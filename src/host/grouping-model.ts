/**
 * The model step of automatic grouping: the loose sessions no origin rule placed, with the matters in progress, go to the user's default
 * model in one call per chunk. The answer is read as one JSON object and checked: ids only from the input, each session in at most one
 * suggestion, a new matter of two or more sessions with a name and a goal as a matter takes them and a name no matter in progress has,
 * and a why of one short sentence. A suggestion that fails a check is dropped. Pure.
 */
import type { Made } from './grouping.js';
import { clip } from './preview.js';
import { matterGoal, matterName } from './remote.js';

/** Sessions one call reads, and one run sends in all; the rest wait for a later run. */
export const MODEL_CHUNK = 30;
export const MODEL_SESSIONS_MAX = 60;
/** Matters in progress a call lists, the newest first. */
export const MODEL_MATTERS_MAX = 40;
/** The longest why, in characters. */
export const WHY_MAX = 80;
/** How much of the first prompt and the last reply DSH's turn outline keeps. */
const PROMPT_CHARS = 50;
const REPLY_CHARS = 120;

/** A loose session as the model reads it; fields with nothing to say are left out. */
export interface ModelSession {
  id: string;
  title: string;
  firstPrompt?: string;
  lastReply?: string;
  /** The name of its working directory. */
  folder?: string;
  branch?: string;
  prs?: string[];
  /** What started its first turn. */
  trigger?: string;
  /** Titles of the scheduled tasks that delivered into it. */
  schedules?: string[];
}

export interface ModelMatter {
  id: string;
  name: string;
  goal: string;
}

export interface GroupingInput {
  matters: readonly ModelMatter[];
  sessions: readonly ModelSession[];
}

const TRIGGERS: Readonly<Record<string, string>> = { user: '用户', schedule: '定时任务', 'my-dsh': 'my dsh' };

/** What started a session's first turn, in the words the model reads: a person, a scheduled task, my dsh, or a plugin by its kind. */
export function triggerLabel(kind: string | undefined): string | undefined {
  return kind === undefined ? undefined : TRIGGERS[kind] ?? kind;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first prompt and the last reply in a session's cached turn outline: the first turn a person prompted, the newest turn that replied. */
export function outlineEnds(outline: unknown): { firstPrompt?: string; lastReply?: string } {
  if (!Array.isArray(outline)) return {};
  const text = (entry: unknown, key: string) => (isRecord(entry) && typeof entry[key] === 'string' ? entry[key] : '');
  const prompt = outline.map(entry => text(entry, 'prompt')).find(Boolean);
  const reply = [...outline].reverse().map(entry => text(entry, 'response')).find(Boolean);
  return { ...(prompt ? { firstPrompt: clip(prompt, PROMPT_CHARS) } : {}), ...(reply ? { lastReply: clip(reply, REPLY_CHARS) } : {}) };
}

export const GROUPING_SYSTEM = [
  '你在给不在任何事项里的会话归类。事项是用户手上的一件事；为同一件事工作的几条会话属于同一个事项，归好以后用户在事项里一起看它们。',
  '下面是进行中的事项，和最近 14 天里不在事项里的会话，都是每行一个 JSON。事项有 id、name（名字）、goal（目标，可能没有）。会话有 id、title（标题），能拿到的还有 firstPrompt（第一句提问，最多 50 个字）、lastReply（最后一句回复，最多 120 个字）、folder（工作目录名）、branch（分支）、prs（处理过的 PR）、trigger（第一轮由什么开始：用户、定时任务、my dsh 或别的插件）、schedules（给它送消息的定时任务）。提问和回复可能被截断。',
  '建议有两种。file：一条会话归进一件进行中的事项，只在会话做的事明显属于这件事项时给。new：两条或更多在做同一件事的会话建成一件新事项。',
  '只根据给的材料判断。同一个工作目录只是参考，不能单独作为依据。拿不准的会话不放进任何建议；一条建议都不给也可以。',
  'id 只用材料里的；一条会话最多出现在一条建议里。name 最多 40 个字，不和进行中的事项重名；goal 一句话，最多 120 个字，可以为空。why 写判断的依据，一句话，最多 60 个字，不写 id。',
  '只输出一个 JSON 对象，不要别的文字：{"suggestions":[{"kind":"file","sessionId":"…","matterId":"…","why":"…"},{"kind":"new","sessionIds":["…","…"],"name":"…","goal":"…","why":"…"}]}。没有建议时输出 {"suggestions":[]}。',
].join('\n');

/** One JSON line per matter and per session, fields with nothing to say left out. */
export function groupingPrompt(input: GroupingInput): string {
  const matters = input.matters.map(matter => JSON.stringify({ id: matter.id, name: matter.name, ...(matter.goal ? { goal: matter.goal } : {}) }));
  const sessions = input.sessions.map(session => JSON.stringify(Object.fromEntries(Object.entries(session)
    .filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)))));
  return ['进行中的事项：', ...(matters.length ? matters : ['（没有）']), '', '不在事项里的会话，最近用过的在前：', ...sessions].join('\n');
}

