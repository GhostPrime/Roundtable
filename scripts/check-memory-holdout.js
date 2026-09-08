// scripts/check-memory-holdout.js
// Guards the memory holdout experiment, the rewritten MEMORY prompt, and the
// dispute path.
//
// Context, because these three are one change:
//
// The pool had a usage signal and it was dead. hitCount and lastReferencedAt
// only move in addMemos() — on save or re-assert — and the prompt separately
// told seats "never a fact already in MEMORY", which suppresses the only event
// that moved them. evictionScore() ranks on those fields, so eviction at the
// 50-fact cap was approximately "drop the oldest": retention uncorrelated with
// value. Counting reads would not have helped, because every fact is injected
// on every turn and the counts would come out equal. The only measurement that
// separates "present" from "load-bearing" is causal — withhold one and see.
//
// Alongside it, the prompt used to say "Treat them as true unless the
// transcript contradicts them", which is most dangerous precisely where it is
// most read: in a fresh window there is no transcript, so it evaluates to
// "treat them as true" and a stale fact carries maximum authority with minimum
// verification.
//
// And the pool was a closed loop — written by agents, read by agents,
// corrected by nobody — so MEMO-WRONG exists to open it WITHOUT letting one
// agent delete another's fact, which would be the same loop with a delete key.
//
// Run:  node --experimental-default-type=module scripts/check-memory-holdout.js
import {
  pickHoldout, withoutHoldout, holdoutCounts, holdoutRecord, addHoldoutRecord,
  judgeHoldout, pendingHoldout, holdoutStats, HOLDOUT_MIN_POOL, HOLDOUT_LOG_CAP,
} from '../src/memoryHoldout.js';
import { parseMemoDisputes, matchDisputed, parseMemos } from '../src/orchestrator.js';
import { memoryBlock } from '../src/promptText.js';

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);
const M = (id, text, extra = {}) => ({ id, text, by: 'Qwen3.6', ts: Date.now(), pinned: false, ...extra });

const pool = [
  M('a', 'The sync layer uses PostgreSQL'),
  M('b', 'Phil prefers dark mode', { pinned: true }),
  M('c', 'Releases are tagged vX.Y.Z'),
  M('d', 'The task board already functions as the audit log'),
  M('e', 'The MCP channel cannot be verified'),
];

// ===========================================================================
// 1. Picking what to withhold
// ===========================================================================
ok('a pinned fact is never withheld',
   Array.from({ length: 40 }, (_, i) => pickHoldout(pool, `r${i}`)).every((m) => m.id !== 'b'));
ok('something is always chosen from a big enough pool', pickHoldout(pool, 'x') !== null);
ok('a tiny pool is left alone entirely', pickHoldout(pool.slice(0, 3), 'x') === null);
ok(`…the threshold is ${HOLDOUT_MIN_POOL}`, pickHoldout(pool.slice(0, HOLDOUT_MIN_POOL), 'x') !== null);
ok('an all-pinned pool holds nothing out',
   pickHoldout(pool.map((m) => ({ ...m, pinned: true })), 'x') === null);
ok('an empty pool is safe', pickHoldout([], 'x') === null);

// The same round MUST hold out the same fact — a retry or a regenerate that
// swapped it would contaminate the trial it is meant to repeat.
ok('the same round always picks the same fact',
   pickHoldout(pool, 'round-7').id === pickHoldout(pool, 'round-7').id);
ok('different rounds do not all pick the same fact',
   new Set(Array.from({ length: 30 }, (_, i) => pickHoldout(pool, `r${i}`).id)).size > 1);

// Coverage: fewest-withheld-first, so the sweep is even rather than clumpy.
const counts = new Map([['a', 5], ['c', 5], ['d', 5], ['e', 0]]);
ok('the least-tested fact is chosen next', pickHoldout(pool, 'anything', counts).id === 'e');
let cov = new Map();
for (let i = 0; i < 40; i += 1) {
  const h = pickHoldout(pool, `r${i}`, cov);
  cov.set(h.id, (cov.get(h.id) || 0) + 1);
}
ok('40 rounds cover every unpinned fact', cov.size === 4);
ok('…evenly, not clumped', Math.max(...cov.values()) - Math.min(...cov.values()) <= 1);

