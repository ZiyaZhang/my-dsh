/**
 * 做事记录: what my dsh did, what the user filed by hand, the suggestions of automatic grouping the user accepted, what they took back,
 * and every change to a matter's memory, oldest first on disk. Every function is pure. An entry that made a link (`start`, `file`) can be
 * undone while that exact link, matched by its time, is still in its matter; undoing takes the session out of the matter, keeps the
 * session, marks the entry and records the undo as an entry of its own. A `group` entry can be undone while all its links are still as
 * it made them and, when it made the matter, nothing else was put in the matter or set on it; undoing takes its sessions out and removes
 * a matter it made. A `note` entry can be undone while the file it wrote is still as it wrote it; undoing deletes the file.
 */
import { stamp } from './board-index.js';
import { linkOf, removeSession, type Changed } from './matters.js';
import { clip } from './preview.js';
import {
  RequestError, type ActivityEntry, type ActivityKind, type ActivityView, type CardPlace, type CardView, type LinkSource, type Matter, type MemoryAuthor,
} from './remote.js';

export const ACTIVITY_MAX = 1000;

interface Named {
  id: string;
  at: string;
  matterId: string;
  matterName: string;
  sessionId: string;
  title: string;
}

export function startEntry(input: Named & { why: string; task: string; card?: CardPlace }): ActivityEntry {
  const { card, ...rest } = input;
  return { ...rest, kind: 'start', text: `在「${input.matterName}」开了会话 ${input.title}`, ...(card ? { card } : {}) };
}

export function sendEntry(input: Omit<Named, 'matterId' | 'matterName'> & { matterId?: string; matterName?: string; why: string; task: string; card?: CardPlace }): ActivityEntry {
  const { card, ...rest } = input;
  return { ...rest, kind: 'send', text: `给会话 ${input.title} 发了消息`, ...(card ? { card } : {}) };
}

/**
 * What my dsh wrote into a matter's memory from the user's words: the file it added and its hash. Its `why` is empty: the user's words
 * are the reason.
 */
export function noteEntry(input: {
  id: string; at: string; matterId: string; matterName: string; note: { id: string; text: string; path?: string; hash?: string }; card?: CardPlace;
}): ActivityEntry {
  const { card, note, ...rest } = input;
  return {
    ...rest, kind: 'note', text: `记进「${input.matterName}」：${note.text}`, why: '', note: { ...note },
    ...(note.path ? { memory: { path: note.path, change: 'add' as const, by: 'note' as const } } : {}), ...(card ? { card } : {}),
  };
}

/** Who changed a memory file, as 做事记录 says it. */
const AUTHOR: Record<Exclude<MemoryAuthor, 'session'>, string> = { user: '你在编辑器里改的', capture: '补记', merge: '合并', note: 'my dsh 记下你说的' };
const CHANGE: Record<'add' | 'update' | 'delete', string> = { add: '新记了', update: '改了', delete: '删了' };

/** A change to a file of a matter's memory; `title` names the session that made it. */
export function memoryEntry(input: {
  id: string; at: string; matterId: string; matterName: string; path: string; change: 'add' | 'update' | 'delete'; by: MemoryAuthor;
  sessionId?: string; title?: string;
}): ActivityEntry {
  const { path, change, by, sessionId, title, ...rest } = input;
  const who = by === 'session' ? `会话「${title ?? '未命名'}」改的` : AUTHOR[by];
  return {
    ...rest, kind: 'memory', text: `「${input.matterName}」的记忆：${CHANGE[change]} ${path}`, why: who, memory: { path, change, by },
    ...(sessionId ? { sessionId } : {}), ...(title ? { title } : {}),
  };
}

/** How much of the user's words a `forward` entry's line shows, in characters. */
export const FORWARD_LINE = 60;

/** The user's words my dsh passed to a matter's conversation (`sessionId`), kept whole in `task`; nothing to undo once they went. */
export function forwardEntry(input: { id: string; at: string; matterId: string; matterName: string; sessionId: string; words: string; why: string; card?: CardPlace }): ActivityEntry {
  const { card, words, ...rest } = input;
  return { ...rest, kind: 'forward', text: `转给了「${input.matterName}」：${clip(words, FORWARD_LINE)}`, task: words, ...(card ? { card } : {}) };
}

/** A by-hand filing; `from` names the matter the session left when it was a move. */
export function fileEntry(input: Named & { from?: string }): ActivityEntry {
  const { from, ...rest } = input;
  const text = from === undefined ? `把会话 ${input.title} 加进「${input.matterName}」` : `把会话 ${input.title} 从「${from}」移到「${input.matterName}」`;
  return { ...rest, kind: 'file', text, why: from === undefined ? '你手动加的' : '你手动移的' };
}

