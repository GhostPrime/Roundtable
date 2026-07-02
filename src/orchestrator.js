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
export const MODES = ['discuss', 'build'];

// --- Check parsing/execution loop -------------------------------------------
const CHECK_RE = /^\s*CHECK:\s*(read_file|list_dir|exists|write_file)\s+(.+?)\s*$/gim;
const MAX_CHECKS_PER_TURN = 3;

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
const MAX_TASKS_PER_TURN = 3;

export function parseTasks(text) {
  const out = [];
  if (!text) return out;
  const cleaned = stripDirectiveDecoration(text, 'TASK');
  let m;
  TASK_RE.lastIndex = 0;
  while ((m = TASK_RE.exec(cleaned)) !== null && out.length < MAX_TASKS_PER_TURN) {
    out.push({ op: m[1].toLowerCase(), arg: m[2].trim() });
  }
  return out;
}

// #2 — Stable ordering by role tier, original order preserved within a tier:
//   0  designer  — sets direction/UX before anything is built
//   1  contributor, coder (and any other/unknown role) — does the work
//   2  reviewer, subtractor — react to what was added this round
// This generalizes the old contributor-first/subtractor-last split: a table
// with only contributor/subtractor seats orders identically to before.
function seatTier(agent) {
  if (agent?.role === 'designer') return 0;
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
        result = await runCheck({ op: c.op, arg: c.arg, content: c.content }, agent);
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
      raw = await callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working, taskBoard?.() ?? null));
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
          followRaw = await callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working, taskBoard?.() ?? null));
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
