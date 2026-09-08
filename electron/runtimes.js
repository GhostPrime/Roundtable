// electron/runtimes.js
// What is actually serving this seat, and therefore which knobs it has.
//
// Roundtable's "provider" only names the WIRE FORMAT — Ollama's native
// /api/chat, an OpenAI-compatible /chat/completions, Anthropic's /v1/messages,
// or a CLI. It says nothing about what is on the other end. Ollama is not the
// only way to run a local model: llama.cpp's llama-server, vLLM and LM Studio
// all speak the OpenAI format, and they accept very different parameters from
// each other and from OpenAI itself. A seat pointed at 127.0.0.1:8888 is
// "openai" to Roundtable and llama.cpp in reality.
//
// So the controls a seat offers are chosen by the RUNTIME behind the URL,
// detected by probing it, with a manual override when the probe can't reach it
// (a server that is only started when you need it can't be probed in advance).
//
// The distinction that matters most, and that a naive slider would lie about:
//
//   CONTEXT WINDOW IS A PER-REQUEST OPTION ONLY ON OLLAMA.
//
// llama.cpp takes it as --ctx-size at launch, vLLM as --max-model-len, LM
// Studio in its loader UI. For those we READ the running value back and show
// it, rather than offering a slider that would silently do nothing.

// ---------------------------------------------------------------------------
// Controls — declared once, rendered generically. Adding a runtime never means
// touching the form.
// ---------------------------------------------------------------------------
const CONTROLS = {
  contextWindow: {
    key: 'contextWindow', label: 'Context window', kind: 'int',
    min: 512, max: 1048576, step: 512, unit: 'tokens',
    help: 'How much of the conversation the model can see at once. The whole '
      + 'transcript is resent every turn, so a small window silently drops the '
      + 'oldest messages and the seat looks like it stopped listening.',
  },
  gpuLayers: {
    key: 'gpuLayers', label: 'GPU layers', kind: 'int',
    min: 0, max: 999, step: 1, unit: 'layers',
    help: 'How many layers to put on the graphics card. Lower it when the model '
      + 'crashes on load or runs out of video memory; 0 runs on the CPU only — '
      + 'slow, but it will not crash.',
  },
  maxTokens: {
    key: 'maxTokens', label: 'Max response', kind: 'int',
    min: 64, max: 262144, step: 64, unit: 'tokens',
    help: 'The longest reply this seat may write. On a thinking model this budget '
      + 'covers the reasoning too, so too low means it thinks and never answers.',
  },
  thinking: {
    key: 'thinking', label: 'Reasoning', kind: 'choice',
    options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'on', label: 'Always on' },
      { value: 'off', label: 'Always off' },
    ],
    help: 'Automatic leaves it to the model and turns reasoning off only after a '
      + 'turn where it reasoned and never answered. Off is faster and is the fix '
      + 'when a seat keeps coming back empty.',
  },
  temperature: {
    key: 'temperature', label: 'Temperature', kind: 'float',
    min: 0, max: 2, step: 0.05,
    help: 'How much the model varies its wording. Worth setting per seat at a '
      + 'roundtable: a cold subtractor and a warm contributor actually disagree, '
      + 'where two seats at the same setting tend to converge.',
  },
  topP: {
    key: 'topP', label: 'Top-p', kind: 'float', min: 0, max: 1, step: 0.01,
    help: 'Considers only the most likely words that together make up this share '
      + 'of the probability. Lower is safer and more repetitive.',
  },
  topK: {
    key: 'topK', label: 'Top-k', kind: 'int', min: 0, max: 200, step: 1,
    help: 'Considers only this many candidate words at each step. 0 means no limit.',
  },
  minP: {
    key: 'minP', label: 'Min-p', kind: 'float', min: 0, max: 1, step: 0.01,
    help: 'Drops any word less likely than this share of the best one. A newer '
      + 'alternative to top-p; leave it off unless you know you want it.',
  },
  repeatPenalty: {
    key: 'repeatPenalty', label: 'Repeat penalty', kind: 'float',
    min: 0.8, max: 1.5, step: 0.01,
    help: 'Pushes the model away from repeating itself. Above about 1.2 it starts '
      + 'avoiding words it genuinely needs.',
  },
};

