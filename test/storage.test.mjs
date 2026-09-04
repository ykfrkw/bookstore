import test from 'node:test';
import assert from 'node:assert/strict';

// Node に localStorage は無いので、Web Storage 互換の最小モックを先に据えてから
// storage.js を import する（createStorage が localStorage backend を選ぶように）。
const map = new Map();
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
};

const {
  createStorage,
  CART_KEY,
  loadCart,
  addToCart,
  setCartQuantity,
  removeFromCart,
  clearCart,
} = await import('../src/core/storage.js');

/** localStorage に実際に書かれた生の値を読む（保存層を通さずに確かめる） */
const rawCart = () => JSON.parse(map.get(CART_KEY));

const bookItem = (isbn13, quantity = 1) => ({ book: { isbn13, title: 'テスト書名' }, quantity });

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

test('CART_KEY の値は bookstore.cart のまま', () => {
  // 保存形式の固定。変えると既存利用者のカートが「消えた」ように見える
  // （旧キーに残ったまま読まれなくなる）。次の PR では service worker が
  // storage.onChanged でこのキーを見るので、リテラルの二重化も禁じたい
  assert.equal(CART_KEY, 'bookstore.cart');
});

test('addToCart は CART_KEY の下に書く', async () => {
  await clearCart();
  await addToCart(bookItem('9784000000001'));
  // 保存層の loadCart ではなくモックの localStorage を直接読む。
  // 読み書きが同じ間違ったキーで揃っていると round-trip では気づけない
  assert.deepEqual(rawCart(), [
    { quantity: 1, note: '', book: { isbn13: '9784000000001', title: 'テスト書名' } },
  ]);
});

test('addToCart の加算は clampQty を通る', async () => {
  await clearCart();
  await addToCart(bookItem('9784000000002'));
  await addToCart(bookItem('9784000000002', 2));
  assert.equal((await loadCart())[0].quantity, 3);
});

test('setCartQuantity: 保存されるので読み直しても冊数が残る', async () => {
  await clearCart();
  await addToCart(bookItem('9784000000003'));
  const returned = await setCartQuantity('9784000000003', 5);
  assert.equal(returned[0].quantity, 5);
  // popup を閉じて開き直す＝保存層から読み直す、に相当する経路
  assert.equal((await loadCart())[0].quantity, 5);
  assert.equal(rawCart()[0].quantity, 5);
});

test('setCartQuantity: 0 は 1 に丸まる', async () => {
  await clearCart();
  await addToCart(bookItem('9784000000004'));
  assert.equal((await setCartQuantity('9784000000004', 0))[0].quantity, 1);
  assert.equal((await setCartQuantity('9784000000004', '2.9'))[0].quantity, 2);
});

test('setCartQuantity: 未知の ISBN では カートが変わらない', async () => {
  await clearCart();
  await addToCart(bookItem('9784000000005', 1));
  const before = await loadCart();
  const after = await setCartQuantity('9784999999999', 7);
  // 別タブで削除された本を、冊数変更のついでに復活させてはいけない
  assert.deepEqual(after, before);
  assert.deepEqual(await loadCart(), before);
  assert.equal(after.length, 1);
});

test('addToCart: 新規追加も clampQty を通る（0 冊で push されない）', async () => {
  await clearCart();
  // 呼び出し元は clamp 済みの値を渡すので今は到達しないが、新しい面が
  // 直接 addToCart を呼ぶと 0 冊のまま保存され composeOrder に流れる
  await addToCart(bookItem('9784000000006', 0));
  assert.equal(rawCart()[0].quantity, 1);
  await clearCart();
  await addToCart(bookItem('9784000000006', '2.9'));
  assert.equal(rawCart()[0].quantity, 2);
});

/**
 * 書き込みの直列化。
 *
 * popup では冊数の `change` と × の `click` が同一ジェスチャで並ぶ
 * （× を押すと input が blur して `change` が先に発火する）。直列化が無いと
 * 両方が `set` の前に `get` を終え、後から書いた方が相手の変更を消す。
 * 保存層を通さずモックの localStorage を直接読んで最終状態を見る。
 */
test('直列化: 冊数変更 → 削除 で冊数が消えない（lost update）', async () => {
  await clearCart();
  await addToCart(bookItem('9784000000007'));
  await addToCart(bookItem('9784000000008'));
  await Promise.all([
    setCartQuantity('9784000000007', 5),
    removeFromCart('9784000000008'),
  ]);
  assert.deepEqual(
    rawCart().map((x) => [x.book.isbn13, x.quantity]),
    [['9784000000007', 5]],
  );
});

test('直列化: 削除 → 冊数変更 で削除した本が復活しない', async () => {
  await clearCart();
  await addToCart(bookItem('9784000000009'));
  await addToCart(bookItem('9784000000010'));
  await Promise.all([
    removeFromCart('9784000000010'),
    setCartQuantity('9784000000009', 5),
  ]);
  assert.deepEqual(
    rawCart().map((x) => [x.book.isbn13, x.quantity]),
    [['9784000000009', 5]],
  );
});

test('直列化: 同じ本への同時 addToCart が両方数えられる', async () => {
  await clearCart();
  // カートタブを開いたまま書籍ページのパネルで押した、に相当する並び
  await Promise.all([
    addToCart(bookItem('9784000000011')),
    addToCart(bookItem('9784000000011')),
  ]);
  assert.equal(rawCart().length, 1);
  assert.equal(rawCart()[0].quantity, 2);
});
