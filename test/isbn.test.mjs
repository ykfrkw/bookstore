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
