import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SessionIndex, emptyTrack, lastActivity, sessionState, trackEvent, trackRemoved, trackRow, trackStatus,
  type SessionEventLike, type SessionRow, type SessionTrack,
} from '../src/host/sessions.ts';

const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  sessionId: 's-1', updatedAt: 1_000, running: false, blank: false, title: '整理周报', ...overrides,
});
const event = (type: string, time: number, data: unknown): SessionEventLike => ({ type, time, data });
const fold = (track: SessionTrack, ...events: SessionEventLike[]) => events.reduce(trackEvent, track);
const cold = (overrides: Partial<SessionRow> = {}) => trackRow(undefined, row(overrides), 'list');

test('a cold row with no events is idle, titled from its row, active as of its last prompt', () => {
  const track = cold();
  assert.deepEqual(sessionState(track), { state: 'idle' });
  assert.equal(track.title, '整理周报');
  assert.equal(lastActivity(track), 1_000);
  assert.equal(cold({ title: null }).title, null);
  assert.equal(cold({ origin: 'subagent' }).subagent, true);
  assert.equal(cold({ blank: true }).blank, true);
});

test('a row that says running, or a status event, makes the session running', () => {
  assert.deepEqual(sessionState(cold({ running: true })), { state: 'running' });
  assert.deepEqual(sessionState(trackStatus(cold(), true)), { state: 'running' });
  assert.deepEqual(sessionState(trackStatus(cold({ running: true }), false)), { state: 'idle' });
});

test('an approval waits from approval/asked until approval/decided', () => {
  const asked = fold(trackStatus(cold(), true), event('turn/start', 2_000, { turn: 1 }),
    event('approval/asked', 2_100, { id: 'a-1', toolName: 'bash', callId: 'c-1' }));
  assert.deepEqual(sessionState(asked), { state: 'waiting', wait: 'approval' });
  const decided = fold(asked, event('approval/decided', 2_200, { id: 'a-1', outcome: 'allowed-once' }));
  assert.deepEqual(sessionState(decided), { state: 'running' });
});

