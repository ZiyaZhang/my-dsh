/**
 * 做事记录: what my dsh did, what the user filed by hand and what they took back, oldest first on disk. Every function is pure. An
 * entry that made a link (`start`, `file`) can be undone while that exact link, matched by its time, is still in its matter; undoing
 * takes the session out of the matter, keeps the session, marks the entry and records the undo as an entry of its own.
 */
import { stamp } from './board-index.js';
import { linkOf, removeSession, type Changed } from './matters.js';
import { RequestError, type ActivityEntry, type ActivityView, type CardPlace, type CardView, type LinkSource, type Matter } from './remote.js';

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

/** The link an undoable entry made. */
const MADE: Partial<Record<ActivityEntry['kind'], LinkSource>> = { start: 'mydsh', file: 'manual' };

export function canUndo(entry: ActivityEntry, matters: readonly Matter[]): boolean {
  const by = MADE[entry.kind];
  if (!by || entry.undoneAt !== undefined || !entry.matterId || !entry.sessionId) return false;
  const found = linkOf(matters, entry.sessionId);
  return found !== undefined && found.matter.id === entry.matterId && found.link.by === by && found.link.at === entry.at;
}

/** What undoing does to the matters: the session leaves the matter the entry put it in. */
export function undoChange(matters: readonly Matter[], entry: ActivityEntry): Changed<Matter | null> {
  if (!canUndo(entry, matters)) throw new RequestError('这条已经撤不回了');
  return removeSession(matters, entry.sessionId!);
}

function undoText(entry: ActivityEntry): string {
  if (entry.kind === 'start') return `撤回了会话 ${entry.title ?? ''}（在「${entry.matterName ?? ''}」）`;
  return `把会话 ${entry.title ?? ''} 移出「${entry.matterName ?? ''}」`;
}

/** Mark an entry undone and record the undo. */
export function markUndone(entries: readonly ActivityEntry[], id: string, made: { id: string; at: string }): { entries: ActivityEntry[]; record: ActivityEntry } {
  const entry = entries.find(candidate => candidate.id === id);
  if (!entry) throw new RequestError('没有这条记录');
  if (!MADE[entry.kind] || entry.undoneAt !== undefined) throw new RequestError('这条已经撤不回了');
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

/** Newest first, each with whether it can still be undone. */
export function activityView(entries: readonly ActivityEntry[], matters: readonly Matter[]): ActivityView[] {
  return entries.map(entry => ({ ...entry, undoable: canUndo(entry, matters) })).reverse();
}

/** The receipts under my dsh's turns, in the order they were made. */
export function receiptCards(entries: readonly ActivityEntry[], matters: readonly Matter[]): CardView[] {
  return entries.flatMap((entry): CardView[] => {
    if (!entry.card || !entry.sessionId || (entry.kind !== 'start' && entry.kind !== 'send')) return [];
    return [{
      type: 'receipt', id: entry.id, kind: entry.kind, line: entry.text, target: entry.sessionId,
      undoable: canUndo(entry, matters), undone: entry.undoneAt !== undefined, ...entry.card,
    }];
  });
}

/** Entries in the per-turn context. */
export const CONTEXT_ACTIVITY = 10;

/** Who did what, as the per-turn context names each kind. */
const DONE_BY: Record<ActivityEntry['kind'], string> = {
  start: 'my dsh 开会话', send: 'my dsh 发消息', file: '用户手动加入', unfile: '用户手动移出', manage: '用户确认改事项', undo: '用户撤回',
};

/**
 * The newest entries as my dsh reads them each step, so it says what happened instead of guessing.
 * @returns the text, or an empty string while the log is empty.
 */
export function recentActivity(entries: readonly ActivityEntry[], clock: { now: number; timeZone: string }, count = CONTEXT_ACTIVITY): string {
  const recent = entries.slice(-count).reverse();
  if (recent.length === 0) return '';
  return [
    `做事记录（最近 ${recent.length} 条，新的在前）：`,
    ...recent.map(entry => `- ${stamp(Date.parse(entry.at), clock.now, clock.timeZone)} ${DONE_BY[entry.kind]}：${entry.text}${entry.undoneAt ? '（已撤回）' : ''}`),
  ].join('\n');
}
