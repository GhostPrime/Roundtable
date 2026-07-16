// Local-git reader for the "SourceTree-like" Changes/Git panel.
//
// Scope on purpose: READ-ONLY. This module shells out to the user's own `git`
// against an already-approved project root and reports the working copy —
// status, per-file diffs, recent commits, branches. It intentionally does NOT
// stage, commit, discard, checkout, push, or pull. Every mutation belongs
// behind the ActionApproval gate and is a deliberate follow-up (see the panel
// notes), so nothing here can alter the repo.
//
// Design mirrors the rest of electron/:
//   * No new dependency — spawn `git` directly (reuse cli-detect's resolver +
//     spawnSpec so Windows shims are handled), just like providers.js.
//   * Never throws across the IPC boundary: every path returns a seat/renderer
//     readable { ok, ... } | { ok:false, error } shape, like checks.js / mcp.js.
//   * Diffs are returned as { oldText, newText } and rendered by the existing
//     diffLines.js in the renderer — same engine ReviewPanel already uses — so
//     there's one diff code path in the app, not two.
//
// SECURITY: the caller (main.js) resolves + approves the root via
// resolveProjectRoot BEFORE calling in here. This module treats `root` as a
// trusted absolute path and only ever runs git with cwd=root. `relPath` is
// passed to git after a containment check (no absolute / no ../ escape).

const path = require('path');
const { spawn } = require('child_process');
const { resolveCommand, spawnSpec } = require('./cli-detect');

const GIT_TIMEOUT = 15000; // ms — a status/diff/log on a normal repo is instant
const NET_TIMEOUT = 120000; // ms — push/pull hit the network; give them room
const MAX_BUF = 4 * 1024 * 1024; // 4 MB stdout cap; blobs beyond this are "too large"
const LOG_LIMIT = 50; // commits returned by log()

// Resolve `git` once (cli-detect caches internally). null → not installed.
let gitPathCache;
function gitPath() {
  if (gitPathCache === undefined) gitPathCache = resolveCommand('git') || null;
  return gitPathCache;
}

// Run one git invocation. Resolves { ok, stdout, stderr, code } and NEVER
// rejects — spawn errors (ENOENT, timeout) come back as ok:false with text.
function run(root, args, { binary = false, timeout = GIT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const git = gitPath();
    if (!git) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: 'git is not installed or not on PATH' });
      return;
    }
    const spec = spawnSpec(git, args);
    let child;
    try {
      child = spawn(spec.file, spec.args, { cwd: root, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: `could not run git: ${e.message}` });
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let overflow = false;
    let done = false;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, code: -1, stdout: '', stderr: '', error: 'git timed out' }); }, timeout);

    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen > MAX_BUF) { overflow = true; try { child.kill(); } catch {} return; }
      outChunks.push(d);
    });
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => finish({ ok: false, code: -1, stdout: '', stderr: '', error: `git failed to start: ${e.message}` }));
    child.on('close', (code) => {
      if (overflow) { finish({ ok: false, code: code ?? -1, stdout: '', stderr: '', error: 'output too large to display' }); return; }
      const outBuf = Buffer.concat(outChunks);
      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      finish({
        ok: code === 0,
        code: code ?? -1,
        stdout: binary ? outBuf : outBuf.toString('utf8'),
        buffer: outBuf,
        stderr,
        error: code === 0 ? undefined : (stderr || `git exited with code ${code}`),
      });
    });
  });
}