test('an ask_user_question call waits until its result; other tool calls do not', () => {
  const started = fold(trackStatus(cold(), true), event('turn/start', 2_000, { turn: 1 }));
  const other = fold(started, event('tool/call', 2_050, { turn: 1, step: 1, callId: 'c-0', name: 'bash', arguments: '{}' }));
  assert.deepEqual(sessionState(other), { state: 'running' });
  const asking = fold(other, event('tool/call', 2_100, { turn: 1, step: 1, callId: 'c-1', name: 'ask_user_question', arguments: '{}' }));
  assert.deepEqual(sessionState(asking), { state: 'waiting', wait: 'question' });
  const otherResult = fold(asking, event('tool/result', 2_150, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c-0', content: [] } }));
  assert.deepEqual(sessionState(otherResult), { state: 'waiting', wait: 'question' });
  const answered = fold(otherResult, event('tool/result', 2_200, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c-1', content: [] } }));
  assert.deepEqual(sessionState(answered), { state: 'running' });
});

test('the first wait still pending names the kind', () => {
  const both = fold(trackStatus(cold(), true),
    event('tool/call', 2_100, { turn: 1, step: 1, callId: 'c-1', name: 'ask_user_question', arguments: '{}' }),
    event('approval/asked', 2_200, { id: 'a-1', toolName: 'bash' }));
  assert.deepEqual(sessionState(both), { state: 'waiting', wait: 'question' });
  const left = fold(both, event('tool/result', 2_300, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c-1', content: [] } }));
  assert.deepEqual(sessionState(left), { state: 'waiting', wait: 'approval' });
});

test('a turn that ends with an error leaves the session failed until a later turn', () => {
  const failed = trackStatus(fold(trackStatus(cold(), true), event('turn/start', 2_000, { turn: 1 }),
    event('turn/end', 3_000, { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })), false);
  assert.deepEqual(sessionState(failed), { state: 'failed' });
  const retried = fold(failed, event('turn/start', 4_000, { turn: 2 }));
  assert.deepEqual(sessionState(retried), { state: 'running' });
  const done = trackStatus(fold(retried, event('turn/end', 5_000, { turn: 2, reason: { kind: 'completed' } })), false);
  assert.deepEqual(sessionState(done), { state: 'idle' });
  const stopped = trackStatus(fold(done, event('turn/start', 6_000, { turn: 3 }), event('turn/end', 6_500, { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })), false);
  assert.deepEqual(sessionState(stopped), { state: 'idle' });
});

test('a turn that ends, or an agent that stops or leaves, drops every pending wait', () => {
  const asking = fold(trackStatus(cold(), true), event('turn/start', 2_000, { turn: 1 }),
    event('tool/call', 2_100, { turn: 1, step: 1, callId: 'c-1', name: 'ask_user_question', arguments: '{}' }),
    event('approval/asked', 2_200, { id: 'a-1', toolName: 'bash' }));
  const ended = fold(asking, event('turn/end', 2_500, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  assert.deepEqual(ended.waits, []);
  assert.deepEqual(trackStatus(asking, false).waits, []);
  const gone = trackRemoved(asking);
  assert.deepEqual(gone.waits, []);
  assert.deepEqual(sessionState(gone), { state: 'idle' });
});

test('last activity is the latest of the last prompt, turn start and turn end', () => {
  const track = cold({ updatedAt: 1_000 });
  assert.equal(lastActivity(fold(track, event('turn/start', 2_000, { turn: 1 }))), 2_000);
  assert.equal(lastActivity(fold(track, event('turn/start', 2_000, { turn: 1 }), event('turn/end', 3_000, { turn: 1, reason: { kind: 'completed' } }))), 3_000);
  // A prompt queued after the last turn ended is newer activity.
  assert.equal(lastActivity(trackRow(fold(track, event('turn/end', 3_000, { turn: 1, reason: { kind: 'completed' } })), row({ updatedAt: 4_000 }), 'added')), 4_000);
});

test('a session/title event names the session, and a later list row does not undo it', () => {
  const titled = fold(cold({ title: null }), event('session/title', 2_000, { title: '发布说明', messageSeqs: [], source: { kind: 'user' } }));
  assert.equal(titled.title, '发布说明');
  assert.equal(trackRow(titled, row({ title: '旧标题' }), 'list').title, '发布说明');
  assert.equal(trackRow(titled, row({ title: '新标题' }), 'added').title, '新标题');
  assert.equal(trackRow(titled, row({ title: undefined }), 'added').title, '发布说明');
});

test('a list row read while events arrived does not undo what the events said', () => {
  const live = fold(trackStatus(emptyTrack('s-1'), true), event('turn/start', 2_000, { turn: 1 }));
  const merged = trackRow(live, row({ running: false, blank: true, updatedAt: 500 }), 'list');
  assert.equal(merged.running, true);
  assert.equal(merged.blank, false);
  assert.equal(lastActivity(merged), 2_000);
  const fresh = trackRow(live, row({ running: false }), 'added');
  assert.equal(fresh.running, false);
});

test('events that the board does not read return the same track', () => {
  const track = cold();
  assert.equal(trackEvent(track, event('assistant/message', 2_000, { turn: 1, step: 1 })), track);
  assert.equal(trackEvent(track, event('tool/call', 2_000, { turn: 1, step: 1, callId: 'c-0', name: 'bash', arguments: '' })), track);
  assert.equal(trackEvent(track, event('approval/asked', 2_000, { toolName: 'bash' })), track);
});

test('the index reports a change only when what the board shows changes', () => {
  let changes = 0;
  const index = new SessionIndex(() => { changes += 1; });
  index.load([row(), row({ sessionId: 's-2', title: '发布说明' })]);
  assert.equal(changes, 1);
  assert.deepEqual(index.all().map(track => track.id).sort(), ['s-1', 's-2']);
  index.event('s-1', event('assistant/message', 2_000, {}));
  assert.equal(changes, 1);
  index.status('s-1', true);
  assert.equal(changes, 2);
  index.status('s-1', true);
  assert.equal(changes, 2);
  index.event('s-1', event('tool/call', 2_100, { turn: 1, step: 1, callId: 'c-1', name: 'ask_user_question', arguments: '{}' }));
  assert.equal(changes, 3);
  assert.deepEqual(index.view('s-1')?.state, 'waiting');
  index.activity('s-2', 500);
  assert.equal(changes, 3);
  index.activity('s-2', 9_000);
  assert.equal(changes, 4);
  index.removed('s-1');
  assert.equal(changes, 5);
  assert.equal(index.view('s-1')?.state, 'idle');
  assert.equal(index.has('s-1'), true);
});

test('the index keeps events that arrive before the list and merges the row later', () => {
  const index = new SessionIndex();
  index.status('s-1', true);
  index.event('s-1', event('session/title', 1_500, { title: '整理周报', messageSeqs: [], source: { kind: 'provider', provider: 'p' } }));
  index.load([row({ title: null, running: false })]);
  assert.equal(index.view('s-1')?.state, 'running');
  assert.equal(index.view('s-1')?.title, '整理周报');
  index.added(row({ sessionId: 's-3', title: '看板' }));
  assert.equal(index.view('s-3')?.title, '看板');
});
