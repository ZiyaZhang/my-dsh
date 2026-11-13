/**
 * What the board page's lists say, worked out from the snapshot: the line under each session, which 回顾 days start open and which
 * sessions there were dispatched, the rows of 等你处理, of the card under my dsh's input (with the suggestions of automatic grouping)
 * and of 跟进事项, a matter's counts by column,
 * its session area (cards in progress, idle rows), what a pass to a matter shows of its conversation, the numbers in the page heads,
 * and the rows of a matter's context. Pure, so it can be tested with a fixed clock.
 */
import { previewLine } from '../host/preview.js';
import type { BoardMatter, BoardSession, BoardSnapshot, ConversationView, ReviewSession, SessionState, SuggestionView } from '../host/remote.js';
import { waitingSince } from '../host/snapshot.js';

/** The line under a session's title. A waiting or failed session the Host sent no preview for still says so. */
export function lineOf(session: BoardSession, now: number): string {
  if (session.preview) return previewLine(session.preview, now);
  if (session.state === 'waiting') return session.wait === 'approval' ? '等待审批' : '等待回答';
  if (session.state === 'failed') return '失败';
  return '';
}

/** The newest day (`index` 0) starts open and the older days folded; a day the user toggled keeps the user's choice. */
export function dayOpen(day: { day: string }, index: number, toggled: Readonly<Record<string, boolean>>): boolean {
  return toggled[day.day] ?? index === 0;
}

/** The sessions a matter's conversation, or my dsh, dispatched: those its tools put in the matter. */
export function dispatchedSessions(matters: readonly BoardMatter[]): Set<string> {
  return new Set(matters.flatMap(matter => matter.sessions.filter(session => session.by === 'mydsh').map(session => session.id)));
}

/** One row of 待处理. */
export interface WaitingRow {
  id: string;
  title: string;
  state: SessionState;
  matter?: { id: string; name: string };
  /** When it began to need the user: when it asked, else its last activity. */
  at: number;
  line: string;
}

/** 待处理, in the order the Host gives: the longest wait first. */
export function waitingRows(sessions: readonly ReviewSession[], now: number): WaitingRow[] {
  return sessions.map(session => ({
    id: session.id, title: session.title, state: session.state, ...(session.matter ? { matter: session.matter } : {}),
    at: waitingSince(session), line: lineOf(session, now),
  }));
}

/** One row of 跟进事项. `state` is its newest session's; a matter without sessions has none. */
export interface FollowRow {
  id: string;
  name: string;
  lastActivity: number;
  state?: SessionState;
  line: string;
}

/** 跟进事项: the matters in progress, in the board's order, each with a line about its newest session: `<title> · <its line>`. */
export function followRows(matters: readonly BoardMatter[], now: number): FollowRow[] {
  return matters.filter(matter => !matter.archivedAt).map((matter) => {
    const newest = matter.sessions[0];
    if (!newest) return { id: matter.id, name: matter.name, lastActivity: matter.lastActivity, line: '还没有会话' };
    const line = lineOf(newest, now);
    return { id: matter.id, name: matter.name, lastActivity: matter.lastActivity, state: newest.state, line: line ? `${newest.title} · ${line}` : newest.title };
  });
}

/** Idle rows a matter's page shows before 更早 is opened. */
export const IDLE_SHOWN = 5;

/** A card of a matter's work in progress; `conversation` marks the matter's own conversation, which opens with the matter's tab beside it. */
export interface ProgressCard {
  session: BoardSession;
  conversation?: true;
}

const CARD_RANK: Record<SessionState, number> = { waiting: 0, failed: 1, running: 2, idle: 3 };

/**
 * A matter's session area. Cards: its live sessions that wait, failed or run, and its conversation while that waits or failed; waiting
 * first, then failed, then running; those that need the user the longest wait first, the running ones the newest activity first. Idle
 * rows: its other live sessions, the newest activity first. Archived sessions are left out.
 * @param conversation - the matter's conversation as 等你处理 lists it, when it is there.
 */
export function sessionArea(sessions: readonly BoardSession[], conversation?: BoardSession): { cards: ProgressCard[]; idle: BoardSession[] } {
  const live = sessions.filter(session => !session.archived);
  const cards: ProgressCard[] = live.filter(session => session.state !== 'idle').map(session => ({ session }));
  if (conversation && (conversation.state === 'waiting' || conversation.state === 'failed')) cards.push({ session: conversation, conversation: true });
  const order = (a: BoardSession, b: BoardSession) => CARD_RANK[a.state] - CARD_RANK[b.state]
    || (a.state === 'running' ? b.lastActivity - a.lastActivity : waitingSince(a) - waitingSince(b))
    || a.id.localeCompare(b.id);
  cards.sort((a, b) => order(a.session, b.session));
  const idle = live.filter(session => session.state === 'idle').sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
  return { cards, idle };
}