/** The JSON object in an answer: from its first `{` to its last `}`, so a code fence around it does not matter. */
function answerObject(answer: string): Record<string, unknown> | undefined {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    const parsed: unknown = JSON.parse(answer.slice(start, end + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A why as the card shows it: one line of one sentence, its full stop taken off, at most {@link WHY_MAX} characters, without ids. */
export function whyText(raw: unknown, ids: readonly string[] = []): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().replace(/[。.！!]+$/u, '').trim();
  if (!text || /\p{Cc}/u.test(text) || [...text].length > WHY_MAX || /[。！？!?]/u.test(text)) return undefined;
  if (ids.some(id => text.includes(id))) return undefined;
  return text;
}

/** A field as a matter takes it, or undefined when the check refuses it. */
function checked(check: (raw: string) => string, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    return check(raw);
  } catch {
    return undefined;
  }
}

/**
 * Read and check the model's answer for one call.
 * @returns the suggestions that passed, in the answer's order; undefined when the answer holds no JSON object with a `suggestions` list.
 */
export function readGrouping(answer: string, input: GroupingInput): Made[] | undefined {
  const parsed = answerObject(answer);
  if (!parsed || !Array.isArray(parsed.suggestions)) return undefined;
  const sessions = new Set(input.sessions.map(session => session.id));
  const matters = new Set(input.matters.map(matter => matter.id));
  const names = new Set(input.matters.map(matter => matter.name.toLowerCase()));
  const ids = [...sessions, ...matters];
  const used = new Set<string>();
  const made: Made[] = [];
  for (const item of parsed.suggestions) {
    if (!isRecord(item)) continue;
    const why = whyText(item.why, ids);
    if (!why) continue;
    if (item.kind === 'file') {
      const { sessionId, matterId } = item;
      if (typeof sessionId !== 'string' || !sessions.has(sessionId) || used.has(sessionId)) continue;
      if (typeof matterId !== 'string' || !matters.has(matterId)) continue;
      used.add(sessionId);
      made.push({ change: { kind: 'file', sessionId, matterId }, why, by: 'model' });
    } else if (item.kind === 'new') {
      if (!Array.isArray(item.sessionIds) || !item.sessionIds.every(id => typeof id === 'string')) continue;
      const members = [...new Set(item.sessionIds as string[])];
      if (members.length < 2 || members.some(id => !sessions.has(id) || used.has(id))) continue;
      const name = checked(matterName, item.name);
      const goal = item.goal === undefined || item.goal === null ? '' : checked(matterGoal, item.goal);
      if (name === undefined || goal === undefined || names.has(name.toLowerCase())) continue;
      for (const id of members) used.add(id);
      made.push({ change: { kind: 'new', sessionIds: members, name, goal }, why, by: 'model' });
    }
  }
  return made;
}

/** The list in chunks of `size`. */
export function chunked<T>(list: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
  return chunks;
}