export function unfileEntry(input: Named): ActivityEntry {
  return { ...input, kind: 'unfile', text: `把会话 ${input.title} 移出「${input.matterName}」`, why: '你手动移出的' };
}

/** A confirmed new, merged or renamed matter. */
export function manageEntry(input: { id: string; at: string; matterId: string; matterName: string; text: string; why: string }): ActivityEntry {
  return { ...input, kind: 'manage' };
}

/**
 * An accepted suggestion of automatic grouping: a new matter with its sessions (`created`), or one session put in a matter. Its time is
 * the time of the links it made, which is how undo finds them; `why` is the suggestion's reason.
 */
export function groupEntry(input: {
  id: string; at: string; matterId: string; matterName: string; sessions: readonly { id: string; title: string }[]; created: boolean;
  by: LinkSource; why: string;
}): ActivityEntry {
  const { sessions, created, ...rest } = input;
  const one = !created && sessions.length === 1 ? sessions[0]! : undefined;
  const text = one ? `把会话 ${one.title} 归进「${input.matterName}」` : `新起事项「${input.matterName}」，放进 ${sessions.length} 个会话`;
  return {
    ...rest, kind: 'group', ...(one ? { sessionId: one.id, title: one.title } : {}), sessions: sessions.map(session => session.id),
    ...(created ? { created: true as const } : {}), text,
  };
}

/** The link an undoable entry made. */
const MADE: Partial<Record<ActivityEntry['kind'], LinkSource>> = { start: 'mydsh', file: 'manual' };
/** The kinds an undo can take back: those that made links and a written note. */
const UNDOABLE: readonly ActivityKind[] = ['start', 'file', 'group', 'note'];

/** A `group` entry's links are all still as it made them, and a matter it made holds nothing else and has nothing set on it. */
function groupIntact(entry: ActivityEntry, matters: readonly Matter[]): boolean {
  const sessions = entry.sessions ?? [];
  const matter = matters.find(candidate => candidate.id === entry.matterId);
  if (!matter || sessions.length === 0 || !entry.by) return false;
  const made = sessions.every(id => matter.sessions.some(link => link.sessionId === id && link.by === entry.by && link.at === entry.at));
  if (!made || !entry.created) return made;
  return matter.sessions.length === sessions.length && !matter.conversation && matter.sources.length === 0 && !matter.instructions && !matter.hosting;
}

/** @param notes - the note ids of the `note` entries whose files are still as they wrote them. */
export function canUndo(entry: ActivityEntry, matters: readonly Matter[], notes: ReadonlySet<string> = new Set()): boolean {
  if (entry.undoneAt !== undefined) return false;
  if (entry.kind === 'note') return entry.note !== undefined && notes.has(entry.note.id);
  if (entry.kind === 'group') return groupIntact(entry, matters);
  const by = MADE[entry.kind];
  if (!by || !entry.matterId || !entry.sessionId) return false;
  const found = linkOf(matters, entry.sessionId);
  return found !== undefined && found.matter.id === entry.matterId && found.link.by === by && found.link.at === entry.at;
}

/**
 * What undoing does to the matters: the session leaves the matter the entry put it in; a `group` entry's sessions all leave, and a
 * matter it made goes.
 */
export function undoChange(matters: readonly Matter[], entry: ActivityEntry): Changed<Matter | null> {
  if (!canUndo(entry, matters)) throw new RequestError('这条已经撤不回了');
  if (entry.kind !== 'group') return removeSession(matters, entry.sessionId!);
  const left = (entry.sessions ?? []).reduce<Matter[]>((list, sessionId) => removeSession(list, sessionId).matters, [...matters]);
  if (entry.created) return { matters: left.filter(matter => matter.id !== entry.matterId), matter: null };
  return { matters: left, matter: left.find(matter => matter.id === entry.matterId) ?? null };
}

/**
 * The file undoing a `note` entry deletes, with the hash it must still have.
 * @throws RequestError for an entry taken back already, another kind, or a note from before 事项记忆, which has no file.
 */
export function noteFile(entry: ActivityEntry): { matterId: string; path: string; hash: string } {
  const note = entry.kind === 'note' && entry.undoneAt === undefined ? entry.note : undefined;
  if (!note?.path || !note.hash || !entry.matterId) throw new RequestError('这条已经撤不回了');
  return { matterId: entry.matterId, path: note.path, hash: note.hash };
}

