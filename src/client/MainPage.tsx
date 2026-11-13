/**
 * The `main` layout: the main conversation fills the middle, and a quiet panel on the right lists
 * everything under it by state, each group a grey heading with a count, rows of a state mark, a title and a time; an empty 等你处理 keeps
 * a dashed box, and finished work stays folded. On my dsh's page the main conversation is my dsh's and the panel is the board; on a
 * hosted matter's page it is my dsh's beside the matter's sessions, 产物, memory and context. The panel can widen over the conversation.
 * The same groups fill our tabs in DSH's right sidebar (RightTabs).
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  FileTypeIcon, IconChevronDownOutlineRegular, IconFolderCloseRegular, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { BoardMatter, BoardSession, BoardSnapshot } from '../host/remote.js';
import type { BoardSource } from './board-source.js';
import { SourceChip } from './ContextFields.js';
import { FOLLOWS } from './demo.js';
import { MemoryPanel } from './Memory.js';
import { activate, useMinuteTick } from './parts.js';
import { lineOf, waitingRows } from './rows.js';
import type { Call } from './index.js';
import { upcoming, when } from './time.js';

const dotOf = (state: BoardSession['state']): StateDotState =>
  state === 'waiting' ? 'warning' : state === 'running' ? 'ongoing' : state === 'failed' ? 'error' : 'idle';

const DAY = 24 * 60 * 60 * 1000;

/** A group of rows under its name and count; an empty group is left out. */
function Group({ title, count, folded = false, children }: {
  title: string; count: number; folded?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(!folded);
  if (count === 0) return null;
  return (
    <section className="mydsh-mn-group">
      <button type="button" className="mydsh-mn-group-head" aria-expanded={open} onClick={() => { setOpen(!open); }}>
        {title} · {count}
        <IconChevronDownOutlineRegular size={12} className={open ? '' : 'is-folded'} />
      </button>
      {open && <div className="mydsh-mn-rows">{children}</div>}
    </section>
  );
}

function Row({ mark, title, sub, time, onOpen }: { mark: ReactNode; title: ReactNode; sub?: ReactNode; time?: number; onOpen: () => void }) {
  const now = Date.now();
  return (
    <div className="mydsh-mn-row" {...activate(onOpen)}>
      <span className="mydsh-mn-mark">{mark}</span>
      <span className="mydsh-mn-row-body">
        <span className="mydsh-mn-row-title">{title}</span>
        {sub && <span className="mydsh-mn-row-sub">{sub}</span>}
      </span>
      {time !== undefined && <time>{when(time, now)}</time>}
    </div>
  );
}

/** The board's short form: 待处理, 事项, 跟进中 and 今天完成, a row opening its session or matter. */
export function HomeGroups({ snapshot, now, openSession, openMatter }: {
  snapshot: BoardSnapshot;
  now: number;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
}) {
  const waiting = waitingRows(snapshot.attention, now);
  const matters = snapshot.matters.filter(matter => !matter.archivedAt);
  const loose = new Map(snapshot.unassigned.map(session => [session.id, session]));
  const follows = FOLLOWS.flatMap(({ sessionId, why }) => { const session = loose.get(sessionId); return session ? [{ session, why }] : []; });
  const today = snapshot.review.find(day => day.daysAgo === 0)?.sessions.filter(session => session.state === 'idle') ?? [];
  return (
    <>
      <Group title="待处理" count={waiting.length}>
        {waiting.map(row => (
          <Row key={row.id} mark={<StateDot state="warning" />} title={row.title} sub={row.matter ? `${row.matter.name} · ${row.line}` : row.line} time={row.at} onOpen={() => { openSession(row.id); }} />
        ))}
      </Group>
      <Group title="事项" count={matters.length}>
        {matters.map(matter => <MatterRow key={matter.id} matter={matter} openMatter={openMatter} />)}
      </Group>
      <Group title="跟进中" count={follows.length}>
        {follows.map(({ session, why }) => (
          <Row key={session.id} mark={<StateDot state={dotOf(session.state)} />} title={session.title} sub={why} time={session.lastActivity} onOpen={() => { openSession(session.id); }} />
        ))}
      </Group>
      <Group title="今天完成" count={today.length} folded>
        {today.map(session => (
          <Row key={session.id} mark={<StateDot state="done" />} title={session.title} sub={session.matter?.name} time={session.lastActivity} onOpen={() => { openSession(session.id); }} />
        ))}
      </Group>
    </>
  );
}

export function MainHome({ source, openSession, openMatter, showActivity, conversation }: {
  source: BoardSource;
  openSession: (sessionId: string) => void;
  openMatter: (matterId: string) => void;
  showActivity: () => void;
  conversation: ReactNode;
}) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [wide, setWide] = useState(false);
  useMinuteTick();
  return (
    <div className={`mydsh-mn${wide ? ' is-wide' : ''}`}>
      <div className="mydsh-mn-center">
        <header className="mydsh-mn-head">
          <b>my dsh</b>
          <span className="mydsh-mn-tools"><button type="button" className="mydsh-link is-quiet" onClick={showActivity}>做事记录</button></span>
        </header>
        {conversation}
      </div>
      <aside className="mydsh-mn-side" aria-label="看板">
        <div className="mydsh-mn-side-head">
          <span>看板</span>
          <button type="button" className="mydsh-link is-quiet" onClick={() => { setWide(!wide); }}>{wide ? '收窄' : '展开'}</button>
        </div>
        {state.status === 'ready' && <HomeGroups snapshot={state.snapshot} now={Date.now()} openSession={openSession} openMatter={openMatter} />}
      </aside>
    </div>
  );
}

