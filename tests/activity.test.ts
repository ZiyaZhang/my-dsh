import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestError, type ActivityEntry, type Matter, type SessionLink } from '../src/host/remote.ts';
import {
  ACTIVITY_MAX, activityView, appendActivity, canUndo, fileEntry, markUndone, receiptCards, recentActivity, sendEntry, startEntry, undoChange, unfileEntry,
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
});
