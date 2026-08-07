import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidIsbn10, isValidIsbn13, toIsbn13, toIsbn10, extractIsbn } from '../src/core/isbn.js';

test('ISBN-10 の検証', () => {
  assert.ok(isValidIsbn10('4003100018')); // 岩波文庫
  assert.ok(isValidIsbn10('020161622X')); // チェックディジット X
  assert.ok(!isValidIsbn10('4003100019'));
  assert.ok(!isValidIsbn10('B08XYZ1234')); // Kindle の ASIN
});

test('ISBN-13 の検証', () => {
  assert.ok(isValidIsbn13('9784003100011'));
  assert.ok(!isValidIsbn13('9784003100012'));
});

test('ISBN-10 <-> ISBN-13 の相互変換', () => {
  assert.equal(toIsbn13('4003100018'), '9784003100011');
  assert.equal(toIsbn10('9784003100011'), '4003100018');
  assert.equal(toIsbn13('978-4-00-310001-1'), '9784003100011');
  assert.equal(toIsbn13('B08XYZ1234'), null);
});

test('Amazon URL の ASIN から ISBN を取る', () => {
  const r = extractIsbn({ url: 'https://www.amazon.co.jp/dp/4003100018/ref=sr_1_1' });
  assert.equal(r.isbn13, '9784003100011');
  assert.equal(r.source, 'asin');
});

test('ASIN が ISBN でないときはページ本文にフォールバックする', () => {
  const r = extractIsbn({
    url: 'https://www.amazon.co.jp/dp/B08XYZ1234',
    text: 'ISBN-13 : 978-4-00-310001-1\n出版社 : 岩波書店',
  });
  assert.equal(r.isbn13, '9784003100011');
  assert.equal(r.source, 'page-isbn13');
});

test('ISBN が無いページでは null を返す', () => {
  const r = extractIsbn({ url: 'https://www.amazon.co.jp/dp/B08XYZ1234', text: '家電製品です' });
  assert.equal(r.isbn13, null);
  assert.equal(r.source, 'asin-not-isbn');
});

test('雑誌コードなどの裸の 13 桁は拾わない', () => {
  const r = extractIsbn({ url: '', text: '商品コード 1234567890123' });
  assert.equal(r.isbn13, null);
});

test('紀伊國屋 URL（和書 dsg-01）から ISBN を取る', () => {
  const r = extractIsbn({ url: 'https://www.kinokuniya.co.jp/f/dsg-01-9784478025819' });
  assert.equal(r.isbn13, '9784478025819');
  assert.equal(r.source, 'url-kinokuniya');
});

test('紀伊國屋 URL（洋書 dsg-02）からも ISBN を取る', () => {
  const r = extractIsbn({ url: 'https://www.kinokuniya.co.jp/f/dsg-02-9780262033848' });
  assert.equal(r.isbn13, '9780262033848');
  assert.equal(r.source, 'url-kinokuniya');
});

test('紀伊國屋の電子書籍（dsg-08）は URL 経路で拾わない', () => {
  // 電子版の ISBN で紙の本を発注する事故を防ぐため、意図的に対象外
  const r = extractIsbn({ url: 'https://www.kinokuniya.co.jp/f/dsg-08-9784478025819' });
  assert.equal(r.isbn13, null);
});

test('紀伊國屋 URL のチェックディジット不正は採用しない', () => {
  const r = extractIsbn({ url: 'https://www.kinokuniya.co.jp/f/dsg-01-9784478025810' });
  assert.equal(r.isbn13, null);
});

test('丸善ジュンク堂 /products/ URL から ISBN を取る', () => {
  const r = extractIsbn({ url: 'https://www.maruzenjunkudo.co.jp/products/9784478025819' });
  assert.equal(r.isbn13, '9784478025819');
  assert.equal(r.source, 'url-maruzen');
});

test('楽天ブックス相当: URL に ISBN が無くても title 由来のテキストから取れる', () => {
  const r = extractIsbn({
    url: 'https://books.rakuten.co.jp/rb/12345678/',
    text: 'ダイヤモンド社の本 - 楽天ブックス\n9784478025819',
  });
  assert.equal(r.isbn13, '9784478025819');
  assert.equal(r.source, 'page-bare');
});
