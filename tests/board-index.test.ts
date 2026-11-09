import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Matter, SessionLink } from '../src/host/remote.ts';
import type { SessionView } from '../src/host/sessions.ts';
import { buildBoardIndex, chooseWorkspace, extractRefs, fillWorkspaces, indexContext, type IndexInput } from '../src/host/board-index.ts';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-09T06:00:00Z'); // 14:00 in Shanghai
const T0 = '2026-10-01T00:00:00.000Z';

const view = (id: string, lastActivity: string, overrides: Partial<SessionView> = {}): SessionView => ({
  id, title: id, blank: false, subagent: false, state: 'idle', lastActivity: at(lastActivity), ...overrides,
});
const link = (sessionId: string, by: SessionLink['by'] = 'manual', why?: string): SessionLink => ({ sessionId, by, at: T0, ...(why ? { why } : {}) });

function input(overrides: Partial<IndexInput> = {}): IndexInput {
  const matters: Matter[] = [
    { id: 'm-brief', name: '每周简报', goal: '每周五发一期', aliases: ['周报'], sources: [], createdAt: T0,
      sessions: [link('s-sort', 'mydsh', '前三期都在这里'), link('s-old'), link('s-gone'), link('s-arch')] },
    { id: 'm-auto', name: '发布说明', goal: '0.3 的发布说明随 #4321 合入', aliases: [], createdAt: T0, sessions: [link('s-ci')],
      workspaceId: 'w-other', instructions: `改飞书只替换对应的一节，不整篇替换。${'图用插件页的真实样式重截。'.repeat(20)}`,
      sources: [{ kind: 'folder', value: '/work/other/figures', title: 'figures' }, { kind: 'pr', value: 'https://github.com/o/r/pull/7781', title: 'o/r#7781' },
        { kind: 'doc', value: 'https://example.feishu.cn/docx/AbC' }] },
    { id: 'm-done', name: '第二期', goal: '', aliases: [], sources: [], createdAt: T0, archivedAt: '2026-10-20T00:00:00.000Z', sessions: [] },
  ];
  const sessions: SessionView[] = [
    view('s-sort', '2026-11-09T05:30:00Z', { title: '整理周报', state: 'waiting', wait: 'question' }),
    view('s-old', '2026-10-20T02:00:00Z', { title: '第一期发布 docs/weekly-01.md' }),
    view('s-arch', '2026-10-21T02:00:00Z', { title: '已归档的周报会话' }),
    view('s-ci', '2026-11-09T05:58:00Z', { title: 'PR #4321 CI 重跑', state: 'failed' }),
    view('s-free', '2026-11-08T23:00:00Z', { title: '看一遍我的 PR', state: 'running' }),
    view('s-older', '2026-10-01T00:00:00Z', { title: '一个多月前' }),
    view('s-blank', '2026-11-09T05:59:00Z', { title: null, blank: true }),
    view('s-child', '2026-11-09T05:58:00Z', { subagent: true }),
    view('s-mydsh', '2026-11-09T05:59:30Z', { title: 'my dsh' }),
    view('s-hidden', '2026-11-09T05:57:00Z', { title: '已归档的散会话' }),
  ];
  return {
    matters, sessions, now: NOW,
    workspaces: [
      { id: 'w-dsh', title: 'deepseek-harness', path: '/work/deepseek-harness', sessionIds: ['s-ci', 's-free', 's-old'] },
      { id: 'w-kb', title: 'feishu-kb', path: '/work/feishu-kb', sessionIds: ['s-sort'] },
      { id: 'w-other', title: 'other', path: '/work/other', sessionIds: [] },
    ],
    archived: new Set(['s-arch', 's-hidden']),
    hidden: new Set(['s-mydsh']),
    sent: new Map([['s-sort', ['整理这周合进 master 的 PR，写进 feishu-kb/docs/weekly-04.md']]]),
    ...overrides,
  };
}

