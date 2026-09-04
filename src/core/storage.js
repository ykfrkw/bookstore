/**
 * 保存層の抽象化。
 * Chrome 拡張では chrome.storage.local、ローカルページ / テストでは
 * localStorage（無ければメモリ）にフォールバックする。
 * これにより core 以下は実行環境を知らずに済む。
 */
import { clampQty } from './cart.js';

const KEY_PROFILE = 'bookstore.profile';

/**
 * カートの保存キー。**export する理由**: service worker は
 * `chrome.storage.onChanged` の `changes` からカートの変化を拾うため、
 * 保存層を経由せずキー文字列そのものが要る。export しないと background.js に
 * `'bookstore.cart'` のリテラルが増え、片方だけ直した時点でバッジが黙って
 * 止まる（onChanged が一致しなくなるだけで、エラーは出ない）。
 *
 * 値そのものは既存利用者のカートの在り処なので変えない（test で固定してある）。
 */
export const CART_KEY = 'bookstore.cart';

function memoryBackend() {
  const map = new Map();
  return {
    async get(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async set(k, v) {
      map.set(k, v);
    },
  };
}

function localStorageBackend() {
  return {
    async get(k) {
      const raw = globalThis.localStorage.getItem(k);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        // 他拡張やユーザー操作で壊れた JSON が入っていても起動不能にしない。
        // 未保存扱い（null）に落とせば withDefaults が既定値で埋めてくれる。
        return null;
      }
    },
    async set(k, v) {
      globalThis.localStorage.setItem(k, JSON.stringify(v));
    },
  };
}

function chromeBackend() {
  return {
    async get(k) {
      const out = await chrome.storage.local.get(k);
      return out?.[k] ?? null;
    },
    async set(k, v) {
      await chrome.storage.local.set({ [k]: v });
    },
  };
}

export function createStorage() {
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) return chromeBackend();
  try {
    if (globalThis.localStorage) return localStorageBackend();
  } catch {
    /* file:// などで塞がれている場合 */
  }
  return memoryBackend();
}

const store = createStorage();

export const loadProfile = () => store.get(KEY_PROFILE);
export const saveProfile = (p) => store.set(KEY_PROFILE, p);

/** カート: 複数冊まとめて 1 通のメールにするための一時リスト */
export async function loadCart() {
  return (await store.get(CART_KEY)) || [];
}

export async function addToCart(item) {
  const cart = await loadCart();
  const i = cart.findIndex((x) => x.book?.isbn13 === item.book?.isbn13);
  // 加算後も clampQty を通す。保存済みのカートに 0 や NaN が残っていると
  // （旧版・手編集・壊れた JSON の復元）加算しても 0 以下のままになりうる
  if (i >= 0) cart[i].quantity = clampQty((cart[i].quantity ?? 1) + (item.quantity ?? 1));
  else cart.push({ quantity: 1, note: '', ...item });
  await store.set(CART_KEY, cart);
  return cart;
}

/**
 * 冊数を書き換えて保存する。
 *
 * なぜ保存層に置くか: popup は冊数 input で `cart[i].quantity` を書き換える
 * だけで保存しておらず、閉じて開き直すと冊数が戻っていた。UI 側で
 * 「読んで直して書く」を書くと 3 面に同じ手順が増えるので、ここに寄せる。
 *
 * 未知の ISBN は no-op でカートをそのまま返す。popup を開いたまま別のタブで
 * 削除された、という並びは実際に起こる。そこで throw しても popup 側には
 * 出しようが無いし、消えた本を復活させるのは明確に間違い。
 */
export async function setCartQuantity(isbn13, quantity) {
  const cart = await loadCart();
  const i = cart.findIndex((x) => x.book?.isbn13 === isbn13);
  if (i < 0) return cart;
  cart[i] = { ...cart[i], quantity: clampQty(quantity) };
  await store.set(CART_KEY, cart);
  return cart;
}

export async function removeFromCart(isbn13) {
  const cart = (await loadCart()).filter((x) => x.book?.isbn13 !== isbn13);
  await store.set(CART_KEY, cart);
  return cart;
}

export async function clearCart() {
  await store.set(CART_KEY, []);
  return [];
}
