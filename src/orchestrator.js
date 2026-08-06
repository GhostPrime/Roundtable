// Turns a shared transcript into per-agent message arrays and drives the
// auto back-and-forth. Kept UI-free so it's easy to reason about.
//
// Transcript entry: { speaker, agentId|null, text, thinking? }
// Agent: { id, name, provider, model, systemPrompt, role? }
//   role: 'contributor' (default) | 'subtractor' | 'coder' | 'reviewer' | 'designer'

// Prompt text + stage-based assembly live in promptText.js / promptStages.js
// (single source of truth, shared with the Prompt Flow Canvas). Re-exported
// here so existing imports keep working unchanged.
import { withRolePrompt, isSubtractor } from './promptStages.js';
export { withRolePrompt, isSubtractor, buildPromptStages, assemblePrompt } from './promptStages.js';

// taskBoard: optional pre-formatted "[Task board: …]" line. Appended to the
// final user message (or added as one) so every provider — including CLI —
// sees the board's CURRENT state, user clicks included. The transcript alone
// can't carry that: panel checkoffs never produce TASK lines.
export function buildMessagesFor(agent, transcript, taskBoard = null) {
  const msgs = transcript.map((entry) => {
    const mine = entry.agentId === agent.id;
    if (mine) return { role: 'assistant', content: entry.text };
    // Context pruning: an excluded tool result replays as its one-line header
    // instead of its full output — the seat still knows the check happened and
    // can re-run it, but the bulk stops riding along on every future round.
    // Tool speakers ONLY: a human's or a seat's own turn is never elided, and
    // the flag is set by the user (or a per-round relevance gate), never by a
    // model. Same head-line convention the collapsed Tool bubble displays.
    if (entry.contextPruned && entry.speaker === 'Tool') {
      const t = String(entry.text ?? '');
      const nl = t.indexOf('\n');
      const head = (nl > -1 ? t.slice(0, nl) : t).slice(0, 200);
      return { role: 'user', content: `${entry.speaker}: [excluded from context — was: ${head}]` };
    }
    // Attached images ride along on the message; each provider adapter
    // converts them to its own wire format (or a temp-file path for CLIs).
    const images = entry.images?.length ? { images: entry.images } : {};
    // Attached text/code files are folded straight into the message text so
    // every provider (and CLI) can read them — no vision needed.
    let content = `${entry.speaker}: ${entry.text}`;
    if (entry.attachments?.length) {
      content += entry.attachments
        .map(
          (f) =>
            `\n\n[Attached file: ${f.name}]${f.truncated ? ' (truncated)' : ''}\n${f.text}\n[End of file: ${f.name}]`,
        )
        .join('');
    }
    return { role: 'user', content, ...images };
  });
  if (taskBoard) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') last.content += `\n\n${taskBoard}`;
    else msgs.push({ role: 'user', content: taskBoard });
  }
  return msgs;
}

// Splits out a model's internal reasoning. Handles <think>...</think> and
// <thinking>...</thinking> blocks (Qwen3, DeepSeek, etc.). Returns the clean
// answer plus the concatenated reasoning (or '' if none).
export function splitThinking(raw) {
  if (!raw) return { answer: '', thinking: '' };
  const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
  let thinking = '';
  let m;
  while ((m = re.exec(raw)) !== null) thinking += m[1].trim() + '\n\n';
  const answer = raw.replace(re, '').trim();
  return { answer: answer || raw.trim(), thinking: thinking.trim() };
}

// MODES stays here (it's UI-facing, not prompt text).
export const MODES = ['discuss', 'build', 'mission', 'loop'];

// --- Check parsing/execution loop -------------------------------------------
const CHECK_RE = /^\s*CHECK:\s*(read_file|list_dir|exists|write_file|web_search|fetch_url|mcp|git)\s+(.+?)\s*$/gim;
const MAX_CHECKS_PER_TURN = 3;

