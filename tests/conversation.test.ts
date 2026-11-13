import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  USER_WORDS_MAX, callerOf, checkReach, conversationContext, conversationRules, hostingLine, matterFor, sentText, sessionList, type ListedSession,
} from '../src/host/conversation.ts';
import { RequestError, type Matter } from '../src/host/remote.ts';

const T0 = '2026-11-10T08:00:00.000Z';
const matter: Matter = {
  id: 'm-1', name: 'SDK 升级跟进', goal: '挑功能做成插件', instructions: '不改核心', aliases: [], createdAt: T0, conversation: 's-talk',
  sources: [{ kind: 'link', value: 'https://example.com/r', title: 'releases' }],
  sessions: [{ sessionId: 's-report', by: 'mydsh', at: T0 }, { sessionId: 's-build', by: 'manual', at: T0 }, { sessionId: 's-ask', by: 'mydsh', at: T0 }],
};
const MEMORY = '这件事的记忆在 /w/.my-dsh/m-1/memory/：……\n\n# SDK 升级跟进 · 记忆索引';
const sessions: ListedSession[] = [
  { id: 's-report', title: '出 0.163 的报告', state: 'idle', preview: { kind: 'reply', text: '报告写好了' }, by: 'mydsh' },
  { id: 's-build', title: '装开发 profile', state: 'running', preview: { kind: 'running', step: '运行命令 npm run check', since: 1_700_000_000_000 }, by: 'manual' },
  { id: 's-ask', title: '定开关', state: 'waiting', wait: 'question', preview: { kind: 'question', text: '先跟哪几个开关？', since: 1_700_000_000_000 }, by: 'mydsh' },
];

test('a matter\'s conversation reads its rules, the matter\'s context, its memory and its live sessions, in that order', () => {
  const text = conversationContext(matter, sessions, undefined, MEMORY);
  assert.equal(text, [
    conversationRules('SDK 升级跟进'),
    '',
    '目标：挑功能做成插件',
    '指令：不改核心',
    '来源：releases（https://example.com/r）',
    '',
    '这件事的记忆在 /w/.my-dsh/m-1/memory/：……',
    '',
    '# SDK 升级跟进 · 记忆索引',
    '',
    '这件事里的会话（最急的在前）：',
    '- 定开关 · 在等你回答：先跟哪几个开关？ · 派出去的 · id=s-ask',
    '- 装开发 profile · 在跑：运行命令 npm run check · id=s-build',
    '- 出 0.163 的报告 · 空闲，最后的回复：报告写好了 · 派出去的 · id=s-report',
  ].join('\n'));
  assert.match(text, /^这条会话是事项「SDK 升级跟进」的对话。用户在这里交代和这件事有关的事。\n- 用户的话里没说要做什么、问什么，先问清楚，不要自己找活干。\n- 小事直接做。/);
  // Right after the line about dispatching: the cards that show the dispatched sessions, then what a hosted matter's wake brings.
  const rules = conversationRules('SDK 升级跟进').split('\n');
  const dispatched = rules.findIndex(rule => rule.startsWith('- 派出去以后'));
  assert.match(rules[dispatched + 1]!, /^- 你派出去的每条会话，在派它的那一轮下面有一张卡片，一直显示它在做的这一步、结果开头、报错或它问用户的话，用户看得到。所以你不复述结果，也不提卡片/);
  assert.match(rules[dispatched + 2]!, /^- 这件事托管时，你派出去的会话都停下后会收到一条“派出去的会话有结果了”，照那条消息做；派用户交代的最后一步时带上 last: true（不用跟用户提），它做完就不再叫醒你。没托管时不会收到/);
  // The sessions' own matter line is left out: the rules already say which matter this is.
  assert.doesNotMatch(text, /这条会话属于事项/);
});

test('the conversation\'s text holds no clock times, so it stays the same while nothing changes', () => {
  const later = sessions.map(session => (session.preview && 'since' in session.preview ? { ...session, preview: { ...session.preview, since: 1_800_000_000_000 } } : session));
  assert.equal(conversationContext(matter, later), conversationContext(matter, sessions));
  assert.doesNotMatch(conversationContext(matter, sessions), /\d{1,2}:\d{2}|分钟|刚刚/);
});

test('the list is most urgent first, then in the order the sessions joined; a matter without sessions says so', () => {
  const idle = (id: string): ListedSession => ({ id, title: id, state: 'idle', by: 'manual' });
  const failed: ListedSession = { id: 's-f', title: '构建', state: 'failed', preview: { kind: 'failed', error: '没过' }, by: 'manual' };
  assert.deepEqual(sessionList([idle('s-b'), failed, idle('s-a')]).split('\n').slice(1), [
    '- 构建 · 上一轮失败：没过 · id=s-f', '- s-b · 空闲 · id=s-b', '- s-a · 空闲 · id=s-a',
  ]);
  assert.equal(sessionList([]), '这件事里还没有会话。');
  const bare = { name: '看板', goal: '', sources: [] };
  assert.equal(conversationContext(bare, []), `${conversationRules('看板')}\n\n这件事里还没有会话。`);
});

