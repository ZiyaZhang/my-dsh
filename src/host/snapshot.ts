/**
 * The board snapshot: matters with their sessions, the sessions in no matter, and the review by local day. Pure, so the day boundaries and
 * the orderings can be tested with a fixed clock and time zone.
 */
import type { AssistantView, BoardMatter, BoardSession, BoardSnapshot, Matter, ReviewDay, ReviewSession } from './remote.js';
import type { SessionView } from './sessions.js';

export const REVIEW_DAYS = 14;

/** What the workspace registry says about sessions. */
export interface WorkspaceFacts {
  /** Title of the workspace each attached session belongs to. */
  workspaceOf: ReadonlyMap<string, string>;
  /** Sessions archived in DSH. */
  archived: ReadonlySet<string>;
}

export interface SnapshotInput {
  matters: readonly Matter[];
  sessions: readonly SessionView[];
  workspaces: WorkspaceFacts;
  /** my dsh's session and its cards. Its session is not work the board shows. */
  assistant: AssistantView;
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

export function buildSnapshot(input: SnapshotInput): BoardSnapshot {
  const { workspaces, assistant } = input;
  const own = (view: SessionView) => view.id === assistant.sessionId;
  const views = new Map(input.sessions.filter(view => !own(view)).map(view => [view.id, view]));
  const matterOf = new Map<string, Matter>();
  for (const matter of input.matters) for (const link of matter.sessions) matterOf.set(link.sessionId, matter);

  const board = (view: SessionView): BoardSession => {
    const workspace = workspaces.workspaceOf.get(view.id);
    return {
      id: view.id, title: displayTitle(view), state: view.state, ...(view.wait ? { wait: view.wait } : {}),
      lastActivity: view.lastActivity, ...(workspace !== undefined ? { workspace } : {}),
      ...(workspaces.archived.has(view.id) ? { archived: true as const } : {}),
    };
  };
  /** What the DSH sidebar shows: no subagents, no blank sessions, nothing archived; and never my dsh's own session. */
  const listed = (view: SessionView) => !view.subagent && !view.blank && !workspaces.archived.has(view.id) && !own(view);

  const matters: BoardMatter[] = input.matters.map((matter) => {
    const sessions = matter.sessions.flatMap(link => { const view = views.get(link.sessionId); return view ? [board(view)] : []; }).sort(newestFirst);
    return {
      id: matter.id, name: matter.name, goal: matter.goal, createdAt: matter.createdAt,
      ...(matter.archivedAt ? { archivedAt: matter.archivedAt } : {}),
      sessions, lastActivity: sessions[0]?.lastActivity ?? Date.parse(matter.createdAt),
    };
  });
  const active = matters.filter(matter => !matter.archivedAt).sort(newestFirst);
  const archived = matters.filter(matter => matter.archivedAt)
    .sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!) || a.id.localeCompare(b.id));

  const unassigned = input.sessions.filter(view => listed(view) && !matterOf.has(view.id)).map(board).sort(newestFirst);

  const today = dayKey(input.now, input.timeZone);
  const days = new Map<string, ReviewDay>();
  for (const view of input.sessions) {
    if (!listed(view)) continue;
    const day = dayKey(view.lastActivity, input.timeZone);
    // A clock running ahead of the Host's still counts as today.
    const daysAgo = Math.max(0, daysBetween(day, today));
    if (daysAgo >= REVIEW_DAYS) continue;
    const key = daysAgo === 0 ? today : day;
    const matter = matterOf.get(view.id);
    const session: ReviewSession = { ...board(view), ...(matter ? { matter: { id: matter.id, name: matter.name } } : {}) };
    const entry = days.get(key) ?? { day: key, daysAgo, sessions: [] };
    entry.sessions.push(session);
    days.set(key, entry);
  }
  const review = [...days.values()].sort((a, b) => a.daysAgo - b.daysAgo);
  for (const day of review) day.sessions.sort(newestFirst);

  return { matters: [...active, ...archived], unassigned, review, assistant, now: input.now };
}
