import { useEffect, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Button, IconArchiveOutlineRegular, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconPlusOutlineRegular, Menu, StateDot, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardMatter, BoardSession, BoardSnapshot, ReviewDay } from '../host/remote.js';
import type { BoardSource } from './board-source.js';
import type { Dialogs } from './dialogs.js';
import type { Call } from './index.js';
import { clock, dayTitle, when } from './time.js';

export interface BoardPageProps {
  source: BoardSource;
  call: Call;
  dialogs: Dialogs;
  openSession: (sessionId: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Enter or Space on a focusable row does what a click does. */
const activate = (run: () => void) => ({
  role: 'button',
  tabIndex: 0,
  onClick: run,
  onKeyDown: (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    run();
  },
});

/** A click on a control inside a clickable card stays with the control. */
const only = (run: () => void) => (event: MouseEvent) => { event.stopPropagation(); run(); };

/** Waiting is amber, running spins, failed is red; an idle session shows nothing, or the grey dot where a row needs a mark. */
function StateMark({ session, idle = false }: { session: BoardSession; idle?: boolean }) {
  switch (session.state) {
    case 'waiting': return <StateDot state="warning" />;
    case 'running': return <StateDot state="ongoing" />;
    case 'failed': return <StateDot state="error" />;
    default: return idle ? <StateDot state="idle" /> : null;
  }
}

/** The board page: the board of matters, or one matter's view. */
export function BoardPage({ source, call, dialogs, openSession }: BoardPageProps) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [matterId, setMatterId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Re-render each minute, so 刚刚 and today's times do not go stale between changes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => { setTick(tick => tick + 1); }, 60_000);
    return () => { clearInterval(timer); };
  }, []);

  const act = (run: () => Promise<unknown>) => {
    setFailure(null);
    void run().then(() => source.refresh(), (error: unknown) => { setFailure(message(error)); });
  };

  if (state.status !== 'ready') {
    return (
      <Page>
        <header className="mydsh-head"><h1>看板</h1></header>
        {state.status === 'loading' ? <p className="mydsh-quiet">正在读取</p> : <p className="mydsh-error">读不到看板：{state.error}</p>}
      </Page>
    );
  }
  const snapshot = state.snapshot;
  const notice = failure ?? state.error ?? null;
  const matter = matterId ? snapshot.matters.find(candidate => candidate.id === matterId) : undefined;
  if (matter) {
    return (
      <MatterView
        matter={matter}
        now={Date.now()}
        notice={notice}
        back={() => { setMatterId(null); setFailure(null); }}
        openSession={openSession}
        rename={() => { dialogs.open({ kind: 'rename', matterId: matter.id, name: matter.name }); }}
        editGoal={() => { dialogs.open({ kind: 'goal', matterId: matter.id, goal: matter.goal }); }}
        archive={() => { act(() => call({ action: matter.archivedAt ? 'unarchiveMatter' : 'archiveMatter', id: matter.id })); }}
        remove={(sessionId) => { act(() => call({ action: 'removeSession', sessionId })); }}
      />
    );
  }
  return (
    <BoardView
      snapshot={snapshot}
      now={Date.now()}
      notice={notice}
      openSession={openSession}
      openMatter={(id) => { setMatterId(id); setFailure(null); }}
      create={() => { dialogs.open({ kind: 'create' }); }}
    />
  );
}

function Page({ children }: { children: ReactNode }) {
  return <main className="mydsh-page"><div className="mydsh-column">{children}</div></main>;
}

