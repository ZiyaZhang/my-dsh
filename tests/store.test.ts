import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALIASES_MAX, RequestError, type Matter, type SessionLink } from '../src/host/remote.ts';
import {
  addAlias, addSession, archiveMatter, cleanPhrase, conversationOf, createMatter, linkOf, matterOf, mergeMatters, removeSession, renameMatter, setContext,
  setConversation, setGoal, setHosting, unarchiveMatter,
} from '../src/host/matters.ts';
import { MatterStore, migrateMatters } from '../src/host/store.ts';

const T0 = '2026-11-09T01:00:00.000Z';
const T1 = '2026-11-09T02:00:00.000Z';
const T2 = '2026-11-09T03:00:00.000Z';

const link = (sessionId: string, by: SessionLink['by'] = 'manual', at = T0, why?: string): SessionLink =>
  ({ sessionId, by, at, ...(why ? { why } : {}) });
const ids = (matter: Matter | null | undefined) => matter?.sessions.map(entry => entry.sessionId);

function sample(): Matter[] {
  return [
    { id: 'm-brief', name: '每周简报', goal: '每周五发一期', sessions: [link('s-1'), link('s-2', 'mydsh', T0, '前三期都在这里')], aliases: ['周报'], sources: [], createdAt: T0 },
    { id: 'm-notes', name: '发布说明', goal: '', sessions: [link('s-3')], aliases: [], sources: [], createdAt: T0 },
  ];
}

const refused = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof RequestError && message.test(error.message));

test('createMatter appends a matter with no sessions and no aliases, and leaves the input alone', () => {
  const before = sample();
  const { matters, matter } = createMatter(before, { name: '看板', goal: '组里讨论' }, { id: 'm-new', at: T1 });
  assert.deepEqual(matter, { id: 'm-new', name: '看板', goal: '组里讨论', sessions: [], aliases: [], sources: [], createdAt: T1 });
  assert.deepEqual(matters.map(m => m.id), ['m-brief', 'm-notes', 'm-new']);
  assert.deepEqual(before, sample());
  const withContext = createMatter(before, {
    name: '看板', goal: '', workspaceId: 'w-dsh', sources: [{ kind: 'folder', value: '/work/kb', title: 'kb' }], instructions: '图用真实样式',
  }, { id: 'm-new', at: T1 }).matter;
  assert.deepEqual(withContext, {
    id: 'm-new', name: '看板', goal: '', sessions: [], aliases: [], workspaceId: 'w-dsh', sources: [{ kind: 'folder', value: '/work/kb', title: 'kb' }],
    instructions: '图用真实样式', createdAt: T1,
  });
});

test('setContext replaces the main workspace, the sources and the instructions; leaving one out clears it', () => {
  const set = setContext(sample(), 'm-notes', { workspaceId: 'w-dsh', sources: [{ kind: 'pr', value: 'https://github.com/o/r/pull/1', title: 'o/r#1' }], instructions: '周五前发' }).matter;
  assert.equal(set.workspaceId, 'w-dsh');
  assert.deepEqual(set.sources, [{ kind: 'pr', value: 'https://github.com/o/r/pull/1', title: 'o/r#1' }]);
  assert.equal(set.instructions, '周五前发');
  const cleared = setContext([set], 'm-notes', { sources: [] }).matter;
  assert.ok(!('workspaceId' in cleared) && !('instructions' in cleared));
  assert.deepEqual(cleared.sessions, set.sessions);
  refused(() => setContext(sample(), 'm-gone', { sources: [] }), /没有这个事项/);
});

