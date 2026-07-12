// "Review changes" panel (Phase 5): session-level list of files written by
// seats, each opening a CUMULATIVE diff — the file as it is on disk right now
// vs its content before this session's first write to it (the baseline
// captured in App.jsx at approval time; null baseline = created this session).
import { useMemo, useState } from 'react';
import { diffLines, collapseDiff, pairRows } from './diffLines.js';

const api = window.api;

export default function ReviewPanel({ writtenFiles, baselines, projectPath, onClose }) {
  const [diff, setDiff] = useState(null); // { path, view|null, isNew, error? }
  const [sideBySide, setSideBySide] = useState(true);

  const open = async (relPath) => {
    if (!projectPath) return;
    const r = await api.readProjectFile(projectPath, relPath).catch(() => null);
    if (!r?.ok) {
      setDiff({ path: relPath, error: r?.error || 'could not read the current file' });
      return;
    }
    const base = baselines?.[relPath] ?? null;
    const rows = diffLines(base ?? '', r.content);
    setDiff({ path: relPath, view: rows ? collapseDiff(rows, 3) : null, isNew: base == null });
  };

  const pairs = useMemo(() => (diff?.view ? pairRows(diff.view) : null), [diff]);

  return (
    <aside className="scripts-panel tree-panel">
      <div className="scripts-head">
        <span className="scripts-title">± Changes</span>
        <span className="scripts-count">{writtenFiles.length}</span>
        <button className="icon icon-x" title="Close" onClick={onClose}>✕</button>
      </div>
      <div className="scripts-body">
        {writtenFiles.length === 0 && (
          <p className="scripts-empty">Nothing written this session yet. Approved writes will show up here with a per-file diff.</p>
        )}
        {writtenFiles.map((f) => (
          <button key={f.path} className="tree-row review-row" onClick={() => open(f.path)}>
            <span className="tree-name" title={f.path}>{f.path}</span>
            <span className="review-meta">
              {f.agent || '?'} \u00b7 {new Date(f.ts).toLocaleTimeString()}
            </span>
          </button>
        ))}
      </div>
      {diff && (
        <div className="modal-backdrop" onClick={() => setDiff(null)}>
          <div className="modal file-view" onClick={(e) => e.stopPropagation()}>
            <div className="scripts-head">
              <span className="scripts-title">
                {diff.path}
                {diff.isNew ? ' (new this session)' : ' (vs session start)'}
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
              {!diff.error && !diff.view && (
                <p className="scripts-empty">Diff too large to render.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
