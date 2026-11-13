/**
 * The my-dsh Remote: request and response types, the request check, and the descriptors the DSH Remote carrier routes by. The client
 * bundle imports this file, so it keeps to types and the dependency-free check below.
 */
import type { InvocationDescriptor, RemoteResult, RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { Preview } from './preview.js';

export type { Preview } from './preview.js';

/**
 * How a session came into a matter: `manual` the user put it there, `mydsh` my dsh started it there, `origin` filed by where it came from
 * (the same scheduled task, PR or branch, or an @-reference) and `model` filed by the model. The last two are suggestions of automatic
 * grouping (自动归类) the user accepted.
 */
export type LinkSource = 'manual' | 'mydsh' | 'origin' | 'model';
export const LINK_SOURCES: readonly LinkSource[] = ['manual', 'mydsh', 'origin', 'model'];

/** The origin rule behind an `origin` link: the same scheduled task, the same PR, the same branch, or an @-reference to a session. */
export type OriginRule = 'schedule' | 'pr' | 'branch' | 'reference';
export const ORIGIN_RULES: readonly OriginRule[] = ['schedule', 'pr', 'branch', 'reference'];

/** One session in a matter, with how and when it got there. */
export interface SessionLink {
  sessionId: string;
  by: LinkSource;
  /** ISO time the link was made. */
  at: string;
  /** One sentence, when whoever made the link gave a reason. */
  why?: string;
  /** `origin`: the rule that matched. */
  rule?: OriginRule;
}

/** What a matter's context points at: a folder or file on this machine, a PR, a document, or another link. */
export type SourceKind = 'folder' | 'file' | 'pr' | 'doc' | 'link';
export const SOURCE_KINDS: readonly SourceKind[] = ['folder', 'file', 'pr', 'doc', 'link'];

export interface MatterSource {
  kind: SourceKind;
  /** An absolute path for a folder or file, a URL otherwise. Paths are used where they are; nothing is copied. */
  value: string;
  /** What to call it: a folder's or file's name, `owner/repo#n` for a PR. */
  title?: string;
}

/** A matter: what a group of sessions is for, with its context and the permissions the sessions my dsh opens in it run under. */
export interface Matter {
  id: string;
  name: string;
  /** One sentence. */
  goal: string;
  /** In the order the sessions joined. */
  sessions: SessionLink[];
  /** Other words the user has used for this matter, newest first, at most {@link ALIASES_MAX}. */
  aliases: string[];
  /** Its main workspace: where my dsh starts its sessions. */
  workspaceId?: string;
  /** Folders, files, PRs, documents and links that go with it. */
  sources: MatterSource[];
  /** The user's standing requests for this matter, at most 2,000 characters. */
  instructions?: string;
  /** Set while the user hosts the matter (托管): the DSH permission preset the sessions my dsh opens in it run under, and when it was set. */
  hosting?: { preset: string; at: string };
  /** The session of the matter's own conversation, once it is opened. It is not one of the matter's `sessions`. */
  conversation?: string;
  createdAt: string;
  archivedAt?: string;
}

/** my dsh's agent preset. */
export const PRESET_ID = 'my-dsh';

export const ALIASES_MAX = 10;
/** An alias is a phrase from a sentence, so it gets the same bound as a name. */
export const ALIAS_MAX = 40;

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
  workspaceId?: string;
  /** Archived in DSH, so hidden from the sidebar. */
  archived?: true;
  /** What the line under its title is about; absent when nothing is known, and on the unassigned list, which the page does not show. */
  preview?: Preview;
  /** In a matter's list: how the session got into the matter; `mydsh` when my dsh opened it. */
  by?: LinkSource;
}

export const NOTE_KINDS = ['rule', 'decision', 'answer', 'trap', 'todo'] as const;
export type NoteKind = typeof NOTE_KINDS[number];

/** One line of a matter's notes (事项笔记) in notes.json, from before 事项记忆; read once to move them into memory files. */
export interface NoteView {
  id: string;
  kind: NoteKind;
  text: string;
  /** Session ids the line came from. */
  sources: string[];
  /** `dream` for a tidy pass, `user` for a line the user wrote or edited; a pass keeps the user's lines. */
  by: 'dream' | 'user';
  updatedAt: string;
}

