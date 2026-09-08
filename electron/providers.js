// Provider adapters. Each takes an agent config + a message history and
// returns the assistant's reply text. Adding support for a new backend
// means adding one case here — the rest of the app stays the same.
//
// provider: 'ollama' | 'openai' | 'anthropic' | 'cli'
// messages: [{ role: 'user'|'assistant', content }]

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCommand, spawnSpec } = require('./cli-detect');
const { log } = require('./log');
const { runtimeParams, thinkingChoice, runtimeIdFor } = require('./runtimes.js');

// HTTP calls get a hard cap so a stalled endpoint (Ollama mid-generation,
// dead network) surfaces as an error instead of hanging "…thinking" forever.
// Generous because big local models on CPU are genuinely slow.
const HTTP_TIMEOUT_MS = 300000; // 5 min

function withTimeout(signal, ms = HTTP_TIMEOUT_MS) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// undici (Node's fetch, and so Electron's) reports every mid-flight socket
// failure as the same useless `TypeError: terminated`. The actual reason —
// "other side closed", a body timeout, ECONNRESET — is one or two levels down
// in .cause, which never reaches the UI. Same problem as MCP's bare
// "Connection closed", same fix: unwrap and append.
function describeFetchError(err) {
  const parts = [];
  const seen = new Set();
  for (let e = err; e && typeof e === 'object' && !seen.has(e); e = e.cause) {
    seen.add(e);
    const name = e.name && e.name !== 'Error' && e.name !== 'TypeError' ? e.name : '';
    const msg = String(e.message || '').trim();
    const part = [name, msg].filter(Boolean).join(': ');
    if (part && !parts.includes(part)) parts.push(part);
    if (e.code && !parts.includes(e.code)) parts.push(String(e.code));
  }
  return parts.join(' ← ') || String(err?.message || err);
}

// Worth one retry: the connection died in a way that says nothing about the
// request itself. Deliberately excludes AbortError — that is either the user
// hitting stop or our own HTTP_TIMEOUT_MS cap, and retrying both is wrong.
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isTransientNetworkError(err) {
  if (!err || err.name === 'AbortError') return false;
  const seen = new Set();
  for (let e = err; e && typeof e === 'object' && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (e.code && TRANSIENT_CODES.has(String(e.code))) return true;
    if (/^terminated$/i.test(String(e.message || '').trim())) return true;
    if (/socket hang up|other side closed|premature close/i.test(String(e.message || ''))) return true;
  }
  return false;
}

// A stream that dies mid-reply has still produced usable text. Returning it
// beats throwing away a long answer — but the last line is by definition
// half-written, and a truncated "CHECK: write_file …" is a directive the
// orchestrator would act on. Drop the incomplete tail, keep the rest.
function salvagePartial(text) {
  const cut = text.lastIndexOf('\n');
  return cut > 0 ? text.slice(0, cut) : '';
}

// ---- streaming ----------------------------------------------------------
// HTTP adapters can stream. onDelta(text) fires per fragment as it arrives;
// the adapter still RESOLVES with the same full { text, servedModel } shape,
// so nothing downstream changes — streaming is display-only, and all parsing
// (thinking-split, CHECK/TASK) happens on the final resolved text as before.
// CLI agents don't stream (stdout is buffered until exit); callers must treat
// "no deltas, then the full text at once" as valid.
//
// readLines: feed each newline-delimited line of a fetch response body to
// onLine. Covers both SSE ("data: {...}") and NDJSON (Ollama). Uses the
// reader API (not for-await) for portability across undici versions. An
// aborted signal rejects reader.read() with AbortError, which propagates.
async function readLines(res, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) onLine(buf.replace(/\r$/, ''));
}