// ---------------------------------------------------------------------------
// The runtimes. `wire` maps a control to the parameter name THAT runtime wants
// — the names really do differ (vLLM says repetition_penalty where llama.cpp
// says repeat_penalty), which is the whole reason this table exists.
// `place` is where the parameters go: nested under options (Ollama) or at the
// top level of the request body (everyone else).
// ---------------------------------------------------------------------------
const RUNTIMES = {
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    place: 'options',
    // The ONLY runtime that takes the context window per request.
    contextIsSettable: true,
    supportsThinking: true,
    wire: {
      contextWindow: 'num_ctx',
      gpuLayers: 'num_gpu',
      maxTokens: 'num_predict',
      temperature: 'temperature',
      topP: 'top_p',
      topK: 'top_k',
      repeatPenalty: 'repeat_penalty',
    },
    note: 'Ollama picks a context window from your free video memory — as little '
      + 'as 4k on a card under 24 GB, whatever the model can actually handle. '
      + 'Set it here and Roundtable sends it with every turn.',
  },
  llamacpp: {
    id: 'llamacpp',
    label: 'llama.cpp (llama-server)',
    place: 'body',
    contextIsSettable: false,
    contextFlag: '--ctx-size',
    wire: {
      maxTokens: 'max_tokens',
      temperature: 'temperature',
      topP: 'top_p',
      topK: 'top_k',
      minP: 'min_p',
      repeatPenalty: 'repeat_penalty',
    },
    note: 'llama-server fixes its context window at launch, so it cannot be '
      + 'changed per request. Restart it with --ctx-size to change it.',
  },
  vllm: {
    id: 'vllm',
    label: 'vLLM',
    place: 'body',
    contextIsSettable: false,
    contextFlag: '--max-model-len',
    wire: {
      maxTokens: 'max_tokens',
      temperature: 'temperature',
      topP: 'top_p',
      topK: 'top_k',
      minP: 'min_p',
      repeatPenalty: 'repetition_penalty',
    },
    note: 'vLLM fixes its context window at launch. Restart it with '
      + '--max-model-len to change it.',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    place: 'body',
    contextIsSettable: false,
    contextFlag: "LM Studio's model loader",
    wire: {
      maxTokens: 'max_tokens',
      temperature: 'temperature',
      topP: 'top_p',
      topK: 'top_k',
      repeatPenalty: 'repeat_penalty',
    },
    note: 'LM Studio sets the context window when it loads the model — the slider '
      + 'in its own loader panel. Reload the model there to change it.',
  },
  // A local OpenAI-compatible server we could not identify. Only the
  // parameters every such server accepts, because an unknown one will reject
  // an extension it has never heard of and lose the whole turn.
  openai_compatible: {
    id: 'openai_compatible',
    label: 'OpenAI-compatible server',
    place: 'body',
    contextIsSettable: false,
    wire: { maxTokens: 'max_tokens', temperature: 'temperature', topP: 'top_p' },
    note: 'Roundtable could not identify this server, so it offers only the '
      + 'settings every OpenAI-compatible endpoint accepts. Pick the real one '
      + 'above if you know it and the rest appear.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI API',
    place: 'body',
    contextIsSettable: false,
    wire: { maxTokens: 'max_tokens', temperature: 'temperature', topP: 'top_p' },
    note: 'A hosted API — the context window is a property of the model you '
      + 'chose, not something to set here.',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic API',
    place: 'body',
    contextIsSettable: false,
    wire: { maxTokens: 'max_tokens', temperature: 'temperature', topP: 'top_p' },
    note: 'A hosted API — the context window is a property of the model you chose.',
  },
  cli: {
    id: 'cli',
    label: 'Command-line tool',
    place: null,
    contextIsSettable: false,
    wire: {},
    note: 'A CLI runs the model its own way and keeps its own settings. '
      + 'Roundtable passes it the prompt and nothing else — change these in the '
      + "tool's own configuration.",
  },
};

