/**
 * What each matter action does to the list of matters. Every function is pure: it returns a new list and the matter it changed, and
 * throws a RequestError for an id the list does not have. The store runs them one at a time and writes the result.
 */
import { RequestError, type Matter } from './remote.js';

export interface Changed<M = Matter> {
  matters: Matter[];
  matter: M;
}

function find(matters: readonly Matter[], id: string): Matter {
  const matter = matters.find(candidate => candidate.id === id);
  if (!matter) throw new RequestError('没有这个事项');
  return matter;
}

function replace(matters: readonly Matter[], id: string, change: (matter: Matter) => Matter): Changed {
  const next = change(find(matters, id));
  return { matters: matters.map(matter => matter.id === id ? next : matter), matter: next };
}

function unarchived(matter: Matter): Matter {
  const { archivedAt: _archivedAt, ...rest } = matter;
  return rest;
}

/** The matter a session is in, if any. */
export function matterOf(matters: readonly Matter[], sessionId: string): Matter | undefined {
  return matters.find(matter => matter.sessions.includes(sessionId));
}

/** A new matter with no sessions, at the end of the list. `made` carries the id and the time, so tests can fix them. */
export function createMatter(matters: readonly Matter[], input: { name: string; goal: string }, made: { id: string; at: string }): Changed {
  const matter: Matter = { id: made.id, name: input.name, goal: input.goal, sessions: [], createdAt: made.at };
  return { matters: [...matters, matter], matter };
}

export function renameMatter(matters: readonly Matter[], id: string, name: string): Changed {
  return replace(matters, id, matter => ({ ...matter, name }));
}

export function setGoal(matters: readonly Matter[], id: string, goal: string): Changed {
  return replace(matters, id, matter => ({ ...matter, goal }));
}

/** Archiving an archived matter keeps its first archive time. */
export function archiveMatter(matters: readonly Matter[], id: string, at: string): Changed {
  return replace(matters, id, matter => matter.archivedAt ? matter : { ...matter, archivedAt: at });
}

export function unarchiveMatter(matters: readonly Matter[], id: string): Changed {
  return replace(matters, id, unarchived);
}

/**
 * Put a session in a matter, taking it out of the matter it was in. A session already there keeps its place. Adding to an archived matter
 * brings the matter back to in progress, since it has work again.
 */
export function addSession(matters: readonly Matter[], matterId: string, sessionId: string): Changed {
  const target = find(matters, matterId);
  const next = matters.map((matter) => {
    if (matter.id === matterId) {
      const joined = matter.sessions.includes(sessionId) ? matter : { ...matter, sessions: [...matter.sessions, sessionId] };
      return joined.archivedAt ? unarchived(joined) : joined;
    }
    return matter.sessions.includes(sessionId) ? { ...matter, sessions: matter.sessions.filter(id => id !== sessionId) } : matter;
  });
  return { matters: next, matter: next.find(matter => matter.id === target.id)! };
}

/** Take a session out of its matter; `matter` is the matter it left, or null when it was in none. */
export function removeSession(matters: readonly Matter[], sessionId: string): Changed<Matter | null> {
  const from = matterOf(matters, sessionId);
  if (!from) return { matters: [...matters], matter: null };
  const left: Matter = { ...from, sessions: from.sessions.filter(id => id !== sessionId) };
  return { matters: matters.map(matter => matter.id === from.id ? left : matter), matter: left };
}