test('a caller is my dsh\'s own session or the conversation of a matter in progress; nothing else gets the tools', () => {
  const archived: Matter = { ...matter, id: 'm-2', conversation: 's-old', archivedAt: T0 };
  const matters = [matter, archived];
  assert.deepEqual(callerOf('s-mydsh', 's-mydsh', matters), { kind: 'assistant', sessionId: 's-mydsh' });
  assert.deepEqual(callerOf('s-talk', 's-mydsh', matters), { kind: 'conversation', sessionId: 's-talk', matter });
  assert.equal(callerOf('s-old', 's-mydsh', matters), undefined);
  assert.equal(callerOf('s-report', 's-mydsh', matters), undefined);
  assert.equal(callerOf(undefined, 's-mydsh', matters), undefined);
  assert.equal(callerOf('s-talk', undefined, []), undefined);
});

test('a matter\'s conversation acts on its own matter and its sessions only; my dsh names the matter and reaches any session', () => {
  const home = callerOf('s-mydsh', 's-mydsh', [matter])!;
  const own = callerOf('s-talk', 's-mydsh', [matter])!;
  const refused = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof RequestError && message.test(error.message));
  assert.equal(matterFor(own, undefined), 'm-1');
  assert.equal(matterFor(own, ''), 'm-1');
  assert.equal(matterFor(own, 'm-1'), 'm-1');
  refused(() => matterFor(own, 'm-2'), /只管事项「SDK 升级跟进」/);
  assert.equal(matterFor(home, 'm-2'), 'm-2');
  refused(() => matterFor(home, undefined), /缺少 matterId/);
  refused(() => matterFor(home, ' '), /缺少 matterId/);
  assert.doesNotThrow(() => { checkReach(own, 's-build'); });
  refused(() => { checkReach(own, 's-elsewhere'); }, /不在事项「SDK 升级跟进」里/);
  // The conversation is not one of the matter's sessions.
  refused(() => { checkReach(own, 's-talk'); }, /不在事项/);
  assert.doesNotThrow(() => { checkReach(home, 's-elsewhere'); });
});

test('a dispatched task carries the user\'s own words of the turn after it, cut to 2000 characters, and the closing line last', () => {
  assert.equal(sentText('把报告发到飞书', '把 0.163 的报告发到飞书，别发邮件', '需要时用提问工具问。'), '把报告发到飞书\n\n用户原话：\n把 0.163 的报告发到飞书，别发邮件\n\n需要时用提问工具问。');
  assert.equal(sentText('把报告发到飞书', undefined, '需要时用提问工具问。'), '把报告发到飞书\n\n需要时用提问工具问。');
  assert.equal(sentText('接着做', '好的，接着做'), '接着做\n\n用户原话：\n好的，接着做');
  const long = sentText('做', '长'.repeat(USER_WORDS_MAX + 5));
  assert.equal(long, `做\n\n用户原话：\n${'长'.repeat(USER_WORDS_MAX)}…`);
  assert.equal(USER_WORDS_MAX, 2_000);
});

test('a hosted matter\'s conversation reads which preset its sessions run under, and that the preset does not stop dispatching', () => {
  const tail = '预设不妨碍派活，会话要用户批准时自己会问。';
  assert.equal(hostingLine('read-only'), `这件事托管了：你开的会话按「仅可查看」跑，改任何文件前先问用户。${tail}`);
  assert.equal(hostingLine('workspace-write'), `这件事托管了：你开的会话按「工作区内修改」跑，改工作区以外的文件前先问用户。${tail}`);
  assert.equal(hostingLine('danger-full-access'), `这件事托管了：你开的会话按「完全权限」跑，不问用户。${tail}`);
  assert.equal(hostingLine('team-review'), `这件事托管了：你开的会话按权限预设 team-review 跑。${tail}`);
  const lines = conversationContext(matter, sessions, 'read-only', MEMORY).split('\n');
  assert.equal(lines[lines.indexOf('来源：releases（https://example.com/r）') + 1], hostingLine('read-only'));
  assert.ok(!conversationContext(matter, sessions).includes('这件事托管了'));
});

test('the conversation writes the user\'s standing words into the matter\'s memory, and changes a memory file when the user asks', () => {
  const rules = conversationRules('SDK 升级跟进').split('\n');
  assert.ok(rules.includes('- 用户说了以后都适用的要求或定下的事，用 note_matter 记进这件事的记忆。'));
  assert.ok(rules.includes('- 用户要改记忆里的某个文件（“改记忆「规则/某个文件.md」：……”），照用户的话改那个文件。'));
});

test('words the home passed on can name other matters; their part is not this conversation\'s work', () => {
  assert.ok(conversationRules('SDK 升级跟进').split('\n').includes('- 用户的话里要别的事项做的事不归你做，那些事项有各自的对话。'));
});
