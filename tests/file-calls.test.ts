import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callChanges, callTargets, patchCompleted, patchOperations, resolvePath, resultText, within } from '../src/host/file-calls.ts';

const PATCH = [
  '*** Begin Patch',
  '*** Add File: dsh-tool-list-worktrees/src/index.ts',
  '+export {};',
  '*** Update File: README.md',
  '*** Move to: docs/README.md',
  '@@',
  '-old',
  '+new',
  '*** Delete File: old.txt',
  '*** Update File: /abs/package.json',
  '@@',
  '-1',
  '+2',
  '*** End Patch',
].join('\n');

test('a patch\'s operations come from its Add, Update (with Move to) and Delete headers', () => {
  assert.deepEqual(patchOperations(PATCH), [
    { kind: 'add', path: 'dsh-tool-list-worktrees/src/index.ts' },
    { kind: 'update', path: 'README.md', to: 'docs/README.md' },
    { kind: 'delete', path: 'old.txt' },
    { kind: 'update', path: '/abs/package.json' },
  ]);
  assert.deepEqual(patchOperations('not a patch'), []);
});

test('a patch result lists what completed; a stopped one only what is under Completed', () => {
  assert.deepEqual(patchCompleted('Success. Updated the following files:\nA /w/a.ts\nM /w/b.ts\nD /w/c.ts'), [
    { path: '/w/a.ts', kind: 'created' }, { path: '/w/b.ts', kind: 'modified' }, { path: '/w/c.ts', kind: 'deleted' },
  ]);
  assert.deepEqual(patchCompleted('Patch stopped after 1 of 3 operations.\nCompleted:\nA /w/a.ts\nFailed:\n- operation 2 (update b.ts, patch line 4): no match'), [{ path: '/w/a.ts', kind: 'created' }]);
  assert.deepEqual(patchCompleted('Success. No operations in patch.'), []);
  assert.equal(patchCompleted('something else'), undefined);
});

test('write and edit read the canonical path from the result, else the argument against the session\'s folder; write says whether it created', () => {
  const write = JSON.stringify({ file_path: 'report.md', content: 'x' });
  assert.deepEqual(callChanges('write', write, { meta: { operation: 'create', path: '/real/w/report.md' } }, '/w'), [{ path: '/real/w/report.md', kind: 'created' }]);
  assert.deepEqual(callChanges('write', write, { meta: { operation: 'update', path: '/real/w/report.md' } }, '/w'), [{ path: '/real/w/report.md', kind: 'modified' }]);
  assert.deepEqual(callChanges('write', write, {}, '/w'), [{ path: '/w/report.md', kind: 'modified' }]);
  assert.deepEqual(callChanges('edit', JSON.stringify({ file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }), { meta: { path: '/w/a.ts', diffs: [] } }, undefined), [
    { path: '/w/a.ts', kind: 'modified' },
  ]);
  assert.deepEqual(callChanges('edit', JSON.stringify({ file_path: 'a.ts' }), {}, undefined), [{ path: 'a.ts', kind: 'modified' }]);
});

test('apply_patch reads its result\'s completed lines, else its patch; failed and refused calls and other tools change nothing', () => {
  const args = JSON.stringify({ input: PATCH });
  assert.deepEqual(callChanges('apply_patch', args, { text: 'Success. Updated the following files:\nA w/x.ts\nM /w/y.ts' }, '/w'), [
    { path: '/w/w/x.ts', kind: 'created' }, { path: '/w/y.ts', kind: 'modified' },
  ]);
  assert.deepEqual(callChanges('apply_patch', args, {}, '/w'), [
    { path: '/w/dsh-tool-list-worktrees/src/index.ts', kind: 'created' },
    { path: '/w/docs/README.md', kind: 'modified' },
    { path: '/w/old.txt', kind: 'deleted' },
    { path: '/abs/package.json', kind: 'modified' },
  ]);
  assert.deepEqual(callChanges('apply_patch', args, { isError: true, text: 'rejected' }, '/w'), []);
  assert.deepEqual(callChanges('write', JSON.stringify({ file_path: 'a' }), { isError: true }, '/w'), []);
  assert.deepEqual(callChanges('bash', JSON.stringify({ command: 'touch a' }), {}, '/w'), []);
});

test('a call\'s targets before it runs: write and edit their file, apply_patch every path of its patch', () => {
  assert.deepEqual(callTargets('write', JSON.stringify({ file_path: 'a.md' }), '/w'), ['/w/a.md']);
  assert.deepEqual(callTargets('apply_patch', JSON.stringify({ input: PATCH }), '/w'), [
    '/w/dsh-tool-list-worktrees/src/index.ts', '/w/README.md', '/w/docs/README.md', '/w/old.txt', '/abs/package.json',
  ]);
  assert.deepEqual(callTargets('read', JSON.stringify({ file_path: 'a.md' }), '/w'), []);
  assert.deepEqual(callTargets('write', '{broken', '/w'), []);
});

test('paths: relative ones resolve against the folder, absolute ones normalise; within gives the path below a folder', () => {
  assert.equal(resolvePath('a/../b.md', '/w'), '/w/b.md');
  assert.equal(resolvePath('/w//x/./y.md', undefined), '/w/x/y.md');
  assert.equal(resolvePath('rel.md', undefined), 'rel.md');
  assert.equal(within('/w/.my-dsh/m/memory', '/w/.my-dsh/m/memory/坑/a.md'), '坑/a.md');
  assert.equal(within('/w/.my-dsh/m/memory', '/w/.my-dsh/m/memory'), undefined);
  assert.equal(within('/w/.my-dsh/m/memory', '/w/.my-dsh/m/memory-old/a.md'), undefined);
  assert.equal(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
});
