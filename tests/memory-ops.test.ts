import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHash, parseFrontmatter } from '../src/host/memory-files.ts';
import {
  CAPTURE_QUIET_MS, CAPTURE_SYSTEM, MERGE_EVERY_MS, MERGE_SYSTEM, captureMemory, capturePrompt, captureReady, changedPaths, checkOps, eventChanges, mergeDue,
  claimWriter, mergeMemory, mergePrompt, newTurns, newestText, opPath, ownEvents, readOps, transcriptLines, turnsSince, turnsText, writerOf, type HistoryEvent, type PassFile,
} from '../src/host/memory-ops.ts';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const stamp = { by: '补记', updated: '2026-11-12' };
const file = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} 的一句话\nsources: [s-1]\nverified: 没核实\n${extra}---\n正文\n`;

test('补记 waits until no session of the matter runs and two minutes have passed since the last event', () => {
  assert.equal(captureReady({ states: ['idle', 'waiting', 'failed', undefined], lastEvent: NOW - CAPTURE_QUIET_MS, now: NOW }), true);
  assert.equal(captureReady({ states: ['idle', 'running'], lastEvent: NOW - 10 * CAPTURE_QUIET_MS, now: NOW }), false);
  assert.equal(captureReady({ states: ['idle'], lastEvent: NOW - CAPTURE_QUIET_MS + 1, now: NOW }), false);
  assert.equal(CAPTURE_QUIET_MS, 120_000);
});

test('the merge is due a day after the last one, or after the memory was set up, and only when the matter had activity since', () => {
  const base = NOW - 2 * MERGE_EVERY_MS;
  assert.equal(mergeDue({ base, lastActivity: NOW - 1000, now: NOW }), true);
  assert.equal(mergeDue({ base, lastActivity: base - 1, now: NOW }), false);
  assert.equal(mergeDue({ mergedAt: NOW - MERGE_EVERY_MS + 60_000, base, lastActivity: NOW, now: NOW }), false);
  assert.equal(mergeDue({ mergedAt: NOW - MERGE_EVERY_MS, base, lastActivity: NOW - 1, now: NOW }), true);
  assert.equal(mergeDue({ mergedAt: NOW - MERGE_EVERY_MS, base, lastActivity: NOW - MERGE_EVERY_MS - 1, now: NOW }), false);
  assert.equal(mergeDue({ base: NOW - 1000, lastActivity: NOW, now: NOW }), false);
});

const event = (seq: number, type: string, data: unknown = {}, time = NOW + seq): HistoryEvent => ({ seq, type, time, data });
const user = (seq: number, text: string, kind = 'user') => event(seq, 'user/message', { source: { kind }, content: [{ type: 'text', text }] });
const reply = (seq: number, text: string) => event(seq, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text }] } });
const call = (seq: number, callId: string, name: string, args: unknown) => event(seq, 'tool/call', { callId, name, arguments: JSON.stringify(args) });
const result = (seq: number, callId: string, text: string, extra: Record<string, unknown> = {}, isError = false) =>
  event(seq, 'tool/result', { message: { toolCallId: callId, isError, content: [{ type: 'text', text }] }, ...extra });

test('a session\'s new turns are the events after its cursor up to the last ended turn; an open turn waits, and the cursor moves to that end', () => {
  const events = [
    event(0, 'turn/start'), user(1, '旧的'), event(2, 'turn/end'),
    event(3, 'turn/start'), user(4, '新的'), reply(5, '好'), event(6, 'turn/end'),
    event(7, 'turn/start'), user(8, '还在做'),
  ];
  const fresh = newTurns(events, 2)!;
  assert.deepEqual(fresh.events.map(item => item.seq), [3, 4, 5, 6]);
  assert.equal(fresh.cursor, 6);
  // Nothing ended after the cursor: no pass for this session yet.
  assert.equal(newTurns(events, 6), undefined);
  // No cursor yet: everything read up to the last end.
  assert.deepEqual(newTurns(events, -1)!.events.map(item => item.seq), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(turnsSince(events, NOW + 3).map(item => item.seq), [3, 4, 5, 6]);
});

test('a forked session\'s copy of its parent\'s history is not its own', () => {
  const events = [
    event(0, 'turn/start'), user(1, '父会话的话'), event(2, 'turn/end'), event(3, 'session/end-seed', { inherited: true }),
    event(4, 'turn/start'), user(5, '分叉后的话'), event(6, 'turn/end'),
  ];
  assert.deepEqual(ownEvents(events).map(item => item.seq), [4, 5, 6]);
  // An untagged marker is an ordinary restore boundary, not a fork's cut.
  assert.equal(ownEvents([event(0, 'session/end-seed', {}), user(1, '话')]).length, 2);
  assert.equal(ownEvents([user(0, '话')]).length, 1);
});

test('the turns read as the user\'s words, my dsh\'s tasks, replies and tool calls; context snapshots, notices and reasoning stay out', () => {
  const lines = transcriptLines([
    event(0, 'turn/start'),
    user(1, '记忆的索引……', 'runtime-context'),
    user(2, '派出去的会话有结果了', 'subagent-settled'),
    user(3, '把 0.163 的报告\n  发到飞书'),
    user(4, '跑一遍测试', 'my-dsh'),
    call(5, 'c-1', 'bash', { command: 'npm test' }),
    call(6, 'c-2', 'apply_patch', { input: '*** Begin Patch\n*** Add File: a.md\n+x\n*** Update File: b.md\n*** Move to: c.md\n@@\n-y\n+z\n*** End Patch' }),
    reply(7, '测试过了。'),
    event(8, 'turn/end'),
  ]);
  assert.deepEqual(lines, ['用户：把 0.163 的报告 发到飞书', '派来的任务：跑一遍测试', '工具：运行命令 npm test', '工具：编辑文件 a.md、c.md', '回复：测试过了。']);
});

test('each session\'s turns keep their newest part within the session\'s share and the total, newest session first', () => {
  assert.equal(newestText(['一'.repeat(10), '二'.repeat(10), '三'.repeat(10)], 25), '（前面还有 10 字没给）\n二二二二二二二二二二\n三三三三三三三三三三');
  assert.equal(newestText(['一', '二'], 25), '一\n二');
  const sessions = [
    { id: 's-old', title: '旧会话', lines: ['用户：旧'], last: NOW - 1000 },
    { id: 's-new', title: '新会话', lines: ['用户：新', `回复：${'长'.repeat(8000)}`], last: NOW },
  ];
  const text = turnsText(sessions, 30_000, 6_000);
  assert.ok(text.indexOf('## 会话「新会话」（id=s-new）') < text.indexOf('## 会话「旧会话」（id=s-old）'));
  assert.match(text, /（前面还有 \d+ 字没给）/);
  const block = text.split('\n\n')[0]!;
  assert.ok(block.length <= 6_000 + 40);
  const tight = turnsText(sessions, 6_100, 6_000);
  assert.ok(!tight.includes('旧会话'));
});

const shown = (path: string, text: string) => ({ path, text, hash: contentHash(text) });

test('补记 reads every memory file whole while they fit, else only the index, and then may only add', () => {
  const files: PassFile[] = [shown('规则/a.md', file('a')), shown('坑/b.md', file('b'))];
  const whole = captureMemory(files, '# 索引');
  assert.match(whole.text, /^### 规则\/a\.md\n---\nname: a/);
  assert.deepEqual([...whole.shown.keys()], ['规则/a.md', '坑/b.md']);
  const index = captureMemory(files, '# 索引', 10);
  assert.match(index.text, /只能新增/);
  assert.match(index.text, /# 索引$/);
  assert.equal(index.shown.size, 0);
  assert.equal(captureMemory([], '# 索引').text, '还没有记忆文件。');
});

test('a merge reads whole the files whose sources had new turns first, then the newest; the rest by their index line', () => {
  const files: PassFile[] = [
    { ...shown('规则/old.md', file('old')), sources: ['s-9'], updated: NOW - 3 * MERGE_EVERY_MS, line: '- [old](规则/old.md) — old' },
    { ...shown('规则/new.md', file('new')), sources: ['s-9'], updated: NOW, line: '- [new](规则/new.md) — new' },
    { ...shown('坑/hot.md', file('hot')), sources: ['s-1'], updated: NOW - 5 * MERGE_EVERY_MS, line: '- [hot](坑/hot.md) — hot' },
  ];
  const memory = mergeMemory(files, new Set(['s-1']), file('x').length * 2 + 10);
  assert.deepEqual([...memory.shown.keys()], ['坑/hot.md', '规则/new.md']);
  assert.match(memory.text, /不能改、删：\n- \[old\]\(规则\/old\.md\) — old$/);
});

test('the prompts carry the matter, the memory and the turns; the merge also the index size and whether it is near the cap', () => {
  const matter = { name: 'SDK 升级跟进', goal: '挑功能做成插件', instructions: '不改核心' };
  const capture = capturePrompt(matter, '### 规则/a.md', '## 会话「报告」（id=s-1）\n用户：出报告');
  assert.match(capture, /^事项：SDK 升级跟进\n目标：挑功能做成插件\n指令：不改核心\n\n记忆：\n### 规则\/a\.md\n\n会话的新轮次：\n## 会话「报告」/);
  const merge = mergePrompt(matter, '### 规则/a.md', '', { lines: 170, bytes: 14_000, nearCap: true });
  assert.match(merge, /现在的索引 170 行、13\.7 KB，快到上限了，这次要压回去。/);
  assert.match(merge, /上次合并以来的会话：\n（没有读到）$/);
  // What memory is for comes first; the 70% target is in the merge's own words.
  assert.match(CAPTURE_SYSTEM, /^你在给一件事项补记记忆。记忆给以后在这件事项里干活的会话看/);
  assert.match(MERGE_SYSTEM, /不超过 140 行、11\.2 KB/);
  for (const system of [CAPTURE_SYSTEM, MERGE_SYSTEM]) assert.match(system, /by 是“你说的”的文件是用户的原话，不改不删/);
});

test('the model\'s answer is read from its first JSON object, a bare list, or fenced code; anything else is no answer', () => {
  assert.deepEqual(readOps('好的：\n```json\n{"ops":[{"op":"add","path":"坑/a.md","content":"x"},{"op":"delete","path":"规则/b.md"},{"nope":1}]}\n```'), [
    { op: 'add', path: '坑/a.md', content: 'x' }, { op: 'delete', path: '规则/b.md' },
  ]);
  assert.deepEqual(readOps('[{"op":"update","path":"规则/a.md","content":"y"}]'), [{ op: 'update', path: '规则/a.md', content: 'y' }]);
  assert.deepEqual(readOps('{"ops":[]}'), []);
  assert.equal(readOps('没什么要记的'), undefined);
  assert.equal(readOps('{"ops": "不是列表"}'), undefined);
  assert.equal(readOps('{坏的 json}'), undefined);
});

test('an operation\'s path must be <category>/<name>.md, nothing above or beside the category folders', () => {
  assert.equal(opPath(' ./规则/差距报告格式.md '), '规则/差距报告格式.md');
  assert.equal(opPath('规则\\a.md'), '规则/a.md');
  for (const path of ['MEMORY.md', '规则/INDEX.md', '../规则/a.md', '规则/../坑/a.md', '/abs/规则/a.md', '规则/a.txt', '别的/a.md', '规则/sub/a.md', `规则/${'长'.repeat(81)}.md`]) {
    assert.equal(opPath(path), undefined, path);
  }
});

test('the checks keep the user\'s files, refuse adds on taken paths, and updates or deletes of files not seen whole or changed since', () => {
  const mine = `---\nname: 我的\ndescription: 我说的\nby: 你说的\n---\n正文\n`;
  const files = new Map([
    ['规则/a.md', { hash: contentHash(file('a')), userOwned: false }],
    ['规则/mine.md', { hash: contentHash(mine), userOwned: true }],
    ['坑/changed.md', { hash: 'new-hash', userOwned: false }],
    ['坑/unseen.md', { hash: 'h', userOwned: false }],
  ]);
  const seen = new Map([['规则/a.md', contentHash(file('a'))], ['规则/mine.md', contentHash(mine)], ['坑/changed.md', 'old-hash']]);
  const { planned, skipped } = checkOps([
    { op: 'add', path: '坑/新的.md', content: file('新的') },
    { op: 'add', path: '规则/A.md', content: file('A') },
    { op: 'update', path: '规则/a.md', content: file('a2') },
    { op: 'update', path: '规则/mine.md', content: file('mine2') },
    { op: 'delete', path: '规则/mine.md' },
    { op: 'delete', path: '坑/changed.md' },
    { op: 'delete', path: '坑/unseen.md' },
    { op: 'update', path: '坑/missing.md', content: file('m') },
    { op: 'rename', path: '规则/a.md' },
    { op: 'add', path: 'MEMORY.md', content: file('x') },
  ], files, seen, stamp);
  assert.deepEqual(planned.map(op => [op.op, op.path, op.expect]), [['add', '坑/新的.md', undefined], ['update', '规则/a.md', contentHash(file('a'))]]);
  assert.deepEqual(skipped.map(op => [op.op, op.path, op.reason]), [
    ['add', '规则/A.md', '这个路径已经有文件了'],
    ['update', '规则/mine.md', '标“你说的”的条目不能动'],
    ['delete', '规则/mine.md', '标“你说的”的条目不能动'],
    ['delete', '坑/changed.md', '文件在读过之后又被改了'],
    ['delete', '坑/unseen.md', '没看过这个文件的全文'],
    ['update', '坑/missing.md', '没有这个文件'],
    ['rename', '规则/a.md', '不认识的操作'],
    ['add', 'MEMORY.md', '路径不在类别目录里'],
  ]);
});

test('a written file gets by and updated from the pass; one without a head, claiming 你说的, too big or holding a secret is skipped', () => {
  const { planned, skipped } = checkOps([
    { op: 'add', path: '坑/a.md', content: file('a', 'by: 会话「X」\n') },
    { op: 'add', path: '坑/b.md', content: '只有正文' },
    { op: 'add', path: '坑/c.md', content: '---\nname: c\n---\n' },
    { op: 'add', path: '坑/d.md', content: file('d', 'by: 你说的\n') },
    { op: 'add', path: '坑/e.md', content: file('e') + 'x'.repeat(100 * 1024) },
    { op: 'add', path: '坑/f.md', content: `${file('f')}token = sk-abcdefghijklmnopqrstuvwxyz0123` },
    { op: 'add', path: '坑/g.md' },
    { op: 'add', path: '坑/a.md', content: file('a again') },
  ], new Map(), new Map(), stamp);
  assert.equal(planned.length, 1);
  const fields = parseFrontmatter(planned[0]!.content!)!.fields;
  assert.equal(fields.by, '补记');
  assert.equal(fields.updated, '2026-11-12');
  assert.ok(planned[0]!.content!.endsWith('\n'));
  assert.deepEqual(skipped.map(op => [op.path, op.reason]), [
    ['坑/b.md', '开头格式不对'], ['坑/c.md', '开头格式不对'], ['坑/d.md', '不能写成“你说的”'], ['坑/e.md', '超过 100 KB'], ['坑/f.md', '内容像密钥'],
    ['坑/g.md', '开头格式不对'], ['坑/a.md', '一次只能动同一个文件一回'],
  ]);
});

test('a memory file change belongs to the session whose file call on it came last in the two minutes before, else to the user', () => {
  const folders = ['/w/.my-dsh/m-1/memory', '/private/w/.my-dsh/m-1/memory'];
  const writes = [
    { sessionId: 's-old', callId: 'c-0', paths: ['/w/.my-dsh/m-1/memory/坑/a.md'], at: NOW - 200_000 },
    { sessionId: 's-1', callId: 'c-1', paths: ['/w/.my-dsh/m-1/memory/坑/a.md'], at: NOW - 30_000 },
    { sessionId: 's-2', callId: 'c-2', paths: ['/private/w/.my-dsh/m-1/memory/坑/a.md'], at: NOW - 5_000 },
    { sessionId: 's-3', callId: 'c-3', paths: ['/w/other/坑/a.md'], at: NOW - 1_000 },
    { sessionId: 's-4', callId: 'c-4', paths: ['/w/.my-dsh/m-1/memory/坑/a.md'], at: NOW + 1_000 },
  ];
  assert.equal(writerOf('坑/a.md', folders, NOW, writes), 's-2');
  assert.equal(writerOf('坑/a.md', folders, NOW, writes.slice(0, 2)), 's-1');
  assert.equal(writerOf('坑/a.md', folders, NOW, writes.slice(0, 1)), undefined);
  assert.equal(writerOf('规则/b.md', folders, NOW, writes), undefined);
});

test('the files a session\'s turns changed, from successful write, edit and apply_patch calls; a call without its result holds the cursor back', () => {
  const events = [
    call(0, 'c-1', 'write', { file_path: 'notes/a.md', content: 'x' }),
    result(1, 'c-1', 'Created', { meta: { operation: 'create', path: '/w/notes/a.md' } }),
    call(2, 'c-2', 'edit', { file_path: '/w/.my-dsh/m-1/memory/坑/a.md', old_string: 'a', new_string: 'b' }),
    result(3, 'c-2', 'Edited', { meta: { path: '/w/.my-dsh/m-1/memory/坑/a.md' } }),
    call(4, 'c-3', 'write', { file_path: 'refused.md', content: 'x' }),
    result(5, 'c-3', 'rejected', {}, true),
    call(6, 'c-4', 'bash', { command: 'echo > x' }),
    result(7, 'c-4', ''),
    call(8, 'c-5', 'apply_patch', { input: '*** Begin Patch\n*** Add File: b.md\n+y\n*** End Patch' }),
  ];
  assert.deepEqual(changedPaths(events, '/w'), ['/w/notes/a.md', '/w/.my-dsh/m-1/memory/坑/a.md']);
  const { changes, cursor } = eventChanges(events, '/w');
  assert.deepEqual(changes.map(change => [change.path, change.kind, change.at]), [['/w/notes/a.md', 'created', NOW + 1], ['/w/.my-dsh/m-1/memory/坑/a.md', 'modified', NOW + 3]]);
  assert.equal(cursor, 7);
  assert.equal(eventChanges(events.slice(0, 8), '/w').cursor, 7);
});

test('a call explains one change of a file: a later edit of it in the window is the user\'s', () => {
  const folders = ['/w/.my-dsh/m-1/memory'];
  const writes = [{ sessionId: 's-1', callId: 'c-1', paths: ['/w/.my-dsh/m-1/memory/坑/a.md'], at: NOW - 5_000 }];
  const claimed = new Set<string>();
  assert.equal(claimWriter('坑/a.md', folders, NOW, writes, claimed), 's-1');
  assert.equal(claimWriter('坑/a.md', folders, NOW + 3_000, writes, claimed), undefined);
  // Another file the same call touched is still its own.
  const both = [{ sessionId: 's-2', callId: 'c-2', paths: ['/w/.my-dsh/m-1/memory/坑/b.md', '/w/.my-dsh/m-1/memory/坑/c.md'], at: NOW - 1_000 }];
  assert.equal(claimWriter('坑/b.md', folders, NOW, both, claimed), 's-2');
  assert.equal(claimWriter('坑/c.md', folders, NOW, both, claimed), 's-2');
});
