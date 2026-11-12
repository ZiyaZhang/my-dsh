/**
 * The board snapshot: matters with their sessions, their own conversations and DSH's scheduled tasks on them, the sessions in no matter,
 * the review by local day, the sessions that need the user, and the pending suggestions of automatic grouping whose sessions are all
 * still loose. Sessions the page shows carry the parts of their preview line. A
 * matter's conversation is a conversation, not a piece of work: like my dsh's own session it stays out of the unassigned list and the
 * review, but it shows in 等你处理 when it waits or failed. Pure, so the day boundaries and the orderings can be tested with a fixed clock
 * and time zone.
 */
import { suggestionViews, type Suggestion } from './grouping.js';
import type {
  AssistantView, BoardMatter, BoardSession, BoardSnapshot, ConversationView, Matter, MatterSchedule, ReviewDay, ReviewSession,
} from './remote.js';
import type { SessionView } from './sessions.js';

export const REVIEW_DAYS = 14;

/** One of DSH's scheduled tasks, cut down to what a matter's page and automatic grouping read (an entry of `dsh-schedule`'s catalog). */
export interface ScheduleEntry {
  id: string;
  title: string;
  /** What it sends each time. */
  prompt?: string;
  /** RFC 3339 UTC: the next occurrence while the task is active, the final one once it is not. */
  scheduledAt?: string;
  status: 'active' | 'paused' | 'ended';
  /** Where it delivers; `new` targets name no session. */
  target: { kind: string; sessionId?: string };
  /** Sessions DSH tells about the task: the ones that made or edited it and its target. */
  involvedSessionIds: readonly string[];
  /** Its newest delivery, with the session that took it: for a `new` target, the session that delivery made. */
  lastDelivery?: { targetSessionId?: string };
}

/** The tasks that deliver to a conversation or involve it, in DSH's order, ended ones left out; `next` while a task is active. */
export function matterSchedules(entries: readonly ScheduleEntry[], conversationId: string): MatterSchedule[] {
  return entries.flatMap((entry): MatterSchedule[] => {
    if (entry.status === 'ended') return [];
    if (entry.target.sessionId !== conversationId && !entry.involvedSessionIds.includes(conversationId)) return [];
    const next = entry.status === 'active' && entry.scheduledAt ? Date.parse(entry.scheduledAt) : Number.NaN;
    return [{ id: entry.id, title: entry.title, status: entry.status, ...(Number.isFinite(next) ? { next } : {}) }];
  });
}

/**
 * What the page shows of a conversation over the board, my dsh's own or a matter's: how its newest reply starts, that reply in full once
 * its turn ended, and whether it runs.
 */
export function conversationParts(view: SessionView | undefined, fullReply: string | undefined): Pick<ConversationView, 'line' | 'lineAt' | 'reply' | 'replyAt' | 'running'> {
  const line = view?.preview?.kind === 'reply' ? view.preview.text : undefined;
  const reply = view && view.state !== 'running' ? fullReply : undefined;
  return {
    ...(line ? { line } : {}), ...(line && view && view.state !== 'running' ? { lineAt: view.lastActivity } : {}),
    ...(reply && view ? { reply, replyAt: view.lastActivity } : {}), ...(view?.state === 'running' ? { running: true } : {}),
  };
}

/** Values DSH's permission preset service reserves: `auto` lives for one session at most, `custom` names no preset. */
const RESERVED_PRESETS = new Set(['auto', 'custom']);

/** The presets a matter can be hosted under: the selectable options of DSH's permission catalog without the reserved values. */
export function hostingPresets(options: readonly { value: string; name: string; description?: string }[]): { value: string; name: string }[] {
  return options.filter(option => !RESERVED_PRESETS.has(option.value)).map(option => ({ value: option.value, name: option.name }));
}

/** What the workspace registry says about sessions. */
export interface WorkspaceFacts {
  /** The workspace each attached session belongs to. */
  workspaceOf: ReadonlyMap<string, { id: string; title: string }>;
  /** Sessions archived in DSH. */
  archived: ReadonlySet<string>;
  /** Every workspace, in the registry's order. */
  list: readonly { id: string; title: string; path: string }[];
}

