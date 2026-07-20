// Memory panel: view and prune the project's cross-session fact pool
// (saved via MEMO: lines, injected into every seat's prompt as the `memory`
// stage). Deletes are instant — low stakes, facts are one sentence — and
// "Distill" hands the pool to one model to merge/prune (App owns the call).
// Modeled on McpSettings: modal-backdrop/modal, mouse-down close on backdrop.
export default function MemoryPanel({
  memos,
  poolLabel, // "project <name>" | "global (no project)"
  distillAgentName, // which seat would run the distill, or null when none
  distilling,
  busy, // a round is running — keep distill hands-off
  onDelete,
  onDistill,
  onClose,
}) {
  const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString() : '');
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal mcp-form" onMouseDown={(e) => e.stopPropagation()}>
        <h2>🧷 Shared memory</h2>
        <p className="hint">
          Facts saved with MEMO: lines — pool: {poolLabel}. Every seat sees
          these at the start of each turn and treats them as true.
        </p>

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
              className="mini-btn"
              title="Forget this fact"
              onClick={() => onDelete(m.id)}
            >
              ✕
            </button>
          </div>
        ))}

        <div className="modal-actions">
          <button
            type="button"
            disabled={distilling || busy || memos.length < 2 || !distillAgentName}
            title={
              !distillAgentName
                ? 'Needs at least one configured seat'
                : busy
                  ? 'Wait for the current round to finish'
                  : `Ask ${distillAgentName} to merge duplicates and drop stale facts`
            }
            onClick={onDistill}
          >
            {distilling ? 'Distilling…' : `Distill${distillAgentName ? ` (via ${distillAgentName})` : ''}`}
          </button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
