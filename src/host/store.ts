/**
 * Matters on disk: one JSON file in the plugin's data directory, written whole through a temporary file and a rename, so a crash leaves
 * either the old file or the new one.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Matter } from './remote.js';

interface StoreFile { version: 1; matters: Matter[] }

export class MatterStore {
  private readonly file: string;
  private matters: Matter[] = [];

  constructor(readonly directory: string) {
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
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.matters)) throw new Error(`my-dsh: ${this.file} 不是能读的事项文件`);
    this.matters = parsed.matters;
  }

  list(): Matter[] {
    return this.matters.map(matter => ({ ...matter, sessions: [...matter.sessions] }));
  }

  async save(matters: Matter[]): Promise<void> {
    const body: StoreFile = { version: 1, matters };
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
    this.matters = matters;
  }
}