function BoardView({ snapshot, now, notice, openSession, openMatter, create }: {
  snapshot: BoardSnapshot;
  now: number;
  notice: string | null;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
  create: () => void;
}) {
  const active = snapshot.matters.filter(matter => !matter.archivedAt);
  const archived = snapshot.matters.filter(matter => matter.archivedAt);
  return (
    <Page>
      <header className="mydsh-head"><h1>看板</h1></header>
      {notice && <p className="mydsh-error">{notice}</p>}
      <section className="mydsh-section">
        <div className="mydsh-section-head">
          <h2>进行中<span className="mydsh-count">{active.length}</span></h2>
          <Button variant="ghost" size="sm" className="mydsh-new" icon={<IconPlusOutlineRegular size={14} />} onClick={create}>新建事项</Button>
        </div>
        {active.length
          ? <div className="mydsh-grid">{active.map(matter => <MatterCard key={matter.id} matter={matter} now={now} openMatter={openMatter} openSession={openSession} />)}</div>
          : <p className="mydsh-empty">无</p>}
        {archived.length > 0 && <ArchivedMatters matters={archived} now={now} openMatter={openMatter} />}
      </section>
      <section className="mydsh-section">
        <div className="mydsh-section-head"><h2>回顾</h2></div>
        <Review days={snapshot.review} now={now} openSession={openSession} openMatter={openMatter} />
      </section>
    </Page>
  );
}

