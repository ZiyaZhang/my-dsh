import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeFeed, type Scheduler } from '../src/host/feed.ts';

/** Runs scheduled work only when the test says so. */
class ManualScheduler implements Scheduler {
  readonly pending: { run: () => void; ms: number }[] = [];
  schedule(run: () => void, ms: number): () => void {
    const entry = { run, ms };
    this.pending.push(entry);
    return () => { const index = this.pending.indexOf(entry); if (index >= 0) this.pending.splice(index, 1); };
  }
  fire(): void {
    const entries = this.pending.splice(0);
    for (const entry of entries) entry.run();
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a stream opens with the current revision', async () => {
  const feed = new ChangeFeed(300, new ManualScheduler());
  const stream = feed.follow(new AbortController().signal);
  assert.deepEqual((await stream.next()).value, { revision: 0 });
  await stream.return(undefined);
});

test('changes within the delay make one notice', async () => {
  const scheduler = new ManualScheduler();
  const feed = new ChangeFeed(300, scheduler);
  const stream = feed.follow(new AbortController().signal);
  await stream.next();
  feed.touch(); feed.touch(); feed.touch();
  assert.equal(scheduler.pending.length, 1);
  assert.equal(scheduler.pending[0]!.ms, 300);
  const next = stream.next();
  scheduler.fire();
  assert.deepEqual((await next).value, { revision: 1 });
  feed.touch();
  assert.equal(scheduler.pending.length, 1);
  await stream.return(undefined);
});

test('a reader that falls behind gets the latest revision once', async () => {
  const scheduler = new ManualScheduler();
  const feed = new ChangeFeed(300, scheduler);
  const abort = new AbortController();
  const stream = feed.follow(abort.signal);
  await stream.next();
  feed.touch(); scheduler.fire();
  feed.touch(); scheduler.fire();
  assert.deepEqual((await stream.next()).value, { revision: 2 });
  const seen: { result?: IteratorResult<unknown> } = {};
  const pending = stream.next().then((result) => { seen.result = result; });
  await settle();
  assert.ok(!('result' in seen));
  abort.abort();
  await pending;
  assert.equal(seen.result?.done, true);
});

test('every open stream gets the notice', async () => {
  const scheduler = new ManualScheduler();
  const feed = new ChangeFeed(300, scheduler);
  const a = feed.follow(new AbortController().signal);
  const b = feed.follow(new AbortController().signal);
  await a.next(); await b.next();
  const nextA = a.next(); const nextB = b.next();
  feed.touch(); scheduler.fire();
  assert.deepEqual([(await nextA).value, (await nextB).value], [{ revision: 1 }, { revision: 1 }]);
  await a.return(undefined); await b.return(undefined);
});

test('aborting the signal ends the stream', async () => {
  const feed = new ChangeFeed(300, new ManualScheduler());
  const abort = new AbortController();
  const stream = feed.follow(abort.signal);
  await stream.next();
  const next = stream.next();
  abort.abort();
  assert.equal((await next).done, true);
});

test('closing the feed ends every stream and drops the pending notice', async () => {
  const scheduler = new ManualScheduler();
  const feed = new ChangeFeed(300, scheduler);
  const stream = feed.follow(new AbortController().signal);
  await stream.next();
  const next = stream.next();
  feed.touch();
  feed.close();
  assert.equal(scheduler.pending.length, 0);
  assert.equal((await next).done, true);
  feed.touch();
  assert.equal(scheduler.pending.length, 0);
  const late = feed.follow(new AbortController().signal);
  assert.deepEqual((await late.next()).value, { revision: 0 });
  assert.equal((await late.next()).done, true);
});
