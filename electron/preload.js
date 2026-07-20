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
  // Streaming: agent:delta events carry { callId, text } fragments while a
  // call is in flight (display-only; the invoke still resolves with the full
  // text). Returns the unsubscribe fn — the renderer must call it on unmount.
  onAgentDelta: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:delta', listener);
    return () => ipcRenderer.removeListener('agent:delta', listener);
  },
  // Check tool: req = { op: 'read_file'|'list_dir'|'exists'|'write_file', arg, content? }
  // agentId: main looks up the agent's stored canWrite — the renderer cannot
  // grant write access by passing a flag.
  runCheck: (req, projectRoot, agentId) =>
    ipcRenderer.invoke('check:run', { req, projectRoot, agentId }),
  // MCP integrations (GitHub, Google Drive, Gmail, …). Configs travel with
  // env/header VALUES masked (KEY_SET sentinel) — same pattern as API keys.
  // mcpCall: write-classified tools are re-gated in main on the stored agent's
  // canWrite; the renderer's approval modal is UX, not the capability boundary.
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (servers) => ipcRenderer.invoke('mcp:save', servers),
  mcpCall: (server, tool, args, agentId) =>
    ipcRenderer.invoke('mcp:call', { server, tool, args, agentId }),
  listOllamaModels: (agent) => ipcRenderer.invoke('ollama:models', agent),
  // Provider-aware model list for the form's click-to-pick chips
  listModels: (agent) => ipcRenderer.invoke('models:list', agent),
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
  // Project file tree + root-contained file read (Phase 4)
  projectTree: (projectRoot) => ipcRenderer.invoke('project:tree', { projectRoot }),
  readProjectFile: (projectRoot, relPath) =>
    ipcRenderer.invoke('project:readFile', { projectRoot, relPath }),
  // Project instructions — ROUNDTABLE.md content for the active root (Phase 7)
  projectInstructions: (projectRoot) =>
    ipcRenderer.invoke('project:instructions', { projectRoot }),
  // Cross-session shared memory — plain-text facts per project ('global'
  // when no project). Saved by MEMO: lines, injected as a prompt stage.
  // CLI write approvals: main forwards a claude CLI's permission request;
  // the renderer shows the modal and answers with allow/deny.
  onCliApproval: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('cli-approval', listener);
    return () => ipcRenderer.removeListener('cli-approval', listener);
  },
  answerCliApproval: (id, allow) => ipcRenderer.invoke('cliApproval:answer', { id, allow }),
  memoryLoad: (projectId) => ipcRenderer.invoke('memory:load', projectId),
  memoryAdd: (projectId, items) => ipcRenderer.invoke('memory:add', { projectId, items }),
  memorySave: (projectId, memos) => ipcRenderer.invoke('memory:save', { projectId, memos }),
  // Local git — READ-ONLY working-copy view for the Git/Changes panel. Root is
  // re-validated in main against approved roots; no stage/commit/push here.
  gitStatus: (projectRoot) => ipcRenderer.invoke('git:status', { projectRoot }),
  gitDiff: (projectRoot, relPath, staged) =>
    ipcRenderer.invoke('git:diff', { projectRoot, relPath, staged }),
  gitLog: (projectRoot, limit) => ipcRenderer.invoke('git:log', { projectRoot, limit }),
  gitBranches: (projectRoot) => ipcRenderer.invoke('git:branches', { projectRoot }),
  gitCommitFiles: (projectRoot, sha) => ipcRenderer.invoke('git:commitFiles', { projectRoot, sha }),
  gitCommitDiff: (projectRoot, sha, relPath) =>
    ipcRenderer.invoke('git:commitDiff', { projectRoot, sha, relPath }),
  // Git write ops — mutate the repo. Destructive discard is confirmed in the UI
  // before this fires. relPath null/empty on stage/unstage means "all".
  gitStage: (projectRoot, relPath) => ipcRenderer.invoke('git:stage', { projectRoot, relPath }),
  gitUnstage: (projectRoot, relPath) => ipcRenderer.invoke('git:unstage', { projectRoot, relPath }),
  gitDiscard: (projectRoot, relPath, untracked, expectedFp) =>
    ipcRenderer.invoke('git:discard', { projectRoot, relPath, untracked, expectedFp }),
  gitCommit: (projectRoot, message) => ipcRenderer.invoke('git:commit', { projectRoot, message }),
  // Network ops — use git's credential helper. push auto-sets upstream on first
  // push; pull is --ff-only (never a surprise merge).
  gitPush: (projectRoot) => ipcRenderer.invoke('git:push', { projectRoot }),
  gitPull: (projectRoot) => ipcRenderer.invoke('git:pull', { projectRoot }),
  // Export the current session via native save dialog (Phase 9)
  exportSession: (name, content) => ipcRenderer.invoke('session:export', { name, content }),
  // Persistent sessions (Phase 2)
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  saveSession: (payload) => ipcRenderer.invoke('sessions:save', payload),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  renameSession: (id, name) => ipcRenderer.invoke('sessions:rename', { id, name }),
});
