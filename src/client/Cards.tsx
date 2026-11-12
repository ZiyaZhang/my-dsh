/**
 * The cards under my dsh's turns and those of a matter's conversation, drawn through `conversation.chat.turnTail`: a proposal with its
 * buttons, a candidate question, a receipt for a session the tools started or wrote to, or for a line they wrote into a matter's notes,
 * and 转给了「X」 for the user's words my dsh passed to a matter's conversation. The cards' state comes from the Host with the board
 * snapshot; each card sits under the turn whose tool call made it. Other sessions render nothing.
 */
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { PRESET_ID, type BoardSnapshot, type CardView } from '../host/remote.js';
import type { BoardSource } from './board-source.js';
import { ForwardCard } from './Forward.js';

export interface CardActions {
  accept(id: string): Promise<void>;
  decline(id: string): Promise<void>;
  /** `candidateId` is null for 都不是. */
  answer(id: string, candidateId: string | null): Promise<void>;
  undo(id: string): Promise<void>;
  openSession(sessionId: string): void;
  /** Shows a matter's conversation, with the matter's tab beside it. */
  openMatter(matterId: string): Promise<void>;
}

export interface CardsInjected {
  source: BoardSource;
  actions: CardActions;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The turn tail of my dsh's session, or of a matter's conversation the last board read knows: its cards, if this turn left any. Other
 * sessions do not read the board.
 */
export function CardTail({ turn, sessionId, useProjection, source, actions }: PropsRuntime<'conversation.chat.turnTail'> & CardsInjected) {
  const preset = useProjection('agentPreset');
  const board = source.getSnapshot();
  const conversation = board.status === 'ready' && board.snapshot.matters.some(matter => matter.conversation?.sessionId === sessionId);
  if (preset !== PRESET_ID && !conversation) return null;
  return <TurnCards sessionId={sessionId} turn={turn.turn} source={source} actions={actions} />;
}

function TurnCards({ sessionId, turn, source, actions }: { sessionId: string; turn: number } & CardsInjected) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  if (state.status !== 'ready') return null;
  const cards = state.snapshot.assistant.cards.filter(card => card.sessionId === sessionId && card.turn === turn);
  if (cards.length === 0) return null;
  return <div className="mydsh-cards">{cards.map(card => <Card key={card.id} card={card} snapshot={state.snapshot} actions={actions} />)}</div>;
}

const VERBS = { new: ['新起', '已新起'], merge: ['合并', '已合并'], rename: ['改名', '已改名'] } as const;

function Card({ card, snapshot, actions }: { card: CardView; snapshot: BoardSnapshot; actions: CardActions }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    task().catch((failure: unknown) => { setError(message(failure)); }).finally(() => { setBusy(false); });
  };
  const failure = error && <p className="mydsh-card-error" role="alert">{error}</p>;

  if (card.type === 'proposal') {
    const [verb, done] = VERBS[card.kind];
    return (
      <section className="mydsh-card-item" data-card={card.id}>
        <p className={`mydsh-card-line${card.state === 'pending' ? '' : ' is-settled'}`}>{card.line}</p>
        {card.state === 'pending'
          ? (
            <div className="mydsh-card-buttons">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { run(() => actions.accept(card.id)); }}>{verb}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { run(() => actions.decline(card.id)); }}>取消</Button>
            </div>
          )
          : <p className="mydsh-card-stat">{card.state === 'accepted' ? done : '取消了'}</p>}
        {failure}
      </section>
    );
  }

  if (card.type === 'which') {
    return (
      <section className="mydsh-card-item" data-card={card.id}>
        {card.state === 'pending'
          ? (
            <div className="mydsh-card-buttons">
              {card.candidates.map(candidate => (
                <Button key={candidate.id} variant="outline" size="sm" disabled={busy} onClick={() => { run(() => actions.answer(card.id, candidate.id)); }}>
                  {candidate.label}<span className="mydsh-card-kind">{candidate.kind === 'matter' ? '事项' : '会话'}</span>
                </Button>
              ))}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { run(() => actions.answer(card.id, null)); }}>都不是</Button>
            </div>
          )
          : <p className="mydsh-card-stat">{card.answer ? `选了「${card.answer.label}」` : '都不是'}</p>}
        {failure}
      </section>
    );
  }

  if (card.type === 'forward') {
    return (
      <>
        <ForwardCard card={card} snapshot={snapshot} now={Date.now()} openMatter={(matterId) => { run(() => actions.openMatter(matterId)); }} />
        {failure}
      </>
    );
  }

  const target = card.target;
  return (
    <section className="mydsh-card-item is-receipt" data-card={card.id}>
      <p className="mydsh-card-line">{card.line}</p>
      <span className="mydsh-card-links">
        {target !== undefined && <button type="button" className="mydsh-link" onClick={() => { actions.openSession(target); }}>打开</button>}
        {card.undoable && <button type="button" className="mydsh-link" disabled={busy} onClick={() => { run(() => actions.undo(card.id)); }}>撤回</button>}
        {card.undone && <span className="mydsh-card-stat">已撤回</span>}
      </span>
      {failure}
    </section>
  );
}
