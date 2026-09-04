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

/** 金額表示。価格不明（null / undefined）は「—」にする */
export function yen(amount) {
  return amount == null ? '—' : '¥' + Number(amount).toLocaleString('ja-JP');
}

/**
 * 点数・冊数・概算金額をまとめて数える。
 *
 * **価格不明の点数を数えて返す。** 「価格が分かる分だけ足した金額」は、
 * 不明があることを言わずに出すと少なめの総額として読まれる。
 * 表示側（renderSummary / renderCompactTotal）が必ず添えられるようにする。
 *
 * @param {Array<{book?:object, quantity?:number}>} items
 * @returns {{titles:number, copies:number, amount:number, unknown:number}}
 */
export function tally(items) {
  const copies = items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  const priced = items.filter((item) => item.book?.price != null);
  const amount = priced.reduce(
    (sum, item) => sum + item.book.price * (item.quantity ?? 1),
    0
  );
  return {
    titles: items.length,
    copies,
    amount,
    unknown: items.length - priced.length,
  };
}

/** フル版の合計行。1 点でも出す（罫線の下の締めとして位置が決まっている） */
export function renderSummary({ titles, copies, amount, unknown }) {
  return `合計 ${titles}点 / ${copies}冊${
    amount ? ` / 概算 ${yen(amount)}${unknown ? '（価格不明の書籍を除く）' : ''}` : ''
  }`;
}

/**
 * 簡略版の合計行。**2 点以上のときだけ出す。**
 *
 * 簡略版が使われるのは 1〜3 点なので、ここを落とすと「2〜3 点の注文にだけ
 * 合計が無い」状態になる。複数冊を 1 通にまとめる意味は、受け取る側が
 * 1 通で総額を把握できることにもあるので、点数が増えたときこそ要る。
 * 1 点のときは書名行に価格が出ており、合計行は同じ数字の繰り返しになる。
 *
 * **価格不明があるときは点数を必ず添える。** 分かる分だけ足した額を黙って
 * 出すと、その額で予算が足りると読まれる（誤発注は研究費の執行事故になる）。
 * 全点が不明なら金額を出さず、不明の点数だけを残す。
 *
 * @param {{titles:number, copies:number, amount:number, unknown:number}} counts
 * @returns {string} 1 点以下なら空文字（呼び出し側が filter で落とす）
 */
export function renderCompactTotal({ titles, copies, amount, unknown }) {
  if (titles < 2) return '';
  const estimate = amount ? ` 概算 ${yen(amount)}` : '';
  const missing = unknown ? `（価格不明 ${unknown}点${estimate ? 'を除く' : ''}）` : '';
  return `計 ${titles}点 ${copies}冊${estimate}${missing}`;
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

  const lines = [
    `${index + 1}. 『${b.title || '(書名未取得)'}』`,
    meta && `   ${meta}`,
    `   ISBN: ${displayIsbn(b.isbn13 || '')}`,
    `   定価: ${yen(b.price)}（税込）`,
    `   冊数: ${item.quantity ?? 1}`,
    item.note && `   備考: ${item.note}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 簡略版の 1 件。ISBN 行と書名行の 2 行だけにする（著者・出版社・発行年は落とす）。
 * 書名は削らない。ISBN が 1 桁違ったときに人が気づける唯一の手がかりだから。
 */
export function renderCompactItem(item) {
  const b = item.book || {};
  const price = b.price == null ? '' : ` ${yen(b.price)}`;
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
