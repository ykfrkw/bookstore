import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withDefaults,
  validate,
  findDestination,
  destinationLabel,
  createDestination,
} from '../src/core/profile.js';

/** v0.2 までのスキーマ。既に保存済みのユーザーがいるので落とせない */
const legacyProfile = {
  requester: { name: '古川 由己', affiliation: '○○大学', email: 'yuki@example.ac.jp' },
  coop: {
    label: '○○大学生協 書籍部',
    to: 'book@coop.example.ac.jp',
    cc: 'cc@coop.example.ac.jp',
    receiveMethod: '研究室へ配達',
    storeName: '',
    memberNumber: '12345',
  },
  bookstore: {
    label: '地元書店',
    to: 'order@bookstore.example.jp',
    receiveMethod: '店頭受取',
    storeName: '△△書店',
    customerNumber: '999',
  },
  defaults: { route: 'bookstore', fundingMode: 'private' },
};

test('旧プロフィールは destinations 2 件に移行される', () => {
  const p = withDefaults(legacyProfile);
  assert.equal(p.destinations.length, 2);

  const [coop, bookstore] = p.destinations;
  assert.equal(coop.id, 'coop');
  assert.equal(coop.kind, 'coop');
  assert.equal(coop.label, '○○大学生協 書籍部');
  assert.equal(coop.to, 'book@coop.example.ac.jp');
  assert.equal(coop.cc, 'cc@coop.example.ac.jp');
  assert.equal(coop.memberNumber, '12345'); // 組合員番号を memberNumber に統合

  assert.equal(bookstore.id, 'bookstore');
  assert.equal(bookstore.kind, 'bookstore');
  assert.equal(bookstore.label, '△△書店'); // 店名を表示名に採る
  assert.equal(bookstore.memberNumber, '999'); // 旧 customerNumber も memberNumber へ
});

test('旧 defaults.route がそのまま defaults.destinationId になる', () => {
  const p = withDefaults(legacyProfile);
  assert.equal(p.defaults.destinationId, 'bookstore');
  assert.equal(p.defaults.fundingMode, 'private');
  assert.equal(p.defaults.route, undefined); // 旧キーは残さない
});

test('withDefaults は冪等（変換後をもう一度通しても同じ）', () => {
  const once = withDefaults(legacyProfile);
  assert.deepEqual(withDefaults(once), once);
});

test('空の旧プロフィールからは宛先が生成されない', () => {
  assert.deepEqual(withDefaults({}).destinations, []);
  assert.deepEqual(withDefaults(undefined).destinations, []);
  // 既定値のまま中身が空の枠も宛先にしない
  const blank = { coop: { label: '', to: '', storeName: '' }, bookstore: { to: '' } };
  assert.deepEqual(withDefaults(blank).destinations, []);
});

test('destinations があれば旧キーからは変換しない', () => {
  const mixed = { ...legacyProfile, destinations: [createDestination('coop')] };
  assert.equal(withDefaults(mixed).destinations.length, 1);
});

test('findDestination: id 一致 → 既定 → 先頭 → null', () => {
  const p = withDefaults(legacyProfile);
  assert.equal(findDestination(p, 'coop').id, 'coop');
  // 未知の id は既定の宛先（defaults.destinationId）に落ちる
  assert.equal(findDestination(p, 'unknown').id, 'bookstore');
  // 既定も解決できなければ先頭
  const noDefault = withDefaults({ ...p, defaults: { ...p.defaults, destinationId: '' } });
  assert.equal(findDestination(noDefault, 'unknown').id, 'coop');
  assert.equal(findDestination(withDefaults({}), 'coop'), null);
});

test('destinationLabel は種別を添える', () => {
  const p = withDefaults(legacyProfile);
  assert.equal(destinationLabel(p.destinations[0]), '○○大学生協 書籍部（生協）');
  assert.equal(destinationLabel(p.destinations[1]), '△△書店（書店）');
  assert.equal(destinationLabel(createDestination('coop')), '(名称未設定)（生協）');
  assert.equal(destinationLabel(null), '');
});

test('createDestination は種別ごとの既定の受取方法を持ち、id が衝突しない', () => {
  assert.equal(createDestination('coop').receiveMethod, '研究室へ配達');
  assert.equal(createDestination('bookstore').receiveMethod, '店頭受取');
  assert.notEqual(createDestination('coop').id, createDestination('coop').id);
});

test('validate: 揃っていれば空', () => {
  assert.deepEqual(validate(withDefaults(legacyProfile), 'coop'), []);
});

test('validate: 依頼者が空で宛先も未登録なら全部返す', () => {
  assert.deepEqual(validate(withDefaults({}), ''), [
    '氏名',
    '所属',
    'メールアドレス',
    '注文先',
  ]);
});

test('validate: 宛先が 1 件も無ければ 注文先', () => {
  const p = withDefaults({ requester: legacyProfile.requester });
  assert.deepEqual(validate(p, 'coop'), ['注文先']);
});

test('validate: 解決した宛先の to が空なら 宛先メール', () => {
  const p = withDefaults({
    requester: legacyProfile.requester,
    destinations: [{ ...createDestination('bookstore'), id: 'bs', label: '△△書店', to: '' }],
  });
  assert.deepEqual(validate(p, 'bs'), ['宛先メール']);
});
