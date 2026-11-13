/**
 * The `tabs` layout's template, shared by my dsh's page and a matter's: a head (my dsh's name, numbers and whale; a matter's tile, name
 * over one line of numbers, and tools on the right) over the tabs 看板 and 对话, which switch inside the page. 看板 is the conversation's input on top of
 * the board; 对话 is the conversation with the board's short form in a column the user resizes or puts away (ChatSplit). A message sent from 看板's input
 * shows 对话, and so does every way into the conversation from elsewhere in my dsh (接着说, 在对话里接着说, 在对话里改, a card's matter).
 * Only the shown tab's composer is mounted: DSH gives a session's draft to one composer, so a second, hidden one would take the Enter.
 * The page holds the conversation's session itself, so switching tabs does not close it, the message just sent is already in the
 * conversation, and words meant for its input go in once the session is held. On my dsh's page the conversation is my dsh's; on a
 * matter's page it is the matter's own.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { IconChevronLeftOutlineRegular, IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardMatter, BoardSnapshot } from '../host/remote.js';
// The whale at its laptop, from the whale illustrations; the build inlines it as a data URL.
import whale from './art/whale-work.svg';
import type { BoardSource } from './board-source.js';
import { ChatSplit } from './ChatSplit.js';
import type { OpenDock } from './Dock.js';
import type { Dialogs } from './dialogs.js';
import type { Call } from './index.js';
import { ForwardCard, newestForward } from './Forward.js';
import { HomeCard } from './HomeCard.js';
import { HomeGroups, MatterGroups } from './MainPage.js';
import { useMinuteTick } from './parts.js';
import { HomeBoard, MatterBoard, MatterHeadTools, MatterSide, readDismissed, writeDismissed } from './ProjectPage.js';
import { homeCardRows, homeStats, matterCounts, type HomeStat } from './rows.js';
import type { UseSessionStatus } from './SessionList.js';

export type Tab = 'board' | 'chat';

/** Words another part of my dsh put into this page's conversation input; `seq` tells one ask from the next. */
export interface DraftAsk {
  text: string;
  seq: number;
}

/** When the user last put away the 转给了 card under my dsh's input. */
const FORWARD_DISMISSED = 'mydsh.forward.dismissed';

/** Puts words into a held session's input; false when DSH's input does not take them (the session is not held yet). */
export type Prefill = (sessionId: string, text: string) => boolean;

/** What the tabs give the board and the conversation: the composer with what goes under it, and the way to 对话 with words for its input. */
export interface TabParts {
  ask: (below?: ReactNode) => ReactNode;
  openChat: (text?: string) => void;
}

/**
 * The template. `board` draws 看板 around `ask`; `chat` draws 对话, given the way back to 看板 and to its own input.
 * @param draft - words asked for from elsewhere; a new `seq` shows 对话 and puts them in, and `onDraftTaken` lets the page forget them,
 * so the page does not put them in again when it comes back.
 */
export function TabsFrame({ head, label, tabsEnd, tab, setTab, openDock, prefill, draft, onDraftTaken, composer, board, chat }: {
  head: ReactNode;
  /** The tab list's accessible name. */
  label: string;
  /** What sits at the right end of the tabs' row. */
  tabsEnd?: ReactNode;
  tab: Tab;
  setTab: (tab: Tab) => void;
  /** Holds the conversation's session for the page's lifetime. */
  openDock: OpenDock;
  prefill: Prefill;
  draft?: DraftAsk | undefined;
  onDraftTaken?: () => void;
  /** The conversation's composer for 看板; `onSent` runs once it sent a message. */
  composer: (onSent: () => void) => ReactNode;
  board: (parts: TabParts) => ReactNode;
  chat: (parts: { showBoard: () => void; openChat: (text?: string) => void }) => ReactNode;
}) {
  const held = useRef<string | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const flush = () => {
    const sessionId = held.current;
    if (sessionId !== undefined && pending.current !== undefined && prefill(sessionId, pending.current)) pending.current = undefined;
  };
  useEffect(() => {
    const abort = new AbortController();
    let reference: { release(): void } | undefined;
    held.current = undefined;
    openDock(abort.signal).then((opened) => {
      if (abort.signal.aborted) { opened.reference.release(); return; }
      reference = opened.reference;
      held.current = opened.sessionId;
      flush();
    }, () => {
      // The conversation's own view says why it could not open, and offers to try again.
    });
    return () => { abort.abort(); reference?.release(); held.current = undefined; };
    // flush reads only refs and the latest prefill.
  }, [openDock]);
  // DSH's input can take a draft a moment after the session is held; words still waiting go in on the next render.
  useEffect(flush);
  const openChat = (text?: string) => {
    if (text) {
      pending.current = text;
      flush();
    }
    setTab('chat');
  };
  useEffect(() => {
    if (!draft) return;
    openChat(draft.text);
    onDraftTaken?.();
  }, [draft?.seq]);
  const ask = (below?: ReactNode) => <div className="mydsh-pj-ask">{tab === 'board' && composer(() => { setTab('chat'); })}{below}</div>;
  return (
    <div className={`mydsh-tb is-${tab}`}>
      <header className="mydsh-tb-head">
        {head}
        <div className="mydsh-tb-row">
          <nav className="mydsh-tb-tabs" role="tablist" aria-label={label}>
            {(['board', 'chat'] as const).map(id => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => { setTab(id); }}>
                {id === 'board' ? '看板' : '对话'}
              </button>
            ))}
          </nav>
          {tabsEnd}
        </div>
      </header>
      <div className="mydsh-tb-board" hidden={tab !== 'board'}>{board({ ask, openChat })}</div>
      <div className="mydsh-tb-chat" hidden={tab !== 'chat'}>{tab === 'chat' && chat({ showBoard: () => { setTab('board'); }, openChat })}</div>
    </div>
  );
}

