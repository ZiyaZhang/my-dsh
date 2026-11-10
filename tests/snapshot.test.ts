import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Matter, SessionLink } from '../src/host/remote.ts';
import type { SessionView } from '../src/host/sessions.ts';
import { buildSnapshot, dayKey, type SnapshotInput } from '../src/host/snapshot.ts';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-09T06:00:00Z'); // 14:00 in Shanghai

const links = (...ids: string[]): SessionLink[] => ids.map(sessionId => ({ sessionId, by: 'manual', at: '2026-10-01T00:00:00Z' }));
const view = (id: string, lastActivity: string, overrides: Partial<SessionView> = {}): SessionView => ({
  id, title: id, blank: false, subagent: false, state: 'idle', lastActivity: at(lastActivity), ...overrides,
});

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  const matters: Matter[] = [
    { id: 'm-brief', name: '每周简报', goal: '每周五发一期', sessions: links('s-sort', 's-gone', 's-old'), aliases: [], sources: [], createdAt: '2026-10-01T00:00:00Z' },
    { id: 'm-notes', name: '发布说明', goal: '', sessions: links('s-ask'), aliases: [], sources: [], createdAt: '2026-10-02T00:00:00Z' },
    { id: 'm-empty', name: '看板', goal: '组里讨论', sessions: [], aliases: [], sources: [], createdAt: '2026-11-09T05:00:00Z' },
    { id: 'm-done', name: '第二期', goal: '', sessions: links('s-done'), aliases: [], sources: [], createdAt: '2026-09-01T00:00:00Z', archivedAt: '2026-10-20T00:00:00Z' },
    { id: 'm-done2', name: '第三期', goal: '', sessions: [], aliases: [], sources: [], createdAt: '2026-09-02T00:00:00Z', archivedAt: '2026-10-25T00:00:00Z' },
  ];
  const sessions: SessionView[] = [
    view('s-sort', '2026-11-09T05:30:00Z', { title: '整理周报', state: 'running' }),
    view('s-old', '2026-10-20T02:00:00Z', { title: '第一期发布' }),
    view('s-ask', '2026-11-09T04:00:00Z', { title: '核对版本号', state: 'waiting', wait: 'approval' }),
    view('s-done', '2026-11-08T02:00:00Z', { title: '第二期发布', state: 'failed' }),
    view('s-free', '2026-11-08T23:00:00Z', { title: null }),
    view('s-blank', '2026-11-09T05:59:00Z', { title: null, blank: true }),
    view('s-child', '2026-11-09T05:58:00Z', { subagent: true }),
    view('s-hidden', '2026-11-09T05:57:00Z', { title: '已归档的会话' }),
    view('s-edge', '2026-10-27T00:00:00Z', { title: '十三天前' }),
    view('s-far', '2026-10-26T12:00:00Z', { title: '十四天前' }),
    view('s-ahead', '2026-11-09T07:00:00Z', { title: '时钟快了' }),
    view('s-mydsh', '2026-11-09T05:59:30Z', { title: 'my dsh' }),
  ];
  return {
    matters, sessions, now: NOW, timeZone: 'Asia/Shanghai', assistant: { sessionId: 's-mydsh', cards: [] },
    workspaces: {
      workspaceOf: new Map([['s-sort', { id: 'w-brief', title: 'weekly-brief' }], ['s-ask', { id: 'w-notes', title: 'release-notes' }]]),
      archived: new Set(['s-hidden']),
      list: [{ id: 'w-brief', title: 'weekly-brief', path: '/work/weekly-brief' }, { id: 'w-notes', title: 'release-notes', path: '/work/release-notes' }],
    },
    ...overrides,
  };
}

