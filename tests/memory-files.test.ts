import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATEGORY_ORDER, FILE_MAX, categoryOf, checkMemoryFile, clipDescription, contentHash, freePath, isVerified, looksSecret, parseFrontmatter, renderMemoryFile,
  setFields, shortName,
} from '../src/host/memory-files.ts';

const FILE = [
  '---',
  'name: 差距报告格式',
  'description: 报告写到当前目录的 report.md，写完回复 REPORT_DONE',
  'by: 会话「OpenCodex 报告 · 0.163」',
  'sources: [session-04cd, session-9f2a]',
  'verified: 是，0.163 和 0.164 两次都照这个交付',
  'updated: 2026-11-12',
  '---',
  '差距报告写到会话当前目录的 report.md，写完只回复 REPORT_DONE。',
  '',
  '为什么：报告页按这个文件名取报告。',
].join('\n');

const info = (text: string) => ({ size: Buffer.byteLength(text, 'utf8'), mtime: 1_700_000_000_000 });

test('the category folders are the five note kinds, in the index order', () => {
  assert.deepEqual(CATEGORY_ORDER, ['规则', '定下的', '答过的', '坑', '没做完']);
  assert.equal(categoryOf('规则/差距报告格式.md'), '规则');
  assert.equal(categoryOf('没做完/0.163 重开.MD'), '没做完');
  for (const path of ['MEMORY.md', '规则/INDEX.md', '规则/.hidden.md', '规则/notes.txt', '规则/sub/x.md', '别的/x.md', '规则/.md']) assert.equal(categoryOf(path), undefined, path);
});

test('the frontmatter reads fields, lists and the body', () => {
  const parsed = parseFrontmatter(FILE)!;
  assert.equal(parsed.fields.name, '差距报告格式');
  assert.equal(parsed.fields.by, '会话「OpenCodex 报告 · 0.163」');
  assert.deepEqual(parsed.sources, ['session-04cd', 'session-9f2a']);
  assert.equal(parsed.fields.updated, '2026-11-12');
  assert.equal(parsed.body, '差距报告写到会话当前目录的 report.md，写完只回复 REPORT_DONE。\n\n为什么：报告页按这个文件名取报告。');
});

test('the frontmatter reader is lenient: a BOM, blank lines first, quotes, case, full-width colons, block lists, continued lines', () => {
  const text = [
    '﻿', '', '---', 'Name: "带: 冒号的名字"', 'DESCRIPTION：先说结论，', '  再说依据', 'by: \'你说的\'', 'sources:', '  - s-1', '  - "s-2"',
    '# a comment', 'not a field line', 'verified: >', '  没核实', '...', '正文',
  ].join('\r\n');
  const parsed = parseFrontmatter(text)!;
  assert.equal(parsed.fields.name, '带: 冒号的名字');
  assert.equal(parsed.fields.description, '先说结论， 再说依据');
  assert.equal(parsed.fields.by, '你说的');
  assert.deepEqual(parsed.sources, ['s-1', 's-2']);
  assert.equal(parsed.fields.verified, '没核实');
  assert.equal(parsed.body, '正文');
  assert.deepEqual(parseFrontmatter('---\nsources: s-9\n---\n')!.sources, ['s-9']);
  assert.deepEqual(parseFrontmatter('---\nsources: []\n---\n')!.sources, []);
});

test('a text that does not open with a closed block has no frontmatter', () => {
  assert.equal(parseFrontmatter('name: x\ndescription: y'), undefined);
  assert.equal(parseFrontmatter('---\nname: x\ndescription: y\n'), undefined);
  assert.equal(parseFrontmatter('正文\n---\nname: x\n---'), undefined);
});

test('a checked file is an index entry with whether it is the user\'s and whether it was checked', () => {
  const checked = checkMemoryFile('规则/差距报告格式.md', FILE, info(FILE));
  assert.ok('entry' in checked);
  const { entry } = checked;
  assert.equal(entry.category, '规则');
  assert.equal(entry.name, '差距报告格式');
  assert.equal(entry.userOwned, false);
  assert.equal(entry.isVerified, true);
  assert.equal(entry.updated, Date.parse('2026-11-12'));
  assert.equal(entry.hash, contentHash(FILE));
  assert.deepEqual(entry.warnings, []);
  const user = FILE.replace('by: 会话「OpenCodex 报告 · 0.163」', 'by: 你说的');
  const mine = checkMemoryFile('规则/a.md', user, info(user));
  assert.ok('entry' in mine && mine.entry.userOwned);
});

test('files left out of the index say why: a broken head, a missing name or description, over 100 KB, a secret, a wrong folder', () => {
  const reason = (path: string, text: string, size = Buffer.byteLength(text, 'utf8')) => {
    const checked = checkMemoryFile(path, text, { size, mtime: 0 });
    return 'flagged' in checked ? checked.flagged.reason : undefined;
  };
  assert.equal(reason('规则/a.md', '没有开头的文件'), '开头格式不对');
  assert.equal(reason('规则/a.md', '---\nname: a\n'), '开头格式不对');
  assert.equal(reason('规则/a.md', '---\ndescription: 一句话\n---\n'), '开头缺 name');
  assert.equal(reason('规则/a.md', '---\nname: a\n---\n'), '开头缺 description');
  assert.equal(reason('规则/a.md', FILE, FILE_MAX + 1), '超过 100 KB');
  assert.equal(reason('规则/a.md', `${FILE}\n\nkey: sk-abcdefghijklmnopqrstuvwxyz012345`), '内容像密钥');
  assert.equal(reason('MEMORY.md', FILE), '不在类别目录里');
  assert.equal(reason('规则/a.md', FILE), undefined);
});

