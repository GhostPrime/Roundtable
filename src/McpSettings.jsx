// Integrations settings: add/edit/remove MCP servers and see their live
// connection status + tool catalog. Secrets (env/header values) are stored
// encrypted in main; this form only ever sees the KEY_SET sentinel for saved
// values — retype a value to replace it, clear it to drop it.
import { useState } from 'react';

const KEY_SET = '__KEY_SET__';

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'mcp_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Presets prefill the form for the common three. Google's servers need a
// one-time OAuth/credentials setup on the user's machine — BYOK, like API keys.
const PRESETS = [
  {
    label: 'GitHub',
    note: 'GitHub\'s hosted MCP server. Needs a Personal Access Token (github.com → Settings → Developer settings).',
    server: {
      name: 'GitHub',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: '' }, // user pastes "Bearer ghp_…"
      env: {},
    },
    hint: 'Set the Authorization header to:  Bearer <your PAT>',
  },
  {
    label: 'Google Drive',
    note: 'Reference Google Drive server, run locally via npx. Requires Google OAuth credentials (see the server\'s README for the one-time auth flow).',
    server: {
      name: 'Google Drive',
      transport: 'stdio',
      command: 'npx',
      args: '-y @modelcontextprotocol/server-gdrive',
      env: { GDRIVE_CREDENTIALS_PATH: '' },
      headers: {},
    },
    hint: 'GDRIVE_CREDENTIALS_PATH = path to the saved credentials JSON after the one-time auth.',
  },
  {
    label: 'Gmail',
    note: 'Community Gmail server (auto-auth), run locally via npx. First run opens a browser for Google OAuth; review the server before trusting it with mail.',
    server: {
      name: 'Gmail',
      transport: 'stdio',
      command: 'npx',
      args: '-y @gongrzhe/server-gmail-autoauth-mcp',
      env: {},
      headers: {},
    },
    hint: 'Requires a one-time OAuth setup — see the server\'s README (gcp-oauth.keys.json).',
  },
  {
    label: 'Yahoo Mail',
    note: 'Bundled Yahoo Mail server (scripts/mcp-yahoo-mail.js) — IMAP read/search, SMTP send, flag/move/delete. Needs a Yahoo app password (login.yahoo.com → Account Security → App passwords), not your normal password.',
    server: {
      name: 'Yahoo Mail',
      transport: 'stdio',
      command: 'node',
      args: 'scripts/mcp-yahoo-mail.js',
      env: { YAHOO_EMAIL: '', YAHOO_APP_PASSWORD: '' },
      headers: {},
    },
    hint: 'If the app isn\'t launched from the repo root, change args to the absolute path of scripts/mcp-yahoo-mail.js.',
  },
];

const DOT = { connected: '🟢', connecting: '🟡', error: '🔴' };

