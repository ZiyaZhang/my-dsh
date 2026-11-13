/**
 * 自动归类 (automatic grouping): suggestions that put loose sessions into matters, made by the origin rules (grouping-rules.ts) and then
 * by the user's default model (grouping-model.ts), and kept with their runs in grouping.json (grouping-store.ts). This module holds what
 * those, the Host and the snapshot share: a suggestion and its never-again key, when a run is due, which sessions are loose, a new
 * matter's main workspace, and what the card under my dsh's input shows of the pending suggestions. Pure and free of Host imports: the
 * client bundle reaches it through snapshot.ts.
 */
import type { ActivityEntry, BoardSession, Matter, OriginRule, SuggestionView } from './remote.js';
import type { SessionView } from './sessions.js';

/** How long after a finished run the next one may start, once something it reads changed since that run began. */
export const GROUPING_GAP_MS = 3 * 60 * 60 * 1000;

/** What a suggestion changes: several loose sessions go into a new matter, or one loose session into a matter in progress. */
export type SuggestionChange =
  | { kind: 'new'; sessionIds: string[]; name: string; goal: string }
  | { kind: 'file'; sessionId: string; matterId: string };

/** Where a suggestion came from: an origin rule, or the model. Accepting it links its sessions with this provenance. */
export type SuggestionSource = 'origin' | 'model';

/** A suggestion as a step of a run makes it, before the store gives it an id. */
export interface Made {
  change: SuggestionChange;
  /** One sentence, shown under 为什么. */
  why: string;
  by: SuggestionSource;
  /** `origin`: the rule that matched. */
  rule?: OriginRule;
}

export interface Suggestion extends Made {
  id: string;
  /** ISO time a run first made it. */
  at: string;
  state: 'pending' | 'accepted' | 'declined';
  decidedAt?: string;
  /** Once accepted: the matter it made, or the one the session went into. */
  matterId?: string;
}

/** One run: when it ran, what it looked at and made, and why it stopped when it did not finish. */
export interface GroupingRun {
  /** ISO times it started and ended. */
  at: string;
  endedAt: string;
  /** Loose sessions in the window. */
  loose: number;
  /** Session logs read for evidence. */
  read: number;
  /** Sessions sent to the model. */
  asked: number;
  /** Suggestions the origin rules and the model made, before declined ones were left out. */
  origin: number;
  model: number;
  /** Sessions were left for the model and no model service was there. */
  modelUnavailable?: true;
  /** Why it did not finish; the next check runs again. */
  error?: string;
}

/** A session in a matter, as the never-again key of a filing and the keys of what the user took out by hand name it. */
export const pairKey = (sessionId: string, matterId: string): string => `${sessionId}>${matterId}`;

/** The sessions a change is about. */
export const changeSessions = (change: SuggestionChange): string[] => (change.kind === 'new' ? [...change.sessionIds] : [change.sessionId]);

/** A declined suggestion's never-again key: a new matter by its exact set of sessions, a filing by the session and the matter. */
export function suggestionKey(change: SuggestionChange): string {
  return change.kind === 'new' ? `new:${[...new Set(change.sessionIds)].sort().join(',')}` : `file:${pairKey(change.sessionId, change.matterId)}`;
}

/** The never-again key of the suggestion an accepted `group` entry stands for, so undoing the entry declines it too. */
export function entryKey(entry: ActivityEntry): string | undefined {
  const sessions = entry.sessions ?? [];
  if (entry.kind !== 'group' || sessions.length === 0 || !entry.matterId) return undefined;
  return entry.created
    ? suggestionKey({ kind: 'new', sessionIds: sessions, name: '', goal: '' })
    : suggestionKey({ kind: 'file', sessionId: sessions[0]!, matterId: entry.matterId });
}

/**
 * A run is due. While none has finished: at once, so the first comes as the Host starts (a failed first run is tried again by the next
 * check). After one finished: when the run after it failed; when it had to leave the model out and a model is there now; otherwise
 * {@link GROUPING_GAP_MS} after it, once something changed since it began (`changedAt`: the newest activity of a loose session, or the
 * making of a matter), so a quiet spell costs no run.
 */
