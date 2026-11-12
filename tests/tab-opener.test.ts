import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardMatter, BoardSnapshot, ConversationView } from '../src/host/remote.ts';
import {
  HOME_KIND, MATTER_KIND, OPENED_KEY, OPENED_MAX, OPEN_WAIT_MS, RightTabs, openedSessions, tabFor, tabMatter, type RightTabsDeps, type TabTarget,
} from '../src/client/tab-opener.ts';

const conversation = (sessionId: string): ConversationView => ({ sessionId, state: 'idle' });
const matter = (id: string, overrides: Partial<BoardMatter> = {}): BoardMatter => ({
  id, name: id, goal: '', sources: [], createdAt: '2026-11-01T00:00:00Z', sessions: [], lastActivity: 0, ...overrides,
});
const snapshot = (overrides: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  matters: [matter('m-1', { conversation: conversation('s-m1') }), matter('m-2')],
  unassigned: [], review: [], attention: [], assistant: { sessionId: 's-mydsh', cards: [] }, workspaces: [], presets: [], now: 0, ...overrides,
});

test('my dsh\'s session gets my dsh\'s tab, a matter\'s conversation gets that matter\'s, any other session none', () => {
  assert.deepEqual(tabFor(snapshot(), 's-mydsh'), { kind: HOME_KIND });
  assert.deepEqual(tabFor(snapshot(), 's-m1'), { kind: MATTER_KIND, matterId: 'm-1' });
  assert.equal(tabFor(snapshot(), 's-other'), undefined);
  assert.equal(tabFor(snapshot({ assistant: { sessionId: null, cards: [] } }), 's-mydsh'), undefined);
});

test('a matter tab shows the matter it was opened for, and after a reload the one whose conversation it sits beside', () => {
  assert.equal(tabMatter(snapshot(), 's-m1', 'm-2')?.id, 'm-2');
  assert.equal(tabMatter(snapshot(), 's-m1', undefined)?.id, 'm-1');
  assert.equal(tabMatter(snapshot(), 's-other', undefined), undefined);
  assert.equal(tabMatter(snapshot(), 's-m1', 'm-gone'), undefined);
});

function memoryStorage(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [[OPENED_KEY, initial]]);
  return { items, storage: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } } };
}

test('the sessions our tab opened in are kept in storage, the newest last, a bounded list', () => {
  const { items, storage } = memoryStorage(JSON.stringify(['s-1', 7, 's-2']));
  const opened = openedSessions(storage);
  assert.equal(opened.has('s-1'), true);
  assert.equal(opened.has('s-3'), false);
  opened.add('s-3');
  opened.add('s-3');
  assert.deepEqual(JSON.parse(items.get(OPENED_KEY)!), ['s-1', 's-2', 's-3']);
  assert.equal(openedSessions(storage).has('s-3'), true);
  for (let index = 0; index < OPENED_MAX; index += 1) opened.add(`n-${index}`);
  const kept = JSON.parse(items.get(OPENED_KEY)!) as string[];
  assert.equal(kept.length, OPENED_MAX);
  assert.equal(kept.includes('s-1'), false);
  assert.equal(kept.at(-1), `n-${OPENED_MAX - 1}`);
});

test('unreadable or missing storage starts empty and still remembers for the window', () => {
  assert.equal(openedSessions(memoryStorage('not json').storage).has('s-1'), false);
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const opened = openedSessions(throwing);
  opened.add('s-1');
  assert.equal(opened.has('s-1'), true);
  const none = openedSessions(undefined);
  none.add('s-2');
  assert.equal(none.has('s-2'), true);
});

/**
 * DSH as the opener sees it: the session on screen, and per session the sidebar's store, which exists once DSH drew the sidebar
 * (`adopt`); an open before that does nothing.
 */
