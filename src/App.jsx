import { useState, useRef, useEffect, useCallback } from 'react';
import AgentForm from './AgentForm.jsx';
import ChatStarter from './ChatStarter.jsx';
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
  const stopRef = useRef(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.listAgents().then((a) => {
      setAgents(a);
      setLoaded(true);
    });
  }, []);

  const persist = useCallback((next) => {
    setAgents(next);
    api.saveAgents(next);
  }, []);

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

  // New Chat: clear the roundtable transcript and seat only the chosen AIs.
  function startNewChat(ids) {
    setRoster(ids);
    setTranscripts((t) => ({ ...t, group: [] }));
    setTarget({ type: 'group' });
    setStarting(false);
  }

  // Agents currently seated at the roundtable (roster, or all if never chosen).
  const seated =
    roster === null ? agents : agents.filter((a) => roster.includes(a.id));

  // One seat replies in a single-seat context (direct chat or named @seat),
  // resolving any read-only CHECK requests and giving one follow-up turn.
  async function runSeatTurn(agent, key, startWorking) {
    let working = startWorking;
    const ask = async () => {
      const reply = await api
        .callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working))
        .catch((err) => `⚠️ ${agent.name} error: ${err.message}`);
      const { answer, thinking } = splitThinking(reply);
      const entry = {
        speaker: agent.name,
        agentId: agent.id,
        text: answer,
        thinking,
        ts: new Date().toLocaleTimeString(),
      };
      working = [...working, entry];
      appendTo(key, entry);
      return answer;
    };

    const answer = await ask();
    const checks = parseChecks(answer);
    if (checks.length > 0) {
      for (const c of checks) {
        let result;
        try {
          result = await api.runCheck({ op: c.op, arg: c.arg });
        } catch (err) {
          result = { ok: false, output: String(err?.message || err) };
        }
        const label = result.ok ? `Check (${c.op} ${c.arg})` : `Check failed (${c.op} ${c.arg})`;
        const entry = { speaker: 'Tool', agentId: null, text: `${label}:\n${result.output}` };
        working = [...working, entry];
        appendTo(key, entry);
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
    const userEntry = { speaker: 'You', agentId: null, text };
    appendTo(key, userEntry);

    setBusy(true);
    stopRef.current = false;
    let working = [...(transcripts[key] ?? []), userEntry];

    try {
      if (target.type === 'direct') {
        const agent = agents.find((a) => a.id === target.agentId);
        await runSeatTurn(agent, key, working);
      } else {
        // Strict 1:1 speaker discipline: if the message names a seat, only that
        // seat replies — skip the round entirely.
        const named = addressedAgent(text, seated);
        if (named) {
          await runSeatTurn(named, key, working);
          return;
        }
        const participants = seated;
        if (participants.length === 0) {
          appendTo(key, {
            speaker: 'System',
            agentId: null,
            text: 'Add at least one AI to start a roundtable.',
          });
        } else if (countSubtractors(participants) === 0) {
          // #2 — warn when nothing is holding the table down.
          appendTo(key, {
            speaker: 'System',
            agentId: null,
            text: 'No subtractor seated — the table may drift toward agreement. Set an AI\'s role to "Subtractor" to keep it grounded.',
          });
        }
        // #1 — per-session failure/mute state, survives all rounds.
        const failures = new Map();
        const muted = new Set();
        for (let r = 0; r < rounds; r++) {
          if (stopRef.current) break;
          const { working: next, produced } = await runRound({
            agents: participants,
            transcript: working,
            callAgent: (ag, msgs) => api.callAgent(ag, msgs),
            onReply: (entry) => {
              appendTo(key, entry);
            },
            shouldStop: () => stopRef.current,
            failures,
            muted,
            runCheck: (req) => api.runCheck(req),
            mode,
          });
          working = next;
          // #1 — if every seat is muted, there's nothing left to run.
          if (participants.every((a) => muted.has(a.id))) break;
          // #3 — stop early when a round adds no real progress. Skip the
          // check on the first round so the table always gets one full pass.
          if (r > 0 && !roundMadeProgress(produced)) {
            appendTo(key, {
              speaker: 'System',
              agentId: null,
              text: 'Ended early — last round produced no new progress.',
            });
            break;
          }
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    stopRef.current = true;
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
    </div>
  );
}
