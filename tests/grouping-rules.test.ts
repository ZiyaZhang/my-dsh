import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nameFrom, originSuggestions, prName, scheduleFacts, sessionBranch, sessionPrs, type RuleInput, type RuleSession,
} from '../src/host/grouping-rules.ts';
import { suggestionKey } from '../src/host/grouping.ts';
import type { ScheduleEntry } from '../src/host/snapshot.ts';

const session = (id: string, extra: Partial<RuleSession> = {}): RuleSession => ({ id, title: `会话 ${id}`, lastActivity: 0, prs: [], refs: [], runs: [], ...extra });
const MATTERS = new Map([['m-1', { name: '周报', prs: [] }], ['m-2', { name: '看板', prs: ['github.com/a/b#7'] }]]);
const input = (extra: Partial<RuleInput>): RuleInput => ({
  loose: [], filed: [], matters: MATTERS, tasks: new Map(), declined: new Set(), takenOut: new Set(), ...extra,
});

test('the same scheduled task: the matter of its other runs, else of the session that made it, else a new matter of its runs', () => {
  const result = originSuggestions(input({
    loose: [
      session('r-1', { runs: ['t-1'] }), session('r-2', { runs: ['t-1'] }), session('r-3', { runs: ['t-2'] }),
      session('r-5', { runs: ['t-3'] }), session('r-6', { runs: ['t-3'] }), session('r-7', { runs: ['t-4'] }), session('r-8', { runs: ['t-5'] }),
      session('c-3'),
    ],
    filed: [
      session('f-1', { matterId: 'm-1', runs: ['t-1'] }), session('c-2', { matterId: 'm-2' }),
      session('f-4a', { matterId: 'm-1', runs: ['t-4'] }), session('f-4b', { matterId: 'm-2', runs: ['t-4'] }),
    ],
    tasks: new Map([
      ['t-1', { title: '每周简报' }], ['t-2', { title: '喝水提醒', creator: 'c-2' }],
      ['t-3', { title: '每天整理 PR', prompt: '把昨天合进 master 的 PR\n按模块列出来', creator: 'c-3' }], ['t-4', { title: '两边都有' }],
    ]),
  }));
  assert.deepEqual(result.suggestions, [
    { change: { kind: 'file', sessionId: 'r-1', matterId: 'm-1' }, why: '和「周报」里的会话来自同一个定时任务「每周简报」', by: 'origin', rule: 'schedule' },
    { change: { kind: 'file', sessionId: 'r-2', matterId: 'm-1' }, why: '和「周报」里的会话来自同一个定时任务「每周简报」', by: 'origin', rule: 'schedule' },
    { change: { kind: 'file', sessionId: 'r-3', matterId: 'm-2' }, why: '定时任务「喝水提醒」是在「看板」的会话里建的', by: 'origin', rule: 'schedule' },
    {
      change: { kind: 'new', sessionIds: ['r-5', 'r-6'], name: '每天整理 PR', goal: '把昨天合进 master 的 PR 按模块列出来' }, why: '来自同一个定时任务「每天整理 PR」',
      by: 'origin', rule: 'schedule',
    },
  ]);
  // Runs in two matters place nothing, a lone run makes no matter, and the session that made a task does not join its runs.
  assert.deepEqual([...result.placed].sort(), ['r-1', 'r-2', 'r-3', 'r-5', 'r-6']);
});

