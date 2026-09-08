// MemoryGraph.jsx — the memory pool as a force map.
//
// Drawing, panning and selection only. Every position, edge and edit transform
// comes from memoryGraph.js (pure, tested by scripts/check-memory-graph.js).
//
// Reading the map:
//   • the big ringed node is the ORIGIN — the first fact ever saved in this
//     project. Every other fact attaches to an earlier one, so every branch
//     traces back there and the pool reads as one growing structure rather
//     than a scatter of islands.
//   • solid edge  — the chain: this fact grew out of that one
//   • bright edge — the save path thinks these two are the SAME fact
//   • faint edge  — a cross-link: same salient word, different branch
//   • colour      — the strongest shared word for that node
//   • ring        — pinned, never auto-evicted
//
// Labels are drawn for pinned nodes, the selection and its neighbours, and
// anything on hover. Drawing all 50 at once was the previous version's mistake:
// every caption overlapped its neighbours and got clipped, which is how a map
// turns back into an unreadable list.
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  layoutForce, neighboursOf, editMemo, deleteMemo, togglePin, combineMemos, combineDraft,
} from './memoryGraph.js';

const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString() : '');

// Distinguishable at small sizes on the dark panel, and stable per topic index.
const TOPIC_COLORS = [
  '#7aa2f7', '#bb9af7', '#e0af68', '#9ece6a', '#f7768e',
  '#2ac3de', '#ff9e64', '#c0caf5', '#73daca', '#d5a6ff',
];

