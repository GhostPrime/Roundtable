// Provider adapters. Each takes an agent config + a message history and
// returns the assistant's reply text. Adding support for a new backend
// means adding one case here — the rest of the app stays the same.
//
// provider: 'ollama' | 'openai' | 'anthropic' | 'cli'
// messages: [{ role: 'user'|'assistant', content }]

const { spawn } = require('child_process');

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

async function callOllama(agent, messages) {
  const url = `${agent.baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = {
    model: agent.model,
    stream: false,
    messages: [
      ...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []),
      ...messages,
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  return data?.message?.content ?? '(empty response)';
}

async function callOpenAICompatible(agent, messages) {
  const url = `${agent.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: agent.model,
    messages: [
      ...(agent.systemPrompt ? [{ role: 'system', content: agent.systemPrompt }] : []),
      ...messages,
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI-compat ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '(empty response)';
}

async function callAnthropic(agent, messages) {
  const url = `${(agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const body = {
    model: agent.model,
    max_tokens: 1024,
    ...(agent.systemPrompt ? { system: agent.systemPrompt } : {}),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': agent.apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
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
  if (agent.systemPrompt) lines.push(`[System]: ${agent.systemPrompt}`, '');
  for (const m of messages) {
    const who = m.role === 'assistant' ? agent.name : '';
    lines.push(who ? `${who}: ${m.content}` : m.content);
  }
  lines.push('', `${agent.name}:`);
  return lines.join('\n');
}

function callCli(agent, messages) {
  return new Promise((resolve, reject) => {
    const cmd = (agent.command || '').trim();
    if (!cmd) return reject(new Error('No command set for this CLI agent.'));

    const extra = (agent.args || '').trim();
    const args = ['-p'];
    if (/claude/i.test(cmd)) args.push('--output-format', 'text');
    if (extra) args.push(...extra.split(/\s+/));

    const prompt = flattenForCli(agent, messages);
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { shell: true });
    } catch (e) {
      return reject(new Error(`Could not start "${cmd}": ${e.message}`));
    }

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`"${cmd}" timed out after 120s.`));
    }, 120000);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run "${cmd}": ${e.message}`));
    });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim() || '(empty response)');
      else reject(new Error(`"${cmd}" exited with code ${code}. ${err.trim().slice(0, 300)}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callAgent(agent, messages) {
  switch (agent.provider) {
    case 'ollama':
      return callOllama(agent, messages);
    case 'openai':
      return callOpenAICompatible(agent, messages);
    case 'anthropic':
      return callAnthropic(agent, messages);
    case 'cli':
      return callCli(agent, messages);
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
      return { ok: true, detail: `Will run "${cmd}" from your terminal login.` };
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
