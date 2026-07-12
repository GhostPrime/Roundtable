import { useState, useEffect } from 'react';

const api = window.api;

// Map a fenced-block language hint to a sensible download filename extension.
const LANG_EXT = {
  js: 'js', javascript: 'js', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx',
  py: 'py', python: 'py', rb: 'rb', ruby: 'rb', go: 'go', rust: 'rs', rs: 'rs',
  java: 'java', c: 'c', cpp: 'cpp', cs: 'cs', php: 'php', sh: 'sh', bash: 'sh',
  html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yml', sql: 'sql',
  md: 'md', markdown: 'md',
};
function scriptFileName(lang, idx) {
  const ext = LANG_EXT[(lang || '').toLowerCase()] || 'txt';
  return `script-${idx + 1}.${ext}`;
}
const baseName = (p) => (p || '').split(/[\\/]/).pop() || p;

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
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

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ScriptsPanel({ scripts, files, projectPath, onClose }) {
  // Lazy-loaded content for agent-written files (read from disk on demand).
  const [fileContent, setFileContent] = useState({}); // path -> string | null
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const f of files) {
        if (fileContent[f.path] !== undefined) continue;
        try {
          const r = await api.runCheck({ op: 'read_file', arg: f.path }, projectPath, null);
          if (!cancelled) {
            setFileContent((prev) => ({ ...prev, [f.path]: r?.ok ? r.output : null }));
          }
        } catch {
          if (!cancelled) setFileContent((prev) => ({ ...prev, [f.path]: null }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, projectPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (msg) => {
    setStatus(msg);
    setTimeout(() => setStatus(''), 1500);
  };

  const doCopy = async (text) => flash((await copyText(text)) ? 'Copied' : 'Copy failed');
  const doDownload = (name, text) => {
    downloadText(name, text);
    flash('Downloaded');
  };
  const doSave = async (name, text) => {
    try {
      const saved = await api.saveScript(projectPath, name, text);
      flash(saved ? `Saved ${baseName(saved)}` : 'Save cancelled');
    } catch (e) {
      flash(`Save failed: ${e.message}`);
    }
  };

  const total = scripts.length + files.length;

  return (
    <aside className="scripts-panel">
      <div className="scripts-head">
        <span className="scripts-title">Scripts</span>
        <span className="scripts-count">{total}</span>
        <span className="scripts-status">{status}</span>
        <button className="icon icon-x" title="Close panel" aria-label="Close scripts panel" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="scripts-body">
        {total === 0 && (
          <p className="scripts-empty">
            No scripts yet. Code blocks the AIs write — and files they save in Build mode — show up here.
          </p>
        )}

        {files.length > 0 && <div className="scripts-section">Written to the project</div>}
        {files.map((f) => {
          const content = fileContent[f.path];
          return (
            <div className="script-card" key={`file:${f.path}`}>
              <div className="script-head">
                <span className="script-lang">file</span>
                <span className="script-name" title={f.path}>{baseName(f.path)}</span>
                {f.agent && <span className="script-src">{f.agent}</span>}
              </div>
              <pre className="script-code">
                {content === undefined ? 'Loading…' : content === null ? '(could not read file)' : content}
              </pre>
              <div className="script-actions">
                <button onClick={() => doCopy(content || '')} disabled={!content}>Copy</button>
                <button onClick={() => doDownload(baseName(f.path), content || '')} disabled={!content}>Download</button>
                <button onClick={() => api.revealFile(projectPath, f.path)}>Reveal</button>
              </div>
            </div>
          );
        })}

        {scripts.length > 0 && <div className="scripts-section">From the discussion</div>}
        {scripts.map((s, i) => (
          <div className="script-card" key={`block:${i}`}>
            <div className="script-head">
              <span className="script-lang">{s.lang || 'text'}</span>
              <span className="script-src">{s.source}</span>
            </div>
            <pre className="script-code">{s.code}</pre>
            <div className="script-actions">
              <button onClick={() => doCopy(s.code)}>Copy</button>
              <button onClick={() => doDownload(scriptFileName(s.lang, i), s.code)}>Download</button>
              <button onClick={() => doSave(scriptFileName(s.lang, i), s.code)}>Save to project</button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
