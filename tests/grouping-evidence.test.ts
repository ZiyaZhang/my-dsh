import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyEvidence, foldEvidence, ghCommand, ownPrKeys, prKey, prKeys, scheduleIds, shellWords } from '../src/host/grouping-evidence.ts';
import type { HistoryEvent } from '../src/host/memory-ops.ts';

test('a PR URL becomes host/owner/repo#n in lower case, without what follows the number', () => {
  assert.equal(prKey('https://github.com/DeepSeek-AI/DeepSeek-Harness/pull/8381'), 'github.com/deepseek-ai/deepseek-harness#8381');
  assert.equal(prKey('https://github.com/a/b/pull/12/files?diff=split#r1'), 'github.com/a/b#12');
  assert.equal(prKey('https://ghe.example.com/team/tool/pull/3'), 'ghe.example.com/team/tool#3');
  assert.equal(prKey('https://github.com/a/b/issues/12'), undefined);
  assert.equal(prKey('https://github.com/a/b/pull/0'), undefined);
  assert.deepEqual(prKeys('看下 https://github.com/a/b/pull/12，还有 https://github.com/a/b/pull/12 和 https://github.com/c/d/pull/7。'), ['github.com/a/b#12', 'github.com/c/d#7']);
});

test('gh prints its own PR in a url line or a JSON url member; links in a description after -- are not its own', () => {
  const view = 'title:\t改看板\nstate:\tOPEN\nurl:\thttps://github.com/a/b/pull/12\n--\n参考 https://github.com/x/y/pull/99';
  assert.deepEqual(ownPrKeys(view), ['github.com/a/b#12']);
  assert.deepEqual(ownPrKeys('{"number":12,"url":"https://github.com/a/b/pull/12"}'), ['github.com/a/b#12']);
  assert.deepEqual(ownPrKeys('Merged https://github.com/x/y/pull/99 into main'), []);
});

test('a command line splits into simple commands at separators outside quotes, a redirection staying one word', () => {
  assert.deepEqual(shellWords('cd "/work/my dsh" && gh pr view 12 2>&1 | head -5; echo \'a;b\''), [
    ['cd', '/work/my dsh'], ['gh', 'pr', 'view', '12', '2>&1'], ['head', '-5'], ['echo', 'a;b'],
  ]);
});

test('gh pr commands say whether they create or refer to a PR, and which PR they name', () => {
  assert.deepEqual(ghCommand('gh pr create --title "看板 · 建议卡" --body-file /tmp/body.md'), { created: true, referenced: false, keys: [], numbers: [] });
  assert.deepEqual(ghCommand('gh pr view https://github.com/a/b/pull/12 --comments'), { created: false, referenced: true, keys: ['github.com/a/b#12'], numbers: [] });
  assert.deepEqual(ghCommand('gh pr merge 12 --squash -R a/b'), { created: false, referenced: true, keys: ['github.com/a/b#12'], numbers: [] });
  assert.deepEqual(ghCommand('gh pr view --json url,title 12 --repo=ghe.example.com/team/tool'), { created: false, referenced: true, keys: ['ghe.example.com/team/tool#12'], numbers: [] });
  assert.deepEqual(ghCommand('GH_REPO=a/b gh pr checkout 7'), { created: false, referenced: true, keys: ['github.com/a/b#7'], numbers: [] });
  assert.deepEqual(ghCommand('gh pr review -b "LGTM" 31 --approve'), { created: false, referenced: true, keys: [], numbers: [31] });
  assert.deepEqual(ghCommand('git push -u origin feat/x && gh pr create --fill'), { created: true, referenced: false, keys: [], numbers: [] });
  // Not a gh pr command, or one that names no PR it acts on.
  assert.equal(ghCommand('gh issue view 12'), undefined);
  assert.equal(ghCommand('echo "gh is fine"'), undefined);
  assert.equal(ghCommand('gh pr list --state open'), undefined);
  assert.deepEqual(ghCommand('gh pr view feat/x'), { created: false, referenced: true, keys: [], numbers: [] });
});

