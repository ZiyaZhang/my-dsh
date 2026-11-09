import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { matterGoal, matterName } from '../host/remote.js';
import type { DialogRequest, Dialogs } from './dialogs.js';
import type { Call } from './index.js';

export interface MatterDialogsProps {
  dialogs: Dialogs;
  call: Call;
  /** Read the board again after a change. */
  after: () => void;
}

/** The `shell.overlay` entry: nothing until a dialog is asked for, then one form per request. */
export function MatterDialogs({ dialogs, call, after }: MatterDialogsProps) {
  const request = useSyncExternalStore(dialogs.subscribe, dialogs.get);
  if (request === null) return null;
  const key = request.kind === 'create' ? `create:${request.sessionId ?? ''}` : `${request.kind}:${request.matterId}`;
  return <MatterForm key={key} request={request} call={call} close={() => { dialogs.close(); }} after={after} />;
}

const TITLE = { create: '新建事项', rename: '改名', goal: '改目标' } as const;
const CONFIRM = { create: '创建', rename: '保存', goal: '保存' } as const;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function MatterForm({ request, call, close, after }: { request: DialogRequest; call: Call; close: () => void; after: () => void }) {
  const [name, setName] = useState(request.kind === 'rename' ? request.name : '');
  const [goal, setGoal] = useState(request.kind === 'goal' ? request.goal : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The matter a create already made, so a retry after a failed add does not make a second one.
  const created = useRef<string | null>(null);
  // Enter that ends an IME composition must not submit.
  const composing = useRef(false);
  const askName = request.kind !== 'goal';
  const askGoal = request.kind !== 'rename';
  const blocked = busy || (askName && name.trim() === '');

  const dismiss = () => { if (!busy) close(); };
  const submit = async () => {
    if (blocked) return;
    let checked: { name: string; goal: string };
    try {
      checked = { name: askName ? matterName(name) : '', goal: askGoal ? matterGoal(goal) : '' };
    } catch (problem) {
      setError(message(problem));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (request.kind === 'create') {
        created.current ??= (await call({ action: 'createMatter', name: checked.name, goal: checked.goal })).id;
        if (request.sessionId) await call({ action: 'addSession', matterId: created.current, sessionId: request.sessionId });
      } else if (request.kind === 'rename') {
        await call({ action: 'renameMatter', id: request.matterId, name: checked.name });
      } else {
        await call({ action: 'setGoal', id: request.matterId, goal: checked.goal });
      }
      setBusy(false);
      close();
      after();
    } catch (failure) {
      setBusy(false);
      setError(message(failure));
    }
  };
  const field = (value: string, change: (value: string) => void, label: string, autofocus: boolean) => (
    <input
      className="mydsh-input"
      value={value}
      aria-label={label}
      disabled={busy}
      {...(autofocus ? { 'data-modal-autofocus': true } : {})}
      onFocus={(event) => { if (request.kind !== 'create') event.target.select(); }}
      onChange={(event) => { change(event.target.value); setError(null); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter' && !composing.current) {
          event.preventDefault();
          void submit();
        }
      }}
    />
  );
  return (
    <Modal
      open
      onClose={dismiss}
      closeLabel="关闭"
      title={TITLE[request.kind]}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={dismiss}>取消</Button>
          <Button variant="primary" disabled={blocked} onClick={() => { void submit(); }}>{CONFIRM[request.kind]}</Button>
        </>
      )}
    >
      <div className="mydsh-form">
        {request.kind === 'create'
          ? (
            <>
              <label className="mydsh-field"><span>名字</span>{field(name, setName, '名字', true)}</label>
              <label className="mydsh-field"><span>目标</span>{field(goal, setGoal, '目标', false)}</label>
            </>
          )
          : askName ? field(name, setName, '名字', true) : field(goal, setGoal, '目标', true)}
        {error !== null && <p className="mydsh-form-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
