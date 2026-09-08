// Resolver + bootstrapper for the Blender MCP server (projects.blender.org/lab/blender_mcp).
//
// Why this file exists: unlike every other preset, Blender's server is a Python
// package that has to be installed on the machine before anything can spawn it.
// It is not on PyPI (source-only, from a Gitea subdirectory), so there is no
// `npx -y`-style one-liner to paste into the preset. Without this module the
// preset can only ship a placeholder command and a note telling the user to go
// build a venv by hand — which is not a preset, it is a README with a button.
//
// So: the preset stores the bare sentinel `blender-mcp`, and mcp.js hands it
// here at connect time. We find a working install, or build one, and hand back
// an absolute path to the console script.
//
// Search order (first working hit wins):
//   1. cached path from a previous resolve (userData/blender-mcp.json)
//   2. Roundtable's own managed venv (userData/blender-mcp-venv)
//   3. conventional user venvs (C:\blender-mcp-venv, ~/.blender-mcp-venv)
//   4. PATH
// Nothing found and bootstrap allowed → create the managed venv and pip-install.
//
// "Working" is not "present". A found binary is validated by actually running
// it (see probeBinary) because the failure mode we hit in practice is an
// install that exists and is broken: blender-mcp 1.0.0 declares
// `mcp[cli]>=1.2.0` with no upper bound, and the MCP Python SDK's 2.0.0
// (2026-07-28) removed `mcp.server.fastmcp`, which blmcp/__init__.py imports at
// module scope. An unpinned install therefore resolves fine, spawns fine, and
// dies at import with ModuleNotFoundError. Hence the <2 pin below, and hence
// probing rather than trusting existsSync.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { app } = require('electron');

const SENTINEL = 'blender-mcp';

// Source install, pinned. Keep PIN_SPEC and the McpSettings preset hint in sync.
const PKG_SPEC = 'blender-mcp @ git+https://projects.blender.org/lab/blender_mcp.git#subdirectory=mcp';
const PIN_SPEC = 'mcp[cli]<2';

const IS_WIN = process.platform === 'win32';
const PROBE_TIMEOUT_MS = 20_000;
const VENV_TIMEOUT_MS = 120_000;
const PIP_TIMEOUT_MS = 600_000; // source install pulls a ~5MB doc tree; be patient

// Serialises concurrent resolves. syncServers() is sequential today, but a
// second Blender row (or a fast disable/enable) must not race two bootstraps
// into the same venv directory.
let inFlight = null;

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function cacheFile() {
  return path.join(app.getPath('userData'), 'blender-mcp.json');
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return typeof raw?.bin === 'string' ? raw.bin : null;
  } catch { return null; }
}

function writeCache(bin) {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify({ bin, at: new Date().toISOString() }, null, 2));
  } catch { /* cache is an optimisation — a failed write just costs a re-probe */ }
}

// Managed venv lives in userData: per-user, no admin rights, survives app
// updates, and goes away cleanly on uninstall. Never next to the app itself —
// that lands in Program Files on a packaged install and is not writable.
function managedVenv() {
  return path.join(app.getPath('userData'), 'blender-mcp-venv');
}

function venvBin(root) {
  return IS_WIN
    ? path.join(root, 'Scripts', 'blender-mcp.exe')
    : path.join(root, 'bin', 'blender-mcp');
}

function venvPython(root) {
  return IS_WIN
    ? path.join(root, 'Scripts', 'python.exe')
    : path.join(root, 'bin', 'python');
}

function candidatePaths() {
  const home = os.homedir();
  const out = [managedVenv()];
  if (IS_WIN) out.push('C:\\blender-mcp-venv');
  out.push(path.join(home, '.blender-mcp-venv'), path.join(home, 'blender-mcp-venv'));
  return out.map(venvBin);
}

// Ask the OS where a bare `blender-mcp` lives. Only useful when the user has a
// venv activated in the shell that launched Roundtable, which is rare — but
// free to check and it makes an already-working setup Just Work.
async function fromPath() {
  const r = await run(IS_WIN ? 'where' : 'which', [SENTINEL], PROBE_TIMEOUT_MS);
  if (!r.ok) return null;
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first && fs.existsSync(first) ? first : null;
}

// Run the thing. `--help` is enough: blmcp imports FastMCP at module scope, so
// a broken dependency tree fails here exactly as it would on a real spawn,
// without starting a server or touching Blender.
async function probeBinary(bin) {
  if (!bin || !fs.existsSync(bin)) return { ok: false, why: 'not present' };
  const r = await run(bin, ['--help'], PROBE_TIMEOUT_MS);
  if (r.ok) return { ok: true };
  const why = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ')
    || `exited ${r.code}`;
  return { ok: false, why };
}

