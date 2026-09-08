// scripts/check-session-html.js
// Checks the "share this conversation" HTML export.
//
// Two jobs. First, the assembly itself: escaping of anything that isn't
// markdown, poll replies staying labelled as blind answers, and — the one with
// real consequences — tool results being genuinely ABSENT from the share-safe
// variant rather than merely collapsed, since those carry file contents,
// fetched pages and integration output into a file whose whole purpose is
// being sent to someone else.
//
// Second, a guard that already earned its keep: Markdown.jsx emits its own
// class names (.md-h, .md-p, .md-code…) instead of semantic tags, so an export
// stylesheet written against <h2>/<pre> styles NOTHING and the bug is invisible
// until you open the file. This reads Markdown.jsx as text and asserts every
// class it can emit is covered by the export's inlined CSS — which also catches
// classes the fixture below never exercises.
//
// Run:  node --experimental-default-type=module scripts/check-session-html.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sessionHtml, EXPORT_CSS } from '../src/sessionHtml.js';

const here = dirname(fileURLToPath(import.meta.url));

const agents = [
  { id: 'a', name: 'Qwen', color: '#a1c4fd' },
  { id: 'b', name: 'Claude', color: '#ffd3a5' },
];
const transcripts = {
  group: [
    { speaker: 'You', agentId: null, text: 'Ship it? <script>alert(1)</script>' },
    {
      speaker: 'System', agentId: null, pollHeader: true, pollId: 'p1',
      text: 'Poll — 2 seats answering this independently, none seeing the others.',
    },
    {
      speaker: 'Qwen', agentId: 'a', text: '## No\n\nThe sync layer leaks.',
      pollId: 'p1', pollIndex: 0, pollTotal: 2,
    },
    {
      speaker: 'Claude', agentId: 'b', text: 'Yes — ship, then fix forward.',
      pollId: 'p1', pollIndex: 1, pollTotal: 2,
    },
    { speaker: 'Tool', agentId: null, text: 'Check (read_file .env):\nAPI_KEY=super-secret-value' },
    { speaker: 'Qwen', agentId: 'a', text: 'Fine.', breakoutTask: 3 },
    // A failed turn. An export is the copy that gets sent to someone who was
    // never at the table, so it has to explain this the same way the app does.
    {
      speaker: 'Claude', agentId: 'b',
      text: '⚠️ Claude error: Error invoking remote method \'agent:call\': Error: '
        + '"C:\\Users\\GhostPrime\\.local\\bin\\claude.exe" exited with code 1. '
        + 'Failed to authenticate: OAuth session expired and could not be refreshed',
    },
  ],
};
const tasks = [{ id: 1, text: 'Fix the sync layer', done: false, by: 'Qwen' }];

// Stand-in for the real Markdown component (see sessionHtml.js on why the
// renderer is injected). Marks its output so the assembly can be checked
// without compiling JSX.
const renderBody = (text) => `<div class="md-p">[md]${text}</div>`;

const opts = {
  sessionName: 'Sync rewrite', transcripts, agents, tasks, renderBody,
  now: new Date('2026-08-19T12:00:00Z'),
};
const full = sessionHtml({ ...opts, includeTools: true });
const safe = sessionHtml({ ...opts, includeTools: false });

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);

// ---- document shape --------------------------------------------------------
ok('is a complete document', full.startsWith('<!doctype html>') && full.trim().endsWith('</html>'));
ok('self-contained: no external refs', !/<script|src="http|href="http/i.test(full));
ok('inlines its stylesheet', full.includes('<style>') && full.includes('.msg'));
ok('titles the session', full.includes('<title>Sync rewrite'));
ok('lists the seats with their colors', full.includes('#a1c4fd') && full.includes('#ffd3a5'));

