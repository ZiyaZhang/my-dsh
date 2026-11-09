/**
 * The board's data on the client: the latest snapshot, read again on each `watch` notice. While the page is open the stream runs; when it
 * cannot open, fails or ends, the source reads the snapshot every 5 seconds instead, and tries the stream again after a connection reset.
 * Nothing runs while nobody reads the board.
 */
import type { BoardSnapshot } from '../host/remote.js';

export type BoardState =
  | { status: 'loading' }
  /** `error`: the last read failed; the snapshot is the one before it. */
  | { status: 'ready'; snapshot: BoardSnapshot; error?: string }
  | { status: 'failed'; error: string };

export interface BoardSourceDeps {
  fetch(signal: AbortSignal): Promise<BoardSnapshot>;
  /** Open the notice stream. May throw when the stream method is not there. */
  watch(signal: AbortSignal): AsyncIterable<unknown> & { dispose?(): void };
  /** @returns the unsubscribe function. */
  onReset(listener: () => void): () => void;
  /** @returns the function that stops the timer. */
  every(run: () => void, ms: number): () => void;
}

export const POLL_MS = 5_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One stretch of time with readers: from the first subscriber to the last unsubscribe. */
interface Run {
  readonly abort: AbortController;
  stopReset: () => void;
  stream?: { readonly abort: AbortController; readonly dispose: () => void };
  stopPoll?: () => void;
  /** The read in flight, and whether another read was asked for while it ran. */
  fetching?: Promise<void>;
  again: boolean;
}

export class BoardSource {
  private state: BoardState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private run: Run | undefined;
  /** How changes arrive right now. */
  mode: 'off' | 'stream' | 'poll' = 'off';

  constructor(private readonly deps: BoardSourceDeps) {}

  getSnapshot = (): BoardState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** Read the snapshot now. A read asked for while one runs makes one more read after it; the promise settles after that one. */
  refresh(): Promise<void> {
    const run = this.run;
    if (!run) return Promise.resolve();
    run.again = true;
    run.fetching ??= this.read(run);
    return run.fetching;
  }

  private async read(run: Run): Promise<void> {
    await Promise.resolve(); // `run.fetching` is set before the first read starts
    try {
      while (run.again && this.run === run) {
        run.again = false;
        try {
          const snapshot = await this.deps.fetch(run.abort.signal);
          if (this.run === run) this.set({ status: 'ready', snapshot });
        } catch (error) {
          if (this.run !== run || run.abort.signal.aborted) return;
          this.set(this.state.status === 'ready' ? { status: 'ready', snapshot: this.state.snapshot, error: message(error) } : { status: 'failed', error: message(error) });
        }
      }
    } finally {
      // Cleared in the same tick the loop ends, so a refresh asked for after it starts a new read.
      run.fetching = undefined;
    }
  }

  private set(state: BoardState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  private start(): void {
    const run: Run = { abort: new AbortController(), stopReset: () => {}, again: false };
    this.run = run;
    run.stopReset = this.deps.onReset(() => { this.reconnect(run); });
    void this.refresh();
    this.openStream(run);
  }

  private stop(): void {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    run.stopReset();
    this.closeStream(run);
    run.stopPoll?.();
    run.abort.abort();
    this.mode = 'off';
  }

  private openStream(run: Run): void {
    const abort = new AbortController();
    const stop = () => { abort.abort(); };
    run.abort.signal.addEventListener('abort', stop, { once: true });
    let handle: AsyncIterable<unknown> & { dispose?(): void };
    try {
      handle = this.deps.watch(abort.signal);
    } catch {
      this.poll(run, false);
      return;
    }
    const stream = { abort, dispose: () => { handle.dispose?.(); } };
    run.stream = stream;
    this.mode = 'stream';
    void (async () => {
      try {
        for await (const _notice of handle) {
          if (run.stream !== stream) return;
          void this.refresh();
        }
      } catch {
        // Reported below as the end of the stream.
      }
      if (this.run !== run || run.stream !== stream) return;
      run.stream = undefined;
      this.poll(run, true);
    })();
  }

  private closeStream(run: Run): void {
    const stream = run.stream;
    run.stream = undefined;
    stream?.abort.abort();
    stream?.dispose();
  }

  /** @param missed - a stream was open and may have missed changes, so read once now. */
  private poll(run: Run, missed: boolean): void {
    if (this.run !== run || run.stopPoll) return;
    this.mode = 'poll';
    run.stopPoll = this.deps.every(() => { void this.refresh(); }, POLL_MS);
    if (missed) void this.refresh();
  }

  /** The connection came back: an open stream is dead, and a stream that failed may work again. */
  private reconnect(run: Run): void {
    if (this.run !== run) return;
    this.closeStream(run);
    run.stopPoll?.();
    run.stopPoll = undefined;
    void this.refresh();
    this.openStream(run);
  }
}
