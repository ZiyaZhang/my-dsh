/**
 * What each session is doing, folded from the session list and the events this DSH process sees. DSH has no "now waiting for input"
 * event, so waiting is read off the log: an `approval/asked` without its `approval/decided`, or an `ask_user_question` call without its
 * `tool/result`. Everything here is process-local: a session another DSH process runs shows up only as a cold row, which reads as idle.
 *
 * Each session also keeps the parts of its preview line: the step or tool call in flight, what it waits for, the error that ended its
 * last turn, and how its last reply starts. The reply comes from the turn outline DSH caches for every session, read once at listing
 * time, and from the turns this process sees end.
 *
 * The track functions are pure and return the same object when an input changes nothing the board reads.
 */
import { THINKING, clip, questionText, toolStep, type Preview } from './preview.js';
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

/** A pending question or approval: `text` is the question, or the tool the approval is about. */
interface Wait { kind: WaitKind; id: string; text: string; since: number }

/** Something running in the open turn, with the moment it started. */
interface Step { label: string; since: number }

/** A tool call in flight. */
interface Call extends Step { id: string }

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
  /** The model's part of the open turn: since the turn or the step started, or since its last tool call returned. */
  readonly step?: Step;
  /** Tool calls in flight, oldest first; an `ask_user_question` call is a wait instead. */
  readonly calls: readonly Call[];
  /** How the last reply starts. */
  readonly reply?: string;
  /** A turn this process saw end set `reply`; a reply read at listing time is older and does not override it. */
  readonly replySeen: boolean;
  /** The newest reply text of the open turn; it becomes `reply` when the turn ends, as in DSH's turn outline. */
  readonly draft?: string;
  readonly turnStart?: number;
  readonly turnEnd?: { readonly time: number; readonly failed: boolean; readonly error?: string };
}

/**
 * Where a row came from. `list`: the start-up listing, read while events already arrived, so it fills in only what no event has said.
 * `added`: an `api-session/added` row, current when it was emitted, so it wins.
 */
export type RowSource = 'list' | 'added';

export function emptyTrack(id: string): SessionTrack {
  return { id, title: null, titleSeen: false, updatedAt: 0, running: false, runningSeen: false, blank: false, subagent: false, waits: [], calls: [], replySeen: false };
}

/** Nothing runs or waits: the agent stopped or left. */
const stopped = { waits: [], calls: [], step: undefined } as const;

export function trackRow(track: SessionTrack | undefined, row: SessionRow, source: RowSource): SessionTrack {
  const base = track ?? emptyTrack(row.sessionId);
  const fresh = source === 'added';
  const turnSeen = base.turnStart !== undefined || base.turnEnd !== undefined;
  return {
    ...base,
    title: row.title !== undefined && (fresh || !base.titleSeen) ? row.title : base.title,
    updatedAt: Math.max(base.updatedAt, row.updatedAt),
    running: fresh || !base.runningSeen ? row.running : base.running,
    ...(fresh && !row.running ? stopped : {}),
    blank: row.blank && !turnSeen,
    subagent: row.origin === 'subagent',
  };
}

/** A reply read at listing time; one this process saw a turn end with is newer. */
export function trackReply(track: SessionTrack, reply: string): SessionTrack {
  return track.replySeen || track.reply === reply ? track : { ...track, reply };
}

/** An agent changed running state. An agent that stops has no turn open, so nothing can still be waiting. */
export function trackStatus(track: SessionTrack, running: boolean): SessionTrack {
  const idle = track.waits.length === 0 && track.calls.length === 0 && track.step === undefined;
  if (track.running === running && track.runningSeen && (running || idle)) return track;
  return { ...track, running, runningSeen: true, ...(running ? {} : stopped) };
}

/** A user prompt moved the list activity time. */
export function trackActivity(track: SessionTrack, updatedAt: number): SessionTrack {
  return updatedAt > track.updatedAt ? { ...track, updatedAt } : track;
}

