import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardMatter, BoardSession, ReviewSession } from '../src/host/remote.ts';
import { columnCounts, dayOpen, followRows, waitingRows } from '../src/client/rows.ts';

const NOW = Date.parse('2026-11-09T06:00:00Z');
const MINUTE = 60_000;

const session = (id: string, overrides: Partial<BoardSession> = {}): BoardSession => ({
  id, title: id, state: 'idle', lastActivity: NOW - 60 * MINUTE, ...overrides,
});
const matter = (id: string, name: string, sessions: BoardSession[], overrides: Partial<BoardMatter> = {}): BoardMatter => ({
  id, name, goal: '', sources: [], createdAt: '2026-11-01T00:00:00Z', sessions,
  lastActivity: sessions[0]?.lastActivity ?? Date.parse('2026-11-01T00:00:00Z'), ...overrides,
});

test('回顾 opens 今天 and 昨天 and folds older days, until the user toggles a day', () => {
  assert.equal(dayOpen({ day: '2026-11-09', daysAgo: 0 }, {}), true);
  assert.equal(dayOpen({ day: '2026-11-08', daysAgo: 1 }, {}), true);
  assert.equal(dayOpen({ day: '2026-11-06', daysAgo: 3 }, {}), false);
  assert.equal(dayOpen({ day: '2026-11-08', daysAgo: 1 }, { '2026-11-08': false }), false);
  assert.equal(dayOpen({ day: '2026-11-06', daysAgo: 3 }, { '2026-11-06': true }), true);
});

test('跟进事项 has each matter in progress, its newest activity and a line about its newest session', () => {
  const matters = [
    matter('m-1', '每周简报', [
      session('s-1', { title: '整理周报', state: 'running', lastActivity: NOW - 2 * MINUTE, preview: { kind: 'running', step: '运行命令 npm test', since: NOW - 3 * MINUTE } }),
      session('s-2', { title: '第三期发布', state: 'waiting', wait: 'question', preview: { kind: 'question', text: '要不要重跑？', since: NOW - 30 * MINUTE } }),
    ]),
    matter('m-2', '发布说明', [session('s-3', { title: '核对版本号', preview: { kind: 'reply', text: '版本号都对上了。' } })]),
    matter('m-3', '看板', [session('s-4', { title: '旧会话' })]),
    matter('m-4', '方案', []),
    matter('m-5', '第二期', [session('s-5')], { archivedAt: '2026-11-02T00:00:00Z' }),
  ];
  assert.deepEqual(followRows(matters, NOW), [
    { id: 'm-1', name: '每周简报', lastActivity: NOW - 2 * MINUTE, state: 'running', line: '整理周报 · 正在：运行命令 npm test · 3 分钟' },
    { id: 'm-2', name: '发布说明', lastActivity: NOW - 60 * MINUTE, state: 'idle', line: '核对版本号 · 版本号都对上了。' },
    { id: 'm-3', name: '看板', lastActivity: NOW - 60 * MINUTE, state: 'idle', line: '旧会话' },
    { id: 'm-4', name: '方案', lastActivity: Date.parse('2026-11-01T00:00:00Z'), line: '还没有会话' },
  ]);
});

test('等你处理 gives each session its title, matter, when it began to need you and its line', () => {
  const sessions: ReviewSession[] = [
    { ...session('s-1', { title: '整理周报', state: 'failed', lastActivity: NOW - 120 * MINUTE, preview: { kind: 'failed', error: '构建没过' } }), matter: { id: 'm-1', name: '每周简报' } },
    session('s-2', { title: '核对版本号', state: 'waiting', wait: 'approval', preview: { kind: 'approval', tool: 'bash', since: NOW - 10 * MINUTE } }),
    session('s-3', { title: '第三期发布', state: 'waiting', wait: 'question' }),
  ];
  assert.deepEqual(waitingRows(sessions, NOW), [
    { id: 's-1', title: '整理周报', state: 'failed', matter: { id: 'm-1', name: '每周简报' }, at: NOW - 120 * MINUTE, line: '失败：构建没过' },
    { id: 's-2', title: '核对版本号', state: 'waiting', at: NOW - 10 * MINUTE, line: '在等你批准：bash' },
    { id: 's-3', title: '第三期发布', state: 'waiting', at: NOW - 60 * MINUTE, line: '在等你回答' },
  ]);
});

test('a matter counts its sessions the way its columns hold them, failed ones with the idle', () => {
  const sessions = [session('a', { state: 'waiting' }), session('b', { state: 'running' }), session('c', { state: 'failed' }), session('d')];
  assert.deepEqual(columnCounts(sessions), { waiting: 1, running: 1, idle: 2 });
  assert.deepEqual(columnCounts([]), { waiting: 0, running: 0, idle: 0 });
});
