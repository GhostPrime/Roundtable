// src/memoryHoldout.js
// The holdout experiment: does the memory pool actually pay for itself?
//
// The store had a usage signal — hitCount, lastReferencedAt — and both were
// dead. Nothing bumps them on READ; they only move in addMemos() when a fact
// is saved or re-asserted, and the prompt separately tells seats "never a fact
// already in MEMORY", which suppresses the only event that moved them. So a
// memo injected into four hundred prompts and load-bearing every time is
// indistinguishable from one nobody has ever used: hitCount 0. evictionScore()
// ranks on those fields, which makes eviction at the 50-fact cap approximately
// "drop the oldest" — retention almost uncorrelated with value.
//
// Counting reads would not have fixed it. Every memo is injected on every
// turn, so read-counts come out equal and tell you nothing. The only
// measurement that separates "present" from "load-bearing" is causal: take one
// away and see whether anything breaks.
//
// So each round withholds exactly one unpinned fact, records which, and asks
// the user afterwards whether the round suffered. That is also the only human
// in a loop that is otherwise agents writing for agents — a fact an agent got
// wrong on Tuesday is a premise on Wednesday, and nothing in the system was
// ever positioned to catch it.
//
// Pure and JSX-free so scripts/check-memory-holdout.js can run it under plain
// node — this repo has no bundler to compile JSX for tests.

// Below this, the pool IS the noise: removing one of three facts tests nothing
// and just degrades small projects for no measurement.
export const HOLDOUT_MIN_POOL = 4;

// Records kept per project. Enough to see a pattern, bounded so the log can't
// outgrow the thing it measures.
export const HOLDOUT_LOG_CAP = 300;

// Deterministic hash — the same round must always hold out the same fact.
// A retry or a regenerate that swapped the withheld memo would contaminate the
// trial it is supposed to be repeating.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i += 1) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Which fact to withhold this round.
//
// Not random: random over 50 facts gives clumpy coverage, and you would wait
// months to learn anything about most of the pool. Fewest-times-held-out
// first, ties broken deterministically by the round seed, so coverage sweeps
// the pool evenly while any single round stays reproducible.
//
// Pinned facts are never withheld — the user pinned them, which is a stated
// judgement that they matter, and overriding it to run an experiment on
// someone's data is not ours to do.
export function pickHoldout(memos, seed, priorCounts = new Map()) {
  const pool = (memos || []).filter((m) => m && m.id && !m.pinned);
  if ((memos || []).length < HOLDOUT_MIN_POOL || pool.length === 0) return null;
  let best = null;
  let bestKey = null;
  for (const m of pool) {
    const used = Number(priorCounts.get(m.id)) || 0;
    // Sort key: coverage first, then a stable per-round shuffle.
    const key = [used, hash(`${seed}:${m.id}`)];
    if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = m;
      bestKey = key;
    }
  }
  return best;
}

// The pool as the seats will actually see it this round.
export function withoutHoldout(memos, holdout) {
  if (!holdout?.id) return memos || [];
  return (memos || []).filter((m) => m.id !== holdout.id);
}

// How many times each fact has been withheld so far, for the coverage sort.
export function holdoutCounts(records) {
  const counts = new Map();
  for (const r of records || []) {
    if (!r?.memoId) continue;
    counts.set(r.memoId, (counts.get(r.memoId) || 0) + 1);
  }
  return counts;
}

// One trial. `verdict` starts null and only a human sets it — the whole point
// is to put a judgement in the loop that no agent made.
export function holdoutRecord(holdout, { ts = Date.now(), roundId = null, poolSize = 0 } = {}) {
  if (!holdout?.id) return null;
  return {
    id: `h_${ts.toString(36)}_${String(holdout.id).slice(-6)}`,
    ts,
    roundId,
    memoId: holdout.id,
    // The text is copied, not referenced: the whole question is what happens
    // to facts over time, and a record pointing at a memo that was later
    // edited or evicted would quietly rewrite its own history.
    text: holdout.text,
    by: holdout.by || null,
    poolSize,
    verdict: null, // null | 'fine' | 'missed'
    judgedAt: null,
  };
}

export function addHoldoutRecord(records, rec) {
  if (!rec) return records || [];
  const next = [...(records || []), rec];
  return next.length > HOLDOUT_LOG_CAP ? next.slice(next.length - HOLDOUT_LOG_CAP) : next;
}

export function judgeHoldout(records, id, verdict) {
  if (verdict !== 'fine' && verdict !== 'missed') return records || [];
  return (records || []).map((r) =>
    r.id === id ? { ...r, verdict, judgedAt: Date.now() } : r);
}

// The most recent trial the user has not ruled on yet — what the transcript
// asks about once a round finishes.
export function pendingHoldout(records) {
  const list = records || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].verdict === null) return list[i];
  }
  return null;
}

// What the log says so far.
//
// `missed` is the only column that argues for keeping a fact. A fact withheld
// repeatedly with nothing ever going wrong is not "unproven" — it is evidence,
// and after enough trials it is the thing to delete. That is deliberately the
// opposite of the old ranking, where a fact nobody ever used looked exactly
// like a fact everybody relied on.
export function holdoutStats(records) {
  const list = (records || []).filter(Boolean);
  const judged = list.filter((r) => r.verdict);
  const perMemo = new Map();
  for (const r of list) {
    const cur = perMemo.get(r.memoId) || { memoId: r.memoId, text: r.text, trials: 0, missed: 0, fine: 0 };
    cur.trials += 1;
    if (r.verdict === 'missed') cur.missed += 1;
    if (r.verdict === 'fine') cur.fine += 1;
    perMemo.set(r.memoId, cur);
  }
  return {
    trials: list.length,
    judged: judged.length,
    missed: judged.filter((r) => r.verdict === 'missed').length,
    fine: judged.filter((r) => r.verdict === 'fine').length,
    // Withheld at least twice, never once missed. These are the candidates for
    // deletion — and the first honest answer the store has ever been able to
    // give to "which of these is actually earning its place?".
    deadWeight: [...perMemo.values()]
      .filter((m) => m.fine >= 2 && m.missed === 0)
      .sort((a, b) => b.fine - a.fine),
    perMemo: [...perMemo.values()],
  };
}
