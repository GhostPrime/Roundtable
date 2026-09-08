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
    // A seat challenged this fact with MEMO-WRONG. It STAYS in the pool and
    // keeps asserting — flagging is not deleting — but every later prompt
    // carries the challenge alongside the claim, and the user decides.
    ...(m?.disputed
      ? {
        disputed: {
          by: String(m.disputed.by || '').slice(0, 64),
          why: String(m.disputed.why || '').slice(0, MAX_TEXT),
          ts: Number(m.disputed.ts) || Date.now(),
        },
      }
      : {}),
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

// --- Graph view support -------------------------------------------------------
// Two reads the MemoryGraph panel needs. Both live here rather than in the
// renderer for one reason: `sameSubject` below is the SAME predicate that
// already governs dedupe-on-save and eviction ranking, and it has a tuned
// threshold plus a subject-anchor rule that took real work to get right.
// Reimplementing "are these two facts related?" in the renderer would mean two
// definitions of relatedness drifting apart, and the graph would start drawing
// edges the save path disagrees with.

// Every project that has a memory file, with enough stats to render a card.
// Names are NOT resolved here — memory.js knows nothing about projects, so the
// renderer maps projectId → name against its own project list and falls back
// to the raw id for pools whose project was deleted.
function listPools(app) {
  let files = [];
  try {
    files = fs.readdirSync(memoryDir(app)).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no memory dir yet
  }
  const pools = [];
  for (const f of files) {
    const projectId = f.slice(0, -5);
    if (!validId(projectId)) continue;
    const memos = loadMemos(app, projectId);
    if (!memos.length) continue;
    pools.push({
      projectId,
      count: memos.length,
      pinned: memos.filter((m) => m.pinned).length,
      unused: memos.filter((m) => !m.hitCount).length,
      newest: memos.reduce((a, m) => Math.max(a, m.ts || 0), 0),
    });
  }
  return pools.sort((a, b) => b.newest - a.newest);
}

// TWO edge sets, because "should I silently merge these?" and "should I show
// these near each other?" are different questions and need different bars.
//
// sameSubject is tuned to bias HARD toward missed merges (0.6 overlap plus a
// subject-anchor rule) — correct for a predicate that can destroy a fact by
// merging it, and far too strict for display. Used on a real 19-fact pool it
// produced ZERO edges, so the graph rendered as a column of disconnected dots:
// strictly worse than the list it was meant to improve on. That was the bug.
//
//   duplicates — sameSubject. Rare, strong, "these two are the same fact".
//   related    — share a SALIENT token: one appearing in at least 2 facts but
//                not in most of them. A token every fact contains ("blender"
//                in a Blender project) says nothing about which facts belong
//                together, so it is excluded; the discriminating words
//                (ramen, blockout, mcp, release) are what actually cluster.
function salientTokens(memos) {
  const df = new Map();
  for (const m of memos) {
    for (const w of new Set(contentTokens(m.text))) df.set(w, (df.get(w) || 0) + 1);
  }
  const ceiling = Math.max(2, Math.ceil(memos.length * 0.5));
  const salient = new Set();
  for (const [w, n] of df) if (n >= 2 && n <= ceiling && w.length > 2) salient.add(w);
  return salient;
}