/** One entry of a matter's memory index, as the page lists it. */
export interface MemoryRowView {
  /** Relative to the memory folder: `规则/差距报告格式.md`. */
  path: string;
  /** The category folder: 规则, 定下的, 答过的, 坑 or 没做完. */
  category: string;
  /** The file's description, as the index line shows it. */
  description: string;
  /** Not checked yet; never set on the user's entries. */
  unverified?: true;
}

/** 事项记忆 on a matter's page: the index's entries in index order, the files left out of it, and the last merge. */
export interface MemoryView {
  /** The memory folder, absolute. */
  dir: string;
  rows: MemoryRowView[];
  /** Files left out of the index, with why. */
  flagged: { path: string; reason: string }[];
  /** When the last merge (整理) finished. */
  mergedAt?: string;
  /** A merge is running. */
  merging?: true;
}

/** One memory file opened on the page. Sources name the sessions they came from as the page shows them. */
export interface MemoryFileView {
  path: string;
  category: string;
  name: string;
  description: string;
  by: string;
  /** The user said it; only the matter's conversation changes it. */
  userOwned: boolean;
  sources: { id: string; title: string }[];
  verified: string;
  /** `updated` as written. */
  updated?: string;
  body: string;
  /** Soft: over 4 KB, a description over 150 characters. */
  warnings: string[];
}

/** One row of a matter's 产物: a file a session of the matter wrote, or a new folder of several, newest first. */
export interface ArtifactRowView {
  path: string;
  label: string;
  folder: boolean;
  files: number;
  sessionId: string;
  /** The session's title as the page shows it; 对话 for the matter's conversation. */
  title: string;
  at: number;
}

export interface BoardMatter {
  id: string;
  name: string;
  goal: string;
  /** Its main workspace, while it exists. */
  workspace?: { id: string; title: string };
  sources: MatterSource[];
  instructions?: string;
  /** Set while the matter is hosted (托管): the permission preset the sessions my dsh opens in it run under. */
  hosting?: { preset: string };
  createdAt: string;
  archivedAt?: string;
  /** Newest activity first. Ids the session list does not know are left out. */
  sessions: BoardSession[];
  /** Newest session activity, or the creation time of a matter without sessions. */
  lastActivity: number;
  /** 事项记忆, once its folder was read. */
  memory?: MemoryView;
  /** 产物: what the matter's sessions wrote, newest first; absent while there is none. */
  artifacts?: ArtifactRowView[];
  /** The matter's own conversation, while its session is listed: what it is doing and its newest reply, as my dsh's own shows. */
  conversation?: ConversationView;
  /** DSH's scheduled tasks that deliver to the matter's conversation or involve it, in DSH's order; ended ones are left out. */
  schedules?: MatterSchedule[];
}

/** A conversation as the page shows it over the board. `reply` is the newest reply in full, once its turn ended. */
export interface ConversationView {
  sessionId: string;
  state: SessionState;
  wait?: WaitKind;
  /** How the newest reply starts. */
  line?: string;
  /** Epoch ms of the session's last activity, which `line` is from, once its turn ended. */
  lineAt?: number;
  reply?: string;
  /** Epoch ms the turn of `reply` ended. */
  replyAt?: number;
  running?: boolean;
}

/** One of DSH's scheduled tasks on a matter. `next` is the next occurrence, epoch ms, while the task is active. */
export interface MatterSchedule {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'ended';
  next?: number;
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
  /** Sessions in no matter, newest activity first; archived, blank and subagent sessions, and the conversations, are left out. */
  unassigned: BoardSession[];
  /** The last 14 local days that had activity, today first; the conversations are left out. */
  review: ReviewDay[];
  /**
   * Sessions that wait for the user or whose last turn failed, the longest wait first, for 待处理. A matter's conversation is among
   * them with its matter and the title 对话.
   */
  attention: ReviewSession[];
  /** my dsh's session, and the cards under its turns and under those of each matter's conversation. */
  assistant: AssistantView;
  /** DSH's workspaces, for picking a matter's main workspace. */
  workspaces: { id: string; title: string; path: string }[];
  /** The permission presets a matter can be hosted under, in DSH's order; empty when DSH has no permission preset service. */
  presets: { value: string; name: string }[];
  /** The workspace of the most recently active session that has one. */
  recentWorkspaceId?: string;
  /** Numbers about the user's DSH as a whole, for my dsh's head. */
  usage?: UsageStats;
  /** How many entries 做事记录 has; my dsh's head links to it once there is one. */
  activity?: number;
  /** Pending suggestions of automatic grouping whose sessions are all still loose, new matters first; absent while there are none. */
  suggestions?: SuggestionView[];
  /** Host time the snapshot was taken, epoch ms. */
  now: number;
}