test('renameMatter keeps the old name as the newest alias; setGoal changes one field', () => {
  const renamed = renameMatter(sample(), 'm-notes', '版本说明').matter;
  assert.equal(renamed.name, '版本说明');
  assert.deepEqual(renamed.aliases, ['发布说明']);
  assert.deepEqual(renameMatter(sample(), 'm-brief', '简报').matter.aliases, ['每周简报', '周报']);
  // The same name again adds nothing; going back to an alias takes it off the list.
  assert.deepEqual(renameMatter(sample(), 'm-brief', '每周简报').matter.aliases, ['周报']);
  assert.deepEqual(renameMatter(sample(), 'm-brief', '周报').matter.aliases, ['每周简报']);
  assert.equal(setGoal(sample(), 'm-notes', '周五前发出').matter.goal, '周五前发出');
  assert.equal(setGoal(sample(), 'm-brief', '').matter.goal, '');
  refused(() => renameMatter(sample(), 'm-gone', '版本说明'), /没有这个事项/);
  refused(() => setGoal(sample(), 'm-gone', ''), /没有这个事项/);
});

test('setHosting hosts a matter under a preset with the time it was set, changes it, and stops it with null', () => {
  const before = sample();
  const hosted = setHosting(before, 'm-notes', { preset: 'workspace-write', at: T1 });
  assert.deepEqual(hosted.matter.hosting, { preset: 'workspace-write', at: T1 });
  assert.deepEqual(hosted.matter.sessions, sample()[1]!.sessions);
  assert.deepEqual(before, sample());
  const changed = setHosting(hosted.matters, 'm-notes', { preset: 'read-only', at: T2 });
  assert.deepEqual(changed.matter.hosting, { preset: 'read-only', at: T2 });
  const stopped = setHosting(changed.matters, 'm-notes', null);
  assert.ok(!('hosting' in stopped.matter));
  assert.deepEqual(stopped.matter, sample()[1]);
  // Stopping a matter that is not hosted changes nothing.
  assert.deepEqual(setHosting(sample(), 'm-brief', null).matter, sample()[0]);
  refused(() => setHosting(sample(), 'm-gone', { preset: 'read-only', at: T1 }), /没有这个事项/);
});

test('a merge keeps the hosting of the matter that stays, whether or not the merged one was hosted', () => {
  const both = setHosting(setHosting(sample(), 'm-brief', { preset: 'read-only', at: T1 }).matters, 'm-notes', { preset: 'danger-full-access', at: T2 }).matters;
  assert.deepEqual(mergeMatters(both, 'm-notes', 'm-brief').matter.hosting, { preset: 'read-only', at: T1 });
  const onlyMerged = setHosting(sample(), 'm-notes', { preset: 'danger-full-access', at: T2 }).matters;
  assert.ok(!('hosting' in mergeMatters(onlyMerged, 'm-notes', 'm-brief').matter));
});

test('a matter records its own conversation, which is not one of its sessions; a merge keeps the conversation of the matter that stays', () => {
  const talking = setConversation(sample(), 'm-brief', 's-talk');
  assert.equal(talking.matter.conversation, 's-talk');
  assert.deepEqual(talking.matter.sessions, sample()[0]!.sessions);
  assert.equal(conversationOf(talking.matters, 's-talk')?.id, 'm-brief');
  assert.equal(conversationOf(talking.matters, 's-1'), undefined);
  assert.equal(matterOf(talking.matters, 's-talk'), undefined);
  // One that is gone is replaced.
  assert.equal(setConversation(talking.matters, 'm-brief', 's-again').matter.conversation, 's-again');
  const both = setConversation(talking.matters, 'm-notes', 's-notes').matters;
  assert.equal(mergeMatters(both, 'm-notes', 'm-brief').matter.conversation, 's-talk');
  assert.ok(!('conversation' in mergeMatters(setConversation(sample(), 'm-notes', 's-notes').matters, 'm-notes', 'm-brief').matter));
  refused(() => setConversation(sample(), 'm-gone', 's-talk'), /没有这个事项/);
});

