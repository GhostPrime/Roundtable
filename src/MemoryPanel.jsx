// Memory panel: view and prune the project's cross-session fact pool
// (saved via MEMO: lines, injected into every seat's prompt as the `memory`
// stage). Deletes are instant — low stakes, facts are one sentence — and
// "Distill" hands the pool to one model to merge/prune (App owns the call).
// Modeled on McpSettings: modal-backdrop/modal, mouse-down close on backdrop.
import { useState, useEffect, useRef } from 'react';
import MemoryGraph from './MemoryGraph.jsx';

const MAX_MEMOS = 50; // must match electron/memory.js
const NUDGE_THRESHOLD = 40; // approaching MAX_MEMOS

// holdoutStats turns the trial log into the one question this pool could
// never answer before: which of these facts is actually earning its place?
// A fact withheld repeatedly with nothing ever going wrong is not 'unproven' —
// it is evidence, and the honest thing to do with it is delete it.
import { holdoutStats } from './memoryHoldout.js';

export default function MemoryPanel({
  memos,
  poolLabel, // "project <name>" | "global (no project)"
  poolId, // active project id (or 'global') — which pool `memos` is
  projects = [], // for resolving a pool's projectId to a readable name
  seatedAgents = [], // seated (not benched) seats — who's eligible to distill
  distillAgentId, // which seat would run the distill, or null when none
  distilling,
  busy, // a round is running — keep distill hands-off
  onDelete,
  onResolveDispute, // (memoId, 'wrong' | 'stands') => void
  holdoutLog = [],  // trials from the holdout experiment, for the badges
  onTogglePin,
  onChangeDistillAgent,
  onDistill,
  onSaveMemos, // (memos) => void — graph edits write the whole pool back
  onClearPool, // () => void — erase every fact in the ACTIVE pool. Other pools
               // are browsed, not edited, so this is never ambiguous.
  onClose,
}) {
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  // Clearing is the one memory action that cannot be walked back, so it takes
  // two clicks and disarms itself after four seconds. Never window.confirm —
  // Electron's modal dialog swallows keyboard input in this app (same reason
  // delete/pin use the instant, no-dialog pattern).
  const [clearArmed, setClearArmed] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!clearArmed) return undefined;
    const t = setTimeout(() => setClearArmed(false), 4000);
    return () => clearTimeout(t);
  }, [clearArmed]);

  // Hand the pool back as text before it goes. The argument that finally
  // landed about this store was that distilling it BEFORE auditing it destroys
  // the raw material you would need to find out which parts were load-bearing
  // — and a clear button with no copy is that mistake with a bigger blast
  // radius. One click, and the facts survive outside the app.
  async function copyPool() {
    // Author and date go with each fact. Stripping them is exactly the
    // generation loss that turned this pool into confident, sourceless
    // assertions in the first place.
    const stamp = (m) => [m.by, m.ts ? new Date(m.ts).toLocaleDateString() : '']
      .filter(Boolean).join(', ');
    const text = [
      `# ${poolLabel} — ${memos.length} fact${memos.length === 1 ? '' : 's'}, ${new Date().toLocaleString()}`,
      ...memos.map((m) => {
        const s = stamp(m);
        return `- ${m.text}${s ? `  (${s})` : ''}${m.pinned ? '  [pinned]' : ''}`;
      }),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied');
    } catch {
      setCopied('Copy failed');
    }
    setTimeout(() => setCopied(''), 1500);
  }
  // 'list' stays the default: it is the fastest way to skim and prune, and the
  // graph is the answer to a different question (what relates to what, what is
  // actually being used). Neither replaces the other.
  const [view, setView] = useState('list');
  // Pools other than the active one are BROWSED, not edited — switching the
  // app's project just to fix a memory would be a heavier action than the fix.
  const [pools, setPools] = useState([]);
  const stats = holdoutStats(holdoutLog);
  const [openPool, setOpenPool] = useState(null); // { projectId, memos, links }
  const [loadingPool, setLoadingPool] = useState(false);
  const lastPoolRef = useRef(null); // last active project id this panel synced to

  // Which pool is on screen. A ref because the refresh effect below must read
  // it without re-running every time it changes.
  const openedRef = useRef(null);
  useEffect(() => { openedRef.current = openPool?.projectId ?? null; }, [openPool]);

  // The project-card list. Cheap, and only needs re-reading when the graph opens.
  useEffect(() => {
    if (view !== 'graph') return undefined;
    let live = true;
    (async () => {
      const p = await (window.api.memoryPools?.() ?? []);
      if (live) setPools(p || []);
    })();
    return () => { live = false; };
  }, [view]);

  // Edges for the ACTIVE pool, refreshed whenever its facts change (an edit
  // here, or a seat saving a MEMO: mid-round).
  //
  // The guard matters: this used to reset openPool unconditionally, so a seat
  // saving a fact while you were browsing another project's map yanked you
  // back to the active one mid-look. Only re-point the view at the active pool
  // when the active pool is what you are already looking at — or when the app's
  // project changed underneath you, which SHOULD move the view.
  useEffect(() => {
    if (view !== 'graph') return undefined;
    const browsingElsewhere = openedRef.current && openedRef.current !== poolId;
    if (browsingElsewhere && poolId === lastPoolRef.current) return undefined;
    lastPoolRef.current = poolId;
    let live = true;
    (async () => {
      const l = await (window.api.memoryLinks?.(poolId) ?? {});
      if (!live) return;
      setOpenPool({
        projectId: poolId,
        memos,
        links: l?.links || [],
        related: l?.related || [],
        chain: l?.chain || [],
        root: l?.root || null,
      });
    })();
    return () => { live = false; };
  }, [view, poolId, memos]);

  const projectName = (id) =>
    id === 'global' ? 'global (no project)' : projects.find((p) => p.id === id)?.name || id;

  // Always refetch the edges for the pool being opened — including when
  // returning to the ACTIVE one. This used to spread the previously-open
  // pool's links/chain/root onto the active pool's facts; every edge then
  // named an id that pool doesn't contain, got dropped as unknown, and the
  // active map redrew with almost no connections.
  // Facts come from React state for the active pool (authoritative, and in
  // lockstep with the list view) and from disk for any other.
  async function openOtherPool(projectId) {
    setLoadingPool(true);
    const r = await (window.api.memoryLinks?.(projectId) ?? {});
    setLoadingPool(false);
    setOpenPool({
      projectId,
      memos: projectId === poolId ? memos : (r?.memos || []),
      links: r?.links || [],
      related: r?.related || [],
      chain: r?.chain || [],
      root: r?.root || null,
    });
  }

  const viewingActive = !openPool || openPool.projectId === poolId;
  const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString() : '');
  const distillAgent = seatedAgents.find((a) => a.id === distillAgentId) || null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal mcp-form ${view === 'graph' ? 'mem-modal-wide' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>🧷 Shared memory</h2>
        <p className="hint">
          Facts saved with MEMO: lines — pool: {poolLabel}. Every seat sees
          these at the start of each turn and treats them as true.
        </p>

        <div className="mem-views">
          <button
            type="button"
            className={`mini-btn ${view === 'list' ? 'active' : ''}`}
            onClick={() => setView('list')}
          >
            ☰ List
          </button>
          <button
            type="button"
            className={`mini-btn ${view === 'graph' ? 'active' : ''}`}
            title="See which facts are about the same subject, and which are actually being used"
            onClick={() => setView('graph')}
          >
            ◦—◦ Graph
          </button>
          <span className="hint" style={{ marginLeft: 'auto' }}>
            {memos.length}/{MAX_MEMOS} in this pool
          </span>
        </div>

        {!nudgeDismissed && memos.length >= NUDGE_THRESHOLD && (
          <p className="form-warn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>
              <strong>{memos.length}</strong> facts saved — getting close to the
              cap. A Distill pass can merge overlaps and drop stale ones.
            </span>
            <button type="button" className="mini-btn" onClick={() => setNudgeDismissed(true)}>
              Dismiss
            </button>
          </p>
        )}

        {view === 'graph' && (
          <>
            {pools.length > 1 && (
              <div className="mem-pools">
                {pools.map((p) => (
                  <button
                    key={p.projectId}
                    type="button"
                    className={`mem-pool-card ${openPool?.projectId === p.projectId ? 'active' : ''}`}
                    onClick={() => openOtherPool(p.projectId)}
                  >
                    <span className="mem-pool-name">{projectName(p.projectId)}</span>
                    <span className="mem-pool-stats">
                      {p.count} facts
                      {p.pinned ? ` · ${p.pinned} pinned` : ''}
                      {p.unused ? ` · ${p.unused} unused` : ''}
                    </span>
                    {p.projectId === poolId && <span className="mem-pool-tag">active</span>}
                  </button>
                ))}
              </div>
            )}
            {!viewingActive && (
              <p className="form-warn">
                Browsing <strong>{projectName(openPool.projectId)}</strong> — read-only.
                Switch the app to that project to edit its facts.
              </p>
            )}
            {loadingPool ? (
              <p className="hint">Loading…</p>
            ) : (
              <MemoryGraph
                memos={openPool?.memos || []}
                links={openPool?.links || []}
                related={openPool?.related || []}
                chain={openPool?.chain || []}
                root={openPool?.root || null}
                busy={busy}
                readOnly={!viewingActive}
                onSave={viewingActive ? onSaveMemos : () => {}}
              />
            )}
          </>
        )}

        {view === 'list' && memos.length === 0 && (
          <p className="hint">
            Nothing saved yet. Seats save facts by ending a message with
            “MEMO: &lt;one short sentence&gt;” — you can type one too.
          </p>
        )}

        {view === 'list' && memos.map((m) => {
          const trial = stats.perMemo.find((x) => x.memoId === m.id);
          return (
          <div className="folder-row" key={m.id} style={{ alignItems: 'baseline' }}>
            <span style={{ flex: 1 }}>
              {m.text}
              <span className="hint" style={{ marginLeft: 8 }}>
                {m.by ? `${m.by} · ` : ''}
                {fmtDay(m.ts)}
              </span>
              {/* Withheld more than once with nothing ever lost. Not proof it
                  is false — proof it is not doing any work. */}
              {trial && trial.fine >= 2 && trial.missed === 0 && (
                <span className="mem-dead" title={`Withheld from ${trial.fine} rounds and never missed. Nothing has needed it yet.`}>
                  never missed ×{trial.fine}
                </span>
              )}
              {trial && trial.missed > 0 && (
                <span className="mem-earned" title={`Withheld and missed ${trial.missed} time(s) — this fact is doing work.`}>
                  earned its place
                </span>
              )}
              {/* A seat challenged this fact. It stays and keeps asserting
                  until a PERSON rules on it — one agent silently deleting
                  another agent's fact would be the same closed loop with a
                  delete key. */}
              {m.disputed && (
                <span className="mem-disputed">
                  <strong>disputed</strong>
                  {m.disputed.by ? ` by ${m.disputed.by}` : ''}
                  {m.disputed.why ? `: ${m.disputed.why}` : ''}
                  <button type="button" className="mini-btn" title="The challenge is right — forget this fact"
                    onClick={() => onResolveDispute?.(m.id, 'wrong')}>it was wrong</button>
                  <button type="button" className="mini-btn" title="The fact is fine — clear the challenge"
                    onClick={() => onResolveDispute?.(m.id, 'stands')}>it stands</button>
                </span>
              )}
            </span>
            <button
              type="button"
              className={`mini-btn ${m.pinned ? 'active' : ''}`}
              title={m.pinned ? 'Pinned — never auto-evicted. Click to unpin.' : 'Pin — never auto-evicted when the pool overflows'}
              onClick={() => onTogglePin(m.id)}
            >
              📌
            </button>
            <button
              type="button"
              className="mini-btn"
              title="Forget this fact"
              onClick={() => onDelete(m.id)}
            >
              ✕
            </button>
          </div>
          );
        })}

        {seatedAgents.length > 0 && (
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            Distill via
            <select
              value={distillAgentId || ''}
              onChange={(e) => onChangeDistillAgent(e.target.value || null)}
              disabled={distilling || busy}
            >
              {seatedAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        )}

        <div className="modal-actions">
          {/* Copy sits immediately left of Clear on purpose: the escape hatch
              should be the thing your eye passes on the way to the drop. */}
          <button
            type="button"
            className="ghost"
            disabled={memos.length === 0}
            title="Copy every fact in this pool as text, so clearing is not the only record of what was here"
            onClick={copyPool}
          >
            {copied || 'Copy all'}
          </button>
          <button
            type="button"
            className={`ghost mem-clear ${clearArmed ? 'armed' : ''}`}
            disabled={memos.length === 0 || distilling}
            title={
              clearArmed
                ? 'Click again to erase every fact in this pool. This cannot be undone.'
                : `Erase all ${memos.length} fact${memos.length === 1 ? '' : 's'} in ${poolLabel}, and the holdout trials for them`
            }
            onClick={() => {
              if (!clearArmed) { setClearArmed(true); return; }
              setClearArmed(false);
              onClearPool?.();
            }}
          >
            {clearArmed
              ? `Erase ${memos.length}? Click again`
              : 'Clear pool'}
          </button>
          <button
            type="button"
            disabled={distilling || busy || memos.length < 2 || !distillAgent}
            title={
              !distillAgent
                ? 'Needs at least one configured seat'
                : busy
                  ? 'Wait for the current round to finish'
                  : `Ask ${distillAgent.name} to merge duplicates and drop stale facts`
            }
            onClick={onDistill}
          >
            {distilling ? 'Distilling…' : `Distill${distillAgent ? ` (via ${distillAgent.name})` : ''}`}
          </button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
