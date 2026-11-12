import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { branchKey, gitdirOf, headBranch, originUrl, readGit, remoteRepo } from '../src/host/grouping-git.ts';

test('HEAD names a branch, or nothing when detached', () => {
  assert.equal(headBranch('ref: refs/heads/feat/plugin-self-context\n'), 'feat/plugin-self-context');
  assert.equal(headBranch('4b825dc642cb6eb9a060e54bf8d69288fbee4904\n'), undefined);
  assert.equal(headBranch('ref: refs/remotes/origin/main'), undefined);
  assert.equal(gitdirOf('gitdir: ../.git/worktrees/alpha\n', '/repo/wt'), '/repo/.git/worktrees/alpha');
  assert.equal(gitdirOf('nothing', '/repo/wt'), undefined);
});

test('the origin remote reads as host/owner/repo from https, ssh and scp-style URLs; other remotes and paths do not', () => {
  const config = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/x/y.git\n[remote "origin"]\n\turl = git@github.com:Owner/Tool.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
  assert.equal(originUrl(config), 'git@github.com:Owner/Tool.git');
  assert.equal(originUrl('[remote "upstream"]\n\turl = https://github.com/x/y.git\n'), undefined);
  assert.equal(remoteRepo('git@github.com:Owner/Tool.git'), 'github.com/owner/tool');
  assert.equal(remoteRepo('https://github.com/deepseek-ai/deepseek-harness'), 'github.com/deepseek-ai/deepseek-harness');
  assert.equal(remoteRepo('ssh://git@ghe.example.com:2222/team/tool.git'), 'ghe.example.com/team/tool');
  assert.equal(remoteRepo('/srv/git/tool.git'), undefined);
  assert.equal(remoteRepo('https://gitlab.com/group/sub/proj.git'), undefined);
});

test('the branch key names the repository and the branch; a shared branch or a detached HEAD has none', () => {
  assert.deepEqual(branchKey({ commonDir: '/repo/.git', branch: 'feat/x' }), { key: '/repo/.git\nfeat/x', name: 'feat/x' });
  for (const branch of ['main', 'master', 'develop', 'dev', 'trunk', 'Main']) assert.equal(branchKey({ commonDir: '/repo/.git', branch }), undefined);
  assert.equal(branchKey({ commonDir: '/repo/.git' }), undefined);
});

test('a main checkout and its linked worktree read as one repository, each with its own branch, from any folder inside them', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'my-dsh-git-')));
  const repo = join(root, 'repo');
  await mkdir(join(repo, '.git', 'worktrees', 'alpha'), { recursive: true });
  await mkdir(join(repo, 'src', 'deep'), { recursive: true });
  await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/a/b.git\n');
  await writeFile(join(repo, '.git', 'worktrees', 'alpha', 'HEAD'), 'ref: refs/heads/feat/alpha\n');
  await writeFile(join(repo, '.git', 'worktrees', 'alpha', 'commondir'), '../..\n');
  const worktree = join(repo, '.agents', 'worktrees', 'feat', 'alpha');
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'alpha')}\n`);

  assert.deepEqual(await readGit(join(repo, 'src', 'deep')), { commonDir: join(repo, '.git'), branch: 'main', worktree: false, remote: 'github.com/a/b' });
  assert.deepEqual(await readGit(worktree), { commonDir: join(repo, '.git'), branch: 'feat/alpha', worktree: true, remote: 'github.com/a/b' });
  // Outside the repository nothing of it is found (a repository above the temporary folder, if any, is another one).
  await mkdir(join(root, 'plain'));
  for (const dir of [join(root, 'plain'), join(root, 'gone')]) assert.ok(!(await readGit(dir))?.commonDir.startsWith(root));
});