/**
 * A suggestion of automatic grouping (自动归类) as the card under my dsh's input shows it: `new` puts several loose sessions in a new
 * matter, `file` puts one loose session in a matter in progress. Names and titles are as they are now; the sessions are newest first.
 */
export interface SuggestionView {
  id: string;
  kind: 'new' | 'file';
  /** `new`: the matter's name and goal. */
  name?: string;
  goal?: string;
  /** `new`: the main workspace the matter gets, the one most of its sessions are in; absent when none of them is in one. */
  workspace?: { id: string; title: string };
  /** `file`: the matter the session goes into. */
  matter?: { id: string; name: string };
  /** Each with its last activity, epoch ms. */
  sessions: { id: string; title: string; lastActivity: number }[];
  /** One sentence. */
  why: string;
}

/** Numbers about the user's DSH as a whole; one the Host could not read is left out. */
export interface UsageStats {
  /** When the user's first top-level session was made, epoch ms. */
  firstSessionAt?: number;
  /** Top-level sessions that have a turn. */
  sessions?: number;
  /** Tokens across the sessions that carry a total, subagents and forks left out. */
  tokens?: number;
  /** How many sessions `tokens` covers; fewer than `sessions` makes it a lower bound. */
  tokenSessions?: number;
  /** Plugins the plugin page lists under 已安装插件. */
  plugins?: number;
}

/**
 * One thing in 做事记录. `start`: my dsh started a session in a matter. `send`: my dsh sent a message to a session. `note`: my dsh wrote
 * what the user said into a matter's memory. `forward`: my dsh passed the user's words to a matter's conversation. `file`: the user put a
 * session in a matter by hand, or moved it there. `unfile`: the user took one out by hand. `manage`: a new, merged or renamed matter the
 * user confirmed on a card. `undo`: the user took back an earlier entry. `memory`: a file of a matter's memory changed. `group`: the user
 * accepted a suggestion of automatic grouping, a new matter with its sessions or one session put in a matter.
 */
export type ActivityKind = 'start' | 'send' | 'note' | 'forward' | 'file' | 'unfile' | 'manage' | 'undo' | 'memory' | 'group';

/** Who changed a memory file: a session of the matter, the user in an editor, 补记, 合并, or my dsh writing down what the user said. */
export type MemoryAuthor = 'session' | 'user' | 'capture' | 'merge' | 'note';

export interface ActivityEntry {
  id: string;
  /** ISO time. For `start` and `file` it is also the time of the link the entry made, which is how undo finds that link. */
  at: string;
  kind: ActivityKind;
  matterId?: string;
  sessionId?: string;
  /** The matter's name and the session's title as they were then. */
  matterName?: string;
  title?: string;
  /** What happened, in one line, with the names as they were then. */
  text: string;
  why: string;
  /** `start` and `send`: what my dsh sent to the session; `forward`: the user's words as they went to the conversation (`sessionId`). */
  task?: string;
  /** `note`: the line it wrote; from 事项记忆 on, the file it wrote and the file's hash, which undo needs unchanged. */
  note?: { id: string; text: string; path?: string; hash?: string };
  /** `memory` and `note`: the file that changed, how, and by whom; 做事记录 shows its diff on request. */
  memory?: { path: string; change: 'add' | 'update' | 'delete'; by: MemoryAuthor };
  /** `start`, `send`, `note` and `forward`: where the receipt sits in my dsh's conversation. */
  card?: CardPlace;
  /** `group`: the sessions it put in the matter, how their links were made (`origin` or `model`), and whether it made the matter. */
  sessions?: string[];
  by?: LinkSource;
  created?: true;
  /** Set once the entry was taken back. */
  undoneAt?: string;
  /** `undo`: the entry it took back. */
  undoes?: string;
}

/** An entry as 做事记录 shows it. */
export interface ActivityView extends ActivityEntry {
  /** Taking it back would still change something. */
  undoable: boolean;
}

/** A change to the matters that waits for the user's click. Names are kept as they were when it was proposed. */
export type ProposalChange =
  | { kind: 'new'; name: string; goal: string; workspaceId?: string }
  | { kind: 'merge'; fromId: string; fromName: string; intoId: string; intoName: string }
  | { kind: 'rename'; matterId: string; oldName: string; name: string };

