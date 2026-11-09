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