test('the same PR: the matter whose sessions or sources have it; loose sessions joined by shared PRs make a new matter', () => {
  const result = originSuggestions(input({
    loose: [
      session('p-1', { prs: ['github.com/a/b#1'] }), session('p-2', { prs: ['github.com/a/b#7'] }),
      session('p-3', { prs: ['github.com/a/b#3'] }), session('p-4', { prs: ['github.com/a/b#3', 'ghe.example.com/t/u#4'] }), session('p-5', { prs: ['ghe.example.com/t/u#4'] }),
      session('p-6', { prs: ['github.com/a/b#1', 'github.com/a/b#7'] }), session('p-7', { prs: ['github.com/a/b#9'] }),
    ],
    filed: [session('f-1', { matterId: 'm-1', prs: ['github.com/a/b#1'] })],
  }));
  assert.deepEqual(result.suggestions, [
    { change: { kind: 'file', sessionId: 'p-1', matterId: 'm-1' }, why: '和「周报」处理的是同一个 PR a/b#1', by: 'origin', rule: 'pr' },
    { change: { kind: 'file', sessionId: 'p-2', matterId: 'm-2' }, why: '和「看板」处理的是同一个 PR a/b#7', by: 'origin', rule: 'pr' },
    { change: { kind: 'new', sessionIds: ['p-3', 'p-4', 'p-5'], name: 'a/b#3', goal: '' }, why: '处理的是同一个 PR a/b#3', by: 'origin', rule: 'pr' },
  ]);
  assert.equal(result.placed.has('p-6'), false);
  assert.equal(result.placed.has('p-7'), false);
  assert.equal(prName('ghe.example.com/t/u#4'), 'ghe.example.com/t/u#4');
});

test('the same branch: the matter whose sessions are on it; loose sessions on one branch make a new matter named after it', () => {
  const x = { key: '/repo/.git\nfeat/x', name: 'feat/x' };
  const y = { key: '/repo/.git\nfeat/y', name: 'feat/y' };
  const result = originSuggestions(input({
    loose: [session('b-1', { branch: x }), session('b-2', { branch: y }), session('b-3', { branch: y }), session('b-4', { branch: { key: '/other/.git\nfeat/y', name: 'feat/y' } })],
    filed: [session('f-1', { matterId: 'm-1', branch: x })],
  }));
  assert.deepEqual(result.suggestions, [
    { change: { kind: 'file', sessionId: 'b-1', matterId: 'm-1' }, why: '和「周报」里的会话在同一个分支 feat/x 上', by: 'origin', rule: 'branch' },
    { change: { kind: 'new', sessionIds: ['b-2', 'b-3'], name: 'feat/y', goal: '' }, why: '在同一个分支 feat/y 上', by: 'origin', rule: 'branch' },
  ]);
});

test('an @-reference: the matter of the sessions it referenced when they are in one; loose sessions that referenced each other together', () => {
  const result = originSuggestions(input({
    loose: [
      session('r-1', { refs: ['f-1'] }), session('r-2', { refs: ['r-3'] }), session('r-3'), session('r-4', { refs: ['f-1', 'f-2'] }),
      session('r-5', { refs: ['gone'] }),
    ],
    filed: [session('f-1', { matterId: 'm-1', title: '整理第三期' }), session('f-2', { matterId: 'm-2' })],
  }));
  assert.deepEqual(result.suggestions, [
    { change: { kind: 'file', sessionId: 'r-1', matterId: 'm-1' }, why: '@ 了「周报」里的会话「整理第三期」', by: 'origin', rule: 'reference' },
    { change: { kind: 'new', sessionIds: ['r-2', 'r-3'], name: '会话 r-3', goal: '' }, why: '这几条会话之间有 @ 引用', by: 'origin', rule: 'reference' },
  ]);
  assert.equal(result.placed.has('r-4'), false);
  assert.equal(result.placed.has('r-5'), false);
});

test('rules run strongest first, each over the sessions the ones before left', () => {
  const result = originSuggestions(input({
    loose: [session('s-1', { runs: ['t-1'], prs: ['github.com/a/b#7'] }), session('s-2', { prs: ['github.com/a/b#7'] })],
    filed: [session('f-1', { matterId: 'm-1', runs: ['t-1'] })],
    tasks: new Map([['t-1', { title: '每周简报' }]]),
  }));
  assert.deepEqual(result.suggestions.map(item => [item.rule, item.change.kind, item.change.kind === 'file' ? item.change.matterId : '']), [
    ['schedule', 'file', 'm-1'], ['pr', 'file', 'm-2'],
  ]);
});