export function groupingDue(input: { runs: readonly GroupingRun[]; modelReady: boolean; now: number; changedAt: number | undefined }): boolean {
  const done = input.runs.findLast(run => run.error === undefined);
  if (!done) return true;
  if (input.runs.at(-1)!.error !== undefined) return true;
  if (done.modelUnavailable && input.modelReady) return true;
  return input.changedAt !== undefined && input.changedAt > Date.parse(done.at) && input.now - Date.parse(done.endedAt) >= GROUPING_GAP_MS;
}

/**
 * The loose sessions with activity since `since`, newest first: in no matter (an archived one included), not archived in DSH, not blank,
 * not a subagent, and not a conversation (my dsh's own or a matter's, `hidden`).
 */
export function looseSessions(
  views: readonly SessionView[], facts: { matters: readonly Matter[]; archived: ReadonlySet<string>; hidden: ReadonlySet<string>; since: number },
): SessionView[] {
  const filed = new Set(facts.matters.flatMap(matter => matter.sessions.map(link => link.sessionId)));
  return views
    .filter(view => !view.subagent && !view.blank && !facts.archived.has(view.id) && !facts.hidden.has(view.id) && !filed.has(view.id) && view.lastActivity >= facts.since)
    .sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
}

/**
 * The main workspace of a new matter: the workspace most of its sessions are in; between workspaces with as many, the one of the newest
 * session; none when no session is in a workspace.
 */
export function mainWorkspace(sessions: readonly Pick<BoardSession, 'lastActivity' | 'workspace' | 'workspaceId'>[]): { id: string; title: string } | undefined {
  const counts = new Map<string, { title: string; count: number; newest: number }>();
  for (const session of sessions) {
    if (!session.workspaceId) continue;
    const seen = counts.get(session.workspaceId);
    counts.set(session.workspaceId, {
      title: session.workspace ?? seen?.title ?? '', count: (seen?.count ?? 0) + 1, newest: Math.max(seen?.newest ?? 0, session.lastActivity),
    });
  }
  let best: { id: string; title: string; count: number; newest: number } | undefined;
  for (const [id, entry] of counts) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.newest > best.newest)) best = { id, ...entry };
  }
  return best ? { id: best.id, title: best.title } : undefined;
}

const newestFirst = (a: { lastActivity: number; id: string }, b: { lastActivity: number; id: string }) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id);

/**
 * What the card shows of the pending suggestions: those whose sessions are all still loose, and for a filing, whose matter is in progress
 * and is not one the user took the session out of by hand. New matters first, then filings, each by its newest session.
 * @param facts.loose - the board's unassigned sessions by id.
 * @param facts.takenOut - {@link pairKey} of every session the user took out of a matter by hand.
 */
export function suggestionViews(
  pending: readonly Suggestion[], facts: { loose: ReadonlyMap<string, BoardSession>; matters: readonly Matter[]; takenOut: ReadonlySet<string> },
): SuggestionView[] {
  const views = pending.flatMap((suggestion): SuggestionView[] => {
    if (suggestion.state !== 'pending') return [];
    const sessions: BoardSession[] = [];
    for (const id of changeSessions(suggestion.change)) {
      const session = facts.loose.get(id);
      if (!session) return [];
      sessions.push(session);
    }
    const shown = sessions.map(session => ({ id: session.id, title: session.title, lastActivity: session.lastActivity })).sort(newestFirst);
    const { change } = suggestion;
    if (change.kind === 'new') {
      const workspace = mainWorkspace(sessions);
      return [{
        id: suggestion.id, kind: 'new', name: change.name, ...(change.goal ? { goal: change.goal } : {}), ...(workspace ? { workspace } : {}),
        sessions: shown, why: suggestion.why,
      }];
    }
    const matter = facts.matters.find(candidate => candidate.id === change.matterId && !candidate.archivedAt);
    if (!matter || facts.takenOut.has(pairKey(change.sessionId, change.matterId))) return [];
    return [{ id: suggestion.id, kind: 'file', matter: { id: matter.id, name: matter.name }, sessions: shown, why: suggestion.why }];
  });
  return views.sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file')
    || b.sessions[0]!.lastActivity - a.sessions[0]!.lastActivity || a.id.localeCompare(b.id));
}
