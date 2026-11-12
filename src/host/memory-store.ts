/**
 * 事项记忆 on disk. Each matter's memory folder is `<main workspace>/.my-dsh/<matter id>/memory/`, or `<data directory>/matters/<matter
 * id>/memory/` while the matter has no main workspace; when the main workspace changes, the folder moves with it. Creating a `.my-dsh`
 * folder in a git repository adds `.my-dsh/` to that repository's `.git/info/exclude` (never .gitignore), so it stays out of commits.
 *
 * The store rebuilds MEMORY.md (and the folded categories' INDEX.md) on start, after each write of its own, and a second after anything
 * in a watched folder changes; it writes a file only when its text changes, so its own writes do not start another rebuild. It keeps a
 * copy of each file as it last saw it under `memory-shadow/` in the data directory, and reports every change it did not make itself with
 * the text before and after. Its own writes (补记, 合并, what the user said) go through {@link MemoryStore.apply}: each checked against
 * the file as it is right then, written to a temporary file and renamed into place. `memory-state.json` keeps where each folder is,
 * which matters' notes were moved in, the merge times, each session's 补记 cursor and the last passes.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { watch, type Dirent, type FSWatcher } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { within } from './file-calls.js';
import {
  CATEGORIES, CATEGORY_INDEX, CATEGORY_ORDER, FILE_MAX, INDEX_FILE, MERGE_BY, USER_BY, checkMemoryFile, clipDescription, contentHash, freePath, isUserBy,
  parseFrontmatter, renderMemoryFile, shortName, type FlaggedFile, type MemoryEntry,
} from './memory-files.js';
import { buildIndex, type MemoryIndex } from './memory-index.js';
import type { PlannedOp, SkippedOp } from './memory-ops.js';
import type { NoteView } from './remote.js';

/** Where one matter's memory belongs. */
export interface MemoryPlace {
  matterId: string;
  /** The matter's name, for the index's title. */
  name: string;
  /** The folder of the matter's main workspace, when it has one that exists. */
  workspace?: string;
}

/** A file that changed: added, updated or deleted, with its text before and after. */
export interface MemoryChange {
  path: string;
  change: 'add' | 'update' | 'delete';
  before: string | null;
  after: string | null;
}

/** A matter's memory as last read. */
export interface MemoryScan {
  dir: string;
  /** The folder with symbolic links resolved, as tool results name paths. */
  realDir: string;
  entries: MemoryEntry[];
  flagged: FlaggedFile[];
  /** The text of every file in the category folders that could be read, flagged ones too, by relative path. */
  texts: Map<string, string>;
  /** Whether each of those files is the user's, flagged ones read as far as they can be. */
  owned: Map<string, boolean>;
  index: MemoryIndex;
}

/** One 补记 or merge: what it wrote and what it skipped, and why. */
export interface PassRecord {
  kind: 'capture' | 'merge';
  at: string;
  applied: { op: string; path: string }[];
  skipped: SkippedOp[];
}

interface MatterState {
  /** Where the folder is. */
  dir?: string;
  /** notes.json's lines for the matter were written as files. */
  migrated?: true;
  /** When the memory was first set up: the first merge is due a day after it. */
  base?: string;
  mergedAt?: string;
  /** The newest passes, oldest first. */
  passes?: PassRecord[];
}

interface StateFile {
  version: 1;
  matters: Record<string, MatterState>;
  /** Each session's 补记 cursor: the seq of the last `turn/end` read. */
  cursors: Record<string, number>;
}

const PASSES_KEPT = 20;
/** How long the store waits after a change in a watched folder before it reads the folder again. */
export const RESCAN_DELAY_MS = 1_000;

export interface MemoryHooks {
  /** Files that changed since the store last saw them, made by someone other than the store. */
  observed(matterId: string, changes: MemoryChange[]): void;
  /** A matter's folder was read again: its index, rows and context may differ. */
  scanned(matterId: string): void;
  warn(message: string): void;
  /** `YYYY-MM-DD` of a moment, in the user's time zone. */
  dateOf(ms: number): string;
}

