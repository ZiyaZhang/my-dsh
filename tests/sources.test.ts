import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestError } from '../src/host/remote.ts';
import { INSTRUCTIONS_MAX, SOURCES_MAX, classifyUrl, matterInstructions, pathSource, sourceLabel } from '../src/host/sources.ts';

const refused = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof RequestError && message.test(error.message));

test('a GitHub pull request link becomes a PR named owner/repo#n', () => {
  assert.deepEqual(classifyUrl('https://github.com/example/app/pull/4321'),
    { kind: 'pr', value: 'https://github.com/example/app/pull/4321', title: 'example/app#4321' });
  // Tabs, queries and fragments of the same PR point at the PR itself.
  assert.deepEqual(classifyUrl('  https://github.com/o/r/pull/12/files?diff=split#top '),
    { kind: 'pr', value: 'https://github.com/o/r/pull/12', title: 'o/r#12' });
  assert.equal(classifyUrl('https://github.com/o/r/issues/12').kind, 'link');
  assert.equal(classifyUrl('https://github.com/o/r').kind, 'link');
});

test('Feishu and Lark documents become docs; anything else on the web is a link', () => {
  for (const url of [
    'https://example.feishu.cn/docx/AbC123', 'https://example.feishu.cn/wiki/XyZ', 'https://abc.larksuite.com/docs/doccn1',
    'https://x.larkoffice.com/sheets/S1', 'https://example.feishu.cn/base/B1?table=t',
  ]) assert.deepEqual(classifyUrl(url), { kind: 'doc', value: url }, url);
  assert.deepEqual(classifyUrl('https://example.feishu.cn/'), { kind: 'link', value: 'https://example.feishu.cn/' });
  assert.deepEqual(classifyUrl('https://notfeishu.cn/docx/1'), { kind: 'link', value: 'https://notfeishu.cn/docx/1' });
  assert.deepEqual(classifyUrl('http://localhost:4790/x'), { kind: 'link', value: 'http://localhost:4790/x' });
});

test('only web links are taken', () => {
  refused(() => classifyUrl('ftp://example.com/a'), /要以 http:\/\/ 或 https:\/\/ 开头/);
  refused(() => classifyUrl('feishu doc'), /要以 http:\/\/ 或 https:\/\/ 开头/);
  refused(() => classifyUrl(''), /要以 http:\/\/ 或 https:\/\/ 开头/);
});

test('a checked path is a folder or a file, named by its last part', () => {
  assert.deepEqual(pathSource('/work/deepseek-harness/', 'folder'), { kind: 'folder', value: '/work/deepseek-harness', title: 'deepseek-harness' });
  assert.deepEqual(pathSource('/work/notes/plan.md', 'file'), { kind: 'file', value: '/work/notes/plan.md', title: 'plan.md' });
  assert.deepEqual(pathSource('/', 'folder'), { kind: 'folder', value: '/', title: '/' });
});

test('a source reads as its title, or a short form of its link', () => {
  assert.equal(sourceLabel({ kind: 'pr', value: 'https://github.com/o/r/pull/1', title: 'o/r#1' }), 'o/r#1');
  assert.equal(sourceLabel({ kind: 'doc', value: 'https://example.feishu.cn/docx/AbC123' }), 'example.feishu.cn/docx/AbC123');
  assert.equal(sourceLabel({ kind: 'link', value: 'https://example.com/' }), 'example.com');
  assert.equal(sourceLabel({ kind: 'folder', value: '/work/kb', title: 'kb' }), 'kb');
});

test('instructions are trimmed, at most 2,000 characters, and empty means none', () => {
  assert.equal(INSTRUCTIONS_MAX, 2_000);
  assert.equal(SOURCES_MAX, 30);
  assert.equal(matterInstructions('  改飞书只替换对应的一节。\n图用插件页的真实样式。 '), '改飞书只替换对应的一节。\n图用插件页的真实样式。');
  assert.equal(matterInstructions('   '), undefined);
  assert.equal(matterInstructions('长'.repeat(2_000))?.length, 2_000);
  refused(() => matterInstructions('长'.repeat(2_001)), /指令最多 2000 个字/);
});
