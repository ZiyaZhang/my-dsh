/**
 * 往回报 (report back): once every session a matter's conversation dispatched has stopped, the Host wakes that conversation once with
 * their results, so it can tell the user. This module keeps a book per dispatcher (a matter's conversation): the sessions it dispatched,
 * one note per watched session whose turn ended since the last wake, the wakes since the user last spoke there, whether waking is
 * paused, and whether a wake's turn is still open. It also decides when to wake and writes the message. Every function is pure; the Host
 * owns the timers, the session events and the delivery. The books live in memory only: after a Host restart nothing is watched.
 */
import type { SessionState, WaitKind } from './remote.js';

/** How long the Host waits after a turn ends before it checks, so sessions ending together, or a queued next turn, make one wake. */
export const WAKE_DELAY_MS = 3_000;
/** Wakes in a row without a user message in between; at the cap, notes wait for the user. */
export const WAKES_MAX = 10;
/** How much of a finished session's newest reply the message carries, in characters. */
export const REPLY_CHARS = 400;

/** What a watched session's ended turn leaves for its dispatcher. */
export interface ReportNote {
  sessionId: string;
  title: string;
  /** How the turn ended: DSH's turn end reason, such as `completed`, `error` or `aborted`. */
  outcome: string;
  /** `completed`: its newest reply; `error`: the error message. */
  text?: string;
  /** Tools whose approval the user rejected in that turn: those operations did not run, whatever the reply says. */
  refused?: string[];
}

/** One dispatcher's book. */
export interface Book {
  /** The sessions it dispatched, in the order it first did. */
  watched: string[];
  /** At most one per watched session whose turn ended since the last wake, oldest first. */
  notes: ReportNote[];
  /** Wakes since the user last spoke in the dispatcher. */
  wakes: number;
  /** A wake's turn was stopped or failed: no wakes until the user speaks there again. */
  paused: boolean;
  /** A wake was sent and the dispatcher's turn that reads it has not ended. */
  waking: boolean;
}

/** Books by dispatcher session id. */
export type Books = ReadonlyMap<string, Book>;

const emptyBook = (): Book => ({ watched: [], notes: [], wakes: 0, paused: false, waking: false });

/** Change one dispatcher's book; undefined from `change` drops it. Books stay the same object when nothing changes. */
function update(books: Books, dispatcher: string, change: (book: Book) => Book | undefined): Books {
  const book = books.get(dispatcher);
  if (!book) return books;
  const next = change(book);
  if (next === book) return books;
  const copy = new Map(books);
  if (next) copy.set(dispatcher, next);
  else copy.delete(dispatcher);
  return copy;
}

/** The dispatcher dispatched a session: it is watched from now on. A session it already watches changes nothing. */
export function watch(books: Books, dispatcher: string, sessionId: string): Books {
  const book = books.get(dispatcher) ?? emptyBook();
  if (book.watched.includes(sessionId)) return books;
  return new Map(books).set(dispatcher, { ...book, watched: [...book.watched, sessionId] });
}

/** The dispatchers that watch a session. */
export function watchersOf(books: Books, sessionId: string): string[] {
  return [...books].flatMap(([dispatcher, book]) => (book.watched.includes(sessionId) ? [dispatcher] : []));
}

/** A session's turn ended: a note for each dispatcher that watches it, replacing its older note there. Unwatched sessions leave none. */
export function noteTurnEnd(books: Books, note: ReportNote): Books {
  let next = books;
  for (const dispatcher of watchersOf(books, note.sessionId)) {
    next = update(next, dispatcher, book => ({ ...book, notes: [...book.notes.filter(old => old.sessionId !== note.sessionId), { ...note }] }));
  }
  return next;
}

/** The user spoke in the dispatcher: the wake count starts again, and a pause ends. */
export function userTurn(books: Books, dispatcher: string): Books {
  return update(books, dispatcher, book => (book.wakes === 0 && !book.paused && !book.waking ? book : { ...book, wakes: 0, paused: false, waking: false }));
}

/** A wake went out: its notes are delivered, and the wake counts. */
export function wakeSent(books: Books, dispatcher: string): Books {
  return update(books, dispatcher, book => ({ ...book, notes: [], wakes: book.wakes + 1, waking: true }));
}

/** The dispatcher's own turn ended. A wake's turn that was stopped or failed pauses waking until the user speaks again. */
export function wakeTurnEnded(books: Books, dispatcher: string, outcome: string): Books {
  return update(books, dispatcher, book => (book.waking ? { ...book, waking: false, paused: book.paused || outcome === 'aborted' || outcome === 'error' } : book));
}