// Is `root` inside a git work tree? Cheap gate used by every public method so
// the panel can show a friendly "not a git repo" empty state.
async function isRepo(root) {
  const r = await run(root, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

// Contain a caller-supplied path to the repo (no absolute, no ../ escape).
// Returns the repo-relative POSIX-ish path git wants, or null if it escapes.
function safeRel(root, relPath) {
  const target = path.resolve(root, String(relPath || ''));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// ---- status --------------------------------------------------------------
// Parse `git status --porcelain=v2 --branch`. Returns per-file staged /
// unstaged status letters + a branch/ahead/behind header, SourceTree-style.
function parseStatus(text) {
  const files = [];
  const info = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false };
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length).trim();
      if (h === '(detached)') info.detached = true; else info.branch = h;
    } else if (line.startsWith('# branch.upstream ')) {
      info.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { info.ahead = +m[1]; info.behind = +m[2]; }
    } else if (line[0] === '1' || line[0] === '2') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path><TAB><origPath>
      // Positional regex — NOT indexOf: for unstaged edits hH === hI, so an
      // indexOf on the last field would match the wrong (earlier) occurrence
      // and swallow a hash into the path.
      const ren = line[0] === '2';
      const m = ren
        ? line.match(/^2 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/)
        : line.match(/^1 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (!m) continue;
      const xy = m[1] || '..';
      let file = m[2];
      let orig;
      if (ren) { const t = file.split('\t'); file = t[0]; orig = t[1]; }
      files.push({
        path: file,
        orig,
        index: xy[0] === '.' ? '' : xy[0],   // staged status letter
        worktree: xy[1] === '.' ? '' : xy[1], // unstaged status letter
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        untracked: false,
      });
    } else if (line[0] === 'u') {
      const file = line.split(' ').slice(10).join(' ');
      files.push({ path: file, index: 'U', worktree: 'U', staged: true, unstaged: true, conflicted: true, untracked: false });
    } else if (line[0] === '?') {
      files.push({ path: line.slice(2), index: '', worktree: '?', staged: false, unstaged: true, untracked: true });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...info, files };
}

async function status(root) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const r = await run(root, ['status', '--porcelain=v2', '--branch']);
  if (!r.ok) return { ok: false, error: r.error };
  const parsed = parseStatus(r.stdout);
  // Stamp each row with its working-file fingerprint at paint time; discard
  // compares against this to catch a stale panel (the freshness floor).
  for (const f of parsed.files) f.fp = fingerprint(root, f.path);
  return { ok: true, ...parsed };
}

// ---- diff ----------------------------------------------------------------
// Return { oldText, newText } for one file so the renderer's diffLines.js can
// draw it. `staged=false` → working tree vs index (unstaged changes).
//         `staged=true`  → index vs HEAD (what a commit would record).
// Untracked files diff against empty; deletions produce empty newText.
async function blob(root, spec) {
  // spec e.g. ":path" (index), "HEAD:path". Missing blob (new/deleted) → ''.
  const r = await run(root, ['show', spec], { binary: true });
  if (!r.ok) return { text: '', missing: true };
  const buf = r.buffer;
  // crude binary sniff — a NUL in the first 8KB
  if (buf.includes(0, 0, Math.min(buf.length, 8192))) return { text: null, binary: true };
  return { text: buf.toString('utf8') };
}

async function diff(root, relPath, staged = false) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const rel = safeRel(root, relPath);
  if (!rel) return { ok: false, error: 'path outside the project folder' };

  // Figure out the file's state so we handle new/untracked/deleted cleanly.
  const st = await run(root, ['status', '--porcelain=v2', '--', rel]);
  const line = (st.stdout || '').split('\n').find(Boolean) || '';
  const untracked = line.startsWith('? ');

  // Resolve each side. Working-tree side is read from disk; committed/index
  // sides come from git blobs. Missing blob (new/deleted) → empty string.
  let oldSide;
  let newSide;
  if (staged) {
    oldSide = await blob(root, `HEAD:${rel}`); // last commit
    newSide = await blob(root, `:${rel}`);     // staged (index)
  } else if (untracked) {
    oldSide = { text: '' };                     // nothing tracked yet
    newSide = workingFile(root, rel);           // whole file is "added"
  } else {
    oldSide = await blob(root, `:${rel}`);       // index
    newSide = workingFile(root, rel);            // working tree
  }

  if (oldSide.binary || newSide.binary) return { ok: true, binary: true, path: rel };
  if (newSide.tooLarge) return { ok: true, tooLarge: true, path: rel };
  return { ok: true, path: rel, oldText: oldSide.text ?? '', newText: newSide.text ?? '', staged, untracked };
}

