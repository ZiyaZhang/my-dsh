/**
 * The origin rules of automatic grouping, strongest first: the same scheduled task, the same PR, the same branch, an @-reference. Each
 * rule looks only at the loose sessions no earlier rule placed. A loose session whose key points at sessions (or sources) of exactly one
 * matter in progress gets a filing into it; a key that points at two matters places nothing. Loose sessions whose keys point at no
 * matter and that share a key, two or more of them, get a new matter. A suggestion the user declined, or a filing into a matter the user
 * took the session out of, is not made again, and its sessions stay open for the rules after it and for the model. Pure.
 */
import type { SessionEvidence } from './grouping-evidence.js';
import { branchKey, type GitFacts } from './grouping-git.js';
import { changeSessions, pairKey, suggestionKey, type Made, type SuggestionChange } from './grouping.js';
import { clip } from './preview.js';
import { GOAL_MAX, NAME_MAX, type OriginRule } from './remote.js';
import type { ScheduleEntry } from './snapshot.js';

/** A session as the rules read it. */
export interface RuleSession {
  id: string;
  /** As the board shows it. */
  title: string;
  lastActivity: number;
  /** The matter in progress it is in; absent for a loose session. */
  matterId?: string;
  /** Its repository and branch, when known and not a shared branch such as main. */
  branch?: { key: string; name: string };
  /** `host/owner/repo#n`. */
  prs: readonly string[];
  /** Sessions the user @-referenced in it. */
  refs: readonly string[];
  /** Scheduled tasks that delivered into it. */
  runs: readonly string[];
}

/** A scheduled task as the rules read it. */
export interface RuleTask {
  title: string;
  /** What the task sends each time, which becomes a new matter's goal. */
  prompt?: string;
  /** The session that made the task, when that is not a session it delivers into. */
  creator?: string;
}

export interface RuleInput {
  /** Loose sessions, newest first. */
  loose: readonly RuleSession[];
  /** Sessions in matters in progress. */
  filed: readonly RuleSession[];
  /** Matters in progress by id: the name, and the PR keys among their sources. */
  matters: ReadonlyMap<string, { name: string; prs: readonly string[] }>;
  /** DSH's scheduled tasks by id. */
  tasks: ReadonlyMap<string, RuleTask>;
  /** Never-again keys of declined suggestions ({@link suggestionKey}). */
  declined: ReadonlySet<string>;
  /** {@link pairKey} of each session the user took out of a matter by hand. */
  takenOut: ReadonlySet<string>;
}

export interface RuleResult {
  suggestions: Made[];
  /** The loose sessions the suggestions are about. */
  placed: Set<string>;
}

/** A branch recorded when one of a session's turns ended. */
export interface BranchNote {
  key: string;
  name: string;
  /** Epoch ms of the turn end. */
  at: number;
}

/**
 * A session's branch for the rules: the one recorded when its turns ended, else the branch its worktree has now. A main checkout's
 * branch now is not used: it changes under every session that ran there.
 */
export function sessionBranch(note: BranchNote | undefined, git: GitFacts | undefined): { key: string; name: string } | undefined {
  if (note) return { key: note.key, name: note.name };
  return git?.worktree ? branchKey(git) : undefined;
}

/** A session's PRs: those its evidence names, and the bare numbers it named, in the repository of its git remote. */
export function sessionPrs(evidence: Pick<SessionEvidence, 'prs' | 'numbers'> | undefined, remote: string | undefined): string[] {
  if (!evidence) return [];
  return unique([...evidence.prs, ...(remote ? evidence.numbers.map(number => `${remote}#${number}`) : [])]);
}

/**
 * What DSH's task list says for the rules: each task with the session that made it, unless that is a session it delivers into
 * (`involvedSessionIds` starts with the session whose agent made the task), and the tasks each session runs: the session a task
 * delivers into, and the one its last delivery went to.
 */
export function scheduleFacts(entries: readonly ScheduleEntry[]): { tasks: Map<string, RuleTask>; runs: Map<string, string[]> } {
  const tasks = new Map<string, RuleTask>();
  const runs = new Map<string, string[]>();
  const run = (sessionId: string | undefined, taskId: string) => { if (sessionId) runs.set(sessionId, unique([...(runs.get(sessionId) ?? []), taskId])); };
  for (const entry of entries) {
    const targets = new Set([entry.target.sessionId, entry.lastDelivery?.targetSessionId].filter((id): id is string => typeof id === 'string'));
    const creator = entry.involvedSessionIds[0];
    tasks.set(entry.id, { title: entry.title, ...(entry.prompt ? { prompt: entry.prompt } : {}), ...(creator && !targets.has(creator) ? { creator } : {}) });
    for (const sessionId of targets) run(sessionId, entry.id);
  }
  return { tasks, runs };
}

