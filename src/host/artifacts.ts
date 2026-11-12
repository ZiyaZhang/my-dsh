/**
 * 产物: the files a matter's sessions wrote with DSH's file tools, per session, in `artifacts.json` in the plugin's data directory: the
 * path, when, and whether the session created it or changed a file that was there. The Host records successful calls as they end and
 * reads each session's history from its cursor on start and when it joins a matter; files written by shell commands are not seen. The
 * matter's page lists them newest first, with several new files under one new folder as one row.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { FileChange } from './file-calls.js';

export interface ArtifactFile {
  path: string;
  /** Epoch ms of the newest change. */
  at: number;
  /** A file the session created stays created through later changes. */
  kind: 'created' | 'modified';
}

export interface SessionArtifacts {
  /** The last history seq read for this session; -1 before any. */
  cursor: number;
  /** The session's working directory, which folded rows stay inside. */
  cwd?: string;
  files: ArtifactFile[];
}

interface ArtifactsFile { version: 1; sessions: Record<string, SessionArtifacts> }

/** Files kept per session, the newest. */
export const FILES_MAX = 300;

/** A change with the time of the call that made it, epoch ms. */
export type TimedChange = FileChange & { at: number };

/** Fold changes, oldest first, into a session's files: a deleted file goes, a created one stays created, the newest time wins. */
export function recordFiles(files: readonly ArtifactFile[], changes: readonly TimedChange[]): ArtifactFile[] {
  const byPath = new Map(files.map(file => [file.path, { ...file }]));
  for (const change of changes) {
    if (change.kind === 'deleted') { byPath.delete(change.path); continue; }
    const before = byPath.get(change.path);
    byPath.set(change.path, {
      path: change.path, at: Math.max(change.at, before?.at ?? 0), kind: before?.kind === 'created' || change.kind === 'created' ? 'created' : 'modified',
    });
  }
  return [...byPath.values()].sort((a, b) => b.at - a.at || a.path.localeCompare(b.path)).slice(0, FILES_MAX);
}

/** One row of the 产物 panel: a file, or a new folder with how many new files it holds. */
export interface ArtifactRow {
  path: string;
  /** The file's name, or the folder's with a trailing `/`. */
  label: string;
  folder: boolean;
  /** Files the row stands for. */
  files: number;
  /** The session of its newest file. */
  sessionId: string;
  at: number;
}

const inside = (path: string, folder: string) => {
  const rest = relative(folder, path);
  return rest !== '' && !rest.startsWith('..') && !rest.startsWith(sep) && !/^[A-Za-z]:/.test(rest);
};
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * The rows of the 产物 panel, newest first. New files fold into one row under the highest folder that is the folder of some new file,
 * lies inside the session's working directory (or is the file's own folder, for a file outside it), and holds no changed file; a fold
 * of one file stays a file row.
 */
export function artifactRows(sessions: readonly { sessionId: string; cwd?: string; files: readonly ArtifactFile[] }[], max = 20): ArtifactRow[] {
  const latest = new Map<string, { file: ArtifactFile; sessionId: string; cwd?: string }>();
  for (const session of sessions) {
    for (const file of session.files) {
      const seen = latest.get(file.path);
      if (!seen || seen.file.at < file.at) latest.set(file.path, { file, sessionId: session.sessionId, ...(session.cwd ? { cwd: session.cwd } : {}) });
    }
  }
  const all = [...latest.values()];
  const created = all.filter(item => item.file.kind === 'created');
  const parents = new Set(created.map(item => dirname(item.file.path)));
  /** A file's folders from its own up to the root. */
  const ancestors = (path: string): string[] => {
    const folders: string[] = [];
    for (let folder = dirname(path); ; folder = dirname(folder)) {
      folders.push(folder);
      if (dirname(folder) === folder) return folders;
    }
  };
  /** Folders that hold a changed file, which no fold may take. */
  const blocked = new Set(all.filter(item => item.file.kind === 'modified').flatMap(item => ancestors(item.file.path)));
  const foldOf = (item: { file: ArtifactFile; cwd?: string }): string | undefined => {
    const inWorking = item.cwd !== undefined && inside(item.file.path, item.cwd);
    let best: string | undefined;
    for (const folder of ancestors(item.file.path)) {
      if (inWorking ? !inside(folder, item.cwd!) : best !== undefined || folder !== dirname(item.file.path)) break;
      if (parents.has(folder) && !blocked.has(folder)) best = folder;
    }
    return best;
  };
  const groups = new Map<string, typeof created>();
  const rows: ArtifactRow[] = [];
  for (const item of created) {
    const folder = foldOf(item);
    if (folder) groups.set(folder, [...(groups.get(folder) ?? []), item]);
    else rows.push({ path: item.file.path, label: nameOf(item.file.path), folder: false, files: 1, sessionId: item.sessionId, at: item.file.at });
  }
  for (const [folder, items] of groups) {
    const newest = items.reduce((a, b) => (b.file.at > a.file.at ? b : a));
    if (items.length === 1) rows.push({ path: newest.file.path, label: nameOf(newest.file.path), folder: false, files: 1, sessionId: newest.sessionId, at: newest.file.at });
    else rows.push({ path: folder, label: `${nameOf(folder)}/`, folder: true, files: items.length, sessionId: newest.sessionId, at: newest.file.at });
  }
  for (const item of all.filter(entry => entry.file.kind === 'modified')) {
    rows.push({ path: item.file.path, label: nameOf(item.file.path), folder: false, files: 1, sessionId: item.sessionId, at: item.file.at });
  }
  return rows.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path)).slice(0, max);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFile = (value: unknown): value is ArtifactFile => isRecord(value) && typeof value.path === 'string' && typeof value.at === 'number'
  && (value.kind === 'created' || value.kind === 'modified');

/** `artifacts.json`, written whole through a rename; changes run one at a time. A file it cannot read starts empty. */
export class ArtifactStore {
  private readonly file: string;
  private data: ArtifactsFile = { version: 1, sessions: {} };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string, private readonly changed: () => void = () => {}) {
    this.file = join(directory, 'artifacts.json');
  }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sessions)) return;
      for (const [id, value] of Object.entries(parsed.sessions)) {
        if (!isRecord(value) || typeof value.cursor !== 'number' || !Array.isArray(value.files)) continue;
        this.data.sessions[id] = { cursor: value.cursor, ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}), files: value.files.filter(isFile) };
      }
    } catch {
      // Missing or unreadable: the histories are read again from the start.
    }
  }

  of(sessionId: string): SessionArtifacts {
    const entry = this.data.sessions[sessionId];
    return entry ? { ...entry, files: entry.files.map(file => ({ ...file })) } : { cursor: -1, files: [] };
  }

  /** Changes a session made, oldest first; `cursor` moves the history cursor forward when given. */
  record(sessionId: string, changes: readonly TimedChange[], extra: { cursor?: number; cwd?: string } = {}): Promise<void> {
    const run = this.queue.then(async () => {
      const before = this.of(sessionId);
      const files = recordFiles(before.files, changes);
      const cursor = Math.max(before.cursor, extra.cursor ?? -1);
      const cwd = extra.cwd ?? before.cwd;
      if (files.length === before.files.length && files.every((file, index) => JSON.stringify(file) === JSON.stringify(before.files[index])) && cursor === before.cursor && cwd === before.cwd) return;
      this.data = { version: 1, sessions: { ...this.data.sessions, [sessionId]: { cursor, ...(cwd ? { cwd } : {}), files } } };
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.data)}\n`, 'utf8');
      await rename(temporary, this.file);
      if (changes.length) this.changed();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
