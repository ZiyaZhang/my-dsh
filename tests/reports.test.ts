import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REPLY_CHARS, WAKES_MAX, WAKE_QUIET, WAKE_TURN, forgetDispatcher, forgetSession, noteTurnEnd, reportSummary, reportText, shouldWake, turnEndKind, userTurn, wakeSent,
  wakeTurnEnded, watch, watchersOf, type Book, type Books, type ReportNote, type WakeStates,
} from '../src/host/reports.ts';
import type { SessionState } from '../src/host/remote.ts';

const done = (sessionId: string, text = '报告写好了'): ReportNote => ({ sessionId, title: `会话 ${sessionId}`, outcome: 'completed', text });
/** The dispatcher `s-talk` watching `s-1` and `s-2`. */
const books = (): Books => watch(watch(new Map(), 's-talk', 's-1'), 's-talk', 's-2');
const book = (all: Books): Book => all.get('s-talk')!;
const states = (dispatcher: SessionState | undefined, sessions: Record<string, SessionState> = {}, archived = false, hosted = true): WakeStates =>
  ({ dispatcher, archived, hosted, sessions: new Map(Object.entries(sessions)) });

test('a session the conversation dispatched is watched once; a note comes only from a watched session, and a newer one replaces the older', () => {
  const start = books();
  assert.deepEqual(book(start), { watched: ['s-1', 's-2'], last: [], notes: [], wakes: 0, paused: false, waking: false });
  // Sending again to a watched session changes nothing.
  assert.equal(watch(start, 's-talk', 's-1'), start);
  assert.deepEqual(watchersOf(start, 's-1'), ['s-talk']);
  assert.deepEqual(watchersOf(start, 's-mine'), []);
  // The user's own session in the matter, or a subagent, was not dispatched: its turn leaves no note.
  assert.equal(noteTurnEnd(start, done('s-mine')), start);
  const first = noteTurnEnd(start, done('s-1', '第一版'));
  const second = noteTurnEnd(noteTurnEnd(first, done('s-2')), done('s-1', '第二版'));
  assert.deepEqual(book(second).notes.map(note => [note.sessionId, note.text]), [['s-2', '报告写好了'], ['s-1', '第二版']]);
});

test('no wake while a watched session runs, or while the dispatcher runs or waits; one waiting for the user does not hold it back', () => {
  const noted = noteTurnEnd(books(), done('s-1'));
  assert.equal(shouldWake(book(noted), states('idle')), true);
  assert.equal(shouldWake(book(noted), states('failed')), true);
  assert.equal(shouldWake(book(noted), states('idle', { 's-2': 'running' })), false);
  assert.equal(shouldWake(book(noted), states('idle', { 's-2': 'waiting' })), true);
  assert.equal(shouldWake(book(noted), states('running')), false);
  assert.equal(shouldWake(book(noted), states('waiting')), false);
  assert.equal(shouldWake(book(noted), states(undefined)), false);
  assert.equal(shouldWake(book(noted), states('idle', {}, true)), false);
  // Nothing to say, or no book at all.
  assert.equal(shouldWake(book(books()), states('idle')), false);
  assert.equal(shouldWake(undefined, states('idle')), false);
  // A wake whose turn has not ended yet holds the next one back.
  assert.equal(shouldWake(book(noteTurnEnd(wakeSent(noted, 's-talk'), done('s-2'))), states('idle')), false);
});

test('a matter that is not hosted is never woken: its cards show the sessions, and its conversation reads them on the user\'s next turn', () => {
  const all = noteTurnEnd(noteTurnEnd(books(), done('s-1')), done('s-2'));
  assert.equal(shouldWake(book(all), states('idle', {}, false, false)), false);
  assert.equal(shouldWake(book(all), states('failed', {}, false, false)), false);
  // The notes stay: hosted later, the first wake carries them.
  assert.equal(book(all).notes.length, 2);
  assert.equal(shouldWake(book(all), states('idle')), true);
});

