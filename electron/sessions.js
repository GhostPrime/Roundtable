// electron/sessions.js — persistent chat sessions.
//
// Modeled on store.js: small JSON files in Electron's userData folder,
// defensive reads that return safe defaults. Sessions contain NO agent
// configs and NO key material — agents are referenced by id only (invariant:
// decrypted keys exist only in store.js/main; nothing here touches them).
//
// Layout:
//   userData/sessions/index.json — [{ id, name, createdAt, updatedAt, projectId, agentIds }]
//   userData/sessions/<id>.json  — full payload (the serializable subset of App state):
//     { id, name, createdAt, updatedAt, projectId, mode, transcripts, tasks,
//       writtenFiles, baselines? }
// Per-session files keep autosave writes small, and one corrupt file can't
// destroy all history — index and payloads degrade independently.
const fs = require('fs');
const path = require('path');

// Session ids are renderer-generated (crypto.randomUUID()). They become file
// names, so refuse anything that isn't a plain id — path-traversal guard.
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function sessionsDir(app) {
  return path.join(app.getPath('userData'), 'sessions');
}
function indexPath(app) {
  return path.join(sessionsDir(app), 'index.json');
}
function sessionPath(app, id) {
  return path.join(sessionsDir(app), `${id}.json`);
}

function ensureDir(app) {
  try { fs.mkdirSync(sessionsDir(app), { recursive: true }); } catch { /* exists */ }
}

function readIndex(app) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(app), 'utf8'));
    return Array.isArray(data) ? data.filter((e) => e && validId(e.id)) : [];
  } catch {
    return [];
  }
}

function writeIndex(app, entries) {
  ensureDir(app);
  fs.writeFileSync(indexPath(app), JSON.stringify(entries, null, 2), 'utf8');
}

// Newest first — the renderer restores [0] on launch.
function listSessions(app) {
  return readIndex(app).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function loadSession(app, id) {
  if (!validId(id)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath(app, id), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

// Upsert. The payload comes from the renderer and must never contain agent
// configs or keys — agents ride along only as ids inside transcript entries.
// agentIds in the index is derived here (not trusted from the renderer) so
// the sidebar can label sessions without loading full payloads.
function saveSession(app, payload) {
  if (!payload || !validId(payload.id)) return { ok: false, error: 'invalid session id' };
  ensureDir(app);
  const now = Date.now();
  const meta = {
    id: payload.id,
    name: String(payload.name || 'New session').slice(0, 200),
    createdAt: Number(payload.createdAt) || now,
    updatedAt: now,
    projectId: payload.projectId ?? null,
    agentIds: [...new Set(
      Object.values(payload.transcripts || {})
        .flat()
        .map((e) => e?.agentId)
        .filter(Boolean),
    )],
  };
  const toStore = { ...payload, name: meta.name, createdAt: meta.createdAt, updatedAt: now };
  fs.writeFileSync(sessionPath(app, payload.id), JSON.stringify(toStore), 'utf8');
  const idx = readIndex(app).filter((e) => e.id !== payload.id);
  idx.push(meta);
  writeIndex(app, idx);
  return { ok: true, updatedAt: now };
}

function deleteSession(app, id) {
  if (!validId(id)) return false;
  try { fs.unlinkSync(sessionPath(app, id)); } catch { /* already gone */ }
  writeIndex(app, readIndex(app).filter((e) => e.id !== id));
  return true;
}

function renameSession(app, id, name) {
  if (!validId(id)) return false;
  const clean = String(name || '').trim().slice(0, 200);
  if (!clean) return false;
  const payload = loadSession(app, id);
  if (payload) {
    payload.name = clean;
    fs.writeFileSync(sessionPath(app, id), JSON.stringify(payload), 'utf8');
  }
  writeIndex(app, readIndex(app).map((e) => (e.id === id ? { ...e, name: clean } : e)));
  return true;
}

module.exports = { listSessions, loadSession, saveSession, deleteSession, renameSession };
