import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import {
  Button, HoverCard, HoverCardGroup, IconArchiveOutlineRegular, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconFolderCloseRegular,
  IconPlusOutlineRegular, Menu, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardMatter, BoardSession, BoardSnapshot, ReviewDay } from '../host/remote.js';
import { ActivityDialog } from './ActivityDialog.js';
import { SourceChip } from './ContextFields.js';
import type { BoardSource } from './board-source.js';
import { Dock, type DockSlots, type OpenDock } from './Dock.js';
import type { Dialogs } from './dialogs.js';
import type { Call } from './index.js';
import { StateMark, activate, only, useMinuteTick } from './parts.js';
import { readLayout } from './layout.js';
import { MainHome, MainMatter } from './MainPage.js';
import type { PageRequests } from './pages.js';
import { MatterTabs, MyDshTabs, type DraftAsk, type Prefill, type Tab } from './TabsPage.js';
import { ProjectHome, ProjectMatter } from './ProjectPage.js';
import { Rail, RailParts } from './Rail.js';
import { columnCounts, dayOpen, dispatchedSessions, lineOf } from './rows.js';
import type { UseSessionStatus } from './SessionList.js';
import { clock, dayTitle, when } from './time.js';

export interface BoardPageProps {
  source: BoardSource;
  call: Call;
  dialogs: Dialogs;
  openSession: (sessionId: string) => void;
  openDock: OpenDock;
  /** Opens a matter's own conversation (made on first use) for its page. */
  openMatterDock: (matterId: string) => OpenDock;
  /** Puts words into the input of a conversation the page holds. */
  prefill: Prefill;
  /** Where the rest of my dsh asks the page to go: our tabs in DSH's right sidebar, and every way into a conversation. */
  pages: PageRequests;
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
export function BoardPage({ source, call, dialogs, openSession, openDock, openMatterDock, prefill, pages, renderSlot, SessionProvider, useSessionStatus }: BoardPageProps & DockSlots & {
  /** DSH's session status hook, a standard prop of every slot component; a matter's page reads its unread marks. */
  useSessionStatus: UseSessionStatus;
}) {
  const [activity, setActivity] = useState(false);
  const [matterId, setMatterId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('board');
  /** Words asked for a page's conversation input, with the page they are for (null: my dsh's). */
  const [draft, setDraft] = useState<{ matterId: string | null; ask: DraftAsk }>();
  const asks = useRef(0);
  /** Shows my dsh's page (null) or a matter's, on 看板 unless told otherwise. */
  const openMatter = useCallback((id: string | null, next: Tab = 'board') => { setMatterId(id); setTab(next); }, []);
  useEffect(() => {
    const go = () => {
      const request = pages.take();
      if (!request) return;
      openMatter(request.matterId, request.tab);
      if (request.draft) {
        asks.current += 1;
        setDraft({ matterId: request.matterId, ask: { text: request.draft, seq: asks.current } });
      }
    };
    go();
    return pages.listen(go);
  }, [pages, openMatter]);
  const draftFor = (id: string | null) => (draft && draft.matterId === id ? draft.ask : undefined);
  // One opener per matter, so the docks keep the session while the page shows that matter.
  const matterDock = useMemo(() => (matterId ? openMatterDock(matterId) : undefined), [openMatterDock, matterId]);
  const [layout] = useState(readLayout);
  const page = useRef<HTMLElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const wide = useWideEnough(page, RAIL_PAGE_MIN);
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  // A matter opened from the right column or a card starts at its top, not where the board was scrolled to.
  useEffect(() => { board.current?.scrollTo({ top: 0 }); }, [matterId]);
  const boardPart = (
    <div className="mydsh-board" ref={board}>
      <div className="mydsh-column">
        <BoardContent source={source} call={call} dialogs={dialogs} openSession={openSession} matterId={matterId} openMatter={openMatter} />
      </div>
    </div>
  );
  const dock = { openDock, renderSlot, SessionProvider, openSession, showActivity: () => { setActivity(true); } };
  const activityDialog = activity && <ActivityDialog close={() => { setActivity(false); }} call={call} source={source} />;
  const snapshot = state.status === 'ready' ? state.snapshot : undefined;
  /** 托管 for a matter: the preset its dispatched sessions run under, or null to stop. */
  const setHosting = (matter: BoardMatter) => async (preset: string | null) => {
    await call({ action: 'setHosting', id: matter.id, preset });
    await source.refresh();
  };
  /** The menu on a matter's folder page: its name, goal and context, and archiving. */
  const matterMenu = (matter: BoardMatter) => ({
    menu: [{ id: 'rename', label: '改名' }, { id: 'goal', label: '改目标' }, { id: 'context', label: '编辑上下文' }, { id: 'archive', label: matter.archivedAt ? '恢复' : '归档' }],
    onMenu: (id: string) => {
      if (id === 'rename') dialogs.open({ kind: 'rename', matterId: matter.id, name: matter.name });
      else if (id === 'goal') dialogs.open({ kind: 'goal', matterId: matter.id, goal: matter.goal });
      else if (id === 'context') dialogs.open({ kind: 'context', matterId: matter.id });
      else void call({ action: matter.archivedAt ? 'unarchiveMatter' : 'archiveMatter', id: matter.id }).then(() => source.refresh());
    },
  });
  if (layout === 'main' || layout === 'tabs') {
    const matter = matterId ? snapshot?.matters.find(candidate => candidate.id === matterId) : undefined;
    const conversation = <Dock {...dock} variant="main" />;
    // The tabs layout gives every matter its own conversation and the home page's two tabs.
    if (layout === 'tabs' && matter && snapshot && matterDock) {
      return (
        <main className="mydsh-page is-main" ref={page}>
          <MatterTabs
            key={matter.id}
            matter={matter}
            snapshot={snapshot}
            useSessionStatus={useSessionStatus}
            call={call}
            back={() => { openMatter(null); }}
            openSession={openSession}
            tab={tab}
            setTab={setTab}
            openDock={matterDock}
            prefill={prefill}
            draft={draftFor(matter.id)}
            onDraftTaken={() => { setDraft(undefined); }}
            composer={onSent => <Dock {...dock} openDock={matterDock} variant="top" onSent={onSent} />}
            conversation={<Dock {...dock} openDock={matterDock} variant="main" />}
            editContext={() => { dialogs.open({ kind: 'context', matterId: matter.id }); }}
            setHosting={setHosting(matter)}
            {...matterMenu(matter)}
          />
          {activityDialog}
        </main>
      );
    }
    // The main layout keeps its conversation page for a hosted matter and the folder page for the rest.
    if (matter && !matter.hosting) {
      return (
        <main className="mydsh-page is-project" ref={page}>
          <div className="mydsh-board" ref={board}>
            <ProjectMatter
              matter={matter}
              presets={snapshot?.presets ?? []}
              call={call}
              now={Date.now()}
              back={() => { setMatterId(null); }}
              openSession={openSession}
              editContext={() => { dialogs.open({ kind: 'context', matterId: matter.id }); }}
              setHosting={setHosting(matter)}
              useSessionStatus={useSessionStatus}
              {...matterMenu(matter)}
            />
          </div>
          {activityDialog}
        </main>
      );
    }
    return (
      <main className="mydsh-page is-main" ref={page}>
        {matter
          ? (
            <MainMatter
              matter={matter}
              call={call}
              back={() => { setMatterId(null); }}
              openSession={openSession}
              conversation={conversation}
              editContext={() => { dialogs.open({ kind: 'context', matterId: matter.id }); }}
            />
          )
          : layout === 'tabs'
            ? (
              <MyDshTabs
                source={source}
                call={call}
                dialogs={dialogs}
                openSession={openSession}
                openMatter={openMatter}
                showActivity={() => { setActivity(true); }}
                tab={tab}
                setTab={setTab}
                openDock={openDock}
                prefill={prefill}
                draft={draftFor(null)}
                onDraftTaken={() => { setDraft(undefined); }}
                composer={onSent => <Dock {...dock} variant="top" onSent={onSent} />}
                conversation={conversation}
              />
            )
            : <MainHome source={source} openSession={openSession} openMatter={openMatter} showActivity={() => { setActivity(true); }} conversation={conversation} />}
        {activityDialog}
      </main>
    );
  }
  if (layout === 'project') {
    const matter = matterId ? snapshot?.matters.find(candidate => candidate.id === matterId) : undefined;
    return (
      <main className="mydsh-page is-project" ref={page}>
        <div className="mydsh-board" ref={board}>
          {matter
            ? (
              <ProjectMatter
                matter={matter}
                presets={snapshot?.presets ?? []}
                call={call}
                now={Date.now()}
                back={() => { setMatterId(null); }}
                openSession={openSession}
                editContext={() => { dialogs.open({ kind: 'context', matterId: matter.id }); }}
                setHosting={setHosting(matter)}
                useSessionStatus={useSessionStatus}
                {...matterMenu(matter)}
              />
            )
            : (
              <ProjectHome
                source={source}
                dialogs={dialogs}
                openSession={openSession}
                openMatter={openMatter}
                showActivity={() => { setActivity(true); }}
                composer={<Dock {...dock} variant="top" />}
              />
            )}
        </div>
        {activityDialog}
      </main>
    );
  }
  if (layout === 'side') {
    return (
      <main className="mydsh-page is-side" ref={page}>
        {boardPart}
        <Dock {...dock} variant="side" top={<RailParts source={source} openSession={openSession} openMatter={openMatter} compact />} />
        {activityDialog}
      </main>
    );
  }
  if (layout === 'drawer') {
    const peek = state.status === 'ready' ? state.snapshot.assistant.line : undefined;
    return (
      <main className="mydsh-page is-drawer" ref={page}>
        <div className="mydsh-main">
          {boardPart}
          <Dock {...dock} variant="drawer" peek={peek} />
        </div>
        {wide && <Rail source={source} openSession={openSession} openMatter={openMatter} />}
        {activityDialog}
      </main>
    );
  }
  return (
    <main className="mydsh-page" ref={page}>
      <div className="mydsh-main">
        {boardPart}
        <Dock {...dock} />
      </div>
      {wide && <Rail source={source} openSession={openSession} openMatter={openMatter} />}
      {activityDialog}
    </main>
  );
}

function BoardContent({ source, call, dialogs, openSession, matterId, openMatter }: Omit<BoardPageProps, 'openDock' | 'openMatterDock' | 'prefill' | 'pages'> & {
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
        <Review days={snapshot.review} now={now} dispatched={dispatchedSessions(snapshot.matters)} openSession={openSession} />
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

/**
 * 回顾: a card per day, the newest open and the older days folded to how many sessions they had. An entry per session, opening it: its time,
 * its state's dot on the day's line, its title, what it did (its newest reply as the board has it), and chips for its matter, whether a
 * matter's conversation dispatched it, and its workspace.
 * @param dispatched - the sessions a matter's conversation or my dsh dispatched.
 */
export function Review({ days, now, dispatched, openSession }: {
  days: ReviewDay[];
  now: number;
  dispatched: ReadonlySet<string>;
  openSession: (sessionId: string) => void;
}) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (days.length === 0) return <p className="mydsh-empty">无</p>;
  return (
    <div className="mydsh-rv">
      {days.map((day, index) => {
        const open = dayOpen(day, index, toggled);
        const title = dayTitle(day, now);
        return (
          <section key={day.day} className={`mydsh-rv-day${open ? ' is-open' : ''}`}>
            <button type="button" className="mydsh-rv-head" aria-expanded={open} onClick={() => { setToggled({ ...toggled, [day.day]: !open }); }}>
              <b>{title.label}</b>
              {title.date && <span>{title.date}</span>}
              {open ? <IconChevronDownOutlineRegular size={12} className="mydsh-rv-chevron" /> : <span>· {day.sessions.length} 条会话</span>}
            </button>
            {open && (
              <div className="mydsh-rv-list">
                {day.sessions.map((session) => {
                  const line = lineOf(session, now);
                  return (
                    <div key={session.id} className="mydsh-rv-entry" {...activate(() => { openSession(session.id); })}>
                      <time>{clock(session.lastActivity)}</time>
                      <span className="mydsh-rv-mark"><span className="mydsh-mark"><StateMark state={session.state} idle /></span></span>
                      <div className="mydsh-rv-body">
                        <p className="mydsh-rv-title">{session.title}</p>
                        {line && <p className="mydsh-rv-text">{line}</p>}
                        {(session.matter || dispatched.has(session.id) || session.workspace) && (
                          <p className="mydsh-rv-chips">
                            {session.matter && <span><IconFolderCloseRegular size={12} />{session.matter.name}</span>}
                            {dispatched.has(session.id) && <span>派出去的</span>}
                            {session.workspace && <span>{session.workspace}</span>}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** The `dock` layout's columns of a matter's sessions by state; a failed session sits with the idle ones. */
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
        {session.by === 'mydsh' && <Tag tone="neutral">派出去的</Tag>}
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