function linkMemos(app, projectId) {
  const memos = loadMemos(app, projectId);
  const salient = salientTokens(memos);
  const tokOf = new Map(
    memos.map((m) => [m.id, new Set(contentTokens(m.text).filter((w) => salient.has(w)))]),
  );
  const shareOf = (a, b) => {
    const A = tokOf.get(a.id);
    const B = tokOf.get(b.id);
    return [...A].filter((w) => B.has(w));
  };

  const links = [];    // strong: same fact, likely merge candidates
  const related = [];  // weak: same topic — cross-links across branches
  for (let i = 0; i < memos.length; i++) {
    for (let j = i + 1; j < memos.length; j++) {
      if (sameSubject(memos[i].text, memos[j].text)) {
        links.push([memos[i].id, memos[j].id]);
        continue;
      }
      const shared = shareOf(memos[i], memos[j]);
      if (shared.length) related.push([memos[i].id, memos[j].id, shared.length, shared[0]]);
    }
  }

  // --- the chain -------------------------------------------------------------
  // A spanning tree rooted at the OLDEST fact in the pool — the origin the
  // whole project grew from. Every later fact attaches to one earlier fact, so
  // every edge points backwards in time and every node has a path home. That
  // is what makes the picture a connected structure rather than a scatter of
  // islands: topic edges alone leave any fact that shares no vocabulary
  // floating with nothing to trace it back through.
  //
  // Parent = the most similar EARLIER fact. sameSubject dominates (a fact that
  // supersedes another should hang directly off it); otherwise it is the count
  // of shared salient words. Ties go to the MOST RECENT candidate, which grows
  // readable chains — oldest → refinement → refinement — instead of a star
  // where forty facts all hang off fact one.
  //
  // A fact resembling nothing before it attaches straight to the origin, which
  // is the honest answer: it started its own branch.
  const byAge = [...memos].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const chain = [];
  for (let i = 1; i < byAge.length; i++) {
    let bestIdx = 0;
    let bestScore = 0;
    let bestToken = null;
    for (let j = 0; j < i; j++) {
      const shared = shareOf(byAge[j], byAge[i]);
      const score = shared.length + (sameSubject(byAge[i].text, byAge[j].text) ? 10 : 0);
      if (score > 0 && score >= bestScore) {
        bestScore = score;
        bestIdx = j;
        bestToken = shared[0] || null;
      }
    }
    chain.push([byAge[bestIdx].id, byAge[i].id, bestScore, bestToken]);
  }

  return { memos, links, related, chain, root: byAge[0]?.id ?? null, salient: [...salient] };
}

// --- the holdout log ---------------------------------------------------------
// One trial per round: which fact was withheld, and what the user said about it
// afterwards. Kept beside the pool it measures, per project, so a store that
// turns out to be worthless can be deleted along with its evidence.
const HOLDOUT_CAP = 300; // mirrors HOLDOUT_LOG_CAP in src/memoryHoldout.js

function holdoutPath(app, projectId) {
  return path.join(memoryDir(app), `${projectId}.holdouts.json`);
}

function loadHoldouts(app, projectId) {
  if (!validId(projectId)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(holdoutPath(app, projectId), 'utf8'));
    return Array.isArray(data?.records) ? data.records.filter(Boolean) : [];
  } catch {
    return []; // no trials yet — never an error
  }
}

function saveHoldouts(app, projectId, records) {
  if (!validId(projectId)) return [];
  ensureDir(app);
  const list = (records || []).filter(Boolean).slice(-HOLDOUT_CAP);
  fs.writeFileSync(holdoutPath(app, projectId), JSON.stringify({ records: list }, null, 2), 'utf8');
  return list;
}

// Stamp a challenge onto a fact. The renderer resolved which fact this is
// about (matchDisputed in src/orchestrator.js — deliberately strict, because a
// dispute landing on the wrong fact would flag something true, which is worse
// than losing the correction); this only records the result.
function disputeMemo(app, projectId, { memoId, why, by }) {
  const memos = loadMemos(app, projectId);
  const target = memos.find((m) => m.id === memoId);
  if (!target) return null;
  const next = memos
    .map((m) => (m.id === target.id
      ? { ...m, disputed: { by: by || '', why: why || '', ts: Date.now() } }
      : m))
    .map(normalizeMemo);
  writeMemos(app, projectId, next);
  return { memos: next, disputed: target };
}

// The user's ruling: 'wrong' removes the fact, 'stands' clears the flag.
// Either way a PERSON decided, which is the whole point — the pool was written
// by agents, read by agents, and corrected by nobody.
function resolveDispute(app, projectId, memoId, ruling) {
  const memos = loadMemos(app, projectId);
  const next = (ruling === 'wrong'
    ? memos.filter((m) => m.id !== memoId)
    : memos.map((m) => {
      if (m.id !== memoId) return m;
      const copy = { ...m };
      delete copy.disputed;
      return copy;
    })).map(normalizeMemo);
  writeMemos(app, projectId, next);
  return next;
}

module.exports = {
  loadMemos, addMemos, saveMemos, listPools, linkMemos,
  loadHoldouts, saveHoldouts, disputeMemo, resolveDispute,
};
