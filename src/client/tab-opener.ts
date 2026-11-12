/**
 * my dsh's two kinds of tab in DSH's right sidebar: my dsh's own session gets the board's short form, and a matter's conversation gets
 * that matter's. Our page shows these conversations in its own 对话 tab; one that comes on screen in DSH's own session page (DSH's
 * session list, a reload) gets the tab once, the first time; from then on the sidebar is the user's, and a tab they closed stays closed.
 * DSH draws a session's right sidebar only while the session is on screen, and makes the sidebar's store for it in the render after
 * that, so the opener waits for both before the tab can open. Pure apart from the deps, so it can be tested without DSH.
 */
import type { BoardMatter, BoardSnapshot } from '../host/remote.js';

/** The tab types' ids in DSH's tab system: the keys their bodies and chips register under. */
export const HOME_TAB_ID = 'dsh-my-dsh/home';
export const MATTER_TAB_ID = 'dsh-my-dsh/matter';

/** The tab kinds this plugin owns. */
export const HOME_KIND = 'myDsh';
export const MATTER_KIND = 'myDshMatter';

/** One of our tabs: my dsh's board, or one matter's. */
export type TabTarget = { kind: typeof HOME_KIND } | { kind: typeof MATTER_KIND; matterId: string };

/** A way into a conversation: my dsh's own, or with `matterId` the matter's (made on first use); `draft` goes into its input. */
export interface ConversationRequest {
  matterId?: string;
  draft?: string;
}

/** Shows a conversation on our page's 对话 tab, with `draft` in its input once the page holds the session. */
export type OpenConversation = (request: ConversationRequest) => Promise<void>;

const ours = (kind: string) => kind === HOME_KIND || kind === MATTER_KIND;

/** The tab a session gets: my dsh's in my dsh's own session, a matter's in that matter's conversation, none in any other session. */
export function tabFor(snapshot: BoardSnapshot, sessionId: string): TabTarget | undefined {
  if (snapshot.assistant.sessionId === sessionId) return { kind: HOME_KIND };
  const matter = snapshot.matters.find(candidate => candidate.conversation?.sessionId === sessionId);
  return matter ? { kind: MATTER_KIND, matterId: matter.id } : undefined;
}

/**
 * The matter a matter tab shows: the one it was opened for; DSH keeps no opening parameters across a reload, so a restored tab shows the
 * matter whose conversation it sits beside.
 */
export function tabMatter(snapshot: BoardSnapshot, sessionId: string, matterId: string | undefined): BoardMatter | undefined {
  if (matterId !== undefined) return snapshot.matters.find(matter => matter.id === matterId);
  return snapshot.matters.find(matter => matter.conversation?.sessionId === sessionId);
}

/** The sessions our tab was opened in. */
export interface OpenedSessions {
  has(sessionId: string): boolean;
  add(sessionId: string): void;
}

/** Where the browser keeps the sessions our tab was opened in, the newest last, at most {@link OPENED_MAX}. */
export const OPENED_KEY = 'mydsh.rightbar.opened';
export const OPENED_MAX = 200;

/** The sessions our tab was opened in, kept in browser storage so a reload does not open it again where the user closed it. */
export function openedSessions(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): OpenedSessions {
  let ids: string[] = [];
  try {
    const stored: unknown = JSON.parse(storage?.getItem(OPENED_KEY) ?? '[]');
    if (Array.isArray(stored)) ids = stored.filter((id): id is string => typeof id === 'string');
  } catch {
    // Unreadable: start over.
  }
  return {
    has: sessionId => ids.includes(sessionId),
    add: (sessionId) => {
      if (ids.includes(sessionId)) return;
      ids = [...ids, sessionId].slice(-OPENED_MAX);
      try {
        storage?.setItem(OPENED_KEY, JSON.stringify(ids));
      } catch {
        // Kept for this window only.
      }
    },
  };
}

