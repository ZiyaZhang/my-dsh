import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstSessionAt, installedPlugins, seededSessions, sessionUsage, tokenTotal } from '../src/host/usage.ts';

const usage = (input: number, output: number, read = 0, write = 0) => ({ uncachedInputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write });

test('a token total adds the four buckets, as DSH\'s composer does; anything short of four counts is no total', () => {
  assert.equal(tokenTotal(usage(100, 20, 300, 4)), 424);
  assert.equal(tokenTotal({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }), undefined);
  assert.equal(tokenTotal({ ...usage(1, 2), outputTokens: -1 }), undefined);
  assert.equal(tokenTotal({ ...usage(1, 2), cacheReadTokens: Number.NaN }), undefined);
  assert.equal(tokenTotal(undefined), undefined);
  assert.equal(tokenTotal(7), undefined);
});

test('sessions count the top-level ones with a turn; tokens leave out forks and sessions without a total, and say how many they cover', () => {
  const rows = [
    { sessionId: 'a', blank: false, tokenUsage: usage(1_000, 200) },
    { sessionId: 'b', blank: false, tokenUsage: usage(10, 5, 85) },
    { sessionId: 'old', blank: false },
    { sessionId: 'fork', blank: false, tokenUsage: usage(5_000, 1_000) },
    { sessionId: 'child', blank: false, origin: 'subagent', tokenUsage: usage(9_000, 9_000) },
    { sessionId: 'new', blank: true },
  ];
  assert.deepEqual(sessionUsage(rows, new Set(['fork'])), { sessions: 4, tokens: 1_300, tokenSessions: 2 });
  assert.deepEqual(sessionUsage([], new Set()), { sessions: 0, tokens: 0, tokenSessions: 0 });
});

test('the first session is the earliest top-level header; forks are the seeded headers', () => {
  const headers = [
    { id: 'a', createdAt: 2_000 },
    { id: 'child', createdAt: 500, origin: 'subagent' },
    { id: 'b', createdAt: 1_000, isSeeded: true },
    { id: 'c' },
  ];
  assert.equal(firstSessionAt(headers), 1_000);
  assert.equal(firstSessionAt([{ id: 'x', origin: 'subagent', createdAt: 1 }]), undefined);
  assert.deepEqual([...seededSessions(headers)], ['b']);
});

test('installed plugins are what the plugin page lists under 已安装插件', () => {
  assert.equal(installedPlugins([
    { installed: true },
    { installed: true, official: true },
    { installed: false, error: { message: 'missing peer' } },
    { installed: false },
    { official: true },
  ]), 2);
});
