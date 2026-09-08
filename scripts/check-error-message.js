// scripts/check-error-message.js
// Guards src/errorMessage.js — the plain-English translation of provider
// failures.
//
// Why this file exists: every one of the four errors asserted below is one
// Phil actually hit in a single day's use, and every one of them rendered as a
// single unreadable line. The rule this suite enforces is not "we produce a
// message" but "we produce a message that names the fix". So each case asserts
// on the ACTIONABLE words — "sign in", "ollama pull", the host:port — not just
// that some string came back. A rewrite that keeps the shape and loses the
// advice fails here.
//
// The second half is the false-positive half, and it matters just as much: a
// seat that TALKS about an error must not have its answer replaced by an error
// card. That failure mode is silent and destroys real content.
//
// Run:  node --experimental-default-type=module scripts/check-error-message.js
import { explainError } from '../src/errorMessage.js';

const t = [];
const ok = (n, c) => t.push([c ? 'PASS' : 'FAIL', n]);
const has = (s, ...words) => words.every((w) => String(s || '').toLowerCase().includes(w.toLowerCase()));

// ===========================================================================
// 1. The four real failures from 2026-08-20, verbatim
// ===========================================================================

// ---- (a) Ollama loaded a model onto the GPU and it died --------------------
const gpu = explainError(
  '⚠️ Qemma error: Error invoking remote method \'agent:call\': Error: Ollama 500: ' +
  '{"error":"llama-server process has terminated: exit status 0xc0000409: The system ' +
  'detected an overrun of a stack-based buffer... CUDA error: shared object ' +
  'initialization failed"}',
);
ok('GPU crash is recognised', gpu !== null);
ok('…names the seat', gpu?.seat === 'Qemma');
ok('…title says the model crashed, not "0xc0000409"',
   has(gpu?.title, 'crashed') && !/0xc0000409|CUDA/i.test(gpu?.title || ''));
ok('…action points at video memory', has(gpu?.action, 'video memory'));
ok('…action offers a smaller model', has(gpu?.action, 'smaller model'));
ok('…the original text is kept', has(gpu?.raw, '0xc0000409'));
ok('…and the IPC wrapper is stripped from it',
   !/invoking remote method/i.test(gpu?.raw || ''));

// ---- (b) a thinking model that never wrote an answer -----------------------
const empty = explainError('(empty response)', 'Qwen 3.6');
ok('an empty reply is explained', empty !== null);
ok('…attributed to the seat', empty?.seat === 'Qwen 3.6');
ok('…and says why it happens', has(empty?.action, 'reasoning'));
ok('…without demanding the ⚠️ prefix', empty?.id === 'empty');
ok('an empty reply with no seat name still reads', explainError('(empty response)')?.seat === 'This seat');

// ---- (c) nothing listening on the seat's port ------------------------------
const refused = explainError(
  '⚠️ Qwen 3.8 error: fetch failed ← connect ECONNREFUSED 127.0.0.1:8888 ← ECONNREFUSED ' +
  '(retried once after: fetch failed ← connect ECONNREFUSED 127.0.0.1:8888 ← ECONNREFUSED)',
);
ok('a refused connection is recognised', refused !== null);
ok('…and it is the REFUSAL, not the generic "fetch failed", that wins',
   refused?.id === 'refused');
ok('…title names the exact address', has(refused?.title, '127.0.0.1:8888'));
ok('…action says to start the server', has(refused?.action, 'nothing is running there'));
ok('…action points at the seat\'s settings', has(refused?.action, 'settings'));
ok('…and admits Roundtable already retried', has(refused?.action, 'already retried'));
ok('a non-retried failure does not claim a retry',
   !has(explainError('⚠️ X error: connect ECONNREFUSED 1.2.3.4:99')?.action, 'already retried'));

// The default Ollama port gets the exact command to run.
const ollamaPort = explainError('⚠️ Gemma error: fetch failed ← connect ECONNREFUSED 127.0.0.1:11434 ← ECONNREFUSED');
ok('port 11434 offers the ollama command', ollamaPort?.command === 'ollama serve');
ok('a custom port offers no command to run', refused?.command === null);

// ---- (d) the CLI seat's terminal login expired -----------------------------
const oauth = explainError(
  '⚠️ claude error: Error invoking remote method \'agent:call\': Error: ' +
  '"C:\\Users\\GhostPrime\\.local\\bin\\claude.exe" exited with code 1. ' +
  'Failed to authenticate: OAuth session expired and could not be refreshed',
);
ok('an expired CLI login is recognised', oauth !== null);
ok('…as sign-in, not as a generic exit code', oauth?.id === 'cli-auth');
ok('…title says the sign-in expired', has(oauth?.title, 'sign-in expired'));
ok('…title has no exit code or Windows path in it',
   !/code 1|C:\\|\.exe/i.test(oauth?.title || ''));