/** The session left this process's live registry: its agent is gone, so it neither runs nor waits here. */
export function trackRemoved(track: SessionTrack): SessionTrack {
  return { ...track, running: false, runningSeen: true, ...stopped };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const textField = (data: unknown, key: string): string | undefined => {
  const value = isRecord(data) ? data[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};

/** The visible text of an assistant message: its text blocks joined with spaces, as DSH's turn outline joins them. */
function messageText(message: unknown): string {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  return content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join(' ');
}

/**
 * How the last reply of a session starts, from its cached `turnOutline` projection: the newest turn whose response is not empty. A
 * turn that ended without text (stopped, or only tool calls) keeps the reply before it.
 */
export function lastReply(outline: unknown): string | undefined {
  if (!Array.isArray(outline)) return undefined;
  for (let index = outline.length - 1; index >= 0; index -= 1) {
    const response = textField(outline[index], 'response');
    if (response) return clip(response);
  }
  return undefined;
}

export function trackEvent(track: SessionTrack, event: SessionEventLike): SessionTrack {
  const { data } = event;
  switch (event.type) {
    case 'turn/start':
      return {
        ...track, turnStart: event.time, running: true, runningSeen: true, blank: false,
        step: { label: THINKING, since: event.time }, calls: [], draft: undefined,
      };
    case 'step/start':
      return track.calls.length > 0 ? track : { ...track, step: { label: THINKING, since: event.time } };
    case 'turn/end': {
      const reason = isRecord(data) ? data.reason : undefined;
      const failed = textField(reason, 'kind') === 'error';
      const error = failed ? clip(textField(isRecord(reason) ? reason.error : undefined, 'message') ?? '') : '';
      return {
        ...track, turnEnd: { time: event.time, failed, ...(error ? { error } : {}) }, ...stopped, blank: false,
        ...(track.draft ? { reply: track.draft, replySeen: true } : {}), draft: undefined,
      };
    }
    case 'assistant/message': {
      const text = clip(messageText(isRecord(data) ? data.message : undefined));
      return text === '' || text === track.draft ? track : { ...track, draft: text };
    }
    case 'approval/asked': {
      const id = textField(data, 'id');
      return id === undefined ? track : { ...track, waits: [...track.waits, { kind: 'approval', id, text: textField(data, 'toolName') ?? '', since: event.time }] };
    }
    case 'approval/decided': {
      const id = textField(data, 'id');
      return id !== undefined && track.waits.some(wait => wait.kind === 'approval' && wait.id === id)
        ? { ...track, waits: track.waits.filter(wait => !(wait.kind === 'approval' && wait.id === id)) }
        : track;
    }
    case 'tool/call': {
      const id = textField(data, 'callId');
      const name = textField(data, 'name');
      if (id === undefined || name === undefined) return track;
      const args = textField(data, 'arguments') ?? '';
      return name === 'ask_user_question'
        ? { ...track, waits: [...track.waits, { kind: 'question', id, text: questionText(args), since: event.time }] }
        : { ...track, calls: [...track.calls, { id, label: toolStep(name, args), since: event.time }] };
    }
    case 'tool/result': {
      const id = textField(isRecord(data) ? data.message : undefined, 'toolCallId');
      if (id === undefined) return track;
      if (track.waits.some(wait => wait.kind === 'question' && wait.id === id)) {
        return { ...track, waits: track.waits.filter(wait => !(wait.kind === 'question' && wait.id === id)) };
      }
      if (!track.calls.some(call => call.id === id)) return track;
      const calls = track.calls.filter(call => call.id !== id);
      return { ...track, calls, ...(calls.length === 0 ? { step: { label: THINKING, since: event.time } } : {}) };
    }
    case 'session/title': {
      const title = textField(data, 'title');
      return title === undefined ? track : { ...track, title, titleSeen: true };
    }
    default:
      return track;
  }
}

/** The wait the board names: a pending question before a pending approval, the older one first. */
const shownWait = (track: SessionTrack): Wait | undefined => track.waits.find(wait => wait.kind === 'question') ?? track.waits[0];

/** Waiting wins over running, running over a failed last turn. */
export function sessionState(track: SessionTrack): { state: SessionState; wait?: WaitKind } {
  const wait = shownWait(track);
  if (wait) return { state: 'waiting', wait: wait.kind };
  if (track.running) return { state: 'running' };
  if (track.turnEnd?.failed) return { state: 'failed' };
  return { state: 'idle' };
}

/**
 * What the preview line is about, by the state the board shows: what a waiting session asks, the newest tool call in flight (else the
 * model's step) of a running one, the error of a failed one, and how an idle one's last reply starts. Undefined when nothing is known.
 */
export function previewOf(track: SessionTrack): Preview | undefined {
  const wait = shownWait(track);
  if (wait) return wait.kind === 'question' ? { kind: 'question', text: wait.text, since: wait.since } : { kind: 'approval', tool: wait.text, since: wait.since };
  if (track.running) {
    const step = track.calls.at(-1) ?? track.step;
    return step ? { kind: 'running', step: step.label, since: step.since } : { kind: 'running' };
  }
  if (track.turnEnd?.failed) return { kind: 'failed', error: track.turnEnd.error ?? '' };
  return track.reply ? { kind: 'reply', text: track.reply } : undefined;
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
  preview?: Preview;
}

export function sessionView(track: SessionTrack): SessionView {
  const preview = previewOf(track);
  return {
    id: track.id, title: track.title, blank: track.blank, subagent: track.subagent, ...sessionState(track), lastActivity: lastActivity(track),
    ...(preview ? { preview } : {}),
  };
}

const samePreview = (a: Preview | undefined, b: Preview | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
};

/**
 * How much a session's view changed: `minor` when only the step of a running session moved (a tool call started or returned), which
 * the board can pick up a little later; `major` for anything else it shows.
 */
function viewChange(before: SessionView | undefined, after: SessionView): 'none' | 'minor' | 'major' {
  if (before === undefined) return 'major';
  const same = before.title === after.title && before.blank === after.blank && before.subagent === after.subagent && before.state === after.state
    && before.wait === after.wait && before.lastActivity === after.lastActivity;
  if (!same) return 'major';
  if (samePreview(before.preview, after.preview)) return 'none';
  return before.preview?.kind === 'running' && after.preview?.kind === 'running' ? 'minor' : 'major';
}

/**
 * Every session this process knows, kept current by the Host's listeners; `changed` runs when what the board shows changes, with
 * `minor` set when only a running step moved, and the session when one session changed.
 */
export class SessionIndex {
  private readonly tracks = new Map<string, SessionTrack>();

  constructor(private readonly changed: (minor: boolean, sessionId?: string) => void = () => {}) {}

  /** The start-up listing; reports one change for the whole list. */
  load(rows: readonly SessionRow[]): void {
    for (const row of rows) this.tracks.set(row.sessionId, trackRow(this.tracks.get(row.sessionId), row, 'list'));
    this.changed(false);
  }

  /** Replies read at listing time, for the sessions the index knows; reports one change when any view changed. */
  loadReplies(replies: ReadonlyMap<string, string>): void {
    let changed = false;
    for (const [id, reply] of replies) {
      const before = this.tracks.get(id);
      if (!before) continue;
      const after = trackReply(before, reply);
      if (after === before) continue;
      this.tracks.set(id, after);
      changed ||= viewChange(sessionView(before), sessionView(after)) !== 'none';
    }
    if (changed) this.changed(false);
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
    const kind = viewChange(before && sessionView(before), sessionView(after));
    if (kind !== 'none') this.changed(kind === 'minor', id);
  }
}
