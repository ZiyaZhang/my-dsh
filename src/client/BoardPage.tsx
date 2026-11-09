import { useEffect, useState } from 'react';
import type { BoardMatter } from '../host/remote.js';
import type { Call } from './index.js';

type State = { kind: 'loading' } | { kind: 'ready'; matters: BoardMatter[] } | { kind: 'failed'; message: string };

/** The board page. This first version reads the matters from the Host and lists the ones in progress. */
export function BoardPage({ call }: { call: Call; openSession: (sessionId: string) => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useEffect(() => {
    const abort = new AbortController();
    call({ action: 'snapshot' }, abort.signal)
      .then(response => setState({ kind: 'ready', matters: response.matters }))
      .catch((error: unknown) => { if (!abort.signal.aborted) setState({ kind: 'failed', message: String((error as Error)?.message ?? error) }); });
    return () => abort.abort();
  }, [call]);
  const active = state.kind === 'ready' ? state.matters.filter(matter => !matter.archivedAt) : [];
  return (
    <main className="mydsh-page">
      <header className="mydsh-head"><h1>看板</h1></header>
      <section className="mydsh-section">
        <h2>进行中<span className="mydsh-count">{state.kind === 'ready' ? active.length : ''}</span></h2>
        {state.kind === 'loading' && <p className="mydsh-quiet">正在读取事项</p>}
        {state.kind === 'failed' && <p className="mydsh-error">读不到事项：{state.message}</p>}
        {state.kind === 'ready' && active.length === 0 && <p className="mydsh-quiet">还没有事项</p>}
        {active.map(matter => (
          <article key={matter.id} className="mydsh-card">
            <h3>{matter.name}</h3>
            <p>{matter.goal}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
