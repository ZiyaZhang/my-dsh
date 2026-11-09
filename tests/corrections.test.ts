import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActivityEntry, Matter, Proposal, SessionLink, WhichQuestion } from '../src/host/remote.ts';
import {
  CorrectionLog, correctionLine, declineCorrection, membershipCorrection, pickCorrection, undoCorrection, type Correction,
} from '../src/host/corrections.ts';

const T0 = '2026-11-09T01:00:00.000Z';
const T1 = '2026-11-09T02:00:00.000Z';
const link = (sessionId: string, by: SessionLink['by'], why?: string): SessionLink => ({ sessionId, by, at: T0, ...(why ? { why } : {}) });
const matter = (id: string, links: SessionLink[]): Matter => ({ id, name: id, goal: '', sessions: links, aliases: [], sources: [], createdAt: T0 });

test('a by-hand add, move or removal is one line with the link it replaced; nothing changing writes nothing', () => {
  const brief = matter('m-brief', [link('s-1', 'mydsh', '前三期都在这里'), link('s-2', 'manual')]);
  assert.deepEqual(membershipCorrection(undefined, 'm-brief', 's-9', T1), {
    at: T1, kind: 'add', sessionId: 's-9', decided: null, chosen: { matterId: 'm-brief' },
  });
  assert.deepEqual(membershipCorrection({ matter: brief, link: brief.sessions[0]! }, 'm-notes', 's-1', T1), {
    at: T1, kind: 'move', sessionId: 's-1',
    decided: { matterId: 'm-brief', by: 'mydsh', at: T0, why: '前三期都在这里' }, chosen: { matterId: 'm-notes' },
  });
  assert.deepEqual(membershipCorrection({ matter: brief, link: brief.sessions[1]! }, null, 's-2', T1), {
    at: T1, kind: 'remove', sessionId: 's-2', decided: { matterId: 'm-brief', by: 'manual', at: T0 }, chosen: null,
  });
  assert.equal(membershipCorrection({ matter: brief, link: brief.sessions[1]! }, 'm-brief', 's-2', T1), null);
  assert.equal(membershipCorrection(undefined, null, 's-9', T1), null);
});

const question = (): WhichQuestion => ({
  id: 'q-1', phrase: '那个项目', why: '两件都和周报有关', at: T0, state: 'pending', sessionId: 's-mydsh', turn: 3,
  candidates: [{ kind: 'matter', id: 'm-brief', label: '每周简报' }, { kind: 'session', id: 's-4', label: '整理周报' }],
});

test('a candidate pick records the phrase, the candidates my dsh offered and the pick, or null for 都不是', () => {
  assert.deepEqual(pickCorrection(question(), { kind: 'matter', id: 'm-brief', label: '每周简报' }, T1), {
    at: T1, kind: 'pick', phrase: '那个项目', question: 'q-1',
    decided: { candidates: [{ kind: 'matter', id: 'm-brief' }, { kind: 'session', id: 's-4' }], why: '两件都和周报有关' },
    chosen: { kind: 'matter', id: 'm-brief' },
  });
  assert.equal(pickCorrection(question(), null, T1).chosen, null);
});

test('a declined proposal records the change my dsh proposed and why, and the phrase when there was one', () => {
  const proposal: Proposal = {
    id: 'p-1', change: { kind: 'rename', matterId: 'm-brief', oldName: '每周简报', name: '周报' }, why: '你一直叫它周报',
    phrase: '周报', at: T0, state: 'declined', sessionId: 's-mydsh', turn: 2,
  };
  assert.deepEqual(declineCorrection(proposal, T1), {
    at: T1, kind: 'decline', phrase: '周报', proposal: 'p-1',
    decided: { change: { kind: 'rename', matterId: 'm-brief', oldName: '每周简报', name: '周报' }, why: '你一直叫它周报' }, chosen: null,
  });
  const { phrase: _phrase, ...withoutPhrase } = proposal;
  assert.ok(!('phrase' in declineCorrection(withoutPhrase, T1)));
});

test('an undo records the entry it took back with the provenance of the link it made', () => {
  const entry: ActivityEntry = {
    id: 'a-1', at: T0, kind: 'start', matterId: 'm-brief', sessionId: 's-7', text: '在「每周简报」开了会话 整理周报', why: '前三期都在这里', task: '整理这周的 PR',
  };
  assert.deepEqual(undoCorrection(entry, T1), {
    at: T1, kind: 'undo', activity: 'a-1', sessionId: 's-7', matterId: 'm-brief',
    decided: { kind: 'start', by: 'mydsh', text: '在「每周简报」开了会话 整理周报', why: '前三期都在这里' }, chosen: null,
  });
  const filed: ActivityEntry = { id: 'a-2', at: T0, kind: 'file', matterId: 'm-brief', sessionId: 's-8', text: '把会话 草稿 加进「每周简报」', why: '你手动加的' };
  assert.equal((undoCorrection(filed, T1).decided as { by: string }).by, 'manual');
});

test('each correction is one JSON line, appended in order to corrections.jsonl', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const log = new CorrectionLog(directory);
  const first = membershipCorrection(undefined, 'm-brief', 's-9', T0)!;
  const second = pickCorrection(question(), null, T1);
  assert.equal(correctionLine(first), `${JSON.stringify(first)}\n`);
  await Promise.all([log.append(first), log.append(second)]);
  const lines = (await readFile(join(directory, 'corrections.jsonl'), 'utf8')).split('\n');
  assert.equal(lines.at(-1), '');
  assert.deepEqual(lines.slice(0, -1).map(line => JSON.parse(line) as Correction), [first, second]);
});

test('a correction that cannot be written does not fail the change that caused it', async () => {
  const log = new CorrectionLog('/dev/null/my-dsh');
  const failures: unknown[] = [];
  const quiet = new CorrectionLog('/dev/null/my-dsh', (error) => { failures.push(error); });
  await log.append(membershipCorrection(undefined, 'm-brief', 's-9', T0)!);
  await quiet.append(membershipCorrection(undefined, 'm-brief', 's-9', T0)!);
  assert.equal(failures.length, 1);
});
