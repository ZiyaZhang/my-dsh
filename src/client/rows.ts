/**
 * What the board page's lists say, worked out from the snapshot: the line under each session, which 回顾 days start open, the rows of
 * 等你处理 and 跟进事项, and a matter's counts by column. Pure, so it can be tested with a fixed clock.
 */
import { previewLine } from '../host/preview.js';
import type { BoardMatter, BoardSession, ReviewSession, SessionState } from '../host/remote.js';
import { waitingSince } from '../host/snapshot.js';

/** The line under a session's title. A waiting or failed session the Host sent no preview for still says so. */
export function lineOf(session: BoardSession, now: number): string {
  if (session.preview) return previewLine(session.preview, now);
  if (session.state === 'waiting') return session.wait === 'approval' ? '在等你批准' : '在等你回答';
  if (session.state === 'failed') return '失败';
  return '';
}

/** 今天 and 昨天 start open and older days folded; a day the user toggled keeps the user's choice. */
export function dayOpen(day: { day: string; daysAgo: number }, toggled: Readonly<Record<string, boolean>>): boolean {
  return toggled[day.day] ?? day.daysAgo <= 1;
}

/** One row of 等你处理. */
export interface WaitingRow {
  id: string;
  title: string;
  state: SessionState;
  matter?: { id: string; name: string };
  /** When it began to need the user: when it asked, else its last activity. */
  at: number;
  line: string;
}

/** 等你处理, in the order the Host gives: the longest wait first. */
export function waitingRows(sessions: readonly ReviewSession[], now: number): WaitingRow[] {
  return sessions.map(session => ({
    id: session.id, title: session.title, state: session.state, ...(session.matter ? { matter: session.matter } : {}),
    at: waitingSince(session), line: lineOf(session, now),
  }));
}

/** One row of 跟进事项. `state` is its newest session's; a matter without sessions has none. */
export interface FollowRow {
  id: string;
  name: string;
  lastActivity: number;
  state?: SessionState;
  line: string;
}

/** 跟进事项: the matters in progress, in the board's order, each with a line about its newest session: `<title> · <its line>`. */
export function followRows(matters: readonly BoardMatter[], now: number): FollowRow[] {
  return matters.filter(matter => !matter.archivedAt).map((matter) => {
    const newest = matter.sessions[0];
    if (!newest) return { id: matter.id, name: matter.name, lastActivity: matter.lastActivity, line: '还没有会话' };
    const line = lineOf(newest, now);
    return { id: matter.id, name: matter.name, lastActivity: matter.lastActivity, state: newest.state, line: line ? `${newest.title} · ${line}` : newest.title };
  });
}

/** A matter's sessions by the column that holds them: a failed session sits with the idle ones. */
export function columnCounts(sessions: readonly BoardSession[]): { waiting: number; running: number; idle: number } {
  const counts = { waiting: 0, running: 0, idle: 0 };
  for (const session of sessions) counts[session.state === 'failed' ? 'idle' : session.state] += 1;
  return counts;
}
