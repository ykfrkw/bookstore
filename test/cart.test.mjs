import test from 'node:test';
import assert from 'node:assert/strict';
import { clampQty, badgeText } from '../src/core/cart.js';

test('clampQty: 1 未満・非数値はすべて 1 に落ちる', () => {
  // 冊数入力は空欄にでき、number 型でも '-' や 'e' が残ることがある。
  // ここが素通りすると composeOrder に「0冊」の行が入る（誤発注の種）
  for (const input of [0, -1, -99, '', ' ', 'abc', NaN, null, undefined, Infinity, -Infinity]) {
    assert.equal(clampQty(input), 1, `clampQty(${String(input)}) は 1`);
  }
});

test('clampQty: 小数は切り捨て、数字の文字列は数として読む', () => {
  assert.equal(clampQty(2.7), 2);
  assert.equal(clampQty(1.9), 1);
  assert.equal(clampQty('3'), 3);
  assert.equal(clampQty(3), 3);
});

test('badgeText: 空のカートは空文字（"0" のバッジを常駐させない）', () => {
  assert.equal(badgeText([]), '');
});

test('badgeText: カートの点数を返す', () => {
  assert.equal(badgeText([{ quantity: 1 }, { quantity: 1 }]), '2');
});

test('badgeText: undefined / null でも throw せず空文字', () => {
  // storage.onChanged の newValue は remove / clear / サイトデータ削除で
  // undefined になる。ここで throw すると service worker の中なので
  // エラーは SW の DevTools にしか出ず、バッジが黙って止まる
  assert.equal(badgeText(undefined), '');
  assert.equal(badgeText(null), '');
});

test('badgeText: 冊数合計ではなく点数（1 点 5 冊は "1"）', () => {
  // バッジを冊数合計に変えないための固定。既存の唯一の数表示（パネルの
  // トースト「注文リストに追加（N点）」）と同じ数でなければならない
  assert.equal(badgeText([{ quantity: 5 }]), '1');
  assert.equal(badgeText([{ quantity: 5 }, { quantity: 3 }]), '2');
});
