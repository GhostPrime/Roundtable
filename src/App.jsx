import { useState, useRef, useEffect, useCallback } from 'react';
import AgentForm from './AgentForm.jsx';
import ChatStarter from './ChatStarter.jsx';
import ProjectForm from './ProjectForm.jsx';
import {
  runRound,
  buildMessagesFor,
  splitThinking,
  withRolePrompt,
  countSubtractors,
  roundMadeProgress,
  addressedAgent,
  parseChecks,
} from './orchestrator.js';

const api = window.api;

export default function App() {
  const [agents, setAgents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState({ type: 'group' });
  const [transcripts, setTranscripts] = useState({ group: [] });
  const [input, setInput] = useState('');
  const [rounds, setRounds] = useState(2);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [starting, setStarting] = useState(false);
  // Roster of agent ids in the current roundtable. null = not yet chosen (use all).
  const [roster, setRoster] = useState(null);
  const [mode, setMode] = useState('discuss'); // 'discuss' | 'build'
  // Projects
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [editingProject, setEditingProject] = useState(null); // null | 'new' | project object
  const stopRef = useRef(false);
  // Monotonically-increasing session token. Incremented on New Chat so any
  // in-flight send() from the previous session can self-abort before appending.
  const sessionRef = useRef(0);
  // Current callId prefix — lets stop() abort the in-flight IPC call.
  const callIdBase = useRef('');
  const scrollRef = useRef(null);

  useEffect(() => {
    Promise.all([api.listAgents(), api.listProjects()]).then(([a, p]) => {
      setAgents(a);
      setProjects(p);
      setLoaded(true);
    });
  }, []);

  const persist = useCallback((next) => {
    setAgents(next);
    api.saveAgents(next);
  }, []);

  const persistProjects = useCallback((next) => {
    setProjects(next);
    api.saveProjects(next);
  }, []);

  function saveProject(project) {
    const exists = projects.some((p) => p.id === project.id);
    persistProjects(exists ? projects.map((p) => (p.id === project.id ? project : p)) : [...projects, project]);
    setEditingProject(null);
  }

  function deleteProject(id) {
    persistProjects(projects.filter((p) => p.id !== id));
    if (activeProjectId === id) setActiveProjectId(null);
  }

  // Active project object (or null if none selected / project deleted).
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const targetKey = target.type === 'group' ? 'group' : target.agentId;
  const transcript = transcripts[targetKey] ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [transcript, busy]);

  function appendTo(key, entry) {
    setTranscripts((t) => ({ ...t, [key]: [...(t[key] ?? []), entry] }));
  }

  function saveAgent(agent) {
    const exists = agents.some((a) => a.id === agent.id);
    persist(exists ? agents.map((a) => (a.id === agent.id ? agent : a)) : [...agents, agent]);
    setEditing(null);
  }

  function deleteAgent(id) {
    persist(agents.filter((a) => a.id !== id));
    if (target.type === 'direct' && target.agentId === id) setTarget({ type: 'group' });
    setRoster((r) => (r ? r.filter((rid) => rid !== id) : r));
  }

  // New Chat: clear the roundtable transcript, seat only the chosen AIs, and
  // kill any in-flight send() so it can't bleed replies into the fresh chat.
  function startNewChat(ids) {
    stopRef.current = true;
    sessionRef.current += 1;
    if (callIdBase.current) api.abortCall(callIdBase.current);
    setBusy(false);
    setRoster(ids);
    setTranscripts((t) => ({ ...t, group: [] }));
    setTarget({ type: 'group' });
    setStarting(false);
  }

  // Agents currently seated at the roundtable (roster, or all if never chosen).
  const seated =
    roster === null ? agents : agents.filter((a) => roster.includes(a.id));

  // One seat replies in a single-seat context (direct chat or named @seat),
  // resolving any CHECK requests and giving one follow-up turn with the results.
  async function runSeatTurn(agent, key, startWorking, callId, safeAppend) {
    let working = startWorking;
    const ask = async () => {
      const raw = await api
        .callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working), callId)
        .catch((err) => `⚠️ ${agent.name} error: ${err.message}`);
      // Treat abort sentinel as a clean stop — don't append anything.
      if (raw === '__ABORTED__' || stopRef.current) return null;
      const { answer, thinking } = splitThinking(raw);
      const entry = {
        speaker: agent.name,
        agentId: agent.id,
        text: answer,
        thinking,
        ts: new Date().toLocaleTimeString(),
      };
      working = [...working, entry];
      safeAppend(key, entry);
      return answer;
    };

    const answer = await ask();
    if (answer === null) return; // stopped
    const checks = parseChecks(answer);
    if (checks.length > 0) {
      for (const c of checks) {
        let result;
        try {
          result = await api.runCheck(
            { op: c.op, arg: c.arg, content: c.content },
            activeProject?.path ?? null,
            agent.canWrite === true,
          );
        } catch (err) {
          result = { ok: false, output: String(err?.message || err) };
        }
        const label = result.ok ? `Check (${c.op} ${c.arg})` : `Check failed (${c.op} ${c.arg})`;
        const entry = { speaker: 'Tool', agentId: null, text: `${label}:\n${result.output}` };
        working = [...working, entry];
        safeAppend(key, entry);
      }
      await ask(); // one follow-up turn with the real results in context
    }
  }

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');

    const key = targetKey;
    // Snapshot the session token. If it changes (New Chat) while we're running,
    // we know this send is stale and must not touch the transcript.
    const mySession = sessionRef.current;
    const safeAppend = (k, entry) => {
      if (sessionRef.current !== mySession) return;
      appendTo(k, entry);
    };

    // Unique id for this send so stop() / New Chat can abort the live IPC call.
    const myCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    callIdBase.current = myCallId;

    const userEntry = { speaker: 'You', agentId: null, text };
    safeAppend(key, userEntry);

    setBusy(true);
    stopRef.current = false;
    let working = [...(transcripts[key] ?? []), userEntry];

    try {
      if (target.type === 'direct') {
        const agent = agents.find((a) => a.id === target.agentId);
        await runSeatTurn(agent, key, working, myCallId, safeAppend);
      } else {
        // Strict 1:1 speaker discipline: if the message names a seat, only that
        // seat replies — skip the full round.
        const named = addressedAgent(text, seated);
        if (named) {
          await runSeatTurn(named, key, working, myCallId, safeAppend);
          // fall through to finally — do NOT return early (would skip setBusy)
        } else {
          const participants = seated;
          if (participants.length === 0) {
            safeAppend(key, {
              speaker: 'System',
              agentId: null,
              text: 'Add at least one AI to start a roundtable.',
            });
          } else if (countSubtractors(participants) === 0) {
            safeAppend(key, {
              speaker: 'System',
              agentId: null,
              text: 'No subtractor seated — the table may drift toward agreement. Set an AI\'s role to "Subtractor" to keep it grounded.',
            });
          }
          // #1 — per-session failure/mute state, survives all rounds.
          const failures = new Map();
          const muted = new Set();
          for (let r = 0; r < rounds; r++) {
            if (stopRef.current || sessionRef.current !== mySession) break;
            const { working: next, produced } = await runRound({
              agents: participants,
              transcript: working,
              callAgent: (ag, msgs) => api.callAgent(ag, msgs, myCallId),
              onReply: (entry) => {
                safeAppend(key, entry);
              },
              shouldStop: () => stopRef.current || sessionRef.current !== mySession,
              failures,
              muted,
              runCheck: (req, ag) =>
                api.runCheck(
                  req,
                  activeProject?.path ?? null,
                  ag?.canWrite === true,
                ),
              mode,
            });
            working = next;
            if (participants.every((a) => muted.has(a.id))) break;
            if (r > 0 && !roundMadeProgress(produced)) {
              safeAppend(key, {
                speaker: 'System',
                agentId: null,
                text: 'Ended early — last round produced no new progress.',
              });
              break;
            }
          }
        }
      }
    } finally {
      if (callIdBase.current === myCallId) callIdBase.current = '';
      // Only clear busy if we're still the active session.
      if (sessionRef.current === mySession) setBusy(false);
    }
  }

  function stop() {
    stopRef.current = true;
    if (callIdBase.current) api.abortCall(callIdBase.current);
  }

  if (!loaded) return <div className="loading">Loading…</div>;

  const targetName =
    target.type === 'group'
      ? `Roundtable (${seated.length} AI${seated.length === 1 ? '' : 's'})`
      : agents.find((a) => a.id === target.agentId)?.name ?? 'Unknown';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Roundtable</div>

        {/* Project selector */}
        <div className="nav-label">
          Project
          <button className="label-action" title="Add project" onClick={() => setEditingProject('new')}>+</button>
        </div>
        <div className="project-selector">
          <select
            value={activeProjectId ?? ''}
            onChange={(e) => setActiveProjectId(e.target.value || null)}
            className="project-select"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {activeProject && (
            <div className="project-meta">
              <span className="project-path" title={activeProject.path}>{activeProject.path}</span>
              <div className="project-actions">
                <button className="icon" title="Edit project" onClick={() => setEditingProject(activeProject)}>✎</button>
                <button className="icon" title="Remove project" onClick={() => deleteProject(activeProject.id)}>✕</button>
              </div>
            </div>
          )}
        </div>

        <div className="nav-label">Direct chats</div>
        {agents.map((a) => (
          <div key={a.id} className="agent-row">
            <button
              className={`nav-item ${
                target.type === 'direct' && target.agentId === a.id ? 'active' : ''
              }`}
              onClick={() => {
                setTarget({ type: 'direct', agentId: a.id });
                setTranscripts((t) => ({ ...t, [a.id]: t[a.id] ?? [] }));
              }}
            >
              🤖 {a.name}
            </button>
            <button className="icon" title="Edit" onClick={() => setEditing(a)}>✎</button>
            <button className="icon" title="Remove" onClick={() => deleteAgent(a.id)}>✕</button>
          </div>
        ))}
        {agents.length === 0 && <div className="hint">No AIs yet.</div>}

        <button className="add-btn" onClick={() => setEditing('new')}>+ Add an AI</button>

        {/* Pinned to the bottom-left */}
        <div className="sidebar-bottom">
          <button className="new-chat-btn" onClick={() => setStarting(true)}>
            ✚ New chat
          </button>
          <button
            className={`roundtable-btn ${target.type === 'group' ? 'active' : ''}`}
            onClick={() => setTarget({ type: 'group' })}
          >
            👥 Roundtable
          </button>
        </div>
      </aside>

      <main className="chat">
        <header className="chat-header">
          <span className="chat-title">{targetName}</span>
          <div className="mode-toggle" title="Discuss = understand first, no code. Build = implementation welcome.">
            <button
              className={`mode-opt ${mode === 'discuss' ? 'active' : ''}`}
              onClick={() => setMode('discuss')}
            >
              💬 Discuss
            </button>
            <button
              className={`mode-opt ${mode === 'build' ? 'active' : ''}`}
              onClick={() => setMode('build')}
            >
              🔨 Build
            </button>
          </div>
          {target.type === 'group' && (
            <label className="rounds">
              Rounds
              <input
                type="number"
                min={1}
                max={10}
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value) || 1)}
              />
            </label>
          )}
          {busy && <button className="stop" onClick={stop}>■ Stop</button>}
        </header>

        <div className="messages" ref={scrollRef}>
          {transcript.length === 0 && (
            <p className="empty">
              {target.type === 'group'
                ? 'Post a message and the AIs will discuss it amongst themselves.'
                : 'Start a one-on-one conversation.'}
            </p>
          )}
          {transcript.map((m, i) => {
            const kind =
              m.speaker === 'You' ? 'user' : m.speaker === 'Tool' ? 'tool' : 'assistant';
            const agentColor =
              kind === 'assistant'
                ? agents.find((a) => a.id === m.agentId)?.color
                : null;
            return (
              <div
                key={i}
                className={`bubble ${kind} ${agentColor ? 'colored' : ''}`}
                style={agentColor ? { background: agentColor } : undefined}
              >
                {m.speaker !== 'You' && <div className="who">{m.speaker}</div>}
                <div className="text">{m.text}</div>
              </div>
            );
          })}
          {busy && <div className="bubble assistant pending">…thinking</div>}
        </div>

        <form className="composer" onSubmit={send}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              target.type === 'group'
                ? 'Pose a topic to the roundtable…'
                : `Message ${targetName}…`
            }
          />
          <button type="submit" disabled={busy || !input.trim()}>Send</button>
        </form>
      </main>

      {editing && (
        <AgentForm
          initial={editing === 'new' ? null : editing}
          onSave={saveAgent}
          onCancel={() => setEditing(null)}
        />
      )}

      {starting && (
        <ChatStarter
          agents={agents}
          onStart={startNewChat}
          onCancel={() => setStarting(false)}
        />
      )}

      {editingProject && (
        <ProjectForm
          initial={editingProject === 'new' ? null : editingProject}
          onSave={saveProject}
          onCancel={() => setEditingProject(null)}
        />
      )}
    </div>
  );
}
