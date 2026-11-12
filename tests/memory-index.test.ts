import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GENERATED_NOTE, buildIndex, indexLine, type IndexItem } from '../src/host/memory-index.ts';

const DAY = 86_400_000;
const T = Date.parse('2026-11-12');
const item = (path: string, extra: Partial<IndexItem> = {}): IndexItem => ({
  path, category: path.split('/')[0]!, name: path.split('/')[1]!.replace(/\.md$/, ''), description: `${path} 的描述`, userOwned: false,
  isVerified: true, mtime: T, ...extra,
});

test('the index is grouped by category in order, the user\'s entries first and then the newest; lines carry 你说的 or 没核实', () => {
  const index = buildIndex('OpenCodex 跟进', [
    item('坑/装完要重启.md', { description: '装进 profile 后要重启桌面端才生效', isVerified: false }),
    item('规则/差距报告格式.md', { description: '报告写到当前目录的 report.md，写完回复 REPORT_DONE', updated: T - DAY }),
    item('规则/按建议级别实现.md', { description: '按报告“建议”一节的级别做，独立 bundle，不改 DSH 核心', userOwned: true, updated: T - 5 * DAY, isVerified: false }),
    item('没做完/0.163重开.md', { description: '「功能开关注册表」的实现会话没有产出，要重开' }),
    item('定下的/worktree只读.md', { description: '只做只读的 list_worktrees，不做创建和管理' }),
    item('规则/更新的规则.md', { updated: T }),
  ]);
  assert.equal(index.text, [
    '# OpenCodex 跟进 · 记忆索引',
    GENERATED_NOTE,
    '',
    '## 规则 3',
    '- [按建议级别实现](规则/按建议级别实现.md) — 按报告“建议”一节的级别做，独立 bundle，不改 DSH 核心 · 你说的',
    '- [更新的规则](规则/更新的规则.md) — 规则/更新的规则.md 的描述',
    '- [差距报告格式](规则/差距报告格式.md) — 报告写到当前目录的 report.md，写完回复 REPORT_DONE',
    '',
    '## 定下的 1',
    '- [worktree只读](定下的/worktree只读.md) — 只做只读的 list_worktrees，不做创建和管理',
    '',
    '## 坑 1',
    '- [装完要重启](坑/装完要重启.md) — 装进 profile 后要重启桌面端才生效 · 没核实',
    '',
    '## 没做完 1',
    '- [0.163重开](没做完/0.163重开.md) — 「功能开关注册表」的实现会话没有产出，要重开',
    '',
  ].join('\n'));
  assert.deepEqual(index.order.map(entry => entry.path), [
    '规则/按建议级别实现.md', '规则/更新的规则.md', '规则/差距报告格式.md', '定下的/worktree只读.md', '坑/装完要重启.md', '没做完/0.163重开.md',
  ]);
  assert.deepEqual(index.folded, {});
  assert.deepEqual(index.categoryIndexes, {});
  assert.equal(index.nearCap, false);
});

test('without updated the file\'s mtime orders it; names and paths that would break the link are escaped', () => {
  const index = buildIndex('x', [item('坑/旧.md', { mtime: T - DAY }), item('坑/新.md', { mtime: T })]);
  assert.deepEqual(index.order.map(entry => entry.path), ['坑/新.md', '坑/旧.md']);
  assert.equal(indexLine(item('规则/a b.md', { name: 'a [b]' })), '- [a \\[b\\]](<规则/a b.md>) — 规则/a b.md 的描述');
  assert.match(indexLine(item('规则/a.md', { description: `${'长'.repeat(160)}\n第二行` })), /— 长{149}…$/);
});

test('an empty memory says so under the title', () => {
  assert.equal(buildIndex('看板', []).text, `# 看板 · 记忆索引\n${GENERATED_NOTE}\n\n还没有记忆。\n`);
});

test('over 200 lines the largest category folds first, keeping its first entries and pointing at its own INDEX.md, which lists all', () => {
  const rules = Array.from({ length: 150 }, (_, n) => item(`规则/r${String(n).padStart(3, '0')}.md`, { updated: T - n * 1000 }));
  const traps = Array.from({ length: 60 }, (_, n) => item(`坑/t${String(n).padStart(3, '0')}.md`, { updated: T - n * 1000 }));
  const index = buildIndex('大事项', [...rules, ...traps]);
  const lines = index.text.trimEnd().split('\n');
  assert.ok(lines.length <= 200, String(lines.length));
  assert.equal(index.lines, 2 + 2 + 150 + 2 + 60);
  assert.equal(index.nearCap, true);
  // 规则 folds alone: it is the largest until the index fits.
  assert.equal(index.folded['规则'], 150 - (200 - 2 - 2 - 1 - 2 - 60));
  assert.equal(index.folded['坑'], undefined);
  assert.ok(lines.includes(`- 还有 ${index.folded['规则']} 条，见 规则/INDEX.md`));
  assert.ok(lines.includes('## 规则 150'));
  // The newest stay; the oldest go to INDEX.md only.
  assert.ok(index.text.includes('(规则/r000.md)'));
  assert.ok(!index.text.includes('(规则/r149.md)'));
  const full = index.categoryIndexes['规则']!.split('\n');
  assert.equal(full[0], '# 大事项 · 规则 · 全部 150 条');
  assert.equal(full[1], GENERATED_NOTE);
  assert.equal(full.filter(line => line.startsWith('- [')).length, 150);
  assert.ok(full.includes('- [r149](r149.md) — 规则/r149.md 的描述'));
  assert.equal(index.order.length, 210);
});

test('when the largest group is folded down to the next, they fold in turn', () => {
  const rules = Array.from({ length: 120 }, (_, n) => item(`规则/r${n}.md`, { updated: T - n }));
  const traps = Array.from({ length: 110 }, (_, n) => item(`坑/t${n}.md`, { updated: T - n }));
  const index = buildIndex('x', [...rules, ...traps]);
  assert.ok(index.text.trimEnd().split('\n').length <= 200);
  assert.ok(index.folded['规则']! > 0 && index.folded['坑']! > 0);
  assert.ok(Math.abs((120 - index.folded['规则']!) - (110 - index.folded['坑']!)) <= 1);
});

test('over 16 KB the index folds by bytes too, though it has few lines', () => {
  const long = (n: number) => item(`规则/r${n}.md`, { description: '很长的描述'.repeat(28), updated: T - n });
  const index = buildIndex('x', Array.from({ length: 60 }, (_, n) => long(n)));
  assert.ok(index.lines < 200);
  assert.ok(index.bytes > 16 * 1024);
  assert.ok(Buffer.byteLength(index.text, 'utf8') <= 16 * 1024);
  assert.ok(index.folded['规则']! > 0);
  assert.equal(index.nearCap, true);
});

test('near the cap is 80% of either: lines or bytes', () => {
  const few = (count: number) => Array.from({ length: count }, (_, n) => item(`规则/r${n}.md`, { updated: T - n }));
  assert.equal(buildIndex('x', few(150)).nearCap, false);
  assert.equal(buildIndex('x', few(156)).nearCap, true);
  const wide = Array.from({ length: 40 }, (_, n) => item(`规则/r${n}.md`, { description: '描述'.repeat(55), updated: T - n }));
  const index = buildIndex('x', wide);
  assert.ok(index.lines < 160 && index.bytes >= 0.8 * 16 * 1024);
  assert.equal(index.nearCap, true);
});
