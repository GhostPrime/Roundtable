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
  TASK_BOARD,
  CLI_HONESTY,
  SUBTRACTOR_DIRECTIVE,
  CODER_DIRECTIVE,
  REVIEWER_DIRECTIVE,
  DESIGNER_DIRECTIVE,
} from './promptText.js';

// role is a single select on the agent — one of these, or 'contributor'
// (the default, no directive). Each maps to one directive block + label.
const ROLE_DIRECTIVES = {
  subtractor: { text: SUBTRACTOR_DIRECTIVE, label: 'Subtractor' },
  coder: { text: CODER_DIRECTIVE, label: 'Coder' },
  reviewer: { text: REVIEWER_DIRECTIVE, label: 'Code Reviewer' },
  designer: { text: DESIGNER_DIRECTIVE, label: 'Designer/UX' },
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
export function buildPromptStages(agent, mode = 'build') {
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
      label: mode === 'discuss' ? 'Mode: DISCUSS' : 'Mode: BUILD',
      text: MODE_BLOCKS[mode] ?? MODE_BLOCKS.build,
      applies: true,
      why: 'The gear the whole table is in — forbids or allows implementation.',
    },
    {
      id: 'roleDirective',
      label: `Role: ${roleDirective(agent)?.label ?? 'Contributor'}`,
      text: roleDirective(agent)?.text ?? '',
      applies: !!roleDirective(agent),
      why: 'Role directive — only for seats with a non-default role (subtractor/coder/reviewer/designer).',
    },
    {
      id: 'checkTool',
      label: agent?.canWrite ? 'Check tool (read + write)' : 'Check tool (read-only)',
      text: agent?.canWrite ? CHECK_TOOL_WRITE : CHECK_TOOL_READONLY,
      applies: mode === 'build',
      why: 'Teaches the CHECK syntax. BUILD only — DISCUSS keeps seats off the codebase.',
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
export function withRolePrompt(agent, mode = 'build', disabled = undefined) {
  return {
    ...agent,
    systemPrompt: assemblePrompt(buildPromptStages(agent, mode), disabled),
  };
}
