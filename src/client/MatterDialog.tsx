import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { matterGoal, matterName, type BoardSnapshot } from '../host/remote.js';
import type { BoardSource } from './board-source.js';
import { ContextField, WorkspaceField, type ContextTools, type DraftSource } from './ContextFields.js';
import type { DialogRequest, Dialogs } from './dialogs.js';
import type { Call } from './index.js';

export interface MatterDialogsProps {
  dialogs: Dialogs;
  call: Call;
  /** Read the board again after a change. */
  after: () => void;
  /** The board, for the workspaces and a matter's current context. */
  source: BoardSource;
  tools: ContextTools;
}

/** The `shell.overlay` entry: nothing until a dialog is asked for, then one form per request. */
export function MatterDialogs({ dialogs, call, after, source, tools }: MatterDialogsProps) {
  const request = useSyncExternalStore(dialogs.subscribe, dialogs.get);
  if (request === null) return null;
  const key = request.kind === 'create' ? `create:${request.sessionId ?? ''}` : `${request.kind}:${request.matterId}`;
  const close = () => { dialogs.close(); };
  if (request.kind === 'create' || request.kind === 'context') {
    return <ContextForm key={key} request={request} call={call} close={close} after={after} source={source} tools={tools} />;
  }
  return <MatterForm key={key} request={request} call={call} close={close} after={after} />;
}

const TITLE = { rename: '改名', goal: '改目标' } as const;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One line of text that submits on Enter, but not on the Enter that ends an IME composition. */
function useLine(submit: () => void) {
  const composing = useRef(false);
  return {
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && !composing.current) {
        event.preventDefault();
        submit();
      }
    },
  };
}

