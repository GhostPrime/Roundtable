// Memory panel: view and prune the project's cross-session fact pool
// (saved via MEMO: lines, injected into every seat's prompt as the `memory`
// stage). Deletes are instant — low stakes, facts are one sentence — and
// "Distill" hands the pool to one model to merge/prune (App owns the call).
// Modeled on McpSettings: modal-backdrop/modal, mouse-down close on backdrop.
import { useState } from 'react';

const NUDGE_THRESHOLD = 40; // approaching MAX_MEMOS (50) in electron/memory.js

export default function MemoryPanel({
  memos,
  poolLabel, // "project <name>" | "global (no project)"
  seatedAgents = [], // seated (not benched) seats — who's eligible to distill
  distillAgentId, // which seat would run the distill, or null when none
  distilling,
  busy, // a round is running — keep distill hands-off
  onDelete,
  onTogglePin,
  onChangeDistillAgent,
  onDistill,
  onClose,
}) {
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString() : '');
  const distillAgent = seatedAgents.find((a) => a.id === distillAgentId) || null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal mcp-form" onMouseDown={(e) => e.stopPropagation()}>
        <h2>🧷 Shared memory</h2>
        <p className="hint">
          Facts saved with MEMO: lines — pool: {poolLabel}. Every seat sees
          these at the start of each turn and treats them as true.
        </p>

        {!nudgeDismissed && memos.length >= NUDGE_THRESHOLD && (
          <p className="form-warn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>
              <strong>{memos.length}</strong> facts saved — getting close to the
              cap. A Distill pass can merge overlaps and drop stale ones.
            </span>
            <button type="button" className="mini-btn" onClick={() => setNudgeDismissed(true)}>
              Dismiss
            </button>
          </p>
        )}

        {memos.length === 0 && (
          <p className="hint">
            Nothing saved yet. Seats save facts by ending a message with
            “MEMO: &lt;one short sentence&gt;” — you can type one too.
          </p>
        )}

        {memos.map((m) => (
          <div className="folder-row" key={m.id} style={{ alignItems: 'baseline' }}>
            <span style={{ flex: 1 }}>
              {m.text}
              <span className="hint" style={{ marginLeft: 8 }}>
                {m.by ? `${m.by} · ` : ''}
                {fmtDay(m.ts)}
              </span>
            </span>
            <button
              type="button"
              className={`mini-btn ${m.pinned ? 'active' : ''}`}
              title={m.pinned ? 'Pinned — never auto-evicted. Click to unpin.' : 'Pin — never auto-evicted when the pool overflows'}
              onClick={() => onTogglePin(m.id)}
            >
              📌
            </button>
            <button
              type="button"
              className="mini-btn"
              title="Forget this fact"
              onClick={() => onDelete(m.id)}
            >
              ✕
            </button>
          </div>
        ))}

        {seatedAgents.length > 0 && (
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            Distill via
            <select
              value={distillAgentId || ''}
              onChange={(e) => onChangeDistillAgent(e.target.value || null)}
              disabled={distilling || busy}
            >
              {seatedAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        )}

        <div className="modal-actions">
          <button
            type="button"
            disabled={distilling || busy || memos.length < 2 || !distillAgent}
            title={
              !distillAgent
                ? 'Needs at least one configured seat'
                : busy
                  ? 'Wait for the current round to finish'
                  : `Ask ${distillAgent.name} to merge duplicates and drop stale facts`
            }
            onClick={onDistill}
          >
            {distilling ? 'Distilling…' : `Distill${distillAgent ? ` (via ${distillAgent.name})` : ''}`}
          </button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
