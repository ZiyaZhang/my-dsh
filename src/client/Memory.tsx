/**
 * 事项记忆 and 产物 on a matter's page. The memory panel is read only: its count, when it was last merged (整理) and 整理 itself; a row
 * per index entry with its category and description, and 没核实 where it was not checked; a row opens the file: its body, the sessions
 * it came from, how it was checked, and 在对话里改, which carries the file's name into the matter's conversation. Files the index left
 * out show why. 产物 lists what the matter's sessions wrote, newest first, a new folder of several files as one row. Both also fill the
 * 记忆 and 产物 parts of the context's drill-in, where the panel goes without its box and title.
 */
import { useEffect, useState } from 'react';
import { FileTypeIcon, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ArtifactRowView, BoardMatter, MemoryFileView } from '../host/remote.js';
import type { Call } from './index.js';
import { activate } from './parts.js';
import { when } from './time.js';

const LABELS: MarkdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One opened file, read when it opens. */
function MemoryFile({ matterId, path, call, openSession, editInChat }: {
  matterId: string;
  path: string;
  call: Call;
  openSession: (sessionId: string) => void;
  editInChat?: (text: string) => void;
}) {
  const [file, setFile] = useState<MemoryFileView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    call({ action: 'memoryFile', matterId, path }, abort.signal).then(setFile, (error: unknown) => { if (!abort.signal.aborted) setFailure(message(error)); });
    return () => { abort.abort(); };
  }, [call, matterId, path]);
  if (failure) return <div className="mydsh-memory-open"><p className="mydsh-error">{failure}</p></div>;
  if (!file) return <div className="mydsh-memory-open"><p className="mydsh-quiet">正在读取</p></div>;
  return (
    <div className="mydsh-memory-open">
      {file.body && <MarkdownText text={file.body} labels={LABELS} variant="compact" />}
      {file.verified && <p className="mydsh-memory-line"><b>核实</b>{file.verified}</p>}
      {file.warnings.length > 0 && <p className="mydsh-memory-line is-warning">{file.warnings.join('、')}</p>}
      {file.sources.length > 0 && (
        <span className="mydsh-memory-sources">
          {file.sources.map(source => (
            <button key={source.id} type="button" className="mydsh-note-source" title="打开出处会话" onClick={() => { openSession(source.id); }}>{source.title}</button>
          ))}
        </span>
      )}
      {editInChat && <button type="button" className="mydsh-link" onClick={() => { editInChat(`改记忆「${file.path}」：`); }}>在对话里改</button>}
    </div>
  );
}

export function MemoryPanel({ matter, call, openSession, editInChat, compact = false, folded = false, bare = false }: {
  matter: BoardMatter;
  call: Call;
  openSession: (sessionId: string) => void;
  /** Shows the matter's conversation with the text in its input; absent where the page has no conversation to show. */
  editInChat?: (text: string) => void;
  /** In the narrow side panel: smaller type, no box, folded to its heading row until opened. */
  compact?: boolean;
  folded?: boolean;
  /** In the context's drill-in, which names the part itself: no box and no title. */
  bare?: boolean;
}) {
  const [shown, setShown] = useState(!folded);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const memory = matter.memory;
  const rows = memory?.rows ?? [];
  const merging = busy || memory?.merging === true;
  const merge = () => {
    setBusy(true);
    setFailure(null);
    call({ action: 'mergeMemory', id: matter.id }).catch((error: unknown) => { setFailure(message(error)); }).finally(() => { setBusy(false); });
  };
  const title = compact
    ? <button type="button" className="mydsh-notes-toggle" aria-expanded={shown} onClick={() => { setShown(!shown); }}>记忆{rows.length > 0 && <span className="mydsh-count">{rows.length}</span>}<span className={`mydsh-notes-chevron${shown ? '' : ' is-folded'}`}>⌄</span></button>
    : <>记忆{rows.length > 0 && <span className="mydsh-count">{rows.length}</span>}</>;
  return (
    <section className={bare ? 'mydsh-memory is-bare' : compact ? 'mydsh-memory is-compact' : 'mydsh-pj-panel mydsh-memory'}>
      <div className="mydsh-memory-head">
        {!bare && <h3>{title}</h3>}
        <span className="mydsh-memory-when">{merging ? '在整理' : memory?.mergedAt ? `${when(Date.parse(memory.mergedAt), Date.now())} 整理过` : ''}</span>
        <button type="button" className="mydsh-link" disabled={merging || !memory} onClick={merge}>整理</button>
      </div>
      {failure && <p className="mydsh-error">{failure}</p>}
      {shown && (rows.length === 0 && !memory?.flagged.length
        ? <p className="mydsh-empty">无</p>
        : (
          <ul className="mydsh-memory-rows">
            {rows.map(row => (
              <li key={row.path} className={open === row.path ? 'is-open' : undefined}>
                <button type="button" className="mydsh-memory-row" aria-expanded={open === row.path} onClick={() => { setOpen(open === row.path ? null : row.path); }}>
                  <span className="mydsh-memory-tag">{row.category}</span>
                  <span className="mydsh-memory-text">{row.description}{row.unverified && <span className="mydsh-memory-unverified">没核实</span>}</span>
                </button>
                {open === row.path && <MemoryFile matterId={matter.id} path={row.path} call={call} openSession={openSession} editInChat={editInChat} />}
              </li>
            ))}
            {memory?.flagged.map(file => (
              <li key={file.path} className="is-flagged" title={file.path}>
                <span className="mydsh-memory-row">
                  {file.path.includes('/') && <span className="mydsh-memory-tag">{file.path.split('/')[0]}</span>}
                  <span className="mydsh-memory-text">{file.path.split('/').pop()}<span className="mydsh-memory-flag">{file.reason}，没进索引</span></span>
                </span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

/** 产物: a row per file or new folder, its name, then how many files and the session that wrote it; a row opens that session. */
export function ArtifactRows({ artifacts, openSession }: { artifacts: readonly ArtifactRowView[]; openSession: (sessionId: string) => void }) {
  return (
    <>
      {artifacts.map(row => (
        <div key={row.path} className="mydsh-pj-file" title={row.path} {...activate(() => { openSession(row.sessionId); })}>
          {row.folder ? <FileTypeIcon kind="folder" size={20} /> : <FileTypeIcon path={row.path} size={20} />}
          <div className="mydsh-pj-file-body">
            <p><b>{row.label}</b></p>
            <p className="mydsh-pj-file-from">{row.folder ? `${row.files} 个文件 · ${row.title}` : row.title}</p>
          </div>
        </div>
      ))}
    </>
  );
}
