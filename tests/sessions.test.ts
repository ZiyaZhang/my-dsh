import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SessionIndex, emptyTrack, lastActivity, lastReply, previewOf, sessionState, sessionView, trackEvent, trackRemoved, trackRow, trackStatus,
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
  assert.equal(decided.refused, undefined);
});

test('a rejected approval is kept as a refused tool until the next turn starts', () => {
  const asked = fold(trackStatus(cold(), true), event('turn/start', 2_000, { turn: 1 }),
    event('approval/asked', 2_100, { id: 'a-1', toolName: 'write', callId: 'c-1' }),
    event('approval/asked', 2_150, { id: 'a-2', toolName: 'bash', callId: 'c-2' }));
  const decided = fold(asked,
    event('approval/decided', 2_200, { id: 'a-1', outcome: 'rejected' }),
    event('approval/decided', 2_250, { id: 'a-2', outcome: 'allowed-once' }),
    event('approval/decided', 2_260, { id: 'a-9', outcome: 'rejected' }));
  assert.deepEqual(decided.refused, ['write']);
  assert.deepEqual(sessionState(decided), { state: 'running' });
  const ended = fold(decided, event('turn/end', 2_300, { turn: 1, reason: { kind: 'completed' } }));
  assert.deepEqual(ended.refused, ['write']);
  assert.equal(fold(ended, event('turn/start', 3_000, { turn: 2 })).refused, undefined);
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
  assert.equal(trackEvent(track, event('assistant/message', 2_000, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }] } })), track);
  assert.equal(trackEvent(track, event('tool/call', 2_000, { turn: 1, step: 1, name: 'bash', arguments: '' })), track);
  assert.equal(trackEvent(track, event('tool/result', 2_000, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c-9', content: [] } })), track);
  assert.equal(trackEvent(track, event('approval/asked', 2_000, { toolName: 'bash' })), track);
  assert.equal(trackEvent(track, event('request/header', 2_000, {})), track);
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

// ── the preview line's parts ────────────────────────────────────────────────────────────────────────────────────────────────────

const call = (time: number, callId: string, name: string, args: unknown) =>
  event('tool/call', time, { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) });
const result = (time: number, callId: string) => event('tool/result', time, { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [] } });
const said = (time: number, ...texts: string[]) =>
  event('assistant/message', time, { turn: 1, step: 1, message: { role: 'assistant', content: texts.map(text => ({ type: 'text', text })) } });
const ended = (time: number, reason: unknown = { kind: 'completed' }) => event('turn/end', time, { turn: 1, reason });
const live = () => fold(trackStatus(cold(), true), event('turn/start', 2_000, { turn: 1 }));

test('a running session shows the model\'s step until a tool runs, then the newest tool call in flight', () => {
  const started = live();
  assert.deepEqual(previewOf(started), { kind: 'running', step: '分析请求', since: 2_000 });
  const stepped = fold(started, event('step/start', 2_100, { turn: 1, step: 1 }));
  assert.deepEqual(previewOf(stepped), { kind: 'running', step: '分析请求', since: 2_100 });
  const reading = fold(stepped, call(2_200, 'c-1', 'read', { path: '/work/notes.md' }));
  assert.deepEqual(previewOf(reading), { kind: 'running', step: '读取文件 /work/notes.md', since: 2_200 });
  const both = fold(reading, call(2_300, 'c-2', 'bash', { command: 'npm test' }));
  assert.deepEqual(previewOf(both), { kind: 'running', step: '运行命令 npm test', since: 2_300 });
  // The newer call returns first: the older one is still in flight.
  assert.deepEqual(previewOf(fold(both, result(2_400, 'c-2'))), { kind: 'running', step: '读取文件 /work/notes.md', since: 2_200 });
  // Every call returned: the model has the step again, from the last result.
  assert.deepEqual(previewOf(fold(both, result(2_400, 'c-2'), result(2_500, 'c-1'))), { kind: 'running', step: '分析请求', since: 2_500 });
  // A running row with no event of the turn seen yet.
  assert.deepEqual(previewOf(cold({ running: true })), { kind: 'running' });
});

test('a waiting session shows its question, even while its agent runs, and a question before an approval', () => {
  const asked = fold(live(), call(2_100, 'c-1', 'ask_user_question', { questions: [{ id: 'q', question: '先改注释还是先改代码？' }] }));
  assert.deepEqual(previewOf(asked), { kind: 'question', text: '先改注释还是先改代码？', since: 2_100 });
  const approval = fold(live(), event('approval/asked', 2_100, { id: 'a-1', toolName: 'bash', callId: 'c-9' }));
  assert.deepEqual(previewOf(approval), { kind: 'approval', tool: 'bash', since: 2_100 });
  const both = fold(approval, call(2_200, 'c-1', 'ask_user_question', { questions: [{ id: 'q', question: '要不要重跑？' }] }));
  assert.deepEqual(sessionState(both), { state: 'waiting', wait: 'question' });
  assert.deepEqual(previewOf(both), { kind: 'question', text: '要不要重跑？', since: 2_200 });
  assert.deepEqual(previewOf(fold(both, result(2_300, 'c-1'))), { kind: 'approval', tool: 'bash', since: 2_100 });
});

test('a failed session shows the error that ended its turn', () => {
  const failed = trackStatus(fold(live(), ended(3_000, { kind: 'error', error: { message: '  Windows 构建没过：\n内存超了 ', code: 'UNKNOWN' } })), false);
  assert.deepEqual(previewOf(failed), { kind: 'failed', error: 'Windows 构建没过： 内存超了' });
  assert.deepEqual(previewOf(trackStatus(fold(live(), ended(3_000, { kind: 'error' })), false)), { kind: 'failed', error: '' });
});

test('an idle session shows how its last reply starts; a turn that said nothing keeps the reply before it', () => {
  const replied = trackStatus(fold(live(), said(2_500, '先看了 CI。'), said(2_800, '两处都删短了，', '跑了 doc-sync。'), ended(3_000)), false);
  assert.deepEqual(previewOf(replied), { kind: 'reply', text: '两处都删短了， 跑了 doc-sync。' });
  const quiet = trackStatus(fold(replied, event('turn/start', 4_000, { turn: 2 }), ended(4_500, { kind: 'aborted', reason: { kind: 'user' } })), false);
  assert.deepEqual(previewOf(quiet), { kind: 'reply', text: '两处都删短了， 跑了 doc-sync。' });
  // While a turn runs, its text is not the last reply yet.
  const next = fold(replied, event('turn/start', 5_000, { turn: 3 }), said(5_100, '新的回复'));
  assert.equal(next.reply, '两处都删短了， 跑了 doc-sync。');
  assert.equal(previewOf(cold()), undefined);
});

test('the last reply of a cold session is the newest turn outline entry with a response', () => {
  const outline = [
    { turn: 1, seq: 3, prompt: '看下 CI', response: '先看了 CI。' },
    { turn: 2, seq: 40, prompt: '改吧', response: '两处都删短了。' },
    { turn: 3, seq: 90, prompt: '停', response: '' },
  ];
  assert.equal(lastReply(outline), '两处都删短了。');
  assert.equal(lastReply([]), undefined);
  assert.equal(lastReply(undefined), undefined);
  assert.equal(lastReply([{ turn: 1, response: 7 }, 'x', null]), undefined);
});

test('replies read at listing time fill in sessions, but not over a reply this process saw', () => {
  let changes = 0;
  const index = new SessionIndex(() => { changes += 1; });
  index.load([row(), row({ sessionId: 's-2', title: '发布说明' }), row({ sessionId: 's-3', title: '看板' })]);
  index.event('s-2', event('turn/start', 2_000, { turn: 1 }));
  index.event('s-2', said(2_500, '这一轮的回复'));
  index.event('s-2', ended(3_000));
  index.status('s-2', false);
  const before = changes;
  index.loadReplies(new Map([['s-1', '旧的回复'], ['s-2', '更旧的回复'], ['s-9', '没有这条会话']]));
  assert.equal(changes, before + 1);
  assert.deepEqual(index.view('s-1')?.preview, { kind: 'reply', text: '旧的回复' });
  assert.deepEqual(index.view('s-2')?.preview, { kind: 'reply', text: '这一轮的回复' });
  assert.equal(index.view('s-3')?.preview, undefined);
  assert.equal(index.has('s-9'), false);
  index.loadReplies(new Map([['s-1', '旧的回复']]));
  assert.equal(changes, before + 1);
});

test('a change that only moves a running step is minor; everything else is not', () => {
  const kinds: boolean[] = [];
  const ids = new Set<string | undefined>();
  const index = new SessionIndex((minor, id) => { kinds.push(minor); ids.add(id); });
  index.load([row()]);
  index.status('s-1', true);
  index.event('s-1', event('turn/start', 2_000, { turn: 1 }));
  index.event('s-1', call(2_100, 'c-1', 'bash', { command: 'npm test' }));
  index.event('s-1', said(2_150, '先跑测试'));
  index.event('s-1', result(2_200, 'c-1'));
  index.event('s-1', call(2_300, 'c-2', 'ask_user_question', { questions: [{ id: 'q', question: '要不要重跑？' }] }));
  assert.deepEqual(kinds, [false, false, false, true, true, false]);
  // The listing names no session; each event names the session it changed.
  assert.deepEqual([...ids], [undefined, 's-1']);
});

test('the view carries the preview the board shows', () => {
  const asked = fold(live(), call(2_100, 'c-1', 'ask_user_question', { questions: [{ id: 'q', question: '要不要重跑？' }] }));
  assert.deepEqual(sessionView(asked).preview, { kind: 'question', text: '要不要重跑？', since: 2_100 });
  assert.equal('preview' in sessionView(cold()), false);
});
