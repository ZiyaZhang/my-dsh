/**
 * What each matter action does to the list of matters. Every function is pure: it returns a new list and the matter it changed, and
 * throws a RequestError for an id the list does not have. The store runs them one at a time and writes the result.
 */
import { ALIAS_MAX, ALIASES_MAX, RequestError, type Matter, type MatterSource, type SessionLink } from './remote.js';

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

const has = (matter: Matter, sessionId: string) => matter.sessions.some(link => link.sessionId === sessionId);
const without = (matter: Matter, sessionId: string): Matter => ({ ...matter, sessions: matter.sessions.filter(link => link.sessionId !== sessionId) });

/** One line, single spaces, as the user wrote it; undefined when it cannot be an alias. */
function aliasText(phrase: string): string | undefined {
  if (/[\r\n]/.test(phrase)) return undefined;
  const text = phrase.replace(/\s+/g, ' ').trim();
  if (text === '' || [...text].length > ALIAS_MAX || /\p{Cc}/u.test(text)) return undefined;
  return text;
}

const sameWords = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Words that point at a thing or name only its kind, and question words; none of them tells one matter from another. */
const VAGUE_WORDS = ['怎么样', '这个', '那个', '这件', '那件', '这条', '那条', '之前', '刚才', '上次', '上回', '事项', '项目', '事情', '东西', '会话', '任务', '文档', '现在'];
/** Single characters of the same sort, taken off the ends of what is left. */
const EDGE_CHARACTERS = new Set(['这', '那', '它', '事', '了', '吗', '呢', '的']);

/**
 * The part of a phrase that can name a matter: without punctuation, pointing and time words, generic nouns and question words.
 * @returns the cleaned phrase, or undefined when fewer than two letters or digits are left.
 */
export function cleanPhrase(phrase: string): string | undefined {
  let text = phrase.replace(/[\p{P}\p{S}]/gu, ' ').replace(/\bpr\b/gi, ' ');
  for (const word of VAGUE_WORDS) text = text.split(word).join(' ');
  const words = text.split(/\s+/).map((word) => {
    const characters = [...word];
    while (characters.length > 0 && EDGE_CHARACTERS.has(characters[0]!)) characters.shift();
    while (characters.length > 0 && EDGE_CHARACTERS.has(characters.at(-1)!)) characters.pop();
    return characters.join('');
  }).filter(Boolean);
  const cleaned = words.join(' ');
  return [...cleaned].filter(character => /[\p{L}\p{N}]/u.test(character)).length >= 2 ? cleaned : undefined;
}

/** `phrases` put in front of the aliases, newest first, without repeats, the matter's own name, or more than ALIASES_MAX. */
function withAliases(matter: Matter, phrases: readonly string[]): Matter {
  const next: string[] = [];
  for (const phrase of [...phrases, ...matter.aliases]) {
    const text = aliasText(phrase);
    if (text === undefined || sameWords(text, matter.name) || next.some(alias => sameWords(alias, text))) continue;
    next.push(text);
    if (next.length === ALIASES_MAX) break;
  }
  return { ...matter, aliases: next };
}

/** The matter a session is in, if any. */
export function matterOf(matters: readonly Matter[], sessionId: string): Matter | undefined {
  return matters.find(matter => has(matter, sessionId));
}

/** The matter a session is in and the link it joined with. */
export function linkOf(matters: readonly Matter[], sessionId: string): { matter: Matter; link: SessionLink } | undefined {
  for (const matter of matters) {
    const link = matter.sessions.find(candidate => candidate.sessionId === sessionId);
    if (link) return { matter, link };
  }
  return undefined;
}

/** A matter's context: its main workspace, its sources and the user's standing requests. */
export interface MatterContext {
  workspaceId?: string;
  sources: MatterSource[];
  instructions?: string;
}

const withContext = (matter: Matter, context: MatterContext): Matter => {
  const { workspaceId: _workspaceId, instructions: _instructions, ...rest } = matter;
  return {
    ...rest, ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    sources: context.sources.map(source => ({ ...source })), ...(context.instructions ? { instructions: context.instructions } : {}),
  };
};