export interface RightTabsDeps {
  /** The session DSH shows with its right sidebar; undefined while a panel fills the main area or no session is selected. */
  readonly mounted: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void };
  /** The kinds of the tabs in a session's right sidebar; none until DSH has made the sidebar's store for the session. */
  kinds(sessionId: string): readonly string[];
  /** Open one of our tabs in a session's right sidebar, or show it again; nothing happens until DSH has the sidebar's store. */
  open(sessionId: string, target: TabTarget): void;
  /** Which of our tabs a session gets, if any. */
  classify(sessionId: string, signal: AbortSignal): Promise<TabTarget | undefined>;
  readonly opened: OpenedSessions;
  /** Run `run` every `ms`. @returns the function that stops it. */
  every(run: () => void, ms: number): () => void;
  now(): number;
}

/** How long an open waits for the session to come on screen and for DSH to make its sidebar's store. */
export const OPEN_WAIT_MS = 5_000;
/** How often an open waiting for DSH tries again. */
export const OPEN_RETRY_MS = 50;

interface Pending {
  readonly sessionId: string;
  readonly target: TabTarget;
  readonly until: number;
  /** The session has been on screen since the open began. */
  shown: boolean;
}

/** Opens our tab once in the right sidebar of a session on screen, followed from {@link RightTabs.start}. One open waits at a time; a newer one replaces it. */
export class RightTabs {
  private pending: Pending | undefined;
  private stopRetry: (() => void) | undefined;
  /** The check of the session on screen, while it runs. */
  private checking: { sessionId: string; abort: AbortController } | undefined;
  /** Sessions found to be neither my dsh's nor a matter's conversation. They stay so: a conversation is always a new session. */
  private readonly others = new Set<string>();

  constructor(private readonly deps: RightTabsDeps) {}

  /** Follow the session on screen. @returns the function that stops. */
  start(): () => void {
    const stop = this.deps.mounted.subscribe(() => { this.screen(); });
    this.screen();
    return () => {
      stop();
      this.drop();
      this.checking?.abort.abort();
      this.checking = undefined;
    };
  }

  private screen(): void {
    const sessionId = this.deps.mounted.getSnapshot();
    if (this.checking && this.checking.sessionId !== sessionId) {
      this.checking.abort.abort();
      this.checking = undefined;
    }
    this.attempt();
    if (sessionId === undefined || this.pending?.sessionId === sessionId || this.checking?.sessionId === sessionId) return;
    if (this.others.has(sessionId) || this.deps.opened.has(sessionId)) return;
    const abort = new AbortController();
    const check = { sessionId, abort };
    this.checking = check;
    this.deps.classify(sessionId, abort.signal).then((target) => {
      if (this.checking !== check) return;
      this.checking = undefined;
      if (!target) {
        this.others.add(sessionId);
        return;
      }
      if (this.deps.mounted.getSnapshot() !== sessionId || this.pending?.sessionId === sessionId || this.deps.opened.has(sessionId)) return;
      this.wait({ sessionId, target, until: this.deps.now() + OPEN_WAIT_MS, shown: false });
      this.attempt();
    }, () => {
      // Checked again the next time the session comes on screen.
      if (this.checking === check) this.checking = undefined;
    });
  }

  private wait(pending: Pending): void {
    this.drop();
    this.pending = pending;
    this.stopRetry = this.deps.every(() => { this.attempt(); }, OPEN_RETRY_MS);
  }

  private drop(): void {
    this.stopRetry?.();
    this.stopRetry = undefined;
    this.pending = undefined;
  }

  /** One try at the waiting open. It needs the session on screen and DSH's store for its sidebar, which shows in `kinds` once the open landed. */
  private attempt(): void {
    const pending = this.pending;
    if (!pending) return;
    if (this.deps.now() > pending.until) {
      this.drop();
      return;
    }
    const { sessionId, target } = pending;
    if (this.deps.mounted.getSnapshot() !== sessionId) {
      // The user moved on after the session came on screen.
      if (pending.shown) this.drop();
      return;
    }
    pending.shown = true;
    // The sidebar already has one of ours: the user's choice stands.
    if (this.deps.kinds(sessionId).some(ours)) {
      this.deps.opened.add(sessionId);
      this.drop();
      return;
    }
    this.deps.open(sessionId, target);
    // Without the sidebar's store the open did nothing, and the session lists no tabs yet.
    if (!this.deps.kinds(sessionId).includes(target.kind)) return;
    this.deps.opened.add(sessionId);
    this.drop();
  }
}
