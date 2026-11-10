/**
 * The line under a session's title: what it is doing, what it waits for, why it failed, or how its last reply starts. The Host folds the
 * parts from session events and the turn outline; the page writes the line, so the minutes of a running step stay current between
 * snapshots. Pure and free of Host imports: the client bundle uses it too.
 */

/** What the line is about. Times are epoch ms on the Host. */
export type Preview =
  /** `step`: the tool call in flight, else the model's part of the turn; absent until the plugin sees an event of the turn. */
  | { kind: 'running'; step?: string; since?: number }
  /** The first question of a pending `ask_user_question` call, and when it was asked. */
  | { kind: 'question'; text: string; since: number }
  /** The tool a pending approval is about, and when it was asked. */
  | { kind: 'approval'; tool: string; since: number }
  /** The error that ended the last turn. */
  | { kind: 'failed'; error: string }
  /** How the last reply starts. */
  | { kind: 'reply'; text: string };

/** Characters a line keeps; DSH's turn outline bounds its reply preview the same way. */
export const LINE_MAX = 120;

/** What DSH's chat says while the model works and no tool runs (正在分析请求). */
export const THINKING = '分析请求';

/** Arguments longer than this are not read for a detail; the verb and the tool name stand in. */
const ARGUMENTS_MAX = 1_000_000;

/**
 * Whitespace collapsed to single spaces, trimmed, and cut to `max` characters with an ellipsis. Only the start of a long text is read,
 * so a reply of megabytes costs no more than a short one.
 */
export function clip(text: string, max = LINE_MAX): string {
  const head = text.length > max * 4 ? text.slice(0, max * 4) : text;
  const normalized = head.replace(/\s+/g, ' ').trim();
  const characters = [...normalized];
  if (characters.length > max) return `${characters.slice(0, max - 1).join('').trimEnd()}…`;
  return head === text || normalized === '' ? normalized : `${normalized}…`;
}

/** The verb DSH's chat shows for a running tool, without 正在 (ui-chat `stepProcess`, by the same tool-name rules). */
export function toolVerb(name: string): string {
  if (name === 'read') return '读取文件';
  if (name === 'read_image') return '读取图片';
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return '搜索代码';
  if (name === 'write') return '写入文件';
  if (name === 'edit' || name === 'apply_patch') return '编辑文件';
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(name) || name.startsWith('terminal_')) return '运行命令';
  if (name === 'run_code') return '运行代码';
  if (name === 'web_search') return '搜索网页';
  if (name === 'web_fetch') return '访问网页';
  if (name === 'subagent' || name.startsWith('subagent_')) return '协调子智能体';
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(name)) return '更新计划';
  return '调用工具';
}

/** The argument keys DSH's chat reads, in its order, for what a running tool works on. */
const DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt', 'message',
  'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(args: string): Record<string, unknown> | undefined {
  if (args.length > ARGUMENTS_MAX) return undefined;
  try {
    const value: unknown = JSON.parse(args);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The first question's text in a `questions` list. */
function firstQuestion(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    const text = isRecord(item) && typeof item.question === 'string' ? clip(item.question) : '';
    if (text) return text;
  }
  return '';
}

function detailOf(value: unknown): string {
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) return clip(value.join(', '));
  return '';
}

/** A tool call in flight: its verb and what it works on, as DSH's chat picks it from the arguments, else the tool's name. */
export function toolStep(name: string, args: string): string {
  const parsed = parse(args);
  let detail = '';
  for (const key of DETAIL_KEYS) {
    if (!parsed || !(key in parsed)) continue;
    detail = key === 'questions' ? firstQuestion(parsed[key]) : detailOf(parsed[key]);
    if (detail) break;
  }
  return `${toolVerb(name)} ${detail || name}`;
}

/** What an `ask_user_question` call asks: its first question, or '' when the arguments say none. */
export function questionText(args: string): string {
  return firstQuestion(parse(args)?.questions);
}

/** Whole minutes since a moment; under one minute 刚刚, like DSH's relative times. */
function elapsed(ms: number): string {
  return ms < 60_000 ? '刚刚' : `${Math.floor(ms / 60_000)} 分钟`;
}

/** The line itself; '' when there is nothing to say. */
export function previewLine(preview: Preview | undefined, now: number): string {
  if (!preview) return '';
  switch (preview.kind) {
    case 'running': {
      const head = preview.step ? `正在：${preview.step}` : '正在运行';
      return preview.since === undefined ? head : `${head} · ${elapsed(now - preview.since)}`;
    }
    case 'question': return preview.text ? `在等你回答：${preview.text}` : '在等你回答';
    case 'approval': return preview.tool ? `在等你批准：${preview.tool}` : '在等你批准';
    case 'failed': return preview.error ? `失败：${preview.error}` : '失败';
    case 'reply': return preview.text;
  }
}
