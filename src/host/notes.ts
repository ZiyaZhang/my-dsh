/**
 * 事项笔记 from before 事项记忆 lived in `notes.json` beside the matters. The Host reads it once and writes each matter's lines into the
 * matter's memory folder (memory-store.ts); the file stays as it was. Also here: the matter's own lines every session in it reads (its
 * goal, instructions and sources, then its memory), and the check of a line the user said.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RequestError, type NoteView as Note } from './remote.js';

export type { Note };

interface NotesFile { version: 1; matters: Record<string, { notes: Note[] }> }

export const NOTE_TEXT_MAX = 240;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** notes.json, read only. */
export class NoteStore {
  private readonly file: string;
  private data: NotesFile = { version: 1, matters: {} };

  constructor(private readonly directory: string) {
    this.file = join(directory, 'notes.json');
  }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.matters)) this.data = parsed as unknown as NotesFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Object.assign(new Error(`my-dsh: ${this.file} 不是能读的笔记文件`), { cause: error });
    }
  }

  /** A matter's lines, as notes.json has them. */
  of(matterId: string): Note[] {
    const notes = this.data.matters[matterId]?.notes;
    return Array.isArray(notes) ? notes.map(note => ({ ...note, sources: Array.isArray(note.sources) ? [...note.sources] : [] })) : [];
  }
}

/**
 * A line the user said, written in their words: one line with single spaces.
 * @throws RequestError when it is empty or longer than {@link NOTE_TEXT_MAX}.
 */
export function noteText(raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) throw new RequestError('要记的话不能为空');
  if ([...text].length > NOTE_TEXT_MAX) throw new RequestError(`一次最多记 ${NOTE_TEXT_MAX} 个字`);
  return text;
}

/** The parts of a matter its context gives: name, goal, instructions and sources. */
export interface ContextMatter {
  name: string;
  goal: string;
  instructions?: string;
  sources: { kind: string; value: string; title?: string }[];
}

/** The context a session in a matter reads each step: which matter, {@link matterDetails}, then the matter's memory block. */
export function matterContext(matter: ContextMatter, memory?: string): string {
  return [`这条会话属于事项「${matter.name}」。`, ...matterDetails(matter), ...(memory ? ['', memory] : [])].join('\n');
}

/** Goal, instructions and sources, one line each. */
export function matterDetails(matter: ContextMatter): string[] {
  const lines: string[] = [];
  if (matter.goal) lines.push(`目标：${matter.goal}`);
  if (matter.instructions) lines.push(`指令：${matter.instructions}`);
  if (matter.sources.length) lines.push(`来源：${matter.sources.map(source => source.title ? `${source.title}（${source.value}）` : source.value).join('；')}`);
  return lines;
}
