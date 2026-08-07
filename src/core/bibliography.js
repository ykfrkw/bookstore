/**
 * 書誌情報の取得。
 * 一次ソースは openBD（無料・登録不要・CORS 許可あり）。
 * 落ちたとき / 未収録のときは Amazon ページから拾った値にフォールバックする。
 *
 * 注意: Amazon から取れた値は「注文メールの下書きを作るための一時利用」に留め、
 *       保存・再配布はしない（規約上の安全側）。
 */

import { toIsbn13 } from './isbn.js';

const OPENBD_ENDPOINT = 'https://api.openbd.jp/v1/get';

/** @typedef {{isbn13:string,title:string,author:string,publisher:string,pubdate:string,price:number|null,cover:string,source:string}} Book */

/** @returns {Book} */
export function emptyBook(isbn13 = '') {
  return {
    isbn13,
    title: '',
    author: '',
    publisher: '',
    pubdate: '',
    price: null,
    cover: '',
    source: 'empty',
  };
}

/** openBD のレスポンス 1 件を Book に落とす */
export function parseOpenBd(entry, isbn13) {
  if (!entry) return null;
  const s = entry.summary || {};
  const onix = entry.onix || {};

  let price = null;
  const p = onix?.ProductSupply?.SupplyDetail?.Price?.[0]?.PriceAmount;
  if (p != null && !Number.isNaN(Number(p))) price = Number(p);

  return {
    isbn13: s.isbn ? String(s.isbn).replace(/-/g, '') : isbn13,
    title: s.title || '',
    author: s.author || '',
    publisher: s.publisher || '',
    pubdate: s.pubdate || '',
    price,
    cover: s.cover || '',
    source: 'openbd',
  };
}

/**
 * @param {string} isbn ISBN-10 / ISBN-13 どちらでも可
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<Book|null>}
 */
export async function fetchBook(isbn, opts = {}) {
  const isbn13 = toIsbn13(isbn);
  if (!isbn13) return null;

  const doFetch = opts.fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);

  try {
    const res = await doFetch(`${OPENBD_ENDPOINT}?isbn=${isbn13}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return parseOpenBd(json?.[0], isbn13);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** openBD で引けなかったときに、ページ由来の値で最低限埋める */
export function mergeFallback(book, fallback = {}) {
  const base = book || emptyBook(fallback.isbn13 || '');
  const out = { ...base };
  for (const k of ['title', 'author', 'publisher', 'pubdate', 'cover']) {
    if (!out[k] && fallback[k]) out[k] = fallback[k];
  }
  if (out.price == null && fallback.price != null) out.price = fallback.price;
  if (base.source === 'empty' && fallback.title) out.source = 'page';
  return out;
}
