// Provider adapters for mobile. Ported from electron/providers.js minus the
// CLI provider (no child processes on Android) and image attachments (v1 is
// text-only). All calls go through window.fetch, which Capacitor's HTTP
// plugin patches to native requests — so no CORS and LAN hosts (Ollama) work.

const HTTP_TIMEOUT_MS = 300000;

function withTimeout(signal) {
  const t = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function chatMessages(agent, messages, extraSystem) {
  const system = [agent.systemPrompt, extraSystem].filter(Boolean).join('\n\n');
  return { system, turns: messages.map((m) => ({ role: m.role, content: m.content })) };
}

async function callOllama(agent, messages, extraSystem, signal) {
  const url = `${(agent.baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/chat`;
  const { system, turns } = chatMessages(agent, messages, extraSystem);
  const body = {
    model: agent.model,
    stream: false,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  return { text: data?.message?.content ?? '(empty response)', servedModel: data?.model ?? null };
}

async function callOpenAICompatible(agent, messages, extraSystem, signal) {
  const url = `${(agent.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const { system, turns } = chatMessages(agent, messages, extraSystem);
  const body = {
    model: agent.model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns],
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
  return {
    text: data?.choices?.[0]?.message?.content ?? '(empty response)',
    servedModel: data?.model ?? null,
  };
}

async function callAnthropic(agent, messages, extraSystem, signal) {
  const url = `${(agent.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const { system, turns } = chatMessages(agent, messages, extraSystem);
  const body = {
    model: agent.model,
    max_tokens: Number(agent.maxTokens) > 0 ? Number(agent.maxTokens) : 4096,
    ...(system ? { system } : {}),
    messages: turns,
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
  return { text: data?.content?.[0]?.text ?? '(empty response)', servedModel: data?.model ?? null };
}

// extraSystem: app-level instructions (assistant action blocks, current date)
// kept separate from the user's own per-agent system prompt.
export async function callAgent(agent, messages, extraSystem, signal) {
  switch (agent.provider) {
    case 'ollama':
      return callOllama(agent, messages, extraSystem, signal);
    case 'openai':
      return callOpenAICompatible(agent, messages, extraSystem, signal);
    case 'anthropic':
      return callAnthropic(agent, messages, extraSystem, signal);
    default:
      throw new Error(`Unknown provider: ${agent.provider}`);
  }
}
