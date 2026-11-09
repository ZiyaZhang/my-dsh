/**
 * Reading sessions for my dsh: the latest replies of a session for `session_recent`, and which turn my dsh's session is in and whether a
 * person's prompt opened it. Pure; the Host feeds them history records and `session/event`s.
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

/** The turn a session is in, and whether a person's prompt is part of it. */
export interface TurnState {
  turn: number;
  byUser: boolean;
}

/**
 * Fold one session event. `turn/start` opens a turn; a `user/message` whose source is a person marks it; any other event that names a
 * turn this state has not seen (the plugin started mid-turn) opens that turn as not started by a person.
 */
export function trackTurn(state: TurnState | undefined, event: { type: string; data: unknown }): TurnState | undefined {
  const turn = isRecord(event.data) && typeof event.data.turn === 'number' ? event.data.turn : undefined;
  if (event.type === 'turn/start' && turn !== undefined) return { turn, byUser: false };
  if (event.type === 'user/message') {
    const source = isRecord(event.data) ? event.data.source : undefined;
    return state && !state.byUser && isRecord(source) && source.kind === 'user' ? { ...state, byUser: true } : state;
  }
  if (turn !== undefined && turn !== state?.turn) return { turn, byUser: false };
  return state;
}
