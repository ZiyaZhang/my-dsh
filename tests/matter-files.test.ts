import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestError, type UploadSource } from '../src/host/remote.ts';
import { checkPath, copyUpload, resolveSources, type ReadUpload } from '../src/host/matter-files.ts';

async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'my-dsh-'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'plan.md'), '# 计划\n');
  return root;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const reader = (files: Record<string, string>): ReadUpload => async function* (upload) {
  const body = files[upload.attachmentId];
  if (body === undefined) throw new Error('missing attachment');
  yield bytes(body.slice(0, 2));
  yield bytes(body.slice(2));
};
const upload = (attachmentId: string, name: string): UploadSource => ({ kind: 'upload', attachmentId, name, bytes: 0 });

test('a path that exists is a folder or a file; anything else is refused', async () => {
  const root = await folder();
  assert.deepEqual(await checkPath(join(root, 'docs')), { kind: 'folder', value: join(root, 'docs'), title: 'docs' });
  assert.deepEqual(await checkPath(join(root, 'docs', 'plan.md')), { kind: 'file', value: join(root, 'docs', 'plan.md'), title: 'plan.md' });
  await assert.rejects(checkPath(join(root, 'missing')), (error: unknown) => error instanceof RequestError && /路径不存在/.test(error.message));
  await assert.rejects(checkPath('docs'), (error: unknown) => error instanceof RequestError && /要写完整路径/.test(error.message));
  assert.equal((await checkPath('~')).kind, 'folder');
});

test('an upload is copied into the matter’s files folder under its own name, without overwriting', async () => {
  const root = await folder();
  const into = join(root, 'matters', 'm-1', 'files');
  const read = reader({ 'att-1': '第一份', 'att-2': '第二份' });
  const first = await copyUpload(read, upload('att-1', 'notes.md'), into);
  assert.deepEqual(first, { kind: 'file', value: join(into, 'notes.md'), title: 'notes.md' });
  assert.equal(await readFile(join(into, 'notes.md'), 'utf8'), '第一份');
  const second = await copyUpload(read, upload('att-2', 'notes.md'), into);
  assert.deepEqual(second, { kind: 'file', value: join(into, 'notes 2.md'), title: 'notes 2.md' });
  assert.equal(await readFile(join(into, 'notes 2.md'), 'utf8'), '第二份');
  // A name cannot climb out of the folder.
  const sneaky = await copyUpload(read, upload('att-1', '../../escape.md'), into);
  assert.equal(sneaky.value, join(into, 'escape.md'));
});

test('resolveSources checks paths, reads links and copies uploads, once each', async () => {
  const root = await folder();
  const into = join(root, 'matters', 'm-1', 'files');
  const sources = await resolveSources([
    { kind: 'folder', value: join(root, 'docs') },
    { kind: 'file', value: join(root, 'docs', 'plan.md'), title: 'whatever' },
    { kind: 'link', value: 'https://github.com/o/r/pull/9' },
    { kind: 'doc', value: 'https://example.com/' },
    upload('att-1', 'notes.md'),
    { kind: 'folder', value: join(root, 'docs') },
  ], { read: reader({ 'att-1': '内容' }), files: into });
  assert.deepEqual(sources, [
    { kind: 'folder', value: join(root, 'docs'), title: 'docs' },
    { kind: 'file', value: join(root, 'docs', 'plan.md'), title: 'plan.md' },
    { kind: 'pr', value: 'https://github.com/o/r/pull/9', title: 'o/r#9' },
    { kind: 'link', value: 'https://example.com/' },
    { kind: 'file', value: join(into, 'notes.md'), title: 'notes.md' },
  ]);
  await assert.rejects(resolveSources([{ kind: 'folder', value: join(root, 'gone') }], { read: reader({}), files: into }), /路径不存在/);
  await assert.rejects(resolveSources([upload('att-9', 'x.md')], { read: undefined, files: into }), /这里收不了上传的文件/);
});
