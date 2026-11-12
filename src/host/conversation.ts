/**
 * A matter's own conversation: an ordinary DSH session, running the user's default preset, where the user talks about one matter. The
 * plugin offers it my dsh's coordination tools, scoped to its matter, and each step it reads the rules below, the matter's context, its
 * memory and the matter's live sessions. Pure, so the text and the scope decisions can be tested.
 */
import { matterDetails, type ContextMatter } from './notes.js';
import type { Preview } from './preview.js';
import { RequestError, type LinkSource, type Matter, type SessionState, type WaitKind } from './remote.js';

/** The rules a matter's conversation reads first, each step. */
export function conversationRules(name: string): string {
  return [
    `这条会话是事项「${name}」的对话。用户在这里交代和这件事有关的事。`,
    '- 用户的话里没说要做什么、问什么，先问清楚，不要自己找活干。',
    '- 小事直接做。要跑很久的、互不相干的、要用户批准或要用户盯着的活，用 start_session 开一条会话去做；只在工作区里读写、不需要用户的活，也可以用子任务。',
    '- 派出去以后，用一句话说派给了哪条会话、做什么，不复述任务，不写会话 id。',
    '- 你派出去的会话都停下后，会收到一条“派出去的会话有结果了”。那一轮只汇报，不开新会话，不发消息。',
    '- 用户说了以后都适用的要求或定下的事，用 note_matter 记进这件事的记忆。',
    '- 用户要改记忆里的某个文件（“改记忆「规则/某个文件.md」：……”），照用户的话改那个文件。',
    '- 用户问进度，先看下面的会话列表，不够再用 session_recent。',
    '- 用户的话里要别的事项做的事不归你做，那些事项有各自的对话。',
  ].join('\n');
}

/** DSH's three permission presets as the conversation names them, with what a session under each asks the user first. */
const PRESETS: Record<string, { name: string; asks: string }> = {
  'read-only': { name: '仅可查看', asks: '改任何文件前先问用户' },
  'workspace-write': { name: '工作区内修改', asks: '改工作区以外的文件前先问用户' },
  'danger-full-access': { name: '完全权限', asks: '不问用户' },
};

/** The line a hosted matter's conversation reads: the preset its sessions run under, and that the preset does not stop dispatching. */
export function hostingLine(preset: string): string {
  const known = PRESETS[preset];
  const runs = known ? `按「${known.name}」跑，${known.asks}` : `按权限预设 ${preset} 跑`;
  return `这件事托管了：你开的会话${runs}。预设不妨碍派活，会话要用户批准时自己会问。`;
}

/** One of the matter's sessions as its conversation's list reads it. */
export interface ListedSession {
  id: string;
  title: string;
  state: SessionState;
  wait?: WaitKind;
  preview?: Preview;
  /** How the session joined the matter. */
  by: LinkSource;
}

const RANK: Record<SessionState, number> = { waiting: 0, running: 1, failed: 2, idle: 3 };
const WAIT: Record<WaitKind, string> = { question: '在等你回答', approval: '在等你批准' };

/** The state with what the session waits for, runs, failed on or last replied; no times, so the text stays the same between steps. */
function stateText(session: ListedSession): string {
  const { preview } = session;
  switch (session.state) {
    case 'waiting': {
      const head = session.wait ? WAIT[session.wait] : '在等你';
      const detail = preview?.kind === 'question' ? preview.text : preview?.kind === 'approval' ? preview.tool : '';
      return detail ? `${head}：${detail}` : head;
    }
    case 'running': return preview?.kind === 'running' && preview.step ? `在跑：${preview.step}` : '在跑';
    case 'failed': return preview?.kind === 'failed' && preview.error ? `上一轮失败：${preview.error}` : '上一轮失败';
    case 'idle': return preview?.kind === 'reply' && preview.text ? `空闲，最后的回复：${preview.text}` : '空闲';
  }
}

