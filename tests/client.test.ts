import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardSnapshot } from '../src/host/remote.ts';
import { BoardSource, type BoardSourceDeps } from '../src/client/board-source.ts';
import { clock, dayTitle, groupByDay, when } from '../src/client/time.ts';

process.env.TZ = 'Asia/Shanghai';
const at = (iso: string) => Date.parse(iso);

test('times read as the board writes them: just now, today, this year, earlier years', () => {
  const now = at('2026-11-09T14:30:00+08:00');
  assert.equal(when(at('2026-11-09T14:29:40+08:00'), now), '刚刚');
  assert.equal(when(at('2026-11-09T14:30:40+08:00'), now), '刚刚');
  assert.equal(when(at('2026-11-09T09:05:00+08:00'), now), '09:05');
  assert.equal(when(at('2026-11-08T23:59:00+08:00'), now), '11月8日');
  assert.equal(when(at('2025-12-31T10:00:00+08:00'), now), '2025年12月31日');
  assert.equal(clock(at('2026-11-08T07:03:00+08:00')), '07:03');
});

test('review days are today and yesterday with their dates, then plain dates', () => {
  const now = at('2026-11-09T14:30:00+08:00');
  assert.deepEqual(dayTitle({ day: '2026-11-09', daysAgo: 0 }, now), { label: '今天', date: '11月9日' });
  assert.deepEqual(dayTitle({ day: '2026-11-08', daysAgo: 1 }, now), { label: '昨天', date: '11月8日' });
  assert.deepEqual(dayTitle({ day: '2026-10-27', daysAgo: 13 }, now), { label: '10月27日' });
  assert.deepEqual(dayTitle({ day: '2025-12-31', daysAgo: 13 }, at('2026-01-05T10:00:00+08:00')), { label: '2025年12月31日' });
});

const snapshot = (now: number): BoardSnapshot => ({ matters: [], unassigned: [], review: [], assistant: { sessionId: null, cards: [] }, workspaces: [], now });

