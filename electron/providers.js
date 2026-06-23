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

// HTTP calls get a hard cap so a stalled endpoint (Ollama mid-generation,
// dead network) surfaces as an error instead of hanging "…thinking" forever.
// Generous because big local models on CPU are genuinely slow.
const HTTP_TIMEOUT_MS = 300000; // 5 min

function withTimeout(signal, ms = HTTP_TIMEOUT_MS) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
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
  const hay = `${agent?.baseUrl || ''} ${agent?.model || ''}`.toLowerCase();
  if (hay.includes('deepseek')) return false;
  return true;
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

async function callOllama(agent, messages, signal) {
  const url = `${agent.baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = {
    model: agent.model,
    stream: false,
    messages: [
      ...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []),
      // Ollama vision format: images = array of raw base64 strings.
      ...messages.map((m) =>
        m.images?.length
          ? {
              role: m.role,
              content: m.content,
              images: m.images.map((u) => parseDataUrl(u)?.base64).filter(Boolean),
            }
          : { role: m.role, content: m.content },
      ),
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  return data?.message?.content ?? '(empty response)';
}

async function callOpenAICompatible(agent, messages, signal) {
  const url = `${agent.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const visionOk = openAICompatAcceptsImages(agent);
  const body = {
    model: agent.model,
    messages: [
      ...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []),
      ...messages.map((m) => {
        if (!m.images?.length) return { role: m.role, content: m.content };
        // Text-only endpoint (e.g. DeepSeek): drop the images so the request
        // doesn't 400, but note their presence so the seat can say it can't
        // see them instead of answering as if no image was ever attached.
        if (!visionOk) {
          const note = `[${m.images.length} image attachment(s) were omitted — this model can't receive images.]`;
          return { role: m.role, content: m.content ? `${m.content}\n\n${note}` : note };
        }
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
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '(empty response)';
}

async function callAnthropic(agent, messages, signal) {
  const url = `${(agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const body = {
    model: agent.model,
    max_tokens: 1024,
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
  const data = await res.json();
  return data?.content?.[0]?.text ?? '(empty response)';
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
      return reject(new Error(`Could not start "${cmd}": ${e.message}`));
    }

    // Abort: kill the child process immediately.
    function onAbort() {
      clearTimeout(timer);
      child.kill();
      reject(new DOMException('Aborted', 'AbortError'));
    }
    if (signal) {
      if (signal.aborted) { child.kill(); return reject(new DOMException('Aborted', 'AbortError')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      child.kill();
      log('cli', `"${cmd}" TIMED OUT after 120s (stdout so far: ${out.length} chars)`);
      reject(new Error(`"${cmd}" timed out after 120s.`));
    }, 120000);

    child.on('error', (e) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      reject(new Error(`Could not run "${cmd}": ${e.message}`));
    });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      if (signal?.aborted) return; // already rejected via onAbort
      log('cli', `exit code=${code} in ${Date.now() - t0}ms (stdout ${out.length}, stderr ${err.length} chars)`);
      if (code === 0) resolve(out.trim() || '(empty response)');
      else {
        const errText = err.trim();
        log('cli', `stderr: ${errText.slice(0, 200)}`);
        reject(new Error(
          `${cliAuthHint(errText)}"${cmd}" exited with code ${code}. ${errText.slice(0, 300)}`,
        ));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callAgent(agent, messages, signal) {
  switch (agent.provider) {
    case 'ollama':
      return callOllama(agent, messages, signal);
    case 'openai':
      return callOpenAICompatible(agent, messages, signal);
    case 'anthropic':
      return callAnthropic(agent, messages, signal);
    case 'cli':
      return callCli(agent, messages, signal);
    default:
      throw new Error(`Unknown provider: ${agent.provider}`);
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

module.exports = { callAgent, listOllamaModels, testConnection };
