import { Fragment, useState, useEffect, useMemo } from 'react';
import { highlightCode } from './Markdown.jsx';
// LANG_EXT / EXT_LANG / extOf / langOfPath moved to langMap.js so EditorPanel
// can reuse the same table. Same definitions, same behaviour.
import { LANG_EXT, extOf, langOfPath, sniffLang } from './langMap.js';
import { groupScripts } from './scriptGroups.js';

const api = window.api;

function scriptFileName(lang, idx) {
  const ext = LANG_EXT[(lang || '').toLowerCase()] || 'txt';
  return `script-${idx + 1}.${ext}`;
}
const baseName = (p) => (p || '').split(/[\\/]/).pop() || p;
// One label per language across both lists: fence hints ("javascript") and
// file extensions ("js") collapse to the same chip.
const langKey = (lang) => {
  const l = (lang || '').toLowerCase();
  return LANG_EXT[l] || l || 'text';
};
// The language to actually show/highlight/download-with for a discussion
// block: the fence hint when the seat bothered to write one, otherwise a sniff
// of the body. Untagged blocks used to pile up as identical "TEXT" chips.
const effLang = (s) => String(s?.lang || '').trim() || sniffLang(s?.code);

// highlightCode() returns one flat stream of strings + <span> tokens for the
// whole block. Re-slice that stream at newlines so every line can be its own
// grid row beside a line-number cell — highlighting stays whole-block accurate
// (multi-line comments and template strings included), which per-line
// re-highlighting would lose.
function highlightLines(code, lang) {
  const lines = [[]];
  let k = 0;
  const cut = (text, make) => {
    const parts = String(text ?? '').split('\n');
    parts.forEach((p, i) => {
      if (i) lines.push([]);
      if (p) lines[lines.length - 1].push(make(p));
    });
  };
  for (const tok of highlightCode(String(code ?? ''), lang)) {
    if (typeof tok === 'string') cut(tok, (p) => p);
    else cut(tok.props.children, (p) => <span key={k++} className={tok.props.className}>{p}</span>);
  }
  return lines;
}