test('aliases stay at most ten per matter, newest first, without repeats or the current name', () => {
  let matters = sample();
  for (let n = 1; n <= 12; n += 1) matters = addAlias(matters, 'm-notes', `说法${n}`).matters;
  const notes = matters.find(m => m.id === 'm-notes')!;
  assert.equal(ALIASES_MAX, 10);
  assert.equal(notes.aliases.length, 10);
  assert.deepEqual(notes.aliases.slice(0, 3), ['说法12', '说法11', '说法10']);
  assert.ok(!notes.aliases.includes('说法1') && !notes.aliases.includes('说法2'));
  // An alias used again moves to the front; case and spacing do not make a new one.
  const again = addAlias(matters, 'm-notes', ' 说法5 ').matter;
  assert.deepEqual(again.aliases.slice(0, 2), ['说法5', '说法12']);
  assert.equal(again.aliases.length, 10);
  assert.deepEqual(addAlias(sample(), 'm-brief', 'Weekly  brief').matter.aliases, ['Weekly brief', '周报']);
  assert.deepEqual(addAlias(addAlias(sample(), 'm-brief', 'Weekly brief').matters, 'm-brief', 'weekly brief').matter.aliases, ['weekly brief', '周报']);
  // The name itself, an empty phrase, a second line or a very long phrase is not stored.
  assert.deepEqual(addAlias(sample(), 'm-brief', '每周简报').matter.aliases, ['周报']);
  assert.deepEqual(addAlias(sample(), 'm-brief', '  ').matter.aliases, ['周报']);
  assert.deepEqual(addAlias(sample(), 'm-brief', '周报\n第二行').matter.aliases, ['周报']);
  assert.deepEqual(addAlias(sample(), 'm-brief', '长'.repeat(41)).matter.aliases, ['周报']);
  refused(() => addAlias(sample(), 'm-gone', '周报'), /没有这个事项/);
});

test('a phrase loses its pointing words, generic nouns and question words, and needs two characters left to be an alias', () => {
  assert.equal(cleanPhrase('那件事项'), undefined);
  assert.equal(cleanPhrase('周报那件'), '周报');
  assert.equal(cleanPhrase('那件事项现在怎么样了'), undefined);
  assert.equal(cleanPhrase('那个项目'), undefined);
  assert.equal(cleanPhrase('之前那个 PR'), undefined);
  assert.equal(cleanPhrase('刚才那条会话'), undefined);
  assert.equal(cleanPhrase('上回那个东西'), undefined);
  assert.equal(cleanPhrase('这个文档呢'), undefined);
  assert.equal(cleanPhrase('它'), undefined);
  assert.equal(cleanPhrase('报'), undefined);
  assert.equal(cleanPhrase('周报那件事现在怎么样了？'), '周报');
  assert.equal(cleanPhrase('上次的切换卡顿任务'), '切换卡顿');
  assert.equal(cleanPhrase('PR评审那个'), '评审');
  assert.equal(cleanPhrase('pr 4321 那条'), '4321');
  assert.equal(cleanPhrase('Weekly  brief'), 'Weekly brief');
  // pr inside a word is part of the word.
  assert.equal(cleanPhrase('approve flow'), 'approve flow');
});

