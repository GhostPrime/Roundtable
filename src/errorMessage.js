// src/errorMessage.js
// Turns a provider failure into something a person can act on.
//
// Every seat failure used to render as one line of whatever the provider,
// Node, or Electron happened to say:
//
//   ⚠️ claude error: Error invoking remote method 'agent:call': Error:
//   "C:\Users\GhostPrime\.local\bin\claude.exe" exited with code 1. Failed to
//   authenticate: OAuth session expired and could not be refreshed
//
// The fix is in there — run `claude` and log in again — but it is behind an
// IPC prefix, a Windows path, and an exit code. That is fine for the person
// who wrote the app and useless to everyone else.
//
// explainError() returns a plain sentence saying what happened plus a second
// saying what to do about it, and keeps the original text so nothing is lost.
//
// `title` is the collapsed one-line header, so it is kept SHORT and never
// names the seat — both surfaces print the speaker directly above it, and
// "Qwen 3.6 / Qwen 3.6 replied with nothing at all" reads like a stutter.
// `action` may name the seat freely; it is only read once opened.
// It is deliberately pure and JSX-free so scripts/check-error-message.js can
// run it under plain node — there is no bundler in this repo to compile JSX
// for tests (vite 8 ships rolldown, not esbuild).

// ---------------------------------------------------------------------------
// Recognising an error bubble
// ---------------------------------------------------------------------------
// All six construction sites (App.jsx runSeatTurn + five in orchestrator.js)
// build the same shape: `⚠️ ${agent.name} error: ${err.message}`.
const ERROR_LINE = /^⚠️\s*(.*?)\s+error:\s*([\s\S]*)$/;

// A seat can also just… say nothing. Ollama returns an empty message when a
// model spends its whole output budget on reasoning, and "(empty response)"
// told Phil nothing for a week of Qwen3.6 turns.
const EMPTY_REPLY = /^\(empty response\)$/i;

// Guard against a seat that merely TALKS about an error in prose. A real
// failure is one short blob from err.message: no blank lines, and short.
const MAX_ERROR_LEN = 2000;

// Electron wraps every rejected IPC call, and Node stringifies Error twice on
// the way through. None of it means anything to a reader.
function stripNoise(s) {
  let out = String(s == null ? '' : s).trim();
  for (let i = 0; i < 6; i += 1) {
    const before = out;
    out = out.replace(/^Error invoking remote method\s+'[^']*':\s*/i, '');
    out = out.replace(/^(?:Uncaught\s+)?(?:Error|TypeError):\s*/i, '');
    if (out === before) break;
  }
  return out.trim();
}

// Ollama nests the real complaint inside a JSON envelope.
function unwrap(body) {
  const m = body.match(/\{\s*"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return body;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

// "C:\Users\…\claude.exe" → claude
function prettyCommand(raw) {
  const base = String(raw).split(/[\\/]/).pop() || String(raw);
  return base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '');
}

function cliName(body) {
  const m =
    body.match(/(?:Could not (?:find|start|run))\s+"([^"]+)"/i) ||
    body.match(/"([^"]+)"\s*(?:exited with code|timed out)/i);
  return m ? prettyCommand(m[1]) : null;
}

