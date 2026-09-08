// promptStages.js — stage-based prompt assembly.
//
// The system prompt a seat receives is built from discrete, named stages
// instead of opaque string concatenation. This is the data source for the
// Prompt Flow Canvas, and (later) the hook for live per-stage toggles:
// assembling from `stages.filter(enabled)` means a toggle is one boolean.
//
// IMPORTANT: with no stages disabled, assemblePrompt() must produce output
// byte-identical to the old withRolePrompt() concatenation. See
// scripts/check-prompt-regression.js.

import {
  // these move here from orchestrator.js (or re-export from there — see notes)
  MODE_BLOCKS,
  BASE_CONSTRAINT,
  CHECK_TOOL_READONLY,
  CHECK_TOOL_WRITE,
  WEB_TOOL,
  GIT_TOOL,
  TASK_BOARD,
  CLI_HONESTY,
  SUBTRACTOR_DIRECTIVE,
  CODER_DIRECTIVE,
  REVIEWER_DIRECTIVE,
  DESIGNER_DIRECTIVE,
  PLANNER_DIRECTIVE,
  DISCUSS_ROLE_OVERRIDES,
  POLL_NOTE,
  PROOF_RULE,
} from './promptText.js';

// role is a single select on the agent — one of these, or 'contributor'
// (the default, no directive). Each maps to one directive block + label.
const ROLE_DIRECTIVES = {
  subtractor: { text: SUBTRACTOR_DIRECTIVE, label: 'Subtractor' },
  coder: { text: CODER_DIRECTIVE, label: 'Coder' },
  reviewer: { text: REVIEWER_DIRECTIVE, label: 'Code Reviewer' },
  designer: { text: DESIGNER_DIRECTIVE, label: 'Designer/UX' },
  planner: { text: PLANNER_DIRECTIVE, label: 'Planner/Lead' },
};

export function isSubtractor(agent) {
  return agent?.role === 'subtractor';
}

export function isReviewer(agent) {
  return agent?.role === 'reviewer';
}

export function isCoder(agent) {
  return agent?.role === 'coder';
}

export function isDesigner(agent) {
  return agent?.role === 'designer';
}

export function isPlanner(agent) {
  return agent?.role === 'planner';
}

// The role directive for this seat IN THIS MODE. In discuss, roles whose normal
// directive orders implementation (coder/reviewer/planner) get a discuss variant
// instead — see DISCUSS_ROLE_OVERRIDES in promptText.js. Without this the last
// instruction a coding seat reads is "write real, specific code", assembled
// after the DISCUSS block, and it wins.
function roleDirective(agent, mode = 'build') {
  const base = ROLE_DIRECTIVES[agent?.role];
  if (!base) return null;
  const override = mode === 'discuss' ? DISCUSS_ROLE_OVERRIDES[agent.role] : null;
  return override
    ? { text: override, label: `${base.label} (discuss)`, overridden: true }
    : base;
}

function hasHands(agent) {
  return agent?.provider === 'cli';
}

