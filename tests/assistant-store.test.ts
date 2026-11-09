import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AssistantStore, emptyAssistant } from '../src/host/assistant-store.ts';
import { RequestError, type ActivityEntry, type Proposal } from '../src/host/remote.ts';

const T0 = '2026-11-09T01:00:00.000Z';
const entry = (id: string): ActivityEntry => ({ id, at: T0, kind: 'file', matterId: 'm-1', sessionId: 's-1', text: '把会话 草稿 加进「每周简报」', why: '你手动加的' });
const proposal: Proposal = { id: 'p-1', change: { kind: 'new', name: '看板', goal: '' }, why: '理由', at: T0, state: 'pending', sessionId: 's-mydsh', turn: 2 };

test('a missing file is an empty state; an update reads back from disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new AssistantStore(directory);
  await store.open();
  assert.deepEqual(store.state(), emptyAssistant());
  const result = await store.update(state => ({ state: { ...state, sessionId: 's-mydsh', activity: [entry('a-1')], proposals: [proposal] }, result: 'done' }));
  assert.equal(result, 'done');
  const again = new AssistantStore(directory);
  await again.open();
  assert.deepEqual(again.state(), { sessionId: 's-mydsh', activity: [entry('a-1')], proposals: [proposal], questions: [] });
  const written = JSON.parse(await readFile(join(directory, 'assistant.json'), 'utf8')) as { version: number };
  assert.equal(written.version, 1);
});

test('updates run one at a time; a refused one changes nothing and reports after each write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  let writes = 0;
  const store = new AssistantStore(directory, () => { writes += 1; });
  await store.open();
  await Promise.all(['a-1', 'a-2', 'a-3'].map(id => store.update(state => ({ state: { ...state, activity: [...state.activity, entry(id)] }, result: id }))));
  assert.deepEqual(store.state().activity.map(item => item.id), ['a-1', 'a-2', 'a-3']);
  await assert.rejects(store.update(() => { throw new RequestError('没有这条记录'); }), RequestError);
  assert.equal(store.state().activity.length, 3);
  assert.equal(writes, 3);
  store.state().activity.pop();
  assert.equal(store.state().activity.length, 3);
});

test('a damaged file stops the start instead of being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  for (const body of ['{"version": 2, "activity": []}', '{"version": 1, "activity": {}}', '{"version": 1, "activity": [{"id": 3}], "proposals": [], "questions": []}', 'not json']) {
    await writeFile(join(directory, 'assistant.json'), body);
    await assert.rejects(new AssistantStore(directory).open(), /不是能读的 my dsh 记录/);
    assert.equal(await readFile(join(directory, 'assistant.json'), 'utf8'), body);
  }
});
