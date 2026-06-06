const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { callAgent, listOllamaModels, testConnection } = require('./providers');
const { loadAgents, saveAgents, loadProjects, saveProjects } = require('./store');
const { runCheck } = require('./checks');

// Project root = parent of electron/. All read-only checks are locked to here.
const PROJECT_ROOT = path.join(__dirname, '..');

// Active abort controllers keyed by callId. Lets the renderer cancel in-flight
// agent calls (stop button, new chat) without waiting for the HTTP/CLI to finish.
const activeControllers = new Map();

// Dev mode if NODE_ENV says so OR a --dev flag was passed (the flag always
// survives across shell chaining on Windows, env vars don't always).
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
    },
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
ipcMain.handle('agent:call', async (_e, { agent, messages, callId }) => {
  const controller = new AbortController();
  if (callId) activeControllers.set(callId, controller);
  try {
    return await callAgent(agent, messages, controller.signal);
  } catch (err) {
    // Surface abort as a clean sentinel the renderer can ignore.
    if (err.name === 'AbortError') return '__ABORTED__';
    throw err;
  } finally {
    if (callId) activeControllers.delete(callId);
  }
});

// Cancel an in-flight agent call by callId. No-op if already done.
ipcMain.handle('agent:abort', (_e, callId) => {
  const ctrl = activeControllers.get(callId);
  if (ctrl) { ctrl.abort(); activeControllers.delete(callId); }
});
// check:run — `projectRoot` overrides the default PROJECT_ROOT when a project
// is active. `canWrite` is forwarded from the calling agent's config so the
// executor can enforce per-agent write permission.
ipcMain.handle('check:run', (_e, { req, projectRoot, canWrite }) => {
  const root = (projectRoot && projectRoot.trim()) ? projectRoot.trim() : PROJECT_ROOT;
  return runCheck(root, req, { canWrite: !!canWrite });
});
ipcMain.handle('ollama:models', (_e, agent) => listOllamaModels(agent));
ipcMain.handle('agent:test', (_e, agent) => testConnection(agent));

// Projects
ipcMain.handle('projects:list', () => loadProjects(app));
ipcMain.handle('projects:save', (_e, projects) => saveProjects(app, projects));

// Open a native folder-picker dialog and return the chosen path (or null).
ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
