import { useState } from 'react';

// New Chat picker: lists all saved AIs (pre-checked) and lets the user choose
// which ones enter a fresh roundtable. onStart receives the chosen agent ids.
export default function ChatStarter({ agents, onStart, onCancel }) {
  const [picked, setPicked] = useState(() => new Set(agents.map((a) => a.id)));

  function toggle(id) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const allOn = agents.length > 0 && picked.size === agents.length;
  function toggleAll() {
    setPicked(allOn ? new Set() : new Set(agents.map((a) => a.id)));
  }

  function start() {
    onStart([...picked]);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>New roundtable</h2>
        <p className="form-note">Choose which AIs join this chat. This clears the current roundtable.</p>

        {agents.length === 0 ? (
          <p className="hint">No AIs yet — add one first.</p>
        ) : (
          <>
            <label className="picker-row picker-all">
              <input type="checkbox" checked={allOn} onChange={toggleAll} />
              <span>Select all</span>
            </label>
            <div className="picker-list">
              {agents.map((a) => (
                <label key={a.id} className="picker-row">
                  <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                  <span>🤖 {a.name}</span>
                  {a.role && a.role !== 'contributor' && (
                    <span className="picker-tag">{a.role}</span>
                  )}
                </label>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={start} disabled={picked.size === 0}>
            Start chat
          </button>
        </div>
      </div>
    </div>
  );
}