/** A page's head: the tile, the name over its line of numbers, and the tools at the right, at the top or (`middle`) level with the tile. */
function PageHead({ tile, title, line, tools, middle = false }: { tile: ReactNode; title: ReactNode; line: ReactNode; tools: ReactNode; middle?: boolean }) {
  return (
    <div className="mydsh-hd">
      {tile}
      <div className="mydsh-hd-text">
        <div className="mydsh-hd-title">{title}</div>
        <p className="mydsh-hd-line">{line}</p>
      </div>
      <div className={`mydsh-hd-tools${middle ? ' is-middle' : ''}`}>{tools}</div>
    </div>
  );
}

/** The sentence under my dsh's name, each part as `before <b>value</b> after`, the parts joined by commas. */
function HomeLine({ stats }: { stats: readonly HomeStat[] }) {
  return (
    <>
      {stats.map((stat, index) => (
        <span key={stat.key} className="mydsh-hd-stat" title={stat.title}>
          {stat.before}<b>{stat.value}</b>{stat.after}{index < stats.length - 1 && '，'}
        </span>
      ))}
    </>
  );
}

/** my dsh's head: the name over the sentence of numbers, and the whale at its laptop standing on the head's bottom line at the right. */
function HomeHead({ stats }: { stats: readonly HomeStat[] }) {
  return (
    <div className="mydsh-hh">
      <h1>my dsh</h1>
      <p className="mydsh-hh-line">{stats.length > 0 && <HomeLine stats={stats} />}</p>
      <img className="mydsh-hh-whale" src={whale} alt="" draggable={false} />
    </div>
  );
}

/** The 整页看 link at the head of 对话's column, back to 看板. */
const FullBoard = ({ showBoard }: { showBoard: () => void }) => <button type="button" className="mydsh-link is-quiet" onClick={showBoard}>整页看</button>;

/**
 * my dsh's page: the head with the numbers, then the home board under my dsh's input, and in 对话 my dsh's conversation beside the
 * board's short form. Under the input sit the newest 转给了 card until it is put away, with what the matter's conversation did with the
 * words (its 接着说 opens that conversation), and the card of what needs the user, which takes the place of the board's 待处理.
 */
export function MyDshTabs({ source, call, dialogs, openSession, openMatter, showActivity, tab, setTab, openDock, prefill, draft, onDraftTaken, composer, conversation }: {
  source: BoardSource;
  /** For the suggestions on the card under the input. */
  call: Call;
  dialogs: Dialogs;
  openSession: (sessionId: string) => void;
  /** Shows a matter's page on a tab, 看板 unless given. */
  openMatter: (matterId: string, tab?: Tab) => void;
  showActivity: () => void;
  tab: Tab;
  setTab: (tab: Tab) => void;
  /** Holds my dsh's session for the page's lifetime. */
  openDock: OpenDock;
  prefill: Prefill;
  draft?: DraftAsk | undefined;
  onDraftTaken?: () => void;
  /** my dsh's composer for 看板. */
  composer: (onSent: () => void) => ReactNode;
  /** my dsh's conversation for 对话. */
  conversation: ReactNode;
}) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const snapshot = state.status === 'ready' ? state.snapshot : undefined;
  const [dismissed, setDismissed] = useState(() => readDismissed(FORWARD_DISMISSED));
  useMinuteTick();
  const now = Date.now();
  const forward = snapshot ? newestForward(snapshot) : undefined;
  return (
    <TabsFrame
      head={<HomeHead stats={snapshot ? homeStats(snapshot, now) : []} />}
      label="my dsh"
      // 做事记录 shows once it has an entry.
      tabsEnd={(snapshot?.activity ?? 0) > 0 && <button type="button" className="mydsh-link is-quiet" onClick={showActivity}>做事记录</button>}
      tab={tab}
      setTab={setTab}
      openDock={openDock}
      prefill={prefill}
      draft={draft}
      onDraftTaken={onDraftTaken}
      composer={composer}
      board={({ ask }) => (
        <div className="mydsh-pj">
          {ask(snapshot && (
            <>
              {forward && forward.at > dismissed && (
                <ForwardCard
                  card={forward} snapshot={snapshot} now={now} whole openMatter={(matterId) => { openMatter(matterId, 'chat'); }}
                  close={() => { setDismissed(forward.at); writeDismissed(FORWARD_DISMISSED, forward.at); }}
                />
              )}
              <HomeCard rows={homeCardRows(snapshot.attention, snapshot.suggestions)} now={now} openSession={openSession} call={call} refresh={() => source.refresh()} />
            </>
          ))}
          {snapshot && <HomeBoard snapshot={snapshot} now={now} dialogs={dialogs} openSession={openSession} openMatter={openMatter} waiting={false} />}
          {state.status === 'failed' && <p className="mydsh-error">读不到看板：{state.error}</p>}
        </div>
      )}
      chat={({ showBoard }) => (
        <ChatSplit conversation={conversation} title="看板" tools={<FullBoard showBoard={showBoard} />}>
          {snapshot
            ? <HomeGroups snapshot={snapshot} now={now} openSession={openSession} openMatter={(matterId) => { openMatter(matterId); }} />
            : state.status === 'failed' ? <p className="mydsh-error">读不到看板：{state.error}</p> : <p className="mydsh-quiet">正在读取</p>}
        </ChatSplit>
      )}
    />
  );
}

