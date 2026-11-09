/** Times as the board writes them, in the browser's local time. */

const pad = (value: number) => String(value).padStart(2, '0');

/** `HH:mm`. */
export function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function date(year: number, month: number, day: number, thisYear: number): string {
  return year === thisYear ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

/** Within a minute either way: 刚刚; today: `HH:mm`; this year: `M月D日`; earlier: `YYYY年M月D日`. */
export function when(ms: number, now: number): string {
  if (Math.abs(now - ms) < 60_000) return '刚刚';
  const then = new Date(ms);
  const today = new Date(now);
  if (sameDay(then, today)) return clock(ms);
  return date(then.getFullYear(), then.getMonth() + 1, then.getDate(), today.getFullYear());
}

/** A review day's heading: 今天 and 昨天 carry their date beside them; older days are their date. */
export function dayTitle(day: { day: string; daysAgo: number }, now: number): { label: string; date?: string } {
  const [year, month, dayOfMonth] = day.day.split('-').map(Number) as [number, number, number];
  const text = date(year, month, dayOfMonth, new Date(now).getFullYear());
  if (day.daysAgo === 0) return { label: '今天', date: text };
  if (day.daysAgo === 1) return { label: '昨天', date: text };
  return { label: text };
}
