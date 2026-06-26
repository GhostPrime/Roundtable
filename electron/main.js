const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { callAgent, listOllamaModels, testConnection } = require('./providers');
const {
  loadAgents, saveAgents, getAgentById, migratePlaintextKeys,
  loadProjects, saveProjects, KEY_SET,
} = require('./store');
const { runCheck } = require('./checks');
const { detectClis } = require('./cli-detect');
const { initLog, log, getLogPath } = require('./log');

// Project root = parent of electron/. All read-only checks are locked to here.
const PROJECT_ROOT = path.join(__dirname, '..');

// SECURITY: roots the user has explicitly approved via the native folder
// picker (plus saved projects + the app's own folder). check:run refuses any
// root not in this set, so a compromised renderer can't point the executor at
// an arbitrary directory like C:\.
const approvedRoots = new Set([path.resolve(PROJECT_ROOT)]);

// Shared by check:run AND agent:call — both need the same "is this root
// actually approved" gate. Three outcomes, kept distinct on purpose:
//   { none: true }  — no project selected. NOT an error, but NOT the app's own
//                     folder either: callers treat this as "no file access".
//                     (Previously this fell back to PROJECT_ROOT, which let a
//                     write-enabled seat edit Roundtable's own source.)
//   { error }       — a path WAS supplied but isn't approved. This is the
//                     compromised-renderer case and must be refused loudly.
//   { root }        — an approved folder; safe to use.
function resolveProjectRoot(projectRoot) {
  if (!projectRoot || !projectRoot.trim()) return { none: true };
  const requested = path.resolve(projectRoot.trim());
  if (!approvedRoots.has(requested)) {
    return { error: 'project folder not approved — pick it via the folder dialog' };
  }
  return { root: requested };
}

// Active abort controllers keyed by callId.
const activeControllers = new Map();

const isDev =
  process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 460,
    title: 'Roundtable',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // SECURITY: the window renders untrusted model output. Never navigate the
  // app window anywhere; external links go to the OS browser (https only).
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? 'http://localhost:5173' : 'file://';
    if (!url.startsWith(allowed)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click context menu — Electron has none by default, which makes
  // paste into form fields (API keys!) look broken.
  win.webContents.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ]).popup();
    } else if (params.selectionText) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup();
    }
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('agents:list', () => loadAgents(app));
ipcMain.handle('agents:save', (_e, agents) => saveAgents(app, agents));

// SECURITY: the renderer sends an agent whose apiKey is either the KEY_SET
// sentinel (meaning "use what's already stored") or a real key the user just
// typed into the form (meaning "use this — it hasn't been saved yet, or the
// user is replacing the stored one"). Only the sentinel case needs a lookup;
// trusting a freshly-typed key as-is is what lets "Test connection" work for
// brand-new agents and lets editing an existing agent's key actually test the
// new value instead of silently re-testing the old stored one.
function withResolvedKey(agent) {
  if (agent?.apiKey === KEY_SET) {
    let stored = agent?.id ? getAgentById(app, agent.id) : null;
    // Unsaved clone: no key under its own (new) id yet — fall back to the
    // source agent's stored key so "Test connection" works before first save.
    if (!stored?.apiKey && agent?.cloneKeyFrom) stored = getAgentById(app, agent.cloneKeyFrom);
    return { ...agent, apiKey: stored?.apiKey || '' };
  }
  return { ...agent, apiKey: agent?.apiKey || '' };
}

ipcMain.handle('agent:call', async (_e, { agent, messages, callId, projectRoot }) => {
  const effective = withResolvedKey(agent);

  // SECURITY: only CLI-provider agents get a cwd — they drive a real,
  // already-authenticated CLI tool (claude/qwen/...) whose own file access is
  // bounded by where it's spawned, not by our CHECK executor. Without this,
  // every CLI seat was always rooted at the app's own folder regardless of
  // which project was selected. Non-CLI agents don't need cwd — their file
  // access already goes through check:run, which is scoped correctly today.
  if (effective.provider === 'cli') {
    const resolved = resolveProjectRoot(projectRoot);
    if (resolved.error) {
      log('call', `✕ ${agent?.name ?? '?'} rejected: ${resolved.error}`);
      throw new Error(resolved.error);
    }
    // No project selected: spawn the CLI in a throwaway temp dir rather than
    // the app's own source folder. We can't truly jail a spawned CLI, but we
    // can at least avoid pointing it at Roundtable's own code by default.
    effective.cwd = resolved.none ? os.tmpdir() : resolved.root;
  }

  const t0 = Date.now();
  log('call', `→ ${agent?.name ?? '?'} (${agent?.provider}/${agent?.model || agent?.command || '?'}) msgs=${messages?.length ?? 0} callId=${callId || '-'}`);
  const controller = new AbortController();
  if (callId) activeControllers.set(callId, controller);
  try {
    const out = await callAgent(effective, messages, controller.signal);
    log('call', `← ${agent?.name ?? '?'} ok in ${Date.now() - t0}ms (${String(out).length} chars)`);
    return out;
  } catch (err) {
    if (err.name === 'AbortError') {
      log('call', `← ${agent?.name ?? '?'} aborted after ${Date.now() - t0}ms`);
      return '__ABORTED__';
    }
    log('call', `✕ ${agent?.name ?? '?'} FAILED after ${Date.now() - t0}ms: ${err.message}`);
    throw err;
  } finally {
    if (callId) activeControllers.delete(callId);
  }
});

