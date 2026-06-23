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
  CLI_HONESTY,
  SUBTRACTOR_DIRECTIVE,
  CODER_DIRECTIVE,
  REVIEWER_DIRECTIVE,
  DESIGNER_DIRECTIVE,
} from '../src/promptText.js';

// --- Reference assembly (the intended spec, stated independently) -----------
// 2026-06-12 spec change: the CHECK tool block is BUILD-mode only. DISCUSS
// keeps seats off the codebase entirely (prompt + runtime enforcement).
// 2026-06-19 spec change: 'subtractor' generalized to a role-directive lookup
// covering subtractor/coder/reviewer/designer (see promptStages.js ROLE_DIRECTIVES).
const ROLE_DIRECTIVES = {
  subtractor: SUBTRACTOR_DIRECTIVE,
  coder: CODER_DIRECTIVE,
  reviewer: REVIEWER_DIRECTIVE,
  designer: DESIGNER_DIRECTIVE,
};
function legacyWithRolePrompt(agent, mode = 'build') {
  const parts = [];
  if (agent.systemPrompt) parts.push(agent.systemPrompt.trim());
  parts.push(MODE_BLOCKS[mode] ?? MODE_BLOCKS.build);
  if (ROLE_DIRECTIVES[agent?.role]) parts.push(ROLE_DIRECTIVES[agent.role]);
  if (mode === 'build') parts.push(agent?.canWrite ? CHECK_TOOL_WRITE : CHECK_TOOL_READONLY);
  if (agent?.provider === 'cli') parts.push(CLI_HONESTY);
  parts.push(BASE_CONSTRAINT);
  return parts.filter(Boolean).join('\n\n');
}

// --- Exhaustive matrix -------------------------------------------------------
const matrix = [];
for (const mode of ['discuss', 'build'])
  for (const role of [undefined, 'contributor', 'subtractor', 'coder', 'reviewer', 'designer'])
    for (const canWrite of [false, true])
      for (const provider of ['ollama', 'openai', 'anthropic', 'cli'])
        for (const systemPrompt of ['', '  You are Gemma, be curious.  ', 'Line1\nLine2'])
          matrix.push({ id: 'x', name: 'X', mode, role, canWrite, provider, systemPrompt });

let failures = 0;
for (const agent of matrix) {
  const legacy = legacyWithRolePrompt(agent, agent.mode);
  const staged = assemblePrompt(buildPromptStages(agent, agent.mode));
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
