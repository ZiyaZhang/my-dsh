import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestError, type ActivityEntry, type Matter, type SessionLink } from '../src/host/remote.ts';
import {
  ACTIVITY_MAX, FORWARD_LINE, activityView, appendActivity, canUndo, fileEntry, forwardEntry, groupEntry, markUndone, memoryEntry, noteEntry, noteFile,
  receiptCards, recentActivity, sendEntry, startEntry, undoChange, unfileEntry,
} from '../src/host/activity.ts';
import { addSession, removeSession } from '../src/host/matters.ts';

const T0 = '2026-11-09T01:00:00.000Z';
const T1 = '2026-11-09T02:00:00.000Z';
const T2 = '2026-11-09T03:00:00.000Z';
const PLACE = { sessionId: 's-mydsh', turn: 4 };

const link = (sessionId: string, by: SessionLink['by'], at: string, why?: string): SessionLink => ({ sessionId, by, at, ...(why ? { why } : {}) });
const matters = (): Matter[] => [
  { id: 'm-brief', name: '每周简报', goal: '', sessions: [link('s-7', 'mydsh', T1, '前三期都在这里'), link('s-8', 'manual', T1)], aliases: [], sources: [], createdAt: T0 },
  { id: 'm-notes', name: '发布说明', goal: '', sessions: [], aliases: [], sources: [], createdAt: T0 },
];

const started = (): ActivityEntry => startEntry({
  id: 'a-1', at: T1, matterId: 'm-brief', matterName: '每周简报', sessionId: 's-7', title: '整理周报', why: '前三期都在这里',
  task: '整理这周合进 master 的 PR，按模块分组', card: PLACE,
});
const filed = (): ActivityEntry => fileEntry({ id: 'a-2', at: T1, matterId: 'm-brief', matterName: '每周简报', sessionId: 's-8', title: '草稿' });

test('entries say what happened in one line, with the names as they were', () => {
  assert.deepEqual(started(), {
    id: 'a-1', at: T1, kind: 'start', matterId: 'm-brief', matterName: '每周简报', sessionId: 's-7', title: '整理周报',
    text: '在「每周简报」开了会话 整理周报', why: '前三期都在这里', task: '整理这周合进 master 的 PR，按模块分组', card: PLACE,
  });
  assert.equal(sendEntry({ id: 'a-3', at: T1, sessionId: 's-7', title: '整理周报', why: '你要它加上 #4321', task: '加上 #4321', card: PLACE }).text,
    '给会话 整理周报 发了消息');
  assert.deepEqual(filed(), {
    id: 'a-2', at: T1, kind: 'file', matterId: 'm-brief', matterName: '每周简报', sessionId: 's-8', title: '草稿',
    text: '把会话 草稿 加进「每周简报」', why: '你手动加的',
  });
  assert.equal(fileEntry({ id: 'a-4', at: T1, matterId: 'm-notes', matterName: '发布说明', sessionId: 's-8', title: '草稿', from: '每周简报' }).text,
    '把会话 草稿 从「每周简报」移到「发布说明」');
  assert.deepEqual(unfileEntry({ id: 'a-5', at: T1, matterId: 'm-brief', matterName: '每周简报', sessionId: 's-8', title: '草稿' }), {
    id: 'a-5', at: T1, kind: 'unfile', matterId: 'm-brief', matterName: '每周简报', sessionId: 's-8', title: '草稿',
    text: '把会话 草稿 移出「每周简报」', why: '你手动移出的',
  });
});

test('a start or a by-hand filing can be undone while the exact link it made is still there', () => {
  assert.equal(canUndo(started(), matters()), true);
  assert.equal(canUndo(filed(), matters()), true);
  // Moved elsewhere, taken out, or filed again later: the link this entry made is gone.
  assert.equal(canUndo(started(), addSession(matters(), 'm-notes', link('s-7', 'manual', T2)).matters), false);
  assert.equal(canUndo(filed(), removeSession(matters(), 's-8').matters), false);
  const refiled = addSession(removeSession(matters(), 's-8').matters, 'm-brief', link('s-8', 'manual', T2)).matters;
  assert.equal(canUndo(filed(), refiled), false);
  assert.equal(canUndo({ ...started(), undoneAt: T2 }, matters()), false);
  // Sending a message, taking a session out and confirming a proposal cannot be taken back here.
  assert.equal(canUndo(sendEntry({ id: 'a-3', at: T1, sessionId: 's-7', title: '整理周报', why: '', task: '加上 #4321', card: PLACE }), matters()), false);
  assert.equal(canUndo(unfileEntry({ id: 'a-5', at: T1, matterId: 'm-brief', matterName: '每周简报', sessionId: 's-8', title: '草稿' }), matters()), false);
});

