// memoryGraph.js — force layout and edit maths for the memory map.
//
// Pure and JSX-free so it can be tested on plain `node` (this repo has no
// bundler to compile a JSX test with — vite 8 ships rolldown, not esbuild).
// MemoryGraph.jsx does nothing but draw what these functions return.
//
// ---------------------------------------------------------------------------
// This replaced a deterministic column layout, which was wrong twice over.
//
// It was wrong on FORM: columns of dots with clipped captions is a list that
// has lost its text. The thing worth looking at is the shape of the pool —
// which facts pull together, which float alone — and that needs free 2D space.
//
// It was wrong on DATA: it drew edges only from `sameSubject`, the predicate
// the save path uses to decide whether merging two facts would destroy one.
// That is deliberately near-paranoid, so on a real 19-fact pool it produced
// zero edges and the map had nothing to show.
//
// Three edge sets now, all from electron/memory.js:
//   chain     — a spanning tree rooted at the OLDEST fact. Every node has a
//               path back to that origin, which is what makes this ONE
//               structure with branches instead of scattered islands. Drawn
//               as the primary edges and given the strongest springs, so the
//               force sim resolves into branches radiating from the root.
//   duplicate — sameSubject: probably the same fact, pulled tight.
//   related   — shared salient word: cross-links between branches.
//
// The force sim is SEEDED — initial positions come from a hash of each id, and
// the iteration count is fixed — so the same pool always produces the same
// map. That was the one real argument for columns (a layout that reshuffles
// every time makes "where was that fact?" unanswerable) and it costs nothing
// to keep.
// ---------------------------------------------------------------------------

// ---- deterministic seeding -------------------------------------------------
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export const FORCE = {
  width: 1000,
  height: 640,
  iterations: 340,
  repulsion: 5600,   // node-node push
  spring: 0.012,     // edge pull
  chainSpring: 0.05, // the tree holds the shape; topic links only nudge it
  chainLen: 78,      // rest length parent→child
  springLen: 130,    // cross-links sit loose so they don't collapse branches
  dupLen: 50,        // duplicates sit closer — they ARE nearly the same fact
  gravity: 0.012,    // pull to centre so nothing drifts off-canvas
  rootGravity: 0.09, // the origin holds the middle so branches read outward
  damping: 0.86,
  minR: 7,
  maxR: 20,
  rootR: 26,
};

// Radius from text length, not hitCount.
//
// hitCount was the original choice and it is dead data: memory.js only bumps
// it when the SAME fact is re-asserted (the dedupe path), which essentially
// never happens, so every node rendered at the minimum AND dimmed — the whole
// pool looked disabled. Length is a weak signal but an honest one: a longer
// fact carries more, and it makes the map legible instead of uniform.
export function radiusFor(memo, longest) {
  const { minR, maxR } = FORCE;
  const len = (memo.text || '').length;
  if (!longest) return minR;
  return minR + (maxR - minR) * Math.sqrt(Math.min(len, longest) / longest);
}

// ---- topics ----------------------------------------------------------------
// A node's colour comes from its strongest shared token, so the eye groups
// what the edges connect. Assignment is greedy by token frequency within the
// pool, which keeps it stable and explicable ("these are the ramen ones").
export function assignTopics(memos, related) {
  const weight = new Map(); // memoId -> Map(token -> count)
  for (const [a, b, , token] of related || []) {
    if (!token) continue;
    for (const id of [a, b]) {
      if (!weight.has(id)) weight.set(id, new Map());
      const w = weight.get(id);
      w.set(token, (w.get(token) || 0) + 1);
    }
  }
  const topicCount = new Map();
  const topicOf = new Map();
  for (const m of memos) {
    const w = weight.get(m.id);
    if (!w || !w.size) continue;
    let best = null;
    let bestN = 0;
    for (const [tok, n] of w) {
      if (n > bestN || (n === bestN && best && tok < best)) { best = tok; bestN = n; }
    }
    topicOf.set(m.id, best);
    topicCount.set(best, (topicCount.get(best) || 0) + 1);
  }
  // Rank topics by size so colours are assigned stably, biggest group first.
  const topics = [...topicCount.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([t]) => t);
  return { topicOf, topics };
}

