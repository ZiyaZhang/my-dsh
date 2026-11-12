/**
 * Automatic grouping on disk: `grouping.json` in the plugin's data directory, written whole through a temporary file and a rename, its
 * changes run one at a time. It keeps the runs (when, what each looked at and made, why one stopped), the suggestions with what the user
 * decided on them, the never-again keys of the declined ones, each session's evidence read from its log with its cursor, and the branch
 * each session's turns ended on. A missing file is an empty store; a file that cannot be read is kept beside it as
 * `grouping.damaged.json` and the store starts empty. The transitions are pure functions, exported for tests.
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvidence } from './grouping-evidence.js';
import type { BranchNote } from './grouping-rules.js';
import { changeSessions, pairKey, suggestionKey, type GroupingRun, type Made, type Suggestion, type SuggestionChange } from './grouping.js';
import { ORIGIN_RULES, RequestError, type OriginRule } from './remote.js';

/** Runs kept, the newest. */
export const RUNS_KEPT = 30;
/** Pending suggestions kept: a run's first ones. */
export const PENDING_MAX = 30;
/** Decided suggestions kept, the newest; their never-again keys are kept apart. */
export const DECIDED_KEPT = 200;
/** Never-again keys kept, the newest. */
export const DECLINED_MAX = 2000;
/** Sessions whose evidence and turn-end branch are kept, the most recently read or ended. */
export const SESSIONS_KEPT = 1000;

export interface GroupingState {
  /** Oldest first. */
  runs: GroupingRun[];
  /** Decided ones first, oldest first; then the pending ones in the order the last run made them. */
  suggestions: Suggestion[];
  /** {@link suggestionKey} of each declined suggestion, oldest first. */
  declined: string[];
  evidence: Record<string, SessionEvidence>;
  branches: Record<string, BranchNote>;
}

export const emptyGrouping = (): GroupingState => ({ runs: [], suggestions: [], declined: [], evidence: {}, branches: {} });

const keepNewest = <T>(list: readonly T[], max: number): T[] => (list.length > max ? list.slice(list.length - max) : [...list]);
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** What a run comes to: its record, and the suggestions it made unless it stopped before making any. */
export interface RunResult {
  run: GroupingRun;
  made?: readonly Made[];
  /** The model step failed or had no model: the pending model suggestions stay, unless a new suggestion is about one of their sessions. */
  keepModel?: boolean;
}

/**
 * Record a run. Its suggestions replace the pending ones, less those declined before and filings into a matter the user took the
 * session out of; a suggestion that was pending already keeps its id and time. Each session is in one pending suggestion at most, the
 * first made, and at most {@link PENDING_MAX} stay pending.
 */
export function recordRun(state: GroupingState, result: RunResult, made: { at: string; id: () => string; takenOut: ReadonlySet<string> }): GroupingState {
  const runs = keepNewest([...state.runs, result.run], RUNS_KEPT);
  if (!result.made) return { ...state, runs };
  const declined = new Set(state.declined);
  const pending = state.suggestions.filter(suggestion => suggestion.state === 'pending');
  const before = new Map(pending.map(suggestion => [suggestionKey(suggestion.change), suggestion]));
  const fresh: Suggestion[] = [];
  const keys = new Set<string>();
  const busy = new Set<string>();
  const take = (item: Made, kept?: Suggestion) => {
    const key = suggestionKey(item.change);
    if (declined.has(key) || keys.has(key)) return;
    if (item.change.kind === 'file' && made.takenOut.has(pairKey(item.change.sessionId, item.change.matterId))) return;
    const sessions = changeSessions(item.change);
    if (sessions.some(id => busy.has(id))) return;
    keys.add(key);
    for (const id of sessions) busy.add(id);
    const old = kept ?? before.get(key);
    fresh.push({ change: item.change, why: item.why, by: item.by, ...(item.rule ? { rule: item.rule } : {}), id: old?.id ?? made.id(), at: old?.at ?? made.at, state: 'pending' });
  };
  for (const item of result.made) take(item);
  if (result.keepModel) for (const suggestion of pending) if (suggestion.by === 'model') take(suggestion, suggestion);
  const decided = state.suggestions.filter(suggestion => suggestion.state !== 'pending');
  return { ...state, runs, suggestions: [...keepNewest(decided, DECIDED_KEPT), ...fresh.slice(0, PENDING_MAX)] };
}

