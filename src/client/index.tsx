import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { MY_DSH_REMOTE, type MyDshRequest, type MyDshResponse } from '../host/remote.js';
import { BoardPage } from './BoardPage.js';
import styles from './style.css';

export type Call = (request: MyDshRequest, signal?: AbortSignal) => Promise<MyDshResponse>;

const PANEL = 'my-dsh' as MainPanelId;
export const inject = ['slots', 'layout', 'remote', 'uiWorkspace'];

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(MY_DSH_REMOTE);
  ctx.effect(() => unmount, 'my-dsh: remote');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.myDsh = 'styles'; style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  }, 'my-dsh: styles');
  const openSession = (sessionId: string) => { ctx.uiWorkspace.openSession(sessionId as SessionId); };
  ctx.inject(['remote.mydsh'], ctx => {
    const call: Call = async (request, signal) => {
      const result = await ctx.remote.mydsh.call(request, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL, inject: () => ({ call, openSession }),
    }, BoardPage));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL, order: 0, label: () => '看板',
    }, ({ size }: { size?: number }) => <BoardIcon size={size ?? 18} />));
  });
}

/** Four squares, the board. */
function BoardIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}
