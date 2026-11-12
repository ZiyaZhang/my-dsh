import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardMatter, BoardSession, BoardSnapshot, ConversationView, MemoryView, ReviewSession, SuggestionView } from '../src/host/remote.ts';
import {
  HOME_CARD_SHOWN, IDLE_SHOWN, columnCounts, contextSummary, dayOpen, dispatchedSessions, daysUsed, foldHomeCard, foldIdle, followRows, forwardState, homeCardRows,
  homeStats, tokenText, lineOf, matterCounts, sessionArea, suggestionTitle, waitingRows,
} from '../src/client/rows.ts';

const NOW = Date.parse('2026-11-09T06:00:00Z');
const MINUTE = 60_000;

const session = (id: string, overrides: Partial<BoardSession> = {}): BoardSession => ({
  id, title: id, state: 'idle', lastActivity: NOW - 60 * MINUTE, ...overrides,
});
const matter = (id: string, name: string, sessions: BoardSession[], overrides: Partial<BoardMatter> = {}): BoardMatter => ({
  id, name, goal: '', sources: [], createdAt: '2026-11-01T00:00:00Z', sessions,
  lastActivity: sessions[0]?.lastActivity ?? Date.parse('2026-11-01T00:00:00Z'), ...overrides,
});

test('回顾 opens 今天 and folds the older days, until the user toggles a day', () => {
  assert.equal(dayOpen({ day: '2026-11-09', daysAgo: 0 }, {}), true);
  assert.equal(dayOpen({ day: '2026-11-08', daysAgo: 1 }, {}), false);
  assert.equal(dayOpen({ day: '2026-11-06', daysAgo: 3 }, {}), false);
  assert.equal(dayOpen({ day: '2026-11-09', daysAgo: 0 }, { '2026-11-09': false }), false);
  assert.equal(dayOpen({ day: '2026-11-06', daysAgo: 3 }, { '2026-11-06': true }), true);
});

