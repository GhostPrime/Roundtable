// Diff → editor-line-marker mapping for EditorPanel's "what did the table
// change?" highlighting. Pure and Monaco-free on purpose: it turns diffLines()
// rows into LINE NUMBERS IN THE CURRENT FILE, and EditorPanel turns those into
// Monaco decorations. Keeping it separate makes it unit-testable without a DOM.
//
// The mapping rule, per change block (a run of consecutive -/+ rows):
//   - the first min(#removed, #added) added lines are MODIFIED lines,
//   - any further added lines are pure ADDITIONS,
//   - if more lines were removed than added, the leftover removal collapses to
//     a single marker on the line AFTER the block (deleted text has no line of
//     its own in the current file, so it can only be pointed at).
import { diffLines } from './diffLines.js';

// [3,4,5,9] -> [{start:3,end:5},{start:9,end:9}]
function toRanges(nums) {
  const out = [];
  for (const n of nums) {
    const last = out[out.length - 1];
    if (last && n === last.end + 1) last.end = n;
    else out.push({ start: n, end: n });
  }
  return out;
}

// rows: output of diffLines() (may be null when the diff was too large).
// -> { changed: [{start,end}], added: [{start,end}], deleted: [lineNo],
//      adds, dels, lines } | null
export function changeMarksFromRows(rows) {
  if (!rows) return null;
  const changed = [];
  const added = [];
  const deleted = [];
  let adds = 0;
  let dels = 0;
  let line = 0; // last line number consumed in the CURRENT text
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t === ' ') { line++; i++; continue; }
    // one change block, any -/+ interleaving
    let removed = 0;
    const addLines = [];
    while (i < rows.length && rows[i].t !== ' ') {
      if (rows[i].t === '-') removed++;
      else { line++; addLines.push(line); }
      i++;
    }
    dels += removed;
    adds += addLines.length;
    const paired = Math.min(removed, addLines.length);
    addLines.forEach((n, k) => (k < paired ? changed : added).push(n));
    if (removed > addLines.length) deleted.push(line + 1);
  }
  return {
    changed: toRanges(changed),
    added: toRanges(added),
    deleted,
    adds,
    dels,
    lines: line,
  };
}

// Convenience: baseline text vs current text -> marks (null when diffLines
// bails out on an oversized pair).
export function computeChangeMarks(oldText, newText) {
  return changeMarksFromRows(diffLines(oldText, newText));
}