test('addAlias keeps the cleaned phrase, and nothing when only pointing words were said', () => {
  assert.deepEqual(addAlias(sample(), 'm-notes', '那件事项').matter.aliases, []);
  assert.deepEqual(addAlias(sample(), 'm-notes', '那件事项现在怎么样了').matter.aliases, []);
  assert.deepEqual(addAlias(sample(), 'm-notes', '发布那件事').matter.aliases, ['发布']);
  assert.deepEqual(addAlias(sample(), 'm-brief', '周报那件').matter.aliases, ['周报']);
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

test('addSession records how the session joined, and moves it out of any other matter', () => {
  const joined = addSession(sample(), 'm-notes', link('s-9', 'mydsh', T1, '这件事项的 PR'));
  assert.deepEqual(joined.matter.sessions, [link('s-3'), link('s-9', 'mydsh', T1, '这件事项的 PR')]);
  const moved = addSession(sample(), 'm-notes', link('s-1', 'manual', T1));
  assert.deepEqual(ids(moved.matters.find(m => m.id === 'm-brief')), ['s-2']);
  assert.deepEqual(moved.matter.sessions, [link('s-3'), link('s-1', 'manual', T1)]);
  // A session already in the matter keeps its place and the link it joined with.
  const same = addSession(sample(), 'm-brief', link('s-2', 'manual', T1));
  assert.deepEqual(same.matter.sessions, sample()[0]!.sessions);
  refused(() => addSession(sample(), 'm-gone', link('s-1')), /没有这个事项/);
});

test('a session added to an archived matter brings the matter back', () => {
  const archived = archiveMatter(sample(), 'm-notes', T1).matters;
  const joined = addSession(archived, 'm-notes', link('s-9', 'manual', T1));
  assert.equal(joined.matter.archivedAt, undefined);
});

test('removeSession takes the session out of its matter, or reports it was in none; linkOf finds the link', () => {
  const removed = removeSession(sample(), 's-1');
  assert.equal(removed.matter?.id, 'm-brief');
  assert.deepEqual(ids(removed.matter), ['s-2']);
  assert.equal(removeSession(sample(), 's-9').matter, null);
  assert.equal(matterOf(sample(), 's-3')?.id, 'm-notes');
  assert.equal(matterOf(sample(), 's-9'), undefined);
  assert.deepEqual(linkOf(sample(), 's-2'), { matter: sample()[0], link: link('s-2', 'mydsh', T0, '前三期都在这里') });
  assert.equal(linkOf(sample(), 's-9'), undefined);
});

test('mergeMatters moves the sessions with their links, carries the names over as aliases and drops the merged matter', () => {
  const matters: Matter[] = [...sample(), { id: 'm-old', name: '周报旧稿', goal: '', sessions: [link('s-4', 'mydsh', T1), link('s-2')], aliases: ['旧稿'], sources: [{ kind: 'file', value: '/work/a.md', title: 'a.md' }], createdAt: T0 }];
  const { matters: after, matter } = mergeMatters(matters, 'm-old', 'm-brief');
  assert.deepEqual(after.map(m => m.id), ['m-brief', 'm-notes']);
  assert.deepEqual(matter.sessions, [link('s-1'), link('s-2', 'mydsh', T0, '前三期都在这里'), link('s-4', 'mydsh', T1)]);
  assert.deepEqual(matter.aliases, ['周报旧稿', '旧稿', '周报']);
  assert.deepEqual(matter.sources, [{ kind: 'file', value: '/work/a.md', title: 'a.md' }]);
  const archivedInto = archiveMatter(matters, 'm-brief', T2).matters;
  assert.equal(mergeMatters(archivedInto, 'm-old', 'm-brief').matter.archivedAt, undefined);
  refused(() => mergeMatters(matters, 'm-old', 'm-old'), /不能并进自己/);
  refused(() => mergeMatters(matters, 'm-gone', 'm-brief'), /没有这个事项/);
  refused(() => mergeMatters(matters, 'm-old', 'm-gone'), /没有这个事项/);
});

test('migrateMatters turns an M1 file into links made by hand at the matter creation time, with no sources and no workspace yet', () => {
  const v1 = { version: 1, matters: [
    { id: 'm-1', name: '每周简报', goal: '', sessions: ['s-1', 's-2'], createdAt: T0 },
    { id: 'm-2', name: '发布说明', goal: '周五前发出', sessions: [], createdAt: T1, archivedAt: T2 },
  ] };
  const { matters, migrated } = migrateMatters(v1)!;
  assert.equal(migrated, true);
  assert.deepEqual(matters, [
    { id: 'm-1', name: '每周简报', goal: '', sessions: [link('s-1', 'manual', T0), link('s-2', 'manual', T0)], aliases: [], sources: [], createdAt: T0 },
    { id: 'm-2', name: '发布说明', goal: '周五前发出', sessions: [], aliases: [], sources: [], createdAt: T1, archivedAt: T2 },
  ]);
  const current = { version: 2, matters };
  assert.deepEqual(migrateMatters(current), { matters, migrated: false });
  assert.equal(migrateMatters({ version: 3, matters: [] }), undefined);
  assert.equal(migrateMatters({ version: 1, matters: [{ id: 'm-1', name: '每周简报', goal: '', sessions: 's-1', createdAt: T0 }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], sessions: [{ sessionId: 's-1', by: 'robot', at: T0 }] }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], aliases: [7] }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], sources: [{ kind: 'video', value: 'x' }] }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], workspaceId: 3 }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], instructions: [] }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], hosting: 'workspace-write' }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], hosting: { preset: 'workspace-write' } }] }), undefined);
  assert.equal(migrateMatters({ version: 2, matters: [{ ...matters[0], conversation: 7 }] }), undefined);
});

