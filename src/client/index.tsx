import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import { IconCloseOutlineRegular, IconGoalOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { MY_DSH_REMOTE, type MyDshRequest, type MyDshResult } from '../host/remote.js';
import { BoardPage } from './BoardPage.js';
import { BoardSource } from './board-source.js';
import { Dialogs } from './dialogs.js';
import { MatterDialogs } from './MatterDialog.js';
import styles from './style.css';

export type Call = <R extends MyDshRequest>(request: R, signal?: AbortSignal) => Promise<MyDshResult<R>>;

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
  const dialogs = new Dialogs();
  ctx.inject(['remote.mydsh'], (ctx) => {
    const call: Call = async <R extends MyDshRequest>(request: R, signal?: AbortSignal) => {
      const result = await ctx.remote.mydsh.call(request, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value as MyDshResult<R>;
    };
    const source = new BoardSource({
      fetch: signal => call({ action: 'snapshot' }, signal),
      watch: signal => ctx.remote.mydsh.watch(signal),
      onReset: (listener) => {
        const dispose = ctx.on('connection/reset', listener);
        return () => { dispose(); };
      },
      every: (run, ms) => {
        const timer = setInterval(run, ms);
        return () => { clearInterval(timer); };
      },
    });
    const after = () => { void source.refresh(); };
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL, inject: () => ({ source, call, dialogs, openSession }),
    }, BoardPage));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL, order: 0, label: () => '看板',
    }, ({ size }: { size?: number }) => <BoardIcon size={size ?? 18} />));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'my-dsh.dialogs', inject: () => ({ dialogs, call, after }),
    }, MatterDialogs));
    ctx.inject(['contextMenus'], (ctx) => { registerSessionMenu(ctx, call, dialogs, after); });
  });
}

const ICON_MATTER = 'my-dsh.matter';
const ICON_NEW = 'my-dsh.new';
const ICON_LEAVE = 'my-dsh.leave';

/** 加入事项 with the matters in progress and 新建事项; 移出事项「name」 when the session is in one. */
function registerSessionMenu(ctx: Context, call: Call, dialogs: Dialogs, after: () => void): void {
  ctx.slots.inject('contextMenu.icon', function* () {
    yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_MATTER }, IconGoalOutlineRegular);
    yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_NEW }, IconPlusOutlineRegular);
    yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_LEAVE }, IconCloseOutlineRegular);
  });
  ctx.effect(() => ctx.contextMenus.register({
    // After 置顶, 重命名 and 分叉, before the session id and 归档.
    id: 'my-dsh.matters', target: 'session', order: 350,
    resolve: async ({ sessionId }, signal) => {
      const snapshot = await call({ action: 'snapshot' }, signal);
      const current = snapshot.matters.find(matter => matter.sessions.some(session => session.id === sessionId));
      const others = snapshot.matters.filter(matter => !matter.archivedAt && matter.id !== current?.id);
      const actions: MenuAction[] = [{
        id: 'my-dsh.join', label: '加入事项', icon: { key: ICON_MATTER }, separatorBefore: true,
        children: [
          ...others.map((matter): MenuAction => ({
            id: `my-dsh.join.${matter.id}`, label: matter.name, icon: { key: ICON_MATTER }, failureLabel: '加入事项失败',
            run: async () => { await call({ action: 'addSession', matterId: matter.id, sessionId }); after(); },
          })),
          {
            id: 'my-dsh.join.new', label: '新建事项', icon: { key: ICON_NEW }, separatorBefore: others.length > 0,
            run: () => { dialogs.open({ kind: 'create', sessionId }); },
          },
        ],
      }];
      if (current) {
        actions.push({
          id: 'my-dsh.leave', label: `移出事项「${current.name}」`, icon: { key: ICON_LEAVE }, failureLabel: '移出事项失败',
          run: async () => { await call({ action: 'removeSession', sessionId }); after(); },
        });
      }
      return actions;
    },
  }), 'my-dsh: session menu');
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
