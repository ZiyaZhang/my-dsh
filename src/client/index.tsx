import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { FileUploadService } from '@deepseek-ai/dsh-client-file-upload/client';
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import { IconCloseOutlineRegular, IconGoalOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { MY_DSH_REMOTE, type MyDshRequest, type MyDshResult, type UploadSource } from '../host/remote.js';
import { openAssistant } from './assistant.js';
import { BoardPage } from './BoardPage.js';
import { BoardSource } from './board-source.js';
import { CardTail, type CardActions } from './Cards.js';
import type { ContextTools } from './ContextFields.js';
import { Dialogs } from './dialogs.js';
import { DockConversation, type OpenDock } from './Dock.js';
import { MatterDialogs } from './MatterDialog.js';
import { PageRequests } from './pages.js';
import { HOME_TAB, HomeTab, HomeTabTitle, MATTER_TAB, MatterTab, MatterTabTitle } from './RightTabs.js';
import styles from './style.css';
import { HOME_KIND, HOME_TAB_ID, MATTER_KIND, MATTER_TAB_ID, RightTabs, openedSessions, tabFor, type OpenConversation } from './tab-opener.js';

export type Call = <R extends MyDshRequest>(request: R, signal?: AbortSignal) => Promise<MyDshResult<R>>;

const PANEL = 'my-dsh' as MainPanelId;
export const inject = ['slots', 'layout', 'remote', 'uiWorkspace', 'sessions', 'sidebarRight', 'sidebarRightTabs'];

/** The browser's storage, where the page may use it. */
function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

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
  // `ctx.sessions` is typed as the Host session store when Host packages are in the same program; on the client it is ISessions.
  const sessions = (ctx as unknown as { sessions: ISessions }).sessions;
  const dialogs = new Dialogs();
  const pages = new PageRequests();
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
    const list = {
      known: (sessionId: string) => sessions.list.getSnapshot().byId[sessionId as SessionId] !== undefined,
      refresh: () => sessions.refresh(),
      watch: (listener: () => void) => sessions.list.subscribe(listener),
      retain: (sessionId: string, inner: AbortSignal) => sessions.retain(sessionId as SessionId, { source: 'myDshDock', signal: inner }),
    };
    const openDock: OpenDock = signal => openAssistant({ ...list, ensure: async inner => (await call({ action: 'assistant' }, inner)).sessionId }, signal);
    // DSH's conversation input takes a draft for a session someone holds; without the service or the session, nothing goes in.
    const prefill = (sessionId: string, text: string): boolean => {
      const conversation = (ctx as unknown as { get(name: string): IConversation | undefined }).get('conversation');
      const binding = sessions.binding(sessionId as SessionId);
      if (!conversation || !binding) return false;
      try {
        conversation.input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'append' });
        return true;
      } catch {
        // A session let go of in the meantime takes no draft; the words wait for the next try.
        return false;
      }
    };
    const MISSING_MATTER = '会话列表里还没有这件事的对话';
    // A matter's own conversation, made by the Host on first use.
    const openMatterDock = (matterId: string): OpenDock => signal => openAssistant({
      ...list, ensure: async inner => (await call({ action: 'assistant', matterId }, inner)).sessionId, missing: MISSING_MATTER,
    }, signal);
    // Our tabs sit beside a conversation in DSH's own session page, where the board page is not mounted: it takes the request when it mounts.
    const openPage = (matterId: string | null) => { pages.open({ matterId }); ctx.layout.selectPanel(PANEL); };
    const sidebar = ctx.sidebarRight;
    const tabs = new RightTabs({
      mounted: sidebar.mounted,
      kinds: sessionId => sidebar.tabsIn(sessionId as SessionId).map(tab => tab.kind),
      open: (sessionId, target) => {
        if (target.kind === MATTER_KIND) sidebar.openTabIn(sessionId as SessionId, MATTER_KIND, { params: { matterId: target.matterId } });
        else sidebar.openTabIn(sessionId as SessionId, HOME_KIND);
      },
      // The board the page read last knows my dsh's session and the conversations; one it does not know is asked of the Host.
      classify: async (sessionId, signal) => {
        const state = source.getSnapshot();
        const known = state.status === 'ready' ? tabFor(state.snapshot, sessionId) : undefined;
        return known ?? tabFor(await call({ action: 'snapshot' }, signal), sessionId);
      },
      opened: openedSessions(browserStorage()),
      every: (run, ms) => {
        const timer = setInterval(run, ms);
        return () => { clearInterval(timer); };
      },
      now: () => Date.now(),
    });
    ctx.effect(() => ctx.sidebarRightTabs.register(HOME_TAB), 'my-dsh: home tab type');
    ctx.effect(() => ctx.sidebarRightTabs.register(MATTER_TAB), 'my-dsh: matter tab type');
    ctx.effect(() => tabs.start(), 'my-dsh: right sidebar tabs');
    // Our conversations show in our page's 对话 tab, which holds the session; the page makes a matter's on first use.
    const openConversation: OpenConversation = ({ matterId, draft }) => {
      pages.open({ matterId: matterId ?? null, tab: 'chat', ...(draft ? { draft } : {}) });
      ctx.layout.selectPanel(PANEL);
      return Promise.resolve();
    };
    const actions: CardActions = {
      accept: async (id) => { await call({ action: 'acceptProposal', id }); await source.refresh(); },
      decline: async (id) => { await call({ action: 'declineProposal', id }); await source.refresh(); },
      answer: async (id, candidateId) => { await call({ action: 'answerWhich', id, candidateId }); await source.refresh(); },
      undo: async (id) => { await call({ action: 'undo', id }); await source.refresh(); },
      openSession,
      openMatter: matterId => openConversation({ matterId }),
    };
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL,
      children: { 'mydsh.dock.conversation': { kind: 'single', scope: 'session' } },
      inject: () => ({ source, call, dialogs, openSession, openDock, openMatterDock, prefill, pages }),
    }, BoardPage));
    ctx.slots.inject('sidebar.right.pane.tab', function* () {
      yield ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: HOME_TAB_ID, inject: () => ({ source, openSession, openPage }),
      }, HomeTab);
      yield ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: MATTER_TAB_ID,
        inject: () => ({ source, call, dialogs, openSession, openPage, prefill, openConversation }),
      }, MatterTab);
    });
    ctx.slots.inject('sidebar.right.pane.tab.title', function* () {
      yield ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: HOME_TAB_ID }, HomeTabTitle);
      yield ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: MATTER_TAB_ID, inject: () => ({ source }) }, MatterTabTitle);
    });
    ctx.slots.inject('mydsh.dock.conversation', () => ctx.slots.register({ name: 'mydsh.dock.conversation' }, DockConversation));
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail', id: 'my-dsh.cards',
      inject: () => ({ source, actions }),
    }, CardTail));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL, order: 0, label: () => 'my dsh',
    }, ({ size }: { size?: number }) => <IconSparkleRegular size={size ?? 16} />));
    const tools: ContextTools = {
      checkPath: path => call({ action: 'checkPath', path }),
      // The chooser DSH's own add-folder flow opens: the desktop bridge, else the Host's OS chooser.
      pickFolder: () => {
        const desktop = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__;
        return desktop ? desktop.pick() : ctx.uiWorkspace.pickDirectory();
      },
      // DSH's composer upload: the file goes into DSH's attachment store under my dsh's session, and the Host copies it into the matter's folder on save.
      upload: async (file: File): Promise<UploadSource> => {
        const service = (ctx as unknown as { get(name: string): FileUploadService | undefined }).get('fileUpload');
        if (!service) throw new Error('这里不能上传文件');
        const { sessionId } = await call({ action: 'assistant' });
        const result = await service.upload(sessionId as SessionId, file, file.name);
        if (!result.ok) throw new Error(result.error.message);
        return { kind: 'upload', attachmentId: result.value.file.attachmentId, name: result.value.file.name, bytes: result.value.file.bytes };
      },
    };
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'my-dsh.dialogs', inject: () => ({ dialogs, call, after, source, tools }),
    }, MatterDialogs));
    ctx.inject(['contextMenus'], (ctx) => { registerSessionMenu(ctx, call, dialogs, after); });
  });
}

const ICON_MATTER = 'my-dsh.matter';
const ICON_NEW = 'my-dsh.new';
const ICON_LEAVE = 'my-dsh.leave';

/** 加入事项 with the matters in progress and 新建事项; 移出事项「name」 when the session is in one. Nothing for my dsh's or a matter's conversation. */
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
      // Conversations are not filed: my dsh's own, and each matter's.
      if (sessionId === snapshot.assistant.sessionId || snapshot.matters.some(matter => matter.conversation?.sessionId === sessionId)) return [];
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
