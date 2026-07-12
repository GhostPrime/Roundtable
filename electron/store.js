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

// ---- MCP servers --------------------------------------------------------------
// Integration configs (GitHub, Google Drive, Gmail, any MCP server). env and
// headers VALUES are secrets (PATs, OAuth tokens) — encrypted at rest exactly
// like agent API keys. The renderer sees the key NAMES with the KEY_SET
// sentinel as every value; sending the sentinel back means "keep what's stored".

function mcpPath(app) {
  return path.join(app.getPath('userData'), 'mcp.json');
}

function loadMcpRaw(app) {
  try {
    const data = JSON.parse(fs.readFileSync(mcpPath(app), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function maskKV(enc) {
  const out = {};
  for (const k of Object.keys(enc || {})) out[k] = KEY_SET;
  return out;
}

function decryptKV(enc) {
  const out = {};
  for (const [k, v] of Object.entries(enc || {})) out[k] = decryptKey(v);
  return out;
}

// Renderer view: env/headers values replaced by the sentinel.
function loadMcpServers(app) {
  return loadMcpRaw(app).map(({ envEnc, headersEnc, ...rest }) => ({
    ...rest,
    env: maskKV(envEnc),
    headers: maskKV(headersEnc),
  }));
}

// Main-process view: real values. NEVER pass the result over IPC.
function getMcpServersDecrypted(app) {
  return loadMcpRaw(app).map(({ envEnc, headersEnc, ...rest }) => ({
    ...rest,
    env: decryptKV(envEnc),
    headers: decryptKV(headersEnc),
  }));
}

// Accepts servers from the renderer. Per env/headers value:
//   KEY_SET sentinel   -> keep the previously stored encrypted value
//   non-empty string   -> encrypt and store the new value
//   empty string       -> key dropped
function saveMcpServers(app, servers) {
  const prev = new Map(loadMcpRaw(app).map((s) => [s.id, s]));
  const encryptKV = (kv, prevEnc) => {
    const out = {};
    for (const [k, v] of Object.entries(kv || {})) {
      if (v === KEY_SET) { if (prevEnc?.[k]) out[k] = prevEnc[k]; }
      else if (v) out[k] = encryptKey(v);
    }
    return out;
  };
  const toStore = (Array.isArray(servers) ? servers : []).map((s) => {
    const { env, headers, ...rest } = s;
    const old = prev.get(s.id);
    return {
      ...rest,
      envEnc: encryptKV(env, old?.envEnc),
      headersEnc: encryptKV(headers, old?.headersEnc),
    };
  });
  fs.writeFileSync(mcpPath(app), JSON.stringify(toStore, null, 2), 'utf8');
  return loadMcpServers(app);
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
  loadMcpServers,
  saveMcpServers,
  getMcpServersDecrypted,
};
