// scripts/check-ollama-thinking.js
// Guards the thinking-model path in electron/providers.js callOllama().
//
// The bug: thinking models (qwen3, deepseek-r1, gpt-oss…) return their
// reasoning in `message.thinking` and can return message.content EMPTY — the
// model spends its whole output budget reasoning and never writes an answer.
// callOllama read only `.content`, so a Qwen3.6 seat rendered "(empty
// response)" every round while looking otherwise healthy, and nothing in the
// transcript hinted that thousands of characters of reasoning had happened.
//
// The fix must hold three lines at once:
//   1. never send `think` on a first call — not every model/version accepts it,
//      and a seat whose reasoning the user wants must keep it
//   2. retry ONCE with think:false when the model reasoned but did not answer,
//      and remember that model needs it
//   3. if it still will not answer, say WHY instead of "(empty response)"
//
// Run:  node scripts/check-ollama-thinking.js
const { callAgent } = require('../electron/providers.js');

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);

const agent = (model) => ({
  provider: 'ollama', baseUrl: 'http://localhost:11434', model, systemPrompt: 'sys',
});
const MSGS = [{ role: 'user', content: 'hi' }];

// Stub fetch; record every request body so we can assert on what was SENT.
let sent = [];
function stubFetch(replies) {
  let i = 0;
  sent = [];
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const body = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return {
      ok: true,
      json: async () => body,
      body: null,
      text: async () => JSON.stringify(body),
    };
  };
}
const reply = (content, thinking) => ({
  model: 'srv', message: { content, ...(thinking ? { thinking } : {}) },
  prompt_eval_count: 5, eval_count: 7,
});

(async () => {
  // --- 1. an ordinary answer is untouched, and `think` is never sent --------
  stubFetch([reply('a real answer', '')]);
  let r = await callAgent(agent('llama3'), MSGS);
  ok('normal reply passes straight through', r.text === 'a real answer');
  ok('…in ONE request', sent.length === 1);
  ok('…with no think parameter', !('think' in sent[0]));
  ok('…usage still reported', r.usage?.input === 5 && r.usage?.output === 7);
  ok('…servedModel still reported', r.servedModel === 'srv');

  // A model that reasons AND answers is also left alone — reasoning is not a
  // problem in itself, only an answerless turn is.
  stubFetch([reply('answered anyway', 'lots of reasoning')]);
  r = await callAgent(agent('qwen3.6'), MSGS);
  ok('reasoning + answer needs no retry', r.text === 'answered anyway' && sent.length === 1);

  // --- 2. reasoned but never answered → one retry with think:false ---------
  stubFetch([reply('', 'thought hard about it'), reply('the answer', '')]);
  r = await callAgent(agent('qwen3.6-a'), MSGS);
  ok('answerless turn is retried', sent.length === 2);
  ok('…first attempt sent no think param', !('think' in sent[0]));
  ok('…retry sent think:false', sent[1].think === false);
  ok('…and the real answer is returned', r.text === 'the answer');

  // The model is remembered, so the next call skips the wasted round trip.
  stubFetch([reply('second answer', '')]);
  r = await callAgent(agent('qwen3.6-a'), MSGS);
  ok('a known thinking model sends think:false up front', sent[0].think === false);
  ok('…in ONE request', sent.length === 1);
  ok('…and answers normally', r.text === 'second answer');

  // The cache is per model, not global.
  stubFetch([reply('fresh', '')]);
  await callAgent(agent('some-other-model'), MSGS);
  ok('the no-think cache does not leak to other models', !('think' in sent[0]));

  // --- 3. still no answer → explain, do not just say "(empty response)" ----
  stubFetch([reply('', 'x'.repeat(4000)), reply('', 'x'.repeat(4000))]);
  r = await callAgent(agent('qwen3.6-b'), MSGS);
  ok('a persistently answerless model does not report "(empty response)"',
     !r.text.includes('(empty response)'));
  ok('…it reports the reasoning length', r.text.includes('4000 characters of reasoning'));
  ok('…and names the model', r.text.includes('qwen3.6-b'));
  ok('…and suggests something actionable', /non-thinking model/.test(r.text));
  ok('…and it is not cached as fixed (retry did not help)', sent.length === 2);

  // A genuinely empty reply with no reasoning keeps the old wording — there is
  // nothing more to say about it.
  stubFetch([reply('', '')]);
  r = await callAgent(agent('mute-model'), MSGS);
  ok('truly empty reply still reads "(empty response)"', r.text === '(empty response)');
  ok('…and is NOT retried (no reasoning to explain it)', sent.length === 1);

  // --- 4. a model/version that rejects `think` must not lose the turn ------
  let n = 0;
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    n += 1;
    if (n === 1) return { ok: true, json: async () => reply('', 'reasoned'), text: async () => '' };
    return { ok: false, status: 400, text: async () => 'unknown parameter "think"' };
  };
  sent = [];
  r = await callAgent(agent('picky-model'), MSGS);
  ok('a rejected think:false retry does not throw', typeof r.text === 'string');
  ok('…and still explains the answerless turn', r.text.includes('reasoning but no answer'));

  for (const [res, name] of t) console.log(`${res}  ${name}`);
  const f = t.filter((x) => x[0] === 'FAIL').length;
  console.log(`\n${t.length - f}/${t.length} passed`);
  process.exit(f ? 1 : 0);
})();