test('undoing takes the session out of the matter and keeps the session; the entry is marked and a new entry records the undo', () => {
  const { matters: after, matter } = undoChange(matters(), started());
  assert.equal(matter?.id, 'm-brief');
  assert.deepEqual(after.find(m => m.id === 'm-brief')!.sessions.map(entry => entry.sessionId), ['s-8']);
  const entries = [started(), filed()];
  const { entries: marked, record } = markUndone(entries, 'a-1', { id: 'a-9', at: T2 });
  assert.equal(marked.find(entry => entry.id === 'a-1')!.undoneAt, T2);
  assert.deepEqual(record, {
    id: 'a-9', at: T2, kind: 'undo', matterId: 'm-brief', matterName: '每周简报', sessionId: 's-7', title: '整理周报',
    text: '撤回了会话 整理周报（在「每周简报」）', why: '你点了撤回', undoes: 'a-1',
  });
  assert.deepEqual(marked.at(-1), record);
  assert.equal(markUndone(entries, 'a-2', { id: 'a-9', at: T2 }).record.text, '把会话 草稿 移出「每周简报」');
  assert.throws(() => undoChange(removeSession(matters(), 's-7').matters, started()), (error: unknown) => error instanceof RequestError && /撤不回/.test(error.message));
  assert.throws(() => markUndone(entries, 'a-gone', { id: 'a-9', at: T2 }), (error: unknown) => error instanceof RequestError && /没有这条记录/.test(error.message));
  assert.throws(() => markUndone(marked, 'a-1', { id: 'a-10', at: T2 }), (error: unknown) => error instanceof RequestError && /撤不回/.test(error.message));
});

test('做事记录 lists entries newest first with whether each can still be undone', () => {
  const entries = [started(), filed(), { ...filed(), id: 'a-3', at: T2, kind: 'unfile' as const, text: '把会话 草稿 移出「每周简报」' }];
  const view = activityView(entries, removeSession(matters(), 's-8').matters);
  assert.deepEqual(view.map(entry => [entry.id, entry.undoable]), [['a-3', false], ['a-2', false], ['a-1', true]]);
});

test('the log keeps the newest entries when it grows past its bound', () => {
  let entries: ActivityEntry[] = [];
  for (let n = 0; n < ACTIVITY_MAX + 5; n += 1) entries = appendActivity(entries, { ...filed(), id: `a-${n}` });
  assert.equal(entries.length, ACTIVITY_MAX);
  assert.equal(entries[0]!.id, 'a-5');
  assert.equal(entries.at(-1)!.id, `a-${ACTIVITY_MAX + 4}`);
});

test('a start or a send leaves a receipt card under its turn; a start keeps 撤回 while it can be undone', () => {
  const send = sendEntry({ id: 'a-3', at: T1, sessionId: 's-7', title: '整理周报', why: '', task: '加上 #4321', card: { ...PLACE, turn: 5 } });
  const cards = receiptCards([started(), filed(), send], matters());
  assert.deepEqual(cards, [
    { type: 'receipt', id: 'a-1', kind: 'start', line: '在「每周简报」开了会话 整理周报', target: 's-7', undoable: true, undone: false, ...PLACE },
    { type: 'receipt', id: 'a-3', kind: 'send', line: '给会话 整理周报 发了消息', target: 's-7', undoable: false, undone: false, sessionId: 's-mydsh', turn: 5 },
  ]);
  const undone = receiptCards([{ ...started(), undoneAt: T2 }], removeSession(matters(), 's-7').matters);
  assert.deepEqual(undone.map(card => card.type === 'receipt' && [card.undoable, card.undone]), [[false, true]]);
});

