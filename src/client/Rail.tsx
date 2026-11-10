/**
 * The page's right column, beside both the board and the dock: 等你处理, the sessions that wait for the user or failed, and 跟进事项, the
 * matters in progress with a line about the newest session of each. DSH hides its own right bar on plugin pages, so the page draws this
 * one; it folds away when the page is narrow.
 */
import { useSyncExternalStore } from 'react';
import type { BoardSource } from './board-source.js';
import { StateMark, activate, only, useMinuteTick } from './parts.js';
import { followRows, waitingRows } from './rows.js';
import { when } from './time.js';

export function Rail({ source, openSession, openMatter }: {
  source: BoardSource;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
}) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useMinuteTick();
  if (state.status !== 'ready') return <aside className="mydsh-rail" aria-label="等你处理和跟进事项" />;
  const now = Date.now();
  const waiting = waitingRows(state.snapshot.attention, now);
  const follow = followRows(state.snapshot.matters, now);
  return (
    <aside className="mydsh-rail" aria-label="等你处理和跟进事项">
      <section className="mydsh-rail-part">
        <h2 className="mydsh-rail-head">等你处理{waiting.length > 0 && <span className="mydsh-count">{waiting.length}</span>}</h2>
        {waiting.length
          ? waiting.map(row => (
            <article key={row.id} className="mydsh-rail-card" {...activate(() => { openSession(row.id); })}>
              <div className="mydsh-rail-card-head">
                <span className="mydsh-mark"><StateMark state={row.state} /></span>
                <span className="mydsh-rail-title" title={row.title}>{row.title}</span>
                {row.matter && <span className="mydsh-rail-matter">{row.matter.name}</span>}
                <time>{when(row.at, now)}</time>
              </div>
              <div className="mydsh-rail-line">
                <p className="mydsh-rail-text">{row.line}</p>
                <button type="button" className="mydsh-link" onClick={only(() => { openSession(row.id); })}>打开</button>
              </div>
            </article>
          ))
          : <p className="mydsh-empty">无</p>}
      </section>
      <section className="mydsh-rail-part">
        <h2 className="mydsh-rail-head">跟进事项</h2>
        {follow.length
          ? follow.map(row => (
            <article key={row.id} className="mydsh-rail-card" {...activate(() => { openMatter(row.id); })}>
              <div className="mydsh-rail-card-head">
                <span className="mydsh-mark"><StateMark state={row.state} idle /></span>
                <span className="mydsh-rail-title is-name" title={row.name}>{row.name}</span>
                <time>{when(row.lastActivity, now)}</time>
              </div>
              <p className={`mydsh-rail-text${row.state ? '' : ' is-quiet'}`}>{row.line}</p>
            </article>
          ))
          : <p className="mydsh-empty">无</p>}
      </section>
    </aside>
  );
}
