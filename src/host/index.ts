/**
 * my-dsh Host: the `mydsh/call` Remote over the matter store. Later milestones add the my dsh session, reports and reminders here.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { RequestError, parseRequest, type MyDshRequest, type MyDshResponse } from './remote.js';
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
      switch (parsed.action) {
        case 'snapshot': return { matters: this.store.list() };
      }
    } catch (error) {
      if (error instanceof RequestError) throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error });
      throw error;
    }
  }
}