test('回顾 marks the sessions the tools put in a matter as dispatched, and no others', () => {
  const matters = [
    matter('m-1', 'OpenCodex 跟进', [session('a', { by: 'mydsh' }), session('b', { by: 'manual' }), session('c')]),
    matter('m-2', '方案', [session('d', { by: 'mydsh' }), session('e', { by: 'origin' })]),
  ];
  assert.deepEqual([...dispatchedSessions(matters)].sort(), ['a', 'd']);
  assert.equal(dispatchedSessions([]).size, 0);
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

test('待处理 gives each session its title, matter, when it began to need you and its line', () => {
  const sessions: ReviewSession[] = [
    { ...session('s-1', { title: '整理周报', state: 'failed', lastActivity: NOW - 120 * MINUTE, preview: { kind: 'failed', error: '构建没过' } }), matter: { id: 'm-1', name: '每周简报' } },
    session('s-2', { title: '核对版本号', state: 'waiting', wait: 'approval', preview: { kind: 'approval', tool: 'bash', since: NOW - 10 * MINUTE } }),
    session('s-3', { title: '第三期发布', state: 'waiting', wait: 'question' }),
  ];
  assert.deepEqual(waitingRows(sessions, NOW), [
    { id: 's-1', title: '整理周报', state: 'failed', matter: { id: 'm-1', name: '每周简报' }, at: NOW - 120 * MINUTE, line: '失败：构建没过' },
    { id: 's-2', title: '核对版本号', state: 'waiting', at: NOW - 10 * MINUTE, line: '等待审批：bash' },
    { id: 's-3', title: '第三期发布', state: 'waiting', at: NOW - 60 * MINUTE, line: '等待回答' },
  ]);
});

test('a matter counts its sessions the way its columns hold them, failed ones with the idle', () => {
  const sessions = [session('a', { state: 'waiting' }), session('b', { state: 'running' }), session('c', { state: 'failed' }), session('d')];
  assert.deepEqual(columnCounts(sessions), { waiting: 1, running: 1, idle: 2 });
  assert.deepEqual(columnCounts([]), { waiting: 0, running: 0, idle: 0 });
});

test('a matter\'s session area puts what waits, failed or runs on cards, waiting first, then failed, then running, and the rest in rows', () => {
  const sessions = [
    session('run-old', { state: 'running', lastActivity: NOW - 30 * MINUTE }),
    session('ask-recent', { state: 'waiting', wait: 'question', preview: { kind: 'question', text: '要不要重跑？', since: NOW - 5 * MINUTE } }),
    session('idle-old', { lastActivity: NOW - 120 * MINUTE }),
    session('failed-recent', { state: 'failed', lastActivity: NOW - 2 * MINUTE }),
    session('ask-long', { state: 'waiting', wait: 'approval', preview: { kind: 'approval', tool: 'bash', since: NOW - 50 * MINUTE } }),
    session('run-new', { state: 'running', lastActivity: NOW - MINUTE }),
    session('failed-long', { state: 'failed', lastActivity: NOW - 90 * MINUTE }),
    session('idle-new', { lastActivity: NOW - 3 * MINUTE }),
    session('gone', { state: 'waiting', archived: true }),
  ];
  const { cards, idle } = sessionArea(sessions);
  // Those that need the user the longest wait first; the running ones the newest activity first.
  assert.deepEqual(cards.map(card => card.session.id), ['ask-long', 'ask-recent', 'failed-long', 'failed-recent', 'run-new', 'run-old']);
  assert.ok(cards.every(card => card.conversation === undefined));
  assert.deepEqual(idle.map(item => item.id), ['idle-new', 'idle-old']);
  assert.deepEqual(sessionArea([]), { cards: [], idle: [] });
});

test('the matter\'s conversation is a card while it waits or failed, ordered with the others, and is left out otherwise', () => {
  const sessions = [
    session('ask', { state: 'waiting', wait: 'question', preview: { kind: 'question', text: '先跟哪个？', since: NOW - 20 * MINUTE } }),
    session('run', { state: 'running', lastActivity: NOW - MINUTE }),
  ];
  const asking = session('s-talk', { title: '对话', state: 'waiting', wait: 'approval', preview: { kind: 'approval', tool: 'bash', since: NOW - 40 * MINUTE } });
  assert.deepEqual(sessionArea(sessions, asking).cards.map(card => [card.session.id, card.conversation ?? false]), [
    ['s-talk', true], ['ask', false], ['run', false],
  ]);
  const failed = session('s-talk', { title: '对话', state: 'failed', lastActivity: NOW - 5 * MINUTE });
  assert.deepEqual(sessionArea(sessions, failed).cards.map(card => card.session.id), ['ask', 's-talk', 'run']);
  for (const state of ['running', 'idle'] as const) {
    assert.ok(!sessionArea(sessions, session('s-talk', { state })).cards.some(card => card.conversation), state);
  }
});

test('idle rows show the first five until 更早 is opened, with how many more there are', () => {
  const rows = Array.from({ length: 8 }, (_, n) => `s-${n}`);
  assert.deepEqual(foldIdle(rows, false), { rows: rows.slice(0, IDLE_SHOWN), rest: 3 });
  assert.deepEqual(foldIdle(rows, true), { rows, rest: 3 });
  assert.deepEqual(foldIdle(rows.slice(0, 5), false), { rows: rows.slice(0, 5), rest: 0 });
  assert.deepEqual(foldIdle([], false), { rows: [], rest: 0 });
  assert.equal(IDLE_SHOWN, 5);
});

test('a pass shows the conversation\'s reply once a turn ended after the words went, what it waits for or failed on, that it answers, or that it has not started', () => {
  const at = NOW - 10 * MINUTE;
  const view = (overrides: Partial<ConversationView> = {}): ConversationView => ({ sessionId: 's-talk', state: 'idle', ...overrides });
  assert.deepEqual(forwardState(undefined, undefined, at, NOW), { kind: 'queued' });
  // The reply from before the words went is not the answer.
  assert.deepEqual(forwardState(view({ line: '上一轮', lineAt: at - MINUTE, reply: '上一轮的回复', replyAt: at - MINUTE }), undefined, at, NOW), { kind: 'queued' });
  assert.deepEqual(forwardState(view({ state: 'running', running: true }), undefined, at, NOW), { kind: 'running' });
  assert.deepEqual(forwardState(view({ line: '0.4.0 装上了', lineAt: at + MINUTE, reply: '0.4.0 装上了，在 desktop profile。', replyAt: at + MINUTE }), undefined, at, NOW),
    { kind: 'reply', text: '0.4.0 装上了，在 desktop profile。', line: '0.4.0 装上了', at: at + MINUTE });
  // After a restart the Host has only the line.
  assert.deepEqual(forwardState(view({ line: '0.4.0 装上了', lineAt: at + MINUTE }), undefined, at, NOW), { kind: 'reply', text: '0.4.0 装上了', line: '0.4.0 装上了', at: at + MINUTE });
  const asking = session('s-talk', { title: '对话', state: 'waiting', wait: 'approval', preview: { kind: 'approval', tool: 'write', since: at + MINUTE } });
  assert.deepEqual(forwardState(view({ state: 'waiting', wait: 'approval' }), asking, at, NOW), { kind: 'waiting', line: lineOf(asking, NOW) });
  assert.deepEqual(forwardState(view({ state: 'waiting', wait: 'approval' }), undefined, at, NOW), { kind: 'waiting', line: '等待审批' });
  assert.deepEqual(forwardState(view({ state: 'failed' }), undefined, at, NOW), { kind: 'failed', line: '失败' });
});

const memory = (count: number): MemoryView => ({
  dir: '/w/.my-dsh/m/memory', flagged: [],
  rows: Array.from({ length: count }, (_, index) => ({ path: `规则/${index}.md`, category: '规则', description: `第 ${index} 条` })),
});

test('my dsh\'s head shows the days, tokens and plugins the Host read, then the matters in progress', () => {
  const snapshot: BoardSnapshot = {
    matters: [
      matter('m-1', 'OpenCodex 跟进', [], { memory: memory(3) }),
      matter('m-2', 'chatbot 成本测算', []),
      matter('m-3', '第二期', [], { archivedAt: '2026-11-02T00:00:00Z', memory: memory(5) }),
    ],
    unassigned: [],
    review: [
      { day: '2026-11-09', daysAgo: 0, sessions: [session('a'), session('b', { state: 'running' }), session('c', { state: 'waiting' }), session('d')] },
      { day: '2026-11-08', daysAgo: 1, sessions: [session('e')] },
    ],
    attention: [session('c', { state: 'waiting' }), { ...session('f', { state: 'failed' }), matter: { id: 'm-1', name: 'OpenCodex 跟进' } }],
    assistant: { sessionId: 's-mydsh', cards: [] }, workspaces: [], presets: [], now: NOW,
  };
  assert.deepEqual(homeStats(snapshot, NOW), [{ key: 'matters', value: '2', after: '个事项' }]);
  const used = homeStats({ ...snapshot, usage: { firstSessionAt: NOW - 3 * 86_400_000, sessions: 329, tokens: 123_456_789, tokenSessions: 329, plugins: 5 } }, NOW);
  assert.deepEqual(used.map(stat => [stat.key, stat.before ?? '', stat.value, stat.after]), [
    ['days', '用了', '4', '天'], ['sessions', '', '329', '个会话'], ['tokens', '', '1.23 亿', 'token'], ['plugins', '', '5', '个插件'], ['matters', '', '2', '个事项'],
  ]);
  assert.equal(used[2]!.title, '所有会话共 123,456,789 token，不含子智能体');
  const partial = homeStats({ ...snapshot, usage: { sessions: 329, tokens: 98_765_432, tokenSessions: 105 } }, NOW).find(stat => stat.key === 'tokens')!;
  assert.equal(partial.before, '至少');
  assert.equal(partial.title, '105 个会话有用量记录，共 98,765,432 token；另有 224 个会话（旧格式或分叉出来的）没有算进来');
  assert.equal(homeStats({ ...snapshot, usage: { sessions: 3, tokens: 0, tokenSessions: 0 } }, NOW).some(stat => stat.key === 'tokens'), false);
});

test('a matter\'s head counts its sessions, archived ones left out, and its memory entries', () => {
  assert.deepEqual(matterCounts(matter('m-1', 'OpenCodex 跟进', [session('a'), session('b', { archived: true }), session('c', { state: 'running' })], { memory: memory(11) })),
    { sessions: 2, memory: 11 });
  assert.deepEqual(matterCounts(matter('m-2', '方案', [])), { sessions: 0, memory: 0 });
});

test('the card under my dsh\'s input lists what waits for an approval or an answer, then what failed, each in 待处理\'s order', () => {
  const opencodex = { id: 'm-1', name: 'OpenCodex 跟进' };
  const attention: ReviewSession[] = [
    { ...session('f-1', { title: '构建', state: 'failed' }), matter: opencodex },
    session('q-1', { title: '年度成本与新方案', state: 'waiting', wait: 'question' }),
    { ...session('a-1', { title: '实现 · 功能开关注册表有变化', state: 'waiting', wait: 'approval' }), matter: opencodex },
    session('f-2', { title: '整理周报', state: 'failed' }),
  ];
  assert.deepEqual(homeCardRows(attention), [
    { kind: 'waiting', id: 'q-1', failed: false, word: '等待回答', title: '年度成本与新方案' },
    { kind: 'waiting', id: 'a-1', failed: false, word: '等待审批', title: '实现 · 功能开关注册表有变化', matter: opencodex },
    { kind: 'waiting', id: 'f-1', failed: true, word: '失败', title: '构建', matter: opencodex },
    { kind: 'waiting', id: 'f-2', failed: true, word: '失败', title: '整理周报' },
  ]);
  assert.deepEqual(homeCardRows([]), []);
  assert.equal(HOME_CARD_SHOWN, 3);
});

test('a matter\'s context rows say the first line of its instructions and how many sources, memory entries and written files it has', () => {
  const full = matter('m-1', 'OpenCodex 跟进', [], {
    instructions: '\n  只做不改 DSH 核心的功能；每个功能做成独立插件\n挑值得做的', sources: [{ kind: 'folder', value: '/w/reports' }, { kind: 'link', value: 'https://example.com' }],
    memory: { ...memory(11), mergedAt: '2026-11-09T01:29:00Z' },
    artifacts: [
      { path: 'report.md', label: 'report.md', folder: false, files: 1, sessionId: 's-1', title: '0.163 报告', at: NOW },
      { path: 'dsh-tool-list-worktrees', label: 'dsh-tool-list-worktrees/', folder: true, files: 6, sessionId: 's-2', title: '实现', at: NOW },
    ],
  });
  assert.deepEqual(contextSummary(full), {
    instructions: '只做不改 DSH 核心的功能；每个功能做成独立插件', sources: 2, memory: 11, merged: { at: Date.parse('2026-11-09T01:29:00Z') }, files: 7,
  });
  assert.deepEqual(contextSummary(matter('m-2', '方案', [])), { instructions: '', sources: 0, memory: 0, merged: undefined, files: 0 });
  assert.deepEqual(contextSummary(matter('m-3', '整理中', [], { memory: { ...memory(2), merging: true, mergedAt: '2026-11-09T01:29:00Z' } })).merged, { now: true });
});

test('days in use count calendar days with the first one; tokens read in 万 and 亿', () => {
  const at = (iso: string) => new Date(iso).getTime();
  assert.equal(daysUsed(at('2026-11-09T23:00:00'), at('2026-11-09T23:30:00')), 1);
  assert.equal(daysUsed(at('2026-11-09T23:00:00'), at('2026-11-10T00:30:00')), 2);
  assert.equal(daysUsed(at('2026-07-22T09:00:00'), at('2026-11-12T08:00:00')), 114);
  assert.equal(tokenText(9_999), '9,999');
  assert.equal(tokenText(10_000), '1 万');
  assert.equal(tokenText(39_300), '3.9 万');
  assert.equal(tokenText(99_999_999), '1 亿');
  assert.equal(tokenText(99_940_000), '9994 万');
  assert.equal(tokenText(100_000_000), '1 亿');
  assert.equal(tokenText(150_000_000), '1.5 亿');
  assert.equal(tokenText(1_234_567_890), '12.35 亿');
});

test('the card puts the suggestions of automatic grouping after what needs the user, shows three rows and folds the rest', () => {
  const attention: ReviewSession[] = [session('q-1', { title: '提问', state: 'waiting', wait: 'question' }), session('f-1', { title: '构建', state: 'failed' })];
  const suggestions: SuggestionView[] = [
    {
      id: 'g-1', kind: 'new', name: 'chatbot 成本测算', goal: '算清年成本', why: '三条开在同一个工作区，都在算 chatbot 的成本',
      sessions: [{ id: 'a', title: '年度成本与新方案', lastActivity: NOW }, { id: 'b', title: 'chatbot 年成本测算表', lastActivity: NOW }, { id: 'c', title: '成本模型改用分档价格', lastActivity: NOW }],
    },
    { id: 'g-2', kind: 'file', matter: { id: 'm-1', name: 'OpenCodex 跟进' }, sessions: [{ id: 'd', title: '回一句收到', lastActivity: NOW }], why: '@ 了「OpenCodex 跟进」里的会话' },
  ];
  const rows = homeCardRows(attention, suggestions);
  assert.deepEqual(rows.map(row => [row.kind, row.id]), [['waiting', 'q-1'], ['waiting', 'f-1'], ['suggestion', 'g-1'], ['suggestion', 'g-2']]);
  assert.deepEqual(rows.flatMap(row => (row.kind === 'suggestion' ? [[row.text, row.note]] : [])), [
    ['建事项「chatbot 成本测算」', '3 个会话'], ['「回一句收到」归进 OpenCodex 跟进', undefined],
  ]);
  assert.equal(suggestionTitle(suggestions[0]!), '建事项「chatbot 成本测算」');
  assert.equal(suggestionTitle(suggestions[1]!), '「回一句收到」归进「OpenCodex 跟进」');
  const folded = foldHomeCard(rows);
  assert.deepEqual([folded.shown.map(row => row.id), folded.rest.map(row => row.id)], [['q-1', 'f-1', 'g-1'], ['g-2']]);
  assert.deepEqual(foldHomeCard(rows.slice(0, HOME_CARD_SHOWN)).rest, []);
  assert.deepEqual(homeCardRows([], suggestions.slice(1)).map(row => row.id), ['g-2']);
});