/** The idle rows to show: the first {@link IDLE_SHOWN} while 更早 is closed, all once it is open; and how many are past the first. */
export function foldIdle<T>(idle: readonly T[], open: boolean): { rows: T[]; rest: number } {
  return { rows: open ? [...idle] : idle.slice(0, IDLE_SHOWN), rest: Math.max(0, idle.length - IDLE_SHOWN) };
}

/** A matter's sessions by the column that holds them: a failed session sits with the idle ones. */
export function columnCounts(sessions: readonly BoardSession[]): { waiting: number; running: number; idle: number } {
  const counts = { waiting: 0, running: 0, idle: 0 };
  for (const session of sessions) counts[session.state === 'failed' ? 'idle' : session.state] += 1;
  return counts;
}

/**
 * What a pass to a matter shows of the matter's conversation since the words went (`at`, epoch ms): its reply once a turn ended after
 * them (`text` whole when the Host has it, `line` its start), what it waits for or failed on, that it is answering, or that it has not
 * started. `asking` is the conversation as 等你处理 lists it, which says what it waits for.
 */
export type ForwardState =
  | { kind: 'reply'; text: string; line: string; at: number }
  | { kind: 'running' }
  | { kind: 'waiting' | 'failed'; line: string }
  | { kind: 'queued' };

export function forwardState(conversation: ConversationView | undefined, asking: BoardSession | undefined, at: number, now: number): ForwardState {
  if (!conversation) return { kind: 'queued' };
  if (conversation.state === 'waiting' || conversation.state === 'failed') {
    const line = asking ? lineOf(asking, now) : '';
    const fallback = conversation.state === 'failed' ? '失败' : conversation.wait === 'approval' ? '等待审批' : '等待回答';
    return { kind: conversation.state, line: line || fallback };
  }
  if (conversation.running || conversation.state === 'running') return { kind: 'running' };
  if (conversation.reply !== undefined && conversation.replyAt !== undefined && conversation.replyAt >= at) {
    return { kind: 'reply', text: conversation.reply, line: conversation.line ?? conversation.reply, at: conversation.replyAt };
  }
  if (conversation.line && conversation.lineAt !== undefined && conversation.lineAt >= at) {
    return { kind: 'reply', text: conversation.line, line: conversation.line, at: conversation.lineAt };
  }
  return { kind: 'queued' };
}

/** One part of the sentence under my dsh's name: `before`, the number in bold, `after`; `title` gives the exact figure or what it counts. */
export interface HomeStat {
  key: 'days' | 'sessions' | 'tokens' | 'plugins';
  before: string;
  value: string;
  after: string;
  title?: string;
}

const DAY_MS = 86_400_000;
const localMidnight = (ms: number) => { const date = new Date(ms); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };

/** Calendar days from the day of `since` to the day of `now`, both counted: 1 on the first day. */
export function daysUsed(since: number, now: number): number {
  return Math.max(1, Math.round((localMidnight(now) - localMidnight(since)) / DAY_MS) + 1);
}

/** A token count the way Chinese writes large numbers: up to 9,999 as is, then 万 and 亿 with one or two decimals. */
export function tokenText(tokens: number): string {
  const trim = (text: string) => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);
  if (tokens < 10_000) return tokens.toLocaleString('en-US');
  // A count that rounds to 10000 万 reads as 亿.
  const wan = (tokens / 10_000).toFixed(1);
  if (Number(wan) < 10_000) return `${trim(wan)} 万`;
  return `${trim((tokens / 100_000_000).toFixed(2))} 亿`;
}

/**
 * The sentence under my dsh's name, 你已使用 dsh N 天，开启 N 个 session，用过 N token，安装 N 个插件: how long DSH has been in use, its
 * sessions, their tokens, and the installed plugins. A number the Host could not read is left out. The tokens are those of the
 * sessions with a usage record; the title says how many sessions have none.
 */
export function homeStats(snapshot: BoardSnapshot, now: number): HomeStat[] {
  const usage = snapshot.usage ?? {};
  const stats: HomeStat[] = [];
  if (usage.firstSessionAt !== undefined) {
    const first = new Date(usage.firstSessionAt);
    stats.push({
      key: 'days', before: '你已使用 dsh', value: String(daysUsed(usage.firstSessionAt, now)), after: '天',
      title: `第一个会话在 ${first.getFullYear()}年${first.getMonth() + 1}月${first.getDate()}日`,
    });
  }
  if (usage.sessions !== undefined) stats.push({ key: 'sessions', before: '开启', value: String(usage.sessions), after: '个 session', title: '不含子智能体和没说过话的会话' });
  if (usage.tokens !== undefined && usage.tokenSessions) {
    const exact = usage.tokens.toLocaleString('en-US');
    const missing = usage.sessions !== undefined ? usage.sessions - usage.tokenSessions : 0;
    // The number alone is set large; 万 or 亿 goes with the words after it.
    const [count = '', unit] = tokenText(usage.tokens).split(' ');
    stats.push({
      key: 'tokens', before: '用过', value: count, after: unit ? `${unit} token` : 'token',
      title: missing > 0
        ? `${usage.tokenSessions} 个会话有用量记录，共 ${exact} token；另有 ${missing} 个会话（旧格式或分叉出来的）没有算进来`
        : `所有会话共 ${exact} token，不含子智能体`,
    });
  }
  if (usage.plugins !== undefined) stats.push({ key: 'plugins', before: '安装', value: String(usage.plugins), after: '个插件', title: '插件页“已安装插件”里的插件' });
  return stats;
}

