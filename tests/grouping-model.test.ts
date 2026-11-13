import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUPING_SYSTEM, WHY_MAX, chunked, groupingPrompt, outlineEnds, readGrouping, triggerLabel, whyText, type GroupingInput,
} from '../src/host/grouping-model.ts';

const INPUT: GroupingInput = {
  matters: [{ id: 'm-1', name: 'SDK 升级跟进', goal: '跟上游每个版本' }, { id: 'm-2', name: '周报', goal: '' }],
  sessions: [
    { id: 's-1', title: 'chatbot 年成本测算表', firstPrompt: '算一下 chatbot 一年要花多少', folder: 'untitled folder', trigger: '用户' },
    { id: 's-2', title: '成本模型改用分档价格', lastReply: '改成分档以后年成本降了三成', prs: ['a/b#12'] },
    { id: 's-3', title: '回一句收到', branch: 'feat/x', schedules: ['每周简报'] },
    { id: 's-4', title: '年度成本与新方案' },
  ],
};

test('the prompt lists the matters in progress and the loose sessions, one JSON line each, leaving out what is not known', () => {
  const prompt = groupingPrompt(INPUT);
  assert.equal(prompt, [
    '进行中的事项：',
    '{"id":"m-1","name":"SDK 升级跟进","goal":"跟上游每个版本"}',
    '{"id":"m-2","name":"周报"}',
    '',
    '不在事项里的会话，最近用过的在前：',
    '{"id":"s-1","title":"chatbot 年成本测算表","firstPrompt":"算一下 chatbot 一年要花多少","folder":"untitled folder","trigger":"用户"}',
    '{"id":"s-2","title":"成本模型改用分档价格","lastReply":"改成分档以后年成本降了三成","prs":["a/b#12"]}',
    '{"id":"s-3","title":"回一句收到","branch":"feat/x","schedules":["每周简报"]}',
    '{"id":"s-4","title":"年度成本与新方案"}',
  ].join('\n'));
  assert.match(groupingPrompt({ matters: [], sessions: [] }), /进行中的事项：\n（没有）/);
  // The instructions ask for strict JSON and say what the fields are; they speak to the task, not to a persona.
  assert.match(GROUPING_SYSTEM, /只输出一个 JSON 对象/);
  assert.doesNotMatch(GROUPING_SYSTEM, /你是|助手|管家/);
});

test('a valid answer gives filings and new matters, with what each needs and why', () => {
  const answer = '```json\n{"suggestions":['
    + '{"kind":"new","sessionIds":["s-1","s-2","s-4"],"name":" chatbot 成本测算 ","goal":"算清年成本，给新方案留出数据","why":"三条都在算 chatbot 的成本。"},'
    + '{"kind":"file","sessionId":"s-3","matterId":"m-2","why":"每周简报的定时任务开的"}]}\n```';
  assert.deepEqual(readGrouping(answer, INPUT), [
    { change: { kind: 'new', sessionIds: ['s-1', 's-2', 's-4'], name: 'chatbot 成本测算', goal: '算清年成本，给新方案留出数据' }, why: '三条都在算 chatbot 的成本', by: 'model' },
    { change: { kind: 'file', sessionId: 's-3', matterId: 'm-2' }, why: '每周简报的定时任务开的', by: 'model' },
  ]);
  assert.deepEqual(readGrouping('{"suggestions":[]}', INPUT), []);
});

test('an answer without a JSON object holding a suggestions list cannot be read', () => {
  assert.equal(readGrouping('我觉得 s-1 和 s-2 是一起的', INPUT), undefined);
  assert.equal(readGrouping('{"suggestion":[]}', INPUT), undefined);
  assert.equal(readGrouping('{"suggestions": [', INPUT), undefined);
});

test('each suggestion that fails a check is dropped: unknown ids, a session used twice, too few sessions, a bad name or goal, a bad why', () => {
  const item = (fields: Record<string, unknown>) => JSON.stringify({ why: '在做同一件事', ...fields });
  const answer = `{"suggestions":[${[
    item({ kind: 'file', sessionId: 's-9', matterId: 'm-1' }),
    item({ kind: 'file', sessionId: 's-1', matterId: 'm-9' }),
    item({ kind: 'file', sessionId: 's-1', matterId: 'm-1' }),
    item({ kind: 'new', sessionIds: ['s-1', 's-2'], name: '重复了', goal: '' }),
    item({ kind: 'new', sessionIds: ['s-2'], name: '一条不成', goal: '' }),
    item({ kind: 'new', sessionIds: ['s-2', 's-2'], name: '同一条两次', goal: '' }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3'], name: '名'.repeat(41), goal: '' }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3'], name: '周报', goal: '' }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3'], name: '两行\n名字', goal: '' }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3'], name: '目标太长', goal: '标'.repeat(121) }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3'], name: '没有理由', goal: '', why: '' }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3'], name: '两句理由', goal: '', why: '同一个目录。也都在改成本' }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3'], name: '理由带 id', goal: '', why: 's-2 和 s-3 是一起的' }),
    item({ kind: 'merge', sessionIds: ['s-2', 's-3'] }),
    item({ kind: 'new', sessionIds: ['s-2', 's-3', 's-4'], name: '成本', why: '都在算成本' }),
  ].join(',')}]}`;
  assert.deepEqual(readGrouping(answer, INPUT), [
    { change: { kind: 'file', sessionId: 's-1', matterId: 'm-1' }, why: '在做同一件事', by: 'model' },
    { change: { kind: 'new', sessionIds: ['s-2', 's-3', 's-4'], name: '成本', goal: '' }, why: '都在算成本', by: 'model' },
  ]);
});

test('a why is one line of one sentence, at most 80 characters, its full stop taken off', () => {
  assert.equal(whyText('三条开在同一个工作区，都在算 chatbot 的成本。'), '三条开在同一个工作区，都在算 chatbot 的成本');
  assert.equal(whyText('用的是 v0.2.2 的接口'), '用的是 v0.2.2 的接口');
  assert.equal(whyText('理'.repeat(WHY_MAX)), '理'.repeat(WHY_MAX));
  assert.equal(whyText('理'.repeat(WHY_MAX + 1)), undefined);
  assert.equal(whyText('第一句。第二句'), undefined);
  assert.equal(whyText('是不是一起的？'), undefined);
  assert.equal(whyText('一行\n两行'), undefined);
  assert.equal(whyText(7), undefined);
});

test('the first prompt and the last reply come from the cached turn outline, as DSH keeps them', () => {
  const outline = [
    { turn: 1, seq: 3, prompt: '', response: '' },
    { turn: 2, seq: 9, prompt: '算一下 **chatbot** 一年要花多少，按现在的用量', response: '先看用量' },
    { turn: 3, seq: 20, prompt: '再算分档', response: '' },
  ];
  assert.deepEqual(outlineEnds(outline), { firstPrompt: '算一下 chatbot 一年要花多少，按现在的用量', lastReply: '先看用量' });
  assert.deepEqual(outlineEnds(undefined), {});
  assert.equal(triggerLabel('user'), '用户');
  assert.equal(triggerLabel('schedule'), '定时任务');
  assert.equal(triggerLabel('my-dsh'), 'my dsh');
  assert.equal(triggerLabel('webhook'), 'webhook');
  assert.equal(triggerLabel(undefined), undefined);
  assert.deepEqual(chunked([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