/** Where a card sits: under one turn of my dsh's session. */
export interface CardPlace {
  /** my dsh's session. */
  sessionId: string;
  /** The turn whose tool call made the card. */
  turn: number;
}

export interface Proposal extends CardPlace {
  id: string;
  change: ProposalChange;
  why: string;
  /** The words the user used for the matter, kept as an alias once accepted. */
  phrase?: string;
  at: string;
  state: 'pending' | 'accepted' | 'declined';
  decidedAt?: string;
  /** `new`, once accepted: the matter it made. */
  matterId?: string;
}

export interface WhichCandidate {
  kind: 'matter' | 'session';
  id: string;
  /** Its name when my dsh asked. */
  label: string;
}

/** my dsh could not tell which matter or session a phrase meant and asked the user to pick. */
export interface WhichQuestion extends CardPlace {
  id: string;
  phrase: string;
  candidates: WhichCandidate[];
  why: string;
  at: string;
  state: 'pending' | 'answered';
  /** The pick, or null for 都不是. */
  answer?: WhichCandidate | null;
  answeredAt?: string;
}

/** A card as the conversation draws it. */
export type CardView =
  | (CardPlace & { type: 'proposal'; id: string; kind: ProposalChange['kind']; line: string; state: Proposal['state'] })
  | (CardPlace & { type: 'which'; id: string; phrase: string; candidates: WhichCandidate[]; state: WhichQuestion['state']; answer?: WhichCandidate | null })
  /**
   * The receipt my dsh leaves under the turn that started a session, sent it a message or wrote a note; `id` is the activity entry and
   * `target` the session 打开 opens, which a note has none of.
   */
  | (CardPlace & { type: 'receipt'; id: string; kind: 'start' | 'send' | 'note'; line: string; target?: string; undoable: boolean; undone: boolean })
  | ForwardCardView;

/**
 * The receipt my dsh leaves under the turn that passed the user's words to a matter's conversation: `id` is the activity entry,
 * `conversationId` the conversation the words went to, `at` when (epoch ms), `matterName` the name then. `latest` marks the newest pass to
 * that matter, the one card that shows what the conversation did with it.
 */
export type ForwardCardView = CardPlace & { type: 'forward'; id: string; matterId: string; matterName: string; conversationId: string; at: number; latest: boolean };

export interface AssistantView {
  /** my dsh's session, once it exists. */
  sessionId: string | null;
  /** The cards of my dsh's session and of the matters' conversations; each names the session and turn it sits under. */
  cards: CardView[];
  /** How my dsh's last reply starts, for the one line a folded conversation shows. */
  line?: string;
  /** my dsh's newest reply in full and when its turn ended, for the reply shown over the board. */
  reply?: string;
  replyAt?: number;
  /** my dsh is in a turn. */
  running?: boolean;
}

export type MyDshRequest =
  | { action: 'snapshot' }
  | ({ action: 'createMatter'; name: string; goal: string } & Partial<ContextInput>)
  | { action: 'renameMatter'; id: string; name: string }
  | { action: 'setGoal'; id: string; goal: string }
  | { action: 'archiveMatter'; id: string }
  | { action: 'unarchiveMatter'; id: string }
  | { action: 'addSession'; matterId: string; sessionId: string }
  | { action: 'removeSession'; sessionId: string }
  /** my dsh's session, or with `matterId` the matter's own conversation; either is made when there is none. */
  | { action: 'assistant'; matterId?: string }
  | { action: 'activity' }
  | { action: 'undo'; id: string }
  | { action: 'acceptProposal'; id: string }
  | { action: 'declineProposal'; id: string }
  | { action: 'answerWhich'; id: string; candidateId: string | null }
  | ({ action: 'setContext'; id: string } & ContextInput)
  | { action: 'checkPath'; path: string }
  /** Merge (整理) a matter's memory now. */
  | { action: 'mergeMemory'; id: string }
  /** One file of a matter's memory index, opened on the page. */
  | { action: 'memoryFile'; matterId: string; path: string }
  /** The diff a 做事记录 entry about a memory file keeps. */
  | { action: 'activityDiff'; id: string }
  /** `preset: null` stops hosting the matter. */
  | { action: 'setHosting'; id: string; preset: string | null }
  /** A suggestion of automatic grouping: make the matter it names or file the session, or decline it for good. */
  | { action: 'acceptSuggestion'; id: string }
  | { action: 'declineSuggestion'; id: string };

