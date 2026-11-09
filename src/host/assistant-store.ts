/**
 * my dsh's own records on disk, beside the matters: its session id, 做事记录, proposals and candidate questions, in `assistant.json`.
 * Written whole through a temporary file and a rename; changes run one at a time, like the matter store.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityEntry, Proposal, WhichQuestion } from './remote.js';

export interface AssistantState {
  /** my dsh's session, once made. */
  sessionId?: string;
  /** Oldest first. */
  activity: ActivityEntry[];
  proposals: Proposal[];
  questions: WhichQuestion[];
}

interface AssistantFile extends AssistantState { version: 1 }

export const emptyAssistant = (): AssistantState => ({ activity: [], proposals: [], questions: [] });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isPlace = (value: Record<string, unknown>) => isText(value.sessionId) && typeof value.turn === 'number';

const isEntry = (value: unknown): value is ActivityEntry => isRecord(value) && isText(value.id) && isText(value.at) && isText(value.kind)
  && isText(value.text) && isText(value.why);
const isProposal = (value: unknown): value is Proposal => isRecord(value) && isText(value.id) && isRecord(value.change) && isText(value.change.kind)
  && isText(value.why) && isText(value.at) && isText(value.state) && isPlace(value);
const isQuestion = (value: unknown): value is WhichQuestion => isRecord(value) && isText(value.id) && isText(value.phrase)
  && Array.isArray(value.candidates) && value.candidates.every(candidate => isRecord(candidate) && isText(candidate.id) && isText(candidate.kind) && isText(candidate.label))
  && isText(value.why) && isText(value.at) && isText(value.state) && isPlace(value);

function readState(parsed: unknown): AssistantState | undefined {
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  const { sessionId, activity, proposals, questions } = parsed;
  if (sessionId !== undefined && !isText(sessionId)) return undefined;
  if (!Array.isArray(activity) || !activity.every(isEntry)) return undefined;
  if (!Array.isArray(proposals) || !proposals.every(isProposal)) return undefined;
  if (!Array.isArray(questions) || !questions.every(isQuestion)) return undefined;
  return { ...(sessionId !== undefined ? { sessionId } : {}), activity, proposals, questions };
}

const copy = (state: AssistantState): AssistantState => structuredClone(state);

export class AssistantStore {
  private readonly file: string;
  private current: AssistantState = emptyAssistant();
  private queue: Promise<unknown> = Promise.resolve();

  /** @param changed - called after each change is written. */
  constructor(readonly directory: string, private readonly changed: () => void = () => {}) {
    this.file = join(directory, 'assistant.json');
  }

  /** Reads the file; a missing file is an empty state, a damaged one fails with its path so nothing overwrites it. */
  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.current = emptyAssistant(); return; }
      throw error;
    }
    const damaged = () => new Error(`my-dsh: ${this.file} 不是能读的 my dsh 记录`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw Object.assign(damaged(), { cause: error });
    }
    const state = readState(parsed);
    if (!state) throw damaged();
    this.current = state;
  }

  state(): AssistantState {
    return copy(this.current);
  }

  /** The current state without a copy, for reads that do not keep it. */
  peek(): Readonly<AssistantState> {
    return this.current;
  }

  /**
   * Apply one change and write the result. A change that throws leaves the state as it was, and the next change still runs.
   * @returns what the change reports.
   */
  update<R>(change: (state: AssistantState) => { state: AssistantState; result: R }): Promise<R> {
    const run = this.queue.then(async () => {
      const { state, result } = change(this.state());
      await this.save(state);
      this.changed();
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async save(state: AssistantState): Promise<void> {
    const body: AssistantFile = { version: 1, ...state };
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
    this.current = copy(state);
  }
}
