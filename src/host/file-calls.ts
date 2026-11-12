/**
 * The files a session's `write`, `edit` and `apply_patch` calls (DSH's `dsh-tool-fs`) touch, read from the call and its result: the
 * paths a call targets before it runs, and what a successful call changed. `write` and `edit` results carry the canonical absolute
 * path in their `meta` (`write` also whether it created the file); `apply_patch` takes patch text in its `input` argument
 * (`*** Add File:`, `*** Update File:` with an optional `*** Move to:`, `*** Delete File:`, paths relative to the session's working
 * directory), and its result lists the completed operations as `A path`, `M path` and `D path` lines. Pure.
 */
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/** DSH's file tools that change files. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'apply_patch']);

export interface FileChange {
  /** Absolute when the call or its session's directory said where; else as the call wrote it. */
  path: string;
  kind: 'created' | 'modified' | 'deleted';
}

/** What a `tool/result` event says, cut down to what is read here. */
export interface CallResult {
  isError?: boolean;
  /** The text blocks of the result, joined. */
  text?: string;
  meta?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function argumentsOf(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The relative path of a file inside a folder, with `/`; undefined for the folder itself and anything outside it. */
export function within(folder: string, path: string): string | undefined {
  const rest = relative(folder, path);
  if (rest === '' || rest.startsWith('..') || isAbsolute(rest)) return undefined;
  return rest.split(sep).join('/');
}

/** A path made absolute against the session's working directory, when it is relative and that directory is known. */
export function resolvePath(path: string, cwd: string | undefined): string {
  const trimmed = path.trim();
  if (isAbsolute(trimmed)) return normalize(trimmed);
  return cwd ? join(cwd, trimmed) : trimmed;
}

/** The operations of an `apply_patch` text, in order. */
export function patchOperations(input: string): { kind: 'add' | 'update' | 'delete'; path: string; to?: string }[] {
  const operations: { kind: 'add' | 'update' | 'delete'; path: string; to?: string }[] = [];
  for (const line of input.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      operations.push({ kind: header[1] === 'Add' ? 'add' : header[1] === 'Update' ? 'update' : 'delete', path: header[2]! });
      continue;
    }
    const move = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    const last = operations.at(-1);
    if (move && last?.kind === 'update') last.to = move[1]!;
  }
  return operations;
}

/**
 * The completed operations a patch result lists: every `A`, `M` and `D` line after `Success. Updated the following files:`, or under
 * `Completed:` when the patch stopped part way.
 * @returns them, or undefined when the text is not such a result.
 */
export function patchCompleted(text: string): FileChange[] | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('Success. Updated the following files:') || line.trim() === 'Completed:');
  if (start < 0) return text.startsWith('Success. No operations') ? [] : undefined;
  const changes: FileChange[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^([AMD]) (.+)$/.exec(line);
    if (!match) break;
    changes.push({ path: match[2]!, kind: match[1] === 'A' ? 'created' : match[1] === 'D' ? 'deleted' : 'modified' });
  }
  return changes;
}

/** The paths a file tool call targets, absolute where its session's directory says; none for other tools. */
export function callTargets(name: string, args: string, cwd: string | undefined): string[] {
  if (!FILE_TOOLS.has(name)) return [];
  const parsed = argumentsOf(args);
  if (name === 'apply_patch') {
    const input = typeof parsed.input === 'string' ? parsed.input : '';
    return patchOperations(input).flatMap(operation => [operation.path, ...(operation.to ? [operation.to] : [])]).map(path => resolvePath(path, cwd));
  }
  return typeof parsed.file_path === 'string' && parsed.file_path.trim() ? [resolvePath(parsed.file_path, cwd)] : [];
}

/**
 * What a file tool call changed: nothing when it failed (a refused approval fails it too). `write` and `edit` read the canonical path
 * from the result's meta, else the argument; `apply_patch` reads the completed operations from the result, else the patch.
 */
export function callChanges(name: string, args: string, result: CallResult, cwd: string | undefined): FileChange[] {
  if (!FILE_TOOLS.has(name) || result.isError) return [];
  const meta = isRecord(result.meta) ? result.meta : {};
  if (name === 'apply_patch') {
    const completed = patchCompleted(result.text ?? '');
    if (completed) return completed.map(change => ({ ...change, path: resolvePath(change.path, cwd) }));
    const input = argumentsOf(args).input;
    return patchOperations(typeof input === 'string' ? input : '').map((operation): FileChange => {
      if (operation.kind === 'add') return { path: resolvePath(operation.path, cwd), kind: 'created' };
      if (operation.kind === 'delete') return { path: resolvePath(operation.path, cwd), kind: 'deleted' };
      return { path: resolvePath(operation.to ?? operation.path, cwd), kind: 'modified' };
    });
  }
  const path = typeof meta.path === 'string' && meta.path ? meta.path : callTargets(name, args, cwd)[0];
  if (!path) return [];
  return [{ path: resolvePath(path, cwd), kind: name === 'write' && meta.operation === 'create' ? 'created' : 'modified' }];
}

/** The text blocks of a tool result message, joined. */
export function resultText(message: unknown): string {
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  return content.flatMap(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
}
