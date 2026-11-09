/**
 * The my-dsh Remote: request and response types, the request check, and the descriptors the DSH Remote carrier routes by. The client
 * bundle imports this file, so it keeps to types and the dependency-free check below.
 */
import type { InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';

/** A matter: what a group of sessions is for. Big matters have a main conversation; the rest are only a board. */
export interface Matter {
  id: string;
  name: string;
  /** One sentence. */
  goal: string;
  /** Session ids, in the order they joined. */
  sessions: string[];
  /** The session id of its main conversation, once one is opened. */
  main?: string;
  createdAt: string;
  archivedAt?: string;
}

/** What a session is doing, as far as this DSH process has seen. */
export type SessionState = 'waiting' | 'running' | 'failed' | 'idle';
/** What a waiting session waits for: an answer to `ask_user_question`, or a tool approval. */
export type WaitKind = 'question' | 'approval';

/** One session as the board shows it. */
export interface BoardSession {
  id: string;
  title: string;
  state: SessionState;
  /** Set when `state` is `waiting`. */
  wait?: WaitKind;
  /** Epoch ms of the session's latest turn start or end, or of its latest prompt when no turn was seen. */
  lastActivity: number;
  /** Title of the workspace the session belongs to. */
  workspace?: string;
  /** Archived in DSH, so hidden from the sidebar. */
  archived?: true;
}

export interface BoardMatter {
  id: string;
  name: string;
  goal: string;
  createdAt: string;
  archivedAt?: string;
  /** Newest activity first. Ids the session list does not know are left out. */
  sessions: BoardSession[];
  /** Newest session activity, or the creation time of a matter without sessions. */
  lastActivity: number;
}

/** A session in the review, with the matter it belongs to. */
export interface ReviewSession extends BoardSession {
  matter?: { id: string; name: string };
}

/** The sessions whose last activity fell on one local day. */
export interface ReviewDay {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
  /** 0 for today, 1 for yesterday. */
  daysAgo: number;
  /** Newest activity first. */
  sessions: ReviewSession[];
}

export interface BoardSnapshot {
  /** In-progress matters first, newest activity first; archived ones after them, newest archive first. */
  matters: BoardMatter[];
  /** Sessions in no matter, newest activity first; archived, blank and subagent sessions are left out. */
  unassigned: BoardSession[];
  /** The last 14 local days that had activity, today first. */
  review: ReviewDay[];
  /** Host time the snapshot was taken, epoch ms. */
  now: number;
}

export type MyDshRequest =
  | { action: 'snapshot' }
  | { action: 'createMatter'; name: string; goal: string }
  | { action: 'renameMatter'; id: string; name: string }
  | { action: 'setGoal'; id: string; goal: string }
  | { action: 'archiveMatter'; id: string }
  | { action: 'unarchiveMatter'; id: string }
  | { action: 'addSession'; matterId: string; sessionId: string }
  | { action: 'removeSession'; sessionId: string };

/** The result of each action. A change returns the matter it changed; `removeSession` returns null when the session was in none. */
export interface MyDshResults {
  snapshot: BoardSnapshot;
  createMatter: Matter;
  renameMatter: Matter;
  setGoal: Matter;
  archiveMatter: Matter;
  unarchiveMatter: Matter;
  addSession: Matter;
  removeSession: Matter | null;
}
export type MyDshResponse = MyDshResults[keyof MyDshResults];
export type MyDshResult<R extends MyDshRequest> = MyDshResults[R['action']];

/** One item of the `watch` stream: the board changed, read a new snapshot. The first item comes when the stream opens. */
export interface WatchNotice {
  revision: number;
}

export class RequestError extends Error {}

export const NAME_MAX = 40;
export const GOAL_MAX = 120;

/** The fields each action takes, all required. */
const FIELDS: { [A in MyDshRequest['action']]: readonly string[] } = {
  snapshot: [],
  createMatter: ['name', 'goal'],
  renameMatter: ['id', 'name'],
  setGoal: ['id', 'goal'],
  archiveMatter: ['id'],
  unarchiveMatter: ['id'],
  addSession: ['matterId', 'sessionId'],
  removeSession: ['sessionId'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAction(value: unknown): value is MyDshRequest['action'] {
  return typeof value === 'string' && Object.hasOwn(FIELDS, value);
}

function text(value: Record<string, unknown>, field: string): string {
  const raw = value[field];
  if (typeof raw !== 'string') throw new RequestError(`${field} 必须是文字`);
  return raw;
}

/** Matter ids come from randomUUID and session ids from DSH; neither has spaces or control characters. */
function id(value: Record<string, unknown>, field: string): string {
  const raw = text(value, field);
  if (!/^[^\s\p{Cc}]{1,200}$/u.test(raw)) throw new RequestError(`${field} 不是有效的 id`);
  return raw;
}

/** Trimmed, one line, counted in characters as people see them. */
function line(raw: string, label: string, min: number, max: number): string {
  const trimmed = raw.trim();
  if (/\p{Cc}/u.test(trimmed)) throw new RequestError(`${label}只能写一行`);
  const length = [...trimmed].length;
  if (length < min) throw new RequestError(`${label}不能为空`);
  if (length > max) throw new RequestError(`${label}最多 ${max} 个字`);
  return trimmed;
}

export const matterName = (raw: string): string => line(raw, '名字', 1, NAME_MAX);
export const matterGoal = (raw: string): string => line(raw, '目标', 0, GOAL_MAX);

/** Takes the listed actions only, each with exactly its fields; returns a fresh, trimmed copy or throws a RequestError whose message the page shows. */
export function parseRequest(value: unknown): MyDshRequest {
  if (!isRecord(value)) throw new RequestError('my-dsh 请求必须是一个 JSON 对象');
  const action = value.action;
  if (!isAction(action)) throw new RequestError(`没有这个操作：${JSON.stringify(action)}`);
  const fields = FIELDS[action];
  const extra = Object.keys(value).filter(key => key !== 'action' && !fields.includes(key));
  if (extra.length) throw new RequestError(`${action} 不接受这些字段：${extra.join('、')}`);
  const missing = fields.filter(field => !Object.hasOwn(value, field));
  if (missing.length) throw new RequestError(`${action} 缺少字段：${missing.join('、')}`);
  switch (action) {
    case 'snapshot': return { action };
    case 'createMatter': return { action, name: matterName(text(value, 'name')), goal: matterGoal(text(value, 'goal')) };
    case 'renameMatter': return { action, id: id(value, 'id'), name: matterName(text(value, 'name')) };
    case 'setGoal': return { action, id: id(value, 'id'), goal: matterGoal(text(value, 'goal')) };
    case 'archiveMatter': return { action, id: id(value, 'id') };
    case 'unarchiveMatter': return { action, id: id(value, 'id') };
    case 'addSession': return { action, matterId: id(value, 'matterId'), sessionId: id(value, 'sessionId') };
    case 'removeSession': return { action, sessionId: id(value, 'sessionId') };
  }
}

const json = (value: unknown) => value;
const requestObject = (value: unknown) => {
  if (!isRecord(value)) throw new Error('request must be a JSON object');
  return value as unknown as MyDshRequest;
};

export const MY_DSH_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-my-dsh#mydsh/call', service: 'mydsh', namespace: 'mydsh', method: 'call',
  invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'MyDshRequest', create: () => ({ parse: requestObject }) } }],
  result: { mode: 'strict', typeSymbol: 'MyDshResponse', create: () => ({ parse: json }), encode: value => json(value) },
};