/** A notice stream the test feeds by hand. */
class FakeStream implements AsyncIterable<unknown> {
  private readonly items: unknown[] = [];
  private wake: (() => void) | undefined;
  private ended: { error?: unknown } | undefined;
  disposed = false;
  push(item: unknown) { this.items.push(item); this.wake?.(); }
  fail(error: unknown) { this.ended = { error }; this.wake?.(); }
  dispose() { this.disposed = true; this.ended = {}; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift();
      if (this.ended) { if (this.ended.error) throw this.ended.error; return; }
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

function harness(options: { openThrows?: boolean } = {}) {
  let fetches = 0;
  const streams: FakeStream[] = [];
  const signals: AbortSignal[] = [];
  const timers: { run: () => void; ms: number; stopped: boolean }[] = [];
  const resets = new Set<() => void>();
  const deps: BoardSourceDeps = {
    fetch: async () => snapshot(++fetches),
    watch: (signal) => {
      signals.push(signal);
      if (options.openThrows) throw new Error('watch is not mounted');
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
    onReset: (listener) => { resets.add(listener); return () => { resets.delete(listener); }; },
    every: (run, ms) => { const timer = { run, ms, stopped: false }; timers.push(timer); return () => { timer.stopped = true; }; },
  };
  return { deps, streams, signals, timers, resets, fetches: () => fetches };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test('the first reader fetches a snapshot and opens the stream; each notice fetches again', async () => {
  const h = harness();
  const source = new BoardSource(h.deps);
  assert.deepEqual(source.getSnapshot(), { status: 'loading' });
  const stop = source.subscribe(() => {});
  await settle();
  assert.equal(h.fetches(), 1);
  assert.equal(source.mode, 'stream');
  assert.deepEqual(source.getSnapshot(), { status: 'ready', snapshot: snapshot(1) });
  h.streams[0]!.push({ revision: 1 });
  await settle();
  assert.equal(h.fetches(), 2);
  stop();
  assert.equal(h.signals[0]!.aborted, true);
  assert.equal(h.streams[0]!.disposed, true);
  assert.equal(source.mode, 'off');
});

test('a stream that fails or ends falls back to polling every 5 seconds', async () => {
  const h = harness();
  const source = new BoardSource(h.deps);
  source.subscribe(() => {});
  await settle();
  h.streams[0]!.fail(new Error('carrier lost'));
  await settle();
  assert.equal(source.mode, 'poll');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0]!.ms, 5_000);
  const before = h.fetches();
  h.timers[0]!.run();
  await settle();
  assert.equal(h.fetches(), before + 1);
});

test('a stream that cannot open at all polls from the start', async () => {
  const h = harness({ openThrows: true });
  const source = new BoardSource(h.deps);
  source.subscribe(() => {});
  await settle();
  assert.equal(source.mode, 'poll');
  assert.equal(h.fetches(), 1);
});

test('a connection reset tries the stream again and stops polling', async () => {
  const h = harness();
  const source = new BoardSource(h.deps);
  source.subscribe(() => {});
  await settle();
  h.streams[0]!.fail(new Error('carrier lost'));
  await settle();
  assert.equal(source.mode, 'poll');
  for (const reset of h.resets) reset();
  await settle();
  assert.equal(h.timers[0]!.stopped, true);
  assert.equal(h.streams.length, 2);
  assert.equal(source.mode, 'stream');
  h.streams[1]!.push({ revision: 1 });
  await settle();
  // Opening, the fall back to polling, the reset, the notice on the new stream.
  assert.equal(h.fetches(), 4);
});

test('refreshes asked for during a fetch run once more after it, not once each', async () => {
  let resolveFirst: (() => void) | undefined;
  let fetches = 0;
  const deps: BoardSourceDeps = {
    fetch: () => {
      fetches += 1;
      if (fetches === 1) return new Promise(resolve => { resolveFirst = () => resolve(snapshot(1)); });
      return Promise.resolve(snapshot(fetches));
    },
    watch: () => new FakeStream(),
    onReset: () => () => {},
    every: () => () => {},
  };
  const source = new BoardSource(deps);
  source.subscribe(() => {});
  await settle();
  const a = source.refresh();
  const b = source.refresh();
  resolveFirst!();
  await Promise.all([a, b]);
  assert.equal(fetches, 2);
  assert.deepEqual(source.getSnapshot(), { status: 'ready', snapshot: snapshot(2) });
});

test('a failed fetch shows the error, keeping the last snapshot when there is one', async () => {
  let fail = false;
  const deps: BoardSourceDeps = {
    fetch: async () => { if (fail) throw new Error('读不到会话'); return snapshot(1); },
    watch: () => new FakeStream(),
    onReset: () => () => {},
    every: () => () => {},
  };
  const source = new BoardSource(deps);
  source.subscribe(() => {});
  await settle();
  fail = true;
  await source.refresh();
  assert.deepEqual(source.getSnapshot(), { status: 'ready', snapshot: snapshot(1), error: '读不到会话' });
  const fresh = new BoardSource(deps);
  fresh.subscribe(() => {});
  await settle();
  assert.deepEqual(fresh.getSnapshot(), { status: 'failed', error: '读不到会话' });
});

test('refresh does nothing while nobody reads the board', async () => {
  const h = harness();
  const source = new BoardSource(h.deps);
  await source.refresh();
  assert.equal(h.fetches(), 0);
});

test('a reader that comes back while the last read is still in flight gets a read of its own', async () => {
  let fetches = 0;
  const answers: (() => void)[] = [];
  const deps: BoardSourceDeps = {
    fetch: (signal) => {
      fetches += 1;
      const n = fetches;
      return new Promise((resolve, reject) => {
        answers.push(() => { resolve(snapshot(n)); });
        signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      });
    },
    watch: () => new FakeStream(),
    onReset: () => () => {},
    every: () => () => {},
  };
  const source = new BoardSource(deps);
  const leave = source.subscribe(() => {});
  await settle();
  assert.equal(fetches, 1);
  leave();
  source.subscribe(() => {});
  await settle();
  assert.equal(fetches, 2);
  answers[1]!();
  await settle();
  assert.deepEqual(source.getSnapshot(), { status: 'ready', snapshot: snapshot(2) });
});

test('做事记录 groups entries by local day, keeping their order', () => {
  const now = at('2026-11-09T14:30:00+08:00');
  const entries = [
    { id: 'a-3', at: '2026-11-09T05:00:00Z' },
    { id: 'a-2', at: '2026-11-08T17:00:00Z' },
    { id: 'a-1', at: '2026-11-08T15:00:00Z' },
    { id: 'a-0', at: '2026-10-30T01:00:00Z' },
  ];
  assert.deepEqual(groupByDay(entries, now).map(group => [group.day, group.daysAgo, group.entries.map(entry => entry.id)]), [
    ['2026-11-09', 0, ['a-3', 'a-2']],
    ['2026-11-08', 1, ['a-1']],
    ['2026-10-30', 10, ['a-0']],
  ]);
});