ok('…action explains there is no API key to fix', has(oauth?.action, 'not an api key'));
ok('…and hands over the exact command', oauth?.command === 'claude');
ok('…with the .exe and the path stripped off it', !/\\|\.exe/.test(oauth?.command || ''));

// ===========================================================================
// 2. False positives — a seat TALKING about failure keeps its answer
// ===========================================================================
ok('ordinary prose is not an error', explainError('Here is what I think we should do next.') === null);
ok('empty text is not an error', explainError('') === null);
ok('null is not an error', explainError(null) === null);
ok('undefined is not an error', explainError(undefined) === null);
ok('prose merely containing "error:" is not an error',
   explainError('The log line reads error: connection refused, which suggests…') === null);
ok('a ⚠️ line that is not a seat failure is left alone',
   explainError('⚠️ Mission mode needs a Planner — set a seat\'s role to Planner.') === null);
ok('a multi-paragraph answer that opens with ⚠️ is left alone',
   explainError('⚠️ Build error: the thing failed.\n\nHere is my full analysis of why, at length.') === null);
ok('a very long ⚠️ block is left alone',
   explainError(`⚠️ X error: ${'y'.repeat(2100)}`) === null);
ok('a ⚠️ line with nothing after "error:" is left alone', explainError('⚠️ Qwen error:   ') === null);
ok('a bare "(empty response)" inside a longer answer is not an error',
   explainError('The tool gave me (empty response) so I moved on.') === null);

// ===========================================================================
// 3. The rest of the failure surface
// ===========================================================================
const E = (msg, seat = 'Seat') => explainError(`⚠️ ${seat} error: ${msg}`);

// ---- command-line seats ----------------------------------------------------
const missing = E('Could not find "qwen" on this system. Edit this AI and click "Detect installed CLIs", or enter the full path to the executable.');
ok('a missing CLI is recognised', missing?.id === 'cli-missing');
ok('…names the program', has(missing?.title, 'qwen'));
ok('…and points at Detect installed CLIs', has(missing?.action, 'detect installed clis'));

ok('an unset CLI command is recognised', E('No command set for this CLI agent.')?.id === 'cli-no-command');
ok('…and says the field is empty', has(E('No command set for this CLI agent.')?.action, 'command field is empty'));

const gem = E('Gemini isn\'t signed in yet — open a terminal, run "gemini" once, and choose "Login with Google" (one-time setup). "gemini" exited with code 1. GEMINI_API_KEY not set');
ok('the Gemini auth state is recognised', gem?.id === 'cli-gemini-auth');
ok('…and hands over the gemini command', gem?.command === 'gemini');

const to = E('"claude" timed out after 120s.');
ok('a CLI timeout is recognised', to?.id === 'cli-timeout');
ok('…and names the number of seconds', has(to?.title, '120'));

ok('a failed spawn is recognised', E('Could not start "qwen": EACCES')?.id === 'cli-start');
ok('a plain non-zero exit is recognised', E('"qwen" exited with code 2. Model refused the request')?.id === 'cli-exit');
ok('…and quotes what the CLI actually said',
   has(E('"qwen" exited with code 2. Model refused the request')?.action, 'Model refused the request'));

// ---- local models ----------------------------------------------------------
const pull = E('Ollama 404: model "qwen3.6:35b-a3b" not found, try pulling it first');
ok('a missing model is recognised', pull?.id === 'model-missing');
ok('…names the model', has(pull?.title, 'qwen3.6:35b-a3b'));
ok('…and gives the exact pull command', pull?.command === 'ollama pull qwen3.6:35b-a3b');
ok('…rather than falling through to the 404 rule', pull?.id !== 'http-404');

const noOllama = E('Can\'t reach Ollama at http://localhost:11434 — is it running? (fetch failed)');
ok('a dead Ollama is recognised', noOllama?.id === 'ollama-unreachable');
ok('…and offers the start command', noOllama?.command === 'ollama serve');

// ---- network ---------------------------------------------------------------
const dns = E('fetch failed ← getaddrinfo ENOTFOUND api.exampl.com ← ENOTFOUND');
ok('a bad hostname is recognised', dns?.id === 'dns');
ok('…names the host', has(dns?.title, 'api.exampl.com'));
ok('…and suggests a typo before blaming the network', has(dns?.action, 'typo'));

