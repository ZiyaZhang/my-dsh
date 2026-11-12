import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtifactStore, artifactRows, recordFiles, type ArtifactFile } from '../src/host/artifacts.ts';

const T = 1_700_000_000_000;

test('recorded files keep the newest time; a created file stays created, a deleted one goes', () => {
  const files = recordFiles([], [
    { path: '/w/a.md', kind: 'created', at: T },
    { path: '/w/b.md', kind: 'modified', at: T + 1 },
    { path: '/w/a.md', kind: 'modified', at: T + 2 },
    { path: '/w/c.md', kind: 'created', at: T + 3 },
    { path: '/w/c.md', kind: 'deleted', at: T + 4 },
  ]);
  assert.deepEqual(files, [{ path: '/w/a.md', at: T + 2, kind: 'created' }, { path: '/w/b.md', at: T + 1, kind: 'modified' }]);
});

const file = (path: string, at: number, kind: ArtifactFile['kind'] = 'created'): ArtifactFile => ({ path, at, kind });

test('new files under one new folder fold into one row with their count, newest first; single files and changed files stay rows', () => {
  const rows = artifactRows([
    {
      sessionId: 's-impl', cwd: '/w',
      files: [
        file('/w/dsh-tool-list-worktrees/package.json', T + 1), file('/w/dsh-tool-list-worktrees/README.md', T + 2),
        file('/w/dsh-tool-list-worktrees/src/index.ts', T + 3), file('/w/dsh-tool-list-worktrees/src/tool.ts', T + 4),
        file('/w/dsh-tool-list-worktrees/tests/a.test.ts', T + 5), file('/w/dsh-tool-list-worktrees/tsconfig.json', T + 6),
      ],
    },
    { sessionId: 's-report', cwd: '/w', files: [file('/w/report.md', T + 10), file('/w/notes.md', T + 9)] },
    { sessionId: 's-fix', cwd: '/w', files: [file('/w/src/app.ts', T + 8, 'modified'), file('/w/src/new.ts', T + 7)] },
  ]);
  assert.deepEqual(rows.map(row => [row.label, row.folder, row.files, row.sessionId]), [
    ['report.md', false, 1, 's-report'],
    ['notes.md', false, 1, 's-report'],
    ['app.ts', false, 1, 's-fix'],
    ['new.ts', false, 1, 's-fix'],
    ['dsh-tool-list-worktrees/', true, 6, 's-impl'],
  ]);
  assert.equal(rows[4]!.path, '/w/dsh-tool-list-worktrees');
  assert.equal(rows[4]!.at, T + 6);
});

test('files right in the working folder never fold into it; outside the working folder, only files of one folder fold', () => {
  const rows = artifactRows([
    { sessionId: 's-1', cwd: '/w', files: [file('/w/a.md', T + 1), file('/w/b.md', T + 2)] },
    { sessionId: 's-2', cwd: '/w', files: [file('/tmp/out/x.csv', T + 3), file('/tmp/out/y.csv', T + 4), file('/tmp/other/z.csv', T + 5)] },
  ]);
  assert.deepEqual(rows.map(row => row.label), ['z.csv', 'out/', 'b.md', 'a.md']);
  assert.equal(rows.find(row => row.label === 'out/')!.files, 2);
});

test('the same path written by two sessions is one row, for the newest; rows are capped', () => {
  const rows = artifactRows([
    { sessionId: 's-1', cwd: '/w', files: [file('/w/r.md', T + 1, 'modified')] },
    { sessionId: 's-2', cwd: '/w', files: [file('/w/r.md', T + 2, 'modified')] },
  ]);
  assert.deepEqual(rows.map(row => [row.label, row.sessionId]), [['r.md', 's-2']]);
  const many = artifactRows([{ sessionId: 's', cwd: '/w', files: Array.from({ length: 30 }, (_, n) => file(`/w/f${n}.md`, T + n)) }], 20);
  assert.equal(many.length, 20);
  assert.equal(many[0]!.label, 'f29.md');
});

test('artifacts.json keeps each session\'s files, folder and history cursor; the cursor only moves forward', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  const store = new ArtifactStore(directory);
  await store.open();
  assert.deepEqual(store.of('s-1'), { cursor: -1, files: [] });
  await store.record('s-1', [{ path: '/w/a.md', kind: 'created', at: T }], { cursor: 40, cwd: '/w' });
  await store.record('s-1', [], { cursor: 12 });
  const again = new ArtifactStore(directory);
  await again.open();
  assert.deepEqual(again.of('s-1'), { cursor: 40, cwd: '/w', files: [{ path: '/w/a.md', at: T, kind: 'created' }] });
  assert.match(await readFile(join(directory, 'artifacts.json'), 'utf8'), /"version":1/);
});
