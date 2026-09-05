/**
 * 注文メール本文の「部品」。フル版と簡略版の 1 件・ヘッダ・合計行を持つ。
 *
 * なぜ compose.js から分けるか: compose.js の責務は「部品をどう並べるか」と
 * mailto の 3 段階の選択（pickMailPlan）で、変わる理由が違う。文面の書式を
 * 直すのは書式だけの話なのに、同じファイルにあると長さ判定の周りを毎回読む
 * ことになる。逆に、**フル版と簡略版は必ず同じファイルに置く**。片方だけ直すと
 * 「呼び名は生協なら組合員番号」のような規則が静かにズレる。
 *
 * ここも core なので DOM・chrome API を触らない（純関数だけ）。
 */
import { display as displayIsbn } from './isbn.js';
import { TAX_BASIS } from './bibliography.js';

/** 金額表示。価格不明（null / undefined）は「—」にする */
export function yen(amount) {
  return amount == null ? '—' : '¥' + Number(amount).toLocaleString('ja-JP');
}

/** 税区分の表示語。混在の注記もこの語を並べて作る */
const TAX_WORD = {
  [TAX_BASIS.excluded]: '税抜',
  [TAX_BASIS.included]: '税込',
  [TAX_BASIS.unknown]: '税区分不明',
};

/** 混在を並べる順。「税抜・税込が混在」と読ませたいので税抜を先に置く */
const TAX_ORDER = [TAX_BASIS.excluded, TAX_BASIS.included, TAX_BASIS.unknown];

/**
 * 金額に添える税区分のラベル。
 *
 * **`unknown` にはラベルを付けない。** openBD の ONIX に PriceType が無い版元
 * データや、ページから拾った価格は税抜・税込のどちらか決められない。
 * そこに「（税込）」と書けば推測ではなく誤りが相手に届く。
 * **税抜から 10% を掛けて税込を作ることもしない。** 税率をコードに埋めると
 * 税制改正で腐り、軽減税率の判定まで抱え込むことになる。こちらの仕事は
 * どちらの数字かを間違えずに伝えることであって、換算ではない。
 */
export function taxLabel(basis) {
  const word = TAX_WORD[basis];
  if (!word || basis === TAX_BASIS.unknown) return '';
  return `（${word}）`;
}

/**
 * 合計行に添える注記。**足した数字の性質を言い切れないときは言い切らない。**
 *
 * 複数冊の注文では税抜の本と税込の本が混ざりうる。黙って足した額に「（税込）」と
 * 書くのが一番まずいので、区分が 1 つに定まるときだけその区分を出し、
 * 2 つ以上あるときは「何と何が混ざっているか」をそのまま書く。
 * 税区分不明が混ざる場合も同じ扱いにする（不明を税込・税抜のどちらかに
 * 寄せて数えると、寄せた事実が本文のどこにも残らない）。
 *
 * @param {string[]} bases tally が返す、価格が分かっている点の税区分（重複なし）
 */
export function taxNote(bases = []) {
  const present = TAX_ORDER.filter((basis) => bases.includes(basis));
  if (present.length === 0) return '';
  if (present.length === 1) return taxLabel(present[0]);
  return `（${present.map((basis) => TAX_WORD[basis]).join('・')}が混在）`;
}

/**
 * 点数・冊数・定価合計をまとめて数える。
 *
 * **価格不明の点数を数えて返す。** 「価格が分かる分だけ足した金額」は、
 * 不明があることを言わずに出すと少なめの総額として読まれる。
 * 表示側（renderSummary / renderCompactTotal）が必ず添えられるようにする。
 *
 * **税区分も集めて返す。** 税抜の本と税込の本を黙って足した額は、どちらの
 * 数字なのか誰にも分からない。数えた側でしか分からないので、ここで返す。
 *
 * @param {Array<{book?:object, quantity?:number}>} items
 * @returns {{titles:number, copies:number, amount:number, unknown:number,
 *            taxBases:string[]}}
 */
