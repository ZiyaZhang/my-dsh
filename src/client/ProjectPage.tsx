/**
 * The `project` layout, and the board parts of a matter's page. The home page is my dsh's input on top, then
 * 等你处理, 事项, 跟进中 and 回顾; my dsh's newest reply floats under the input until it is closed, and the whole conversation is one click
 * away. A matter's folder page (ProjectMatter) is its sessions (SessionList: in progress as cards, idle as rows) with its right column:
 * 定时 when DSH has scheduled tasks on the matter's conversation, then 这件事的上下文, whose rows for 指令, 来源, 记忆 and 产物 open in
 * place; 托管 is a chip in the head. The tabs layout's matter page draws its 看板 tab with MatterBoard: the composer of the matter's
 * conversation and its newest reply over the matter's sessions, the conversation among the cards while it waits or failed, beside the
 * same column; the matter's tab in DSH's right sidebar shows that column beside the conversation.
 */
import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconEllipsisOutlineRegular, IconFolderCloseRegular, IconPlusOutlineRegular,
  MarkdownText, Menu, SegmentedControl, StateDot, type MarkdownLabels, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardMatter, BoardSession, BoardSnapshot } from '../host/remote.js';
import { Review } from './BoardPage.js';
import type { BoardSource } from './board-source.js';
import { SourceChip } from './ContextFields.js';
import { FOLLOWS } from './demo.js';
import type { Dialogs } from './dialogs.js';
import { HostingChip } from './Hosting.js';
import { ArtifactRows, MemoryPanel } from './Memory.js';
import { activate, only, useMinuteTick } from './parts.js';
import { contextSummary, dispatchedSessions, lineOf, waitingRows, type ContextSummary, type WaitingRow } from './rows.js';
import { SessionList, type UseSessionStatus } from './SessionList.js';
import type { Call } from './index.js';
import { upcoming, when } from './time.js';

const LABELS: MarkdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

const dotOf = (state: BoardSession['state']): StateDotState =>
  state === 'waiting' ? 'warning' : state === 'running' ? 'ongoing' : state === 'failed' ? 'error' : 'idle';

/** Waiting first, then running, then failed, then by newest activity. */
const RANK: Record<BoardSession['state'], number> = { waiting: 0, running: 1, failed: 2, idle: 3 };
const byUrgency = (a: BoardSession, b: BoardSession) => RANK[a.state] - RANK[b.state] || b.lastActivity - a.lastActivity;

export interface ProjectHomeProps {
  source: BoardSource;
  dialogs: Dialogs;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
  showActivity: () => void;
  /** my dsh's composer. */
  composer: ReactNode;
}

/** When the user last closed a reply card: my dsh's under this key, a matter's conversation's under it with the matter's id. */
const DISMISSED = 'mydsh.reply.dismissed';
export const readDismissed = (key: string): number => { try { return Number(globalThis.localStorage?.getItem(key) ?? 0) || 0; } catch { return 0; } };
export const writeDismissed = (key: string, at: number) => { try { globalThis.localStorage?.setItem(key, String(at)); } catch { /* the card shows again next time */ } };

export function ProjectHome({ source, dialogs, openSession, openMatter, showActivity, composer }: ProjectHomeProps) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [dismissed, setDismissed] = useState(() => readDismissed(DISMISSED));
  useMinuteTick();
  const snapshot = state.status === 'ready' ? state.snapshot : undefined;
  const assistant = snapshot?.assistant;
  const now = Date.now();
  const showReply = assistant?.reply !== undefined && (assistant.replyAt ?? 0) > dismissed;
  const close = () => {
    const at = assistant?.replyAt ?? Date.now();
    setDismissed(at);
    writeDismissed(DISMISSED, at);
  };
  return (
    <div className="mydsh-pj">
      <header className="mydsh-pj-head">
        <h1>my dsh</h1>
        <span className="mydsh-pj-links">
          <button type="button" className="mydsh-link" disabled={!assistant?.sessionId} onClick={() => { if (assistant?.sessionId) openSession(assistant.sessionId); }}>对话记录</button>
          <button type="button" className="mydsh-link" onClick={showActivity}>做事记录</button>
        </span>
      </header>
      <div className="mydsh-pj-ask">
        {composer}
        {showReply && assistant?.reply && (
          <section className="mydsh-pj-reply" aria-label="my dsh 的回复">
            <div className="mydsh-pj-reply-head">
              <b>my dsh</b>
              {assistant.replyAt && <time>{when(assistant.replyAt, now)}</time>}
              <span className="mydsh-pj-reply-links">
                <button type="button" className="mydsh-link" onClick={() => { if (assistant.sessionId) openSession(assistant.sessionId); }}>在对话记录里接着说</button>
                <button type="button" className="mydsh-link is-quiet" onClick={close}>收起</button>
              </span>
            </div>
            <div className="mydsh-pj-reply-body"><MarkdownText text={assistant.reply} labels={LABELS} variant="compact" /></div>
          </section>
        )}
      </div>
      {state.status === 'loading' && <p className="mydsh-quiet">正在读取</p>}
      {state.status === 'failed' && <p className="mydsh-error">读不到看板：{state.error}</p>}
      {snapshot && <HomeBoard snapshot={snapshot} now={now} dialogs={dialogs} openSession={openSession} openMatter={openMatter} />}
    </div>
  );
}

