/**
 * 注文メールの生成。宛先（destinations の 1 件）の種別に応じて文面を出し分ける。
 *
 * 設計方針:
 *  - 自動発注はしない。人が最終確認して送るための「下書き」を作るだけ。
 *  - mailto: は URL 長制限（実質 2000 文字前後）に当たる。日本語は 1 文字が
 *    パーセントエンコードで 9 文字になるため、和文の注文メールはフル版だと
 *    1 冊でも超える。そこで文面を 2 種類持ち、UI は情報量の多い方から順に
 *    試す（→ pickMailPlan）。
 *      (1) フル版が収まる → 本文入り mailto で開く
 *      (2) 収まらないが簡略版（compact）が収まる → 簡略版の本文入り mailto で開く
 *      (3) どちらも収まらない → フル版の本文をコピーし mailtoHeaderOnly で開く
 *    長さ判定は buildMailto の tooLongForMailto 1 箇所だけを見る。
 *  - 複数冊をまとめて 1 通にできる。公費は検収の都合でまとめた方が実務的。
 */

import { display as displayIsbn } from './isbn.js';
import { withDefaults, findFundingSource, findDestination } from './profile.js';

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

/**
 * 簡略版の 1 件。ISBN 行と書名行の 2 行だけにする（著者・出版社・発行年は落とす）。
 * 書名は削らない。ISBN が 1 桁違ったときに人が気づける唯一の手がかりだから。
 */
function renderCompactItem(item) {
  const b = item.book || {};
  const price = b.price == null ? '' : ` ${yen(b.price)}`;
  return [
    `ISBN ${displayIsbn(b.isbn13 || '')}`,
    `『${b.title || '(書名未取得)'}』 ${item.quantity ?? 1}冊${price}`,
  ].join('\n');
}

function totals(items) {
  const count = items.reduce((a, i) => a + (i.quantity ?? 1), 0);
  const known = items.filter((i) => i.book?.price != null);
  const amount = known.reduce((a, i) => a + i.book.price * (i.quantity ?? 1), 0);
  return { count, amount, partial: known.length !== items.length };
}

/**
 * @param {object} args
 * @param {string} args.destinationId profile.destinations の id
 * @param {Array<{book:object, quantity?:number, note?:string}>} args.items
 * @param {object} args.profile
 * @param {'research'|'private'} [args.fundingMode]
 * @param {string} [args.fundingSourceId]
 * @param {string} [args.message] 末尾に添える自由記述
 * @param {boolean} [args.compact] 簡略版の文面にする（本文入り mailto に収めるため）
 */