// Read the working-tree copy of a file straight from disk. `rel` is already
// containment-checked by safeRel(); apply the same size / binary guards as
// git blobs so the renderer never has to cope with a 50MB or binary payload.
function workingFile(root, rel) {
  const fs = require('fs');
  try {
    const full = path.resolve(root, rel);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile()) return { text: '', missing: true };
    const buf = fs.readFileSync(full);
    if (buf.length > MAX_BUF) return { text: null, tooLarge: true };
    if (buf.includes(0, 0, Math.min(buf.length, 8192))) return { text: null, binary: true };
    return { text: buf.toString('utf8') };
  } catch {
    return { text: '', missing: true };
  }
}

// ---- log -----------------------------------------------------------------
// Recent commits on the current branch. Unit-separator / record-separator
// framing avoids any quoting headaches with commit subjects.
async function log(root, limit = LOG_LIMIT) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%ar', '%s'].join('%x1f') + '%x1e';
  const n = Math.max(1, Math.min(200, limit | 0));
  const r = await run(root, ['--no-pager', 'log', `--max-count=${n}`, `--pretty=format:${fmt}`]);
  if (!r.ok) return { ok: false, error: r.error };
  const commits = r.stdout.split('\x1e').map((rec) => rec.replace(/^\n/, '')).filter(Boolean).map((rec) => {
    const [hash, short, author, email, isoDate, relDate, subject] = rec.split('\x1f');
    return { hash, short, author, email, isoDate, relDate, subject };
  });
  return { ok: true, commits };
}

// ---- branches ------------------------------------------------------------
async function branches(root) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const r = await run(root, ['branch', '--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(objectname:short)']);
  if (!r.ok) return { ok: false, error: r.error };
  const list = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [head, name, upstream, sha] = line.split('\0');
    return { name, current: head.trim() === '*', upstream: upstream || null, sha };
  });
  return { ok: true, branches: list };
}

// ---- commit detail (roadmap #5) ------------------------------------------
// A commit SHA only ever comes from our own log() output, but validate anyway
// so nothing weird reaches the `git show` arg.
function validSha(sha) { return typeof sha === 'string' && /^[0-9a-f]{4,40}$/i.test(sha); }

// Files touched by one commit. `--root` makes the initial commit list its
// files as adds (otherwise diff-tree emits nothing for a parentless commit).
async function commitFiles(root, sha) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  if (!validSha(sha)) return { ok: false, error: 'invalid commit id' };
  const r = await run(root, ['diff-tree', '--no-commit-id', '--name-status', '-M', '-r', '--root', sha]);
  if (!r.ok) return { ok: false, error: r.error };
  const files = r.stdout.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    const code = parts[0];              // M, A, D, R100, C75, …
    const status = code[0];
    // rename/copy lines are: <code>\t<old>\t<new>
    const isRen = status === 'R' || status === 'C';
    const file = isRen ? parts[2] : parts[1];
    const orig = isRen ? parts[1] : undefined;
    return { path: file, orig, status, worktree: status, index: '' };
  }).filter((f) => f.path);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, sha, files };
}

// Diff of one file AS OF a commit: parent blob vs commit blob. A missing side
// (added file / deleted file / root commit with no parent) becomes empty text,
// so the existing renderer shows a clean all-add / all-del diff.
async function commitDiff(root, sha, relPath) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  if (!validSha(sha)) return { ok: false, error: 'invalid commit id' };
  const rel = safeRel(root, relPath);
  if (!rel) return { ok: false, error: 'path outside the project folder' };
  const oldSide = await blob(root, `${sha}^:${rel}`); // parent (missing on add/root)
  const newSide = await blob(root, `${sha}:${rel}`);   // this commit (missing on delete)
  if (oldSide.binary || newSide.binary) return { ok: true, binary: true, path: rel };
  return { ok: true, path: rel, oldText: oldSide.text ?? '', newText: newSide.text ?? '', sha };
}