/** A new matter with no sessions, at the end of the list. `made` carries the id and the time, so tests can fix them. */
export function createMatter(
  matters: readonly Matter[], input: { name: string; goal: string } & Partial<MatterContext>, made: { id: string; at: string },
): Changed {
  const bare: Matter = { id: made.id, name: input.name, goal: input.goal, sessions: [], aliases: [], sources: [], createdAt: made.at };
  const matter = withContext(bare, { ...input, sources: input.sources ?? [] });
  return { matters: [...matters, matter], matter };
}

/** Replace the main workspace, the sources and the instructions; what the context leaves out is cleared. */
export function setContext(matters: readonly Matter[], id: string, context: MatterContext): Changed {
  return replace(matters, id, matter => withContext(matter, context));
}

/** The old name becomes the newest alias, so the words the user knew it by still find it. */
export function renameMatter(matters: readonly Matter[], id: string, name: string): Changed {
  return replace(matters, id, matter => withAliases({ ...matter, name }, [matter.name]));
}

export function setGoal(matters: readonly Matter[], id: string, goal: string): Changed {
  return replace(matters, id, matter => ({ ...matter, goal }));
}

/** Remember the words the user used for the matter, cleaned by {@link cleanPhrase}. A phrase that leaves nothing changes nothing. */
export function addAlias(matters: readonly Matter[], id: string, phrase: string): Changed {
  const cleaned = /[\r\n]/.test(phrase) ? undefined : cleanPhrase(phrase);
  return replace(matters, id, matter => cleaned === undefined ? matter : withAliases(matter, [cleaned]));
}

/** Archiving an archived matter keeps its first archive time. */
export function archiveMatter(matters: readonly Matter[], id: string, at: string): Changed {
  return replace(matters, id, matter => matter.archivedAt ? matter : { ...matter, archivedAt: at });
}

export function unarchiveMatter(matters: readonly Matter[], id: string): Changed {
  return replace(matters, id, unarchived);
}

/**
 * Put a session in a matter with the link that says how it got there, taking it out of the matter it was in. A session already there
 * keeps its place and its first link. Adding to an archived matter brings the matter back to in progress, since it has work again.
 */
export function addSession(matters: readonly Matter[], matterId: string, link: SessionLink): Changed {
  find(matters, matterId);
  const next = matters.map((matter) => {
    if (matter.id === matterId) {
      const joined = has(matter, link.sessionId) ? matter : { ...matter, sessions: [...matter.sessions, link] };
      return joined.archivedAt ? unarchived(joined) : joined;
    }
    return has(matter, link.sessionId) ? without(matter, link.sessionId) : matter;
  });
  return { matters: next, matter: next.find(matter => matter.id === matterId)! };
}

/** Take a session out of its matter; `matter` is the matter it left, or null when it was in none. */
export function removeSession(matters: readonly Matter[], sessionId: string): Changed<Matter | null> {
  const from = matterOf(matters, sessionId);
  if (!from) return { matters: [...matters], matter: null };
  const left = without(from, sessionId);
  return { matters: matters.map(matter => matter.id === from.id ? left : matter), matter: left };
}

/**
 * Merge `fromId` into `intoId`: its sessions follow with the links they had, its sources join the ones the staying matter lacks, its
 * name and aliases become aliases of the matter that stays, and it leaves the list. Sessions arriving in an archived matter bring it
 * back, as in {@link addSession}.
 */
export function mergeMatters(matters: readonly Matter[], fromId: string, intoId: string): Changed {
  if (fromId === intoId) throw new RequestError('一件事项不能并进自己');
  const from = find(matters, fromId);
  const into = find(matters, intoId);
  const arriving = from.sessions.filter(link => !has(into, link.sessionId));
  const sources = [...into.sources, ...from.sources.filter(source => !into.sources.some(kept => kept.value === source.value))];
  const joined = withAliases({ ...into, sessions: [...into.sessions, ...arriving], sources }, [from.name, ...from.aliases]);
  const merged = arriving.length > 0 && joined.archivedAt ? unarchived(joined) : joined;
  return { matters: matters.flatMap(matter => matter.id === fromId ? [] : matter.id === intoId ? [merged] : [matter]), matter: merged };
}
