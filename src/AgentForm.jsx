import { useState, useEffect } from 'react';

const PROVIDER_DEFAULTS = {
  ollama: { baseUrl: 'http://localhost:11434', needsKey: false, isCli: false },
  openai: { baseUrl: 'https://api.openai.com/v1', needsKey: true, isCli: false },
  anthropic: { baseUrl: 'https://api.anthropic.com', needsKey: true, isCli: false },
  cli: { baseUrl: '', needsKey: false, isCli: true },
};

const PROVIDER_LABELS = {
  ollama: 'Ollama (local)',
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic (Claude, API key)',
  cli: 'Command-line tool (claude / qwen, no key)',
};

// Short per-provider guidance shown right in the form.
// Quick-fill endpoints for the OpenAI-compatible provider.
const OPENAI_COMPAT_PRESETS = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1', modelHint: 'gpt-5.4-mini' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com', modelHint: 'deepseek-chat' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', modelHint: 'anthropic/claude-sonnet-4.5' },
  { label: 'Together', url: 'https://api.together.xyz/v1', modelHint: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
];

// Help text shown under the Role select, keyed by role value. One role per
// seat — assign whichever this agent should specialize in this round.
export const ROLE_HELP = {
  contributor:
    'No special directive — adds ideas and builds on what others said. The default.',
  coder:
    'Owns implementation: writes real code, flags vague specs or risky tradeoffs instead of building them as-is.',
  reviewer:
    'Critiques what was actually built — advisory only, cannot block or revert writes. Must give a specific issue or an explicit "approved", never vague praise.',
  designer:
    'Owns flows, layout, and wording. Pushes back on building before the user-facing behavior is clear, and judges results from the user\'s seat.',
  subtractor:
    'Always speaks last each round. Kills weak ideas and forces one decision — seat at least one to keep the roundtable from drifting into agreement.',
  planner:
    'Runs Mission mode: breaks your goal into tasks, delegates each to a specialist seat (spawning temp ones if needed), then synthesizes the reports into one deliverable.',
};

const PROVIDER_HELP = {
  ollama:
    'Runs models locally — no API key. Make sure Ollama is running, then click “Load installed models” and pick one (no need to type the long name).',
  openai:
    'Needs an API key in the field below. Get one at platform.openai.com → API keys. Model example: gpt-5.4-mini. Works with any OpenAI-compatible endpoint (DeepSeek, Together, etc.) — just change the URL.',
  anthropic:
    'Needs an Anthropic API key (get one at console.anthropic.com). Model example: claude-sonnet-4-5. Tip: to skip the key, use the “Command-line tool” provider with command “claude” instead.',
  cli:
    'No API key — uses a CLI you already logged into in your terminal (e.g. “claude” or “qwen”). Click “Detect installed CLIs” below to find them automatically. The app runs it per turn with -p.',
};

// Curated pastel palette — soft enough that dark bubble text stays legible.
export const PASTELS = [
  '#6fb7ff', // sky
  '#6fd9a6', // mint
  '#ffc266', // peach
  '#f58bac', // rose
  '#b692ec', // lavender
  '#ffe05a', // butter
  '#6fd6e3', // aqua
  '#bcd277', // sage
  '#f7a86a', // apricot
  '#aeb0c4', // slate-grey
];