function undoText(entry: ActivityEntry): string {
  if (entry.kind === 'start') return `撤回了会话 ${entry.title ?? ''}（在「${entry.matterName ?? ''}」）`;
  if (entry.kind === 'note') return `撤回了「${entry.matterName ?? ''}」记忆里的：${entry.note?.text ?? ''}`;
  if (entry.kind === 'group' && entry.created) return `撤回了新起的事项「${entry.matterName ?? ''}」`;
  return `把会话 ${entry.title ?? ''} 移出「${entry.matterName ?? ''}」`;
}

/** Mark an entry undone and record the undo. */
export function markUndone(entries: readonly ActivityEntry[], id: string, made: { id: string; at: string }): { entries: ActivityEntry[]; record: ActivityEntry } {
  const entry = entries.find(candidate => candidate.id === id);
  if (!entry) throw new RequestError('没有这条记录');
  if (!UNDOABLE.includes(entry.kind) || entry.undoneAt !== undefined) throw new RequestError('这条已经撤不回了');
  const record: ActivityEntry = {
    id: made.id, at: made.at, kind: 'undo',
    ...(entry.matterId ? { matterId: entry.matterId } : {}), ...(entry.matterName ? { matterName: entry.matterName } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ...(entry.title ? { title: entry.title } : {}),
    text: undoText(entry), why: '你点了撤回', undoes: entry.id,
  };
  const marked = entries.map(candidate => candidate.id === id ? { ...candidate, undoneAt: made.at } : candidate);
  return { entries: appendActivity(marked, record), record };
}

/** Add an entry; the oldest go once the log passes its bound. */
export function appendActivity(entries: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  const next = [...entries, entry];
  return next.length > ACTIVITY_MAX ? next.slice(next.length - ACTIVITY_MAX) : next;
}

/** Newest first, each with whether it can still be undone; `notes` as in {@link canUndo}. */
export function activityView(entries: readonly ActivityEntry[], matters: readonly Matter[], notes: ReadonlySet<string> = new Set()): ActivityView[] {
  return entries.map(entry => ({ ...entry, undoable: canUndo(entry, matters, notes) })).reverse();
}

/**
 * The receipts under my dsh's turns, in the order they were made; `notes` as in {@link canUndo}. Of the passes to one matter, only the
 * newest is `latest`.
 */
export function receiptCards(entries: readonly ActivityEntry[], matters: readonly Matter[], notes: ReadonlySet<string> = new Set()): CardView[] {
  const newest = new Map<string, string>();
  for (const entry of entries) if (entry.kind === 'forward' && entry.matterId) newest.set(entry.matterId, entry.id);
  return entries.flatMap((entry): CardView[] => {
    if (!entry.card) return [];
    if (entry.kind === 'forward') {
      if (!entry.matterId || !entry.sessionId) return [];
      return [{
        type: 'forward', id: entry.id, matterId: entry.matterId, matterName: entry.matterName ?? '', conversationId: entry.sessionId,
        at: Date.parse(entry.at), latest: newest.get(entry.matterId) === entry.id, ...entry.card,
      }];
    }
    const state = { undoable: canUndo(entry, matters, notes), undone: entry.undoneAt !== undefined, ...entry.card };
    if (entry.kind === 'note') return [{ type: 'receipt', id: entry.id, kind: 'note', line: entry.text, ...state }];
    if (!entry.sessionId || (entry.kind !== 'start' && entry.kind !== 'send')) return [];
    return [{ type: 'receipt', id: entry.id, kind: entry.kind, line: entry.text, target: entry.sessionId, ...state }];
  });
}

/** Entries in the per-turn context. */
export const CONTEXT_ACTIVITY = 10;

/** Who did what, as the per-turn context names each kind. */
const DONE_BY: Record<ActivityEntry['kind'], string> = {
  start: 'my dsh 开会话', send: 'my dsh 发消息', note: 'my dsh 记进事项', forward: 'my dsh 转给事项', file: '用户手动加入', unfile: '用户手动移出',
  manage: '用户确认改事项', undo: '用户撤回', memory: '记忆改动', group: '用户确认自动归类',
};

/**
 * The newest entries as my dsh reads them each step, so it says what happened instead of guessing. Changes to the matters' memory stay
 * out: they belong to each matter, not to the board.
 * @returns the text, or an empty string while the log is empty.
 */
export function recentActivity(entries: readonly ActivityEntry[], clock: { now: number; timeZone: string }, count = CONTEXT_ACTIVITY): string {
  const recent = entries.filter(entry => entry.kind !== 'memory').slice(-count).reverse();
  if (recent.length === 0) return '';
  return [
    `做事记录（最近 ${recent.length} 条，新的在前）：`,
    ...recent.map(entry => `- ${stamp(Date.parse(entry.at), clock.now, clock.timeZone)} ${DONE_BY[entry.kind]}：${entry.text}${entry.undoneAt ? '（已撤回）' : ''}`),
  ].join('\n');
}
