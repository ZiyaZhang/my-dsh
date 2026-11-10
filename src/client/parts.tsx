/** Small pieces the board page and its right column share. */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SessionState } from '../host/remote.js';

/** Enter or Space on a focusable row does what a click does. */
export const activate = (run: () => void) => ({
  role: 'button',
  tabIndex: 0,
  onClick: run,
  onKeyDown: (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    run();
  },
});

/** A click on a control inside a clickable card stays with the control. */
export const only = (run: () => void) => (event: MouseEvent) => { event.stopPropagation(); run(); };

/** Waiting is amber, running spins, failed is red; an idle session shows nothing, or the grey dot where a row needs a mark. */
export function StateMark({ state, idle = false }: { state: SessionState | undefined; idle?: boolean }) {
  switch (state) {
    case 'waiting': return <StateDot state="warning" />;
    case 'running': return <StateDot state="ongoing" />;
    case 'failed': return <StateDot state="error" />;
    default: return idle ? <StateDot state="idle" /> : null;
  }
}

/** Re-render each minute, so 刚刚, today's times and a running step's minutes do not go stale between changes. */
export function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => { setTick(tick => tick + 1); }, 60_000);
    return () => { clearInterval(timer); };
  }, []);
}