/** 待处理 in the home board's rows: what waits, with its matter, its line, its time and 打开. */
function WaitingSection({ rows, now, open }: { rows: WaitingRow[]; now: number; open: (row: WaitingRow) => void }) {
  return (
    <section className="mydsh-pj-section">
      <h2>待处理<span className="mydsh-count">{rows.length}</span></h2>
      <div className="mydsh-pj-rows">
        {rows.map(row => (
          <div key={row.id} className="mydsh-pj-row is-waiting" {...activate(() => { open(row); })}>
            <StateDot state="warning" />
            <span className="mydsh-pj-row-path">{row.matter && <><span>{row.matter.name}</span><i>›</i></>}<b>{row.title}</b></span>
            <span className="mydsh-pj-row-line">{row.line}</span>
            <time>{when(row.at, now)}</time>
            <button type="button" className="mydsh-link" onClick={only(() => { open(row); })}>打开</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The home board: 等你处理 (unless the page shows what waits in the card under its input), 事项, 跟进中 and 回顾.
 * @param waiting - draw 等你处理 here.
 */
export function HomeBoard({ snapshot, now, dialogs, openSession, openMatter, waiting: withWaiting = true }: {
  snapshot: BoardSnapshot; now: number; dialogs: Dialogs;
  openSession: (sessionId: string) => void; openMatter: (matterId: string) => void;
  waiting?: boolean;
}) {
  const waiting = withWaiting ? waitingRows(snapshot.attention, now) : [];
  const active = snapshot.matters.filter(matter => !matter.archivedAt);
  const loose = new Map(snapshot.unassigned.map(session => [session.id, session]));
  const follows = FOLLOWS.flatMap(({ sessionId, why }) => { const session = loose.get(sessionId); return session ? [{ session, why }] : []; });
  return (
    <>
      {waiting.length > 0 && <WaitingSection rows={waiting} now={now} open={(row) => { openSession(row.id); }} />}
      <section className="mydsh-pj-section">
        <div className="mydsh-pj-section-head">
          <h2>事项<span className="mydsh-count">{active.length}</span></h2>
          <button type="button" className="mydsh-pj-new" onClick={() => { dialogs.open({ kind: 'create' }); }}><IconPlusOutlineRegular size={14} />新建事项</button>
        </div>
        <div className="mydsh-pj-grid">
          {active.map(matter => <HomeMatterCard key={matter.id} matter={matter} now={now} openMatter={openMatter} openSession={openSession} />)}
        </div>
      </section>
      {follows.length > 0 && (
        <section className="mydsh-pj-section">
          <h2>跟进中<span className="mydsh-count">{follows.length}</span></h2>
          <div className="mydsh-pj-rows">
            {follows.map(({ session, why }) => (
              <div key={session.id} className="mydsh-pj-row" {...activate(() => { openSession(session.id); })}>
                <StateDot state={dotOf(session.state)} />
                <span className="mydsh-pj-row-path"><b>{session.title}</b></span>
                <span className="mydsh-pj-row-line">{why}{lineOf(session, now) ? ` · ${lineOf(session, now)}` : ''}</span>
                <time>{when(session.lastActivity, now)}</time>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="mydsh-pj-section">
        <h2>回顾</h2>
        <Review days={snapshot.review} now={now} dispatched={dispatchedSessions(snapshot.matters)} openSession={openSession} />
      </section>
    </>
  );
}

/** A matter on the home page: its goal, how its conversation's newest reply starts, its two most urgent sessions, and the counts. */
function HomeMatterCard({ matter, now, openMatter, openSession }: {
  matter: BoardMatter; now: number; openMatter: (matterId: string) => void; openSession: (sessionId: string) => void;
}) {
  const sessions = matter.sessions.filter(session => !session.archived).sort(byUrgency);
  const waiting = sessions.filter(session => session.state === 'waiting').length;
  const running = sessions.filter(session => session.state === 'running').length;
  const said = matter.conversation?.line;
  return (
    <article className="mydsh-pj-card" onClick={() => { openMatter(matter.id); }}>
      <div className="mydsh-pj-card-head">
        <IconFolderCloseRegular size={16} className="mydsh-pj-card-icon" />
        <h3>{matter.name}</h3>
        {matter.hosting && <span className="mydsh-pj-badge">托管中</span>}
        {matter.sessions.length > 0 && <time>{when(matter.lastActivity, now)}</time>}
      </div>
      {matter.goal && <p className="mydsh-pj-card-goal">{matter.goal}</p>}
      {said && <p className="mydsh-pj-card-line">{said}</p>}
      <div className="mydsh-pj-card-rows">
        {sessions.slice(0, 2).map(session => (
          <button key={session.id} type="button" className="mydsh-pj-card-row" onClick={only(() => { openSession(session.id); })}>
            <StateDot state={dotOf(session.state)} />
            <span>{session.title}</span>
          </button>
        ))}
      </div>
      <p className="mydsh-pj-card-foot">
        {sessions.length} 个会话{waiting > 0 && <span className="is-waiting"> · {waiting} 个待处理</span>}{running > 0 && <span> · {running} 个进行中</span>}
      </p>
    </article>
  );
}

/** The right end of a matter's head: 托管 as a chip while DSH offers presets or the matter is hosted, then the … menu. */
export function MatterHeadTools({ matter, presets, setHosting, menu, onMenu }: {
  matter: BoardMatter;
  presets: BoardSnapshot['presets'];
  /** Hosts the matter under a preset, or stops with null. */
  setHosting: (preset: string | null) => Promise<void>;
  menu: { id: string; label: string }[];
  onMenu: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="mydsh-pj-mhead-tools">
      <HostingChip preset={matter.hosting?.preset} presets={presets} setHosting={setHosting} />
      <Menu
        open={open}
        align="end"
        onClose={() => { setOpen(false); }}
        anchor={<button type="button" className={`mydsh-icon-button${open ? ' is-on' : ''}`} aria-label="更多" onClick={() => { setOpen(!open); }}><IconEllipsisOutlineRegular size={15} /></button>}
        items={menu}
        onSelect={(id) => { setOpen(false); onMenu(id); }}
      />
    </span>
  );
}

/** What a matter's right column needs. */
export interface MatterSideProps {
  matter: BoardMatter;
  call: Call;
  now: number;
  openSession: (sessionId: string) => void;
  editContext: () => void;
  /** Shows the matter's conversation with the text in its input; absent where the page has no way to it. */
  editInChat?: (text: string) => void;
}

type ContextPart = 'instructions' | 'sources' | 'memory' | 'artifacts';

/** How the 记忆 row reads: its entries, and when it was merged. */
function memoryValue(summary: ContextSummary, now: number): string {
  const merged = summary.merged === undefined ? '' : 'now' in summary.merged ? ' · 在整理' : ` · ${when(summary.merged.at, now)} 整理过`;
  return `${summary.memory} 条${merged}`;
}

/**
 * A matter's right column: 定时 while DSH has tasks on its conversation, then 这件事的上下文, a row each for 指令 (its first line), 来源,
 * 记忆 and 产物. A row opens its part in place of the rows: ‹ 这件事的上下文 goes back, and a segmented control moves between the parts.
 */
export function MatterSide({ matter, call, now, openSession, editContext, editInChat }: MatterSideProps) {
  const [part, setPart] = useState<ContextPart | null>(null);
  const summary = contextSummary(matter);
  const schedules = matter.schedules ?? [];
  const row = (key: ContextPart, label: string, value: string) => (
    <button type="button" className="mydsh-ctx-row" onClick={() => { setPart(key); }}>
      <b>{label}</b>
      <span>{value}</span>
      <IconChevronRightOutlineRegular size={12} className="mydsh-ctx-go" />
    </button>
  );
  return (
    <aside className="mydsh-pj-side">
      {schedules.length > 0 && (
        <Panel title="定时" count={schedules.length}>
          {schedules.map(item => (
            <div key={item.id} className="mydsh-pj-schedule">
              <b>{item.title}</b>
              {item.status === 'paused' ? <span>已暂停</span> : item.next !== undefined && <span>下次 {upcoming(item.next, now)}</span>}
            </div>
          ))}
        </Panel>
      )}
      {part === null
        ? (
          <Panel title="这件事的上下文">
            <div className="mydsh-ctx-rows">
              {row('instructions', '指令', summary.instructions || '无')}
              {row('sources', '来源', `${summary.sources} 个`)}
              {row('memory', '记忆', memoryValue(summary, now))}
              {row('artifacts', '产物', `${summary.files} 个文件`)}
            </div>
          </Panel>
        )
        : (
          <ContextParts
            part={part} choose={setPart} back={() => { setPart(null); }} matter={matter} summary={summary} call={call}
            openSession={openSession} editContext={editContext} editInChat={editInChat}
          />
        )}
    </aside>
  );
}

/** The context's parts in place of its rows: the way back, the segmented control, and the part: 指令, 来源, 记忆 or 产物. */
function ContextParts({ part, choose, back, matter, summary, call, openSession, editContext, editInChat }: Omit<MatterSideProps, 'now'> & {
  part: ContextPart;
  choose: (part: ContextPart) => void;
  back: () => void;
  summary: ContextSummary;
}) {
  const id = useId();
  const artifacts = matter.artifacts ?? [];
  return (
    <section className="mydsh-pj-panel mydsh-ctx">
      <button type="button" className="mydsh-ctx-back" onClick={back}><IconChevronLeftOutlineRegular size={12} />这件事的上下文</button>
      <SegmentedControl
        id={id} value={part} onChange={choose} label="这件事的上下文" className="mydsh-ctx-seg"
        options={[
          { value: 'instructions', label: '指令' },
          { value: 'sources', label: `来源 ${summary.sources}` },
          { value: 'memory', label: `记忆 ${summary.memory}` },
          { value: 'artifacts', label: `产物 ${summary.files}` },
        ]}
      />
      <div role="tabpanel" id={`${id}-${part}-panel`} aria-labelledby={`${id}-${part}`} className="mydsh-ctx-part">
        {part === 'instructions' && (
          <>
            <div className="mydsh-ctx-bar"><button type="button" className="mydsh-link" onClick={editContext}>编辑</button></div>
            {matter.instructions ? <p className="mydsh-ctx-text">{matter.instructions}</p> : <p className="mydsh-empty">无</p>}
          </>
        )}
        {part === 'sources' && (
          <>
            <div className="mydsh-ctx-bar"><button type="button" className="mydsh-link" onClick={editContext}>添加</button></div>
            {matter.sources.length ? <div className="mydsh-chips">{matter.sources.map(item => <SourceChip key={item.value} source={item} />)}</div> : <p className="mydsh-empty">无</p>}
          </>
        )}
        {part === 'memory' && <MemoryPanel key={matter.id} matter={matter} call={call} openSession={openSession} editInChat={editInChat} bare />}
        {part === 'artifacts' && (artifacts.length ? <ArtifactRows artifacts={artifacts} openSession={openSession} /> : <p className="mydsh-empty">无</p>)}
      </div>
    </section>
  );
}

export interface ProjectMatterProps extends MatterSideProps {
  presets: BoardSnapshot['presets'];
  /** Hosts the matter under a preset, or stops with null. */
  setHosting: (preset: string | null) => Promise<void>;
  back: () => void;
  menu: { id: string; label: string }[];
  onMenu: (id: string) => void;
  /** DSH's session status hook, for the unread marks. */
  useSessionStatus: UseSessionStatus;
}

/** A matter's folder page in the `project` layout: its sessions, with its panels on the right. */
export function ProjectMatter({ matter, presets, setHosting, call, now, back, openSession, menu, onMenu, useSessionStatus, ...side }: ProjectMatterProps) {
  return (
    <div className="mydsh-pj mydsh-pj-matter">
      <header className="mydsh-pj-mhead">
        <nav className="mydsh-crumbs">
          <button type="button" className="mydsh-crumb" onClick={back}>my dsh</button>
          <span className="mydsh-crumb-sep">/</span>
          <span className="mydsh-crumb is-current">{matter.name}</span>
        </nav>
        <MatterHeadTools matter={matter} presets={presets} setHosting={setHosting} menu={menu} onMenu={onMenu} />
      </header>
      {matter.goal && <p className="mydsh-pj-goal">{matter.goal}</p>}
      <div className="mydsh-pj-body">
        <div className="mydsh-pj-main">
          <SessionList
            first sessions={matter.sessions} now={now} openSession={openSession} useSessionStatus={useSessionStatus}
            remove={(sessionId) => { void call({ action: 'removeSession', sessionId }); }}
          />
        </div>
        <MatterSide matter={matter} call={call} now={now} openSession={openSession} {...side} />
      </div>
    </div>
  );
}

/**
 * A matter's 看板 tab: in the main column the composer of the matter's conversation, its newest reply until it is closed (per matter),
 * and the matter's sessions, with the conversation among the cards while it waits or failed; the panels on the right. 在对话里接着说,
 * the conversation's card and 在对话里改 in the memory panel open the conversation, the last with its words in the input.
 * @param ask - draws the composer with what goes under it, as the tabs template mounts it.
 * @param openChat - shows the matter's conversation on the 对话 tab, with `draft` in its input.
 */
export function MatterBoard({ snapshot, ask, openChat, useSessionStatus, ...side }: Omit<MatterSideProps, 'now' | 'editInChat'> & {
  snapshot: BoardSnapshot;
  ask: (below?: ReactNode) => ReactNode;
  openChat: (draft?: string) => void;
  /** DSH's session status hook, for the unread marks. */
  useSessionStatus: UseSessionStatus;
}) {
  const { matter, call, openSession } = side;
  const key = `${DISMISSED}.${matter.id}`;
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  useMinuteTick();
  const now = Date.now();
  const conversation = matter.conversation;
  // The conversation as 等你处理 lists it (title 对话), present while it waits or failed.
  const asking = conversation ? snapshot.attention.find(session => session.id === conversation.sessionId) : undefined;
  const close = () => {
    const at = conversation?.replyAt ?? Date.now();
    setDismissed(at);
    writeDismissed(key, at);
  };
  const reply = conversation?.reply !== undefined && (conversation.replyAt ?? 0) > dismissed && (
    <section className="mydsh-pj-reply" aria-label="这件事的对话的回复">
      <div className="mydsh-pj-reply-head">
        <b>这件事的对话</b>
        {conversation.replyAt && <time>{when(conversation.replyAt, now)}</time>}
        <span className="mydsh-pj-reply-links">
          <button type="button" className="mydsh-link" onClick={() => { openChat(); }}>在对话里接着说</button>
          <button type="button" className="mydsh-link is-quiet" onClick={close}>收起</button>
        </span>
      </div>
      <div className="mydsh-pj-reply-body"><MarkdownText text={conversation.reply} labels={LABELS} variant="compact" /></div>
    </section>
  );
  // The goal is in the page's head.
  return (
    <div className="mydsh-pj mydsh-pj-matter">
      <div className="mydsh-pj-body">
        <div className="mydsh-pj-main">
          {ask(reply)}
          <SessionList
            sessions={matter.sessions} conversation={asking} now={now} openSession={openSession} openConversation={() => { openChat(); }}
            useSessionStatus={useSessionStatus} remove={(sessionId) => { void call({ action: 'removeSession', sessionId }); }}
          />
        </div>
        <MatterSide {...side} now={now} editInChat={openChat} />
      </div>
    </div>
  );
}

function Panel({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mydsh-pj-panel">
      <div className="mydsh-pj-panel-head"><h3>{title}{count !== undefined && count > 0 && <span className="mydsh-count">{count}</span>}</h3>{action}</div>
      {children}
    </section>
  );
}
