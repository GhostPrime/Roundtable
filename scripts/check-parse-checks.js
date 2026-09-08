// scripts/check-parse-checks.js
// Guards the CHECK-line parser — specifically that NO CHECK line can be
// silently dropped.
//
// The bug this exists to prevent: CHECK_RE used to be an alternation of the
// valid ops, so a line naming an op we don't know matched nothing, fell
// through parseChecks, and rendered in the transcript as ordinary prose. No
// tool bubble, no error, no log line. The overwhelmingly common instance was a
// dropped `mcp` keyword — seats wrote "CHECK: blender.get_objects_summary"
// because that's the shape the tool catalog listed — and every such call
// vanished. From the seat's side the integration was a black hole, so it
// concluded the tool was broken and fell back to hand-written scripts. One
// session even wrote "the MCP channel cannot be verified" into cross-session
// memory, which would have poisoned every later session.
//
// Two defences, both asserted below:
//   1. the dropped-keyword shorthand is RECOVERED (it has one meaning)
//   2. anything else unrecognised becomes op:'unknown_op' — a real, failing
//      check the seat is told about — never prose
//
// Run:  node --experimental-default-type=module scripts/check-parse-checks.js
import { parseChecks } from '../src/orchestrator.js';

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);
const one = (text) => parseChecks(text)[0];

// ---- the exact lines from the Blender session that silently vanished -------
const blender = parseChecks(
  'Here is the plan.\n' +
    'CHECK: blender.get_screenshot_of_window_as_image {"size_limit_in_bytes": 500000}',
);
ok('dropped-keyword call is parsed at all', blender.length === 1);
ok('…routed to mcp', blender[0]?.op === 'mcp');
ok('…server extracted', blender[0]?.server === 'blender');
ok('…tool extracted', blender[0]?.tool === 'get_screenshot_of_window_as_image');
ok('…inline JSON args kept', /size_limit_in_bytes/.test(blender[0]?.args || ''));

const noArgs = one('CHECK: blender.get_objects_summary');
ok('no-argument tool call parses', noArgs?.op === 'mcp' && noArgs?.tool === 'get_objects_summary');
ok('…with empty args', !noArgs?.args);

// A catalog line copied wholesale, [write] marker and all.
const copied = one('CHECK: blender.execute_blender_code [write]');
ok('copied catalog line still resolves the tool',
   copied?.op === 'mcp' && copied?.tool === 'execute_blender_code');
const copiedFull = one('CHECK: mcp blender.execute_blender_code  [write] — Execute Python code…');
ok('…even with the trailing description', copiedFull?.tool === 'execute_blender_code');

// ---- the canonical forms must be untouched --------------------------------
const canon = one('CHECK: mcp blender.get_objects_summary {"a": 1}');
ok('canonical mcp form unchanged', canon?.op === 'mcp' && canon?.server === 'blender');
ok('…args intact', /"a"/.test(canon?.args || ''));
ok('read_file unchanged', one('CHECK: read_file src/App.jsx')?.op === 'read_file');
ok('read_file arg intact', one('CHECK: read_file src/App.jsx')?.arg === 'src/App.jsx');
ok('list_dir unchanged', one('CHECK: list_dir src')?.op === 'list_dir');
ok('exists unchanged', one('CHECK: exists index.html')?.op === 'exists');
ok('web_search unchanged', one('CHECK: web_search ollama cuda error')?.op === 'web_search');
ok('fetch_url unchanged', one('CHECK: fetch_url https://example.com')?.op === 'fetch_url');
ok('git unchanged', one('CHECK: git status')?.op === 'git');

const wf = one('CHECK: write_file src/a.js\n```\nconst a = 1;\n```');
ok('write_file still grabs its fence', wf?.op === 'write_file' && wf?.content === 'const a = 1;\n');

// ---- nothing is silently dropped ------------------------------------------
const bogus = one('CHECK: frobnicate everything');
ok('unknown op becomes a real check', bogus?.op === 'unknown_op');
ok('…carrying what was actually written', bogus?.arg === 'frobnicate everything');
ok('near-miss op is reported', one('CHECK: readfile src/a.js')?.op === 'unknown_op');
ok('another near-miss is reported', one('CHECK: search_web ollama')?.op === 'unknown_op');
ok('a CHECK line ALWAYS yields something', parseChecks('CHECK: anything at all').length === 1);

// ---- fenced args: JSON only ------------------------------------------------
const pyFence = one(
  'CHECK: mcp blender.execute_blender_code\n' +
    '```python\n' +
    'bpy.ops.transform.translate(value={"x": 1})\n' +
    '```',
);
ok('a ```python fence is NOT scraped for args', !pyFence?.args);
const jsonFence = one('CHECK: mcp blender.execute_blender_code\n```json\n{"code": "print(1)"}\n```');
ok('a ```json fence IS used as args', /"code"/.test(jsonFence?.args || ''));
const bareFence = one('CHECK: mcp blender.execute_blender_code\n```\n{"code": "print(1)"}\n```');
ok('an untagged fence is used as args', /"code"/.test(bareFence?.args || ''));

// ---- limits and hygiene ----------------------------------------------------
ok('still capped at 3 checks/turn',
   parseChecks('CHECK: exists a\nCHECK: exists b\nCHECK: exists c\nCHECK: exists d').length === 3);
ok('no CHECK lines → no checks', parseChecks('just talking about CHECK: things inline').length === 0);
ok('empty input is safe', parseChecks('').length === 0);
ok('markdown decoration still stripped', one('**CHECK: exists a.txt**')?.op === 'exists');

for (const [r, n] of t) console.log(`${r}  ${n}`);
const f = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - f}/${t.length} passed`);
process.exit(f ? 1 : 0);
