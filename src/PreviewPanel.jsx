// Preview panel: render a built web app (project HTML file) inside Roundtable
// via an Electron <webview>. file:// loading means relative assets (app.js,
// styles.css) just work — no server, no inlining. The webview is locked down
// in main.js (will-attach-webview: file:// inside approved roots only, no
// node, no preload), so AI-written HTML runs with the same trust as double-
// clicking the file — less, actually: no window.open, no external navigation.
//
// Reloads: remount-by-key instead of webview.reload() — stateless, and the
// key changes both on the manual ⟳ and whenever `writeStamp` moves (a seat's
// approved write landed), so the preview tracks the file as it's built.
import { useEffect, useMemo, useRef, useState } from 'react';

const api = window.api;

// Flatten the project tree to relative paths of previewable HTML files.
function collectHtml(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === 'dir') collectHtml(n.children, out);
    else if (/\.html?$/i.test(n.name)) out.push(n.path);
  }
  return out;
}

function fileUrl(projectRoot, relPath) {
  const root = projectRoot.replace(/\\/g, '/');
  return encodeURI(`file:///${root}/${relPath}`).replace(/#/g, '%23');
}

export default function PreviewPanel({ projectRoot, writeStamp, onClose }) {
  const [htmlFiles, setHtmlFiles] = useState(null); // null = loading
  const [selected, setSelected] = useState('');
  const [tick, setTick] = useState(0);
  // Guard against the silent-blank failure mode: <webview> only works after
  // the main process launches with webviewTag enabled. On a hot-reloaded
  // renderer atop an old main process the element is inert — detect that
  // (no webview API on the element) and say so instead of showing nothing.
  const frameRef = useRef(null);
  const [inert, setInert] = useState(false);
  useEffect(() => {
    const el = frameRef.current;
    if (el && typeof el.getWebContentsId !== 'function') setInert(true);
  }, [selected, tick, htmlFiles]);

  // (Re)scan for HTML files on open and after every approved write — a seat
  // may have just created the file we're here to look at.
  useEffect(() => {
    let alive = true;
    api.projectTree?.(projectRoot)
      .then((t) => {
        if (!alive) return;
        const files = t?.ok !== false ? collectHtml(t?.tree || t?.children || []) : [];
        setHtmlFiles(files);
        setSelected((s) => {
          if (s && files.includes(s)) return s;
          return files.find((f) => /(^|\/)index\.html$/i.test(f)) || files[0] || '';
        });
      })
      .catch(() => { if (alive) setHtmlFiles([]); });
    return () => { alive = false; };
  }, [projectRoot, writeStamp]);

  // A landed write also refreshes the rendered page itself.
  useEffect(() => { setTick((t) => t + 1); }, [writeStamp]);

  const src = useMemo(
    () => (selected ? fileUrl(projectRoot, selected) : ''),
    [projectRoot, selected],
  );

  return (
    <aside className="scripts-panel preview-panel">
      <div className="scripts-head">
        <span className="scripts-title">▶ Preview</span>
        {htmlFiles?.length > 1 ? (
          <select
            className="preview-pick"
            value={selected}
            title="Which HTML file to preview"
            onChange={(e) => setSelected(e.target.value)}
          >
            {htmlFiles.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        ) : (
          <span className="scripts-count" title="The previewed file">{selected}</span>
        )}
        <button
          className="icon"
          title="Reload the preview"
          aria-label="Reload preview"
          onClick={() => setTick((t) => t + 1)}
        >
          ⟳
        </button>
        <button className="icon icon-x" title="Close panel" aria-label="Close preview panel" onClick={onClose}>
          ✕
        </button>
      </div>

      {inert ? (
        <div className="scripts-body">
          <p className="scripts-empty">
            The preview engine isn't loaded — this happens when the app was
            hot-reloaded after an update. Fully quit Roundtable and start it
            again, then reopen this panel.
          </p>
        </div>
      ) : htmlFiles !== null && htmlFiles.length === 0 ? (
        <div className="scripts-body">
          <p className="scripts-empty">
            No HTML file in this project yet. When a seat writes one (CHECK:
            write_file index.html), it becomes previewable here.
          </p>
        </div>
      ) : (
        src && (
          <webview
            ref={frameRef}
            key={`${selected}:${tick}`}
            className="preview-frame"
            src={src}
          />
        )
      )}
    </aside>
  );
}
