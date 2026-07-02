// Write-approval modal: before a seat's CHECK: write_file executes, show the
// user what would change (unified-style diff vs. the file on disk) and let
// them Approve / Reject / Approve-all-for-this-chat. The orchestration loop
// awaits the decision — see App.jsx's runGatedCheck.
//
// Note: read_file truncates at 64KB, so for very large files the "old" side
// of the diff can be a truncated view. The write itself is unaffected.
import { useMemo } from 'react';
import { diffLines, collapseDiff } from './diffLines.js';

export default function WriteApproval({ approval, onDecide }) {
  const { path, agentName, color, oldText, content } = approval;
  const isNew = oldText == null;

  const rows = useMemo(() => {
    if (isNew) return String(content ?? '').split('\n').map((line) => ({ t: '+', line }));
    return diffLines(oldText, content);
  }, [isNew, oldText, content]);

  const adds = rows ? rows.filter((r) => r.t === '+').length : 0;
  const dels = rows ? rows.filter((r) => r.t === '-').length : 0;
  const unchanged = rows && adds === 0 && dels === 0;
  const view = rows ? collapseDiff(rows, 3) : null;

  return (
    <div className="modal-backdrop">
      <div className="modal write-approval">
        <h2>✍️ Write request</h2>
        <p className="form-note">
          <strong style={color ? { color } : undefined}>{agentName || 'A seat'}</strong>{' '}
          wants to {isNew ? 'create' : 'overwrite'} <code>{path}</code>
          {rows && !unchanged && (
            <>
              {' '}— <span className="diff-adds">+{adds}</span>{' '}
              <span className="diff-dels">−{dels}</span>
            </>
          )}
        </p>
        {unchanged ? (
          <p className="form-note">Content is identical to the current file — nothing would change.</p>
        ) : (
          <div className="diff-view">
            {view
              ? view.map((r, i) =>
                  r.gap ? (
                    <div key={i} className="dl dl-gap">
                      … {r.n} unchanged line{r.n === 1 ? '' : 's'} …
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={`dl ${r.t === '+' ? 'dl-add' : r.t === '-' ? 'dl-del' : 'dl-ctx'}`}
                    >
                      {(r.t === ' ' ? '  ' : `${r.t} `) + r.line}
                    </div>
                  ),
                )
              : /* diff too large — show the incoming content plain */
                <pre className="diff-fallback">{String(content ?? '').slice(0, 8000)}</pre>}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => onDecide('reject')}>
            Reject
          </button>
          <button
            type="button"
            className="ghost"
            title="Approve this and every later write in this chat without asking"
            onClick={() => onDecide('always')}
          >
            Approve all (this chat)
          </button>
          <button type="submit" onClick={() => onDecide('approve')}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
