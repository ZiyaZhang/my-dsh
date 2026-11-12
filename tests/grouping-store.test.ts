import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyEvidence } from '../src/host/grouping-evidence.ts';
import {
  DECLINED_MAX, GroupingStore, PENDING_MAX, decideSuggestion, emptyGrouping, noteBranch, noteEvidence, parseGroupingFile, recordRun, refuseKeys,
  type GroupingState,
} from '../src/host/grouping-store.ts';
import { suggestionKey, type GroupingRun, type Made } from '../src/host/grouping.ts';
import { RequestError } from '../src/host/remote.ts';

const T1 = '2026-11-12T01:00:00.000Z';
const T2 = '2026-11-13T01:00:00.000Z';
const run = (endedAt: string, extra: Partial<GroupingRun> = {}): GroupingRun => ({ at: endedAt, endedAt, loose: 4, read: 4, asked: 2, origin: 1, model: 1, ...extra });
const ids = (prefix: string) => { let next = 0; return () => `${prefix}-${++next}`; };
const newMatter = (sessionIds: string[], name = '看板', by: Made['by'] = 'model'): Made => ({ change: { kind: 'new', sessionIds, name, goal: '' }, why: '在做同一件事', by });
const filing = (sessionId: string, matterId: string, by: Made['by'] = 'origin'): Made => ({
  change: { kind: 'file', sessionId, matterId }, why: '同一个分支', by, ...(by === 'origin' ? { rule: 'branch' as const } : {}),
});

test('a run\'s suggestions replace the pending ones; one made again keeps its id and time, its text is the newest', () => {
  const first = recordRun(emptyGrouping(), { run: run(T1), made: [newMatter(['s-1', 's-2']), filing('s-3', 'm-1')] }, { at: T1, id: ids('a'), takenOut: new Set() });
  assert.deepEqual(first.suggestions.map(item => [item.id, item.at, item.state]), [['a-1', T1, 'pending'], ['a-2', T1, 'pending']]);
  assert.equal(first.suggestions[1]!.rule, 'branch');
  const second = recordRun(first, { run: run(T2), made: [newMatter(['s-2', 's-1'], '看板改版'), filing('s-4', 'm-1')] }, { at: T2, id: ids('b'), takenOut: new Set() });
  assert.deepEqual(second.suggestions.map(item => [item.id, item.at, item.change.kind === 'new' ? item.change.name : item.change.sessionId]), [
    ['a-1', T1, '看板改版'], ['b-1', T2, 's-4'],
  ]);
  assert.equal(second.runs.length, 2);
});

test('a run leaves out declined suggestions, filings into a matter the session was taken out of, and a second suggestion for a session', () => {
  const declined = refuseKeys(emptyGrouping(), [suggestionKey({ kind: 'new', sessionIds: ['s-1', 's-2'], name: '', goal: '' })], T1);
  const state = recordRun(declined, {
    run: run(T1), made: [newMatter(['s-1', 's-2']), filing('s-3', 'm-1'), filing('s-4', 'm-1'), newMatter(['s-4', 's-5'])],
  }, { at: T1, id: ids('a'), takenOut: new Set(['s-3>m-1']) });
  assert.deepEqual(state.suggestions.map(item => item.change), [{ kind: 'file', sessionId: 's-4', matterId: 'm-1' }]);
});

test('at most PENDING_MAX stay pending; a run that stopped before making any keeps the pending ones', () => {
  const many = Array.from({ length: PENDING_MAX + 5 }, (_, index) => filing(`s-${index}`, 'm-1'));
  const full = recordRun(emptyGrouping(), { run: run(T1), made: many }, { at: T1, id: ids('a'), takenOut: new Set() });
  assert.equal(full.suggestions.length, PENDING_MAX);
  const failed = recordRun(full, { run: run(T2, { error: '会话列表读不到' }) }, { at: T2, id: ids('b'), takenOut: new Set() });
  assert.equal(failed.suggestions, full.suggestions);
  assert.equal(failed.runs.at(-1)!.error, '会话列表读不到');
});

test('when the model step failed, the earlier model suggestions stay beside the rules\' new ones, unless those are about their sessions', () => {
  const before = recordRun(emptyGrouping(), { run: run(T1), made: [newMatter(['s-1', 's-2']), newMatter(['s-5', 's-6'], '周报')] }, { at: T1, id: ids('a'), takenOut: new Set() });
  const after = recordRun(before, { run: run(T2, { error: '模型超时' }), made: [filing('s-1', 'm-1')], keepModel: true }, { at: T2, id: ids('b'), takenOut: new Set() });
  assert.deepEqual(after.suggestions.map(item => [item.id, item.by]), [['b-1', 'origin'], ['a-2', 'model']]);
});