// Find an interpreter >= 3.10 (blender-mcp's floor). `py -3` first on Windows:
// the launcher is present on python.org installs and resolves the newest 3.x
// even when `python` is the App Execution Alias stub that opens the Store.
async function findPython() {
  const tries = IS_WIN
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, pre] of tries) {
    const r = await run(cmd, [...pre, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], PROBE_TIMEOUT_MS);
    if (!r.ok) continue;
    const m = r.stdout.trim().match(/^(\d+)\.(\d+)$/);
    if (!m) continue;
    const [maj, min] = [Number(m[1]), Number(m[2])];
    if (maj > 3 || (maj === 3 && min >= 10)) return { cmd, pre, version: `${maj}.${min}` };
  }
  return null;
}

async function bootstrap(log) {
  const py = await findPython();
  if (!py) {
    throw new Error(
      'no Python 3.10+ found. Install it from python.org (tick "Add python.exe to PATH"), then reconnect. '
      + "Blender's bundled interpreter cannot be used for this.",
    );
  }
  // git is not optional: the package is source-only from a Gitea subdirectory,
  // so pip shells out to git to fetch it.
  const git = await run('git', ['--version'], PROBE_TIMEOUT_MS);
  if (!git.ok) {
    throw new Error('git not found on PATH — pip needs it to fetch blender-mcp from projects.blender.org. Install Git, then reconnect.');
  }

  const root = managedVenv();
  log('mcp', `blender: no working install found — building venv at ${root} (python ${py.version}, first run only)`);

  if (!fs.existsSync(venvPython(root))) {
    const mk = await run(py.cmd, [...py.pre, '-m', 'venv', root], VENV_TIMEOUT_MS);
    if (!mk.ok) throw new Error(`could not create venv: ${(mk.stderr || mk.stdout).trim().slice(0, 300)}`);
  }

  log('mcp', 'blender: installing blender-mcp (source build, this takes a minute)…');
  const pip = await run(
    venvPython(root),
    ['-m', 'pip', 'install', '--disable-pip-version-check', PKG_SPEC, PIN_SPEC],
    PIP_TIMEOUT_MS,
  );
  if (!pip.ok) {
    throw new Error(`pip install failed: ${(pip.stderr || pip.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
  }

  const bin = venvBin(root);
  const probe = await probeBinary(bin);
  if (!probe.ok) throw new Error(`installed but not runnable: ${probe.why}`);
  log('mcp', `blender: ready — ${bin}`);
  return bin;
}

async function resolveOnce(log, allowBootstrap) {
  const cached = readCache();
  if (cached) {
    const probe = await probeBinary(cached);
    if (probe.ok) return cached;
    log('mcp', `blender: cached install at ${cached} no longer works (${probe.why}) — re-resolving`);
  }

  const seen = new Set(cached ? [cached] : []);
  const broken = [];
  for (const bin of candidatePaths()) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    const probe = await probeBinary(bin);
    if (probe.ok) { writeCache(bin); return bin; }
    if (probe.why !== 'not present') broken.push(`${bin} (${probe.why})`);
  }

  const onPath = await fromPath();
  if (onPath && !seen.has(onPath)) {
    const probe = await probeBinary(onPath);
    if (probe.ok) { writeCache(onPath); return onPath; }
    broken.push(`${onPath} (${probe.why})`);
  }

  // A present-but-broken install in the user's OWN venv is not ours to
  // overwrite, but it is almost certainly the mcp 2.x import failure, so say so
  // rather than silently building a second copy beside it.
  if (broken.length && !allowBootstrap) {
    throw new Error(
      `found blender-mcp but it does not run: ${broken[0]}. `
      + `If that is the mcp 2.x import error, repair it with:  pip install "${PIN_SPEC}"`,
    );
  }
  if (!allowBootstrap) {
    throw new Error('blender-mcp is not installed, and automatic setup is disabled for this server.');
  }
  if (broken.length) {
    log('mcp', `blender: existing install is broken — ${broken[0]}; building a clean managed venv instead`);
  }
  const bin = await bootstrap(log);
  writeCache(bin);
  return bin;
}

// True when a stdio server config is the Blender preset in its unresolved form:
// a bare `blender-mcp` with no path separator. A user who has typed an absolute
// path has opted out — we hand it straight through untouched.
function isSentinel(command, args) {
  if (args && args.length) return false;
  const c = String(command || '').trim();
  if (!c) return false;
  const bare = IS_WIN ? c.replace(/\.exe$/i, '') : c;
  return bare === SENTINEL && !/[\\/]/.test(bare);
}

// mcp.js entry point. Returns { command } or null when this isn't ours.
async function resolveBlenderStdioCommand(command, args, log, opts) {
  if (!isSentinel(command, args)) return null;
  const allowBootstrap = opts?.allowBootstrap !== false;
  if (!inFlight) {
    inFlight = resolveOnce(log || (() => {}), allowBootstrap)
      .finally(() => { inFlight = null; });
  }
  return { command: await inFlight };
}

module.exports = {
  SENTINEL,
  PIN_SPEC,
  isSentinel,
  managedVenv,
  resolveBlenderStdioCommand,
};
