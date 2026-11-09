/**
 * Change notices for the `watch` stream. The first change schedules one notice after the delay and later changes ride along with it, so a
 * busy session costs at most one notice per delay. A reader that falls behind gets only the latest revision.
 */
import type { WatchNotice } from './remote.js';

export interface Scheduler {
  /** @returns a function that cancels the run. */
  schedule(run: () => void, ms: number): () => void;
}

export const timerScheduler: Scheduler = {
  schedule(run, ms) {
    const timer = setTimeout(run, ms);
    return () => { clearTimeout(timer); };
  },
};

export class ChangeFeed {
  private revision = 0;
  private cancel: (() => void) | undefined;
  private closed = false;
  private readonly wakers = new Set<() => void>();

  constructor(private readonly delayMs = 300, private readonly scheduler: Scheduler = timerScheduler) {}

  /** Something the board shows changed. */
  touch(): void {
    if (this.closed || this.cancel) return;
    this.cancel = this.scheduler.schedule(() => {
      this.cancel = undefined;
      this.revision += 1;
      this.wake();
    }, this.delayMs);
  }

  /** The current revision first, then each later one, until `signal` aborts or the feed closes. */
  async *follow(signal: AbortSignal): AsyncGenerator<WatchNotice, void, undefined> {
    let seen = this.revision;
    yield { revision: seen };
    while (true) {
      if (this.revision === seen) await this.next(signal);
      if (signal.aborted || this.closed) return;
      if (this.revision !== seen) {
        seen = this.revision;
        yield { revision: seen };
      }
    }
  }

  /** End every stream; later changes are ignored. */
  close(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
    this.wake();
  }

  private next(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.wakers.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.wakers.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }
}
