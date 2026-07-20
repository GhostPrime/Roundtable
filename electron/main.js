const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { callAgent, listOllamaModels, listModels, testConnection } = require('./providers');
const {
  loadAgents, saveAgents, getAgentById, migratePlaintextKeys,
  loadProjects, saveProjects, KEY_SET,
  loadMcpServers, saveMcpServers, getMcpServersDecrypted,
} = require('./store');
const { runCheck, WEB_OPS } = require('./checks');
const { McpManager } = require('./mcp');
const git = require('./git');
const sessions = require('./sessions');
const memory = require('./memory');
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

// --- CLI write-approval broker ----------------------------------------------
// claude CLI seats in -p mode can't ask for write permission in a terminal.
// providers.js gives them --permission-prompt-tool wired (via a temp MCP
// config) to scripts/mcp-cli-approvals.js, which POSTs each permission
// request here. We forward it to the renderer (approval modal), await the
// user's decision, and answer the HTTP request with allow/deny.
// Loopback-only + per-run bearer token; anything unauthorized or malformed is
// refused. Auto-deny after 90s — callCli kills the child at 120s, so the CLI
// always gets a clean denial before the hard timeout.
let approvalBroker = null; // { url, token }
const pendingCliApprovals = new Map(); // id -> finish(decision)

function startApprovalBroker(win) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/approve' || req.headers['x-rt-token'] !== token) {
      res.writeHead(403);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      const id = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const finish = (decision) => {
        if (!pendingCliApprovals.has(id)) return; // already answered
        pendingCliApprovals.delete(id);
        clearTimeout(timer);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(decision));
      };
      const timer = setTimeout(
        () => finish({ behavior: 'deny', message: 'No decision in Roundtable within 90s — auto-denied.' }),
        90000,
      );
      pendingCliApprovals.set(id, finish);
      log('cli-approve', `? ${payload.agentName || '?'} wants ${payload.tool_name}`);
      if (win.webContents.isDestroyed()) {
        finish({ behavior: 'deny', message: 'Roundtable window closed.' });
        return;
      }
      win.webContents.send('cli-approval', {
        id,
        toolName: String(payload.tool_name || ''),
        input: payload.input && typeof payload.input === 'object' ? payload.input : {},
        agentName: String(payload.agentName || 'CLI seat'),
      });
    });
  });
  server.listen(0, '127.0.0.1', () => {
    approvalBroker = { url: `http://127.0.0.1:${server.address().port}/approve`, token };
    log('cli-approve', `broker on ${approvalBroker.url}`);
  });
}

ipcMain.handle('cliApproval:answer', (_e, { id, allow }) => {
  const finish = pendingCliApprovals.get(id);
  if (!finish) return false;
  log('cli-approve', `${allow ? '✓ allowed' : '✕ denied'} ${id}`);
  finish(
    allow
      ? { behavior: 'allow' } // mcp-cli-approvals.js fills updatedInput with the original input
      : { behavior: 'deny', message: 'The user declined this action in Roundtable.' },
  );
  return true;
});

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
      // Only for the Preview panel's <webview> (renders project HTML).
      // Guests are clamped hard in will-attach-webview below.
      webviewTag: true,
    },
  });

  // Is this file path inside a root the user approved (picked via dialog or
  // saved project)? Windows: URL pathname is "/C:/…" and paths are
  // case-insensitive.
  const inApprovedRoot = (fileUrl) => {
    try {
      const u = new URL(fileUrl);
      if (u.protocol !== 'file:') return false;
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      p = path.resolve(p);
      const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
      return [...approvedRoots].some(
        (root) => norm(p) === norm(root) || norm(p).startsWith(norm(root + path.sep)),
      );
    } catch {
      return false;
    }
  };

  // SECURITY: <webview> exists solely so the Preview panel can render
  // AI-written project HTML. Attach-time clamp regardless of what the
  // renderer asked for: file:// inside an approved root only, and the guest
  // gets no preload, no node, full sandbox.
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!inApprovedRoot(params.src)) e.preventDefault();
  });
  // Keep the guest where it started: navigation only to files still inside
  // approved roots (an AI-written <a href="file:///C:/…"> must not turn the
  // preview into a local file browser); external links go to the OS browser.
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.on('will-navigate', (ev, url) => {
      if (!inApprovedRoot(url)) ev.preventDefault();
    });
    guest.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
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

  startApprovalBroker(win);

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

