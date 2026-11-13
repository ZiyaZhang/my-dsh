import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUPING_GAP_MS, entryKey, groupingDue, looseSessions, mainWorkspace, pairKey, suggestionKey, suggestionViews, type GroupingRun, type Suggestion,
} from '../src/host/grouping.ts';
import type { ActivityEntry, BoardSession, Matter } from '../src/host/remote.ts';
import type { SessionView } from '../src/host/sessions.ts';

const NOW = Date.parse('2026-11-12T06:00:00Z');
const HOUR = 3_600_000;

const run = (endedAt: number, extra: Partial<GroupingRun> = {}): GroupingRun => ({
  at: new Date(endedAt - 60_000).toISOString(), endedAt: new Date(endedAt).toISOString(), loose: 3, read: 3, asked: 1, origin: 1, model: 0, ...extra,
});

test('a new matter is declined for good by its exact set of sessions, a filing by the session and the matter', () => {
  assert.equal(suggestionKey({ kind: 'new', sessionIds: ['s-2', 's-1', 's-2'], name: '甲', goal: '' }), 'new:s-1,s-2');
  assert.equal(suggestionKey({ kind: 'new', sessionIds: ['s-1', 's-2'], name: '乙', goal: '别的目标' }), 'new:s-1,s-2');
  assert.notEqual(suggestionKey({ kind: 'new', sessionIds: ['s-1', 's-2', 's-3'], name: '甲', goal: '' }), 'new:s-1,s-2');
  assert.equal(suggestionKey({ kind: 'file', sessionId: 's-1', matterId: 'm-1' }), `file:${pairKey('s-1', 'm-1')}`);
  assert.equal(pairKey('s-1', 'm-1'), 's-1>m-1');
});

test('undoing an accepted suggestion declines the suggestion it stood for', () => {
  const entry = (extra: Partial<ActivityEntry>): ActivityEntry => ({ id: 'a-1', at: 'T', kind: 'group', matterId: 'm-1', text: '', why: '', ...extra });
  assert.equal(entryKey(entry({ sessions: ['s-2', 's-1'], created: true })), 'new:s-1,s-2');
  assert.equal(entryKey(entry({ sessions: ['s-1'] })), 'file:s-1>m-1');
  assert.equal(entryKey(entry({ kind: 'file', sessionId: 's-1' })), undefined);
  assert.equal(entryKey(entry({ sessions: [] })), undefined);
});

test('the first run comes as the Host starts; later ones three hours apart once something changed, sooner after a failure or when a model turned up', () => {
  assert.equal(groupingDue({ runs: [], modelReady: false, now: NOW, changedAt: undefined }), true);
  // A first run that failed is tried again by the next check.
  assert.equal(groupingDue({ runs: [run(NOW - HOUR, { error: 'x' })], modelReady: true, now: NOW, changedAt: undefined }), true);
  // After a finished run, nothing changed since it began: no run, however long ago it was.
  assert.equal(groupingDue({ runs: [run(NOW - 10 * 24 * HOUR)], modelReady: true, now: NOW, changedAt: undefined }), false);
  assert.equal(groupingDue({ runs: [run(NOW - 10 * 24 * HOUR)], modelReady: true, now: NOW, changedAt: NOW - 11 * 24 * HOUR }), false);
  // Something changed: three hours after the run, and a change while it ran counts.
  assert.equal(groupingDue({ runs: [run(NOW - 2 * HOUR)], modelReady: true, now: NOW, changedAt: NOW - HOUR }), false);
  assert.equal(groupingDue({ runs: [run(NOW - GROUPING_GAP_MS)], modelReady: true, now: NOW, changedAt: NOW - HOUR }), true);
  assert.equal(groupingDue({ runs: [run(NOW - GROUPING_GAP_MS)], modelReady: true, now: NOW, changedAt: NOW - GROUPING_GAP_MS - 30_000 }), true);
  assert.equal(groupingDue({ runs: [run(NOW - GROUPING_GAP_MS)], modelReady: true, now: NOW, changedAt: NOW - GROUPING_GAP_MS - 90_000 }), false);
  assert.equal(groupingDue({ runs: [run(NOW - 2 * HOUR), run(NOW - HOUR, { error: '模型超时' })], modelReady: true, now: NOW, changedAt: undefined }), true);
  assert.equal(groupingDue({ runs: [run(NOW - HOUR, { modelUnavailable: true })], modelReady: false, now: NOW, changedAt: undefined }), false);
  assert.equal(groupingDue({ runs: [run(NOW - HOUR, { modelUnavailable: true })], modelReady: true, now: NOW, changedAt: undefined }), true);
});