// The full control list for a runtime, in display order, each already carrying
// whether it is editable here or only readable.
const ORDER = [
  'contextWindow', 'gpuLayers', 'maxTokens', 'thinking',
  'temperature', 'topP', 'topK', 'minP', 'repeatPenalty',
];

function controlsFor(runtimeId) {
  const rt = RUNTIMES[runtimeId] || RUNTIMES.openai_compatible;
  const out = [];
  for (const key of ORDER) {
    if (key === 'thinking') {
      if (rt.supportsThinking) out.push({ ...CONTROLS.thinking, editable: true });
      continue;
    }
    if (key === 'contextWindow') {
      // Always SHOWN — a seat silently running in 4k is the single most
      // expensive thing to not know. Editable only where it is real.
      if (rt.id === 'cli') continue;
      out.push({
        ...CONTROLS.contextWindow,
        editable: !!rt.contextIsSettable,
        readOnlyReason: rt.contextIsSettable
          ? null
          : `Set where the server starts (${rt.contextFlag || 'the provider decides it'}), not per request.`,
      });
      continue;
    }
    if (rt.wire[key]) out.push({ ...CONTROLS[key], editable: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the settings off an agent.
//
// Every control is OPTIONAL and an unset one must be ABSENT from the request,
// never zero: temperature 0 makes a model deterministic and num_ctx 0 is an
// error, so "" and 0 have to stay distinguishable all the way to the wire.
// ---------------------------------------------------------------------------
function num(value, spec) {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.min(spec.max, Math.max(spec.min, n));
  return spec.kind === 'int' ? Math.round(clamped) : clamped;
}

// { num_ctx: 32768, temperature: 0.2, … } for this agent's runtime, or null
// when the seat has set nothing.
function runtimeParams(agent, runtimeId) {
  const rt = RUNTIMES[runtimeId] || RUNTIMES.openai_compatible;
  const out = {};
  for (const [key, wireName] of Object.entries(rt.wire)) {
    // The context window only reaches the wire where it is real. Everywhere
    // else it is a reading, and sending it would be a lie the server ignores.
    if (key === 'contextWindow' && !rt.contextIsSettable) continue;
    const v = num(agent?.[key], CONTROLS[key]);
    if (v !== undefined) out[wireName] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Which runtime's rules apply to this seat. The seat's saved choice wins (set
// by detection or by hand); otherwise fall back by wire format — and for an
// unidentified OpenAI-compatible endpoint that means the SAFE set, never a
// guess, because an extension parameter an unknown server has not heard of
// can 400 and cost the whole turn.
function runtimeIdFor(agent) {
  const saved = agent?.runtime;
  if (saved && RUNTIMES[saved]) return saved;
  switch (agent?.provider) {
    case 'ollama': return 'ollama';
    case 'anthropic': return 'anthropic';
    case 'cli': return 'cli';
    default: return 'openai_compatible';
  }
}

// 'auto' | 'on' | 'off' → undefined | true | false. Only Ollama has this.
function thinkingChoice(agent) {
  const v = agent?.thinking;
  if (v === 'on') return true;
  if (v === 'off') return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Detection.
//
// Every probe is best-effort and short: a runtime you only start when you need
// it cannot be reached now, and that must never block saving a seat. An
// unreachable endpoint returns reachable:false and the form falls back to the
// saved override, or to the safe generic control set.
// ---------------------------------------------------------------------------
const HOSTED = [
  { re: /(^|\.)api\.openai\.com$/i, id: 'openai' },
  { re: /(^|\.)api\.anthropic\.com$/i, id: 'anthropic' },
];

// An OpenAI-compatible baseUrl usually ends in /v1, but the identifying
// endpoints (/props, /api/version, /api/v0/models) live at the ROOT.
function rootOf(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v\d+$/i, '');
}

function hostOf(baseUrl) {
  try { return new URL(baseUrl).hostname; } catch { return ''; }
}

async function getJson(url, signal, timeoutMs = 2500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Probes, most specific first. Each returns a detection or null.
const PROBES = [
  // Ollama's native API — the only one with /api/version.
  async (root, signal) => {
    const v = await getJson(`${root}/api/version`, signal);
    if (!v || typeof v.version !== 'string') return null;
    return { id: 'ollama', version: v.version, contextWindow: null };
  },
  // LM Studio's own REST layer, which reports each model's context window.
  async (root, signal) => {
    const d = await getJson(`${root}/api/v0/models`, signal);
    const list = Array.isArray(d?.data) ? d.data : null;
    if (!list || !list.some((m) => m && 'max_context_length' in m)) return null;
    const loaded = list.find((m) => m?.state === 'loaded') || list[0];
    return {
      id: 'lmstudio',
      version: null,
      contextWindow: Number(loaded?.max_context_length) || null,
      model: loaded?.id ?? null,
    };
  },
  // llama-server: /props is its "everything about me" endpoint.
  async (root, signal) => {
    const p = await getJson(`${root}/props`, signal);
    if (!p || (!p.build_info && !p.default_generation_settings)) return null;
    return {
      id: 'llamacpp',
      version: p.build_info ?? null,
      contextWindow: Number(p?.default_generation_settings?.n_ctx) || null,
      model: p.model_path ? String(p.model_path).split(/[\\/]/).pop() : null,
    };
  },
  // vLLM reports max_model_len on each model it serves.
  async (root, signal) => {
    const d = await getJson(`${root}/v1/models`, signal);
    const list = Array.isArray(d?.data) ? d.data : null;
    const withLen = list?.find((m) => m && m.max_model_len != null);
    if (!withLen) return null;
    const v = await getJson(`${root}/version`, signal);
    return {
      id: 'vllm',
      version: v?.version ?? null,
      contextWindow: Number(withLen.max_model_len) || null,
      model: withLen.id ?? null,
    };
  },
];

// detectRuntime(agent) → { id, label, version, contextWindow, model,
//                          reachable, detected }
// `detected` false means this is a fallback, not an observation — the form says
// so rather than presenting a guess as fact.
async function detectRuntime(agent, signal) {
  const provider = agent?.provider;
  if (provider === 'cli') {
    return { ...RUNTIMES.cli, reachable: true, detected: true, version: null, contextWindow: null };
  }
  if (provider === 'anthropic') {
    return { ...RUNTIMES.anthropic, reachable: true, detected: true, version: null, contextWindow: null };
  }

  const host = hostOf(agent?.baseUrl);
  const hosted = HOSTED.find((h) => h.re.test(host));
  if (hosted) {
    return { ...RUNTIMES[hosted.id], reachable: true, detected: true, version: null, contextWindow: null };
  }

  const root = rootOf(agent?.baseUrl);
  if (!root) {
    return { ...RUNTIMES.openai_compatible, reachable: false, detected: false, version: null, contextWindow: null };
  }

  for (const probe of PROBES) {
    let hit = null;
    try { hit = await probe(root, signal); } catch { hit = null; }
    if (hit) {
      return { ...RUNTIMES[hit.id], ...hit, reachable: true, detected: true };
    }
  }

  // Nothing answered. Distinguish "server is down" from "server is up but
  // unrecognised" — the advice differs, and the seat's saved choice should
  // survive a server that simply is not running yet.
  const alive = await getJson(`${root}/v1/models`, signal);
  const fallback = provider === 'ollama' ? 'ollama' : 'openai_compatible';
  return {
    ...RUNTIMES[fallback],
    reachable: !!alive,
    detected: false,
    version: null,
    contextWindow: null,
  };
}

module.exports = {
  CONTROLS, RUNTIMES, ORDER,
  controlsFor, runtimeParams, thinkingChoice, runtimeIdFor,
  detectRuntime, rootOf, hostOf,
};
