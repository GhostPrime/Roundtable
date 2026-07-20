import { useState } from 'react';

// Web context preview: everything the seats pulled into context from the web
// this session (CHECK: web_search / fetch_url results), in one place — so you
// can see what the AIs are actually reading without hunting through collapsed
// tool bubbles. Read-only view over the transcript; nothing here re-fetches.

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function WebCard({ item, flash }) {
  const [open, setOpen] = useState(false);
  const isFetch = item.op === 'fetch_url';
  return (
    <div className={`script-card web-card ${item.failed ? 'failed' : ''}`}>
      <div className="script-head">
        <span className="script-lang">{isFetch ? 'fetch' : 'search'}</span>
        <span className="script-name" title={item.arg}>{item.arg}</span>
        {item.by && (
          <span className="script-src">
            {item.color && <span className="rail-dot" style={{ background: item.color }} />}
            {item.by}
          </span>
        )}
      </div>
      {item.failed ? (
        <div className="web-failed">{item.body || 'failed'}</div>
      ) : (
        <>
          <button className="tool-toggle web-toggle" onClick={() => setOpen((v) => !v)}>
            <span className="tool-chevron">{open ? '▾' : '▸'}</span>
            {open ? 'collapse' : `preview — ${item.body.length.toLocaleString()} chars in context`}
          </button>
          {open && <pre className="script-code web-body">{item.body}</pre>}
        </>
      )}
      <div className="script-actions">
        <button onClick={async () => flash((await copyText(item.body)) ? 'Copied' : 'Copy failed')} disabled={!item.body}>
          Copy
        </button>
        {isFetch && (
          <button title="Open the live page in your browser" onClick={() => window.open(item.arg)}>
            Open ↗
          </button>
        )}
      </div>
    </div>
  );
}

export default function WebPanel({ items, onClose }) {
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const flash = (msg) => {
    setStatus(msg);
    setTimeout(() => setStatus(''), 1500);
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? items.filter((it) => it.arg.toLowerCase().includes(q) || it.body.toLowerCase().includes(q))
    : items;
  const chars = items.reduce((n, it) => n + (it.failed ? 0 : it.body.length), 0);

  return (
    <aside className="scripts-panel web-panel">
      <div className="scripts-head">
        <span className="scripts-title">🌐 Web context</span>
        <span className="scripts-count" title="Characters of web content sitting in this session's context">
          {items.length} · {chars.toLocaleString()} chars
        </span>
        <span className="scripts-status">{status}</span>
        <button className="icon icon-x" title="Close panel" aria-label="Close web context panel" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="scripts-body">
        {items.length === 0 && (
          <p className="scripts-empty">
            Nothing from the web yet. When a seat runs CHECK: web_search or CHECK: fetch_url, the
            content it pulls into context shows up here.
          </p>
        )}
        {items.length > 1 && (
          <input
            className="web-filter"
            placeholder="Filter by query, URL, or content…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        {q && shown.length === 0 && <p className="scripts-empty">No matches.</p>}
        {shown.map((it) => (
          <WebCard key={it.id} item={it} flash={flash} />
        ))}
      </div>
    </aside>
  );
}
