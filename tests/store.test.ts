import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestError, type Matter } from '../src/host/remote.ts';
import { addSession, archiveMatter, createMatter, matterOf, removeSession, renameMatter, setGoal, unarchiveMatter } from '../src/host/matters.ts';
import { MatterStore } from '../src/host/store.ts';

const T0 = '2026-11-09T01:00:00.000Z';
const T1 = '2026-11-09T02:00:00.000Z';

function sample(): Matter[] {
  return [
    { id: 'm-brief', name: '每周简报', goal: '每周五发一期', sessions: ['s-1', 's-2'], createdAt: T0 },
    { id: 'm-notes', name: '发布说明', goal: '', sessions: ['s-3'], createdAt: T0 },
  ];
}

const refused = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof RequestError && message.test(error.message));

test('createMatter appends a matter with no sessions and leaves the input alone', () => {
  const before = sample();
  const { matters, matter } = createMatter(before, { name: '看板', goal: '组里讨论' }, { id: 'm-new', at: T1 });
  assert.deepEqual(matter, { id: 'm-new', name: '看板', goal: '组里讨论', sessions: [], createdAt: T1 });
  assert.deepEqual(matters.map(m => m.id), ['m-brief', 'm-notes', 'm-new']);
  assert.deepEqual(before, sample());
});

test('renameMatter and setGoal change one field of a known matter', () => {
  assert.equal(renameMatter(sample(), 'm-notes', '版本说明').matter.name, '版本说明');
  assert.equal(setGoal(sample(), 'm-notes', '周五前发出').matter.goal, '周五前发出');
  assert.equal(setGoal(sample(), 'm-brief', '').matter.goal, '');
  refused(() => renameMatter(sample(), 'm-gone', '版本说明'), /没有这个事项/);
  refused(() => setGoal(sample(), 'm-gone', ''), /没有这个事项/);
});

test('archiveMatter stamps the time once; unarchiveMatter clears it', () => {
  const archived = archiveMatter(sample(), 'm-brief', T1);
  assert.equal(archived.matter.archivedAt, T1);
  const again = archiveMatter(archived.matters, 'm-brief', '2026-11-10T00:00:00.000Z');
  assert.equal(again.matter.archivedAt, T1);
  const restored = unarchiveMatter(again.matters, 'm-brief');
  assert.equal(restored.matter.archivedAt, undefined);
  assert.ok(!('archivedAt' in restored.matter));
  assert.equal(unarchiveMatter(sample(), 'm-notes').matter.archivedAt, undefined);
  refused(() => archiveMatter(sample(), 'm-gone', T1), /没有这个事项/);
  refused(() => unarchiveMatter(sample(), 'm-gone'), /没有这个事项/);
});

test('addSession joins the session to one matter, moving it out of any other', () => {
  const joined = addSession(sample(), 'm-notes', 's-9');
  assert.deepEqual(joined.matter.sessions, ['s-3', 's-9']);
  const moved = addSession(sample(), 'm-notes', 's-1');
  assert.deepEqual(moved.matters.find(m => m.id === 'm-brief')?.sessions, ['s-2']);
  assert.deepEqual(moved.matter.sessions, ['s-3', 's-1']);
  const same = addSession(sample(), 'm-brief', 's-2');
  assert.deepEqual(same.matter.sessions, ['s-1', 's-2']);
  refused(() => addSession(sample(), 'm-gone', 's-1'), /没有这个事项/);
});

test('a session added to an archived matter brings the matter back', () => {
  const archived = archiveMatter(sample(), 'm-notes', T1).matters;
  const joined = addSession(archived, 'm-notes', 's-9');
  assert.equal(joined.matter.archivedAt, undefined);
});

test('removeSession takes the session out of its matter, or reports it was in none', () => {
  const removed = removeSession(sample(), 's-1');
  assert.equal(removed.matter?.id, 'm-brief');
  assert.deepEqual(removed.matter?.sessions, ['s-2']);
  assert.equal(removeSession(sample(), 's-9').matter, null);
  assert.equal(matterOf(sample(), 's-3')?.id, 'm-notes');
  assert.equal(matterOf(sample(), 's-9'), undefined);
});

test('a missing matter file is an empty store, and an update reads back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new MatterStore(directory);
  await store.open();
  assert.deepEqual(store.list(), []);
  const matter = await store.update(matters => createMatter(matters, { name: '每周简报', goal: '每周五发一期' }, { id: 'm-1', at: T0 }));
  assert.equal(matter.id, 'm-1');
  const again = new MatterStore(directory);
  await again.open();
  assert.deepEqual(again.list(), [{ id: 'm-1', name: '每周简报', goal: '每周五发一期', sessions: [], createdAt: T0 }]);
});

test('updates run one at a time, each on the matters the previous one left', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new MatterStore(directory);
  await store.open();
  await Promise.all([
    store.update(matters => createMatter(matters, { name: '每周简报', goal: '' }, { id: 'm-1', at: T0 })),
    store.update(matters => createMatter(matters, { name: '发布说明', goal: '' }, { id: 'm-2', at: T0 })),
    store.update(matters => addSession(matters, 'm-1', 's-1')),
  ]);
  assert.deepEqual(store.list().map(m => [m.id, m.sessions]), [['m-1', ['s-1']], ['m-2', []]]);
  const again = new MatterStore(directory);
  await again.open();
  assert.deepEqual(again.list(), store.list());
});

test('a refused update changes nothing and later updates still run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new MatterStore(directory);
  await store.open();
  await assert.rejects(store.update(matters => renameMatter(matters, 'm-gone', '发布说明')), RequestError);
  assert.deepEqual(store.list(), []);
  await store.update(matters => createMatter(matters, { name: '发布说明', goal: '' }, { id: 'm-1', at: T0 }));
  assert.equal(store.list().length, 1);
});

test('the store reports each change after it is written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const seen: number[] = [];
  const store = new MatterStore(directory, () => { seen.push(store.list().length); });
  await store.open();
  await store.update(matters => createMatter(matters, { name: '发布说明', goal: '' }, { id: 'm-1', at: T0 }));
  assert.deepEqual(seen, [1]);
});

test('list hands out copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new MatterStore(directory);
  await store.open();
  await store.update(matters => createMatter(matters, { name: '发布说明', goal: '' }, { id: 'm-1', at: T0 }));
  store.list()[0]!.sessions.push('s-x');
  assert.deepEqual(store.list()[0]!.sessions, []);
});

test('a damaged matter file stops the start instead of being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  await writeFile(join(directory, 'matters.json'), '{"version": 2}');
  await assert.rejects(new MatterStore(directory).open(), /不是能读的事项文件/);
  assert.equal(await readFile(join(directory, 'matters.json'), 'utf8'), '{"version": 2}');
  const broken = JSON.stringify({ version: 1, matters: [{ id: 'm-1', name: '发布说明', goal: '', sessions: 's-1', createdAt: T0 }] });
  await writeFile(join(directory, 'matters.json'), broken);
  await assert.rejects(new MatterStore(directory).open(), /不是能读的事项文件/);
  await writeFile(join(directory, 'matters.json'), '{"version": 1, "matters": [');
  await assert.rejects(new MatterStore(directory).open(), /不是能读的事项文件/);
});
