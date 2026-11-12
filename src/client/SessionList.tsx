/**
 * A matter's sessions on its page: what is in progress as cards on top (waiting, failed, running, and the matter's own conversation
 * while it waits or failed), then the idle ones as rows, newest first, the first five until 更早 is opened. An idle row has DSH's done
 * dot while DSH marks the session's finished turn unread, as DSH's sidebar does, and a … menu that takes the session out of the matter.
 */
import { useState } from 'react';
import { IconEllipsisOutlineRegular, Menu, StateDot, Tag, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardSession, SessionState } from '../host/remote.js';
import { waitingSince } from '../host/snapshot.js';
import { activate } from './parts.js';
import { foldIdle, lineOf, sessionArea } from './rows.js';
import { when } from './time.js';

/**
 * DSH's selector hook over each session's UI status, `useSessionStatus`: a standard prop every slot component gets from
 * `dsh-client-ui-session`. `completionUnread` is set when a session not on screen stops running, and cleared when it is opened.
 */
export type UseSessionStatus = <S>(select: (statuses: ReadonlyMap<string, { readonly completionUnread: boolean }>) => S, equal?: (a: S, b: S) => boolean) => S;

const DOT: Record<SessionState, StateDotState> = { waiting: 'warning', failed: 'error', running: 'ongoing', idle: 'idle' };

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** The tag on a session my dsh's tools opened. */
const Dispatched = ({ session }: { session: BoardSession }) => (session.by === 'mydsh' ? <Tag tone="neutral">派出去的</Tag> : null);

export function SessionList({ sessions, conversation, now, openSession, openConversation, remove, useSessionStatus, first = false }: {
  sessions: BoardSession[];
  /** The matter's conversation as 待处理 lists it, when it is there. */
  conversation?: BoardSession;
  now: number;
  openSession: (sessionId: string) => void;
  /** Where the conversation's card goes; without it the card opens the conversation's session. */
  openConversation?: () => void;
  /** Take a session out of the matter. */
  remove: (sessionId: string) => void;
  useSessionStatus: UseSessionStatus;
  /** The first thing in its column: no space above the heading. */
  first?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { cards, idle } = sessionArea(sessions, conversation);
  const ids = idle.map(session => session.id);
  // Only the listed sessions' unread marks: another session's status change does not draw the list again.
  const unread = useSessionStatus(statuses => ids.filter(id => statuses.get(id)?.completionUnread === true), sameIds);
  const { rows, rest } = foldIdle(idle, open);
  const count = sessions.filter(session => !session.archived).length;
  return (
    <section className="mydsh-sl">
      <h2 className={`mydsh-pj-list-head${first ? ' is-first' : ''}`}>会话<span className="mydsh-count">{count}</span></h2>
      {cards.length === 0 && idle.length === 0 && <p className="mydsh-empty">无</p>}
      {cards.length > 0 && (
        <div className="mydsh-sl-cards">
          {cards.map(({ session, conversation: own }) => {
            const line = lineOf(session, now);
            const openCard = own && openConversation ? openConversation : () => { openSession(session.id); };
            return (
              <article key={session.id} className={`mydsh-sl-card${session.state === 'waiting' ? ' is-waiting' : ''}`} {...activate(openCard)}>
                <div className="mydsh-sl-card-head">
                  <StateDot state={DOT[session.state]} />
                  <span className="mydsh-sl-card-title" title={session.title}>{session.title}</span>
                  <Dispatched session={session} />
                </div>
                <p className="mydsh-sl-card-line"><span>{line}</span><time>{when(waitingSince(session), now)}</time></p>
              </article>
            );
          })}
        </div>
      )}
      {idle.length > 0 && (
        <>
          <p className="mydsh-sl-group">空闲中 · {idle.length}</p>
          <div className="mydsh-pj-rows">
            {rows.map(session => (
              <IdleRow key={session.id} session={session} unread={unread.includes(session.id)} now={now} openSession={openSession} remove={remove} />
            ))}
          </div>
          {rest > 0 && (
            <button type="button" className="mydsh-link is-quiet mydsh-sl-toggle" onClick={() => { setOpen(!open); }}>{open ? '收起' : `更早 · ${rest} ›`}</button>
          )}
        </>
      )}
    </section>
  );
}

/** An idle session's row: its dot, title with the tag, line, time, and a … menu with 移出事项. */
function IdleRow({ session, unread, now, openSession, remove }: {
  session: BoardSession; unread: boolean; now: number; openSession: (sessionId: string) => void; remove: (sessionId: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className={`mydsh-pj-row mydsh-sl-row${menu ? ' is-menu' : ''}`} {...activate(() => { openSession(session.id); })}>
      {/* DSH's sidebar draws the same unread mark as the done dot; the list follows it. */}
      <span className={unread ? 'is-unread' : undefined}><StateDot state={unread ? 'done' : 'idle'} /></span>
      <span className="mydsh-pj-row-path"><b>{session.title}</b><Dispatched session={session} /></span>
      <span className="mydsh-pj-row-line">{lineOf(session, now)}</span>
      <time>{when(session.lastActivity, now)}</time>
      {/* A click on the menu, including its items, which bubble here through the portal, stays out of the row. */}
      <span className="mydsh-sl-more" onClick={(event) => { event.stopPropagation(); }}>
        <Menu
          open={menu}
          align="end"
          onClose={() => { setMenu(false); }}
          anchor={(
            <button type="button" className={`mydsh-icon-button${menu ? ' is-on' : ''}`} aria-label="更多" onClick={() => { setMenu(!menu); }}>
              <IconEllipsisOutlineRegular size={15} />
            </button>
          )}
          items={[{ id: 'remove', label: '移出事项' }]}
          onSelect={() => { setMenu(false); remove(session.id); }}
        />
      </span>
    </div>
  );
}