function MatterCard({ matter, now, openMatter, openSession }: {
  matter: BoardMatter;
  now: number;
  openMatter: (matterId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  const open = () => { openMatter(matter.id); };
  return (
    <article className="mydsh-card" onClick={open}>
      <div className="mydsh-card-head">
        <h3><button type="button" className="mydsh-card-name" onClick={only(open)}>{matter.name}</button></h3>
        {matter.sessions.length > 0 && <time>{when(matter.lastActivity, now)}</time>}
      </div>
      {matter.goal && <p className="mydsh-card-goal">{matter.goal}</p>}
      {matter.sessions.length
        ? (
          <div className="mydsh-card-rows">
            {matter.sessions.slice(0, 3).map(session => (
              <button type="button" key={session.id} className="mydsh-line" title={session.title} onClick={only(() => { openSession(session.id); })}>
                <time>{when(session.lastActivity, now)}</time>
                <span className="mydsh-mark"><StateMark session={session} /></span>
                <span className="mydsh-line-title">{session.title}</span>
              </button>
            ))}
          </div>
        )
        : <p className="mydsh-card-empty">还没有会话</p>}
    </article>
  );
}

function Fold({ open, toggle, head, children, className = '' }: { open: boolean; toggle: () => void; head: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mydsh-fold${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <button type="button" className="mydsh-fold-head" aria-expanded={open} onClick={toggle}>
        {head}
        <IconChevronDownOutlineRegular size={12} className="mydsh-fold-chevron" />
      </button>
      {open && children}
    </section>
  );
}

function ArchivedMatters({ matters, now, openMatter }: { matters: BoardMatter[]; now: number; openMatter: (matterId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Fold open={open} toggle={() => { setOpen(!open); }} head={<>已归档 {matters.length} 件</>} className="mydsh-archived">
      <div className="mydsh-fold-list">
        {matters.map(matter => (
          <div key={matter.id} className="mydsh-archived-row" {...activate(() => { openMatter(matter.id); })}>
            <span className="mydsh-archived-lead"><IconArchiveOutlineRegular size={14} /></span>
            <div className="mydsh-archived-body">
              <p className="mydsh-archived-title"><b>{matter.name}</b>{matter.archivedAt && <span>{when(Date.parse(matter.archivedAt), now)}</span>}</p>
              {matter.goal && <p className="mydsh-archived-goal">{matter.goal}</p>}
            </div>
          </div>
        ))}
      </div>
    </Fold>
  );
}

function Review({ days, now, openSession, openMatter }: {
  days: ReviewDay[];
  now: number;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
}) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  if (days.length === 0) return <p className="mydsh-empty">无</p>;
  return (
    <div className="mydsh-review">
      {days.map((day) => {
        const open = opened[day.day] ?? day.daysAgo <= 1;
        const title = dayTitle(day, now);
        return (
          <Fold
            key={day.day}
            open={open}
            toggle={() => { setOpened({ ...opened, [day.day]: !open }); }}
            head={<>{title.label}{title.date && <span className="mydsh-fold-date">{title.date}</span>}</>}
          >
            <div className="mydsh-fold-list mydsh-review-list">
              {day.sessions.map(session => (
                <div key={session.id} className="mydsh-review-row" {...activate(() => { openSession(session.id); })}>
                  <time>{clock(session.lastActivity)}</time>
                  <span className="mydsh-review-mark"><StateMark session={session} idle /></span>
                  <p className="mydsh-review-title">
                    <b>{session.title}</b>
                    {session.matter && (
                      <button type="button" className="mydsh-review-matter" onClick={only(() => { openMatter(session.matter!.id); })}>{session.matter.name}</button>
                    )}
                  </p>
                </div>
              ))}
            </div>
          </Fold>
        );
      })}
    </div>
  );
}

const COLUMNS = [['waiting', '等待输入'], ['running', '工作中'], ['idle', '空闲中']] as const;
const column = (session: BoardSession): typeof COLUMNS[number][0] => (session.state === 'failed' ? 'idle' : session.state);
const STEP: Partial<Record<string, string>> = { question: '在等你回答', approval: '在等你批准' };

function MatterView({ matter, now, notice, back, openSession, rename, editGoal, archive, remove }: {
  matter: BoardMatter;
  now: number;
  notice: string | null;
  back: () => void;
  openSession: (sessionId: string) => void;
  rename: () => void;
  editGoal: () => void;
  archive: () => void;
  remove: (sessionId: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const facts = [matter.goal, `${matter.sessions.length} 个会话`, matter.archivedAt ? '已归档' : ''].filter(Boolean).join(' · ');
  return (
    <Page>
      <header className="mydsh-matter-head">
        <nav className="mydsh-crumbs">
          <button type="button" className="mydsh-crumb" onClick={back}>看板</button>
          <span className="mydsh-crumb-sep">/</span>
          <span className="mydsh-crumb is-current">{matter.name}</span>
        </nav>
        <Menu
          open={menu}
          align="end"
          onClose={() => { setMenu(false); }}
          anchor={(
            <button type="button" className={`mydsh-icon-button${menu ? ' is-on' : ''}`} aria-label="更多" onClick={() => { setMenu(!menu); }}>
              <IconEllipsisOutlineRegular size={15} />
            </button>
          )}
          items={[{ id: 'rename', label: '改名' }, { id: 'goal', label: '改目标' }, { id: 'archive', label: matter.archivedAt ? '恢复' : '归档' }]}
          onSelect={(id) => {
            setMenu(false);
            if (id === 'rename') rename();
            else if (id === 'goal') editGoal();
            else archive();
          }}
        />
      </header>
      <p className="mydsh-matter-facts">{facts}</p>
      {notice && <p className="mydsh-error">{notice}</p>}
      <div className="mydsh-columns">
        {COLUMNS.map(([key, label]) => {
          const sessions = matter.sessions.filter(session => column(session) === key);
          return (
            <section key={key} className="mydsh-col">
              <h4>{label}<span className="mydsh-count">{sessions.length}</span></h4>
              {sessions.length
                ? sessions.map(session => <SessionCard key={session.id} session={session} now={now} openSession={openSession} remove={remove} />)
                : <p className="mydsh-empty">无</p>}
            </section>
          );
        })}
      </div>
    </Page>
  );
}

function SessionCard({ session, now, openSession, remove }: {
  session: BoardSession;
  now: number;
  openSession: (sessionId: string) => void;
  remove: (sessionId: string) => void;
}) {
  const open = () => { openSession(session.id); };
  const failed = session.state === 'failed';
  const step = failed ? '失败' : session.state === 'waiting' && session.wait ? STEP[session.wait] : undefined;
  return (
    <article className="mydsh-session" onClick={open}>
      <div className="mydsh-session-head">
        <span className="mydsh-mark"><StateMark session={session} /></span>
        <span className="mydsh-session-title" title={session.title}>{session.title}</span>
        {session.archived && <Tag tone="outline">已归档</Tag>}
        <time>{when(session.lastActivity, now)}</time>
      </div>
      {step && <p className={`mydsh-session-step${failed ? ' is-failed' : ''}`}>{step}</p>}
      <div className="mydsh-session-foot">
        <span className="mydsh-session-workspace">{session.workspace ?? ''}</span>
        <span className="mydsh-session-actions">
          <button type="button" className="mydsh-link" onClick={only(open)}>打开</button>
          <button type="button" className="mydsh-link" onClick={only(() => { remove(session.id); })}>移出</button>
        </span>
      </div>
    </article>
  );
}