interface Live {
  name: string;
  dir: string;
  realDir: string;
  scan?: MemoryScan;
  watcher?: FSWatcher;
  watched?: string;
  timer?: ReturnType<typeof setTimeout>;
  queue: Promise<unknown>;
  shadows?: Map<string, string>;
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Run a command in a folder and give its output; fails after `timeout` ms, on a non-zero exit, or when the command is missing. */
function output(command: string, args: string[], cwd: string, timeout = 3_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile(command, args, { cwd, timeout, windowsHide: true }, (error, stdout) => { if (error) fail(error); else done(String(stdout)); });
  });
}

/**
 * Add `.my-dsh/` to the `.git/info/exclude` of the repository a folder is in, once. Nothing happens outside a repository or without git.
 * @returns whether the line is there now.
 */
export async function excludeFromGit(folder: string, run: (args: string[], cwd: string) => Promise<string> = (args, cwd) => output('git', args, cwd)): Promise<boolean> {
  let reply: string;
  try {
    reply = (await run(['rev-parse', '--git-path', 'info/exclude'], folder)).trim();
  } catch {
    return false;
  }
  if (!reply) return false;
  const file = isAbsolute(reply) ? reply : resolve(folder, reply);
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  if (text.split(/\r?\n/).some(line => ['.my-dsh', '.my-dsh/', '/.my-dsh', '/.my-dsh/'].includes(line.trim()))) return true;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.my-dsh/\n`, 'utf8');
  } catch {
    return false;
  }
  return true;
}

/** Write a file through a temporary file beside it and a rename, so readers see the old text or the new one. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, text, 'utf8');
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Every file under a folder, relative with `/`. */
async function walk(folder: string, prefix = ''): Promise<string[]> {
  let entries: Dirent[];
  try { entries = await readdir(folder, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(join(folder, entry.name), path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** The diffs of 做事记录's memory entries, one file each under `memory-diffs/` in the data directory, so the activity log stays small. */
export class DiffStore {
  constructor(private readonly directory: string) {}

  private file(id: string): string | undefined {
    return /^[\w-]{1,100}$/.test(id) ? join(this.directory, 'memory-diffs', `${id}.diff`) : undefined;
  }

  async write(id: string, diff: string): Promise<void> {
    const file = this.file(id);
    if (file && diff) await writeAtomic(file, diff);
  }

  async read(id: string): Promise<string | undefined> {
    const file = this.file(id);
    return file ? await readFile(file, 'utf8').catch(() => undefined) : undefined;
  }

  /** Drop the diffs of entries the log no longer keeps. */
  async prune(keep: ReadonlySet<string>): Promise<void> {
    const folder = join(this.directory, 'memory-diffs');
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (name.endsWith('.diff') && !keep.has(name.slice(0, -'.diff'.length))) await unlink(join(folder, name)).catch(() => undefined);
    }
  }
}

export class MemoryStore {
  private readonly file: string;
  private state: StateFile = { version: 1, matters: {}, cursors: {} };
  private stateQueue: Promise<unknown> = Promise.resolve();
  private readonly live = new Map<string, Live>();
  private closed = false;

  constructor(readonly directory: string, private readonly hooks: MemoryHooks) {
    this.file = join(directory, 'memory-state.json');
  }

  /** Read the state; a missing or damaged file starts empty, and a damaged one is kept beside it. */
  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.matters) && isRecord(parsed.cursors)) {
        this.state = { version: 1, matters: parsed.matters as Record<string, MatterState>, cursors: parsed.cursors as Record<string, number> };
        return;
      }
    } catch {
      // Kept below.
    }
    await writeFile(`${this.file}.damaged`, text, 'utf8').catch(() => undefined);
    this.hooks.warn(`${this.file} was not readable; the memory state starts again`);
  }

  /** The folder a matter's memory belongs in. */
  folderFor(place: MemoryPlace): string {
    return place.workspace ? join(place.workspace, '.my-dsh', place.matterId, 'memory') : join(this.directory, 'matters', place.matterId, 'memory');
  }

  /** The folder of a matter's memory, once it was set up. */
  dirOf(matterId: string): string | undefined {
    return this.live.get(matterId)?.dir ?? this.state.matters[matterId]?.dir;
  }

  scanOf(matterId: string): MemoryScan | undefined {
    return this.live.get(matterId)?.scan;
  }

  /** The folders of every matter set up here, with symbolic links resolved where known. */
  folders(): { matterId: string; dir: string; realDir: string }[] {
    return [...this.live].map(([matterId, live]) => ({ matterId, dir: live.dir, realDir: live.realDir }));
  }

  /**
   * Set up the memory of these matters and stop watching any other: move a folder whose main workspace changed, create a missing one,
   * write notes.json's lines in as files the first time, read it, and watch it.
   * @param notes - a matter's lines in notes.json.
   */
  async sync(places: readonly MemoryPlace[], notes: (matterId: string) => readonly NoteView[]): Promise<void> {
    if (this.closed) return;
    const wanted = new Set(places.map(place => place.matterId));
    for (const [matterId, live] of this.live) {
      if (wanted.has(matterId)) continue;
      live.watcher?.close();
      clearTimeout(live.timer);
      this.live.delete(matterId);
    }
    for (const place of places) {
      await this.run(place.matterId, () => this.settle(place, notes(place.matterId))).catch((error: unknown) => {
        this.hooks.warn(`the memory of ${place.matterId} was not set up: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async settle(place: MemoryPlace, notes: readonly NoteView[]): Promise<void> {
    const want = this.folderFor(place);
    const state = this.state.matters[place.matterId] ?? {};
    let live = this.live.get(place.matterId);
    // Nothing moved or was renamed and the watch still runs: it keeps the folder current. A folder someone removed ends its watch, and
    // is set up again below.
    if (live?.scan && live.watcher && live.dir === want && live.name === place.name && state.dir === want && state.migrated) return;
    const firstSight = !(await exists(this.shadowRoot(place.matterId)));
    if (state.dir && state.dir !== want) {
      live?.watcher?.close();
      if (live) { live.watcher = undefined; live.watched = undefined; }
      await this.move(state.dir, want, place);
    } else {
      await this.prepare(want, place);
    }
    if (!live) {
      live = { name: place.name, dir: want, realDir: want, queue: Promise.resolve() };
      this.live.set(place.matterId, live);
    }
    live.name = place.name;
    live.dir = want;
    live.realDir = await realpath(want).catch(() => want);
    const next: MatterState = { dir: want, ...(state.base ? {} : { base: new Date().toISOString() }) };
    if (!state.migrated) {
      await this.migrate(place.matterId, want, notes);
      next.migrated = true;
    }
    if (state.dir !== want || !state.base || !state.migrated) {
      await this.saveState(current => ({ ...current, matters: { ...current.matters, [place.matterId]: { ...current.matters[place.matterId], ...next } } }));
    }
    await this.scanNow(place.matterId, firstSight);
    this.watch(place.matterId);
  }

  /** Create the folder and its category folders; a new `.my-dsh` folder in a workspace goes into the repository's exclude list. */
  private async prepare(dir: string, place: MemoryPlace): Promise<void> {
    const hidden = place.workspace ? join(place.workspace, '.my-dsh') : undefined;
    const fresh = hidden !== undefined && !(await exists(hidden));
    for (const category of CATEGORY_ORDER) await mkdir(join(dir, category), { recursive: true });
    if (fresh && place.workspace) await excludeFromGit(place.workspace);
  }

  /** Move a folder to where the matter's memory now belongs; into a folder that already exists, only the files it lacks go. */
  private async move(from: string, to: string, place: MemoryPlace): Promise<void> {
    await this.prepare(to, place);
    // Only ever a matter's own memory folder is emptied and removed, whatever the saved state says.
    if (basename(from) !== 'memory' || basename(dirname(from)) !== place.matterId) {
      this.hooks.warn(`the memory of ${place.matterId} was not moved from ${from}: not a memory folder`);
      return;
    }
    if (await exists(from)) {
      for (const path of await walk(from)) {
        const target = join(to, ...path.split('/'));
        if (await exists(target)) continue;
        await mkdir(dirname(target), { recursive: true });
        try {
          await rename(join(from, ...path.split('/')), target);
        } catch {
          await cp(join(from, ...path.split('/')), target);
        }
      }
      await rm(from, { recursive: true, force: true });
      // The emptied matter folder and `.my-dsh` folder of a workspace go too; a data directory's matter folder keeps its uploads.
      if (basename(dirname(dirname(from))) === '.my-dsh') {
        await rmdir(dirname(from)).catch(() => undefined);
        await rmdir(dirname(dirname(from))).catch(() => undefined);
      }
    }
  }

  /** Write notes.json's lines as files, one per line in its category folder; the user's lines are 你说的. */
  private async migrate(matterId: string, dir: string, notes: readonly NoteView[]): Promise<void> {
    const taken = new Set<string>();
    for (const category of CATEGORY_ORDER) {
      for (const name of await readdir(join(dir, category)).catch(() => [] as string[])) taken.add(`${category}/${name}`);
    }
    for (const note of notes) {
      const category = CATEGORIES[note.kind];
      if (!category) continue;
      const name = shortName(note.text);
      const path = freePath(category, name, taken);
      taken.add(path);
      const user = note.by === 'user';
      const text = renderMemoryFile({
        name, description: clipDescription(note.text), by: user ? USER_BY : MERGE_BY, sources: note.sources,
        verified: user ? '用户说的' : '没核实', updated: this.hooks.dateOf(Date.parse(note.updatedAt) || Date.now()), body: note.text,
      });
      await writeAtomic(join(dir, ...path.split('/')), text);
      await this.setShadow(matterId, path, text);
    }
  }

  /** Read the folder again after a change in it, a second after the last one. */
  private schedule(matterId: string): void {
    const live = this.live.get(matterId);
    if (!live || this.closed) return;
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      live.timer = undefined;
      void this.run(matterId, () => this.scanNow(matterId, false)).catch((error: unknown) => {
        this.hooks.warn(`the memory of ${matterId} was not read: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, RESCAN_DELAY_MS);
  }

  private watch(matterId: string): void {
    const live = this.live.get(matterId);
    if (!live || this.closed || (live.watcher && live.watched === live.dir)) return;
    live.watcher?.close();
    try {
      const watcher = watch(live.dir, { recursive: true }, (_event, name) => {
        // Temporary files come and go; the rename that ends a write names the file itself.
        if (name && basename(String(name)).startsWith('.')) return;
        this.schedule(matterId);
      });
      watcher.on('error', () => {
        watcher.close();
        if (live.watcher === watcher) { live.watcher = undefined; live.watched = undefined; }
      });
      live.watcher = watcher;
      live.watched = live.dir;
    } catch (error) {
      this.hooks.warn(`the memory of ${matterId} is not watched: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Read the folder, rebuild the index files, and report what changed since the last copy; `silent` takes the copy without reporting. */
  private async scanNow(matterId: string, silent: boolean): Promise<void> {
    const live = this.live.get(matterId);
    if (!live) return;
    const { dir } = live;
    for (const category of CATEGORY_ORDER) await mkdir(join(dir, category), { recursive: true });
    const entries: MemoryEntry[] = [];
    const flagged: FlaggedFile[] = [];
    const texts = new Map<string, string>();
    const owned = new Map<string, boolean>();
    /** Files too big to read, which keep their copies until they can be read again. */
    const unread = new Set<string>();
    for (const category of CATEGORY_ORDER) {
      let names: Dirent[];
      try { names = await readdir(join(dir, category), { withFileTypes: true }); } catch { continue; }
      for (const dirent of names) {
        const name = dirent.name;
        if (name.startsWith('.') || !dirent.isFile() || !name.toLowerCase().endsWith('.md') || name.toUpperCase() === CATEGORY_INDEX.toUpperCase()) continue;
        const path = `${category}/${name}`;
        const full = join(dir, category, name);
        const info = await stat(full).catch(() => undefined);
        if (!info) continue;
        if (info.size > FILE_MAX) {
          flagged.push({ path, reason: '超过 100 KB' });
          unread.add(path);
          continue;
        }
        const text = await readFile(full, 'utf8').catch(() => undefined);
        if (text === undefined) continue;
        texts.set(path, text);
        const checked = checkMemoryFile(path, text, { size: info.size, mtime: info.mtimeMs });
        if ('entry' in checked) {
          entries.push(checked.entry);
          owned.set(path, checked.entry.userOwned);
        } else {
          flagged.push(checked.flagged);
          owned.set(path, isUserBy(parseFrontmatter(text)?.fields.by ?? ''));
        }
      }
    }
    for (const dirent of await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])) {
      if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md') && dirent.name !== INDEX_FILE && !dirent.name.startsWith('.')) {
        flagged.push({ path: dirent.name, reason: '不在类别目录里' });
      }
    }
    const index = buildIndex(live.name, entries.map(entry => ({
      path: entry.path, category: entry.category, name: entry.name, description: entry.description, userOwned: entry.userOwned,
      isVerified: entry.isVerified, mtime: entry.mtime, ...(entry.updated !== undefined ? { updated: entry.updated } : {}),
    })));
    await this.writeIfChanged(join(dir, INDEX_FILE), index.text);
    for (const category of CATEGORY_ORDER) {
      const file = join(dir, category, CATEGORY_INDEX);
      const text = index.categoryIndexes[category];
      if (text !== undefined) await this.writeIfChanged(file, text);
      else await unlink(file).catch(() => undefined);
    }
    const shadows = await this.shadows(matterId);
    const changes: MemoryChange[] = [];
    for (const [path, text] of texts) {
      const before = shadows.get(path);
      if (before === text) continue;
      changes.push({ path, change: before === undefined ? 'add' : 'update', before: before ?? null, after: text });
    }
    for (const [path, before] of shadows) {
      if (!texts.has(path) && !unread.has(path)) changes.push({ path, change: 'delete', before, after: null });
    }
    for (const change of changes) await this.setShadow(matterId, change.path, change.after);
    live.scan = { dir, realDir: live.realDir, entries, flagged, texts, owned, index };
    if (changes.length && !silent) this.hooks.observed(matterId, changes);
    this.hooks.scanned(matterId);
  }

  private async writeIfChanged(file: string, text: string): Promise<void> {
    const current = await readFile(file, 'utf8').catch(() => undefined);
    if (current !== text) await writeAtomic(file, text);
  }

  private shadowRoot(matterId: string): string {
    return join(this.directory, 'memory-shadow', matterId);
  }

  /** The copies of a matter's files, read once per process. */
  private async shadows(matterId: string): Promise<Map<string, string>> {
    const live = this.live.get(matterId);
    if (live?.shadows) return live.shadows;
    const root = this.shadowRoot(matterId);
    await mkdir(root, { recursive: true });
    const map = new Map<string, string>();
    for (const path of await walk(root)) {
      if (!path.includes('/') || basename(path).startsWith('.')) continue;
      const text = await readFile(join(root, ...path.split('/')), 'utf8').catch(() => undefined);
      if (text !== undefined) map.set(path, text);
    }
    if (live) live.shadows = map;
    return map;
  }

  private async setShadow(matterId: string, path: string, text: string | null): Promise<void> {
    const file = join(this.shadowRoot(matterId), ...path.split('/'));
    if (text === null) await unlink(file).catch(() => undefined);
    else await writeAtomic(file, text);
    const map = this.live.get(matterId)?.shadows;
    if (!map) return;
    if (text === null) map.delete(path);
    else map.set(path, text);
  }

  /** Run one change to a matter's folder after the ones before it. */
  private run<T>(matterId: string, work: () => Promise<T>): Promise<T> {
    const live = this.live.get(matterId);
    if (!live) return work();
    const run = live.queue.then(work);
    live.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Write operations the checks passed, each against the file as it is now: an add needs the path free, an update or delete the hash
   * the pass saw. The store keeps each new text as its copy, so the change is reported by the caller and not again by the next read.
   * @returns the changes made and the operations skipped, with why.
   */
  apply(matterId: string, ops: readonly PlannedOp[]): Promise<{ applied: MemoryChange[]; skipped: SkippedOp[] }> {
    return this.run(matterId, async () => {
      const live = this.live.get(matterId);
      if (!live) return { applied: [], skipped: ops.map(op => ({ op: op.op, path: op.path, reason: '这件事项的记忆还没准备好' })) };
      await this.shadows(matterId);
      const applied: MemoryChange[] = [];
      const skipped: SkippedOp[] = [];
      for (const op of ops) {
        const file = join(live.dir, ...op.path.split('/'));
        const current = await readFile(file, 'utf8').catch(() => null);
        if (op.op === 'add' && current !== null) { skipped.push({ op: op.op, path: op.path, reason: '这个路径已经有文件了' }); continue; }
        if (op.expect !== undefined && (current === null || contentHash(current) !== op.expect)) {
          skipped.push({ op: op.op, path: op.path, reason: '文件在读过之后又被改了' });
          continue;
        }
        if (op.op === 'delete') {
          await unlink(file);
          applied.push({ path: op.path, change: 'delete', before: current, after: null });
        } else {
          await writeAtomic(file, op.content ?? '');
          applied.push({ path: op.path, change: current === null ? 'add' : 'update', before: current, after: op.content ?? '' });
        }
        await this.setShadow(matterId, op.path, op.op === 'delete' ? null : op.content ?? '');
      }
      await this.scanNow(matterId, false);
      return { applied, skipped };
    });
  }

  /** A file's text, for a path in a category folder; undefined when it cannot be read. */
  async read(matterId: string, path: string): Promise<string | undefined> {
    const dir = this.dirOf(matterId);
    if (!dir || within(dir, join(dir, ...path.split('/'))) !== path) return undefined;
    return await readFile(join(dir, ...path.split('/')), 'utf8').catch(() => undefined);
  }

  /** Read a matter's folder again now, as after a change in it. */
  rescan(matterId: string): Promise<void> {
    return this.run(matterId, () => this.scanNow(matterId, false));
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private saveState(change: (state: StateFile) => StateFile): Promise<void> {
    const run = this.stateQueue.then(async () => {
      const next = change(this.state);
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(temporary, this.file);
      this.state = next;
    });
    this.stateQueue = run.catch(() => undefined);
    return run;
  }

  /** A session's 补记 cursor; undefined before its first 补记. */
  cursor(sessionId: string): number | undefined {
    return this.state.cursors[sessionId];
  }

  setCursors(cursors: Readonly<Record<string, number>>): Promise<void> {
    if (Object.keys(cursors).length === 0) return Promise.resolve();
    return this.saveState(state => ({ ...state, cursors: { ...state.cursors, ...cursors } }));
  }

  /** When the last merge finished, epoch ms. */
  mergedAt(matterId: string): number | undefined {
    const at = Date.parse(this.state.matters[matterId]?.mergedAt ?? '');
    return Number.isFinite(at) ? at : undefined;
  }

  /** When the matter's memory was set up here, epoch ms; now before that. */
  base(matterId: string): number {
    const at = Date.parse(this.state.matters[matterId]?.base ?? '');
    return Number.isFinite(at) ? at : Date.now();
  }

  /** Keep a pass's record; a merge also sets the merge time. */
  recordPass(matterId: string, record: PassRecord): Promise<void> {
    return this.saveState((state) => {
      const matter = state.matters[matterId] ?? {};
      const passes = [...(matter.passes ?? []), record].slice(-PASSES_KEPT);
      return { ...state, matters: { ...state.matters, [matterId]: { ...matter, passes, ...(record.kind === 'merge' ? { mergedAt: record.at } : {}) } } };
    });
  }

  passes(matterId: string): readonly PassRecord[] {
    return this.state.matters[matterId]?.passes ?? [];
  }

  close(): void {
    this.closed = true;
    for (const live of this.live.values()) {
      live.watcher?.close();
      clearTimeout(live.timer);
    }
  }
}
