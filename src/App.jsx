import { useState, useRef, useEffect, useCallback } from 'react';
import AgentForm, { ROLE_HELP } from './AgentForm.jsx';
import Markdown from './Markdown.jsx';
import TaskBoard from './TaskBoard.jsx';
import WriteApproval from './WriteApproval.jsx';
import ScriptsPanel from './ScriptsPanel.jsx';
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
  parseTasks,
  orderSeats,
} from './orchestrator.js';

const api = window.api;

// Clickable starter prompts shown on the empty roundtable.
const STARTERS = [
  'Propose a simple architecture for this project',
  'What are the three biggest unknowns to resolve first?',
  'Review the current folder structure and flag any risks',
];

// Pull fenced ``` code blocks out of the AIs' messages for the scripts panel.
// Deduped by code body (re-rendered turns repeat the same block), newest first.
function extractScripts(transcript) {
  const re = /```([\w.+-]*)\r?\n([\s\S]*?)```/g;
  const seen = new Map();
  for (const m of transcript || []) {
    if (!m?.text || m.speaker === 'You' || m.speaker === 'Tool') continue;
    let match;
    while ((match = re.exec(m.text)) !== null) {
      const code = match[2].replace(/\s+$/, '');
      if (!code.trim()) continue;
      seen.set(code, { kind: 'block', lang: (match[1] || '').trim(), code, source: m.speaker });
    }
  }
  return [...seen.values()].reverse();
}