/** A file dropped or picked in the browser and uploaded through DSH; the Host copies it into the matter's folder. */
export interface UploadSource {
  kind: 'upload';
  attachmentId: string;
  name: string;
  bytes: number;
}

/** A matter's context as the dialogs send it. `workspaceId: null` clears the main workspace; no instructions clears them. */
export interface ContextInput {
  workspaceId: string | null;
  sources: (MatterSource | UploadSource)[];
  instructions?: string;
}

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
  /** my dsh's session or the matter's conversation, made when there is none. */
  assistant: { sessionId: string };
  /** Newest first. */
  activity: ActivityView[];
  /** The entry that records the undo. */
  undo: ActivityView;
  acceptProposal: Proposal;
  declineProposal: Proposal;
  answerWhich: WhichQuestion;
  setContext: Matter;
  /** The path as a source, once the Host found it. */
  checkPath: MatterSource;
  /** When the merge finished. */
  mergeMemory: { mergedAt: string };
  memoryFile: MemoryFileView;
  /** '' when the entry keeps none. */
  activityDiff: { diff: string };
  setHosting: Matter;
  /** The matter it made, or the one the session went into. */
  acceptSuggestion: Matter;
  declineSuggestion: { id: string };
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

/** The fields each action takes, all required; `answerWhich` takes null as its candidateId for 都不是, `setHosting` null as its preset. */
const FIELDS: { [A in MyDshRequest['action']]: readonly string[] } = {
  snapshot: [],
  createMatter: ['name', 'goal'],
  renameMatter: ['id', 'name'],
  setGoal: ['id', 'goal'],
  archiveMatter: ['id'],
  unarchiveMatter: ['id'],
  addSession: ['matterId', 'sessionId'],
  removeSession: ['sessionId'],
  assistant: [],
  activity: [],
  undo: ['id'],
  acceptProposal: ['id'],
  declineProposal: ['id'],
  answerWhich: ['id', 'candidateId'],
  setContext: ['id', 'workspaceId', 'sources', 'instructions'],
  checkPath: ['path'],
  mergeMemory: ['id'],
  memoryFile: ['matterId', 'path'],
  activityDiff: ['id'],
  setHosting: ['id', 'preset'],
  acceptSuggestion: ['id'],
  declineSuggestion: ['id'],
};

/** Fields an action may leave out. */
const OPTIONAL: { [A in MyDshRequest['action']]?: readonly string[] } = {
  createMatter: ['workspaceId', 'sources', 'instructions'],
  assistant: ['matterId'],
};

export const SOURCES_MAX = 30;
export const INSTRUCTIONS_MAX = 2_000;
/** The longest task, message or prompt the plugin sends a session, in characters. */
export const TASK_MAX = 20_000;

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
export function line(raw: string, label: string, min: number, max: number): string {
  const trimmed = raw.trim();
  if (/\p{Cc}/u.test(trimmed)) throw new RequestError(`${label}只能写一行`);
  const length = [...trimmed].length;
  if (length < min) throw new RequestError(`${label}不能为空`);
  if (length > max) throw new RequestError(`${label}最多 ${max} 个字`);
  return trimmed;
}

export const matterName = (raw: string): string => line(raw, '名字', 1, NAME_MAX);
export const matterGoal = (raw: string): string => line(raw, '目标', 0, GOAL_MAX);

/** A full path on the Host: `/…`, `~/…`, or a Windows drive or share path. */
export function absolutePath(raw: string): string {
  const path = raw.trim();
  if (!/^(\/|~\/|~$|[A-Za-z]:[\\/]|\\\\)/.test(path) || /[\r\n\0]/.test(path)) throw new RequestError('要写完整路径，以 / 或 ~/ 开头');
  return path;
}

function source(raw: unknown): MatterSource | UploadSource {
  if (!isRecord(raw)) throw new RequestError('来源必须是对象');
  if (raw.kind === 'upload') {
    if (typeof raw.attachmentId !== 'string' || !/^[^\s\p{Cc}]{1,200}$/u.test(raw.attachmentId) || typeof raw.name !== 'string' || raw.name.trim() === ''
      || typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) throw new RequestError('上传的文件不完整');
    return { kind: 'upload', attachmentId: raw.attachmentId, name: raw.name, bytes: raw.bytes };
  }
  if (!SOURCE_KINDS.includes(raw.kind as SourceKind)) throw new RequestError('来源的种类不对');
  if (typeof raw.value !== 'string' || raw.value.trim() === '') throw new RequestError('来源不能为空');
  if (raw.title !== undefined && typeof raw.title !== 'string') throw new RequestError('来源的名字必须是文字');
  return { kind: raw.kind as SourceKind, value: raw.value.trim(), ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}) };
}

