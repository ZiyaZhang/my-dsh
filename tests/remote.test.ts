import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestError, parseRequest } from '../src/host/remote.ts';

const rejects = (value: unknown, message?: RegExp) => assert.throws(() => parseRequest(value), (error: unknown) => {
  assert.ok(error instanceof RequestError, `expected a RequestError, got ${String(error)}`);
  if (message) assert.match(error.message, message);
  return true;
});

test('parseRequest takes each action with exactly its fields and returns a trimmed copy', () => {
  assert.deepEqual(parseRequest({ action: 'snapshot' }), { action: 'snapshot' });
  assert.deepEqual(parseRequest({ action: 'createMatter', name: '  每周简报 ', goal: ' 每周五发一期 ' }),
    { action: 'createMatter', name: '每周简报', goal: '每周五发一期' });
  assert.deepEqual(parseRequest({ action: 'createMatter', name: '发布说明', goal: '' }), { action: 'createMatter', name: '发布说明', goal: '' });
  assert.deepEqual(parseRequest({ action: 'renameMatter', id: 'm-1', name: ' 发布说明 ' }), { action: 'renameMatter', id: 'm-1', name: '发布说明' });
  assert.deepEqual(parseRequest({ action: 'setGoal', id: 'm-1', goal: '周五前发出' }), { action: 'setGoal', id: 'm-1', goal: '周五前发出' });
  assert.deepEqual(parseRequest({ action: 'archiveMatter', id: 'm-1' }), { action: 'archiveMatter', id: 'm-1' });
  assert.deepEqual(parseRequest({ action: 'unarchiveMatter', id: 'm-1' }), { action: 'unarchiveMatter', id: 'm-1' });
  assert.deepEqual(parseRequest({ action: 'addSession', matterId: 'm-1', sessionId: 's-1' }), { action: 'addSession', matterId: 'm-1', sessionId: 's-1' });
  assert.deepEqual(parseRequest({ action: 'removeSession', sessionId: 's-1' }), { action: 'removeSession', sessionId: 's-1' });
});

test('parseRequest refuses anything that is not a plain object with a known action', () => {
  rejects(null, /JSON 对象/);
  rejects([], /JSON 对象/);
  rejects('snapshot', /JSON 对象/);
  rejects(new (class Request { action = 'snapshot'; })(), /JSON 对象/);
  rejects({}, /没有这个操作/);
  rejects({ action: 'drop' }, /没有这个操作/);
  rejects({ action: 'toString' }, /没有这个操作/);
});

test('parseRequest refuses extra and missing fields', () => {
  rejects({ action: 'snapshot', extra: 1 }, /snapshot 不接受这些字段：extra/);
  rejects({ action: 'createMatter', name: '每周简报', goal: '', sessionId: 's-1' }, /不接受这些字段：sessionId/);
  rejects({ action: 'createMatter', name: '每周简报' }, /createMatter 缺少字段：goal/);
  rejects({ action: 'renameMatter', name: '每周简报' }, /缺少字段：id/);
  rejects({ action: 'addSession', sessionId: 's-1' }, /缺少字段：matterId/);
  rejects({ action: 'removeSession' }, /缺少字段：sessionId/);
});

test('parseRequest refuses fields of the wrong type', () => {
  rejects({ action: 'createMatter', name: 7, goal: '' }, /name 必须是文字/);
  rejects({ action: 'setGoal', id: 'm-1', goal: null }, /goal 必须是文字/);
  rejects({ action: 'archiveMatter', id: 42 }, /id 必须是文字/);
});

test('names are 1 to 40 characters after trimming, goals at most 120, both on one line', () => {
  rejects({ action: 'createMatter', name: '', goal: '' }, /名字不能为空/);
  rejects({ action: 'createMatter', name: '   ', goal: '' }, /名字不能为空/);
  assert.equal((parseRequest({ action: 'createMatter', name: '简'.repeat(40), goal: '' }) as { name: string }).name.length, 40);
  rejects({ action: 'createMatter', name: '简'.repeat(41), goal: '' }, /名字最多 40 个字/);
  // Counted in characters as people see them, so an emoji is one, not two.
  assert.doesNotThrow(() => parseRequest({ action: 'renameMatter', id: 'm-1', name: '📦'.repeat(40) }));
  rejects({ action: 'renameMatter', id: 'm-1', name: '📦'.repeat(41) }, /名字最多 40 个字/);
  assert.doesNotThrow(() => parseRequest({ action: 'setGoal', id: 'm-1', goal: '目'.repeat(120) }));
  rejects({ action: 'setGoal', id: 'm-1', goal: '目'.repeat(121) }, /目标最多 120 个字/);
  rejects({ action: 'createMatter', name: '每周\n简报', goal: '' }, /名字只能写一行/);
  rejects({ action: 'setGoal', id: 'm-1', goal: '周五\r\n发出' }, /目标只能写一行/);
  rejects({ action: 'createMatter', name: '每周\t简报', goal: '' }, /名字只能写一行/);
});

