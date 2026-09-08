// scripts/check-runtimes.js
// Guards electron/runtimes.js — which knobs a seat gets, and what actually
// goes on the wire.
//
// The premise this file defends: Roundtable's "provider" is only the wire
// FORMAT. Ollama is not the only way to run a local model — llama.cpp, vLLM
// and LM Studio all speak the OpenAI format and accept different parameters
// under different names. A seat pointed at 127.0.0.1:8888 is "openai" to the
// app and llama.cpp in reality, and sending it OpenAI's parameter set (or,
// worse, sending an unknown server llama.cpp's extensions) throws the turn
// away for nothing.
//
// Three properties matter more than the rest, and each has bitten before:
//
//   1. UNSET MEANS ABSENT. Not zero. temperature:0 makes a model
//      deterministic and num_ctx:0 is an error, so "" and 0 have to stay
//      distinguishable all the way to the request body.
//   2. THE CONTEXT WINDOW ONLY REACHES THE WIRE ON OLLAMA. Everywhere else it
//      is fixed when the server launches; a slider that silently did nothing
//      would be worse than no slider.
//   3. AN UNIDENTIFIED SERVER GETS THE SAFE SET ONLY. A parameter it has not
//      heard of can 400, and a 400 costs the whole turn.
//
// Run:  node scripts/check-runtimes.js
const {
  RUNTIMES, controlsFor, runtimeParams, thinkingChoice, runtimeIdFor,
  detectRuntime, rootOf,
} = require('../electron/runtimes.js');
const { callAgent } = require('../electron/providers.js');

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);
const keys = (o) => Object.keys(o || {}).sort();

// ===========================================================================
// 1. Unset means absent
// ===========================================================================
ok('a seat that set nothing sends nothing', runtimeParams({}, 'ollama') === null);
ok('…even with every field present but empty',
   runtimeParams({ contextWindow: '', temperature: '', topP: '', maxTokens: '' }, 'ollama') === null);
ok('…and null/undefined are equally absent',
   runtimeParams({ contextWindow: null, temperature: undefined }, 'ollama') === null);
ok('a real zero is NOT absent',
   runtimeParams({ temperature: 0 }, 'ollama')?.temperature === 0);
ok('…zero GPU layers means CPU-only, not unset',
   runtimeParams({ gpuLayers: 0 }, 'ollama')?.num_gpu === 0);
ok('garbage is ignored rather than sent',
   runtimeParams({ temperature: 'hot' }, 'ollama') === null);

// ===========================================================================
// 2. Each runtime gets ITS OWN parameter names
// ===========================================================================
const all = {
  contextWindow: 32768, gpuLayers: 20, maxTokens: 2048,
  temperature: 0.3, topP: 0.9, topK: 40, minP: 0.05, repeatPenalty: 1.1,
};
const ollama = runtimeParams(all, 'ollama');
ok('ollama nests under its own names',
   ollama.num_ctx === 32768 && ollama.num_gpu === 20 && ollama.num_predict === 2048);
ok('…and its sampling names', ollama.top_p === 0.9 && ollama.repeat_penalty === 1.1);

const llama = runtimeParams(all, 'llamacpp');
ok('llama.cpp gets max_tokens, not num_predict', llama.max_tokens === 2048 && !('num_predict' in llama));
ok('…and repeat_penalty', llama.repeat_penalty === 1.1);
ok('…and min_p', llama.min_p === 0.05);

const vllm = runtimeParams(all, 'vllm');
ok('vLLM says repetition_penalty, not repeat_penalty',
   vllm.repetition_penalty === 1.1 && !('repeat_penalty' in vllm));

const lms = runtimeParams(all, 'lmstudio');
ok('LM Studio gets top_k', lms.top_k === 40);
ok('…but not min_p, which it does not take', !('min_p' in lms));

