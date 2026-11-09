/**
 * The bottom of the board page: my dsh's conversation, docked. It is DSH's own conversation view of my dsh's session, with its composer,
 * rendered through the `conversation.content` factory in its embedded variant.
 */
import { useEffect, useState } from 'react';
import type { SessionReference, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** my dsh's conversation, docked under the board. */
    'mydsh.dock.conversation': { kind: 'single'; scope: 'session' };
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The board page's dock, which shows my dsh's conversation. */
    myDshDock: unknown;
  }
}

/** What the board page's `main` entry gets for the dock's child slot. */
export type DockSlots = PropsRenderSlots<'mydsh.dock.conversation'>;

export type OpenDock = (signal: AbortSignal) => Promise<{ sessionId: string; reference: SessionReference }>;

type DockState =
  | { status: 'opening' }
  | { status: 'open'; sessionId: string; reference: SessionReference }
  | { status: 'failed'; error: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function Dock({ openDock, renderSlot, SessionProvider, openSession, showActivity }: DockSlots & {
  openDock: OpenDock;
  openSession: (sessionId: string) => void;
  showActivity: () => void;
}) {
  const [state, setState] = useState<DockState>({ status: 'opening' });
  const [attempt, setAttempt] = useState(0);
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
  return (
    <section className="mydsh-dock">
      <div className="mydsh-dock-head">
        <h2>my dsh</h2>
        <span className="mydsh-dock-links">
          <button type="button" className="mydsh-link" disabled={sessionId === undefined} onClick={() => { if (sessionId) openSession(sessionId); }}>全部记录</button>
          <button type="button" className="mydsh-link" onClick={showActivity}>做事记录</button>
        </span>
      </div>
      <div className="mydsh-dock-body">
        {state.status === 'open' && (
          <SessionProvider session={state.reference}>{renderSlot('mydsh.dock.conversation', {})}</SessionProvider>
        )}
        {state.status === 'failed' && (
          <p className="mydsh-dock-note">
            <span className="mydsh-error">{state.error}</span>
            <button type="button" className="mydsh-link" onClick={() => { setAttempt(n => n + 1); }}>重试</button>
          </p>
        )}
      </div>
    </section>
  );
}

/** The dock's conversation: the transcript and the composer, with Chat as its only view. */
export function DockConversation({ useSession, renderFactorySlot }: PropsRuntime<'mydsh.dock.conversation'> & PropsRenderFactories) {
  const loading = useSession((session: SessionSnapshot) => session.openState === 'loading' || session.openState === 'cold');
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: loading ? 'settling' : 'active', hero: false }, {
    slots: { views: ChatView },
  });
}

function ChatView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>;
}
