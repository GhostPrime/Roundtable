// Dependency-free markdown → React elements for chat bubbles.
//
// Why hand-rolled: adding react-markdown/highlight.js would need an npm
// install + lockfile update (breaks CI's `npm ci` if out of sync), and this
// stays trivially CSP-safe. Everything renders as React elements — there is
// deliberately NO innerHTML anywhere, so untrusted model output can never
// inject markup. Unrecognized syntax falls through as plain text.
//
// Scope (what chat models actually emit): headings, bullet/numbered lists,
// blockquotes, horizontal rules, fenced code with light syntax highlighting
// + a Copy button, inline code / bold / italic / strikethrough, https links.
import { useState } from 'react';

// ---------- syntax highlighting (fenced code) --------------------------------

// One keyword union across common languages — good enough for chat display.
const KEYWORDS = new Set(
  (
    'function const let var return if else for while do class import export from new await async ' +
    'try catch finally throw switch case default break continue typeof instanceof in of this super ' +
    'extends static get set delete void yield null undefined true false ' +
    'def elif lambda pass None True False and or not with as raise except global nonlocal ' +
    'fn pub struct enum impl trait match mut use mod crate where loop ' +
    'package func go chan interface type map range defer select ' +
    'public private protected abstract final int float double long short byte char bool boolean string'
  ).split(/\s+/),
);

const HASH_LANGS = /^(py|python|sh|bash|zsh|shell|rb|ruby|yaml|yml|toml|r|perl|pl|makefile|dockerfile|cmake|ini|conf)$/;
const SLASH_LANGS = /^(js|jsx|ts|tsx|javascript|typescript|json|jsonc|json5|java|kt|kotlin|c|h|cpp|cc|hpp|cs|go|rs|rust|swift|dart|php|scala|css|scss|less)$/;

function commentSrc(lang) {
  const l = (lang || '').toLowerCase();
  const slash = '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const hash = '#[^\\n]*';
  if (SLASH_LANGS.test(l)) return slash;
  if (HASH_LANGS.test(l)) return hash;
  if (l === 'html' || l === 'xml' || l === 'svg') return '<!--[\\s\\S]*?-->';
  return `${slash}|${hash}`; // unknown language — best effort
}

export function highlightCode(code, lang) {
  const re = new RegExp(
    `(${commentSrc(lang)})` +
      `|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)` +
      '|\\b(0x[\\da-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b' +
      '|\\b([A-Za-z_][A-Za-z0-9_]*)\\b',
    'g',
  );
  const out = [];
  let last = 0;
  let k = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1] != null) out.push(<span key={k++} className="md-tok-com">{m[1]}</span>);
    else if (m[2] != null) out.push(<span key={k++} className="md-tok-str">{m[2]}</span>);
    else if (m[3] != null) out.push(<span key={k++} className="md-tok-num">{m[3]}</span>);
    else if (m[4] != null) {
      if (KEYWORDS.has(m[4])) out.push(<span key={k++} className="md-tok-kw">{m[4]}</span>);
      else out.push(m[4]);
    }
    last = re.lastIndex;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

// Clipboard with the same execCommand fallback ScriptsPanel uses (Electron
// file:// can reject navigator.clipboard).
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    resolve();
  });
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'code'}</span>
        <button
          type="button"
          className="md-copy"
          onClick={() =>
            copyText(code)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {})
          }
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{highlightCode(code, lang)}</code>
      </pre>
    </div>
  );
}

// ---------- inline markdown ---------------------------------------------------

// Bold/italic require non-space content edges (so "2 * 3 * 4" stays plain);
// _underscore_ needs word boundaries (so snake_case identifiers stay plain).
// The regex literal is inside the function on purpose: renderInline recurses,
// and a shared module-level /g regex would clobber its own lastIndex.
function renderInline(text, depth = 0) {
  if (!text) return [];
  if (depth > 2) return [text];
  const re =
    /(`[^`\n]+`)|(\*\*\S(?:[^*\n]*?\S)?\*\*)|(__\S(?:[^_\n]*?\S)?__)|(\*\S(?:[^*\n]*?\S)?\*)|(\b_\S(?:[^_\n]*?\S)?_\b)|(~~\S(?:[^~\n]*?\S)?~~)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  const out = [];
  let last = 0;
  let k = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={k++} className="md-inline">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{renderInline(m[2].slice(2, -2), depth + 1)}</strong>);
    else if (m[3]) out.push(<strong key={k++}>{renderInline(m[3].slice(2, -2), depth + 1)}</strong>);
    else if (m[4]) out.push(<em key={k++}>{renderInline(m[4].slice(1, -1), depth + 1)}</em>);
    else if (m[5]) out.push(<em key={k++}>{renderInline(m[5].slice(1, -1), depth + 1)}</em>);
    else if (m[6]) out.push(<del key={k++}>{m[6].slice(2, -2)}</del>);
    else if (m[7]) {
      const lm = m[7].match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      // main.js's setWindowOpenHandler denies in-app navigation and sends
      // https links to the OS browser, so target=_blank is safe here.
      out.push(
        <a key={k++} href={lm[2]} target="_blank" rel="noopener noreferrer">
          {lm[1]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- block parsing -----------------------------------------------------

const LIST_RE = /^(\s*)([-*•]|\d{1,3}[.)])\s+(.+)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

function parseBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = (line.match(/^\s*```\s*([\w.+-]*)/)?.[1] || '').trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run off the end — unterminated fence)
      blocks.push({ type: 'code', lang, code: buf.join('\n').replace(/\s+$/, '') });
      continue;
    }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.+)$/))) {
      blocks.push({ type: 'h', level: m[1].length, text: m[2] });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: buf });
      continue;
    }

    if ((m = line.match(LIST_RE))) {
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length && (m = lines[i].match(LIST_RE))) {
        items.push({ depth: Math.min(2, Math.floor(m[1].length / 2)), text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph: consume until a blank line or a recognized block start.
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !HR_RE.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', lines: buf });
  }
  return blocks;
}

// ---------- component ----------------------------------------------------------

export default function Markdown({ text }) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'code') return <CodeBlock key={i} lang={b.lang} code={b.code} />;
        if (b.type === 'h')
          return (
            <div key={i} className={`md-h md-h${b.level}`}>
              {renderInline(b.text)}
            </div>
          );
        if (b.type === 'hr') return <hr key={i} className="md-hr" />;
        if (b.type === 'quote')
          return (
            <blockquote key={i} className="md-quote">
              {b.lines.map((l, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  {renderInline(l)}
                </span>
              ))}
            </blockquote>
          );
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className="md-list">
              {b.items.map((it, j) => (
                <li key={j} style={it.depth ? { marginLeft: it.depth * 14 } : undefined}>
                  {renderInline(it.text)}
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i} className="md-p">
            {b.lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {renderInline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}
