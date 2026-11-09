/**
 * Opening my dsh's conversation for the dock: ask the Host for its session (made on first use), wait until the client's session list
 * knows it, then retain it. The Host's list and the client's catch up through events, so a session made a moment ago can be missing
 * from the client list for a short while.
 */

export interface AssistantDeps<R> {
  /** The Host's `assistant` action. */
  ensure(signal: AbortSignal): Promise<string>;
  /** Whether the client session list has the session. */
  known(sessionId: string): boolean;
  /** Read the session list again. */
  refresh(): Promise<void>;
  /** @returns the function that stops listening. */
  watch(listener: () => void): () => void;
  retain(sessionId: string, signal: AbortSignal): R;
}

/** How long the list may take to learn a new session. */
export const KNOWN_WAIT_MS = 10_000;

function waitKnown<R>(deps: AssistantDeps<R>, sessionId: string, signal: AbortSignal, waitMs: number): Promise<void> {
  if (deps.known(sessionId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stop();
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (error === undefined) resolve(); else reject(error);
    };
    const check = () => { if (deps.known(sessionId)) finish(); };
    const aborted = () => { finish(signal.reason ?? new Error('aborted')); };
    const stop = deps.watch(check);
    const timer = setTimeout(() => { finish(new Error('会话列表里还没有 my dsh 的会话')); }, waitMs);
    signal.addEventListener('abort', aborted, { once: true });
    void deps.refresh().then(check, () => {});
  });
}

export async function openAssistant<R>(deps: AssistantDeps<R>, signal: AbortSignal, waitMs = KNOWN_WAIT_MS): Promise<{ sessionId: string; reference: R }> {
  const sessionId = await deps.ensure(signal);
  signal.throwIfAborted();
  await waitKnown(deps, sessionId, signal, waitMs);
  signal.throwIfAborted();
  return { sessionId, reference: deps.retain(sessionId, signal) };
}