const noted = (): ActivityEntry => noteEntry({
  id: 'a-6', at: T1, matterId: 'm-brief', matterName: '每周简报', note: { id: 'n-1', text: '周报只发到飞书，不发邮件', path: '定下的/周报只发到飞书.md', hash: 'h-1' },
  card: { ...PLACE, turn: 6 },
});

test('a note entry says what was written where; it has a receipt without 打开, and 撤回 while its file is still as written', () => {
  assert.deepEqual(noted(), {
    id: 'a-6', at: T1, kind: 'note', matterId: 'm-brief', matterName: '每周简报', text: '记进「每周简报」：周报只发到飞书，不发邮件', why: '',
    note: { id: 'n-1', text: '周报只发到飞书，不发邮件', path: '定下的/周报只发到飞书.md', hash: 'h-1' },
    memory: { path: '定下的/周报只发到飞书.md', change: 'add', by: 'note' }, card: { ...PLACE, turn: 6 },
  });
  assert.equal(canUndo(noted(), matters(), new Set(['n-1', 'n-2'])), true);
  // No 撤回 once the line is gone or the entry was taken back, nor when the caller gives no note ids.
  assert.equal(canUndo(noted(), matters(), new Set(['n-2'])), false);
  assert.equal(canUndo({ ...noted(), undoneAt: T2 }, matters(), new Set(['n-1'])), false);
  assert.equal(canUndo(noted(), matters()), false);
  assert.deepEqual(receiptCards([started(), noted()], matters(), new Set(['n-1']))[1], {
    type: 'receipt', id: 'a-6', kind: 'note', line: '记进「每周简报」：周报只发到飞书，不发邮件', undoable: true, undone: false, sessionId: 's-mydsh', turn: 6,
  });
  assert.deepEqual(activityView([started(), noted()], matters(), new Set()).map(entry => [entry.id, entry.undoable]), [['a-6', false], ['a-1', true]]);
});

test('undoing a note entry deletes the file it wrote, with the hash it wrote, and records the undo; a note without a file cannot be undone', () => {
  assert.deepEqual(noteFile(noted()), { matterId: 'm-brief', path: '定下的/周报只发到飞书.md', hash: 'h-1' });
  const refused = (run: () => unknown) => assert.throws(run, (error: unknown) => error instanceof RequestError && /撤不回/.test(error.message));
  refused(() => noteFile({ ...noted(), undoneAt: T2 }));
  refused(() => noteFile(started()));
  // A note from before 事项记忆 lived in notes.json; it has no file to delete.
  refused(() => noteFile(noteEntry({ id: 'a-7', at: T1, matterId: 'm-brief', matterName: '每周简报', note: { id: 'n-0', text: '旧的' } })));
  const { entries, record } = markUndone([started(), noted()], 'a-6', { id: 'a-9', at: T2 });
  assert.equal(entries.find(entry => entry.id === 'a-6')!.undoneAt, T2);
  assert.deepEqual(record, {
    id: 'a-9', at: T2, kind: 'undo', matterId: 'm-brief', matterName: '每周简报', text: '撤回了「每周简报」记忆里的：周报只发到飞书，不发邮件', why: '你点了撤回', undoes: 'a-6',
  });
  assert.throws(() => markUndone(entries, 'a-6', { id: 'a-10', at: T2 }), (error: unknown) => error instanceof RequestError && /撤不回/.test(error.message));
});

test('the per-turn context carries the last ten entries, newest first, with who did each and whether it was taken back', () => {
  const NOW = Date.parse('2026-11-09T06:00:00Z'); // 14:00 in Shanghai
  const clock = { now: NOW, timeZone: 'Asia/Shanghai' };
  const { entries: [start, undo] } = markUndone([{ ...started(), at: '2026-11-09T05:40:00.000Z' }], 'a-1', { id: 'a-9', at: '2026-11-09T05:45:00.000Z' });
  const yesterday = { ...filed(), at: '2026-11-08T09:00:00.000Z' };
  assert.deepEqual(recentActivity([yesterday, start!, undo!], clock).split('\n'), [
    '做事记录（最近 3 条，新的在前）：',
    '- 13:45 用户撤回：撤回了会话 整理周报（在「每周简报」）',
    '- 13:40 my dsh 开会话：在「每周简报」开了会话 整理周报（已撤回）',
    '- 11月8日 17:00 用户手动加入：把会话 草稿 加进「每周简报」',
  ]);
  const many = Array.from({ length: 12 }, (_, n) => ({ ...filed(), id: `a-${n}`, at: new Date(NOW - (12 - n) * 60_000).toISOString(), text: `第${n}条` }));
  const lines = recentActivity(many, clock).split('\n');
  assert.equal(lines[0], '做事记录（最近 10 条，新的在前）：');
  assert.equal(lines.length, 11);
  assert.match(lines[1]!, /第11条$/);
  assert.match(lines[10]!, /第2条$/);
  assert.equal(recentActivity([], clock), '');
  assert.deepEqual(recentActivity([{ ...noted(), at: '2026-11-09T05:50:00.000Z' }], clock).split('\n')[1],
    '- 13:50 my dsh 记进事项：记进「每周简报」：周报只发到飞书，不发邮件');
});

