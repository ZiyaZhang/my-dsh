/**
 * Our tabs in DSH's right sidebar, beside one of our conversations opened in DSH's own session page (from DSH's session list, or after
 * a reload). my dsh's: the board's short form (待处理, 事项, 今天完成) with 整页看 back to the board page. A matter's: its sessions by state, then the matter page's right column (定时, and 这件事的上下文 whose rows open in
 * place), with 整页看 back to the matter's page. The chips name the tabs: the whale and my dsh, or a folder and 事项：<name>. DSH draws
 * the strip, the resizing, closing and fullscreen around them.
 */
import { useSyncExternalStore } from 'react';
import { FishLogo, IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SidebarRightNavigationParams, SidebarRightTabDefinition, UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { BoardSource, BoardState } from './board-source.js';
import type { Dialogs } from './dialogs.js';
import type { Call } from './index.js';
import { HomeGroups, MatterGroups } from './MainPage.js';
import { useMinuteTick } from './parts.js';
import { MatterSide } from './ProjectPage.js';
import { HOME_KIND, HOME_TAB_ID, MATTER_KIND, MATTER_TAB_ID, tabMatter, type OpenConversation } from './tab-opener.js';

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The matter a matter tab was opened for. */
    myDshMatter: { matterId: string };
  }
}

/** The two tab types: page types, opened by kind, one per pane, and left off DSH's guide page. */
export const HOME_TAB: SidebarRightTabDefinition = { id: HOME_TAB_ID, kind: HOME_KIND, priority: 'extension', title: () => 'my dsh' };
export const MATTER_TAB: SidebarRightTabDefinition = { id: MATTER_TAB_ID, kind: MATTER_KIND, priority: 'extension', title: () => '事项' };

/**
 * What DSH gives a tab's body and chip: the session the tab sits beside, and the hook over the tab's information. The slot types reach
 * that hook through a store package this plugin does not install, so its type is restored here.
 */
interface TabStandard {
  sessionId: string;
  useTabInfo: unknown;
}

/** The matter a tab's opening named. */
const openedFor = (params: SidebarRightNavigationParams): string | undefined =>
  params !== undefined && 'matterId' in params ? params.matterId : undefined;

/** The matter a matter tab shows, once the board is read. */
function useTabMatter(sessionId: string, useTabInfo: unknown, state: BoardState) {
  const { tab } = (useTabInfo as UseSidebarRightTabInfo)();
  const matterId = openedFor(tab.navigation.params as SidebarRightNavigationParams);
  return state.status === 'ready' ? tabMatter(state.snapshot, sessionId, matterId) : undefined;
}

/** While the board is not read: 正在读取, or why it failed. */
function Unread({ state }: { state: BoardState }) {
  if (state.status === 'failed') return <p className="mydsh-error">读不到看板：{state.error}</p>;
  return state.status === 'loading' ? <p className="mydsh-quiet">正在读取</p> : null;
}

export interface HomeTabInjected {
  source: BoardSource;
  openSession: (sessionId: string) => void;
  /** Shows the board page: a matter's with its id, my dsh's with null. */
  openPage: (matterId: string | null) => void;
}

/** my dsh's tab: 看板 with 整页看, then the board's short form. */
export function HomeTab({ source, openSession, openPage }: TabStandard & HomeTabInjected) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useMinuteTick();
  return (
    <div className="mydsh-rt">
      <div className="mydsh-rt-head">
        <b>看板</b>
        <button type="button" className="mydsh-link is-quiet" onClick={() => { openPage(null); }}>整页看</button>
      </div>
      {state.status === 'ready'
        ? <HomeGroups snapshot={state.snapshot} now={Date.now()} openSession={openSession} openMatter={openPage} />
        : <Unread state={state} />}
    </div>
  );
}

export interface MatterTabInjected extends HomeTabInjected {
  call: Call;
  dialogs: Dialogs;
  /** Puts text into a session's input, where DSH lets the page. */
  prefill: (sessionId: string, text: string) => void;
  openConversation: OpenConversation;
}

/** A matter's tab: 看板 with 整页看, the matter's sessions by state, then its right column. */
export function MatterTab({ sessionId, useTabInfo, source, call, dialogs, openSession, openPage, prefill, openConversation }: TabStandard & MatterTabInjected) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const matter = useTabMatter(sessionId, useTabInfo, state);
  useMinuteTick();
  const now = Date.now();
  return (
    <div className="mydsh-rt">
      <div className="mydsh-rt-head">
        <b>看板</b>
        {matter && <button type="button" className="mydsh-link is-quiet" onClick={() => { openPage(matter.id); }}>整页看</button>}
      </div>
      {matter && state.status === 'ready'
        ? (
          <>
            <MatterGroups matter={matter} now={now} openSession={openSession} />
            <div className="mydsh-rt-panels">
              <MatterSide
                matter={matter}
                call={call}
                now={now}
                openSession={openSession}
                editContext={() => { dialogs.open({ kind: 'context', matterId: matter.id }); }}
                // The conversation beside the tab is the matter's: the words go into its input. A tab beside an older conversation of
                // the matter takes them to the current one.
                editInChat={(text) => {
                  if (matter.conversation?.sessionId === sessionId) prefill(sessionId, text);
                  else void openConversation({ matterId: matter.id, draft: text }).catch(() => {});
                }}
              />
            </div>
          </>
        )
        : state.status === 'ready' ? <p className="mydsh-quiet">找不到这件事项</p> : <Unread state={state} />}
    </div>
  );
}

/** my dsh's chip: the whale and my dsh. */
export function HomeTabTitle() {
  return <><FishLogo size={16} className="mydsh-rt-whale" />my dsh</>;
}

/** A matter's chip: a folder and 事项：<name>, live as the matter is renamed. */
export function MatterTabTitle({ sessionId, useTabInfo, source }: TabStandard & { source: BoardSource }) {
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const matter = useTabMatter(sessionId, useTabInfo, state);
  return <><IconFolderCloseRegular size={16} className="mydsh-rt-icon" />{matter ? `事项：${matter.name}` : '事项'}</>;
}
