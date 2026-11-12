/**
 * Reading sessions for my dsh: the latest replies of a session for `session_recent`, and which turn a session is in, whether a person's
 * prompt opened it and what that prompt said. Pure; the Host feeds them history records and `session/event`s.
 */

/** About how much reply text `session_recent` hands back. */
export const RECENT_CHARS = 1_500;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The visible text of an `assistant/message` event: its text blocks, without reasoning or tool calls. */
function replyText(data: unknown): string {
  const message = isRecord(data) ? data.message : undefined;
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  return content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim();
}

/**
 * The newest replies in a page of history records, cut to about {@link RECENT_CHARS} characters.
 * @param records - history records, oldest first, as `sessionController.events` returns them.
 */
export function recentReplies(records: readonly unknown[], max = RECENT_CHARS): { replies: { at: string; text: string }[]; truncated: boolean } {
  const replies: { at: string; text: string }[] = [];
  let room = max;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const event = isRecord(record) && record.type === 'event' && isRecord(record.event) ? record.event : undefined;
    if (event?.type !== 'assistant/message') continue;
    const text = replyText(event.data);
    if (!text) continue;
    if (room <= 0) return { replies, truncated: true };
    const characters = [...text];
    const at = new Date(typeof event.time === 'number' ? event.time : 0).toISOString();
    if (characters.length > room) {
      replies.push({ at, text: `${characters.slice(0, room).join('')}…` });
      return { replies, truncated: true };
    }
    replies.push({ at, text });
    room -= characters.length;
  }
  return { replies, truncated: false };
}

/**
 * What a click on one of my dsh's cards posts into its conversation as the user's message: 是事项「X」, 是会话「X」 or 都不是 on a
 * candidate card, 新起了事项「X」 on an accepted new matter. These answer my dsh; they are not words to pass on.
 */
export const CARD_REPLY = /^(?:是事项「[^」\n]*」|是会话「[^」\n]*」|都不是|新起了事项「[^」\n]*」)$/;

/** How many of the user's latest messages a pass to a matter's conversation may take. */
export const FORWARD_MESSAGES_MAX = 3;

/** How much of the user's words a pass takes, in characters. */
export const FORWARD_CHARS = 8_000;

/**
 * The user's last `count` messages in a page of history, oldest first, as they were written: only messages a person sent, without card
 * replies ({@link CARD_REPLY}) and without messages that have no text, joined by blank lines and cut to `max` characters.
 * @param records - history records, oldest first, as `sessionController.events` returns them.
 * @returns the words, how many messages they came from, and how many attachments those messages had, which are not passed on.
 */
export function userWords(records: readonly unknown[], count: number, max = FORWARD_CHARS): { text: string; messages: number; attachments: number } {
  const picked: { text: string; attachments: number }[] = [];
  for (let index = records.length - 1; index >= 0 && picked.length < count; index -= 1) {
    const record = records[index];
    const event = isRecord(record) && record.type === 'event' && isRecord(record.event) ? record.event : undefined;
    if (event?.type !== 'user/message' || !isRecord(event.data)) continue;
    const { source, content } = event.data;
    if (!isRecord(source) || source.kind !== 'user' || !Array.isArray(content)) continue;
    const text = content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim();
    if (!text || CARD_REPLY.test(text)) continue;
    picked.unshift({ text, attachments: content.filter(block => !isRecord(block) || block.type !== 'text').length });
  }
  const joined = picked.map(message => message.text).join('\n\n');
  const characters = [...joined];
  return {
    text: characters.length > max ? `${characters.slice(0, max).join('')}…` : joined,
    messages: picked.length,
    attachments: picked.reduce((sum, message) => sum + message.attachments, 0),
  };
}

/**
 * Whether the words name things and say nothing else: only the given names (with or without @, longest first, as a matter's name can hold
 * spaces), other @-names, whitespace and punctuation. Such words give a matter's conversation nothing to do, so they are not passed on.
 */
export function onlyNames(text: string, names: readonly string[] = []): boolean {
  let rest = text;
  for (const name of [...names].filter(Boolean).sort((a, b) => b.length - a.length)) rest = rest.split(name).join(' ');
  return rest.replace(/@\S*/gu, '').replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

/** The turn a session is in, whether a person's prompt is part of it, and that prompt's words. */
export interface TurnState {
  turn: number;
  byUser: boolean;
  /** The text of the person's prompt that marked the turn, when it had text. */
  prompt?: string;
}

/**
 * How much of a prompt a turn keeps, in UTF-16 units: more characters than a dispatched task takes along (2,000), so a cut still shows
 * there, and a bound on what each session holds here.
 */
const PROMPT_KEPT = 4_100;

/** The text blocks of a user message, one after another, up to {@link PROMPT_KEPT} without splitting a character. */
function promptOf(message: unknown): string {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  const text = content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim();
  if (text.length <= PROMPT_KEPT) return text;
  const cut = text.slice(0, PROMPT_KEPT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Fold one session event. `turn/start` opens a turn; a `user/message` whose source is a person marks it and keeps its text; any other
 * event that names a turn this state has not seen (the plugin started mid-turn) opens that turn as not started by a person.
 */
export function trackTurn(state: TurnState | undefined, event: { type: string; data: unknown }): TurnState | undefined {
  const turn = isRecord(event.data) && typeof event.data.turn === 'number' ? event.data.turn : undefined;
  if (event.type === 'turn/start' && turn !== undefined) return { turn, byUser: false };
  if (event.type === 'user/message') {
    const source = isRecord(event.data) ? event.data.source : undefined;
    if (!state || state.byUser || !isRecord(source) || source.kind !== 'user') return state;
    const prompt = promptOf(event.data);
    return { ...state, byUser: true, ...(prompt ? { prompt } : {}) };
  }
  if (turn !== undefined && turn !== state?.turn) return { turn, byUser: false };
  return state;
}
