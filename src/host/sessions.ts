/**
 * What each session is doing, folded from the session list and the events this DSH process sees. DSH has no "now waiting for input"
 * event, so waiting is read off the log: an `approval/asked` without its `approval/decided`, or an `ask_user_question` call without its
 * `tool/result`. Everything here is process-local: a session another DSH process runs shows up only as a cold row, which reads as idle.
 *
 * The track functions are pure and return the same object when an input changes nothing the board reads.
 */
import type { SessionState, WaitKind } from './remote.js';

/** A session list row, cut down to what the board reads. `title` is undefined when the row's projection block leaves it out. */
export interface SessionRow {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  origin?: 'subagent';
  title?: string | null;
}

/** One `session/event`, cut down to what the board reads. */
export interface SessionEventLike {
  type: string;
  time: number;
  data: unknown;
}

interface Wait { kind: WaitKind; id: string }

export interface SessionTrack {
  readonly id: string;
  readonly title: string | null;
  /** A `session/title` event named it; a list row read earlier does not override that. */
  readonly titleSeen: boolean;
  /** Latest human prompt, epoch ms (the list row's `updatedAt`). */
  readonly updatedAt: number;
  readonly running: boolean;
  /** A status or turn event set `running`; a list row read earlier does not override that. */
  readonly runningSeen: boolean;
  readonly blank: boolean;
  readonly subagent: boolean;
  /** Pending waits, oldest first. */
  readonly waits: readonly Wait[];
  readonly turnStart?: number;
  readonly turnEnd?: { readonly time: number; readonly failed: boolean };
}

/**
 * Where a row came from. `list`: the start-up listing, read while events already arrived, so it fills in only what no event has said.
 * `added`: an `api-session/added` row, current when it was emitted, so it wins.
 */
export type RowSource = 'list' | 'added';

export function emptyTrack(id: string): SessionTrack {
  return { id, title: null, titleSeen: false, updatedAt: 0, running: false, runningSeen: false, blank: false, subagent: false, waits: [] };
}

export function trackRow(track: SessionTrack | undefined, row: SessionRow, source: RowSource): SessionTrack {
  const base = track ?? emptyTrack(row.sessionId);
  const fresh = source === 'added';
  const turnSeen = base.turnStart !== undefined || base.turnEnd !== undefined;
  return {
    ...base,
    title: row.title !== undefined && (fresh || !base.titleSeen) ? row.title : base.title,
    updatedAt: Math.max(base.updatedAt, row.updatedAt),
    running: fresh || !base.runningSeen ? row.running : base.running,
    waits: fresh && !row.running ? [] : base.waits,
    blank: row.blank && !turnSeen,
    subagent: row.origin === 'subagent',
  };
}

/** An agent changed running state. An agent that stops has no turn open, so nothing can still be waiting. */
export function trackStatus(track: SessionTrack, running: boolean): SessionTrack {
  if (track.running === running && track.runningSeen && (running || track.waits.length === 0)) return track;
  return { ...track, running, runningSeen: true, waits: running ? track.waits : [] };
}

/** A user prompt moved the list activity time. */
export function trackActivity(track: SessionTrack, updatedAt: number): SessionTrack {
  return updatedAt > track.updatedAt ? { ...track, updatedAt } : track;
}