test('the index has matters, the sessions in them and recent loose sessions, the workspaces they use and the links between them', () => {
  const index = buildBoardIndex(input());
  assert.equal(index.at, '2026-11-09T06:00:00.000Z');
  assert.deepEqual(index.matters.map(matter => [matter.id, matter.archived]), [['m-auto', false], ['m-brief', false], ['m-done', true]]);
  assert.deepEqual(index.links, [
    { matterId: 'm-brief', sessionId: 's-sort', by: 'mydsh', at: T0, why: '前三期都在这里' },
    { matterId: 'm-brief', sessionId: 's-old', by: 'manual', at: T0 },
    { matterId: 'm-brief', sessionId: 's-arch', by: 'manual', at: T0 },
    { matterId: 'm-auto', sessionId: 's-ci', by: 'manual', at: T0 },
  ]);
  assert.deepEqual(index.sessions.map(session => session.id), ['s-ci', 's-sort', 's-free', 's-arch', 's-old']);
  assert.deepEqual(index.sessions.find(session => session.id === 's-sort'), {
    id: 's-sort', title: '整理周报', state: 'waiting', wait: 'question', lastActivity: '2026-11-09T05:30:00.000Z', workspaceId: 'w-kb',
  });
  assert.equal(index.sessions.find(session => session.id === 's-arch')!.archived, true);
  assert.deepEqual(index.workspaces, [
    { id: 'w-dsh', title: 'deepseek-harness', path: '/work/deepseek-harness' },
    { id: 'w-kb', title: 'feishu-kb', path: '/work/feishu-kb' },
    { id: 'w-other', title: 'other', path: '/work/other' },
  ]);
  const auto = index.matters.find(matter => matter.id === 'm-auto')!;
  assert.equal(auto.workspaceId, 'w-other');
  assert.equal(auto.sources.length, 3);
  assert.match(auto.instructions!, /^改飞书只替换对应的一节/);
  // A main workspace that no longer exists is left out.
  const gone = input();
  gone.workspaces = gone.workspaces.filter(workspace => workspace.id !== 'w-other');
  assert.equal(buildBoardIndex(gone).matters.find(matter => matter.id === 'm-auto')!.workspaceId, undefined);
});

test('matters carry their aliases and the PRs and documents named in their name, goal, session titles and what my dsh sent', () => {
  const index = buildBoardIndex(input());
  const brief = index.matters.find(matter => matter.id === 'm-brief')!;
  assert.deepEqual(brief.aliases, ['周报']);
  assert.deepEqual(brief.docs, ['docs/weekly-01.md', 'feishu-kb/docs/weekly-04.md']);
  assert.deepEqual(brief.prs, []);
  assert.deepEqual(index.matters.find(matter => matter.id === 'm-auto')!.prs, ['#4321']);
  assert.equal(brief.lastActivity, '2026-11-09T05:30:00.000Z');
});

test('my dsh, blank, subagent and archived loose sessions stay out; loose sessions are the recent ones only', () => {
  const ids = buildBoardIndex(input()).sessions.map(session => session.id);
  for (const id of ['s-mydsh', 's-blank', 's-child', 's-hidden', 's-older', 's-gone']) assert.ok(!ids.includes(id), id);
  const linked = input();
  linked.matters[1]!.sessions.push(link('s-mydsh'));
  assert.ok(!buildBoardIndex(linked).sessions.some(session => session.id === 's-mydsh'));
  assert.ok(!buildBoardIndex(linked).links.some(entry => entry.sessionId === 's-mydsh'));
});

test('extractRefs finds PR numbers and documents once each', () => {
  // A pull request link counts as its PR, not as a document.
  assert.deepEqual(extractRefs(['PR #4321 CI 重跑', '看 https://github.com/o/r/pull/4310 和 #4321', '#1 不算']), { prs: ['#4321', '#4310'], docs: [] });
  assert.deepEqual(extractRefs(['写进 feishu-kb/docs/weekly-04.md。', '方案在 https://example.feishu.cn/docx/AbC123）里', 'notes.txt 和 a.b']),
    { prs: [], docs: ['feishu-kb/docs/weekly-04.md', 'https://example.feishu.cn/docx/AbC123', 'notes.txt'] });
});