// ---- escaping (everything not routed through the markdown renderer) --------
ok('escapes script tags in your own messages', !full.includes('<script>alert(1)</script>'));
ok('…and keeps the text readable', full.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

// ---- the content that matters ----------------------------------------------
ok('seat replies go through the markdown renderer', full.includes('[md]## No'));
ok('poll replies badged as blind', (full.match(/answered blind/g) || []).length === 2);
ok('poll badge numbers each seat', full.includes('poll 1/2') && full.includes('poll 2/2'));
ok('poll header rendered', full.includes('none seeing the others'));
ok('breakout badge carried through', full.includes('↳ #3'));
ok('task board rendered', full.includes('Fix the sync layer'));

// ---- tool output: the share-safety contract --------------------------------
ok('FULL export contains tool output', full.includes('API_KEY=super-secret-value'));
ok('FULL export collapses it behind <details>', full.includes('<details class="tool">'));
ok('SAFE export omits the secret entirely', !safe.includes('API_KEY=super-secret-value'));
ok('SAFE export omits the tool element', !safe.includes('<details class="tool">'));
ok('SAFE export says what it left out', /1 tool result .* left out/.test(safe));
ok('SAFE export keeps the conversation', safe.includes('fix forward'));

// ---- failed turns ----------------------------------------------------------
// The export must not hand someone the raw IPC/Windows-path wording that the
// app now hides. Same explainError(), same words, both surfaces.
ok('a failed turn is rendered as an error card', full.includes('<details class="body err">'));
ok('…collapsed to a single headline row', full.includes('<summary class="err-title">'));
ok('…and the row is marked', /class="msg\s+\S*\s*errored"|class="msg[^"]*errored/.test(full));
ok('…with a plain-English headline', full.includes('>Sign-in expired</summary>'));
ok('…that does not repeat the seat name it sits under',
   !/<summary class="err-title">[^<]*Claude/.test(full));
ok('…and the command to fix it', full.includes('<code>claude</code>'));
ok('…the IPC wrapper is gone from the headline',
   !/invoking remote method[^<]*<\/div>/.test(full));
ok('…but the provider\'s exact words are still there',
   full.includes('OAuth session expired') && full.includes('<pre class="err-raw">'));
ok('…behind the same one disclosure, not two', (full.match(/<details class="body err">/g) || []).length === 1);
ok('…escaped, not injected', full.includes('&quot;C:\\Users\\GhostPrime'));
ok('…and it does NOT go through the markdown renderer',
   !full.includes('[md]⚠️'));
ok('ordinary replies are untouched by the error path', full.includes('[md]Fine.'));
for (const cls of ['.body.err', '.err-title', '.err-action', '.err-cmd', '.err-raw',
                   '.err-body', '.err-rawlabel', '.msg.errored']) {
  ok(`export CSS styles ${cls}`, EXPORT_CSS.includes(cls));
}
ok('error colours are defined for light AND dark',
   (EXPORT_CSS.match(/--errbg:/g) || []).length === 2);

// ---- the CSS-drift guard ---------------------------------------------------
const mdSource = readFileSync(join(here, '..', 'src', 'Markdown.jsx'), 'utf8');
const emitted = [...new Set(
  [...mdSource.matchAll(/md-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((m) => m[0]),
)]
  // md-h${b.level} is built by interpolation; enumerate what it can produce.
  .concat(['md-h1', 'md-h2', 'md-h3', 'md-h4', 'md-h5', 'md-h6'])
  .filter((c, i, arr) => arr.indexOf(c) === i)
  .sort();
const unstyled = emitted.filter((c) => !EXPORT_CSS.includes(`.${c}`));
ok(`export CSS covers every md-* class Markdown.jsx emits (${emitted.length})`, unstyled.length === 0);
if (unstyled.length) console.error('   not styled in the export:', unstyled.join(', '));
ok('inert Copy button hidden in the export', EXPORT_CSS.includes('.md-copy{display:none}'));

ok('deterministic', sessionHtml({ ...opts, includeTools: true }) === full);

for (const [r, n] of t) console.log(`${r}  ${n}`);
const f = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - f}/${t.length} passed`);
process.exit(f ? 1 : 0);