/** Add never-again keys; a pending suggestion with one of them is declined with it. */
export function refuseKeys(state: GroupingState, keys: readonly string[], at: string): GroupingState {
  if (keys.length === 0) return state;
  const refused = new Set(keys);
  return {
    ...state,
    declined: keepNewest(unique([...state.declined.filter(key => !refused.has(key)), ...keys]), DECLINED_MAX),
    suggestions: state.suggestions.map(suggestion => (suggestion.state === 'pending' && refused.has(suggestionKey(suggestion.change))
      ? { ...suggestion, state: 'declined' as const, decidedAt: at } : suggestion)),
  };
}

/** Record the user's decision on a pending suggestion; a declined one's key is never made again. */
export function decideSuggestion(
  state: GroupingState, id: string, decision: { state: 'accepted' | 'declined'; at: string; matterId?: string },
): { state: GroupingState; suggestion: Suggestion } {
  const found = state.suggestions.find(suggestion => suggestion.id === id);
  if (!found) throw new RequestError('没有这条建议');
  if (found.state !== 'pending') throw new RequestError('这条建议已经处理过了');
  const suggestion: Suggestion = { ...found, state: decision.state, decidedAt: decision.at, ...(decision.matterId ? { matterId: decision.matterId } : {}) };
  const next = { ...state, suggestions: state.suggestions.map(candidate => (candidate.id === id ? suggestion : candidate)) };
  return { state: decision.state === 'declined' ? refuseKeys(next, [suggestionKey(found.change)], decision.at) : next, suggestion };
}

/** Keep the newest {@link SESSIONS_KEPT} entries of a per-session record by a time, and only sessions still `known` when that is given. */
function pruned<T>(entries: Record<string, T>, time: (entry: T) => number, known?: ReadonlySet<string>): Record<string, T> {
  const kept = Object.entries(entries).filter(([id]) => !known || known.has(id)).sort((a, b) => time(b[1]) - time(a[1])).slice(0, SESSIONS_KEPT);
  return Object.fromEntries(kept);
}

/** Store freshly read evidence; with `known`, the evidence of sessions DSH no longer lists goes. */
export function noteEvidence(state: GroupingState, updates: Readonly<Record<string, SessionEvidence>>, known?: ReadonlySet<string>): GroupingState {
  return { ...state, evidence: pruned({ ...state.evidence, ...updates }, entry => entry.readAt, known) };
}

/** Store the branch a session's turn ended on; the same state back when it is the one already stored. */
export function noteBranch(state: GroupingState, sessionId: string, note: BranchNote): GroupingState {
  const known = state.branches[sessionId];
  if (known && known.key === note.key && known.name === note.name) return state;
  return { ...state, branches: pruned({ ...state.branches, [sessionId]: { ...note } }, entry => entry.at) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function isChange(value: unknown): value is SuggestionChange {
  if (!isRecord(value)) return false;
  if (value.kind === 'new') return isTexts(value.sessionIds) && isText(value.name) && isText(value.goal);
  return value.kind === 'file' && isText(value.sessionId) && isText(value.matterId);
}

const isSuggestion = (value: unknown): value is Suggestion => isRecord(value) && isText(value.id) && isChange(value.change) && isText(value.why)
  && (value.by === 'origin' || value.by === 'model') && (value.rule === undefined || ORIGIN_RULES.includes(value.rule as OriginRule))
  && isText(value.at) && (value.state === 'pending' || value.state === 'accepted' || value.state === 'declined')
  && (value.decidedAt === undefined || isText(value.decidedAt)) && (value.matterId === undefined || isText(value.matterId));

const isRun = (value: unknown): value is GroupingRun => isRecord(value) && isText(value.at) && isText(value.endedAt)
  && isCount(value.loose) && isCount(value.read) && isCount(value.asked) && isCount(value.origin) && isCount(value.model)
  && (value.modelUnavailable === undefined || value.modelUnavailable === true) && (value.error === undefined || isText(value.error));

const isEvidence = (value: unknown): value is SessionEvidence => isRecord(value) && isCount(value.cursor) && isTexts(value.prs)
  && Array.isArray(value.numbers) && value.numbers.every(isCount) && isTexts(value.refs) && isTexts(value.schedules)
  && (value.trigger === undefined || isText(value.trigger)) && isCount(value.readAt);

const isBranch = (value: unknown): value is BranchNote => isRecord(value) && isText(value.key) && isText(value.name) && isCount(value.at);

/** The state in a parsed file, each entry that does not read left out; undefined for anything that is not a version 1 file. */
export function parseGroupingFile(parsed: unknown): GroupingState | undefined {
  if (!isRecord(parsed) || parsed.version !== 1) return undefined;
  const list = <T>(value: unknown, check: (item: unknown) => item is T): T[] => (Array.isArray(value) ? value.filter(check) : []);
  const record = <T>(value: unknown, check: (item: unknown) => item is T): Record<string, T> => (isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, T] => check(entry[1])))
    : {});
  return {
    runs: list(parsed.runs, isRun), suggestions: list(parsed.suggestions, isSuggestion), declined: list(parsed.declined, isText),
    evidence: record(parsed.evidence, isEvidence), branches: record(parsed.branches, isBranch),
  };
}

