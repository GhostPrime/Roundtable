// sessionHtml.js — the "share this conversation" export.
//
// Pure, parameterized, and deliberately JSX-FREE: no React state, no closure
// over App, no import that plain `node` can't parse. That last part is why
// markdown rendering is injected as `renderBody` instead of imported —
// this repo has no test runner and vite 8 ships rolldown rather than esbuild,
// so there is no bundler lying around to compile a JSX test with. App.jsx
// (which vite compiles anyway) supplies the real renderer:
//
//   renderBody: (text) => renderToStaticMarkup(<Markdown text={text} />)
//
// so the export renders through the SAME component the app draws with and
// can't drift from what you saw on screen. Markdown.jsx is SSR-safe: its only
// DOM access (the code-block Copy button) lives in an onClick that static
// rendering never fires.

// errorMessage.js is imported directly rather than injected: it is pure and
// JSX-free, so plain `node` parses it, and an exported transcript must explain
// a failed turn the same way the app does. An export is the copy that gets
// mailed to someone who was never at the table.
import { explainError } from './errorMessage.js';

// ---- HTML export ---------------------------------------------------------
// A self-contained single file: inline CSS, images already ride along as data
// URLs, no scripts. Bodies go through the SAME Markdown component the app
// renders with (renderToStaticMarkup), so the export can't drift from what
// you saw on screen and there is no second markdown parser to maintain.
// React escapes every interpolation, so model output can't inject markup.
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const EXPORT_CSS = `
:root{--bg:#fff;--fg:#1b1b1f;--muted:#6b6b78;--line:#e3e3ea;--panel:#f7f7fa;--accent:#4f6bed;
 --err:#c0344f;--errbg:#fff6f8;--errline:#f0c9d3;--errfg:#7d2138;--errmuted:#9d5c70}
@media(prefers-color-scheme:dark){:root{--bg:#1e1e24;--fg:#e6e6ec;--muted:#9a9aa8;--line:#34343f;--panel:#26262e;
 --err:#f58bac;--errbg:#211318;--errline:#6e3040;--errfg:#ffc4d6;--errmuted:#c58ba0}}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--fg);
 font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.meta{color:var(--muted);font-size:12px;margin-bottom:6px}
.seats{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 28px}
.seat{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);
 border:1px solid var(--line);border-radius:999px;padding:2px 9px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:0 0 auto}
h2{font-size:15px;margin:34px 0 14px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.msg{margin:0 0 18px;padding-left:12px;border-left:3px solid var(--line)}
.msg.user{border-left-color:var(--accent)}
.msg.poll{border-left-color:var(--accent);border-left-style:dashed}
/* A failed turn, explained and COLLAPSED — see explainError() in
   src/errorMessage.js. One headline row; the fix and the provider's exact
   wording open on click, same as in the app. */
.msg.errored{border-left-color:var(--err)}
.body.err{background:var(--errbg);border:1px solid var(--errline);border-radius:8px;
 padding:8px 12px}
.err-title{cursor:pointer;list-style:none;font-weight:600;font-size:13.5px;color:var(--errfg);
 display:flex;align-items:baseline;gap:6px}
.err-title::-webkit-details-marker{display:none}
.err-title::before{content:'▸';font-size:11px;opacity:.7}
.body.err[open]>.err-title::before{content:'▾'}
.body.err[open]>.err-title{margin-bottom:8px}
.err-body{display:flex;flex-direction:column;gap:7px}
.err-action{font-size:13px;line-height:1.5;color:var(--errfg);opacity:.88}
.err-cmd code{display:inline-block;font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
 background:var(--bg);border:1px solid var(--errline);border-radius:6px;padding:3px 8px;color:var(--errfg)}
.err-rawlabel{font-size:11px;color:var(--errmuted)}
.err-raw{margin:0;padding:8px 10px;background:var(--bg);border:1px solid var(--errline);
 border-radius:6px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
 color:var(--errmuted);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto}
.who{font-weight:600;font-size:13px;margin-bottom:4px;display:flex;align-items:center;gap:5px}
.badge{font-weight:400;font-size:10px;color:var(--muted);border:1px solid var(--line);
 border-radius:5px;padding:0 4px}
.sys{color:var(--muted);font-size:12.5px;font-style:italic;border-left-color:transparent}
.imgs img,.body img{max-width:100%;border-radius:8px;margin:6px 0}
details.tool{margin:0 0 18px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
details.tool summary{cursor:pointer;padding:7px 12px;font-size:12px;color:var(--muted)}
details.tool pre{margin:0;padding:0 12px 12px;white-space:pre-wrap;word-break:break-word;font-size:12px}
.stripped{color:var(--muted);font-size:12px;font-style:italic;margin:0 0 18px}
.tasks li{margin:3px 0}.tasks li.done{color:var(--muted);text-decoration:line-through}
.foot{margin-top:44px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}

/* Markdown.jsx emits its own class names rather than semantic tags, so these
   mirror the app's .md-* rules (styles.css). If Markdown.jsx grows a class and
   this block doesn't, check-session-html.js fails — that is the guard. */
.md-p{margin:0 0 8px}
.md-p:last-child,.md-list:last-child,.md-code:last-child,.md-quote:last-child{margin-bottom:0}
.md-h{font-weight:700;margin:14px 0 6px;line-height:1.3}
.md-h:first-child{margin-top:0}
.md-h1{font-size:19px}.md-h2{font-size:17px}.md-h3{font-size:15px}
.md-h4,.md-h5,.md-h6{font-size:14px}
.md-list{margin:0 0 8px;padding-left:22px}
.md-list li{margin:2px 0}
.md-quote{margin:0 0 8px;padding:2px 10px;border-left:3px solid var(--line);color:var(--muted)}
.md-hr{border:none;border-top:1px solid var(--line);margin:10px 0}
.body a{color:var(--accent)}
code.md-inline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;
 background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.md-code{margin:0 0 8px;border-radius:10px;overflow:hidden;background:#17171d;
 border:1px solid rgba(127,127,127,.3)}
.md-code-head{display:flex;align-items:center;padding:4px 10px;font-size:11px;color:#9a9aa8;
 background:rgba(255,255,255,.04);border-bottom:1px solid rgba(127,127,127,.2)}
.md-code-lang{text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.md-copy{display:none} /* the app's Copy button — inert in a static file */
.md-code pre{margin:0;padding:10px 12px;overflow-x:auto}
.md-code code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
 line-height:1.5;color:#d6d6e0;white-space:pre}
.md-tok-kw{color:#82aaff}.md-tok-str{color:#c3e88d}.md-tok-num{color:#f78c6c}
.md-tok-com{color:#7d8799;font-style:italic}
`.trim();

