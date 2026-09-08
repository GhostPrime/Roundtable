// scripts/check-memory-graph.js
// Layout + edit maths for the memory node graph (src/memoryGraph.js).
//
// The edit functions are the ones worth guarding: combine() silently losing a
// pinned flag or a hit count would quietly expose a protected fact to eviction
// or reset the usage signal the eviction ranking depends on, and neither would
// be visible in the UI until the fact vanished.
//
// Run:  node --experimental-default-type=module scripts/check-memory-graph.js
import {
  layoutForce, neighboursOf, assignTopics, radiusFor, FORCE,
  editMemo, deleteMemo, togglePin, combineMemos, combineDraft,
} from '../src/memoryGraph.js';

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);

const M = (id, text, extra = {}) => ({
  id, text, by: 'Qwen', ts: 1000, pinned: false, hitCount: 0, lastReferencedAt: 1000, ...extra,
});

// Three facts about the sync layer, two unrelated ones.
const memos = [
  M('a', 'The sync layer uses SQLite', { ts: 100, hitCount: 4 }),
  M('b', 'The sync layer uses PostgreSQL now', { ts: 200, hitCount: 2 }),
  M('c', 'The sync layer retry path has a race', { ts: 300 }),
  M('d', 'Phil prefers dark mode', { ts: 400, hitCount: 9, pinned: true }),
  M('e', 'Releases are tagged vX.Y.Z', { ts: 500 }),
  M('f', 'Release notes live in RELEASING.md', { ts: 600 }),
];
// ---- edges as electron/memory.js supplies them -----------------------------
// links   = sameSubject (strong, "same fact")
// related = [a, b, weight, sharedToken]  (weak, "same topic")
// chain   = the spanning tree rooted at the OLDEST fact — every node has a
//           path back to the origin, which is what makes this one structure
//           rather than islands
const links = [['a', 'b']];
const related = [
  ['a', 'b', 2, 'sync'], ['b', 'c', 1, 'sync'], ['a', 'c', 1, 'sync'],
  ['e', 'f', 1, 'release'],
];
const chain = [
  ['a', 'b', 12, 'sync'], ['b', 'c', 1, 'sync'],
  ['a', 'd', 0, null], ['a', 'e', 0, null], ['e', 'f', 1, 'release'],
];
const edgeSets = { links, related, chain, root: 'a' };

const g = layoutForce(memos, edgeSets);

const at = (id) => g.nodes.find((n) => n.id === id);
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// ---- layout ----------------------------------------------------------------
ok('lays out every memo', g.nodes.length === memos.length);
// a↔b and e↔f appear in more than one set; each pair is drawn ONCE, strongest wins
ok('every pair drawn exactly once',
   new Set(g.edges.map((e) => [e.a, e.b].sort().join('|'))).size === g.edges.length);
ok('chain edges win over weaker duplicates of the same pair',
   g.edges.find((e) => [e.a, e.b].sort().join('|') === 'a|b').kind === 'chain');
ok('edge endpoints resolve to nodes', g.edges.every((e) => e.from && e.to));
ok('chain edges are marked', g.edges.some((e) => e.kind === 'chain'));
ok('cross-links are marked', g.edges.some((e) => e.kind === 'related'));

// ---- the origin ------------------------------------------------------------
ok('names the root', g.root === 'a');
ok('root node is flagged', g.nodes.find((n) => n.id === 'a').isRoot === true);
ok('only one root', g.nodes.filter((n) => n.isRoot).length === 1);
ok('root is drawn larger than the rest',
   g.nodes.find((n) => n.isRoot).r > Math.max(...g.nodes.filter((n) => !n.isRoot).map((n) => n.r)));
ok('root falls back to the OLDEST fact when main names none',
   layoutForce(memos, { chain }).root === 'a');
ok('a bogus root falls back to the oldest too',
   layoutForce(memos, { chain, root: 'nope' }).root === 'a');

// EVERY node must reach the origin — that is the whole point of the chain.
const adj = new Map(memos.map((m) => [m.id, []]));
for (const e of g.edges) { adj.get(e.a).push(e.b); adj.get(e.b).push(e.a); }
const seenIds = new Set(['a']);
const queue = ['a'];
while (queue.length) for (const nx of adj.get(queue.pop())) if (!seenIds.has(nx)) { seenIds.add(nx); queue.push(nx); }
ok('every fact traces back to the origin', seenIds.size === memos.length);

// …including a fact that shares no vocabulary with anything.
const lone = layoutForce(memos, { chain: [['a', 'd', 0, null]], root: 'a' });
ok('an unrelated fact still hangs off the origin',
   lone.edges.some((e) => e.a === 'a' && e.b === 'd' && e.kind === 'chain'));

// The chain should dominate placement: a child sits nearer its parent than a
// node it merely shares a word with.
ok('chain children sit near their parent',
   dist(at('b'), at('c')) < dist(at('c'), at('f')));
ok('every node lands inside the canvas',
   g.nodes.every((n) => n.x >= 0 && n.x <= g.width && n.y >= 0 && n.y <= g.height));
