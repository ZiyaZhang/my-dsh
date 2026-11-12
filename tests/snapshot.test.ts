import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Suggestion } from '../src/host/grouping.ts';
import type { Matter, SessionLink } from '../src/host/remote.ts';
import type { SessionView } from '../src/host/sessions.ts';
import { buildSnapshot, dayKey, hostingPresets, matterSchedules, type ScheduleEntry, type SnapshotInput } from '../src/host/snapshot.ts';

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
    matters, sessions, now: NOW, timeZone: 'Asia/Shanghai', assistant: { sessionId: 's-mydsh', cards: [] }, presets: [], replies: new Map(), schedules: [],
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
    { id: 's-sort', title: '整理周报', state: 'running', lastActivity: at('2026-11-09T05:30:00Z'), workspace: 'weekly-brief', workspaceId: 'w-brief', by: 'manual' },
    { id: 's-old', title: '第一期发布', state: 'idle', lastActivity: at('2026-10-20T02:00:00Z'), by: 'manual' },
  ]);
  assert.equal(brief.lastActivity, at('2026-11-09T05:30:00Z'));
  const notes = matters.find(matter => matter.id === 'm-notes')!;
  assert.deepEqual(notes.sessions[0], {
    id: 's-ask', title: '核对版本号', state: 'waiting', wait: 'approval', lastActivity: at('2026-11-09T04:00:00Z'), workspace: 'release-notes', workspaceId: 'w-notes',
    by: 'manual',
  });
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

test('a hosted matter carries its preset; a matter\'s sessions say how they joined; the snapshot lists the presets to host under', () => {
  const matters: Matter[] = [
    { id: 'm-1', name: '发布说明', goal: '', aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z', hosting: { preset: 'workspace-write', at: '2026-11-09T01:00:00Z' },
      sessions: [{ sessionId: 's-sort', by: 'mydsh', at: '2026-11-09T01:00:00Z', why: '派到这里' }, ...links('s-old')] },
    { id: 'm-2', name: '看板', goal: '', sessions: [], aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z' },
  ];
  const presets = [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }];
  const snapshot = buildSnapshot(input({ matters, presets }));
  const hosted = snapshot.matters.find(matter => matter.id === 'm-1')!;
  assert.deepEqual(hosted.hosting, { preset: 'workspace-write' });
  assert.deepEqual(hosted.sessions.map(session => [session.id, session.by]), [['s-sort', 'mydsh'], ['s-old', 'manual']]);
  assert.ok(!('hosting' in snapshot.matters.find(matter => matter.id === 'm-2')!));
  assert.deepEqual(snapshot.presets, presets);
  // Sessions outside a matter's list say nothing about how they joined.
  assert.ok(snapshot.review.flatMap(day => day.sessions).every(session => !('by' in session)));
  assert.deepEqual(buildSnapshot(input()).presets, []);
});

