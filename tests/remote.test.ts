import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestError, parseRequest } from '../src/host/remote.ts';
import { MatterStore } from '../src/host/store.ts';

test('parseRequest takes a snapshot and nothing else', () => {
  assert.deepEqual(parseRequest({ action: 'snapshot' }), { action: 'snapshot' });
  assert.throws(() => parseRequest({ action: 'drop' }), RequestError);
  assert.throws(() => parseRequest({ action: 'snapshot', extra: 1 }), RequestError);
  assert.throws(() => parseRequest(null), RequestError);
  assert.throws(() => parseRequest([]), RequestError);
});

test('a missing matter file is an empty store, and a save reads back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new MatterStore(directory);
  await store.open();
  assert.deepEqual(store.list(), []);
  const matter = { id: 'm1', name: '每周简报', goal: '每周五发一期', sessions: ['s1'], createdAt: '2026-11-09T00:00:00.000Z' };
  await store.save([matter]);
  const again = new MatterStore(directory);
  await again.open();
  assert.deepEqual(again.list(), [matter]);
});

test('a damaged matter file stops the start instead of being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  await writeFile(join(directory, 'matters.json'), '{"version": 2}');
  await assert.rejects(new MatterStore(directory).open(), /不是能读的事项文件/);
  assert.equal(await readFile(join(directory, 'matters.json'), 'utf8'), '{"version": 2}');
});
