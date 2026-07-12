// Check executor. Runs in the Electron main process — the only place with real
// filesystem access. All ops are path-locked to the project root via safeResolve
// so a seat can never escape the folder the user designated.
//
// Read ops (read_file, list_dir, exists) are always available.
// Write op (write_file) requires the calling agent to have canWrite: true. This
// is enforced here in the executor — not just in the prompt — so it cannot be
// bypassed by a clever model response.
//
// Web ops (web_search, fetch_url) are read-only network access (Phase 3):
// keyless DuckDuckGo by default so every user has search with zero setup;
// Tavily is used instead when opts.tavilyKey is provided. fetch_url is SSRF-
// guarded — https/http only, private/loopback hosts refused.
//
// There is deliberately NO command execution. The capability boundary lives at
// this executor, not at the prompt.

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024; // don't dump huge files into the transcript
const MAX_DIR_ENTRIES = 200;
const WEB_TIMEOUT_MS = 15000;
const MAX_PAGE_CHARS = 12000; // page text folded into the transcript
const MAX_RESULTS = 6;

// Resolve a user/model-supplied path against the project root and refuse
// anything that escapes it (absolute paths elsewhere, ../ traversal, symlink
// games). Returns the safe absolute path or throws.
//
// Two layers, both required:
//   1. Lexical: path.resolve + path.relative catches ../ and absolute paths,
//      but is purely textual — it does NOT follow symlinks.
//   2. Physical: realpath the nearest EXISTING ancestor of the target (the
//      target itself may not exist yet for write_file) and confirm it still
//      lives under the realpathed root. This is what actually stops a symlink
//      inside the project from pointing the op outside it.
function safeResolve(root, rel) {
  const cleanRoot = path.resolve(root);
  const target = path.resolve(cleanRoot, rel || '.');
  const relCheck = path.relative(cleanRoot, target);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`path "${rel}" is outside the project folder`);
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(cleanRoot);
  } catch {
    realRoot = cleanRoot; // root itself missing — later ops will surface ENOENT
  }
  // Walk up to the nearest existing ancestor (terminates at the drive root).
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realProbe;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    realProbe = probe;
  }
  const relReal = path.relative(realRoot, realProbe);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
    throw new Error(`path "${rel}" resolves outside the project folder (symlink)`);
  }
  return target;
}

function readFile(root, rel) {
  const p = safeResolve(root, rel);
  const stat = fs.statSync(p); // throws ENOENT if missing — real error
  if (stat.isDirectory()) throw new Error(`"${rel}" is a directory, not a file`);
  if (stat.size > MAX_FILE_BYTES) {
    const buf = fs.readFileSync(p, { encoding: 'utf8' }).slice(0, MAX_FILE_BYTES);
    return `${buf}\n\n…[truncated at ${MAX_FILE_BYTES} bytes of ${stat.size}]`;
  }
  return fs.readFileSync(p, 'utf8');
}

function listDir(root, rel) {
  const p = safeResolve(root, rel);
  const entries = fs.readdirSync(p, { withFileTypes: true });
  const lines = entries
    .slice(0, MAX_DIR_ENTRIES)
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const extra = entries.length > MAX_DIR_ENTRIES ? `\n…[+${entries.length - MAX_DIR_ENTRIES} more]` : '';
  return lines.join('\n') + extra;
}

function exists(root, rel) {
  const p = safeResolve(root, rel);
  return fs.existsSync(p) ? 'true' : 'false';
}

// Write a file. Only allowed when canWrite is true. Creates intermediate
// directories as needed. Content must be a string.
function writeFile(root, rel, content) {
  if (content === undefined || content === null) throw new Error('write_file requires content');
  const p = safeResolve(root, rel);
  // Never allow writing directories — rel must end in a filename.
  if (rel.endsWith('/') || rel.endsWith('\\')) {
    throw new Error(`"${rel}" looks like a directory — provide a file path`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content), 'utf8');
  return `wrote ${rel} (${Buffer.byteLength(String(content), 'utf8')} bytes)`;
}

// ---- Web ops (Phase 3) -------------------------------------------------------

