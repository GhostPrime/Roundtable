// Action-approval modal: before a seat's write-classified MCP call executes
// (create an issue, send an email, upload a file, …), show the user exactly
// which tool would run and with what arguments, and let them Approve / Reject /
// Approve-all-for-this-chat. The orchestration loop awaits the decision — same
// flow as WriteApproval, but for integration calls instead of file writes.
import ApprovalActions from './ApprovalActions.jsx';

export default function ActionApproval({ approval, onDecide }) {
  const { target, args, description, destructive, unknown, agentName, color } = approval;

  // Pretty-print the JSON arguments if they parse; show raw text otherwise.
  let argText = '';
  if (args && args.trim()) {
    try { argText = JSON.stringify(JSON.parse(args), null, 2); }
    catch { argText = args; }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal write-approval">
        <h2>🔌 Integration call</h2>
        <p className="form-note">
          <strong style={color ? { color } : undefined}>{agentName || 'A seat'}</strong>{' '}
          wants to call <code>{target}</code>
          {destructive && <span className="action-flag"> ⚠ marked destructive by the server</span>}
          {unknown && <span className="action-flag"> ⚠ tool not in the connected catalog</span>}
        </p>
        {description && <p className="form-note action-desc">{description}</p>}
        <div className="diff-view">
          <pre className="tool-body action-args">{argText || '(no arguments)'}</pre>
        </div>
        <p className="form-note">
          This changes real data on the connected service and cannot be undone from here.
        </p>
        <ApprovalActions
          onDecide={onDecide}
          allLabel="Every later write and integration call in this chat runs without asking"
        />
      </div>
    </div>
  );
}
