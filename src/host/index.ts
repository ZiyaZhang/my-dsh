/**
 * my-dsh Host: the `mydsh/call` Remote over the matter store. Later milestones add the my dsh session, reports and reminders here.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { addSession, archiveMatter, createMatter, removeSession, renameMatter, setGoal, unarchiveMatter } from './matters.js';
import { RequestError, parseRequest, type BoardSnapshot, type MyDshRequest, type MyDshResponse } from './remote.js';
import { MatterStore } from './store.js';

export interface Config { dataDirectory?: string }
declare module '@deepseek-ai/cordis' { interface Context { mydsh: MyDsh } }

export default class MyDsh extends TypertRemoteService {
  static inject = ['typert'];
  /** `config.dataDirectory`, else `$DSH_HOME/my-dsh`, else `~/.dsh/my-dsh`. */
  readonly directory: string;
  private readonly store: MatterStore;
  private readonly ready: Promise<void>;

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'mydsh');
    this.directory = resolve(config.dataDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'my-dsh'));
    this.store = new MatterStore(this.directory);
    this.ready = this.store.open();
    void this.ready.catch(() => undefined); // reported by [Service.init] and by every call
  }

  /** A matter file that cannot be read fails the plugin start with the reason, rather than starting empty and overwriting it later. */
  async [Service.init](): Promise<void> { await this.ready; }

  /** The one Remote method; the client mounts its descriptor (`MY_DSH_REMOTE`), the Gateway finds it through `@Remote`. */
  @Remote
  async call(request: MyDshRequest, signal: AbortSignal): Promise<MyDshResponse> {
    signal.throwIfAborted();
    try {
      const parsed = parseRequest(request);
      await this.ready;
      const now = () => new Date().toISOString();
      switch (parsed.action) {
        case 'snapshot': return this.snapshot();
        case 'createMatter': return await this.store.update(matters => createMatter(matters, parsed, { id: randomUUID(), at: now() }));
        case 'renameMatter': return await this.store.update(matters => renameMatter(matters, parsed.id, parsed.name));
        case 'setGoal': return await this.store.update(matters => setGoal(matters, parsed.id, parsed.goal));
        case 'archiveMatter': return await this.store.update(matters => archiveMatter(matters, parsed.id, now()));
        case 'unarchiveMatter': return await this.store.update(matters => unarchiveMatter(matters, parsed.id));
        case 'addSession': return await this.store.update(matters => addSession(matters, parsed.matterId, parsed.sessionId));
        case 'removeSession': return await this.store.update(matters => removeSession(matters, parsed.sessionId));
      }
    } catch (error) {
      if (error instanceof RequestError) throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error });
      throw error;
    }
  }

  /** The matters alone, until the session index lands. */
  private snapshot(): BoardSnapshot {
    const matters = this.store.list().map(matter => ({
      id: matter.id, name: matter.name, goal: matter.goal, createdAt: matter.createdAt,
      ...(matter.archivedAt ? { archivedAt: matter.archivedAt } : {}), sessions: [], lastActivity: Date.parse(matter.createdAt),
    }));
    return { matters, unassigned: [], review: [], now: Date.now() };
  }
}
