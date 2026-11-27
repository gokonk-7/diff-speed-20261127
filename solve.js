// A faster drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly the answer makefun-diff 1.0.0 returns for the same
// input { old, new }: make.fun's own patch of the two texts, as one JSON string.
// Lines are cut after every "\n" (the only separator; a "\r" is part of its line)
// and a last line with no "\n" is a line too; two lines are equal only when they
// are the same code units, newline or its absence included.
//
// The edit script is the one the reference rule states: the common prefix of
// lines is kept, then the common suffix of the lines left; between them Myers's
// greedy search from the first lines, which keeps on each diagonal the path
// reaching furthest into the old text and, when a deletion and an insertion
// reach the same point, the deletion's, never moves past either text's end,
// prunes no edge diagonal, and follows every run of lines equal in both as far
// as it goes; the first path to reach both ends is the script.
//
// Speed comes from how the same search is run, never from a different answer:
//   - every distinct line is interned once to a small integer id (a module-level
//     map, shared across the cases of one process), so the search compares
//     integers in typed arrays instead of strings;
//   - the search keeps, per edit distance d, one Int32Array of the furthest old
//     position reached on each diagonal (stored + 2, so a zeroed array already
//     means "no path"), and the path is rebuilt by walking those arrays back,
//     so the inner loop allocates nothing at all: no path objects, no
//     linked-list components, no slices;
//   - the middle region is addressed by index ranges, never copied.
//
// The patch is then rendered by the reference's own hunk rule: a first line
// "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then each hunk's
// "@ os ol ns nl" line and one line per line it covers, "=" kept, "-" deleted,
// "+" inserted, deletions before insertions in each change run, up to 3 kept
// lines before and after each run, runs at most 6 kept lines apart sharing a
// hunk, and a line that ends its text with no newline written with one and
// followed by a line "%". Identical texts are the first line alone.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** The op of a kept, a deleted and an inserted line, as the patch writes them. */
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** One line's id for every distinct line string, shared across the cases of one process. */
const intern = new Map();
let nextId = 0;

/**
 * A text's lines, each with its "\n" (the last one without, when the text does
 * not end in one), as strings for the patch and as integer ids for the search.
 */
function tokenize(text) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const count = last + (parts[last] !== '' ? 1 : 0);
  const lines = new Array(count);
  const ids = new Int32Array(count);
  for (let i = 0; i < last; i++) {
    const line = parts[i] + '\n';
    lines[i] = line;
    let id = intern.get(line);
    if (id === undefined) {
      id = nextId++;
      intern.set(line, id);
    }
    ids[i] = id;
  }
  if (parts[last] !== '') {
    const line = parts[last];
    lines[last] = line;
    let id = intern.get(line);
    if (id === undefined) {
      id = nextId++;
      intern.set(line, id);
    }
    ids[last] = id;
  }
  return { lines, ids };
}

/**
 * The runs of the edit script of a[a0 .. a0+n) into b[b0 .. b0+m), as
 * [{ kind, count }] in order, by the reference's greedy rule.
 *
 * Vs[d] is the furthest old position reached on each diagonal k of edit
 * distance d, at index k + d, stored as that position + 2, so a fresh (zeroed)
 * array already means "no path" on every diagonal and the search fills one
 * such array per d and walks them back for the script; the inner loop
 * allocates nothing and writes only the diagonals it reaches.
 */
