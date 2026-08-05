// Per-project human editor. This is NOT a mini-IDE: the project holds a
// handful of hand-editable files, so the panel shows a plain list of them,
// opens ONE at a time, fills the window by default, and — the point of the
// whole thing — paints the lines the table's models changed this session.
//
// Monaco is a ~single-file React wrapper — no @monaco-editor/react, because
// that loads Monaco from a CDN by default and the renderer CSP (and a desktop
// app) forbids that. Everything Monaco is behind a dynamic import() so chat
// startup never pays for it: the ?worker&inline worker and the editor API are
// both pulled in on first mount of this panel, never before. The inline worker
// is a blob: URL, which is why index.html carries `worker-src 'self' blob:`.
//
// Reads/writes go through editor:read / editor:write in main, which jail every
// path to the approved project root AND refuse anything the file tree hides
// (.git, node_modules, dot-files). That is the security boundary; the diff
// approval below is UX.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WriteApproval from './WriteApproval.jsx';
import DiffModal from './DiffModal.jsx';
import { diffLines, collapseDiff } from './diffLines.js';
import { computeChangeMarks } from './editorDecorations.js';
import { langOfPath } from './langMap.js';

const api = window.api;

// The app's fence-language names (langOfPath's output, from langMap.js) →
// Monaco language ids. Only the languages named in LANG_EXT are wired up.
// NOTE: monaco-editor 0.56 has no basic-language JSON grammar (JSON is only
// covered by the language *service*, whose worker this panel deliberately does
// not load). JSON is a subset of JavaScript literal syntax, so the JS Monarch
// tokenizer highlights .json correctly — it is a colouring choice only, no
// diagnostics and no extra worker.
const MONACO_LANG = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rust: 'rust', java: 'java',
  c: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shell',
  html: 'html', css: 'css', json: 'javascript', yaml: 'yaml', yml: 'yaml',
  sql: 'sql', md: 'markdown',
};
const monacoLangOf = (p) => MONACO_LANG[langOfPath(p)] || 'plaintext';

const baseName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
// Seats write paths with whichever separator they used; project:tree always
// emits forward slashes. Compare on a normalised form, never raw.
const norm = (p) => String(p || '').replace(/\\/g, '/');

// project:tree → flat list of file paths (same shape ScriptsPanel flattens).
// The tree already hides .git / node_modules / dot-files, which is exactly the
// set editor:read and editor:write refuse — the list can't offer a file the
// IPC would reject.
function flattenFiles(node, out = []) {
  for (const c of node?.children || []) {
    if (c.type === 'file') out.push(c.path);
    else flattenFiles(c, out);
  }
  return out;
}

// One shared, memoised load of Monaco for the whole app session. Module-level
// so remounting the panel (per project) doesn't re-import anything.
let monacoPromise = null;
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    // ?worker&inline → the worker ships as a blob, so nothing depends on
    // relative worker-URL resolution under file:// (the classic Monaco-in-
    // Electron breakage). Core editor.worker ONLY: no ts/json/css/html
    // language-service workers, by design.
    const [workerMod, monaco] = await Promise.all([
      import('monaco-editor/editor/editor.worker.js?worker&inline'),
      import('monaco-editor/editor/editor.api'),
    ]);
    const EditorWorker = workerMod.default;
    self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
    // Monarch grammars for exactly the LANG_EXT language set. These register
    // lazily-loaded tokenizers on the main thread — no worker involved.
    await Promise.all([
      import('monaco-editor/languages/definitions/javascript/register.js'),
      import('monaco-editor/languages/definitions/typescript/register.js'),
      import('monaco-editor/languages/definitions/python/register.js'),
      import('monaco-editor/languages/definitions/ruby/register.js'),
      import('monaco-editor/languages/definitions/go/register.js'),
      import('monaco-editor/languages/definitions/rust/register.js'),
      import('monaco-editor/languages/definitions/java/register.js'),
      import('monaco-editor/languages/definitions/cpp/register.js'), // c + cpp
      import('monaco-editor/languages/definitions/csharp/register.js'),
      import('monaco-editor/languages/definitions/php/register.js'),
      import('monaco-editor/languages/definitions/shell/register.js'),
      import('monaco-editor/languages/definitions/html/register.js'),
      import('monaco-editor/languages/definitions/css/register.js'),
      import('monaco-editor/languages/definitions/yaml/register.js'),
      import('monaco-editor/languages/definitions/sql/register.js'),
      import('monaco-editor/languages/definitions/markdown/register.js'),
    ]);
    return monaco;
  })();
  return monacoPromise;
}

