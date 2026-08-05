// Shared language ↔ extension table. Lifted verbatim out of ScriptsPanel.jsx
// so the editor panel can derive a syntax language from a file path without
// duplicating the table (the two would drift). ScriptsPanel imports these
// back; its behaviour is unchanged.

// Map a fenced-block language hint to a sensible download filename extension.
export const LANG_EXT = {
  js: 'js', javascript: 'js', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx',
  py: 'py', python: 'py', rb: 'rb', ruby: 'rb', go: 'go', rust: 'rs', rs: 'rs',
  java: 'java', c: 'c', cpp: 'cpp', cs: 'cs', php: 'php', sh: 'sh', bash: 'sh',
  html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yml', sql: 'sql',
  md: 'md', markdown: 'md',
};
// The same table inverted — extension → language, for highlighting the
// "written to project" cards. Built from LANG_EXT so the two can't drift.
export const EXT_LANG = Object.entries(LANG_EXT).reduce((acc, [lang, ext]) => {
  if (!(ext in acc)) acc[ext] = lang;
  return acc;
}, {});

export const extOf = (p) => (String(p ?? '').match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();
export const langOfPath = (p) => EXT_LANG[extOf(p)] || '';

// Shebang interpreter → language, for the first sniff rule below.
const SHEBANG_LANG = {
  python: 'python', python2: 'python', python3: 'python',
  node: 'javascript', deno: 'javascript', bun: 'javascript',
  ruby: 'ruby', bash: 'bash', sh: 'bash', zsh: 'bash',
  perl: 'perl', php: 'php',
};

// Ordered, deliberately cheap heuristics for fenced blocks the seat left
// untagged (```​ with no hint) — the common case behind a wall of "TEXT" chips
// in the scripts panel. First rule that matches wins; 'text' when nothing does.
// Pure string work: no DOM, no React, safe to unit-test on its own.
const SNIFF_RULES = [
  // Python before JavaScript, but only on shapes JS can't produce: a `def`
  // header, or a bare `import x` / `from x import y` with no quotes or
  // semicolon (which is what an ES module import would carry).
  [/^\s*def\s+\w+\s*\(|^\s*class\s+\w[\w.]*\s*(\([^)]*\))?\s*:\s*$|^\s*(from\s+[\w.]+\s+)?import\s+[\w.,\s*]+$/m, 'python'],
  [/\bfunction\s|\bconst\s|=>|console\./, 'javascript'],
  [/<html\b|<!doctype/i, 'html'],
  [/^[\s\r\n]*[[{]\s*"/, 'json'],
  [/\bselect\s+[\w*]|\bcreate\s+table\b/i, 'sql'],
  [/^\s*#\s*include\b/m, 'cpp'],
  [/\bfn\s+main\b|\blet\s+mut\b/, 'rust'],
  [/^\s*package\s+\w+\s*$|^\s*func\s+\w*\s*\(/m, 'go'],
];

export function sniffLang(code) {
  const src = String(code ?? '');
  if (!src.trim()) return 'text';
  const shebang = src.match(/^#!\s*\S*?([\w.]+)\s*$|^#!.*?\b([\w.]+)\b/);
  if (shebang) {
    const interp = (shebang[1] || shebang[2] || '').toLowerCase().replace(/\.\w+$/, '');
    if (SHEBANG_LANG[interp]) return SHEBANG_LANG[interp];
    if (src.startsWith('#!')) return 'bash';
  }
  for (const [re, lang] of SNIFF_RULES) if (re.test(src)) return lang;
  return 'text';
}
