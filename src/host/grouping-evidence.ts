/**
 * What automatic grouping reads from a session's own log, in one pass after a cursor: the PRs it worked on, as `host/owner/repo#n` keys,
 * from its own `gh pr` commands and from PR links in the user's prompts; the sessions the user @-referenced in it; the scheduled tasks
 * that delivered into it; and the kind of message that started its first turn. PR links in other tools' output are not evidence. Pure;
 * the Host keeps each session's evidence with its cursor and reads only what came after it.
 */
import { resultText } from './file-calls.js';
import type { HistoryEvent } from './memory-ops.js';

export interface SessionEvidence {
  /** The last history seq read, or just before a `gh` call still waiting for its result; -1 before any. */
  cursor: number;
  /** `host/owner/repo#n`, each once, in the order found. */
  prs: string[];
  /** PR numbers a `gh pr` command named without its repository, which the session's git remote resolves. */
  numbers: number[];
  /** Sessions the user @-referenced in it. */
  refs: string[];
  /** Scheduled tasks that delivered into it. */
  schedules: string[];
  /** The source kind of the message that started its first turn, once that turn was read. */
  trigger?: string;
  /** Epoch ms of the last read. */
  readAt: number;
}

export const emptyEvidence = (): SessionEvidence => ({ cursor: -1, prs: [], numbers: [], refs: [], schedules: [], readAt: 0 });

/** Entries each list keeps, the first found. */
export const EVIDENCE_LIST_MAX = 20;

/** Message kinds a turn's context brings in before its first message: they do not say what started the turn. */
export const CONTEXT_KINDS: ReadonlySet<string> = new Set([
  'runtime-context', 'time-context', 'skill-catalog', 'user-approval', 'working-directory', 'model-selection', 'workspace-instructions',
  'tool-jobs', 'session-reference',
]);

