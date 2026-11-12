/**
 * 等你处理, the sessions that wait for the user or failed, and 跟进事项, the matters in progress with a line about the newest session of
 * each. In the `dock` and `drawer` layouts they make the page's right column, beside the board; DSH hides its own right bar on plugin
 * pages, so the page draws this one, and it folds away when the page is narrow. In the `side` layout they sit at the top of my dsh's
 * column, a part only while it has something, 跟进事项 one line per matter.
 */
import { useSyncExternalStore } from 'react';
import type { BoardSource } from './board-source.js';
import { StateMark, activate, only, useMinuteTick } from './parts.js';
import { followRows, waitingRows } from './rows.js';
import { when } from './time.js';

interface RailProps {
  source: BoardSource;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
}

export function Rail(props: RailProps) {
  return <aside className="mydsh-rail" aria-label="待处理和跟进事项"><RailParts {...props} /></aside>;
}

export function RailParts({ source, openSession, openMatter, compact = false }: RailProps & { compact?: boolean }) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useMinuteTick();
  if (state.status !== 'ready') return null;
  const now = Date.now();
  const waiting = waitingRows(state.snapshot.attention, now);
  const follow = followRows(state.snapshot.matters, now);
  const waitingPart = (
    <section className="mydsh-rail-part">
      <h2 className="mydsh-rail-head">待处理{waiting.length > 0 && <span className="mydsh-count">{waiting.length}</span>}</h2>
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
  );
  if (compact) {
    return (
      <>
        {waiting.length > 0 && waitingPart}
        {follow.length > 0 && (
          <section className="mydsh-rail-part">
            <h2 className="mydsh-rail-head">跟进事项</h2>
            <div className="mydsh-side-rows">
              {follow.map(row => (
                <button key={row.id} type="button" className="mydsh-side-row" onClick={() => { openMatter(row.id); }}>
                  <span className="mydsh-mark"><StateMark state={row.state} idle /></span>
                  <span className="mydsh-side-row-name">{row.name}</span>
                  <span className={`mydsh-side-row-line${row.state ? '' : ' is-quiet'}`}>{row.line}</span>
                  <time>{when(row.lastActivity, now)}</time>
                </button>
              ))}
            </div>
          </section>
        )}
      </>
    );
  }
  return (
    <>
      {waitingPart}
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
    </>
  );
}
