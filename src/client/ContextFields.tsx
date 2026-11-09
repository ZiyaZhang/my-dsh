/**
 * A matter's context in the dialogs: the main workspace, and 上下文 — sources as small chips with 添加, and the instructions. Files dropped
 * anywhere on 上下文 are uploaded through DSH and copied into the matter's folder when the dialog is saved.
 */
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  Button, IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconDeliverDocRegular, IconFolderCloseRegular,
  IconGlobeOutlineRegular, IconLinkOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { MatterSource, SourceKind, UploadSource } from '../host/remote.js';
import { classifyUrl, sourceLabel } from '../host/sources.js';

export type DraftSource = MatterSource | UploadSource;

export interface ContextTools {
  /** The Host's path check. */
  checkPath(path: string): Promise<MatterSource>;
  /** DSH's folder picker, when this DSH has one for this page. */
  pickFolder?: (() => Promise<string | null>) | undefined;
  /** DSH's file upload, when this DSH has one. */
  upload?: ((file: File) => Promise<UploadSource>) | undefined;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ICONS: Record<SourceKind, ReactNode> = {
  folder: <IconFolderCloseRegular size={14} />,
  file: <IconDeliverDocRegular size={14} />,
  pr: <IconBranchOutlineRegular size={14} />,
  doc: <IconLinkOutlineRegular size={14} />,
  link: <IconGlobeOutlineRegular size={14} />,
};

const kindOf = (source: DraftSource): SourceKind => (source.kind === 'upload' ? 'file' : source.kind);
const labelOf = (source: DraftSource) => (source.kind === 'upload' ? source.name : sourceLabel(source));
const keyOf = (source: DraftSource) => (source.kind === 'upload' ? `upload:${source.attachmentId}` : source.value);

/** One source: its icon and name; removable when `remove` is given. Web sources open in a new tab. */
export function SourceChip({ source, remove }: { source: DraftSource; remove?: () => void }) {
  const label = labelOf(source);
  const web = source.kind === 'pr' || source.kind === 'doc' || source.kind === 'link';
  const body = <>{ICONS[kindOf(source)]}<span className="mydsh-chip-label">{label}</span></>;
  return (
    <span className="mydsh-chip" title={source.kind === 'upload' ? source.name : source.value}>
      {web ? <a className="mydsh-chip-body" href={source.value} target="_blank" rel="noreferrer">{body}</a> : <span className="mydsh-chip-body">{body}</span>}
      {remove && (
        <button type="button" className="mydsh-chip-remove" aria-label={`移除 ${label}`} onClick={remove}>
          <IconCloseOutlineRegular size={12} />
        </button>
      )}
    </span>
  );
}

/** The main workspace: a button that opens DSH's menu of workspaces. */
export function WorkspaceField({ workspaces, value, onChange, disabled }: {
  workspaces: { id: string; title: string; path: string }[];
  value: string | null;
  onChange: (workspaceId: string | null) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = workspaces.find(workspace => workspace.id === value);
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false); }}
      anchor={(
        <button type="button" className="mydsh-input mydsh-select" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); }}>
          <span className={current ? '' : 'mydsh-select-empty'}>{current?.title ?? '不设'}</span>
          <IconChevronDownOutlineRegular size={14} />
        </button>
      )}
      items={[
        ...workspaces.map(workspace => ({ id: workspace.id, label: <span className="mydsh-select-item" title={workspace.path}>{workspace.title}</span>, icon: <IconFolderCloseRegular size={14} /> })),
        ...(workspaces.length ? [{ type: 'separator' as const, id: 'sep' }] : []),
        { id: '', label: '不设' },
      ]}
      onSelect={(id) => { setOpen(false); onChange(id === '' ? null : id); }}
    />
  );
}

type Entry = 'link' | 'path' | null;