export function sessionHtml({
  sessionName,
  transcripts,
  agents = [],
  tasks = [],
  includeTools = true,
  now = new Date(),
  // (text) => html string. Falls back to escaped plain text so a caller that
  // omits it still gets a readable (if unformatted) file rather than a crash.
  renderBody = (text) => `<pre style="white-space:pre-wrap;margin:0">${esc(text)}</pre>`,
}) {
  const roster = agents.filter(Boolean);
  const seatOf = (id) => roster.find((a) => a.id === id);
  const out = [];
  const named = [...new Set(
    Object.values(transcripts).flat().map((e) => e.speaker)
      .filter((n) => n && n !== 'You' && n !== 'Tool' && n !== 'System'),
  )];

  out.push(`<h1>${esc(sessionName)}</h1>`);
  out.push(`<div class="meta">Exported ${esc(now.toLocaleString())} · Roundtable</div>`);
  if (named.length) {
    out.push('<div class="seats">' + named.map((n) => {
      const a = roster.find((x) => x.name === n);
      const d = a?.color ? `<span class="dot" style="background:${esc(a.color)}"></span>` : '';
      return `<span class="seat">${d}${esc(n)}</span>`;
    }).join('') + '</div>');
  }

  let strippedTools = 0;
  for (const [k, list] of Object.entries(transcripts)) {
    if (!list?.length) continue;
    out.push(`<h2>${k === 'group' ? 'Roundtable' : `Direct — ${esc(seatOf(k)?.name ?? k)}`}</h2>`);
    for (const m of list) {
      if (m.speaker === 'Tool') {
        if (!includeTools) { strippedTools += 1; continue; }
        const t = String(m.text ?? '');
        const nl = t.indexOf('\n');
        const head = nl > -1 ? t.slice(0, nl) : t;
        const body = nl > -1 ? t.slice(nl + 1) : '';
        out.push(
          `<details class="tool"><summary>${esc(head)}</summary><pre>${esc(body)}</pre></details>`,
        );
        continue;
      }
      if (m.speaker === 'System') {
        out.push(`<div class="msg sys">${esc(m.text)}</div>`);
        continue;
      }
      const isUser = m.speaker === 'You';
      // A failed turn is explained here exactly as it is on screen. null for
      // every ordinary answer, so nothing a seat really said gets replaced.
      const err = isUser ? null : explainError(m.text, m.speaker);
      const color = seatOf(m.agentId)?.color;
      const badges = [
        m.pollId ? `<span class="badge">⚌ poll ${(m.pollIndex ?? 0) + 1}/${m.pollTotal ?? '?'} · answered blind</span>` : '',
        m.breakoutTask ? `<span class="badge">↳ #${esc(m.breakoutTask)}</span>` : '',
        m.interjected ? '<span class="badge">mid-round</span>' : '',
      ].join('');
      const dot = color ? `<span class="dot" style="background:${esc(color)}"></span> ` : '';
      const imgs = m.images?.length
        ? `<div class="imgs">${m.images.map((src) => `<img src="${esc(src)}" alt="attached">`).join('')}</div>`
        : '';
      const files = m.attachments?.length
        ? `<div class="meta">📄 ${m.attachments.map((f) => esc(f.name)).join(', ')}</div>`
        : '';
      // Seat replies are markdown; your own messages are literal text; a
      // failure is a card, with the provider's exact words still inside it.
      // Collapsed, exactly as on screen: one headline, the fix and the raw
      // wording folded inside. A session with a dead seat in every round is
      // otherwise mostly error boxes.
      const body = err
        ? '<details class="body err">' +
            `<summary class="err-title">${esc(err.title)}</summary>` +
            '<div class="err-body">' +
            `<div class="err-action">${esc(err.action)}</div>` +
            (err.command ? `<div class="err-cmd"><code>${esc(err.command)}</code></div>` : '') +
            `<div class="err-rawlabel">What ${esc(err.seat)}'s provider actually said</div>` +
            `<pre class="err-raw">${esc(err.raw)}</pre>` +
            '</div>' +
          '</details>'
        : isUser
          ? `<div class="body"><pre style="white-space:pre-wrap;background:none;padding:0">${esc(m.text)}</pre></div>`
          : `<div class="body">${renderBody(m.text ?? '')}</div>`;
      out.push(
        `<div class="msg ${isUser ? 'user' : ''} ${m.pollId ? 'poll' : ''} ${err ? 'errored' : ''}">` +
          `<div class="who">${dot}${esc(m.speaker)}${badges}</div>${imgs}${files}${body}</div>`,
      );
    }
  }

  if (strippedTools) {
    out.push(`<p class="stripped">${strippedTools} tool result${strippedTools === 1 ? '' : 's'} (file contents, web fetches, integration calls) left out of this export.</p>`);
  }
  if (tasks.length) {
    out.push('<h2>Task board</h2><ul class="tasks">');
    for (const t of tasks) {
      out.push(`<li class="${t.done ? 'done' : ''}">#${esc(t.id)} ${esc(t.text)}${t.by ? ` <span class="badge">${esc(t.by)}</span>` : ''}</li>`);
    }
    out.push('</ul>');
  }
  out.push('<div class="foot">Generated by Roundtable — github.com/GhostPrime/Roundtable</div>');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(sessionName)} — Roundtable</title>
<style>${EXPORT_CSS}</style>
</head><body><div class="wrap">
${out.join('\n')}
</div></body></html>`;
}