test('the store writes and reads back a matter\'s conversation, and a file without one still opens as version 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const plain = { id: 'm-1', name: '每周简报', goal: '', sessions: [link('s-1')], aliases: [], sources: [], createdAt: T0 };
  await writeFile(join(directory, 'matters.json'), JSON.stringify({ version: 2, matters: [plain] }));
  const store = new MatterStore(directory);
  await store.open();
  assert.deepEqual(store.list(), [plain]);
  await store.update(matters => setConversation(matters, 'm-1', 's-talk'));
  const written = JSON.parse(await readFile(join(directory, 'matters.json'), 'utf8')) as { version: number; matters: Record<string, unknown>[] };
  assert.equal(written.version, 2);
  assert.equal(written.matters[0]!.conversation, 's-talk');
  const again = new MatterStore(directory);
  await again.open();
  assert.deepEqual(again.list(), [{ ...plain, conversation: 's-talk' }]);
});

test('a version 2 file reads with or without hosting, and a main field from older files is read past and dropped', () => {
  const plain = { id: 'm-1', name: '每周简报', goal: '', sessions: [link('s-1')], aliases: [], sources: [], createdAt: T0 };
  const hosted = { ...plain, id: 'm-2', hosting: { preset: 'workspace-write', at: T1 } };
  const old = { ...plain, id: 'm-3', main: 's-1' };
  const read = migrateMatters({ version: 2, matters: [plain, hosted, old] });
  assert.deepEqual(read, { matters: [plain, hosted, { ...plain, id: 'm-3' }], migrated: false });
  assert.equal(migrateMatters({ version: 2, matters: [{ ...plain, main: 7 }] }), undefined);
});

test('the store writes and reads back hosting, and opens a file whose matters carry the old main field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  await writeFile(join(directory, 'matters.json'), JSON.stringify({ version: 2, matters: [
    { id: 'm-1', name: '每周简报', goal: '', sessions: [link('s-1')], aliases: [], sources: [], createdAt: T0, main: 's-1' },
  ] }));
  const store = new MatterStore(directory);
  await store.open();
  assert.deepEqual(store.list(), [{ id: 'm-1', name: '每周简报', goal: '', sessions: [link('s-1')], aliases: [], sources: [], createdAt: T0 }]);
  await store.update(matters => setHosting(matters, 'm-1', { preset: 'workspace-write', at: T1 }));
  const written = JSON.parse(await readFile(join(directory, 'matters.json'), 'utf8')) as { version: number; matters: Record<string, unknown>[] };
  assert.equal(written.version, 2);
  assert.deepEqual(written.matters[0]!.hosting, { preset: 'workspace-write', at: T1 });
  assert.ok(!('main' in written.matters[0]!));
  const again = new MatterStore(directory);
  await again.open();
  assert.deepEqual(again.list()[0]!.hosting, { preset: 'workspace-write', at: T1 });
  // Changing a listed copy leaves the store's hosting as it was.
  again.list()[0]!.hosting!.preset = 'danger-full-access';
  assert.equal(again.list()[0]!.hosting!.preset, 'workspace-write');
});

