const { contextBridge, ipcRenderer } = require('electron');

// Safe bridge between the renderer (React) and the Electron main process.
contextBridge.exposeInMainWorld('api', {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  saveAgents: (agents) => ipcRenderer.invoke('agents:save', agents),
  callAgent: (agent, messages) =>
    ipcRenderer.invoke('agent:call', { agent, messages }),
  // Read-only check: { op: 'read_file'|'list_dir'|'exists', arg: path }
  runCheck: (req) => ipcRenderer.invoke('check:run', req),
  // List installed Ollama models for click-to-fill
  listOllamaModels: (agent) => ipcRenderer.invoke('ollama:models', agent),
  // Reachability-only connection test → { ok, detail }
  testAgent: (agent) => ipcRenderer.invoke('agent:test', agent),
});
