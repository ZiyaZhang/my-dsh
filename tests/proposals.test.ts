import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestError, type Matter, type Proposal, type SessionLink, type WhichQuestion } from '../src/host/remote.ts';
import {
  PROPOSALS_MAX, QUESTIONS_MAX, answerQuestion, applyProposal, decideProposal, keepNewest, proposalCard, proposalLine, questionCard,
} from '../src/host/proposals.ts';

const T0 = '2026-11-09T01:00:00.000Z';
const T1 = '2026-11-09T02:00:00.000Z';
const PLACE = { sessionId: 's-mydsh', turn: 3 };
const link = (sessionId: string): SessionLink => ({ sessionId, by: 'manual', at: T0 });

const matters = (): Matter[] => [
  { id: 'm-brief', name: '每周简报', goal: '每周五发一期', sessions: [link('s-1')], aliases: ['周报'], sources: [], createdAt: T0 },
  { id: 'm-draft', name: '周报草稿', goal: '', sessions: [link('s-2'), link('s-3')], aliases: ['草稿'], sources: [], createdAt: T0 },
];

const proposal = (change: Proposal['change'], phrase?: string): Proposal => ({
  id: 'p-1', change, why: '理由', at: T0, state: 'pending', ...PLACE, ...(phrase ? { phrase } : {}),
});
const refused = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof RequestError && message.test(error.message));

test('each proposal reads as one line of what will change', () => {
  assert.equal(proposalLine({ kind: 'new', name: '工作区切换性能', goal: '跟进工作区切换卡顿' }), '新起事项「工作区切换性能」，目标是跟进工作区切换卡顿');
  assert.equal(proposalLine({ kind: 'new', name: '工作区切换性能', goal: '' }), '新起事项「工作区切换性能」');
  assert.equal(proposalLine({ kind: 'merge', fromId: 'm-draft', fromName: '周报草稿', intoId: 'm-brief', intoName: '每周简报' }), '把「周报草稿」并进「每周简报」');
  assert.equal(proposalLine({ kind: 'rename', matterId: 'm-brief', oldName: '每周简报', name: '周报' }), '把「每周简报」改名为「周报」');
});

test('accepting a new matter creates it, with the user’s phrase as its first alias', () => {
  const { matters: after, matter, text } = applyProposal(matters(), proposal({ kind: 'new', name: '工作区切换性能', goal: '跟进卡顿' }, '切换卡顿那件'), { id: 'm-new', at: T1 });
  assert.deepEqual(matter, { id: 'm-new', name: '工作区切换性能', goal: '跟进卡顿', sessions: [], aliases: ['切换卡顿那件'], sources: [], createdAt: T1 });
  assert.equal(after.length, 3);
  assert.equal(text, '新起事项「工作区切换性能」，目标是跟进卡顿');
});

test('accepting a merge moves the sessions and keeps the old name, its aliases and the phrase as aliases', () => {
  const change = { kind: 'merge' as const, fromId: 'm-draft', fromName: '周报草稿', intoId: 'm-brief', intoName: '每周简报' };
  const { matters: after, matter } = applyProposal(matters(), proposal(change, '那个周报'), { id: 'unused', at: T1 });
  assert.deepEqual(after.map(m => m.id), ['m-brief']);
  assert.deepEqual(matter.sessions.map(entry => entry.sessionId), ['s-1', 's-2', 's-3']);
  assert.deepEqual(matter.aliases, ['那个周报', '周报草稿', '草稿', '周报']);
  refused(() => applyProposal(matters().slice(0, 1), proposal(change), { id: 'unused', at: T1 }), /没有这个事项/);
});

test('accepting a rename keeps the old name as an alias, and the phrase too', () => {
  const { matter } = applyProposal(matters(), proposal({ kind: 'rename', matterId: 'm-brief', oldName: '每周简报', name: '周报汇总' }, '周五那个'), { id: 'unused', at: T1 });
  assert.equal(matter.name, '周报汇总');
  assert.deepEqual(matter.aliases, ['周五那个', '每周简报', '周报']);
});

