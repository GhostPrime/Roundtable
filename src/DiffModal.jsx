// Session-baseline diff modal, lifted verbatim out of ReviewPanel so the
// editor can show the same "vs session start" view without a second copy of
// the diff rendering. Rendering and class names are unchanged; the unified /
// side-by-side toggle stays OWNED BY THE CALLER (ReviewPanel keeps the choice
// across files, which it did before this extraction).
//
// Props:
//   path       relative path, shown in the header
//   isNew      true when the file was created this session (no baseline)
//   view       collapseDiff() rows, or null when the diff was too large
//   error      message to show instead of a diff
//   sideBySide / onMode(bool)   controlled view mode
//   onClose
import { useMemo } from 'react';
import { pairRows } from './diffLines.js';

export default function DiffModal({ path, isNew, view, error, sideBySide, onMode, onClose }) {
  const pairs = useMemo(() => (view ? pairRows(view) : null), [view]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal file-view" onClick={(e) => e.stopPropagation()}>
        <div className="scripts-head">
          <span className="scripts-title">
            {path}
            {isNew ? ' (new this session)' : ' (vs session start)'}
          </span>
          {view && (
            <span className="diff-modes">
              <button className={`mini-btn ${!sideBySide ? 'active' : ''}`} onClick={() => onMode(false)}>Unified</button>
              <button className={`mini-btn ${sideBySide ? 'active' : ''}`} onClick={() => onMode(true)}>Side by side</button>
            </span>
          )}
          <button className="icon icon-x" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="diff-view review-diff">
          {error && <p className="scripts-empty">⚠️ {error}</p>}
          {view && !sideBySide &&
            view.map((r, i) =>
              r.gap ? (
                <div key={i} className="dl dl-gap">… {r.n} unchanged line{r.n === 1 ? '' : 's'} …</div>
              ) : (
                <div key={i} className={`dl ${r.t === '+' ? 'dl-add' : r.t === '-' ? 'dl-del' : 'dl-ctx'}`}>
                  {(r.t === ' ' ? '  ' : `${r.t} `) + r.line}
                </div>
              ),
            )}
          {view && sideBySide && pairs &&
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
          {!error && !view && (
            <p className="scripts-empty">Diff too large to render.</p>
          )}
        </div>
      </div>
    </div>
  );
}
