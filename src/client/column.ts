/**
 * The width of 对话's column and whether it shows, kept in the browser for every page, with the limits of DSH's own right sidebar
 * (ui-layout's columns): at least 300 px, at most 70% of the tab, and 400 px left for the conversation. Pure, apart from the storage
 * passed in.
 */

/** The limits of DSH's right sidebar (ui-layout's columns). */
export const COLUMN_MIN = 300;
export const COLUMN_MAX_RATIO = 0.7;
export const CENTER_MIN = 400;
export const COLUMN_DEFAULT = 380;
/** How far one arrow key moves the edge. */
export const COLUMN_STEP = 16;
export const COLUMN_KEY = 'mydsh.chat.column';

export interface ColumnSetting {
  width: number;
  open: boolean;
}

/** The column's width in a tab `total` px wide, or 0 when the tab has no room for it beside the conversation. */
export function columnWidth(width: number, total: number): number {
  const max = Math.min(total * COLUMN_MAX_RATIO, total - CENTER_MIN);
  if (max < COLUMN_MIN) return 0;
  return Math.round(Math.min(Math.max(width, COLUMN_MIN), max));
}

/** The kept setting; the default width and an open column when there is none or it cannot be read. */
export function readColumn(storage: Pick<Storage, 'getItem'> | undefined): ColumnSetting {
  const fallback = { width: COLUMN_DEFAULT, open: true };
  try {
    const stored: unknown = JSON.parse(storage?.getItem(COLUMN_KEY) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return fallback;
    const { width, open } = stored as Partial<ColumnSetting>;
    return {
      width: typeof width === 'number' && Number.isFinite(width) ? width : COLUMN_DEFAULT,
      open: typeof open === 'boolean' ? open : true,
    };
  } catch {
    // Unreadable: the default.
    return fallback;
  }
}

export function writeColumn(storage: Pick<Storage, 'setItem'> | undefined, setting: ColumnSetting): void {
  try {
    storage?.setItem(COLUMN_KEY, JSON.stringify(setting));
  } catch {
    // Kept for this window only.
  }
}
