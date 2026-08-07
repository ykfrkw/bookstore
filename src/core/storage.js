/**
 * 保存層の抽象化。
 * Chrome 拡張では chrome.storage.local、ローカルページ / テストでは
 * localStorage（無ければメモリ）にフォールバックする。
 * これにより core 以下は実行環境を知らずに済む。
 */

const KEY_PROFILE = 'bookstore.profile';
const KEY_CART = 'bookstore.cart';

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
      return raw ? JSON.parse(raw) : null;
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
  return (await store.get(KEY_CART)) || [];
}

export async function addToCart(item) {
  const cart = await loadCart();
  const i = cart.findIndex((x) => x.book?.isbn13 === item.book?.isbn13);
  if (i >= 0) cart[i].quantity = (cart[i].quantity ?? 1) + (item.quantity ?? 1);
  else cart.push({ quantity: 1, note: '', ...item });
  await store.set(KEY_CART, cart);
  return cart;
}

export async function removeFromCart(isbn13) {
  const cart = (await loadCart()).filter((x) => x.book?.isbn13 !== isbn13);
  await store.set(KEY_CART, cart);
  return cart;
}

export async function clearCart() {
  await store.set(KEY_CART, []);
  return [];
}