ipcMain.handle('agent:call', async (event, { agent, messages, callId, projectRoot }) => {
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

    // canWrite for CLI seats: route the claude CLI's permission requests into
    // the in-app approval modal (providers.js turns this into a temp
    // --mcp-config + --permission-prompt-tool). Re-checked against the STORED
    // agent so a hostile renderer can't flip the flag; spawned seats aren't
    // stored and inherit their planner's renderer-held value.
    const stored = agent?.id ? getAgentById(app, agent.id) : null;
    const canW = stored ? stored.canWrite === true : agent?.canWrite === true;
    if (canW && approvalBroker) {
      effective.cliApproval = {
        url: approvalBroker.url,
        token: approvalBroker.token,
        script: path.join(PROJECT_ROOT, 'scripts', 'mcp-cli-approvals.js'),
      };
    }
  }

  const t0 = Date.now();
  // key=yes/no is diagnostic only — never log key material. "no" on a keyed
  // provider means withResolvedKey found nothing (bad id + no cloneKeyFrom).
  log('call', `→ ${agent?.name ?? '?'} (${agent?.provider}/${agent?.model || agent?.command || '?'}) msgs=${messages?.length ?? 0} key=${effective.apiKey ? 'yes' : 'no'}${agent?.cloneKeyFrom ? ` cloneKeyFrom=${agent.cloneKeyFrom}` : ''} callId=${callId || '-'}`);
  const controller = new AbortController();
  if (callId) activeControllers.set(callId, controller);
  // Streaming: forward text fragments to the renderer as they arrive.
  // Display-only — the handler still resolves with the same full result, so
  // all parsing (thinking-split, CHECK/TASK) operates on complete text.
  // Stop forwarding once aborted so no stragglers reach the renderer.
  const onDelta = callId
    ? (text) => {
        if (controller.signal.aborted || event.sender.isDestroyed()) return;
        event.sender.send('agent:delta', { callId, text });
      }
    : null;
  try {
    const out = await callAgent(effective, messages, controller.signal, onDelta);
    // servedModel = provider-attested (from the API response body), so the
    // log is a verifiable audit trail of what actually ran per call.
    log('call', `← ${agent?.name ?? '?'} ok in ${Date.now() - t0}ms (${String(out?.text ?? '').length} chars${out?.servedModel ? `, served=${out.servedModel}` : ''})`);
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
// Web ops (web_search/fetch_url) are read-only network access: they need no
// project root at all, so they work in project-less chats too. Optional
// TAVILY_API_KEY env var upgrades search quality; keyless DuckDuckGo otherwise.
ipcMain.handle('check:run', async (_e, { req, projectRoot, agentId }) => {
  const stored = agentId ? getAgentById(app, agentId) : null;
  const isWeb = WEB_OPS.has(req?.op);
  let root = null;
  if (!isWeb) {
    const resolved = resolveProjectRoot(projectRoot);
    if (resolved.none) {
      return { ok: false, output: 'no project folder selected — pick a project to give this agent file access' };
    }
    if (resolved.error) return { ok: false, output: resolved.error };
    root = resolved.root;
  }
  const canWrite = stored?.canWrite === true;
  const result = await runCheck(root, req, {
    canWrite,
    tavilyKey: isWeb ? process.env.TAVILY_API_KEY || '' : undefined,
  });
  log('check', `${stored?.name ?? agentId ?? '?'} ${req?.op} ${req?.arg} canWrite=${canWrite} → ok=${result?.ok}`);
  return result;
});

ipcMain.handle('ollama:models', (_e, agent) => listOllamaModels(agent));

// Provider-aware model list (Ollama, OpenAI-compatible, Anthropic). Key is
// resolved here so the KEY_SET sentinel works — the renderer never sees it.
ipcMain.handle('models:list', (_e, agent) => listModels(withResolvedKey(agent)));

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

// Project file tree (Phase 4) — read-only browsing of the ACTIVE project.
// SECURITY: root must be user-approved (resolveProjectRoot). Hard limits:
// skip node_modules/.git/hidden entries, depth ≤ 6, ≤ 2000 entries total,
// and NEVER follow symlinks (lstat) — a link out of the project can't leak.
ipcMain.handle('project:tree', (_e, { projectRoot }) => {
  const resolved = resolveProjectRoot(projectRoot);
  if (!resolved.root) return { ok: false, error: resolved.error || 'no project selected' };
  const root = resolved.root;
  const MAX_ENTRIES = 2000;
  const MAX_DEPTH = 6;
  let count = 0;
  let truncated = false;
  function walk(dir, rel, depth) {
    const children = [];
    let names;
    try { names = fs.readdirSync(dir); } catch { return children; }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (count >= MAX_ENTRIES) { truncated = true; break; }
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      count++;
      if (st.isDirectory()) {
        if (depth >= MAX_DEPTH) { truncated = true; children.push({ name, path: relPath, type: 'dir', children: [], truncated: true }); continue; }
        children.push({ name, path: relPath, type: 'dir', children: walk(full, relPath, depth + 1) });
      } else if (st.isFile()) {
        children.push({ name, path: relPath, type: 'file' });
      }
    }
    return children;
  }
  const children = walk(root, '', 1);
  log('tree', `${root} → ${count} entries${truncated ? ' (truncated)' : ''}`);
  return { ok: true, name: path.basename(root), children, truncated };
});

// Read one file for the tree's View action (Phase 4) and the Phase 5 review
// panel. Root-validated + path-contained (no ../ or absolute escape, no
// symlinks), 200 KB cap — same containment pattern as file:reveal above.
ipcMain.handle('project:readFile', (_e, { projectRoot, relPath }) => {
  const resolved = resolveProjectRoot(projectRoot);
  if (!resolved.root) return { ok: false, error: resolved.error || 'no project selected' };
  const target = path.resolve(resolved.root, String(relPath || ''));
  const rel = path.relative(resolved.root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'path outside the project folder' };
  }
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: 'not a regular file' };
    const CAP = 200 * 1024;
    let content = fs.readFileSync(target, 'utf8');
    let truncated = false;
    if (content.length > CAP) { content = content.slice(0, CAP); truncated = true; }
    return { ok: true, content, truncated };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Project instructions (Phase 7) — ROUNDTABLE.md at the project root,
// injected into every seat's prompt via the projectInstructions stage. The
// renderer fetches this before EVERY send (assembly stays in src/); the 5 s
// cache per root keeps that cheap while edits are picked up next turn.
const instructionsCache = new Map(); // root -> { at, text }
ipcMain.handle('project:instructions', (_e, { projectRoot }) => {
  const resolved = resolveProjectRoot(projectRoot);
  if (!resolved.root) return '';
  const root = resolved.root;
  const hit = instructionsCache.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.text;
  let text = '';
  try {
    const file = path.join(root, 'ROUNDTABLE.md');
    const st = fs.lstatSync(file);
    if (st.isFile() && !st.isSymbolicLink()) {
      text = fs.readFileSync(file, 'utf8');
      const CAP = 16 * 1024;
      if (text.length > CAP) text = `${text.slice(0, CAP)}\n[truncated]`;
    }
  } catch { /* no file — stage stays absent */ }
  instructionsCache.set(root, { at: Date.now(), text });
  return text;
});

// Sessions (Phase 2) — transcripts/tasks/board persisted in userData.
// Payloads contain no agent configs and no key material (see sessions.js);
// ids are re-validated there, so a hostile renderer can't traverse paths.
ipcMain.handle('sessions:list', () => sessions.listSessions(app));
ipcMain.handle('sessions:load', (_e, id) => sessions.loadSession(app, id));
ipcMain.handle('sessions:save', (_e, payload) => sessions.saveSession(app, payload));
ipcMain.handle('sessions:delete', (_e, id) => sessions.deleteSession(app, id));
ipcMain.handle('sessions:rename', (_e, { id, name }) => sessions.renameSession(app, id, name));

// Cross-session shared memory — one plain-text fact pool per project, saved
// by seats via MEMO: lines and injected back as a prompt stage. Ids are
// re-validated in memory.js (same path-traversal guard as sessions).
ipcMain.handle('memory:load', (_e, projectId) => memory.loadMemos(app, projectId));
ipcMain.handle('memory:add', (_e, { projectId, items }) => memory.addMemos(app, projectId, items));
ipcMain.handle('memory:save', (_e, { projectId, memos }) => memory.saveMemos(app, projectId, memos));

// Export the active session (Phase 9) — native save dialog, exactly the
// script:save pattern. Content is rendered in the renderer; this just saves.
ipcMain.handle('session:export', async (_e, { name, content }) => {
  const result = await dialog.showSaveDialog({ defaultPath: name || 'session.md' });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, String(content ?? ''), 'utf8');
  log('session', `exported ${result.filePath}`);
  return result.filePath;
});

