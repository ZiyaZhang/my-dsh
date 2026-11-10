import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import {
  Button, HoverCard, HoverCardGroup, IconArchiveOutlineRegular, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconPlusOutlineRegular, Menu,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardMatter, BoardSession, BoardSnapshot, ReviewDay } from '../host/remote.js';
import { ActivityDialog } from './ActivityDialog.js';
import { SourceChip } from './ContextFields.js';
import type { BoardSource } from './board-source.js';
import { Dock, type DockSlots, type OpenDock } from './Dock.js';
import type { Dialogs } from './dialogs.js';
import type { Call } from './index.js';
import { StateMark, activate, only, useMinuteTick } from './parts.js';
import { Rail } from './Rail.js';
import { columnCounts, dayOpen, lineOf } from './rows.js';
import { clock, dayTitle, when } from './time.js';

export interface BoardPageProps {
  source: BoardSource;
  call: Call;
  dialogs: Dialogs;
  openSession: (sessionId: string) => void;
  openDock: OpenDock;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Narrower than this, the page folds the right column away and the board and the dock take the width. */
const RAIL_PAGE_MIN = 1_100;

/** Whether the element is at least `min` pixels wide, kept current as it resizes; the page re-renders only when that flips. */
function useWideEnough(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setWide(element.getBoundingClientRect().width >= min);
    const observer = new ResizeObserver(([entry]) => { if (entry) setWide(entry.contentRect.width >= min); });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [ref, min]);
  return wide;
}

/**
 * The page: the board of matters or one matter's view on top, scrolling, with my dsh's conversation docked below; the right column of
 * 等你处理 and 跟进事项 runs the full height beside both while the page is wide enough.
 */
export function BoardPage({ source, call, dialogs, openSession, openDock, renderSlot, SessionProvider }: BoardPageProps & DockSlots) {
  const [activity, setActivity] = useState(false);
  const [matterId, setMatterId] = useState<string | null>(null);
  const page = useRef<HTMLElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const wide = useWideEnough(page, RAIL_PAGE_MIN);
  // A matter opened from the right column or a card starts at its top, not where the board was scrolled to.
  useEffect(() => { board.current?.scrollTo({ top: 0 }); }, [matterId]);
  return (
    <main className="mydsh-page" ref={page}>
      <div className="mydsh-main">
        <div className="mydsh-board" ref={board}>
          <div className="mydsh-column">
            <BoardContent source={source} call={call} dialogs={dialogs} openSession={openSession} matterId={matterId} openMatter={setMatterId} />
          </div>
        </div>
        <Dock openDock={openDock} renderSlot={renderSlot} SessionProvider={SessionProvider} openSession={openSession} showActivity={() => { setActivity(true); }} />
      </div>
      {wide && <Rail source={source} openSession={openSession} openMatter={setMatterId} />}
      {activity && <ActivityDialog close={() => { setActivity(false); }} call={call} source={source} />}
    </main>
  );
}

function BoardContent({ source, call, dialogs, openSession, matterId, openMatter }: Omit<BoardPageProps, 'openDock'> & {
  matterId: string | null;
  openMatter: (matterId: string | null) => void;
}) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [failure, setFailure] = useState<string | null>(null);
  useMinuteTick();
  // A failure belongs to the view it happened in.
  useEffect(() => { setFailure(null); }, [matterId]);

  const act = (run: () => Promise<unknown>) => {
    setFailure(null);
    void run().then(() => source.refresh(), (error: unknown) => { setFailure(message(error)); });
  };

  if (state.status !== 'ready') {
    return (
      <Page>
        <header className="mydsh-head"><h1>my dsh</h1></header>
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
        back={() => { openMatter(null); }}
        openSession={openSession}
        rename={() => { dialogs.open({ kind: 'rename', matterId: matter.id, name: matter.name }); }}
        editGoal={() => { dialogs.open({ kind: 'goal', matterId: matter.id, goal: matter.goal }); }}
        editContext={() => { dialogs.open({ kind: 'context', matterId: matter.id }); }}
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
      openMatter={openMatter}
      create={() => { dialogs.open({ kind: 'create' }); }}
    />
  );
}

function Page({ children }: { children: ReactNode }) {
  return <>{children}</>;
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
      <header className="mydsh-head"><h1>my dsh</h1></header>
      {notice && <p className="mydsh-error">{notice}</p>}
      <section className="mydsh-section">
        <div className="mydsh-section-head">
          <h2>事项<span className="mydsh-count">进行中 {active.length}</span></h2>
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
          <HoverCardGroup className="mydsh-card-rows">
            {matter.sessions.slice(0, 3).map(session => (
              <HoverCard
                key={session.id}
                grouped
                openDelayMs={800}
                anchor={(
                  <button type="button" className="mydsh-line" onClick={only(() => { openSession(session.id); })}>
                    <time>{when(session.lastActivity, now)}</time>
                    <span className="mydsh-mark"><StateMark state={session.state} /></span>
                    <span className="mydsh-line-title">{session.title}</span>
                  </button>
                )}
                content={<SessionHover session={session} now={now} />}
              />
            ))}
          </HoverCardGroup>
        )
        : <p className="mydsh-card-empty">还没有会话</p>}
    </article>
  );
}

