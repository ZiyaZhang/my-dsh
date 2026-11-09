import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECENT_CHARS, recentReplies, trackTurn, type TurnState } from '../src/host/session-text.ts';

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

test('a turn seen first through a later event counts as not started by a person', () => {
  assert.deepEqual(fold({ type: 'step/start', data: { turn: 7, step: 2 } }), { turn: 7, byUser: false });
  assert.deepEqual(trackTurn({ turn: 6, byUser: true }, { type: 'tool/call', data: { turn: 7, step: 1 } }), { turn: 7, byUser: false });
  assert.equal(fold({ type: 'user/message', data: { source: { kind: 'user' } } }), undefined);
});