test('ids are non-empty strings without spaces', () => {
  rejects({ action: 'archiveMatter', id: '' }, /id 不是有效的 id/);
  rejects({ action: 'addSession', matterId: 'm 1', sessionId: 's-1' }, /matterId 不是有效的 id/);
  rejects({ action: 'removeSession', sessionId: 'x'.repeat(201) }, /sessionId 不是有效的 id/);
});

test('parseRequest takes the my dsh actions: its session, 做事记录, undo and the card clicks', () => {
  assert.deepEqual(parseRequest({ action: 'assistant' }), { action: 'assistant' });
  assert.deepEqual(parseRequest({ action: 'activity' }), { action: 'activity' });
  assert.deepEqual(parseRequest({ action: 'undo', id: 'a-1' }), { action: 'undo', id: 'a-1' });
  assert.deepEqual(parseRequest({ action: 'acceptProposal', id: 'p-1' }), { action: 'acceptProposal', id: 'p-1' });
  assert.deepEqual(parseRequest({ action: 'declineProposal', id: 'p-1' }), { action: 'declineProposal', id: 'p-1' });
  assert.deepEqual(parseRequest({ action: 'answerWhich', id: 'q-1', candidateId: 'm-1' }), { action: 'answerWhich', id: 'q-1', candidateId: 'm-1' });
  assert.deepEqual(parseRequest({ action: 'answerWhich', id: 'q-1', candidateId: null }), { action: 'answerWhich', id: 'q-1', candidateId: null });
  rejects({ action: 'answerWhich', id: 'q-1' }, /answerWhich 缺少字段：candidateId/);
  rejects({ action: 'answerWhich', id: 'q-1', candidateId: 7 }, /candidateId 必须是文字/);
  rejects({ action: 'answerWhich', id: 'q-1', candidateId: '' }, /candidateId 不是有效的 id/);
  rejects({ action: 'undo', id: 'a 1' }, /id 不是有效的 id/);
  rejects({ action: 'assistant', sessionId: 's-1' }, /assistant 不接受这些字段：sessionId/);
});

test('setHosting takes a matter and a preset, or null to stop hosting', () => {
  assert.deepEqual(parseRequest({ action: 'setHosting', id: 'm-1', preset: 'workspace-write' }), { action: 'setHosting', id: 'm-1', preset: 'workspace-write' });
  assert.deepEqual(parseRequest({ action: 'setHosting', id: 'm-1', preset: null }), { action: 'setHosting', id: 'm-1', preset: null });
  rejects({ action: 'setHosting', id: 'm-1' }, /setHosting 缺少字段：preset/);
  rejects({ action: 'setHosting', preset: null }, /setHosting 缺少字段：id/);
  rejects({ action: 'setHosting', id: 'm-1', preset: 7 }, /preset 必须是文字/);
  rejects({ action: 'setHosting', id: 'm-1', preset: '' }, /preset 不是有效的 id/);
  rejects({ action: 'setHosting', id: 'm-1', preset: 'workspace write' }, /preset 不是有效的 id/);
  rejects({ action: 'setHosting', id: 'm-1', preset: 'read-only', at: '2026-11-10T00:00:00Z' }, /setHosting 不接受这些字段：at/);
});

test('assistant takes an optional matter: without one it is my dsh\'s session, with one the matter\'s conversation', () => {
  assert.deepEqual(parseRequest({ action: 'assistant' }), { action: 'assistant' });
  assert.deepEqual(parseRequest({ action: 'assistant', matterId: 'm-1' }), { action: 'assistant', matterId: 'm-1' });
  rejects({ action: 'assistant', matterId: null }, /matterId 必须是文字/);
  rejects({ action: 'assistant', matterId: 'm 1' }, /matterId 不是有效的 id/);
  rejects({ action: 'assistant', matterId: '' }, /matterId 不是有效的 id/);
  rejects({ action: 'assistant', matterId: 'm-1', sessionId: 's-1' }, /assistant 不接受这些字段：sessionId/);
  // The request to start a bare session from a matter's page is gone: the matter's conversation does that.
  rejects({ action: 'startInMatter', matterId: 'm-1', prompt: '看一下' }, /没有这个操作/);
});