export default function App() {
  const [agents, setAgents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState({ type: 'group' });
  const [transcripts, setTranscripts] = useState({ group: [] });
  const [input, setInput] = useState('');
  const [rounds, setRounds] = useState(2);
  const [busy, setBusy] = useState(false);
  // Live per-seat status shown in the pending bubble:
  // { label, color, round?, rounds? } or null (generic "thinking…").
  const [liveStatus, setLiveStatus] = useState(null);
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
  // Scripts panel: split side-panel collecting code blocks + written files.
  const [showScripts, setShowScripts] = useState(false);
  const [writtenFiles, setWrittenFiles] = useState([]); // [{ path, agent, ts }]
  // Shared task board: seats manage it with TASK: add/done lines, the user
  // manages it in the panel. Per-chat — cleared on New Chat.
  const [showTasks, setShowTasks] = useState(false);
  const [tasks, setTasks] = useState([]); // [{ id, text, done, by, doneBy? }]
  const nextTaskIdRef = useRef(1);
  // Ref mirror of `tasks`: the async round loop snapshots state in its
  // closure, so mid-round panel clicks would be invisible without this.
  const tasksRef = useRef([]);
  // Write approval: a pending CHECK: write_file awaiting the user's decision.
  const [pendingWrite, setPendingWrite] = useState(null); // { path, agentName, color, oldText, content }
  const writeResolveRef = useRef(null); // resolver for the awaited decision
  const [autoApprove, setAutoApprove] = useState(false); // per-chat "approve all"
  const autoApproveRef = useRef(false);
  // Last provider-ATTESTED model per agent id (from the API response body).
  // This is the verifiable answer to "what model actually ran?" — unlike the
  // model's own in-band claims. null/absent for CLI seats (not attestable).
  const [servedModels, setServedModels] = useState({});
  // Images queued in the composer, sent with the next message.
  const [pendingImages, setPendingImages] = useState([]); // [{ dataUrl, name }]
  // Text/code files queued in the composer (read so the AIs can see them).
  const [pendingFiles, setPendingFiles] = useState([]); // [{ name, text, truncated }]
  const [attachNote, setAttachNote] = useState(''); // transient skip/info message
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
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

  // Single write path for the board: keeps state (renders) and the ref (async
  // loop reads) in lockstep. Updater side effect is idempotent, so React
  // StrictMode's double-invoke is harmless.
  function updateTasks(updater) {
    setTasks((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      tasksRef.current = next;
      return next;
    });
  }

  // Compact, authoritative board line injected into every seat's context —
  // this is how the AIs see YOUR panel clicks, not just transcript TASK lines.
  function boardSnapshot() {
    const ts = tasksRef.current;
    if (!ts.length) return null;
    const items = ts
      .slice(0, 30)
      .map((t) => `#${t.id} ${t.text} (${t.done ? 'done' : 'open'})`)
      .join(' · ');
    return `[Task board — current state, including the user's own changes; keep it updated with TASK lines: ${items}]`;
  }

  // Apply any TASK: add/done lines from a transcript entry to the board.
  // Called for user + assistant entries (not Tool/System) as they're appended.
  function recordTasks(text, speaker) {
    const ops = parseTasks(text);
    if (ops.length === 0) return;
    updateTasks((prev) => {
      const next = [...prev];
      for (const t of ops) {
        if (t.op === 'add') {
          const dup = next.some((x) => !x.done && x.text.toLowerCase() === t.arg.toLowerCase());
          if (!dup) next.push({ id: nextTaskIdRef.current++, text: t.arg, done: false, by: speaker });
        } else {
          // done: match "#3"/"3" by id first, then by (prefix-tolerant) text.
          const idMatch = t.arg.match(/^#?(\d+)$/);
          let idx = -1;
          if (idMatch) idx = next.findIndex((x) => x.id === Number(idMatch[1]) && !x.done);
          if (idx < 0) {
            const q = t.arg.replace(/^#/, '').toLowerCase();
            idx = next.findIndex(
              (x) =>
                !x.done &&
                (x.text.toLowerCase() === q ||
                  x.text.toLowerCase().startsWith(q) ||
                  q.startsWith(x.text.toLowerCase())),
            );
          }
          if (idx >= 0) next[idx] = { ...next[idx], done: true, doneBy: speaker };
        }
      }
      return next;
    });
  }

  // Sync helper: the async orchestration loop reads the ref (state would be a
  // stale closure), the header indicator renders from the state.
  function setAutoApproveBoth(v) {
    autoApproveRef.current = v;
    setAutoApprove(v);
  }

  // All CHECK execution funnels through here. write_file by a write-enabled
  // seat pauses the loop and waits for the user's Approve/Reject (unless
  // "approve all" is on for this chat). Rejection returns a normal failed
  // check result so the seat sees why and can adjust.
  async function runGatedCheck(req, ag) {
    if (req?.op === 'write_file' && ag?.canWrite === true && !autoApproveRef.current) {
      // Current content for the diff — null means "new file". (read_file
      // truncates >64KB, so huge files diff against a truncated old view.)
      let oldText = null;
      try {
        const r0 = await api.runCheck({ op: 'read_file', arg: req.arg }, activeProject?.path ?? null, ag?.id);
        if (r0?.ok) oldText = r0.output;
      } catch { /* treat as new file */ }
      setLiveStatus({
        label: `Waiting for you to approve ${ag?.name ?? 'a seat'}'s write to ${req.arg}…`,
        color: ag?.color,
      });
      const decision = await new Promise((resolve) => {
        writeResolveRef.current = resolve;
        setPendingWrite({
          path: req.arg,
          agentName: ag?.name,
          color: ag?.color,
          oldText,
          content: req.content ?? '',
        });
      });
      writeResolveRef.current = null;
      setPendingWrite(null);
      if (decision === 'always') setAutoApproveBoth(true);
      else if (decision !== 'approve') {
        return {
          ok: false,
          output:
            'Write not approved — the user rejected this write. Do not retry the same write; ask what should change or move on.',
        };
      }
    }
    const r = await api.runCheck(req, activeProject?.path ?? null, ag?.id);
    if (req?.op === 'write_file' && r?.ok) recordWrite(req.arg, ag?.name);
    return r;
  }

  // Remember a file an agent just wrote so the scripts panel can list it
  // (newest first, de-duped by path).
  function recordWrite(filePath, agentName) {
    if (!filePath) return;
    setWrittenFiles((prev) => [
      { path: filePath, agent: agentName, ts: Date.now() },
      ...prev.filter((f) => f.path !== filePath),
    ]);
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
    writeResolveRef.current?.('reject'); // dismiss a pending write approval
    setBusy(false);
    setLiveStatus(null);
    updateTasks([]);
    nextTaskIdRef.current = 1;
    setAutoApproveBoth(false);
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
        title={
          servedModels[a.id]
            ? `Verified: last reply served by "${servedModels[a.id]}" (attested by the provider's API response, not the model's own claim)`
            : a.provider === 'cli'
              ? 'CLI seat — the served model cannot be verified from here'
              : undefined
        }
        onClick={() => {
          setTarget({ type: 'direct', agentId: a.id });
          setTranscripts((t) => ({ ...t, [a.id]: t[a.id] ?? [] }));
        }}
      >
        <span className="name" style={{ background: a.color || 'var(--muted)' }}>{a.name}</span>
        {a.role && a.role !== 'contributor' && (
          <span className="role-badge" title={ROLE_HELP[a.role] ?? a.role}>{a.role}</span>
        )}
        {servedMismatch(a) && (
          <span
            className="served-warn"
            title={`⚠ Model mismatch: configured "${a.model}" but the provider says it served "${servedModels[a.id]}"`}
          >
            ⚠
          </span>
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

  function flashNote(msg) {
    setAttachNote(msg);
    setTimeout(() => setAttachNote(''), 3000);
  }

  // Which dropped files we can read as text. Binary formats (pdf, docx, …)
  // can't be read here, so they're skipped with a note.
  const TEXT_EXT =
    /\.(txt|md|markdown|js|jsx|ts|tsx|json|ya?ml|css|html?|xml|csv|tsv|py|rb|go|rs|java|kt|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|sql|toml|ini|cfg|conf|env|log|vue|svelte|astro|r|lua|pl|dart|swift|gradle|properties|gitignore|dockerfile|makefile)$/i;
  function looksTextual(f) {
    if (f.type?.startsWith('text/')) return true;
    if (/(json|xml|javascript|yaml|csv|markdown|x-sh|x-python)/.test(f.type || '')) return true;
    return TEXT_EXT.test(f.name || '');
  }

  async function addFiles(files) {
    const MAX = 100 * 1024; // 100KB cap keeps prompts manageable
    const skipped = [];
    for (const f of [...files]) {
      if (!f || f.type?.startsWith('image/')) continue; // images go through addImages
      if (!looksTextual(f)) {
        skipped.push(f.name || 'file');
        continue;
      }
      try {
        let text = await f.text();
        let truncated = false;
        if (text.length > MAX) {
          text = text.slice(0, MAX);
          truncated = true;
        }
        setPendingFiles((p) => [...p, { name: f.name || 'file', text, truncated }]);
      } catch {
        skipped.push(f.name || 'file');
      }
    }
    if (skipped.length) {
      flashNote(`Can't read ${skipped.join(', ')} — only text/code files (not PDFs or binaries).`);
    }
  }

  // Route a drop: images keep their vision path, everything else is read as text.
  function addDropped(fileList) {
    const arr = [...(fileList || [])];
    const imgs = arr.filter((f) => f.type?.startsWith('image/'));
    const rest = arr.filter((f) => !f.type?.startsWith('image/'));
    if (imgs.length) addImages(imgs);
    if (rest.length) addFiles(rest);
  }

  // agent:call now returns { text, servedModel } (or the '__ABORTED__' string,
  // or an error-string from a .catch). Normalize to the raw string the
  // orchestrator expects, recording the attested model as a side effect.
  function unwrapCall(res, agent) {
    if (res && typeof res === 'object') {
      if (res.servedModel && agent?.id) {
        setServedModels((p) => (p[agent.id] === res.servedModel ? p : { ...p, [agent.id]: res.servedModel }));
      }
      return res.text;
    }
    return res; // '__ABORTED__' sentinel or error string
  }

  // Does the attested model plausibly match what's configured? Providers often
  // return dated/normalized ids (gpt-5.4-mini -> gpt-5.4-mini-2026-01-15), so
  // containment either way counts as a match.
  function servedMismatch(agent) {
    const served = servedModels[agent.id];
    if (!served || !agent.model) return false;
    const a = served.toLowerCase();
    const b = agent.model.toLowerCase();
    return !(a.includes(b) || b.includes(a));
  }

  // Turn an orchestrator status event into the label the pending bubble shows.
  const CHECK_VERBS = {
    read_file: 'reading',
    list_dir: 'listing',
    exists: 'checking for',
    write_file: 'writing',
  };
  function fmtStatus(s, round, rounds) {
    if (!s?.agent) return null;
    let label;
    if (s.phase === 'check') label = `${s.agent.name} is ${CHECK_VERBS[s.op] || s.op} ${s.arg}…`;
    else if (s.followUp) label = `${s.agent.name} is reading the results…`;
    else label = `${s.agent.name} is thinking…`;
    return { label, color: s.agent.color, round, rounds };
  }

  // One seat replies in a single-seat context (direct chat or named @seat),
  // resolving any CHECK requests and giving one follow-up turn with the results.
  async function runSeatTurn(agent, key, startWorking, callId, safeAppend) {
    let working = startWorking;
    const ask = async (followUp = false) => {
      setLiveStatus(fmtStatus({ phase: 'thinking', agent, followUp }));
      const res = await api
        .callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working, boardSnapshot()), callId, activeProject?.path ?? null)
        .catch((err) => `⚠️ ${agent.name} error: ${err.message}`);
      const raw = unwrapCall(res, agent);
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
        setLiveStatus(fmtStatus({ phase: 'check', agent, op: c.op, arg: c.arg }));
        let result;
        try {
          // Gated: write_file pauses here for user approval (diff modal).
          result = await runGatedCheck({ op: c.op, arg: c.arg, content: c.content }, agent);
        } catch (err) {
          result = { ok: false, output: String(err?.message || err) };
        }
        const label = result.ok ? `Check (${c.op} ${c.arg})` : `Check failed (${c.op} ${c.arg})`;
        const entry = { speaker: 'Tool', agentId: null, text: `${label}:\n${result.output}` };
        working = [...working, entry];
        safeAppend(key, entry);
      }
      await ask(true); // one follow-up turn with the real results in context
    }
  }

  async function send(e, textOverride) {
    e?.preventDefault();
    const text = (textOverride ?? input).trim();
    if ((!text && pendingImages.length === 0 && pendingFiles.length === 0) || busy) return;
    setInput('');
    const images = pendingImages.map((p) => p.dataUrl);
    setPendingImages([]);
    const attachments = pendingFiles.map((f) => ({ name: f.name, text: f.text, truncated: f.truncated }));
    setPendingFiles([]);

    const key = targetKey;
    // Snapshot the session token. If it changes (New Chat) while we're running,
    // we know this send is stale and must not touch the transcript.
    const mySession = sessionRef.current;
    const safeAppend = (k, entry) => {
      if (sessionRef.current !== mySession) return;
      appendTo(k, entry);
      // TASK: lines from you or a seat update the shared board.
      if (entry.speaker !== 'Tool' && entry.speaker !== 'System') {
        recordTasks(entry.text, entry.speaker);
      }
    };

    // Unique id for this send so stop() / New Chat can abort the live IPC call.
    const myCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    callIdBase.current = myCallId;

    const userEntry = {
      speaker: 'You',
      agentId: null,
      text,
      ...(images.length ? { images } : {}),
      ...(attachments.length ? { attachments } : {}),
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
              callAgent: async (ag, msgs) => {
                const res = await api.callAgent(ag, msgs, myCallId, activeProject?.path ?? null);
                return unwrapCall(res, ag);
              },
              onReply: (entry) => {
                safeAppend(key, entry);
              },
              shouldStop: () => stopRef.current || sessionRef.current !== mySession,
              failures,
              muted,
              // Gated: write_file pauses for user approval (diff modal).
              runCheck: runGatedCheck,
              mode,
              onStatus: (s) => setLiveStatus(fmtStatus(s, r + 1, rounds)),
              taskBoard: boardSnapshot,
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
      if (sessionRef.current === mySession) {
        setBusy(false);
        setLiveStatus(null);
      }
    }
  }

  function stop() {
    stopRef.current = true;
    if (callIdBase.current) api.abortCall(callIdBase.current);
    writeResolveRef.current?.('reject'); // a pending approval blocks the loop
  }

  if (!loaded) return <div className="loading">Loading…</div>;

  const targetName =
    target.type === 'group'
      ? `Roundtable (${seated.length} AI${seated.length === 1 ? '' : 's'})`
      : agents.find((a) => a.id === target.agentId)?.name ?? 'Unknown';

  // Scripts for the side panel: code blocks from the current conversation +
  // files written this session.
  const scripts = extractScripts(transcript);
  const scriptCount = scripts.length + writtenFiles.length;

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
            <button className="foot-btn new-chat" onClick={() => setStarting(true)}>
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
          if (e.dataTransfer?.files?.length) addDropped(e.dataTransfer.files);
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
            <button
              className={`scripts-toggle ${showTasks ? 'active' : ''}`}
              title="Shared task board — seats manage it with TASK: add / TASK: done lines"
              onClick={() => setShowTasks((v) => !v)}
            >
              ☑ Tasks{tasks.filter((t) => !t.done).length ? ` (${tasks.filter((t) => !t.done).length})` : ''}
            </button>
            <button
              className={`scripts-toggle ${showScripts ? 'active' : ''}`}
              title="Show scripts the AIs produced — copy, download, or save them"
              onClick={() => setShowScripts((v) => !v)}
            >
              {'</>'} Scripts{scriptCount ? ` (${scriptCount})` : ''}
            </button>
            {busy && <button className="stop" onClick={stop}>■ Stop</button>}
          </div>
          <div className="mode-hint">
            {mode === 'discuss'
              ? 'Discuss · understand and debate first — no files are written.'
              : 'Build · implementation welcome — write-enabled seats can change files.'}
            {autoApprove && (
              <button
                className="auto-approve-note"
                title="Every write in this chat is being approved automatically — click to turn approval prompts back on"
                onClick={() => setAutoApproveBoth(false)}
              >
                ✓ auto-approving writes — click to turn off
              </button>
            )}
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
                {m.attachments?.length > 0 && (
                  <div className="bubble-files">
                    {m.attachments.map((f, j) => (
                      <span key={j} className="bubble-file" title={f.name}>
                        📄 {f.name}{f.truncated ? ' (truncated)' : ''}
                      </span>
                    ))}
                  </div>
                )}
                {kind === 'assistant' ? (
                  <div className="text md">
                    <Markdown text={m.text} />
                  </div>
                ) : (
                  <div className="text">{m.text}</div>
                )}
              </div>
            );
          })}
          {busy && (
            <div className="bubble assistant pending live-status">
              <span
                className="status-dot"
                style={liveStatus?.color ? { background: liveStatus.color } : undefined}
              />
              <span>
                {liveStatus?.label ?? 'thinking…'}
                {liveStatus?.round != null && liveStatus?.rounds > 1 && (
                  <span className="status-round">
                    {' '}· Round {liveStatus.round}/{liveStatus.rounds}
                  </span>
                )}
              </span>
            </div>
          )}
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
          {pendingFiles.length > 0 && (
            <div className="composer-files">
              {pendingFiles.map((f, i) => (
                <div key={i} className="composer-file" title={f.name}>
                  <span className="file-ico">📄</span>
                  <span className="file-name">{f.name}{f.truncated ? ' (truncated)' : ''}</span>
                  <button
                    type="button"
                    aria-label="Remove file"
                    onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachNote && <div className="attach-note">{attachNote}</div>}
          <div className="composer-row">
            <button
              type="button"
              className="attach-btn"
              title="Attach an image or a text/code file — or paste / drag it in"
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
            <input
              type="file"
              multiple
              hidden
              ref={fileInputRef}
              onChange={(e) => {
                addDropped(e.target.files);
                e.target.value = '';
              }}
            />
            <textarea
              rows={1}
              ref={composerRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-grow up to the CSS max-height, then scroll.
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(null);
                  // Collapse back to one row (send cleared the value).
                  if (composerRef.current) composerRef.current.style.height = 'auto';
                }
              }}
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
                  ? 'Pose a topic to the roundtable…  (Shift+Enter = new line)'
                  : `Message ${targetName}…  (Shift+Enter = new line)`
              }
            />
            <button
              type="submit"
              disabled={busy || (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0)}
            >
              Send
            </button>
          </div>
        </form>
      </main>

      {showTasks && (
        <TaskBoard
          tasks={tasks}
          onToggle={(id) => updateTasks((p) => p.map((t) => (t.id === id ? { ...t, done: !t.done, doneBy: !t.done ? 'You' : t.doneBy } : t)))}
          onAdd={(text) => updateTasks((p) => [...p, { id: nextTaskIdRef.current++, text, done: false, by: 'You' }])}
          onRemove={(id) => updateTasks((p) => p.filter((t) => t.id !== id))}
          onClearDone={() => updateTasks((p) => p.filter((t) => !t.done))}
          onClose={() => setShowTasks(false)}
        />
      )}

      {showScripts && (
        <ScriptsPanel
          scripts={scripts}
          files={writtenFiles}
          projectPath={activeProject?.path ?? null}
          onClose={() => setShowScripts(false)}
        />
      )}

      {pendingWrite && (
        <WriteApproval
          approval={pendingWrite}
          onDecide={(d) => writeResolveRef.current?.(d)}
        />
      )}

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
