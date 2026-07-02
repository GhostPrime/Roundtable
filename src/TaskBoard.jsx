// Shared task board panel. Seats manage it with TASK: add / TASK: done lines
// (parsed by orchestrator.parseTasks as replies arrive); the user manages it
// here directly. Board state lives in App.jsx and resets on New Chat.
import { useState } from 'react';

export default function TaskBoard({ tasks, onToggle, onAdd, onRemove, onClearDone, onClose }) {
  const [draft, setDraft] = useState('');
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  const submit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onAdd(text);
    setDraft('');
  };

  const row = (t) => (
    <div key={t.id} className={`task-row ${t.done ? 'done' : ''}`}>
      <button
        className="task-check"
        title={t.done ? 'Reopen' : 'Mark done'}
        onClick={() => onToggle(t.id)}
      >
        {t.done ? '✓' : ''}
      </button>
      <span className="task-id">#{t.id}</span>
      <span className="task-text">{t.text}</span>
      <span
        className="task-by"
        title={`Added by ${t.by}${t.doneBy ? ` · done by ${t.doneBy}` : ''}`}
      >
        {t.by}
      </span>
      <button className="icon task-del" title="Remove" onClick={() => onRemove(t.id)}>
        ✕
      </button>
    </div>
  );

  return (
    <aside className="scripts-panel tasks-panel">
      <div className="scripts-head">
        <span className="scripts-title">☑ Task board</span>
        <span className="scripts-count">{open.length} open</span>
        {done.length > 0 && (
          <button className="mini-btn" onClick={onClearDone}>
            Clear done
          </button>
        )}
        <button className="icon" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="scripts-body">
        {tasks.length === 0 && (
          <p className="scripts-empty">
            No tasks yet. Seats add them with <code>TASK: add …</code> lines and finish them
            with <code>TASK: done #id</code> — or add one yourself below.
          </p>
        )}
        {open.map(row)}
        {done.length > 0 && <div className="scripts-section">Done</div>}
        {done.map(row)}
      </div>
      <form className="task-add" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…"
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
    </aside>
  );
}
