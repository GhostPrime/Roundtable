// Project file tree panel (Phase 4). Read-only browsing of the active
// project with badges on files written this session. Pure React recursion —
// no tree library. Listing comes from project:tree (root-validated, limits
// enforced in main); viewing goes through project:readFile (200 KB cap).
import { useEffect, useState } from 'react';

const api = window.api;

function Node({ node, depth, writtenSet, onView, onReveal, onOpen }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === 'dir') {
    return (
      <div>
        <button
          className="tree-row tree-dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tree-arrow">{open ? '\u25be' : '\u25b8'}</span>
          <span className="tree-name">{node.name}</span>
          {node.truncated && (
            <span className="tree-badge" title="Listing truncated (depth/entry limit)">…</span>
          )}
        </button>
        {open &&
          node.children?.map((c) => (
            <Node
              key={c.path}
              node={c}
              depth={depth + 1}
              writtenSet={writtenSet}
              onView={onView}
              onReveal={onReveal}
              onOpen={onOpen}
            />
          ))}
      </div>
    );
  }
  // writtenFiles paths may use either separator, depending on what the seat wrote.
  const written = writtenSet.has(node.path) || writtenSet.has(node.path.replace(/\//g, '\\'));
  return (
    <div className="tree-row file" style={{ paddingLeft: 8 + depth * 14 }}>
      {/* onOpen is optional: without it the name is inert text, exactly as the
          standalone Files panel has always rendered it. */}
      {onOpen ? (
        <button className="tree-name tree-open" title={`Open ${node.path}`} onClick={() => onOpen(node.path)}>
          {node.name}
        </button>
      ) : (
        <span className="tree-name" title={node.path}>{node.name}</span>
      )}
      {written && <span className="tree-badge written" title="Written this session">●</span>}
      <span className="tree-acts">
        <button className="icon" title="View (read-only)" onClick={() => onView(node.path)}>👁</button>
        <button className="icon" title="Reveal in file manager" onClick={() => onReveal(node.path)}>📂</button>
      </span>
    </div>
  );
}

// `embedded` and `onOpen` are OPTIONAL and default to today's behaviour:
//   embedded — render just the tree body (no <aside> chrome / header), for
//              hosting inside another panel's left rail.
//   onOpen   — clicking a file name calls onOpen(relPath) instead of doing
//              nothing. The 👁 / 📂 row actions are unchanged either way.
export default function FileTree({ projectPath, writtenFiles, onClose, embedded = false, onOpen }) {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState(null); // { path, content, truncated }

  const refresh = () => {
    setError('');
    if (!projectPath) { setTree(null); return; }
    api.projectTree(projectPath).then((r) => {
      if (r?.ok) setTree(r);
      else { setTree(null); setError(r?.error || 'could not read the project folder'); }
    });
  };
  // Re-fetch when the active project changes. No file watching (by design) —
  // the Refresh button re-reads on demand.
  useEffect(refresh, [projectPath]);

  const writtenSet = new Set((writtenFiles || []).map((f) => f.path));

  const view = (relPath) => {
    api.readProjectFile(projectPath, relPath).then((r) => {
      if (r?.ok) setViewing({ path: relPath, content: r.content, truncated: r.truncated });
      else setViewing({ path: relPath, content: `\u26a0\ufe0f ${r?.error || 'could not read file'}`, truncated: false });
    });
  };

  const body = (
    <div className="scripts-body tree-body">
      {!projectPath && (
        <p className="scripts-empty">No project selected — pick a project to browse its files.</p>
      )}
      {projectPath && error && <p className="scripts-empty">⚠️ {error}</p>}
      {projectPath && tree && (
        <>
          {tree.truncated && (
            <p className="scripts-empty">Listing truncated (limits: depth 6, 2,000 entries).</p>
          )}
          {tree.children.map((c) => (
            <Node
              key={c.path}
              node={c}
              depth={0}
              writtenSet={writtenSet}
              onView={view}
              onReveal={(p) => api.revealFile(projectPath, p)}
              onOpen={onOpen}
            />
          ))}
        </>
      )}
    </div>
  );

  const viewer = (
    <>
      {viewing && (
        <div className="modal-backdrop" onClick={() => setViewing(null)}>
          <div className="modal file-view" onClick={(e) => e.stopPropagation()}>
            <div className="scripts-head">
              <span className="scripts-title">
                {viewing.path}
                {viewing.truncated ? ' (truncated)' : ''}
              </span>
              <button className="icon icon-x" title="Close" onClick={() => setViewing(null)}>✕</button>
            </div>
            <pre className="script-code file-view-code">{viewing.content}</pre>
          </div>
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="tree-embedded">
        <div className="tree-embedded-head">
          <button className="mini-btn" onClick={refresh}>Refresh</button>
        </div>
        {body}
        {viewer}
      </div>
    );
  }

  return (
    <aside className="scripts-panel tree-panel">
      <div className="scripts-head">
        <span className="scripts-title">🗂 Files</span>
        <button className="mini-btn" onClick={refresh}>Refresh</button>
        <button className="icon icon-x" title="Close" onClick={onClose}>✕</button>
      </div>
      {body}
      {viewer}
    </aside>
  );
}