/** Tools whose calls run a shell command given as the string `command`. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A GitHub-style pull request URL, ending where the number does. */
const PR_URL = /\bhttps?:\/\/[^\s"'<>]+?\/pull\/\d+(?![\w-])/g;
/** gh's own `url:` line, or a URL alone on a line, before the `--` that starts a description. */
const OWN_URL_LINE = /^(?:url:\s+)?(https?:\/\/[^\s"'<>]+?\/pull\/\d+)\/?$/;
/** A JSON `url` member, as `--json url` prints it. */
const OWN_URL_MEMBER = /"url"\s*:\s*"(https?:\/\/[^\s"'<>]+?\/pull\/\d+)\/?"/g;

/** `host/owner/repo#n`, lower-case, without query or fragment, from a PR URL; undefined for anything else. */
export function prKey(url: string): string | undefined {
  const match = /^https?:\/\/([^/\s?#]+)\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}/${match[3]}#${match[4]}`.toLowerCase() : undefined;
}

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** The PRs linked in a text, as keys, each once. */
export function prKeys(text: string): string[] {
  return unique([...text.matchAll(PR_URL)].flatMap(([url]) => { const key = prKey(url); return key ? [key] : []; }));
}

/** The PRs a `gh pr view` or `gh pr edit` result prints for its own change request: its `url:` line, and JSON `url` members. */
export function ownPrKeys(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '--') break;
    const own = OWN_URL_LINE.exec(line.trim())?.[1];
    if (own) urls.push(own);
  }
  for (const [, member] of text.matchAll(OWN_URL_MEMBER)) urls.push(member!);
  return unique(urls.flatMap((url) => { const key = prKey(url); return key ? [key] : []; }));
}

/**
 * A command line as words per simple command: quotes taken off, split at `&&`, `||`, `;`, `|`, `&`, brackets and line ends outside
 * quotes. A redirection such as `2>&1` stays one word.
 */
export function shellWords(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | '\'' | undefined;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === '\\' && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += character;
      continue;
    }
    if (character === '\'' || character === '"') { quote = character; inWord = true; continue; }
    if (character === '\\' && index + 1 < command.length) { word += command[++index]; inWord = true; continue; }
    if (character === ' ' || character === '\t' || character === '\r') { endWord(); continue; }
    if (character === '&' && word.endsWith('>')) { word += character; continue; }
    if ('\n;&|()'.includes(character)) { endCommand(); continue; }
    word += character;
    inWord = true;
  }
  endCommand();
  return commands;
}

/** `gh pr` subcommands that create a PR, whose output prints its URL. */
const CREATE = new Set(['create', 'new']);
/** `gh pr` subcommands that act on one PR, named by a URL or a number. */
const REFERENCE = new Set(['view', 'edit', 'checkout', 'merge', 'comment', 'review', 'diff', 'ready', 'close', 'reopen', 'checks']);
/** Options of those subcommands that take the next word as their value. */
const VALUE_OPTIONS = new Set([
  '--repo', '-R', '--json', '--jq', '-q', '--template', '--body', '-b', '--body-file', '-F', '--title', '--subject', '--author-email', '-A',
  '--match-head-commit', '--branch', '--base', '-B', '--head', '-H', '--color', '--interval', '-i', '--milestone', '--add-assignee',
  '--add-label', '--add-project', '--add-reviewer', '--remove-assignee', '--remove-label', '--remove-project', '--remove-reviewer',
]);

/** What a `gh pr` command line says about PRs: whether it creates or refers to one, and the PRs it names. */
export interface GhEvidence {
  created: boolean;
  referenced: boolean;
  /** PRs the command names by URL, or by number with its repository. */
  keys: string[];
  /** PR numbers it names without a repository. */
  numbers: number[];
}

/** `host/owner/repo` from `--repo`'s value: `owner/repo` (on `host`, else github.com) or `host/owner/repo`, a URL or with `.git`. */
function repoOf(value: string, host: string | undefined): string | undefined {
  const match = /^(?:([a-z\d.-]+(?::\d+)?)\/)?([a-z\d_.-]+)\/([a-z\d_.-]+)$/i.exec(value.replace(/^https?:\/\//i, '').replace(/\.git$/i, '').replace(/\/+$/, ''));
  if (!match || match[3] === '.' || match[3] === '..') return undefined;
  return `${match[1] ?? host ?? 'github.com'}/${match[2]}/${match[3]}`.toLowerCase();
}

/** One simple command, when it runs `gh pr`. */
function ghWords(words: readonly string[]): GhEvidence | undefined {
  const environment = new Map<string, string>();
  let index = words[0] === 'env' ? 1 : 0;
  for (; index < words.length; index += 1) {
    const assignment = /^([A-Za-z_]\w*)=(.*)$/.exec(words[index]!);
    if (!assignment) break;
    environment.set(assignment[1]!, assignment[2]!);
  }
  const program = words[index];
  if (program !== 'gh' && !program?.endsWith('/gh')) return undefined;
  if (words[index + 1] !== 'pr') return undefined;
  const operation = words[index + 2] ?? '';
  if (CREATE.has(operation)) return { created: true, referenced: false, keys: [], numbers: [] };
  if (!REFERENCE.has(operation)) return undefined;
  let repo = environment.get('GH_REPO');
  let selector: string | undefined;
  for (let at = index + 3; at < words.length; at += 1) {
    const arg = words[at]!;
    if (/^\d*(?:>>?|<)/.test(arg)) {
      if (/^\d*(?:>>?|<)$/.test(arg)) at += 1;
      continue;
    }
    if (arg === '--repo' || arg === '-R') { repo = words[at + 1] ?? repo; at += 1; continue; }
    if (arg.startsWith('--repo=')) { repo = arg.slice('--repo='.length); continue; }
    if (arg.startsWith('-R') && arg.length > 2) { repo = arg.slice(2); continue; }
    if (arg.startsWith('-')) {
      if (VALUE_OPTIONS.has(arg)) at += 1;
      continue;
    }
    if (selector === undefined && (prKey(arg) !== undefined || /^[1-9]\d{0,8}$/.test(arg))) selector = arg;
  }
  const evidence: GhEvidence = { created: false, referenced: true, keys: [], numbers: [] };
  if (selector === undefined) return evidence;
  const key = prKey(selector);
  if (key) return { ...evidence, keys: [key] };
  const repository = repo ? repoOf(repo, environment.get('GH_HOST')) : undefined;
  return repository ? { ...evidence, keys: [`${repository}#${selector}`] } : { ...evidence, numbers: [Number(selector)] };
}

/** What a shell command line's `gh pr` commands say about PRs; undefined when it runs none. */
export function ghCommand(command: string): GhEvidence | undefined {
  if (!/\bgh\b/.test(command)) return undefined;
  let found: GhEvidence | undefined;
  for (const words of shellWords(command)) {
    const evidence = ghWords(words);
    if (!evidence) continue;
    found = found
      ? { created: found.created || evidence.created, referenced: found.referenced || evidence.referenced, keys: [...found.keys, ...evidence.keys], numbers: [...found.numbers, ...evidence.numbers] }
      : evidence;
  }
  return found;
}

/**
 * The task ids of a schedule delivery's text: `schedule_id_json` of a `[SCHEDULE REMINDER]`, each `schedule_id` of a
 * `[SCHEDULE REMINDER BATCH]`. A `[SCHEDULE CHANGE]` notice to the sessions involved in a task is not a delivery.
 */
export function scheduleIds(text: string): string[] {
  const head = text.trimStart();
  if (head.startsWith('[SCHEDULE REMINDER BATCH]')) {
    const line = /^reminders_json:\s*(.+)$/m.exec(head)?.[1];
    if (!line) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return Array.isArray(parsed) ? unique(parsed.flatMap(item => (isRecord(item) && typeof item.schedule_id === 'string' ? [item.schedule_id] : []))) : [];
    } catch {
      return [];
    }
  }
  if (!head.startsWith('[SCHEDULE REMINDER]')) return [];
  const line = /^schedule_id_json:\s*(.+)$/m.exec(head)?.[1];
  if (!line) return [];
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'string' && parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

const textOf = (content: unknown): string => (Array.isArray(content)
  ? content.flatMap(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
  : '');

const add = <T>(list: readonly T[], items: readonly T[]): T[] => unique([...list, ...items]).slice(0, EVIDENCE_LIST_MAX);

/**
 * Fold a session's events after its cursor, oldest first, into its evidence. A `gh pr` call counts once its result came back without an
 * error; the cursor stops just before a call still waiting for one, so the next read sees it again.
 */
export function foldEvidence(before: SessionEvidence, events: readonly HistoryEvent[], sessionId: string, readAt: number): SessionEvidence {
  let { prs, numbers, refs, schedules, trigger } = before;
  const calls = new Map<string, { evidence: GhEvidence; seq: number }>();
  let seeking = false;
  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case 'turn/start':
        seeking = trigger === undefined && data.turn === 1;
        break;
      case 'turn/end':
        seeking = false;
        break;
      case 'user/message': {
        const source = isRecord(data.source) ? data.source : {};
        const kind = typeof source.kind === 'string' ? source.kind : undefined;
        if (seeking && kind !== undefined && !CONTEXT_KINDS.has(kind)) { trigger = kind; seeking = false; }
        if (kind === 'user') prs = add(prs, prKeys(textOf(data.content)));
        else if (kind === 'schedule') schedules = add(schedules, scheduleIds(textOf(data.content)));
        else if (kind === 'session-reference' && Array.isArray(source.references)) {
          refs = add(refs, source.references.flatMap(reference => (isRecord(reference) && typeof reference.sessionId === 'string' && reference.sessionId !== sessionId
            ? [reference.sessionId] : [])));
        }
        break;
      }
      case 'tool/call': {
        if (typeof data.callId !== 'string' || typeof data.name !== 'string' || !SHELL_TOOLS.has(data.name) || typeof data.arguments !== 'string') break;
        if (!data.arguments.includes('gh')) break;
        let command: unknown;
        try { command = (JSON.parse(data.arguments) as Record<string, unknown>).command; } catch { break; }
        const evidence = typeof command === 'string' ? ghCommand(command) : undefined;
        if (evidence) calls.set(data.callId, { evidence, seq: event.seq });
        break;
      }
      case 'tool/result': {
        const message = isRecord(data.message) ? data.message : {};
        const call = typeof message.toolCallId === 'string' ? calls.get(message.toolCallId) : undefined;
        if (!call) break;
        calls.delete(message.toolCallId as string);
        if (message.isError === true) break;
        const text = resultText(message);
        const printed = call.evidence.created ? prKeys(text) : ownPrKeys(text);
        prs = add(prs, [...call.evidence.keys, ...printed]);
        // A bare number waits for the session's remote, unless gh printed the PR it acted on.
        if (printed.length === 0) numbers = add(numbers, call.evidence.numbers);
        break;
      }
      default:
        break;
    }
  }
  const last = events.at(-1)?.seq ?? before.cursor;
  const cursor = [...calls.values()].reduce((low, call) => Math.min(low, call.seq - 1), last);
  return { cursor: Math.max(before.cursor, cursor), prs, numbers, refs, schedules, ...(trigger !== undefined ? { trigger } : {}), readAt };
}