// Highlighted code body with a line-number gutter. `wrap` swaps the text
// column between `pre` and `pre-wrap`; the gutter is a separate grid cell, so
// nothing it renders can leak into a copy/download of the raw string.
function CodeBody({ code, lang, wrap }) {
  const lines = useMemo(() => highlightLines(code, lang), [code, lang]);
  return (
    <pre className={`script-code ${wrap ? 'wrap' : ''}`}>
      <code className="script-lines">
        {lines.map((parts, i) => (
          <Fragment key={i}>
            <span className="script-lineno" aria-hidden="true">{i + 1}</span>
            <span className="script-linetext">{parts}</span>
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

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

// Flatten project:tree into the list of file paths (forward-slashed, as main
// builds them) for the Phase 3 "does this snippet name a real file?" lookup.
function flattenFiles(node, out = []) {
  for (const c of node?.children || []) {
    if (c.type === 'file') out.push(c.path);
    else flattenFiles(c, out);
  }
  return out;
}

export default function ScriptsPanel({ scripts, files, projectPath, onApplyToFile, onClose }) {
  // Lazy-loaded content for agent-written files (read from disk on demand).
  const [fileContent, setFileContent] = useState({}); // path -> string | null
  const [status, setStatus] = useState('');
  const [wrap, setWrap] = useState(false); // panel-wide word-wrap
  const [query, setQuery] = useState('');
  const [langFilter, setLangFilter] = useState(null);
  const [projectFiles, setProjectFiles] = useState([]); // real files under the root
  const [diffBusy, setDiffBusy] = useState(null); // code body currently being applied
  const [openGroup, setOpenGroup] = useState(null); // key of the one expanded stack
  const [verSel, setVerSel] = useState({}); // group key -> index into versions

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

  // Project tree once per root — only needed to resolve snippet path hints.
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) {
      setProjectFiles([]);
      return undefined;
    }
    api.projectTree?.(projectPath).then((r) => {
      if (!cancelled) setProjectFiles(r?.ok ? flattenFiles(r) : []);
    }).catch(() => {
      if (!cancelled) setProjectFiles([]);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

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

  // Phase 3 — the file a snippet is probably meant to replace. Deliberately
  // dumb: a path the seat mentioned next to the fence that actually exists in
  // the project. Exact path wins; otherwise a basename that's unique in the
  // tree. Ambiguous or unknown → null, and the card looks as it always has.
  const targetPath = (s) => {
    if (!projectPath || !projectFiles.length) return null;
    for (const hint of s.hints || []) {
      const h = hint.toLowerCase();
      const exact = projectFiles.find((p) => p.toLowerCase() === h);
      if (exact) return exact;
      const tail = projectFiles.filter((p) => p.toLowerCase().endsWith(`/${h}`));
      if (tail.length === 1) return tail[0];
    }
    return null;
  };

  const doDiffApply = async (s, target) => {
    if (!onApplyToFile) return;
    setDiffBusy(s.code);
    try {
      let oldText = null;
      try {
        const r = await api.runCheck({ op: 'read_file', arg: target }, projectPath, null);
        if (r?.ok) oldText = r.output;
      } catch {
        /* treat as a new file — the modal renders an all-additions diff */
      }
      // extractScripts right-trims fenced blocks; keep the file's trailing
      // newline so the diff doesn't show a spurious last-line change. Done
      // BEFORE the modal, so the user still approves exactly what gets written.
      const content =
        oldText && oldText.endsWith('\n') && !s.code.endsWith('\n') ? `${s.code}\n` : s.code;
      const res = await onApplyToFile({
        path: target,
        oldText,
        content,
        agentName: s.source,
      });
      if (res?.ok) flash(`Applied to ${baseName(target)}`);
      else if (res?.rejected) flash('Rejected — file untouched');
      else if (res?.cancelled) flash('Save cancelled');
      else if (res?.error) flash(res.error);
    } finally {
      setDiffBusy(null);
    }
  };

  // ---- one card per written file ------------------------------------------
  // App's recordWrite already keeps ONE entry per path (a re-write replaces
  // the old entry rather than appending), so repeated writes never produce
  // duplicate cards — with one gap: two seats can name the same file with
  // different separators ("src/app.js" vs "src\app.js"). Fold those together
  // here, newest wins. Nothing upstream retains previous contents, so there is
  // no earlier version to expand — the card always shows what's on disk now.
  const groupedFiles = useMemo(() => {
    const byPath = new Map();
    for (const f of files) {
      const k = String(f.path ?? '').replace(/\\/g, '/');
      const prev = byPath.get(k);
      if (!prev || (f.ts || 0) > (prev.ts || 0)) byPath.set(k, f);
    }
    return [...byPath.values()];
  }, [files]);

  // ---- one row per snippet identity ---------------------------------------
  // Four seats re-pasting the same file used to mean fourteen near-identical
  // cards. Fold them into version stacks keyed by resolved file (or, when the
  // block names no real file, by language + first line).
  const groups = useMemo(
    () => groupScripts(scripts, targetPath),
    [scripts, projectFiles, projectPath], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- search + language filter -------------------------------------------
  // Everything below counts GROUPS, not raw blocks: chip numbers, the header
  // count and the "no matches" test all have to agree with what's rendered.
  const q = query.trim().toLowerCase();
  const matchesText = (...parts) => !q || parts.some((p) => String(p ?? '').toLowerCase().includes(q));

  const langCounts = new Map();
  const bump = (k) => langCounts.set(k, (langCounts.get(k) || 0) + 1);
  for (const f of groupedFiles) bump(extOf(f.path) || 'file');
  for (const g of groups) bump(langKey(g.lang));
  const langChips = [...langCounts.keys()].sort();

  const shownFiles = groupedFiles.filter(
    (f) =>
      (!langFilter || (extOf(f.path) || 'file') === langFilter) &&
      matchesText(f.path, fileContent[f.path], f.agent),
  );
  // A stack matches the text query if ANY of its versions does — searching for
  // a line only one revision contains still surfaces the file.
  const shownGroups = groups.filter(
    (g) =>
      (!langFilter || langKey(g.lang) === langFilter) &&
      (!q ||
        g.versions.some((s) => matchesText(s.code, s.source, effLang(s))) ||
        matchesText(g.target)),
  );

  const total = groups.length + groupedFiles.length;
  const shownTotal = shownFiles.length + shownGroups.length;
  const filtering = Boolean(q) || Boolean(langFilter);
  const countTitle =
    scripts.length > groups.length
      ? `${scripts.length} blocks in ${groups.length} groups, plus ${groupedFiles.length} written file${groupedFiles.length === 1 ? '' : 's'}`
      : undefined;

  const wrapBtn = (
    <button
      type="button"
      className="mini-btn script-wrap"
      title={wrap ? 'Switch to no wrapping (scroll long lines)' : 'Wrap long lines'}
      onClick={() => setWrap((v) => !v)}
    >
      {wrap ? 'no-wrap' : 'wrap'}
    </button>
  );

  return (
    <aside className="scripts-panel">
      <div className="scripts-head">
        <span className="scripts-title">Scripts</span>
        <span className="scripts-count" title={countTitle}>
          {filtering ? `${shownTotal}/${total}` : total}
        </span>
        <span className="scripts-status">{status}</span>
        <button className="icon icon-x" title="Close panel" aria-label="Close scripts panel" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="scripts-body">
        {total > 0 && (
          <div className="scripts-filter">
            <input
              className="web-filter"
              type="text"
              value={query}
              placeholder="Search code…"
              aria-label="Search scripts"
              onChange={(e) => setQuery(e.target.value)}
            />
            {langChips.length >= 2 && (
              <div className="scripts-chips">
                <button
                  type="button"
                  className={`speaker-chip ${!langFilter ? 'active' : ''}`}
                  onClick={() => setLangFilter(null)}
                >
                  All
                </button>
                {langChips.map((k) => (
                  <button
                    type="button"
                    key={k}
                    className={`speaker-chip ${langFilter === k ? 'active' : ''}`}
                    onClick={() => setLangFilter(langFilter === k ? null : k)}
                  >
                    {k} <span className="chip-n">{langCounts.get(k)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {total === 0 && (
          <p className="scripts-empty">
            No scripts yet. Code blocks the AIs write — and files they save in Build mode — show up here.
          </p>
        )}

        {total > 0 && shownTotal === 0 && (
          <p className="scripts-empty">
            No scripts match{q ? ` "${query.trim()}"` : ''}
            {langFilter ? `${q ? ' in' : ''} ${langFilter}` : ''}.
          </p>
        )}

        {shownFiles.length > 0 && <div className="scripts-section">Written to the project</div>}
        {shownFiles.map((f) => {
          const content = fileContent[f.path];
          const lang = langOfPath(f.path);
          return (
            <div className="script-card" key={`file:${f.path}`}>
              <div className="script-head">
                <span className="script-lang">{extOf(f.path) || 'file'}</span>
                <span className="script-name" title={f.path}>{baseName(f.path)}</span>
                {wrapBtn}
                <span className="script-src">
                  {f.agent ? `${f.agent} · ` : ''}
                  {f.ts ? new Date(f.ts).toLocaleTimeString() : ''}
                </span>
              </div>
              {content === undefined || content === null ? (
                <pre className="script-code">
                  {content === undefined ? 'Loading…' : '(could not read file)'}
                </pre>
              ) : (
                <CodeBody code={content} lang={lang} wrap={wrap} />
              )}
              <div className="script-actions">
                <button onClick={() => doCopy(content || '')} disabled={!content}>Copy</button>
                <button onClick={() => doDownload(baseName(f.path), content || '')} disabled={!content}>Download</button>
                <button onClick={() => api.revealFile(projectPath, f.path)}>Reveal</button>
                <button
                  title="Open with the OS default application"
                  onClick={() => api.openFile?.(projectPath, f.path)}
                >
                  Open
                </button>
              </div>
            </div>
          );
        })}

        {shownGroups.length > 0 && <div className="scripts-section">From the discussion</div>}
        {shownGroups.map((g) => {
          const n = g.versions.length;
          const open = openGroup === g.key;
          // Newest is index 0 (groupScripts keeps input order, newest-first).
          const vi = Math.min(Math.max(verSel[g.key] ?? 0, 0), n - 1);
          const s = g.versions[vi];
          const newest = g.versions[0];
          const lang = effLang(s);
          // Per-version resolution, exactly as before grouping — the diff
          // action still targets whatever THIS revision pointed at.
          const target = targetPath(s);
          // Index in the UNFILTERED list — download names stay stable while
          // the user types in the search box.
          const i = scripts.indexOf(s);
          const label = g.target ? baseName(g.target) : 'unsaved snippet';
          return (
            <div className={`script-card script-group${open ? ' open' : ''}`} key={g.key}>
              <button
                type="button"
                className="tree-row script-group-row"
                aria-expanded={open}
                title={g.target || 'No matching project file — grouped by first line'}
                onClick={() => setOpenGroup(open ? null : g.key)}
              >
                <span className="tree-arrow">{open ? '▾' : '▸'}</span>
                <span className="tree-name">{label}</span>
                <span className="script-lang">{langKey(g.lang)}</span>
                {n > 1 && <span className="tree-badge">×{n}</span>}
                <span className="review-meta">
                  {newest.source}
                  {newest.ts ? ` · ${newest.ts}` : ''}
                </span>
              </button>
              {open && (
                <>
                  <div className="script-head">
                    <span className="script-lang">{lang}</span>
                    {n > 1 && (
                      <select
                        className="script-ver"
                        value={vi}
                        aria-label="Version"
                        onChange={(e) =>
                          setVerSel((prev) => ({ ...prev, [g.key]: Number(e.target.value) }))
                        }
                      >
                        {g.versions.map((v, k) => (
                          <option key={k} value={k}>
                            {`v${n - k} · ${v.source}${v.ts ? ` · ${v.ts}` : ''}`}
                          </option>
                        ))}
                      </select>
                    )}
                    {wrapBtn}
                    <span className="script-src">
                      {s.source}
                      {s.ts ? ` · ${s.ts}` : ''}
                    </span>
                  </div>
                  <CodeBody code={s.code} lang={lang} wrap={wrap} />
                  <div className="script-actions">
                    <button onClick={() => doCopy(s.code)}>Copy</button>
                    <button onClick={() => doDownload(scriptFileName(lang, i), s.code)}>Download</button>
                    <button onClick={() => doSave(scriptFileName(lang, i), s.code)}>Save to project</button>
                    {target && onApplyToFile && (
                      <button
                        title={`Compare this block with ${target} and apply it through the write-approval diff`}
                        disabled={diffBusy === s.code}
                        onClick={() => doDiffApply(s, target)}
                      >
                        {diffBusy === s.code ? 'Diffing…' : `Diff against ${baseName(target)}`}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
