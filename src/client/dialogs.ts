/** Which matter dialog is open. The board page and the session context menu open them; one `shell.overlay` entry draws them. */

export type DialogRequest =
  /** `sessionId`: the session to put in the new matter, when the session context menu asked. */
  | { kind: 'create'; sessionId?: string }
  | { kind: 'rename'; matterId: string; name: string }
  | { kind: 'goal'; matterId: string; goal: string };

export class Dialogs {
  private request: DialogRequest | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): DialogRequest | null => this.request;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  open(request: DialogRequest): void { this.set(request); }
  close(): void { this.set(null); }

  private set(request: DialogRequest | null): void {
    this.request = request;
    for (const listener of [...this.listeners]) listener();
  }
}
