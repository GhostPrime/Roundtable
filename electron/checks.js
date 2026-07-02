// Check executor. Runs in the Electron main process — the only place with real
// filesystem access. All ops are path-locked to the project root via safeResolve
// so a seat can never escape the folder the user designated.
//
// Read ops (read_file, list_dir, exists) are always available.
// Write op (write_file) requires the calling agent to have canWrite: true. This
// is enforced here in the executor — not just in the prompt — so it cannot be
// bypassed by a clever model response.
//
// There is deliberately NO command execution. The capability boundary lives at
// this executor, not at the prompt.

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024; // don't dump huge files into the transcript
const MAX_DIR_ENTRIES = 200;

// Resolve a user/model-supplied path against the project root and refuse
// anything that escapes it (absolute paths elsewhere, ../ traversal, symlink
// games). Returns the safe absolute path or throws.
//
// Two layers, both required:
//   1. Lexical: path.resolve + path.relative catches ../ and absolute paths,
//      but is purely textual — it does NOT follow symlinks.
//   2. Physical: realpath the nearest EXISTING ancestor of the target (the
//      target itself may not exist yet for write_file) and confirm it still
//      lives under the realpathed root. This is what actually stops a symlink
//      inside the project from pointing the op outside it.
function safeResolve(root, rel) {
  const cleanRoot = path.resolve(root);
  const target = path.resolve(cleanRoot, rel || '.');
  const relCheck = path.relative(cleanRoot, target);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`path "${rel}" is outside the project folder`);
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(cleanRoot);
  } catch {
    realRoot = cleanRoot; // root itself missing — later ops will surface ENOENT
  }
  // Walk up to the nearest existing ancestor (terminates at the drive root).
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realProbe;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    realProbe = probe;
  }
  const relReal = path.relative(realRoot, realProbe);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(`path "${rel}" resolves outside the project folder (symlink)`);
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

// Write a file. Only allowed when canWrite is true. Creates intermediate
// directories as needed. Content must be a string.
function writeFile(root, rel, content) {
  if (content === undefined || content === null) throw new Error('write_file requires content');
  const p = safeResolve(root, rel);
  // Never allow writing directories — rel must end in a filename.
  if (rel.endsWith('/') || rel.endsWith('\\')) {
    throw new Error(`"${rel}" looks like a directory — provide a file path`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content), 'utf8');
  return `wrote ${rel} (${Buffer.byteLength(String(content), 'utf8')} bytes)`;
}

// Dispatch a parsed check request. Always returns { ok, output } — errors are
// returned as real text (e.g. "file not found") so the seat sees the truth
// rather than the call silently failing.
// opts.canWrite must be explicitly true to allow write_file.
function runCheck(root, req, opts = {}) {
  try {
    const { op, arg, content } = req || {};
    let output;
    switch (op) {
      case 'read_file': output = readFile(root, arg); break;
      case 'list_dir':  output = listDir(root, arg);  break;
      case 'exists':    output = exists(root, arg);   break;
      case 'write_file':
        if (!opts.canWrite) {
          throw new Error('write permission denied — this agent does not have write access to the project folder');
        }
        output = writeFile(root, arg, content);
        break;
      default: throw new Error(`unknown check "${op}" (use read_file | list_dir | exists | write_file)`);
    }
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

module.exports = { runCheck };