/** One line of the list: title, state, `派出去的` when my dsh's tools opened it, and its id. */
export function listedLine(session: ListedSession): string {
  return `- ${[session.title, stateText(session), ...(session.by === 'mydsh' ? ['派出去的'] : []), `id=${session.id}`].join(' · ')}`;
}

/** The list under its heading, most urgent first, then in the order the sessions joined the matter. */
export function sessionList(sessions: readonly ListedSession[]): string {
  if (sessions.length === 0) return '这件事里还没有会话。';
  const order = new Map(sessions.map((session, index) => [session.id, index]));
  const sorted = [...sessions].sort((a, b) => RANK[a.state] - RANK[b.state] || order.get(a.id)! - order.get(b.id)!);
  return ['这件事里的会话（最急的在前）：', ...sorted.map(listedLine)].join('\n');
}

/**
 * What a matter's conversation reads each step: the rules, the matter's goal, instructions and sources, the hosting line while it is
 * hosted, the matter's memory block, then its live sessions.
 * @param sessions - the matter's live sessions, in the order they joined.
 * @param hosting - the preset of a hosted matter.
 * @param memory - the memory block, the same for the whole turn.
 */
export function conversationContext(matter: ContextMatter, sessions: readonly ListedSession[], hosting?: string, memory?: string): string {
  const details = [...matterDetails(matter), ...(hosting ? [hostingLine(hosting)] : [])];
  return [conversationRules(matter.name), ...(details.length ? [details.join('\n')] : []), ...(memory ? [memory] : []), sessionList(sessions)].join('\n\n');
}

/** How much of the user's prompt goes with a task or message, in characters. */
export const USER_WORDS_MAX = 2_000;

/**
 * What a dispatched task or message says: the text as the model wrote it, then the user's own words of the turn under 用户原话, then the
 * closing line when there is one.
 */
export function sentText(text: string, words: string | undefined, closing?: string): string {
  const characters = words ? [...words] : [];
  const kept = characters.length > USER_WORDS_MAX ? `${characters.slice(0, USER_WORDS_MAX).join('')}…` : words;
  return [text, ...(kept ? [`用户原话：\n${kept}`] : []), ...(closing ? [closing] : [])].join('\n\n');
}

/** Who calls one of my dsh's tools: my dsh's own session, or a matter's conversation with its matter. */
export type Caller = { kind: 'assistant'; sessionId: string } | { kind: 'conversation'; sessionId: string; matter: Matter };

/**
 * The caller a session is: my dsh's own session, or the conversation of a matter in progress.
 * @returns undefined for every other session, which gets none of these tools.
 */
export function callerOf(sessionId: string | undefined, assistantId: string | undefined, matters: readonly Matter[]): Caller | undefined {
  if (!sessionId) return undefined;
  if (sessionId === assistantId) return { kind: 'assistant', sessionId };
  const matter = matters.find(candidate => candidate.conversation === sessionId && !candidate.archivedAt);
  return matter ? { kind: 'conversation', sessionId, matter } : undefined;
}

/**
 * The matter a tool acts on: the one my dsh names, or in a matter's conversation that matter.
 * @throws RequestError when my dsh names none, or a matter's conversation names another matter.
 */
export function matterFor(caller: Caller, matterId: string | undefined): string {
  const named = matterId?.trim() || undefined;
  if (caller.kind === 'conversation') {
    if (named !== undefined && named !== caller.matter.id) throw new RequestError(`这条对话只管事项「${caller.matter.name}」，别的事项要在首页的 my dsh 里做`);
    return caller.matter.id;
  }
  if (named === undefined) throw new RequestError('缺少 matterId');
  return named;
}

/**
 * Check that a tool may read or write a session: my dsh may reach any; a matter's conversation only the matter's sessions.
 * @throws RequestError for a session outside the conversation's matter.
 */
export function checkReach(caller: Caller, sessionId: string): void {
  if (caller.kind === 'conversation' && !caller.matter.sessions.some(link => link.sessionId === sessionId)) {
    throw new RequestError(`这条会话不在事项「${caller.matter.name}」里；这里只能读写这件事的会话`);
  }
}
