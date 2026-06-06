import { useState } from 'react';

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Modal for adding or editing a project.
// A project is: { id, name, path }
// The folder is chosen via the native OS dialog (dialog:pickFolder IPC).
export default function ProjectForm({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [folderPath, setFolderPath] = useState(initial?.path ?? '');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  async function pickFolder() {
    setPicking(true);
    try {
      const p = await window.api.pickFolder();
      if (p) setFolderPath(p);
    } finally {
      setPicking(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Please enter a project name.');
    if (!folderPath.trim()) return setError('Please choose a folder.');
    onSave({
      id: initial?.id ?? makeId(),
      name: name.trim(),
      path: folderPath.trim(),
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{initial ? 'Edit project' : 'Add a project'}</h2>
        <p className="form-note">
          Agents can read (and optionally write) files inside this folder.
          Files outside it are always off-limits.
        </p>

        <label>
          Project name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My Web App"
            autoFocus
          />
        </label>

        <label>
          Folder
          <div className="folder-row">
            <input
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="Choose a folder…"
              readOnly
              className="folder-path"
            />
            <button type="button" className="mini-btn" onClick={pickFolder} disabled={picking}>
              {picking ? '…' : 'Browse'}
            </button>
          </div>
        </label>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="submit">{initial ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </div>
  );
}
