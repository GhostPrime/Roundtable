import { useState, useRef, useEffect, useCallback } from 'react';
import AgentForm, { ROLE_HELP } from './AgentForm.jsx';
import ChatStarter from './ChatStarter.jsx';
import ProjectForm from './ProjectForm.jsx';
import PromptFlowCanvas from './PromptFlowCanvas.jsx';
import {
  runRound,
  buildMessagesFor,
  splitThinking,
  withRolePrompt,
  countSubtractors,
  roundMadeProgress,
  addressedAgent,
  parseChecks,
  orderSeats,
} from './orchestrator.js';

const api = window.api;

// Clickable starter prompts shown on the empty roundtable.
const STARTERS = [
  'Propose a simple architecture for this project',
  'What are the three biggest unknowns to resolve first?',
  'Review the current folder structure and flag any risks',
];

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
  // Prompt Flow Canvas — agent id whose prompt pipeline is open (null = closed).
  const [flowAgentId, setFlowAgentId] = useState(null);
  // Images queued in the composer, sent with the next message.
  const [pendingImages, setPendingImages] = useState([]); // [{ dataUrl, name }]
  const fileInputRef = useRef(null);
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
    // Main encrypts keys and returns the masked view (apiKey -> '__KEY_SET__');
    // adopt it so plaintext keys never linger in renderer state.
    api.saveAgents(next).then((saved) => {
      if (Array.isArray(saved)) setAgents(saved);
    });
  }, []);

  const persistProjects = useCallback((next) => {
    setProjects(next);
    api.saveProjects(next);
  }, []);

  function saveProject(project) {
    const exists = projects.some((p) => p.id === project.id);
    persistProjects(exists ? projects.map((p) => (p.id === project.id ? project : p)) : [...projects, project]);
    // A project you just added or edited is the one you meant to use — without
    // this, the dropdown silently kept whatever was active before (or "No
    // project"), so CHECK calls kept targeting the old folder and agents
    // looked like they couldn't see the new one.
    setActiveProjectId(project.id);
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

  // Duplicate an existing AI: pre-fill the editor with a copy but DO NOT save
  // anything yet — the copy only exists once the user presses Save. id is left
  // off so the form mints a fresh one; cloneKeyFrom tells the store to inherit
  // the source's encrypted key on save (and lets Test connection work before
  // then). Then tweak the role — e.g. clone the coder, flip the copy to
  // Subtractor.
  function cloneAgent(id) {
    const src = agents.find((a) => a.id === id);
    if (!src) return;
    const names = new Set(agents.map((a) => a.name));
    let name = `${src.name} (copy)`;
    for (let n = 2; names.has(name); n++) name = `${src.name} (copy ${n})`;
    const { id: _drop, ...rest } = src;
    setEditing({ ...rest, name, cloneKeyFrom: id });
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
  // Seated agents in the order they actually speak each round (designer →
  // contributor/coder → reviewer/subtractor), so the sidebar can number them.
  const seatedOrdered = orderSeats(seated);
  const benched = agents.filter((a) => !seated.includes(a));

  const isSeated = (id) => roster === null || roster.includes(id);
  // Seat or bench an AI without starting a new chat. First toggle off the
  // implicit "all seated" default by materializing the full roster, then flip.
  function toggleSeat(id) {
    setRoster((prev) => {
      const base = prev === null ? agents.map((a) => a.id) : prev;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  }

  // One sidebar row. seatNo is the 1-based speaking position when seated, or
  // null when benched (shows a "+" to seat instead of a turn number).
  const renderAgentRow = (a, seatNo) => (
    <div key={a.id} className={`agent-row ${seatNo === null ? 'benched' : ''}`}>
      {seatNo === null ? (
        <button className="seat-num seat-add" title="Seat at the roundtable" onClick={() => toggleSeat(a.id)}>＋</button>
      ) : (
        <button className="seat-num" title={`Speaks #${seatNo} — click to bench`} onClick={() => toggleSeat(a.id)}>{seatNo}</button>
      )}
      <button
        className={`nav-item ${target.type === 'direct' && target.agentId === a.id ? 'active' : ''}`}
        onClick={() => {
          setTarget({ type: 'direct', agentId: a.id });
          setTranscripts((t) => ({ ...t, [a.id]: t[a.id] ?? [] }));
        }}
      >
        <span className="name" style={{ background: a.color || 'var(--muted)' }}>{a.name}</span>
        {a.role && a.role !== 'contributor' && (
          <span className="role-badge" title={ROLE_HELP[a.role] ?? a.role}>{a.role}</span>
        )}
      </button>
      <div className="row-actions">
        <button className="icon" title="Prompt flow" onClick={() => setFlowAgentId(a.id)}>⛓</button>
        <button className="icon" title="Duplicate (keeps API key — change the role on the copy)" onClick={() => cloneAgent(a.id)}>⧉</button>
        <button className="icon" title="Edit" onClick={() => setEditing(a)}>✎</button>
        <button className="icon" title="Remove" onClick={() => deleteAgent(a.id)}>✕</button>
      </div>
    </div>
  );

  // Downscale to ≤1568px long edge and re-encode as JPEG — vision models
  // don't benefit from more, and it keeps transcripts and payloads small.
  async function fileToShrunkDataUrl(file) {
    const bitmap = await createImageBitmap(file);
    const MAX = 1568;
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // flatten transparency instead of going black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  async function addImages(files) {
    const imgs = [...files].filter((f) => f && f.type?.startsWith('image/'));
    for (const f of imgs) {
      try {
        const dataUrl = await fileToShrunkDataUrl(f);
        setPendingImages((p) => [...p, { dataUrl, name: f.name || 'pasted image' }]);
      } catch {
        /* not a decodable image — skip silently */
      }
    }
  }

  // One seat replies in a single-seat context (direct chat or named @seat),
  // resolving any CHECK requests and giving one follow-up turn with the results.
  async function runSeatTurn(agent, key, startWorking, callId, safeAppend) {
    let working = startWorking;
    const ask = async () => {
      const raw = await api
        .callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working), callId, activeProject?.path ?? null)
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
    // DISCUSS mode = no file access, even if the seat emits CHECK lines anyway.
    const checks = mode === 'discuss' ? [] : parseChecks(answer);
    if (checks.length > 0) {
      for (const c of checks) {
        let result;
        try {
          result = await api.runCheck(
            { op: c.op, arg: c.arg, content: c.content },
            activeProject?.path ?? null,
            agent.id,
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

  async function send(e, textOverride) {
    e?.preventDefault();
    const text = (textOverride ?? input).trim();
    if ((!text && pendingImages.length === 0) || busy) return;
    setInput('');
    const images = pendingImages.map((p) => p.dataUrl);
    setPendingImages([]);

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

    const userEntry = {
      speaker: 'You',
      agentId: null,
      text,
      ...(images.length ? { images } : {}),
    };
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
              callAgent: (ag, msgs) => api.callAgent(ag, msgs, myCallId, activeProject?.path ?? null),
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
                  ag?.id,
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
          <button className="label-action" title="Add project" disabled={busy} onClick={() => setEditingProject('new')}>+</button>
        </div>
        <div className="project-selector">
          <select
            value={activeProjectId ?? ''}
            onChange={(e) => setActiveProjectId(e.target.value || null)}
            className="project-select"
            disabled={busy}
            title={busy ? 'Folder is locked while a round is running — it applies on your next message anyway' : undefined}
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
                <button className="icon" title="Edit project" disabled={busy} onClick={() => setEditingProject(activeProject)}>✎</button>
                <button className="icon" title="Remove project" disabled={busy} onClick={() => deleteProject(activeProject.id)}>✕</button>
              </div>
            </div>
          )}
        </div>

        <div className="nav-label">At the table · speaking order</div>
        {seatedOrdered.map((a, idx) => renderAgentRow(a, idx + 1))}
        {agents.length > 0 && seated.length === 0 && (
          <div className="hint">No one seated — seat an AI from Benched below.</div>
        )}

        {benched.length > 0 && <div className="nav-label">Benched</div>}
        {benched.map((a) => renderAgentRow(a, null))}

        {agents.length === 0 && <div className="hint">No AIs yet.</div>}

        <button className="add-btn" onClick={() => setEditing('new')}>+ Add an AI</button>

        {/* Pinned to the bottom-left */}
        <div className="sidebar-bottom">
          <button
            className={`roundtable-btn ${target.type === 'group' ? 'active' : ''}`}
            onClick={() => setTarget({ type: 'group' })}
          >
            👥 Roundtable
          </button>
          <div className="sidebar-footer">
            <button className="foot-btn" onClick={() => setStarting(true)}>
              ✚ New chat
            </button>
            <button
              className="foot-btn icon-only"
              title="Open the app log file (every agent call, CLI run, and file check)"
              aria-label="Open log"
              onClick={() => api.openLog()}
            >
              📜
            </button>
          </div>
        </div>
      </aside>

      <main
        className="chat"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
        }}
      >
        <header className="chat-header">
          <div className="chat-header-row">
            {target.type === 'direct' && (
              <button
                className="back-btn"
                title="Back to the roundtable"
                onClick={() => setTarget({ type: 'group' })}
              >
                ← Roundtable
              </button>
            )}
            <span className="chat-title">{targetName}</span>
            <div className="mode-toggle">
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
              <label className="rounds" title="How many times each seat speaks before the table stops.">
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
          </div>
          <div className="mode-hint">
            {mode === 'discuss'
              ? 'Discuss · understand and debate first — no files are written.'
              : 'Build · implementation welcome — write-enabled seats can change files.'}
          </div>
        </header>

        <div className="messages" ref={scrollRef}>
          {transcript.length === 0 && target.type === 'direct' && (
            <p className="empty">Start a one-on-one conversation.</p>
          )}
          {transcript.length === 0 && target.type === 'group' && (
            <div className="launchpad">
              {seated.length === 0 ? (
                <p className="empty">Seat at least one AI to start a roundtable.</p>
              ) : (
                <>
                  <div className="lp-label">Who's at the table</div>
                  <div className="lp-seats">
                    {seatedOrdered.map((a, i) => (
                      <span key={a.id} className="lp-seat">
                        {i > 0 && <span className="lp-arrow">→</span>}
                        <span className="lp-pill" style={{ background: a.color || 'var(--muted)' }}>
                          {a.name}
                          {a.role && a.role !== 'contributor' ? ` · ${a.role}` : ''}
                        </span>
                      </span>
                    ))}
                  </div>

                  {countSubtractors(seated) === 0 && (
                    <div className="lp-warn">
                      ⚠️ No subtractor seated — the table may drift toward agreement.
                      Set a seat's role to “Subtractor” to keep it grounded.
                    </div>
                  )}

                  <div className="lp-label">Try starting with</div>
                  <div className="lp-prompts">
                    {STARTERS.map((s) => (
                      <button key={s} className="lp-prompt" onClick={() => send(null, s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
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
                {m.images?.length > 0 && (
                  <div className="bubble-images">
                    {m.images.map((src, j) => (
                      <img key={j} className="chat-img" src={src} alt="attached" />
                    ))}
                  </div>
                )}
                <div className="text">{m.text}</div>
              </div>
            );
          })}
          {busy && <div className="bubble assistant pending">…thinking</div>}
        </div>

        <form className="composer" onSubmit={send}>
          {pendingImages.length > 0 && (
            <div className="composer-thumbs">
              {pendingImages.map((img, i) => (
                <div key={i} className="composer-thumb">
                  <img src={img.dataUrl} alt={img.name} title={img.name} />
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-row">
            <button
              type="button"
              className="attach-btn"
              title="Attach image(s) — or paste / drag them in"
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              ref={fileInputRef}
              onChange={(e) => {
                addImages(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = [...(e.clipboardData?.items || [])]
                  .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                  .map((it) => it.getAsFile())
                  .filter(Boolean);
                if (files.length) {
                  e.preventDefault();
                  addImages(files);
                }
              }}
              placeholder={
                target.type === 'group'
                  ? 'Pose a topic to the roundtable…'
                  : `Message ${targetName}…`
              }
            />
            <button type="submit" disabled={busy || (!input.trim() && pendingImages.length === 0)}>
              Send
            </button>
          </div>
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

      {flowAgentId && (
        <PromptFlowCanvas
          agent={agents.find((x) => x.id === flowAgentId)}
          agents={seated}
          mode={mode}
          onPickAgent={setFlowAgentId}
          onClose={() => setFlowAgentId(null)}
        />
      )}
    </div>
  );
}
