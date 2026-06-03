const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { callAgent, listOllamaModels, testConnection } = require('./providers');
const { loadAgents, saveAgents } = require('./store');
const { runCheck } = require('./checks');

// Project root = parent of electron/. All read-only checks are locked to here.
const PROJECT_ROOT = path.join(__dirname, '..');

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
ipcMain.handle('agent:call', async (_e, { agent, messages }) => {
  return callAgent(agent, messages);
});
ipcMain.handle('check:run', (_e, req) => runCheck(PROJECT_ROOT, req));
ipcMain.handle('ollama:models', (_e, agent) => listOllamaModels(agent));
ipcMain.handle('agent:test', (_e, agent) => testConnection(agent));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