ipcMain.handle('agent:abort', (_e, callId) => {
  const ctrl = activeControllers.get(callId);
  log('call', `abort requested callId=${callId}${ctrl ? '' : ' (already finished)'}`);
  if (ctrl) { ctrl.abort(); activeControllers.delete(callId); }
});

// check:run — SECURITY: both decisions are made here, not in the renderer.
//   canWrite:    looked up from the stored agent config by agentId.
//   projectRoot: must be in approvedRoots (picked via dialog or saved project).
ipcMain.handle('check:run', (_e, { req, projectRoot, agentId }) => {
  const resolved = resolveProjectRoot(projectRoot);
  if (resolved.none) {
    return { ok: false, output: 'no project folder selected — pick a project to give this agent file access' };
  }
  if (resolved.error) return { ok: false, output: resolved.error };
  const root = resolved.root;
  const stored = agentId ? getAgentById(app, agentId) : null;
  const canWrite = stored?.canWrite === true;
  const result = runCheck(root, req, { canWrite });
  log('check', `${stored?.name ?? agentId ?? '?'} ${req?.op} ${req?.arg} canWrite=${canWrite} → ok=${result?.ok}`);
  return result;
});

ipcMain.handle('ollama:models', (_e, agent) => listOllamaModels(agent));

// Probe PATH + common install dirs for known CLIs (claude, qwen, ...).
// Returns [{ name, path, version }] so the form can offer click-to-fill.
ipcMain.handle('cli:detect', () => {
  const found = detectClis();
  log('cli', `detect → ${found.length ? found.map((c) => `${c.name}=${c.path}`).join('; ') : 'none found'}`);
  return found;
});

// Reveal the log file in Explorer/Finder.
ipcMain.handle('log:open', () => {
  log('app', 'log opened from UI');
  shell.showItemInFolder(getLogPath());
});

// Scripts panel — save a code block to a file. Native save dialog defaults
// into the active project folder; the user names/places the file. This is an
// explicit user action (not a model write), so it isn't gated by canWrite.
ipcMain.handle('script:save', async (_e, { projectRoot, name, content }) => {
  const resolved = resolveProjectRoot(projectRoot);
  const dir = resolved.root || PROJECT_ROOT;
  const result = await dialog.showSaveDialog({ defaultPath: path.join(dir, name || 'script.txt') });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, String(content ?? ''), 'utf8');
  log('script', `saved ${result.filePath}`);
  return result.filePath;
});

// Reveal an agent-written file in the OS file manager, bounded to the
// approved project root (no escaping via ../ or absolute paths).
ipcMain.handle('file:reveal', (_e, { projectRoot, relPath }) => {
  const resolved = resolveProjectRoot(projectRoot);
  if (!resolved.root) return false;
  const target = path.resolve(resolved.root, relPath || '.');
  const rel = path.relative(resolved.root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('agent:test', (_e, agent) => {
  return testConnection(withResolvedKey(agent));
});

// Projects — saved project paths count as user-approved roots.
ipcMain.handle('projects:list', () => {
  const projects = loadProjects(app);
  for (const p of projects) if (p?.path) approvedRoots.add(path.resolve(p.path));
  return projects;
});
ipcMain.handle('projects:save', (_e, projects) => {
  const saved = saveProjects(app, projects);
  for (const p of saved) if (p?.path) approvedRoots.add(path.resolve(p.path));
  return saved;
});

// Folder picker — anything the user picks here becomes an approved root.
ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled) return null;
  const chosen = path.resolve(result.filePaths[0]);
  approvedRoots.add(chosen);
  return chosen;
});

app.whenReady().then(() => {
  initLog(app);
  migratePlaintextKeys(app); // one-time: encrypt any legacy plaintext keys
  for (const p of loadProjects(app)) if (p?.path) approvedRoots.add(path.resolve(p.path));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