/** 上下文: sources with 添加, the instructions, and dropped files. */
export function ContextField({ sources, instructions, onSources, onInstructions, tools, disabled }: {
  sources: DraftSource[];
  instructions: string;
  onSources: (sources: DraftSource[]) => void;
  onInstructions: (instructions: string) => void;
  tools: ContextTools;
  disabled: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const [entry, setEntry] = useState<Entry>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  // The latest list, for additions that finish after other changes.
  const latest = useRef(sources);
  latest.current = sources;

  const add = (source: DraftSource) => {
    const list = latest.current;
    if (list.some(kept => keyOf(kept) === keyOf(source))) return;
    latest.current = [...list, source];
    onSources(latest.current);
  };
  const remove = (source: DraftSource) => { onSources(latest.current.filter(kept => keyOf(kept) !== keyOf(source))); };

  const addTyped = async () => {
    const value = text.trim();
    if (!value) return;
    setError(null);
    try {
      add(entry === 'link' ? classifyUrl(value) : await tools.checkPath(value));
      setText('');
      setEntry(null);
    } catch (failure) {
      setError(message(failure));
    }
  };
  const pickFolder = async () => {
    setError(null);
    if (!tools.pickFolder) { setEntry('path'); return; }
    try {
      const path = await tools.pickFolder();
      if (path) add(await tools.checkPath(path));
    } catch {
      // No chooser this DSH can open from here: type the path instead.
      setEntry('path');
    }
  };
  const upload = async (list: FileList | null) => {
    if (!list?.length || !tools.upload) return;
    setError(null);
    for (const file of [...list]) {
      setUploading(count => count + 1);
      try {
        add(await tools.upload(file));
      } catch (failure) {
        setError(`${file.name}：${message(failure)}`);
      } finally {
        setUploading(count => count - 1);
      }
    }
  };
  const drop = tools.upload && !disabled ? {
    onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: DragEvent) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); },
  } : {};

  return (
    <div className={`mydsh-field mydsh-context${dragging ? ' is-dragging' : ''}`} {...drop}>
      <span>上下文<em>可选</em></span>
      <div className="mydsh-chips">
        {sources.map(source => <SourceChip key={keyOf(source)} source={source} {...(disabled ? {} : { remove: () => { remove(source); } })} />)}
        {uploading > 0 && <span className="mydsh-chip-note">上传中</span>}
        <Menu
          open={menu}
          onClose={() => { setMenu(false); }}
          anchor={<button type="button" className="mydsh-link mydsh-chip-add" disabled={disabled} onClick={() => { setMenu(!menu); }}>添加</button>}
          items={[
            { id: 'link', label: '链接', icon: <IconLinkOutlineRegular size={14} /> },
            { id: 'folder', label: '文件夹', icon: <IconFolderCloseRegular size={14} /> },
            { id: 'path', label: '路径', icon: <IconDeliverDocRegular size={14} /> },
            ...(tools.upload ? [{ id: 'upload', label: '上传文件', icon: <IconDeliverDocRegular size={14} /> }] : []),
          ]}
          onSelect={(id) => {
            setMenu(false);
            setError(null);
            if (id === 'link' || id === 'path') { setEntry(id); setText(''); }
            else if (id === 'folder') void pickFolder();
            else files.current?.click();
          }}
        />
        <input ref={files} type="file" multiple hidden onChange={(event) => { void upload(event.target.files); event.target.value = ''; }} />
      </div>
      {entry && (
        <div className="mydsh-entry">
          <input
            className="mydsh-input"
            value={text}
            aria-label={entry === 'link' ? '链接' : '路径'}
            placeholder={entry === 'link' ? 'https://' : '/'}
            disabled={disabled}
            data-modal-autofocus
            onChange={(event) => { setText(event.target.value); setError(null); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter' && !composing.current) { event.preventDefault(); event.stopPropagation(); void addTyped(); }
              if (event.key === 'Escape') { event.stopPropagation(); setEntry(null); }
            }}
          />
          <Button variant="outline" size="sm" disabled={disabled || text.trim() === ''} onClick={() => { void addTyped(); }}>添加</Button>
          <Button variant="ghost" size="sm" onClick={() => { setEntry(null); setError(null); }}>取消</Button>
        </div>
      )}
      <label className="mydsh-subfield">
        <span>指令</span>
        <textarea className="mydsh-input mydsh-textarea" value={instructions} aria-label="指令" rows={3} disabled={disabled} onChange={(event) => { onInstructions(event.target.value); }} />
      </label>
      {error !== null && <p className="mydsh-form-error" role="alert">{error}</p>}
    </div>
  );
}