test('createMatter may carry a context; setContext replaces one; checkPath takes a path', () => {
  const sources = [
    { kind: 'folder', value: '/work/kb', title: 'kb' },
    { kind: 'link', value: 'https://example.com/' },
    { kind: 'upload', attachmentId: 'att-1', name: 'plan.md', bytes: 120 },
  ];
  assert.deepEqual(parseRequest({ action: 'createMatter', name: '看板', goal: '', workspaceId: 'w-1', sources, instructions: ' 图用真实样式 ' }),
    { action: 'createMatter', name: '看板', goal: '', workspaceId: 'w-1', sources, instructions: '图用真实样式' });
  assert.deepEqual(parseRequest({ action: 'createMatter', name: '看板', goal: '', workspaceId: null, sources: [], instructions: '' }),
    { action: 'createMatter', name: '看板', goal: '', workspaceId: null, sources: [] });
  assert.deepEqual(parseRequest({ action: 'setContext', id: 'm-1', workspaceId: null, sources: [], instructions: '' }),
    { action: 'setContext', id: 'm-1', workspaceId: null, sources: [] });
  assert.deepEqual(parseRequest({ action: 'checkPath', path: ' /work/kb ' }), { action: 'checkPath', path: '/work/kb' });
  rejects({ action: 'setContext', id: 'm-1', workspaceId: null, sources: [] }, /setContext 缺少字段：instructions/);
  rejects({ action: 'setContext', id: 'm-1', workspaceId: null, sources: {}, instructions: '' }, /sources 必须是列表/);
  rejects({ action: 'setContext', id: 'm-1', workspaceId: null, sources: [{ kind: 'video', value: 'x' }], instructions: '' }, /来源的种类不对/);
  rejects({ action: 'setContext', id: 'm-1', workspaceId: null, sources: [{ kind: 'upload', attachmentId: 'a', name: 'x' }], instructions: '' }, /上传的文件不完整/);
  rejects({ action: 'setContext', id: 'm-1', workspaceId: null, sources: Array.from({ length: 31 }, (_, n) => ({ kind: 'link', value: `https://e.com/${n}` })), instructions: '' }, /来源最多 30 个/);
  rejects({ action: 'setContext', id: 'm-1', workspaceId: null, sources: [], instructions: '长'.repeat(2_001) }, /指令最多 2000 个字/);
  rejects({ action: 'checkPath', path: 'relative/dir' }, /要写完整路径/);
  rejects({ action: 'checkPath', path: '' }, /要写完整路径/);
});

test('the memory actions: merge a matter now, open one file of its index by its relative path, and read a 做事记录 entry\'s diff', () => {
  assert.deepEqual(parseRequest({ action: 'mergeMemory', id: 'm-1' }), { action: 'mergeMemory', id: 'm-1' });
  assert.deepEqual(parseRequest({ action: 'memoryFile', matterId: 'm-1', path: ' 规则/差距报告格式.md ' }), { action: 'memoryFile', matterId: 'm-1', path: '规则/差距报告格式.md' });
  assert.deepEqual(parseRequest({ action: 'activityDiff', id: 'a-1' }), { action: 'activityDiff', id: 'a-1' });
  for (const path of ['', '/etc/passwd', '规则/../../x.md', '规则/a\nb.md']) rejects({ action: 'memoryFile', matterId: 'm-1', path }, /不是记忆里的文件/);
  rejects({ action: 'memoryFile', matterId: 'm-1' }, /memoryFile 缺少字段：path/);
  // The notes' own actions are gone with the notes.
  rejects({ action: 'tidyNotes', id: 'm-1' }, /没有这个操作/);
  rejects({ action: 'editNote', matterId: 'm-1', noteId: 'n-1', text: 'x' }, /没有这个操作/);
});

test('a suggestion of automatic grouping is accepted or declined by its id, and nothing else', () => {
  assert.deepEqual(parseRequest({ action: 'acceptSuggestion', id: 'sg-1' }), { action: 'acceptSuggestion', id: 'sg-1' });
  assert.deepEqual(parseRequest({ action: 'declineSuggestion', id: 'sg-1' }), { action: 'declineSuggestion', id: 'sg-1' });
  rejects({ action: 'acceptSuggestion' }, /acceptSuggestion 缺少字段：id/);
  rejects({ action: 'declineSuggestion', id: 'sg 1' }, /id 不是有效的 id/);
  rejects({ action: 'acceptSuggestion', id: 'sg-1', name: '改个名' }, /acceptSuggestion 不接受这些字段：name/);
});
