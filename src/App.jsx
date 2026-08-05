import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import AgentForm, { ROLE_HELP, PASTELS } from './AgentForm.jsx';
import Markdown from './Markdown.jsx';
import TaskBoard from './TaskBoard.jsx';
import WriteApproval from './WriteApproval.jsx';
import ActionApproval from './ActionApproval.jsx';
import LoopSignoff from './LoopSignoff.jsx';
import McpSettings from './McpSettings.jsx';
import MemoryPanel from './MemoryPanel.jsx';
import SessionSearch from './SessionSearch.jsx';
import { mcpToolBlock } from './promptText.js';
import ScriptsPanel from './ScriptsPanel.jsx';
import ChatStarter from './ChatStarter.jsx';
import ProjectForm from './ProjectForm.jsx';
import PromptFlowCanvas from './PromptFlowCanvas.jsx';
import FileTree from './FileTree.jsx';
import EditorPanel from './EditorPanel.jsx';
import ReviewPanel from './ReviewPanel.jsx';
import GitPanel from './GitPanel.jsx';
import WebPanel from './WebPanel.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import {
  runRound,
  runMission,
  runLoop,
  pickLoopSeats,
  buildMessagesFor,
  buildPromptStages,
  splitThinking,
  withRolePrompt,
  countSubtractors,
  roundMadeProgress,
  addressedAgent,
  parseChecks,
  parseTasks,
  parseMemos,
  orderSeats,
} from './orchestrator.js';
import { memoryBlock } from './promptText.js';

const api = window.api;

// Clickable starter prompts shown on the empty roundtable.
const STARTERS = [
  'Propose a simple architecture for this project',
  'What are the three biggest unknowns to resolve first?',
  'Review the current folder structure and flag any risks',
];

