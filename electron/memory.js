// electron/memory.js — cross-session shared memory, one pool per project.
//
// Modeled on sessions.js: small JSON files in userData/memory/, defensive
// reads that return safe defaults. Memories are plain-text facts seats save
// with MEMO: lines (parsed in orchestrator.js) and read back as a prompt
// stage — pure text, so every provider (Ollama, Anthropic, CLI) gets the
// same memory with zero model-specific plumbing.
//
// Layout:
//   userData/memory/<projectId>.json — { projectId, updatedAt, memos }
//   memos: [{ id, text, by, ts, pinned, hitCount, lastReferencedAt }]
//     by = speaker name that saved it
//     pinned = user-set, never auto-evicted (MemoryPanel)
//     hitCount = times this fact was re-asserted (exact repeat or a
//       same-subject rewording — see addMemos/sameSubject)
//     lastReferencedAt = last time it was saved/re-asserted/matched
//   Old on-disk records lack pinned/hitCount/lastReferencedAt — normalizeMemo
//   defaults them on load, so existing JSON keeps working unmodified.
// No agent configs, no key material — same invariant as sessions.js.
const fs = require('fs');
const path = require('path');

// Project ids are renderer-generated and become file names — same
// path-traversal guard as sessions.js. 'global' is the no-project pool.
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

const MAX_MEMOS = 50; // per project; lowest-value memo dropped on overflow
const MAX_TEXT = 300; // one fact = one short sentence, not an essay

function memoryDir(app) {
  return path.join(app.getPath('userData'), 'memory');
}
function memoryPath(app, projectId) {
  return path.join(memoryDir(app), `${projectId}.json`);
}
function ensureDir(app) {
  try { fs.mkdirSync(memoryDir(app), { recursive: true }); } catch { /* exists */ }
}

// Dedupe key: case/whitespace/trailing-punctuation insensitive, so "Use
// SQLite." and "use sqlite" count as the same fact.
function normText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!,;:]+$/, '').trim();
}

