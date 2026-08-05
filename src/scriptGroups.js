// Grouping for the scripts panel's "From the discussion" list.
//
// In Build mode four seats each paste near-identical revisions of the SAME
// file, turn after turn. extractScripts() only dedupes byte-identical bodies,
// so a single Pac-Man main.js can arrive as a dozen separate blocks that all
// look the same in the panel. This folds those into one row per file (or per
// snippet identity) with a version history behind it.
//
// Pure: strings and arrays only, no React and no DOM, so it can be unit-tested
// directly. The path resolver is injected because it depends on panel state
// (the loaded project tree).
import { sniffLang, langOfPath } from './langMap.js';

// Identity for blocks we can't resolve to a real file: the first line that
// carries any text, whitespace-collapsed and lowercased. Repeated pastes of
// the same file share it ("// Pac-Man Game Implementation"), while genuinely
// different snippets almost never do.
function firstLineKey(code) {
  for (const line of String(code ?? '').split('\n')) {
    const t = line.trim();
    if (t) return t.replace(/\s+/g, ' ').toLowerCase();
  }
  return '';
}

/**
 * Bucket discussion code blocks into version stacks.
 *
 * @param {Array<{code:string, lang?:string, source?:string, ts?:string, hints?:string[]}>} scripts
 *   Newest-first, as App's extractScripts() produces them.
 * @param {(s:object)=>(string|null)} [targetPathFn] resolves a block to a real
 *   project file (ScriptsPanel's targetPath); null/absent when unknown.
 * @returns {Array<{key:string, target:string|null, lang:string, versions:object[]}>}
 *   Version entries are the ORIGINAL objects (identity preserved, so callers
 *   can still index back into `scripts`), kept in input order — newest first.
 *   Groups come back in first-appearance order, i.e. newest member descending.
 */
export function groupScripts(scripts, targetPathFn) {
  const groups = new Map();
  for (const s of scripts || []) {
    if (!s) continue;
    let target = null;
    try {
      target = (typeof targetPathFn === 'function' ? targetPathFn(s) : null) || null;
    } catch {
      target = null; // a broken resolver must not blank the whole panel
    }
    // Explicit fence hint wins; then the resolved file's extension; then a
    // sniff of the body, so untagged blocks stop showing up as "text".
    const lang =
      String(s.lang || '').trim() ||
      (target ? langOfPath(target) : '') ||
      sniffLang(s.code);
    const key = target
      ? `path:${String(target).replace(/\\/g, '/').toLowerCase()}`
      : `snip:${lang}:${firstLineKey(s.code)}`;
    const existing = groups.get(key);
    if (existing) existing.versions.push(s);
    else groups.set(key, { key, target, lang, versions: [s] });
  }
  return [...groups.values()];
}

export default groupScripts;