// changeMarks (line numbers in the current file) → Monaco decorations.
// monaco 0.56 API used: editor.createDecorationsCollection() /
// collection.set(IModelDeltaDecoration[]) / .clear(); range is a plain IRange
// object, options use isWholeLine + className (line background) and
// linesDecorationsClassName (the gutter bar, drawn in the lines-decorations
// margin that exists by default). linesDecorationsTooltip is the string
// tooltip for that margin.
function decorationsFor(marks, lineCount) {
  if (!marks) return [];
  const clamp = (n) => Math.min(Math.max(1, n), Math.max(1, lineCount));
  const out = [];
  const band = (ranges, cls, gutter, tip) => {
    for (const r of ranges) {
      out.push({
        range: {
          startLineNumber: clamp(r.start), startColumn: 1,
          endLineNumber: clamp(r.end), endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: cls,
          linesDecorationsClassName: gutter,
          linesDecorationsTooltip: tip,
        },
      });
    }
  };
  band(marks.changed, 'rt-line-change', 'rt-gutter-change', 'changed by the table this session');
  band(marks.added, 'rt-line-add', 'rt-gutter-add', 'added by the table this session');
  // A removed run has no line of its own in the current file, so it collapses
  // to a marker on the following line.
  for (const n of marks.deleted) {
    out.push({
      range: { startLineNumber: clamp(n), startColumn: 1, endLineNumber: clamp(n), endColumn: 1 },
      options: {
        isWholeLine: true,
        linesDecorationsClassName: 'rt-gutter-del',
        linesDecorationsTooltip: 'lines removed here by the table this session',
      },
    });
  }
  return out;
}

