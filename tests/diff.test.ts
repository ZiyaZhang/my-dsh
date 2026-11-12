import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIFF_MAX, unifiedDiff } from '../src/host/diff.ts';

const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, n) => `${prefix} ${n + 1}`);

test('a changed line shows with three lines of context around it, under a hunk head', () => {
  const before = `${lines(10).join('\n')}\n`;
  const after = before.replace('line 5\n', 'line five\n');
  assert.equal(unifiedDiff('坑/a.md', before, after), [
    '--- a/坑/a.md', '+++ b/坑/a.md', '@@ -2,7 +2,7 @@', ' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8',
  ].join('\n'));
});

test('changes far apart make separate hunks; close ones share one', () => {
  const before = lines(30);
  const after = [...before];
  after[2] = 'changed 3';
  after[25] = 'changed 26';
  const far = unifiedDiff('a.md', before.join('\n'), after.join('\n'));
  assert.equal(far.split('\n').filter(line => line.startsWith('@@')).length, 2);
  const near = [...before];
  near[2] = 'changed 3';
  near[8] = 'changed 9';
  const close = unifiedDiff('a.md', before.join('\n'), near.join('\n'));
  assert.deepEqual(close.split('\n').filter(line => line.startsWith('@@')), ['@@ -1,12 +1,12 @@']);
});

test('a new file is all added from /dev/null, a deleted one all removed; the same text is no diff', () => {
  assert.equal(unifiedDiff('规则/a.md', null, 'one\ntwo\n'), '--- /dev/null\n+++ b/规则/a.md\n@@ -0,0 +1,2 @@\n+one\n+two');
  assert.equal(unifiedDiff('规则/a.md', 'one\n', null), '--- a/规则/a.md\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-one');
  assert.equal(unifiedDiff('规则/a.md', 'same', 'same'), '');
});

test('inserted and removed lines in the middle pair with the lines that stayed', () => {
  const diff = unifiedDiff('a.md', 'a\nb\nc\nd\n', 'a\nc\nx\nd\n');
  assert.equal(diff, '--- a/a.md\n+++ b/a.md\n@@ -1,4 +1,4 @@\n a\n-b\n c\n+x\n d');
});

test('a long diff is cut at a line within its bound and says how many lines it left out', () => {
  const diff = unifiedDiff('a.md', null, lines(2000, 'a fairly long line of text').join('\n'));
  assert.ok(diff.length <= DIFF_MAX);
  assert.match(diff, /\n… 还有 \d+ 行没存$/);
  assert.ok(diff.split('\n').slice(0, -1).every(line => line === '--- /dev/null' || line === '+++ b/a.md' || line.startsWith('@@') || line.startsWith('+')));
});
