// "Git" panel — a SourceTree-lite view of the active project's local working
// copy: changed files (staged / unstaged), per-file diff, recent commits and
// branches, plus stage / unstage / discard / commit. Reads run freely; the one
// destructive action (discard) is confirmed before it fires. Writes are
// user-initiated here (not seat-initiated), and each is logged in main.
//
// Reuses the exact diff machinery ReviewPanel uses (diffLines/collapseDiff/
// pairRows) and the shared .scripts-panel / .diff-view CSS, so this stays
// visually consistent and adds almost no new surface.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { diffLines, collapseDiff, pairRows } from './diffLines.js';

const api = window.api;

// Human label for a git status letter.
const LETTER = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type', '?': 'untracked' };

export default function GitPanel({ projectPath, onClose }) {
  const [tab, setTab] = useState('changes'); // 'changes' | 'history' | 'branches'
  const [status, setStatus] = useState(null); // { branch, ahead, behind, files } | { error }
  const [commits, setCommits] = useState(null);
  const [branches, setBranches] = useState(null);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState(null); // { path, view|null, staged|commitShort, error?, binary?, tooLarge? }
  const [sideBySide, setSideBySide] = useState(true);
  const [expanded, setExpanded] = useState(null); // sha expanded in History
  const [commitFiles, setCommitFiles] = useState({}); // sha -> files[] | 'loading' | 'error'
  const [msg, setMsg] = useState(''); // commit message
  const [msgErr, setMsgErr] = useState(false); // empty-message validation flag
  const [busy, setBusy] = useState(false); // a write op is in flight
  const [writeErr, setWriteErr] = useState(null); // last write/network error text
  const [netMsg, setNetMsg] = useState(null); // last push/pull success line
  const [confirmDiscard, setConfirmDiscard] = useState(null); // file pending discard confirmation
  const [lock, setLock] = useState(null); // { present, stale, ageMs } | null — .git/index.lock status
  const [clearingLock, setClearingLock] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectPath) { setStatus({ error: 'no project selected' }); return; }
    setLoading(true);
    const s = await api.gitStatus(projectPath).catch((e) => ({ ok: false, error: e.message }));
    setStatus(s?.ok ? s : { error: s?.error || 'could not read git status' });
    setLoading(false);
  }, [projectPath]);

  // Proactive stale-lock check (roadmap #3 — don't wait for a write to fail).
  // Cheap fs.stat on the main side, no git spawn involved.
  const checkLock = useCallback(async () => {
    if (!projectPath) { setLock(null); return; }
    const l = await api.gitLockStatus(projectPath).catch(() => null);
    setLock(l?.ok ? { present: l.present, stale: l.stale, ageMs: l.ageMs } : null);
  }, [projectPath]);

  const refreshAll = useCallback(() => { refresh(); checkLock(); }, [refresh, checkLock]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  useEffect(() => {
    if (tab === 'history' && commits == null && projectPath) {
      api.gitLog(projectPath, 50).then((r) => setCommits(r?.ok ? r.commits : [])).catch(() => setCommits([]));
    }
    if (tab === 'branches' && branches == null && projectPath) {
      api.gitBranches(projectPath).then((r) => setBranches(r?.ok ? r.branches : [])).catch(() => setBranches([]));
    }
  }, [tab, commits, branches, projectPath]);

  const openDiff = async (file, staged) => {
    const r = await api.gitDiff(projectPath, file.path, staged).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) { setDiff({ path: file.path, staged, error: r?.error || 'could not diff this file' }); return; }
    if (r.binary) { setDiff({ path: file.path, staged, binary: true }); return; }
    if (r.tooLarge) { setDiff({ path: file.path, staged, tooLarge: true }); return; }
    const rows = diffLines(r.oldText ?? '', r.newText ?? '');
    setDiff({ path: file.path, staged, view: rows ? collapseDiff(rows, 3) : null });
  };

  // Expand a commit in History → lazy-load the files it touched (roadmap #5).
  const toggleCommit = async (sha) => {
    if (expanded === sha) { setExpanded(null); return; }
    setExpanded(sha);
    if (!commitFiles[sha]) {
      setCommitFiles((m) => ({ ...m, [sha]: 'loading' }));
      const r = await api.gitCommitFiles(projectPath, sha).catch(() => null);
      setCommitFiles((m) => ({ ...m, [sha]: r?.ok ? r.files : 'error' }));
    }
  };

  // Diff one file as of a commit (parent blob vs commit blob) into the modal.
  const openCommitDiff = async (sha, short, file) => {
    const r = await api.gitCommitDiff(projectPath, sha, file.path).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) { setDiff({ path: file.path, commitShort: short, error: r?.error || 'could not diff this file' }); return; }
    if (r.binary) { setDiff({ path: file.path, commitShort: short, binary: true }); return; }
    const rows = diffLines(r.oldText ?? '', r.newText ?? '');
    setDiff({ path: file.path, commitShort: short, view: rows ? collapseDiff(rows, 3) : null });
  };

  // --- write ops (roadmap #2/#3). Each refreshes status after; commit also
  // invalidates the History cache so the new commit shows up. Errors surface
  // inline rather than throwing.
  const runWrite = async (fn) => {
    setBusy(true); setWriteErr(null);
    const r = await fn().catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    if (!r?.ok) {
      setWriteErr(r?.error || 'git operation failed');
      if (r?.lockError) await checkLock();
      return false;
    }
    await refresh();
    return true;
  };

  // "Clear stale lock" — only reachable when `lock.stale` is true, and git.js
  // re-verifies staleness itself right before deleting, so this can't blind-
  // delete a lock belonging to a real concurrent git process.
  const handleClearLock = async () => {
    setClearingLock(true);
    const r = await api.gitClearLock(projectPath).catch((e) => ({ ok: false, error: e.message }));
    setClearingLock(false);
    if (!r?.ok) { setWriteErr(r?.error || 'could not clear the lock file'); await checkLock(); return; }
    setWriteErr(null);
    await checkLock();
    await refresh();
  };
  const stageFile = (f) => runWrite(() => api.gitStage(projectPath, f.path));
  const unstageFile = (f) => runWrite(() => api.gitUnstage(projectPath, f.path));
  const stageAll = () => runWrite(() => api.gitStage(projectPath, null));
  const unstageAll = () => runWrite(() => api.gitUnstage(projectPath, null));
  const doDiscard = async () => {
    const f = confirmDiscard; setConfirmDiscard(null);
    if (!f) return;
    setBusy(true); setWriteErr(null); setNetMsg(null);
    // Pass the fingerprint from when this row was painted — the backend refuses
    // if the file changed on disk since (the freshness floor).
    const r = await api.gitDiscard(projectPath, f.path, f.untracked, f.fp).catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    if (r?.stale) { setWriteErr(r.error); await refresh(); return; } // re-paint so they see live state
    if (!r?.ok) { setWriteErr(r?.error || 'discard failed'); if (r?.lockError) await checkLock(); return; }
    setNetMsg(
      r.recoverable === 'trash' ? `Moved ${f.path} to trash — recoverable from your OS trash`
        : r.recoverable === 'stash' ? `Discarded ${f.path} — recoverable via git stash`
          : `${f.path} was already clean`,
    );
    await refresh();
  };
  const doCommit = async () => {
    if (!msg.trim()) { setMsgErr(true); return; } // validate instead of disabling
    setMsgErr(false);
    const ok = await runWrite(() => api.gitCommit(projectPath, msg));
    if (ok) { setMsg(''); setCommits(null); setExpanded(null); } // refetch History
  };

  // Network ops (roadmap #4). Show the last line of git's output on success,
  // the full error on failure; refresh + invalidate History either way.
  const runNet = async (fn) => {
    setBusy(true); setWriteErr(null); setNetMsg(null);
    const r = await fn().catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    if (!r?.ok) { setWriteErr(r?.error || 'network operation failed'); if (r?.lockError) await checkLock(); }
    else { setNetMsg((r.output || 'done').split('\n').filter(Boolean).slice(-1)[0] || 'done'); setCommits(null); setExpanded(null); }
    await refresh();
  };
  const doPush = () => runNet(() => api.gitPush(projectPath));
  const doPull = () => runNet(() => api.gitPull(projectPath));

  const pairs = useMemo(() => (diff?.view ? pairRows(diff.view) : null), [diff]);

  const staged = (status?.files || []).filter((f) => f.staged && !f.untracked);
  const unstaged = (status?.files || []).filter((f) => f.unstaged || f.untracked);

  const fileRow = (f, isStaged) => {
    const letter = (isStaged ? f.index : f.worktree) || '?';
    return (
      <div key={`${isStaged ? 's' : 'w'}:${f.path}`} className="git-file-row">
        <button className="git-file-open" onClick={() => openDiff(f, isStaged)} title={LETTER[letter] || ''}>
          <span className={`git-badge git-${letter}`}>{letter}</span>
          <span className="tree-name" title={f.path}>{f.orig ? `${f.orig} → ${f.path}` : f.path}</span>
        </button>
        <span className="git-file-actions">
          {isStaged ? (
            <button className="mini-btn" disabled={busy} onClick={() => unstageFile(f)}>Unstage</button>
          ) : (
            <>
              <button className="mini-btn" disabled={busy} onClick={() => stageFile(f)}>Stage</button>
              <button className="mini-btn danger" disabled={busy} title="Discard changes (irreversible)" onClick={() => setConfirmDiscard(f)}>Discard</button>
            </>
          )}
        </span>
      </div>
    );
  };

  return (
    <aside className="scripts-panel tree-panel">
      <div className="scripts-head">
        <span className="scripts-title">⎇ Git</span>
        {status?.branch && (
          <span className="git-branch" title={status.upstream || ''}>
            {status.branch}
            {status.ahead ? ` ↑${status.ahead}` : ''}
            {status.behind ? ` ↓${status.behind}` : ''}
          </span>
        )}
        {status && !status.error && (
          <>
            <button className="mini-btn" title="Push to origin" disabled={busy} onClick={doPush}>
              ↑ Push{status.ahead ? ` ${status.ahead}` : ''}
            </button>
            <button
              className="mini-btn"
              title={status.upstream ? 'Pull (fast-forward only)' : 'No upstream yet — push first'}
              disabled={busy || !status.upstream}
              onClick={doPull}
            >
              ↓ Pull{status.behind ? ` ${status.behind}` : ''}
            </button>
          </>
        )}
        <button className="mini-btn" title="Refresh" onClick={refreshAll} disabled={loading || busy}>⟳</button>
        <button className="icon icon-x" title="Close" onClick={onClose}>✕</button>
      </div>

      <div className="git-tabs">
        <button className={`mini-btn ${tab === 'changes' ? 'active' : ''}`} onClick={() => setTab('changes')}>Changes</button>
        <button className={`mini-btn ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>History</button>
        <button className={`mini-btn ${tab === 'branches' ? 'active' : ''}`} onClick={() => setTab('branches')}>Branches</button>
      </div>

      {(writeErr || netMsg || lock?.stale) && (
        <div className={`git-net ${writeErr || lock?.stale ? 'err' : 'ok'} ${lock?.stale ? 'lock' : ''}`}>
          <span className="git-net-msg" title={writeErr || netMsg || ''}>
            {busy ? 'Working…'
              : lock?.stale ? '⚠️ A previous git operation left a stale lock file (.git/index.lock).'
              : writeErr ? `⚠️ ${writeErr}${lock?.present && !lock.stale ? ' — a git operation appears to be in progress, try again in a moment' : ''}`
              : `✓ ${netMsg}`}
          </span>
          {lock?.stale && !busy && (
            <button className="mini-btn danger" disabled={clearingLock} onClick={handleClearLock}>
              {clearingLock ? 'Clearing…' : 'Clear stale lock'}
            </button>
          )}
        </div>
      )}

      <div className="scripts-body">
        {status?.error && <p className="scripts-empty">⚠️ {status.error}</p>}

        {tab === 'changes' && !status?.error && (
          <>
            {staged.length === 0 && unstaged.length === 0 && (
              <p className="scripts-empty">Working tree clean — nothing to show.</p>
            )}
            {staged.length > 0 && (
              <>
                <div className="git-section">
                  <span>Staged ({staged.length})</span>
                  <button className="git-mini-link" disabled={busy} onClick={unstageAll}>unstage all</button>
                </div>
                {staged.map((f) => fileRow(f, true))}
                <div className="git-commit-box">
                  <textarea
                    className={`git-commit-msg ${msgErr ? 'err' : ''}`}
                    placeholder={`Commit message for ${staged.length} staged file${staged.length === 1 ? '' : 's'}…`}
                    value={msg}
                    onChange={(e) => { setMsg(e.target.value); if (msgErr) setMsgErr(false); }}
                    rows={2}
                  />
                  {msgErr && <span className="git-commit-hint">⚠️ Enter a commit message first.</span>}
                  <button className="git-commit-btn" disabled={busy} onClick={doCommit}>
                    Commit {staged.length} file{staged.length === 1 ? '' : 's'}
                  </button>
                </div>
              </>
            )}
            {unstaged.length > 0 && (
              <>
                <div className="git-section">
                  <span>Changes ({unstaged.length})</span>
                  <button className="git-mini-link" disabled={busy} onClick={stageAll}>stage all</button>
                </div>
                {unstaged.map((f) => fileRow(f, false))}
              </>
            )}
          </>
        )}

        {tab === 'history' && (
          commits == null ? <p className="scripts-empty">Loading…</p>
          : commits.length === 0 ? <p className="scripts-empty">No commits.</p>
          : commits.map((c) => {
            const files = commitFiles[c.hash];
            return (
              <div key={c.hash} className="git-commit-group">
                <button
                  className={`git-commit ${expanded === c.hash ? 'open' : ''}`}
                  title={`${c.hash}\n${c.author} <${c.email}>\n${c.isoDate}`}
                  onClick={() => toggleCommit(c.hash)}
                >
                  <span className="git-caret">{expanded === c.hash ? '▾' : '▸'}</span>
                  <span className="git-sha">{c.short}</span>
                  <span className="git-subject">{c.subject}</span>
                  <span className="review-meta">{c.author} · {c.relDate}</span>
                </button>
                {expanded === c.hash && (
                  <div className="git-commit-files">
                    {files === 'loading' && <p className="scripts-empty">Loading…</p>}
                    {files === 'error' && <p className="scripts-empty">⚠️ could not load this commit's files</p>}
                    {Array.isArray(files) && files.length === 0 && <p className="scripts-empty">No file changes.</p>}
                    {Array.isArray(files) && files.map((f) => (
                      <button key={f.path} className="tree-row review-row" onClick={() => openCommitDiff(c.hash, c.short, f)}>
                        <span className={`git-badge git-${f.status || '?'}`}>{f.status || '?'}</span>
                        <span className="tree-name" title={f.path}>{f.orig ? `${f.orig} → ${f.path}` : f.path}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}

        {tab === 'branches' && (
          branches == null ? <p className="scripts-empty">Loading…</p>
          : branches.length === 0 ? <p className="scripts-empty">No branches.</p>
          : branches.map((b) => (
            <div key={b.name} className={`git-branch-row ${b.current ? 'current' : ''}`}>
              <span className="git-badge">{b.current ? '●' : ''}</span>
              <span className="tree-name" title={b.upstream || ''}>{b.name}</span>
              <span className="review-meta">{b.sha}{b.upstream ? ` → ${b.upstream}` : ''}</span>
            </div>
          ))
        )}
      </div>

      {diff && (
        <div className="modal-backdrop" onClick={() => setDiff(null)}>
          <div className="modal file-view" onClick={(e) => e.stopPropagation()}>
            <div className="scripts-head">
              <span className="scripts-title">
                {diff.path}{diff.commitShort ? ` @ ${diff.commitShort}` : diff.staged ? ' (staged)' : ' (working tree)'}
              </span>
              {diff.view && (
                <span className="diff-modes">
                  <button className={`mini-btn ${!sideBySide ? 'active' : ''}`} onClick={() => setSideBySide(false)}>Unified</button>
                  <button className={`mini-btn ${sideBySide ? 'active' : ''}`} onClick={() => setSideBySide(true)}>Side by side</button>
                </span>
              )}
              <button className="icon icon-x" title="Close" onClick={() => setDiff(null)}>✕</button>
            </div>
            <div className="diff-view review-diff">
              {diff.error && <p className="scripts-empty">⚠️ {diff.error}</p>}
              {diff.binary && <p className="scripts-empty">Binary file — no text diff.</p>}
              {diff.tooLarge && <p className="scripts-empty">File too large to diff.</p>}
              {diff.view && !sideBySide &&
                diff.view.map((r, i) =>
                  r.gap ? (
                    <div key={i} className="dl dl-gap">… {r.n} unchanged line{r.n === 1 ? '' : 's'} …</div>
                  ) : (
                    <div key={i} className={`dl ${r.t === '+' ? 'dl-add' : r.t === '-' ? 'dl-del' : 'dl-ctx'}`}>
                      {(r.t === ' ' ? '  ' : `${r.t} `) + r.line}
                    </div>
                  ),
                )}
              {diff.view && sideBySide && pairs &&
                pairs.map((r, i) =>
                  r.gap ? (
                    <div key={i} className="dl dl-gap">… {r.n} unchanged line{r.n === 1 ? '' : 's'} …</div>
                  ) : (
                    <div key={i} className="sbs-row">
                      <div className={`dl ${r.left ? (r.left.t === '-' ? 'dl-del' : 'dl-ctx') : 'sbs-empty'}`}>
                        {r.left ? (r.left.t === ' ' ? '  ' : '- ') + r.left.line : ''}
                      </div>
                      <div className={`dl ${r.right ? (r.right.t === '+' ? 'dl-add' : 'dl-ctx') : 'sbs-empty'}`}>
                        {r.right ? (r.right.t === ' ' ? '  ' : '+ ') + r.right.line : ''}
                      </div>
                    </div>
                  ),
                )}
              {!diff.error && !diff.binary && !diff.tooLarge && !diff.view && (
                <p className="scripts-empty">No differences to show.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <div className="modal-backdrop" onClick={() => setConfirmDiscard(null)}>
          <div className="modal write-approval" onClick={(e) => e.stopPropagation()}>
            <h2>⚠ Discard changes</h2>
            <p className="form-note">
              {confirmDiscard.untracked ? (
                <>Move untracked file <code>{confirmDiscard.path}</code> to the trash? It leaves your project but is recoverable from your OS trash.</>
              ) : (
                <>Discard your changes to <code>{confirmDiscard.path}</code>? The change is stashed first, so it stays recoverable via <code>git stash</code>.</>
              )}
            </p>
            <p className="form-note git-fresh-note">The file is re-checked against disk first — if it changed since the panel last refreshed, the discard is refused.</p>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setConfirmDiscard(null)}>Cancel</button>
              <button type="button" className="danger" onClick={doDiscard}>Discard</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