// ---- MCP integrations (GitHub, Google Drive, Gmail, any MCP server) ---------
// The manager lives here because it holds decrypted tokens and spawns server
// processes. SECURITY: like check:run, the write decision is made in MAIN —
// a non-read-only tool requires the calling agent's STORED canWrite flag, so
// a compromised renderer can't grant a seat write access to integrations it
// was never given. User approval (the modal) is UX on top, in the renderer.
const mcp = new McpManager(log);

// mcp:list — configs for the settings UI (env/header values masked) plus the
// live connection snapshot (status, tools with read/write classification).
ipcMain.handle('mcp:list', () => ({
  servers: loadMcpServers(app),
  status: mcp.status(),
}));

// mcp:save — persist configs (KEY_SET sentinel keeps stored secrets), then
// reconcile connections against the new list.
ipcMain.handle('mcp:save', async (_e, servers) => {
  const masked = saveMcpServers(app, servers);
  await mcp.syncServers(getMcpServersDecrypted(app));
  return { servers: masked, status: mcp.status() };
});

// mcp:call — run one tool. `server` may be an id or a slug (CHECK lines carry
// the slug). Non-read-only tools are gated on the stored agent's canWrite.
ipcMain.handle('mcp:call', async (_e, { server, tool, args, agentId }) => {
  const stored = agentId ? getAgentById(app, agentId) : null;
  const { conn, tool: meta } = mcp.findTool(server, tool);
  if (conn && meta && !meta.readOnly && stored?.canWrite !== true) {
    return {
      ok: false,
      output: `write permission denied — "${tool}" changes real data and this agent does not have write access`,
    };
  }
  const result = await mcp.call(server, tool, args);
  log('mcp', `${stored?.name ?? agentId ?? '?'} ${server}.${tool} readOnly=${meta?.readOnly ?? '?'} → ok=${result?.ok}`);
  return result;
});

