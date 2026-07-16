// CLI discovery + path resolution for the 'cli' provider.
//
// Why this exists: GUI apps on Windows (and macOS) often launch with a
// different PATH than the user's terminal, so a bare command like "claude"
// that works in PowerShell fails inside Electron with "not recognized".
// We resolve commands to absolute paths ourselves, checking PATH *and* the
// common install locations terminals add via profile scripts.
//
// SECURITY: resolving to an absolute path lets providers.js spawn WITHOUT
// shell:true — no shell string interpolation of anything model-adjacent.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWin = process.platform === 'win32';

// CLIs the "Detect" button probes for, in display order.
const KNOWN_CLIS = ['claude', 'qwen', 'gemini', 'codex', 'aider'];

// Executable extensions to try on Windows for a bare name.
const WIN_EXTS = ['.cmd', '.exe', '.bat'];

// Install dirs commonly missing from a GUI app's PATH.
function extraDirs() {
  const home = os.homedir();
  const dirs = [];
  if (isWin) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm')); // npm i -g
    dirs.push(path.join(home, '.local', 'bin')); // native installers (claude)
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'bin'));
      dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    }
  } else {
    dirs.push(
      '/usr/local/bin',
      '/opt/homebrew/bin', // macOS arm64 brew
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, 'bin'),
    );
  }
  const seen = new Set();
  return dirs.filter((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

function findInPath(cmd) {
  try {
    const r = spawnSync(isWin ? 'where' : 'which', [cmd], { timeout: 4000 });
    if (r.status === 0) {
      const lines = r.stdout.toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!isWin) return lines[0] || null;
      // Windows: `where` also lists npm's extensionless bash shim (for Git
      // Bash), which Windows can't spawn → ENOENT. Prefer real executables.
      const exec = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l));
      if (exec) return exec;
      // Only an extensionless hit? Try its .cmd/.exe sibling before giving up.
      for (const l of lines) {
        for (const ext of WIN_EXTS) {
          try { if (fs.statSync(l + ext).isFile()) return l + ext; } catch { /* next */ }
        }
      }
      return null; // bash shims are unusable on Windows
    }
  } catch { /* fall through to dir scan */ }
  return null;
}

function findInDirs(cmd) {
  const names = isWin ? WIN_EXTS.map((e) => cmd + e) : [cmd];
  for (const dir of extraDirs()) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* not here */ }
    }
  }
  return null;
}

// Resolve a user-entered command to an absolute path, or null if not found.
// Accepts either a bare name ("claude") or an explicit path. Cached per name
// so chat turns don't re-run `where` every time.
const resolveCache = new Map();
function resolveCommand(cmd) {
  const key = (cmd || '').trim();
  if (!key) return null;
  if (resolveCache.has(key)) return resolveCache.get(key);

  let resolved = null;
  if (key.includes('/') || key.includes('\\')) {
    // Explicit path. On Windows, prefer .cmd/.exe siblings over an
    // extensionless file — that's npm's bash shim, which Windows can't spawn.
    const candidates = isWin && !path.extname(key)
      ? [...WIN_EXTS.map((e) => key + e), key]
      : [key];
    for (const c of candidates) {
      try { if (fs.statSync(c).isFile()) { resolved = c; break; } } catch { /* next */ }
    }
  } else {
    resolved = findInPath(key) || findInDirs(key);
  }
  resolveCache.set(key, resolved);
  return resolved;
}

// How to spawn a resolved path without shell:true. Windows .cmd/.bat shims
// (npm globals) aren't directly executable — run them via cmd.exe /c with an
// argument array.
//
// SECURITY: cmd.exe RE-PARSES the assembled command line, so metacharacters
// in an arg (& | < > ^ % !) can break out into extra commands even without
// shell:true — libuv only quotes args containing whitespace. None of the CLI
// flags we ever pass (--model x, -p, …) need these characters, so refuse them
// outright rather than attempt cmd.exe quoting (which is famously unreliable).
// Direct (non-shim) spawns don't go through cmd.exe and are unaffected.
const CMD_UNSAFE = /[&|<>^%!"\r\n]/;
function spawnSpec(resolvedPath, args) {
  if (isWin && /\.(cmd|bat)$/i.test(resolvedPath)) {
    const bad = (args || []).find((a) => CMD_UNSAFE.test(String(a)));
    if (bad !== undefined) {
      throw new Error(`argument ${JSON.stringify(bad)} contains characters cmd.exe would interpret (&|<>^%!") — remove them from this agent's Extra arguments`);
    }
    return { file: 'cmd.exe', args: ['/c', resolvedPath, ...args] };
  }
  return { file: resolvedPath, args };
}

function getVersion(resolvedPath) {
  try {
    const spec = spawnSpec(resolvedPath, ['--version']);
    const r = spawnSync(spec.file, spec.args, { timeout: 8000 });
    if (r.status === 0) {
      return r.stdout.toString().trim().split(/\r?\n/)[0].slice(0, 80);
    }
  } catch { /* version is best-effort */ }
  return '';
}

// Probe for known CLIs. Returns [{ name, path, version }] for everything found.
function detectClis() {
  const found = [];
  for (const name of KNOWN_CLIS) {
    const p = resolveCommand(name);
    if (!p) continue;
    found.push({ name, path: p, version: getVersion(p) });
  }
  return found;
}

module.exports = { detectClis, resolveCommand, spawnSpec, KNOWN_CLIS };