// Gemini CLI refuses to run non-interactively until an auth method has been
// chosen. If the user already signed in with Google once (cached creds exist)
// but the selection was never saved, save it for them — that's the only part
// a file can fix. No credentials are created here; if the user never signed
// in, the friendly error below tells them the one-time step.
function ensureGeminiAuthSelected(cmd) {
  if (!/gemini/i.test(cmd)) return;
  try {
    const dir = path.join(os.homedir(), '.gemini');
    const credsExist = ['oauth_creds.json', 'google_accounts.json'].some((f) =>
      fs.existsSync(path.join(dir, f)),
    );
    if (!credsExist) return; // nothing to select — sign-in has to happen once
    const file = path.join(dir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* fresh file */ }
    if (settings.selectedAuthType || settings.security?.auth?.selectedType) return;
    settings.selectedAuthType = 'oauth-personal'; // legacy key
    settings.security = {
      ...(settings.security || {}),
      auth: { ...(settings.security?.auth || {}), selectedType: 'oauth-personal' },
    };
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
  } catch { /* best-effort; the real error still surfaces on spawn */ }
}

// Translate common CLI sign-in failures into a one-line instruction.
function cliAuthHint(stderrText) {
  if (/GEMINI_API_KEY|Auth method|GOOGLE_GENAI_USE/i.test(stderrText)) {
    return 'Gemini isn\'t signed in yet — open a terminal, run "gemini" once, and choose "Login with Google" (one-time setup). ';
  }
  if (/Not logged in|Please run \/login/i.test(stderrText)) {
    return 'Claude isn\'t signed in yet — open a terminal, run "claude" once, and log in (one-time setup). ';
  }
  return '';
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

// ---- image attachments ------------------------------------------------------
// Messages may carry images: ['data:image/jpeg;base64,...']. Each adapter
// converts to its provider's wire format below.

function parseDataUrl(u) {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(u || '');
  return m ? { mediaType: m[1], base64: m[2] } : null;
}

// Some OpenAI-compatible endpoints expose a text-only /chat/completions schema
// and reject the standard image_url content part with a 400 ("unknown variant
// `image_url`, expected `text`"). DeepSeek is the known case — its public API
// is text-only per https://api-docs.deepseek.com/api/create-chat-completion/
// even for the v4 models. For those seats we strip images and tell the model,
// rather than letting the whole call fail. Extend the check as others surface.
function openAICompatAcceptsImages(agent) {
  if (typeof agent?.supportsImages === 'boolean') return agent.supportsImages; // manual override
  const hay = `${agent?.baseUrl || ''} ${agent?.model || ''}`.toLowerCase();
  if (hay.includes('deepseek')) return false;
  return true;
}

// Text-only seat: drop the image parts but leave a breadcrumb, so the model
// answers "I can't see it" instead of pretending nothing was attached.
function withImagesStripped(m) {
  const note = `[${m.images.length} image attachment(s) were omitted — this model can't receive images. Ask a vision-capable seat to describe them.]`;
  return { role: m.role, content: m.content ? `${m.content}\n\n${note}` : note };
}

// Ollama HARD-FAILS on images to a text-only model: 400 "Multimodal data
// provided, but model does not support multimodal requests" — the seat never
// runs at all (this is what killed the DEBUGGER seat on qwen3-coder). So ask
// the server what the model can do before sending. /api/show reports
// capabilities: ['completion','vision','tools',...] on modern Ollama; older
// servers omit it → null = unknown, and callOllama self-heals on the 400.
// Cached per baseUrl+model; capability is a property of the model, not the run.
const ollamaVisionCache = new Map();
function ollamaVisionKey(agent) {
  return `${(agent?.baseUrl || '').replace(/\/$/, '')}|${agent?.model || ''}`;
}
async function ollamaSupportsVision(agent, signal) {
  if (typeof agent?.supportsImages === 'boolean') return agent.supportsImages; // manual override
  const key = ollamaVisionKey(agent);
  if (ollamaVisionCache.has(key)) return ollamaVisionCache.get(key);
  try {
    const res = await fetch(`${agent.baseUrl.replace(/\/$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agent.model }),
      signal: withTimeout(signal, 15000),
    });
    if (!res.ok) return null; // model mid-pull, older API, etc. — don't cache
    const data = await res.json();
    const caps = Array.isArray(data?.capabilities) ? data.capabilities : null;
    if (!caps) return null; // pre-capabilities Ollama — unknown, try and see
    const ok = caps.includes('vision');
    ollamaVisionCache.set(key, ok);
    return ok;
  } catch {
    return null; // network hiccup here must not break the actual chat call
  }
}

// CLI seats can't take image bytes — save to a temp file once (content-hashed,
// so re-sent transcripts reuse the same file) and reference the path in the
// prompt. Agentic CLIs (claude, gemini) open the file themselves.
const crypto = require('crypto');
const imageFileCache = new Map();
function imageToTempFile(dataUrl) {
  const p = parseDataUrl(dataUrl);
  if (!p) return null;
  const hash = crypto.createHash('sha1').update(p.base64).digest('hex').slice(0, 16);
  if (imageFileCache.has(hash)) return imageFileCache.get(hash);
  const ext = p.mediaType.split('/')[1].replace('jpeg', 'jpg');
  const file = path.join(os.tmpdir(), `roundtable-img-${hash}.${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(p.base64, 'base64'));
  } catch {
    return null;
  }
  imageFileCache.set(hash, file);
  return file;
}

// Thinking models (qwen3, deepseek-r1, gpt-oss, …) put their reasoning in
// `message.thinking` and can come back with message.content EMPTY — the model
// spends its whole output budget reasoning and never writes an answer. This
// file only ever read `.content`, so such a seat rendered as "(empty response)"
// every single round while looking otherwise healthy.
//
// Ollama's `think: false` turns reasoning off so the model answers directly.
// We deliberately do NOT send it up front: it is not accepted by every
// model/version, and a seat the user WANTS reasoning from should keep it.
// Instead, notice the empty answer, retry ONCE with think:false, and remember
// the model needs it — the same self-heal shape as ollamaVisionCache above.
const ollamaNoThinkCache = new Map();
const noThinkKey = (agent) => `${agent.baseUrl}::${agent.model}`;

async function callOllama(agent, messages, signal, onDelta) {
  const url = `${agent.baseUrl.replace(/\/$/, '')}/api/chat`;
  const hasImages = messages.some((m) => m.images?.length);
  // false = known text-only (strip up front); true/null = send and, if null,
  // let the 400 teach us.
  const visionOk = hasImages ? await ollamaSupportsVision(agent, signal) : false;

  // Per-seat runtime controls (context window, GPU layers, sampling…). Absent
  // entirely when the seat has set nothing, so an untouched seat sends exactly
  // the request it always did.
  const options = runtimeParams(agent, runtimeIdFor(agent));

  const post = (sendImages, think) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: agent.model,
        stream: !!onDelta,
        // undefined = say nothing and let the model do as it likes; true/false
        // = the seat asked for it explicitly, or the auto-retry is turning
        // reasoning off after an answerless turn.
        ...(think === undefined ? {} : { think }),
        ...(options ? { options } : {}),
        messages: [
          ...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []),
          ...messages.map((m) => {
            if (!m.images?.length) return { role: m.role, content: m.content };
            if (!sendImages) return withImagesStripped(m);
            // Ollama vision format: images = array of raw base64 strings.
            return {
              role: m.role,
              content: m.content,
              images: m.images.map((u) => parseDataUrl(u)?.base64).filter(Boolean),
            };
          }),
        ],
      }),
      signal: withTimeout(signal),
    });

  // One request/parse round. Returns { text, thinking, servedModel, usage } so
  // the caller can tell "the model said nothing" apart from "the model only
  // thought" — those need different handling and used to look identical.
  async function attempt(think) {
    let res = await post(hasImages && visionOk !== false, think);
    if (!res.ok) {
      const errText = await safeText(res);
      // Self-heal the unknown-capability case: remember this model is text-only
      // and retry stripped, so one attached screenshot can't take the seat out.
      if (hasImages && visionOk !== false && /multimodal|does not support images|image input/i.test(errText)) {
        ollamaVisionCache.set(ollamaVisionKey(agent), false);
        res = await post(false, think);
        if (!res.ok) throw new Error(`Ollama ${res.status}: ${await safeText(res)}`);
      } else if (think !== undefined && /think/i.test(errText)) {
        // This model or Ollama version does not accept `think` at all. The
        // seat asked for a setting the server cannot honour — losing the turn
        // over it would be worse than quietly doing without.
        log('ollama', `${agent.model} rejected think:${think} — retrying without it`);
        res = await post(hasImages && visionOk !== false, undefined);
        if (!res.ok) throw new Error(`Ollama ${res.status}: ${await safeText(res)}`);
      } else {
        throw new Error(`Ollama ${res.status}: ${errText}`);
      }
    }
    if (!onDelta) {
      const data = await res.json();
      // servedModel: what the SERVER says it ran — provider-attested, unlike the
      // model's own in-band claims about itself, which aren't verifiable.
      // usage: ADDITIVE field (Phase 9) — existing fields never change shape.
      return {
        text: data?.message?.content ?? '',
        thinking: data?.message?.thinking ?? '',
        servedModel: data?.model ?? null,
        usage: data?.prompt_eval_count != null || data?.eval_count != null
          ? { input: data?.prompt_eval_count ?? null, output: data?.eval_count ?? null }
          : null,
      };
    }
    // Streaming: NDJSON — one JSON object per line, done:true on the last.
    let text = '';
    let thinking = '';
    let servedModel = null;
    let usage = null;
    await readLines(res, (line) => {
      if (!line.trim()) return;
      let data;
      try { data = JSON.parse(line); } catch { return; } // partial/junk line — skip
      if (data?.error) throw new Error(`Ollama: ${data.error}`);
      if (data?.model) servedModel = data.model;
      if (data?.done && (data?.prompt_eval_count != null || data?.eval_count != null)) {
        usage = { input: data?.prompt_eval_count ?? null, output: data?.eval_count ?? null };
      }
      const piece = data?.message?.content;
      if (piece) { text += piece; onDelta(piece); }
      // Reasoning is NOT streamed to the bubble — it is only kept so an
      // answerless turn can be explained instead of showing a blank.
      const thought = data?.message?.thinking;
      if (thought) thinking += thought;
    });
    return { text, thinking, servedModel, usage };
  }

  // An explicit choice on the seat wins outright — including "always on", which
  // is a deliberate "let it reason, I will wait" and must not be undone by the
  // automatic retry below.
  const chosen = thinkingChoice(agent);
  const cachedNoThink = chosen === undefined && ollamaNoThinkCache.get(noThinkKey(agent)) === true;
  const auto = chosen === undefined;
  let out = await attempt(auto ? (cachedNoThink ? false : undefined) : chosen);

  // Reasoned but never answered → retry once with reasoning off.
  if (auto && !out.text.trim() && out.thinking.trim() && !cachedNoThink) {
    try {
      // attempt() now takes the think VALUE, not a "noThink" flag — false is
      // what turns reasoning off. (The suite caught this inversion.)
      const retry = await attempt(false);
      if (retry.text.trim()) {
        ollamaNoThinkCache.set(noThinkKey(agent), true);
        log('ollama', `${agent.model} answered only after think:false — caching for this model`);
        out = retry;
      }
    } catch (e) {
      // `think` refused by this model/version: keep the first result and fall
      // through to the diagnostic below rather than failing the whole turn.
      log('ollama', `think:false retry failed for ${agent.model}: ${e.message}`);
    }
  }

  if (out.text.trim()) return { text: out.text, servedModel: out.servedModel, usage: out.usage };

  // Still nothing. Say WHY — "(empty response)" gave no clue that the model had
  // reasoned for thousands of characters and simply never written an answer.
  const text = out.thinking.trim()
    ? `⚠️ ${agent.model} produced ${out.thinking.trim().length} characters of reasoning but no answer, `
      + 'and did not answer with reasoning disabled either. It is likely running out of output budget '
      + 'while thinking — try a non-thinking model for this seat, or shorten the conversation.'
    : '(empty response)';
  return { text, servedModel: out.servedModel, usage: out.usage };
}

