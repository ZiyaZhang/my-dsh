import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUT_TWICE, callStop } from '../src/host/model-call.ts';

test('a pass that ran out of time says so, whatever the stream ended with', () => {
  assert.equal(callStop(undefined, true, 10), '模型 10 分钟内没有答完');
  assert.equal(callStop({ kind: 'aborted', failure: { message: 'This operation was aborted' } }, true, 10), '模型 10 分钟内没有答完');
});

test('a failed or stopped call gives the failure in its own words, collapsed and cut to 120 characters', () => {
  assert.equal(callStop({ kind: 'error', failure: { message: '429  Too\nMany Requests' } }, false, 10), '模型调用出错：429 Too Many Requests');
  assert.equal(callStop({ kind: 'aborted', failure: { message: 'socket hang up' } }, false, 10), '模型调用被中止：socket hang up');
  assert.equal(callStop({ kind: 'error' }, false, 10), '模型调用出错：没有说明');
  const long = callStop({ kind: 'error', failure: { message: '长'.repeat(300) } }, false, 10);
  assert.equal(long, `模型调用出错：${'长'.repeat(120)}`);
});

test('an answer that ended, or was cut at the length limit, is worth reading', () => {
  assert.equal(callStop({ kind: 'stop' }, false, 10), undefined);
  assert.equal(callStop({ kind: 'max-tokens' }, false, 10), undefined);
  assert.equal(callStop(undefined, false, 10), undefined);
  assert.match(CUT_TWICE, /长度上限/);
});