test('a pass to a matter says where the words went and how they start, keeps them whole, and cannot be undone', () => {
  const words = `把第三节改短一点，\n\n只留结论和数字，${'长'.repeat(80)}`;
  const entry = forwardEntry({ id: 'a-6', at: T1, matterId: 'm-brief', matterName: '每周简报', sessionId: 's-talk', words, why: '说的是周报', card: PLACE });
  assert.deepEqual({ ...entry, text: undefined }, {
    id: 'a-6', at: T1, kind: 'forward', matterId: 'm-brief', matterName: '每周简报', sessionId: 's-talk', why: '说的是周报', task: words, card: PLACE, text: undefined,
  });
  assert.match(entry.text, /^转给了「每周简报」：把第三节改短一点， 只留结论和数字，长+…$/);
  assert.equal([...entry.text.slice('转给了「每周简报」：'.length)].length, FORWARD_LINE);
  assert.equal(canUndo(entry, matters()), false);
  assert.throws(() => markUndone([entry], 'a-6', { id: 'a-7', at: T2 }), RequestError);
});

test('each pass leaves a 转给了 card under its turn; only the newest pass to a matter is the latest', () => {
  const pass = (id: string, matterId: string, matterName: string, at: string, turn: number) => forwardEntry({
    id, at, matterId, matterName, sessionId: `talk-${matterId}`, words: '看看到哪了', why: '', card: { sessionId: 's-mydsh', turn },
  });
  const card = (id: string, matterId: string, matterName: string, at: string, turn: number, latest: boolean) => ({
    type: 'forward', id, matterId, matterName, conversationId: `talk-${matterId}`, at: Date.parse(at), latest, sessionId: 's-mydsh', turn,
  });
  assert.deepEqual(receiptCards([pass('a-1', 'm-brief', '每周简报', T0, 1), pass('a-2', 'm-notes', '发布说明', T1, 2), pass('a-3', 'm-brief', '每周简报', T2, 3)], matters()), [
    card('a-1', 'm-brief', '每周简报', T0, 1, false), card('a-2', 'm-notes', '发布说明', T1, 2, true), card('a-3', 'm-brief', '每周简报', T2, 3, true),
  ]);
  const clock = { now: Date.parse('2026-11-09T06:00:00Z'), timeZone: 'Asia/Shanghai' };
  assert.equal(recentActivity([pass('a-9', 'm-brief', '每周简报', '2026-11-09T05:55:00.000Z', 5)], clock).split('\n')[1],
    '- 13:55 my dsh 转给事项：转给了「每周简报」：看看到哪了');
});

test('a memory change says which file changed how in which matter, and who changed it; it stays out of my dsh\'s per-turn context', () => {
  const base = { id: 'a-20', at: T1, matterId: 'm-brief', matterName: '每周简报', path: '坑/装完要重启.md' };
  assert.deepEqual(memoryEntry({ ...base, change: 'update', by: 'session', sessionId: 's-7', title: '整理周报' }), {
    id: 'a-20', at: T1, kind: 'memory', matterId: 'm-brief', matterName: '每周简报', text: '「每周简报」的记忆：改了 坑/装完要重启.md', why: '会话「整理周报」改的',
    memory: { path: '坑/装完要重启.md', change: 'update', by: 'session' }, sessionId: 's-7', title: '整理周报',
  });
  assert.equal(memoryEntry({ ...base, change: 'add', by: 'capture' }).text, '「每周简报」的记忆：新记了 坑/装完要重启.md');
  assert.equal(memoryEntry({ ...base, change: 'add', by: 'capture' }).why, '补记');
  assert.equal(memoryEntry({ ...base, change: 'delete', by: 'merge' }).why, '合并');
  assert.equal(memoryEntry({ ...base, change: 'update', by: 'user' }).why, '你在编辑器里改的');
  const entry = memoryEntry({ ...base, change: 'update', by: 'user' });
  assert.equal(canUndo(entry, matters()), false);
  assert.deepEqual(receiptCards([entry], matters()), []);
  const clock = { now: Date.parse('2026-11-09T06:00:00Z'), timeZone: 'Asia/Shanghai' };
  assert.equal(recentActivity([entry], clock), '');
  assert.equal(recentActivity([filed(), entry], clock).split('\n').length, 2);
});

