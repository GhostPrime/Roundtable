// "Review changes" panel (Phase 5): session-level list of files written by
// seats, each opening a CUMULATIVE diff — the file as it is on disk right now
// vs its content before this session's first write to it (the baseline
// captured in App.jsx at approval time; null baseline = created this session).
import { useState } from 'react';
import { diffLines, collapseDiff } from './diffLines.js';
import DiffModal from './DiffModal.jsx';

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
        <DiffModal
          path={diff.path}
          isNew={diff.isNew}
          view={diff.view}
          error={diff.error}
          sideBySide={sideBySide}
          onMode={setSideBySide}
          onClose={() => setDiff(null)}
        />
      )}
    </aside>
  );
}
