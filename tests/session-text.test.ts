import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD_REPLY, FORWARD_CHARS, RECENT_CHARS, onlyNames, recentReplies, trackTurn, userWords, type TurnState } from '../src/host/session-text.ts';

const reply = (time: number, ...blocks: { type: string; text?: string }[]) => ({ type: 'event', event: { type: 'assistant/message', seq: time, time, data: { turn: 1, step: 1, message: { role: 'assistant', content: blocks } } } });
const other = (type: string, time: number) => ({ type: 'event', event: { type, seq: time, time, data: {} } });

test('recentReplies keeps the text of assistant messages, newest first, without reasoning or tool calls', () => {
  const records = [
    reply(1_000, { type: 'text', text: '先看了 CI。' }),
    other('tool/result', 1_500),
    reply(2_000, { type: 'reasoning', text: '想一想' }, { type: 'text', text: 'Windows 构建没过' }, { type: 'tool-call' }),
    reply(3_000, { type: 'tool-call' }),
    reply(4_000, { type: 'text', text: '  ' }),
  ];
  assert.deepEqual(recentReplies(records), {
    replies: [{ at: new Date(2_000).toISOString(), text: 'Windows 构建没过' }, { at: new Date(1_000).toISOString(), text: '先看了 CI。' }],
    truncated: false,
  });
});

test('recentReplies stops at about 1,500 characters and says so', () => {
  assert.equal(RECENT_CHARS, 1_500);
  const long = '长'.repeat(1_000);
  const result = recentReplies([reply(1_000, { type: 'text', text: '最早的一条' }), reply(2_000, { type: 'text', text: long }), reply(3_000, { type: 'text', text: long })]);
  assert.equal(result.truncated, true);
  assert.equal(result.replies.length, 2);
  assert.equal([...result.replies[0]!.text].length, 1_000);
  assert.equal(result.replies[1]!.text, `${'长'.repeat(500)}…`);
  assert.deepEqual(recentReplies([]), { replies: [], truncated: false });
});

const fold = (...events: { type: string; data: unknown }[]) => events.reduce<TurnState | undefined>(trackTurn, undefined);

test('trackTurn follows the turn and whether a person’s prompt is in it', () => {
  const started = fold({ type: 'turn/start', data: { turn: 3 } });
  assert.deepEqual(started, { turn: 3, byUser: false });
  const prompted = trackTurn(started, { type: 'user/message', data: { role: 'user', content: [], source: { kind: 'user', rpcId: 'r-1' } } });
  assert.deepEqual(prompted, { turn: 3, byUser: true });
  // Context snapshots and plugin messages are user-role too, but no person wrote them.
  assert.deepEqual(trackTurn(started, { type: 'user/message', data: { role: 'user', content: [], source: { kind: 'time-context' } } }), started);
  assert.equal(trackTurn(prompted, { type: 'tool/call', data: { turn: 3, step: 1, callId: 'c-1', name: 'board_index', arguments: '{}' } }), prompted);
  assert.deepEqual(trackTurn(prompted, { type: 'turn/start', data: { turn: 4 } }), { turn: 4, byUser: false });
});

test('trackTurn keeps the text of the person\'s prompt that marked the turn, and drops it when the next turn starts', () => {
  const started = fold({ type: 'turn/start', data: { turn: 3 } });
  const content = [{ type: 'text', text: '  把 0.163 的报告' }, { type: 'image', attachment: {} }, { type: 'text', text: '发到飞书 ' }];
  const prompted = trackTurn(started, { type: 'user/message', data: { role: 'user', content, source: { kind: 'user' } } });
  assert.deepEqual(prompted, { turn: 3, byUser: true, prompt: '把 0.163 的报告\n发到飞书' });
  // A later message in the same turn does not replace it.
  assert.equal(trackTurn(prompted, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '还有' }], source: { kind: 'user' } } }), prompted);
  assert.deepEqual(trackTurn(prompted, { type: 'turn/start', data: { turn: 4 } }), { turn: 4, byUser: false });
});

test('a turn seen first through a later event counts as not started by a person', () => {
  assert.deepEqual(fold({ type: 'step/start', data: { turn: 7, step: 2 } }), { turn: 7, byUser: false });
  assert.deepEqual(trackTurn({ turn: 6, byUser: true }, { type: 'tool/call', data: { turn: 7, step: 1 } }), { turn: 7, byUser: false });
  assert.equal(fold({ type: 'user/message', data: { source: { kind: 'user' } } }), undefined);
});

const said = (time: number, text: string, kind = 'user', more: unknown[] = []) => ({
  type: 'event', event: { type: 'user/message', seq: time, time, data: { source: { kind }, content: [{ type: 'text', text }, ...more] } },
});

test('userWords takes the user\'s last messages as they were written, oldest first, without card replies or other sources', () => {
  const records = [
    said(1, '先别管周报'),
    said(2, '看下 0.4.0 装上没'),
    reply(3, { type: 'text', text: '是哪件事项？' }),
    said(4, '是事项「OpenCodex 跟进」'),
    said(5, '## Referenced sessions', 'session-reference'),
  ];
  assert.deepEqual(userWords(records, 1), { text: '看下 0.4.0 装上没', messages: 1, attachments: 0 });
  assert.deepEqual(userWords(records, 2), { text: '先别管周报\n\n看下 0.4.0 装上没', messages: 2, attachments: 0 });
  assert.deepEqual(userWords(records, 3), { text: '先别管周报\n\n看下 0.4.0 装上没', messages: 2, attachments: 0 });
  for (const text of ['是会话「出报告」', '都不是', '新起了事项「周报」']) assert.ok(CARD_REPLY.test(text), text);
  assert.ok(!CARD_REPLY.test('是事项「周报」的话就改一下'));
  // Only text goes on; the attachments are counted, so the caller can say they did not.
  assert.deepEqual(userWords([said(1, '这个报错是哪来的', 'user', [{ type: 'image', attachmentId: 'f-1' }])], 1), { text: '这个报错是哪来的', messages: 1, attachments: 1 });
  assert.deepEqual(userWords([], 1), { text: '', messages: 0, attachments: 0 });
});

test('userWords cuts the words to its bound', () => {
  const { text } = userWords([said(1, '字'.repeat(FORWARD_CHARS + 10))], 1);
  assert.equal([...text].length, FORWARD_CHARS + 1);
  assert.ok(text.endsWith('…'));
});

test('words that only name things give a matter nothing to do: names, @-names, spaces and punctuation alone', () => {
  const names = ['OpenCodex 跟进', 'chatbot 成本测算'];
  for (const text of ['@chatbot', '@chatbot ', '@OpenCodex 跟进？', 'OpenCodex 跟进', '  ', '@a @b！', '@']) assert.equal(onlyNames(text, names), true, text);
  for (const text of ['@chatbot 这件到哪了', '继续', '好', '@OpenCodex 跟进 先停一下', 'OpenCodex 跟进到哪了']) assert.equal(onlyNames(text, names), false, text);
  // Without the names, a name with a space leaves its second word.
  assert.equal(onlyNames('@OpenCodex 跟进'), false);
});
