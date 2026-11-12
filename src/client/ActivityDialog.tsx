/**
 * 做事记录: what my dsh did, what was filed by hand, the suggestions of automatic grouping that were accepted, and each change to a
 * matter's memory, by day, newest first, with 撤回 where it still applies. A memory change says who made it and opens to its diff.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  IconCloseOutlineRegular, IconGoalOutlineRegular, IconListPenOutlineRegular, IconPaperPlaneOutlineRegular, IconRefreshOutlineRegular,
  IconSendOutlineRegular, IconShareOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { ActivityKind, ActivityView } from '../host/remote.js';
import type { BoardSource } from './board-source.js';
import type { Call } from './index.js';
import { clock, dayTitle, groupByDay } from './time.js';

const ICONS: Record<ActivityKind, ReactNode> = {
  start: <IconPaperPlaneOutlineRegular size={14} />,
  send: <IconSendOutlineRegular size={14} />,
  note: <IconListPenOutlineRegular size={14} />,
  forward: <IconShareOutlineRegular size={14} />,
  file: <IconGoalOutlineRegular size={14} />,
  unfile: <IconCloseOutlineRegular size={14} />,
  manage: <IconGoalOutlineRegular size={14} />,
  undo: <IconRefreshOutlineRegular size={14} />,
  memory: <IconListPenOutlineRegular size={14} />,
  group: <IconGoalOutlineRegular size={14} />,
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A stored unified diff, each line tinted by whether it was added or removed. */
function Diff({ id, call }: { id: string; call: Call }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    call({ action: 'activityDiff', id }, abort.signal).then(read => { setDiff(read.diff); }, (error: unknown) => { if (!abort.signal.aborted) setFailure(message(error)); });
    return () => { abort.abort(); };
  }, [call, id]);
  if (failure) return <p className="mydsh-error">{failure}</p>;
  if (diff === null) return <p className="mydsh-quiet">正在读取</p>;
  if (!diff) return <p className="mydsh-empty">无</p>;
  return (
    <pre className="mydsh-diff">
      {diff.split('\n').map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---') ? 'is-file' : line.startsWith('@@') ? 'is-hunk' : line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-del' : '';
        return <span key={index} className={kind || undefined}>{line}{'\n'}</span>;
      })}
    </pre>
  );
}

export function ActivityDialog({ close, call, source }: { close: () => void; call: Call; source: BoardSource }) {
  const [entries, setEntries] = useState<ActivityView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  // Read again whenever the board changes, so an undo elsewhere or a new entry shows here too.
  const board = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useEffect(() => {
    const abort = new AbortController();
    call({ action: 'activity' }, abort.signal).then((read) => { setEntries(read); setError(null); }, (failure: unknown) => {
      if (!abort.signal.aborted) setError(message(failure));
    });
    return () => { abort.abort(); };
  }, [call, board]);

  const undo = (id: string) => {
    setBusy(id);
    setError(null);
    call({ action: 'undo', id })
      .then(() => source.refresh())
      .catch((failure: unknown) => { setError(message(failure)); })
      .finally(() => { setBusy(null); });
  };

  const now = Date.now();
  return (
    <Modal open onClose={close} closeLabel="关闭" title="做事记录" className="mydsh-activity-modal" contentClassName="mydsh-activity">
      {error !== null && <p className="mydsh-error" role="alert">{error}</p>}
      {entries === null
        ? (error === null && <p className="mydsh-quiet">正在读取</p>)
        : entries.length === 0
          ? <p className="mydsh-empty">无</p>
          : groupByDay(entries, now).map((group) => {
            const title = dayTitle(group, now);
            return (
              <section key={group.day} className="mydsh-activity-day">
                <h3>{title.label}{title.date && <span>{title.date}</span>}</h3>
                {group.entries.map(entry => (
                  <div key={entry.id} className={`mydsh-activity-row${entry.undoneAt ? ' is-undone' : ''}`}>
                    <time>{clock(Date.parse(entry.at))}</time>
                    <span className="mydsh-activity-icon">{ICONS[entry.kind]}</span>
                    <div className="mydsh-activity-body">
                      <p className="mydsh-activity-text">{entry.text}</p>
                      {entry.why && <p className="mydsh-activity-why">{entry.kind === 'memory' ? entry.why : `原因：${entry.why}`}</p>}
                      {entry.memory && opened === entry.id && <Diff id={entry.id} call={call} />}
                    </div>
                    {entry.memory && (
                      <button type="button" className="mydsh-link" onClick={() => { setOpened(opened === entry.id ? null : entry.id); }}>{opened === entry.id ? '收起' : '改动'}</button>
                    )}
                    {entry.undoable && (
                      <button type="button" className="mydsh-link" disabled={busy !== null} onClick={() => { undo(entry.id); }}>撤回</button>
                    )}
                  </div>
                ))}
              </section>
            );
          })}
    </Modal>
  );
}
