/**
 * A unified diff of two texts, line by line, for 做事记录: what a memory file looked like before and after a change, three lines of
 * context around each change, cut to a bound. The common start and end are matched first; the changed middle by a longest common
 * subsequence, or shown removed and added whole when it is too big for that. Pure.
 */

/** Characters a stored diff keeps. */
export const DIFF_MAX = 6_000;
const CONTEXT = 3;
/** Line pairs of the changed middle above which it is not matched line by line. */
const LCS_MAX = 4_000_000;

type Kind = ' ' | '-' | '+';
/** One line of the edit script, with how many lines of each side come before it. */
interface Op { kind: Kind; line: string; a: number; b: number }

function linesOf(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function script(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const ops: Op[] = [];
  let ai = 0;
  let bi = 0;
  const push = (kind: Kind, line: string) => {
    ops.push({ kind, line, a: ai, b: bi });
    if (kind !== '+') ai += 1;
    if (kind !== '-') bi += 1;
  };
  for (let index = 0; index < start; index += 1) push(' ', a[index]!);
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const n = middleA.length;
  const m = middleB.length;
  if (n * m > LCS_MAX) {
    for (const line of middleA) push('-', line);
    for (const line of middleB) push('+', line);
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = middleA[i] === middleB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (middleA[i] === middleB[j]) { push(' ', middleA[i]!); i += 1; j += 1; } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { push('-', middleA[i]!); i += 1; } else { push('+', middleB[j]!); j += 1; }
    }
    for (; i < n; i += 1) push('-', middleA[i]!);
    for (; j < m; j += 1) push('+', middleB[j]!);
  }
  for (let index = endA; index < a.length; index += 1) push(' ', a[index]!);
  return ops;
}

/** `start,count` of one side of a hunk header; an empty side names the line before it. */
const range = (before: number, count: number) => `${count === 0 ? before : before + 1},${count}`;

/**
 * The unified diff from `before` to `after`; null for a file that did not exist or no longer does.
 * @returns the diff, cut to `max` characters at a line, or '' when nothing changed.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, max = DIFF_MAX): string {
  if (before === after) return '';
  const ops = script(linesOf(before), linesOf(after));
  const changed = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]));
  if (changed.length === 0) return '';
  const lines = [before === null ? '--- /dev/null' : `--- a/${path}`, after === null ? '+++ /dev/null' : `+++ b/${path}`];
  let cursor = 0;
  while (cursor < changed.length) {
    // One hunk: changes no more than twice the context apart, with the context around them.
    let last = cursor;
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= CONTEXT * 2 + 1) last += 1;
    const from = Math.max(0, changed[cursor]! - CONTEXT);
    const to = Math.min(ops.length - 1, changed[last]! + CONTEXT);
    const hunk = ops.slice(from, to + 1);
    const aCount = hunk.filter(op => op.kind !== '+').length;
    const bCount = hunk.filter(op => op.kind !== '-').length;
    lines.push(`@@ -${range(hunk[0]!.a, aCount)} +${range(hunk[0]!.b, bCount)} @@`, ...hunk.map(op => `${op.kind}${op.line}`));
    cursor = last + 1;
  }
  const text = lines.join('\n');
  if (text.length <= max) return text;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > max - 40) break;
    kept.push(line);
    length += line.length + 1;
  }
  return `${kept.join('\n')}\n… 还有 ${lines.length - kept.length} 行没存`;
}
