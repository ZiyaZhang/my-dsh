/**
 * Matters on disk: one JSON file in the plugin's data directory, written whole through a temporary file and a rename, so a crash leaves
 * either the old file or the new one. Changes run one at a time, each on the list the previous one left.
 *
 * Version 2 records how each session joined its matter, the matter's aliases and its context (main workspace, sources, instructions).
 * A version 1 file (M1: bare session ids) opens migrated, with every session put there by hand at the matter's creation time and no
 * sources; a copy of it stays beside it as `matters.v1.json`, and the next change writes version 2. The Host fills in the main
 * workspace once it knows the sessions ({@link fillWorkspaces} in board-index).
 */
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LINK_SOURCES, SOURCE_KINDS, type LinkSource, type Matter, type MatterSource, type SessionLink, type SourceKind } from './remote.js';
import type { Changed } from './matters.js';

const VERSION = 2;
interface StoreFile { version: typeof VERSION; matters: Matter[] }

const isText = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isLink(value: unknown): value is SessionLink {
  return isRecord(value) && isText(value.sessionId) && LINK_SOURCES.includes(value.by as LinkSource) && isText(value.at)
    && (value.why === undefined || isText(value.why));
}

/** The fields both versions share. */
function isMatterBase(matter: Record<string, unknown>): boolean {
  return isText(matter.id) && isText(matter.name) && isText(matter.goal) && isText(matter.createdAt)
    && (matter.main === undefined || isText(matter.main))
    && (matter.archivedAt === undefined || isText(matter.archivedAt));
}

function isSource(value: unknown): value is MatterSource {
  return isRecord(value) && SOURCE_KINDS.includes(value.kind as SourceKind) && isText(value.value) && (value.title === undefined || isText(value.title));
}

const isMatter = (value: unknown): value is Matter => isRecord(value) && isMatterBase(value)
  && Array.isArray(value.sessions) && value.sessions.every(isLink)
  && Array.isArray(value.aliases) && value.aliases.every(isText)
  && Array.isArray(value.sources) && value.sources.every(isSource)
  && (value.workspaceId === undefined || isText(value.workspaceId))
  && (value.instructions === undefined || isText(value.instructions));

const isMatterV1 = (value: unknown): value is Omit<Matter, 'sessions' | 'aliases'> & { sessions: string[] } => isRecord(value)
  && isMatterBase(value) && Array.isArray(value.sessions) && value.sessions.every(isText);

const copy = (matter: Matter): Matter => ({
  ...matter, sessions: matter.sessions.map(link => ({ ...link })), aliases: [...matter.aliases], sources: matter.sources.map(source => ({ ...source })),
});

/**
 * Read a parsed matter file of either version.
 * @returns the matters in the current form and whether they came from version 1, or undefined for anything else.
 */
export function migrateMatters(parsed: unknown): { matters: Matter[]; migrated: boolean } | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.matters)) return undefined;
  if (parsed.version === VERSION) return parsed.matters.every(isMatter) ? { matters: parsed.matters.map(copy), migrated: false } : undefined;
  if (parsed.version !== 1 || !parsed.matters.every(isMatterV1)) return undefined;
  const matters = parsed.matters.map(({ sessions, ...matter }): Matter => ({
    ...matter,
    sessions: sessions.map(sessionId => ({ sessionId, by: 'manual', at: matter.createdAt })),
    aliases: [],
    sources: [],
  }));
  return { matters, migrated: true };
}

const exists = (path: string) => access(path).then(() => true, () => false);

export class MatterStore {
  private readonly file: string;
  private matters: Matter[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  /** @param changed - called after each change is written. */
  constructor(readonly directory: string, private readonly changed: () => void = () => {}) {
    this.file = join(directory, 'matters.json');
  }

  /** Reads the file; a missing file is an empty store, a damaged one fails with its path so nothing overwrites it. */
  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.matters = []; return; }
      throw error;
    }
    const damaged = () => new Error(`my-dsh: ${this.file} 不是能读的事项文件`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw Object.assign(damaged(), { cause: error });
    }
    const read = migrateMatters(parsed);
    if (!read) throw damaged();
    if (read.migrated) {
      const backup = join(this.directory, 'matters.v1.json');
      if (!await exists(backup)) await writeFile(backup, text, 'utf8');
    }
    this.matters = read.matters;
  }

  list(): Matter[] {
    return this.matters.map(copy);
  }

  /**
   * Apply one change and write the result. A change that throws leaves the store as it was, and the next change still runs.
   * @returns the matter the change reports.
   */
  update<M>(change: (matters: readonly Matter[]) => Changed<M>): Promise<M> {
    const run = this.queue.then(async () => {
      const { matters, matter } = change(this.list());
      await this.save(matters);
      this.changed();
      return matter;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async save(matters: Matter[]): Promise<void> {
    const body: StoreFile = { version: VERSION, matters };
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
    this.matters = matters.map(copy);
  }
}