/** The numbers under a matter's name: its sessions, archived ones left out, and the entries in its memory. */
export function matterCounts(matter: BoardMatter): { sessions: number; memory: number } {
  return { sessions: matter.sessions.filter(session => !session.archived).length, memory: matter.memory?.rows.length ?? 0 };
}

/** One row of the card under my dsh's input: a session that needs the user, or after those a suggestion of automatic grouping. */
export type HomeCardRow = WaitingCardRow | SuggestionCardRow;

/** A session that needs the user. */
export interface WaitingCardRow {
  kind: 'waiting';
  id: string;
  /** What it needs: 等待审批, 等待回答 or 失败. */
  word: string;
  /** Whether it failed, which the word's colour says. */
  failed: boolean;
  title: string;
  matter?: { id: string; name: string };
}

/** A suggestion of automatic grouping: `text` says what it makes, `note` how many sessions a new matter gets, in grey. */
export interface SuggestionCardRow {
  kind: 'suggestion';
  id: string;
  text: string;
  note?: string;
  suggestion: SuggestionView;
}

/** Rows the card shows before 还有 N 条. */
export const HOME_CARD_SHOWN = 3;

/** What a suggestion's row says: 建事项「name」 with N 个会话, or 「session title」归进 matter name. */
export function suggestionRow(suggestion: SuggestionView): SuggestionCardRow {
  const head = { kind: 'suggestion' as const, id: suggestion.id, suggestion };
  if (suggestion.kind === 'new') return { ...head, text: `建事项「${suggestion.name ?? ''}」`, note: `${suggestion.sessions.length} 个会话` };
  return { ...head, text: `「${suggestion.sessions[0]?.title ?? ''}」归进 ${suggestion.matter?.name ?? ''}` };
}

/** A suggestion's proposal heading: 建事项「name」, or 「session title」归进「matter name」. */
export function suggestionTitle(suggestion: SuggestionView): string {
  return suggestion.kind === 'new' ? `建事项「${suggestion.name ?? ''}」` : `「${suggestion.sessions[0]?.title ?? ''}」归进「${suggestion.matter?.name ?? ''}」`;
}

/**
 * The card's rows: what waits for an approval or an answer first, then what failed, each in the order 待处理 has them; then the
 * suggestions in the Host's order.
 */
export function homeCardRows(attention: readonly ReviewSession[], suggestions: readonly SuggestionView[] = []): HomeCardRow[] {
  const row = (session: ReviewSession): WaitingCardRow => ({
    kind: 'waiting', id: session.id, failed: session.state === 'failed',
    word: session.state === 'failed' ? '失败' : session.wait === 'approval' ? '等待审批' : '等待回答',
    title: session.title, ...(session.matter ? { matter: session.matter } : {}),
  });
  return [
    ...attention.filter(session => session.state !== 'failed').map(row),
    ...attention.filter(session => session.state === 'failed').map(row),
    ...suggestions.map(suggestionRow),
  ];
}

/** The rows the card shows, and those 还有 N 条 folds into its menu. */
export function foldHomeCard<T>(rows: readonly T[]): { shown: T[]; rest: T[] } {
  return { shown: rows.slice(0, HOME_CARD_SHOWN), rest: rows.slice(HOME_CARD_SHOWN) };
}

/** The rows of a matter's context: the first line of its instructions ('' when it has none) and how many sources, memory entries and written files it has. */
export interface ContextSummary {
  instructions: string;
  sources: number;
  memory: number;
  /** When the memory was last merged, or that it is being merged now. */
  merged: { at: number } | { now: true } | undefined;
  /** Files the matter's sessions wrote, a new folder counted by its files. */
  files: number;
}

export function contextSummary(matter: BoardMatter): ContextSummary {
  const memory = matter.memory;
  return {
    instructions: matter.instructions?.split('\n').map(line => line.trim()).find(Boolean) ?? '',
    sources: matter.sources.length,
    memory: memory?.rows.length ?? 0,
    merged: memory?.merging ? { now: true } : memory?.mergedAt ? { at: Date.parse(memory.mergedAt) } : undefined,
    files: (matter.artifacts ?? []).reduce((sum, row) => sum + (row.folder ? row.files : 1), 0),
  };
}
