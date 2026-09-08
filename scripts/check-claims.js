// scripts/check-claims.js
// The proof rule's teeth (orchestrator.js parseClaims / unverifiedClaims).
//
// Seats declare work finished that never happened, and the NEXT seat takes it
// as fact and reasons forward from a fiction. promptText.PROOF_RULE states the
// rule; these functions are what let the round flag a breach in the transcript
// instead of the user catching it afterwards.
//
// The asymmetry that shapes every test below: a FALSE accusation is worse than
// a missed one. A seat wrongly branded a liar poisons the table exactly the way
// the false claim would. So the detector only fires when a claim names a real
// path — anything vaguer is left alone on purpose.
//
// Run:  node --experimental-default-type=module scripts/check-claims.js
import {
  parseClaims, unverifiedClaims, confirmedEvidence, pendingWritePaths,
} from '../src/orchestrator.js';

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);

const tool = (text) => ({ speaker: 'Tool', agentId: null, text });
const wrote = (p) => tool(`Check (write_file ${p}):\nwrote ${p} (120 bytes)`);
const failed = (p) => tool(`Check failed (write_file ${p}):\nEACCES`);

// ---- what counts as a claim ------------------------------------------------
ok('past-tense write claim is caught', parseClaims("I've written src/App.jsx").length === 1);
ok('bare "I wrote" is caught', parseClaims('I wrote index.html with the fix').length === 1);
ok('passive voice is caught', parseClaims('The patch has been applied to src/game.js').length === 1);
ok('"is now in place" is caught', parseClaims('build.js is now in place').length === 1);
ok('"successfully wrote" is caught', parseClaims('Successfully wrote docs/readme.md').length === 1);
ok('the path is extracted', parseClaims("I've saved src/App.jsx")[0]?.path === 'src/app.jsx');
// The register these models actually use — a first pass matched none of this.
ok('"verified on disk" is caught', parseClaims('Change verified on disk: index.html').length === 1);
ok('"the write landed" is caught',
   parseClaims('The write landed — index.html, 17450 bytes').some((c) => c.path === 'index.html'));
ok('"confirmed fixed" is caught', parseClaims('Bug confirmed fixed in src/game.js').length === 1);
ok('windows separators normalise', parseClaims('I wrote src\\game\\enemy.js')[0]?.path === 'src/game/enemy.js');
ok('a leading ./ is stripped', parseClaims('I wrote ./index.html')[0]?.path === 'index.html');

// ---- what must NOT be a claim ----------------------------------------------
ok('intentions are not claims', parseClaims('I will write src/App.jsx next').length === 0);
ok('"let me update" is not a claim', parseClaims('Let me update src/App.jsx').length === 0);
ok('"should" is not a claim', parseClaims('That should fix src/App.jsx').length === 0);
ok('proposals are not claims', parseClaims('We could rewrite src/App.jsx').length === 0);
ok('a pathless boast is not flaggable', parseClaims("I've fixed it and it works now").length === 0);
ok('discussion of a file is not a claim', parseClaims('src/App.jsx is where the bug lives').length === 0);
ok('empty text is safe', parseClaims('').length === 0);
// Paragraph scope is the unit: a claim and its filename routinely land in
// different SENTENCES, so sentence scope missed the real case entirely.
ok('a claim and its path in different sentences still pair up',
   parseClaims('The fix is verified on disk. The write landed in index.html.').length === 1);
ok('…but a separate paragraph does not get implicated',
   parseClaims("I've written a.js\n\nSeparately, b.js looks suspicious.").length === 1);

// ---- verification against real tool results --------------------------------
const ev = confirmedEvidence([wrote('src/App.jsx'), tool('Check (read_file notes.md):\n…')]);
ok('a confirmed write is evidence', ev.paths.has('src/app.jsx'));
ok('a read is evidence too', ev.paths.has('notes.md'));
ok('the op is recorded', ev.ops.has('write_file'));
ok('a FAILED check is not evidence',
   !confirmedEvidence([failed('src/App.jsx')]).paths.has('src/app.jsx'));
ok('no tool results → no evidence', confirmedEvidence([]).paths.size === 0);
ok('ordinary chat is not evidence',
   confirmedEvidence([{ speaker: 'Deep', text: 'Check (write_file x.js): wrote it' }]).paths.size === 0);

ok('a backed claim passes', unverifiedClaims("I've written src/App.jsx", ev).length === 0);
ok('an unbacked claim is flagged', unverifiedClaims("I've written src/other.js", ev).length === 1);
ok('a claim backed only by a FAILED write is flagged',
   unverifiedClaims("I've written src/App.jsx", confirmedEvidence([failed('src/App.jsx')])).length === 1);