const view = (id: string, hoursAgo: number, extra: Partial<SessionView> = {}): SessionView => ({
  id, title: id, blank: false, subagent: false, state: 'idle', lastActivity: NOW - hoursAgo * HOUR, ...extra,
});
const matter = (id: string, sessions: string[], extra: Partial<Matter> = {}): Matter => ({
  id, name: id, goal: '', sessions: sessions.map(sessionId => ({ sessionId, by: 'manual', at: 'T' })), aliases: [], sources: [], createdAt: 'T', ...extra,
});

test('loose sessions are those of the window in no matter, archived ones included, leaving out what the board leaves out, newest first', () => {
  const views = [
    view('old', 15 * 24), view('a', 5), view('b', 1), view('filed', 1), view('in-archived', 1), view('archived', 1), view('blank', 1, { blank: true }),
    view('child', 1, { subagent: true }), view('mydsh', 1),
  ];
  const loose = looseSessions(views, {
    matters: [matter('m-1', ['filed']), matter('m-2', ['in-archived'], { archivedAt: 'T' })], archived: new Set(['archived']), hidden: new Set(['mydsh']),
    since: NOW - 14 * 24 * HOUR,
  });
  assert.deepEqual(loose.map(session => session.id), ['b', 'a']);
});

const board = (id: string, hoursAgo: number, workspace?: [string, string]): BoardSession => ({
  id, title: `标题 ${id}`, state: 'idle', lastActivity: NOW - hoursAgo * HOUR, ...(workspace ? { workspaceId: workspace[0], workspace: workspace[1] } : {}),
});

test('a new matter\'s main workspace is the one most of its sessions are in, the newest session\'s on a tie, none when none is in one', () => {
  assert.deepEqual(mainWorkspace([board('a', 1, ['w-1', 'kb']), board('b', 2, ['w-2', 'site']), board('c', 3, ['w-2', 'site'])]), { id: 'w-2', title: 'site' });
  assert.deepEqual(mainWorkspace([board('a', 3, ['w-1', 'kb']), board('b', 1, ['w-2', 'site'])]), { id: 'w-2', title: 'site' });
  assert.deepEqual(mainWorkspace([board('a', 1), board('b', 2, ['w-1', 'kb'])]), { id: 'w-1', title: 'kb' });
  assert.equal(mainWorkspace([board('a', 1), board('b', 2)]), undefined);
});

const suggestion = (id: string, change: Suggestion['change'], extra: Partial<Suggestion> = {}): Suggestion => ({
  id, change, why: '依据', by: 'origin', rule: 'branch', at: 'T', state: 'pending', ...extra,
});

test('the card shows pending suggestions whose sessions are all loose, new matters first and each kind by its newest session', () => {
  const loose = new Map([board('a', 3, ['w-1', 'kb']), board('b', 1, ['w-1', 'kb']), board('c', 2), board('d', 5), board('e', 4)].map(item => [item.id, item]));
  const matters = [matter('m-1', []), matter('m-old', [], { archivedAt: 'T' })];
  const views = suggestionViews([
    suggestion('g-file', { kind: 'file', sessionId: 'c', matterId: 'm-1' }),
    suggestion('g-new', { kind: 'new', sessionIds: ['a', 'b'], name: '看板', goal: '做完看板' }),
    suggestion('g-new2', { kind: 'new', sessionIds: ['d', 'e'], name: '周报', goal: '' }),
    // Gone from the card: a session filed, archived or unknown; a matter archived; a filing the user undid by hand; a decided one.
    suggestion('g-filed', { kind: 'new', sessionIds: ['a', 'x-filed'], name: '甲', goal: '' }),
    suggestion('g-archived-matter', { kind: 'file', sessionId: 'd', matterId: 'm-old' }),
    suggestion('g-taken', { kind: 'file', sessionId: 'e', matterId: 'm-1' }),
    suggestion('g-gone-matter', { kind: 'file', sessionId: 'e', matterId: 'm-gone' }),
    suggestion('g-done', { kind: 'file', sessionId: 'd', matterId: 'm-1' }, { state: 'declined' }),
  ], { loose, matters, takenOut: new Set([pairKey('e', 'm-1')]) });
  assert.deepEqual(views, [
    {
      id: 'g-new', kind: 'new', name: '看板', goal: '做完看板', workspace: { id: 'w-1', title: 'kb' },
      sessions: [{ id: 'b', title: '标题 b', lastActivity: NOW - HOUR }, { id: 'a', title: '标题 a', lastActivity: NOW - 3 * HOUR }], why: '依据',
    },
    {
      id: 'g-new2', kind: 'new', name: '周报',
      sessions: [{ id: 'e', title: '标题 e', lastActivity: NOW - 4 * HOUR }, { id: 'd', title: '标题 d', lastActivity: NOW - 5 * HOUR }], why: '依据',
    },
    { id: 'g-file', kind: 'file', matter: { id: 'm-1', name: 'm-1' }, sessions: [{ id: 'c', title: '标题 c', lastActivity: NOW - 2 * HOUR }], why: '依据' },
  ]);
});
