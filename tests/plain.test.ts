import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, plain } from '../src/host/preview.ts';

test('plain takes Markdown marks out of a reply', () => {
  assert.equal(plain('已完成，**全部数据** 整理成了 170 条。\n## 下一步'), '已完成，全部数据 整理成了 170 条。\n下一步');
  assert.equal(plain('看 [发布说明](https://example.com/a) 和 `npm test`'), '看 发布说明 和 npm test');
  assert.equal(plain('- 第一条\n2. 第二条\n> 引用'), '第一条\n第二条\n引用');
  assert.equal(plain('改了 file_name 和 __init__'), '改了 file_name 和 __init__');
});

test('clip shows a Markdown reply as one plain line', () => {
  assert.equal(clip('已完成，三份 PDF。我把**全部数据**整理好了。\n\n## 结果\n- 第一条'), '已完成，三份 PDF。我把全部数据整理好了。 结果 第一条');
});