function MatterRow({ matter, openMatter }: { matter: BoardMatter; openMatter: (matterId: string) => void }) {
  const live = matter.sessions.filter(session => !session.archived);
  const waiting = live.filter(session => session.state === 'waiting').length;
  const counts = waiting > 0 ? `${waiting} 个待处理 · ${live.length} 个会话` : `${live.length} 个会话`;
  const sub = matter.hosting ? `托管中 · ${counts}` : counts;
  return (
    <Row
      mark={<IconFolderCloseRegular size={16} />}
      title={matter.name}
      sub={sub}
      time={live.length ? matter.lastActivity : undefined}
      onOpen={() => { openMatter(matter.id); }}
    />
  );
}

/** A matter's sessions by state: 待处理 (waiting or failed), 进行中, 这周 and 更早, a row opening its session. */
export function MatterGroups({ matter, now, openSession }: { matter: BoardMatter; now: number; openSession: (sessionId: string) => void }) {
  const live = matter.sessions.filter(session => !session.archived);
  const waiting = live.filter(session => session.state === 'waiting' || session.state === 'failed');
  const running = live.filter(session => session.state === 'running');
  const idle = live.filter(session => session.state === 'idle');
  const recent = idle.filter(session => now - session.lastActivity < 7 * DAY);
  const older = idle.filter(session => now - session.lastActivity >= 7 * DAY);
  const row = (session: BoardSession) => (
    <Row
      key={session.id}
      mark={<StateDot state={dotOf(session.state)} />}
      title={session.title}
      sub={[session.by === 'mydsh' ? '派出去的' : '', lineOf(session, now)].filter(Boolean).join(' · ') || undefined}
      time={session.lastActivity}
      onOpen={() => { openSession(session.id); }}
    />
  );
  return (
    <>
      <Group title="待处理" count={waiting.length}>{waiting.map(row)}</Group>
      <Group title="进行中" count={running.length}>{running.map(row)}</Group>
      <Group title="这周" count={recent.length}>{recent.map(row)}</Group>
      <Group title="更早" count={older.length} folded>{older.map(row)}</Group>
    </>
  );
}

export function MainMatter({ matter, call, back, openSession, conversation, editContext }: {
  matter: BoardMatter;
  call: Call;
  back: () => void;
  openSession: (sessionId: string) => void;
  conversation: ReactNode;
  editContext: () => void;
}) {
  const [wide, setWide] = useState(false);
  useMinuteTick();
  const now = Date.now();
  const schedules = matter.schedules ?? [];
  const artifacts = matter.artifacts ?? [];
  return (
    <div className={`mydsh-mn${wide ? ' is-wide' : ''}`}>
      <div className="mydsh-mn-center">
        <header className="mydsh-mn-head">
          <nav className="mydsh-crumbs">
            <button type="button" className="mydsh-crumb" onClick={back}>my dsh</button>
            <span className="mydsh-crumb-sep">/</span>
            <span className="mydsh-crumb is-current">{matter.name}</span>
          </nav>
          {matter.hosting && <span className="mydsh-mn-hosted">托管中</span>}
        </header>
        {conversation}
      </div>
      <aside className="mydsh-mn-side" aria-label="这个事项的会话">
        <div className="mydsh-mn-side-head">
          <span>会话</span>
          <button type="button" className="mydsh-link is-quiet" onClick={() => { setWide(!wide); }}>{wide ? '收窄' : '展开'}</button>
        </div>
        <MatterGroups matter={matter} now={now} openSession={openSession} />
        {artifacts.length > 0 && (
          <section className="mydsh-mn-group">
            <p className="mydsh-mn-group-head is-static">产物 · {artifacts.length}</p>
            <div className="mydsh-mn-tiles">
              {artifacts.map(artifact => (
                <div key={artifact.path} className="mydsh-mn-tile" title={artifact.path} {...activate(() => { openSession(artifact.sessionId); })}>
                  {artifact.folder ? <FileTypeIcon kind="folder" size={28} /> : <FileTypeIcon path={artifact.path} size={28} />}
                  <b>{artifact.label}</b>
                  <span>{artifact.folder ? `${artifact.files} 个文件 · ${artifact.title}` : artifact.title}</span>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className="mydsh-mn-group">
          <MemoryPanel key={matter.id} matter={matter} call={call} openSession={openSession} compact folded />
        </section>
        <Group title="上下文" count={matter.sources.length + (matter.instructions ? 1 : 0) + schedules.length} folded>
          <div className="mydsh-mn-context">
            {matter.instructions && <p className="mydsh-mn-context-text"><b>指令</b>{matter.instructions}</p>}
            {matter.sources.length > 0 && <div className="mydsh-chips">{matter.sources.map(item => <SourceChip key={item.value} source={item} />)}</div>}
            {schedules.map(item => (
              <p key={item.id} className="mydsh-mn-context-text">
                <b>定时</b>{item.title}{item.status === 'paused' ? ' · 已暂停' : item.next !== undefined ? ` · 下次 ${upcoming(item.next, now)}` : ''}
              </p>
            ))}
            <button type="button" className="mydsh-link" onClick={editContext}>编辑上下文</button>
          </div>
        </Group>
      </aside>
    </div>
  );
}
