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
//   memos: [{ id, text, by, ts }]  (by = speaker name that saved it)
// No agent configs, no key material — same invariant as sessions.js.
const fs = require('fs');
const path = require('path');

// Project ids are renderer-generated and become file names — same
// path-traversal guard as sessions.js. 'global' is the no-project pool.
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

const MAX_MEMOS = 50; // per project; oldest dropped on overflow
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

function loadMemos(app, projectId) {
  if (!validId(projectId)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(memoryPath(app, projectId), 'utf8'));
    return Array.isArray(data?.memos)
      ? data.memos.filter((m) => m && typeof m.text === 'string')
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

// Append new facts. items: [{ text, by }]. Dedupes against the existing pool
// (and within the batch), truncates over-long facts, drops oldest past the
// cap. Returns the full post-add pool so the renderer can refresh its copy
// from one round-trip.
function addMemos(app, projectId, items) {
  if (!validId(projectId) || !Array.isArray(items)) return loadMemos(app, projectId);
  const memos = loadMemos(app, projectId);
  const seen = new Set(memos.map((m) => normText(m.text)));
  let changed = false;
  for (const it of items) {
    const text = String(it?.text || '').trim().slice(0, MAX_TEXT);
    const key = normText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    memos.push({
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      by: String(it?.by || '').slice(0, 64),
      ts: Date.now(),
    });
    changed = true;
  }
  while (memos.length > MAX_MEMOS) { memos.shift(); changed = true; }
  if (changed) writeMemos(app, projectId, memos);
  return memos;
}

// Full replace — the hook for a future UI panel (delete/edit) and for a
// distillation pass that merges/prunes the pool.
function saveMemos(app, projectId, memos) {
  if (!validId(projectId) || !Array.isArray(memos)) return false;
  const clean = memos
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      id: String(m.id || `m_${Date.now().toString(36)}`),
      text: m.text.trim().slice(0, MAX_TEXT),
      by: String(m.by || '').slice(0, 64),
      ts: Number(m.ts) || Date.now(),
    }))
    .slice(-MAX_MEMOS);
  writeMemos(app, projectId, clean);
  return true;
}

module.exports = { loadMemos, addMemos, saveMemos };