export function composeOrder({
  destinationId,
  items,
  profile,
  fundingMode = 'research',
  fundingSourceId = '',
  message = '',
  compact = false,
}) {
  const p = withDefaults(profile);
  // 宛先未登録でも例外は投げない。総関数のままにしておき、止めるのは UI 側の validate
  const dest = findDestination(p, destinationId);
  const isCoop = dest?.kind === 'coop';
  const to = dest?.to || '';
  const cc = dest?.cc || '';
  const receiveMethod = dest?.receiveMethod || '';
  const storeName = dest?.storeName || '';
  const order = { fundingMode, fundingSourceId };
  const { count, amount, partial } = totals(items);

  const vars = {
    name: p.requester.name || '',
    count: String(items.length),
    funding: isCoop ? fundingLabel(p, order) : '',
    orgLabel: dest?.label || '',
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
    receiveMethod && `■ 受取方法: ${receiveMethod}`,
    storeName && `■ 受取店舗: ${storeName}`,
    p.requester.deliveryPlace && receiveMethod.includes('配達')
      ? `■ 配達場所: ${p.requester.deliveryPlace}`
      : '',
    `■ 所属: ${p.requester.affiliation}`,
    `■ 氏名: ${p.requester.name}${p.requester.kana ? `（${p.requester.kana}）` : ''}`,
    // 呼び名だけ種別で出し分ける（生協は組合員番号、書店は会員番号）
    dest?.memberNumber && `■ ${isCoop ? '組合員番号' : '会員番号'}: ${dest.memberNumber}`,
    `■ 連絡先: ${[p.requester.email, p.requester.phone].filter(Boolean).join(' / ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  // 利用者が自分で書いた文章（ひとこと・備考）は簡略版では落ちる。それを黙って
  // 捨てるのは不可なので、compact を指定されていてもフル版に戻す。UI 側の判定に
  // 頼らず core で担保する（落としても実行時エラーにはならず、気づけないため）。
  // フル版に戻れば長さ制限を超えるので、UI は自然に「コピー + ヘッダのみ」に落ちる
  const hasFreeText =
    Boolean(String(message).trim()) || items.some((i) => String(i.note || '').trim());
  const useCompact = compact && !hasFreeText;

  const rule = '-'.repeat(32);
  const summary = `合計 ${items.length}点 / ${count}冊${
    amount ? ` / 概算 ${yen(amount)}${partial ? '（価格不明の書籍を除く）' : ''}` : ''
  }`;

  const keepBlankLines = (x) => x !== undefined && x !== null && x !== false;

  const fullBody = [
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
    .filter(keepBlankLines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  // 受取店舗は独立行にせず受取方法に括弧で添える（行数を削るのが簡略版の目的）
  const receiveLine = receiveMethod
    ? `受取: ${receiveMethod}${storeName ? `（${storeName}）` : ''}`
    : storeName
      ? `受取: ${storeName}`
      : '';

  const compactInfo = [
    isCoop && `支払: ${fundingLabel(p, order)}`,
    isCoop &&
      fundingMode === 'research' &&
      `予算代表者: ${findFundingSource(p, fundingSourceId)?.representative || p.requester.name}`,
    receiveLine,
    p.requester.deliveryPlace && receiveMethod.includes('配達')
      ? `配達: ${p.requester.deliveryPlace}`
      : '',
    // 既定は空の任意項目。非空なら「この番号を求められている」という利用者の
    // 明示的な入力なので簡略版でも落とさない（呼び名の規則はフル版と同じ）
    dest?.memberNumber && `${isCoop ? '組合員番号' : '会員番号'}: ${dest.memberNumber}`,
  ]
    .filter(Boolean)
    .join('\n');

  const signature = [
    `${p.requester.name}${p.requester.affiliation ? `（${p.requester.affiliation}）` : ''}`,
    [p.requester.email, p.requester.phone].filter(Boolean).join(' / '),
  ]
    .filter(Boolean)
    .join('\n');

  const compactBody = [
    fill(isCoop ? p.templates.coopCompactGreeting : p.templates.bookstoreCompactGreeting, vars),
    '',
    items.map(renderCompactItem).join('\n'),
    '',
    compactInfo,
    '',
    fill(isCoop ? p.templates.coopCompactClosing : p.templates.bookstoreCompactClosing, vars),
    '',
    signature,
  ]
    .filter(keepBlankLines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  const body = useCompact ? compactBody : fullBody;

  return {
    to,
    cc,
    subject,
    body,
    ...buildMailto({ to, cc, subject, body }),
    remarks: isCoop ? remarksLine(p, order) : '',
  };
}

/**
 * 情報量の多い経路から順に選ぶ。UI 3 面（注入パネル / popup / ローカル版）で
 * 同じ判定を書き写さないための純関数。長さ判定はここで再計算せず、
 * buildMailto が付けた tooLongForMailto だけを見る。
 *
 * @param {{full: object, compact?: object|null}} candidates
 *   full: composeOrder の戻り値（フル版）。
 *   compact: 簡略版。使ってはいけない場面（本文を手編集した後など）は null を渡す。
 * @returns {{mode:'full'|'compact'|'copy', open:string, copyText:string, draft:object}}
 *   mode 'copy' のときだけ copyText を書き込む。open は必ず window.open / location へ。
 */
export function pickMailPlan({ full, compact = null }) {
  if (!full.tooLongForMailto) {
    return { mode: 'full', open: full.mailto, copyText: '', draft: full };
  }
  if (compact && !compact.tooLongForMailto) {
    return { mode: 'compact', open: compact.mailto, copyText: '', draft: compact };
  }
  // コピー経路には長さ制限が無いので、渡すのは常に情報量の多いフル版
  return { mode: 'copy', open: full.mailtoHeaderOnly, copyText: full.body, draft: full };
}
