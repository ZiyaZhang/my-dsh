import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINE_MAX, clip, previewLine, questionText, toolStep, type Preview } from '../src/host/preview.ts';

const NOW = Date.parse('2026-11-09T06:00:00Z');
const ago = (minutes: number, seconds = 0) => NOW - minutes * 60_000 - seconds * 1_000;

test('a running session says what it is doing and for how many whole minutes', () => {
  assert.equal(previewLine({ kind: 'running', step: '运行命令 npm test', since: ago(3, 40) }, NOW), '正在：运行命令 npm test · 3 分钟');
  assert.equal(previewLine({ kind: 'running', step: '分析请求', since: ago(0, 40) }, NOW), '正在：分析请求 · 刚刚');
  // A clock running ahead of the Host's is not negative time.
  assert.equal(previewLine({ kind: 'running', step: '分析请求', since: NOW + 5_000 }, NOW), '正在：分析请求 · 刚刚');
  // The plugin saw no event of this turn yet.
  assert.equal(previewLine({ kind: 'running' }, NOW), '正在运行');
});

test('a waiting session says what it asks or which tool waits for approval', () => {
  assert.equal(previewLine({ kind: 'question', text: '先改注释还是先改代码？', since: ago(5) }, NOW), '在等你回答：先改注释还是先改代码？');
  assert.equal(previewLine({ kind: 'approval', tool: 'bash', since: ago(5) }, NOW), '在等你批准：bash');
  assert.equal(previewLine({ kind: 'question', text: '', since: ago(5) }, NOW), '在等你回答');
  assert.equal(previewLine({ kind: 'approval', tool: '', since: ago(5) }, NOW), '在等你批准');
});

test('a failed session gives the error; an idle one the start of its last reply; nothing known says nothing', () => {
  assert.equal(previewLine({ kind: 'failed', error: 'Windows 构建没过' }, NOW), '失败：Windows 构建没过');
  assert.equal(previewLine({ kind: 'failed', error: '' }, NOW), '失败');
  assert.equal(previewLine({ kind: 'reply', text: '两处都删短了。' }, NOW), '两处都删短了。');
  assert.equal(previewLine(undefined, NOW), '');
});

test('the line is one line, cut with an ellipsis at the reply preview bound', () => {
  assert.equal(LINE_MAX, 120);
  assert.equal(clip('  先看 CI。\n\n  再看\t日志  '), '先看 CI。 再看 日志');
  const long = '长'.repeat(200);
  assert.equal(clip(long), `${'长'.repeat(119)}…`);
  assert.equal([...clip(long)].length, 120);
  assert.equal(clip('短'.repeat(120)), '短'.repeat(120));
  assert.equal(clip('ab cd', 4), 'ab…');
  // Only the start of a long text is read.
  assert.equal(clip('x'.repeat(100_000)), `${'x'.repeat(119)}…`);
  assert.equal(clip(`开头${' '.repeat(10_000)}结尾`), '开头…');
});

test('a tool call reads as DSH\'s own chat names it: the verb, then what it works on', () => {
  assert.equal(toolStep('bash', JSON.stringify({ command: 'npm   run check', timeout: 600 })), '运行命令 npm run check');
  assert.equal(toolStep('bash', JSON.stringify({ description: 'Run the tests', command: 'npm test' })), '运行命令 Run the tests');
  assert.equal(toolStep('read', JSON.stringify({ path: '/work/notes.md' })), '读取文件 /work/notes.md');
  assert.equal(toolStep('grep', JSON.stringify({ pattern: 'TODO' })), '搜索代码 TODO');
  assert.equal(toolStep('apply_patch', JSON.stringify({ path: 'src/a.ts' })), '编辑文件 src/a.ts');
  assert.equal(toolStep('web_fetch', JSON.stringify({ url: 'https://example.com' })), '访问网页 https://example.com');
  assert.equal(toolStep('subagent_create', JSON.stringify({ task: '读完三份笔记' })), '协调子智能体 读完三份笔记');
  assert.equal(toolStep('todo_write', JSON.stringify({ todos: [] })), '更新计划 todo_write');
  assert.equal(toolStep('web_search', JSON.stringify({ queries: ['dsh', 'board'] })), '搜索网页 dsh, board');
  // Any other tool: 调用工具 with its own name when no argument says what it works on.
  assert.equal(toolStep('board_index', '{}'), '调用工具 board_index');
  assert.equal(toolStep('board_index', 'not json'), '调用工具 board_index');
  assert.equal([...toolStep('bash', JSON.stringify({ command: 'x'.repeat(500) }))].length, '运行命令 '.length + 120);
});

test('the question of an ask_user_question call is its first question', () => {
  const args = JSON.stringify({ questions: [{ id: 'q1', question: '  先改注释\n还是先改代码？ ' }, { id: 'q2', question: '要不要重跑？' }] });
  assert.equal(questionText(args), '先改注释 还是先改代码？');
  assert.equal(questionText(JSON.stringify({ questions: [{ id: 'q1', question: '' }, { id: 'q2', question: '要不要重跑？' }] })), '要不要重跑？');
  assert.equal(questionText('{"questions": "oops"}'), '');
  assert.equal(questionText('{'), '');
});

test('every kind of preview has a line', () => {
  const previews: Preview[] = [
    { kind: 'running', step: '分析请求', since: NOW }, { kind: 'question', text: '?', since: NOW }, { kind: 'approval', tool: 'bash', since: NOW },
    { kind: 'failed', error: 'x' }, { kind: 'reply', text: 'y' },
  ];
  for (const preview of previews) assert.notEqual(previewLine(preview, NOW), '');
});
