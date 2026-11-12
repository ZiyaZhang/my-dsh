/**
 * my dsh's conversation, or a matter's, inside the page: DSH's own conversation view of the session, with its composer, rendered through
 * the `conversation.content` factory in its embedded variant. The board's input (`top`) shows only the composer, and says when a message
 * it sent was accepted, so the page can show the conversation.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** my dsh's conversation, or a matter's, inside the page. */
    'mydsh.dock.conversation': { kind: 'single'; scope: 'session'; owner: DockConversationOwner };
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The board page's dock, which shows my dsh's conversation. */
    myDshDock: unknown;
  }
}

/** What the dock passes its conversation. */
export interface DockConversationOwner {
  /** Runs when the Host accepted a message sent from this composer. */
  onSent?: (() => void) | undefined;
}

/** What the board page's `main` entry gets for the dock's child slot. */
export type DockSlots = PropsRenderSlots<'mydsh.dock.conversation'>;

export type OpenDock = (signal: AbortSignal) => Promise<{ sessionId: string; reference: SessionReference }>;

type DockState =
  | { status: 'opening' }
  | { status: 'open'; sessionId: string; reference: SessionReference }
  | { status: 'failed'; error: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function Dock({ openDock, renderSlot, SessionProvider, openSession, showActivity, variant = 'dock', top, peek, onSent }: DockSlots & {
  openDock: OpenDock;
  openSession: (sessionId: string) => void;
  showActivity: () => void;
  /** `dock`: under the board. `side`: my dsh's column on the right, with `top` above the conversation. `drawer`: folded to `peek` and
   * the composer at the bottom, opening upward over the board. `top`: the composer alone, the board's input. `main`: the whole
   * conversation filling its column. */
  variant?: 'dock' | 'side' | 'drawer' | 'top' | 'main';
  top?: ReactNode;
  peek?: string;
  /** Runs when the Host accepted a message sent from the composer. */
  onSent?: () => void;
}) {
  const [state, setState] = useState<DockState>({ status: 'opening' });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let held: SessionReference | undefined;
    setState({ status: 'opening' });
    openDock(abort.signal).then((opened) => {
      if (abort.signal.aborted) { opened.reference.release(); return; }
      held = opened.reference;
      setState({ status: 'open', ...opened });
    }, (error: unknown) => {
      if (!abort.signal.aborted) setState({ status: 'failed', error: message(error) });
    });
    return () => { abort.abort(); held?.release(); };
  }, [openDock, attempt]);

  const sessionId = state.status === 'open' ? state.sessionId : undefined;
  const links = (
    <span className="mydsh-dock-links">
      <button type="button" className="mydsh-link" disabled={sessionId === undefined} onClick={() => { if (sessionId) openSession(sessionId); }}>全部记录</button>
      <button type="button" className="mydsh-link" onClick={showActivity}>做事记录</button>
      {variant === 'drawer' && <button type="button" className="mydsh-link" onClick={() => { setOpen(false); }}>收起</button>}
    </span>
  );
  const body = (
    <div className="mydsh-dock-body">
      {state.status === 'open' && (
        <SessionProvider session={state.reference}>{renderSlot('mydsh.dock.conversation', { onSent })}</SessionProvider>
      )}
      {state.status === 'failed' && (
        <p className="mydsh-dock-note">
          <span className="mydsh-error">{state.error}</span>
          <button type="button" className="mydsh-link" onClick={() => { setAttempt(n => n + 1); }}>重试</button>
        </p>
      )}
    </div>
  );
  if (variant === 'top') return <section className="mydsh-top">{body}</section>;
  if (variant === 'main') return <section className="mydsh-mainconv">{body}</section>;
  if (variant === 'side') {
    return (
      <aside className="mydsh-side" aria-label="my dsh">
        <div className="mydsh-side-head"><h2>my dsh</h2>{links}</div>
        {top && <div className="mydsh-side-top">{top}</div>}
        {body}
      </aside>
    );
  }
  if (variant === 'drawer') {
    return (
      <section
        className={`mydsh-drawer${open ? ' is-open' : ''}`}
        onFocusCapture={(event) => { if ((event.target as HTMLElement).closest('[contenteditable], textarea, input')) setOpen(true); }}
        onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}
      >
        {open
          ? <div className="mydsh-dock-head"><h2>my dsh</h2>{links}</div>
          : (
            <button type="button" className="mydsh-drawer-peek" onClick={() => { setOpen(true); }}>
              <b>my dsh</b>
              <span className="mydsh-drawer-line">{peek ?? ''}</span>
              <span className="mydsh-drawer-open">展开</span>
            </button>
          )}
        {body}
      </section>
    );
  }
  return (
    <section className="mydsh-dock">
      <div className="mydsh-dock-head"><h2>my dsh</h2>{links}</div>
      {body}
    </section>
  );
}

/**
 * The dock's conversation: the transcript and the composer, with Chat as its only view. A message the composer sends shows in the
 * session's accepted echoes until its turn is recorded; one more of them than before means the composer just sent one.
 */
export function DockConversation({ useSession, renderFactorySlot, onSent }: PropsRuntime<'mydsh.dock.conversation'> & PropsRenderFactories) {
  const loading = useSession((session: SessionSnapshot) => session.openState === 'loading' || session.openState === 'cold');
  const sent = useSession((session: SessionSnapshot) => session.pendingSubmissions.length);
  const seen = useRef(sent);
  useEffect(() => {
    if (sent > seen.current) onSent?.();
    seen.current = sent;
  }, [sent, onSent]);
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: loading ? 'settling' : 'active', hero: false }, {
    slots: { views: ChatView },
  });
}

function ChatView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>;
}
