/**
 * 注文メールの生成。生協ルート / 地元書店ルートの両方をここで組み立てる。
 *
 * 設計方針:
 *  - 自動発注はしない。人が最終確認して送るための「下書き」を作るだけ。
 *  - mailto: は URL 長制限（実質 2000 文字前後）に当たる。日本語は 1 文字が
 *    パーセントエンコードで 9 文字になるため、和文の注文メールは 1 冊でも
 *    ほぼ確実に超える。そこで本文入りの mailto が使えない場合は
 *      (1) 本文をクリップボードにコピーし
 *      (2) 宛先と件名だけの mailtoHeaderOnly でメーラーを開く
 *    という 2 段構えにする（tooLongForMailto を見て UI が分岐する）。
 *  - 複数冊をまとめて 1 通にできる。公費は検収の都合でまとめた方が実務的。
 */

import { display as displayIsbn } from './isbn.js';
import { withDefaults, findFundingSource } from './profile.js';

/** ブラウザ / OS のメーラー連携が安定して通る実測上の上限の目安 */
export const MAILTO_SAFE_LENGTH = 2000;

/**
 * 宛先・件名・本文から mailto 関連の値だけを組み立てる純関数。
 * composeOrder の内部でも使うが、UI 側で本文を手編集した後に
 * mailto を組み直す用途（local 版の textarea 編集など）のために公開する。
 * 長さ判定のロジックが二重実装にならないよう、必ずここを通すこと。
 *
 * @param {{to:string, cc?:string, subject?:string, body?:string}} args
 */
export function buildMailto({ to, cc = '', subject = '', body = '' }) {
  const query = new URLSearchParams();
  query.set('subject', subject);
  query.set('body', body);
  if (cc) query.set('cc', cc);
  const mailto = `mailto:${encodeURIComponent(to)}?${query.toString()}`;

  const headerQuery = new URLSearchParams();
  headerQuery.set('subject', subject);
  if (cc) headerQuery.set('cc', cc);
  const mailtoHeaderOnly = `mailto:${encodeURIComponent(to)}?${headerQuery.toString()}`;

  return {
    /** 本文入り。長すぎる場合は使わない */
    mailto,
    /** 宛先と件名だけ。本文はクリップボードから貼ってもらう */
    mailtoHeaderOnly,
    encodedLength: mailto.length,
    tooLongForMailto: mailto.length > MAILTO_SAFE_LENGTH,
    /** そのまま送れる形式。クリップボード用 */
    plain: `To: ${to}\nSubject: ${subject}\n\n${body}`,
  };
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

function yen(n) {
  return n == null ? '—' : '¥' + Number(n).toLocaleString('ja-JP');
}

/** 財源の表示ラベル。私費なら「私費」 */
export function fundingLabel(profile, { fundingMode, fundingSourceId }) {
  if (fundingMode !== 'research') return '私費';
  const src = findFundingSource(profile, fundingSourceId);
  if (!src) return '研究費';
  const code = src.code ? ` 課題番号 ${src.code}` : '';
  return `研究費（${src.label}${code}）`;
}

/** 生協の備考欄・公費フォームにそのまま貼れる 1 行 */
export function remarksLine(profile, order) {
  const p = withDefaults(profile);
  const src = findFundingSource(p, order.fundingSourceId);
  return fill(p.templates.remarksLine, {
    fundingLabel: fundingLabel(p, order),
    representative: src?.representative || p.requester.name || '',
    deliveryPlace: p.requester.deliveryPlace || '',
  });
}

function renderItem(item, index) {
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

function totals(items) {
  const count = items.reduce((a, i) => a + (i.quantity ?? 1), 0);
  const known = items.filter((i) => i.book?.price != null);
  const amount = known.reduce((a, i) => a + i.book.price * (i.quantity ?? 1), 0);
  return { count, amount, partial: known.length !== items.length };
}

/**
 * @param {object} args
 * @param {'coop'|'bookstore'} args.route
 * @param {Array<{book:object, quantity?:number, note?:string}>} args.items
 * @param {object} args.profile
 * @param {'research'|'private'} [args.fundingMode]
 * @param {string} [args.fundingSourceId]
 * @param {string} [args.message] 末尾に添える自由記述
 */
export function composeOrder({
  route,
  items,
  profile,
  fundingMode = 'research',
  fundingSourceId = '',
  message = '',
}) {
  const p = withDefaults(profile);
  const isCoop = route !== 'bookstore';
  const target = isCoop ? p.coop : p.bookstore;
  const order = { fundingMode, fundingSourceId };
  const { count, amount, partial } = totals(items);

  const vars = {
    name: p.requester.name || '',
    count: String(items.length),
    funding: isCoop ? fundingLabel(p, order) : '',
    orgLabel: target.storeName || target.label,
  };

  const subject = fill(
    isCoop ? p.templates.coopSubject : p.templates.bookstoreSubject,
    vars
  ).replace(/\s+/g, ' ').trim();

  const header = [
    isCoop && `■ 支払区分: ${fundingLabel(p, order)}`,
    isCoop &&
      fundingMode === 'research' &&
      `■ 予算代表者: ${findFundingSource(p, fundingSourceId)?.representative || p.requester.name}`,
    `■ 受取方法: ${target.receiveMethod}`,
    target.storeName && `■ 受取店舗: ${target.storeName}`,
    p.requester.deliveryPlace && target.receiveMethod.includes('配達')
      ? `■ 配達場所: ${p.requester.deliveryPlace}`
      : '',
    `■ 所属: ${p.requester.affiliation}`,
    `■ 氏名: ${p.requester.name}${p.requester.kana ? `（${p.requester.kana}）` : ''}`,
    isCoop && target.memberNumber && `■ 組合員番号: ${target.memberNumber}`,
    !isCoop && target.customerNumber && `■ 会員番号: ${target.customerNumber}`,
    `■ 連絡先: ${[p.requester.email, p.requester.phone].filter(Boolean).join(' / ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const rule = '-'.repeat(32);
  const summary = `合計 ${items.length}点 / ${count}冊${
    amount ? ` / 概算 ${yen(amount)}${partial ? '（価格不明の書籍を除く）' : ''}` : ''
  }`;

  const body = [
    fill(isCoop ? p.templates.coopGreeting : p.templates.bookstoreGreeting, vars),
    '',
    header,
    '',
    rule,
    items.map(renderItem).join(`\n${rule}\n`),
    rule,
    '',
    summary,
    message && `\n${message}`,
    '',
    isCoop ? p.templates.coopClosing : p.templates.bookstoreClosing,
    '',
    p.requester.name,
    p.requester.affiliation,
    p.requester.email,
  ]
    .filter((x) => x !== undefined && x !== null && x !== false)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return {
    to: target.to,
    cc: target.cc || '',
    subject,
    body,
    ...buildMailto({ to: target.to, cc: target.cc || '', subject, body }),
    remarks: isCoop ? remarksLine(p, order) : '',
  };
}