test('a decision settles a pending suggestion once; a declined one\'s key is kept, and undoing an accepted one declines its key', () => {
  const state = recordRun(emptyGrouping(), { run: run(T1), made: [newMatter(['s-1', 's-2']), filing('s-3', 'm-1')] }, { at: T1, id: ids('a'), takenOut: new Set() });
  const declined = decideSuggestion(state, 'a-1', { state: 'declined', at: T2 });
  assert.equal(declined.suggestion.state, 'declined');
  assert.equal(declined.suggestion.decidedAt, T2);
  assert.deepEqual(declined.state.declined, ['new:s-1,s-2']);
  const accepted = decideSuggestion(declined.state, 'a-2', { state: 'accepted', at: T2, matterId: 'm-1' });
  assert.deepEqual([accepted.suggestion.state, accepted.suggestion.matterId], ['accepted', 'm-1']);
  assert.deepEqual(accepted.state.declined, ['new:s-1,s-2']);
  assert.throws(() => decideSuggestion(accepted.state, 'a-2', { state: 'declined', at: T2 }), (error: unknown) => error instanceof RequestError && /已经处理过了/.test(error.message));
  assert.throws(() => decideSuggestion(accepted.state, 'a-9', { state: 'declined', at: T2 }), /没有这条建议/);
  // A later run does not make the declined one again.
  const again = recordRun(accepted.state, { run: run(T2), made: [newMatter(['s-2', 's-1'])] }, { at: T2, id: ids('b'), takenOut: new Set() });
  assert.deepEqual(again.suggestions.filter(item => item.state === 'pending'), []);
  // Refusing a key declines a pending suggestion that has it.
  const pending = recordRun(emptyGrouping(), { run: run(T1), made: [filing('s-7', 'm-2')] }, { at: T1, id: ids('c'), takenOut: new Set() });
  const refused = refuseKeys(pending, ['file:s-7>m-2'], T2);
  assert.deepEqual([refused.suggestions[0]!.state, refused.declined], ['declined', ['file:s-7>m-2']]);
  assert.equal(refuseKeys(refused, [], T2), refused);
  const crowded = refuseKeys(emptyGrouping(), Array.from({ length: DECLINED_MAX + 3 }, (_, index) => `new:k-${index}`), T1);
  assert.equal(crowded.declined.length, DECLINED_MAX);
  assert.equal(crowded.declined[0], 'new:k-3');
});

test('evidence of sessions DSH no longer lists goes; a branch noted again unchanged changes nothing', () => {
  const state: GroupingState = { ...emptyGrouping(), evidence: { 's-gone': { ...emptyEvidence(), readAt: 1 } } };
  const noted = noteEvidence(state, { 's-1': { ...emptyEvidence(), cursor: 40, readAt: 2 } }, new Set(['s-1']));
  assert.deepEqual(Object.keys(noted.evidence), ['s-1']);
  const branch = { key: '/repo/.git\nfeat/x', name: 'feat/x', at: 5 };
  const once = noteBranch(emptyGrouping(), 's-1', branch);
  assert.deepEqual(once.branches['s-1'], branch);
  assert.equal(noteBranch(once, 's-1', { ...branch, at: 9 }), once);
  assert.equal(noteBranch(once, 's-1', { key: '/repo/.git\nfeat/y', name: 'feat/y', at: 9 }).branches['s-1']!.name, 'feat/y');
});

test('the store writes grouping.json whole, reads it back, and sets a file it cannot read aside', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-grouping-'));
  let changes = 0;
  const store = new GroupingStore(directory, () => { changes += 1; });
  await store.open();
  await store.recordRun({ run: run(T1), made: [filing('s-3', 'm-1')] }, { at: T1, id: ids('a'), takenOut: new Set() });
  await store.noteBranch('s-3', { key: 'k', name: 'feat/x', at: 1 });
  const declined = await store.decide('a-1', { state: 'declined', at: T2 });
  assert.equal(declined.state, 'declined');
  // Runs and decisions are on the board; a noted branch is not.
  assert.equal(changes, 2);
  const again = new GroupingStore(directory);
  await again.open();
  assert.deepEqual(again.peek(), store.peek());
  assert.deepEqual(parseGroupingFile(JSON.parse(await readFile(join(directory, 'grouping.json'), 'utf8'))), store.peek());

  await writeFile(join(directory, 'grouping.json'), '{"version":1,"runs":[', 'utf8');
  const warnings: string[] = [];
  const fresh = new GroupingStore(directory, () => {}, (text) => { warnings.push(text); });
  await fresh.open();
  assert.deepEqual(fresh.peek(), emptyGrouping());
  assert.equal(await readFile(join(directory, 'grouping.damaged.json'), 'utf8'), '{"version":1,"runs":[');
  assert.equal(warnings.length, 1);
  // Entries that do not read are left out one by one.
  assert.deepEqual(parseGroupingFile({ version: 1, runs: [run(T1), { at: 3 }], suggestions: [{ id: 'x' }], declined: ['new:a', 7] })?.runs.length, 1);
  assert.equal(parseGroupingFile({ version: 2 }), undefined);
});
