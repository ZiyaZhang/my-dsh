/**
 * The user's corrections, one JSON line each in `corrections.jsonl` in the data directory. A correction is a session put in, moved
 * between or taken out of matters by hand, a pick on a candidate card, a declined proposal or suggestion of automatic grouping, or an
 * undo. Each line says what the plugin or my dsh had decided (with the link's provenance, rule and reason) and what the user chose
 * instead. The log keeps, from the file and from each line it appends, which matters the user took each session out of, so automatic
 * grouping never files a session back there; the routing check reads the file later. It stays on this machine.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pairKey, type Suggestion, type SuggestionChange } from './grouping.js';
import type {
  ActivityEntry, ActivityKind, LinkSource, Matter, OriginRule, Proposal, ProposalChange, SessionLink, WhichCandidate, WhichQuestion,
} from './remote.js';

/** A link as it stood before the user changed it. */
export interface LinkFact {
  matterId: string;
  by: LinkSource;
  at: string;
  why?: string;
  rule?: OriginRule;
}

/** A candidate without its label, which can change after the question. */
type CandidateRef = Omit<WhichCandidate, 'label'>;

export type Correction =
  | { at: string; kind: 'add' | 'move' | 'remove'; sessionId: string; decided: LinkFact | null; chosen: { matterId: string } | null }
  | { at: string; kind: 'pick'; phrase: string; question: string; decided: { candidates: CandidateRef[]; why: string }; chosen: CandidateRef | null }
  | { at: string; kind: 'decline'; phrase?: string; proposal: string; decided: { change: ProposalChange; why: string }; chosen: null }
  | { at: string; kind: 'decline'; suggestion: string; decided: { change: SuggestionChange; by: LinkSource; rule?: OriginRule; why: string }; chosen: null }
  | {
    at: string; kind: 'undo'; activity: string; sessionId?: string; matterId?: string; sessionIds?: string[];
    decided: { kind: ActivityKind; by?: LinkSource; text: string; why: string }; chosen: null;
  };

const fact = (matter: Matter, link: SessionLink): LinkFact => ({
  matterId: matter.id, by: link.by, at: link.at, ...(link.why ? { why: link.why } : {}), ...(link.rule ? { rule: link.rule } : {}),
});
const ref = (candidate: WhichCandidate): CandidateRef => ({ kind: candidate.kind, id: candidate.id });

/**
 * A by-hand membership change.
 * @param before - the matter and link the session had, if any.
 * @param matterId - where the user put it, or null when they took it out.
 * @returns the correction, or null when nothing changed.
 */
export function membershipCorrection(before: { matter: Matter; link: SessionLink } | undefined, matterId: string | null, sessionId: string, at: string): Correction | null {
  if (!before) return matterId === null ? null : { at, kind: 'add', sessionId, decided: null, chosen: { matterId } };
  if (before.matter.id === matterId) return null;
  return { at, kind: matterId === null ? 'remove' : 'move', sessionId, decided: fact(before.matter, before.link), chosen: matterId === null ? null : { matterId } };
}

/** The user answered a candidate card; `answer` is null for 都不是. */
export function pickCorrection(question: WhichQuestion, answer: WhichCandidate | null, at: string): Correction {
  return {
    at, kind: 'pick', phrase: question.phrase, question: question.id,
    decided: { candidates: question.candidates.map(ref), why: question.why }, chosen: answer ? ref(answer) : null,
  };
}

export function declineCorrection(proposal: Proposal, at: string): Correction {
  return {
    at, kind: 'decline', ...(proposal.phrase ? { phrase: proposal.phrase } : {}), proposal: proposal.id,
    decided: { change: proposal.change, why: proposal.why }, chosen: null,
  };
}

/** The user declined a suggestion of automatic grouping: what it would have changed, where it came from, and why. */
export function suggestionCorrection(suggestion: Suggestion, at: string): Correction {
  return {
    at, kind: 'decline', suggestion: suggestion.id,
    decided: { change: suggestion.change, by: suggestion.by, ...(suggestion.rule ? { rule: suggestion.rule } : {}), why: suggestion.why }, chosen: null,
  };
}

/** Which kind of link an undoable entry made; a `group` entry says it itself. */
const MADE_BY: Partial<Record<ActivityKind, LinkSource>> = { start: 'mydsh', file: 'manual' };

export function undoCorrection(entry: ActivityEntry, at: string): Correction {
  const by = MADE_BY[entry.kind] ?? entry.by;
  return {
    at, kind: 'undo', activity: entry.id,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ...(entry.matterId ? { matterId: entry.matterId } : {}),
    ...(entry.sessions?.length ? { sessionIds: [...entry.sessions] } : {}),
    decided: { kind: entry.kind, ...(by ? { by } : {}), text: entry.text, why: entry.why }, chosen: null,
  };
}

export const correctionLine = (correction: Correction): string => `${JSON.stringify(correction)}\n`;

/**
 * The matters a correction says the user took a session out of, as `sessionId>matterId` keys: the matter of a removal or a move by
 * hand, and the matter an undone entry had put its sessions in.
 */
export function takenOutKeys(correction: Correction): string[] {
  if ((correction.kind === 'remove' || correction.kind === 'move') && correction.decided) return [pairKey(correction.sessionId, correction.decided.matterId)];
  if (correction.kind !== 'undo' || !correction.matterId) return [];
  const sessions = new Set([...(correction.sessionId ? [correction.sessionId] : []), ...(correction.sessionIds ?? [])]);
  return [...sessions].map(sessionId => pairKey(sessionId, correction.matterId!));
}

/**
 * Appends corrections in the order they were made. A line that cannot be written is reported and dropped. It also knows every session
 * the user took out of a matter, from the file when it opens and from each correction it appends.
 */
export class CorrectionLog {
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly taken = new Set<string>();

  constructor(private readonly directory: string, private readonly failed: (error: unknown) => void = () => {}) {
    this.file = join(directory, 'corrections.jsonl');
  }

  /** Read the file for what the user took out by hand; a line that does not parse is skipped, a missing or unreadable file is no history. */
  async open(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failed(error);
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { kind?: unknown }).kind !== 'string') continue;
      try {
        for (const key of takenOutKeys(parsed as Correction)) this.taken.add(key);
      } catch {
        // A line of another shape names nothing taken out.
      }
    }
  }

  /** `sessionId>matterId` of every session the user took out of a matter by hand, or out of the matter an undone entry had put it in. */
  takenOut(): ReadonlySet<string> {
    return this.taken;
  }

  append(correction: Correction): Promise<void> {
    for (const key of takenOutKeys(correction)) this.taken.add(key);
    const line = correctionLine(correction);
    const run = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(this.file, line, 'utf8');
    }).catch((error: unknown) => { this.failed(error); });
    this.queue = run;
    return run;
  }
}
