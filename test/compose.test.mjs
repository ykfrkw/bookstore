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

const profile = withDefaults({
  requester: {
    name: 'テスト 太郎',
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
    { id: 'kaken', label: '科研費 基盤(C)', code: '00X00000', representative: 'テスト 太郎' },
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
  assert.match(d.body, /予算代表者: テスト 太郎/);
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
  const empty = withDefaults({ requester: { name: 'テスト 太郎' } });
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
  assert.match(line, /予算代表者: テスト 太郎/);
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
    name: 'テスト 太郎',
    kana: 'てすと たろう',
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
    { id: 'kaken', label: '科研費 基盤(C)', code: '00X00000', representative: 'テスト 太郎' },
  ],
  defaults: { destinationId: 'coop' },
});

/** 和書 1 冊。書名・著者・出版社まで埋まった現実的な書誌 */
const oneBook = [
  {
    book: {
      isbn13: '9784840488235',
      title: '精神科診療のためのガイドブック',
      author: '山田 太郎',
      publisher: 'メディカ出版',
      pubdate: '2024-03',
      price: 3850,
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
  assert.ok(!compact.body.includes('山田 太郎'));
  assert.ok(!compact.body.includes('メディカ出版'));
  assert.ok(!compact.body.includes('2024-03'));
  assert.ok(!compact.body.includes('----'));
  assert.ok(!compact.body.includes('■'));
  assert.ok(!compact.body.includes('合計'));
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
  assert.match(coop.body, /予算代表者: テスト 太郎/);
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