// ---- Local git (read-only "Changes/Git" panel) ------------------------------
// Reports the working copy of the active project — status, per-file diffs,
// commits, branches. SECURITY: the root is validated through the SAME
// resolveProjectRoot gate as every file read; git only ever runs with cwd set
// to an approved root. This surface is strictly READ-ONLY (no stage/commit/
// push) — mutations would go behind ActionApproval as a separate feature.
function withRoot(projectRoot, fn) {
  const resolved = resolveProjectRoot(projectRoot);
  if (!resolved.root) return Promise.resolve({ ok: false, error: resolved.error || 'no project selected' });
  return fn(resolved.root);
}
ipcMain.handle('git:status', (_e, { projectRoot }) => withRoot(projectRoot, (root) => git.status(root)));
ipcMain.handle('git:diff', (_e, { projectRoot, relPath, staged }) =>
  withRoot(projectRoot, (root) => git.diff(root, relPath, !!staged)));
ipcMain.handle('git:log', (_e, { projectRoot, limit }) => withRoot(projectRoot, (root) => git.log(root, limit)));
ipcMain.handle('git:branches', (_e, { projectRoot }) => withRoot(projectRoot, (root) => git.branches(root)));
ipcMain.handle('git:commitFiles', (_e, { projectRoot, sha }) => withRoot(projectRoot, (root) => git.commitFiles(root, sha)));
ipcMain.handle('git:commitDiff', (_e, { projectRoot, sha, relPath }) =>
  withRoot(projectRoot, (root) => git.commitDiff(root, sha, relPath)));