/** 改名 and 改目标: one field each. */
function MatterForm({ request, call, close, after }: {
  request: Extract<DialogRequest, { kind: 'rename' | 'goal' }>; call: Call; close: () => void; after: () => void;
}) {
  const [value, setValue] = useState(request.kind === 'rename' ? request.name : request.goal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = busy || (request.kind === 'rename' && value.trim() === '');
  const dismiss = () => { if (!busy) close(); };
  const submit = async () => {
    if (blocked) return;
    let checked: string;
    try {
      checked = request.kind === 'rename' ? matterName(value) : matterGoal(value);
    } catch (problem) {
      setError(message(problem));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (request.kind === 'rename') await call({ action: 'renameMatter', id: request.matterId, name: checked });
      else await call({ action: 'setGoal', id: request.matterId, goal: checked });
      setBusy(false);
      close();
      after();
    } catch (failure) {
      setBusy(false);
      setError(message(failure));
    }
  };
  const line = useLine(() => { void submit(); });
  const label = request.kind === 'rename' ? '名字' : '目标';
  return (
    <Modal
      open onClose={dismiss} closeLabel="关闭" title={TITLE[request.kind]}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={dismiss}>取消</Button>
          <Button variant="primary" disabled={blocked} onClick={() => { void submit(); }}>保存</Button>
        </>
      )}
    >
      <div className="mydsh-form">
        <input
          className="mydsh-input" value={value} aria-label={label} disabled={busy} data-modal-autofocus
          onFocus={(event) => { event.target.select(); }}
          onChange={(event) => { setValue(event.target.value); setError(null); }}
          {...line}
        />
        {error !== null && <p className="mydsh-form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/** Where a new matter's main workspace starts: the session's it was made from, else the most recently active one. */
function defaultWorkspace(snapshot: BoardSnapshot | undefined, sessionId: string | undefined): string | null {
  if (!snapshot) return null;
  if (sessionId) {
    const sessions = [
      ...snapshot.matters.flatMap(matter => matter.sessions), ...snapshot.unassigned, ...snapshot.review.flatMap(day => day.sessions),
    ];
    const found = sessions.find(session => session.id === sessionId)?.workspaceId;
    if (found) return found;
  }
  return snapshot.recentWorkspaceId ?? null;
}

/** 新建事项 (名字, 目标, 主工作区, 上下文) and 编辑上下文 (主工作区, 上下文). */
function ContextForm({ request, call, close, after, source, tools }: {
  request: Extract<DialogRequest, { kind: 'create' | 'context' }>; call: Call; close: () => void; after: () => void; source: BoardSource; tools: ContextTools;
}) {
  const board = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const snapshot = board.status === 'ready' ? board.snapshot : undefined;
  const matter = request.kind === 'context' ? snapshot?.matters.find(candidate => candidate.id === request.matterId) : undefined;
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  // Undefined until the user picks, so the default can follow the snapshot that arrives after the dialog opens.
  const [workspaceId, setWorkspaceId] = useState<string | null | undefined>(undefined);
  const [sources, setSources] = useState<DraftSource[] | undefined>(undefined);
  const [instructions, setInstructions] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The matter a create already made, so a retry after a failed add does not make a second one.
  const created = useRef<string | null>(null);
  const creating = request.kind === 'create';

  const chosenWorkspace = workspaceId !== undefined ? workspaceId : creating ? defaultWorkspace(snapshot, request.sessionId) : matter?.workspace?.id ?? null;
  const chosenSources = sources ?? (matter?.sources ?? []);
  const chosenInstructions = instructions ?? (matter?.instructions ?? '');
  const blocked = busy || (creating && name.trim() === '') || (!creating && !matter);

  const dismiss = () => { if (!busy) close(); };
  const submit = async () => {
    if (blocked) return;
    let checked = { name: '', goal: '' };
    try {
      if (creating) checked = { name: matterName(name), goal: matterGoal(goal) };
    } catch (problem) {
      setError(message(problem));
      return;
    }
    setBusy(true);
    setError(null);
    const context = { workspaceId: chosenWorkspace, sources: chosenSources, instructions: chosenInstructions };
    try {
      if (request.kind === 'create') {
        created.current ??= (await call({ action: 'createMatter', name: checked.name, goal: checked.goal, ...context })).id;
        if (request.sessionId) await call({ action: 'addSession', matterId: created.current, sessionId: request.sessionId });
      } else {
        await call({ action: 'setContext', id: request.matterId, ...context });
      }
      setBusy(false);
      close();
      after();
    } catch (failure) {
      setBusy(false);
      setError(message(failure));
    }
  };
  const line = useLine(() => { void submit(); });
  const text = (value: string, change: (value: string) => void, label: string, autofocus: boolean) => (
    <input
      className="mydsh-input" value={value} aria-label={label} disabled={busy}
      {...(autofocus ? { 'data-modal-autofocus': true } : {})}
      onChange={(event) => { change(event.target.value); setError(null); }}
      {...line}
    />
  );
  return (
    <Modal
      open onClose={dismiss} closeLabel="关闭" title={creating ? '新建事项' : '编辑上下文'}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={dismiss}>取消</Button>
          <Button variant="primary" disabled={blocked} onClick={() => { void submit(); }}>{creating ? '创建' : '保存'}</Button>
        </>
      )}
    >
      <div className="mydsh-form">
        {creating && <label className="mydsh-field"><span>名字</span>{text(name, setName, '名字', true)}</label>}
        {creating && <label className="mydsh-field"><span>目标</span>{text(goal, setGoal, '目标', false)}</label>}
        <div className="mydsh-field">
          <span>主工作区</span>
          <WorkspaceField workspaces={snapshot?.workspaces ?? []} value={chosenWorkspace} onChange={setWorkspaceId} disabled={busy} />
        </div>
        <ContextField
          sources={chosenSources} instructions={chosenInstructions} tools={tools} disabled={busy}
          onSources={(next) => { setSources(next); setError(null); }}
          onInstructions={(next) => { setInstructions(next); setError(null); }}
        />
        {error !== null && <p className="mydsh-form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
