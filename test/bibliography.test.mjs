import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenBd, mergeFallback, emptyBook, TAX_BASIS } from '../src/core/bibliography.js';
import { fetchBook } from '../src/core/bibliography.js';

/** ONIX の Price[] だけを差し替えた entry を作る */
const withPrices = (prices) => ({
  summary: { isbn: '9784003100011', title: '価格の検査用' },
  onix: { ProductSupply: { SupplyDetail: { Price: prices } } },
});

/** openBD の実レスポンスから必要な部分だけ抜いた fixture */
const FIXTURE = {
  summary: {
    isbn: '9784003100011',
    title: 'こころの科学',
    volume: '',
    series: '',
    publisher: '岩波書店',
    pubdate: '20240115',
    cover: 'https://cover.openbd.jp/9784003100011.jpg',
    author: 'テスト 著者／著',
  },
  onix: {
    ProductSupply: {
      SupplyDetail: {
        Price: [{ PriceAmount: '2860', CurrencyCode: 'JPY' }],
      },
    },
  },
};

test('openBD のレスポンスを Book に変換する', () => {
  const b = parseOpenBd(FIXTURE, '9784003100011');
  assert.equal(b.title, 'こころの科学');
  assert.equal(b.publisher, '岩波書店');
  assert.equal(b.author, 'テスト 著者／著');
  assert.equal(b.price, 2860);
  assert.equal(b.isbn13, '9784003100011');
  assert.equal(b.source, 'openbd');
});

test('PriceType 02 があれば税込として採る', () => {
  const b = parseOpenBd(withPrices([{ PriceType: '02', PriceAmount: '4180' }]), '9784003100011');
  assert.equal(b.price, 4180);
  assert.equal(b.taxBasis, TAX_BASIS.included);
});

test('PriceType 01 だけなら税抜として採る', () => {
  const b = parseOpenBd(withPrices([{ PriceType: '01', PriceAmount: '3800' }]), '9784003100011');
  assert.equal(b.price, 3800);
  assert.equal(b.taxBasis, TAX_BASIS.excluded);
});

test('01 と 02 が両方あれば 02（税込）を優先する', () => {
  // 配列の順序に依存しないこと。税抜が先に載っている版元データが普通にある
  const b = parseOpenBd(
    withPrices([
      { PriceType: '01', PriceAmount: '3800' },
      { PriceType: '02', PriceAmount: '4180' },
    ]),
    '9784003100011'
  );
  assert.equal(b.price, 4180);
  assert.equal(b.taxBasis, TAX_BASIS.included);
});

test('PriceType が無ければ税区分は不明（先頭の金額は採る）', () => {
  // 税区分を名乗れないだけで、金額は従来どおり出す。
  // ここを included に倒すと「税抜を税込と称する」バグに戻る
  const b = parseOpenBd(withPrices([{ PriceAmount: '2860', CurrencyCode: 'JPY' }]), '9784003100011');
  assert.equal(b.price, 2860);
  assert.equal(b.taxBasis, TAX_BASIS.unknown);
});

test('PriceAmount が数値でない要素は飛ばす', () => {
  // NaN を採ると合計金額まで NaN が伝染する
  const b = parseOpenBd(
    withPrices([
      { PriceType: '02', PriceAmount: '' },
      { PriceType: '02', PriceAmount: 'お問い合わせください' },
      { PriceType: '01', PriceAmount: '3800' },
    ]),
    '9784003100011'
  );
  assert.equal(b.price, 3800);
  assert.equal(b.taxBasis, TAX_BASIS.excluded);

  // 全部が数値でなければ価格不明に落ちる（NaN にしない）
  const none = parseOpenBd(withPrices([{ PriceType: '02', PriceAmount: '—' }]), '9784003100011');
  assert.equal(none.price, null);
  assert.equal(none.taxBasis, TAX_BASIS.unknown);
});

test('PriceType が数値で入っていても文字列として比べる', () => {
  const b = parseOpenBd(withPrices([{ PriceType: 2, PriceAmount: 4180 }]), '9784003100011');
  assert.equal(b.price, 4180);
  assert.equal(b.taxBasis, TAX_BASIS.included);
});

test('未収録（null 要素）は null を返す', () => {
  assert.equal(parseOpenBd(null, '9784003100011'), null);
});

test('価格が無い ONIX でも落ちない', () => {
  const b = parseOpenBd({ summary: { title: 'X' } }, '9784003100011');
  assert.equal(b.price, null);
  assert.equal(b.isbn13, '9784003100011');
});

test('openBD が空振りしたらページ由来の値で埋める', () => {
  const merged = mergeFallback(null, { isbn13: '9784003100011', title: 'ページから取れた書名', price: 1980 });
  assert.equal(merged.title, 'ページから取れた書名');
  assert.equal(merged.price, 1980);
  assert.equal(merged.source, 'page');
  // ページの価格表示は税込のサイトと税抜のサイトが混在する。セレクタで拾った
  // 数字からは決められないので unknown（表示側はラベルを付けない）
  assert.equal(merged.taxBasis, TAX_BASIS.unknown);
});

test('openBD が返した値はページ由来の値で上書きされない', () => {
  const merged = mergeFallback(parseOpenBd(FIXTURE, '9784003100011'), { title: 'Amazon の書名', price: 9999 });
  assert.equal(merged.title, 'こころの科学');
  assert.equal(merged.price, 2860);
});

test('openBD が税区分を持っていれば mergeFallback を通しても保たれる', () => {
  const book = parseOpenBd(withPrices([{ PriceType: '01', PriceAmount: '3800' }]), '9784003100011');
  const merged = mergeFallback(book, { title: 'Amazon の書名', price: 9999 });
  assert.equal(merged.price, 3800);
  assert.equal(merged.taxBasis, TAX_BASIS.excluded);
});

test('taxBasis を持たない旧スキーマの Book は unknown に丸める', () => {
  // 保存済みのカートには taxBasis の無い Book が残る。undefined を表示側へ
  // 渡すと TAX_WORD の引きが外れる
  const legacy = { isbn13: '9784003100011', title: '旧データ', price: 2860, source: 'openbd' };
  assert.equal(mergeFallback(legacy, {}).taxBasis, TAX_BASIS.unknown);
});

test('不正な ISBN では通信せずに null', async () => {
  let called = false;
  const r = await fetchBook('not-an-isbn', {
    fetchImpl: () => {
      called = true;
      return Promise.resolve(new Response('{}'));
    },
  });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('通信が失敗しても例外にせず null を返す', async () => {
  const r = await fetchBook('9784003100011', { fetchImpl: () => Promise.reject(new Error('offline')) });
  assert.equal(r, null);
});

test('emptyBook の形', () => {
  const b = emptyBook('9784003100011');
  assert.equal(b.source, 'empty');
  assert.equal(b.price, null);
  assert.equal(b.taxBasis, TAX_BASIS.unknown);
});