// ---- write ops (roadmap #2/#3) -------------------------------------------
// These MUTATE the working copy / repo. They're user-initiated from the panel;
// the renderer confirms destructive actions (discard) before calling. All are
// path-contained; a null/empty relPath means "everything" for stage/unstage.
// SECURITY: still only ever runs with cwd = an approved root (main.js gate).
async function stage(root, relPath) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  let args;
  if (relPath == null || relPath === '') args = ['add', '-A'];
  else { const rel = safeRel(root, relPath); if (!rel) return { ok: false, error: 'path outside the project folder' }; args = ['add', '--', rel]; }
  const r = await run(root, args);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

async function unstage(root, relPath) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  let args;
  if (relPath == null || relPath === '') args = ['reset', '-q'];
  else { const rel = safeRel(root, relPath); if (!rel) return { ok: false, error: 'path outside the project folder' }; args = ['reset', '-q', '--', rel]; }
  const r = await run(root, args);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// Working-file fingerprint for the freshness floor. mtime+size is enough to
// detect "this file changed on disk since the panel painted it" without reading
// contents. null when it isn't a regular file (deleted / symlink). Carried on
// every status row so a discard can verify the row still matches disk.
function fingerprint(root, relPath) {
  const fs = require('fs');
  const rel = safeRel(root, relPath);
  if (!rel) return null;
  try {
    const st = fs.lstatSync(path.resolve(root, rel));
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return `${st.mtimeMs}:${st.size}`;
  } catch { return null; }
}

// Absolute path IF contained in root — used by main.js's shell.trashItem on the
// untracked path (git.js has no electron shell). null when it escapes.
function resolveInside(root, relPath) {
  const rel = safeRel(root, relPath);
  return rel ? path.resolve(root, rel) : null;
}

// Recoverable discard of a TRACKED file's changes: stash just that path so the
// work is retrievable via `git stash`, rather than `git checkout` which throws
// it away unrecoverably (not even in the reflog). Freshness floor: refuse if the
// working file changed since the panel painted it (expectedFp mismatch).
async function discardTracked(root, relPath, expectedFp) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const rel = safeRel(root, relPath);
  if (!rel) return { ok: false, error: 'path outside the project folder' };
  if (expectedFp != null && fingerprint(root, rel) !== expectedFp) {
    return { ok: false, stale: true, error: 'This file changed on disk since the panel last refreshed — refresh and look again before discarding.' };
  }
  const r = await run(root, ['stash', 'push', '--quiet', '-m', `discard ${rel}`, '--', rel]);
  if (r.ok) return { ok: true, recoverable: 'stash' };
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/No local changes/i.test(out)) return { ok: true, recoverable: null, note: 'already clean' };
  return { ok: false, error: r.error || out.trim() };
}

// Commit whatever is currently staged. Fails loudly (seat/user-readable) if
// nothing is staged or git identity isn't configured — both come back as text.
async function commit(root, message) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const msg = String(message ?? '').trim();
  if (!msg) return { ok: false, error: 'empty commit message' };
  const r = await run(root, ['commit', '-m', msg]);
  if (!r.ok) return { ok: false, error: r.error };
  const head = await run(root, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, sha: head.ok ? head.stdout.trim() : undefined };
}

// ---- push / pull (roadmap #4) --------------------------------------------
// Network ops that lean on git's own credential helper (same creds a terminal
// `git push` uses). Progress is written to stderr even on success, so we fold
// stderr into the returned output. Auth/other failures come back as text.
async function push(root) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const br = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (br.stdout || '').trim();
  if (!branch || branch === 'HEAD') return { ok: false, error: 'detached HEAD — checkout a branch first' };
  // First push of a new branch has no upstream → set it (-u origin <branch>).
  const up = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const args = up.ok ? ['push'] : ['push', '-u', 'origin', branch];
  const r = await run(root, args, { timeout: NET_TIMEOUT });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return r.ok ? { ok: true, output } : { ok: false, error: output || r.error };
}