test('a proposal is decided once; deciding it again or one that is gone is refused', () => {
  const list = [proposal({ kind: 'new', name: '看板', goal: '' }), { ...proposal({ kind: 'new', name: '别的', goal: '' }), id: 'p-2' }];
  const { proposals, proposal: decided } = decideProposal(list, 'p-1', { state: 'accepted', at: T1, matterId: 'm-new' });
  assert.deepEqual(decided, { ...list[0], state: 'accepted', decidedAt: T1, matterId: 'm-new' });
  assert.equal(proposals[1], list[1]);
  assert.equal(decideProposal(list, 'p-2', { state: 'declined', at: T1 }).proposal.state, 'declined');
  refused(() => decideProposal(proposals, 'p-1', { state: 'declined', at: T1 }), /已经处理过了/);
  refused(() => decideProposal(list, 'p-gone', { state: 'declined', at: T1 }), /没有这个提议/);
  refused(() => applyProposal(matters(), decided, { id: 'm-x', at: T1 }), /已经处理过了/);
});

test('a proposal card carries its line, its kind and its state', () => {
  const merge = proposal({ kind: 'merge', fromId: 'm-draft', fromName: '周报草稿', intoId: 'm-brief', intoName: '每周简报' });
  assert.deepEqual(proposalCard(merge), { type: 'proposal', id: 'p-1', kind: 'merge', line: '把「周报草稿」并进「每周简报」', state: 'pending', ...PLACE });
});

const question = (): WhichQuestion => ({
  id: 'q-1', phrase: '那个项目', why: '两件都和周报有关', at: T0, state: 'pending', ...PLACE,
  candidates: [{ kind: 'matter', id: 'm-brief', label: '每周简报' }, { kind: 'session', id: 's-4', label: '整理周报' }],
});

test('answering a candidate card records the pick and the words sent back to my dsh', () => {
  const picked = answerQuestion([question()], 'q-1', 'm-brief', T1);
  assert.deepEqual(picked.answer, { kind: 'matter', id: 'm-brief', label: '每周简报' });
  assert.equal(picked.reply, '是事项「每周简报」');
  assert.deepEqual(picked.question, { ...question(), state: 'answered', answer: { kind: 'matter', id: 'm-brief', label: '每周简报' }, answeredAt: T1 });
  assert.equal(answerQuestion([question()], 'q-1', 's-4', T1).reply, '是会话「整理周报」');
  const none = answerQuestion([question()], 'q-1', null, T1);
  assert.equal(none.answer, null);
  assert.equal(none.question.answer, null);
  assert.equal(none.reply, '都不是');
  refused(() => answerQuestion(picked.questions, 'q-1', 'm-brief', T1), /已经选过了/);
  refused(() => answerQuestion([question()], 'q-1', 'm-other', T1), /不是这张卡上的候选/);
  refused(() => answerQuestion([question()], 'q-gone', null, T1), /没有这个问题/);
});

test('a candidate card lists the candidates and, once answered, the pick', () => {
  const answered = answerQuestion([question()], 'q-1', 's-4', T1).question;
  assert.deepEqual(questionCard(question()), { type: 'which', id: 'q-1', phrase: '那个项目', candidates: question().candidates, state: 'pending', ...PLACE });
  const card = questionCard(answered);
  assert.ok(card.type === 'which');
  assert.deepEqual(card.answer, { kind: 'session', id: 's-4', label: '整理周报' });
});

test('stored proposals and questions keep only the newest', () => {
  assert.equal(PROPOSALS_MAX, 300);
  assert.equal(QUESTIONS_MAX, 300);
  const many = Array.from({ length: 305 }, (_, n) => ({ ...question(), id: `q-${n}` }));
  const kept = keepNewest(many, QUESTIONS_MAX);
  assert.equal(kept.length, 300);
  assert.equal(kept[0]!.id, 'q-5');
});

test('a new matter takes the proposed main workspace, else the one given when it is accepted', () => {
  const proposed = applyProposal(matters(), proposal({ kind: 'new', name: '看板', goal: '', workspaceId: 'w-kb' }), { id: 'm-new', at: T1, workspaceId: 'w-dsh' });
  assert.equal(proposed.matter.workspaceId, 'w-kb');
  const fallback = applyProposal(matters(), proposal({ kind: 'new', name: '看板', goal: '' }), { id: 'm-new', at: T1, workspaceId: 'w-dsh' });
  assert.equal(fallback.matter.workspaceId, 'w-dsh');
  assert.equal(applyProposal(matters(), proposal({ kind: 'new', name: '看板', goal: '' }), { id: 'm-new', at: T1 }).matter.workspaceId, undefined);
});
