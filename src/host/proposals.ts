/**
 * Proposals and candidate questions: the two cards my dsh leaves for the user to click. Nothing changes until the click. Every function
 * is pure; the Host stores the lists and applies the matter changes through the matter functions.
 */
import { addAlias, createMatter, mergeMatters, renameMatter, type Changed } from './matters.js';
import { RequestError, type CardView, type Matter, type Proposal, type ProposalChange, type WhichCandidate, type WhichQuestion } from './remote.js';

export const PROPOSALS_MAX = 300;
export const QUESTIONS_MAX = 300;

/** The newest `max` of a list kept oldest first. */
export function keepNewest<T>(list: readonly T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : [...list];
}

/** What will change, in one line; the same line goes into 做事记录 once it is accepted. */
export function proposalLine(change: ProposalChange): string {
  switch (change.kind) {
    case 'new': return `新起事项「${change.name}」${change.goal ? `，目标是${change.goal}` : ''}`;
    case 'merge': return `把「${change.fromName}」并进「${change.intoName}」`;
    case 'rename': return `把「${change.oldName}」改名为「${change.name}」`;
  }
}

/**
 * Apply an accepted proposal. A new matter gets `made.id`; the user's phrase, when there was one, becomes an alias of the matter that
 * results (a rename also keeps the old name, a merge the merged matter's name and aliases).
 */
export function applyProposal(matters: readonly Matter[], proposal: Proposal, made: { id: string; at: string }): Changed & { text: string } {
  if (proposal.state !== 'pending') throw new RequestError('这个提议已经处理过了');
  const { change } = proposal;
  let changed: Changed;
  switch (change.kind) {
    case 'new': changed = createMatter(matters, { name: change.name, goal: change.goal }, made); break;
    case 'merge': changed = mergeMatters(matters, change.fromId, change.intoId); break;
    case 'rename': changed = renameMatter(matters, change.matterId, change.name); break;
  }
  if (proposal.phrase) changed = addAlias(changed.matters, changed.matter.id, proposal.phrase);
  return { ...changed, text: proposalLine(change) };
}

/** Record the click on a pending proposal. */
export function decideProposal(
  proposals: readonly Proposal[], id: string, decision: { state: 'accepted' | 'declined'; at: string; matterId?: string },
): { proposals: Proposal[]; proposal: Proposal } {
  const found = proposals.find(candidate => candidate.id === id);
  if (!found) throw new RequestError('没有这个提议');
  if (found.state !== 'pending') throw new RequestError('这个提议已经处理过了');
  const proposal: Proposal = { ...found, state: decision.state, decidedAt: decision.at, ...(decision.matterId ? { matterId: decision.matterId } : {}) };
  return { proposals: proposals.map(candidate => candidate.id === id ? proposal : candidate), proposal };
}

export function proposalCard(proposal: Proposal): CardView {
  return {
    type: 'proposal', id: proposal.id, kind: proposal.change.kind, line: proposalLine(proposal.change), state: proposal.state,
    sessionId: proposal.sessionId, turn: proposal.turn,
  };
}

/** The words that go back into my dsh's conversation as the user's answer. */
function replyFor(answer: WhichCandidate | null): string {
  if (answer === null) return '都不是';
  return `是${answer.kind === 'matter' ? '事项' : '会话'}「${answer.label}」`;
}

/**
 * Record the user's pick on a candidate card; `candidateId` is null for 都不是.
 * @returns the answered question, the pick and the reply to send back to my dsh.
 */
export function answerQuestion(questions: readonly WhichQuestion[], id: string, candidateId: string | null, at: string): {
  questions: WhichQuestion[]; question: WhichQuestion; answer: WhichCandidate | null; reply: string;
} {
  const found = questions.find(candidate => candidate.id === id);
  if (!found) throw new RequestError('没有这个问题');
  if (found.state !== 'pending') throw new RequestError('这张卡已经选过了');
  const answer = candidateId === null ? null : found.candidates.find(candidate => candidate.id === candidateId);
  if (answer === undefined) throw new RequestError('不是这张卡上的候选');
  const question: WhichQuestion = { ...found, state: 'answered', answer, answeredAt: at };
  return { questions: questions.map(candidate => candidate.id === id ? question : candidate), question, answer, reply: replyFor(answer) };
}

export function questionCard(question: WhichQuestion): CardView {
  return {
    type: 'which', id: question.id, phrase: question.phrase, candidates: question.candidates, state: question.state,
    ...(question.answer !== undefined ? { answer: question.answer } : {}), sessionId: question.sessionId, turn: question.turn,
  };
}