test('a matter lists the sessions it knows, newest activity first, as the board shows them', () => {
  const { matters } = buildSnapshot(input());
  const brief = matters.find(matter => matter.id === 'm-brief')!;
  assert.deepEqual(brief.sessions, [
    { id: 's-sort', title: '整理周报', state: 'running', lastActivity: at('2026-11-09T05:30:00Z'), workspace: 'weekly-brief', workspaceId: 'w-brief' },
    { id: 's-old', title: '第一期发布', state: 'idle', lastActivity: at('2026-10-20T02:00:00Z') },
  ]);
  assert.equal(brief.lastActivity, at('2026-11-09T05:30:00Z'));
  const notes = matters.find(matter => matter.id === 'm-notes')!;
  assert.deepEqual(notes.sessions[0], { id: 's-ask', title: '核对版本号', state: 'waiting', wait: 'approval', lastActivity: at('2026-11-09T04:00:00Z'), workspace: 'release-notes', workspaceId: 'w-notes' });
  assert.equal(matters.find(matter => matter.id === 'm-empty')!.lastActivity, at('2026-11-09T05:00:00Z'));
});

test('in-progress matters come first by newest activity, then archived ones by newest archive', () => {
  const { matters } = buildSnapshot(input());
  assert.deepEqual(matters.map(matter => matter.id), ['m-brief', 'm-empty', 'm-notes', 'm-done2', 'm-done']);
  assert.equal(matters[3]!.archivedAt, '2026-10-25T00:00:00Z');
});