test('the presets to host under leave out the values DSH reserves, and carry only the value and the name', () => {
  assert.deepEqual(hostingPresets([
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace.' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    { value: 'auto', name: 'auto' },
    { value: 'custom', name: 'custom' },
  ]), [
    { value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' },
  ]);
});

/** 发布说明 with its own conversation `s-talk`, and 看板, whose conversation DSH no longer lists. */
const withConversations = (): Matter[] => [
  { id: 'm-1', name: '发布说明', goal: '', sessions: links('s-sort'), aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z', conversation: 's-talk' },
  { id: 'm-2', name: '看板', goal: '', sessions: [], aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z', conversation: 's-gone' },
];
const talk = (overrides: Partial<SessionView> = {}) => [...input().sessions, view('s-talk', '2026-11-09T05:50:00Z', { title: '发布说明', ...overrides })];

test('a matter\'s conversation shows on its matter with its state, line and reply, and stays out of the unassigned list and the review', () => {
  const sessions = talk({ preview: { kind: 'reply', text: '派了一条会话去跑测试' } });
  const snapshot = buildSnapshot(input({ matters: withConversations(), sessions, replies: new Map([['s-talk', '派了一条会话去跑测试，跑完告诉你。']]) }));
  const matter = snapshot.matters.find(candidate => candidate.id === 'm-1')!;
  assert.deepEqual(matter.conversation, {
    sessionId: 's-talk', state: 'idle', line: '派了一条会话去跑测试', lineAt: at('2026-11-09T05:50:00Z'), reply: '派了一条会话去跑测试，跑完告诉你。',
    replyAt: at('2026-11-09T05:50:00Z'),
  });
  // Without the whole reply, which only this process keeps, the line still says when it is from.
  const cold = buildSnapshot(input({ matters: withConversations(), sessions }));
  assert.deepEqual(cold.matters.find(candidate => candidate.id === 'm-1')!.conversation, {
    sessionId: 's-talk', state: 'idle', line: '派了一条会话去跑测试', lineAt: at('2026-11-09T05:50:00Z'),
  });
  assert.deepEqual(matter.sessions.map(session => session.id), ['s-sort']);
  // A conversation DSH does not list shows none; opening the matter makes a new one.
  assert.ok(!('conversation' in snapshot.matters.find(candidate => candidate.id === 'm-2')!));
  assert.ok(!snapshot.unassigned.some(session => session.id === 's-talk'));
  assert.ok(!snapshot.review.some(day => day.sessions.some(session => session.id === 's-talk')));
  // In a turn it says so, without the reply of the turn before.
  const running = buildSnapshot(input({
    matters: withConversations(), sessions: talk({ state: 'running', preview: { kind: 'running' } }), replies: new Map([['s-talk', '上一轮的回复']]),
  }));
  assert.deepEqual(running.matters.find(candidate => candidate.id === 'm-1')!.conversation, { sessionId: 's-talk', state: 'running', running: true });
  // Archived in DSH, it is not the matter's conversation any more.
  const archived = buildSnapshot(input({ matters: withConversations(), sessions, workspaces: { ...input().workspaces, archived: new Set(['s-talk']) } }));
  assert.ok(!('conversation' in archived.matters.find(candidate => candidate.id === 'm-1')!));
});

test('a matter\'s conversation that waits or failed is in 等你处理 as 对话 with its matter; my dsh\'s own session still is not', () => {
  const sessions = talk({ state: 'waiting', wait: 'approval', preview: { kind: 'approval', tool: 'bash', since: at('2026-11-09T05:45:00Z') } })
    .map(item => (item.id === 's-mydsh' ? { ...item, state: 'waiting' as const, wait: 'question' as const } : item));
  const { attention } = buildSnapshot(input({ matters: withConversations(), sessions }));
  const row = attention.find(session => session.id === 's-talk');
  assert.deepEqual(row && { title: row.title, state: row.state, wait: row.wait, matter: row.matter }, {
    title: '对话', state: 'waiting', wait: 'approval', matter: { id: 'm-1', name: '发布说明' },
  });
  assert.deepEqual(row?.preview, { kind: 'approval', tool: 'bash', since: at('2026-11-09T05:45:00Z') });
  assert.ok(!attention.some(session => session.id === 's-mydsh'));
  const idle = buildSnapshot(input({ matters: withConversations(), sessions: talk() }));
  assert.ok(!idle.attention.some(session => session.id === 's-talk'));
});

test('a matter\'s schedules are DSH\'s tasks that deliver to its conversation or involve it, without ended ones, with the next run while active', () => {
  const entries: ScheduleEntry[] = [
    { id: 'sc-1', title: '每周五汇总这周做了什么', status: 'active', scheduledAt: '2026-11-13T10:00:00.000Z', target: { kind: 'session', sessionId: 's-talk' }, involvedSessionIds: ['s-talk'] },
    { id: 'sc-2', title: 'Atlas 发新版时出一份报告', status: 'paused', scheduledAt: '2026-11-10T01:00:00.000Z', target: { kind: 'new' }, involvedSessionIds: ['s-talk'] },
    { id: 'sc-3', title: '已经提醒过的', status: 'ended', scheduledAt: '2026-11-01T01:00:00.000Z', target: { kind: 'session', sessionId: 's-talk' }, involvedSessionIds: [] },
    { id: 'sc-4', title: '别的会话的', status: 'active', scheduledAt: '2026-11-12T01:00:00.000Z', target: { kind: 'session', sessionId: 's-other' }, involvedSessionIds: ['s-other'] },
    { id: 'sc-5', title: '只投给它', status: 'active', scheduledAt: 'not a time', target: { kind: 'session', sessionId: 's-talk' }, involvedSessionIds: [] },
  ];
  assert.deepEqual(matterSchedules(entries, 's-talk'), [
    { id: 'sc-1', title: '每周五汇总这周做了什么', status: 'active', next: Date.parse('2026-11-13T10:00:00.000Z') },
    { id: 'sc-2', title: 'Atlas 发新版时出一份报告', status: 'paused' },
    { id: 'sc-5', title: '只投给它', status: 'active' },
  ]);
  const snapshot = buildSnapshot(input({ matters: withConversations(), sessions: talk(), schedules: entries }));
  assert.deepEqual(snapshot.matters.find(candidate => candidate.id === 'm-1')!.schedules?.map(item => item.id), ['sc-1', 'sc-2', 'sc-5']);
  assert.ok(!('schedules' in snapshot.matters.find(candidate => candidate.id === 'm-2')!));
});

test('my dsh never shows on the board, even put in a matter', () => {
  const matters: Matter[] = [{ id: 'm-1', name: '发布说明', goal: '', sessions: links('s-mydsh'), aliases: [], sources: [], createdAt: '2026-11-01T00:00:00Z' }];
  const snapshot = buildSnapshot(input({ matters }));
  assert.deepEqual(snapshot.matters[0]!.sessions, []);
  assert.ok(!snapshot.review.some(day => day.sessions.some(session => session.id === 's-mydsh')));
});

test('sessions on the board carry their preview, the unassigned ones too (跟进中 shows their line)', () => {
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
  assert.deepEqual(snapshot.unassigned.find(session => session.id === 's-free')?.preview, { kind: 'reply', text: '整理完了' });
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

test('the snapshot carries the pending suggestions whose sessions are all still loose, with what the card shows of them', () => {
  const pending = (id: string, change: Suggestion['change'], extra: Partial<Suggestion> = {}): Suggestion => ({
    id, change, why: '在做同一件事', by: 'model', at: '2026-11-09T00:00:00Z', state: 'pending', ...extra,
  });
  const suggestions: Suggestion[] = [
    pending('g-1', { kind: 'new', sessionIds: ['s-edge', 's-free'], name: '方案', goal: '' }),
    pending('g-2', { kind: 'file', sessionId: 's-ahead', matterId: 'm-notes' }, { by: 'origin', rule: 'pr', why: '和「发布说明」处理的是同一个 PR a/b#1' }),
    // A session in a matter, one archived in DSH, a subagent, a matter archived, my dsh's own session: none of these is on the card.
    pending('g-3', { kind: 'new', sessionIds: ['s-far', 's-sort'], name: '甲', goal: '' }),
    pending('g-4', { kind: 'file', sessionId: 's-hidden', matterId: 'm-notes' }),
    pending('g-5', { kind: 'new', sessionIds: ['s-far', 's-child'], name: '乙', goal: '' }),
    pending('g-6', { kind: 'file', sessionId: 's-far', matterId: 'm-done' }),
    pending('g-7', { kind: 'file', sessionId: 's-mydsh', matterId: 'm-notes' }),
  ];
  const snapshot = buildSnapshot(input({ suggestions }));
  assert.deepEqual(snapshot.suggestions, [
    {
      id: 'g-1', kind: 'new', name: '方案', why: '在做同一件事',
      sessions: [{ id: 's-free', title: '未命名', lastActivity: at('2026-11-08T23:00:00Z') }, { id: 's-edge', title: '十三天前', lastActivity: at('2026-10-27T00:00:00Z') }],
    },
    {
      id: 'g-2', kind: 'file', matter: { id: 'm-notes', name: '发布说明' }, why: '和「发布说明」处理的是同一个 PR a/b#1',
      sessions: [{ id: 's-ahead', title: '时钟快了', lastActivity: at('2026-11-09T07:00:00Z') }],
    },
  ]);
  // A filing into a matter the user took the session out of by hand goes; with nothing pending there is no list.
  assert.equal(buildSnapshot(input({ suggestions: [suggestions[1]!], takenOut: new Set(['s-ahead>m-notes']) })).suggestions, undefined);
  assert.equal(buildSnapshot(input()).suggestions, undefined);
  // A new matter's main workspace is where most of its sessions are.
  const placed = buildSnapshot(input({
    suggestions: [pending('g-8', { kind: 'new', sessionIds: ['s-free', 's-ahead'], name: '方案', goal: '写清方案' })],
    workspaces: { ...input().workspaces, workspaceOf: new Map([['s-ahead', { id: 'w-notes', title: 'release-notes' }]]) },
  }));
  assert.deepEqual([placed.suggestions?.[0]?.workspace, placed.suggestions?.[0]?.goal], [{ id: 'w-notes', title: 'release-notes' }, '写清方案']);
});
