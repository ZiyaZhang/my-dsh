/**
 * The 对话 tab of my dsh's page and of a matter's: the conversation, and on its right a column the user drags wider or narrower, puts
 * away and brings back, with the limits of DSH's own right sidebar: at least 300 px, at most 70% of the tab, and 400 px left for the
 * conversation; a tab too narrow for both leaves the column out. Hovering the column's edge shows a blue line; a double click on it
 * brings back the default width, and the arrow keys move it while it has focus. The width and whether the column shows are kept in the
 * browser, one setting for every page.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { IconPanelLeftOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { COLUMN_DEFAULT, COLUMN_MIN, COLUMN_STEP, columnWidth, readColumn, writeColumn, type ColumnSetting } from './column.js';

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // A page without storage keeps the setting for this window only.
    return undefined;
  }
}

/** DSH's right sidebar glyph: the left-panel icon turned around. */
const PanelGlyph = () => <IconPanelLeftOutlineRegular size={16} className="mydsh-cs-glyph" />;

/**
 * @param title - the column's heading.
 * @param tools - links at the head's right, before the button that puts the column away.
 */
export function ChatSplit({ conversation, title, tools, children }: {
  conversation: ReactNode;
  title: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [setting, setSetting] = useState(() => readColumn(browserStorage()));
  const [total, setTotal] = useState(0);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    setTotal(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => { if (entry) setTotal(entry.contentRect.width); });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);
  const width = columnWidth(setting.width, total);
  const keep = (next: ColumnSetting) => { setSetting(next); writeColumn(browserStorage(), next); };
  // Dragging left widens the column. The setting keeps the clamped width, so the edge stays under the pointer.
  const resize = (next: number) => { setSetting(current => ({ ...current, width: columnWidth(next, total) || current.width })); };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, width };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    resize(active.width + active.x - event.clientX);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const next = columnWidth(active.width + active.x - event.clientX, total) || setting.width;
    keep({ ...setting, width: next });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? COLUMN_STEP : event.key === 'ArrowRight' ? -COLUMN_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    keep({ ...setting, width: columnWidth(width + step, total) || setting.width });
  };
  const shown = setting.open && width > 0;
  return (
    <div className="mydsh-cs" ref={root} data-dragging={dragging || undefined}>
      <div className="mydsh-cs-center">
        {!setting.open && width > 0 && (
          <Tooltip label="打开侧边栏" side="bottom" delayMs={500}>
            <button type="button" className="mydsh-cs-icon mydsh-cs-show" aria-label="打开右侧边栏" onClick={() => { keep({ ...setting, open: true }); }}>
              <PanelGlyph />
            </button>
          </Tooltip>
        )}
        {conversation}
      </div>
      {shown && (
        <aside className="mydsh-cs-side" style={{ width }} aria-label={title}>
          <div
            className="mydsh-cs-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动改宽窄，双击恢复默认宽度"
            aria-valuemin={COLUMN_MIN}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={() => { keep({ ...setting, width: COLUMN_DEFAULT }); }}
            onKeyDown={onKeyDown}
          />
          <div className="mydsh-cs-head">
            <b>{title}</b>
            <span className="mydsh-cs-tools">
              {tools}
              <Tooltip label="收起侧边栏" side="bottom" delayMs={500}>
                <button type="button" className="mydsh-cs-icon" aria-label="收起右侧边栏" onClick={() => { keep({ ...setting, open: false }); }}>
                  <PanelGlyph />
                </button>
              </Tooltip>
            </span>
          </div>
          <div className="mydsh-cs-body">{children}</div>
        </aside>
      )}
    </div>
  );
}
