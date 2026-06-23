// Tiny JSON store for agent configs and projects, kept in Electron's userData
// folder so it persists across restarts and survives app updates.
//
// SECURITY: API keys are encrypted at rest with Electron safeStorage (DPAPI on
// Windows, Keychain on macOS, libsecret on Linux). Decrypted keys exist ONLY in
// the main process. The renderer never receives a real key — it gets the
// KEY_SET sentinel so the UI can show "a key is saved" without holding it.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

// Sentinel the renderer sees in place of a stored key. If the renderer sends
// this back on save, it means "keep the existing key unchanged".
const KEY_SET = '__KEY_SET__';

function agentsPath(app) {
  return path.join(app.getPath('userData'), 'agents.json');
}

function projectsPath(app) {
  return path.join(app.getPath('userData'), 'projects.json');
}

function encryptKey(plain) {
  if (!plain) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    // Refuse to silently downgrade to plaintext. Caller surfaces this to the UI.
    throw new Error('OS-level encryption unavailable — refusing to store API key in plaintext.');
  }
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptKey(enc) {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return ''; // corrupted / different machine — treat as no key
  }
}

// ---- raw load (main-process internal) --------------------------------------

function loadRaw(app) {
  try {
    const raw = fs.readFileSync(agentsPath(app), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// Full agent config WITH decrypted apiKey. Main-process use only.
// NEVER pass the result of this over IPC.
function getAgentById(app, id) {
  const a = loadRaw(app).find((x) => x.id === id);
  if (!a) return null;
  return { ...a, apiKey: decryptKey(a.apiKeyEnc), apiKeyEnc: undefined };
}

// ---- IPC-facing load/save ---------------------------------------------------

// What the renderer is allowed to see: everything except the key material.
function loadAgents(app) {
  return loadRaw(app).map(({ apiKeyEnc, ...rest }) => ({
    ...rest,
    apiKey: apiKeyEnc ? KEY_SET : '',
  }));
}

// Accepts agents from the renderer. apiKey semantics per agent:
//   - KEY_SET sentinel  -> keep previously stored encrypted key
//   - non-empty string  -> encrypt and store the new key
//   - empty string      -> clear the key
// cloneKeyFrom: present only on a freshly-duplicated agent that hasn't been
// saved yet. When this agent's apiKey is the sentinel but it has no stored key
// of its own (new id), inherit the encrypted key of the source agent it was
// cloned from. The field is renderer-only scaffolding — never persisted.
function saveAgents(app, agents) {
  const prev = new Map(loadRaw(app).map((a) => [a.id, a]));
  const toStore = (Array.isArray(agents) ? agents : []).map((a) => {
    const { apiKey, cloneKeyFrom, ...rest } = a;
    let apiKeyEnc = '';
    if (apiKey === KEY_SET) {
      apiKeyEnc =
        prev.get(a.id)?.apiKeyEnc ||
        (cloneKeyFrom ? prev.get(cloneKeyFrom)?.apiKeyEnc : '') ||
        '';
    } else if (apiKey) apiKeyEnc = encryptKey(apiKey);
    return { ...rest, apiKeyEnc };
  });
  fs.writeFileSync(agentsPath(app), JSON.stringify(toStore, null, 2), 'utf8');
  return loadAgents(app); // hand back the masked view
}

// One-time migration: encrypt any legacy plaintext apiKey fields in place.
function migratePlaintextKeys(app) {
  const raw = loadRaw(app);
  let changed = false;
  for (const a of raw) {
    if (a.apiKey && !a.apiKeyEnc) {
      try {
        a.apiKeyEnc = encryptKey(a.apiKey);
        delete a.apiKey;
        changed = true;
      } catch {
        /* encryption unavailable; leave as-is rather than lose the key */
      }
    }
  }
  if (changed) fs.writeFileSync(agentsPath(app), JSON.stringify(raw, null, 2), 'utf8');
}

// ---- projects (unchanged) ---------------------------------------------------

function loadProjects(app) {
  try {
    const raw = fs.readFileSync(projectsPath(app), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveProjects(app, projects) {
  fs.writeFileSync(projectsPath(app), JSON.stringify(projects, null, 2), 'utf8');
  return projects;
}

module.exports = {
  KEY_SET,
  loadAgents,
  saveAgents,
  getAgentById,
  migratePlaintextKeys,
  loadProjects,
  saveProjects,
};
