/**
 * 转给了「X」: the receipt of my dsh passing the user's words to a matter's conversation. The newest pass to a matter shows what the
 * conversation did since: its reply once a turn ended, what it waits for, that it is answering, or that it has not started yet; 接着说
 * opens that conversation. Under a turn in my dsh's conversation the reply is its first line; under my dsh's input it shows whole.
 */
import { MarkdownText, StateDot, type MarkdownLabels, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardSnapshot, ForwardCardView } from '../host/remote.js';
import { forwardState, type ForwardState } from './rows.js';
import { when } from './time.js';

const LABELS: MarkdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

/** The newest pass my dsh's own session made, for the card under its input. */
export function newestForward(snapshot: BoardSnapshot): ForwardCardView | undefined {
  let newest: ForwardCardView | undefined;
  for (const card of snapshot.assistant.cards) {
    if (card.type === 'forward' && card.sessionId === snapshot.assistant.sessionId && (!newest || card.at > newest.at)) newest = card;
  }
  return newest;
}

export function ForwardCard({ card, snapshot, now, openMatter, whole = false, close }: {
  card: ForwardCardView;
  snapshot: BoardSnapshot;
  now: number;
  /** Opens the matter's conversation. */
  openMatter: (matterId: string) => void;
  /** The whole reply, as under my dsh's input; otherwise its first line. */
  whole?: boolean;
  /** 收起, where the card can be put away. */
  close?: () => void;
}) {
  const matter = snapshot.matters.find(candidate => candidate.id === card.matterId);
  const conversation = matter?.conversation?.sessionId === card.conversationId ? matter.conversation : undefined;
  const asking = snapshot.attention.find(session => session.id === card.conversationId);
  const state = card.latest ? forwardState(conversation, asking, card.at, now) : undefined;
  const open = matter && !matter.archivedAt ? () => { openMatter(card.matterId); } : undefined;
  return (
    <section className={`mydsh-fw${whole ? ' is-whole' : ''}`} data-card={card.id} aria-label={`转给了「${matter?.name ?? card.matterName}」`}>
      <div className="mydsh-fw-head">
        <b>转给了「{matter?.name ?? card.matterName}」</b>
        <time>{when(card.at, now)}</time>
        <span className="mydsh-fw-links">
          {open && <button type="button" className="mydsh-link" onClick={open}>{card.latest ? '接着说' : '打开'}</button>}
          {close && <button type="button" className="mydsh-link is-quiet" onClick={close}>收起</button>}
        </span>
      </div>
      {state && <ForwardBody state={state} whole={whole} />}
    </section>
  );
}

const DOTS: Record<Exclude<ForwardState['kind'], 'reply'>, StateDotState> = { running: 'ongoing', waiting: 'warning', failed: 'error', queued: 'idle' };

function ForwardBody({ state, whole }: { state: ForwardState; whole: boolean }) {
  if (state.kind === 'reply') {
    return whole
      ? <div className="mydsh-fw-reply"><MarkdownText text={state.text} labels={LABELS} variant="compact" /></div>
      : <p className="mydsh-fw-line">{state.line}</p>;
  }
  const text = state.kind === 'running' ? '在回答' : state.kind === 'queued' ? '已送到，等它开始' : state.line;
  return <p className="mydsh-fw-state"><StateDot state={DOTS[state.kind]} /><span>{text}</span></p>;
}