export function tally(items) {
  const copies = items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  const priced = items.filter((item) => item.book?.price != null);
  const amount = priced.reduce(
    (sum, item) => sum + item.book.price * (item.quantity ?? 1),
    0
  );
  // 金額に足されていない点（価格不明）の税区分は数えない。足していない以上、
  // 合計の性質には関わらないため
  const taxBases = [
    ...new Set(priced.map((item) => item.book.taxBasis || TAX_BASIS.unknown)),
  ];
  return {
    titles: items.length,
    copies,
    amount,
    unknown: items.length - priced.length,
    taxBases,
  };
}

/**
 * フル版の合計行。1 点でも出す（罫線の下の締めとして位置が決まっている）。
 *
 * **「合計」ではなく「定価合計」。** 生協は組合員価格で割引があるのが普通で、
 * 定価の和は請求額ではない。「合計」と書くと請求額として読まれ、差額が
 * 後から出る。数字の正体をそのまま名前にする。
 */
export function renderSummary({ titles, copies, amount, unknown, taxBases = [] }) {
  const total = amount
    ? ` / 定価合計 ${yen(amount)}${taxNote(taxBases)}${
        unknown ? '（価格不明の書籍を除く）' : ''
      }`
    : '';
  return `合計 ${titles}点 / ${copies}冊${total}`;
}

/**
 * 簡略版の合計行。**「1 点かつ 1 冊」のときだけ出さない。**
 *
 * 簡略版が使われるのは 1〜3 点なので、ここを落とすと「2〜3 点の注文にだけ
 * 合計が無い」状態になる。複数冊を 1 通にまとめる意味は、受け取る側が
 * 1 通で総額を把握できることにもあるので、点数が増えたときこそ要る。
 *
 * **省けるのは合計が書名行の数字と一致するときだけで、それは 1 点かつ 1 冊の
 * ときに限る。** 簡略版の書名行は `『書名』 3冊 ¥3,800` の形で、¥ は単価である。
 * 冊数が 2 以上なら総額は単価と違う数字になるのに、簡略版にはフル版のような
 * `定価` / `冊数` / `定価合計` のラベルが無いので、本文に現れる唯一の金額を
 * 総額と読まれる。生協が単価で予算計上すれば差額が後から出る（誤発注は
 * 研究費の執行事故になる）。だから点数ではなく「点数と冊数の両方が 1」で判定する。
 *
 * **価格不明があるときは点数を必ず添える。** 分かる分だけ足した額を黙って
 * 出すと、その額で予算が足りると読まれる。
 * 全点が不明なら金額を出さず、不明の点数だけを残す。
 *
 * @param {{titles:number, copies:number, amount:number, unknown:number,
 *          taxBases?:string[]}} counts
 * @returns {string} 1 点 1 冊なら空文字（呼び出し側が filter で落とす）
 */
export function renderCompactTotal({ titles, copies, amount, unknown, taxBases = [] }) {
  if (titles < 2 && copies < 2) return '';
  const total = amount ? ` 定価合計 ${yen(amount)}${taxNote(taxBases)}` : '';
  const missing = unknown ? `（価格不明 ${unknown}点${total ? 'を除く' : ''}）` : '';
  return `計 ${titles}点 ${copies}冊${total}${missing}`;
}

