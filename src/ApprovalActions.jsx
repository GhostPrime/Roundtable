// ApprovalActions.jsx — the decision row shared by WriteApproval (file writes)
// and ActionApproval (MCP integration calls).
//
// Extracted because the two had byte-identical rows with the same problem:
// "Reject" and "Approve all (this chat)" both rendered as `ghost`, sitting
// adjacent, with only "Approve" styled as primary. The safest option and the
// highest-consequence one were visually indistinguishable — and "Approve all"
// is not merely "approve, again": it switches OFF the approval prompt for the
// rest of the chat, which is the last thing standing between prompt-injected
// model output and a real write. A misclick there is not recoverable by
// noticing the next modal, because there is no next modal.
//
// So the row now separates by consequence rather than lining three buttons up:
//   Reject   — left, its own outline, hover reads as the safe exit
//   Approve  — right, primary, the ordinary answer
//   Approve all — demoted to its own line below, muted, and armed by a first
//                 click before it does anything (the same arm/confirm idiom
//                 App.jsx uses for session delete; window.confirm is banned in
//                 this app — it breaks keyboard input on Electron/Windows).
//
// `allowApproveAll` exists because EditorPanel reuses WriteApproval for a
// human's own save, where 'always' is treated as a plain approve and nothing
// is remembered. Offering a scary blanket option that silently does nothing
// special would be worse than not offering it.
import { useEffect, useState } from 'react';

export default function ApprovalActions({ onDecide, allowApproveAll = true, allLabel }) {
  const [armed, setArmed] = useState(false);

  // Disarm on its own so a stray first click never sits waiting to be
  // completed by an unrelated second one.
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <>
      <div className="modal-actions">
        <button type="button" className="reject" onClick={() => onDecide('reject')}>
          Reject
        </button>
        <button type="submit" className="approve" onClick={() => onDecide('approve')}>
          Approve
        </button>
      </div>
      {allowApproveAll && (
        <div className="approve-all-row">
          <button
            type="button"
            className={`approve-all ${armed ? 'armed' : ''}`}
            title={
              armed
                ? 'Click again to stop asking for the rest of this chat'
                : 'Stops asking for approval for the rest of this chat — click twice'
            }
            onClick={() => (armed ? onDecide('always') : setArmed(true))}
          >
            {armed
              ? `Sure? ${allLabel || 'Every later write in this chat runs without asking'}`
              : 'Approve all (this chat)…'}
          </button>
        </div>
      )}
    </>
  );
}
