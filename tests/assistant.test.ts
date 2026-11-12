import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownSession, openAssistant, type AssistantDeps } from '../src/client/assistant.ts';

function harness(options: { knownAfterRefresh?: boolean; knownAtStart?: boolean } = {}) {
  const list = new Set<string>(options.knownAtStart ? ['s-mydsh'] : []);
  const listeners = new Set<() => void>();
  const retained: string[] = [];
  let refreshes = 0;
  const deps: AssistantDeps<string> = {
    ensure: async () => 's-mydsh',
    known: id => list.has(id),
    refresh: async () => { refreshes += 1; if (options.knownAfterRefresh) list.add('s-mydsh'); },
    watch: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retain: (id) => { retained.push(id); return `ref:${id}`; },
  };
  const arrive = () => { list.add('s-mydsh'); for (const listener of [...listeners]) listener(); };
  return { deps, retained, arrive, listeners, refreshes: () => refreshes };
}

test('a session the list already knows is retained straight away', async () => {
  const h = harness({ knownAtStart: true });
  assert.deepEqual(await openAssistant(h.deps, new AbortController().signal), { sessionId: 's-mydsh', reference: 'ref:s-mydsh' });
  assert.equal(h.refreshes(), 0);
});

test('a session the list does not know yet is retained once a refresh or a list change brings it', async () => {
  const refreshed = harness({ knownAfterRefresh: true });
  assert.equal((await openAssistant(refreshed.deps, new AbortController().signal)).reference, 'ref:s-mydsh');
  const late = harness();
  const opening = openAssistant(late.deps, new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(late.retained, []);
  late.arrive();
  assert.equal((await opening).reference, 'ref:s-mydsh');
  assert.equal(late.listeners.size, 0);
});

test('a session the list never learns fails after the wait; an abort retains nothing', async () => {
  const h = harness();
  await assert.rejects(openAssistant(h.deps, new AbortController().signal, 20), /会话列表里还没有 my dsh 的会话/);
  const aborted = harness();
  const controller = new AbortController();
  const opening = openAssistant(aborted.deps, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('closed'));
  await assert.rejects(opening, /closed/);
  assert.deepEqual(aborted.retained, []);
  assert.equal(aborted.listeners.size, 0);
});

test('a way into a conversation waits for the list to know the session, without retaining it', async () => {
  const h = harness();
  const known = knownSession(h.deps, new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  h.arrive();
  assert.equal(await known, 's-mydsh');
  assert.deepEqual(h.retained, []);
  const missing = harness();
  await assert.rejects(knownSession({ ...missing.deps, missing: '会话列表里还没有这件事的对话' }, new AbortController().signal, 20), /会话列表里还没有这件事的对话/);
});