export class GroupingStore {
  private readonly file: string;
  private state: GroupingState = emptyGrouping();
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param changed - called after a change the board shows was written: the runs and the suggestions.
   * @param warn - told when the file could not be read and was set aside.
   */
  constructor(readonly directory: string, private readonly changed: () => void = () => {}, private readonly warn: (text: string) => void = () => {}) {
    this.file = join(directory, 'grouping.json');
  }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let state: GroupingState | undefined;
    try {
      state = parseGroupingFile(JSON.parse(text));
    } catch {
      state = undefined;
    }
    if (state) { this.state = state; return; }
    const aside = join(this.directory, 'grouping.damaged.json');
    await copyFile(this.file, aside);
    this.warn(`${this.file} could not be read; it was kept as ${aside} and automatic grouping starts over`);
  }

  /** The current state without a copy; the transitions never change it in place. */
  peek(): Readonly<GroupingState> {
    return this.state;
  }

  /**
   * Apply one change and write the result when it differs; `shown` says whether the board shows what changed. A change that throws
   * leaves the state as it was, and the next change still runs.
   * @returns what the change reports.
   */
  update<R>(change: (state: GroupingState) => { state: GroupingState; result: R }, shown: boolean): Promise<R> {
    const run = this.queue.then(async () => {
      const { state, result } = change(this.state);
      if (state !== this.state) {
        await this.save(state);
        if (shown) this.changed();
      }
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  recordRun(result: RunResult, made: { at: string; id: () => string; takenOut: ReadonlySet<string> }): Promise<void> {
    return this.update(state => ({ state: recordRun(state, result, made), result: undefined }), true);
  }

  decide(id: string, decision: { state: 'accepted' | 'declined'; at: string; matterId?: string }): Promise<Suggestion> {
    return this.update((state) => {
      const decided = decideSuggestion(state, id, decision);
      return { state: decided.state, result: decided.suggestion };
    }, true);
  }

  refuse(keys: readonly string[], at: string): Promise<void> {
    return this.update(state => ({ state: refuseKeys(state, keys, at), result: undefined }), true);
  }

  noteEvidence(updates: Readonly<Record<string, SessionEvidence>>, known?: ReadonlySet<string>): Promise<void> {
    return this.update(state => ({ state: Object.keys(updates).length || known ? noteEvidence(state, updates, known) : state, result: undefined }), false);
  }

  noteBranch(sessionId: string, note: BranchNote): Promise<void> {
    return this.update(state => ({ state: noteBranch(state, sessionId, note), result: undefined }), false);
  }

  private async save(state: GroupingState): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, ...state })}\n`, 'utf8');
    await rename(temporary, this.file);
    this.state = state;
  }
}
