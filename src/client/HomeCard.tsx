/**
 * The card under my dsh's input. First a row for each thing that needs the user: the coloured word for what it needs (等待审批 and
 * 等待回答 in amber, 失败 in red), the session's title and its matter in grey; a row opens its session. Then a row for each suggestion
 * of automatic grouping: 建事项「name」 with how many sessions in grey, or 「title」归进 a matter, with × on hover, which declines it.
 * Three rows show; the rest fold into 还有 N 条, which lists them in DSH's menu. A suggestion opens in the card as a proposal: what it
 * makes, its goal, its sessions with their dates (each opens its session), the main workspace and why, with 不要 and 新起 (归进 for a
 * filing); a decision, or 返回 without one, brings the rows back. With nothing to show there is no card.
 */
import { useEffect, useState } from 'react';
import { Button, IconChevronDownOutlineRegular, IconCloseOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SuggestionView } from '../host/remote.js';
import type { Call } from './index.js';
import { foldHomeCard, suggestionTitle, type HomeCardRow, type SuggestionCardRow } from './rows.js';
import { when } from './time.js';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A row's menu id: a session and a suggestion may not share one. */
const rowKey = (row: HomeCardRow) => `${row.kind}:${row.id}`;

function RowText({ row }: { row: HomeCardRow }) {
  if (row.kind === 'suggestion') {
    return (
      <>
        <span className="mydsh-hc-title">{row.text}</span>
        {row.note && <span className="mydsh-hc-note">{row.note}</span>}
      </>
    );
  }
  return (
    <>
      <span className={`mydsh-hc-word${row.failed ? ' is-failed' : ''}`}>{row.word}</span>
      <span className="mydsh-hc-title">{row.title}</span>
      {row.matter && <span className="mydsh-hc-matter">{row.matter.name}</span>}
    </>
  );
}

export function HomeCard({ rows, now, openSession, call, refresh }: {
  rows: readonly HomeCardRow[];
  now: number;
  openSession: (sessionId: string) => void;
  call: Call;
  /** Reads the board again. */
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  /** The suggestion shown as a proposal. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposal = chosen === null ? undefined : rows.find((row): row is SuggestionCardRow => row.kind === 'suggestion' && row.id === chosen)?.suggestion;
  // A suggestion decided elsewhere, or no longer shown, takes the card back to its rows.
  useEffect(() => { if (chosen !== null && !proposal) setChosen(null); }, [chosen, proposal]);

  const decide = (id: string, accept: boolean) => {
    setBusy(true);
    setError(null);
    const request: Promise<unknown> = accept ? call({ action: 'acceptSuggestion', id }) : call({ action: 'declineSuggestion', id });
    request
      .then(async () => { setChosen(null); await refresh(); })
      .catch((failure: unknown) => { setError(message(failure)); })
      .finally(() => { setBusy(false); });
  };

  if (proposal) {
    return (
      <Proposal
        suggestion={proposal} now={now} busy={busy} error={error} openSession={openSession}
        decide={(accept) => { decide(proposal.id, accept); }} back={() => { setChosen(null); setError(null); }}
      />
    );
  }
  if (rows.length === 0) return null;
  const { shown, rest } = foldHomeCard(rows);
  const choose = (row: HomeCardRow) => {
    if (row.kind === 'waiting') { openSession(row.id); return; }
    setError(null);
    setChosen(row.id);
  };
  const items: MenuEntry[] = rest.map(row => ({ id: rowKey(row), label: <span className="mydsh-hc-option"><RowText row={row} /></span> }));
  return (
    <section className="mydsh-hc" data-mydsh-section="waiting" aria-label="待处理">
      {shown.map(row => (row.kind === 'waiting'
        ? <button key={rowKey(row)} type="button" className="mydsh-hc-row" onClick={() => { choose(row); }}><RowText row={row} /></button>
        : (
          <div key={rowKey(row)} className="mydsh-hc-row is-suggestion">
            <button type="button" className="mydsh-hc-open" onClick={() => { choose(row); }}><RowText row={row} /></button>
            <button type="button" className="mydsh-hc-x" aria-label="不要" title="不要" disabled={busy} onClick={() => { decide(row.id, false); }}>
              <IconCloseOutlineRegular size={12} />
            </button>
          </div>
        )))}
      {rest.length > 0 && (
        <Menu
          open={open}
          items={items}
          onSelect={(id) => {
            setOpen(false);
            const row = rest.find(candidate => rowKey(candidate) === id);
            if (row) choose(row);
          }}
          onClose={() => { setOpen(false); }}
          portal
          className="mydsh-hc-menu"
          anchor={(
            <button type="button" className={`mydsh-hc-row mydsh-hc-more${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => { setOpen(!open); }}>
              还有 {rest.length} 条<IconChevronDownOutlineRegular size={12} className="mydsh-hc-chevron" />
            </button>
          )}
        />
      )}
      {error !== null && <p className="mydsh-card-error mydsh-hc-error" role="alert">{error}</p>}
    </section>
  );
}

/** A suggestion as a proposal: its heading, goal, sessions, main workspace and why, then 不要 and 新起 or 归进. */
function Proposal({ suggestion, now, busy, error, openSession, decide, back }: {
  suggestion: SuggestionView;
  now: number;
  busy: boolean;
  error: string | null;
  openSession: (sessionId: string) => void;
  decide: (accept: boolean) => void;
  back: () => void;
}) {
  const title = suggestionTitle(suggestion);
  return (
    <section className="mydsh-hc is-proposal" aria-label={title}>
      <div className="mydsh-hc-head">
        <h3>{title}</h3>
        <button type="button" className="mydsh-link is-quiet" onClick={back}>返回</button>
      </div>
      {suggestion.goal && <p className="mydsh-hc-goal">目标：{suggestion.goal}</p>}
      <ul className="mydsh-hc-sessions">
        {suggestion.sessions.map(session => (
          <li key={session.id}>
            <button type="button" title={session.title} onClick={() => { openSession(session.id); }}>{session.title}</button>
            <time>{when(session.lastActivity, now)}</time>
          </li>
        ))}
      </ul>
      {suggestion.workspace && <p className="mydsh-hc-kv"><b>主工作区</b><span>{suggestion.workspace.title}</span></p>}
      <p className="mydsh-hc-kv"><b>为什么</b><span>{suggestion.why}</span></p>
      {error !== null && <p className="mydsh-card-error" role="alert">{error}</p>}
      <div className="mydsh-hc-buttons">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { decide(false); }}>不要</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { decide(true); }}>{suggestion.kind === 'new' ? '新起' : '归进'}</Button>
      </div>
    </section>
  );
}