test('the per-turn context is a compact text: matters with their sessions and states, archived names, then loose sessions', () => {
  const text = indexContext(buildBoardIndex(input()), { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(text, [
    '看板索引。状态是这个 DSH 进程看到的；别的 DSH 进程里在跑的会话，这里显示空闲。',
    '',
    '事项「发布说明」 id=m-auto 目标：0.3 的发布说明随 #4321 合入 PR：#4321 主工作区：other',
    '来源：文件夹 /work/other/figures；PR o/r#7781；文档 https://example.feishu.cn/docx/AbC',
    `指令：改飞书只替换对应的一节，不整篇替换。${'图用插件页的真实样式重截。'.repeat(20)}`.slice(0, 203) + '…',
    '- PR #4321 CI 重跑 id=s-ci 上一轮失败 13:58',
    '事项「每周简报」 id=m-brief 目标：每周五发一期 别名：周报 文档：docs/weekly-01.md、feishu-kb/docs/weekly-04.md 工作区：feishu-kb、deepseek-harness',
    '- 整理周报 id=s-sort 在等你回答 13:30 my dsh 开的',
    '- 已归档的周报会话 id=s-arch 已归档 10月21日 10:00',
    '- 第一期发布 docs/weekly-01.md id=s-old 空闲 10月20日 10:00',
    '已归档的事项：「第二期」 id=m-done',
    '',
    '不在事项里的会话（最近 14 天）：',
    '- 看一遍我的 PR id=s-free 在跑 07:00 工作区：deepseek-harness',
  ].join('\n'));
});

test('a matter with many sessions shows the newest few and says how many more there are', () => {
  const crowded = input();
  const many = Array.from({ length: 9 }, (_, n) => view(`s-${n}`, `2026-11-0${n + 1}T01:00:00Z`, { title: `第${n}条` }));
  crowded.sessions = [...crowded.sessions, ...many];
  crowded.matters[1]!.sessions = many.map(session => link(session.id));
  const text = indexContext(buildBoardIndex(crowded), { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.match(text, /- 第8条 id=s-8/);
  assert.doesNotMatch(text, /- 第2条 id=s-2/);
  assert.match(text, /还有 3 条，用 board_index 看全部/);
});

test('an empty board still says so', () => {
  const text = indexContext(buildBoardIndex(input({ matters: [], sessions: [] })), { now: NOW, timeZone: 'Asia/Shanghai' });
  assert.match(text, /还没有事项/);
  assert.doesNotMatch(text, /不在事项里的会话/);
});

test('start_session goes to the matter’s main workspace, else to that of its most recent session that has one', () => {
  const data = input();
  const facts = buildBoardIndex(data);
  assert.deepEqual(chooseWorkspace(data.matters[1]!, facts), { workspace: { id: 'w-other', title: 'other', path: '/work/other' } });
  // A main workspace removed from DSH falls back to the sessions.
  const removed = buildBoardIndex({ ...data, workspaces: data.workspaces.filter(w => w.id !== 'w-other') });
  assert.deepEqual(chooseWorkspace(data.matters[1]!, removed), { workspace: { id: 'w-dsh', title: 'deepseek-harness', path: '/work/deepseek-harness' } });
  const brief = data.matters[0]!;
  assert.deepEqual(chooseWorkspace(brief, facts), { workspace: { id: 'w-kb', title: 'feishu-kb', path: '/work/feishu-kb' } });
  // The most recent session has no workspace: the next one that has decides.
  const loose = buildBoardIndex({ ...data, workspaces: data.workspaces.map(w => w.id === 'w-kb' ? { ...w, sessionIds: [] } : w) });
  assert.deepEqual(chooseWorkspace(brief, loose), { workspace: { id: 'w-dsh', title: 'deepseek-harness', path: '/work/deepseek-harness' } });
  const result = chooseWorkspace(data.matters[2]!, facts);
  assert.ok('problem' in result);
  assert.match(result.problem, /「第二期」没有主工作区，里面也没有在工作区里的会话/);
});

test('matters without a main workspace get the workspace of their most recent session, once it is known', () => {
  const data = input();
  const { matters, filled } = fillWorkspaces(data.matters, buildBoardIndex(data));
  assert.deepEqual(filled, ['m-brief']);
  assert.equal(matters[0]!.workspaceId, 'w-kb');
  assert.equal(matters[1]!.workspaceId, 'w-other');
  assert.equal(matters[1], data.matters[1]);
  assert.equal(matters[2]!.workspaceId, undefined);
});
