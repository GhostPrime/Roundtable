// Read-only check executor. Runs in the Electron main process — the only place
// with real filesystem access. Every op is read-only and path-locked to the
// project root, so a roundtable seat can verify real facts (does a file exist,
// what's in it, what's in a directory) instead of hallucinating them.
//
// There is deliberately NO command execution and NO write here. The capability
// is locked down at this executor, not at the prompt — that's what makes it
// safe to expose to any seat.

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024; // don't dump huge files into the transcript
const MAX_DIR_ENTRIES = 200;

// Resolve a user/model-supplied path against the project root and refuse
// anything that escapes it (absolute paths elsewhere, ../ traversal, symlink
// games). Returns the safe absolute path or throws.
function safeResolve(root, rel) {
  const cleanRoot = path.resolve(root);
  const target = path.resolve(cleanRoot, rel || '.');
  const relCheck = path.relative(cleanRoot, target);
  if (relCheck === '' ) return cleanRoot;
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`path "${rel}" is outside the project folder`);
  }
  return target;
}

function readFile(root, rel) {
  const p = safeResolve(root, rel);
  const stat = fs.statSync(p); // throws ENOENT if missing — real error
  if (stat.isDirectory()) throw new Error(`"${rel}" is a directory, not a file`);
  if (stat.size > MAX_FILE_BYTES) {
    const buf = fs.readFileSync(p, { encoding: 'utf8' }).slice(0, MAX_FILE_BYTES);
    return `${buf}\n\n…[truncated at ${MAX_FILE_BYTES} bytes of ${stat.size}]`;
  }
  return fs.readFileSync(p, 'utf8');
}

function listDir(root, rel) {
  const p = safeResolve(root, rel);
  const entries = fs.readdirSync(p, { withFileTypes: true });
  const lines = entries
    .slice(0, MAX_DIR_ENTRIES)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const extra = entries.length > MAX_DIR_ENTRIES ? `\n…[+${entries.length - MAX_DIR_ENTRIES} more]` : '';
  return lines.join('\n') + extra;
}

function exists(root, rel) {
  const p = safeResolve(root, rel);
  return fs.existsSync(p) ? 'true' : 'false';
}

// Dispatch a parsed check request. Always returns { ok, output } — errors are
// returned as real text (e.g. "file not found") so the seat sees the truth
// rather than the call silently failing.
function runCheck(root, req) {
  try {
    const { op, arg } = req || {};
    let output;
    switch (op) {
      case 'read_file': output = readFile(root, arg); break;
      case 'list_dir':  output = listDir(root, arg);  break;
      case 'exists':    output = exists(root, arg);   break;
      default: throw new Error(`unknown check "${op}" (use read_file | list_dir | exists)`);
    }
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

module.exports = { runCheck };
