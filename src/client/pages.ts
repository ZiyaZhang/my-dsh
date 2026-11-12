/**
 * Where my dsh's page goes next when something else asks: our tabs in DSH's right sidebar (整页看, a matter's row), which sit beside a
 * conversation in DSH's own session page where the page is not mounted, and every way into one of our conversations (a card's matter,
 * 接着说, 在对话里改 from a tab). The request waits here until the page takes it.
 */
export interface PageRequest {
  /** The matter whose page to show; null for my dsh's. */
  matterId: string | null;
  /** The tab to show: 看板 unless given. */
  tab?: 'board' | 'chat';
  /** Words for that page's conversation input; they go in once the page holds the conversation. */
  draft?: string;
}

export class PageRequests {
  private pending: PageRequest | undefined;
  private readonly listeners = new Set<() => void>();

  open(request: PageRequest): void {
    this.pending = request;
    for (const listener of this.listeners) listener();
  }

  /** The waiting request, once: taking it clears it. */
  take(): PageRequest | undefined {
    const request = this.pending;
    this.pending = undefined;
    return request;
  }

  /** @returns the function that stops listening. */
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