/** The context fields of createMatter and setContext. */
function contextInput(value: Record<string, unknown>): ContextInput {
  const workspaceId = value.workspaceId === undefined || value.workspaceId === null ? null : id(value, 'workspaceId');
  const sources = value.sources ?? [];
  if (!Array.isArray(sources)) throw new RequestError('sources 必须是列表');
  if (sources.length > SOURCES_MAX) throw new RequestError(`来源最多 ${SOURCES_MAX} 个`);
  const raw = value.instructions === undefined ? '' : text(value, 'instructions');
  const instructions = raw.trim();
  if ([...instructions].length > INSTRUCTIONS_MAX) throw new RequestError(`指令最多 ${INSTRUCTIONS_MAX} 个字`);
  return { workspaceId, sources: sources.map(source), ...(instructions ? { instructions } : {}) };
}

/** Takes the listed actions only, each with exactly its fields; returns a fresh, trimmed copy or throws a RequestError whose message the page shows. */
export function parseRequest(value: unknown): MyDshRequest {
  if (!isRecord(value)) throw new RequestError('my-dsh 请求必须是一个 JSON 对象');
  const action = value.action;
  if (!isAction(action)) throw new RequestError(`没有这个操作：${JSON.stringify(action)}`);
  const fields = FIELDS[action];
  const optional = OPTIONAL[action] ?? [];
  const extra = Object.keys(value).filter(key => key !== 'action' && !fields.includes(key) && !optional.includes(key));
  if (extra.length) throw new RequestError(`${action} 不接受这些字段：${extra.join('、')}`);
  const missing = fields.filter(field => !Object.hasOwn(value, field));
  if (missing.length) throw new RequestError(`${action} 缺少字段：${missing.join('、')}`);
  switch (action) {
    case 'snapshot': return { action };
    case 'createMatter': return {
      action, name: matterName(text(value, 'name')), goal: matterGoal(text(value, 'goal')),
      ...(Object.hasOwn(value, 'workspaceId') || Object.hasOwn(value, 'sources') || Object.hasOwn(value, 'instructions') ? contextInput(value) : {}),
    };
    case 'renameMatter': return { action, id: id(value, 'id'), name: matterName(text(value, 'name')) };
    case 'setGoal': return { action, id: id(value, 'id'), goal: matterGoal(text(value, 'goal')) };
    case 'archiveMatter': return { action, id: id(value, 'id') };
    case 'unarchiveMatter': return { action, id: id(value, 'id') };
    case 'addSession': return { action, matterId: id(value, 'matterId'), sessionId: id(value, 'sessionId') };
    case 'removeSession': return { action, sessionId: id(value, 'sessionId') };
    case 'assistant': return value.matterId === undefined ? { action } : { action, matterId: id(value, 'matterId') };
    case 'activity': return { action };
    case 'undo': return { action, id: id(value, 'id') };
    case 'acceptProposal': return { action, id: id(value, 'id') };
    case 'declineProposal': return { action, id: id(value, 'id') };
    case 'answerWhich': return { action, id: id(value, 'id'), candidateId: value.candidateId === null ? null : id(value, 'candidateId') };
    case 'setContext': return { action, id: id(value, 'id'), ...contextInput(value) };
    case 'checkPath': return { action, path: absolutePath(text(value, 'path')) };
    case 'mergeMemory': return { action, id: id(value, 'id') };
    case 'memoryFile': {
      const path = text(value, 'path').trim();
      if (!path || path.length > 300 || /\p{Cc}/u.test(path) || path.startsWith('/') || path.split('/').includes('..')) throw new RequestError('不是记忆里的文件');
      return { action, matterId: id(value, 'matterId'), path };
    }
    case 'activityDiff': return { action, id: id(value, 'id') };
    case 'setHosting': return { action, id: id(value, 'id'), preset: value.preset === null ? null : id(value, 'preset') };
    case 'acceptSuggestion': return { action, id: id(value, 'id') };
    case 'declineSuggestion': return { action, id: id(value, 'id') };
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