test('a declined suggestion and a filing into a matter the user took the session out of are not made; their sessions stay open', () => {
  const y = { key: '/repo/.git\nfeat/y', name: 'feat/y' };
  const result = originSuggestions(input({
    loose: [session('b-1', { branch: y, refs: ['f-1'] }), session('b-2', { branch: y }), session('b-3', { prs: ['github.com/a/b#7'] })],
    filed: [session('f-1', { matterId: 'm-1' })],
    declined: new Set([suggestionKey({ kind: 'new', sessionIds: ['b-1', 'b-2'], name: '', goal: '' })]),
    takenOut: new Set(['b-3>m-2']),
  }));
  // The branch group was declined, so b-1 is left to the reference rule; b-3 was taken out of 看板, so nothing places it.
  assert.deepEqual(result.suggestions.map(item => [item.rule, item.change]), [['reference', { kind: 'file', sessionId: 'b-1', matterId: 'm-1' }]]);
  assert.deepEqual([...result.placed], ['b-1']);
});

test('a session\'s branch is the one its turns ended on, else its worktree\'s now; a main checkout\'s branch now is not used', () => {
  const note = { key: '/repo/.git\nfeat/old', name: 'feat/old', at: 1 };
  const worktree = { commonDir: '/repo/.git', branch: 'feat/alpha', worktree: true };
  const checkout = { commonDir: '/repo/.git', branch: 'feat/now', worktree: false };
  assert.deepEqual(sessionBranch(note, worktree), { key: '/repo/.git\nfeat/old', name: 'feat/old' });
  assert.deepEqual(sessionBranch(undefined, worktree), { key: '/repo/.git\nfeat/alpha', name: 'feat/alpha' });
  assert.equal(sessionBranch(undefined, checkout), undefined);
  assert.equal(sessionBranch(undefined, { ...worktree, branch: 'main' }), undefined);
  assert.equal(sessionBranch(undefined, undefined), undefined);
});

test('a session\'s PRs add its bare PR numbers in the repository of its remote', () => {
  assert.deepEqual(sessionPrs({ prs: ['github.com/a/b#1'], numbers: [1, 2] }, 'github.com/a/b'), ['github.com/a/b#1', 'github.com/a/b#2']);
  assert.deepEqual(sessionPrs({ prs: ['github.com/a/b#1'], numbers: [2] }, undefined), ['github.com/a/b#1']);
  assert.deepEqual(sessionPrs(undefined, 'github.com/a/b'), []);
});

test('DSH\'s task list gives each task\'s maker, unless it is a session the task delivers into, and the tasks each session runs', () => {
  const entries: ScheduleEntry[] = [
    { id: 't-1', title: '每周简报', prompt: '整理周报', status: 'active', target: { kind: 'new' }, involvedSessionIds: ['s-maker'], lastDelivery: { targetSessionId: 's-run' } },
    { id: 't-2', title: '提醒自己', status: 'active', target: { kind: 'session', sessionId: 's-self' }, involvedSessionIds: ['s-self'] },
    { id: 't-3', title: '在别处跑', status: 'paused', target: { kind: 'new_once', sessionId: 's-once' }, involvedSessionIds: ['s-maker', 's-once'] },
  ];
  const { tasks, runs } = scheduleFacts(entries);
  assert.deepEqual(tasks.get('t-1'), { title: '每周简报', prompt: '整理周报', creator: 's-maker' });
  assert.deepEqual(tasks.get('t-2'), { title: '提醒自己' });
  assert.deepEqual(tasks.get('t-3'), { title: '在别处跑', creator: 's-maker' });
  assert.deepEqual(Object.fromEntries(runs), { 's-run': ['t-1'], 's-self': ['t-2'], 's-once': ['t-3'] });
  assert.equal(nameFrom(`  ${'长'.repeat(50)}\n`), '长'.repeat(40));
  assert.equal(nameFrom('   '), '未命名');
});