// Backward-compat + shape guard: applied on every load and every full-replace
// save so old records (pre-pin/hitCount) and hand-edited JSON both come out
// with sane defaults instead of undefined fields leaking into the UI/scoring.
function normalizeMemo(m) {
  const ts = Number(m?.ts) || Date.now();
  return {
    id: String(m?.id || `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    text: String(m?.text || '').trim().slice(0, MAX_TEXT),
    by: String(m?.by || '').slice(0, 64),
    ts,
    pinned: m?.pinned === true,
    hitCount: Number.isFinite(m?.hitCount) ? m.hitCount : 0,
    lastReferencedAt: Number(m?.lastReferencedAt) || ts,
  };
}

function loadMemos(app, projectId) {
  if (!validId(projectId)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(memoryPath(app, projectId), 'utf8'));
    return Array.isArray(data?.memos)
      ? data.memos.filter((m) => m && typeof m.text === 'string').map(normalizeMemo)
      : [];
  } catch {
    return []; // no file yet / corrupt — empty pool, never an error
  }
}

function writeMemos(app, projectId, memos) {
  ensureDir(app);
  fs.writeFileSync(
    memoryPath(app, projectId),
    JSON.stringify({ projectId, updatedAt: Date.now(), memos }, null, 2),
    'utf8',
  );
}

// --- Subject-based replacement -----------------------------------------------
// Cheap, deterministic "is this a rewording of the same fact" check — no
// model call. Two texts are treated as the same subject when:
//   1. They share a "subject anchor": the first content word of one appears
//      somewhere in the other (so "user likes pizza" anchors on "user"
//      against "user's favorite food is pizza").
//   2. Their content-token sets (stopwords stripped) overlap at or above
//      OVERLAP_THRESHOLD, measured as intersection / smaller-set-size (the
//      overlap coefficient — forgiving of one side just adding a couple of
//      extra words, e.g. "food"/"favorite").
//   3. Both sides have at least MIN_TOKENS content tokens, so two very short
//      facts can't spuriously "overlap" on a single shared word.
// Threshold picked (and checked against the pizza/favorite-food example in
// the task write-up, plus adversarial pairs — different subjects, same
// predicate/different object, same category/different value) to bias hard
// toward missed merges over wrong merges: a missed merge just leaves two
// lines (today's behavior); a wrong merge silently loses a fact. 0.6 catches
// straightforward rewordings and value-updates ("uses SQLite" -> "uses
// PostgreSQL") while sparing same-subject-different-fact pairs like
// "favorite color is blue" / "favorite food is pizza" (overlap 0.5).
const OVERLAP_THRESHOLD = 0.6;
const MIN_TOKENS = 2;
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to',
  'of', 'in', 'on', 'for', 'and', 'or', 'that', 'this', 'it', 'its', 'as',
  'at', 'by', 'with', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
  'should', 'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'their',
]);

function contentTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/'s\b/g, '') // "user's" -> "user" so possessives anchor together
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

function sameSubject(newText, oldText) {
  const a = contentTokens(newText);
  const b = contentTokens(oldText);
  if (a.length < MIN_TOKENS || b.length < MIN_TOKENS) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  // Subject anchor: the leading content word of either side must appear in
  // the other, or these are probably unrelated facts that happen to share
  // vocabulary ("user likes pizza" vs "team likes pizza" must NOT merge).
  if (!setA.has(b[0]) && !setB.has(a[0])) return false;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const overlap = inter / Math.min(setA.size, setB.size);
  return overlap >= OVERLAP_THRESHOLD;
}

// --- Eviction ranking ---------------------------------------------------------
// Overflow used to be `while (memos.length > MAX_MEMOS) memos.shift()` — pure
// FIFO, dropping the OLDEST fact. That systematically evicted durable
// identity/preference facts (saved once, early, rarely restated) while
// preserving disposable recent task chatter, purely because the chatter
// arrived later. Fixed by ranking on value instead of age:
//   1. Pinned facts (user-set in MemoryPanel) are never auto-evicted.
//   2. Among unpinned facts, hitCount (bumped whenever the same fact — exact
//      repeat or same-subject update, see addMemos) is re-asserted) is the
//      primary signal: repetition is the cheapest proxy we have for "this
//      matters."
//   3. Within equal hitCount (the common case — most facts are saved once),
//      OLDER wins over newer. This is a deliberate inversion of naive
//      recency/LRU ranking: an untouched fact that's survived this long
//      reads as foundational (identity/preference), while an untouched fact
//      that just arrived is more likely one-off task chatter that hasn't
//      had a chance to prove otherwise yet.
function evictionScore(m) {
  const hits = Number(m.hitCount) || 0;
  const touchedAt = Number(m.lastReferencedAt) || Number(m.ts) || 0;
  const age = Date.now() - touchedAt; // ms since last touched; bigger = older
  return hits * 1e15 + age;
}

function evictOverflow(memos) {
  let changed = false;
  while (memos.length > MAX_MEMOS) {
    const unpinned = memos.filter((m) => !m.pinned);
    // Everything left pinned would otherwise loop forever — fall back to
    // the lowest-scoring pinned memo rather than growing past the cap.
    const pool = unpinned.length ? unpinned : memos;
    let worst = pool[0];
    for (const m of pool) if (evictionScore(m) < evictionScore(worst)) worst = m;
    const idx = memos.indexOf(worst);
    if (idx < 0) break;
    memos.splice(idx, 1);
    changed = true;
  }
  return changed;
}

// Append new facts. items: [{ text, by }]. Dedupes against the existing pool
// (and within the batch) — an exact restatement bumps the existing memo's
// hitCount instead of being dropped silently, which is what protects it from
// eviction. A same-subject rewording (sameSubject()) REPLACES the existing
// line rather than appending a second, so one fact occupies one line. Over-
// long facts are truncated, lowest-value memos drop past the cap (see
// evictOverflow). Returns the full post-add pool so the renderer can refresh
// its copy from one round-trip.
function addMemos(app, projectId, items) {
  if (!validId(projectId) || !Array.isArray(items)) return loadMemos(app, projectId);
  const memos = loadMemos(app, projectId);
  const seen = new Set(memos.map((m) => normText(m.text)));
  let changed = false;
  for (const it of items) {
    const text = String(it?.text || '').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const key = normText(text);
    if (seen.has(key)) {
      // Exact restatement of an existing fact — not new, but a real
      // "this still matters" signal. Bump it instead of silently dropping.
      const dup = memos.find((m) => normText(m.text) === key);
      if (dup) {
        dup.hitCount = (Number(dup.hitCount) || 0) + 1;
        dup.lastReferencedAt = Date.now();
        changed = true;
      }
      continue;
    }
    seen.add(key);
    const replaceIdx = memos.findIndex((m) => sameSubject(text, m.text));
    if (replaceIdx >= 0) {
      const prev = memos[replaceIdx];
      memos[replaceIdx] = {
        id: prev.id,
        text,
        by: String(it?.by || '').slice(0, 64),
        ts: Date.now(),
        pinned: prev.pinned === true,
        hitCount: (Number(prev.hitCount) || 0) + 1,
        lastReferencedAt: Date.now(),
      };
    } else {
      memos.push({
        id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        text,
        by: String(it?.by || '').slice(0, 64),
        ts: Date.now(),
        pinned: false,
        hitCount: 0,
        lastReferencedAt: Date.now(),
      });
    }
    changed = true;
  }
  if (evictOverflow(memos)) changed = true;
  if (changed) writeMemos(app, projectId, memos);
  return memos;
}

// Full replace — the hook for the UI panel (delete/pin/edit) and for a
// distillation pass that merges/prunes the pool. Same normalize + eviction
// path as addMemos, so a caller that hands back an over-cap or legacy-shaped
// list still ends up with a clean, capped, ranked pool on disk.
function saveMemos(app, projectId, memos) {
  if (!validId(projectId) || !Array.isArray(memos)) return false;
  const clean = memos
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map(normalizeMemo);
  evictOverflow(clean);
  writeMemos(app, projectId, clean);
  return true;
}

module.exports = { loadMemos, addMemos, saveMemos };