// ===========================================================================
// 2. The pool the seats actually see
// ===========================================================================
const held = pickHoldout(pool, 'r1');
const shown = withoutHoldout(pool, held);
ok('exactly one fact is withheld', shown.length === pool.length - 1);
ok('…and it is the chosen one', !shown.some((m) => m.id === held.id));
ok('no holdout means the full pool', withoutHoldout(pool, null).length === pool.length);
ok('the original pool is not mutated', pool.length === 5);

// ===========================================================================
// 3. The log, and the human in it
// ===========================================================================
const rec = holdoutRecord(held, { roundId: 'rd1', poolSize: pool.length });
ok('a trial is recorded', !!rec?.id);
ok('…starting unjudged — only a person sets this', rec.verdict === null);
ok('…copying the text, not pointing at it', rec.text === held.text);
ok('…and noting the pool size it was drawn from', rec.poolSize === 5);
ok('no holdout logs nothing', holdoutRecord(null) === null);

let log = addHoldoutRecord([], rec);
ok('the log grows', log.length === 1);
ok('an unjudged trial is what the user is asked about', pendingHoldout(log)?.id === rec.id);
log = judgeHoldout(log, rec.id, 'fine');
ok('a verdict sticks', log[0].verdict === 'fine');
ok('…and is timestamped', typeof log[0].judgedAt === 'number');
ok('…and clears the question', pendingHoldout(log) === null);
ok('a nonsense verdict is refused', judgeHoldout(log, rec.id, 'maybe')[0].verdict === 'fine');

let big = [];
for (let i = 0; i < HOLDOUT_LOG_CAP + 25; i += 1) {
  big = addHoldoutRecord(big, holdoutRecord(M(`m${i}`, `fact ${i}`), { ts: 1000 + i }));
}
ok('the log cannot outgrow what it measures', big.length === HOLDOUT_LOG_CAP);
ok('…keeping the most recent trials', big[big.length - 1].text === `fact ${HOLDOUT_LOG_CAP + 24}`);

// ===========================================================================
// 4. What the log can finally answer
// ===========================================================================
// This is the question the store could never answer before: which of these
// facts is actually earning its place?
let trials = [];
for (const [memo, verdict] of [
  [M('a', 'The sync layer uses PostgreSQL'), 'missed'],
  [M('d', 'The task board already functions as the audit log'), 'fine'],
  [M('d', 'The task board already functions as the audit log'), 'fine'],
  [M('d', 'The task board already functions as the audit log'), 'fine'],
  [M('e', 'The MCP channel cannot be verified'), 'fine'],
]) {
  const r = holdoutRecord(memo, { ts: Date.now() + trials.length });
  trials = judgeHoldout(addHoldoutRecord(trials, r), r.id, verdict);
}
const stats = holdoutStats(trials);
ok('trials are counted', stats.trials === 5 && stats.judged === 5);
ok('misses are counted', stats.missed === 1);
ok('a fact withheld repeatedly with nothing lost is named as dead weight',
   stats.deadWeight[0]?.memoId === 'd' && stats.deadWeight[0].fine === 3);
ok('a fact that WAS missed is never called dead weight',
   !stats.deadWeight.some((m) => m.memoId === 'a'));
ok('one uneventful trial is not yet evidence',
   !stats.deadWeight.some((m) => m.memoId === 'e'));
ok('an empty log says nothing either way', holdoutStats([]).deadWeight.length === 0);

// ===========================================================================
// 5. The prompt — the clause that granted blanket authority is gone
// ===========================================================================
const now = Date.parse('2026-09-07T12:00:00Z');
const aged = [
  M('a', 'The sync layer uses PostgreSQL', { ts: now - 86400000 * 120, by: 'Qwen3.6' }),
  M('e', 'The MCP channel cannot be verified', { ts: now - 86400000 * 2, by: 'Qwen3.6' }),
];
const block = memoryBlock(aged, 'proj_1', now);
ok('the "treat them as true" instruction is gone', !/treat them as true/i.test(block));
ok('facts are framed as claims', /claims, not premises/i.test(block));
ok('the conversation is stated to outrank the list', /outranks anything on the list/i.test(block));
ok('the seat is asked to say when it leans on one', /per memory/i.test(block));
ok('each fact carries its author', block.includes('Qwen3.6'));
ok('…and its age, not a bare date', /4mo ago/.test(block));
ok('…so a fresh fact reads as fresh', /2d ago/.test(block));
ok('the MEMO syntax survives', /MEMO: <one short factual sentence>/.test(block));
ok('and a way to report a wrong fact exists', /MEMO-WRONG:/.test(block));
ok('…which flags rather than deletes', /does not delete anything/i.test(block));