test('a schedule delivery names its tasks; a change notice to the sessions involved is not a delivery', () => {
  assert.deepEqual(scheduleIds('[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-1"\noccurrence_at: 2026-11-12T01:00:00Z'), ['schedule-1']);
  assert.deepEqual(scheduleIds(`[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ${JSON.stringify([
    { schedule_id: 'schedule-1', occurrence_at: 'x', reminder_prompt: 'a' }, { schedule_id: 'schedule-2', occurrence_at: 'x', reminder_prompt: 'b' },
  ])}`), ['schedule-1', 'schedule-2']);
  assert.deepEqual(scheduleIds('[SCHEDULE CHANGE]\nchange: updated\nschedule_id_json: "schedule-1"'), []);
  assert.deepEqual(scheduleIds('[SCHEDULE REMINDER]\nschedule_id_json: not json'), []);
});

let seq = 0;
const event = (type: string, data: unknown): HistoryEvent => ({ type, seq: seq++, time: 1_000 + seq, data });
const message = (kind: string, text: string, extra: Record<string, unknown> = {}) => event('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind, ...extra } });
const bash = (callId: string, command: string) => event('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) });
const result = (callId: string, text: string, isError = false) => event('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError } });

test('a log read gives the first turn\'s trigger, PRs from gh calls and the user\'s prompts, references and schedule deliveries', () => {
  seq = 0;
  const events = [
    event('turn/start', { turn: 1 }),
    message('time-context', '现在是 11 月 12 日'),
    message('session-reference', '', { references: [{ sessionId: 's-other' }, { sessionId: 's-self' }] }),
    message('user', '接着改 https://github.com/a/b/pull/12 的评论'),
    bash('c-1', 'gh pr create --fill'),
    result('c-1', 'https://github.com/a/b/pull/13\n'),
    bash('c-2', 'gh pr view 14'),
    result('c-2', 'url:\thttps://github.com/a/b/pull/14'),
    bash('c-3', 'gh pr merge 15 --squash'),
    result('c-3', 'X Pull request #15 is not mergeable', true),
    event('tool/call', { turn: 1, step: 2, callId: 'c-4', name: 'read', arguments: '{"path":"notes.md"}' }),
    result('c-4', '参考 https://github.com/x/y/pull/99'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', { turn: 2 }),
    message('schedule', '[SCHEDULE REMINDER]\nschedule_id_json: "schedule-1"'),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ];
  const evidence = foldEvidence(emptyEvidence(), events, 's-self', 5_000);
  assert.deepEqual(evidence, {
    cursor: events.at(-1)!.seq, prs: ['github.com/a/b#12', 'github.com/a/b#13', 'github.com/a/b#14'], numbers: [], refs: ['s-other'],
    schedules: ['schedule-1'], trigger: 'user', readAt: 5_000,
  });
});

test('a schedule that started the first turn is its trigger; a later read keeps what the first found and adds to it', () => {
  seq = 0;
  const first = foldEvidence(emptyEvidence(), [
    event('turn/start', { turn: 1 }), message('runtime-context', '…'), message('schedule', '[SCHEDULE REMINDER]\nschedule_id_json: "schedule-9"'),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ], 's-1', 10);
  assert.equal(first.trigger, 'schedule');
  const later = foldEvidence(first, [event('turn/start', { turn: 2 }), message('user', '再看 https://github.com/a/b/pull/3')], 's-1', 20);
  assert.equal(later.trigger, 'schedule');
  assert.deepEqual(later.prs, ['github.com/a/b#3']);
  assert.deepEqual(later.schedules, ['schedule-9']);
  assert.equal(later.cursor, seq - 1);
});

test('the cursor stops before a gh call still waiting for its result, so the next read sees the call again', () => {
  seq = 10;
  const start = event('turn/start', { turn: 3 });
  const call = bash('c-1', 'gh pr view 21 -R a/b');
  const progress = event('tool/progress', {});
  const waiting = foldEvidence(emptyEvidence(), [start, call, progress], 's-1', 1);
  assert.equal(waiting.cursor, call.seq - 1);
  assert.deepEqual(waiting.prs, []);
  const done = foldEvidence(waiting, [call, progress, result('c-1', 'title:\tx')], 's-1', 2);
  assert.deepEqual(done.prs, ['github.com/a/b#21']);
  assert.equal(done.cursor, seq - 1);
  // A bare number is kept for the session's git remote to resolve.
  assert.deepEqual(foldEvidence(emptyEvidence(), [bash('c-9', 'gh pr checkout 8'), result('c-9', 'Switched to branch')], 's-1', 3).numbers, [8]);
});