// --ff-only: only fast-forwards. If local and remote have diverged it aborts
// cleanly (no merge commit, no working-tree surprise) and reports it, rather
// than dropping the user into a half-merged state from a GUI button.
async function pull(root) {
  if (!(await isRepo(root))) return { ok: false, error: 'not a git repository' };
  const up = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return { ok: false, error: 'no upstream set for this branch — push it first' };
  const r = await run(root, ['pull', '--ff-only'], { timeout: NET_TIMEOUT });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return r.ok ? { ok: true, output } : { ok: false, error: output || r.error };
}

// ---- seat-facing reads (roadmap #7) --------------------------------------
// A single READ-ONLY entry point for AI seats via `CHECK: git <sub> [arg]`.
// Only status / diff / log — never stage/commit/discard/push/pull, which stay
// with the human in the panel. Output is plain text, capped so it can't flood
// the transcript. Every failure is returned as readable text, never thrown.
const SEAT_CAP = 12000;
function capSeat(text) {
  const s = String(text);
  return s.length > SEAT_CAP ? `${s.slice(0, SEAT_CAP)}\n…[truncated at ${SEAT_CAP} chars]` : s;
}
function formatStatus(r) {
  const out = [`On branch ${r.branch || '(detached)'}${r.upstream ? ` (tracking ${r.upstream})` : ''}`];
  if (r.ahead || r.behind) out.push(`ahead ${r.ahead}, behind ${r.behind}`);
  const staged = r.files.filter((f) => f.staged && !f.untracked);
  const unstaged = r.files.filter((f) => f.unstaged || f.untracked);
  if (!staged.length && !unstaged.length) out.push('working tree clean');
  if (staged.length) { out.push('', 'Staged:'); staged.forEach((f) => out.push(`  ${f.index || '?'}  ${f.orig ? `${f.orig} -> ${f.path}` : f.path}`)); }
  if (unstaged.length) { out.push('', 'Not staged:'); unstaged.forEach((f) => out.push(`  ${f.worktree || '?'}  ${f.path}`)); }
  return out.join('\n');
}
async function seatRead(root, line) {
  const s = String(line || '').trim();
  const sp = s.indexOf(' ');
  const sub = (sp === -1 ? s : s.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : s.slice(sp + 1).trim();
  if (!(await isRepo(root))) return { ok: false, output: 'not a git repository (no .git in the project root)' };
  if (sub === 'status') {
    const r = await status(root);
    return r.ok ? { ok: true, output: formatStatus(r) } : { ok: false, output: r.error };
  }
  if (sub === 'diff') {
    let staged = false; let file = rest;
    if (/^--(staged|cached)\b/.test(file)) { staged = true; file = file.replace(/^--(staged|cached)\s*/, '').trim(); }
    if (!file) return { ok: false, output: 'usage: git diff <path>  (optionally: git diff --staged <path>)' };
    const rel = safeRel(root, file);
    if (!rel) return { ok: false, output: 'path outside the project folder' };
    const r = await run(root, ['--no-pager', 'diff', ...(staged ? ['--staged'] : []), '--', rel]);
    if (!r.ok) return { ok: false, output: r.error };
    const patch = r.stdout.trim();
    return { ok: true, output: patch ? capSeat(patch) : `no ${staged ? 'staged ' : ''}changes in ${rel}` };
  }
  if (sub === 'log') {
    const n = rest ? Math.max(1, Math.min(50, parseInt(rest, 10) || 20)) : 20;
    const r = await log(root, n);
    if (!r.ok) return { ok: false, output: r.error };
    return { ok: true, output: capSeat(r.commits.map((c) => `${c.short}  ${c.subject}  (${c.author}, ${c.relDate})`).join('\n')) };
  }
  return { ok: false, output: `git reads support: status | diff <path> | log [n]  (got "${sub}")` };
}

module.exports = { isRepo, status, diff, log, branches, commitFiles, commitDiff, stage, unstage, discardTracked, fingerprint, resolveInside, commit, push, pull, seatRead };