test('untitled sessions read as DSH names them: a blank one is a new session, others are untitled', () => {
  const sessions = [view('s-1', '2026-11-09T01:00:00Z', { title: null }), view('s-2', '2026-11-09T01:00:00Z', { title: null, blank: true })];
  const matters: Matter[] = [{ id: 'm-1', name: '发布说明', goal: '', sessions: links('s-1', 's-2'), aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z' }];
  const titles = buildSnapshot(input({ matters, sessions })).matters[0]!.sessions.map(session => session.title).sort();
  assert.deepEqual(titles, ['新会话', '未命名']);
});

test('a matter keeps a session archived in DSH and marks it', () => {
  const matters: Matter[] = [{ id: 'm-1', name: '发布说明', goal: '', sessions: links('s-hidden'), aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z' }];
  const [session] = buildSnapshot(input({ matters })).matters[0]!.sessions;
  assert.equal(session?.archived, true);
});

test('unassigned sessions leave out those in a matter, those DSH hides (archived, blank, subagent) and my dsh itself', () => {
  const { unassigned } = buildSnapshot(input());
  assert.deepEqual(unassigned.map(session => session.id), ['s-ahead', 's-free', 's-edge', 's-far']);
  assert.equal(unassigned[1]!.title, '未命名');
});

test('the review groups the last 14 local days, today first, newest first, with each session\'s matter', () => {
  const { review } = buildSnapshot(input());
  assert.deepEqual(review.map(day => [day.day, day.daysAgo]), [['2026-11-09', 0], ['2026-11-08', 1], ['2026-10-27', 13]]);
  assert.deepEqual(review[0]!.sessions.map(session => [session.id, session.matter?.name]), [
    ['s-ahead', undefined], ['s-sort', '每周简报'], ['s-ask', '发布说明'], ['s-free', undefined],
  ]);
  assert.deepEqual(review[1]!.sessions.map(session => [session.id, session.matter?.id]), [['s-done', 'm-done']]);
  assert.deepEqual(review[2]!.sessions.map(session => session.id), ['s-edge']);
});

test('day boundaries follow the time zone', () => {
  // 23:00 UTC on 11-08 is 07:00 on 11-09 in Shanghai.
  assert.equal(dayKey(at('2026-11-08T23:00:00Z'), 'Asia/Shanghai'), '2026-11-09');
  assert.equal(dayKey(at('2026-11-08T23:00:00Z'), 'UTC'), '2026-11-08');
  assert.equal(dayKey(at('2026-11-08T23:00:00Z'), 'America/Los_Angeles'), '2026-11-08');
  const { review } = buildSnapshot(input({ timeZone: 'UTC' }));
  assert.deepEqual(review.map(day => day.day), ['2026-11-09', '2026-11-08', '2026-10-27']);
  assert.deepEqual(review[1]!.sessions.map(session => session.id), ['s-free', 's-done']);
});

test('the snapshot carries the time it was taken, and my dsh with its cards', () => {
  const snapshot = buildSnapshot(input());
  assert.equal(snapshot.now, NOW);
  assert.deepEqual(snapshot.assistant, { sessionId: 's-mydsh', cards: [] });
});

test('matters carry their main workspace while it exists, their sources and instructions; the snapshot lists workspaces and the recent one', () => {
  const matters: Matter[] = [
    { id: 'm-1', name: '发布说明', goal: '', sessions: [], aliases: [], createdAt: '2026-11-01T00:00:00Z', workspaceId: 'w-notes',
      sources: [{ kind: 'pr', value: 'https://github.com/o/r/pull/1', title: 'o/r#1' }], instructions: '周五前发' },
    { id: 'm-2', name: '看板', goal: '', sessions: [], aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z', workspaceId: 'w-gone' },
  ];
  const snapshot = buildSnapshot(input({ matters }));
  const first = snapshot.matters.find(matter => matter.id === 'm-1')!;
  assert.deepEqual(first.workspace, { id: 'w-notes', title: 'release-notes' });
  assert.deepEqual(first.sources, [{ kind: 'pr', value: 'https://github.com/o/r/pull/1', title: 'o/r#1' }]);
  assert.equal(first.instructions, '周五前发');
  assert.equal(snapshot.matters.find(matter => matter.id === 'm-2')!.workspace, undefined);
  assert.deepEqual(snapshot.workspaces.map(workspace => workspace.id), ['w-brief', 'w-notes']);
  // s-sort (05:30) is the newest listed session in a workspace; s-ahead and s-free have none.
  assert.equal(snapshot.recentWorkspaceId, 'w-brief');
});

test('my dsh never shows on the board, even put in a matter', () => {
  const matters: Matter[] = [{ id: 'm-1', name: '发布说明', goal: '', sessions: links('s-mydsh'), aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z' }];
  const snapshot = buildSnapshot(input({ matters }));
  assert.deepEqual(snapshot.matters[0]!.sessions, []);
  assert.ok(!snapshot.review.some(day => day.sessions.some(session => session.id === 's-mydsh')));
});

test('sessions on the board carry their preview; the unassigned list, which the page does not show, leaves it out', () => {
  const sessions = input().sessions.map((item): SessionView => {
    if (item.id === 's-sort') return { ...item, preview: { kind: 'running', step: '运行命令 npm test', since: at('2026-11-09T05:40:00Z') } };
    if (item.id === 's-free') return { ...item, preview: { kind: 'reply', text: '整理完了' } };
    return item;
  });
  const snapshot = buildSnapshot(input({ sessions }));
  const brief = snapshot.matters.find(matter => matter.id === 'm-brief')!;
  assert.deepEqual(brief.sessions[0]!.preview, { kind: 'running', step: '运行命令 npm test', since: at('2026-11-09T05:40:00Z') });
  assert.equal(brief.sessions[1]!.preview, undefined);
  const today = snapshot.review[0]!.sessions;
  assert.deepEqual(today.find(session => session.id === 's-free')!.preview, { kind: 'reply', text: '整理完了' });
  assert.ok(snapshot.unassigned.every(session => session.preview === undefined));
});

test('等你处理 lists the sessions that wait or failed, the longest wait first, with their matter', () => {
  const sessions = input().sessions.map((item): SessionView => {
    if (item.id === 's-ask') return { ...item, preview: { kind: 'approval', tool: 'bash', since: at('2026-11-09T04:30:00Z') } };
    if (item.id === 's-done') return { ...item, preview: { kind: 'failed', error: '构建没过' } };
    if (item.id === 's-free') return { ...item, state: 'waiting', wait: 'question', preview: { kind: 'question', text: '要不要重跑？', since: at('2026-11-09T05:55:00Z') } };
    // DSH hides these, and my dsh is never on the board.
    if (item.id === 's-hidden' || item.id === 's-child' || item.id === 's-mydsh') return { ...item, state: 'waiting', wait: 'question' };
    return item;
  });
  const { attention } = buildSnapshot(input({ sessions }));
  assert.deepEqual(attention.map(session => [session.id, session.state, session.matter?.name]), [
    ['s-done', 'failed', '第二期'], ['s-ask', 'waiting', '发布说明'], ['s-free', 'waiting', undefined],
  ]);
  assert.deepEqual(attention[1]!.preview, { kind: 'approval', tool: 'bash', since: at('2026-11-09T04:30:00Z') });
});