/** A text as a matter's name: one line, at most {@link NAME_MAX} characters. */
export function nameFrom(text: string): string {
  const characters = [...text.replace(/\s+/g, ' ').trim()];
  return characters.slice(0, NAME_MAX).join('').trim() || '未命名';
}

/** A PR key as people write it: `owner/repo#n` on github.com, with its host elsewhere. */
export const prName = (key: string): string => (key.startsWith('github.com/') ? key.slice('github.com/'.length) : key);

const short = (text: string) => clip(text, 24);
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** Sessions joined when they share a key, each group in the order the sessions came. */
function components(sessions: readonly RuleSession[], keysOf: (session: RuleSession) => readonly string[]): RuleSession[][] {
  const parent = new Map(sessions.map(session => [session.id, session.id]));
  const root = (id: string): string => {
    let top = id;
    while (parent.get(top) !== top) top = parent.get(top)!;
    parent.set(id, top);
    return top;
  };
  const first = new Map<string, string>();
  for (const session of sessions) {
    for (const key of keysOf(session)) {
      const seen = first.get(key);
      if (seen === undefined) first.set(key, session.id);
      else parent.set(root(session.id), root(seen));
    }
  }
  const groups = new Map<string, RuleSession[]>();
  for (const session of sessions) {
    const top = root(session.id);
    groups.set(top, [...(groups.get(top) ?? []), session]);
  }
  return [...groups.values()];
}

/** The key most sessions of a group hold, the first of them on a tie. */
function commonest(group: readonly RuleSession[], keysOf: (session: RuleSession) => readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const session of group) for (const key of keysOf(session)) counts.set(key, (counts.get(key) ?? 0) + 1);
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best?.[0];
}

