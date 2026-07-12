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
export const MODES = ['discuss', 'build', 'mission'];

// --- Check parsing/execution loop -------------------------------------------
const CHECK_RE = /^\s*CHECK:\s*(read_file|list_dir|exists|write_file|web_search|fetch_url|mcp)\s+(.+?)\s*$/gim;
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
      const content = fenceMatch ? fenceMatch[1] : '';
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
}) {
  let working = [...transcript];
  const produced = [];
  const seats = orderSeats(agents);

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

    let raw;
    let failed = false;
    onStatus?.({ phase: 'thinking', agent });
    try {
      raw = await callAgent(withRolePrompt(agent, mode, undefined, promptExtras), buildMessagesFor(agent, working, taskBoard?.() ?? null));
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
        onStatus?.({ phase: 'thinking', agent, followUp: true });
        let followRaw;
        try {
          followRaw = await callAgent(withRolePrompt(agent, mode, undefined, promptExtras), buildMessagesFor(agent, working, taskBoard?.() ?? null));
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
  maxTurnsPerTask = 2,
  maxTotalTurns = 16,
}) {
  // `working` is the COMPACT main context: user goal, planner turns, system
  // notes, and one report message per closed task. Breakout turns never enter
  // it. Mutable array — post() pushes.
  const working = [...transcript];
  const produced = [];
  const roster = [...agents];

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

  const rosterLine = () =>
    'Currently seated (assignable with @Name):\n' +
    roster.map((a) => `  ${a.name} — ${a.role || 'contributor'}${a.spawned ? ' (spawned)' : ''}`).join('\n');

  // One seat turn against `thread` (the compact main context by default; a
  // breakout array during dispatch). CHECKs resolve with one follow-up turn.
  // Returns the seat's LAST answer this turn (the follow-up when checks ran —
  // it's the one written with real results in context), or null on stop/abort.
  async function turn(agent, dispatch, thread = working, tag = null, followUp = false) {
    const extras =
      agent.role === 'planner' ? { ...(promptExtras || {}), seatRoster: rosterLine() } : promptExtras;
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
  // the planner never synthesizes blind.
  for (const [taskId, thread] of breakouts) {
    if (reported.has(taskId)) continue;
    const task = (getTasks?.() || []).find((t) => t.id === taskId);
    const lastAnswer = [...thread].reverse().find((e) => e.agentId && e.speaker !== 'System')?.text || '';
    if (lastAnswer) {
      working.push({
        speaker: findSeatByName(roster, task?.assignee)?.name || 'Specialist',
        agentId: findSeatByName(roster, task?.assignee)?.id ?? null,
        text: `[Task #${taskId} report — ${task?.text ?? ''}]\n${lastAnswer}`,
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
