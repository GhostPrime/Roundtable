// Roundtable Mobile — chat with API-backed AIs + device actions:
// calendar events, reminders, email drafts parsed from model replies.
import { useEffect, useRef, useState } from 'react';
import { callAgent } from './providers.js';
import {
  actionsPrompt,
  parseActions,
  shareEventIcs,
  googleCalendarUrl,
  scheduleReminder,
  emailUrl,
  addEventToDevice,
  upcomingEventsContext,
} from './actions.js';
import Markdown from './Markdown.jsx';

// ---- persistence (localStorage is stable inside the Capacitor WebView) ------
const LS_AGENTS = 'rt.agents';
const LS_CHATS = 'rt.chats';
const LS_CALCTX = 'rt.calctx';

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* full/blocked storage: keep running in-memory */ }
}

// Presets prefill base URL + a sensible model; everything stays editable.
// Most services speak the OpenAI chat-completions dialect, so provider is
// 'openai' for all of them — only the base URL differs.
const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', provider: 'anthropic', needsKey: true, defaultModel: 'claude-sonnet-5', baseUrl: '' },
  { id: 'openai-com', label: 'OpenAI', provider: 'openai', needsKey: true, defaultModel: 'gpt-5.2', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', provider: 'openai', needsKey: true, defaultModel: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'groq', label: 'Groq', provider: 'openai', needsKey: true, defaultModel: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openai', needsKey: true, defaultModel: 'openrouter/auto', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'xai', label: 'xAI (Grok)', provider: 'openai', needsKey: true, defaultModel: 'grok-3', baseUrl: 'https://api.x.ai/v1' },
  { id: 'mistral', label: 'Mistral', provider: 'openai', needsKey: true, defaultModel: 'mistral-large-latest', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'gemini', label: 'Google Gemini', provider: 'openai', needsKey: true, defaultModel: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'together', label: 'Together AI', provider: 'openai', needsKey: true, defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', baseUrl: 'https://api.together.xyz/v1' },
  { id: 'custom', label: 'Custom (any OpenAI-compatible URL)', provider: 'openai', needsKey: true, defaultModel: '', baseUrl: '' },
  { id: 'ollama', label: 'Ollama (LAN)', provider: 'ollama', needsKey: false, defaultModel: 'llama3.1', baseUrl: '' },
];

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- action cards -------------------------------------------------------------

function ActionCard({ action }) {
  const [status, setStatus] = useState('');
  const run = async (fn, okMsg) => {
    try {
      await fn();
      setStatus(okMsg);
    } catch (e) {
      setStatus(`⚠️ ${e.message}`);
    }
  };

  if (action.type === 'event') {
    const gcal = googleCalendarUrl(action);
    return (
      <div className="action-card">
        <div className="action-kind">📅 Calendar event</div>
        <div className="action-title">{action.title || 'Event'}</div>
        <div className="action-meta">
          {action.start}{action.end ? ` → ${action.end}` : ''}{action.location ? ` · ${action.location}` : ''}
        </div>
        <div className="action-buttons">
          <button className="primary" onClick={() => run(() => addEventToDevice(action), 'Added to calendar ✓')}>
            Add to calendar
          </button>
          {gcal && (
            <button onClick={() => window.open(gcal, '_blank')}>Google Calendar</button>
          )}
          <button onClick={() => run(() => shareEventIcs(action), 'Shared .ics ✓')}>
            Share .ics
          </button>
        </div>
        {status && <div className="action-status">{status}</div>}
      </div>
    );
  }
  if (action.type === 'reminder') {
    return (
      <div className="action-card">
        <div className="action-kind">⏰ Reminder</div>
        <div className="action-title">{action.title || 'Reminder'}</div>
        <div className="action-meta">{action.at}{action.notes ? ` · ${action.notes}` : ''}</div>
        <div className="action-buttons">
          <button
            onClick={() =>
              run(async () => {
                const at = await scheduleReminder(action);
                return at;
              }, 'Scheduled ✓')
            }
          >
            Set reminder
          </button>
        </div>
        {status && <div className="action-status">{status}</div>}
      </div>
    );
  }
  if (action.type === 'email') {
    return (
      <div className="action-card">
        <div className="action-kind">✉️ Email draft</div>
        <div className="action-title">{action.subject || '(no subject)'}</div>
        <div className="action-meta">To: {action.to || '(fill in)'}</div>
        <div className="action-buttons">
          <button onClick={() => (window.location.href = emailUrl(action))}>
            Open in mail app
          </button>
        </div>
        {status && <div className="action-status">{status}</div>}
      </div>
    );
  }
  return null;
}

// ---- agent form ----------------------------------------------------------------