// ---- force layout ----------------------------------------------------------
export function layoutForce(memos, edgeSets = {}, opts = {}) {
  const { links = [], related = [], chain = [], root = null } = edgeSets || {};
  const cfg = { ...FORCE, ...opts };
  const list = memos || [];
  if (!list.length) {
    return { nodes: [], edges: [], topics: [], root: null, width: cfg.width, height: cfg.height };
  }
  // The origin: whatever main named, else the oldest fact in the pool.
  const rootId = root && list.some((m) => m.id === root)
    ? root
    : [...list].sort((a, b) => (a.ts || 0) - (b.ts || 0))[0].id;

  const longest = list.reduce((n, m) => Math.max(n, (m.text || '').length), 0);
  const { topicOf, topics } = assignTopics(list, related);

  // Seeded ring start: deterministic, and a ring unfolds more cleanly than
  // random scatter (fewer crossed edges once it settles).
  const cx = cfg.width / 2;
  const cy = cfg.height / 2;
  const nodes = list.map((m, i) => {
    const a = hash(m.id) * Math.PI * 2;
    const rad = 120 + hash(`${m.id}r`) * Math.min(cx, cy) * 0.55;
    return {
      ...m,
      x: cx + Math.cos(a) * rad,
      y: cy + Math.sin(a) * rad,
      vx: 0,
      vy: 0,
      r: m.id === rootId ? cfg.rootR : radiusFor(m, longest),
      topic: topicOf.get(m.id) || null,
      isRoot: m.id === rootId,
      idx: i,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Chain first so it draws underneath, and so a pair that is BOTH a chain
  // edge and a topic link renders once as the stronger of the two.
  const seen = new Set();
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edges = [];
  for (const [a, b, w, token] of chain || []) {
    if (!byId.has(a) || !byId.has(b) || seen.has(key(a, b))) continue;
    seen.add(key(a, b));
    edges.push({ a, b, kind: 'chain', weight: w || 1, token });
  }
  for (const [a, b] of links || []) {
    if (!byId.has(a) || !byId.has(b) || seen.has(key(a, b))) continue;
    seen.add(key(a, b));
    edges.push({ a, b, kind: 'duplicate', weight: 3 });
  }
  for (const [a, b, w, token] of related || []) {
    if (!byId.has(a) || !byId.has(b) || seen.has(key(a, b))) continue;
    seen.add(key(a, b));
    edges.push({ a, b, kind: 'related', weight: w || 1, token });
  }

  for (let step = 0; step < cfg.iterations; step++) {
    const cool = 1 - step / cfg.iterations;

    // Repulsion — every pair. n<=50 so n²·iters is trivial.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const p = nodes[i];
        const q = nodes[j];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (hash(p.id) - 0.5) * 0.1; dy = (hash(q.id) - 0.5) * 0.1; d2 = 0.01; }
        const f = cfg.repulsion / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        p.vx += fx; p.vy += fy;
        q.vx -= fx; q.vy -= fy;
      }
    }

    // Attraction along edges. Duplicates pull to a shorter rest length.
    for (const e of edges) {
      const p = byId.get(e.a);
      const q = byId.get(e.b);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const rest = e.kind === 'chain' ? cfg.chainLen
        : e.kind === 'duplicate' ? cfg.dupLen
          : cfg.springLen;
      const k = e.kind === 'chain' ? cfg.chainSpring : cfg.spring;
      const f = (d - rest) * k * Math.min(e.weight, 3);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      p.vx += fx; p.vy += fy;
      q.vx -= fx; q.vy -= fy;
    }

    for (const n of nodes) {
      // The origin is held near the middle so the tree reads as growing
      // outward from it rather than dangling off one edge.
      const grav = n.isRoot ? cfg.rootGravity : cfg.gravity;
      n.vx += (cx - n.x) * grav;
      n.vy += (cy - n.y) * grav;
      n.vx *= cfg.damping;
      n.vy *= cfg.damping;
      n.x += n.vx * cool;
      n.y += n.vy * cool;
    }
  }

  // Normalise into a tight box with padding, so the view always fills nicely
  // whether the pool is 5 facts or 50.
  const pad = 40;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((cfg.width - pad * 2) / spanX, (cfg.height - pad * 2) / spanY, 1.6);
  for (const n of nodes) {
    n.x = pad + (n.x - minX) * scale + (cfg.width - pad * 2 - spanX * scale) / 2;
    n.y = pad + (n.y - minY) * scale + (cfg.height - pad * 2 - spanY * scale) / 2;
    delete n.vx;
    delete n.vy;
  }

  const drawn = edges.map((e) => ({ ...e, from: byId.get(e.a), to: byId.get(e.b) }));
  return { nodes, edges: drawn, topics, root: rootId, width: cfg.width, height: cfg.height };
}

// Neighbours of a node — used to highlight a selection's connections.
export function neighboursOf(edges, id) {
  const out = new Set();
  for (const e of edges || []) {
    if (e.a === id) out.add(e.b);
    else if (e.b === id) out.add(e.a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits. Each returns a NEW pool array; the caller persists with memorySave.
// ---------------------------------------------------------------------------
export function editMemo(memos, id, text) {
  const clean = String(text || '').trim().slice(0, 300); // MAX_TEXT in memory.js
  if (!clean) return memos;
  return memos.map((m) => (m.id === id ? { ...m, text: clean } : m));
}

export function deleteMemo(memos, id) {
  return memos.filter((m) => m.id !== id);
}

export function togglePin(memos, id) {
  return memos.map((m) => (m.id === id ? { ...m, pinned: !m.pinned } : m));
}

// Merge several facts into one. The merged fact inherits the OLDEST id and
// timestamp (it is the continuation of that thread, and keeping the id means
// anything referencing it still resolves), the SUM of hit counts, the most
// recent reference time, and pinned if ANY input was pinned — un-pinning by
// merging would quietly expose a fact the user protected to auto-eviction.
export function combineMemos(memos, ids, text) {
  const set = new Set(ids || []);
  const picked = memos.filter((m) => set.has(m.id));
  if (picked.length < 2) return memos;
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) return memos;

  const oldest = picked.reduce((a, m) => ((m.ts || 0) < (a.ts || 0) ? m : a), picked[0]);
  const merged = {
    ...oldest,
    text: clean,
    by: 'you',
    pinned: picked.some((m) => m.pinned),
    hitCount: picked.reduce((n, m) => n + (m.hitCount || 0), 0),
    lastReferencedAt: picked.reduce((n, m) => Math.max(n, m.lastReferencedAt || 0), 0),
  };
  const out = [];
  let placed = false;
  for (const m of memos) {
    if (!set.has(m.id)) { out.push(m); continue; }
    if (!placed) { out.push(merged); placed = true; }
  }
  return out;
}

// Pre-fill for the combine editor: picked facts oldest-first. Deliberately NOT
// auto-summarised — a silent model merge is how a fact goes missing without
// anyone noticing. The panel's Distill button is there for the model version.
export function combineDraft(memos, ids) {
  const set = new Set(ids || []);
  return memos
    .filter((m) => set.has(m.id))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map((m) => m.text)
    .join(' ');
}