/** フル版の 1 件。書誌を省かない */
export function renderItem(item, index) {
  const b = item.book || {};
  const meta = [
    b.author && `著者: ${b.author}`,
    b.publisher && `出版社: ${b.publisher}`,
    b.pubdate && `発行: ${b.pubdate}`,
  ]
    .filter(Boolean)
    .join(' / ');

  // 価格そのものが無いときは税区分を書かない（「—（税抜）」は意味を成さない）
  const price = b.price == null ? yen(b.price) : `${yen(b.price)}${taxLabel(b.taxBasis)}`;

  const lines = [
    `${index + 1}. 『${b.title || '(書名未取得)'}』`,
    meta && `   ${meta}`,
    `   ISBN: ${displayIsbn(b.isbn13 || '')}`,
    `   定価: ${price}`,
    `   冊数: ${item.quantity ?? 1}`,
    item.note && `   備考: ${item.note}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 簡略版の 1 件。ISBN 行と書名行の 2 行だけにする（著者・出版社・発行年は落とす）。
 * 書名は削らない。ISBN が 1 桁違ったときに人が気づける唯一の手がかりだから。
 *
 * **税区分のラベルはここには付けない。** 2 点以上・2 冊以上なら合計行が区分を
 * 名乗るので重複するうえ、簡略版は mailto の 2000 字に収めるための版で、
 * 和文 1 文字は encoded 9 字である。1 点 1 冊のときだけ区分の無い金額が残るが、
 * それは「何も名乗っていない」状態であって、税抜を税込と称する側の誤りではない。
 */
export function renderCompactItem(item, { withTaxLabel = false } = {}) {
  const b = item.book || {};
  // 税区分は通常は合計行が担う。ただし合計行が出ないとき（1 点 1 冊）は、
  // 税抜か税込か分からない金額が本文にただ 1 つ載ることになるので、
  // そのときだけ明細行に添える（呼び出し側が withTaxLabel を渡す）
  const tax = withTaxLabel ? taxLabel(b.taxBasis) : '';
  const price = b.price == null ? '' : ` ${yen(b.price)}${tax}`;
  return [
    `ISBN ${displayIsbn(b.isbn13 || '')}`,
    `『${b.title || '(書名未取得)'}』 ${item.quantity ?? 1}冊${price}`,
  ].join('\n');
}

/**
 * 依頼者・宛先まわりの文脈。フル版のヘッダと簡略版の情報行が共通で使う。
 *
 * @typedef {object} DraftContext
 * @property {boolean} isCoop 生協宛か（呼び名と支払区分の有無が変わる）
 * @property {'research'|'private'} fundingMode
 * @property {object} requester withDefaults 済みの profile.requester
 * @property {string} fundingLabel 「研究費（…課題番号…）」または「私費」
 * @property {string} representative 予算代表者。空でも研究費なら行は出す
 *   （欄があること自体が生協への合図になるため、埋まっていない事実を隠さない）
 * @property {string} receiveMethod
 * @property {string} storeName
 * @property {string} memberNumber 組合員番号 / 会員番号。空なら行ごと出さない
 */

/** フル版のヘッダ（■ 付きの箇条書き） */
export function renderHeader(context) {
  const { isCoop, fundingMode, requester, receiveMethod, storeName, memberNumber } = context;
  return [
    isCoop && `■ 支払区分: ${context.fundingLabel}`,
    isCoop && fundingMode === 'research' && `■ 予算代表者: ${context.representative}`,
    receiveMethod && `■ 受取方法: ${receiveMethod}`,
    storeName && `■ 受取店舗: ${storeName}`,
    requester.deliveryPlace && receiveMethod.includes('配達')
      ? `■ 配達場所: ${requester.deliveryPlace}`
      : '',
    `■ 所属: ${requester.affiliation}`,
    `■ 氏名: ${requester.name}${requester.kana ? `（${requester.kana}）` : ''}`,
    // 呼び名だけ種別で出し分ける（生協は組合員番号、書店は会員番号）
    memberNumber && `■ ${isCoop ? '組合員番号' : '会員番号'}: ${memberNumber}`,
    `■ 連絡先: ${[requester.email, requester.phone].filter(Boolean).join(' / ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 簡略版の情報行。■ と独立行を減らし、所属・氏名は署名に任せる */
export function renderCompactInfo(context) {
  const { isCoop, fundingMode, requester, receiveMethod, storeName, memberNumber } = context;
  // 受取店舗は独立行にせず受取方法に括弧で添える（行数を削るのが簡略版の目的）
  const receiveLine = receiveMethod
    ? `受取: ${receiveMethod}${storeName ? `（${storeName}）` : ''}`
    : storeName
      ? `受取: ${storeName}`
      : '';

  return [
    isCoop && `支払: ${context.fundingLabel}`,
    isCoop && fundingMode === 'research' && `予算代表者: ${context.representative}`,
    receiveLine,
    requester.deliveryPlace && receiveMethod.includes('配達')
      ? `配達: ${requester.deliveryPlace}`
      : '',
    // 既定は空の任意項目。非空なら「この番号を求められている」という利用者の
    // 明示的な入力なので簡略版でも落とさない（呼び名の規則はフル版と同じ）
    memberNumber && `${isCoop ? '組合員番号' : '会員番号'}: ${memberNumber}`,
  ]
    .filter(Boolean)
    .join('\n');
}