/**
 * Hand-written, like the call descriptor above: no Typert compiler runs over this package. The Host side is found through `@Remote` (the
 * Gateway's SRC mode); the client needs this descriptor to install `ctx.remote.mydsh.watch`. Stream items pass through without a codec.
 */
export const MY_DSH_WATCH_DESCRIPTOR: InvocationDescriptor = {
  id: 'dsh-my-dsh#mydsh/watch', service: 'mydsh', namespace: 'mydsh', method: 'watch', mode: 'stream',
  invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' }, parameters: [],
  result: { mode: 'strict', typeSymbol: 'MyDshWatchNotice', create: () => ({ parse: json }) },
};

export const MY_DSH_REMOTE: TypertRemoteContribution = { package: 'dsh-my-dsh', descriptors: [MY_DSH_DESCRIPTOR, MY_DSH_WATCH_DESCRIPTOR] };

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    mydsh: {
      call: (request: MyDshRequest, signal?: AbortSignal) => Promise<RemoteResult<MyDshResponse>>;
      watch: (signal?: AbortSignal) => RemoteStreamHandle<WatchNotice, never>;
    };
  }
  interface TypertRemoteMap {
    'mydsh/call': (request: MyDshRequest, signal?: AbortSignal) => Promise<RemoteResult<MyDshResponse>>;
    'mydsh/watch': (signal?: AbortSignal) => RemoteStreamHandle<WatchNotice, never>;
  }
}