/** {goal} · N 个会话 · N 条记忆. */
function MatterLine({ matter }: { matter: BoardMatter }) {
  const counts = matterCounts(matter);
  return (
    <>
      {matter.goal && <><span className="mydsh-hd-goal" title={matter.goal}>{matter.goal}</span><i>·</i></>}
      <span><b>{counts.sessions}</b>个会话</span>
      <i>·</i>
      <span><b>{counts.memory}</b>条记忆</span>
    </>
  );
}

/**
 * A matter's page: ‹ my dsh back to my dsh's page, a folder tile with the matter's name over its goal and numbers, then the 托管 chip and
 * the … menu; 看板 is the input of the matter's own conversation over the matter's board (MatterBoard), 对话 is that conversation beside
 * the matter's sessions and its context.
 */
export function MatterTabs({
  matter, snapshot, call, back, openSession, tab, setTab, openDock, prefill, draft, onDraftTaken, composer, conversation, editContext, setHosting, menu, onMenu, useSessionStatus,
}: {
  matter: BoardMatter;
  snapshot: BoardSnapshot;
  call: Call;
  back: () => void;
  openSession: (sessionId: string) => void;
  tab: Tab;
  setTab: (tab: Tab) => void;
  /** Holds the matter's conversation for the page's lifetime. */
  openDock: OpenDock;
  prefill: Prefill;
  draft?: DraftAsk | undefined;
  onDraftTaken?: () => void;
  /** DSH's session status hook, for the unread marks on the sessions. */
  useSessionStatus: UseSessionStatus;
  /** The matter's composer for 看板. */
  composer: (onSent: () => void) => ReactNode;
  /** The matter's conversation for 对话. */
  conversation: ReactNode;
  editContext: () => void;
  /** Hosts the matter under a preset, or stops with null. */
  setHosting: (preset: string | null) => Promise<void>;
  menu: { id: string; label: string }[];
  onMenu: (id: string) => void;
}) {
  useMinuteTick();
  const now = Date.now();
  return (
    <TabsFrame
      head={(
        <>
          <button type="button" className="mydsh-hd-back" onClick={back}><IconChevronLeftOutlineRegular size={12} />my dsh</button>
          <PageHead
            tile={<span className="mydsh-hd-tile is-matter"><IconFolderCloseRegular size={24} /></span>}
            title={<h1 title={matter.name}>{matter.name}</h1>}
            line={<MatterLine matter={matter} />}
            tools={<MatterHeadTools matter={matter} presets={snapshot.presets} setHosting={setHosting} menu={menu} onMenu={onMenu} />}
            middle
          />
        </>
      )}
      label={matter.name}
      tab={tab}
      setTab={setTab}
      openDock={openDock}
      prefill={prefill}
      draft={draft}
      onDraftTaken={onDraftTaken}
      composer={composer}
      board={({ ask, openChat }) => (
        <MatterBoard
          matter={matter} snapshot={snapshot} call={call} openSession={openSession} editContext={editContext} ask={ask}
          openChat={openChat} useSessionStatus={useSessionStatus}
        />
      )}
      chat={({ showBoard, openChat }) => (
        <ChatSplit conversation={conversation} title="看板" tools={<FullBoard showBoard={showBoard} />}>
          <MatterGroups matter={matter} now={now} openSession={openSession} />
          <div className="mydsh-rt-panels">
            <MatterSide matter={matter} call={call} now={now} openSession={openSession} editContext={editContext} editInChat={(text) => { openChat(text); }} />
          </div>
        </ChatSplit>
      )}
    />
  );
}
