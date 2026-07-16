// scripts/check-prompt-regression.js
// Verifies the stage-based assembly (promptStages.js) produces output
// byte-identical to the legacy withRolePrompt() concatenation for every
// combination of mode / role / canWrite / provider / systemPrompt.
//
// Run with:  node scripts/check-prompt-regression.js
// (requires "type": "module" handling — easiest: run via `node --input-type`?
//  No — just run it with vite-node or rename imports; simplest path below uses
//  dynamic import so plain `node` works as long as package.json has no
//  conflicting "type". If imports fail, run: npx vite-node scripts/check-prompt-regression.js)

import { buildPromptStages, assemblePrompt } from '../src/promptStages.js';
import {
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
} from '../src/promptText.js';

// --- Reference assembly (the intended spec, stated independently) -----------
// 2026-06-12 spec change: the CHECK tool block is BUILD-mode only. DISCUSS
// keeps seats off the codebase entirely (prompt + runtime enforcement).
// 2026-06-19 spec change: 'subtractor' generalized to a role-directive lookup
// covering subtractor/coder/reviewer/designer (see promptStages.js ROLE_DIRECTIVES).
// 2026-07-01 spec change: TASK_BOARD stage added after the CHECK tool block,
// applies in BOTH modes (planning is discuss-friendly; no file access involved).
// 2026-07-06 spec change: projectInstructions stage added directly after the
// MODE block — the trimmed text of <projectRoot>/ROUNDTABLE.md. When absent
// (no project, no file, or empty file) the stage contributes nothing and the
// assembled prompt must remain byte-identical to the pre-stage output.
// 2026-07-09 spec change (mission mode): 'planner' role directive added;
// 'mission' mode block added; CHECK tool now applies mode !== 'discuss'
// (identical output for discuss/build, extends to mission).
// 2026-07-10 spec change (Phase 3 web tools): WEB_TOOL stage added after the
// CHECK tool block, applies whenever mode !== 'discuss'. seatRoster stage
// (planner-only, mission-time extras) is not covered here — the script passes
// no seatRoster extra, so the stage must contribute nothing.
// 2026-07-11 spec change (MCP integrations): mcpTools stage added after the
// WEB_TOOL block, applies when extras.mcpTools is non-empty AND mode !==
// 'discuss'. When absent (no MCP server connected) the assembled prompt must
// remain byte-identical to the pre-stage output.
// 2026-07-14 spec change (seat git reads): gitTool stage added directly after
// the mcpTools block, applies when extras.gitTool is truthy AND mode !==
// 'discuss'. It teaches read-only CHECK: git status/diff/log. When absent (not
// a git repo) the assembled prompt must remain byte-identical to before.
const ROLE_DIRECTIVES = {
  subtractor: SUBTRACTOR_DIRECTIVE,
  coder: CODER_DIRECTIVE,
  reviewer: REVIEWER_DIRECTIVE,
  designer: DESIGNER_DIRECTIVE,
  planner: PLANNER_DIRECTIVE,
};
function legacyWithRolePrompt(agent, mode = 'build', projectInstructions = '', mcpTools = '', gitTool = false) {
  const parts = [];
  if (agent.systemPrompt) parts.push(agent.systemPrompt.trim());
  parts.push(MODE_BLOCKS[mode] ?? MODE_BLOCKS.build);
  if (projectInstructions && projectInstructions.trim()) parts.push(projectInstructions.trim());
  if (ROLE_DIRECTIVES[agent?.role]) parts.push(ROLE_DIRECTIVES[agent.role]);
  if (mode !== 'discuss') parts.push(agent?.canWrite ? CHECK_TOOL_WRITE : CHECK_TOOL_READONLY);
  if (mode !== 'discuss') parts.push(WEB_TOOL);
  if (mode !== 'discuss' && mcpTools && mcpTools.trim()) parts.push(mcpTools.trim());
  if (mode !== 'discuss' && gitTool) parts.push(GIT_TOOL);
  parts.push(TASK_BOARD);
  if (agent?.provider === 'cli') parts.push(CLI_HONESTY);
  parts.push(BASE_CONSTRAINT);
  return parts.filter(Boolean).join('\n\n');
}

// --- Exhaustive matrix -------------------------------------------------------
const matrix = [];
for (const mode of ['discuss', 'build', 'mission'])
  for (const role of [undefined, 'contributor', 'subtractor', 'coder', 'reviewer', 'designer', 'planner'])
    for (const canWrite of [false, true])
      for (const provider of ['ollama', 'openai', 'anthropic', 'cli'])
        for (const systemPrompt of ['', '  You are Gemma, be curious.  ', 'Line1\nLine2'])
          for (const projectInstructions of ['', 'Use 2-space indent.\nNever touch db/schema.sql.', '  padded instructions  '])
            for (const mcpTools of ['', 'External integrations (MCP):\n  github.search_issues [read] — search issues'])
              for (const gitTool of [false, true])
                matrix.push({ id: 'x', name: 'X', mode, role, canWrite, provider, systemPrompt, projectInstructions, mcpTools, gitTool });

let failures = 0;
for (const agent of matrix) {
  const legacy = legacyWithRolePrompt(agent, agent.mode, agent.projectInstructions, agent.mcpTools, agent.gitTool);
  const staged = assemblePrompt(buildPromptStages(agent, agent.mode, { projectInstructions: agent.projectInstructions, mcpTools: agent.mcpTools, gitTool: agent.gitTool }));
  if (legacy !== staged) {
    failures++;
    console.error('MISMATCH for', {
      mode: agent.mode, role: agent.role, canWrite: agent.canWrite,
      provider: agent.provider, sys: JSON.stringify(agent.systemPrompt),
    });
    // Show first divergence point to make the diff easy to spot.
    let i = 0;
    while (legacy[i] === staged[i]) i++;
    console.error(`  first diff at char ${i}:`);
    console.error('  legacy:', JSON.stringify(legacy.slice(Math.max(0, i - 30), i + 30)));
    console.error('  staged:', JSON.stringify(staged.slice(Math.max(0, i - 30), i + 30)));
  }
}

if (failures === 0) {
  console.log(`OK — ${matrix.length}/${matrix.length} combinations byte-identical.`);
  process.exit(0);
} else {
  console.error(`FAILED — ${failures}/${matrix.length} combinations differ.`);
  process.exit(1);
}