// key=value editor for env vars / headers. Values arrive masked (KEY_SET);
// leaving the mask means "keep the stored secret".
function KVEditor({ label, kv, onChange, secretHint }) {
  const entries = Object.entries(kv || {});
  return (
    <label>
      {label}
      {entries.map(([k, v], i) => (
        <div className="folder-row" key={i}>
          <input
            className="kv-key"
            value={k}
            placeholder="NAME"
            onChange={(e) => {
              const next = entries.slice();
              next[i] = [e.target.value, v];
              onChange(Object.fromEntries(next));
            }}
          />
          <input
            className="kv-val"
            type="password"
            value={v}
            placeholder={secretHint}
            title={v === KEY_SET ? 'A value is saved (encrypted). Type to replace it.' : ''}
            onFocus={(e) => { if (v === KEY_SET) e.target.select(); }}
            onChange={(e) => {
              const next = entries.slice();
              next[i] = [k, e.target.value];
              onChange(Object.fromEntries(next));
            }}
          />
          <button
            type="button"
            className="mini-btn"
            title="Remove"
            onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="mini-btn"
        onClick={() => onChange({ ...(kv || {}), '': '' })}
      >
        + add
      </button>
    </label>
  );
}

export default function McpSettings({ servers, status, onSave, onRefresh, onClose }) {
  const [list, setList] = useState(servers || []);
  const [editing, setEditing] = useState(null); // null | server draft
  const [presetNote, setPresetNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const statusById = new Map((status || []).map((s) => [s.id, s]));

  async function persist(next) {
    setSaving(true);
    setError('');
    try {
      setList(next);
      await onSave(next);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setSaving(false);
    }
  }

  function startPreset(p) {
    setPresetNote(`${p.note}${p.hint ? `\n${p.hint}` : ''}`);
    setEditing({ id: makeId(), enabled: true, args: '', command: '', url: '', ...p.server });
  }

  function submitEdit(e) {
    e.preventDefault();
    setError('');
    if (!editing.name?.trim()) return setError('Please name this integration.');
    if (editing.transport === 'http' && !editing.url?.trim()) return setError('Please enter the server URL.');
    if (editing.transport !== 'http' && !editing.command?.trim()) return setError('Please enter the command to run.');
    // Drop empty-name env/header rows.
    const clean = (kv) => Object.fromEntries(Object.entries(kv || {}).filter(([k]) => k.trim()));
    const next = { ...editing, name: editing.name.trim(), env: clean(editing.env), headers: clean(editing.headers) };
    const exists = list.some((s) => s.id === next.id);
    persist(exists ? list.map((s) => (s.id === next.id ? next : s)) : [...list, next]);
    setEditing(null);
    setPresetNote('');
  }

  // ---- edit form -------------------------------------------------------------
  if (editing) {
    return (
      <div className="modal-backdrop" onMouseDown={() => { setEditing(null); setPresetNote(''); }}>
        <form className="modal mcp-form" onMouseDown={(e) => e.stopPropagation()} onSubmit={submitEdit}>
          <h2>🔌 {list.some((s) => s.id === editing.id) ? 'Edit integration' : 'Add integration'}</h2>
          {presetNote && <p className="form-note mcp-preset-note">{presetNote}</p>}

          <label>
            Name
            <input
              value={editing.name || ''}
              autoFocus
              placeholder="e.g. GitHub"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>

          <label>
            Transport
            <select
              value={editing.transport === 'http' ? 'http' : 'stdio'}
              onChange={(e) => setEditing({ ...editing, transport: e.target.value })}
            >
              <option value="stdio">Local command (stdio)</option>
              <option value="http">Remote server (HTTP)</option>
            </select>
          </label>

          {editing.transport === 'http' ? (
            <>
              <label>
                Server URL
                <input
                  value={editing.url || ''}
                  placeholder="https://api.githubcopilot.com/mcp/"
                  onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                />
              </label>
              <KVEditor
                label="Headers (values stored encrypted)"
                kv={editing.headers}
                onChange={(headers) => setEditing({ ...editing, headers })}
                secretHint="e.g. Bearer ghp_…"
              />
            </>
          ) : (
            <>
              <label>
                Command
                <input
                  value={editing.command || ''}
                  placeholder="npx"
                  onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                />
              </label>
              <label>
                Arguments
                <input
                  value={editing.args || ''}
                  placeholder="-y @modelcontextprotocol/server-gdrive"
                  onChange={(e) => setEditing({ ...editing, args: e.target.value })}
                />
              </label>
              <KVEditor
                label="Environment variables (values stored encrypted)"
                kv={editing.env}
                onChange={(env) => setEditing({ ...editing, env })}
                secretHint="secret value"
              />
            </>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={() => { setEditing(null); setPresetNote(''); }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>{saving ? 'Connecting…' : 'Save & connect'}</button>
          </div>
        </form>
      </div>
    );
  }

  // ---- server list -------------------------------------------------------------
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal mcp-form" onMouseDown={(e) => e.stopPropagation()}>
        <h2>🔌 Integrations</h2>
        <p className="form-note">
          Connect MCP servers so seats can use real services (GitHub, Google
          Drive, Gmail, or any other MCP server). Read tools run freely; write
          tools need the seat's write access AND your approval per call.
        </p>

        {list.length === 0 && <p className="scripts-empty">No integrations yet — start from a preset below.</p>}

        {list.map((s) => {
          const st = s.enabled === false ? null : statusById.get(s.id);
          return (
            <div className="mcp-row-wrap" key={s.id}>
            <div className="mcp-row">
              <span className="mcp-dot" title={st?.error || st?.status || 'disabled'}>
                {s.enabled === false ? '⚪' : DOT[st?.status] || '⚪'}
              </span>
              <span className="mcp-name">{s.name}</span>
              <span className="mcp-meta">
                {st?.status === 'connected'
                  ? `${st.tools.length} tools as "${st.slug}"`
                  : st?.status === 'error'
                    ? 'connection failed'
                    : s.enabled === false ? 'disabled' : (st?.status || 'not connected')}
              </span>
              <button
                type="button"
                className="mini-btn"
                title={s.enabled === false ? 'Enable and connect' : 'Disable and disconnect'}
                onClick={() => persist(list.map((x) => (x.id === s.id ? { ...x, enabled: x.enabled === false } : x)))}
              >
                {s.enabled === false ? 'Enable' : 'Disable'}
              </button>
              <button type="button" className="mini-btn" onClick={() => setEditing({ ...s })}>
                Edit
              </button>
              <button
                type="button"
                className="mini-btn"
                title="Remove this integration"
                onClick={() => persist(list.filter((x) => x.id !== s.id))}
              >
                ✕
              </button>
            </div>
            {st?.status === 'error' && st?.error && (
              <div className="mcp-error">{st.error}</div>
            )}
            </div>
          );
        })}

        <div className="mcp-presets">
          <span className="nav-label">Add</span>
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="mini-btn" onClick={() => startPreset(p)}>
              + {p.label}
            </button>
          ))}
          <button
            type="button"
            className="mini-btn"
            onClick={() => {
              setPresetNote('');
              setEditing({ id: makeId(), name: '', transport: 'stdio', command: '', args: '', url: '', env: {}, headers: {}, enabled: true });
            }}
          >
            + Custom…
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={() => onRefresh?.()} disabled={saving}>
            Refresh status
          </button>
          <button type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
