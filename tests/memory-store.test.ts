import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { contentHash, parseFrontmatter } from '../src/host/memory-files.ts';
import { DiffStore, MemoryStore, excludeFromGit, type MemoryChange } from '../src/host/memory-store.ts';
import type { NoteView } from '../src/host/remote.ts';

const AT = '2026-11-10T08:00:00.000Z';
const FILE = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} 的一句话\nsources: [s-1]\nverified: 没核实\nupdated: 2026-11-11\n${extra}---\n正文\n`;
const exists = (path: string) => stat(path).then(() => true, () => false);

/** A store over a data directory, closed when the test ends however it ends, so no watch keeps the run alive. */
function harness(t: TestContext, directory: string) {
  const observed: { matterId: string; changes: MemoryChange[] }[] = [];
  const warnings: string[] = [];
  const store = new MemoryStore(directory, {
    observed: (matterId, changes) => { observed.push({ matterId, changes }); },
    scanned: () => {},
    warn: (text) => { warnings.push(text); },
    dateOf: ms => new Date(ms).toISOString().slice(0, 10),
  });
  t.after(() => { store.close(); });
  return { store, observed, warnings };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'my-dsh-memory-'));
  const data = join(root, 'data');
  const workspace = join(root, 'repo');
  await mkdir(workspace, { recursive: true });
  return { root, data, workspace };
}

let git = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }

test('a matter\'s memory folder goes in its main workspace with its category folders and index; a new .my-dsh goes into the repo\'s exclude', async (t) => {
  const { data, workspace } = await setup();
  if (git) execFileSync('git', ['init', '-q'], { cwd: workspace });
  const { store } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: 'OpenCodex 跟进', workspace }], () => []);
  const dir = join(workspace, '.my-dsh', 'm-1', 'memory');
  assert.equal(store.dirOf('m-1'), dir);
  assert.deepEqual((await readdir(dir)).sort(), ['MEMORY.md', '坑', '定下的', '没做完', '答过的', '规则'].sort());
  assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /^# OpenCodex 跟进 · 记忆索引\n<!-- my dsh 按各文件开头生成，改记忆请改那些文件 -->\n\n还没有记忆。\n$/);
  if (git) {
    assert.match(await readFile(join(workspace, '.git', 'info', 'exclude'), 'utf8'), /\n\.my-dsh\/\n$/);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }), '');
  }
  store.close();
});

test('the exclude line goes in once, after the file\'s last line, and nowhere outside a repository', async (t) => {
  const { root } = await setup();
  const exclude = join(root, 'info', 'exclude');
  await mkdir(join(root, 'info'), { recursive: true });
  await writeFile(exclude, '# git ls-files --others --exclude-from=.git/info/exclude\n*.log');
  const run = async () => exclude;
  assert.equal(await excludeFromGit(root, run), true);
  assert.equal(await excludeFromGit(root, run), true);
  assert.equal(await readFile(exclude, 'utf8'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n.my-dsh/\n');
  assert.equal(await excludeFromGit(root, async () => { throw new Error('fatal: not a git repository'); }), false);
});

test('without a main workspace the memory is in the data directory; when the matter gets one, the folder moves there', async (t) => {
  const { data, workspace } = await setup();
  const { store, observed } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: '看板' }], () => []);
  const before = join(data, 'matters', 'm-1', 'memory');
  assert.equal(store.dirOf('m-1'), before);
  await writeFile(join(before, '规则', '图用真实样式.md'), FILE('图用真实样式'));
  await store.rescan('m-1');
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  const after = join(workspace, '.my-dsh', 'm-1', 'memory');
  assert.equal(store.dirOf('m-1'), after);
  assert.equal(await readFile(join(after, '规则', '图用真实样式.md'), 'utf8'), FILE('图用真实样式'));
  assert.equal(await exists(before), false);
  assert.deepEqual(store.scanOf('m-1')!.entries.map(entry => entry.path), ['规则/图用真实样式.md']);
  // Moving is not a change to the files.
  assert.equal(observed.flatMap(item => item.changes).filter(change => change.change !== 'add').length, 0);
  // And back out of the workspace: the emptied .my-dsh folder goes with it.
  await store.sync([{ matterId: 'm-1', name: '看板' }], () => []);
  assert.equal(await exists(join(workspace, '.my-dsh')), false);
  store.close();
  const reopened = harness(t, data).store;
  await reopened.open();
  assert.equal(reopened.dirOf('m-1'), before);
  reopened.close();
});

const note = (id: string, kind: NoteView['kind'], text: string, by: NoteView['by']): NoteView => ({ id, kind, text, sources: ['s-1'], by, updatedAt: AT });

test('notes.json\'s lines become files once, one per line in its category, the user\'s as 你说的', async (t) => {
  const { data, workspace } = await setup();
  const { store, observed } = harness(t, data);
  await store.open();
  const notes = [
    note('n-1', 'rule', '发布前先在开发 profile 里装一遍。装完再发。', 'user'),
    note('n-2', 'trap', '报告会话的回复是空的时，要去看 report.md', 'dream'),
    note('n-3', 'trap', '报告会话的回复是空的时，要去看 report.md 第二节', 'dream'),
  ];
  await store.sync([{ matterId: 'm-1', name: 'OpenCodex 跟进', workspace }], () => notes);
  const scan = store.scanOf('m-1')!;
  assert.deepEqual(scan.entries.map(entry => entry.path).sort(), ['坑/报告会话的回复是空的时 2.md', '坑/报告会话的回复是空的时.md', '规则/发布前先在开发 profile 里装一遍.md'].sort());
  const mine = parseFrontmatter(scan.texts.get('规则/发布前先在开发 profile 里装一遍.md')!)!;
  assert.equal(mine.fields.by, '你说的');
  assert.equal(mine.fields.verified, '用户说的');
  assert.equal(mine.fields.updated, '2026-11-10');
  assert.deepEqual(mine.sources, ['s-1']);
  assert.equal(mine.body.trim(), '发布前先在开发 profile 里装一遍。装完再发。');
  const learned = parseFrontmatter(scan.texts.get('坑/报告会话的回复是空的时.md')!)!;
  assert.equal(learned.fields.by, '合并');
  assert.equal(learned.fields.verified, '没核实');
  assert.match(scan.index.text, /- \[发布前先在开发 profile 里装一遍。装完再发。\]\(<规则\/发布前先在开发 profile 里装一遍\.md>\) · 你说的/);
  // Moving the notes in is not a change anyone made; a second start does not move them again.
  assert.deepEqual(observed, []);
  store.close();
  const again = harness(t, data);
  await again.store.open();
  await again.store.sync([{ matterId: 'm-1', name: 'OpenCodex 跟进', workspace }], () => notes);
  assert.equal(again.store.scanOf('m-1')!.entries.length, 3);
  again.store.close();
});

test('changes on disk are reported with the text before and after, the copy is kept across restarts, and MEMORY.md is rebuilt from the files', async (t) => {
  const { data, workspace } = await setup();
  const { store, observed } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  const dir = store.dirOf('m-1')!;
  await writeFile(join(dir, '坑', '装完要重启.md'), FILE('装完要重启'));
  await store.rescan('m-1');
  assert.deepEqual(observed.at(-1)!.changes, [{ path: '坑/装完要重启.md', change: 'add', before: null, after: FILE('装完要重启') }]);
  assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /## 坑 1\n- \[装完要重启 的一句话\]\(坑\/装完要重启\.md\) · 没核实\n$/);
  // Someone edits MEMORY.md: it is written again from the files, and that is no change to the memory.
  await writeFile(join(dir, 'MEMORY.md'), '我自己写的索引');
  const reported = observed.length;
  await store.rescan('m-1');
  assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /^# 看板 · 记忆索引/);
  assert.equal(observed.length, reported);
  store.close();
  // After a restart the copies remain: an edit made while the Host was down shows as an update.
  const later = harness(t, data);
  await later.store.open();
  await writeFile(join(dir, '坑', '装完要重启.md'), FILE('装完要重启', 'by: 你说的\n'));
  await later.store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  assert.deepEqual(later.observed.map(item => item.changes.map(change => [change.path, change.change])), [[['坑/装完要重启.md', 'update']]]);
  await rm(join(dir, '坑', '装完要重启.md'));
  await later.store.rescan('m-1');
  assert.deepEqual(later.observed.at(-1)!.changes.map(change => [change.path, change.change, change.after]), [['坑/装完要重启.md', 'delete', null]]);
  later.store.close();
});

test('files left out of the index are flagged with why; a big one keeps its copy until it can be read', async (t) => {
  const { data, workspace } = await setup();
  const { store, observed } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  const dir = store.dirOf('m-1')!;
  await writeFile(join(dir, '规则', '好的.md'), FILE('好的'));
  await writeFile(join(dir, '规则', '坏的.md'), '没有开头');
  await writeFile(join(dir, '坑', '密钥.md'), FILE('密钥', 'note: sk-abcdefghijklmnopqrstuvwxyz0123\n'));
  await writeFile(join(dir, '放错了.md'), FILE('放错了'));
  await writeFile(join(dir, '答过的', '.草稿.md'), '隐藏的');
  await writeFile(join(dir, '答过的', 'notes.txt'), '不是 md');
  await store.rescan('m-1');
  const scan = store.scanOf('m-1')!;
  assert.deepEqual(scan.entries.map(entry => entry.path), ['规则/好的.md']);
  assert.deepEqual(scan.flagged.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: '坑/密钥.md', reason: '内容像密钥' }, { path: '放错了.md', reason: '不在类别目录里' }, { path: '规则/坏的.md', reason: '开头格式不对' },
  ].sort((a, b) => a.path.localeCompare(b.path)));
  assert.doesNotMatch(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /密钥|坏的/);
  await writeFile(join(dir, '规则', '好的.md'), FILE('好的') + 'x'.repeat(101 * 1024));
  const before = observed.length;
  await store.rescan('m-1');
  assert.deepEqual(store.scanOf('m-1')!.flagged.find(file => file.path === '规则/好的.md'), { path: '规则/好的.md', reason: '超过 100 KB' });
  assert.equal(observed.length, before);
  store.close();
});

test('the Host\'s own writes are checked against the file as it is: an add needs the path free, an update or delete the hash the pass saw', async (t) => {
  const { data, workspace } = await setup();
  const { store, observed } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  const dir = store.dirOf('m-1')!;
  await writeFile(join(dir, '坑', 'a.md'), FILE('a'));
  await store.rescan('m-1');
  const seen = contentHash(FILE('a'));
  // A session changed the file after the pass read it.
  await writeFile(join(dir, '坑', 'a.md'), FILE('a', 'by: 会话「X」\n'));
  const first = await store.apply('m-1', [
    { op: 'add', path: '坑/a.md', content: FILE('a2') },
    { op: 'update', path: '坑/a.md', content: FILE('a3'), expect: seen },
    { op: 'add', path: '规则/新的.md', content: FILE('新的') },
  ]);
  assert.deepEqual(first.skipped.map(op => [op.op, op.reason]), [['add', '这个路径已经有文件了'], ['update', '文件在读过之后又被改了']]);
  assert.deepEqual(first.applied.map(change => [change.path, change.change, change.before]), [['规则/新的.md', 'add', null]]);
  assert.equal(await readFile(join(dir, '规则', '新的.md'), 'utf8'), FILE('新的'));
  // The store's own write is not reported again; the session's change it found in passing is.
  assert.deepEqual(observed.at(-1)!.changes.map(change => [change.path, change.change]), [['坑/a.md', 'update']]);
  const current = contentHash(FILE('a', 'by: 会话「X」\n'));
  const second = await store.apply('m-1', [{ op: 'delete', path: '坑/a.md', expect: current }, { op: 'update', path: '规则/新的.md', content: FILE('改过的'), expect: contentHash(FILE('新的')) }]);
  assert.deepEqual(second.applied.map(change => [change.path, change.change]), [['坑/a.md', 'delete'], ['规则/新的.md', 'update']]);
  assert.equal(await exists(join(dir, '坑', 'a.md')), false);
  const reported = observed.length;
  await store.rescan('m-1');
  assert.equal(observed.length, reported);
  assert.deepEqual(store.scanOf('m-1')!.entries.map(entry => entry.path), ['规则/新的.md']);
  assert.equal(await store.read('m-1', '规则/新的.md'), FILE('改过的'));
  assert.equal(await store.read('m-1', '../../../etc/passwd'), undefined);
  // No temporary files are left behind.
  assert.deepEqual((await readdir(join(dir, '规则'))).filter(name => name.startsWith('.')), []);
  store.close();
});

test('a change in a watched folder is read again about a second later', async (t) => {
  const { data, workspace } = await setup();
  const { store, observed } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  await writeFile(join(store.dirOf('m-1')!, '没做完', '重开.md'), FILE('重开'));
  for (let waited = 0; observed.length === 0 && waited < 8_000; waited += 100) await new Promise(done => setTimeout(done, 100));
  store.close();
  assert.deepEqual(observed.flatMap(item => item.changes.map(change => [change.path, change.change])), [['没做完/重开.md', 'add']]);
});

test('cursors, merge times and passes are kept in memory-state.json', async (t) => {
  const { data, workspace } = await setup();
  const { store } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  assert.equal(store.cursor('s-1'), undefined);
  assert.equal(store.mergedAt('m-1'), undefined);
  const base = store.base('m-1');
  await store.setCursors({ 's-1': 12, 's-2': 40 });
  await store.recordPass('m-1', { kind: 'capture', at: AT, applied: [{ op: 'add', path: '坑/a.md' }], skipped: [{ op: 'update', path: '规则/b.md', reason: '没看过这个文件的全文' }] });
  await store.recordPass('m-1', { kind: 'merge', at: '2026-11-11T08:00:00.000Z', applied: [], skipped: [] });
  store.close();
  const again = harness(t, data).store;
  await again.open();
  assert.equal(again.cursor('s-2'), 40);
  assert.equal(again.mergedAt('m-1'), Date.parse('2026-11-11T08:00:00.000Z'));
  assert.equal(again.base('m-1'), base);
  assert.deepEqual(again.passes('m-1').map(pass => [pass.kind, pass.skipped.length]), [['capture', 1], ['merge', 0]]);
  again.close();
});

test('a memory change\'s diff is kept in its own file, read by the entry\'s id, and dropped once the entry is gone', async (t) => {
  const { data } = await setup();
  const diffs = new DiffStore(data);
  await diffs.write('a-1', '--- a/x\n+++ b/x');
  await diffs.write('a-2', '--- a/y\n+++ b/y');
  assert.equal(await diffs.read('a-1'), '--- a/x\n+++ b/x');
  assert.equal(await diffs.read('../a-1'), undefined);
  await diffs.prune(new Set(['a-2']));
  assert.equal(await diffs.read('a-1'), undefined);
  assert.equal(await diffs.read('a-2'), '--- a/y\n+++ b/y');
});

test('a memory folder someone removed comes back on the next read, with its files reported as deleted', async (t) => {
  const { data, workspace } = await setup();
  const { store, observed } = harness(t, data);
  await store.open();
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  const dir = store.dirOf('m-1')!;
  await writeFile(join(dir, '坑', 'a.md'), FILE('a'));
  await store.rescan('m-1');
  await rm(join(workspace, '.my-dsh'), { recursive: true, force: true });
  await store.rescan('m-1');
  assert.deepEqual(observed.at(-1)!.changes.map(change => [change.path, change.change]), [['坑/a.md', 'delete']]);
  assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /还没有记忆。/);
  assert.equal(await exists(join(dir, '规则')), true);
  await store.sync([{ matterId: 'm-1', name: '看板', workspace }], () => []);
  assert.equal(await exists(join(dir, 'MEMORY.md')), true);
});