// Existing agents saved before presets existed carry only a provider —
// map them back to the closest preset so the form opens in a sane state.
function guessPreset(agent) {
  if (!agent) return PROVIDERS[0];
  return (
    PROVIDERS.find((p) => p.baseUrl && p.baseUrl === agent.baseUrl) ||
    PROVIDERS.find((p) => p.provider === agent.provider && !p.baseUrl) ||
    PROVIDERS.find((p) => p.id === 'custom')
  );
}

function AgentForm({ agent, onSave, onCancel, onDelete }) {
  const initial = guessPreset(agent);
  const [preset, setPreset] = useState(agent?.preset || initial.id);
  const [form, setForm] = useState(
    agent || {
      name: '', provider: initial.provider, model: '', apiKey: '',
      baseUrl: initial.baseUrl, systemPrompt: '',
    },
  );
  const prov = PROVIDERS.find((p) => p.id === preset) || PROVIDERS[0];
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function pickPreset(e) {
    const p = PROVIDERS.find((x) => x.id === e.target.value);
    setPreset(p.id);
    // Prefill URL + model for the chosen service; name if still empty.
    setForm((f) => ({
      ...f,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.defaultModel,
      name: f.name || (p.id !== 'custom' && p.id !== 'ollama' ? p.label.split(' ')[0] : f.name),
    }));
  }

  return (
    <div className="sheet">
      <div className="sheet-title">{agent ? 'Edit AI' : 'Add AI'}</div>
      <label>
        Service
        <select value={preset} onChange={pickPreset}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>
      <label>Name<input value={form.name} onChange={set('name')} placeholder="Claude" /></label>
      <label>Model<input value={form.model} onChange={set('model')} placeholder={prov.defaultModel || 'model name'} /></label>
      {prov.needsKey && (
        <label>API key<input value={form.apiKey} onChange={set('apiKey')} type="password" placeholder="sk-..." /></label>
      )}
      <label>
        Base URL {prov.id === 'custom'
          ? <span className="opt">(required — e.g. https://api.example.com/v1)</span>
          : <span className="opt">(prefilled{form.provider === 'ollama' ? ' — e.g. http://192.168.1.20:11434' : ''})</span>}
        <input value={form.baseUrl} onChange={set('baseUrl')} placeholder={form.provider === 'ollama' ? 'http://192.168.1.20:11434' : 'https://api.example.com/v1'} />
      </label>
      <label>System prompt <span className="opt">(optional)</span>
        <textarea rows={3} value={form.systemPrompt} onChange={set('systemPrompt')} />
      </label>
      <div className="sheet-buttons">
        <button
          className="primary"
          onClick={() => {
            if (!form.name.trim()) return alert('Give it a name.');
            if (prov.id === 'custom' && !form.baseUrl.trim()) return alert('Custom service needs a base URL.');
            if (!form.model.trim() && !prov.defaultModel) return alert('Enter a model name.');
            onSave({
              ...form,
              preset,
              model: form.model.trim() || prov.defaultModel,
              id: form.id || newId(),
            });
          }}
        >
          Save
        </button>
        <button onClick={onCancel}>Cancel</button>
        {agent && (
          <button className="danger" onClick={() => onDelete(agent.id)}>Delete</button>
        )}
      </div>
    </div>
  );
}

// ---- app -----------------------------------------------------------------------

export default function App() {
  const [agents, setAgents] = useState(() => load(LS_AGENTS, []));
  const [chats, setChats] = useState(() => load(LS_CHATS, []));
  const [chatId, setChatId] = useState(() => load(LS_CHATS, [])[0]?.id ?? null);
  const [agentId, setAgentId] = useState(() => load(LS_AGENTS, [])[0]?.id ?? null);
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [calCtx, setCalCtx] = useState(() => load(LS_CALCTX, false));
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => save(LS_AGENTS, agents), [agents]);
  useEffect(() => save(LS_CHATS, chats), [chats]);
  useEffect(() => save(LS_CALCTX, calCtx), [calCtx]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chats, chatId, busy]);

  const chat = chats.find((c) => c.id === chatId) || null;
  const agent = agents.find((a) => a.id === agentId) || null;

  function updateChat(id, fn) {
    setChats((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
  }

  async function send() {
    const content = input.trim();
    if (!content || busy) return;
    if (!agent) { setEditing(null); return; }

    let id = chatId;
    if (!id) {
      id = newId();
      const title = content.slice(0, 40);
      setChats((cs) => [{ id, title, messages: [] }, ...cs]);
      setChatId(id);
    }
    setInput('');
    const userMsg = { role: 'user', content };
    updateChat(id, (c) => ({ ...c, messages: [...c.messages, userMsg] }));
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // Build transcript from latest state (React state updates are async).
      const prior = (chats.find((c) => c.id === id)?.messages || []).concat(userMsg);
      // Optionally let the model see the next week of real calendar entries.
      let extra = actionsPrompt();
      if (calCtx) {
        try {
          extra += `\n\n${await upcomingEventsContext(7)}`;
        } catch {
          extra += '\n\n(The user enabled calendar sharing, but calendar access failed — say so if asked about their schedule.)';
        }
      }
      const { text } = await callAgent(agent, prior, extra, ac.signal);
      const { text: display, actions } = parseActions(text);
      updateChat(id, (c) => ({
        ...c,
        messages: [...c.messages, { role: 'assistant', content: display || '(see actions below)', actions, agentName: agent.name }],
      }));
    } catch (e) {
      const msg = e.name === 'AbortError' ? '(stopped)' : `⚠️ ${e.message}`;
      updateChat(id, (c) => ({ ...c, messages: [...c.messages, { role: 'assistant', content: msg, agentName: agent.name }] }));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="app">
      {/* header */}
      <header className="topbar">
        <button className="icon-btn" onClick={() => setDrawer(true)}>☰</button>
        <div className="topbar-title">{chat?.title || 'Roundtable'}</div>
        <select
          className="agent-pick"
          value={agentId || ''}
          onChange={(e) => (e.target.value === '__add' ? setEditing(null) : setAgentId(e.target.value))}
        >
          {agents.length === 0 && <option value="">No AI yet</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
          <option value="__add">＋ Add AI…</option>
        </select>
      </header>

      {/* messages */}
      <main className="messages" ref={scrollRef}>
        {!chat && (
          <div className="empty">
            <div className="empty-logo">Roundtable</div>
            <p>Chat with your AIs, and let them create calendar events, reminders, and email drafts you can use with one tap.</p>
            {agents.length === 0 && (
              <button className="primary" onClick={() => setEditing(null)}>Add your first AI</button>
            )}
            <p className="hint-small">Try: “remind me to call Mom tomorrow at 5pm” or “draft an email to my landlord about the leaky faucet”.</p>
          </div>
        )}
        {chat?.messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === 'assistant' && m.agentName && <div className="who">{m.agentName}</div>}
            <Markdown text={m.content} />
            {m.actions?.map((a, j) => <ActionCard key={j} action={a} />)}
          </div>
        ))}
        {busy && <div className="bubble assistant thinking">…thinking</div>}
      </main>

      {/* composer */}
      <footer className="composer">
        <textarea
          rows={1}
          value={input}
          placeholder={agent ? `Message ${agent.name}` : 'Add an AI to start'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        {busy ? (
          <button className="send stop" onClick={() => abortRef.current?.abort()}>■</button>
        ) : (
          <button className="send" onClick={send} disabled={!input.trim()}>➤</button>
        )}
      </footer>

      {/* drawer: chats + agents */}
      {drawer && (
        <div className="scrim" onClick={() => setDrawer(false)}>
          <nav className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="brand">Roundtable</div>
            <button className="primary wide" onClick={() => { setChatId(null); setDrawer(false); }}>
              ＋ New chat
            </button>
            <div className="nav-label">Chats</div>
            {chats.map((c) => (
              <div key={c.id} className={`nav-item ${c.id === chatId ? 'active' : ''}`}>
                <span className="nav-item-title" onClick={() => { setChatId(c.id); setDrawer(false); }}>
                  {c.title}
                </span>
                <button
                  className="icon-btn small"
                  onClick={() => {
                    setChats((cs) => cs.filter((x) => x.id !== c.id));
                    if (chatId === c.id) setChatId(null);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="nav-label">AIs</div>
            {agents.map((a) => (
              <div key={a.id} className="nav-item">
                <span className="nav-item-title" onClick={() => { setAgentId(a.id); setDrawer(false); }}>
                  {a.name} <span className="opt">({a.provider})</span>
                </span>
                <button className="icon-btn small" onClick={() => setEditing(a)}>✎</button>
              </div>
            ))}
            <button className="wide" onClick={() => setEditing(null)}>＋ Add AI</button>
            <div className="nav-label">Options</div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={calCtx}
                onChange={(e) => setCalCtx(e.target.checked)}
              />
              <span>Let AI see my calendar<br /><span className="opt">next 7 days, sent with each message</span></span>
            </label>
          </nav>
        </div>
      )}

      {/* agent editor sheet */}
      {editing !== undefined && (
        <div className="scrim center" onClick={() => setEditing(undefined)}>
          <div onClick={(e) => e.stopPropagation()}>
            <AgentForm
              agent={editing}
              onSave={(a) => {
                setAgents((as) => {
                  const i = as.findIndex((x) => x.id === a.id);
                  return i >= 0 ? as.map((x) => (x.id === a.id ? a : x)) : [...as, a];
                });
                setAgentId(a.id);
                setEditing(undefined);
              }}
              onCancel={() => setEditing(undefined)}
              onDelete={(id) => {
                setAgents((as) => as.filter((x) => x.id !== id));
                if (agentId === id) setAgentId(null);
                setEditing(undefined);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