export default function EditorPanel({
  projectPath,
  onClose,
  onHumanWrite,
  approvalBusy,
  writtenFiles = [],
  baselines = {},
  agentColors = {},
}) {
  const [monaco, setMonaco] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [tree, setTree] = useState({ files: [], error: '' });
  const [treeStamp, setTreeStamp] = useState(0);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(null); // the ONE open relPath
  const [readOnly, setReadOnly] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState(''); // inline status / error line
  const [confirmSwitch, setConfirmSwitch] = useState(null); // relPath waiting on a dirty buffer
  const [approval, setApproval] = useState(null); // local WriteApproval state
  const [changeInfo, setChangeInfo] = useState(null); // { adds, dels, tooBig }
  const [fullDiff, setFullDiff] = useState(null); // DiffModal payload
  const [sideBySide, setSideBySide] = useState(true);
  // Opens MAXIMIZED: this is a reading/editing surface, not a sidebar. The
  // toggle now docks it back to panel width.
  const [maximized, setMaximized] = useState(true);

  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const modelRef = useRef(null);
  const decoRef = useRef(null);
  const baselineRef = useRef(''); // content as loaded/last saved (dirty check)
  const saveRef = useRef(() => {});
  const switchTargetRef = useRef(null); // "Save then switch" destination

  // ---- session change data, keyed on normalised paths ----------------------
  const writtenBy = useMemo(() => {
    const m = new Map();
    for (const f of writtenFiles || []) if (!m.has(norm(f.path))) m.set(norm(f.path), f);
    return m;
  }, [writtenFiles]);
  const baselineMap = useMemo(() => {
    const m = new Map();
    for (const k of Object.keys(baselines || {})) m.set(norm(k), baselines[k]);
    return m;
  }, [baselines]);

  const changedList = useMemo(
    () => (writtenFiles || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)),
    [writtenFiles],
  );
  const projectList = useMemo(() => {
    const seen = new Set(changedList.map((f) => norm(f.path)));
    return tree.files.filter((p) => !seen.has(norm(p))).sort((a, b) => a.localeCompare(b));
  }, [tree.files, changedList]);

  const q = filter.trim().toLowerCase();
  const match = (p) => !q || norm(p).toLowerCase().includes(q);

  // ---- Monaco boot (first mount of the panel only, thanks to the memo) -----
  useEffect(() => {
    let alive = true;
    loadMonaco().then(
      (m) => { if (alive) setMonaco(m); },
      (e) => { if (alive) setLoadError(e?.message || String(e)); },
    );
    return () => { alive = false; };
  }, []);

  // ---- file list. Re-fetched when a write lands so new files show up ------
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) { setTree({ files: [], error: '' }); return undefined; }
    api.projectTree?.(projectPath).then((r) => {
      if (cancelled) return;
      if (r?.ok) setTree({ files: flattenFiles(r), error: '' });
      else setTree({ files: [], error: r?.error || 'could not read the project folder' });
    }).catch(() => {
      if (!cancelled) setTree({ files: [], error: 'could not read the project folder' });
    });
    return () => { cancelled = true; };
  }, [projectPath, treeStamp, writtenFiles.length]);

  // ---- create / dispose the editor instance ------------------------------
  useEffect(() => {
    if (!monaco || !hostRef.current || editorRef.current) return undefined;
    editorRef.current = monaco.editor.create(hostRef.current, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      tabSize: 2,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
    });
    decoRef.current = editorRef.current.createDecorationsCollection();
    // Ctrl/Cmd+S inside the editor. The handler is read through a ref so the
    // command never goes stale as the open file changes.
    editorRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => saveRef.current(),
    );
    return () => {
      editorRef.current?.dispose();
      editorRef.current = null;
      decoRef.current = null;
      modelRef.current?.dispose();
      modelRef.current = null;
    };
  }, [monaco]);

  const flash = useCallback((msg) => setNotice(msg), []);

  // ---- paint the "changed by the table" decorations ----------------------
  // Called on open and after a successful save (never on every keystroke):
  // the diff is baseline → CONTENT ON DISK. While the user types, Monaco's
  // sticky decorations drift with the edits — accepted, they resync on save.
  const paint = useCallback((relPath, content) => {
    const key = norm(relPath);
    if (!baselineMap.has(key)) { // untouched by the table this session
      decoRef.current?.clear();
      setChangeInfo(null);
      return;
    }
    const base = baselineMap.get(key); // null = created this session
    const marks = computeChangeMarks(base ?? '', content);
    const model = modelRef.current;
    decoRef.current?.set(marks && model ? decorationsFor(marks, model.getLineCount()) : []);
    setChangeInfo({
      adds: marks?.adds ?? 0,
      dels: marks?.dels ?? 0,
      tooBig: !marks,
      isNew: base == null,
    });
  }, [baselineMap]);

  // ---- open a file (one at a time; no tabs) ------------------------------
  const doOpen = useCallback(async (relPath) => {
    setNotice('');
    setConfirmSwitch(null);
    switchTargetRef.current = null;
    let m;
    try {
      m = await loadMonaco();
    } catch (e) {
      setLoadError(e?.message || String(e));
      return;
    }
    const r = await api.readEditorFile(projectPath, relPath);
    if (!r?.ok) {
      // binary / hidden / oversize-path refusals show inline, never a dialog
      setNotice(`${relPath}: ${r?.error || 'could not read file'}`);
      return;
    }
    const old = modelRef.current;
    const model = m.editor.createModel(r.content, monacoLangOf(relPath));
    modelRef.current = model;
    baselineRef.current = r.content;
    model.onDidChangeContent(() => {
      if (modelRef.current !== model) return;
      setDirty(model.getValue() !== baselineRef.current);
    });
    // truncated (> 2 MB) opens READ-ONLY: saving it would destroy the tail.
    const ro = Boolean(r.truncated);
    setActive(relPath);
    setReadOnly(ro);
    setDirty(false);
    const ed = editorRef.current;
    if (ed) {
      ed.setModel(model); // NB: this clears the decorations collection…
      ed.updateOptions({ readOnly: ro });
      ed.focus();
    }
    old?.dispose();
    paint(relPath, r.content); // …so painting always comes after setModel
  }, [projectPath, paint]);

  // A file can be picked before Monaco finishes loading: the model exists but
  // there was no editor to hang it on. Attach as soon as the instance is up.
  useEffect(() => {
    const ed = editorRef.current;
    const model = modelRef.current;
    if (!ed || !model || ed.getModel() === model) return;
    ed.setModel(model);
    ed.updateOptions({ readOnly });
    if (active) paint(active, model.getValue());
  }, [monaco, active, readOnly, paint]);

  // Selecting another file with a dirty buffer asks first (inline strip, never
  // window.confirm — that breaks keyboard input on Windows).
  const select = useCallback((relPath) => {
    if (relPath === active) { editorRef.current?.focus(); return; }
    if (dirty) { setConfirmSwitch(relPath); return; }
    doOpen(relPath);
  }, [active, dirty, doOpen]);

  // ---- save: diff against CURRENT disk, then write ------------------------
  // Returns true once the approval modal is up, false on every refusal — the
  // "Save then switch" strip uses that to drop its destination on a refusal.
  const save = useCallback(async () => {
    const relPath = active;
    if (!relPath || !modelRef.current) return false;
    if (readOnly) { flash('this file is open read-only (over 2 MB) — not saved'); return false; }
    // App's writeResolveRef is a single slot; never race an agent's modal.
    if (approvalBusy) { flash('another approval is open — try again in a moment'); return false; }
    if (approval) return false;
    const content = modelRef.current.getValue();
    // Re-read at SAVE time, not the open-time baseline: if an agent wrote the
    // file while it sat open, the diff must show what changes on disk NOW.
    const r = await api.readEditorFile(projectPath, relPath);
    if (!r?.ok) { flash(`${relPath}: ${r?.error || 'could not re-read file'}`); return false; }
    if (r.truncated) { flash(`${relPath}: file is now over 2 MB — refusing to save`); return false; }
    setNotice('');
    setApproval({ path: relPath, agentName: 'You', oldText: r.content, content });
    return true;
  }, [active, readOnly, approvalBusy, approval, projectPath, flash]);

  useEffect(() => { saveRef.current = save; }, [save]);

  const decide = useCallback(async (decision) => {
    const a = approval;
    setApproval(null);
    if (!a || decision === 'reject') { switchTargetRef.current = null; setConfirmSwitch(null); return; }
    const w = await api.writeEditorFile(projectPath, a.path, a.content);
    if (!w?.ok) { flash(`${a.path}: ${w?.error || 'write failed'}`); return; }
    baselineRef.current = a.content;
    setDirty(modelRef.current ? modelRef.current.getValue() !== a.content : false);
    onHumanWrite?.(a.path);
    flash(`saved ${a.path}`);
    // a.content IS the file on disk now, so the highlights resync for free.
    paint(a.path, a.content);
    const next = switchTargetRef.current;
    switchTargetRef.current = null;
    setConfirmSwitch(null);
    if (next) doOpen(next);
  }, [approval, projectPath, onHumanWrite, flash, paint, doOpen]);

  // ---- "view full diff": same modal the Changes panel uses ---------------
  const openFullDiff = useCallback(async () => {
    if (!active) return;
    const r = await api.readEditorFile(projectPath, active);
    if (!r?.ok) { setFullDiff({ path: active, error: r?.error || 'could not read the current file' }); return; }
    const base = baselineMap.get(norm(active)) ?? null;
    const rows = diffLines(base ?? '', r.content);
    setFullDiff({ path: active, view: rows ? collapseDiff(rows, 3) : null, isNew: base == null });
  }, [active, projectPath, baselineMap]);

  // Ctrl/Cmd+S when focus is on the file list rather than the editor.
  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveRef.current();
    }
  };

  const canSave = Boolean(active) && !readOnly && !approval;
  const activeMeta = active ? writtenBy.get(norm(active)) : null;

  const fileRow = (path, meta) => {
    const color = meta ? (agentColors?.[meta.agent] || 'var(--accent)') : null;
    return (
      <button
        key={path}
        className={`editor-file${norm(path) === norm(active) ? ' active' : ''}`}
        title={path}
        onClick={() => select(path)}
      >
        {meta && <span className="editor-file-dot" style={{ background: color }} />}
        <span className="editor-file-path">{path}</span>
        {meta && (
          <span className="editor-file-meta">
            {meta.agent || '?'} · {new Date(meta.ts).toLocaleTimeString()}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside
      className={`scripts-panel editor-panel${maximized ? ' maximized' : ''}`}
      onKeyDown={onKeyDown}
    >
      <div className="scripts-head">
        <span className="scripts-title">
          ✎ {active ? baseName(active) : baseName(projectPath) || 'Editor'}
          {dirty && <span className="editor-dot" title="Unsaved changes">●</span>}
        </span>
        <button
          className="mini-btn"
          disabled={!canSave}
          title="Save (Ctrl/Cmd+S) — shows a diff against the file on disk first"
          onClick={() => save()}
        >
          Save
        </button>
        <button
          className={`mini-btn ${maximized ? 'active' : ''}`}
          title={maximized ? 'Dock to panel width' : 'Fill the window'}
          onClick={() => setMaximized((v) => !v)}
        >
          {maximized ? '⤡' : '⤢'}
        </button>
        <button className="icon icon-x" title="Close" onClick={onClose}>✕</button>
      </div>

      {/* Switching away from a dirty buffer. Save keeps the destination in a
          ref and continues once the write is approved. */}
      {confirmSwitch && (
        <div className="editor-confirm">
          <span>Unsaved changes in <code>{baseName(active)}</code> — open <code>{baseName(confirmSwitch)}</code>?</span>
          <button
            className="mini-btn"
            onClick={async () => {
              const target = confirmSwitch;
              switchTargetRef.current = target;
              if (!(await save())) switchTargetRef.current = null;
            }}
          >
            Save
          </button>
          <button className="mini-btn danger" onClick={() => doOpen(confirmSwitch)}>Discard</button>
          <button className="mini-btn" onClick={() => setConfirmSwitch(null)}>Cancel</button>
        </div>
      )}

      {active && changeInfo && (
        <div className="editor-changebar">
          <span className="editor-changebar-text">
            {changeInfo.isNew ? 'created' : 'changed'} by {activeMeta?.agent || 'the table'}
            {activeMeta?.ts ? ` · ${new Date(activeMeta.ts).toLocaleTimeString()}` : ''}
            {changeInfo.tooBig
              ? ' · diff too large to highlight'
              : ` · +${changeInfo.adds} −${changeInfo.dels}`}
          </span>
          <button className="mini-btn" onClick={openFullDiff}>view full diff</button>
        </div>
      )}

      {readOnly && (
        <div className="editor-warn">file exceeds 2 MB — read-only, Save is disabled</div>
      )}
      {loadError && <div className="editor-warn">editor failed to load: {loadError}</div>}
      {notice && <div className="editor-note">{notice}</div>}

      <div className="editor-body">
        <div className="editor-rail">
          <div className="editor-rail-head">
            <input
              className="editor-filter"
              placeholder="filter files"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button className="mini-btn" title="Re-read the folder" onClick={() => setTreeStamp((n) => n + 1)}>↻</button>
          </div>
          <div className="editor-list">
            <div className="editor-list-label">Changed by the table</div>
            {changedList.filter((f) => match(f.path)).length === 0 && (
              <p className="editor-list-empty">Nothing written this session yet.</p>
            )}
            {changedList.filter((f) => match(f.path)).map((f) => fileRow(f.path, f))}

            <div className="editor-list-label">Project files</div>
            {tree.error && <p className="editor-list-empty">⚠️ {tree.error}</p>}
            {!tree.error && projectList.filter(match).length === 0 && (
              <p className="editor-list-empty">{q ? 'No match.' : 'No files.'}</p>
            )}
            {projectList.filter(match).map((p) => fileRow(p, null))}
          </div>
        </div>
        <div className="editor-main">
          {!monaco && !loadError && <div className="editor-loading">loading editor…</div>}
          {monaco && !active && <div className="editor-loading">Pick a file on the left.</div>}
          <div ref={hostRef} className="editor-host" />
        </div>
      </div>

      {fullDiff && (
        <DiffModal
          path={fullDiff.path}
          isNew={fullDiff.isNew}
          view={fullDiff.view}
          error={fullDiff.error}
          sideBySide={sideBySide}
          onMode={setSideBySide}
          onClose={() => setFullDiff(null)}
        />
      )}

      {/* Local approval state — deliberately NOT App's single pendingWrite
          slot, so a human save can never clobber an agent's pending modal.
          "Approve all" is treated as a plain approve: nothing is remembered. */}
      {approval && <WriteApproval approval={approval} onDecide={decide} />}
    </aside>
  );
}
