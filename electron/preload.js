const { contextBridge, ipcRenderer } = require('electron');

// Safe bridge between the renderer (React) and the Electron main process.
// SECURITY: nothing here grants capability by itself — canWrite and project
// roots are validated in main against stored config / user-approved paths.
contextBridge.exposeInMainWorld('api', {
  listAgents: () => ipcRenderer.invoke('agents:list'),
  saveAgents: (agents) => ipcRenderer.invoke('agents:save', agents),
  // projectRoot: the active project's folder path (or null for "no project").
  // Only matters to CLI-provider agents, which get spawned with it as cwd —
  // see main.js's agent:call handler.
  callAgent: (agent, messages, callId, projectRoot) =>
    ipcRenderer.invoke('agent:call', { agent, messages, callId, projectRoot }),
  abortCall: (callId) => ipcRenderer.invoke('agent:abort', callId),
  // Check tool: req = { op: 'read_file'|'list_dir'|'exists'|'write_file', arg, content? }
  // agentId: main looks up the agent's stored canWrite — the renderer cannot
  // grant write access by passing a flag.
  runCheck: (req, projectRoot, agentId) =>
    ipcRenderer.invoke('check:run', { req, projectRoot, agentId }),
  listOllamaModels: (agent) => ipcRenderer.invoke('ollama:models', agent),
  // Find installed CLIs (claude, qwen, ...) → [{ name, path, version }]
  detectClis: () => ipcRenderer.invoke('cli:detect'),
  testAgent: (agent) => ipcRenderer.invoke('agent:test', agent),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  saveProjects: (projects) => ipcRenderer.invoke('projects:save', projects),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  // Reveal roundtable.log in Explorer/Finder
  openLog: () => ipcRenderer.invoke('log:open'),
  // Scripts panel: save a code block via native dialog → returns saved path or null
  saveScript: (projectRoot, name, content) =>
    ipcRenderer.invoke('script:save', { projectRoot, name, content }),
  // Reveal an agent-written file in the OS file manager
  revealFile: (projectRoot, relPath) =>
    ipcRenderer.invoke('file:reveal', { projectRoot, relPath }),
});
