import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOrder, fundingLabel, remarksLine, MAILTO_SAFE_LENGTH } from '../src/core/compose.js';
import { withDefaults, validate } from '../src/core/profile.js';

const profile = withDefaults({
  requester: {
    name: '古川 由己',
    affiliation: '○○大学 医学部 精神医学教室',
    email: 'yuki@example.ac.jp',
    phone: '03-0000-0000',
    deliveryPlace: '医学部本館 3F 305号室',
  },
  coop: { label: '○○大学生協 書籍部', to: 'book@coop.example.ac.jp', receiveMethod: '研究室へ配達' },
  bookstore: { storeName: '△△書店', to: 'order@bookstore.example.jp', receiveMethod: '店頭受取' },
  fundingSources: [
    { id: 'kaken', label: '科研費 基盤(C)', code: '00X00000', representative: '古川 由己' },
  ],
});

const items = [
  {
    book: {
      isbn13: '9784003100011',
      title: 'テスト書名',
      author: 'テスト著者',
      publisher: '岩波書店',
      pubdate: '2024-01',
      price: 2860,
    },
    quantity: 2,
  },
];

test('生協・研究費の文面に財源と予算代表者が入る', () => {
  const d = composeOrder({ route: 'coop', items, profile, fundingMode: 'research', fundingSourceId: 'kaken' });
  assert.equal(d.to, 'book@coop.example.ac.jp');
  assert.match(d.subject, /研究費/);
  assert.match(d.body, /科研費 基盤\(C\)/);
  assert.match(d.body, /課題番号 00X00000/);
  assert.match(d.body, /予算代表者: 古川 由己/);
  assert.match(d.body, /ISBN: 9784003100011/);
  assert.match(d.body, /冊数: 2/);
  assert.match(d.body, /医学部本館 3F 305号室/);
});

test('私費では課題番号を出さない', () => {
  const d = composeOrder({ route: 'coop', items, profile, fundingMode: 'private' });
  assert.match(d.body, /支払区分: 私費/);
  assert.ok(!d.body.includes('00X00000'));
  assert.ok(!d.body.includes('予算代表者'));
});

test('書店ルートでは支払区分を出さず、宛先が書店になる', () => {
  const d = composeOrder({ route: 'bookstore', items, profile });
  assert.equal(d.to, 'order@bookstore.example.jp');
  assert.ok(!d.body.includes('支払区分'));
  assert.match(d.body, /△△書店 御中/);
  assert.match(d.body, /店頭受取/);
  assert.equal(d.remarks, '');
});

test('複数冊の合計と概算金額が出る', () => {
  const two = [...items, { book: { isbn13: '9784003100028', title: '二冊目', price: 1000 }, quantity: 1 }];
  const d = composeOrder({ route: 'coop', items: two, profile });
  assert.match(d.body, /合計 2点 \/ 3冊/);
  assert.match(d.body, /¥6,720/); // 2860*2 + 1000
});

test('価格不明の書籍があると但し書きが付く', () => {
  const mixed = [...items, { book: { isbn13: '9784003100028', title: '価格不明', price: null }, quantity: 1 }];
  const d = composeOrder({ route: 'coop', items: mixed, profile });
  assert.match(d.body, /価格不明の書籍を除く/);
});

test('mailto を組み立てる', () => {
  const d = composeOrder({ route: 'coop', items, profile });
  assert.ok(d.mailto.startsWith('mailto:book%40coop.example.ac.jp?'));
  assert.ok(d.mailto.includes('body='));
  assert.ok(!d.mailtoHeaderOnly.includes('body='));
  assert.match(d.plain, /^To: book@coop\.example\.ac\.jp\nSubject: /);
});

test('和文の注文メールは 1 冊でも mailto 長制限を超えるので、必ず退避経路が要る', () => {
  // 日本語 1 文字がパーセントエンコードで 9 文字になるため、現実的にはほぼ常に超える。
  // ここが false に変わったら UI 側の分岐（コピー + 件名だけの mailto）を見直すこと。
  const d = composeOrder({ route: 'coop', items, profile });
  assert.equal(d.tooLongForMailto, true);
  assert.ok(d.encodedLength > MAILTO_SAFE_LENGTH);
  assert.ok(d.mailtoHeaderOnly.length < MAILTO_SAFE_LENGTH);
});

test('備考欄用の1行', () => {
  const line = remarksLine(profile, { fundingMode: 'research', fundingSourceId: 'kaken' });
  assert.match(line, /研究費（科研費 基盤\(C\) 課題番号 00X00000）/);
  assert.match(line, /予算代表者: 古川 由己/);
  assert.match(line, /配達先: 医学部本館 3F 305号室/);
});

test('財源ラベル', () => {
  assert.equal(fundingLabel(profile, { fundingMode: 'private' }), '私費');
  assert.equal(fundingLabel(profile, { fundingMode: 'research', fundingSourceId: 'none' }), '研究費');
});

test('未入力項目の検出', () => {
  assert.deepEqual(validate(profile, 'coop'), []);
  const empty = withDefaults({});
  assert.deepEqual(validate(empty, 'coop'), ['氏名', '所属', 'メールアドレス', '生協の宛先メール']);
  assert.ok(validate(empty, 'bookstore').includes('書店の宛先メール'));
});
