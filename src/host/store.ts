/**
 * Matters on disk: one JSON file in the plugin's data directory, written whole through a temporary file and a rename, so a crash leaves
 * either the old file or the new one. Changes run one at a time, each on the list the previous one left.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Matter } from './remote.js';
import type { Changed } from './matters.js';

interface StoreFile { version: 1; matters: Matter[] }

const isText = (value: unknown): value is string => typeof value === 'string';

function isMatter(value: unknown): value is Matter {
  if (typeof value !== 'object' || value === null) return false;
  const matter = value as Record<string, unknown>;
  return isText(matter.id) && isText(matter.name) && isText(matter.goal) && isText(matter.createdAt)
    && Array.isArray(matter.sessions) && matter.sessions.every(isText)
    && (matter.main === undefined || isText(matter.main))
    && (matter.archivedAt === undefined || isText(matter.archivedAt));
}

const copy = (matter: Matter): Matter => ({ ...matter, sessions: [...matter.sessions] });

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
    let parsed: Partial<StoreFile>;
    try {
      parsed = JSON.parse(text) as Partial<StoreFile>;
    } catch (error) {
      throw Object.assign(damaged(), { cause: error });
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.matters) || !parsed.matters.every(isMatter)) throw damaged();
    this.matters = parsed.matters.map(copy);
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
    const body: StoreFile = { version: 1, matters };
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
    this.matters = matters.map(copy);
  }
}
