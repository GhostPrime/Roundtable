// MCP client manager. Runs in the Electron main process — the only place that
// holds decrypted tokens and spawns server processes. The renderer talks to it
// exclusively through the mcp:* IPC handlers in main.js.
//
// Capability model (mirrors checks.js):
//   - Read-classified tools (annotations.readOnlyHint === true) are always
//     callable by any seat.
//   - Everything else is treated as a WRITE. Two gates, both required:
//       1. main.js enforces agent.canWrite (stored config, not a renderer flag)
//       2. the renderer pauses for user approval (ActionApproval modal) the
//          same way CHECK: write_file does.
//     Unknown/missing annotations default to write — conservative on purpose.
//
// Transports: stdio (local servers spawned as child processes, e.g. npx …)
// and streamable HTTP (remote servers, e.g. GitHub's hosted MCP endpoint).

const path = require('path');
const { app } = require('electron');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 12_000; // folded into the transcript, same cap as fetch_url
const MAX_TOOLS_PER_SERVER = 60;

// electron/mcp.js -> repo root in dev; inside app.asar when packaged.
const PROJECT_ROOT = path.join(__dirname, '..');

// Roundtable bundles its own MCP stdio servers under scripts/*.js (currently
// just the Yahoo Mail preset — see src/McpSettings.jsx). Those presets store
// a bare `node` command with a path relative to the repo root, which only
// resolves when the app is launched from inside the repo. Detect that exact
// pattern and rewrite it into something that works standalone once installed:
//   - command/args: Electron's own binary run as plain Node (ELECTRON_RUN_AS_NODE)
//     instead of a bare `node`, so no system Node install is required.
//   - path: resolved to an absolute path, and — when packaged — into
//     app.asar.unpacked, since a spawned child process (even Electron-as-Node)
//     cannot reliably read files packed inside app.asar. The script and its
//     full transitive dependency tree are unpacked there by electron-builder's
//     asarUnpack config (electron-builder.yml). Node's own upward node_modules
//     resolution then finds them at app.asar.unpacked/node_modules since
//     scripts/ and node_modules/ remain siblings under app.asar.unpacked.
// Not applied to user-configured MCP servers — only to this repo-relative
// scripts/*.js pattern nothing else plausibly matches.
function resolveBundledStdioCommand(command, args) {
  if (command !== 'node' || !args.length) return null;
  const first = String(args[0] || '').replace(/\\/g, '/');
  const m = first.match(/^scripts\/([\w.-]+\.js)$/);
  if (!m) return null;
  const scriptsRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : PROJECT_ROOT;
  const resolvedScript = path.join(scriptsRoot, 'scripts', m[1]);
  return {
    command: process.execPath,
    args: [resolvedScript, ...args.slice(1)],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

// Server names become the prefix seats use in CHECK lines
// ("CHECK: mcp github.search_issues …"), so keep them line-safe.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'server';
}

// Flatten an MCP tool result (content blocks) into transcript text.
function resultToText(result) {
  const parts = [];
  for (const c of result?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource' && c.resource?.text) parts.push(c.resource.text);
    else if (c.type === 'image') parts.push(`[image ${c.mimeType || ''} — not shown]`);
    else parts.push(`[${c.type} content]`);
  }
  let text = parts.join('\n').trim() || '(empty result)';
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n…[truncated at ${MAX_RESULT_CHARS} of ${text.length} chars]`;
  }
  return text;
}

function toolMeta(t) {
  const ann = t.annotations || {};
  return {
    name: t.name,
    description: String(t.description || '').replace(/\s+/g, ' ').trim(),
    readOnly: ann.readOnlyHint === true,
    destructive: ann.destructiveHint === true,
  };
}

class McpManager {
  constructor(logFn) {
    this.log = logFn || (() => {});
    // id → { config, slug, client, status: 'connecting'|'connected'|'error',
    //        error, tools: [{ name, description, readOnly, destructive }] }
    this.conns = new Map();
  }

  // Config fingerprint — reconnect only when something material changed.
  static fp(s) {
    return JSON.stringify([
      s.transport, s.command, s.args, s.url,
      s.env || {}, s.headers || {}, s.enabled !== false,
    ]);
  }

  // Bring connections in line with `servers` (configs with DECRYPTED env/
  // headers). Never throws — per-server failures land in that server's status.
  async syncServers(servers) {
    const wanted = new Map((servers || []).map((s) => [s.id, s]));
    // Drop removed/disabled/changed connections.
    for (const [id, conn] of [...this.conns]) {
      const next = wanted.get(id);
      if (!next || next.enabled === false || McpManager.fp(next) !== conn.fp) {
        await this.disconnect(id);
      }
    }
    // Connect new/changed enabled servers (sequentially — these are few).
    for (const s of wanted.values()) {
      if (s.enabled === false) continue;
      if (!this.conns.has(s.id)) await this.connect(s);
    }
  }

  async connect(server) {
    const slug = slugify(server.name);
    const conn = {
      config: server, slug, fp: McpManager.fp(server),
      client: null, status: 'connecting', error: null, tools: [],
    };
    this.conns.set(server.id, conn);
    let stderrBuf = ''; // stdio servers only — see the transport branch below
    try {
      const client = new Client({ name: 'roundtable', version: '1.0.0' });
      let transport;
      if (server.transport === 'http') {
        if (!server.url) throw new Error('no URL configured');
        // Users paste bare tokens (ghp_…, github_pat_…) at least as often as
        // full "Bearer <token>" values — auto-prefix so both work.
        const headers = { ...(server.headers || {}) };
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'authorization' && headers[k] && !/^\s*(bearer|basic|token)\s/i.test(headers[k])) {
            headers[k] = `Bearer ${String(headers[k]).trim()}`;
          }
        }
        transport = new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers },
        });
      } else {
        if (!server.command) throw new Error('no command configured');
        let command = server.command;
        let args = Array.isArray(server.args)
          ? server.args
          : String(server.args || '').split(/\s+/).filter(Boolean);
        let env = { ...getDefaultEnvironment(), ...(server.env || {}) };
        const bundled = resolveBundledStdioCommand(command, args);
        if (bundled) {
          command = bundled.command;
          args = bundled.args;
          env = { ...env, ...bundled.env };
        }
        transport = new StdioClientTransport({
          command,
          args,
          env,
          // 'pipe', not 'ignore': when a stdio server dies during the handshake
          // the SDK only reports "Connection closed", which says nothing about
          // why. The child's stderr holds the real cause (missing module, bad
          // path, auth error) — capture it and fold it into the failure below.
          stderr: 'pipe',
        });
        stderrBuf = '';
        transport.stderr?.on('data', (chunk) => {
          if (stderrBuf.length < 2000) stderrBuf += String(chunk);
        });
      }
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      conn.client = client;
      conn.tools = (listed.tools || []).slice(0, MAX_TOOLS_PER_SERVER).map(toolMeta);
      conn.status = 'connected';
      this.log('mcp', `connected ${server.name} (${slug}) — ${conn.tools.length} tools`);
    } catch (err) {
      conn.status = 'error';
      conn.error = String(err?.message || err);
      // "Connection closed" on its own is useless — append what the child said.
      const why = stderrBuf.trim().split('\n').filter(Boolean).slice(-4).join(' | ');
      if (why) conn.error += ` — child stderr: ${why}`;
      conn.client = null;
      this.log('mcp', `connect FAILED ${server.name}: ${conn.error}`);
    }
  }

  async disconnect(id) {
    const conn = this.conns.get(id);
    this.conns.delete(id);
    try { await conn?.client?.close(); } catch { /* already dead */ }
  }

  // Renderer-safe snapshot: no clients, no secrets.
  status() {
    return [...this.conns.entries()].map(([id, c]) => ({
      id,
      slug: c.slug,
      status: c.status,
      error: c.error,
      tools: c.tools,
    }));
  }

  findBySlug(slug) {
    for (const conn of this.conns.values()) if (conn.slug === slug) return conn;
    return null;
  }

  // Look up a tool's metadata (renderer + main both need the read/write class).
  findTool(serverIdOrSlug, toolName) {
    const conn = this.conns.get(serverIdOrSlug) || this.findBySlug(serverIdOrSlug);
    if (!conn) return { conn: null, tool: null };
    return { conn, tool: conn.tools.find((t) => t.name === toolName) || null };
  }

  // Call a tool. Returns { ok, output } like checks.js — errors are real text
  // the seat can see, never a silent failure.
  async call(serverIdOrSlug, toolName, args) {
    const { conn, tool } = this.findTool(serverIdOrSlug, toolName);
    if (!conn) return { ok: false, output: `no connected MCP server "${serverIdOrSlug}" — check Integrations settings` };
    if (conn.status !== 'connected' || !conn.client) {
      return { ok: false, output: `server "${conn.slug}" is not connected (${conn.error || conn.status})` };
    }
    if (!tool) {
      return { ok: false, output: `server "${conn.slug}" has no tool "${toolName}" — available: ${conn.tools.map((t) => t.name).join(', ')}` };
    }
    let parsed = {};
    if (args && typeof args === 'string' && args.trim()) {
      try { parsed = JSON.parse(args); } catch (err) {
        return { ok: false, output: `arguments are not valid JSON (${err.message}) — pass a single JSON object like {"query": "…"}` };
      }
    } else if (args && typeof args === 'object') parsed = args;
    try {
      const result = await conn.client.callTool(
        { name: toolName, arguments: parsed },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      const text = resultToText(result);
      return result.isError ? { ok: false, output: text } : { ok: true, output: text };
    } catch (err) {
      return { ok: false, output: `MCP call failed: ${String(err?.message || err)}` };
    }
  }

  async closeAll() {
    for (const id of [...this.conns.keys()]) await this.disconnect(id);
  }
}

module.exports = { McpManager, slugify };
