import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOrder, fundingLabel, remarksLine, buildMailto, MAILTO_SAFE_LENGTH } from '../src/core/compose.js';
import { withDefaults } from '../src/core/profile.js';

const profile = withDefaults({
  requester: {
    name: '古川 由己',
    affiliation: '○○大学 医学部 精神医学教室',
    email: 'yuki@example.ac.jp',
    phone: '03-0000-0000',
    deliveryPlace: '医学部本館 3F 305号室',
  },
  destinations: [
    {
      id: 'coop',
      kind: 'coop',
      label: '○○大学生協 書籍部',
      to: 'book@coop.example.ac.jp',
      cc: '',
      receiveMethod: '研究室へ配達',
      storeName: '',
      memberNumber: '12345',
    },
    {
      id: 'bs',
      kind: 'bookstore',
      label: '△△書店',
      to: 'order@bookstore.example.jp',
      cc: '',
      receiveMethod: '店頭受取',
      storeName: '',
      memberNumber: '',
    },
  ],
  fundingSources: [
    { id: 'kaken', label: '科研費 基盤(C)', code: '00X00000', representative: '古川 由己' },
  ],
  defaults: { destinationId: 'coop' },
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
  const d = composeOrder({ destinationId: 'coop', items, profile, fundingMode: 'research', fundingSourceId: 'kaken' });
  assert.equal(d.to, 'book@coop.example.ac.jp');
  assert.match(d.subject, /研究費/);
  assert.match(d.body, /科研費 基盤\(C\)/);
  assert.match(d.body, /課題番号 00X00000/);
  assert.match(d.body, /予算代表者: 古川 由己/);
  assert.match(d.body, /ISBN: 9784003100011/);
  assert.match(d.body, /冊数: 2/);
  assert.match(d.body, /医学部本館 3F 305号室/);
  assert.match(d.body, /組合員番号: 12345/);
});

test('私費では課題番号を出さない', () => {
  const d = composeOrder({ destinationId: 'coop', items, profile, fundingMode: 'private' });
  assert.match(d.body, /支払区分: 私費/);
  assert.ok(!d.body.includes('00X00000'));
  assert.ok(!d.body.includes('予算代表者'));
});

test('書店の宛先では支払区分・財源・備考を出さず、宛先が書店になる', () => {
  const d = composeOrder({ destinationId: 'bs', items, profile, fundingMode: 'research', fundingSourceId: 'kaken' });
  assert.equal(d.to, 'order@bookstore.example.jp');
  assert.ok(!d.body.includes('支払区分'));
  assert.ok(!d.body.includes('科研費 基盤(C)'));
  assert.ok(!d.body.includes('予算代表者'));
  assert.match(d.body, /△△書店 御中/);
  assert.match(d.body, /店頭受取/);
  assert.equal(d.remarks, '');
});

test('会員番号は書店の宛先では「会員番号」と呼ぶ', () => {
  const withNumber = withDefaults({
    ...profile,
    destinations: profile.destinations.map((x) => (x.id === 'bs' ? { ...x, memberNumber: '999' } : x)),
  });
  const d = composeOrder({ destinationId: 'bs', items, profile: withNumber });
  assert.match(d.body, /会員番号: 999/);
  assert.ok(!d.body.includes('組合員番号'));
});

test('宛先未登録でも例外にならず、宛先が空の下書きを返す', () => {
  const empty = withDefaults({ requester: { name: '古川 由己' } });
  const d = composeOrder({ destinationId: '', items, profile: empty });
  assert.equal(d.to, '');
  assert.equal(d.cc, '');
  assert.ok(d.body.includes('テスト書名'));
  assert.equal(d.remarks, ''); // 種別不明なので生協扱いにしない
});

test('複数冊の合計と概算金額が出る', () => {
  const two = [...items, { book: { isbn13: '9784003100028', title: '二冊目', price: 1000 }, quantity: 1 }];
  const d = composeOrder({ destinationId: 'coop', items: two, profile });
  assert.match(d.body, /合計 2点 \/ 3冊/);
  assert.match(d.body, /¥6,720/); // 2860*2 + 1000
});

test('価格不明の書籍があると但し書きが付く', () => {
  const mixed = [...items, { book: { isbn13: '9784003100028', title: '価格不明', price: null }, quantity: 1 }];
  const d = composeOrder({ destinationId: 'coop', items: mixed, profile });
  assert.match(d.body, /価格不明の書籍を除く/);
});

test('未知の宛先 id は既定の宛先に落ちる', () => {
  const d = composeOrder({ destinationId: 'unknown', items, profile });
  assert.equal(d.to, 'book@coop.example.ac.jp');
});

test('mailto を組み立てる', () => {
  const d = composeOrder({ destinationId: 'coop', items, profile });
  assert.ok(d.mailto.startsWith('mailto:book%40coop.example.ac.jp?'));
  assert.ok(d.mailto.includes('body='));
  assert.ok(!d.mailtoHeaderOnly.includes('body='));
  assert.match(d.plain, /^To: book@coop\.example\.ac\.jp\nSubject: /);
});

test('和文の注文メールは 1 冊でも mailto 長制限を超えるので、必ず退避経路が要る', () => {
  // 日本語 1 文字がパーセントエンコードで 9 文字になるため、現実的にはほぼ常に超える。
  // ここが false に変わったら UI 側の分岐（コピー + 件名だけの mailto）を見直すこと。
  const d = composeOrder({ destinationId: 'coop', items, profile });
  assert.equal(d.tooLongForMailto, true);
  assert.ok(d.encodedLength > MAILTO_SAFE_LENGTH);
  assert.ok(d.mailtoHeaderOnly.length < MAILTO_SAFE_LENGTH);
});

test('buildMailto: 短い ASCII 本文は mailto に収まる', () => {
  const d = buildMailto({ to: 'a@example.com', cc: 'cc@example.com', subject: 'Sub', body: 'short body' });
  assert.equal(d.tooLongForMailto, false);
  assert.ok(d.mailto.startsWith('mailto:a%40example.com?'));
  assert.ok(d.mailto.includes('body='));
  assert.ok(d.mailto.includes('cc='));
  assert.ok(!d.mailtoHeaderOnly.includes('body='));
  assert.ok(d.mailtoHeaderOnly.includes('cc='));
  assert.equal(d.encodedLength, d.mailto.length);
  assert.equal(d.plain, 'To: a@example.com\nSubject: Sub\n\nshort body');
});

test('buildMailto: 長い和文本文では tooLongForMailto になり、header-only は短いまま', () => {
  const d = buildMailto({ to: 'a@example.com', subject: '件名', body: 'あ'.repeat(400) });
  assert.equal(d.tooLongForMailto, true);
  assert.ok(d.encodedLength > MAILTO_SAFE_LENGTH);
  assert.ok(d.mailtoHeaderOnly.length < MAILTO_SAFE_LENGTH);
  assert.ok(!d.mailtoHeaderOnly.includes('cc=')); // cc 未指定なら付けない
});

test('buildMailto: composeOrder の mailto と一致する（実装が一本化されている）', () => {
  const d = composeOrder({ destinationId: 'coop', items, profile });
  const m = buildMailto({ to: d.to, cc: d.cc, subject: d.subject, body: d.body });
  assert.equal(m.mailto, d.mailto);
  assert.equal(m.mailtoHeaderOnly, d.mailtoHeaderOnly);
  assert.equal(m.tooLongForMailto, d.tooLongForMailto);
  assert.equal(m.plain, d.plain);
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