/** What a card row shows on hover, as DSH's sidebar does for its session rows: the title, the line, the workspace and time. */
function SessionHover({ session, now }: { session: BoardSession; now: number }) {
  const line = lineOf(session, now);
  return (
    <div className="mydsh-hover">
      <p className="mydsh-hover-title">{session.title}</p>
      {line && <p className="mydsh-hover-text">{line}</p>}
      <p className="mydsh-hover-text">{[session.workspace, when(session.lastActivity, now)].filter(Boolean).join(' · ')}</p>
    </div>
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

/** 回顾: one box per day, 今天 and 昨天 open; a row per session with its time, state, title, matter and line. */
function Review({ days, now, openSession, openMatter }: {
  days: ReviewDay[];
  now: number;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
}) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (days.length === 0) return <p className="mydsh-empty">无</p>;
  return (
    <div className="mydsh-review">
      {days.map((day) => {
        const open = dayOpen(day, toggled);
        const title = dayTitle(day, now);
        return (
          <Fold
            key={day.day}
            open={open}
            toggle={() => { setToggled({ ...toggled, [day.day]: !open }); }}
            head={<>{title.label}{title.date && <span className="mydsh-fold-date">{title.date}</span>}</>}
          >
            <div className="mydsh-fold-list mydsh-review-list">
              {day.sessions.map((session) => {
                const line = lineOf(session, now);
                return (
                  <div key={session.id} className="mydsh-review-row" {...activate(() => { openSession(session.id); })}>
                    <time>{clock(session.lastActivity)}</time>
                    <span className="mydsh-review-mark"><StateMark state={session.state} idle /></span>
                    <div className="mydsh-review-body">
                      <p className="mydsh-review-title">
                        <b>{session.title}</b>
                        {session.matter && (
                          <button type="button" className="mydsh-review-matter" onClick={only(() => { openMatter(session.matter!.id); })}>{session.matter.name}</button>
                        )}
                      </p>
                      {line && <p className="mydsh-review-line">{line}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Fold>
        );
      })}
    </div>
  );
}

const COLUMNS = [['waiting', '等待输入'], ['running', '工作中'], ['idle', '空闲中']] as const;
const column = (session: BoardSession): typeof COLUMNS[number][0] => (session.state === 'failed' ? 'idle' : session.state);

function MatterView({ matter, now, notice, back, openSession, rename, editGoal, editContext, archive, remove }: {
  matter: BoardMatter;
  now: number;
  notice: string | null;
  back: () => void;
  openSession: (sessionId: string) => void;
  rename: () => void;
  editGoal: () => void;
  editContext: () => void;
  archive: () => void;
  remove: (sessionId: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const facts = [matter.goal, `${matter.sessions.length} 个会话`, matter.archivedAt ? '已归档' : ''].filter(Boolean).join(' · ');
  const counts = columnCounts(matter.sessions);
  return (
    <Page>
      <header className="mydsh-matter-head">
        <nav className="mydsh-crumbs">
          <button type="button" className="mydsh-crumb" onClick={back}>my dsh</button>
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
          items={[
            { id: 'rename', label: '改名' }, { id: 'goal', label: '改目标' }, { id: 'context', label: '编辑上下文' },
            { id: 'archive', label: matter.archivedAt ? '恢复' : '归档' },
          ]}
          onSelect={(id) => {
            setMenu(false);
            if (id === 'rename') rename();
            else if (id === 'goal') editGoal();
            else if (id === 'context') editContext();
            else archive();
          }}
        />
      </header>
      <div className="mydsh-matter-bar">
        <p className="mydsh-matter-facts">{facts}</p>
        <p className="mydsh-matter-counts">
          <span className={counts.waiting ? 'is-waiting' : ''}><b>{counts.waiting}</b>等待输入</span>
          <span className={counts.running ? 'is-running' : ''}><b>{counts.running}</b>工作中</span>
          <span><b>{counts.idle}</b>空闲中</span>
        </p>
      </div>
      <MatterContext matter={matter} />
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

/** The matter's context under its header line: main workspace, instructions, sources. */
function MatterContext({ matter }: { matter: BoardMatter }) {
  if (!matter.workspace && !matter.instructions && matter.sources.length === 0) return null;
  return (
    <dl className="mydsh-matter-context">
      {matter.workspace && <div><dt>主工作区</dt><dd>{matter.workspace.title}</dd></div>}
      {matter.instructions && <div><dt>指令</dt><dd className="mydsh-matter-instructions">{matter.instructions}</dd></div>}
      {matter.sources.length > 0 && (
        <div><dt>来源</dt><dd className="mydsh-chips">{matter.sources.map(source => <SourceChip key={source.value} source={source} />)}</dd></div>
      )}
    </dl>
  );
}

function SessionCard({ session, now, openSession, remove }: {
  session: BoardSession;
  now: number;
  openSession: (sessionId: string) => void;
  remove: (sessionId: string) => void;
}) {
  const open = () => { openSession(session.id); };
  const line = lineOf(session, now);
  return (
    <article className="mydsh-session" onClick={open}>
      <div className="mydsh-session-head">
        <span className="mydsh-mark"><StateMark state={session.state} idle /></span>
        <span className="mydsh-session-title" title={session.title}>{session.title}</span>
        {session.archived && <Tag tone="outline">已归档</Tag>}
        <time>{when(session.lastActivity, now)}</time>
      </div>
      {line && <p className="mydsh-session-line">{line}</p>}
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