async function callOpenAICompatible(agent, messages, signal, onDelta) {
  const url = `${agent.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const visionOk = openAICompatAcceptsImages(agent);
  const body = {
    model: agent.model,
    ...(onDelta ? { stream: true } : {}),
    // Per-seat runtime controls, named the way THIS runtime wants them —
    // llama.cpp says repeat_penalty where vLLM says repetition_penalty, and an
    // unidentified server gets only the parameters every OpenAI-compatible
    // endpoint accepts, because one it has never heard of can 400 the turn.
    ...(runtimeParams(agent, runtimeIdFor(agent)) || {}),
    messages: [
      ...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []),
      ...messages.map((m) => {
        if (!m.images?.length) return { role: m.role, content: m.content };
        // Text-only endpoint (e.g. DeepSeek): drop the images so the request
        // doesn't 400, but note their presence so the seat can say it can't
        // see them instead of answering as if no image was ever attached.
        if (!visionOk) return withImagesStripped(m);
        // OpenAI vision format: content becomes an array of text + image_url parts.
        return {
          role: m.role,
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
          ],
        };
      }),
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  if (!res.ok) throw new Error(`OpenAI-compat ${res.status}: ${await safeText(res)}`);
  if (!onDelta) {
    const data = await res.json();
    return {
      text: data?.choices?.[0]?.message?.content ?? '(empty response)',
      servedModel: data?.model ?? null,
      usage: data?.usage
        ? { input: data.usage.prompt_tokens ?? null, output: data.usage.completion_tokens ?? null }
        : null,
    };
  }
  // Streaming: SSE — "data: {chunk}" lines, "data: [DONE]" terminator.
  let text = '';
  let servedModel = null;
  let usage = null;
  try {
    await readLines(res, (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let data;
      try { data = JSON.parse(payload); } catch { return; }
      if (data?.model) servedModel = data.model;
      // Some endpoints include usage on the final chunk — take it if present.
      if (data?.usage) {
        usage = { input: data.usage.prompt_tokens ?? null, output: data.usage.completion_tokens ?? null };
      }
      const piece = data?.choices?.[0]?.delta?.content;
      if (piece) { text += piece; onDelta(piece); }
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const why = describeFetchError(err);
    // Nothing arrived: the caller can safely re-run the whole request.
    if (!text) throw Object.assign(new Error(why), { transient: isTransientNetworkError(err), cause: err });
    // Partial reply in hand. Re-running would duplicate what the user already
    // watched stream in, so keep it and mark the seam instead.
    const kept = salvagePartial(text);
    log('call', `stream cut short after ${text.length} chars (${why}) — keeping ${kept.length}`);
    if (!kept) throw Object.assign(new Error(why), { transient: isTransientNetworkError(err), cause: err });
    return { text: `${kept}\n\n_[reply cut short: ${why}]_`, servedModel, usage, truncated: true };
  }
  return { text: text || '(empty response)', servedModel, usage };
}

async function callAnthropic(agent, messages, signal, onDelta) {
  const url = `${(agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const body = {
    model: agent.model,
    ...(onDelta ? { stream: true } : {}),
    // 1024 was silently truncating long coder-seat answers. Honor a per-agent
    // maxTokens if the config carries one; otherwise a roomy default.
    max_tokens: Number(agent.maxTokens) > 0 ? Number(agent.maxTokens) : 4096,
    // temperature / top_p when the seat set them. max_tokens stays above:
    // Anthropic requires one, and 1024 was truncating coder seats.
    ...(() => { const p = runtimeParams(agent, 'anthropic') || {}; delete p.max_tokens; return p; })(),
    ...(agent.systemPrompt ? { system: agent.systemPrompt } : {}),
    // Anthropic vision format: content blocks with base64 image sources.
    messages: messages.map((m) => {
      if (!m.images?.length) return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: [
          ...m.images
            .map((u) => {
              const p = parseDataUrl(u);
              return p
                ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } }
                : null;
            })
            .filter(Boolean),
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ],
      };
    }),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': agent.apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await safeText(res)}`);
  if (!onDelta) {
    const data = await res.json();
    return {
      text: data?.content?.[0]?.text ?? '(empty response)',
      servedModel: data?.model ?? null,
      usage: data?.usage
        ? { input: data.usage.input_tokens ?? null, output: data.usage.output_tokens ?? null }
        : null,
    };
  }
  // Streaming: SSE events — message_start carries the attested model,
  // content_block_delta/text_delta carries text. Ignore pings/other blocks.
  let text = '';
  let servedModel = null;
  let usage = null;
  await readLines(res, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    if (data?.type === 'error') {
      throw new Error(`Anthropic stream: ${data?.error?.message || 'unknown error'}`);
    }
    if (data?.type === 'message_start') {
      servedModel = data?.message?.model ?? null;
      const u = data?.message?.usage;
      if (u) usage = { input: u.input_tokens ?? null, output: u.output_tokens ?? null };
    }
    if (data?.type === 'message_delta' && data?.usage?.output_tokens != null) {
      usage = { ...(usage || { input: null }), output: data.usage.output_tokens };
    }
    if (data?.type === 'content_block_delta' && data?.delta?.type === 'text_delta' && data.delta.text) {
      text += data.delta.text;
      onDelta(data.delta.text);
    }
  });
  return { text: text || '(empty response)', servedModel, usage };
}

