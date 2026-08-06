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

function roleDirective(agent) {
  return ROLE_DIRECTIVES[agent?.role] || null;
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
      label: `Role: ${roleDirective(agent)?.label ?? 'Contributor'}`,
      text: roleDirective(agent)?.text ?? '',
      applies: !!roleDirective(agent),
      why: 'Role directive — only for seats with a non-default role (subtractor/coder/reviewer/designer).',
    },
    {
      id: 'seatRoster',
      label: 'Seat roster',
      text: extras?.roster ? String(extras.roster).trim() : '',
      applies: !!(extras?.roster && String(extras.roster).trim()),
      why: 'Who else is at the table, their roles, and speaking order — every seat in every mode, not just the mission planner. Built per-recipient (marks "(you)") by orchestrator.js\'s rosterLine(). Extras-gated — absent, prompts are byte-identical to before (see check-prompt-regression.js, which never supplies this extra).',
    },
    {
      id: 'checkTool',
      label: agent?.canWrite ? 'Check tool (read + write)' : 'Check tool (read-only)',
      text: agent?.canWrite ? CHECK_TOOL_WRITE : CHECK_TOOL_READONLY,
      applies: mode !== 'discuss',
      why: 'Teaches the CHECK syntax. BUILD/MISSION only — DISCUSS keeps seats off the codebase.',
    },
    {
      id: 'webTool',
      label: 'Web tool (search + fetch)',
      text: WEB_TOOL,
      applies: mode !== 'discuss',
      why: 'Teaches web_search/fetch_url. BUILD/MISSION only — DISCUSS stays tool-free.',
    },
    {
      id: 'mcpTools',
      label: 'Integrations (MCP tools)',
      text: extras?.mcpTools ? String(extras.mcpTools).trim() : '',
      applies: !!(extras?.mcpTools && String(extras.mcpTools).trim()) && mode !== 'discuss',
      why: 'Teaches CHECK: mcp calls for connected services (GitHub, Drive, Gmail, …). Absent when no server is connected; DISCUSS stays tool-free.',
    },
    {
      id: 'gitTool',
      label: 'Git reads (status/diff/log)',
      text: extras?.gitTool ? GIT_TOOL : '',
      applies: !!extras?.gitTool && mode !== 'discuss',
      why: 'Teaches read-only CHECK: git status/diff/log for the active repo. Absent when the project is not a git repo; DISCUSS stays tool-free. Writes stay human-only.',
    },
    {
      id: 'taskBoard',
      label: 'Shared task board',
      text: TASK_BOARD,
      applies: true,
      why: 'Teaches the TASK: add/done syntax — planning works in both modes.',
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
export function withRolePrompt(agent, mode = 'build', disabled = undefined, extras = undefined) {
  return {
    ...agent,
    systemPrompt: assemblePrompt(buildPromptStages(agent, mode, extras || {}), disabled),
  };
}
// (mission-mode stages added 2026-07-09)
