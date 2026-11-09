/**
 * The user's corrections, one JSON line each in `corrections.jsonl` in the data directory. A correction is a session put in, moved
 * between or taken out of matters by hand, a pick on a candidate card, a declined proposal or an undo. Each line says what the plugin or
 * my dsh had decided (with the link's provenance and reason) and what the user chose instead. Filing rules and the routing check read
 * this file later; it stays on this machine.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityEntry, ActivityKind, LinkSource, Matter, Proposal, ProposalChange, SessionLink, WhichCandidate, WhichQuestion } from './remote.js';

/** A link as it stood before the user changed it. */
export interface LinkFact {
  matterId: string;
  by: LinkSource;
  at: string;
  why?: string;
}

/** A candidate without its label, which can change after the question. */
type CandidateRef = Omit<WhichCandidate, 'label'>;

export type Correction =
  | { at: string; kind: 'add' | 'move' | 'remove'; sessionId: string; decided: LinkFact | null; chosen: { matterId: string } | null }
  | { at: string; kind: 'pick'; phrase: string; question: string; decided: { candidates: CandidateRef[]; why: string }; chosen: CandidateRef | null }
  | { at: string; kind: 'decline'; phrase?: string; proposal: string; decided: { change: ProposalChange; why: string }; chosen: null }
  | { at: string; kind: 'undo'; activity: string; sessionId?: string; matterId?: string; decided: { kind: ActivityKind; by?: LinkSource; text: string; why: string }; chosen: null };

const fact = (matter: Matter, link: SessionLink): LinkFact => ({ matterId: matter.id, by: link.by, at: link.at, ...(link.why ? { why: link.why } : {}) });
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

/** Which kind of link an undoable entry made. */
const MADE_BY: Partial<Record<ActivityKind, LinkSource>> = { start: 'mydsh', file: 'manual' };

export function undoCorrection(entry: ActivityEntry, at: string): Correction {
  const by = MADE_BY[entry.kind];
  return {
    at, kind: 'undo', activity: entry.id,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ...(entry.matterId ? { matterId: entry.matterId } : {}),
    decided: { kind: entry.kind, ...(by ? { by } : {}), text: entry.text, why: entry.why }, chosen: null,
  };
}

export const correctionLine = (correction: Correction): string => `${JSON.stringify(correction)}\n`;

/** Appends corrections in the order they were made. A line that cannot be written is reported and dropped. */
export class CorrectionLog {
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string, private readonly failed: (error: unknown) => void = () => {}) {
    this.file = join(directory, 'corrections.jsonl');
  }

  append(correction: Correction): Promise<void> {
    const line = correctionLine(correction);
    const run = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(this.file, line, 'utf8');
    }).catch((error: unknown) => { this.failed(error); });
    this.queue = run;
    return run;
  }
}
