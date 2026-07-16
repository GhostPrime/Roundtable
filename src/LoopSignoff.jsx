// Loop sign-off modal: the human stop-condition for Loop mode. Shown when the
// verifier passes an iteration (accept it?) or the iteration budget runs out
// (keep going?). runLoop awaits the decision — same promise-pause pattern as
// WriteApproval / runGatedCheck.
import { useState } from 'react';

export default function LoopSignoff({ signoff, onDecide }) {
  const { kind, iteration, verdict } = signoff;
  const [notes, setNotes] = useState('');
  const pass = kind === 'pass';

  return (
    <div className="modal-backdrop">
      <div className="modal loop-signoff">
        <h2>{pass ? '🔁 Verifier passed it — your call' : '🔁 Iteration budget reached'}</h2>
        <p className="form-note">
          {pass ? (
            <>
              After <strong>{iteration}</strong> iteration{iteration === 1 ? '' : 's'} the verifier says:{' '}
              <em>{verdict?.reason || 'pass'}</em>
            </>
          ) : (
            <>
              <strong>{iteration}</strong> iteration{iteration === 1 ? '' : 's'} used without an accepted pass
              {verdict ? (
                <>
                  {' '}— last verdict: <em>{verdict.verdict} — {verdict.reason || '(no reason given)'}</em>
                </>
              ) : null}
              . Accept the current state, send it back with notes, or stop.
            </>
          )}
        </p>
        <textarea
          className="loop-notes"
          rows={3}
          placeholder="Optional notes for the next pass (used by “Send back”) — what's wrong, what to change…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => onDecide({ action: 'stop' })}>
            Stop loop
          </button>
          <button
            type="button"
            className="ghost"
            title="Reject the current result and run more iterations — your notes go to the seats"
            onClick={() => onDecide({ action: 'revise', notes: notes.trim() })}
          >
            Send back
          </button>
          <button type="submit" onClick={() => onDecide({ action: 'accept' })}>
            Accept result
          </button>
        </div>
      </div>
    </div>
  );
}
