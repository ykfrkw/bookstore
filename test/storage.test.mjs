import test from 'node:test';
import assert from 'node:assert/strict';

// Node に localStorage は無いので、Web Storage 互換の最小モックを先に据えてから
// storage.js を import する（createStorage が localStorage backend を選ぶように）。
const map = new Map();
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
};

const { createStorage } = await import('../src/core/storage.js');

test('localStorage backend: 壊れた JSON は null 扱いで落ちない', async () => {
  const store = createStorage();
  map.set('bookstore.broken', '{"oops": '); // 途中で切れた JSON
  assert.equal(await store.get('bookstore.broken'), null);
  map.set('bookstore.broken2', 'not-json-at-all');
  assert.equal(await store.get('bookstore.broken2'), null);
});

test('localStorage backend: set → get の round-trip', async () => {
  const store = createStorage();
  const value = { requester: { name: '山田 太郎' }, fundingSources: [{ id: 'a' }] };
  await store.set('bookstore.rt', value);
  assert.deepEqual(await store.get('bookstore.rt'), value);
  assert.equal(await store.get('bookstore.missing'), null);
});
