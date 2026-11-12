/**
 * Git facts for automatic grouping, read from the files under `.git` without running git: the repository a directory belongs to (its
 * common git directory, which the repository's worktrees share), the branch checked out, and the `origin` remote. A linked worktree's
 * `.git` is a file naming its own git directory, whose `commondir` names the repository's. A read is a few stat calls and small file
 * reads, and writes nothing. HEAD is the branch now, not the one a session worked on when it ran.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface GitFacts {
  /** The repository's common git directory, absolute, with links resolved where they can be. */
  commonDir: string;
  /** The branch checked out; absent while HEAD is detached. */
  branch?: string;
  /** The directory is a linked worktree (its `.git` is a file), whose branch stays with it; a main checkout switches under its sessions. */
  worktree: boolean;
  /** `host/owner/repo` of the `origin` remote, lower-case, when its URL names one. */
  remote?: string;
}

/** Branches every piece of work passes through, which say nothing about which work a session did. */
export const SHARED_BRANCHES: ReadonlySet<string> = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

/** Directories a read walks up at most, looking for `.git`. */
const DEPTH_MAX = 64;

/** The branch HEAD names (`ref: refs/heads/<branch>`); undefined for a detached HEAD or anything else. */
export function headBranch(text: string): string | undefined {
  const match = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(text.trim());
  return match?.[1];
}

/** The git directory a linked worktree's `.git` file names (`gitdir: <path>`), resolved against the worktree. */
export function gitdirOf(text: string, worktree: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return match ? resolve(worktree, match[1]!) : undefined;
}

/** The URL of the `origin` remote in a git config file. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    const url = inOrigin ? /^url\s*=\s*(\S+)$/i.exec(line) : null;
    if (url) return url[1];
  }
  return undefined;
}

/** `host/owner/repo`, lower-case, from a remote URL: `https://host/owner/repo`, `ssh://git@host:22/owner/repo`, `git@host:owner/repo`. */
export function remoteRepo(url: string): string | undefined {
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match || match[3] === '.' || match[3] === '..') return undefined;
  return `${match[1]}/${match[2]}/${match[3]}`.toLowerCase();
}

/** The key that groups sessions on one branch of one repository, with the branch's name; none for a shared branch or a detached HEAD. */
export function branchKey(facts: Pick<GitFacts, 'commonDir' | 'branch'>): { key: string; name: string } | undefined {
  if (!facts.branch || SHARED_BRANCHES.has(facts.branch.toLowerCase())) return undefined;
  return { key: `${facts.commonDir}\n${facts.branch}`, name: facts.branch };
}

/** The facts of the checkout whose `.git` is at `dotGit`; undefined when its files cannot be read. */
async function factsAt(top: string, dotGit: string, linked: boolean): Promise<GitFacts | undefined> {
  try {
    let gitDir = dotGit;
    let common = dotGit;
    if (linked) {
      const named = gitdirOf(await readFile(dotGit, 'utf8'), top);
      if (!named) return undefined;
      gitDir = named;
      const pointer = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
      common = pointer ? resolve(gitDir, pointer) : gitDir;
    }
    const head = await readFile(join(gitDir, 'HEAD'), 'utf8');
    const config = await readFile(join(common, 'config'), 'utf8').catch(() => '');
    const commonDir = await realpath(common).catch(() => common);
    const branch = headBranch(head);
    const url = originUrl(config);
    const remote = url ? remoteRepo(url) : undefined;
    return { commonDir, ...(branch ? { branch } : {}), worktree: linked, ...(remote ? { remote } : {}) };
  } catch {
    return undefined;
  }
}

/** The git facts of a directory, from the nearest `.git` at or above it; undefined outside a repository or when nothing can be read. */
export async function readGit(dir: string): Promise<GitFacts | undefined> {
  let current = resolve(dir);
  for (let depth = 0; depth < DEPTH_MAX; depth += 1) {
    const dotGit = join(current, '.git');
    const info = await stat(dotGit).catch(() => undefined);
    if (info) return factsAt(current, dotGit, info.isFile());
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}
