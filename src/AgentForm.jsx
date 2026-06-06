import { useState } from 'react';

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
const PROVIDER_HELP = {
  ollama:
    'Runs models locally — no API key. Make sure Ollama is running, then click “Load installed models” and pick one (no need to type the long name).',
  openai:
    'Needs an API key in the field below. Get one at platform.openai.com → API keys. Model example: gpt-4o-mini. Works with any OpenAI-compatible endpoint (DeepSeek, Together, etc.) — just change the URL.',
  anthropic:
    'Needs an Anthropic API key (get one at console.anthropic.com). Model example: claude-sonnet-4-5. Tip: to skip the key, use the “Command-line tool” provider with command “claude” instead.',
  cli:
    'No API key — uses a CLI you already logged into in your terminal (e.g. “claude” or “qwen”). The app runs it per turn with -p.',
};

// Curated pastel palette — soft enough that dark bubble text stays legible.
export const PASTELS = [
  '#a8d4ff', // sky
  '#a6e6c6', // mint
  '#ffd79e', // peach
  '#f5b8cc', // rose
  '#d0b8f0', // lavender
  '#ffe98a', // butter
  '#a9e4ec', // aqua
  '#cfdca6', // sage
  '#f7c19a', // apricot
  '#c9cad6', // slate-grey
];

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

  const [test, setTest] = useState(null); // { ok, detail } | null
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState([]); // installed Ollama models
  const [loadingModels, setLoadingModels] = useState(false);

  const needsKey = PROVIDER_DEFAULTS[provider].needsKey;
  const isCli = PROVIDER_DEFAULTS[provider].isCli;

  // Build the current agent config (without committing) for test/list calls.
  function draftAgent() {
    return { provider, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim(), command: command.trim(), args: args.trim() };
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

  async function loadModels() {
    setLoadingModels(true);
    setTest(null);
    try {
      const list = await window.api.listOllamaModels(draftAgent());
      setModels(list);
      if (list.length === 0) setTest({ ok: false, detail: 'Ollama is running but has no models. Run: ollama pull <model>' });
    } catch (e) {
      setTest({ ok: false, detail: e.message });
    } finally {
      setLoadingModels(false);
    }
  }

  function changeProvider(p) {
    setProvider(p);
    setBaseUrl(PROVIDER_DEFAULTS[p].baseUrl);
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
      });
    } catch (err) {
      setError('Could not save: ' + err.message);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{initial ? 'Edit AI' : 'Add an AI'}</h2>

        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Qwen Coder" autoFocus />
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
            <label>
              Extra arguments (optional)
              <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="e.g. --model sonnet" />
            </label>
          </>
        ) : (
          <>
            <label>
              Endpoint URL
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
            <label>
              Model
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={provider === 'ollama' ? 'qwen3-coder:30b-a3b-q4_K_M' : provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini'}
              />
            </label>

            {provider === 'ollama' && (
              <div className="model-help">
                <button type="button" className="mini-btn" onClick={loadModels} disabled={loadingModels}>
                  {loadingModels ? 'Loading…' : '⟳ Load installed models'}
                </button>
                {models.length > 0 && (
                  <div className="chips">
                    {models.map((m) => (
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
            )}
            {needsKey && (
              <label>
                API key
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
              </label>
            )}
          </>
        )}

        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="contributor">Contributor — adds ideas</option>
            <option value="subtractor">Subtractor — kills weak ideas, forces a decision</option>
          </select>
        </label>
        <p className="form-note">
          Subtractors always speak last each round and are told to remove scope and force one
          decision. Seat at least one to keep the roundtable from drifting into agreement.
        </p>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={canWrite}
            onChange={(e) => setCanWrite(e.target.checked)}
          />
          <span>Can write files to the active project folder</span>
        </label>
        <p className="form-note">
          When checked, this agent can use{' '}
          <code>CHECK: write_file &lt;path&gt;</code> to create or update files
          inside the project folder. All writes are path-locked — files outside
          the project folder are always rejected.
        </p>

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