// Refuse URLs that could point the app at itself or the local network. This is
// a desktop app, not a server, but seats consume untrusted model output — a
// prompt-injected page shouldn't be able to probe localhost services.
function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error(`"${raw}" is not a valid URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`only http(s) URLs are allowed, got "${u.protocol}"`);
  }
  const host = u.hostname.toLowerCase();
  const priv =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '[::1]' || host === '::1' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (priv) throw new Error(`refusing to fetch private/loopback host "${host}"`);
  return u;
}

async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WEB_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Roundtable/1.0',
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`request timed out after ${WEB_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Minimal HTML → readable text. No DOM dependency: strip non-content blocks,
// turn tags into whitespace, decode the common entities, collapse runs.
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function capText(text, cap = MAX_PAGE_CHARS) {
  const s = String(text);
  return s.length > cap ? `${s.slice(0, cap)}\n\n…[truncated at ${cap} of ${s.length} chars]` : s;
}

async function fetchUrl(rawUrl) {
  const u = assertPublicHttpUrl(rawUrl);
  const res = await fetchWithTimeout(u.href);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} for ${u.href}`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const body = await res.text();
  if (type.includes('html')) return capText(`[${u.href}]\n${htmlToText(body)}`);
  if (type.includes('json') || type.includes('text') || type.includes('xml') || type === '') {
    return capText(`[${u.href}]\n${body}`);
  }
  throw new Error(`unsupported content-type "${type}" — fetch_url reads text/HTML/JSON pages`);
}

// Keyless default: DuckDuckGo's HTML endpoint. Fragile by nature (markup can
// change), so parsing is defensive and failure surfaces as a real error the
// seat can see. Result links are DDG redirects carrying the target in uddg=.
async function ddgSearch(query) {
  const res = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status} from DuckDuckGo`);
  const html = await res.text();
  const out = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let m;
  while ((m = snipRe.exec(html)) !== null) snippets.push(htmlToText(m[1]));
  while ((m = linkRe.exec(html)) !== null && out.length < MAX_RESULTS) {
    let href = m[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (/duckduckgo\.com/.test(href)) continue; // ads/internal
    out.push({ title: htmlToText(m[2]), url: href, snippet: snippets[out.length] || '' });
  }
  if (out.length === 0) {
    throw new Error('search returned no parseable results (DuckDuckGo may have changed markup or rate-limited; try again or use fetch_url with a known site)');
  }
  return out
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n');
}

// Optional upgrade: Tavily (LLM-ready extracts) when a key is configured.
async function tavilySearch(query, key) {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: MAX_RESULTS, include_answer: true }),
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status} from Tavily`);
  const data = await res.json();
  const lines = [];
  if (data.answer) lines.push(`Answer: ${data.answer}`, '');
  for (const [i, r] of (data.results || []).entries()) {
    lines.push(`${i + 1}. ${r.title}\n   ${r.url}\n   ${capText(r.content || '', 400)}`);
  }
  if (lines.length === 0) throw new Error('search returned no results');
  return lines.join('\n');
}

async function webSearch(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('web_search needs a query');
  const text = opts.tavilyKey ? await tavilySearch(q, opts.tavilyKey) : await ddgSearch(q);
  return `Results for "${q}"${opts.tavilyKey ? ' (Tavily)' : ' (DuckDuckGo)'}:\n${text}`;
}

// Dispatch a parsed check request. Always returns { ok, output } — errors are
// returned as real text (e.g. "file not found") so the seat sees the truth
// rather than the call silently failing.
// opts.canWrite must be explicitly true to allow write_file.
// opts.tavilyKey (optional) upgrades web_search from DuckDuckGo to Tavily.
// File ops need `root`; web ops ignore it (they work with no project selected).
async function runCheck(root, req, opts = {}) {
  try {
    const { op, arg, content } = req || {};
    let output;
    switch (op) {
      case 'read_file': output = readFile(root, arg); break;
      case 'list_dir':  output = listDir(root, arg);  break;
      case 'exists':    output = exists(root, arg);   break;
      case 'write_file':
        if (!opts.canWrite) {
          throw new Error('write permission denied — this agent does not have write access to the project folder');
        }
        output = writeFile(root, arg, content);
        break;
      case 'web_search': output = await webSearch(arg, opts); break;
      case 'fetch_url':  output = await fetchUrl(arg); break;
      default: throw new Error(`unknown check "${op}" (use read_file | list_dir | exists | write_file | web_search | fetch_url)`);
    }
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

const WEB_OPS = new Set(['web_search', 'fetch_url']);

module.exports = { runCheck, WEB_OPS };
