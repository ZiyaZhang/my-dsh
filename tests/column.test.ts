import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLUMN_DEFAULT, COLUMN_KEY, columnWidth, readColumn, writeColumn } from '../src/client/column.ts';

test('the column keeps 300 px to 70% of the tab and leaves the conversation 400 px', () => {
  assert.equal(columnWidth(380, 1_000), 380);
  assert.equal(columnWidth(100, 1_000), 300);
  assert.equal(columnWidth(900, 1_000), 600);
  assert.equal(columnWidth(1_500, 2_000), 1_400);
  assert.equal(columnWidth(380, 1_200), 380);
});

test('a tab too narrow for the column beside the conversation leaves it out', () => {
  assert.equal(columnWidth(380, 699), 0);
  assert.equal(columnWidth(380, 700), 300);
  assert.equal(columnWidth(380, 0), 0);
});

test('the setting is kept in storage; missing or unreadable storage gives the default, open', () => {
  const items = new Map<string, string>();
  const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
  assert.deepEqual(readColumn(storage), { width: COLUMN_DEFAULT, open: true });
  writeColumn(storage, { width: 512, open: false });
  assert.deepEqual(readColumn(storage), { width: 512, open: false });
  items.set(COLUMN_KEY, '{bad');
  assert.deepEqual(readColumn(storage), { width: COLUMN_DEFAULT, open: true });
  items.set(COLUMN_KEY, JSON.stringify({ width: 'wide', open: 'yes' }));
  assert.deepEqual(readColumn(storage), { width: COLUMN_DEFAULT, open: true });
  assert.deepEqual(readColumn(undefined), { width: COLUMN_DEFAULT, open: true });
  const broken = { setItem: () => { throw new Error('quota'); } };
  assert.doesNotThrow(() => { writeColumn(broken, { width: 400, open: true }); });
});