function myersRuns(a, b, a0, b0, n, m) {
  if (n === 0 && m === 0) return [];
  const maxEdit = n + m;
  const aEnd = a0 + n;
  const bEnd = b0 + m;
  const Vs = [];
  // d = 0: the snake from before both texts' first lines.
  const v0 = new Int32Array(1);
  let x = -1;
  let y = -1;
  while (x + 1 < n && y + 1 < m && a[a0 + x + 1] === b[b0 + y + 1]) {
    x++;
    y++;
  }
  v0[0] = x + 2;
  Vs.push(v0);
  if (x + 1 >= n && y + 1 >= m) {
    return x >= 0 ? [{ kind: KEEP, count: x + 1 }] : [];
  }
  for (let d = 1; d <= maxEdit; d++) {
    const vPrev = Vs[d - 1];
    const vCurr = new Int32Array(2 * d + 1);
    const prevLen = vPrev.length;
    // The (d-1)-paths on diagonals k-1 (a deletion's) and k+1 (an insertion's),
    // stored + 2, 0 where that diagonal holds no path. The insertion's path of
    // one diagonal is the deletion's path of the next, so it is carried over
    // instead of read twice.
    let xDelS = 0;
    let xInsS = vPrev[0];
    for (let k = -d; k <= d; k += 2) {
      // A move past the end of either text is no candidate.
      const canRemove = xDelS !== 0 && xDelS - 1 < n;
      const canAdd = xInsS !== 0 && xInsS - 2 - k < m;
      if (canRemove || canAdd) {
        // The candidate further into the old text, and the deletion when both
        // reach the same point.
        const byDeletion = canRemove ? xDelS - 1 : -2;
        const byInsertion = canAdd ? xInsS - 2 : -2;
        let xx = byDeletion >= byInsertion ? xDelS - 1 : xInsS - 2;
        let yy = xx - k;
        // Follow every run of lines equal in both as far as it goes.
        let ai = a0 + xx + 1;
        let bi = b0 + yy + 1;
        while (ai < aEnd && bi < bEnd && a[ai] === b[bi]) {
          ai++;
          bi++;
          xx++;
          yy++;
        }
        vCurr[k + d] = xx + 2;
        if (xx + 1 >= n && yy + 1 >= m) {
          Vs.push(vCurr);
          return backtrack(Vs, d, k, n, m);
        }
      }
      xDelS = xInsS;
      const nextIns = k + d + 2;
      xInsS = nextIns < prevLen ? vPrev[nextIns] : 0;
    }
    Vs.push(vCurr);
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/** The runs of the path the search found at (d, k), rebuilt from the Vs arrays. */
function backtrack(Vs, D, kEnd, n, m) {
  const rev = [];
  let d = D;
  let k = kEnd;
  while (d > 0) {
    const vCurr = Vs[d];
    const vPrev = Vs[d - 1];
    const prevLen = vPrev.length;
    const xEnd = vCurr[k + d] - 2;
    const iDel = k + d - 2;
    const xDelS = iDel >= 0 ? vPrev[iDel] : 0;
    const iIns = k + d;
    const xInsS = iIns < prevLen ? vPrev[iIns] : 0;
    const canRemove = xDelS !== 0 && xDelS - 1 < n;
    const canAdd = xInsS !== 0 && xInsS - 2 - k < m;
    const byDeletion = canRemove ? xDelS - 1 : -2;
    const byInsertion = canAdd ? xInsS - 2 : -2;
    const del = byDeletion >= byInsertion;
    const xPre = del ? xDelS - 1 : xInsS - 2;
    const snake = xEnd - xPre;
    if (snake > 0) rev.push({ kind: KEEP, count: snake });
    rev.push({ kind: del ? DELETE : INSERT, count: 1 });
    k = del ? k - 1 : k + 1;
    d--;
  }
  const x0 = Vs[0][0] - 2;
  if (x0 >= 0) rev.push({ kind: KEEP, count: x0 + 1 });
  rev.reverse();
  const runs = [];
  for (const r of rev) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** make.fun's own patch of input.old into input.new, as one JSON string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const aT = tokenize(input.old);
  const bT = tokenize(input.new);
  const a = aT.ids;
  const b = bT.ids;
  const aLines = aT.lines;
  const bLines = bT.lines;
  const n = a.length;
  const m = b.length;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...myersRuns(a, b, prefix, prefix, n - prefix - suffix, m - prefix - suffix));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes.at(-1);
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.at(-1);
    const prev = h?.at(-1);
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h.at(-1);
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, aLines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, aLines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, bLines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, aLines[at]));
  }
  return out.join('');
}