// Build the ordered stage list for one seat. Every stage:
//   id      — stable key (used for toggles + persistence later)
//   label   — human name shown on the canvas
//   text    — exact text contributed to the system prompt ('' if not applicable)
//   applies — whether this stage is active for THIS agent/mode (vs. structurally
//             absent). Canvas shows non-applying stages greyed out, so you can
//             see what a seat is NOT getting and why.
//   why     — one-line explanation shown on the node
export function buildPromptStages(agent, mode = 'build', extras = {}) {
  // Poll turns run every seat in parallel against a frozen transcript, so the
  // whole tool surface is off: a poll that stops to run checks or fires TASK
  // lines from five seats at once is neither fast nor parallel, and five
  // simultaneous write approvals are unusable. Extras-gated, so a caller that
  // never sets it (including check-prompt-regression.js) sees no change.
  const polling = !!extras?.poll;
  return [
    {
      id: 'system',
      label: 'Agent system prompt',
      text: agent.systemPrompt ? agent.systemPrompt.trim() : '',
      applies: !!agent.systemPrompt,
      why: 'The persona/instructions you wrote for this seat.',
    },
    {
      id: 'mode',
      label: `Mode: ${(mode in MODE_BLOCKS ? mode : 'build').toUpperCase()}`,
      text: MODE_BLOCKS[mode] ?? MODE_BLOCKS.build,
      applies: true,
      why: 'The gear the whole table is in — forbids or allows implementation.',
    },
    {
      id: 'projectInstructions',
      label: 'Project instructions (ROUNDTABLE.md)',
      text: extras?.projectInstructions ? String(extras.projectInstructions).trim() : '',
      applies: !!(extras?.projectInstructions && String(extras.projectInstructions).trim()),
      why: 'Standing instructions from ROUNDTABLE.md in the active project root — this project\'s CLAUDE.md equivalent. Absent when no project or no file.',
    },
    {
      id: 'memory',
      label: 'Shared memory (cross-session)',
      text: extras?.memory ? String(extras.memory).trim() : '',
      applies: !!(extras?.memory && String(extras.memory).trim()),
      why: 'Facts saved with MEMO: lines in earlier sessions of this project, plus the MEMO syntax. Extras-gated — absent, prompts are byte-identical to before.',
    },
    {
      id: 'roleDirective',
      label: `Role: ${roleDirective(agent, mode)?.label ?? 'Contributor'}`,
      text: roleDirective(agent, mode)?.text ?? '',
      applies: !!roleDirective(agent, mode),
      why: roleDirective(agent, mode)?.overridden
        ? 'Role directive, DISCUSS variant — the normal one orders implementation, which would override the mode block sitting above it.'
        : 'Role directive — only for seats with a non-default role (subtractor/coder/reviewer/designer/planner).',
    },
    {
      id: 'seatRoster',
      label: 'Seat roster',
      text: extras?.roster ? String(extras.roster).trim() : '',
      applies: !!(extras?.roster && String(extras.roster).trim()),
      why: 'Who else is at the table, their roles, and speaking order — every seat in every mode, not just the mission planner. Built per-recipient (marks "(you)") by orchestrator.js\'s rosterLine(). Extras-gated — absent, prompts are byte-identical to before (see check-prompt-regression.js, which never supplies this extra).',
    },
    {
      id: 'proofRule',
      label: 'Proof rule (done = confirmed)',
      text: PROOF_RULE,
      applies: mode !== 'discuss' && !polling,
      why: 'States once, positively, that work counts as done only when a Tool result proves it — the five per-tool "NEVER claim…" negatives below were advisory and seats still declared finished work that had never landed. Backed by parseClaims() flagging unsupported completion claims in the transcript. Absent in DISCUSS/poll turns, which have no tools to be honest about.',
    },
    {
      id: 'checkTool',
      label: agent?.canWrite ? 'Check tool (read + write)' : 'Check tool (read-only)',
      text: agent?.canWrite ? CHECK_TOOL_WRITE : CHECK_TOOL_READONLY,
      applies: mode !== 'discuss' && !polling,
      why: 'Teaches the CHECK syntax. BUILD/MISSION only — DISCUSS keeps seats off the codebase.',
    },
    {
      id: 'webTool',
      label: 'Web tool (search + fetch)',
      text: WEB_TOOL,
      applies: mode !== 'discuss' && !polling,
      why: 'Teaches web_search/fetch_url. BUILD/MISSION only — DISCUSS stays tool-free.',
    },
    {
      id: 'mcpTools',
      label: 'Integrations (MCP tools)',
      text: extras?.mcpTools ? String(extras.mcpTools).trim() : '',
      applies: !!(extras?.mcpTools && String(extras.mcpTools).trim()) && mode !== 'discuss' && !polling,
      why: 'Teaches CHECK: mcp calls for connected services (GitHub, Drive, Gmail, …). Absent when no server is connected; DISCUSS stays tool-free.',
    },
    {
      id: 'gitTool',
      label: 'Git reads (status/diff/log)',
      text: extras?.gitTool ? GIT_TOOL : '',
      applies: !!extras?.gitTool && mode !== 'discuss' && !polling,
      why: 'Teaches read-only CHECK: git status/diff/log for the active repo. Absent when the project is not a git repo; DISCUSS stays tool-free. Writes stay human-only.',
    },
    {
      id: 'taskBoard',
      label: 'Shared task board',
      text: TASK_BOARD,
      applies: mode !== 'discuss' && !polling,
      why: 'Teaches the TASK: add/done syntax. BUILD/MISSION/LOOP only — "break the goal into steps" reads as a build order in DISCUSS, which is half of why seats kept implementing there. The board itself still works; seats just are not prompted to drive it.',
    },
    {
      id: 'cliHonesty',
      label: 'CLI honesty clause',
      text: CLI_HONESTY,
      applies: hasHands(agent),
      why: 'Extra truthfulness rules for seats that can run real terminal actions.',
    },
    {
      id: 'baseConstraint',
      label: 'Turn-taking constraint',
      text: BASE_CONSTRAINT,
      applies: true,
      why: 'The generative bias — earn your turn, no padding, one idea per turn.',
    },
    {
      id: 'poll',
      label: 'Poll turn',
      text: polling ? POLL_NOTE : '',
      applies: polling,
      why: 'Only on a "Poll the table" turn. Deliberately assembled AFTER the turn-taking constraint so it is the last thing read: a poll inverts it (independent full answers, overlap is signal, no one-idea limit). Extras-gated — absent, prompts are byte-identical.',
    },
  ];
}

// Assemble the final system prompt from stages. `disabled` is a Set of stage
// ids to skip (empty/omitted = exact legacy behavior).
export function assemblePrompt(stages, disabled = new Set()) {
  return stages
    .filter((s) => s.applies && !disabled.has(s.id))
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
}

// Drop-in replacement for the old withRolePrompt. Third arg is the future
// live-toggle hook; nothing passes it yet, so behavior is unchanged.
//
// `mode` is stamped onto the returned agent so it survives the trip to the
// main process: every seat turn calls api.callAgent() with THIS object, and
// main.js needs to know the table is in Discuss to withhold a CLI seat's
// project cwd and write approvals (a claude/qwen seat is a real coding agent
// whose own tools our CHECK gate never saw). It can only remove capability
// there, never grant it, so a renderer-supplied value is safe.
export function withRolePrompt(agent, mode = 'build', disabled = undefined, extras = undefined) {
  return {
    ...agent,
    mode,
    systemPrompt: assemblePrompt(buildPromptStages(agent, mode, extras || {}), disabled),
  };
}
// (mission-mode stages added 2026-07-09)