// The safe set — this is the one that must stay small.
ok('an unidentified server gets ONLY the universal parameters',
   keys(runtimeParams(all, 'openai_compatible')).join(',') === 'max_tokens,temperature,top_p');
ok('…identically for the real OpenAI API',
   keys(runtimeParams(all, 'openai')).join(',') === 'max_tokens,temperature,top_p');
ok('…and for Anthropic', keys(runtimeParams(all, 'anthropic')).join(',') === 'max_tokens,temperature,top_p');
ok('a CLI seat sends nothing at all', runtimeParams(all, 'cli') === null);
ok('an unknown runtime id falls back to the safe set, not a crash',
   keys(runtimeParams(all, 'nonsense')).join(',') === 'max_tokens,temperature,top_p');

// ===========================================================================
// 3. The context window only reaches the wire where it is real
// ===========================================================================
ok('ollama sends num_ctx', 'num_ctx' in runtimeParams({ contextWindow: 8192 }, 'ollama'));
for (const id of ['llamacpp', 'vllm', 'lmstudio', 'openai_compatible', 'openai', 'anthropic']) {
  const p = runtimeParams({ contextWindow: 8192 }, id) || {};
  ok(`${id} does NOT send a context window`, !Object.keys(p).some((k) => /ctx|context|model_len/i.test(k)));
}
// …but the control is still SHOWN everywhere, because a seat silently running
// in a 4k window is the most expensive thing not to know.
for (const id of ['ollama', 'llamacpp', 'vllm', 'lmstudio', 'openai']) {
  const c = controlsFor(id).find((x) => x.key === 'contextWindow');
  ok(`${id} still shows the context window`, !!c);
}
ok('ollama lets you edit it', controlsFor('ollama').find((c) => c.key === 'contextWindow').editable === true);
for (const id of ['llamacpp', 'vllm', 'lmstudio']) {
  const c = controlsFor(id).find((x) => x.key === 'contextWindow');
  ok(`${id} shows it read-only`, c.editable === false);
  ok(`…and says where it IS set`, /ctx-size|max-model-len|loader/i.test(c.readOnlyReason || ''));
}
ok('a CLI seat is not offered a context window',
   !controlsFor('cli').some((c) => c.key === 'contextWindow'));
ok('a CLI seat is offered nothing at all', controlsFor('cli').length === 0);
ok('…and says why', /keeps its own settings/i.test(RUNTIMES.cli.note));

// ===========================================================================
// 4. Reasoning is Ollama-only, and an explicit choice is a real choice
// ===========================================================================
ok('only ollama offers the reasoning toggle',
   controlsFor('ollama').some((c) => c.key === 'thinking')
   && !['llamacpp', 'vllm', 'lmstudio', 'openai', 'anthropic'].some((id) =>
     controlsFor(id).some((c) => c.key === 'thinking')));
ok('auto stays silent', thinkingChoice({ thinking: 'auto' }) === undefined);
ok('unset stays silent', thinkingChoice({}) === undefined);
ok('on means true', thinkingChoice({ thinking: 'on' }) === true);
ok('off means false', thinkingChoice({ thinking: 'off' }) === false);

// ===========================================================================
// 5. Which runtime applies to a seat
// ===========================================================================
ok('a saved choice wins', runtimeIdFor({ provider: 'openai', runtime: 'llamacpp' }) === 'llamacpp');
ok('a bogus saved choice is ignored', runtimeIdFor({ provider: 'ollama', runtime: 'nope' }) === 'ollama');
ok('ollama defaults to ollama', runtimeIdFor({ provider: 'ollama' }) === 'ollama');
ok('anthropic defaults to anthropic', runtimeIdFor({ provider: 'anthropic' }) === 'anthropic');
ok('cli defaults to cli', runtimeIdFor({ provider: 'cli' }) === 'cli');
ok('an openai seat defaults to the SAFE set, never a guess',
   runtimeIdFor({ provider: 'openai' }) === 'openai_compatible');

