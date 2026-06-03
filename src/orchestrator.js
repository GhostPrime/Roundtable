// Turns a shared transcript into per-agent message arrays and drives the
// auto back-and-forth. Kept UI-free so it's easy to reason about.
//
// Transcript entry: { speaker, agentId|null, text, thinking? }
// Agent: { id, name, provider, model, systemPrompt, role? }
//   role: 'contributor' (default) | 'subtractor'

export function buildMessagesFor(agent, transcript) {
  return transcript.map((entry) => {
    const mine = entry.agentId === agent.id;
    if (mine) return { role: 'assistant', content: entry.text };
    return { role: 'user', content: `${entry.speaker}: ${entry.text}` };
  });
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

// ---------------------------------------------------------------------------
// The generative bias — a softened gate. It steers seats toward substance
// without vetoing turns, so cautious models (e.g. DeepSeek/Whale) still
// participate instead of abstaining into silence. Earn your turn by adding
// something; just don't pad.
// ---------------------------------------------------------------------------
const BASE_CONSTRAINT = [
  'How to take a turn:',
  'Speak when you have something that adds to the discussion — a decision,',
  'a concrete proposal, a checkable claim, or a real critique of what was said.',
  'Prefer substance over agreement: if you only agree, build on the point or',
  'sharpen it rather than restating it. Do not pad, do not re-pitch an idea',
  'already on the table, and do not bounce the question back to the human.',
  'Add at most one new idea per turn. Keep it tight.',
].join('\n');

// Table mode — the gear the whole roundtable is in. DISCUSS forbids jumping to
// implementation so the table actually understands the problem; BUILD allows it.
const DISCUSS_MODE = [
  'MODE: DISCUSS — understanding, not building.',
  'Do NOT write code, pseudo-code, config, or commands. Do not propose specific',
  'implementations, file names, libraries, or APIs. Code is off the table this',
  'round. Your job: clarify what is actually being asked, surface hidden',
  'assumptions, question whether this should be built at all, and argue about the',
  'approach in plain language. If you catch yourself reaching for an',
  'implementation, stop and ask what problem it would actually solve.',
].join('\n');

const BUILD_MODE = [
  'MODE: BUILD — implementation welcome.',
  'Concrete solutions, code, file names, and technical specifics are fair game.',
  'Still resist building before the goal is clear — but you may propose and write',
  'implementations.',
].join('\n');

export const MODES = ['discuss', 'build'];
function modeBlock(mode) {
  return mode === 'discuss' ? DISCUSS_MODE : BUILD_MODE;
}

// Read-only check capability. Seats can verify real facts about the project by
// emitting a CHECK line; the app runs it and feeds the real result back. This
// replaces blind "I confirmed the file exists" narration with actual lookups.
// What they STILL can't do: write, run commands, launch, or approve anything.
const CHECK_TOOL = [
  'Checking real facts (read-only):',
  'You can look up real, current facts about this project. To do so, end your',
  'message with one or more CHECK lines, each on its own line, then stop:',
  '  CHECK: list_dir <path>     — list files in a folder (path relative to project root)',
  '  CHECK: read_file <path>    — read a text file',
  '  CHECK: exists <path>       — print true/false whether a path exists',
  'Example:  CHECK: exists fridge.html',
  'The real result is added to the conversation and you get another turn to use',
  'it. Use at most 3 checks per turn. NEVER claim you read, listed, confirmed, or',
  'verified anything unless an actual CHECK result for it appears in the',
  'transcript. You still cannot write files, run commands, launch apps, or',
  'approve anything — describe those as steps for the user to perform.',
].join('\n');

// CLI seats can additionally execute through their terminal; keep them honest.
const CLI_HONESTY = [
  'You may also run real actions through your CLI. Only report an action as done',
  'after it actually completed, and report results truthfully — never invent',
  'output, file contents, or confirmations.',
].join('\n');

function hasHands(agent) {
  return agent?.provider === 'cli';
}

// --- Read-only check parsing/execution loop ---------------------------------
const CHECK_RE = /^\s*CHECK:\s*(read_file|list_dir|exists)\s+(.+?)\s*$/gim;
const MAX_CHECKS_PER_TURN = 3;

// Pull CHECK requests out of a reply. Returns [{ op, arg, raw }].
export function parseChecks(text) {
  const out = [];
  if (!text) return out;
  let m;
  CHECK_RE.lastIndex = 0;
  while ((m = CHECK_RE.exec(text)) !== null && out.length < MAX_CHECKS_PER_TURN) {
    out.push({ op: m[1], arg: m[2].trim(), raw: m[0].trim() });
  }
  return out;
}

// #2 — Role directive injected for subtractor seats. Makes the role structural
// rather than a hand-written prompt convention.
const SUBTRACTOR_DIRECTIVE = [
  'Your role at this table is SUBTRACTOR.',
  'Kill weak ideas. Force exactly one decision per round.',
  'Remove scope rather than adding it. Add no new open questions.',
  'Never bounce the prompt back to the human. End with a concrete call.',
].join('\n');

export function isSubtractor(agent) {
  return agent?.role === 'subtractor';
}

// Returns the agent with role + table constraints folded into systemPrompt.
export function withRolePrompt(agent, mode = 'build') {
  const parts = [];
  if (agent.systemPrompt) parts.push(agent.systemPrompt.trim());
  parts.push(modeBlock(mode));
  if (isSubtractor(agent)) parts.push(SUBTRACTOR_DIRECTIVE);
  parts.push(CHECK_TOOL);
  if (hasHands(agent)) parts.push(CLI_HONESTY);
  parts.push(BASE_CONSTRAINT);
  return { ...agent, systemPrompt: parts.filter(Boolean).join('\n\n') };
}

// #2 — Stable ordering: contributors first (original order), subtractors last,
// so subtractors react to what was added this round.
export function orderSeats(agents) {
  const contributors = agents.filter((a) => !isSubtractor(a));
  const subtractors = agents.filter((a) => isSubtractor(a));
  return [...contributors, ...subtractors];
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
}) {
  let working = [...transcript];
  const produced = [];
  const seats = orderSeats(agents);

  // Run any CHECK requests in `text`, append a Tool entry per result, and
  // return true if at least one ran (so the caller can give the seat a
  // follow-up turn with the real results in context).
  async function resolveChecks(text) {
    if (!runCheck) return false;
    const checks = parseChecks(text);
    if (checks.length === 0) return false;
    for (const c of checks) {
      let result;
      try {
        result = await runCheck({ op: c.op, arg: c.arg });
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
    try {
      raw = await callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working));
    } catch (err) {
      failed = true;
      raw = `⚠️ ${agent.name} error: ${err.message}`;
    }

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

    // If the seat asked for read-only checks, run them and give it one
    // follow-up turn with the real results in context. Bounded to a single
    // follow-up per turn so a seat can't loop on checks forever.
    if (!shouldStop()) {
      const ran = await resolveChecks(answer);
      if (ran) {
        let followRaw;
        try {
          followRaw = await callAgent(withRolePrompt(agent, mode), buildMessagesFor(agent, working));
        } catch (err) {
          followRaw = `⚠️ ${agent.name} error: ${err.message}`;
        }
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