ok('no NaN positions', g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
ok('no two nodes land on the exact same point',
   new Set(g.nodes.map((n) => `${n.x.toFixed(2)},${n.y.toFixed(2)}`)).size === g.nodes.length);
ok('velocities are not leaked into the result',
   g.nodes.every((n) => n.vx === undefined && n.vy === undefined));

// DETERMINISM is the whole reason the sim is seeded: a map that reshuffles on
// every open makes "where was that fact?" unanswerable.
ok('same pool → identical map',
   JSON.stringify(layoutForce(memos, edgeSets)) === JSON.stringify(g));

ok('empty pool lays out without throwing', layoutForce([], {}).nodes.length === 0);
ok('a pool with no edges at all still lays out', layoutForce(memos, {}).nodes.length === memos.length);
ok('edges naming unknown ids are dropped',
   layoutForce(memos, { links: [['a', 'zzz']] }).edges.length === 0);

// ---- topics ----------------------------------------------------------------
const { topicOf, topics } = assignTopics(memos, related);
ok('topic assigned from the shared token', topicOf.get('a') === 'sync');
ok('a second topic is found', topics.includes('release'));
ok('unconnected facts get no topic', !topicOf.has('d'));
ok('topics ranked biggest first', topics[0] === 'sync');
ok('nodes carry their topic', at('a').topic === 'sync' && at('d').topic === null);

// ---- radius: text length, NOT hitCount -------------------------------------
// hitCount only moves on an exact re-assert, so it is 0 for effectively every
// fact — sizing on it made every node identical AND dimmed.
ok('longer text → bigger node', radiusFor({ text: 'x'.repeat(200) }, 200) > radiusFor({ text: 'xx' }, 200));
ok('longest text hits the max', radiusFor({ text: 'x'.repeat(200) }, 200) === FORCE.maxR);
ok('degenerate pool is safe', radiusFor({ text: '' }, 0) === FORCE.minR);
ok('a zero-hitCount pool still varies in size',
   new Set(memos.map((m) => radiusFor(m, 60))).size > 1);

// ---- neighbours ------------------------------------------------------------
const nb = neighboursOf(g.edges, 'b');
ok('neighbours found in both directions', nb.has('a') && nb.has('c'));
ok('unrelated facts are not neighbours', !nb.has('d'));
ok('unknown id yields none', neighboursOf(g.edges, 'zzz').size === 0);

// ---- edits -----------------------------------------------------------------
ok('edit replaces the text', editMemo(memos, 'c', 'rewritten').find((m) => m.id === 'c').text === 'rewritten');
ok('edit leaves other facts alone', editMemo(memos, 'c', 'x').find((m) => m.id === 'a').text === memos[0].text);
ok('edit ignores an empty string', editMemo(memos, 'c', '   ').find((m) => m.id === 'c').text === memos[2].text);
ok('edit truncates at the 300-char cap', editMemo(memos, 'c', 'z'.repeat(400)).find((m) => m.id === 'c').text.length === 300);
ok('delete removes exactly one', deleteMemo(memos, 'c').length === memos.length - 1);
ok('pin toggles', togglePin(memos, 'a').find((m) => m.id === 'a').pinned === true);
ok('pin toggles back', togglePin(togglePin(memos, 'a'), 'a').find((m) => m.id === 'a').pinned === false);

// ---- combine: the one with teeth ------------------------------------------
const comb = combineMemos(memos, ['a', 'b'], 'The sync layer uses PostgreSQL');
ok('combine collapses two into one', comb.length === memos.length - 1);
ok('…keeping the merged text', comb.find((m) => m.text === 'The sync layer uses PostgreSQL'));
ok('…inheriting the OLDEST id', comb.some((m) => m.id === 'a'));
ok('…and the oldest timestamp', comb.find((m) => m.id === 'a').ts === 100);
ok('…SUMMING hit counts', comb.find((m) => m.id === 'a').hitCount === 6);
ok('…attributed to you', comb.find((m) => m.id === 'a').by === 'you');
ok('…in the oldest member\'s slot', comb.findIndex((m) => m.id === 'a') === 0);
ok('…leaving untouched facts alone', comb.find((m) => m.id === 'd').hitCount === 9);

const pinKept = combineMemos(
  [M('p', 'one', { ts: 1, pinned: true }), M('q', 'two', { ts: 2 })], ['p', 'q'], 'merged',
);
ok('combine keeps pinned if ANY input was pinned', pinKept[0].pinned === true);
const pinKept2 = combineMemos(
  [M('p', 'one', { ts: 1 }), M('q', 'two', { ts: 2, pinned: true })], ['p', 'q'], 'merged',
);
ok('…even when it is the NEWER one that was pinned', pinKept2[0].pinned === true);
ok('combine keeps the latest reference time',
   combineMemos([M('p', 'a', { ts: 1, lastReferencedAt: 50 }), M('q', 'b', { ts: 2, lastReferencedAt: 90 })],
     ['p', 'q'], 'm')[0].lastReferencedAt === 90);

ok('combine refuses a single selection', combineMemos(memos, ['a'], 'x').length === memos.length);
ok('combine refuses empty text', combineMemos(memos, ['a', 'b'], '  ').length === memos.length);
ok('combine truncates at the cap', combineMemos(memos, ['a', 'b'], 'z'.repeat(400))[0].text.length === 300);
ok('draft is oldest-first', combineDraft(memos, ['b', 'a']).startsWith('The sync layer uses SQLite'));
ok('draft joins both texts', combineDraft(memos, ['a', 'b']).includes('PostgreSQL'));

for (const [r, n] of t) console.log(`${r}  ${n}`);
const f = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - f}/${t.length} passed`);
process.exit(f ? 1 : 0);