// Sentinel returned by main when an encrypted key is stored — the real key
// never reaches the renderer. Pass it through unchanged to keep the key,
// type a new value to replace it, or clear the field to remove it.
const KEY_SET = '__KEY_SET__';

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export default function AgentForm({ initial, onSave, onCancel }) {
  const [error, setError] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? 'ollama');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? PROVIDER_DEFAULTS.ollama.baseUrl);
  const [model, setModel] = useState(initial?.model ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [args, setArgs] = useState(initial?.args ?? '');
  const [role, setRole] = useState(initial?.role ?? 'contributor');
  const [color, setColor] = useState(initial?.color ?? PASTELS[0]);
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');

  const [canWrite, setCanWrite] = useState(initial?.canWrite ?? false);

  // ---- runtime + its controls ---------------------------------------------
  // "Provider" is only the wire format. What decides which knobs exist is the
  // SERVER behind the URL: Ollama, llama-server, vLLM and LM Studio all differ,
  // and three of them speak the same OpenAI format. So we ask the endpoint what
  // it is, and fall back to a manual choice when it can't be reached — a local
  // server you start on demand simply isn't up while you're configuring it.
  const [runtime, setRuntime] = useState(initial?.runtime ?? '');
  const [rt, setRt] = useState(null);      // the detection + its control list
  const [probing, setProbing] = useState(false);
  // Every control is optional; '' means "leave it to the model/server", which
  // must stay distinct from 0 all the way to the request body.
  const [tune, setTune] = useState(() => {
    const t = {};
    for (const k of ['contextWindow', 'gpuLayers', 'maxTokens', 'temperature',
                     'topP', 'topK', 'minP', 'repeatPenalty']) {
      t[k] = initial?.[k] ?? '';
    }
    t.thinking = initial?.thinking ?? 'auto';
    return t;
  });
  const [signin, setSignin] = useState(null);

  const [test, setTest] = useState(null); // { ok, detail } | null
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState([]); // models offered by the endpoint
  const [modelFilter, setModelFilter] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [clis, setClis] = useState([]); // detected CLIs [{ name, path, version }]
  const [detecting, setDetecting] = useState(false);

  const needsKey = PROVIDER_DEFAULTS[provider].needsKey;
  const isCli = PROVIDER_DEFAULTS[provider].isCli;
  // Key-field states: the agent had a saved (encrypted) key when the form
  // opened; apiKey === KEY_SET means "keep it", '' means "delete it",
  // anything else means "replace it".
  const hadSavedKey = initial?.apiKey === KEY_SET;

  // Build the current agent config (without committing) for test/list calls.
  function draftAgent() {
    // Include the id so main can look up the stored (encrypted) key when the
    // field still holds the sentinel.
    return { id: initial?.id, cloneKeyFrom: initial?.cloneKeyFrom, provider, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim(), command: command.trim(), args: args.trim(), runtime };
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const r = await window.api.testAgent(draftAgent());
      setTest(r);
    } catch (e) {
      setTest({ ok: false, detail: e.message });
    } finally {
      setTesting(false);
    }
  }

  // Works for every non-CLI provider: Ollama lists installed models, API
  // providers (OpenAI/DeepSeek/OpenRouter/Together/Anthropic) list what the
  // endpoint offers your key. Live data — no hardcoded list to go stale.
  async function loadModels() {
    setLoadingModels(true);
    setTest(null);
    setModels([]);
    setModelFilter('');
    try {
      const list = await window.api.listModels(draftAgent());
      setModels(list);
      if (list.length === 0) {
        setTest({
          ok: false,
          detail:
            provider === 'ollama'
              ? 'Ollama is running but has no models. Run: ollama pull <model>'
              : 'The endpoint returned no models.',
        });
      }
    } catch (e) {
      setTest({ ok: false, detail: e.message });
    } finally {
      setLoadingModels(false);
    }
  }

  async function runDetectClis() {
    setDetecting(true);
    setTest(null);
    try {
      const found = await window.api.detectClis();
      setClis(found);
      if (found.length === 0) {
        setTest({
          ok: false,
          detail: 'No known CLIs found (looked for claude, qwen, gemini, codex, aider). Enter the full path to the executable instead.',
        });
      }
    } catch (e) {
      setTest({ ok: false, detail: e.message });
    } finally {
      setDetecting(false);
    }
  }

  async function probeRuntime(override) {
    setProbing(true);
    try {
      const d = await window.api.detectRuntime({ ...draftAgent(), runtime: override ?? runtime });
      setRt(d);
    } catch {
      setRt(null); // best-effort: a failed probe must never block saving a seat
    } finally {
      setProbing(false);
    }
  }

  // Ask once when the form opens, and again whenever the provider changes —
  // not on every keystroke in the address field, which the button covers.
  useEffect(() => { probeRuntime(); /* eslint-disable-next-line */ }, [provider]);

  async function openSignIn() {
    setSignin(null);
    const r = await window.api.cliSignIn(command.trim());
    setSignin(r);
  }

  function changeProvider(p) {
    setProvider(p);
    setBaseUrl(PROVIDER_DEFAULTS[p].baseUrl);
    // A detection from the previous endpoint would be worse than none.
    setRuntime('');
    setRt(null);
    // A model list from the previous provider/endpoint would be misleading.
    setModels([]);
    setModelFilter('');
  }

  function submit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Please enter a display name.');
    if (isCli) {
      if (!command.trim()) return setError('Please enter the command to run (e.g. claude or qwen).');
    } else if (!model.trim()) {
      return setError('Please enter a model name.');
    }
    try {
      onSave({
        id: initial?.id ?? makeId(),
        ...(initial?.cloneKeyFrom ? { cloneKeyFrom: initial.cloneKeyFrom } : {}),
        name: name.trim(),
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
        command: command.trim(),
        args: args.trim(),
        role,
        color,
        systemPrompt: systemPrompt.trim(),
        canWrite,
        runtime,
        // Saved as-is: '' means unset, and unset must not become 0.
        ...tune,
      });
    } catch (err) {
      setError('Could not save: ' + err.message);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{initial?.id ? 'Edit AI' : 'Add an AI'}</h2>

        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coder" autoFocus />
        </label>

        <label>
          Provider
          <select value={provider} onChange={(e) => changeProvider(e.target.value)}>
            {Object.keys(PROVIDER_LABELS).map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </label>

        <p className="form-note">{PROVIDER_HELP[provider]}</p>

        {isCli ? (
          <>
            <label>
              Command
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="claude   (or qwen, or a full path)" />
            </label>

            <div className="model-help">
              <button type="button" className="mini-btn" onClick={runDetectClis} disabled={detecting}>
                {detecting ? 'Searching…' : '🔍 Detect installed CLIs'}
              </button>
              {/* Roundtable runs a CLI seat with -p for one non-interactive
                  turn, so its own /login can never be typed from in here — the
                  seat just fails with "sign-in expired" and there is nowhere
                  to fix it. This opens a terminal already running the tool. */}
              <button
                type="button"
                className="mini-btn"
                onClick={openSignIn}
                disabled={!command.trim()}
                title="Open a terminal running this tool, so you can sign in to it"
              >
                🔑 Sign in to this tool
              </button>
              {signin && (
                <span className={`test-result ${signin.ok ? 'ok' : 'bad'}`}>
                  {signin.ok
                    ? '✓ Terminal opened — sign in there, then come back. In Claude, type /login.'
                    : `✕ ${signin.error}`}
                </span>
              )}
              {clis.length > 0 && (
                <div className="chips">
                  {clis.map((c) => (
                    <button
                      type="button"
                      key={c.path}
                      className={`chip ${command === c.path ? 'selected' : ''}`}
                      onClick={() => { setCommand(c.path); if (!name.trim()) setName(c.name); }}
                      title={`${c.path}${c.version ? `\n${c.version}` : ''}`}
                    >
                      {c.name}{c.version ? ` · ${c.version}` : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label>
              Extra arguments (optional)
              <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="e.g. --model sonnet" />
            </label>
          </>
        ) : (
          <>
            <label>
              Endpoint URL
              <input
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setModels([]); // list belonged to the old endpoint
                }}
              />
            </label>
            {provider === 'openai' && (
              <div className="chips">
                {OPENAI_COMPAT_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.url}
                    className={`chip ${baseUrl === p.url ? 'selected' : ''}`}
                    onClick={() => {
                      setBaseUrl(p.url);
                      setModels([]);
                    }}
                    title={`${p.url}\nmodel example: ${p.modelHint}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
            <label>
              Model
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={
                  provider === 'ollama'
                    ? 'e.g. llama3.1:8b — or click below to list installed'
                    : provider === 'anthropic'
                      ? 'claude-sonnet-4-5'
                      : (OPENAI_COMPAT_PRESETS.find((p) => p.url === baseUrl)?.modelHint ?? 'gpt-5.4-mini')
                }
              />
            </label>

            <div className="model-help">
              <button type="button" className="mini-btn" onClick={loadModels} disabled={loadingModels}>
                {loadingModels
                  ? 'Loading…'
                  : provider === 'ollama'
                    ? '⟳ Load installed models'
                    : '⟳ List available models'}
              </button>
              {provider !== 'ollama' && models.length === 0 && (
                <span className="form-note"> Uses your API key to ask the endpoint what it offers.</span>
              )}
              {models.length > 12 && (
                <input
                  className="model-filter"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder={`Filter ${models.length} models…`}
                />
              )}
              {models.length > 0 && (
                <div className={`chips ${models.length > 12 ? 'scroll' : ''}`}>
                  {(modelFilter.trim()
                    ? models.filter((m) => m.toLowerCase().includes(modelFilter.trim().toLowerCase()))
                    : models
                  )
                    .slice(0, 60)
                    .map((m) => (
                      <button
                        type="button"
                        key={m}
                        className={`chip ${model === m ? 'selected' : ''}`}
                        onClick={() => setModel(m)}
                        title="Click to use this model"
                      >
                        {m}
                      </button>
                    ))}
                </div>
              )}
            </div>
            {needsKey && (
              <>
                <label>
                  API key
                  <input
                    type="password"
                    value={apiKey === KEY_SET ? '' : apiKey}
                    onChange={(e) => {
                      const v = e.target.value;
                      // Deleting a half-typed replacement reverts to "keep the saved key".
                      setApiKey(v === '' && hadSavedKey ? KEY_SET : v);
                    }}
                    placeholder={apiKey === KEY_SET ? '✓ key saved — type here to replace it' : 'sk-...'}
                  />
                </label>
                {apiKey === KEY_SET && (
                  <div className="test-row">
                    <span className="test-result ok">✓ A key is saved (encrypted) and will be kept.</span>
                    <button type="button" className="mini-btn" onClick={() => setApiKey('')}>
                      Remove key
                    </button>
                  </div>
                )}
                {hadSavedKey && apiKey === '' && (
                  <p className="form-error">
                    The saved key will be DELETED when you press Save. Type a new key
                    (or Cancel) to keep one.
                  </p>
                )}
                {hadSavedKey && apiKey !== '' && apiKey !== KEY_SET && (
                  <p className="form-note">The saved key will be replaced when you press Save.</p>
                )}
              </>
            )}
          </>
        )}

        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="contributor">Contributor — adds ideas</option>
            <option value="coder">Coder — writes the implementation</option>
            <option value="reviewer">Code Reviewer — critiques what was built (advisory)</option>
            <option value="designer">Designer/UX — owns flows, layout, wording</option>
            <option value="subtractor">Subtractor — kills weak ideas, forces a decision</option>
            <option value="planner">Planner/Lead — delegates missions to specialists</option>
          </select>
        </label>
        <p className="form-note">{ROLE_HELP[role] ?? ROLE_HELP.contributor}</p>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={canWrite}
            onChange={(e) => setCanWrite(e.target.checked)}
          />
          <span>
            {isCli
              ? 'Can write files — each write pops an approval in Roundtable'
              : 'Can write files to the active project folder'}
          </span>
        </label>
        {isCli ? (
          <p className="form-note">
            For the <code>claude</code> CLI, checking this routes every file
            write through Roundtable: the CLI pauses, you approve or reject the
            exact action in a modal, then it continues. Unchecked, its writes
            stay blocked (headless mode can't ask for permission).
            <br />
            ⚠️ Other CLIs (qwen, gemini, …) have no such hook — this checkbox
            doesn't affect them; they follow their own permission flags. And an
            approved write is executed by the CLI itself, which is{' '}
            <strong>not</strong> jailed to the project folder — only point a CLI
            agent at folders you trust it in.
          </p>
        ) : (
          <p className="form-note">
            When checked, this agent can use{' '}
            <code>CHECK: write_file &lt;path&gt;</code> to create or update files
            inside the project folder. All writes are path-locked — files outside
            the project folder are always rejected.
          </p>
        )}

        <label>
          Bubble color
          <div className="swatches">
            {PASTELS.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${color === c ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
                aria-label={`Choose color ${c}`}
              />
            ))}
          </div>
        </label>

        <label>
          Persona / system prompt (optional)
          <textarea
            rows={3}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="e.g. You are a skeptical senior engineer who values brevity."
          />
        </label>

        <div className="runtime-panel">
          <div className="runtime-head">
            <span className="runtime-title">Model settings</span>
            <span className={`runtime-badge ${rt?.detected ? 'found' : rt?.reachable ? 'guess' : 'down'}`}>
              {probing
                ? 'checking…'
                : !rt
                  ? 'not checked'
                  : rt.detected
                    ? `${rt.label}${rt.version ? ` · ${rt.version}` : ''}`
                    : rt.reachable
                      ? 'server up, not recognised'
                      : 'server not reachable'}
            </span>
            <button type="button" className="mini-btn" onClick={() => probeRuntime()} disabled={probing}>
              {probing ? '…' : '↻ Check'}
            </button>
          </div>

          {/* Detection is a convenience, not a requirement: a server you only
              start when you need it can't be probed while you configure it. */}
          <label className="runtime-pick">
            Running on
            <select
              value={runtime || rt?.detectedId || ''}
              onChange={(e) => { setRuntime(e.target.value); probeRuntime(e.target.value); }}
            >
              <option value="">{rt?.detected ? `Detected — ${rt.label}` : 'Detect automatically'}</option>
              {(rt?.all ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </label>

          {rt?.note && <p className="form-note">{rt.note}</p>}
          {rt?.model && <p className="form-note runtime-served">Serving <code>{rt.model}</code></p>}

          {(rt?.controls ?? []).map((c) => {
            if (!c.editable) {
              // Shown, never faked. A seat silently running in a 4k window is
              // the most expensive thing not to know, but a slider that did
              // nothing would be worse than saying where the setting lives.
              return (
                <div className="runtime-row readonly" key={c.key}>
                  <span className="runtime-label">{c.label}</span>
                  <span className="runtime-readval">
                    {rt.contextWindow ? `${rt.contextWindow.toLocaleString()} ${c.unit ?? ''}` : 'unknown'}
                  </span>
                  <p className="runtime-help">{c.readOnlyReason}</p>
                </div>
              );
            }
            if (c.kind === 'choice') {
              return (
                <div className="runtime-row" key={c.key}>
                  <span className="runtime-label">{c.label}</span>
                  <select
                    value={tune[c.key] ?? 'auto'}
                    onChange={(e) => setTune((t) => ({ ...t, [c.key]: e.target.value }))}
                  >
                    {c.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <p className="runtime-help">{c.help}</p>
                </div>
              );
            }
            const set = tune[c.key] !== '' && tune[c.key] != null;
            const shown = set ? Number(tune[c.key]) : (c.kind === 'int' ? c.min : (c.min + c.max) / 2);
            return (
              <div className={`runtime-row ${set ? '' : 'unset'}`} key={c.key}>
                <span className="runtime-label">{c.label}</span>
                <input
                  type="range"
                  min={c.min} max={c.max} step={c.step} value={shown}
                  onChange={(e) => setTune((t) => ({ ...t, [c.key]: e.target.value }))}
                />
                <input
                  type="number"
                  className="runtime-num"
                  min={c.min} max={c.max} step={c.step}
                  value={set ? tune[c.key] : ''}
                  placeholder="auto"
                  onChange={(e) => setTune((t) => ({ ...t, [c.key]: e.target.value }))}
                />
                {/* Clearing must return to "unset", not to zero — zero is a
                    real setting (CPU-only, deterministic) and means something
                    completely different from "leave it alone". */}
                <button
                  type="button"
                  className="runtime-clear"
                  title={set ? 'Back to automatic' : 'Not set — the model or server decides'}
                  disabled={!set}
                  onClick={() => setTune((t) => ({ ...t, [c.key]: '' }))}
                >
                  {set ? '× auto' : 'auto'}
                </button>
                <p className="runtime-help">{c.help}</p>
              </div>
            );
          })}
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="test-row">
          <button type="button" className="mini-btn" onClick={runTest} disabled={testing}>
            {testing ? 'Testing…' : '⚡ Test connection'}
          </button>
          {test && (
            <span className={`test-result ${test.ok ? 'ok' : 'bad'}`}>
              {test.ok ? '✓ ' : '✕ '}{test.detail}
            </span>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
          <button type="submit">{initial ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </div>
  );
}