test('an M1 matter file opens migrated, keeps a copy of the old file and is written in the new form on the next change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const v1 = JSON.stringify({ version: 1, matters: [{ id: 'm-1', name: '每周简报', goal: '', sessions: ['s-1'], createdAt: T0 }] });
  await writeFile(join(directory, 'matters.json'), v1);
  const store = new MatterStore(directory);
  await store.open();
  assert.deepEqual(store.list()[0]!.sessions, [link('s-1', 'manual', T0)]);
  assert.equal(await readFile(join(directory, 'matters.v1.json'), 'utf8'), v1);
  assert.equal(await readFile(join(directory, 'matters.json'), 'utf8'), v1);
  await store.update(matters => setGoal(matters, 'm-1', '每周五发一期'));
  const written = JSON.parse(await readFile(join(directory, 'matters.json'), 'utf8')) as { version: number; matters: Matter[] };
  assert.equal(written.version, 2);
  assert.deepEqual(written.matters[0]!.sessions, [link('s-1', 'manual', T0)]);
  const again = new MatterStore(directory);
  await again.open();
  assert.deepEqual(again.list(), store.list());
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
  assert.deepEqual(again.list(), [{ id: 'm-1', name: '每周简报', goal: '每周五发一期', sessions: [], aliases: [], sources: [], createdAt: T0 }]);
});

test('updates run one at a time, each on the matters the previous one left', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new MatterStore(directory);
  await store.open();
  await Promise.all([
    store.update(matters => createMatter(matters, { name: '每周简报', goal: '' }, { id: 'm-1', at: T0 })),
    store.update(matters => createMatter(matters, { name: '发布说明', goal: '' }, { id: 'm-2', at: T0 })),
    store.update(matters => addSession(matters, 'm-1', link('s-1'))),
  ]);
  assert.deepEqual(store.list().map(m => [m.id, ids(m)]), [['m-1', ['s-1']], ['m-2', []]]);
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
  store.list()[0]!.sessions.push(link('s-x'));
  store.list()[0]!.aliases.push('说法');
  store.list()[0]!.sources.push({ kind: 'link', value: 'https://example.com/' });
  assert.deepEqual(store.list()[0]!.sessions, []);
  assert.deepEqual(store.list()[0]!.aliases, []);
  assert.deepEqual(store.list()[0]!.sources, []);
});

test('a damaged matter file stops the start instead of being overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  await writeFile(join(directory, 'matters.json'), '{"version": 3}');
  await assert.rejects(new MatterStore(directory).open(), /不是能读的事项文件/);
  assert.equal(await readFile(join(directory, 'matters.json'), 'utf8'), '{"version": 3}');
  const broken = JSON.stringify({ version: 1, matters: [{ id: 'm-1', name: '发布说明', goal: '', sessions: 's-1', createdAt: T0 }] });
  await writeFile(join(directory, 'matters.json'), broken);
  await assert.rejects(new MatterStore(directory).open(), /不是能读的事项文件/);
  await writeFile(join(directory, 'matters.json'), '{"version": 1, "matters": [');
  await assert.rejects(new MatterStore(directory).open(), /不是能读的事项文件/);
});

test('a link made by an origin rule keeps its rule; a rule that is not one makes the file unreadable', () => {
  const file = (rule: unknown) => ({
    version: 2,
    matters: [{ id: 'm-1', name: '看板', goal: '', createdAt: 'T', aliases: [], sources: [], sessions: [{ sessionId: 's-1', by: 'origin', at: 'T', why: '在同一个分支 feat/x 上', rule }] }],
  });
  assert.equal(migrateMatters(file('branch'))?.matters[0]!.sessions[0]!.rule, 'branch');
  assert.equal(migrateMatters(file(undefined))?.matters[0]!.sessions[0]!.rule, undefined);
  assert.equal(migrateMatters(file('guess')), undefined);
});