test('a wake delivers the notes and counts; ten in a row without the user is the cap, and a user turn starts the count again', () => {
  let all = books();
  for (let n = 0; n < WAKES_MAX; n += 1) {
    all = noteTurnEnd(all, done('s-1', `第${n}版`));
    assert.equal(shouldWake(book(all), states('idle')), true, `wake ${n + 1}`);
    all = wakeSent(all, 's-talk');
    assert.deepEqual(book(all).notes, []);
    all = wakeTurnEnded(all, 's-talk', 'completed');
  }
  assert.equal(book(all).wakes, WAKES_MAX);
  all = noteTurnEnd(all, done('s-1', '又一版'));
  assert.equal(shouldWake(book(all), states('idle')), false);
  // The note waits for the user, and goes out once the user has spoken and the dispatcher is idle again.
  all = userTurn(all, 's-talk');
  assert.equal(book(all).wakes, 0);
  assert.deepEqual(book(all).notes.map(note => note.text), ['又一版']);
  assert.equal(shouldWake(book(all), states('running')), false);
  assert.equal(shouldWake(book(all), states('idle')), true);
  assert.equal(WAKES_MAX, 10);
});

test('a wake turn that was stopped or failed pauses waking until the next user turn; other turn ends do not', () => {
  const woken = wakeSent(noteTurnEnd(books(), done('s-1')), 's-talk');
  for (const outcome of ['aborted', 'error']) {
    const stopped = wakeTurnEnded(woken, 's-talk', outcome);
    assert.deepEqual([book(stopped).paused, book(stopped).waking], [true, false], outcome);
    const later = noteTurnEnd(stopped, done('s-2'));
    assert.equal(shouldWake(book(later), states('idle')), false);
    assert.equal(shouldWake(book(userTurn(later, 's-talk')), states('idle')), true);
  }
  assert.equal(book(wakeTurnEnded(woken, 's-talk', 'completed')).paused, false);
  // The dispatcher's own turn, not a wake's, ending aborted pauses nothing.
  const own = noteTurnEnd(books(), done('s-1'));
  assert.equal(wakeTurnEnded(own, 's-talk', 'aborted'), own);
  // A user message that lands while a wake waits makes that turn the user's.
  assert.equal(book(userTurn(woken, 's-talk')).waking, false);
});

test('a session archived or out of the matter is forgotten with its note; an archived conversation is forgotten whole', () => {
  const noted = noteTurnEnd(noteTurnEnd(books(), done('s-1')), done('s-2'));
  const left = forgetSession(noted, 's-talk', 's-1');
  assert.deepEqual(book(left).watched, ['s-2']);
  assert.deepEqual(book(left).notes.map(note => note.sessionId), ['s-2']);
  assert.equal(forgetSession(noted, 's-talk', 's-other'), noted);
  assert.equal(forgetDispatcher(noted, 's-talk').has('s-talk'), false);
  assert.equal(forgetDispatcher(noted, 's-nobody'), noted);
});

test('the message says how each turn ended, with the start of a finished reply and the error, then who waits for the user', () => {
  const notes: ReportNote[] = [
    { sessionId: 's-1', title: '出报告', outcome: 'completed', text: '  报告\n\n  写好了，\t放在 report.md ' },
    { sessionId: 's-2', title: '跑测试', outcome: 'error', text: '构建没过' },
    { sessionId: 's-3', title: '装插件', outcome: 'aborted' },
    { sessionId: 's-4', title: '整理', outcome: 'max-tokens' },
    { sessionId: 's-5', title: '空回复', outcome: 'completed' },
    { sessionId: 's-6', title: '没说原因', outcome: 'error' },
  ];
  const waiting = [
    { sessionId: 's-7', title: '定开关', wait: 'question' as const },
    { sessionId: 's-8', title: '删目录', wait: 'approval' as const, tool: 'bash' },
  ];
  assert.equal(reportText(notes, waiting), [
    '派出去的会话有结果了：',
    '- 「出报告」做完了（id=s-1）。最后的回复：报告 写好了， 放在 report.md',
    '- 「跑测试」出错了（id=s-2）：构建没过',
    '- 「装插件」被停下了（id=s-3）。',
    '- 「整理」停下了（id=s-4，max-tokens）。',
    '- 「空回复」做完了（id=s-5）。',
    '- 「没说原因」出错了（id=s-6）。',
    '还在等用户的：',
    '- 「定开关」在等用户回答问题（id=s-7）。',
    '- 「删目录」在等用户批准bash（id=s-8）。',
    `${WAKE_TURN}在等用户的会话不用提，用户在卡片和“待处理”里能直接处理。${WAKE_QUIET}`,
  ].join('\n'));
  // Without waiting sessions the block and its sentence are left out.
  assert.equal(reportText([notes[2]!], []), [
    '派出去的会话有结果了：',
    '- 「装插件」被停下了（id=s-3）。',
    `${WAKE_TURN}${WAKE_QUIET}`,
  ].join('\n'));
  for (const outcome of ['interrupted', 'blocked', 'forked']) {
    assert.match(reportText([{ sessionId: 's-9', title: 'x', outcome }], []), new RegExp(`- 「x」停下了（id=s-9，${outcome}）。`));
  }
  assert.equal(reportSummary(notes), '6 条会话有结果');
});

