// Cross-session search: scan every saved session's transcript text from one
// modal; clicking a hit hands { sessionId, key, index } back to App, which
// switches session and scrolls to the bubble. Payloads are loaded lazily
// (newest-first) and cached in a ref so retyping is cheap; the scan stops
// early once 50 hits are collected. Modeled on MemoryPanel: modal-backdrop/
// modal with a mouse-down backdrop close.
import { useState, useEffect, useRef } from 'react';

const api = window.api;

// ~120-char window centered on the first match, split into plain parts so the
// match can be wrapped in <mark> without dangerouslySetInnerHTML.
function makeSnippet(text, q) {
  const mi = text.toLowerCase().indexOf(q);
  if (mi < 0) return null;
  const radius = 55;
  const start = Math.max(0, mi - radius);
  const end = Math.min(text.length, mi + q.length + radius);
  return {
    prefix: start > 0 ? '…' : '',
    before: text.slice(start, mi),
    match: text.slice(mi, mi + q.length),
    after: text.slice(mi + q.length, end),
    suffix: end < text.length ? '…' : '',
  };
}

// Non-seat speakers never label a thread; used to recover a removed seat's
// name from the thread's own entries when it's gone from the live roster.
const NON_SEAT_SPEAKERS = new Set(['You', 'System', 'Tool']);
function threadLabel(key, entries, seatNames) {
  const named = seatNames.get(key);
  if (named) return named;
  const e = entries.find((x) => x?.speaker && !NON_SEAT_SPEAKERS.has(x.speaker));
  return e ? e.speaker : key;
}

export default function SessionSearch({ onClose, onJump, busy, agents = [] }) {
  const [index, setIndex] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const cacheRef = useRef(new Map()); // sessionId → payload | null

  useEffect(() => {
    let alive = true;
    (api.listSessions?.() ?? Promise.resolve([]))
      .then((idx) => { if (alive) setIndex(Array.isArray(idx) ? idx : []); })
      .catch(() => { if (alive) setIndex([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const seatNames = new Map(agents.map((a) => [a.id, a.name]));
    const timer = setTimeout(async () => {
      const hits = [];
      for (const s of index) {
        if (cancelled) return;
        let payload = cacheRef.current.get(s.id);
        if (payload === undefined) {
          payload = await api.loadSession(s.id).catch(() => null);
          if (cancelled) return;
          cacheRef.current.set(s.id, payload);
        }
        if (!payload) continue;
        const transcripts = payload.transcripts && typeof payload.transcripts === 'object'
          ? payload.transcripts : {};
        for (const key of Object.keys(transcripts)) {
          const entries = transcripts[key];
          if (!Array.isArray(entries)) continue;
          for (let idx = 0; idx < entries.length; idx++) {
            const e = entries[idx];
            const text = e?.text;
            if (!text) continue;
            if (text.toLowerCase().includes(q)) {
              hits.push({
                sessionId: s.id,
                sessionName: s.name || payload.name || 'Session',
                key,
                threadName: key === 'group' ? null : threadLabel(key, entries, seatNames),
                index: idx,
                speaker: e.speaker,
                snippet: makeSnippet(text, q),
                ts: payload.updatedAt,
              });
              if (hits.length >= 50) break;
            }
          }
          if (hits.length >= 50) break;
        }
        if (cancelled) return;
        setResults(hits.slice()); // progressive render as sessions resolve
        if (hits.length >= 50) break;
      }
      if (!cancelled) setSearching(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, index, agents]);

  // Group consecutive hits by session (scan order is already newest-first).
  const groups = [];
  for (const h of results) {
    const last = groups[groups.length - 1];
    if (last && last.sessionId === h.sessionId) last.hits.push(h);
    else groups.push({ sessionId: h.sessionId, sessionName: h.sessionName, hits: [h] });
  }

  const hasQuery = query.trim().length > 0;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal session-search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-head">
          <h2>🔍 Search all sessions</h2>
          <button className="icon icon-x" title="Close" onClick={onClose}>✕</button>
        </div>
        <input
          className="search-input"
          autoFocus
          placeholder="Search every saved session…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {busy && (
          <p className="hint">A round is running — results are locked until it finishes.</p>
        )}

        <div className="search-results">
          {!hasQuery && <p className="hint">Type to search all sessions.</p>}
          {hasQuery && results.length === 0 && !searching && (
            <p className="hint">No matches.</p>
          )}
          {groups.map((g) => (
            <div className="search-group" key={g.sessionId}>
              <div className="search-group-head">{g.sessionName}</div>
              {g.hits.map((h, j) => (
                <button
                  type="button"
                  className="search-hit"
                  key={`${h.key}-${h.index}-${j}`}
                  disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    onJump({ sessionId: h.sessionId, key: h.key, index: h.index });
                    onClose();
                  }}
                >
                  <span className="search-hit-meta">
                    <span className="search-speaker">{h.speaker}</span>
                    {h.key !== 'group' && <span className="search-thread">↳ {h.threadName}</span>}
                  </span>
                  <span className="search-snippet">
                    {h.snippet ? (
                      <>
                        {h.snippet.prefix}{h.snippet.before}
                        <mark>{h.snippet.match}</mark>
                        {h.snippet.after}{h.snippet.suffix}
                      </>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {searching && <p className="hint search-status">searching…</p>}
        </div>
      </div>
    </div>
  );
}