// MCP calls: "CHECK: mcp <server>.<tool> {json args}". The args object may be
// inline on the line, in a fenced code block on the following lines, or absent
// (tools with no required params).
const MCP_ARG_RE = /^([\w-]+)\.([\w./-]+)\s*(\{.*)?$/s;

// Models routinely wrap the whole CHECK line in markdown emphasis or a list
// bullet — **CHECK: list_dir .**, `CHECK: read_file foo.js`, "- CHECK: ...".
// CHECK_RE anchors on a literal line-start "CHECK:", so any of that wrapping
// makes the line fail to match: no Tool entry gets created, no error is
// shown, and the directive just sits in the transcript as inert text — a
// seat's **CHECK: list_dir .** simply never ran.
// Strip the decoration before matching so formatting can't swallow a request.
// Generalized for any line directive (CHECK:, TASK:, …).
function stripDirectiveDecoration(text, kw) {
  return text.replace(
    new RegExp(
      `^[ \\t]*(?:[-*•]\\s*)?[\`*_]{0,3}\\s*(${kw}:.*?)[\`*_]{0,3}\\s*$`,
      'gim',
    ),
    '$1',
  );
}
function stripCheckDecoration(text) {
  return stripDirectiveDecoration(text, 'CHECK');
}

// Pull CHECK requests out of a reply. Returns [{ op, arg, content?, raw }].
// For write_file, we also pull the fenced code block that must follow the CHECK
// line. The block is consumed by finding the first ``` fence after the match.
export function parseChecks(text) {
  const out = [];
  if (!text) return out;
  const cleaned = stripCheckDecoration(text);
  let m;
  CHECK_RE.lastIndex = 0;
  while ((m = CHECK_RE.exec(cleaned)) !== null && out.length < MAX_CHECKS_PER_TURN) {
    const op = m[1];
    const arg = m[2].trim();
    const raw = m[0].trim();
    if (op === 'write_file') {
      // Grab the fenced block that immediately follows this CHECK line.
      // We look for ``` (with optional language tag) after the match position.
      const afterMatch = cleaned.slice(m.index + m[0].length);
      const fenceMatch = afterMatch.match(/^\s*```[^\n]*\n([\s\S]*?)```/);
      // No fence right after the line → content null, which the executor
      // REFUSES with a teaching error. It used to default to '' — which
      // silently wrote a 0-byte file whenever a seat put prose between the
      // CHECK line and its code block (happened live: empty index.html, the
      // seat saw "wrote index.html (0 bytes)" and sailed on).
      const content = fenceMatch ? fenceMatch[1] : null;
      out.push({ op, arg, content, raw });
    } else if (op === 'mcp') {
      // "<server>.<tool> {json}" — args inline, or in a fenced block after the
      // line (same convention as write_file content), or absent.
      const am = arg.match(MCP_ARG_RE);
      if (!am) {
        // Malformed target — surface as a runnable-but-failing check so the
        // seat sees WHY instead of the line silently doing nothing.
        out.push({ op, arg, server: '', tool: '', args: '', raw });
        continue;
      }
      let args = (am[3] || '').trim();
      if (!args) {
        const afterMatch = cleaned.slice(m.index + m[0].length);
        const fenceMatch = afterMatch.match(/^\s*```[^\n]*\n([\s\S]*?)```/);
        if (fenceMatch && fenceMatch[1].trim().startsWith('{')) args = fenceMatch[1].trim();
      }
      out.push({ op, arg: `${am[1]}.${am[2]}`, server: am[1], tool: am[2], args, raw });
    } else {
      out.push({ op, arg, raw });
    }
  }
  return out;
}

// --- Shared task board -------------------------------------------------------
// Seats manage the board with TASK lines (taught by promptText.TASK_BOARD):
//   TASK: add <short description>
//   TASK: done <#id or text>
// Parsed here; the board itself lives in UI state (App.jsx) and the TASK lines
// stay visible in the transcript, which is how other seats see board activity.
const TASK_RE = /^\s*TASK:\s*(add|done)\s+(.+?)\s*$/gim;
// Raised from 3 → 6 for mission mode: a planner's opening turn delegates the
// whole plan (2–6 subtasks) in one message.
const MAX_TASKS_PER_TURN = 6;

export function parseTasks(text) {
  const out = [];
  if (!text) return out;
  const cleaned = stripDirectiveDecoration(text, 'TASK');
  let m;
  TASK_RE.lastIndex = 0;
  while ((m = TASK_RE.exec(cleaned)) !== null && out.length < MAX_TASKS_PER_TURN) {
    const op = m[1].toLowerCase();
    let arg = m[2].trim();
    let assignee;
    if (op === 'add') {
      // Trailing "@SeatName" assigns the task (mission mode). Only the LAST
      // @word(s) run counts, so descriptions containing @ elsewhere are safe.
      // Models bold names constantly (@**Scout**) — allow and strip the wrap.
      const am = arg.match(/^(.*?)\s+@[*_`~]*([\w][\w .-]{0,23}?)[*_`~]*\s*$/);
      if (am && am[1].trim()) {
        arg = am[1].trim();
        assignee = normName(am[2]);
      }
    }
    out.push(assignee ? { op, arg, assignee } : { op, arg });
  }
  return out;
}

// --- Cross-session memory ----------------------------------------------------
// Seats save durable facts with MEMO lines (taught by promptText.memoryBlock):
//   MEMO: <one short factual sentence>
// Parsed here like TASK lines; storage lives in electron/memory.js and the
// saved pool is injected back as the `memory` prompt stage. Plain text end to
// end, so it works identically for every provider — local Ollama models,
// API models, and CLI seats alike. The user can save facts too: a MEMO line
// typed in the composer goes through the same parser.
const MEMO_RE = /^\s*MEMO:\s*(.+?)\s*$/gim;
const MAX_MEMOS_PER_TURN = 2;

export function parseMemos(text) {
  const out = [];
  if (!text) return out;
  const cleaned = stripDirectiveDecoration(text, 'MEMO');
  let m;
  MEMO_RE.lastIndex = 0;
  while ((m = MEMO_RE.exec(cleaned)) !== null && out.length < MAX_MEMOS_PER_TURN) {
    const fact = m[1].trim();
    if (fact) out.push(fact);
  }
  return out;
}

// --- Mission mode: SPAWN + delegation ----------------------------------------
// Seat names come from model output, which loves markdown — "**Scout**",
// "`Scout`", "@Scout". Normalize everywhere a name is minted or compared, or
// spawned seats become unreachable ("no seat named Scout" while **Scout**
// sits at the table — happened live 2026-07-10).
function normName(s) {
  return String(s || '').replace(/[*_`~"']/g, '').replace(/^@/, '').trim();
}

// The planner creates session-scoped specialist seats with SPAWN lines:
//   SPAWN: <Name> | <one-line persona>
const SPAWN_RE = /^\s*SPAWN:\s*([^|\n]+?)\s*\|\s*(.+?)\s*$/gim;
const MAX_SPAWNS_PER_TURN = 4;

export function parseSpawns(text) {
  const out = [];
  if (!text) return out;
  const cleaned = stripDirectiveDecoration(text, 'SPAWN');
  let m;
  SPAWN_RE.lastIndex = 0;
  while ((m = SPAWN_RE.exec(cleaned)) !== null && out.length < MAX_SPAWNS_PER_TURN) {
    const name = normName(m[1]).slice(0, 24);
    const persona = m[2].trim();
    if (name && persona) out.push({ name, persona });
  }
  return out;
}

// Build a temp specialist seat from a SPAWN spec. Provider plumbing is copied
// from the planner (same model answers in a different persona). Returns null
// when the name collides with an existing seat — that's an assignment to the
// existing seat, not a new one.
export function makeSpawnedAgent(spec, planner, existingNames, color) {
  const taken = existingNames.map((n) => normName(n).toLowerCase());
  if (taken.includes(normName(spec.name).toLowerCase())) return null;
  return {
    id: `spawn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: spec.name,
    provider: planner.provider,
    baseUrl: planner.baseUrl,
    model: planner.model,
    // The renderer only holds the KEY_SET sentinel, never the real key. Point
    // main.js at the planner's STORED key (same path cloned seats use) —
    // without this, spawned seats 401 on any keyed provider.
    apiKey: planner.apiKey,
    cloneKeyFrom: planner.id,
    command: planner.command,
    args: planner.args,
    role: 'contributor',
    color: color || planner.color,
    canWrite: planner.canWrite === true,
    spawned: true,
    systemPrompt: `You are ${spec.name}, a specialist created for this mission. ${spec.persona}\nStay inside your specialty; work only the tasks dispatched to you.`,
  };
}

// Case-insensitive, markdown-insensitive seat lookup by display name
// (assignees come from TASK lines; seat names may carry legacy decoration).
export function findSeatByName(agents, name) {
  const q = normName(name).toLowerCase();
  if (!q) return null;
  return agents.find((a) => normName(a.name).toLowerCase() === q) || null;
}

// #2 — Stable ordering by role tier, original order preserved within a tier:
//   0  designer  — sets direction/UX before anything is built
//   1  contributor, coder (and any other/unknown role) — does the work
//   2  reviewer, subtractor — react to what was added this round
// This generalizes the old contributor-first/subtractor-last split: a table
// with only contributor/subtractor seats orders identically to before.
function seatTier(agent) {
  if (agent?.role === 'planner' || agent?.role === 'designer') return 0;
  if (agent?.role === 'reviewer' || isSubtractor(agent)) return 2;
  return 1;
}

export function orderSeats(agents) {
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => seatTier(x.a) - seatTier(y.a) || x.i - y.i)
    .map(({ a }) => a);
}

// ---------------------------------------------------------------------------
// Seat roster — every seat should know who else is at the table and what
// their role is, not just the mission planner (that was the ONLY consumer
// before this). Built fresh per RECIPIENT (so "(you)" points at the right
// line) from orderSeats(), the same ordering the round itself speaks in.
//
// showModels is an INDEPENDENT sub-toggle, OFF by default (see App.jsx's
// "Reveal models to seats" checkbox and styles.css). Rationale: naming the
// underlying provider/model can make a smaller local seat defer to a
// big-name one ("I agree with Claude") instead of pushing back — which
// defeats the whole point of seating a subtractor/reviewer. Phil can flip it
// on deliberately to A/B that effect on his own table; the base roster
// (name/role/order/you) always ships regardless.
// ---------------------------------------------------------------------------

// Short, readable "who is this really" label — provider + model (or the CLI
// command for CLI seats). Reuses the exact convention the sidebar's
// `.agent-model` row already shows, so this isn't a second display format —
// never the raw endpoint URL, which stays out of the prompt entirely.
export function modelLabel(agent) {
  if (!agent) return 'unknown';
  return agent.provider === 'cli'
    ? `cli · ${agent.command || '?'}`
    : `${agent.provider || 'unknown'} · ${agent.model || '?'}`;
}

// agents: the seats to list. forAgent: the recipient, marked "(you)" (pass
// null/undefined for none). opts.showModels: append modelLabel() per line.
// opts.assignable: planner-facing hint that tasks can be delegated by name.
export function rosterLine(agents, forAgent, opts = {}) {
  const { showModels = false, assignable = false } = opts;
  const seats = orderSeats(agents);
  const lines = seats.map((a, i) => {
    const role = a.role || 'contributor';
    const you = forAgent && a.id === forAgent.id ? ' (you)' : '';
    const spawned = a.spawned ? ' (spawned)' : '';
    const model = showModels ? ` (${modelLabel(a)})` : '';
    return `${i + 1}. ${a.name} — ${role}${you}${spawned}${model}`;
  });
  const header = assignable
    ? 'Seated at this table (assignable with @Name), in speaking order:'
    : 'Seated at this table, in speaking order:';
  const footer = assignable
    ? '\nAssign tasks by ending a line with "TASK: add <description> @<SeatName>".'
    : '';
  return `${header}\n${lines.join('\n')}${footer}`;
}

export function countSubtractors(agents) {
  return agents.filter(isSubtractor).length;
}

// Strict 1:1 speaker discipline. If the message opens by addressing a seat by
// name — "@Qwen ...", "Qwen: ...", or "Qwen, ..." — return that agent so only
// it replies this turn. Returns null when no seat is named (run the full round).
export function addressedAgent(text, agents) {
  const t = (text || '').trimStart();
  for (const agent of agents) {
    const name = agent.name?.trim();
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // @Name  |  Name:  |  Name,   (case-insensitive, at the very start)
    const re = new RegExp(`^(?:@${esc}\\b|${esc}\\s*[:,])`, 'i');
    if (re.test(t)) return agent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// #3 — Progress detection. Heuristic by default; pass a custom `classify`
// (e.g. a one-shot model call) to override without rewiring the loop.
// Returns true if the entry represents real progress (proposal/decision/
// artifact) rather than reassurance or meta.
// ---------------------------------------------------------------------------
const REASSURANCE_RE =
  /\b(great point|good point|i agree|agreed|well said|that makes sense|sounds good|nice idea|what should we (build|do)|let me know|happy to help|thanks for)\b/i;

export function looksLikeProgress(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.startsWith('⚠️') || t.startsWith('System:')) return false;
  // Very short turns are almost always filler.
  if (t.length < 60) return false;
  // If what's left after removing reassurance/meta is thin, it's not progress.
  const stripped = t.replace(REASSURANCE_RE, '').trim();
  if (stripped.length < 40) return false;
  return true;
}

// A round made progress if at least one fresh entry looks substantive.
export function roundMadeProgress(newEntries, classify = looksLikeProgress) {
  return newEntries.some((e) => classify(e.text));
}

// ---------------------------------------------------------------------------
// runRound — now stateful across rounds via `failures` (a Map of agentId ->
// consecutive failure count) and `muted` (a Set of agentIds). Both are owned
// by the caller and passed in so state survives the whole session (#1).
// Returns { working, produced }: the full transcript and just this round's
// new entries (used by the turn-terminator, #3).
// ---------------------------------------------------------------------------
export async function runRound({
  agents,
  transcript,
  callAgent,
  onReply,
  shouldStop,
  failures,
  muted,
  muteThreshold = 2,
  runCheck,
  mode = 'build',
  // Optional live-status hook for the UI. Called with:
  //   { phase: 'thinking', agent, followUp? }   — before each model call
  //   { phase: 'check', agent, op, arg }        — before each file check
  onStatus,
  // Optional () => string|null returning the formatted task-board line.
  // A function (not a string) so mid-round user clicks are picked up fresh
  // on every call.
  taskBoard,
  // Optional { projectInstructions } forwarded into prompt assembly (the
  // projectInstructions stage). undefined = stage absent = prompts are
  // byte-identical to before this option existed.
  promptExtras,
  // Independent sub-toggle: when true, the roster stage's lines also show
  // each seat's underlying provider/model (see rosterLine()/modelLabel()
  // above). Off by default; the base roster (name/role/order/you) always
  // ships once this option exists — it's only the model-identity part
  // that's gated.
  showRosterModels = false,
  // Optional () => transcript array | undefined. Live interjection support:
  // `working` below is a local snapshot that only grows from THIS round's own
  // replies, so a message the user sends mid-round (via the app's normal
  // append path) never reaches it on its own. When provided, this is polled
  // right before each speaker's prompt is built; a longer live array replaces
  // `working` wholesale (it's the same accumulation plus interjections spliced
  // in at their real point in time — never shorter, never reordered). Absent
  // by default, so callers that don't pass it (including the prompt-regression
  // harness) see exactly the old behavior.
  getLiveTranscript,
}) {
  let working = [...transcript];
  const produced = [];
  const seats = orderSeats(agents);

  function syncLive() {
    if (!getLiveTranscript) return;
    const live = getLiveTranscript();
    // Defensive copy — `working` is never mutated in place here, but stay
    // consistent with runMission (which does .push()) rather than alias the
    // live React-state array directly.
    if (Array.isArray(live) && live.length > working.length) working = [...live];
  }

  // Run any CHECK requests in `text` for `agent`, append a Tool entry per
  // result, and return true if at least one ran (so the caller can give the
  // seat a follow-up turn with the real results in context).
  async function resolveChecks(text, agent) {
    // DISCUSS mode = no file access, even if a seat emits CHECK lines anyway.
    if (!runCheck || mode === 'discuss') return false;
    const checks = parseChecks(text);
    if (checks.length === 0) return false;
    for (const c of checks) {
      onStatus?.({ phase: 'check', agent, op: c.op, arg: c.arg });
      let result;
      try {
        result = await runCheck({ op: c.op, arg: c.arg, content: c.content, server: c.server, tool: c.tool, args: c.args }, agent);
      } catch (err) {
        result = { ok: false, output: String(err?.message || err) };
      }
      const label = result.ok ? `Check (${c.op} ${c.arg})` : `Check failed (${c.op} ${c.arg})`;
      const entry = {
        speaker: 'Tool',
        agentId: null,
        text: `${label}:\n${result.output}`,
        thinking: '',
      };
      working = [...working, entry];
      produced.push(entry);
      onReply(entry);
    }
    return true;
  }

  for (const agent of seats) {
    if (shouldStop()) break;
    if (muted && muted.has(agent.id)) continue; // #1 — skip dead seats entirely

    // Per-recipient: "(you)" has to point at THIS agent's own line, so the
    // roster is rebuilt fresh for each speaker rather than reused across the
    // round (see rosterLine()).
    const extras = { ...(promptExtras || {}), roster: rosterLine(seats, agent, { showModels: showRosterModels }) };

    let raw;
    let failed = false;
    syncLive();
    onStatus?.({ phase: 'thinking', agent });
    try {
      raw = await callAgent(withRolePrompt(agent, mode, undefined, extras), buildMessagesFor(agent, working, taskBoard?.() ?? null));
    } catch (err) {
      failed = true;
      raw = `⚠️ ${agent.name} error: ${err.message}`;
    }

    // Abort sentinel — stop button was pressed mid-call; bail out cleanly.
    if (raw === '__ABORTED__' || shouldStop()) break;

    if (failures) {
      const n = failed ? (failures.get(agent.id) || 0) + 1 : 0;
      failures.set(agent.id, n);
      if (failed && muted && n >= muteThreshold) {
        muted.add(agent.id);
        const muteEntry = {
          speaker: 'System',
          agentId: null,
          text: `muted ${agent.name} after ${n} failures`,
          thinking: '',
        };
        working = [...working, muteEntry];
        produced.push(muteEntry);
        onReply(muteEntry);
        continue; // don't also post the raw error this turn
      }
    }

    const { answer, thinking } = splitThinking(raw);
    const entry = {
      speaker: agent.name,
      agentId: agent.id,
      text: answer,
      thinking,
      ts: new Date().toLocaleTimeString(),
    };
    working = [...working, entry];
    produced.push(entry);
    onReply(entry);

    // If the seat asked for checks, run them and give it one follow-up turn
    // with the real results in context. Bounded to a single follow-up per turn.
    if (!shouldStop()) {
      const ran = await resolveChecks(answer, agent);
      if (ran) {
        syncLive();
        onStatus?.({ phase: 'thinking', agent, followUp: true });
        let followRaw;
        try {
          followRaw = await callAgent(withRolePrompt(agent, mode, undefined, extras), buildMessagesFor(agent, working, taskBoard?.() ?? null));
        } catch (err) {
          followRaw = `⚠️ ${agent.name} error: ${err.message}`;
        }
        if (followRaw === '__ABORTED__' || shouldStop()) break;
        const follow = splitThinking(followRaw);
        const followEntry = {
          speaker: agent.name,
          agentId: agent.id,
          text: follow.answer,
          thinking: follow.thinking,
          ts: new Date().toLocaleTimeString(),
        };
        working = [...working, followEntry];
        produced.push(followEntry);
        onReply(followEntry);
      }
    }
  }

  return { working, produced };
}

// ---------------------------------------------------------------------------
// Loop mode (bounded seat-loop) — worker seats iterate on the user's goal;
// a verifier seat judges each iteration with a VERDICT line; the HUMAN holds
// the stop condition (sign-off on pass, and again when the budget runs out).
// This is the counterweight to autonomous "loop engineering": the evaluate
// step stays adversarial (reviewer/subtractor) and the accept step stays human.
// ---------------------------------------------------------------------------
const VERDICT_RE = /^\s*VERDICT:\s*(pass|fail)\b[\s—–:-]*(.*)$/gim;

// Pull the verifier's verdict out of a reply. Returns { verdict: 'pass'|'fail',
// reason } from the LAST verdict line (models sometimes restate earlier ones),
// or null when no verdict line is present.
export function parseVerdict(text) {
  if (!text) return null;
  const cleaned = stripDirectiveDecoration(text, 'VERDICT');
  let m;
  let last = null;
  VERDICT_RE.lastIndex = 0;
  while ((m = VERDICT_RE.exec(cleaned)) !== null) {
    last = { verdict: m[1].toLowerCase(), reason: m[2].trim() };
  }
  return last;
}

// Seat selection: the first reviewer (preferred — reviews are its whole job),
// else the first subtractor, becomes the verifier. Every other non-judging
// seat works. Exported so the UI can preview the split in the launchpad.
export function pickLoopSeats(agents) {
  const seats = orderSeats(agents);
  const verifier = seats.find((a) => a?.role === 'reviewer') || seats.find(isSubtractor) || null;
  const workers = seats.filter((a) => a !== verifier && a?.role !== 'reviewer' && !isSubtractor(a));
  return { workers, verifier };
}

export async function runLoop({
  agents,
  transcript,
  callAgent,
  onReply,
  shouldStop,
  runCheck,
  onStatus,
  taskBoard,
  promptExtras,
  // See runRound — same independent, off-by-default model-identity sub-toggle.
  showRosterModels = false,
  // Iterations before the loop pauses for the human even without a pass.
  // Infinity is allowed (local models) — the human still holds Stop and every
  // pass still pauses for sign-off, so an infinite budget can't run away silently.
  maxIterations = 3,
  // async ({ kind: 'pass'|'budget', iteration, verdict }) =>
  //   { action: 'accept'|'revise'|'stop', notes? }
  // The UI resolves this from the sign-off bar. Absent (headless/test use with
  // no handler) = treat every pause as 'stop', never auto-accept.
  requestSignoff,
  // See runRound — same live-interjection pickup, same "absent = old behavior".
  getLiveTranscript,
}) {
  let working = [...transcript];
  const produced = [];
  const post = (entry) => {
    working = [...working, entry];
    produced.push(entry);
    onReply(entry);
  };
  const sys = (text) => post({ speaker: 'System', agentId: null, text, thinking: '' });
  function syncLive() {
    if (!getLiveTranscript) return;
    const live = getLiveTranscript();
    if (Array.isArray(live) && live.length > working.length) working = [...live];
  }

  const { workers, verifier } = pickLoopSeats(agents);
  if (!verifier) {
    sys('Loop mode needs a verifier — set a seat\'s role to "Code Reviewer" or "Subtractor".');
    return { working, produced };
  }
  if (workers.length === 0) {
    sys('Loop mode needs at least one working seat besides the verifier.');
    return { working, produced };
  }

  // One seat turn against the shared context. CHECKs resolve with a single
  // follow-up turn — the same bound as runRound/runMission. Returns the seat's
  // last answer, or null on stop/abort.
  async function turn(agent, dispatch, followUp = false) {
    syncLive();
    onStatus?.({ phase: 'thinking', agent, followUp });
    const extraLine = [taskBoard?.() ?? null, dispatch].filter(Boolean).join('\n\n') || null;
    // Roster is the loop's full seat set (workers + verifier), rebuilt fresh
    // per speaker so "(you)" lands on the right line — see runRound.
    const extras = { ...(promptExtras || {}), roster: rosterLine(agents, agent, { showModels: showRosterModels }) };
    let raw;
    try {
      raw = await callAgent(withRolePrompt(agent, 'loop', undefined, extras), buildMessagesFor(agent, working, extraLine));
    } catch (err) {
      raw = `⚠️ ${agent.name} error: ${err.message}`;
    }
    if (raw === '__ABORTED__' || shouldStop()) return null;
    const { answer, thinking } = splitThinking(raw);
    post({ speaker: agent.name, agentId: agent.id, text: answer, thinking, ts: new Date().toLocaleTimeString() });
    if (runCheck && !followUp) {
      const checks = parseChecks(answer);
      if (checks.length > 0 && !shouldStop()) {
        for (const c of checks) {
          onStatus?.({ phase: 'check', agent, op: c.op, arg: c.arg });
          let result;
          try {
            result = await runCheck({ op: c.op, arg: c.arg, content: c.content, server: c.server, tool: c.tool, args: c.args }, agent);
          } catch (err) {
            result = { ok: false, output: String(err?.message || err) };
          }
          const label = result.ok ? `Check (${c.op} ${c.arg})` : `Check failed (${c.op} ${c.arg})`;
          post({ speaker: 'Tool', agentId: null, text: `${label}:\n${result.output}`, thinking: '' });
        }
        return turn(agent, dispatch, true);
      }
    }
    return answer;
  }

  // Pause for the human. A missing handler or a missing decision means STOP —
  // the loop must never auto-accept its own output.
  async function signoff(kind, iteration, verdict) {
    if (!requestSignoff) return { action: 'stop' };
    const d = await requestSignoff({ kind, iteration, verdict });
    return d && d.action ? d : { action: 'stop' };
  }

  let iteration = 0;
  let budget = maxIterations;
  let lastVerdict = null;
  const iterLabel = () => (Number.isFinite(budget) ? `${iteration}/${budget}` : `${iteration}`);

  while (!shouldStop()) {
    // Budget floor: pause for the human BEFORE burning more calls.
    if (iteration >= budget) {
      const d = await signoff('budget', iteration, lastVerdict);
      if (d.action === 'accept') {
        sys(`loop ended — you accepted the result after ${iteration} iteration${iteration === 1 ? '' : 's'} (budget exhausted).`);
        break;
      }
      if (d.action !== 'revise') {
        sys(`loop stopped after ${iteration} iteration${iteration === 1 ? '' : 's'} — budget exhausted.`);
        break;
      }
      // Send-back: user notes enter the context, fresh budget granted.
      budget = Number.isFinite(maxIterations) ? iteration + maxIterations : Infinity;
      post({ speaker: 'You', agentId: null, text: `[Loop revision] ${d.notes || 'Keep going.'}` });
    }

    iteration++;
    for (const w of workers) {
      const fixNote = lastVerdict?.verdict === 'fail'
        ? ` The verifier's last verdict was FAIL: "${lastVerdict.reason}" — fix exactly those issues first.`
        : '';
      const answer = await turn(
        w,
        `[Loop iteration ${iterLabel()} — ${w.name}: work the user's goal now, concretely.${fixNote} Do not declare the goal met — that is ${verifier.name}'s call.]`,
      );
      if (answer === null) return { working, produced };
    }

    const vAnswer = await turn(
      verifier,
      `[Loop verification ${iterLabel()} — ${verifier.name}: judge the work above against the user's goal. Verify claims with checks where possible; be specific. End with exactly one line: "VERDICT: pass — <reason>" or "VERDICT: fail — <specific fixable issues>".]`,
    );
    if (vAnswer === null) return { working, produced };

    const v = parseVerdict(vAnswer);
    if (!v) {
      lastVerdict = { verdict: 'fail', reason: `no VERDICT line from ${verifier.name} — be explicit this time` };
      sys(`${verifier.name} gave no VERDICT line — counting as a fail.`);
      continue;
    }
    lastVerdict = v;
    if (v.verdict === 'pass') {
      const d = await signoff('pass', iteration, v);
      if (d.action === 'accept') {
        sys(`loop complete — ${verifier.name} passed it and you accepted (${iteration} iteration${iteration === 1 ? '' : 's'}).`);
        break;
      }
      if (d.action !== 'revise') {
        sys(`loop stopped by you at iteration ${iteration}.`);
        break;
      }
      budget = Number.isFinite(maxIterations) ? iteration + maxIterations : Infinity;
      post({ speaker: 'You', agentId: null, text: `[Loop revision] ${d.notes || 'Not there yet — keep going.'}` });
      lastVerdict = { verdict: 'fail', reason: d.notes || 'the user sent it back for another pass' };
    }
  }

  return { working, produced };
}

// ---------------------------------------------------------------------------
// runMission — mission-mode driver (Phase 1 + Phase 2 breakouts).
//   1. The planner seat turns the user's goal into assigned tasks
//      (TASK: add … @Seat), spawning temp specialists (SPAWN: …) as needed.
//   2. Each open assigned task is dispatched to its seat, one at a time,
//      sequentially — in a per-task BREAKOUT thread (Phase 2). The breakout
//      starts from the compact main context (goal, plan, prior reports) and
//      accumulates the seat's working turns + tool results locally; none of
//      that enters the main context. When the task closes, the seat's final
//      answer is folded into the main context as a single [Task #n report]
//      message. Seats close their task with TASK: done #id; the driver
//      force-closes after maxTurnsPerTask so a shy seat can't stall the run.
//   3. The planner gets a final synthesis turn over the compact main context.
// Every entry still reaches the UI via onReply — breakout entries carry a
// breakoutTask field so the renderer can mark them; the report copy into the
// main context is silent (no duplicate bubble).
// UI-free like runRound: board state and spawned-seat registration are owned
// by the caller and reached through the injected accessors.
// ---------------------------------------------------------------------------
export async function runMission({
  agents,
  transcript,
  callAgent,
  onReply,
  shouldStop,
  runCheck,
  onStatus,
  // (agent) => registered agent — caller assigns color/state, returns the
  // object to use (or the input unchanged).
  onSpawn,
  taskBoard,
  // () => [{ id, text, done, assignee? }] — live board state.
  getTasks,
  // (id, byName) => void — mark a task done outside a TASK line.
  completeTask,
  promptExtras,
  // See runRound — same independent, off-by-default model-identity sub-toggle.
  showRosterModels = false,
  maxTurnsPerTask = 2,
  maxTotalTurns = 16,
  // See runRound — same live-interjection pickup, same "absent = old
  // behavior". Only applied to turns on the main `working` thread (planner
  // turns): breakout threads are a deliberately isolated sub-context per
  // task and shouldn't pick up unrelated table chatter mid-task.
  getLiveTranscript,
}) {
  // `working` is the COMPACT main context: user goal, planner turns, system
  // notes, and one report message per closed task. Breakout turns never enter
  // it. Mutable array — post() pushes; reassignable so syncLive can replace it
  // wholesale when a live interjection lands.
  let working = [...transcript];
  const produced = [];
  const roster = [...agents];
  function syncLive() {
    if (!getLiveTranscript) return;
    const live = getLiveTranscript();
    // Defensive copy — `working` here is mutated in place via .push()
    // elsewhere (close(), the safety-net loop), so it must never alias the
    // live React-state array directly.
    if (Array.isArray(live) && live.length > working.length) working = [...live];
  }

  // Append to `thread`, surface in the UI. `tag` rides on the entry so the
  // renderer can mark breakout bubbles ({ breakoutTask: id }).
  const post = (entry, thread = working, tag = null) => {
    const e = tag ? { ...entry, ...tag } : entry;
    thread.push(e);
    produced.push(e);
    onReply(e);
  };
  const sys = (text) => post({ speaker: 'System', agentId: null, text, thinking: '' });

  const planner = roster.find((a) => a.role === 'planner');
  if (!planner) {
    sys('Mission mode needs a seat with the Planner/Lead role. Set one in the seat\'s settings.');
    return { working, produced };
  }

  // One seat turn against `thread` (the compact main context by default; a
  // breakout array during dispatch). CHECKs resolve with one follow-up turn.
  // Returns the seat's LAST answer this turn (the follow-up when checks ran —
  // it's the one written with real results in context), or null on stop/abort.
  async function turn(agent, dispatch, thread = working, tag = null, followUp = false) {
    // Live interjection: only the main context adopts a mid-run live sync —
    // breakout threads (thread !== working, passed explicitly) are a
    // deliberately isolated sub-context and skip this. `thread` was bound to
    // the pre-sync `working` by the default param above, so re-read `working`
    // after syncLive() to pick up any reassignment.
    if (thread === working) {
      syncLive();
      thread = working;
    }
    // Every seat gets the roster now, not just the planner — spawned
    // specialists included (`roster` grows as SPAWN lines land, below).
    // The planner additionally gets the "@Name is assignable" hint.
    const extras = {
      ...(promptExtras || {}),
      roster: rosterLine(roster, agent, { showModels: showRosterModels, assignable: agent.role === 'planner' }),
    };
    const extraLine = [taskBoard?.() ?? null, dispatch].filter(Boolean).join('\n\n') || null;
    onStatus?.({ phase: 'thinking', agent, followUp });
    let raw;
    try {
      raw = await callAgent(withRolePrompt(agent, 'mission', undefined, extras), buildMessagesFor(agent, thread, extraLine));
    } catch (err) {
      raw = `⚠️ ${agent.name} error: ${err.message}`;
    }
    if (raw === '__ABORTED__' || shouldStop()) return null;
    const { answer, thinking } = splitThinking(raw);
    post({ speaker: agent.name, agentId: agent.id, text: answer, thinking, ts: new Date().toLocaleTimeString() }, thread, tag);

    // CHECK resolution (mission always has file access; writes stay gated by
    // the caller's runCheck). One follow-up turn, same bound as runRound.
    if (runCheck && !followUp) {
      const checks = parseChecks(answer);
      if (checks.length > 0 && !shouldStop()) {
        for (const c of checks) {
          onStatus?.({ phase: 'check', agent, op: c.op, arg: c.arg });
          let result;
          try {
            result = await runCheck({ op: c.op, arg: c.arg, content: c.content, server: c.server, tool: c.tool, args: c.args }, agent);
          } catch (err) {
            result = { ok: false, output: String(err?.message || err) };
          }
          const label = result.ok ? `Check (${c.op} ${c.arg})` : `Check failed (${c.op} ${c.arg})`;
          post({ speaker: 'Tool', agentId: null, text: `${label}:\n${result.output}`, thinking: '' }, thread, tag);
        }
        const followAnswer = await turn(agent, dispatch, thread, tag, true);
        if (followAnswer === null) return null;
        return followAnswer;
      }
    }
    return answer;
  }

  // Let React flush pending board updates (recordTasks runs in the caller's
  // onReply via setState) before we read getTasks().
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // --- 1. Planning turn -------------------------------------------------------
  // Spawns are parsed from EVERYTHING the planner said this phase (a CHECK
  // follow-up may carry the SPAWN/TASK lines, not the first message).
  const planStart = produced.length;
  const planText = await turn(
    planner,
    `[Mission: plan now. Break the user's goal into subtasks and delegate each with "TASK: add <description> @<SeatName>", spawning specialists with "SPAWN: <Name> | <persona>" where no seated specialist fits. Do not do the work yourself this turn.]`,
  );
  if (planText === null) return { working, produced };
  const plannerSaid = produced
    .slice(planStart)
    .filter((e) => e.agentId === planner.id)
    .map((e) => e.text)
    .join('\n');

  for (const spec of parseSpawns(plannerSaid)) {
    let agent = makeSpawnedAgent(spec, planner, roster.map((r) => r.name));
    if (!agent) continue; // name collision = assignment to an existing seat
    agent = onSpawn?.(agent) || agent;
    roster.push(agent);
    sys(`spawned ${agent.name} — ${spec.persona}`);
  }

  // --- 2. Dispatch loop (Phase 2: breakouts) -----------------------------------
  const attempts = new Map(); // task id -> turns used
  const breakouts = new Map(); // task id -> its thread (persists across attempts)
  const reported = new Set(); // task ids whose report reached `working`
  let total = 0;
  while (!shouldStop() && total < maxTotalTurns) {
    await tick();
    const open = (getTasks?.() || []).filter((t) => !t.done && t.assignee);
    const next = open.find((t) => findSeatByName(roster, t.assignee));
    if (!next) {
      // Assigned-but-unseatable tasks would spin forever; surface them once.
      const orphan = open.find((t) => !findSeatByName(roster, t.assignee));
      if (orphan) {
        completeTask?.(orphan.id, 'System');
        sys(`closed #${orphan.id} — no seat named "${orphan.assignee}".`);
        continue;
      }
      break; // board is clear
    }
    const seat = findSeatByName(roster, next.assignee);
    const used = attempts.get(next.id) || 0;

    // The breakout thread: compact main context at first dispatch + this
    // task's own working turns. Closing folds one report into `working`.
    if (!breakouts.has(next.id)) breakouts.set(next.id, [...working]);
    const thread = breakouts.get(next.id);

    const close = (finalText, by) => {
      completeTask?.(next.id, by);
      attempts.set(next.id, maxTurnsPerTask);
      reported.add(next.id);
      if (finalText) {
        // Silent — the bubble already streamed from the breakout; this copy
        // only feeds the planner's (and later seats') context.
        working.push({
          speaker: seat.name,
          agentId: seat.id,
          text: `[Task #${next.id} report — ${next.text}]\n${finalText}`,
          thinking: '',
        });
      }
    };

    if (used >= maxTurnsPerTask) {
      // Out of turns: close with the seat's last breakout answer as the report.
      const lastAnswer = [...thread].reverse().find((e) => e.agentId === seat.id)?.text || '';
      close(lastAnswer, seat.name);
      sys(`closed #${next.id} after ${used} turn${used === 1 ? '' : 's'} — moving on.`);
      continue;
    }
    attempts.set(next.id, used + 1);
    total++;
    const answer = await turn(
      seat,
      used === 0
        ? `[Mission dispatch — ${seat.name}: task #${next.id} is yours: "${next.text}". You are in a breakout thread — work freely; your final message becomes your report to the table. Do the work now, in this reply. End with a brief report for ${planner.name}, then the line "TASK: done #${next.id}".]`
        : `[Mission dispatch — ${seat.name}: task #${next.id} is still open. Finish it now: end with your report for ${planner.name}, then the line "TASK: done #${next.id}".]`,
      thread,
      { breakoutTask: next.id },
    );
    if (answer === null) return { working, produced };
    // The board updates async via the caller's onReply; also read the answer
    // directly so a completed task never gets re-dispatched.
    const closedInline = parseTasks(answer).some(
      (t) => t.op === 'done' && new RegExp(`^#?${next.id}$`).test(t.arg.trim().split(/\s/)[0]),
    );
    if (closedInline) close(answer, seat.name);
  }

  // Safety net: a task can close via the board (recordTasks caught a done line
  // the inline parser missed) without close() running — fold its report in so
  // the planner never synthesizes blind. Attribute the report to whoever the
  // THREAD ENTRY says produced it — never re-derive speaker/agentId from
  // task.assignee via a fresh name lookup. A spawned seat's own reply must
  // carry its own name; re-deriving identity by name here is exactly the
  // kind of indirection that can misattribute a spawned specialist's report
  // to a differently-named seat if the lookup and the actual last speaker
  // ever disagree (bug: a spawned seat's reply rendered under an existing
  // seat's name).
  for (const [taskId, thread] of breakouts) {
    if (reported.has(taskId)) continue;
    const task = (getTasks?.() || []).find((t) => t.id === taskId);
    const lastEntry = [...thread].reverse().find((e) => e.agentId && e.speaker !== 'System');
    if (lastEntry) {
      working.push({
        speaker: lastEntry.speaker,
        agentId: lastEntry.agentId,
        text: `[Task #${taskId} report — ${task?.text ?? ''}]\n${lastEntry.text}`,
        thinking: '',
      });
      reported.add(taskId);
    }
  }

  // --- 3. Synthesis turn -------------------------------------------------------
  if (!shouldStop()) {
    await turn(
      planner,
      `[Mission wrap-up — ${planner.name}: all dispatched tasks are closed. Synthesize the specialists' reports into one final, complete deliverable that answers the user's original goal. If files were written, list them. Do not delegate further.]`,
    );
  }

  return { working, produced };
}
