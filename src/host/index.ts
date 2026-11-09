/**
 * my-dsh Host: the `mydsh/call` Remote over the matter store and the session index. Later milestones add the my dsh session, reports
 * and reminders here.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-storage-domain';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-workspace';
import { addSession, archiveMatter, createMatter, removeSession, renameMatter, setGoal, unarchiveMatter } from './matters.js';
import { RequestError, parseRequest, type BoardSnapshot, type MyDshRequest, type MyDshResponse } from './remote.js';
import { SessionIndex, sessionView, type SessionRow } from './sessions.js';
import { buildSnapshot, type WorkspaceFacts } from './snapshot.js';
import { MatterStore } from './store.js';

export interface Config { dataDirectory?: string }
declare module '@deepseek-ai/cordis' { interface Context { mydsh: MyDsh } }

/** A session list row as the index reads it. A projection block that leaves the title out says nothing about it. */
function toRow(summary: SessionSummary): SessionRow {
  const values = summary.projections?.values;
  return {
    sessionId: summary.sessionId, updatedAt: summary.updatedAt, running: summary.running, blank: summary.blank,
    ...(summary.origin ? { origin: summary.origin } : {}),
    ...(values && 'title' in values ? { title: values.title ?? null } : {}),
  };
}

export default class MyDsh extends TypertRemoteService {
  static inject = ['typert', 'sessionController', 'workspaceRegistry'];
  /** `config.dataDirectory`, else `$DSH_HOME/my-dsh`, else `~/.dsh/my-dsh`. */
  readonly directory: string;
  private readonly store: MatterStore;
  private readonly sessions: SessionIndex;
  private readonly ready: Promise<void>;
  private readonly lifetime = new AbortController();
  /** The first session listing; cleared when it fails, so the next snapshot tries again. */
  private listing: Promise<void> | undefined;

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'mydsh');
    this.directory = resolve(config.dataDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'my-dsh'));
    this.store = new MatterStore(this.directory, () => { this.changed(); });
    this.sessions = new SessionIndex(() => { this.changed(); });
    // Listen before the first listing, so nothing that happens while it runs is lost.
    ctx.on('api-session/added', (summary) => { this.sessions.added(toRow(summary)); });
    ctx.on('api-session/removed', (sessionId) => { this.sessions.removed(sessionId); });
    ctx.on('api-session/status', (sessionId, running) => { this.sessions.status(sessionId, running); });
    ctx.on('api-session/activity', (sessionId, updatedAt) => { this.sessions.activity(sessionId, updatedAt); });
    ctx.on('session/event', (session, event) => { this.sessions.event(session.id, event); }, { global: true });
    // Workspace titles, membership and the archive set live in the workspace domain.
    ctx.on('domain/changed', (change) => { if (change.domain === 'workspace') this.changed(); });
    ctx.effect(() => () => { this.lifetime.abort(); }, 'my-dsh: lifetime');
    this.ready = this.store.open();
    void this.ready.catch(() => undefined); // reported by [Service.init] and by every call
  }

  /** A matter file that cannot be read fails the plugin start with the reason, rather than starting empty and overwriting it later. */
  async [Service.init](): Promise<void> {
    await this.ready;
    void this.loadSessions().catch(() => undefined); // a failure reaches the page through the next snapshot
  }

  /** The one Remote method; the client mounts its descriptor (`MY_DSH_REMOTE`), the Gateway finds it through `@Remote`. */
  @Remote
  async call(request: MyDshRequest, signal: AbortSignal): Promise<MyDshResponse> {
    signal.throwIfAborted();
    try {
      const parsed = parseRequest(request);
      await this.ready;
      const now = () => new Date().toISOString();
      switch (parsed.action) {
        case 'snapshot': return await this.snapshot();
        case 'createMatter': return await this.store.update(matters => createMatter(matters, parsed, { id: randomUUID(), at: now() }));
        case 'renameMatter': return await this.store.update(matters => renameMatter(matters, parsed.id, parsed.name));
        case 'setGoal': return await this.store.update(matters => setGoal(matters, parsed.id, parsed.goal));
        case 'archiveMatter': return await this.store.update(matters => archiveMatter(matters, parsed.id, now()));
        case 'unarchiveMatter': return await this.store.update(matters => unarchiveMatter(matters, parsed.id));
        case 'addSession':
          await this.requireSession(parsed.sessionId);
          return await this.store.update(matters => addSession(matters, parsed.matterId, parsed.sessionId));
        case 'removeSession': return await this.store.update(matters => removeSession(matters, parsed.sessionId));
      }
    } catch (error) {
      if (error instanceof RequestError) throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error });
      throw error;
    }
  }

  /** Something the board shows changed. */
  private changed(): void {}

  private async snapshot(): Promise<BoardSnapshot> {
    await this.loadSessions();
    return buildSnapshot({
      matters: this.store.list(),
      sessions: this.sessions.all().map(sessionView),
      workspaces: this.workspaceFacts(),
      now: Date.now(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  private loadSessions(): Promise<void> {
    if (!this.listing) {
      const run = this.listSessions();
      this.listing = run;
      run.catch(() => { if (this.listing === run) this.listing = undefined; });
    }
    return this.listing;
  }

  private async listSessions(): Promise<void> {
    const { items } = await this.ctx.sessionController.list({}, this.lifetime.signal);
    this.sessions.load(items.map(toRow));
  }

  /** A session the index does not know may come from another DSH process after the first listing, so list once more before refusing. */
  private async requireSession(sessionId: string): Promise<void> {
    await this.loadSessions();
    if (!this.sessions.has(sessionId)) await this.listSessions();
    if (!this.sessions.has(sessionId)) throw new RequestError('没有这个会话');
  }

  private workspaceFacts(): WorkspaceFacts {
    const workspaceOf = new Map<string, string>();
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      for (const sessionId of workspace.sessionIds) if (!workspaceOf.has(sessionId)) workspaceOf.set(sessionId, workspace.title);
    }
    return { workspaceOf, archived: new Set(this.ctx.workspaceRegistry.archivedSessionIds) };
  }
}