/** The session left this process's live registry: its agent is gone, so it neither runs nor waits here. */
export function trackRemoved(track: SessionTrack): SessionTrack {
  return { ...track, running: false, runningSeen: true, waits: [] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const textField = (data: unknown, key: string): string | undefined => {
  const value = isRecord(data) ? data[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};

export function trackEvent(track: SessionTrack, event: SessionEventLike): SessionTrack {
  const { data } = event;
  switch (event.type) {
    case 'turn/start':
      return { ...track, turnStart: event.time, running: true, runningSeen: true, blank: false };
    case 'turn/end': {
      const reason = isRecord(data) ? data.reason : undefined;
      return { ...track, turnEnd: { time: event.time, failed: textField(reason, 'kind') === 'error' }, waits: [], blank: false };
    }
    case 'approval/asked': {
      const id = textField(data, 'id');
      return id === undefined ? track : { ...track, waits: [...track.waits, { kind: 'approval', id }] };
    }
    case 'approval/decided': {
      const id = textField(data, 'id');
      return id !== undefined && track.waits.some(wait => wait.kind === 'approval' && wait.id === id)
        ? { ...track, waits: track.waits.filter(wait => !(wait.kind === 'approval' && wait.id === id)) }
        : track;
    }
    case 'tool/call': {
      const id = textField(data, 'callId');
      return id !== undefined && textField(data, 'name') === 'ask_user_question'
        ? { ...track, waits: [...track.waits, { kind: 'question', id }] }
        : track;
    }
    case 'tool/result': {
      const id = textField(isRecord(data) ? data.message : undefined, 'toolCallId');
      return id !== undefined && track.waits.some(wait => wait.kind === 'question' && wait.id === id)
        ? { ...track, waits: track.waits.filter(wait => !(wait.kind === 'question' && wait.id === id)) }
        : track;
    }
    case 'session/title': {
      const title = textField(data, 'title');
      return title === undefined ? track : { ...track, title, titleSeen: true };
    }
    default:
      return track;
  }
}

/** Waiting wins over running, running over a failed last turn. */
export function sessionState(track: SessionTrack): { state: SessionState; wait?: WaitKind } {
  const first = track.waits[0];
  if (first) return { state: 'waiting', wait: first.kind };
  if (track.running) return { state: 'running' };
  if (track.turnEnd?.failed) return { state: 'failed' };
  return { state: 'idle' };
}

/** The latest of the last prompt, the last turn start and the last turn end. */
export function lastActivity(track: SessionTrack): number {
  return Math.max(track.updatedAt, track.turnStart ?? 0, track.turnEnd?.time ?? 0);
}

/** What the board shows of one session; the index compares these to decide whether anything changed. */
export interface SessionView {
  id: string;
  title: string | null;
  blank: boolean;
  subagent: boolean;
  state: SessionState;
  wait?: WaitKind;
  lastActivity: number;
}

export function sessionView(track: SessionTrack): SessionView {
  return { id: track.id, title: track.title, blank: track.blank, subagent: track.subagent, ...sessionState(track), lastActivity: lastActivity(track) };
}

const sameView = (a: SessionView | undefined, b: SessionView): boolean => a !== undefined
  && a.title === b.title && a.blank === b.blank && a.subagent === b.subagent && a.state === b.state && a.wait === b.wait
  && a.lastActivity === b.lastActivity;

/** Every session this process knows, kept current by the Host's listeners; `changed` runs when what the board shows changes. */
export class SessionIndex {
  private readonly tracks = new Map<string, SessionTrack>();

  constructor(private readonly changed: () => void = () => {}) {}

  /** The start-up listing; reports one change for the whole list. */
  load(rows: readonly SessionRow[]): void {
    for (const row of rows) this.tracks.set(row.sessionId, trackRow(this.tracks.get(row.sessionId), row, 'list'));
    this.changed();
  }

  added(row: SessionRow): void { this.apply(row.sessionId, track => trackRow(track, row, 'added')); }
  status(id: string, running: boolean): void { this.apply(id, track => trackStatus(track ?? emptyTrack(id), running)); }
  activity(id: string, updatedAt: number): void { this.apply(id, track => trackActivity(track ?? emptyTrack(id), updatedAt)); }
  removed(id: string): void { if (this.tracks.has(id)) this.apply(id, track => trackRemoved(track!)); }
  event(id: string, event: SessionEventLike): void { this.apply(id, track => trackEvent(track ?? emptyTrack(id), event)); }

  has(id: string): boolean { return this.tracks.has(id); }
  view(id: string): SessionView | undefined {
    const track = this.tracks.get(id);
    return track && sessionView(track);
  }
  all(): SessionTrack[] { return [...this.tracks.values()]; }

  private apply(id: string, change: (track: SessionTrack | undefined) => SessionTrack): void {
    const before = this.tracks.get(id);
    const after = change(before);
    if (after === before) return;
    this.tracks.set(id, after);
    if (!sameView(before && sessionView(before), sessionView(after))) this.changed();
  }
}