/** Stop watching a session for one dispatcher, with its note: it was archived or left the matter. */
export function forgetSession(books: Books, dispatcher: string, sessionId: string): Books {
  return update(books, dispatcher, book => (book.watched.includes(sessionId)
    ? { ...book, watched: book.watched.filter(id => id !== sessionId), notes: book.notes.filter(note => note.sessionId !== sessionId) }
    : book));
}

/** Drop a dispatcher's book: its conversation was archived or is not the matter's conversation any more. */
export function forgetDispatcher(books: Books, dispatcher: string): Books {
  return update(books, dispatcher, () => undefined);
}

/** What the wake decision reads of the sessions now. */
export interface WakeStates {
  /** The dispatcher's state as this process sees it; undefined when it does not know the session. */
  dispatcher: SessionState | undefined;
  /** DSH archived the dispatcher. */
  archived: boolean;
  /** Each watched session's state, by id. */
  sessions: ReadonlyMap<string, SessionState | undefined>;
}

/**
 * Whether to wake the dispatcher now: it has notes, no watched session runs (one that waits for the user does not hold the wake back),
 * the dispatcher itself is idle or failed and not archived, no wake's turn is open, waking is not paused, and the cap is not reached.
 */
export function shouldWake(book: Book | undefined, states: WakeStates): boolean {
  if (!book || book.notes.length === 0 || book.paused || book.waking || book.wakes >= WAKES_MAX || states.archived) return false;
  if (states.dispatcher !== 'idle' && states.dispatcher !== 'failed') return false;
  return !book.watched.some(id => states.sessions.get(id) === 'running');
}

/** A watched session that waits for the user when the wake goes out. `tool` names what an approval is for. */
export interface WaitingSession {
  sessionId: string;
  title: string;
  wait: WaitKind;
  tool?: string;
}

/** The start of a reply for the message: whitespace collapsed, the first {@link REPLY_CHARS} characters. */
function replyStart(text: string | undefined): string {
  return [...(text ?? '').replace(/\s+/g, ' ').trim()].slice(0, REPLY_CHARS).join('').trimEnd();
}

/** What the Host saw that the session's own reply may leave out: the operations the user rejected. */
const refusedText = (note: ReportNote): string => (note.refused?.length ? `用户拒绝了${[...new Set(note.refused)].join('、')}，这些操作没有执行。` : '');

function noteLine(note: ReportNote): string {
  const head = `- 「${note.title}」`;
  const id = `id=${note.sessionId}`;
  const refused = refusedText(note);
  switch (note.outcome) {
    case 'completed': {
      const reply = replyStart(note.text);
      return `${head}做完了（${id}）。${refused}${reply ? `最后的回复：${reply}` : ''}`;
    }
    case 'error': return `${note.text ? `${head}出错了（${id}）：${note.text}${refused ? '。' : ''}` : `${head}出错了（${id}）。`}${refused}`;
    case 'aborted': return `${head}被停下了（${id}）。${refused}`;
    default: return `${head}停下了（${id}，${note.outcome}）。${refused}`;
  }
}

function waitingLine(session: WaitingSession): string {
  const id = `id=${session.sessionId}`;
  return session.wait === 'approval'
    ? `- 「${session.title}」在等用户批准${session.tool ?? ''}（${id}）。`
    : `- 「${session.title}」在等用户回答问题（${id}）。`;
}

/** The wake's message: each note's outcome, the watched sessions still waiting for the user, and what this turn is for. */
export function reportText(notes: readonly ReportNote[], waiting: readonly WaitingSession[]): string {
  const lines = ['派出去的会话有结果了：', ...notes.map(noteLine)];
  if (waiting.length) lines.push('还在等用户的：', ...waiting.map(waitingLine));
  const refused = notes.some(note => note.refused?.length) ? '用户拒绝过的操作没有执行，照实说，不要说它做成了。' : '';
  lines.push(`这一轮只汇报：用一两句告诉用户结果和要用户定的事，不复述原文，要细节用 session_recent 读。${refused}${waiting.length ? '在等用户的会话提一句是哪条就行，用户在“待处理”里能直接处理。' : ''}`);
  return lines.join('\n');
}

/** The one-line account the wake's message carries. */
export const reportSummary = (notes: readonly ReportNote[]): string => `${notes.length} 条会话有结果`;

/** How a `turn/end` event's turn ended: its reason's kind. */
export function turnEndKind(data: unknown): string | undefined {
  const reason = typeof data === 'object' && data !== null ? (data as { reason?: unknown }).reason : undefined;
  const kind = typeof reason === 'object' && reason !== null ? (reason as { kind?: unknown }).kind : undefined;
  return typeof kind === 'string' ? kind : undefined;
}
