import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestError } from '../src/host/remote.ts';
import { NoteStore, matterContext, noteText } from '../src/host/notes.ts';

const at = '2026-11-10T08:00:00.000Z';

test('matterContext gives a session in a matter its goal, instructions and sources, then the memory block', () => {
  const matter = { name: 'SDK 升级跟进', goal: '挑功能做成插件', instructions: '不改核心', sources: [{ kind: 'link', value: 'https://example.com/r', title: 'releases' }] };
  assert.deepEqual(matterContext(matter, '这件事的记忆在 /w/.my-dsh/m-1/memory/：……').split('\n'), [
    '这条会话属于事项「SDK 升级跟进」。',
    '目标：挑功能做成插件',
    '指令：不改核心',
    '来源：releases（https://example.com/r）',
    '',
    '这件事的记忆在 /w/.my-dsh/m-1/memory/：……',
  ]);
  assert.equal(matterContext({ name: 'x', goal: '', sources: [] }), '这条会话属于事项「x」。');
});

test('a line from the user is one line of at most 240 characters', () => {
  assert.equal(noteText('  报告只发到飞书，\n 不发邮件 '), '报告只发到飞书， 不发邮件');
  const refused = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof RequestError && message.test(error.message));
  refused(() => noteText(' \n '), /要记的话不能为空/);
  refused(() => noteText('长'.repeat(241)), /一次最多记 240 个字/);
  assert.equal(noteText('长'.repeat(240)).length, 240);
});

test('notes.json is read as it was, per matter; a missing file is empty and a damaged one stops the start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const empty = new NoteStore(directory);
  await empty.open();
  assert.deepEqual(empty.of('m-1'), []);
  await writeFile(join(directory, 'notes.json'), JSON.stringify({
    version: 1, matters: { 'm-1': { notes: [{ id: 'n-1', kind: 'rule', text: '发布前先装一遍', sources: ['s-1'], by: 'user', updatedAt: at }], revision: 3 } },
  }));
  const store = new NoteStore(directory);
  await store.open();
  assert.deepEqual(store.of('m-1'), [{ id: 'n-1', kind: 'rule', text: '发布前先装一遍', sources: ['s-1'], by: 'user', updatedAt: at }]);
  assert.deepEqual(store.of('m-2'), []);
  await writeFile(join(directory, 'notes.json'), '{坏的');
  await assert.rejects(new NoteStore(directory).open(), /不是能读的笔记文件/);
});