test('an accepted suggestion of automatic grouping says what it made, and can be undone while its links are as it made them', () => {
  const T3 = '2026-11-09T04:00:00.000Z';
  const made: Matter = {
    id: 'm-new', name: 'chatbot 成本测算', goal: '', sessions: [link('s-1', 'model', T2, '都在算成本'), link('s-2', 'model', T2, '都在算成本')], aliases: [], sources: [],
    createdAt: T2,
  };
  const list = [...matters(), made];
  const created = groupEntry({
    id: 'a-9', at: T2, matterId: 'm-new', matterName: 'chatbot 成本测算', sessions: [{ id: 's-1', title: '年成本' }, { id: 's-2', title: '分档价格' }], created: true,
    by: 'model', why: '都在算成本',
  });
  assert.deepEqual(created, {
    id: 'a-9', at: T2, kind: 'group', matterId: 'm-new', matterName: 'chatbot 成本测算', sessions: ['s-1', 's-2'], created: true, by: 'model',
    text: '新起事项「chatbot 成本测算」，放进 2 个会话', why: '都在算成本',
  });
  assert.equal(canUndo(created, list), true);
  // Undoing takes the sessions out and removes the matter it made.
  const undone = undoChange(list, created);
  assert.equal(undone.matter, null);
  assert.deepEqual(undone.matters.map(matter => matter.id), ['m-brief', 'm-notes']);
  // Once something else was put in the matter or set on it, or one of its links changed, the matter stays the user's.
  assert.equal(canUndo(created, addSession(list, 'm-new', link('s-3', 'manual', T3)).matters), false);
  assert.equal(canUndo(created, list.map(matter => (matter.id === 'm-new' ? { ...matter, conversation: 's-conversation' } : matter))), false);
  assert.equal(canUndo(created, list.map(matter => (matter.id === 'm-new' ? { ...matter, sources: [{ kind: 'link' as const, value: 'https://e.com' }] } : matter))), false);
  assert.equal(canUndo(created, removeSession(list, 's-2').matters), false);
  assert.equal(markUndone([created], 'a-9', { id: 'u-1', at: T3 }).record.text, '撤回了新起的事项「chatbot 成本测算」');

  const filedOne = groupEntry({
    id: 'a-10', at: T2, matterId: 'm-notes', matterName: '发布说明', sessions: [{ id: 's-5', title: '核对版本号' }], created: false, by: 'origin', why: '在同一个分支 feat/x 上',
  });
  assert.deepEqual([filedOne.text, filedOne.sessionId, filedOne.title, filedOne.created], ['把会话 核对版本号 归进「发布说明」', 's-5', '核对版本号', undefined]);
  const withFiled = addSession(matters(), 'm-notes', { ...link('s-5', 'origin', T2, '在同一个分支 feat/x 上'), rule: 'branch' }).matters;
  assert.equal(canUndo(filedOne, withFiled), true);
  assert.equal(canUndo(filedOne, addSession(withFiled, 'm-brief', link('s-5', 'manual', T3)).matters), false);
  assert.deepEqual(undoChange(withFiled, filedOne).matter?.sessions, []);
  assert.equal(markUndone([filedOne], 'a-10', { id: 'u-2', at: T3 }).record.text, '把会话 核对版本号 移出「发布说明」');
  assert.match(recentActivity([filedOne], { now: Date.parse(T3), timeZone: 'UTC' }), /用户确认自动归类：把会话 核对版本号 归进「发布说明」/);
});