export default function MemoryGraph({
  memos, links, related, chain, root, onSave, busy,
  // Browsing another project's pool. Kept SEPARATE from `busy` so every
  // control can be disabled honestly: previously read-only mode left Pin
  // clickable (its onSave was a no-op that silently did nothing) and let you
  // stage facts for a Combine that could never fire.
  readOnly = false,
}) {
  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null);
  const [picked, setPicked] = useState([]);
  const [draft, setDraft] = useState(null);
  const [mode, setMode] = useState(null);      // 'edit' | 'combine'
  const [query, setQuery] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef(null);
  const svgRef = useRef(null);

  const g = useMemo(
    () => layoutForce(memos, { links, related, chain, root }),
    [memos, links, related, chain, root],
  );
  const current = memos.find((m) => m.id === selected) || null;
  const nbrs = useMemo(() => neighboursOf(g.edges, selected), [g.edges, selected]);
  const colorOf = (topic) =>
    (topic == null ? '#6b6b78' : TOPIC_COLORS[g.topics.indexOf(topic) % TOPIC_COLORS.length]);

  // One character matches almost everything, so reacting to it just flashed
  // every label on at once — the same overlap soup the column version died of.
  const raw = query.trim().toLowerCase();
  const q = raw.length >= 2 ? raw : '';
  const matches = useCallback(
    (n) => !q || n.text.toLowerCase().includes(q) || (n.by || '').toLowerCase().includes(q),
    [q],
  );

  useEffect(() => {
    if (selected && !memos.some((m) => m.id === selected)) { setSelected(null); setMode(null); }
    setPicked((p) => p.filter((id) => memos.some((m) => m.id === id)));
  }, [memos, selected]);

  // Switching into a read-only pool drops any staging/editing in progress —
  // leaving it visible would offer an action that cannot complete.
  useEffect(() => {
    if (readOnly) { setPicked([]); setMode(null); setDraft(null); }
  }, [readOnly]);

  // Client pixels → the SVG's own user space.
  //
  // The viewBox is a fixed 1000×640 scaled to fit the canvas, so a client-pixel
  // delta is NOT a user-space delta: using raw clientX/clientY made panning lag
  // the cursor by the render ratio and made zoom drift away from the pointer
  // instead of holding the point under it. getScreenCTM().inverse() accounts
  // for the viewBox, preserveAspectRatio letterboxing and any CSS scaling in
  // one step, which hand-rolled rect math does not.
  const toUser = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM?.();
    if (!ctm) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  }, []);

  const onDown = (e) => {
    if (e.target.closest('.mem-node')) return;
    const p = toUser(e.clientX, e.clientY);
    if (!p) return;
    drag.current = { ux: p.x, uy: p.y, ox: view.x, oy: view.y };
  };
  const onMove = (e) => {
    if (!drag.current) return;
    const p = toUser(e.clientX, e.clientY);
    if (!p) return;
    setView((v) => ({
      ...v,
      x: drag.current.ox + (p.x - drag.current.ux),
      y: drag.current.oy + (p.y - drag.current.uy),
    }));
  };
  const onUp = () => { drag.current = null; };

  // Wheel zoom as a NATIVE non-passive listener. React registers wheel
  // passively, so preventDefault() from onWheel is ignored and zooming also
  // scrolls whatever is behind the canvas.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const p = toUser(e.clientX, e.clientY);
      if (!p) return;
      setView((v) => {
        const k = Math.min(3, Math.max(0.35, v.k * (e.deltaY < 0 ? 1.12 : 0.89)));
        // hold the point under the cursor fixed: it is at local (p - x)/k
        return { k, x: p.x - ((p.x - v.x) / v.k) * k, y: p.y - ((p.y - v.y) / v.k) * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [toUser, g.nodes.length]);

  const apply = (next) => { setMode(null); setDraft(null); onSave(next); };
  const togglePick = (id) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const showLabel = (n) =>
    n.id === selected || n.id === hover || nbrs.has(n.id) || n.pinned || (q && matches(n));

  return (
    <div className="mem-graph">
      <div className="mem-graph-canvas">
        <div className="mem-graph-tools">
          <input
            className="mem-search"
            placeholder="Find a fact…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="mini-btn" title="Reset the view"
            onClick={() => setView({ x: 0, y: 0, k: 1 })}>⟲</button>
          <span className="hint">{memos.length} facts · drag to pan · scroll to zoom</span>
        </div>

        {g.nodes.length === 0 ? (
          <p className="hint" style={{ padding: 24 }}>Nothing saved in this pool yet.</p>
        ) : (
          <svg
            ref={svgRef}
            className="mem-svg"
            viewBox={`0 0 ${g.width} ${g.height}`}
            preserveAspectRatio="xMidYMid meet"
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={() => { onUp(); setHover(null); }}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {g.edges.map((e, i) => {
                const lit = selected && (e.a === selected || e.b === selected);
                return (
                  <line
                    key={i}
                    className={`mem-edge ${e.kind} ${lit ? 'lit' : ''}`}
                    x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y}
                  />
                );
              })}
              {g.nodes.map((n) => {
                const dim = (q && !matches(n)) || (selected && n.id !== selected && !nbrs.has(n.id));
                const col = colorOf(n.topic);
                return (
                  <g
                    key={n.id}
                    className={`mem-node ${n.id === selected ? 'sel' : ''} ${picked.includes(n.id) ? 'picked' : ''} ${dim ? 'dim' : ''}`}
                    transform={`translate(${n.x},${n.y})`}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => { setSelected(n.id); setMode(null); }}
                  >
                    <title>{n.isRoot ? `origin — ${n.text}` : n.text}</title>
                    {n.isRoot && <circle className="mem-root-ring" r={n.r + 7} />}
                    {n.pinned && <circle className="mem-ring" r={n.r + 4} />}
                    <circle r={n.r} style={{ fill: col }} />
                    {(showLabel(n) || n.isRoot) && (
                      <text className="mem-label" y={n.r + 13} textAnchor="middle">
                        {n.text.length > 34 ? `${n.text.slice(0, 33)}…` : n.text}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>

      <div className="mem-graph-side">
        {g.topics.length > 0 && (
          <div className="mem-legend">
            {g.topics.slice(0, 8).map((t) => (
              <span key={t}>
                <span className="lg-dot" style={{ background: colorOf(t) }} /> {t}
              </span>
            ))}
            <span className="hint" style={{ width: '100%', marginTop: 2 }}>
              ◎ origin = the first fact saved here · solid line = grew out of ·
              faint line = shares a word
            </span>
          </div>
        )}

        {picked.length > 0 && (
          <div className="mem-picked">
            <span>{picked.length} staged</span>
            <button type="button" className="mini-btn" disabled={picked.length < 2 || busy || readOnly}
              onClick={() => { setMode('combine'); setDraft(combineDraft(memos, picked)); }}>
              Combine
            </button>
            <button type="button" className="mini-btn" onClick={() => setPicked([])}>Clear</button>
          </div>
        )}

        {!current && (
          <p className="hint">
            The ringed node is the origin — the first fact saved in this
            project. Every other fact hangs off an earlier one, so you can
            trace any branch back to it. Click a node to read it in full and
            light up what it connects to.
          </p>
        )}

        {current && (
          <div className="mem-detail">
            {mode ? (
              <>
                <p className="hint">
                  {mode === 'combine'
                    ? `Merging ${picked.length} facts — edit into one sentence. Nothing is summarised for you: a silent merge is how a fact goes missing.`
                    : 'Edit this fact. Every seat reads it as true at the start of each turn.'}
                </p>
                <textarea className="mem-editor" rows={4} maxLength={300} autoFocus
                  value={draft ?? ''} onChange={(e) => setDraft(e.target.value)} />
                <div className="mem-detail-actions">
                  <span className="hint">{(draft ?? '').length}/300</span>
                  <button type="button" className="mini-btn"
                    onClick={() => { setMode(null); setDraft(null); }}>Cancel</button>
                  <button type="button" className="mini-btn primary"
                    disabled={!(draft ?? '').trim() || busy}
                    onClick={() => mode === 'combine'
                      ? (apply(combineMemos(memos, picked, draft)), setPicked([]))
                      : apply(editMemo(memos, current.id, draft))}>
                    Save
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mem-detail-text">{current.text}</p>
                <p className="hint">
                  {current.by ? `saved by ${current.by} · ` : ''}{fmtDay(current.ts)}
                  {current.id === g.root ? ' · origin of this pool' : ''}
                  {nbrs.size ? ` · connects to ${nbrs.size}` : ''}
                </p>
                <div className="mem-detail-actions">
                  <button type="button"
                    className={`mini-btn ${picked.includes(current.id) ? 'active' : ''}`}
                    disabled={busy || readOnly}
                    title={readOnly
                      ? 'Read-only — switch the app to this project to edit its facts'
                      : 'Stage this fact to merge with another'}
                    onClick={() => togglePick(current.id)}>
                    {picked.includes(current.id) ? '✓ staged' : 'Stage to combine'}
                  </button>
                  <button type="button" className={`mini-btn ${current.pinned ? 'active' : ''}`}
                    disabled={busy || readOnly}
                    title={readOnly
                      ? 'Read-only — switch the app to this project to edit its facts'
                      : current.pinned
                        ? 'Pinned — never auto-evicted. Click to unpin.'
                        : 'Pin — never auto-evicted when the pool overflows'}
                    onClick={() => onSave(togglePin(memos, current.id))}>📌</button>
                  <button type="button" className="mini-btn" disabled={busy || readOnly}
                    onClick={() => { setMode('edit'); setDraft(current.text); }}>Edit</button>
                  <button type="button" className="mini-btn danger" disabled={busy || readOnly}
                    title="Forget this fact"
                    onClick={() => onSave(deleteMemo(memos, current.id))}>Delete</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