ok('a connect timeout is recognised', E('fetch failed ← UND_ERR_CONNECT_TIMEOUT')?.id === 'net-timeout');
ok('a dropped socket is recognised', E('terminated ← other side closed ← UND_ERR_SOCKET')?.id === 'dropped');
ok('a bare "fetch failed" is recognised', E('fetch failed')?.id === 'dropped');
ok('a self-signed certificate is recognised', E('fetch failed ← self-signed certificate ← DEPTH_ZERO_SELF_SIGNED_CERT')?.id === 'tls');
ok('…and does NOT tell the user to ignore it for internet servers',
   has(E('fetch failed ← DEPTH_ZERO_SELF_SIGNED_CERT')?.action, 'do not ignore'));

// ---- HTTP ------------------------------------------------------------------
ok('401 is about the key', E('Anthropic 401: {"error":{"message":"invalid x-api-key"}}')?.id === 'http-401');
ok('…and says to re-enter it', has(E('Anthropic 401: invalid x-api-key')?.action, 're-enter the key'));
ok('403 is about permission', E('OpenAI-compat 403: forbidden')?.id === 'http-403');
ok('…and mentions billing', has(E('OpenAI-compat 403: forbidden')?.action, 'billing'));
ok('404 is about the model name', E('OpenAI-compat 404: model not available')?.id === 'http-404');
ok('429 is about rate limits', E('Anthropic 429: rate_limit_error')?.id === 'http-429');
ok('…and says to wait', has(E('Anthropic 429: rate_limit_error')?.action, 'wait a minute'));
ok('500 is blamed on the provider, not the user',
   has(E('OpenAI-compat 502: bad gateway')?.action, 'not on your machine'));
ok('a status inside a JSON envelope is still read',
   E('Ollama 503: {"error":"server busy"}')?.id === 'http-503');
// A 400 that is really "you sent too much" must read as too much, not as a
// generic bad request — the fix (prune the table) is completely different.
const long = E('OpenAI-compat 400: This model\'s maximum context length is 8192 tokens');
ok('a context-length rejection reads as too long', has(long?.title, 'too long'));
ok('…and says how to shorten it', has(long?.action, 'prune'));
ok('a plain 400 stays a plain 400', E('OpenAI-compat 400: bad request')?.id === 'http-400');

// ---- stop ------------------------------------------------------------------
const stopped = E('AbortError: The operation was aborted');
ok('a user-cancelled turn is not framed as a fault', has(stopped?.action, 'nothing failed'));

// ---- the fallback ----------------------------------------------------------
const unknown = E('flurbulated the widget mainframe');
ok('an unrecognised failure still produces a card', unknown !== null);
ok('…and admits it does not know', has(unknown?.action, 'doesn\'t recognise'));
ok('…points at the retry button', has(unknown?.action, '↻'));
ok('…and keeps the original wording', has(unknown?.raw, 'flurbulated'));

// ===========================================================================
// 4. Shape — the renderer depends on all of this
// ===========================================================================
const samples = [gpu, empty, refused, oauth, missing, pull, dns, unknown, stopped];
ok('every result carries a seat', samples.every((r) => typeof r?.seat === 'string' && r.seat.length));
ok('every result carries a title', samples.every((r) => typeof r?.title === 'string' && r.title.length));
ok('every result carries an action', samples.every((r) => typeof r?.action === 'string' && r.action.length));
ok('every result carries the raw text', samples.every((r) => typeof r?.raw === 'string' && r.raw.length));
ok('command is a string or null, never undefined',
   samples.every((r) => r.command === null || typeof r.command === 'string'));
ok('no title ends in a full stop', samples.every((r) => !/\.$/.test(r.title)));
// The title IS the collapsed header — one short line, and never the seat
// name a second time. Both surfaces print the speaker immediately above it.
ok('every title fits on one line', samples.every((r) => r.title.length <= 64));
ok('no title repeats the seat name',
   samples.every((r) => !r.title.toLowerCase().includes(r.seat.toLowerCase())));
ok('…including the possessive form',
   samples.every((r) => !new RegExp(`\\b${r.seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'s\\b`, 'i').test(r.title)));
ok('every action still carries the whole fix', samples.every((r) => r.action.length >= 40));
ok('every action is a real sentence', samples.every((r) => /[.!]$/.test(r.action.trim())));
ok('no message leaks the IPC wrapper',
   samples.every((r) => !/invoking remote method/i.test(`${r.title} ${r.action}`)));
ok('no message leaks a raw error code into the title',
   samples.every((r) => !/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR|CUDA|0x[0-9a-f]{4}/i.test(r.title)));

for (const [r, n] of t) console.log(`${r}  ${n}`);
const f = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - f}/${t.length} passed`);
process.exit(f ? 1 : 0);