export function originSuggestions(input: RuleInput): RuleResult {
  const placed = new Set<string>();
  const suggestions: Made[] = [];
  const open = () => input.loose.filter(session => !placed.has(session.id));
  const nameOf = (matterId: string) => input.matters.get(matterId)?.name ?? '';
  /** Make the suggestion unless the user declined it, or took the session out of that matter; placed sessions are left to no one else. */
  const offer = (change: SuggestionChange, why: string, rule: OriginRule): void => {
    if (input.declined.has(suggestionKey(change))) return;
    if (change.kind === 'file' && input.takenOut.has(pairKey(change.sessionId, change.matterId))) return;
    suggestions.push({ change, why, by: 'origin', rule });
    for (const id of changeSessions(change)) placed.add(id);
  };
  const live = (matterId: string | undefined): matterId is string => matterId !== undefined && input.matters.has(matterId);

  // The same scheduled task: the matter of the task's other runs; else the matter of the session that made it; else a new matter.
  for (const taskId of unique(input.loose.flatMap(session => session.runs))) {
    const runs = open().filter(session => session.runs.includes(taskId));
    if (runs.length === 0) continue;
    const task = input.tasks.get(taskId);
    const title = task?.title ?? runs[0]!.title;
    const matters = unique(input.filed.filter(session => session.runs.includes(taskId)).map(session => session.matterId).filter(live));
    if (matters.length > 1) continue;
    if (matters.length === 1) {
      for (const session of runs) offer({ kind: 'file', sessionId: session.id, matterId: matters[0]! }, `和「${nameOf(matters[0]!)}」里的会话来自同一个定时任务「${short(title)}」`, 'schedule');
      continue;
    }
    const made = task?.creator === undefined ? undefined : input.filed.find(session => session.id === task.creator)?.matterId;
    if (live(made)) {
      for (const session of runs) offer({ kind: 'file', sessionId: session.id, matterId: made }, `定时任务「${short(title)}」是在「${nameOf(made)}」的会话里建的`, 'schedule');
      continue;
    }
    if (runs.length >= 2) {
      offer({ kind: 'new', sessionIds: runs.map(session => session.id), name: nameFrom(title), goal: task?.prompt ? clip(task.prompt, GOAL_MAX) : '' }, `来自同一个定时任务「${short(title)}」`, 'schedule');
    }
  }

  // The same PR: held by a matter's sessions or named among its sources.
  const prHolders = new Map<string, Set<string>>();
  const hold = (holders: Map<string, Set<string>>, key: string, matterId: string) => { holders.set(key, new Set([...(holders.get(key) ?? []), matterId])); };
  for (const session of input.filed) if (live(session.matterId)) for (const key of session.prs) hold(prHolders, key, session.matterId);
  for (const [matterId, matter] of input.matters) for (const key of matter.prs) hold(prHolders, key, matterId);
  keyed(open(), session => session.prs, prHolders, (session, matterId, key) => {
    offer({ kind: 'file', sessionId: session.id, matterId }, `和「${nameOf(matterId)}」处理的是同一个 PR ${prName(key)}`, 'pr');
  }, (group, key) => {
    offer({ kind: 'new', sessionIds: group.map(session => session.id), name: nameFrom(prName(key)), goal: '' }, `处理的是同一个 PR ${prName(key)}`, 'pr');
  });

  // The same branch of the same repository.
  const branchHolders = new Map<string, Set<string>>();
  for (const session of input.filed) if (live(session.matterId) && session.branch) hold(branchHolders, session.branch.key, session.matterId);
  const branchName = new Map([...input.loose, ...input.filed].flatMap(session => (session.branch ? [[session.branch.key, session.branch.name] as const] : [])));
  keyed(open(), session => (session.branch ? [session.branch.key] : []), branchHolders, (session, matterId, key) => {
    offer({ kind: 'file', sessionId: session.id, matterId }, `和「${nameOf(matterId)}」里的会话在同一个分支 ${branchName.get(key)} 上`, 'branch');
  }, (group, key) => {
    offer({ kind: 'new', sessionIds: group.map(session => session.id), name: nameFrom(branchName.get(key) ?? ''), goal: '' }, `在同一个分支 ${branchName.get(key)} 上`, 'branch');
  });

  // An @-reference: the matter of the sessions it referenced, when they are in one; loose sessions that referenced each other together.
  const matterOf = new Map(input.filed.flatMap(session => (live(session.matterId) ? [[session.id, session.matterId] as const] : [])));
  const titleOf = new Map([...input.loose, ...input.filed].map(session => [session.id, session.title]));
  const unplaced: RuleSession[] = [];
  for (const session of open()) {
    const matters = unique(session.refs.flatMap(id => (matterOf.has(id) ? [matterOf.get(id)!] : [])));
    if (matters.length > 1) continue;
    if (matters.length === 1) {
      const referenced = session.refs.find(id => matterOf.get(id) === matters[0])!;
      offer({ kind: 'file', sessionId: session.id, matterId: matters[0]! }, `@ 了「${nameOf(matters[0]!)}」里的会话「${short(titleOf.get(referenced) ?? '')}」`, 'reference');
      continue;
    }
    unplaced.push(session);
  }
  for (const group of components(unplaced, session => [session.id, ...session.refs])) {
    if (group.length < 2) continue;
    const ids = new Set(group.map(session => session.id));
    const cited = commonest(group, session => session.refs.filter(id => ids.has(id)));
    offer({ kind: 'new', sessionIds: group.map(session => session.id), name: nameFrom(titleOf.get(cited ?? group[0]!.id) ?? group[0]!.title), goal: '' }, '这几条会话之间有 @ 引用', 'reference');
  }
  return { suggestions, placed };
}

/**
 * One keyed rule over the open loose sessions: a session whose keys point at exactly one matter is filed there, at two or more it is
 * left alone; the sessions whose keys point at no matter are joined by shared keys, and each group of two or more gets a new matter,
 * named by the key most of them hold.
 */
function keyed(
  sessions: readonly RuleSession[], keysOf: (session: RuleSession) => readonly string[], holders: ReadonlyMap<string, ReadonlySet<string>>,
  file: (session: RuleSession, matterId: string, key: string) => void, group: (sessions: RuleSession[], key: string) => void,
): void {
  const free: RuleSession[] = [];
  for (const session of sessions) {
    const keys = keysOf(session);
    if (keys.length === 0) continue;
    const matters = unique(keys.flatMap(key => [...(holders.get(key) ?? [])]));
    if (matters.length === 1) file(session, matters[0]!, keys.find(key => holders.get(key)?.has(matters[0]!))!);
    else if (matters.length === 0) free.push(session);
  }
  for (const members of components(free, keysOf)) {
    if (members.length < 2) continue;
    group(members, commonest(members, keysOf)!);
  }
}
