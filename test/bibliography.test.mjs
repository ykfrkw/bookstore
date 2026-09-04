import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenBd, mergeFallback, emptyBook } from '../src/core/bibliography.js';
import { fetchBook } from '../src/core/bibliography.js';

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
});

test('openBD が返した値はページ由来の値で上書きされない', () => {
  const merged = mergeFallback(parseOpenBd(FIXTURE, '9784003100011'), { title: 'Amazon の書名', price: 9999 });
  assert.equal(merged.title, 'こころの科学');
  assert.equal(merged.price, 2860);
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
});
