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

/**
 * 価格の税区分。値は `source`（'openbd' / 'page' / 'empty'）と同じ流儀に合わせ、
 * 小文字の短い語にする。
 *
 * **`unknown` は「たぶん税込」ではなく「こちらでは判断できない」。**
 * 表示側は unknown にラベルを付けない（→ mail-body.js）。分からないものに
 * 「（税込）」と書けば、それは推測ではなく誤りとして相手に届く。
 */
export const TAX_BASIS = {
  included: 'included',
  excluded: 'excluded',
  unknown: 'unknown',
};

/**
 * ONIX の PriceType。**`'01'` が税抜（本体価格）、`'02'` が税込。**
 * 日本の書籍は本体価格（税抜）で流通しているものが多いので、区別せずに
 * `Price[0]` を拾うと税抜の数字を「税込」として注文メールに載せることになる。
 * 研究費の執行では 10% の差が後から出る。
 */
const PRICE_TYPE_TAX_EXCLUDED = '01';
const PRICE_TYPE_TAX_INCLUDED = '02';

/**
 * @typedef {{isbn13:string, title:string, author:string, publisher:string,
 *            pubdate:string, price:number|null, taxBasis:string, cover:string,
 *            source:string}} Book
 */

/** @returns {Book} */
export function emptyBook(isbn13 = '') {
  return {
    isbn13,
    title: '',
    author: '',
    publisher: '',
    pubdate: '',
    price: null,
    taxBasis: TAX_BASIS.unknown,
    cover: '',
    source: 'empty',
  };
}

/**
 * ONIX の Price[] から採る 1 件を決める。
 *
 * 優先順は **税込（'02'）→ 税抜（'01'）→ 先頭**。税込が載っているなら
 * それが利用者の払う額に一番近い。どちらの PriceType も無い版元データでは
 * 従来どおり先頭を採るが、**税区分は unknown にして黙って断言しない**。
 *
 * 金額に読めない要素は飛ばす。数値でない PriceAmount を採ると price が NaN に
 * なり、合計金額まで NaN が伝染する（元コードの Number.isNaN 判定の意図）。
 *
 * @param {Array<object>|undefined} prices
 * @returns {{price:number|null, taxBasis:string}}
 */
function pickPrice(prices) {
  const numeric = (Array.isArray(prices) ? prices : [])
    .map((entry) => ({
      amount: Number(entry?.PriceAmount),
      // ONIX のコードは 2 桁の文字列だが、JSON では数値 2 や '1' で入ることが
      // ある。0 埋めした文字列に寄せてから比べる
      priceType: entry?.PriceType == null ? '' : String(entry.PriceType).padStart(2, '0'),
      rawAmount: entry?.PriceAmount,
    }))
    .filter(
      (entry) =>
        entry.rawAmount != null && entry.rawAmount !== '' && !Number.isNaN(entry.amount)
    );

  const taxIncluded = numeric.find((entry) => entry.priceType === PRICE_TYPE_TAX_INCLUDED);
  if (taxIncluded) return { price: taxIncluded.amount, taxBasis: TAX_BASIS.included };

  const taxExcluded = numeric.find((entry) => entry.priceType === PRICE_TYPE_TAX_EXCLUDED);
  if (taxExcluded) return { price: taxExcluded.amount, taxBasis: TAX_BASIS.excluded };

  if (numeric.length) return { price: numeric[0].amount, taxBasis: TAX_BASIS.unknown };
  return { price: null, taxBasis: TAX_BASIS.unknown };
}

/** openBD のレスポンス 1 件を Book に落とす */
export function parseOpenBd(entry, isbn13) {
  if (!entry) return null;
  const s = entry.summary || {};
  const onix = entry.onix || {};

  const { price, taxBasis } = pickPrice(onix?.ProductSupply?.SupplyDetail?.Price);

  return {
    isbn13: s.isbn ? String(s.isbn).replace(/-/g, '') : isbn13,
    title: s.title || '',
    author: s.author || '',
    publisher: s.publisher || '',
    pubdate: s.pubdate || '',
    price,
    taxBasis,
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

/**
 * openBD で引けなかったときに、ページ由来の値で最低限埋める。
 *
 * **ページから拾った価格の税区分は必ず unknown。** 対応サイトの価格表示に
 * 税区分が併記されているとは限らず、税込表示のサイトと税抜表示のサイトが
 * 混在する。セレクタで拾った数字だけからは決められない。ここで税込と
 * 決め打つと、直したはずのバグ（税抜を税込と称する）をフォールバック経路に
 * 作り直すことになる。
 */
export function mergeFallback(book, fallback = {}) {
  const base = book || emptyBook(fallback.isbn13 || '');
  const out = { ...base };
  // 旧スキーマ（taxBasis を持たない時代に保存された Book）が流れ込んでも
  // undefined を表示側へ渡さない
  out.taxBasis = base.taxBasis || TAX_BASIS.unknown;
  for (const k of ['title', 'author', 'publisher', 'pubdate', 'cover']) {
    if (!out[k] && fallback[k]) out[k] = fallback[k];
  }
  if (out.price == null && fallback.price != null) {
    out.price = fallback.price;
    out.taxBasis = TAX_BASIS.unknown;
  }
  if (base.source === 'empty' && fallback.title) out.source = 'page';
  return out;
}
