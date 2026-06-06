const { contextBridge, ipcRenderer } = require('electron');

// Safe bridge between the renderer (React) and the Electron main process.
contextBridge.exposeInMainWorld('api', {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  saveAgents: (agents) => ipcRenderer.invoke('agents:save', agents),
  callAgent: (agent, messages, callId) =>
    ipcRenderer.invoke('agent:call', { agent, messages, callId }),
  abortCall: (callId) => ipcRenderer.invoke('agent:abort', callId),
  // Check tool: { req, projectRoot?, canWrite? }
  // req: { op: 'read_file'|'list_dir'|'exists'|'write_file', arg: path, content?: string }
  // projectRoot: active project folder path (overrides app default when set)
  // canWrite: true only for agents with write permission
  runCheck: (req, projectRoot, canWrite) =>
    ipcRenderer.invoke('check:run', { req, projectRoot, canWrite }),
  // List installed Ollama models for click-to-fill
  listOllamaModels: (agent) => ipcRenderer.invoke('ollama:models', agent),
  // Reachability-only connection test → { ok, detail }
  testAgent: (agent) => ipcRenderer.invoke('agent:test', agent),
  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  saveProjects: (projects) => ipcRenderer.invoke('projects:save', projects),
  // Open native folder picker → absolute path string | null
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
});