test('what the user rejected goes into the note and the instruction, whatever the reply says', () => {
  const text = reportText([
    { sessionId: 's-1', title: '写文件', outcome: 'completed', text: '完成', refused: ['write', 'write'] },
    { sessionId: 's-2', title: '跑脚本', outcome: 'error', text: '退出码 1', refused: ['bash'] },
  ], []);
  assert.equal(text, [
    '派出去的会话有结果了：',
    '- 「写文件」做完了（id=s-1）。用户拒绝了write，这些操作没有执行。最后的回复：完成',
    '- 「跑脚本」出错了（id=s-2）：退出码 1。用户拒绝了bash，这些操作没有执行。',
    `${WAKE_TURN}用户拒绝过的操作没有执行，照实说，不要说它做成了。${WAKE_QUIET}`,
  ].join('\n'));
});

test('a finished reply is cut to its first 400 characters after its whitespace is collapsed', () => {
  const cut = (text: string) => reportText([{ sessionId: 's-1', title: '长', outcome: 'completed', text }], []).split('\n')[1]!;
  assert.equal(cut(`${'甲'.repeat(REPLY_CHARS - 2)}\n\n乙丙丁`), `- 「长」做完了（id=s-1）。最后的回复：${'甲'.repeat(REPLY_CHARS - 2)} 乙`);
  // A cut that ends on collapsed whitespace leaves no space at the end.
  assert.equal(cut(`${'甲'.repeat(REPLY_CHARS - 1)}\n\n乙`), `- 「长」做完了（id=s-1）。最后的回复：${'甲'.repeat(REPLY_CHARS - 1)}`);
  assert.equal(REPLY_CHARS, 400);
});

test('a turn end event names how the turn ended', () => {
  assert.equal(turnEndKind({ turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } }), 'aborted');
  assert.equal(turnEndKind({ turn: 3, reason: { kind: 'error', error: { message: '没过' } } }), 'error');
  assert.equal(turnEndKind({ turn: 3 }), undefined);
  assert.equal(turnEndKind(null), undefined);
});

test('a completed turn of a session sent the user\'s last step leaves no note, so the work ending wakes no one; a failed one still does', () => {
  // The dispatcher sent s-2 the last step after s-1 finished and was reported.
  const sent = watch(books(), 's-talk', 's-2', true);
  assert.deepEqual(book(sent).last, ['s-2']);
  assert.equal(watch(sent, 's-talk', 's-2', true), sent);
  const quiet = noteTurnEnd(sent, done('s-2'));
  assert.deepEqual(book(quiet).notes, []);
  assert.equal(shouldWake(book(quiet), states('idle')), false);
  // A last step that fails or is stopped is reported, so the conversation can act on it.
  const failed = noteTurnEnd(sent, { sessionId: 's-2', title: '会话 s-2', outcome: 'error', text: '构建没过' });
  assert.equal(shouldWake(book(failed), states('idle')), true);
  // Its completed turn also takes back an older note of the same session.
  assert.deepEqual(book(noteTurnEnd(failed, done('s-2'))).notes, []);
  // Another step sent to the same session without the mark makes it an ordinary dispatch again.
  const again = watch(sent, 's-talk', 's-2');
  assert.deepEqual(book(again).last, []);
  assert.equal(shouldWake(book(noteTurnEnd(again, done('s-2'))), states('idle')), true);
  // Another session's ordinary note still wakes the dispatcher, with that note alone.
  const mixed = noteTurnEnd(noteTurnEnd(sent, done('s-1')), done('s-2'));
  assert.deepEqual(book(mixed).notes.map(note => note.sessionId), ['s-1']);
  assert.equal(shouldWake(book(mixed), states('idle')), true);
});