function harness(options: { tabs?: Record<string, string[]>; classify?: (sessionId: string, signal: AbortSignal) => Promise<TabTarget | undefined> } = {}) {
  let mounted: string | undefined;
  let now = 1_000;
  const listeners = new Set<() => void>();
  const adopted = new Set<string>();
  const tabs = new Map<string, string[]>(Object.entries(options.tabs ?? {}));
  const opens: [string, TabTarget][] = [];
  const checks: string[] = [];
  const timers: { run: () => void; stopped: boolean }[] = [];
  const { items, storage } = memoryStorage();
  const deps: RightTabsDeps = {
    mounted: { getSnapshot: () => mounted, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    kinds: sessionId => (adopted.has(sessionId) ? tabs.get(sessionId) ?? [] : []),
    open: (sessionId, target) => {
      opens.push([sessionId, target]);
      if (!adopted.has(sessionId)) return;
      const kinds = tabs.get(sessionId) ?? [];
      if (!kinds.includes(target.kind)) tabs.set(sessionId, [...kinds, target.kind]);
    },
    classify: (sessionId, signal) => { checks.push(sessionId); return (options.classify ?? (async () => undefined))(sessionId, signal); },
    opened: openedSessions(storage),
    every: (run) => {
      const timer = { run, stopped: false };
      timers.push(timer);
      return () => { timer.stopped = true; };
    },
    now: () => now,
  };
  return {
    deps, opens, checks, tabs,
    opened: () => JSON.parse(items.get(OPENED_KEY) ?? '[]') as string[],
    /** DSH puts a session on screen, or a panel (undefined). */
    show(sessionId: string | undefined) { mounted = sessionId; for (const listener of [...listeners]) listener(); },
    /** DSH draws the session's sidebar and so makes its store. */
    adopt(sessionId: string) { adopted.add(sessionId); },
    tick() { for (const timer of timers) if (!timer.stopped) timer.run(); },
    retrying: () => timers.some(timer => !timer.stopped),
    advance(ms: number) { now += ms; },
    close(sessionId: string, kind: string) { tabs.set(sessionId, (tabs.get(sessionId) ?? []).filter(item => item !== kind)); },
  };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test('a conversation that comes on screen another way gets its tab once; closed, it stays closed', async () => {
  const h = harness({ classify: async sessionId => tabFor(snapshot(), sessionId) });
  const tabs = new RightTabs(h.deps);
  tabs.start();
  h.show('s-m1');
  await settle();
  h.adopt('s-m1');
  h.tick();
  assert.deepEqual(h.opens.at(-1), ['s-m1', { kind: MATTER_KIND, matterId: 'm-1' }]);
  assert.deepEqual(h.tabs.get('s-m1'), [MATTER_KIND]);
  assert.deepEqual(h.opened(), ['s-m1']);
  // The user closes it, goes elsewhere and comes back: nothing opens, and nothing is checked.
  h.close('s-m1', MATTER_KIND);
  const opens = h.opens.length;
  h.show('s-other');
  h.show('s-m1');
  await settle();
  h.tick();
  assert.equal(h.opens.length, opens);
  assert.deepEqual(h.checks, ['s-m1', 's-other']);
  // A reload keeps the memory.
  const reloaded = new RightTabs({ ...h.deps, opened: openedSessions({ getItem: () => JSON.stringify(h.opened()), setItem: () => {} }) });
  reloaded.start();
  await settle();
  assert.equal(h.opens.length, opens);
});

test('a conversation whose sidebar already has our tab is only remembered', async () => {
  const h = harness({ tabs: { 's-mydsh': ['guide', HOME_KIND] }, classify: async sessionId => tabFor(snapshot(), sessionId) });
  h.adopt('s-mydsh');
  const tabs = new RightTabs(h.deps);
  h.show('s-mydsh');
  tabs.start();
  await settle();
  assert.deepEqual(h.opens, []);
  assert.deepEqual(h.opened(), ['s-mydsh']);
});

test('a session that is not a conversation gets nothing and is not checked again', async () => {
  const h = harness({ classify: async sessionId => tabFor(snapshot(), sessionId) });
  const tabs = new RightTabs(h.deps);
  tabs.start();
  h.show('s-other');
  await settle();
  h.show('s-mydsh');
  h.show('s-other');
  await settle();
  assert.deepEqual(h.checks, ['s-other', 's-mydsh']);
  assert.deepEqual(h.opens.filter(([sessionId]) => sessionId === 's-other'), []);
});

test('moving on while the check runs opens nothing; a failed check is tried again on the next visit', async () => {
  let release: (target: TabTarget | undefined) => void = () => {};
  const signals: AbortSignal[] = [];
  const slow = harness({ classify: (_sessionId, signal) => { signals.push(signal); return new Promise((resolve) => { release = resolve; }); } });
  const first = new RightTabs(slow.deps);
  first.start();
  slow.show('s-mydsh');
  slow.show(undefined);
  assert.equal(signals[0]?.aborted, true);
  release({ kind: HOME_KIND });
  await settle();
  slow.adopt('s-mydsh');
  slow.tick();
  assert.deepEqual(slow.opens, []);

  let fail = true;
  const flaky = harness({ classify: async (sessionId) => { if (fail) throw new Error('Host away'); return tabFor(snapshot(), sessionId); } });
  const second = new RightTabs(flaky.deps);
  second.start();
  flaky.show('s-mydsh');
  await settle();
  assert.deepEqual(flaky.opens, []);
  fail = false;
  flaky.adopt('s-mydsh');
  flaky.show(undefined);
  flaky.show('s-mydsh');
  await settle();
  assert.deepEqual(flaky.opens, [['s-mydsh', { kind: HOME_KIND }]]);
});

test('stopping drops what waits and stops following the screen', async () => {
  const h = harness({ classify: async sessionId => tabFor(snapshot(), sessionId) });
  const tabs = new RightTabs(h.deps);
  const stop = tabs.start();
  h.show('s-mydsh');
  await settle();
  assert.equal(h.retrying(), true);
  stop();
  assert.equal(h.retrying(), false);
  h.adopt('s-m1');
  h.show('s-m1');
  await settle();
  assert.deepEqual(h.opens.filter(([sessionId]) => sessionId === 's-m1'), []);
  assert.deepEqual(h.checks, ['s-mydsh']);
});