// The probe endpoints hang off the root, but a seat's baseUrl usually ends /v1.
ok('a /v1 suffix is stripped for probing', rootOf('http://127.0.0.1:8888/v1') === 'http://127.0.0.1:8888');
ok('…and a trailing slash', rootOf('http://127.0.0.1:8888/v1/') === 'http://127.0.0.1:8888');
ok('…and a bare root is left alone', rootOf('http://localhost:11434') === 'http://localhost:11434');

// ===========================================================================
// 6. Detection
// ===========================================================================
function stub(routes) {
  global.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[path] };
  };
}
const seat = (baseUrl, provider = 'openai') => ({ provider, baseUrl });

(async () => {
  stub({ '/api/version': { version: '0.14.2' } });
  let d = await detectRuntime(seat('http://localhost:11434', 'ollama'));
  ok('Ollama is detected by /api/version', d.id === 'ollama' && d.detected === true);
  ok('…and its version reported', d.version === '0.14.2');

  stub({ '/props': { build_info: 'b8681', model_path: '/models/qwen3.8-27b-q4_K_M.gguf', default_generation_settings: { n_ctx: 16384 } } });
  d = await detectRuntime(seat('http://127.0.0.1:8888/v1'));
  ok('llama-server is detected by /props', d.id === 'llamacpp');
  ok('…and its REAL context window read back', d.contextWindow === 16384);
  ok('…and the model file named', d.model === 'qwen3.8-27b-q4_K_M.gguf');
  ok('…even though the seat is configured as "openai"', d.detected === true);

  stub({ '/v1/models': { data: [{ id: 'Qwen/Qwen3.8-27B', max_model_len: 262144 }] }, '/version': { version: '0.11.0' } });
  d = await detectRuntime(seat('http://127.0.0.1:8000/v1'));
  ok('vLLM is detected by max_model_len', d.id === 'vllm');
  ok('…with its context window', d.contextWindow === 262144);

  stub({ '/api/v0/models': { data: [
    { id: 'small', state: 'not-loaded', max_context_length: 4096 },
    { id: 'qwen3.8-27b', state: 'loaded', max_context_length: 131072 },
  ] } });
  d = await detectRuntime(seat('http://localhost:1234/v1'));
  ok('LM Studio is detected by its own REST layer', d.id === 'lmstudio');
  ok('…and reports the LOADED model, not the first one', d.model === 'qwen3.8-27b');
  ok('…with its context window', d.contextWindow === 131072);

  // A server that is up but unrecognised, vs one that is not running at all —
  // the advice differs, so the two must not collapse into one state.
  stub({ '/v1/models': { data: [{ id: 'mystery' }] } });
  d = await detectRuntime(seat('http://127.0.0.1:9999/v1'));
  ok('an unrecognised but LIVE server falls back safely', d.id === 'openai_compatible');
  ok('…marked as a fallback, not an observation', d.detected === false);
  ok('…but reported as reachable', d.reachable === true);

  stub({});
  d = await detectRuntime(seat('http://127.0.0.1:8888/v1'));
  ok('a server that is not running is reported unreachable', d.reachable === false);
  ok('…and still yields a usable control set', controlsFor(d.id).length > 0);
  ok('…and does not claim to have detected anything', d.detected === false);

  // Hosted APIs are known by their hostname; probing them is pointless.
  d = await detectRuntime(seat('https://api.openai.com/v1'));
  ok('the OpenAI API is recognised without a probe', d.id === 'openai' && d.detected === true);
  d = await detectRuntime({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  ok('Anthropic is recognised without a probe', d.id === 'anthropic');
  d = await detectRuntime({ provider: 'cli', command: 'claude' });
  ok('a CLI seat is not probed at all', d.id === 'cli' && d.reachable === true);

  // A missing baseUrl must not throw.
  d = await detectRuntime({ provider: 'openai' });
  ok('a seat with no address degrades quietly', d.id === 'openai_compatible' && d.reachable === false);

  // ========================================================================
  // 7. End to end — what really lands in the request body
  // ========================================================================
  let sent = [];
  const capture = (reply) => {
    sent = [];
    global.fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, json: async () => reply, body: null, text: async () => '' };
    };
  };
  const MSGS = [{ role: 'user', content: 'hi' }];

  capture({ model: 'srv', message: { content: 'ok' } });
  await callAgent({
    provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3.8:27b',
    contextWindow: 32768, gpuLayers: 20, temperature: 0.2,
  }, MSGS);
  ok('an ollama seat really sends options.num_ctx', sent[0].body.options.num_ctx === 32768);
  ok('…and num_gpu', sent[0].body.options.num_gpu === 20);
  ok('…and temperature', sent[0].body.options.temperature === 0.2);
  ok('…and nothing it was not given', keys(sent[0].body.options).join(',') === 'num_ctx,num_gpu,temperature');

  capture({ model: 'srv', message: { content: 'ok' } });
  await callAgent({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'm' }, MSGS);
  ok('an untouched ollama seat sends NO options block at all', !('options' in sent[0].body));
  ok('…and no think parameter', !('think' in sent[0].body));

  capture({ model: 'srv', message: { content: 'ok' } });
  await callAgent({ provider: 'ollama', baseUrl: 'http://x', model: 'm', thinking: 'off' }, MSGS);
  ok('"always off" sends think:false on the FIRST call', sent[0].body.think === false);
  ok('…in one request, with no retry dance', sent.length === 1);

  capture({ model: 'srv', message: { content: '', thinking: 'reasoned a lot' } });
  await callAgent({ provider: 'ollama', baseUrl: 'http://x', model: 'm2', thinking: 'on' }, MSGS);
  ok('"always on" is honoured', sent[0].body.think === true);
  ok('…and is NOT undone by the automatic retry', sent.length === 1);

  capture({ choices: [{ message: { content: 'ok' } }] });
  await callAgent({
    provider: 'openai', baseUrl: 'http://127.0.0.1:8888/v1', model: 'q', apiKey: 'k',
    runtime: 'llamacpp', contextWindow: 99999, maxTokens: 1024, topK: 40, repeatPenalty: 1.05,
  }, MSGS);
  ok('a llama.cpp seat sends top_k at the top level', sent[0].body.top_k === 40);
  ok('…and repeat_penalty', sent[0].body.repeat_penalty === 1.05);
  ok('…and max_tokens', sent[0].body.max_tokens === 1024);
  ok('…but NOT the context window, which it cannot honour',
     !Object.keys(sent[0].body).some((k) => /ctx|context|model_len/i.test(k)));

  capture({ choices: [{ message: { content: 'ok' } }] });
  await callAgent({
    provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', apiKey: 'k',
    topK: 40, repeatPenalty: 1.05, temperature: 0.4,
  }, MSGS);
  ok('an OpenAI seat is not sent llama.cpp extensions',
     !('top_k' in sent[0].body) && !('repeat_penalty' in sent[0].body));
  ok('…but does get temperature', sent[0].body.temperature === 0.4);

  capture({ content: [{ type: 'text', text: 'ok' }] });
  await callAgent({
    provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
    apiKey: 'k', temperature: 0.1, maxTokens: 8000,
  }, MSGS);
  ok('an anthropic seat gets temperature', sent[0].body.temperature === 0.1);
  ok('…and keeps its required max_tokens', sent[0].body.max_tokens === 8000);
  ok('…exactly once', (JSON.stringify(sent[0].body).match(/"max_tokens"/g) || []).length === 1);

  for (const [r, n] of t) console.log(`${r}  ${n}`);
  const f = t.filter((x) => x[0] === 'FAIL').length;
  console.log(`\n${t.length - f}/${t.length} passed`);
  process.exit(f ? 1 : 0);
})();