export interface SnapshotInput {
  matters: readonly Matter[];
  sessions: readonly SessionView[];
  workspaces: WorkspaceFacts;
  /** my dsh's session and its cards. Its session is not work the board shows. */
  assistant: AssistantView;
  /** The permission presets a matter can be hosted under; none without DSH's permission preset service. */
  presets: readonly { value: string; name: string }[];
  /** The whole newest reply of each matter's conversation, by session id, as this process saw it. */
  replies: ReadonlyMap<string, string>;
  /** DSH's scheduled tasks; none without DSH's schedule service. */
  schedules: readonly ScheduleEntry[];
  /** The pending suggestions of automatic grouping, and `sessionId>matterId` of each session the user took out of a matter by hand. */
  suggestions?: readonly Suggestion[];
  takenOut?: ReadonlySet<string>;
  /** Epoch ms. */
  now: number;
  /** IANA zone whose calendar days the review uses. */
  timeZone: string;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The local calendar day of a moment, `YYYY-MM-DD`. */
export function dayKey(ms: number, timeZone: string): string {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Whole calendar days from one `YYYY-MM-DD` to a later one. */
function daysBetween(from: string, to: string): number {
  const utc = (key: string) => { const [year, month, day] = key.split('-').map(Number); return Date.UTC(year!, month! - 1, day!); };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** DSH's own names for a session without a title: a blank one is a new session, any other is untitled. */
export function displayTitle(view: SessionView): string {
  return view.title ?? (view.blank ? '新会话' : '未命名');
}

const newestFirst = (a: { lastActivity: number; id: string }, b: { lastActivity: number; id: string }) =>
  b.lastActivity - a.lastActivity || a.id.localeCompare(b.id);

/** When a session began to need the user: when it asked, else (a failed turn) its last activity. */
export function waitingSince(session: BoardSession): number {
  const { preview } = session;
  return preview && (preview.kind === 'question' || preview.kind === 'approval') ? preview.since : session.lastActivity;
}

export function buildSnapshot(input: SnapshotInput): BoardSnapshot {
  const { workspaces, assistant } = input;
  const conversationOf = new Map(input.matters.flatMap(matter => (matter.conversation ? [[matter.conversation, matter] as const] : [])));
  /** Conversations rather than work: my dsh's own session and each matter's. */
  const hidden = new Set([...(assistant.sessionId ? [assistant.sessionId] : []), ...conversationOf.keys()]);
  const views = new Map(input.sessions.filter(view => view.id !== assistant.sessionId).map(view => [view.id, view]));
  const matterOf = new Map<string, Matter>();
  for (const matter of input.matters) for (const link of matter.sessions) matterOf.set(link.sessionId, matter);

  const board = (view: SessionView, shown = true): BoardSession => {
    const workspace = workspaces.workspaceOf.get(view.id);
    return {
      id: view.id, title: displayTitle(view), state: view.state, ...(view.wait ? { wait: view.wait } : {}),
      lastActivity: view.lastActivity, ...(workspace !== undefined ? { workspace: workspace.title, workspaceId: workspace.id } : {}),
      ...(workspaces.archived.has(view.id) ? { archived: true as const } : {}),
      ...(shown && view.preview ? { preview: view.preview } : {}),
    };
  };
  const reviewed = (view: SessionView): ReviewSession => {
    const matter = matterOf.get(view.id);
    return { ...board(view), ...(matter ? { matter: { id: matter.id, name: matter.name } } : {}) };
  };
  const named = new Map(workspaces.list.map(workspace => [workspace.id, workspace.title]));
  /** What the DSH sidebar shows: no subagents, no blank sessions, nothing archived; and never a conversation. */
  const listed = (view: SessionView) => !view.subagent && !view.blank && !workspaces.archived.has(view.id) && !hidden.has(view.id);
  /** A matter's conversation, while DSH lists it and has not archived it. */
  const conversation = (matter: Matter): ConversationView | undefined => {
    const view = matter.conversation ? views.get(matter.conversation) : undefined;
    if (!view || workspaces.archived.has(view.id)) return undefined;
    return { sessionId: view.id, state: view.state, ...(view.wait ? { wait: view.wait } : {}), ...conversationParts(view, input.replies.get(view.id)) };
  };

  const matters: BoardMatter[] = input.matters.map((matter) => {
    const sessions = matter.sessions
      .flatMap(link => { const view = views.get(link.sessionId); return view ? [{ ...board(view), by: link.by }] : []; })
      .sort(newestFirst);
    const workspace = matter.workspaceId ? named.get(matter.workspaceId) : undefined;
    const own = conversation(matter);
    const schedules = matter.conversation ? matterSchedules(input.schedules, matter.conversation) : [];
    return {
      id: matter.id, name: matter.name, goal: matter.goal,
      ...(workspace !== undefined ? { workspace: { id: matter.workspaceId!, title: workspace } } : {}),
      sources: matter.sources.map(item => ({ ...item })), ...(matter.instructions ? { instructions: matter.instructions } : {}),
      ...(matter.hosting ? { hosting: { preset: matter.hosting.preset } } : {}),
      createdAt: matter.createdAt, ...(matter.archivedAt ? { archivedAt: matter.archivedAt } : {}),
      sessions, lastActivity: sessions[0]?.lastActivity ?? Date.parse(matter.createdAt),
      ...(own ? { conversation: own } : {}), ...(schedules.length ? { schedules } : {}),
    };
  });
  const active = matters.filter(matter => !matter.archivedAt).sort(newestFirst);
  const archived = matters.filter(matter => matter.archivedAt)
    .sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!) || a.id.localeCompare(b.id));

  const unassigned = input.sessions.filter(view => listed(view) && !matterOf.has(view.id)).map(view => board(view)).sort(newestFirst);
  const suggestions = suggestionViews(input.suggestions ?? [], {
    loose: new Map(unassigned.map(session => [session.id, session])), matters: input.matters, takenOut: input.takenOut ?? new Set(),
  });

  const today = dayKey(input.now, input.timeZone);
  const days = new Map<string, ReviewDay>();
  for (const view of input.sessions) {
    if (!listed(view)) continue;
    const day = dayKey(view.lastActivity, input.timeZone);
    // A clock running ahead of the Host's still counts as today.
    const daysAgo = Math.max(0, daysBetween(day, today));
    if (daysAgo >= REVIEW_DAYS) continue;
    const key = daysAgo === 0 ? today : day;
    const entry = days.get(key) ?? { day: key, daysAgo, sessions: [] };
    entry.sessions.push(reviewed(view));
    days.set(key, entry);
  }
  const review = [...days.values()].sort((a, b) => a.daysAgo - b.daysAgo);
  for (const day of review) day.sessions.sort(newestFirst);

  // A matter's conversation that needs the user reads 事项名 › 对话 there.
  const needsUser = (view: SessionView) => view.state === 'waiting' || view.state === 'failed';
  const asConversation = (view: SessionView, matter: Matter): ReviewSession => ({ ...board(view), title: '对话', matter: { id: matter.id, name: matter.name } });
  const attention = input.sessions.flatMap((view): ReviewSession[] => {
    if (!needsUser(view)) return [];
    const matter = conversationOf.get(view.id);
    if (matter) return !view.subagent && !workspaces.archived.has(view.id) ? [asConversation(view, matter)] : [];
    return listed(view) ? [reviewed(view)] : [];
  }).sort((a, b) => waitingSince(a) - waitingSince(b) || a.id.localeCompare(b.id));

  const recent = input.sessions.filter(view => listed(view) && workspaces.workspaceOf.has(view.id))
    .sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id))[0];
  return {
    matters: [...active, ...archived], unassigned, review, attention, assistant,
    workspaces: workspaces.list.map(workspace => ({ ...workspace })),
    presets: input.presets.map(preset => ({ ...preset })),
    ...(recent ? { recentWorkspaceId: workspaces.workspaceOf.get(recent.id)!.id } : {}),
    ...(suggestions.length ? { suggestions } : {}),
    now: input.now,
  };
}
