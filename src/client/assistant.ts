/**
 * Opening my dsh's conversation, or a matter's: ask the Host for its session (made on first use) and wait until the client's session list
 * knows it; the page then retains it for its 看板 input and its 对话 tab. The Host's list and the client's catch up through events, so a
 * session made a moment ago can be missing from the client list for a short while.
 */

export interface KnownDeps {
  /** The Host's `assistant` action. */
  ensure(signal: AbortSignal): Promise<string>;
  /** Whether the client session list has the session. */
  known(sessionId: string): boolean;
  /** Read the session list again. */
  refresh(): Promise<void>;
  /** @returns the function that stops listening. */
  watch(listener: () => void): () => void;
  /** What the error says when the list does not learn the session in time; it names my dsh's session unless given. */
  missing?: string;
}

export interface AssistantDeps<R> extends KnownDeps {
  retain(sessionId: string, signal: AbortSignal): R;
}

/** How long the list may take to learn a new session. */
export const KNOWN_WAIT_MS = 10_000;

function waitKnown(deps: KnownDeps, sessionId: string, signal: AbortSignal, waitMs: number): Promise<void> {
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
    const timer = setTimeout(() => { finish(new Error(deps.missing ?? '会话列表里还没有 my dsh 的会话')); }, waitMs);
    signal.addEventListener('abort', aborted, { once: true });
    void deps.refresh().then(check, () => {});
  });
}

/** The session the Host names, once the client's session list knows it. */
export async function knownSession(deps: KnownDeps, signal: AbortSignal, waitMs = KNOWN_WAIT_MS): Promise<string> {
  const sessionId = await deps.ensure(signal);
  signal.throwIfAborted();
  await waitKnown(deps, sessionId, signal, waitMs);
  signal.throwIfAborted();
  return sessionId;
}

/** The session, known to the client list and retained. */
export async function openAssistant<R>(deps: AssistantDeps<R>, signal: AbortSignal, waitMs = KNOWN_WAIT_MS): Promise<{ sessionId: string; reference: R }> {
  const sessionId = await knownSession(deps, signal, waitMs);
  return { sessionId, reference: deps.retain(sessionId, signal) };
}