ok('case and separators do not defeat matching',
   unverifiedClaims('I wrote SRC\\App.JSX', ev).length === 0);

// ---- the false-positive that matters ---------------------------------------
// A reply that says "I've written X" while ALSO emitting CHECK: write_file X is
// narrating the write it is making right now. Flagging that would fire on
// almost every legitimate build turn.
const narrating = "I've written the fix to src/game.js\nCHECK: write_file src/game.js\n```\nconst a = 1;\n```";
ok('(control) it does read as a claim', parseClaims(narrating).length === 1);
ok('a write requested in the SAME message is pending, not a lie',
   unverifiedClaims(narrating, confirmedEvidence([]), pendingWritePaths(narrating)).length === 0);
ok('pendingWritePaths finds the requested path', pendingWritePaths(narrating).has('src/game.js'));
ok('…but a claim about a DIFFERENT file still flags',
   unverifiedClaims("I've written src/game.js and src/other.js\nCHECK: write_file src/game.js",
     confirmedEvidence([]), pendingWritePaths("CHECK: write_file src/game.js")).length === 1);
ok('a read request does not excuse a write claim',
   pendingWritePaths('CHECK: read_file src/game.js').size === 0);

// ---- code identifiers are NOT files ----------------------------------------
// Every one of these false-positived on the first live run. `p.life` — a
// projectile's lifetime property — was flagged as an unwritten file in front of
// the whole table, which is the exact accusation this must never make.
ok('p.life is not a file', parseClaims("I've fixed p.life = 1.5 in the fire path").length === 0);
ok('p.active is not a file', parseClaims('I fixed p.active = true').length === 0);
ok('this.state is not a file', parseClaims("I've updated this.state").length === 0);
ok('Number.isFinite is not a file', parseClaims('I added Number.isFinite guards').length === 0);
ok('Enemy.takeDamage is not a file', parseClaims('I fixed Enemy.takeDamage').length === 0);
ok('a method call is not a file', parseClaims("I've patched updateWeapons() and Projectile.update()").length === 0);
ok('…but a REAL file in the same sentence still counts',
   parseClaims("I fixed p.life in src/game.js")[0]?.path === 'src/game.js');
ok('unusual extensions are missed, not guessed', parseClaims('I wrote data.qqq').length === 0);

// ---- fabricated tool receipts ----------------------------------------------
// checks.js answers a write with "wrote <path> (<n> bytes)". A seat quoting a
// byte count no tool result contains has invented the receipt — and this is the
// only check that catches the live case, where the seat said "written and
// verified on disk (18021 bytes)" and never named a file.
const claimedBytes = 'The fix has been written and verified on disk (18021 bytes).';
ok('a byte count is read as a claim', parseClaims(claimedBytes).length === 1);
ok('…even with no filename', parseClaims(claimedBytes)[0]?.bytes === '18021');
ok('an invented byte count is flagged',
   unverifiedClaims(claimedBytes, confirmedEvidence([wrote('index.html')])).length === 1);
ok('a byte count matching a real result passes',
   unverifiedClaims(claimedBytes,
     confirmedEvidence([tool('Check (write_file index.html):\nwrote index.html (18021 bytes)')])).length === 0);
ok('small numbers are not byte counts', parseClaims("I've fixed 42 bytes of it").length === 0);
ok('evidence collects byte counts',
   confirmedEvidence([tool('Check (write_file a.js):\nwrote a.js (1234 bytes)')]).bytes.has('1234'));

// ---- the real scenario from the transcript ---------------------------------
// Verbatim shape of the message that prompted this whole feature.
const answer = 'The bug is confirmed fixed and verified on disk. The write landed (wrote index.html, 17450 bytes).';
// Fully backed: the write happened AND the byte count matches the receipt.
const realReceipt = tool('Check (write_file index.html):\nwrote index.html (17450 bytes)');
ok('claim with a confirming write passes',
   unverifiedClaims(answer, confirmedEvidence([realReceipt])).length === 0);
ok('the SAME claim with no write at all is flagged',
   unverifiedClaims(answer, confirmedEvidence([])).length === 2);
ok('…naming the file so the flag is specific',
   unverifiedClaims(answer, confirmedEvidence([])).some((c) => c.path === 'index.html'));
// The sharpest case: the write DID happen, but the seat quoted a byte count
// that is not the one the tool returned — a real file, an invented receipt.
ok('a real write with a WRONG byte count still flags the receipt',
   unverifiedClaims(answer, confirmedEvidence([wrote('index.html')]))
     .every((c) => c.bytes === '17450'));

for (const [r, n] of t) console.log(`${r}  ${n}`);
const f = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - f}/${t.length} passed`);
process.exit(f ? 1 : 0);