// Ollama says: model "qwen3.6:35b-a3b" not found, try pulling it first
function modelName(body) {
  const m =
    body.match(/model\s+["'`]?([\w.:@/-]+)["'`]?\s+not found/i) ||
    body.match(/["'`]([\w.:@/-]+)["'`]\s+not found, try pulling/i);
  return m ? m[1] : null;
}

function httpStatus(body) {
  const m =
    body.match(/\b(?:Ollama|OpenAI-compat|Anthropic|HTTP)\s+(\d{3})\b/i) ||
    body.match(/^\s*(\d{3}):\s/) ||
    body.match(/\bstatus(?:\s+code)?[:\s]+(\d{3})\b/i);
  const n = m ? Number(m[1]) : 0;
  return n >= 400 && n <= 599 ? n : 0;
}

// ---------------------------------------------------------------------------
// Rules, most specific first. Each returns { title, action, command? }.
// `seat` is already a display name ("Qwen 3.8" / "this seat").
// ---------------------------------------------------------------------------
const RULES = [
  // ---- the user pressed Stop ----------------------------------------------
  {
    id: 'aborted',
    when: (b) => /\bAbortError\b|^Aborted\b/i.test(b),
    make: (b, seat) => ({
      title: 'Turn stopped',
      action: 'Nothing failed — the round was cancelled. Send again to pick it back up.',
    }),
  },

  // ---- command-line seats --------------------------------------------------
  {
    id: 'cli-missing',
    when: (b) => /Could not find\s+"[^"]+"\s+on this system/i.test(b),
    make: (b, seat) => ({
      title: `Can't find the ${cliName(b) || 'command-line'} program on this computer`,
      action:
        `${seat} runs a command-line AI, and that command isn't on this machine — or isn't ` +
        'somewhere Roundtable can see it. Edit this seat and click "Detect installed CLIs", ' +
        'or paste the full path to the program.',
    }),
  },
  {
    id: 'cli-no-command',
    when: (b) => /No command set for this CLI/i.test(b),
    make: (b, seat) => ({
      title: 'No command set for this seat',
      action:
        'This seat is set to use a command-line AI but the command field is empty. ' +
        'Edit the seat and either pick a detected CLI or enter the command yourself.',
    }),
  },
  {
    id: 'cli-gemini-auth',
    when: (b) => /GEMINI_API_KEY|GOOGLE_GENAI_USE|\bAuth method\b/i.test(b),
    make: (b, seat) => ({
      title: 'Not signed in to Gemini',
      action:
        'Open a terminal, run the command below, and choose "Login with Google". ' +
        'That is a one-time setup — then send this message again.',
      command: 'gemini',
    }),
  },
  {
    id: 'cli-auth',
    when: (b) =>
      /exited with code|Could not run|timed out after/i.test(b) &&
      /OAuth|Failed to authenticate|Not logged in|Please run \/login|session expired|credentials?\b.*expired|Invalid API key|unauthori[sz]ed/i.test(
        b,
      ),
    make: (b, seat) => {
      const cmd = cliName(b) || 'the CLI';
      return {
        title: 'Sign-in expired',
        action:
          `Roundtable signs in as you do — through ${cmd} itself, not an API key — and that ` +
          'login has run out. Open a terminal, run the command below, sign in again, then ' +
          'send this message again.',
        command: cliName(b) || null,
      };
    },
  },
  {
    id: 'cli-timeout',
    when: (b) => /"[^"]+"\s+timed out after\s+[\d.]+s/i.test(b),
    make: (b, seat) => {
      const secs = (b.match(/timed out after\s+([\d.]+)s/i) || [])[1];
      return {
        title: `No answer within ${secs || 'the time limit'} seconds`,
        action:
          'Either the model is genuinely slow on this machine, or the command is sitting ' +
          'waiting for something. Try again — and if it happens every time, run the command ' +
          'once in a terminal to see what it is waiting for.',
        command: cliName(b) || null,
      };
    },
  },
  {
    id: 'cli-start',
    when: (b) => /Could not (?:start|run)\s+"[^"]+"/i.test(b),
    make: (b, seat) => ({
      title: "The command wouldn't start",
      action:
        'The program is there but the computer refused to run it. That is usually a ' +
        'permissions problem or a broken install. Try running it once in a terminal.',
      command: cliName(b) || null,
    }),
  },
  {
    id: 'cli-exit',
    when: (b) => /exited with code\s+\d+/i.test(b),
    make: (b, seat) => {
      const code = (b.match(/exited with code\s+(\d+)/i) || [])[1];
      const cmd = cliName(b) || 'the command';
      // Everything after "exited with code N." is the CLI's own complaint.
      const tail = (b.split(/exited with code\s+\d+\.\s*/i)[1] || '').trim();
      return {
        title: `${cmd} stopped with an error${code ? ` (code ${code})` : ''}`,
        action: tail
          ? `${cmd} said: "${tail.slice(0, 220)}". Running it once in a terminal usually ` +
            'shows the problem more clearly.'
          : `${cmd} quit without explaining why. Running it once in a terminal usually ` +
            'shows the problem more clearly.',
      };
    },
  },

  // ---- local models --------------------------------------------------------
  {
    id: 'gpu-oom',
    when: (b) =>
      /llama-server process has terminated|CUDA error|cudaMalloc|hipMalloc|shared object initialization failed|0xc0000409|failed to allocate|out of memory|ggml_backend/i.test(
        b,
      ),
    make: (b, seat) => ({
      title: 'The model crashed while loading',
      action:
        'Ollama started the model and it died before answering. Nearly always this is too ' +
        "little video memory: close other programs using the graphics card, pick a smaller " +
        'model for this seat, or restart Ollama and try again.',
    }),
  },
  {
    id: 'model-missing',
    when: (b) => /not found, try pulling it first|model\s+["'`]?[\w.:@/-]+["'`]?\s+not found|no such model/i.test(b),
    make: (b, seat) => {
      const model = modelName(b);
      return {
        title: model
          ? `Ollama doesn't have "${model}" downloaded`
          : "Ollama doesn't have this seat's model downloaded",
        action: model
          ? 'Download it once with the command below, then send this message again.'
          : "Download the model with `ollama pull`, or pick one from this seat's model list.",
        command: model ? `ollama pull ${model}` : null,
      };
    },
  },
  {
    id: 'ollama-unreachable',
    when: (b) => /Can't reach Ollama at/i.test(b),
    make: (b, seat) => ({
      title: 'Ollama isn\'t running',
      action:
        `${seat} uses Ollama for its model, and nothing answered at that address. Start ` +
        'Ollama (the desktop app, or the command below) and try again.',
      command: 'ollama serve',
    }),
  },

  // ---- the network ---------------------------------------------------------
  {
    id: 'refused',
    when: (b) => /ECONNREFUSED/i.test(b),
    make: (b, seat) => {
      const m = b.match(/ECONNREFUSED\s+([\w.:-]+?):(\d+)/i);
      const where = m ? `${m[1]}:${m[2]}` : null;
      const isOllama = m && m[2] === '11434';
      return {
        title: where
          ? `Nothing is listening at ${where}`
          : 'The server refused the connection',
        action:
          `${seat} is set to talk to a server ${where ? `at ${where}` : 'on this machine'}, ` +
          'but nothing is running there. Start that server, or correct the address in this ' +
          "seat's settings.",
        command: isOllama ? 'ollama serve' : null,
      };
    },
  },
  {
    id: 'dns',
    when: (b) => /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(b),
    make: (b, seat) => {
      const host = (b.match(/(?:ENOTFOUND|getaddrinfo\s+\w+)\s+([\w.-]+)/i) || [])[1];
      return {
        title: host ? `The address "${host}" couldn't be found` : "The server address couldn't be found",
        action:
          "Check the server address in this seat's settings for a typo. If it looks right, " +
          'this computer may be offline or behind something blocking it.',
      };
    },
  },
  {
    id: 'net-timeout',
    when: (b) => /ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|ESOCKETTIMEDOUT/i.test(b),
    make: (b, seat) => ({
      title: "The server didn't respond in time",
      action:
        'The request was sent but nothing came back. The server may be overloaded or the ' +
        'model may be too slow for the time limit. Try again — a second attempt often works.',
    }),
  },
  {
    id: 'tls',
    when: (b) => /CERT_|DEPTH_ZERO|self[- ]signed certificate|unable to verify the first certificate|ERR_TLS/i.test(b),
    make: (b, seat) => ({
      title: "The security certificate wasn't accepted",
      action:
        'This is normal for a server you run yourself on your own network. If it is a ' +
        "service on the internet, do not ignore it — check the address in this seat's " +
        'settings is the one you meant.',
    }),
  },
  {
    id: 'dropped',
    when: (b) =>
      /ECONNRESET|EPIPE|socket hang up|other side closed|premature close|UND_ERR_SOCKET|\bterminated\b|fetch failed/i.test(
        b,
      ),
    make: (b, seat) => ({
      title: 'The connection dropped mid-answer',
      action:
        'The server closed the connection before finishing. If it is a local model, it may ' +
        'have run out of memory; if it is an online one, the network hiccuped. Try again.',
    }),
  },
];

// ---- HTTP status codes, handled together ----------------------------------
function fromStatus(status, body, seat) {
  if (status === 401) {
    return {
      title: 'API key rejected',
      action:
        "Open this seat's settings and re-enter the key. Keys are also rejected when they " +
        'have been rotated or deleted at the provider, so check it is still listed there.',
    };
  }
  if (status === 403) {
    return {
      title: 'The provider refused the request',
      action:
        'The key works but is not allowed to use this model. That usually means billing ' +
        "isn't set up, or the account doesn't have access to this particular model yet.",
    };
  }
  if (status === 404) {
    return {
      title: "The model wasn't found at that address",
      action:
        "Check the model name in this seat's settings — it has to match the provider's " +
        'spelling exactly. If the address is a custom server, check that too.',
    };
  }
  if (status === 429) {
    return {
      title: 'Rate limit reached',
      action:
        'Too many requests, or the account is out of credit. Wait a minute and try again — ' +
        "if it keeps happening, check the account's usage limits at the provider.",
    };
  }
  if (status === 413 || /context length|maximum context|too many tokens|token limit/i.test(body)) {
    return {
      title: 'The conversation is too long for this model',
      action:
        'This model can only read so much at once, and the table has outgrown it. Start a ' +
        'new session, prune some messages, or give this seat a model with more room.',
    };
  }
  if (status === 400) {
    return {
      title: 'The provider rejected the request',
      action:
        'Something in the request was not valid for this model — often an image sent to a ' +
        'model that cannot see, or a setting it does not support. The exact wording is below.',
    };
  }
  if (status >= 500) {
    return {
      title: 'The provider had a server error',
      action:
        'This one is not on your machine — the provider itself failed. Wait a moment and ' +
        'try again.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// explainError(text, seatName)
//   → null when `text` is not a failure
//   → { seat, title, action, command, raw, id } when it is
// ---------------------------------------------------------------------------
export function explainError(text, seatName) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;

  const fallbackSeat = String(seatName || '').trim() || 'This seat';

  // A seat that answered with nothing at all.
  if (EMPTY_REPLY.test(t)) {
    return {
      seat: fallbackSeat,
      id: 'empty',
      title: 'Replied with nothing at all',
      action:
        'The model finished its turn without writing an answer. Thinking models do this ' +
        'when they spend their whole reply on reasoning. Try again, and if it keeps ' +
        "happening give this seat a different model in its settings.",
      command: null,
      raw: t,
    };
  }

  if (!t.startsWith('⚠️')) return null;
  // Real failures are one blob from err.message — not prose about an error.
  if (t.length > MAX_ERROR_LEN || /\n\s*\n/.test(t)) return null;

  const m = t.match(ERROR_LINE);
  if (!m) return null;

  const seat = m[1].trim() || fallbackSeat;
  const raw = stripNoise(m[2]);
  if (!raw) return null;
  const body = unwrap(raw);

  // Roundtable retries transient network failures once on its own. Say so,
  // otherwise "try again" reads as advice already taken.
  const retried = /\(retried once after:/i.test(raw);

  let hit = null;
  for (const rule of RULES) {
    if (rule.when(body)) {
      hit = { id: rule.id, ...rule.make(body, seat) };
      break;
    }
  }

  if (!hit) {
    // Read the status off the ORIGINAL text: unwrap() drops the "Ollama 500:"
    // envelope on its way to the inner complaint.
    const status = httpStatus(raw) || httpStatus(body);
    const byStatus = status ? fromStatus(status, body, seat) : null;
    if (byStatus) hit = { id: `http-${status}`, ...byStatus };
  }

  if (!hit) {
    hit = {
      id: 'unknown',
      title: "Couldn't finish this turn",
      action:
        "Roundtable doesn't recognise this failure, so the provider's own words are below. " +
        'The ↻ button on this message runs the turn again.',
    };
  }

  return {
    seat,
    id: hit.id,
    title: hit.title,
    action: retried
      ? `${hit.action} Roundtable already retried this once automatically.`
      : hit.action,
    command: hit.command || null,
    raw,
  };
}

export default explainError;