// Git WRITE ops — mutate the working copy / repo. User-initiated from the
// panel (destructive discard is confirmed in the renderer first). Logged for
// audit like mcp:call; still confined to an approved root by withRoot.
ipcMain.handle('git:stage', async (_e, { projectRoot, relPath }) => {
  const res = await withRoot(projectRoot, (root) => git.stage(root, relPath));
  log('git', `stage ${relPath || '(all)'} → ok=${res.ok}${res.error ? ' ' + res.error : ''}`);
  return res;
});
ipcMain.handle('git:unstage', async (_e, { projectRoot, relPath }) => {
  const res = await withRoot(projectRoot, (root) => git.unstage(root, relPath));
  log('git', `unstage ${relPath || '(all)'} → ok=${res.ok}${res.error ? ' ' + res.error : ''}`);
  return res;
});
ipcMain.handle('git:discard', async (_e, { projectRoot, relPath, untracked, expectedFp }) => {
  const res = await withRoot(projectRoot, async (root) => {
    if (untracked) {
      // Untracked "delete" → OS trash (recoverable), not `git clean -f`.
      const abs = git.resolveInside(root, relPath);
      if (!abs) return { ok: false, error: 'path outside the project folder' };
      if (expectedFp != null && git.fingerprint(root, relPath) !== expectedFp) {
        return { ok: false, stale: true, error: 'This file changed on disk since the panel last refreshed — refresh before discarding.' };
      }
      try { await shell.trashItem(abs); return { ok: true, recoverable: 'trash' }; }
      catch (e) { return { ok: false, error: `could not move to trash: ${e.message}` }; }
    }
    return git.discardTracked(root, relPath, expectedFp); // tracked → recoverable stash
  });
  log('git', `discard ${relPath} untracked=${!!untracked} → ok=${res.ok}${res.stale ? ' STALE' : ''}${res.error ? ' ' + res.error : ''}`);
  return res;
});
ipcMain.handle('git:commit', async (_e, { projectRoot, message }) => {
  const res = await withRoot(projectRoot, (root) => git.commit(root, message));
  log('git', `commit → ok=${res.ok}${res.sha ? ' ' + res.sha : ''}${res.error ? ' ' + res.error : ''}`);
  return res;
});
ipcMain.handle('git:push', async (_e, { projectRoot }) => {
  const res = await withRoot(projectRoot, (root) => git.push(root));
  log('git', `push → ok=${res.ok}${res.error ? ' ' + res.error : ''}`);
  return res;
});
ipcMain.handle('git:pull', async (_e, { projectRoot }) => {
  const res = await withRoot(projectRoot, (root) => git.pull(root));
  log('git', `pull → ok=${res.ok}${res.error ? ' ' + res.error : ''}`);
  return res;
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
  // Connect enabled MCP servers in the background — never blocks the window.
  mcp.syncServers(getMcpServersDecrypted(app)).catch((err) => log('mcp', `startup sync failed: ${err.message}`));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  mcp.closeAll().catch(() => {}); // kill spawned stdio servers with the app
});
// (MCP integrations added 2026-07-11)