// Path-ish tokens (a name with an extension, optionally with folders) that a
// seat mentions right around a fence — "here's the new src/App.jsx:". The
// scripts panel intersects these with the REAL project tree to offer "Diff
// against <path>"; nothing matching means the card behaves exactly as before.
const PATH_TOKEN_RE = /[\w.@-]+(?:[\\/][\w.@-]+)*\.[A-Za-z]\w{0,8}/g;
function pathHints(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PATH_TOKEN_RE)) {
    const t = m[0].replace(/\\/g, '/').replace(/^\.\//, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Pull fenced ``` code blocks out of the AIs' messages for the scripts panel.
// Deduped by code body (re-rendered turns repeat the same block), newest first.
// ts is the transcript entry's own stamp — a clock string from
// toLocaleTimeString(), not an epoch; the panel renders it as-is.
function extractScripts(transcript) {
  const re = /```([\w.+-]*)\r?\n([\s\S]*?)```/g;
  const seen = new Map();
  for (const m of transcript || []) {
    if (!m?.text || m.speaker === 'You' || m.speaker === 'Tool') continue;
    let match;
    while ((match = re.exec(m.text)) !== null) {
      const code = match[2].replace(/\s+$/, '');
      if (!code.trim()) continue;
      // ~2 lines either side of the fence — where a seat names the file it
      // means the block to replace.
      const before = m.text.slice(0, match.index).split('\n').slice(-3).join('\n');
      const after = m.text.slice(re.lastIndex).split('\n').slice(0, 3).join('\n');
      seen.set(code, {
        kind: 'block',
        lang: (match[1] || '').trim(),
        code,
        source: m.speaker,
        ts: m.ts,
        hints: pathHints(`${before}\n${after}`),
      });
    }
  }
  return [...seen.values()].reverse();
}

// --- Context size estimates (Phase A) ---------------------------------------
// Character counts over a BUILT message array (what buildMessagesFor returns).
// Non-string content (image payloads, provider-shaped parts) is measured via
// its JSON form so nothing silently reads as 0. Tokens are a deliberate rough
// ratio — always rendered with "≈", never presented as a provider count.
const CHARS_PER_TOKEN = 4;
// Below this the number is noise, not information — the composer stays clean.
const CTX_ESTIMATE_MIN = 4000;
// Payload size (chars of built messages) at/above which the relevance gate
// runs before a send. Below it, behavior is exactly what it has always been:
// full history, no extra call. A judgment call, tuned by hand — raise it if
// the pre-pass ever costs more than the history it saves.
const CTX_GATE_THRESHOLD = 20000;
function msgChars(mm) {
  const c = mm?.content;
  if (typeof c === 'string') return c.length;
  if (c === undefined || c === null) return 0;
  try {
    return JSON.stringify(c).length;
  } catch {
    return 0;
  }
}
function totalChars(msgs) {
  return (msgs || []).reduce((n, mm) => n + msgChars(mm), 0);
}
function approxTokens(chars) {
  return Math.round(chars / CHARS_PER_TOKEN);
}
function compactNum(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}
// First line of a transcript entry's text — the same head-line convention
// ToolBubble uses for its collapsed header, reused by the context placeholder
// and the relevance gate's digest so all three describe an entry identically.
function headLine(text) {
  const t = String(text ?? '');
  const nl = t.indexOf('\n');
  return nl > -1 ? t.slice(0, nl) : t;
}

// Tool results (CHECK output — dir listings, web pages, search results) can be
// thousands of chars. Collapse to the one-line header ("Check (web_search …):")
// by default; tiny results stay inline. memo — entries are immutable.
// index/pruned/onTogglePrune (Phase B) are the context-exclusion toggle; the
// callback is stable (useCallback in App) and takes the absolute transcript
// index, so memoization still holds.
const ToolBubble = memo(function ToolBubble({ text, index, pruned, onTogglePrune }) {
  const t = String(text ?? '');
  const nl = t.indexOf('\n');
  const head = nl > -1 ? t.slice(0, nl) : t;
  const body = nl > -1 ? t.slice(nl + 1) : '';
  const [open, setOpen] = useState(body.length <= 160);
  const failed = /^Check failed/i.test(head);
  const pruneBtn = onTogglePrune ? (
    <button
      className="tool-toggle tool-prune"
      title={
        pruned
          ? 'Replay this result in full to every seat again on future turns'
          : 'Stop replaying this result to every seat on future turns. It stays visible here, and a seat can always re-run the check.'
      }
      onClick={() => onTogglePrune(index)}
    >
      {pruned ? '↺ include in context' : '⊘ exclude from context'}
    </button>
  ) : null;
  if (!body) {
    return (
      <div className={`text tool-text ${pruned ? 'pruned' : ''}`}>
        {t}
        {pruned && <span className="tool-pruned-tag">excluded from context</span>}
        {pruneBtn}
      </div>
    );
  }
  return (
    <div className={`text tool-text ${failed ? 'failed' : ''} ${pruned ? 'pruned' : ''}`}>
      <button
        className="tool-toggle"
        title={open ? 'Collapse result' : 'Expand result'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-chevron">{open ? '▾' : '▸'}</span> {head}
        {!open && <span className="tool-size"> {body.length.toLocaleString()} chars</span>}
        {pruned && <span className="tool-pruned-tag">excluded from context</span>}
      </button>
      {open && <pre className="tool-body">{body}</pre>}
      {open && body.length > 160 && (
        <button className="tool-toggle tool-collapse" onClick={() => setOpen(false)}>
          <span className="tool-chevron">▴</span> collapse
        </button>
      )}
      {pruneBtn}
    </div>
  );
});

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
  // Streaming preview: raw text of the in-flight call, accumulated from
  // agent:delta events. DISPLAY-ONLY — never parsed (no thinking-split, no
  // CHECK/TASK). Reset before each provider call; discarded when the call's
  // invoke resolves and the final parsed entry replaces it.
  const [streamText, setStreamText] = useState('');
  const [editing, setEditing] = useState(null);
  const [starting, setStarting] = useState(false);
  // Roster of agent ids in the current roundtable. null = not yet chosen (use all).
  const [roster, setRoster] = useState(null);
  const [mode, setMode] = useState('discuss'); // 'discuss' | 'build' | 'mission' | 'loop'
  // Loop mode: iteration budget (per run; a send-back grants a fresh budget).
  // loopInf = ∞ for local-model grinds — every pass still pauses for sign-off.
  const [loopBudget, setLoopBudget] = useState(3);
  const [loopInf, setLoopInf] = useState(false);
  // Loop sign-off pending decision — same promise-pause pattern as pendingWrite.
  const [pendingSignoff, setPendingSignoff] = useState(null); // { kind, iteration, verdict }
  const loopResolveRef = useRef(null);
  // Mission mode: temp specialist seats spawned by the planner this session.
  // Ref mirror because the async mission loop registers seats mid-run.
  const [missionSeats, setMissionSeats] = useState([]);
  const missionSeatsRef = useRef([]);
  // Projects
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [editingProject, setEditingProject] = useState(null); // null | 'new' | project object
  // Prompt Flow Canvas — agent id whose prompt pipeline is open (null = closed).
  const [flowAgentId, setFlowAgentId] = useState(null);
  // Scripts panel: split side-panel collecting code blocks + written files.
  const [showScripts, setShowScripts] = useState(false);
  const [showFiles, setShowFiles] = useState(false); // project file tree (Phase 4)
  const [showEditor, setShowEditor] = useState(false); // Monaco editor panel (mini-IDE)
  const [showReview, setShowReview] = useState(false); // session change review (Phase 5)
  const [showGit, setShowGit] = useState(false); // local git working-copy view (read-only)
  const [showWeb, setShowWeb] = useState(false); // web context preview (what seats pulled from the web)
  const [showPreview, setShowPreview] = useState(false); // render the project's HTML app in-app
  const [gitSummary, setGitSummary] = useState(null); // { branch, changed, files } for the rail badge
  // Phase 7: ROUNDTABLE.md content for the active project ('' = none).
  const [projInstructions, setProjInstructions] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);
  const [writtenFiles, setWrittenFiles] = useState([]); // [{ path, agent, ts }]
  // Phase 5: content of each file BEFORE this session's first write to it.
  // null value = the file did not exist (created this session). Ref mirror
  // because the async round loop captures state in its closure.
  const [baselines, setBaselines] = useState({});
  const baselinesRef = useRef({});
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
  // MCP integrations (GitHub, Drive, Gmail, …): configs + live connection
  // status from main. Ref mirror for the async loops: the assembled prompt
  // block plus a 'slug.tool' → { readOnly, destructive } index for gating.
  const [mcpInfo, setMcpInfo] = useState({ servers: [], status: [] });
  const [showMcp, setShowMcp] = useState(false);
  const mcpRef = useRef({ block: null, tools: new Map() });
  // Integration calls made this chat (newest first) — feeds the rail's Calls
  // card so MCP activity is visible without opening anything.
  const [mcpCalls, setMcpCalls] = useState([]); // [{ target, ok, ts }]
  // Right rail: always-visible Tasks/Changes/Files/Scripts/Calls summaries.
  // Collapsed state survives restarts (renderer localStorage is fine here).
  // Per-section accordion state for the rail. Persisted so the layout the
  // user set up survives restarts. Sections without preview bodies (Files,
  // Scripts) don't collapse — there's nothing to hide.
  const RAIL_SEC_DEFAULT = { tasks: true, changes: true, git: true, calls: true, web: true };
  const [railSecOpen, setRailSecOpen] = useState(() => {
    try {
      return { ...RAIL_SEC_DEFAULT, ...JSON.parse(localStorage.getItem('railSecOpen') || '{}') };
    } catch {
      return RAIL_SEC_DEFAULT;
    }
  });
  const toggleRailSec = (k) => (e) => {
    // The chevron lives inside the card button — don't also toggle the panel.
    e.stopPropagation();
    setRailSecOpen((p) => {
      const next = { ...p, [k]: !p[k] };
      try { localStorage.setItem('railSecOpen', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const railChev = (k) => (
    <span
      className="rail-chev"
      role="button"
      title={railSecOpen[k] ? 'Collapse preview' : 'Expand preview'}
      onClick={toggleRailSec(k)}
    >
      {railSecOpen[k] ? '▾' : '▸'}
    </span>
  );
  const [railOpen, setRailOpen] = useState(() => {
    try { return localStorage.getItem('railOpen') !== '0'; } catch { return true; }
  });
  function toggleRail() {
    setRailOpen((v) => {
      try { localStorage.setItem('railOpen', v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  }
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
  // ---- Persistent sessions (Phase 2) ---------------------------------------
  const [sessions, setSessions] = useState([]); // index entries, newest first
  const [currentSessionId, setCurrentSessionId] = useState(() => crypto.randomUUID());
  const [sessionName, setSessionName] = useState('New session');
  const sessionCreatedRef = useRef(Date.now());
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const saveTimerRef = useRef(null);
  // Ref mirror so the debounced save + send() closures see the live name.
  const sessionNameRef = useRef('New session');
  sessionNameRef.current = sessionName;
  // Phase 8: per-agent slot holding what the in-flight call was sent; attached
  // to the resulting transcript entry the moment it lands (attachCallMeta).
  const callRecordRef = useRef({});
  const usageRef = useRef({}); // Phase 9: provider-reported token usage
  const [inspecting, setInspecting] = useState(null); // Phase 8 modal
  // Phase C: what the last send's relevance gate decided, for the composer
  // hint. { kept, total, excluded: string[] } | null (null = ungated send).
  const [lastCtxGate, setLastCtxGate] = useState(null);
  // Phase 9: Ctrl/Cmd+K quick-switcher.
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switchQuery, setSwitchQuery] = useState('');
  // Perf: long restored sessions used to render every bubble up front, which
  // froze the renderer (and the composer) for seconds. Render only the recent
  // tail until the user asks for the rest. Reset on session switch.
  const RECENT_MSGS = 80;
  const [showFullHistory, setShowFullHistory] = useState(false);

  useEffect(() => {
    Promise.all([api.listAgents(), api.listProjects(), api.listSessions?.() ?? Promise.resolve([])])
      .then(async ([a, p, idx]) => {
        setAgents(a);
        setProjects(p);
        setSessions(Array.isArray(idx) ? idx : []);
        // Restore the most recently updated session, if any (Phase 2).
        const latest = Array.isArray(idx) ? idx[0] : null;
        if (latest) {
          const s = await api.loadSession(latest.id).catch(() => null);
          if (s) restoreSession(s);
        }
        setLoaded(true);
      });
    // MCP servers connect in the background at app start — poll once now and
    // again shortly after, so slow-starting stdio servers still show up.
    api.mcpList?.().then(adoptMcpInfo).catch(() => {});
    const t = setTimeout(() => api.mcpList?.().then(adoptMcpInfo).catch(() => {}), 5000);
    return () => clearTimeout(t);
  }, []);

  // Fold an mcp:list/mcp:save response into state + the async-loop ref:
  // prompt block (what seats are taught) and the tool index (how calls gate).
  function adoptMcpInfo(info) {
    const servers = info?.servers ?? [];
    const status = info?.status ?? [];
    const tools = new Map();
    const lines = [];
    for (const s of status) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        tools.set(`${s.slug}.${t.name}`, t);
        const desc = (t.description || '').slice(0, 110);
        lines.push(`  ${s.slug}.${t.name} [${t.readOnly ? 'read' : 'write'}]${desc ? ` — ${desc}${(t.description || '').length > 110 ? '…' : ''}` : ''}`);
      }
    }
    mcpRef.current = { block: lines.length ? mcpToolBlock(lines.join('\n')) : null, tools };
    setMcpInfo({ servers, status });
  }

  // Prompt extras for one turn: ROUNDTABLE.md instructions + the MCP tool
  // catalog + the cross-session memory pool. Memory always applies (an empty
  // pool still teaches the MEMO syntax so the first fact can be saved), so
  // extras is always defined now.
  function buildExtras(instructions) {
    const mcpTools = mcpRef.current.block;
    const gitTool = !!gitSummary; // active project is a git repo (from the status poll)
    const extras = { memory: memoryBlock(memoriesRef.current) };
    if (instructions) extras.projectInstructions = instructions;
    if (mcpTools) extras.mcpTools = mcpTools;
    if (gitTool) extras.gitTool = true;
    return extras;
  }

  // CLI write approvals: a claude CLI seat asked permission for a file write
  // (routed main → here via the broker). Auto-approve honors the same "Approve
  // all (this chat)" toggle as CHECK writes; otherwise the modal decides.
  // Only ONE request arrives at a time (the CLI blocks awaiting the answer).
  useEffect(() => {
    const off = api.onCliApproval?.((req) => {
      if (autoApproveRef.current) {
        api.answerCliApproval?.(req.id, true);
        return;
      }
      setPendingWrite({
        kind: 'cli',
        id: req.id,
        target: req.toolName,
        args: JSON.stringify(req.input ?? {}),
        description: req.input?.file_path
          ? `File: ${req.input.file_path}`
          : 'Permission request from this seat’s CLI process.',
        agentName: req.agentName,
        color: agents.find((a) => a.name === req.agentName)?.color ?? null,
      });
    });
    return () => off?.();
  }, [agents]);

  function decideCliApproval(decision) {
    const req = pendingWrite;
    if (!req || req.kind !== 'cli') return;
    if (decision === 'always') setAutoApproveBoth(true);
    api.answerCliApproval?.(req.id, decision === 'approve' || decision === 'always');
    setPendingWrite(null);
  }

  // Streaming deltas → preview buffer. Guarded by callIdBase so stragglers
  // after abort/completion (or from a stale send) are dropped.
  useEffect(() => {
    const off = api.onAgentDelta?.(({ callId, text }) => {
      if (callId && callId === callIdBase.current && typeof text === 'string') {
        setStreamText((s) => s + text);
      }
    });
    return () => off?.();
  }, []);

  // Phase 9: global shortcuts. Esc aborts the running round; Ctrl/Cmd+K opens
  // the quick-switcher. The composer's own Enter handling is untouched.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && busy) {
        stop();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowSwitcher((v) => !v);
        setSwitchQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

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

  // Cross-session search (Feature A) + per-seat transcript filter (Feature B).
  const [showSearch, setShowSearch] = useState(false);
  const pendingScrollRef = useRef(null); // { key, index } | null
  const [scrollNonce, setScrollNonce] = useState(0); // bumped per jump so the scroll effect always fires
  const [speakerFilter, setSpeakerFilter] = useState(null); // null = all speakers
  // Send-while-busy: the prompt is queued instead of forcing Stop, and fires
  // automatically when the round ends. One slot — a second queue overwrites it.
  const [queued, setQueued] = useState(null); // { text, images, attachments } | null

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [transcript, busy, streamText]);

  // Jump-to-message: after a search hit switches session/thread and expands the
  // full history, find the target bubble by its absolute index and scroll to it
  // with a brief flash. Depends on everything that can change which bubbles are
  // rendered, plus a nonce so a jump to an already-visible message still fires.
  useEffect(() => {
    const pend = pendingScrollRef.current;
    if (!pend) return;
    if (pend.key !== targetKey) return; // wait until the right thread is shown
    const el = scrollRef.current?.querySelector(`[data-mi="${pend.index}"]`);
    if (!el) return; // not rendered yet (e.g. history still collapsing) — a later dep change retries
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
    pendingScrollRef.current = null;
  }, [transcript, targetKey, showFullHistory, scrollNonce]);

  // Filtering is per-thread — switching seats/group clears the active filter.
  useEffect(() => { setSpeakerFilter(null); }, [targetKey]);

  // Feature B derived views. Attach absolute indices BEFORE filtering so the
  // render loop's `i` stays the true transcript index (delete/edit/regenerate
  // slice the real array by it). Chip choices are the distinct human/agent
  // speakers actually present (Tool/System excluded; 'You' included).
  const speakerChoices = [];
  for (const m of transcript) {
    if (m.speaker === 'Tool' || m.speaker === 'System') continue;
    if (!speakerChoices.includes(m.speaker)) speakerChoices.push(m.speaker);
  }
  const indexedTranscript = transcript.map((m, i) => ({ m, i }));
  const filteredTranscript = speakerFilter
    ? indexedTranscript.filter(({ m }) => m.speaker === speakerFilter || m.speaker === 'You')
    : indexedTranscript;

  // Phase 7: refresh the indicator when the active project changes. The
  // authoritative fetch happens per send — this only keeps the UI current.
  useEffect(() => {
    if (!activeProject?.path) { setProjInstructions(''); return; }
    api.projectInstructions?.(activeProject.path)
      .then((t) => setProjInstructions(t || ''))
      .catch(() => {});
  }, [activeProjectId, loaded]);

  // Cross-session memory: the active project's fact pool ('global' when no
  // project is selected). State renders the panel; the ref is what prompt
  // assembly reads at send time — adoptMemories keeps them in lockstep.
  const memoriesRef = useRef([]);
  const [memories, setMemories] = useState([]);
  const [showMemory, setShowMemory] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const adoptMemories = (m) => {
    const list = Array.isArray(m) ? m : [];
    memoriesRef.current = list;
    setMemories(list);
  };
  useEffect(() => {
    adoptMemories([]);
    api.memoryLoad?.(activeProject?.id || 'global')
      .then(adoptMemories)
      .catch(() => {});
  }, [activeProjectId, loaded]);

  // Git rail badge: light poll of the working-copy status so the card shows
  // "N changed" at rest (roadmap #1). Re-runs when the project changes, when
  // the Git panel closes (you may have just looked/edited), and every 15s.
  // Read-only + cheap; failures collapse to no badge rather than erroring.
  useEffect(() => {
    const p = activeProject?.path;
    if (!p) { setGitSummary(null); return; }
    let alive = true;
    const load = () => api.gitStatus?.(p)
      .then((s) => { if (alive) setGitSummary(s?.ok ? { branch: s.branch, changed: s.files.length, files: s.files } : null); })
      .catch(() => { if (alive) setGitSummary(null); });
    load();
    const id = setInterval(load, 15000);
    return () => { alive = false; clearInterval(id); };
  }, [activeProjectId, showGit, loaded]);

  // Autosave (Phase 2): 2s after any persisted-state change — but never while
  // busy. Turn completion flips `busy` false, which re-runs this effect, so
  // finished turns always save without saving mid-stream.
  useEffect(() => {
    if (!loaded || busy) return undefined;
    const hasContent =
      Object.values(transcripts).some((t) => t?.length) || tasks.length > 0 || writtenFiles.length > 0;
    if (!hasContent) return undefined;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      api.saveSession?.(sessionPayload()).then((r) => {
        if (r?.ok) api.listSessions?.().then((idx) => setSessions(Array.isArray(idx) ? idx : []));
      });
    }, 2000);
    return () => clearTimeout(saveTimerRef.current);
  }, [transcripts, tasks, writtenFiles, mode, activeProjectId, busy, loaded, currentSessionId, sessionName]);

  function appendTo(key, entry) {
    setTranscripts((t) => ({ ...t, [key]: [...(t[key] ?? []), entry] }));
  }

  // ---- Session persistence helpers (Phase 2) --------------------------------
  function restoreSession(s) {
    setCurrentSessionId(s.id);
    setSessionName(s.name || 'New session');
    sessionCreatedRef.current = s.createdAt || Date.now();
    setTranscripts(s.transcripts && typeof s.transcripts === 'object' ? s.transcripts : { group: [] });
    const ts = Array.isArray(s.tasks) ? s.tasks : [];
    updateTasks(ts);
    nextTaskIdRef.current = ts.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
    setWrittenFiles(Array.isArray(s.writtenFiles) ? s.writtenFiles : []);
    // Older sessions saved before Phase 5 have no baselines — default to {}.
    const b = s.baselines && typeof s.baselines === 'object' ? s.baselines : {};
    baselinesRef.current = b;
    setBaselines(b);
    if (s.mode === 'discuss' || s.mode === 'build' || s.mode === 'mission' || s.mode === 'loop') setMode(s.mode);
    const ms = Array.isArray(s.missionSeats) ? s.missionSeats : [];
    missionSeatsRef.current = ms;
    setMissionSeats(ms);
    setShowFullHistory(false); // restored sessions render the recent tail only
    setSpeakerFilter(null);
    setLastCtxGate(null); // the hint described the other session's last send
    setActiveProjectId(s.projectId ?? null);
    setTarget({ type: 'group' });
    setRoster(null);
  }

  function sessionPayload() {
    return {
      id: currentSessionId,
      name: sessionNameRef.current,
      createdAt: sessionCreatedRef.current,
      projectId: activeProjectId,
      mode,
      transcripts: pruneCallRecords(transcripts),
      tasks: tasksRef.current,
      writtenFiles,
      baselines: baselinesRef.current,
      missionSeats: missionSeatsRef.current,
    };
  }

  function newSession() {
    if (busy) return;
    clearTimeout(saveTimerRef.current);
    setCurrentSessionId(crypto.randomUUID());
    setSessionName('New session');
    sessionCreatedRef.current = Date.now();
    setTranscripts({ group: [] });
    updateTasks([]);
    nextTaskIdRef.current = 1;
    setWrittenFiles([]);
    baselinesRef.current = {};
    setBaselines({});
    missionSeatsRef.current = [];
    setMissionSeats([]);
    setAutoApproveBoth(false);
    setSpeakerFilter(null);
    setTarget({ type: 'group' });
  }

  async function switchSession(id) {
    if (busy || id === currentSessionId) return;
    clearTimeout(saveTimerRef.current);
    const s = await api.loadSession(id).catch(() => null);
    if (s) restoreSession(s);
  }

  // Search hit → open that session's thread and scroll to the matching bubble.
  async function jumpToMessage({ sessionId, key, index }) {
    if (busy) return; // switchSession no-ops while busy; keep behavior consistent
    if (sessionId !== currentSessionId) await switchSession(sessionId);
    pendingScrollRef.current = { key, index };
    setSpeakerFilter(null); // an active filter could hide the target bubble entirely
    setShowFullHistory(true); // the hit may be older than the RECENT_MSGS window
    if (key === 'group') setTarget({ type: 'group' });
    else setTarget({ type: 'direct', agentId: key });
    setScrollNonce((n) => n + 1);
  }

  // Two-click delete instead of window.confirm(): Electron's native confirm/
  // alert dialogs break keyboard input in the window afterwards on Windows
  // (typing dead, mouse fine, until refocus) — that was the "can't type in the
  // composer" bug. First click arms the button for 3s, second click deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const confirmTimerRef = useRef(null);

  async function removeSession(id) {
    if (busy) return;
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    clearTimeout(confirmTimerRef.current);
    setConfirmDeleteId(null);
    await api.deleteSession?.(id);
    const idx = (await api.listSessions?.()) ?? [];
    setSessions(Array.isArray(idx) ? idx : []);
    if (id === currentSessionId) newSession();
  }

  async function commitRename(id) {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name) return;
    await api.renameSession?.(id, name);
    if (id === currentSessionId) setSessionName(name);
    const idx = (await api.listSessions?.()) ?? [];
    setSessions(Array.isArray(idx) ? idx : []);
  }

  function relTime(ts) {
    const d = Date.now() - (ts || 0);
    if (d < 60_000) return 'now';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
    return `${Math.floor(d / 86_400_000)}d`;
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
      .map((t) => `#${t.id} ${t.text}${t.assignee ? ` @${t.assignee}` : ''} (${t.done ? 'done' : 'open'})`)
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
          if (!dup)
            next.push({
              id: nextTaskIdRef.current++,
              text: t.arg,
              done: false,
              by: speaker,
              ...(t.assignee ? { assignee: t.assignee } : {}),
            });
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

  // Apply any MEMO: lines from a transcript entry to the project's
  // cross-session memory pool. Fire-and-forget: main dedupes/caps and
  // returns the full post-add pool, which becomes the ref's new truth.
  // Runs for user entries too — you can type a MEMO: line yourself.
  function recordMemos(text, speaker) {
    const facts = parseMemos(text);
    if (facts.length === 0) return;
    const pid = activeProject?.id || 'global';
    api.memoryAdd?.(pid, facts.map((t) => ({ text: t, by: speaker })))
      .then((m) => { if (Array.isArray(m)) adoptMemories(m); })
      .catch(() => {});
  }

  // Forget one fact (panel ✕). Instant — facts are one sentence, and the
  // pool is visible, so no confirm dance (and never window.confirm — see the
  // Electron keyboard-input bug).
  function deleteMemo(id) {
    const next = memoriesRef.current.filter((m) => m.id !== id);
    adoptMemories(next);
    api.memorySave?.(activeProject?.id || 'global', next).catch(() => {});
  }

  // Distillation pass: one seat rewrites the pool — merge overlaps, drop
  // stale/trivial facts, keep decisions. One-shot call outside any round;
  // the model returns plain "- " bullet lines (works on every provider, same
  // reasoning as the MEMO/CHECK line protocols). If the reply yields no
  // bullets, the pool is left untouched — a shy model can't wipe memory.
  const DISTILL_SYS =
    'You maintain a project memory list: short facts saved across sessions. ' +
    'Compact the list the user sends: merge duplicates and overlapping facts, ' +
    'drop stale or trivial ones, keep every decision and durable preference. ' +
    'Rewrite each kept fact as one short standalone sentence. Output ONLY the ' +
    'final list, one fact per line, each line starting with "- ". No headers, ' +
    'no commentary, no code fences.';
  async function distillMemories() {
    const agent = agents[0];
    const pool = memoriesRef.current;
    if (!agent || pool.length < 2 || distilling || busy) return;
    setDistilling(true);
    try {
      const msgs = [{
        role: 'user',
        content: `Compact this memory list:\n${pool.map((m) => `- ${m.text}`).join('\n')}`,
      }];
      const callId = `distill_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const res = await api.callAgent(
        { ...agent, systemPrompt: DISTILL_SYS },
        msgs,
        callId,
        activeProject?.path ?? null,
      );
      const text = unwrapCall(res, agent);
      if (typeof text !== 'string' || text === '__ABORTED__') return;
      const { answer } = splitThinking(text);
      const facts = answer
        .split('\n')
        .map((l) => l.match(/^\s*[-*•]\s+(.+?)\s*$/)?.[1])
        .filter(Boolean);
      if (facts.length === 0) return; // no usable list — keep the pool as-is
      const next = facts.map((t) => ({ text: t, by: agent.name, ts: Date.now() }));
      const pid = activeProject?.id || 'global';
      const ok = await api.memorySave?.(pid, next).catch(() => false);
      if (ok) adoptMemories(await api.memoryLoad?.(pid).catch(() => next) || next);
    } finally {
      setDistilling(false);
    }
  }

  // ---- Phase C: relevance gate over past tool results -----------------------
  // Generalizes the (never-built) MEMO relevance-gate spec from "which saved
  // facts matter" to "which past tool checks matter", using the exact one-shot
  // call shape distillMemories uses above. Returns
  //   { excluded: Set<absolute transcript index>, kept, total }
  // or null meaning "gate unavailable — send the full history, today's
  // behavior". FAIL OPEN is the entire contract: losing a tool result because
  // a small model rambled is strictly worse than the tokens of sending it.
  const CTX_GATE_SYS =
    'You select which past tool-check results are still relevant to a new ' +
    'prompt in an ongoing conversation. Reply with ONE line, nothing else: ' +
    'RELEVANT: followed by the comma-separated numbers of results still ' +
    'relevant (e.g. RELEVANT: 2,5), or RELEVANT: none if none apply. Prefer ' +
    'fewer, truly relevant results — assume anything not listed can be ' +
    're-fetched later if actually needed.';
  async function scoreRelevantTools(promptText, working) {
    // Scope: Tool speakers only (same restriction as the manual toggle and
    // buildMessagesFor) — a conversational turn is never silently dropped.
    // Entries the USER already excluded by hand stay excluded and stay out of
    // the digest: a manual decision isn't the gate's to reverse.
    const digest = [];
    working.forEach((e, i) => {
      if (e?.speaker === 'Tool' && !e.contextPruned) digest.push({ i, entry: e });
    });
    if (digest.length === 0) return null;
    // CLI seats spawn a process per call — multi-second overhead, wrong tool
    // for a latency-sensitive pre-pass (same reasoning as the MEMO gate spec).
    const agent = agents.find((a) => a.provider !== 'cli') || agents[0];
    if (!agent) return null;
    try {
      const lines = digest
        .map(
          (d, n) =>
            `${n + 1}. ${headLine(d.entry.text)} (${String(d.entry.text ?? '').length} chars)`,
        )
        .join('\n');
      const msgs = [
        { role: 'user', content: `Past tool-check results:\n${lines}\n\nPrompt: ${promptText}` },
      ];
      const callId = `ctxgate_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const res = await api.callAgent(
        { ...agent, systemPrompt: CTX_GATE_SYS },
        msgs,
        callId,
        activeProject?.path ?? null,
      );
      const text = unwrapCall(res, agent);
      if (typeof text !== 'string' || text === '__ABORTED__') return null;
      const { answer } = splitThinking(text);
      // Tolerant parse: last RELEVANT: line wins (models like to restate).
      let capture = null;
      for (const l of answer.split('\n')) {
        const m = l.match(/RELEVANT:\s*(.*)/i);
        if (m) capture = m[1];
      }
      if (capture === null) return null; // no verdict → full history
      let keep;
      if (/^\s*none\b/i.test(capture)) {
        keep = new Set(); // a real answer: none of this still matters
      } else {
        const nums = (capture.match(/\d+/g) || [])
          .map(Number)
          .filter((n) => n >= 1 && n <= digest.length);
        if (nums.length === 0) return null; // rambled → full history
        keep = new Set(nums);
      }
      const excluded = new Set(digest.filter((_, n) => !keep.has(n + 1)).map((d) => d.i));
      return { excluded, kept: digest.length - excluded.size, total: digest.length };
    } catch {
      return null; // any error at all → full history
    }
  }

  // Apply a gate result to the working transcript for THIS SEND ONLY: excluded
  // tool entries become copies carrying contextPruned, so buildMessagesFor's
  // placeholder path (Phase B) handles them with no extra orchestrator wiring.
  // The transcript in state is never touched — an automatic decision must not
  // become permanent, since a prompt two turns later may need that same output.
  function applyCtxExclusions(list, excluded) {
    if (!excluded || excluded.size === 0) return list;
    return list.map((e, i) => (excluded.has(i) ? { ...e, contextPruned: true } : e));
  }

  // Mission mode: mark a task done outside a TASK line (force-close/orphans).
  function completeTask(id, byName) {
    updateTasks((prev) =>
      prev.map((t) => (t.id === id && !t.done ? { ...t, done: true, doneBy: byName } : t)),
    );
  }

  // Mission mode: register a spawned specialist seat — assign a free pastel,
  // mirror to the ref for the async loop, and return the registered agent.
  function registerSpawned(agent) {
    const used = [...agents, ...missionSeatsRef.current].map((a) => a.color);
    const color = PASTELS.find((c) => !used.includes(c)) || agent.color;
    const reg = { ...agent, color };
    missionSeatsRef.current = [...missionSeatsRef.current, reg];
    setMissionSeats(missionSeatsRef.current);
    return reg;
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
    // MCP integration calls. Read-classified tools run straight through; every
    // other tool is a WRITE: approval modal here (unless "approve all"), plus
    // main re-checks the stored agent's canWrite — the modal is UX, not the
    // capability boundary. Unknown tools count as writes (conservative).
    if (req?.op === 'mcp') {
      const meta = mcpRef.current.tools.get(req.arg) || null;
      const isWrite = !meta || !meta.readOnly;
      if (isWrite && ag?.canWrite === true && !autoApproveRef.current) {
        setLiveStatus({
          label: `Waiting for you to approve ${ag?.name ?? 'a seat'}'s call to ${req.arg}…`,
          color: ag?.color,
        });
        const decision = await new Promise((resolve) => {
          writeResolveRef.current = resolve;
          setPendingWrite({
            kind: 'mcp',
            target: req.arg,
            args: req.args || '',
            description: meta?.description || '',
            destructive: meta?.destructive === true,
            unknown: !meta,
            agentName: ag?.name,
            color: ag?.color,
          });
        });
        writeResolveRef.current = null;
        setPendingWrite(null);
        if (decision === 'always') setAutoApproveBoth(true);
        else if (decision !== 'approve') {
          return {
            ok: false,
            output:
              'Call not approved — the user rejected this integration call. Do not retry the same call; ask what should change or move on.',
          };
        }
      }
      const result = await api.mcpCall(req.server, req.tool, req.args ?? '', ag?.id);
      setMcpCalls((prev) => [
        { target: req.arg, ok: result?.ok === true, agentName: ag?.name, color: ag?.color, ts: Date.now() },
        ...prev,
      ].slice(0, 20));
      return result;
    }
    // Current content for the diff AND the Phase 5 baseline — null means "new
    // file". (read_file truncates >64KB, so huge files diff against a
    // truncated old view.) Read for every gated write, approval prompt or not,
    // so auto-approved writes still get baselines.
    let oldText = null;
    if (req?.op === 'write_file' && ag?.canWrite === true) {
      try {
        const r0 = await api.runCheck({ op: 'read_file', arg: req.arg }, activeProject?.path ?? null, ag?.id);
        if (r0?.ok) oldText = r0.output;
      } catch { /* treat as new file */ }
    }
    if (req?.op === 'write_file' && ag?.canWrite === true && !autoApproveRef.current) {
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
    if (req?.op === 'write_file' && r?.ok) {
      recordWrite(req.arg, ag?.name);
      recordBaseline(req.arg, oldText);
    }
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

  // Phase 5: remember the FIRST pre-write content per path this session so the
  // review panel can show a cumulative "since session start" diff per file.
  function recordBaseline(filePath, oldText) {
    if (!filePath || filePath in baselinesRef.current) return;
    const next = { ...baselinesRef.current, [filePath]: oldText };
    baselinesRef.current = next;
    setBaselines(next);
  }

  // Scripts panel → apply a chat code block to an EXISTING project file.
  // Deliberately not a second write path: the diff goes through the same
  // pendingWrite state + WriteApproval modal an agent's write_file uses, and
  // the filesystem write itself is the existing user-initiated script:save
  // (native save dialog, defaulted to the target path). Nothing here can write
  // without the user approving twice.
  async function applyScriptToFile({ path: relPath, oldText, content, agentName }) {
    if (!activeProject?.path) return { ok: false, error: 'no project selected' };
    // One approval slot (writeResolveRef) — never clobber a live agent write.
    if (pendingWrite || writeResolveRef.current) return { ok: false, error: 'another approval is open' };
    const decision = await new Promise((resolve) => {
      writeResolveRef.current = resolve;
      setPendingWrite({
        path: relPath,
        agentName,
        color: agents.find((a) => a.name === agentName)?.color ?? null,
        oldText,
        content,
      });
    });
    writeResolveRef.current = null;
    setPendingWrite(null);
    // "Approve all" from THIS surface means approve this one. It must not flip
    // the per-chat auto-approve for agent writes — that's a different risk.
    if (decision !== 'approve' && decision !== 'always') return { ok: false, rejected: true };
    const saved = await api.saveScript(activeProject.path, relPath, content);
    if (!saved) return { ok: false, cancelled: true };
    recordWrite(relPath, agentName);
    recordBaseline(relPath, oldText);
    return { ok: true, saved };
  }

  // Phase 8/9: attach the retained call record + token usage to the entry the
  // moment it lands in the transcript, then clear the per-agent slot.
  function attachCallMeta(entry) {
    if (!entry?.agentId) return;
    const rec = callRecordRef.current[entry.agentId];
    if (rec) {
      entry.callRecord = rec;
      delete callRecordRef.current[entry.agentId];
    }
    const u = usageRef.current[entry.agentId];
    if (u) {
      entry.usage = u;
      delete usageRef.current[entry.agentId];
    }
  }

  // Phase 8: cap retained call records at ~2 MB per SAVED session, newest
  // kept (records embed the transcript-so-far, so an uncapped session file
  // grows quadratically). Live state is untouched — only the saved copy.
  function pruneCallRecords(map) {
    const BUDGET = 2 * 1024 * 1024;
    const out = {};
    const holders = [];
    for (const [k, list] of Object.entries(map || {})) {
      out[k] = (list || []).map((e) => (e?.callRecord ? { ...e } : e));
      out[k].forEach((e) => { if (e?.callRecord) holders.push(e); });
    }
    let used = 0;
    for (const e of holders.reverse()) { // later in a list ≈ newer
      const size = JSON.stringify(e.callRecord).length;
      if (used + size <= BUDGET) used += size;
      else delete e.callRecord;
    }
    return out;
  }

  function saveAgent(agent) {
    const exists = agents.some((a) => a.id === agent.id);
    persist(exists ? agents.map((a) => (a.id === agent.id ? agent : a)) : [...agents, agent]);
    // A copy of a seated AI arrives seated, mirroring its source. Only needed
    // when the roster is materialized — null already means everyone is seated.
    if (!exists && agent.cloneKeyFrom) {
      setRoster((r) => (r && r.includes(agent.cloneKeyFrom) && !r.includes(agent.id) ? [...r, agent.id] : r));
    }
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
    setLastCtxGate(null); // the gate hint belongs to the old chat's last send
    updateTasks([]);
    nextTaskIdRef.current = 1;
    setAutoApproveBoth(false);
    setRoster(ids);
    // New chat = new persisted session (Phase 2): full reset, fresh id.
    clearTimeout(saveTimerRef.current);
    setCurrentSessionId(crypto.randomUUID());
    setSessionName('New session');
    sessionCreatedRef.current = Date.now();
    setWrittenFiles([]);
    setMcpCalls([]);
    baselinesRef.current = {};
    setBaselines({});
    // Spawned specialists belong to the old mission — a stale one blocks a
    // fresh SPAWN of the same name (collision = reuse), keeping old bugs alive.
    missionSeatsRef.current = [];
    setMissionSeats([]);
    setTranscripts({ group: [] });
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

  // ---- Phase A: context size visibility -------------------------------------
  // A1 — aggregate for the record the 🔍 inspector is showing. Pure derived
  // data off `inspecting`; no new state, nothing recorded at call time.
  const inspectMsgs = inspecting?.messages ?? [];
  const inspectChars = totalChars(inspectMsgs);
  let inspectLargest = -1;
  for (let j = 0, best = -1; j < inspectMsgs.length; j++) {
    const n = msgChars(inspectMsgs[j]);
    if (n > best) {
      best = n;
      inspectLargest = j;
    }
  }

  // A2 — live pre-send estimate for the CURRENT thread. buildMessagesFor is
  // pure (orchestrator.js: maps the transcript, returns; touches no state) and
  // taskBoard is passed null on purpose — this is a read-only projection, not
  // a send, and boardSnapshot()'s line is small anyway. Memoized because the
  // composer re-renders on every keystroke and long transcripts make this a
  // few hundred KB of string building.
  const estimateAgent =
    (target.type === 'direct' ? agents.find((a) => a.id === target.agentId) : null) ||
    seated[0] ||
    agents[0] ||
    { id: '__estimate__' };
  const pendingChars = useMemo(
    () => totalChars(buildMessagesFor(estimateAgent, transcript, null)),
    [transcript, estimateAgent.id],
  );

  const isSeated = (id) => roster === null || roster.includes(id);
  // Seat or bench an AI without starting a new chat. First toggle off the
  // implicit "all seated" default by materializing the full roster, then flip.
  function toggleSeat(id) {
    setRoster((prev) => {
      const base = prev === null ? agents.map((a) => a.id) : prev;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  }

  // Total tools across connected MCP servers — drives the 🔌 capability icon
  // on seat cards and the empty-state integrations card.
  const mcpToolTotal = mcpInfo.status
    .filter((s) => s.status === 'connected')
    .reduce((n, s) => n + (s.tools?.length ?? 0), 0);

  // One sidebar seat card. seatNo is the 1-based speaking position when
  // seated, or null when benched (shows a "+" to seat instead of a number).
  // WYSIWYG: model + capabilities are on the card — no opening the form to
  // see who can do what.
  const renderAgentRow = (a, seatNo) => (
    <div
      key={a.id}
      className={`agent-card ${seatNo === null ? 'benched' : 'seated'}`}
      // Seated cards carry the agent's accent color on the left edge, so
      // seat state reads at a glance — the pill is the control, not the
      // only signal.
      style={seatNo !== null ? { borderLeftColor: a.color || 'var(--accent)' } : undefined}
    >
    <div className="agent-row">
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
        <button className="icon icon-x" title="Remove" onClick={() => deleteAgent(a.id)}>✕</button>
      </div>
    </div>
    <div className="agent-sub">
      <span className="agent-model" title={a.provider === 'cli' ? a.command : a.model}>
        {a.provider === 'cli' ? `cli · ${a.command || '?'}` : `${a.provider} · ${a.model || '?'}`}
      </span>
      <span className="agent-caps">
        <span className="cap" title="Reads project files (CHECK: read_file / list_dir)">👁</span>
        {a.canWrite === true && <span className="cap cap-write" title="Writes project files — you approve each diff">✎</span>}
        <span className="cap" title="Searches the web (CHECK: web_search / fetch_url)">🌐</span>
        {mcpToolTotal > 0 && <span className="cap cap-mcp" title={`Calls connected integrations (${mcpToolTotal} tools)`}>🔌</span>}
      </span>
      <button
        className={`seat-pill ${seatNo === null ? 'off' : 'on'}`}
        title={seatNo === null ? 'Benched — click to seat at the roundtable' : `Seated, speaks #${seatNo} — click to bench`}
        onClick={() => toggleSeat(a.id)}
      >
        {seatNo === null ? 'benched' : 'seated'}
      </button>
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
      if (res.usage && agent?.id) usageRef.current[agent.id] = res.usage; // Phase 9
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
    web_search: 'searching the web for',
    fetch_url: 'fetching',
    mcp: 'calling',
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
  async function runSeatTurn(agent, key, startWorking, callId, safeAppend, instructions = '') {
    let working = startWorking;
    // Phase 7: ROUNDTABLE.md rides in as the projectInstructions stage;
    // connected MCP tools ride in as the mcpTools stage.
    const extras = buildExtras(instructions);
    const ask = async (followUp = false) => {
      setLiveStatus(fmtStatus({ phase: 'thinking', agent, followUp }));
      setStreamText(''); // fresh preview buffer for this call
      const built = withRolePrompt(agent, mode, undefined, extras);
      const msgs = buildMessagesFor(agent, working, boardSnapshot());
      // Phase 8: retain exactly what this seat is sent (attached on append).
      callRecordRef.current[agent.id] = {
        systemPrompt: built.systemPrompt,
        stages: buildPromptStages(agent, mode, extras)
          .filter((s) => s.applies && s.text)
          .map((s) => ({ id: s.id, label: s.label, text: s.text })),
        messages: msgs,
      };
      const res = await api
        .callAgent(built, msgs, callId, activeProject?.path ?? null)
        .catch((err) => `⚠️ ${agent.name} error: ${err.message}`);
      setStreamText(''); // final text takes over from the preview
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
          result = await runGatedCheck({ op: c.op, arg: c.arg, content: c.content, server: c.server, tool: c.tool, args: c.args }, agent);
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

  // ---- Message actions (Phase 3) -------------------------------------------
  function copyEntry(m) {
    navigator.clipboard?.writeText(m.text || '');
  }

  function deleteEntry(i) {
    if (busy) return;
    setTranscripts((t) => ({ ...t, [targetKey]: (t[targetKey] ?? []).filter((_, j) => j !== i) }));
  }

  // Phase B: exclude/include one tool result from what future turns are SENT.
  // Display is untouched — the bubble still shows the full output, just dimmed
  // and tagged. Immutable update at the absolute index (same shape as the
  // other in-place transcript edits above); sessions serialize whatever's on
  // the entry, so `contextPruned` persists with no save/load special-casing.
  // Tool speakers only — the same scope restriction buildMessagesFor enforces.
  // useCallback + index-arg keeps memo(ToolBubble) effective.
  const toggleContextPruned = useCallback(
    (i) => {
      setTranscripts((t) => {
        const list = t[targetKey] ?? [];
        const e = list[i];
        if (!e || e.speaker !== 'Tool') return t;
        const next = list.slice();
        if (e.contextPruned) {
          const { contextPruned: _was, ...rest } = e;
          next[i] = rest;
        } else {
          next[i] = { ...e, contextPruned: true };
        }
        return { ...t, [targetKey]: next };
      });
    },
    [targetKey],
  );

  // Edit-and-resend (user entries): load the text back into the composer and
  // truncate the transcript from this entry on — the resend replays from here.
  function editResend(i, m) {
    if (busy) return;
    setInput(m.text || '');
    if (m.images?.length) {
      setPendingImages(m.images.map((d, k) => ({ dataUrl: d, name: `image ${k + 1}` })));
    }
    setTranscripts((t) => ({ ...t, [targetKey]: (t[targetKey] ?? []).slice(0, i) }));
    composerRef.current?.focus();
  }

  // Retry (user entries): re-run this prompt in place. The replies that
  // followed answered this exact prompt, so they're replaced — the transcript
  // rewinds to just before the entry and send() replays it with the same
  // text, images, and attachments. Unlike editResend, the composer draft is
  // left untouched.
  function retryEntry(i, m) {
    if (busy) return;
    const prior = (transcripts[targetKey] ?? []).slice(0, i);
    setTranscripts((t) => ({ ...t, [targetKey]: prior }));
    send(null, m.text || '', {
      images: m.images ?? [],
      attachments: m.attachments ?? [],
      base: prior,
    });
  }

  // Regenerate (agent entries): truncate from this entry on — later entries
  // replied to a message that no longer exists, so they go too (same rule as
  // edit-and-resend) — then re-invoke the same seat via the single-agent path.
  async function regenerate(i, m) {
    if (busy) return;
    const agent =
      agents.find((a) => a.id === m.agentId) ||
      missionSeatsRef.current.find((a) => a.id === m.agentId);
    if (!agent) return;
    const key = targetKey;
    const truncated = (transcripts[key] ?? []).slice(0, i);
    setTranscripts((t) => ({ ...t, [key]: truncated }));
    const mySession = sessionRef.current;
    const safeAppend = (k, entry) => {
      if (sessionRef.current !== mySession) return;
      attachCallMeta(entry); // Phase 8/9
      appendTo(k, entry);
      if (entry.speaker !== 'Tool' && entry.speaker !== 'System') {
        recordTasks(entry.text, entry.speaker);
        recordMemos(entry.text, entry.speaker);
      }
    };
    const myCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    callIdBase.current = myCallId;
    setBusy(true);
    stopRef.current = false;
    let instructions = '';
    if (activeProject?.path) {
      instructions = (await api.projectInstructions?.(activeProject.path).catch(() => '')) || '';
    }
    try {
      await runSeatTurn(agent, key, truncated, myCallId, safeAppend, instructions);
    } finally {
      if (callIdBase.current === myCallId) callIdBase.current = '';
      if (sessionRef.current === mySession) {
        setBusy(false);
        setLiveStatus(null);
        setStreamText('');
      }
    }
  }

  // retryOpts (from retryEntry): { images, attachments, base } — reuse the
  // original entry's payload instead of the composer, and build the working
  // transcript from `base` because the setTranscripts rewind hasn't landed in
  // `transcripts` yet when send() runs in the same tick.
  async function send(e, textOverride, retryOpts) {
    e?.preventDefault();
    const text = (textOverride ?? input).trim();
    const images = retryOpts ? (retryOpts.images ?? []) : pendingImages.map((p) => p.dataUrl);
    const attachments = retryOpts
      ? (retryOpts.attachments ?? [])
      : pendingFiles.map((f) => ({ name: f.name, text: f.text, truncated: f.truncated }));
    if (!text && images.length === 0 && attachments.length === 0) return;
    if (busy) {
      // Mid-round send → queue it (no Stop needed). Auto-sent when the round
      // ends; visible next to the composer with a ✕ to cancel.
      setQueued({ text, images, attachments });
      if (!retryOpts) {
        setInput('');
        setPendingImages([]);
        setPendingFiles([]);
      }
      return;
    }
    if (!retryOpts) {
      setInput('');
      setPendingImages([]);
      setPendingFiles([]);
    }

    const key = targetKey;
    // Snapshot the session token. If it changes (New Chat) while we're running,
    // we know this send is stale and must not touch the transcript.
    const mySession = sessionRef.current;
    const safeAppend = (k, entry) => {
      if (sessionRef.current !== mySession) return;
      attachCallMeta(entry); // Phase 8/9
      appendTo(k, entry);
      // TASK: lines from you or a seat update the shared board;
      // MEMO: lines land in the project's cross-session memory pool.
      if (entry.speaker !== 'Tool' && entry.speaker !== 'System') {
        recordTasks(entry.text, entry.speaker);
        recordMemos(entry.text, entry.speaker);
      }
    };

    // Project instructions (Phase 7): fetched fresh on EVERY send (5 s cache
    // main-side) so ROUNDTABLE.md edits are picked up on the next turn.
    let instructions = '';
    if (activeProject?.path) {
      instructions = (await api.projectInstructions?.(activeProject.path).catch(() => '')) || '';
      setProjInstructions(instructions);
    }

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
    // First message names the session (until the user renames it).
    if (sessionNameRef.current === 'New session' && text) setSessionName(text.slice(0, 48));

    setBusy(true);
    stopRef.current = false;
    let working = [...(retryOpts?.base ?? transcripts[key] ?? []), userEntry];

    // Phase C: above a size threshold, one cheap scoring call decides which
    // past tool results still matter for THIS prompt; the rest replay as the
    // Phase B placeholder for this send only. Nothing is written back to the
    // transcript, so the next send re-decides from the full history. Any
    // failure here leaves `working` untouched — full history, as always.
    setLastCtxGate(null);
    try {
      if (totalChars(buildMessagesFor(estimateAgent, working, null)) >= CTX_GATE_THRESHOLD) {
        setLiveStatus({ label: 'selecting relevant tool results…' });
        const gate = await scoreRelevantTools(text, working);
        if (gate) {
          setLastCtxGate({
            kept: gate.kept,
            total: gate.total,
            excluded: [...gate.excluded].map((i) => headLine(working[i]?.text)),
          });
          working = applyCtxExclusions(working, gate.excluded);
        }
      }
    } catch {
      /* gate is best-effort: fall through with the full history */
    }

    try {
      if (target.type === 'direct') {
        const agent = agents.find((a) => a.id === target.agentId);
        await runSeatTurn(agent, key, working, myCallId, safeAppend, instructions);
      } else {
        // Strict 1:1 speaker discipline: if the message names a seat, only that
        // seat replies — skip the full round.
        const named = addressedAgent(text, [...seated, ...missionSeatsRef.current]);
        if (named) {
          await runSeatTurn(named, key, working, myCallId, safeAppend, instructions);
          // fall through to finally — do NOT return early (would skip setBusy)
        } else {
          const participants = seated;
          if (participants.length === 0) {
            safeAppend(key, {
              speaker: 'System',
              agentId: null,
              text: 'Add at least one AI to start a roundtable.',
            });
          } else if (mode !== 'mission' && mode !== 'loop' && countSubtractors(participants) === 0) {
            safeAppend(key, {
              speaker: 'System',
              agentId: null,
              text: 'No subtractor seated — the table may drift toward agreement. Set an AI\'s role to "Subtractor" to keep it grounded.',
            });
          }
          // Shared with runRound and runMission: call one seat, retaining what
          // it was sent (Phase 8) and rebuilding its stage view for the
          // inspector. Spawned mission seats resolve through the ref.
          const makeCallAgent = () => async (ag, msgs) => {
            setStreamText(''); // fresh preview buffer for this seat's call
            const orig =
              participants.find((a) => a.id === ag.id) ||
              missionSeatsRef.current.find((a) => a.id === ag.id);
            callRecordRef.current[ag.id] = {
              systemPrompt: ag.systemPrompt,
              stages: orig
                ? buildPromptStages(orig, mode, buildExtras(instructions))
                    .filter((s) => s.applies && s.text)
                    .map((s) => ({ id: s.id, label: s.label, text: s.text }))
                : null,
              messages: msgs,
            };
            const res = await api.callAgent(ag, msgs, myCallId, activeProject?.path ?? null);
            setStreamText(''); // final text takes over from the preview
            return unwrapCall(res, ag);
          };

          if (mode === 'mission' && participants.length > 0) {
            // Mission: planner decomposes + delegates; seats work one task at
            // a time; planner synthesizes. Spawned seats persist per session.
            await runMission({
              agents: [...participants, ...missionSeatsRef.current],
              transcript: working,
              promptExtras: buildExtras(instructions),
              callAgent: makeCallAgent(),
              onReply: (entry) => safeAppend(key, entry),
              shouldStop: () => stopRef.current || sessionRef.current !== mySession,
              runCheck: runGatedCheck,
              onStatus: (s) => setLiveStatus(fmtStatus(s)),
              onSpawn: registerSpawned,
              taskBoard: boardSnapshot,
              getTasks: () => tasksRef.current,
              completeTask,
            });
          } else if (mode === 'loop' && participants.length > 0) {
            // Loop: workers iterate, the verifier judges each pass, and the
            // human signs off (on pass, and again when the budget runs out).
            await runLoop({
              agents: participants,
              transcript: working,
              promptExtras: buildExtras(instructions),
              callAgent: makeCallAgent(),
              onReply: (entry) => safeAppend(key, entry),
              shouldStop: () => stopRef.current || sessionRef.current !== mySession,
              runCheck: runGatedCheck,
              onStatus: (s) => setLiveStatus(fmtStatus(s)),
              taskBoard: boardSnapshot,
              maxIterations: loopInf ? Infinity : Math.max(1, Number(loopBudget) || 3),
              requestSignoff: (info) =>
                new Promise((resolve) => {
                  loopResolveRef.current = (decision) => {
                    loopResolveRef.current = null;
                    setPendingSignoff(null);
                    resolve(decision);
                  };
                  setPendingSignoff(info);
                }),
            });
          } else if (participants.length > 0) {
          // #1 — per-session failure/mute state, survives all rounds.
          const failures = new Map();
          const muted = new Set();
          for (let r = 0; r < rounds; r++) {
            if (stopRef.current || sessionRef.current !== mySession) break;
            const { working: next, produced } = await runRound({
              agents: participants,
              transcript: working,
              promptExtras: buildExtras(instructions),
              callAgent: makeCallAgent(),
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
      }
    } finally {
      if (callIdBase.current === myCallId) callIdBase.current = '';
      // Only clear busy if we're still the active session.
      if (sessionRef.current === mySession) {
        setBusy(false);
        setLiveStatus(null);
        setStreamText('');
      }
    }
  }

  // Fire the queued prompt once the table goes quiet. Uses the retryOpts path
  // so the queued payload (not the composer) is what gets sent; no `base`
  // means it builds on the live transcript, which now includes the round that
  // was running when the user queued.
  useEffect(() => {
    if (busy || !queued) return;
    const q = queued;
    setQueued(null);
    send(null, q.text, { images: q.images, attachments: q.attachments });
  }, [busy, queued]); // eslint-disable-line react-hooks/exhaustive-deps

  function stop() {
    stopRef.current = true;
    setQueued(null); // Stop means stop — don't fire a queued prompt into the silence
    // A pending CLI write approval would leave the CLI hanging until the
    // broker's auto-deny; answer it now so the abort is immediate and clean.
    setPendingWrite((pw) => {
      if (pw?.kind === 'cli') api.answerCliApproval?.(pw.id, false);
      return pw?.kind === 'cli' ? null : pw;
    });
    if (callIdBase.current) api.abortCall(callIdBase.current);
    setStreamText(''); // abort mid-stream leaves no orphan preview text
    writeResolveRef.current?.('reject'); // a pending approval blocks the loop
    loopResolveRef.current?.({ action: 'stop' }); // a pending sign-off blocks runLoop
  }

  // Phase 9: export the current session (markdown or raw JSON payload).
  function exportSession(kind) {
    const base = (sessionName || 'session').replace(/[^\w-]+/g, '_');
    if (kind === 'json') {
      api.exportSession?.(`${base}.json`, JSON.stringify(sessionPayload(), null, 2));
      return;
    }
    const lines = [`# ${sessionName}`, '', `Exported: ${new Date().toLocaleString()}`, ''];
    const names = [...new Set(
      Object.values(transcripts).flat().map((e) => e.speaker)
        .filter((s) => s && s !== 'You' && s !== 'Tool' && s !== 'System'),
    )];
    if (names.length) lines.push(`AIs: ${names.join(', ')}`, '');
    for (const [k, list] of Object.entries(transcripts)) {
      if (!list?.length) continue;
      lines.push(k === 'group' ? '## Roundtable' : `## Direct — ${agents.find((a) => a.id === k)?.name ?? k}`, '');
      for (const e of list) lines.push(`**${e.speaker}:** ${e.text}`, '');
    }
    if (tasksRef.current.length) {
      lines.push('## Task board', '');
      for (const t of tasksRef.current) {
        lines.push(`- [${t.done ? 'x' : ' '}] #${t.id} ${t.text}${t.by ? ` (by ${t.by})` : ''}`);
      }
      lines.push('');
    }
    api.exportSession?.(`${base}.md`, lines.join('\n'));
  }

  // Phase 9: quick-switcher items (agents, the table, sessions), filtered.
  const switcherItems = !showSwitcher
    ? []
    : [
        { key: 'rt', label: 'Roundtable', kind: 'table', go: () => setTarget({ type: 'group' }) },
        ...agents.map((a) => ({
          key: `a${a.id}`,
          label: a.name,
          kind: 'AI',
          go: () => {
            setTarget({ type: 'direct', agentId: a.id });
            setTranscripts((t) => ({ ...t, [a.id]: t[a.id] ?? [] }));
          },
        })),
        ...sessions.map((s) => ({
          key: `s${s.id}`,
          label: s.id === currentSessionId ? sessionName : s.name || 'Session',
          kind: 'session',
          go: () => switchSession(s.id),
        })),
      ]
        .filter((it) => it.label.toLowerCase().includes(switchQuery.toLowerCase()))
        .slice(0, 12);

  if (!loaded) return <div className="loading">Loading…</div>;

  const targetName =
    target.type === 'group'
      ? `Roundtable (${seated.length} AI${seated.length === 1 ? '' : 's'})`
      : agents.find((a) => a.id === target.agentId)?.name ?? 'Unknown';

  // Scripts for the side panel: code blocks from the current conversation +
  // files written this session.
  const scripts = extractScripts(transcript);
  const scriptCount = scripts.length + writtenFiles.length;
  // Web context preview: every web_search / fetch_url result across ALL
  // threads this session, attributed to the seat whose CHECK requested it
  // (the nearest preceding assistant entry). Newest first. Derived, not
  // stored — the transcript is the single source of truth.
  const webContext = [];
  for (const [tKey, entries] of Object.entries(transcripts)) {
    let lastAgent = null;
    (entries ?? []).forEach((e, i) => {
      if (!e) return;
      if (e.speaker && e.speaker !== 'Tool' && e.speaker !== 'System' && e.speaker !== 'You') lastAgent = e;
      if (e.speaker !== 'Tool') return;
      const text = String(e.text ?? '');
      const nl = text.indexOf('\n');
      const head = nl > -1 ? text.slice(0, nl) : text;
      const m = /^Check( failed)? \((web_search|fetch_url) (.*)\):$/.exec(head);
      if (!m) return;
      const seat = [...agents, ...missionSeats].find(
        (a) => a.id === lastAgent?.agentId || a.name === lastAgent?.speaker,
      );
      webContext.push({
        id: `${tKey}:${i}`,
        failed: !!m[1],
        op: m[2],
        arg: m[3],
        body: nl > -1 ? text.slice(nl + 1) : '',
        by: lastAgent?.speaker ?? null,
        color: seat?.color ?? null,
      });
    });
  }
  webContext.reverse();
  // Phase 9: session token total (only entries whose provider reported usage;
  // tokens only, never prices — prices go stale, counts don't).
  const tokenTotal = Object.values(transcripts)
    .flat()
    .reduce((acc, e) => acc + (e?.usage?.input || 0) + (e?.usage?.output || 0), 0);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Roundtable</div>

        {/* Sessions (Phase 2) */}
        <div className="nav-label">
          Sessions
          <button className="label-action" title="Search all sessions" onClick={() => setShowSearch(true)}>🔍</button>
          <button className="label-action" title="Export this session as Markdown" disabled={busy} onClick={() => exportSession('md')}>⤓</button>
          <button className="label-action" title="Export this session as raw JSON" disabled={busy} onClick={() => exportSession('json')}>{'{}'}</button>
          <button className="label-action" title="New session" disabled={busy} onClick={newSession}>+</button>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <div key={s.id} className={`session-row ${s.id === currentSessionId ? 'active' : ''}`}>
              {renamingId === s.id ? (
                <input
                  className="session-rename"
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <button
                  className="session-name"
                  title={busy ? 'Locked while a round is running' : (s.name || 'Session')}
                  disabled={busy}
                  onClick={() => switchSession(s.id)}
                >
                  <span className="session-label">{s.id === currentSessionId ? sessionName : s.name}</span>
                  <span className="session-time">{relTime(s.updatedAt)}</span>
                </button>
              )}
              <button
                className="icon"
                title="Rename"
                disabled={busy}
                onClick={() => { setRenamingId(s.id); setRenameDraft(s.name || ''); }}
              >
                ✎
              </button>
              <button
                className={`icon icon-x ${confirmDeleteId === s.id ? 'confirm-arm' : ''}`}
                title={confirmDeleteId === s.id ? 'Click again to delete — cannot be undone' : 'Delete'}
                disabled={busy}
                onClick={() => removeSession(s.id)}
              >
                {confirmDeleteId === s.id ? 'sure?' : '✕'}
              </button>
            </div>
          ))}
          {sessions.length === 0 && <div className="hint">Autosaves as you chat.</div>}
        </div>

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
          {activeProject && projInstructions && (
            <button
              className="proj-instructions"
              title="ROUNDTABLE.md is injected into every seat's context for this project — click to view"
              onClick={() => setShowInstructions(true)}
            >
              📋 project instructions active
            </button>
          )}
          {activeProject && (
            <div className="project-meta">
              <span className="project-path" title={activeProject.path}>{activeProject.path}</span>
              <div className="project-actions">
                <button className="icon" title="Edit project" disabled={busy} onClick={() => setEditingProject(activeProject)}>✎</button>
                <button className="icon icon-x" title="Remove project" disabled={busy} onClick={() => deleteProject(activeProject.id)}>✕</button>
              </div>
            </div>
          )}
        </div>

        <div className="nav-label">At the table ({seatedOrdered.length}) · speaking order</div>
        {seatedOrdered.map((a, idx) => renderAgentRow(a, idx + 1))}
        {agents.length > 0 && seated.length === 0 && (
          <div className="hint">No one seated — seat an AI from Benched below.</div>
        )}

        {missionSeats.length > 0 && <div className="nav-label">Mission specialists</div>}
        {missionSeats.map((a) => (
          <div key={a.id} className="agent-row spawned" title={a.systemPrompt}>
            <span className="name" style={{ background: a.color || 'var(--muted)' }}>{a.name}</span>
            <span className="role-badge" title="Spawned by the planner — lasts only this session">spawned</span>
          </div>
        ))}

        {benched.length > 0 && <div className="nav-label">Bench ({benched.length})</div>}
        {benched.map((a) => renderAgentRow(a, null))}

        {agents.length === 0 && <div className="hint">No AIs yet.</div>}

        <button className="add-btn" onClick={() => setEditing('new')}>+ Add an AI</button>

        <div className="nav-label">Integrations</div>
        {mcpInfo.servers.length === 0 && (
          <button className="hint int-empty" onClick={() => setShowMcp(true)}>
            Connect GitHub, Drive, Gmail…
          </button>
        )}
        {mcpInfo.servers.map((s) => {
          const st = s.enabled === false ? null : mcpInfo.status.find((x) => x.id === s.id);
          const dot = s.enabled === false ? 'off' : st?.status === 'connected' ? 'on' : st?.status === 'error' ? 'err' : 'off';
          const meta = s.enabled === false
            ? 'disabled'
            : st?.status === 'connected'
              ? `${st.tools.length} tools`
              : st?.status === 'error'
                ? 'error'
                : 'connecting…';
          return (
            <button
              key={s.id}
              className="int-row"
              title={st?.error || (st?.status === 'connected' ? `Seats call these as "${st.slug}.<tool>"` : meta)}
              onClick={() => setShowMcp(true)}
            >
              <span className={`int-dot int-${dot}`} />
              <span className="int-name">{s.name}</span>
              <span className="int-meta">{meta}</span>
            </button>
          );
        })}
        {mcpInfo.servers.length > 0 && (
          <button className="add-btn int-manage" onClick={() => setShowMcp(true)}>⚙ Manage integrations</button>
        )}

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
              <button
                className={`mode-opt ${mode === 'mission' ? 'active' : ''}`}
                title="A Planner seat breaks your goal into tasks and delegates each to a specialist — spawning new ones if needed — then synthesizes the results."
                onClick={() => setMode('mission')}
              >
                🎯 Mission
              </button>
              <button
                className={`mode-opt ${mode === 'loop' ? 'active' : ''}`}
                title="Worker seats iterate on your goal; a Reviewer/Subtractor seat judges each pass with a verdict; you hold final sign-off."
                onClick={() => setMode('loop')}
              >
                🔁 Loop
              </button>
            </div>
            {target.type === 'group' && mode !== 'mission' && mode !== 'loop' && (
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
            {target.type === 'group' && mode === 'loop' && (
              <label className="rounds" title="Iterations before the loop pauses for you even without a passing verdict. ∞ for local models — every pass still stops for your sign-off.">
                Budget
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={loopInf ? '' : loopBudget}
                  placeholder="∞"
                  disabled={loopInf}
                  onChange={(e) => setLoopBudget(Number(e.target.value) || 1)}
                />
                <button
                  type="button"
                  className={`mini-btn ${loopInf ? 'active' : ''}`}
                  title={loopInf ? 'Switch back to a fixed iteration budget' : 'Unlimited iterations (you still approve every pass, and Stop always works)'}
                  onClick={() => setLoopInf((v) => !v)}
                >
                  ∞
                </button>
              </label>
            )}
            <button
              className="scripts-toggle rail-toggle"
              title={railOpen ? 'Hide the status rail' : 'Show the status rail (tasks, changes, calls, scripts)'}
              onClick={toggleRail}
            >
              {railOpen ? '▸ Hide rail' : '◂ Rail'}
            </button>
          </div>
          <div className="mode-hint">
            <span>
              {mode === 'discuss'
                ? 'Discuss · understand and debate first — no files are written.'
                : mode === 'mission'
                  ? 'Mission · the Planner delegates your goal to specialists, then synthesizes the results.'
                  : mode === 'loop'
                    ? 'Loop · workers iterate, the verifier judges each pass, you hold final sign-off.'
                    : 'Build · implementation welcome — write-enabled seats can change files.'}
            </span>
            {autoApprove && (
              <button
                className="auto-approve-note"
                title="Every write in this chat is being approved automatically — click to turn approval prompts back on"
                onClick={() => setAutoApproveBoth(false)}
              >
                ✓ auto-approving writes — click to turn off
              </button>
            )}
            {tokenTotal > 0 && (
              <span className="token-total" title="Session token total (in + out), where the provider reported usage">
                Σ {tokenTotal.toLocaleString()} tok
              </span>
            )}
          </div>
        </header>

        {speakerChoices.length >= 2 && (
          <div className="speaker-filter">
            <button
              type="button"
              className={`speaker-chip ${!speakerFilter ? 'active' : ''}`}
              onClick={() => setSpeakerFilter(null)}
            >
              All
            </button>
            {speakerChoices.map((sp) => {
              const seat = [...agents, ...missionSeats].find((a) => a.name === sp);
              return (
                <button
                  type="button"
                  key={sp}
                  className={`speaker-chip ${speakerFilter === sp ? 'active' : ''}`}
                  onClick={() => setSpeakerFilter(sp)}
                >
                  {seat?.color && <span className="chip-dot" style={{ background: seat.color }} />}
                  {sp}
                </button>
              );
            })}
            {speakerFilter && (
              <span className="filter-note">
                showing only {speakerFilter}'s turns — {filteredTranscript.length} of {transcript.length}
              </span>
            )}
          </div>
        )}

        <div className="messages" ref={scrollRef}>
          {transcript.length === 0 && target.type === 'direct' && (
            <p className="empty">Start a one-on-one conversation.</p>
          )}
          {transcript.length === 0 && target.type === 'group' && (
            <div className="launchpad">
              {agents.length === 0 ? (
                <div className="getting-started">
                  <div className="lp-label">Get started</div>
                  <ol className="gs-steps">
                    <li><strong>Add an AI</strong> — "+ Add an AI" in the sidebar.</li>
                    <li><strong>Pick a provider & model</strong> — Ollama, Anthropic, OpenAI-compatible, or an installed CLI like claude.</li>
                    <li><strong>Say hello</strong> — type below. Add more seats any time to make it a real roundtable.</li>
                  </ol>
                </div>
              ) : seated.length === 0 ? (
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

                  {mode === 'mission' && !seated.some((a) => a.role === 'planner') && (
                    <div className="lp-warn">
                      ⚠️ Mission mode needs a Planner — set a seat's role to
                      “Planner/Lead” so it can delegate your goal.
                    </div>
                  )}
                  {mode === 'loop' && !pickLoopSeats(seated).verifier && (
                    <div className="lp-warn">
                      ⚠️ Loop mode needs a verifier — set a seat's role to
                      “Code Reviewer” or “Subtractor” to judge each iteration.
                    </div>
                  )}
                  {mode === 'loop' && pickLoopSeats(seated).verifier && pickLoopSeats(seated).workers.length === 0 && (
                    <div className="lp-warn">
                      ⚠️ Loop mode needs at least one working seat besides the verifier.
                    </div>
                  )}
                  {mode !== 'mission' && mode !== 'loop' && countSubtractors(seated) === 0 && (
                    <div className="lp-warn">
                      ⚠️ No subtractor seated — the table may drift toward agreement.
                      Set a seat's role to “Subtractor” to keep it grounded.
                    </div>
                  )}

                  <div className="lp-label">This table can</div>
                  <div className="cap-grid">
                    <button className="cap-card" onClick={() => setEditingProject(activeProject ?? 'new')}>
                      <span className="cap-ico">📁</span>
                      <span>
                        <span className="cap-title">Read your project</span>
                        <span className="cap-sub">
                          {activeProject ? activeProject.name : 'No project selected — pick one'}
                        </span>
                      </span>
                    </button>
                    <div className="cap-card static">
                      <span className="cap-ico">✍️</span>
                      <span>
                        <span className="cap-title">Write files</span>
                        <span className="cap-sub">
                          {seated.filter((a) => a.canWrite).length > 0
                            ? `${seated.filter((a) => a.canWrite).length} seat${seated.filter((a) => a.canWrite).length > 1 ? 's' : ''} · you approve each diff`
                            : 'No write-enabled seats'}
                        </span>
                      </span>
                    </div>
                    <div className="cap-card static">
                      <span className="cap-ico">🌐</span>
                      <span>
                        <span className="cap-title">Search the web</span>
                        <span className="cap-sub">All seats, read-only</span>
                      </span>
                    </div>
                    <button className="cap-card" onClick={() => setShowMcp(true)}>
                      <span className="cap-ico">🔌</span>
                      <span>
                        <span className="cap-title">Use integrations</span>
                        <span className="cap-sub">
                          {mcpToolTotal > 0
                            ? `${mcpToolTotal} tools · writes need approval`
                            : 'None connected — click to add'}
                        </span>
                      </span>
                    </button>
                  </div>

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
          {!showFullHistory && filteredTranscript.length > RECENT_MSGS && (
            <button
              className="mini-btn history-expand"
              onClick={() => setShowFullHistory(true)}
            >
              Show {filteredTranscript.length - RECENT_MSGS} earlier messages
            </button>
          )}
          {(showFullHistory
            ? filteredTranscript
            : filteredTranscript.slice(-RECENT_MSGS)
          ).map(({ m, i }) => {
            // i stays the ABSOLUTE transcript index (attached before filtering) —
            // delete/edit/regenerate all slice the real array by it.
            const kind =
              m.speaker === 'You' ? 'user' : m.speaker === 'Tool' ? 'tool' : 'assistant';
            const agentColor =
              kind === 'assistant'
                ? (agents.find((a) => a.id === m.agentId) ||
                   missionSeats.find((a) => a.id === m.agentId))?.color
                : null;
            return (
              <div
                key={i}
                data-mi={i}
                className={`bubble ${kind} ${agentColor ? 'colored' : ''} ${m.breakoutTask ? 'breakout' : ''}`}
                style={agentColor ? { background: agentColor } : undefined}
                title={m.usage ? `tokens: ${m.usage.input ?? '?'} in · ${m.usage.output ?? '?'} out` : undefined}
              >
                {m.speaker !== 'You' && (
                  <div className="who">
                    {agentColor && <span className="who-dot" style={{ background: agentColor }} />}
                    {m.speaker}
                    {m.agentId && ![...agents, ...missionSeats].some((a) => a.id === m.agentId) ? ' (removed)' : ''}
                    {m.breakoutTask && (
                      <span
                        className="breakout-badge"
                        title={`Breakout thread for task #${m.breakoutTask} — working turns stay out of the main table's context; only the final report is folded in`}
                      >
                        ↳ #{m.breakoutTask}
                      </span>
                    )}
                  </div>
                )}
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
                ) : kind === 'tool' ? (
                  <ToolBubble
                    text={m.text}
                    index={i}
                    pruned={!!m.contextPruned}
                    onTogglePrune={busy ? undefined : toggleContextPruned}
                  />
                ) : (
                  <div className="text">{m.text}</div>
                )}
                {!busy && (
                  <div className="msg-actions">
                    <button title="Copy" onClick={() => copyEntry(m)}>⧉</button>
                    {kind === 'user' && (
                      <button title="Edit & resend (removes this and everything after)" onClick={() => editResend(i, m)}>✎</button>
                    )}
                    {kind === 'user' && (
                      <button title="Retry — re-runs this prompt, replacing the replies below it" onClick={() => retryEntry(i, m)}>↻</button>
                    )}
                    {kind === 'assistant' && m.callRecord && (
                      <button title="Context — exactly what this seat was sent" onClick={() => setInspecting(m.callRecord)}>🔍</button>
                    )}
                    {kind === 'assistant' && m.agentId && [...agents, ...missionSeats].some((a) => a.id === m.agentId) && (
                      <button title="Regenerate (removes this and everything after)" onClick={() => regenerate(i, m)}>↻</button>
                    )}
                    <button title="Delete this message" onClick={() => deleteEntry(i)}>✕</button>
                  </div>
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
              {/* Streaming preview: raw text only — the final bubble (markdown,
                  thinking-split) replaces this when the call resolves. */}
              {streamText && <div className="stream-preview">{streamText}</div>}
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
          {/* Phase A2: rough size of the history replayed on the next send.
              Informational only — nothing here blocks or changes a send. */}
          {pendingChars > CTX_ESTIMATE_MIN && (
            <div
              className="ctx-estimate"
              title="Conversation history replayed to each seat on the next send, before the system prompt. Tokens are a rough estimate (~4 chars each), not a provider count. Excluded tool results are already counted as their placeholder."
            >
              ~{pendingChars.toLocaleString()} chars (≈{compactNum(approxTokens(pendingChars))} tokens)
              {target.type === 'direct' ? ' will be sent' : ' will be sent to each seat'}
            </div>
          )}
          {/* Phase C: what the last gated send actually replayed. Provisional
              by design — the next send scores the history again from scratch. */}
          {lastCtxGate && (
            <div
              className="ctx-gate-note"
              title={
                lastCtxGate.excluded?.length
                  ? `Replayed as a one-line note for that send only — the next send can bring them back:\n${lastCtxGate.excluded.join('\n')}`
                  : 'Every tool result was still relevant, so all of them were replayed in full.'
              }
            >
              <span className="ctx-gate-dot">◆</span>
              last send included {lastCtxGate.kept} of {lastCtxGate.total} tool results (context gate)
            </div>
          )}
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
                // Phase 9: pasted text/code files route through the existing
                // attachment logic (its size/type checks apply); images keep
                // their vision path.
                const files = [...(e.clipboardData?.items || [])]
                  .filter((it) => it.kind === 'file')
                  .map((it) => it.getAsFile())
                  .filter(Boolean);
                if (!files.length) return;
                e.preventDefault();
                const imgs = files.filter((f) => f.type?.startsWith('image/'));
                const rest = files.filter((f) => !f.type?.startsWith('image/'));
                if (imgs.length) addImages(imgs);
                if (rest.length) addFiles(rest);
              }}
              placeholder={
                target.type === 'group'
                  ? 'Pose a topic to the roundtable…  (Shift+Enter = new line)'
                  : `Message ${targetName}…  (Shift+Enter = new line)`
              }
            />
            {queued && (
              <span className="queued-note" title={queued.text}>
                ⏳ queued: “{queued.text.slice(0, 40)}{queued.text.length > 40 ? '…' : ''}”
                <button
                  type="button"
                  className="mini-btn"
                  title="Cancel the queued prompt"
                  onClick={() => setQueued(null)}
                >
                  ✕
                </button>
              </span>
            )}
            {busy && (
              <button type="button" className="stop" onClick={stop}>■ Stop</button>
            )}
            <button
              type="submit"
              title={busy ? 'The round is still running — your prompt will send the moment it ends' : undefined}
              disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0}
            >
              {busy ? 'Queue' : 'Send'}
            </button>
          </div>
        </form>
      </main>

      {railOpen && (
        <aside className="rail">
          <button
            className={`rail-card ${showTasks ? 'active' : ''}`}
            title="Shared task board — click to open. Seats manage it with TASK: add / TASK: done lines"
            onClick={() => setShowTasks((v) => !v)}
          >
            <div className="rail-head">
              <span>☑ Tasks</span>
              {tasks.filter((t) => !t.done).length > 0 && (
                <span className="rail-badge warn">{tasks.filter((t) => !t.done).length} open</span>
              )}
              {railChev('tasks')}
            </div>
            {railSecOpen.tasks && !showTasks && tasks.length > 0 && (
              <div className="rail-items">
                {tasks.slice(-3).map((t) => {
                  const owner = [...agents, ...missionSeats].find(
                    (a) => a.name === (t.doneBy || t.by) || a.name === t.assignee,
                  );
                  return (
                    <div key={t.id} className={`rail-item ${t.done ? 'done' : ''}`}>
                      {owner?.color && <span className="rail-dot" style={{ background: owner.color }} />}
                      {t.done && <span className="rail-check">✓</span>}
                      #{t.id} {t.text}
                    </div>
                  );
                })}
              </div>
            )}
          </button>

          <button
            className={`rail-card ${showReview ? 'active' : ''}`}
            title="Everything written this session — click for cumulative per-file diffs"
            onClick={() => setShowReview((v) => !v)}
          >
            <div className="rail-head">
              <span>± Changes</span>
              {writtenFiles.length > 0 && <span className="rail-badge ok">{writtenFiles.length} files</span>}
              {railChev('changes')}
            </div>
            {railSecOpen.changes && !showReview && writtenFiles.length > 0 && (
              <div className="rail-items">
                {writtenFiles.slice(0, 3).map((f) => {
                  const writer = [...agents, ...missionSeats].find((a) => a.name === f.agent);
                  return (
                    <div key={f.path} className="rail-item">
                      {writer?.color && <span className="rail-dot" style={{ background: writer.color }} />}
                      {f.path}
                    </div>
                  );
                })}
              </div>
            )}
          </button>

          {/* Progressive disclosure: Git/Files cards can't do anything with
              no project selected — hide them instead of showing dead cards. */}
          {activeProject && (
          <button
            className={`rail-card ${showGit ? 'active' : ''}`}
            title="Local git — the project's real working copy (status, diffs, history, branches). Read-only."
            onClick={() => setShowGit((v) => !v)}
          >
            <div className="rail-head">
              <span>⎇ Git</span>
              {gitSummary?.changed > 0 ? (
                <span className="rail-badge warn">{gitSummary.changed} changed</span>
              ) : gitSummary ? (
                <span className="rail-badge ok">{gitSummary.branch || 'clean'}</span>
              ) : (
                <span className="rail-badge">{activeProject.name}</span>
              )}
              {railChev('git')}
            </div>
            {railSecOpen.git && !showGit && gitSummary?.changed > 0 && (
              <div className="rail-items">
                {gitSummary.files.slice(0, 3).map((f) => (
                  <div key={f.path} className="rail-item">
                    <span className={`git-badge git-${(f.worktree || f.index || '?')}`}>
                      {f.worktree || f.index || '?'}
                    </span>
                    {f.path}
                  </div>
                ))}
              </div>
            )}
          </button>
          )}

          <button
            className={`rail-card ${showMcp ? 'active' : ''}`}
            title="Integration calls this chat — click to manage servers"
            onClick={() => setShowMcp(true)}
          >
            <div className="rail-head">
              <span>🔌 Calls</span>
              {pendingWrite?.kind === 'mcp' && <span className="rail-badge warn">awaiting you</span>}
              {railChev('calls')}
            </div>
            {railSecOpen.calls && mcpCalls.length > 0 && (
              <div className="rail-items">
                {mcpCalls.slice(0, 3).map((c, i) => (
                  <div key={i} className="rail-item">
                    {c.color && <span className="rail-dot" style={{ background: c.color }} />}
                    {c.target} {c.ok ? '✓' : '✕'}
                  </div>
                ))}
              </div>
            )}
          </button>

          <button
            className={`rail-card ${showMemory ? 'active' : ''}`}
            title="Shared memory — facts saved with MEMO: lines, injected into every seat's prompt"
            onClick={() => setShowMemory(true)}
          >
            <div className="rail-head">
              <span>🧷 Memory</span>
              {memories.length > 0 && <span className="rail-badge">{memories.length}</span>}
            </div>
          </button>

          <button
            className={`rail-card ${showWeb ? 'active' : ''}`}
            title="Web context — pages and search results the seats pulled into context this session"
            onClick={() => setShowWeb((v) => !v)}
          >
            <div className="rail-head">
              <span>🌐 Web</span>
              {webContext.length > 0 && <span className="rail-badge">{webContext.length}</span>}
              {railChev('web')}
            </div>
            {railSecOpen.web && !showWeb && webContext.length > 0 && (
              <div className="rail-items">
                {webContext.slice(0, 3).map((w) => (
                  <div key={w.id} className="rail-item">
                    {w.color && <span className="rail-dot" style={{ background: w.color }} />}
                    {w.op === 'fetch_url' ? '⇣' : '🔍'} {w.arg}
                  </div>
                ))}
              </div>
            )}
          </button>

          {activeProject && (
          <button
            className={`rail-card ${showPreview ? 'active' : ''}`}
            title="Preview — render the project's web app (HTML) right here, reloading as seats write files"
            onClick={() =>
              setShowPreview((v) => {
                const next = !v;
                // Panels are fixed-width flex columns and .app clips overflow —
                // with Web/Files/etc. open, Preview would render off-screen and
                // look like a dead button (happened live 2026-07-18). Opening
                // Preview closes the other panels; each is one click to reopen.
                if (next) {
                  setShowWeb(false);
                  setShowFiles(false);
                  setShowScripts(false);
                  setShowGit(false);
                  setShowReview(false);
                }
                return next;
              })
            }
          >
            <div className="rail-head">
              <span>▶ Preview</span>
            </div>
          </button>
          )}

          {activeProject && (
          <button
            className={`rail-card ${showFiles ? 'active' : ''}`}
            title="Browse the active project's files — written files are badged"
            onClick={() => setShowFiles((v) => !v)}
          >
            <div className="rail-head">
              <span>🗂 Files</span>
              <span className="rail-badge">{activeProject.name}</span>
            </div>
          </button>
          )}

          {activeProject && (
          <button
            className={`rail-card ${showEditor ? 'active' : ''}`}
            title="Edit the active project's files — syntax highlighting, diff preview before every save"
            onClick={() => setShowEditor((v) => !v)}
          >
            <div className="rail-head">
              <span>✎ Editor</span>
              <span className="rail-badge">{activeProject.name}</span>
            </div>
          </button>
          )}

          <button
            className={`rail-card ${showScripts ? 'active' : ''}`}
            title="Scripts the AIs produced — copy, download, or save them"
            onClick={() => setShowScripts((v) => !v)}
          >
            <div className="rail-head">
              <span>{'</>'} Scripts</span>
              {scriptCount > 0 && <span className="rail-badge">{scriptCount}</span>}
            </div>
          </button>
        </aside>
      )}

      {showTasks && (
        <TaskBoard
          tasks={tasks}
          agents={[...agents, ...missionSeats]}
          onToggle={(id) => updateTasks((p) => p.map((t) => (t.id === id ? { ...t, done: !t.done, doneBy: !t.done ? 'You' : t.doneBy } : t)))}
          onAdd={(text) => updateTasks((p) => [...p, { id: nextTaskIdRef.current++, text, done: false, by: 'You' }])}
          onRemove={(id) => updateTasks((p) => p.filter((t) => t.id !== id))}
          onClearDone={() => updateTasks((p) => p.filter((t) => !t.done))}
          onClose={() => setShowTasks(false)}
        />
      )}

      {showReview && (
        <ReviewPanel
          writtenFiles={writtenFiles}
          baselines={baselines}
          projectPath={activeProject?.path ?? null}
          onClose={() => setShowReview(false)}
        />
      )}

      {showGit && (
        <GitPanel
          projectPath={activeProject?.path ?? null}
          onClose={() => setShowGit(false)}
        />
      )}

      {showWeb && <WebPanel items={webContext} onClose={() => setShowWeb(false)} />}

      {showPreview && activeProject && (
        <PreviewPanel
          projectRoot={activeProject.path}
          writeStamp={writtenFiles.length}
          onClose={() => setShowPreview(false)}
        />
      )}

      {showFiles && (
        <FileTree
          projectPath={activeProject?.path ?? null}
          writtenFiles={writtenFiles}
          onClose={() => setShowFiles(false)}
        />
      )}

      {/* key={project path} — switching projects remounts the editor, dropping
          the open file and its buffer rather than carrying them across roots.
          writtenFiles + baselines are the same pair ReviewPanel gets: they
          drive the "changed by the table" list and the in-editor highlighting
          of the lines seats changed this session. */}
      {showEditor && activeProject && (
        <EditorPanel
          key={activeProject.path}
          projectPath={activeProject.path}
          onClose={() => setShowEditor(false)}
          onHumanWrite={(relPath) => recordWrite(relPath, 'You')}
          approvalBusy={Boolean(pendingWrite) || Boolean(writeResolveRef.current)}
          writtenFiles={writtenFiles}
          baselines={baselines}
          agentColors={Object.fromEntries(
            [...agents, ...missionSeats].filter((a) => a.color).map((a) => [a.name, a.color]),
          )}
        />
      )}

      {showScripts && (
        <ScriptsPanel
          scripts={scripts}
          files={writtenFiles}
          projectPath={activeProject?.path ?? null}
          onApplyToFile={applyScriptToFile}
          onClose={() => setShowScripts(false)}
        />
      )}

      {pendingSignoff && (
        <LoopSignoff
          signoff={pendingSignoff}
          onDecide={(decision) => loopResolveRef.current?.(decision)}
        />
      )}
      {pendingWrite && !pendingWrite.kind && (
        <WriteApproval
          approval={pendingWrite}
          onDecide={(d) => writeResolveRef.current?.(d)}
        />
      )}

      {pendingWrite && pendingWrite.kind === 'mcp' && (
        <ActionApproval
          approval={pendingWrite}
          onDecide={(d) => writeResolveRef.current?.(d)}
        />
      )}

      {pendingWrite && pendingWrite.kind === 'cli' && (
        <ActionApproval
          approval={pendingWrite}
          onDecide={decideCliApproval}
        />
      )}

      {showMcp && (
        <McpSettings
          servers={mcpInfo.servers}
          status={mcpInfo.status}
          onSave={(list) => api.mcpSave(list).then(adoptMcpInfo)}
          onRefresh={() => api.mcpList?.().then(adoptMcpInfo)}
          onClose={() => setShowMcp(false)}
        />
      )}

      {showSearch && (
        <SessionSearch
          busy={busy}
          agents={[...agents, ...missionSeats]}
          onJump={jumpToMessage}
          onClose={() => setShowSearch(false)}
        />
      )}

      {showMemory && (
        <MemoryPanel
          memos={memories}
          poolLabel={activeProject ? `project “${activeProject.name}”` : 'global (no project)'}
          distillAgentName={agents[0]?.name || null}
          distilling={distilling}
          busy={busy}
          onDelete={deleteMemo}
          onDistill={distillMemories}
          onClose={() => setShowMemory(false)}
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

      {inspecting && (
        <div className="modal-backdrop" onClick={() => setInspecting(null)}>
          <div className="modal file-view" onClick={(e) => e.stopPropagation()}>
            <div className="scripts-head">
              <span className="scripts-title">🔍 Context sent to the model</span>
              <button
                className="mini-btn"
                onClick={() => navigator.clipboard?.writeText(JSON.stringify(inspecting, null, 2))}
              >
                Copy JSON
              </button>
              <button className="icon icon-x" title="Close" onClick={() => setInspecting(null)}>✕</button>
            </div>
            <div className="inspector-body">
              <div className="scripts-section">System prompt{inspecting.stages ? ' — by stage' : ''}</div>
              {inspecting.stages ? (
                inspecting.stages.map((s) => (
                  <div key={s.id} className="insp-stage">
                    <div className="insp-stage-label">{s.label}</div>
                    <pre className="script-code">{s.text}</pre>
                  </div>
                ))
              ) : (
                <pre className="script-code">{inspecting.systemPrompt || '(none)'}</pre>
              )}
              <div
                className="insp-total"
                title="Sum of every message's content length in this call. Tokens are a rough estimate (~4 chars each), not a provider count."
              >
                {inspectChars.toLocaleString()} chars total (≈{compactNum(approxTokens(inspectChars))} tokens)
                {inspectMsgs.length > 0 && inspectLargest >= 0 && (
                  <> · largest single message {compactNum(msgChars(inspectMsgs[inspectLargest]))} chars</>
                )}
              </div>
              <div className="scripts-section">Messages ({inspectMsgs.length})</div>
              {inspectMsgs.map((mm, j) => (
                <div key={j} className="insp-stage">
                  <div className="insp-stage-label">
                    {mm.role}
                    {mm.images?.length ? ` · ${mm.images.length} image(s)` : ''}
                    {j === inspectLargest && inspectMsgs.length > 1 && (
                      <span className="insp-largest">
                        largest — {compactNum(msgChars(mm))} chars
                      </span>
                    )}
                  </div>
                  <pre className="script-code">
                    {typeof mm.content === 'string' ? mm.content : JSON.stringify(mm.content, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showSwitcher && (
        <div className="modal-backdrop" onClick={() => setShowSwitcher(false)}>
          <div className="modal switcher" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="Jump to an AI or session…  (Enter = first match)"
              value={switchQuery}
              onChange={(e) => setSwitchQuery(e.target.value)}
              // If focus ever leaves this input while the switcher is open
              // (click-through, HMR remount, OS focus steal), close rather
              // than linger as an invisible keystroke sink.
              onBlur={() => setShowSwitcher(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setShowSwitcher(false);
                if (e.key === 'Enter' && switcherItems[0]) {
                  switcherItems[0].go();
                  setShowSwitcher(false);
                }
              }}
            />
            <div className="switcher-list">
              {switcherItems.map((it) => (
                <button
                  key={it.key}
                  className="tree-row"
                  // mousedown, not click: the input's onBlur closes the
                  // switcher between mousedown and click, so a click handler
                  // would never fire.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    it.go();
                    setShowSwitcher(false);
                  }}
                >
                  <span className="tree-name">{it.label}</span>
                  <span className="review-meta">{it.kind}</span>
                </button>
              ))}
              {switcherItems.length === 0 && <p className="scripts-empty">No matches.</p>}
            </div>
          </div>
        </div>
      )}

      {showInstructions && (
        <div className="modal-backdrop" onClick={() => setShowInstructions(false)}>
          <div className="modal file-view" onClick={(e) => e.stopPropagation()}>
            <div className="scripts-head">
              <span className="scripts-title">📋 ROUNDTABLE.md</span>
              <button className="icon icon-x" title="Close" onClick={() => setShowInstructions(false)}>✕</button>
            </div>
            <pre className="script-code file-view-code">{projInstructions}</pre>
          </div>
        </div>
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
