/**
 * Which page layout to draw, for comparing them side by side: `tabs`, 看板 with the input first and 对话 with the board's short form in a
 * column beside it, both on our page (see TabsPage); `dock`, the conversation docked under the board; `side`, the board in the middle and
 * my dsh's column on the right; `drawer`, the board with a folded conversation at the bottom that opens upward; `project`, my dsh's input
 * on top of the board and a matter page with its context beside its sessions (see ProjectPage); `main`, the main conversation in the
 * middle and everything under it in a panel on the right (see MainPage). Set with `localStorage['mydsh.layout']`; anything else is `tabs`.
 */
export type Layout = 'dock' | 'side' | 'drawer' | 'project' | 'main' | 'tabs';

const KEY = 'mydsh.layout';

export function readLayout(): Layout {
  try {
    const value = globalThis.localStorage?.getItem(KEY);
    return value === 'dock' || value === 'side' || value === 'drawer' || value === 'project' || value === 'main' ? value : 'tabs';
  } catch {
    return 'tabs';
  }
}
