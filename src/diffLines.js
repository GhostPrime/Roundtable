// Dependency-free line diff (classic LCS dynamic programming).
// Returns [{ t: ' '|'-'|'+', line }] in display order, or null when the
// inputs are too big for the O(n·m) table — callers fall back to showing
// the new content plain.
export function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const n = a.length;
  const m = b.length;
  // ~24MB of Uint32 at the guard — read_file caps at 64KB anyway, so real
  // inputs are far smaller; this is belt-and-braces.
  if ((n + 1) * (m + 1) > 6_000_000) return null;

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: '-', line: a[i] });
      i++;
    } else {
      out.push({ t: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: '-', line: a[i++] });
  while (j < m) out.push({ t: '+', line: b[j++] });
  return out;
}

// Collapse long unchanged runs to "… N unchanged lines …" markers, keeping
// `ctx` context lines around every change (like a unified diff).
export function collapseDiff(rows, ctx = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.t !== ' ') {
      for (let j = Math.max(0, i - ctx); j <= Math.min(rows.length - 1, i + ctx); j++) keep[j] = true;
    }
  });
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) {
      out.push(rows[i]);
      i++;
    } else {
      let j = i;
      while (j < rows.length && !keep[j]) j++;
      out.push({ gap: true, n: j - i });
      i = j;
    }
  }
  return out;
}