// The 'global' pool is the one that merged four unrelated projects, because
// `activeProject?.id || 'global'` silently buckets every unprojected session
// together. A seat cannot know that unless it is told.
const globalBlock = memoryBlock(aged, 'global', now);
ok('the shared no-project pool is declared as such', /no project is selected/i.test(globalBlock));
ok('…and warns the facts may be about other work', /unrelated pieces of work/i.test(globalBlock));
ok('a real project pool does NOT carry that warning', !/unrelated pieces of work/i.test(block));

const disputedBlock = memoryBlock(
  [M('e', 'The MCP channel cannot be verified', { ts: now, disputed: { by: 'Claude', why: 'the parser was fixed' } })],
  'proj_1', now,
);
ok('a disputed fact is marked in the prompt', /\[DISPUTED by Claude: the parser was fixed\]/.test(disputedBlock));
ok('…and the marker is explained', /not settled/i.test(disputedBlock));
ok('an empty pool still teaches the syntax',
   /nothing saved yet/.test(memoryBlock([], 'proj_1', now)) && /MEMO:/.test(memoryBlock([], 'proj_1', now)));

// ===========================================================================
// 6. Disputes
// ===========================================================================
const d = parseMemoDisputes(
  'MEMO-WRONG: the MCP channel cannot be verified — the CHECK parser was dropping mcp lines, and it is fixed',
);
ok('a dispute parses', d.length === 1);
ok('…splitting the claim from the reason', d[0].claim === 'the MCP channel cannot be verified');
ok('…keeping the reason', /CHECK parser/.test(d[0].why));
ok('an en dash works too', parseMemoDisputes('MEMO-WRONG: x – y')[0].why === 'y');
ok('a hyphen works too', parseMemoDisputes('MEMO-WRONG: x - y')[0].why === 'y');
ok('a reasonless dispute is still recorded', parseMemoDisputes('MEMO-WRONG: x')[0].claim === 'x');
ok('markdown decoration is stripped', parseMemoDisputes('**MEMO-WRONG: x — y**').length === 1);
ok('capped per turn', parseMemoDisputes('MEMO-WRONG: a\nMEMO-WRONG: b\nMEMO-WRONG: c').length === 2);
ok('ordinary prose is not a dispute', parseMemoDisputes('I think the memo is wrong').length === 0);

// The two directives must not bleed into each other.
ok('MEMO does not swallow MEMO-WRONG', parseMemos('MEMO-WRONG: x — y').length === 0);
ok('MEMO-WRONG does not swallow MEMO', parseMemoDisputes('MEMO: a new fact').length === 0);
ok('both can appear in one turn',
   parseMemos('MEMO: new thing\nMEMO-WRONG: old thing — superseded').length === 1
   && parseMemoDisputes('MEMO: new thing\nMEMO-WRONG: old thing — superseded').length === 1);

// Matching a paraphrase to the fact it is about. A miss loses a correction; a
// false hit flags something true, so the bar is high on purpose.
ok('an exact claim matches', matchDisputed(pool, 'The MCP channel cannot be verified')?.id === 'e');
ok('case and punctuation do not matter', matchDisputed(pool, 'the mcp channel cannot be verified!')?.id === 'e');
ok('a partial quote matches', matchDisputed(pool, 'MCP channel cannot be verified')?.id === 'e');
ok('a close paraphrase matches', matchDisputed(pool, 'the MCP channel cannot really be verified')?.id === 'e');
ok('an unrelated claim matches nothing', matchDisputed(pool, 'the moon is made of cheese') === null);
ok('a vague claim matches nothing', matchDisputed(pool, 'the thing') === null);
ok('an empty claim matches nothing', matchDisputed(pool, '') === null);
ok('an empty pool matches nothing', matchDisputed([], 'anything') === null);
// The dangerous case: two similar facts, one true. Better to match neither
// than to flag the wrong one.
const twins = [M('x', 'The sync layer uses PostgreSQL'), M('y', 'The sync layer uses SQLite')];
ok('a dispute lands on the fact it actually quotes',
   matchDisputed(twins, 'The sync layer uses SQLite')?.id === 'y');

for (const [r, n] of t) console.log(`${r}  ${n}`);
const f = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - f}/${t.length} passed`);
process.exit(f ? 1 : 0);
