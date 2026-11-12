import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { MY_DSH_PRESET, MY_DSH_PROMPT, PRESET_ID, TOOLS_ROW } from '../src/host/prompt.ts';

type Row = { id?: string; name: string; config?: unknown; group?: boolean | null };
const rows = (list: readonly Row[]): Row[] => list.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? rows(row.config as Row[]) : [])]);

test('the my-dsh preset reads files but cannot write, edit, run commands or browse', () => {
  assert.equal(MY_DSH_PRESET.id, PRESET_ID);
  const names = rows(MY_DSH_PRESET.plugins as Row[]).map(row => row.name);
  assert.deepEqual(names, [
    '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search',
    'cordis:group', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-tool-result-pruner',
    TOOLS_ROW,
  ]);
  const fs = MY_DSH_PRESET.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-fs');
  assert.deepEqual(fs?.config, { read: true, readImage: true, write: false, edit: false, applyPatch: false });
  for (const name of names) assert.doesNotMatch(name, /bash|pwsh|shell|exec|web|subagent|workflow|jobs|plugin-manager|str-replace/);
});

test('the tools row is a subpath this package exports', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; exports: Record<string, unknown> };
  assert.equal(TOOLS_ROW, `${manifest.name}/tools`);
  assert.ok(manifest.exports['./tools']);
});

test('the system prompt says what my dsh does and does not do, how to resolve a vague reference, and ends with the voice rules', () => {
  assert.match(MY_DSH_PROMPT, /^你是 my dsh/);
  assert.match(MY_DSH_PROMPT, /# 你不做的事/);
  assert.match(MY_DSH_PROMPT, /ask_which/);
  assert.match(MY_DSH_PROMPT, /只能用 propose_matter_change 提议/);
  const voice = MY_DSH_PROMPT.indexOf('# 说话');
  assert.ok(voice > 0 && !MY_DSH_PROMPT.slice(voice + 1).includes('\n# '), 'the voice rules are the last section');
  // The persona text is a template: a {{…}} group would be read as a variable.
  assert.doesNotMatch(MY_DSH_PROMPT, /\{\{/);
});

test('the prompt has my dsh pass a matter\'s words on to its conversation rather than work in it, and says hosting is the user\'s', () => {
  assert.match(MY_DSH_PROMPT, /^你是 my dsh，用户在 DeepSeek Harness（DSH）里的助理。用户在 my dsh 页跟你说话。\n/);
  assert.ok(!MY_DSH_PROMPT.includes('看板页下半'));
  assert.match(MY_DSH_PROMPT, /每件事项有自己的对话：这件事的活、问题和要求都在那条对话里谈，由它开会话、记进这件事的记忆、汇报。/);
  assert.match(MY_DSH_PROMPT, /# 你做的事\n[^#]*- 用户的话只关于一件事项（点了名，或者对得上唯一一件）时，用 forward_to_matter 把用户的原话转给那件事项的对话。/);
  // A question about one matter goes there even when it asks what waits for the user; only questions about every matter stay here.
  assert.match(MY_DSH_PROMPT, /不管是问它的进度、问它哪些会话在等用户、要在里面做事，还是定以后的要求，都由那边来答、来做。/);
  assert.match(MY_DSH_PROMPT, /没点名事项、问的是所有事项的事（哪些在等用户、今天做了什么），你自己答，不转。/);
  assert.match(MY_DSH_PROMPT, /- 不派活、不开会话、不给会话发消息、不写事项的记忆：这些由事项的对话做。/);
  // The tools my dsh no longer has are not named, so it does not reach for them.
  for (const gone of ['start_session', 'send_to_session', 'note_matter']) assert.ok(!MY_DSH_PROMPT.includes(gone), gone);
  const sections = [...MY_DSH_PROMPT.matchAll(/^# (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(sections, ['你做的事', '你不做的事', '看板索引', '对上指代', '转给事项', '托管', '提议事项的改动', '说话']);
  assert.match(MY_DSH_PROMPT, /用户 @ 了一件事项的对话（消息里有“@事项名”，后面附了那条对话的快照），就转给那件事项。/);
  assert.match(MY_DSH_PROMPT, /转过去的是用户的原话。你不改写、不补充，转之前也不先回答。/);
  assert.match(MY_DSH_PROMPT, /用户只提了一件事项的名字或只 @ 了它，没说要做什么、问什么，不转，先问要做什么。/);
  assert.match(MY_DSH_PROMPT, /messages 是转用户最近几句话，默认 1。[^\n]*卡片上选的“是事项「X」”这类回复不算。/);
  assert.match(MY_DSH_PROMPT, /用户新起后会发来“新起了事项「X」”/);
  assert.match(MY_DSH_PROMPT, /选的是事项就转给它；选的是会话就转给它所在的事项/);
  assert.match(MY_DSH_PROMPT, /看板索引里带 hosting 的事项是用户托管的：那件事项的对话开的会话按 hosting\.preset 这个权限预设跑。这是用户定的，你改不了，也不用你设。/);
  assert.match(MY_DSH_PROMPT, /做事记录：你转给事项的话，你以前开的会话、发的消息和记进事项的话，/);
});

test('the prompt keeps my dsh off the page, off guesses, and off workspaces in proposals', () => {
  assert.match(MY_DSH_PROMPT, /不讲界面：不描述按钮、卡片和页面/);
  assert.match(MY_DSH_PROMPT, /不用“大概”“可能”去猜/);
  assert.match(MY_DSH_PROMPT, /最近 10 条做事记录/);
  assert.match(MY_DSH_PROMPT, /说提议时不提主工作区/);
  for (const page of ['回执上撤回', '点卡片', '卡片上点', '让用户点', '主工作区不确定就不填']) assert.ok(!MY_DSH_PROMPT.includes(page), page);
});
