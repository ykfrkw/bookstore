import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeOrder,
  fundingLabel,
  remarksLine,
  buildMailto,
  pickMailPlan,
  MAILTO_SAFE_LENGTH,
} from '../src/core/compose.js';
import { withDefaults } from '../src/core/profile.js';
import { readCode } from './helpers/source.mjs';

const profile = withDefaults({
  requester: {
    name: '山田 太郎',
    affiliation: '○○大学 △△学部 ××研究室',
    email: 'taro@example.ac.jp',
    phone: '03-0000-0000',
    deliveryPlace: '△△棟 3F 305号室',
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
    { id: 'kaken', label: '科研費 基盤(C)', code: '00X00000', representative: '山田 太郎' },
  ],
  defaults: { destinationId: 'coop' },
});

const items = [
  {
    book: {
      isbn13: '9784003100011',
      title: 'テスト書名',
      author: 'テスト 著者',
      publisher: '岩波書店',
      pubdate: '2024-01',
      price: 2860,
      taxBasis: 'included',
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
  assert.match(d.body, /予算代表者: 山田 太郎/);
  assert.match(d.body, /ISBN: 9784003100011/);
  assert.match(d.body, /冊数: 2/);
  assert.match(d.body, /△△棟 3F 305号室/);
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
  const empty = withDefaults({ requester: { name: '山田 太郎' } });
  const d = composeOrder({ destinationId: '', items, profile: empty });
  assert.equal(d.to, '');
  assert.equal(d.cc, '');
  assert.ok(d.body.includes('テスト書名'));
  assert.equal(d.remarks, ''); // 種別不明なので生協扱いにしない
});

test('複数冊の合計と定価合計が出る', () => {
  const two = [
    ...items,
    { book: { isbn13: '9784003100028', title: '二冊目', price: 1000, taxBasis: 'included' }, quantity: 1 },
  ];
  const d = composeOrder({ destinationId: 'coop', items: two, profile });
  assert.match(d.body, /合計 2点 \/ 3冊/);
  assert.match(d.body, /¥6,720/); // 2860*2 + 1000
  assert.match(d.body, /定価合計 ¥6,720（税込）/);
});

test('価格不明の書籍があると但し書きが付く', () => {
  const mixed = [...items, { book: { isbn13: '9784003100028', title: '価格不明', price: null }, quantity: 1 }];
  const d = composeOrder({ destinationId: 'coop', items: mixed, profile });
  // 点数まで書く（簡略版と同じ形）。「除く」が付くのは足した金額があるときだけ
  assert.match(d.body, /価格不明 1点を除く/);
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

test('フル版の和文注文メールは 1 冊でも mailto 長制限を超える（簡略版が要る根拠）', () => {
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
  assert.match(line, /予算代表者: 山田 太郎/);
  assert.match(line, /配達先: △△棟 3F 305号室/);
});

test('財源ラベル', () => {
  assert.equal(fundingLabel(profile, { fundingMode: 'private' }), '私費');
  assert.equal(fundingLabel(profile, { fundingMode: 'research', fundingSourceId: 'none' }), '研究費');
});

/* ------------------------------------------------------------------ *
 * 簡略版（compact）
 *
 * 目的は「本文入り mailto に収めて貼り付けを不要にする」こと。長さの主張は
 * すべて MAILTO_SAFE_LENGTH との不等号で書く。実測値を直接固定すると
 * テンプレートを 1 文字直しただけで落ちるテストになるため。
 * ------------------------------------------------------------------ */

/** 実運用に近い（全項目を埋めた）プロフィール。長さの主張はこれを基準にする */
const filledProfile = withDefaults({
  requester: {
    name: '山田 太郎',
    kana: 'やまだ たろう',
    affiliation: '○○大学 △△学部 ××研究室',
    email: 'taro@example.ac.jp',
    phone: '03-0000-0000',
    deliveryPlace: '△△棟 3F 305号室',
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
      memberNumber: '1234567',
    },
    {
      id: 'bs',
      kind: 'bookstore',
      label: '△△書店',
      to: 'order@bookstore.example.jp',
      cc: '',
      receiveMethod: '店頭受取',
      storeName: '△△書店 本店',
      memberNumber: '',
    },
  ],
  fundingSources: [
    { id: 'kaken', label: '科研費 基盤(C)', code: '00X00000', representative: '山田 太郎' },
  ],
  defaults: { destinationId: 'coop' },
});

/** 和書 1 冊。書名・著者・出版社まで埋まった現実的な書誌 */
const oneBook = [
  {
    book: {
      isbn13: '9784840488235',
      title: '精神科診療のためのガイドブック',
      author: 'テスト 著者',
      publisher: 'メディカ出版',
      pubdate: '2024-03',
      price: 3850,
      taxBasis: 'included',
    },
    quantity: 1,
  },
];

const coopArgs = {
  destinationId: 'coop',
  items: oneBook,
  profile: filledProfile,
  fundingMode: 'research',
  fundingSourceId: 'kaken',
};

/**
 * 簡略版に残しておくべき余裕（encoded の文字数）。
 * 「収まる／収まらない」だけを見ていると、テンプレートを数十字伸ばしても
 * テストは通るのに複数点の注文が黙ってコピー経路へ落ちる。SPEC と profile.js の
 * 「ここを長くするな」という警告を実行可能にするための下限。
 */
const COMPACT_MIN_HEADROOM = 300;

test('生協・和書 1 冊: フル版は mailto に収まらないが簡略版は収まる', () => {
  const full = composeOrder(coopArgs);
  const compact = composeOrder({ ...coopArgs, compact: true });
  assert.equal(full.tooLongForMailto, true);
  assert.ok(full.encodedLength > MAILTO_SAFE_LENGTH);
  assert.equal(compact.tooLongForMailto, false);
  assert.ok(compact.encodedLength < MAILTO_SAFE_LENGTH);
  // 収まるだけでなく余裕も残っていること（テンプレートを伸ばしすぎたら落とす）
  assert.ok(
    compact.encodedLength < MAILTO_SAFE_LENGTH - COMPACT_MIN_HEADROOM,
    `簡略版の余裕が ${MAILTO_SAFE_LENGTH - compact.encodedLength} 字しかない`
  );
  // 縮んでいることも押さえる（同じ本文を返す実装ミスを弾く）
  assert.ok(compact.body.length < full.body.length);
});

test('書店・和書 1 冊でも簡略版は mailto に収まる', () => {
  const args = { destinationId: 'bs', items: oneBook, profile: filledProfile };
  const full = composeOrder(args);
  const compact = composeOrder({ ...args, compact: true });
  assert.equal(full.tooLongForMailto, true);
  assert.equal(compact.tooLongForMailto, false);
  assert.ok(compact.encodedLength < MAILTO_SAFE_LENGTH - COMPACT_MIN_HEADROOM);
});

test('簡略版でも書名と ISBN は必ず残る（誤発注に気づける唯一の手がかり）', () => {
  const compact = composeOrder({ ...coopArgs, compact: true });
  assert.ok(compact.body.includes('精神科診療のためのガイドブック'));
  assert.ok(compact.body.includes('9784840488235'));
  assert.match(compact.body, /1冊/);
});

test('簡略版は著者・出版社・罫線・■ を落とす', () => {
  const compact = composeOrder({ ...coopArgs, compact: true });
  // 検査したい挙動は「著者行を落とすこと」。名前ではなくラベルで書けば
  // fixture の人名が何であれ壊れない（`予算代表者:` は `著者:` を含まない）
  assert.ok(!compact.body.includes('著者:'));
  assert.ok(!compact.body.includes('メディカ出版'));
  assert.ok(!compact.body.includes('2024-03'));
  assert.ok(!compact.body.includes('----'));
  assert.ok(!compact.body.includes('■'));
  // フル版の合計行（`合計 N点 / M冊 …`）は出ない。簡略版の合計行は `計 …` で
  // 始まる別の行で、2 点以上のときだけ出る（下の「簡略版は 2 点以上なら…」）
  assert.ok(!/^合計 /m.test(compact.body));
});

/** 価格が入っている 2 冊目。合計行の検査で 1 冊目（¥3,850）と足し合わせる */
const secondBook = {
  book: {
    isbn13: '9784260042116',
    title: 'テスト書名 第2巻',
    price: 2200,
    taxBasis: 'included',
  },
  quantity: 2,
};

/** 価格不明の 1 冊。openBD にも Amazon にも価格が無い新刊で普通に起きる */
const pricelessBook = {
  book: { isbn13: '9784758109123', title: 'テスト書名 第3巻', price: null, taxBasis: 'unknown' },
  quantity: 1,
};

/** 簡略版の合計行（`計 …` で始まる行）だけを取り出す。無ければ undefined */
const compactTotalOf = (items) =>
  composeOrder({ ...coopArgs, items, compact: true })
    .body.split('\n')
    .find((line) => line.startsWith('計 '));

test('簡略版は 2 点以上なら合計行を出す', () => {
  // 簡略版が使われるのは 1〜3 点。ここを落とすと「2〜3 点の注文にだけ合計が
  // 無い」状態になり、受け取った側も出した側も金額を数え直すことになる
  assert.equal(compactTotalOf([...oneBook, secondBook]), '計 2点 3冊 定価合計 ¥8,250（税込）');
  assert.equal(
    compactTotalOf([...oneBook, secondBook, pricelessBook]),
    '計 3点 4冊 定価合計 ¥8,250（税込）（価格不明 1点を除く）'
  );
  // 1 点 1 冊では出さない。書名行に価格が出ているので同じ数字の繰り返しになる
  assert.equal(compactTotalOf(oneBook), undefined);
});

test('簡略版は 1 点でも 2 冊以上なら合計行を出す（単価と総額が違うため）', () => {
  // 簡略版の書名行は『書名』 3冊 ¥3,850 の形で、¥ は単価。冊数が 2 以上だと
  // 総額は単価と違う数字になるのに、簡略版にはフル版の `定価` / `冊数` /
  // `定価合計` のようなラベルが無いので、本文に現れる唯一の金額を総額と読まれる。
  // 生協が単価で予算計上すれば差額が後から出る（研究費の執行事故）
  const threeCopies = [{ ...oneBook[0], quantity: 3 }];
  assert.equal(compactTotalOf(threeCopies), '計 1点 3冊 定価合計 ¥11,550（税込）');

  // 単価 × 冊数であること自体を書名行から取り直して確かめる。期待値を
  // 直書きするだけだと、単価と冊数のどちらを間違えても気づけない
  const unitPrice = oneBook[0].book.price;
  assert.equal(unitPrice * 3, 11550);
  const body = composeOrder({ ...coopArgs, items: threeCopies, compact: true }).body;
  assert.match(body, /3冊 ¥3,850/); // 書名行に出るのは単価
  assert.match(body, /定価合計 ¥11,550/); // 合計行に出るのは総額

  // 価格不明でも冊数が 2 以上なら「何冊の注文か」だけは残す
  const priceless3 = [{ ...oneBook[0], book: { ...oneBook[0].book, price: null }, quantity: 3 }];
  assert.equal(compactTotalOf(priceless3), '計 1点 3冊（価格不明 1点）');
});

test('簡略版の合計行は価格不明の点数を必ず書く', () => {
  // 分かる分だけ足した額を黙って出すと、その額で予算が足りると読まれる。
  // 誤発注は研究費の執行事故になるので、不明があることを本文に残す
  const partial = compactTotalOf([...oneBook, pricelessBook]);
  assert.match(partial, /価格不明 1点を除く/);
  assert.match(partial, /定価合計 ¥3,850/);
  // 全点が不明なら金額を出さず、不明の点数だけを残す（「を除く」も付けない）
  const none = compactTotalOf([pricelessBook, { ...pricelessBook, quantity: 2 }]);
  assert.equal(none, '計 2点 3冊（価格不明 2点）');
});

test('合計行を足しても 2 点の簡略版は mailto に収まる', () => {
  // 合計行は encoded で 75 字（注記が付くと 169 字）を食う。簡略版が
  // 収まらなくなると、2 点の注文が黙ってコピー経路（貼り付けが要る）に落ちる
  const compact = composeOrder({
    ...coopArgs,
    items: [...oneBook, secondBook],
    compact: true,
  });
  assert.equal(compact.tooLongForMailto, false);
  assert.ok(
    compact.encodedLength < MAILTO_SAFE_LENGTH,
    `2 点の簡略版が ${compact.encodedLength} 字で収まらない`
  );
});

/** taxBasis だけを差し替えた 1 点。明細行のラベルの検査に使う */
const taxedOne = (taxBasis) => [
  { ...oneBook[0], book: { ...oneBook[0].book, taxBasis } },
];

/** 税区分だけを差し替えた 2 点。¥3,850 ×1 と ¥2,200 ×2 で定価合計 ¥8,250 */
const taxedTwo = (firstBasis, secondBasis) => [
  { ...oneBook[0], book: { ...oneBook[0].book, taxBasis: firstBasis } },
  { ...secondBook, book: { ...secondBook.book, taxBasis: secondBasis } },
];

/** フル版の明細行（`定価:` の行）。前後の空白は落として比べる */
const priceLineOf = (items) =>
  composeOrder({ ...coopArgs, items })
    .body.split('\n')
    .find((line) => line.trim().startsWith('定価:'))
    .trim();

/** フル版の合計行（`合計 ` で始まる行） */
const summaryOf = (items) =>
  composeOrder({ ...coopArgs, items })
    .body.split('\n')
    .find((line) => line.startsWith('合計 '));

test('明細行の税区分ラベルは taxBasis どおりに出る', () => {
  // openBD の PriceType を見ずに拾った数字を「（税込）」と称していたのが元のバグ。
  // 税抜の本体価格を税込と書けば、研究費の執行で 10% の差が後から出る
  assert.equal(priceLineOf(taxedOne('included')), '定価: ¥3,850（税込）');
  assert.equal(priceLineOf(taxedOne('excluded')), '定価: ¥3,850（税抜）');
});

test('税区分が不明な明細行にはラベルを付けない', () => {
  // 分からないものに「（税込）」と書けば、推測ではなく誤りとして相手に届く
  assert.equal(priceLineOf(taxedOne('unknown')), '定価: ¥3,850');
  // taxBasis を持たない旧データでも同じ（（undefined）を出さない）
  assert.equal(priceLineOf(taxedOne(undefined)), '定価: ¥3,850');
});

/** 簡略版の書名行（`『` で始まる行）だけを取り出す */
const compactTitleLinesOf = (items) =>
  composeOrder({ ...coopArgs, items, compact: true })
    .body.split('\n')
    .filter((line) => line.startsWith('『'));

test('簡略版で合計行が出ないときは、税区分を書名行に添える', () => {
  // 1 点 1 冊では合計行が出ない（単価と総額が同じ数字になるため）。
  // そこで書名行にも税区分が無いと、税抜か税込か分からない金額が
  // 本文にただ 1 つ載ることになる。出典が 0 箇所になるのを防ぐ
  assert.deepEqual(compactTitleLinesOf(taxedOne('included')), [
    '『精神科診療のためのガイドブック』 1冊 ¥3,850（税込）',
  ]);
  assert.deepEqual(compactTitleLinesOf(taxedOne('excluded')), [
    '『精神科診療のためのガイドブック』 1冊 ¥3,850（税抜）',
  ]);
  // 不明なら添えない（推測を書かない方針は明細行と同じ）
  assert.deepEqual(compactTitleLinesOf(taxedOne('unknown')), ['『精神科診療のためのガイドブック』 1冊 ¥3,850']);
});

test('簡略版で合計行が出るときは、書名行に税区分を重ねない', () => {
  // 合計行が税区分を担うので、行ごとに繰り返すと冗長なうえ長さを食う
  const lines = compactTitleLinesOf(taxedTwo('included', 'included'));
  for (const line of lines) assert.ok(!line.includes('（税込）'), line);
  assert.match(compactTotalOf(taxedTwo('included', 'included')), /（税込）$/);
});

test('価格そのものが不明なら税区分ラベルも付かない', () => {
  assert.equal(priceLineOf([pricelessBook]), '定価: —');
});

test('合計行は「概算」ではなく「定価合計」（フル版・簡略版とも）', () => {
  // 生協は組合員価格で割引があるのが普通なので、定価の和は請求額ではない。
  // 「合計」と書くと請求額として読まれ、差額が後から出る。数字の正体を名前にする
  const two = taxedTwo('included', 'included');
  assert.match(summaryOf(two), /定価合計 ¥8,250/);
  assert.ok(!composeOrder({ ...coopArgs, items: two }).body.includes('概算'));
  assert.ok(!composeOrder({ ...coopArgs, items: two, compact: true }).body.includes('概算'));
});

test('全点が同じ税区分なら合計行にもその区分が出る', () => {
  assert.equal(summaryOf(taxedTwo('excluded', 'excluded')), '合計 2点 / 3冊 / 定価合計 ¥8,250（税抜）');
  assert.equal(summaryOf(taxedTwo('included', 'included')), '合計 2点 / 3冊 / 定価合計 ¥8,250（税込）');
  assert.equal(compactTotalOf(taxedTwo('excluded', 'excluded')), '計 2点 3冊 定価合計 ¥8,250（税抜）');
});

test('税区分が全点不明なら合計行にも区分を出さない', () => {
  assert.equal(summaryOf(taxedTwo('unknown', 'unknown')), '合計 2点 / 3冊 / 定価合計 ¥8,250');
  assert.equal(compactTotalOf(taxedTwo('unknown', 'unknown')), '計 2点 3冊 定価合計 ¥8,250');
});

test('税抜と税込が混ざったら合計行にその旨を出す', () => {
  // 黙って足すのが一番まずい。足した数字がどちらの額なのか誰にも分からない
  assert.equal(
    summaryOf(taxedTwo('excluded', 'included')),
    '合計 2点 / 3冊 / 定価合計 ¥8,250（税抜・税込が混在）'
  );
  assert.equal(
    compactTotalOf(taxedTwo('excluded', 'included')),
    '計 2点 3冊 定価合計 ¥8,250（税抜・税込が混在）'
  );
  // 並べる順は税抜・税込の登場順に依存しない
  assert.equal(
    summaryOf(taxedTwo('included', 'excluded')),
    '合計 2点 / 3冊 / 定価合計 ¥8,250（税抜・税込が混在）'
  );
});

test('税区分不明が混ざる場合も混在として書く（税込・税抜に寄せない）', () => {
  // 不明をどちらかに寄せて数えると、寄せた事実が本文のどこにも残らない
  assert.equal(
    summaryOf(taxedTwo('excluded', 'unknown')),
    '合計 2点 / 3冊 / 定価合計 ¥8,250（税抜・税区分不明が混在）'
  );
  assert.equal(
    compactTotalOf(taxedTwo('included', 'unknown')),
    '計 2点 3冊 定価合計 ¥8,250（税込・税区分不明が混在）'
  );
});

test('税区分の注記と価格不明の注記は併記しても破綻しない', () => {
  const mixedWithPriceless = [...taxedTwo('excluded', 'included'), pricelessBook];
  assert.equal(
    summaryOf(mixedWithPriceless),
    '合計 3点 / 4冊 / 定価合計 ¥8,250（税抜・税込が混在）（価格不明 1点を除く）'
  );
  assert.equal(
    compactTotalOf(mixedWithPriceless),
    '計 3点 4冊 定価合計 ¥8,250（税抜・税込が混在）（価格不明 1点を除く）'
  );
  // 価格が 1 点も分からなければ金額を出さないので、税区分の注記も出ない
  assert.equal(
    compactTotalOf([pricelessBook, { ...pricelessBook, quantity: 2 }]),
    '計 2点 3冊（価格不明 2点）'
  );
});

test('簡略版の書名行は旧データ（taxBasis なし）でもラベルを出さない', () => {
  // v0.5.0 までに保存されたカートの Book は taxBasis を持たない。popup.js は
  // loadCart() の結果をそのまま composeOrder に渡す（mergeFallback を通さない）
  // ので、undefined がここまで届く。「（undefined）」を書かないことを固定する
  assert.deepEqual(compactTitleLinesOf(taxedOne(undefined)), [
    '『精神科診療のためのガイドブック』 1冊 ¥3,850',
  ]);
});

test('知らない税区分の文字列は落とさず「不明」として数える', () => {
  // TAX_ORDER に無い値を集合から消すと、残りが 1 つになって合計行が単一区分を
  // 断言する（税抜の本と混ざっているのに `（税抜）` になる）。混在の事実を残す
  assert.equal(
    summaryOf(taxedTwo('excluded', 'incl')),
    '合計 2点 / 3冊 / 定価合計 ¥8,250（税抜・税区分不明が混在）'
  );
  assert.equal(
    compactTotalOf(taxedTwo('excluded', 'incl')),
    '計 2点 3冊 定価合計 ¥8,250（税抜・税区分不明が混在）'
  );
  // 旧データの undefined も同じ扱い（片方だけ丸めて他方を落とす、が起きない）
  assert.equal(
    summaryOf(taxedTwo('included', undefined)),
    '合計 2点 / 3冊 / 定価合計 ¥8,250（税込・税区分不明が混在）'
  );
  // 全点が知らない値なら「全点不明」と同じ。区分は出さない
  assert.equal(summaryOf(taxedTwo('incl', 'incl')), '合計 2点 / 3冊 / 定価合計 ¥8,250');
});

test('フル版も全点が価格不明なら「価格不明」を必ず書く', () => {
  // 但し書きを定価合計の内側に置くと、全点不明で amount が 0 になったときに
  // total ごと消え、「価格不明」の語が本文から 1 つも無くなる。フル版は
  // コピー経路で実際に送られる本文なので、そこで黙るのが一番まずい
  const allUnknown = [pricelessBook, { ...pricelessBook, quantity: 2 }];
  assert.equal(summaryOf(allUnknown), '合計 2点 / 3冊（価格不明 2点）');
  // 簡略版と同じ構造（金額があるときだけ「を除く」が付く）
  assert.equal(compactTotalOf(allUnknown), '計 2点 3冊（価格不明 2点）');
  assert.match(summaryOf([...oneBook, pricelessBook]), /（価格不明 1点を除く）$/);

  // 本文全体でも「価格不明」に触れていることを見る（合計行の抽出漏れ防止）
  const body = composeOrder({ ...coopArgs, items: allUnknown }).body;
  assert.match(body, /価格不明/);
});

/**
 * 簡略版の本文に現れる税区分の「出典」の数。
 * `（税抜・税区分不明が混在）` は `（税抜）` にはマッチしない（閉じ括弧が違う）
 * ので、混在は `が混在` の 1 回だけ数えられる。
 */
const taxMentionCount = (body) => (body.match(/（税込）|（税抜）|が混在/g) || []).length;

test('簡略版の税区分の出典はちょうど 1 箇所（不明・価格不明なら 0 箇所）', () => {
  // withTaxLabel は「合計行が出ないとき」という条件に依存している。閾値を
  // 片方だけ変えると、2 箇所に出る／0 箇所になるのどちらかが黙って起きる。
  // 点数 × 冊数 × 税区分の組で不変条件そのものを回す
  const BASES = ['included', 'excluded', 'unknown', undefined];
  const bookOf = (taxBasis, price) => ({
    ...oneBook[0].book,
    taxBasis,
    price,
  });
  // 正規化後に税込・税抜のどちらかを名乗れる点が 1 つでもあれば出典は 1 箇所
  const namesTax = (basis) => basis === 'included' || basis === 'excluded';

  let cases = 0;
  for (const first of BASES) {
    for (const firstPrice of [3850, null]) {
      for (const quantity of [1, 2, 3]) {
        const single = [{ book: bookOf(first, firstPrice), quantity }];
        const expected = firstPrice != null && namesTax(first) ? 1 : 0;
        const body = composeOrder({ ...coopArgs, items: single, compact: true }).body;
        assert.equal(taxMentionCount(body), expected, `1点 ${first} ${firstPrice} ×${quantity}`);
        cases += 1;

        for (const second of BASES) {
          for (const secondPrice of [2200, null]) {
            const two = [
              { book: bookOf(first, firstPrice), quantity },
              { book: { ...secondBook.book, taxBasis: second, price: secondPrice }, quantity: 1 },
            ];
            const priced = [
              firstPrice != null && namesTax(first),
              secondPrice != null && namesTax(second),
            ];
            const twoBody = composeOrder({ ...coopArgs, items: two, compact: true }).body;
            assert.equal(
              taxMentionCount(twoBody),
              priced.some(Boolean) ? 1 : 0,
              `2点 ${first}/${second} ${firstPrice}/${secondPrice} ×${quantity}`
            );
            cases += 1;
          }
        }
      }
    }
  }
  // 組み合わせが痩せたら（fixture を触って for が回らなくなったら）気づけるように
  assert.equal(cases, 4 * 2 * 3 * (1 + 4 * 2));
});

test('税抜から税込を計算していない（税率の係数がソースに無い）', () => {
  // 税率をコードに埋めると税制改正で腐るうえ、軽減税率の判定まで抱え込む。
  // こちらの仕事はどちらの数字かを正しく伝えることであって、換算ではない
  const rateLike = [/1\.1\b/, /1\.10\b/, /1\.08\b/, /0\.1\b/, /0\.08\b/, /\btax(Rate|_rate)\b/i];
  for (const path of ['src/core/mail-body.js', 'src/core/bibliography.js', 'src/core/compose.js']) {
    const code = readCode(path);
    for (const pattern of rateLike) {
      assert.ok(!pattern.test(code), `${path} に税率らしき係数がある: ${pattern}`);
    }
  }
});

test('簡略版でも組合員番号・会員番号は落とさない（非空なら入る）', () => {
  // 既定は空の任意項目。埋まっているのは「自分の生協・書店がこの番号を求める」
  // という利用者の明示的な入力なので、簡略版で黙って落とすと注文が通らなくなる
  const coop = composeOrder({ ...coopArgs, compact: true });
  assert.match(coop.body, /組合員番号: 1234567/);
  assert.equal(coop.tooLongForMailto, false);

  // 書店では呼び名が変わる（フル版と同じ規則）
  const withNumber = withDefaults({
    ...filledProfile,
    destinations: filledProfile.destinations.map((x) =>
      x.id === 'bs' ? { ...x, memberNumber: '999' } : x
    ),
  });
  const store = composeOrder({
    destinationId: 'bs',
    items: oneBook,
    profile: withNumber,
    compact: true,
  });
  assert.match(store.body, /会員番号: 999/);
  assert.ok(!store.body.includes('組合員番号'));

  // 空なら行ごと出さない（「会員番号: 」だけが残る空行を作らない）
  const noNumber = composeOrder({
    destinationId: 'bs',
    items: oneBook,
    profile: filledProfile,
    compact: true,
  });
  assert.ok(!noNumber.body.includes('会員番号'));
});

test('簡略版でも生協なら財源と予算代表者が入り、書店では入らない', () => {
  const coop = composeOrder({ ...coopArgs, compact: true });
  assert.match(coop.body, /支払: 研究費（科研費 基盤\(C\) 課題番号 00X00000）/);
  assert.match(coop.body, /予算代表者: 山田 太郎/);
  assert.match(coop.body, /配達: △△棟 3F 305号室/);

  const store = composeOrder({
    destinationId: 'bs',
    items: oneBook,
    profile: filledProfile,
    compact: true,
  });
  assert.ok(!store.body.includes('支払:'));
  assert.ok(!store.body.includes('科研費 基盤(C)'));
  assert.ok(!store.body.includes('予算代表者'));
  // 受取店舗は独立行にせず受取方法に括弧で添える
  assert.match(store.body, /受取: 店頭受取（△△書店 本店）/);
});

test('簡略版でも remarks の中身は変わらない（備考欄は本文と独立）', () => {
  const full = composeOrder(coopArgs);
  const compact = composeOrder({ ...coopArgs, compact: true });
  assert.equal(compact.remarks, full.remarks);
  assert.match(compact.remarks, /研究費（科研費 基盤\(C\) 課題番号 00X00000）/);
  // 書店では簡略版でも空のまま
  const store = composeOrder({
    destinationId: 'bs',
    items: oneBook,
    profile: filledProfile,
    compact: true,
  });
  assert.equal(store.remarks, '');
});

test('簡略版でも件数が増えれば mailto を超え、コピー経路に落ちる', () => {
  // 1 件あたり 2 行増えるので、件数が増えれば簡略版でも必ず超える。
  // UI は件数で決め打ちせず長さで判定するので、この境界は自然に扱われる
  const many = Array.from({ length: 8 }, (_, i) => ({
    book: {
      isbn13: `978484048823${i}`,
      title: `精神科診療のためのガイドブック 第${i + 1}巻`,
      price: 3850,
    },
    quantity: 1,
  }));
  const compact = composeOrder({ ...coopArgs, items: many, compact: true });
  assert.equal(compact.tooLongForMailto, true);
  assert.ok(compact.encodedLength > MAILTO_SAFE_LENGTH);
});

test('ひとことが入っていると compact 指定を無視してフル版に戻す', () => {
  // 利用者が書いた文章を黙って落とさないための担保。core 側で効かせる
  const full = composeOrder({ ...coopArgs, message: '至急でお願いします' });
  const asked = composeOrder({ ...coopArgs, message: '至急でお願いします', compact: true });
  assert.equal(asked.body, full.body);
  assert.ok(asked.body.includes('至急でお願いします'));
  assert.equal(asked.tooLongForMailto, true); // → UI は自然にコピー経路へ落ちる

  // 空白だけの入力は「書いた文章」ではないので簡略版のままで良い
  const blank = composeOrder({ ...coopArgs, message: '   ', compact: true });
  assert.equal(blank.tooLongForMailto, false);
});

test('明細の備考が入っていても compact 指定を無視してフル版に戻す', () => {
  const withNote = [{ ...oneBook[0], note: '第2版でお願いします' }];
  const asked = composeOrder({ ...coopArgs, items: withNote, compact: true });
  assert.ok(asked.body.includes('第2版でお願いします'));
  assert.equal(asked.tooLongForMailto, true);
});

test('簡略版でも buildMailto と一致する（長さ判定が一本化されている）', () => {
  const d = composeOrder({ ...coopArgs, compact: true });
  const m = buildMailto({ to: d.to, cc: d.cc, subject: d.subject, body: d.body });
  assert.equal(m.mailto, d.mailto);
  assert.equal(m.tooLongForMailto, d.tooLongForMailto);
});

test('pickMailPlan: フル版が収まるならフル版の本文入り mailto を開く', () => {
  const full = buildMailto({ to: 'a@example.com', subject: 'Sub', body: 'short' });
  const compact = buildMailto({ to: 'a@example.com', subject: 'Sub', body: 's' });
  const plan = pickMailPlan({ full, compact });
  assert.equal(plan.mode, 'full');
  assert.equal(plan.open, full.mailto);
  assert.equal(plan.copyText, ''); // 経路 1 では何もコピーしない
});

test('pickMailPlan: フル版が超えて簡略版が収まるなら簡略版を開く', () => {
  const full = composeOrder(coopArgs);
  const compact = composeOrder({ ...coopArgs, compact: true });
  const plan = pickMailPlan({ full, compact });
  assert.equal(plan.mode, 'compact');
  assert.equal(plan.open, compact.mailto);
  assert.ok(plan.open.includes('body='));
  assert.equal(plan.copyText, ''); // 経路 2 でも何もコピーしない
});

test('pickMailPlan: どちらも超えるならフル版の本文をコピーしてヘッダのみ開く', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    book: { isbn13: `978484048823${i % 10}`, title: `書名${i}`, price: 3850 },
    quantity: 1,
  }));
  const full = composeOrder({ ...coopArgs, items: many });
  const compact = composeOrder({ ...coopArgs, items: many, compact: true });
  const plan = pickMailPlan({ full, compact });
  assert.equal(plan.mode, 'copy');
  assert.equal(plan.open, full.mailtoHeaderOnly);
  assert.ok(!plan.open.includes('body='));
  // コピー経路には長さ制限が無いので、渡すのは情報量の多いフル版
  assert.equal(plan.copyText, full.body);
});

test('pickMailPlan: 簡略版を渡さなければ（本文を手編集した場合）コピー経路になる', () => {
  const full = composeOrder(coopArgs);
  const plan = pickMailPlan({ full });
  assert.equal(plan.mode, 'copy');
  assert.equal(plan.copyText, full.body);
});