test('over 4 KB and a description over 150 characters are soft warnings; the file stays in the index', () => {
  const long = FILE.replace(/description: .*/, `description: ${'长'.repeat(151)}`) + `\n${'x'.repeat(4 * 1024)}`;
  const checked = checkMemoryFile('坑/a.md', long, info(long));
  assert.ok('entry' in checked);
  assert.deepEqual(checked.entry.warnings, ['超过 4 KB', '描述超过 150 字']);
  assert.equal([...clipDescription('长'.repeat(151))].length, 150);
  assert.ok(clipDescription('长'.repeat(151)).endsWith('…'));
});

test('secrets: private keys, common key and token prefixes, JWTs and key = long-random lines; ordinary words are not', () => {
  for (const text of [
    '-----BEGIN OPENSSH PRIVATE KEY-----\nabc', '-----BEGIN RSA PRIVATE KEY-----', 'OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_11ABCDEFG0123456789_abcdef', 'glpat-abcdefghij0123456789',
    'AKIAIOSFODNN7EXAMPLE', 'xoxb-123456789012-abcdefghij', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'hf_abcdefghijklmnopqrstuvwxyz012345',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'password: Xk29fjQ8vLm3Rt7wNz5p',
  ]) assert.equal(looksSecret(text), true, text);
  for (const text of [
    'key 存在 macOS 钥匙串里，用 security 读', 'risk-assessment-framework-document-v2', 'task-0123456789abcdefghij', 'token: <your token>',
    'password: 问管理员要', 'sk- 开头的是旧 key', '用 user_sk 登录网关',
  ]) assert.equal(looksSecret(text), false, text);
});

test('verified reads as checked unless it is empty or says no', () => {
  for (const value of ['是，两次都照做了', '核实过：跑了 npm test', 'yes']) assert.equal(isVerified(value), true, value);
  for (const value of ['', '  ', '没核实', '否', '未核实', '待确认', 'no', 'false', 'unverified']) assert.equal(isVerified(value), false, value);
});

test('a written file reads back the same, with values quoted where they would not', () => {
  const text = renderMemoryFile({
    name: '装完要重启', description: '- 装进 profile 后: 要重启桌面端', by: '你说的', sources: ['s-1', 's-2'], verified: '没核实', updated: '2026-11-12', body: '\n装进去以后重启。\n',
  });
  const parsed = parseFrontmatter(text)!;
  assert.equal(parsed.fields.name, '装完要重启');
  assert.equal(parsed.fields.description, '- 装进 profile 后: 要重启桌面端');
  assert.equal(parsed.fields.by, '你说的');
  assert.deepEqual(parsed.sources, ['s-1', 's-2']);
  assert.equal(parsed.body, '装进去以后重启。\n');
  assert.ok(text.endsWith('\n'));
});

test('setFields replaces a field and what continued it, or adds it before the closing line', () => {
  const text = '---\nname: a\nby: 会话\n  「X」\ndescription: d\n---\nbody';
  assert.equal(setFields(text, { by: '补记', updated: '2026-11-12' }), '---\nname: a\nby: 补记\ndescription: d\nupdated: 2026-11-12\n---\nbody');
  assert.equal(setFields('no head', { by: '补记' }), undefined);
});

test('a new file\'s name is the first sentence, cut short, without characters a file name cannot hold; a taken path gets a number', () => {
  assert.equal(shortName('发布前先在开发 profile 里装一遍。装完再发。'), '发布前先在开发 profile 里装一遍');
  assert.equal(shortName('a/b: c?'), 'a b c');
  assert.equal(shortName('。。。'), '记忆');
  assert.equal([...shortName('长'.repeat(40))].length, 20);
  assert.equal(shortName('报告会话的回复是空的时，要去看 report.md 第二节'), '报告会话的回复是空的时');
  // A comma too near the start would leave too short a name: the cut stays at 20.
  assert.equal(shortName('甲，乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地'), '甲，乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申');
  // Quotes, brackets and backticks go; a cut inside a Latin word drops that word's piece.
  assert.equal(shortName('DSH 重启后已用 `cordis_inspect_query` 确认'), 'DSH 重启后已用');
  assert.equal(shortName('Atlas 更新的差距报告写到当前目录的 report.md，写完回复'), 'Atlas 更新的差距报告写到当前目录的');
  assert.equal(shortName('Atlas 候选“Import setup and recent work”只记录了报告'), 'Atlas 候选 Import');
  assert.equal(freePath('规则', '发布', []), '规则/发布.md');
  assert.equal(freePath('规则', '发布', ['规则/发布.md', '规则/发布 2.md']), '规则/发布 3.md');
  assert.equal(freePath('规则', 'Report', ['规则/report.md']), '规则/Report 2.md');
  assert.equal(freePath('规则', 'INDEX', []), '规则/INDEX 2.md');
});