// Drives an already-authenticated CLI (claude, qwen). Auth lives in the CLI
// from your terminal login; no API key in the app. We flatten the transcript
// into one prompt, pipe it on stdin, read the reply from stdout.
function flattenForCli(agent, messages) {
  const lines = [];
  if (agent.cwd) lines.push(`[Working directory: ${agent.cwd}]`, '');
  if (agent.systemPrompt) lines.push(`[System]: ${agent.systemPrompt}`, '');
  for (const m of messages) {
    const who = m.role === 'assistant' ? agent.name : '';
    lines.push(who ? `${who}: ${m.content}` : m.content);
    // Images: saved to temp files; agentic CLIs (claude, gemini) read paths.
    for (const u of m.images || []) {
      const f = imageToTempFile(u);
      if (f) lines.push(`[Image attached — open this file to view it: ${f}]`);
    }
  }
  lines.push('', `${agent.name}:`);
  return lines.join('\n');
}

function callCli(agent, messages, signal) {
  return new Promise((resolve, reject) => {
    const cmd = (agent.command || '').trim();
    if (!cmd) return reject(new Error('No command set for this CLI agent.'));

    const extra = (agent.args || '').trim();
    // Per-CLI invocation. claude: -p = print mode, prompt read from stdin.
    // gemini/qwen: -p expects an INLINE prompt value, so a bare -p breaks
    // them — they run non-interactively when the prompt is piped on stdin,
    // no flag needed. Unknown CLIs get plain stdin too (most portable).
    const args = [];
    if (/claude/i.test(cmd)) args.push('-p', '--output-format', 'text');
    if (extra) args.push(...extra.split(/\s+/));

    // CLI write approvals (claude only — other CLIs have no headless
    // permission-prompt hook). main.js attaches cliApproval when the seat's
    // stored canWrite is true: spawn our MCP approval server (Electron run as
    // Node, so no system Node needed) and route every permission request
    // through it. The user answers in Roundtable's modal; denial is the
    // failure mode for any breakage. Config goes in a per-call temp file,
    // cleaned up on exit.
    let mcpCfgPath = null;
    if (agent.cliApproval && /claude/i.test(cmd)) {
      const cfg = {
        mcpServers: {
          rtapproval: {
            command: process.execPath,
            args: [agent.cliApproval.script],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              RT_APPROVAL_URL: agent.cliApproval.url,
              RT_APPROVAL_TOKEN: agent.cliApproval.token,
              RT_AGENT_NAME: agent.name || 'CLI seat',
            },
          },
        },
      };
      mcpCfgPath = path.join(
        os.tmpdir(),
        `rt-approve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`,
      );
      fs.writeFileSync(mcpCfgPath, JSON.stringify(cfg), 'utf8');
      args.push('--mcp-config', mcpCfgPath, '--permission-prompt-tool', 'mcp__rtapproval__approve');
    }
    const cleanupCfg = () => {
      if (!mcpCfgPath) return;
      try { fs.unlinkSync(mcpCfgPath); } catch { /* already gone */ }
      mcpCfgPath = null;
    };

    // Resolve to an absolute path (PATH + common install dirs). GUI apps
    // often miss the terminal's PATH, so a bare "claude" can fail here even
    // though it works in PowerShell.
    const resolved = resolveCommand(cmd);
    if (!resolved) {
      return reject(new Error(
        `Could not find "${cmd}" on this system. Edit this AI and click ` +
        `"Detect installed CLIs", or enter the full path to the executable.`,
      ));
    }

    // Auto-heal the "signed in but no auth method selected" gemini state.
    ensureGeminiAuthSelected(cmd);

    const prompt = flattenForCli(agent, messages);
    let out = '';
    let err = '';
    let child;
    const t0 = Date.now();
    try {
      // SECURITY: no shell:true — .cmd/.bat shims go through cmd.exe /c with
      // an argument array; everything else is spawned directly.
      const spec = spawnSpec(resolved, args);
      // agent.cwd: the active project's folder, set by main.js's agent:call
      // handler. This is what actually scopes a CLI agent's own file access
      // to the selected project — without it, every CLI seat is rooted at
      // wherever the Electron process itself started from.
      const spawnOpts = agent.cwd ? { cwd: agent.cwd } : undefined;
      log('cli', `spawn ${spec.file} ${spec.args.join(' ')} cwd=${agent.cwd || '(default)'} (prompt ${prompt.length} chars)`);
      child = spawn(spec.file, spec.args, spawnOpts);
    } catch (e) {
      log('cli', `spawn FAILED for "${cmd}": ${e.message}`);
      cleanupCfg();
      return reject(new Error(`Could not start "${cmd}": ${e.message}`));
    }

    // Abort: kill the child process immediately.
    function onAbort() {
      clearTimeout(timer);
      child.kill();
      cleanupCfg();
      reject(new DOMException('Aborted', 'AbortError'));
    }
    if (signal) {
      if (signal.aborted) { child.kill(); return reject(new DOMException('Aborted', 'AbortError')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // With write approvals in play the CLI legitimately pauses for the human
    // (broker auto-denies at 90s), so grant it a longer leash than plain runs.
    const cliTimeoutMs = mcpCfgPath ? 300000 : 120000;
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      child.kill();
      cleanupCfg();
      log('cli', `"${cmd}" TIMED OUT after ${cliTimeoutMs / 1000}s (stdout so far: ${out.length} chars)`);
      reject(new Error(`"${cmd}" timed out after ${cliTimeoutMs / 1000}s.`));
    }, cliTimeoutMs);

    child.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      cleanupCfg();
      reject(new Error(`Could not run "${cmd}": ${e.message}`));
    });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      cleanupCfg();
      if (signal?.aborted) return; // already rejected via onAbort
      log('cli', `exit code=${code} in ${Date.now() - t0}ms (stdout ${out.length}, stderr ${err.length} chars)`);
      // servedModel null: a CLI's model can't be server-attested from here —
      // whatever it says about itself is self-reported only.
      if (code === 0) resolve({ text: out.trim() || '(empty response)', servedModel: null });
      else {
        // Some CLIs (claude) print errors to stdout, not stderr — use both.
        const errText = err.trim() || out.trim();
        log('cli', `stderr: ${err.trim().slice(0, 200)} | stdout: ${out.trim().slice(0, 200)}`);
        reject(new Error(
          `${cliAuthHint(errText)}"${cmd}" exited with code ${code}. ${errText.slice(0, 300)}`,
        ));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function dispatchProvider(agent, messages, signal, onDelta) {
  switch (agent.provider) {
    case 'ollama':
      return callOllama(agent, messages, signal, onDelta);
    case 'openai':
      return callOpenAICompatible(agent, messages, signal, onDelta);
    case 'anthropic':
      return callAnthropic(agent, messages, signal, onDelta);
    case 'cli':
      // Deliberately no onDelta: CLI output is buffered until exit (Phase 1
      // spec — do not restructure the CLI provider path).
      return callCli(agent, messages, signal);
    default:
      throw new Error(`Unknown provider: ${agent.provider}`);
  }
}

// Hosted endpoints drop connections. DeepSeek is the reliable offender in
// practice — long reasoning pauses on a loaded API, and the socket goes away
// mid-stream. One retry, and only when the attempt produced no output at all,
// so a retry can never duplicate text the user already saw.
async function callAgent(agent, messages, signal, onDelta) {
  if (agent.provider === 'cli') return dispatchProvider(agent, messages, signal, onDelta);
  try {
    return await dispatchProvider(agent, messages, signal, onDelta);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    if (!isTransientNetworkError(err)) {
      // Not retryable, but still make it readable — this is the path that was
      // surfacing a bare "TypeError: terminated" to the user.
      throw Object.assign(new Error(describeFetchError(err)), { cause: err });
    }
    const why = describeFetchError(err);
    log('call', `${agent?.name ?? '?'}: ${why} — retrying once`);
    try {
      return await dispatchProvider(agent, messages, signal, onDelta);
    } catch (err2) {
      if (err2?.name === 'AbortError') throw err2;
      throw Object.assign(
        new Error(`${describeFetchError(err2)} (retried once after: ${why})`),
        { cause: err2 },
      );
    }
  }
}

// List installed Ollama models so the form can offer click-to-fill chips.
// Returns an array of model name strings, or throws with a clear message.
async function listOllamaModels(agent) {
  const base = (agent.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  let res;
  try {
    res = await fetch(`${base}/api/tags`);
  } catch (e) {
    throw new Error(`Can't reach Ollama at ${base} — is it running? (${e.message})`);
  }
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  return (data?.models || []).map((m) => m.name).filter(Boolean);
}

// Provider-aware model listing so the form can offer click-to-pick chips for
// every provider, not just Ollama. Uses each API's own models endpoint, so the
// list is live — never a hardcoded set that goes stale.
async function listModels(agent, signal) {
  if (agent.provider === 'ollama') return listOllamaModels(agent);

  if (agent.provider === 'openai') {
    const base = (agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {},
      signal: withTimeout(signal, 30000),
    });
    if (res.status === 401) throw new Error('API key missing or invalid — save or type a key first.');
    if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
    const data = await res.json();
    // Drop obvious non-chat models (embeddings, audio, image, legacy).
    const NON_CHAT =
      /(embed|whisper|tts|dall-e|moderation|audio|transcribe|realtime|image-|davinci|babbage|curie)/i;
    return (data?.data || [])
      .map((m) => m?.id)
      .filter((id) => id && !NON_CHAT.test(id))
      .sort();
  }

  if (agent.provider === 'anthropic') {
    const base = (agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const res = await fetch(`${base}/v1/models`, {
      headers: {
        'x-api-key': agent.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      signal: withTimeout(signal, 30000),
    });
    if (res.status === 401) throw new Error('API key missing or invalid — save or type a key first.');
    if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
    const data = await res.json();
    return (data?.data || []).map((m) => m?.id).filter(Boolean);
  }

  throw new Error('Model lists are not available for CLI agents — pass --model via Extra arguments instead.');
}

// Reachability-only connection test per provider. Confirms the endpoint is up
// and auth is accepted, WITHOUT invoking the model (no token cost). Returns
// { ok: true, detail } or { ok: false, detail }.
async function testConnection(agent) {
  try {
    if (agent.provider === 'cli') {
      const cmd = (agent.command || '').trim();
      if (!cmd) return { ok: false, detail: 'No command set.' };
      const resolved = resolveCommand(cmd);
      if (!resolved) {
        return {
          ok: false,
          detail: `"${cmd}" not found — click "Detect installed CLIs" or enter the full path to the executable.`,
        };
      }
      return { ok: true, detail: `Found: ${resolved}` };
    }

    if (agent.provider === 'ollama') {
      const models = await listOllamaModels(agent);
      if (agent.model && !models.includes(agent.model)) {
        return {
          ok: false,
          detail: `Ollama is up, but "${agent.model}" isn't installed. Installed: ${models.join(', ') || '(none)'}`,
        };
      }
      return { ok: true, detail: `Ollama reachable. ${models.length} model(s) installed.` };
    }

    if (agent.provider === 'openai') {
      const base = (agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
      const res = await fetch(`${base}/models`, {
        headers: agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {},
      });
      if (res.status === 401) return { ok: false, detail: 'API key missing or invalid.' };
      if (!res.ok) return { ok: false, detail: `${res.status}: ${await safeText(res)}` };
      return { ok: true, detail: 'Endpoint reachable and key accepted.' };
    }

    if (agent.provider === 'anthropic') {
      const base = (agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
      // /v1/models requires the key; a 200 means auth is good. No model call.
      const res = await fetch(`${base}/v1/models`, {
        headers: {
          'x-api-key': agent.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
      });
      if (res.status === 401) return { ok: false, detail: 'API key missing or invalid.' };
      if (!res.ok) return { ok: false, detail: `${res.status}: ${await safeText(res)}` };
      return { ok: true, detail: 'Endpoint reachable and key accepted.' };
    }

    return { ok: false, detail: `Unknown provider: ${agent.provider}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

module.exports = { callAgent, listOllamaModels, listModels, testConnection };
