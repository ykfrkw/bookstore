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

import { withDefaults, findFundingSource, findDestination } from './profile.js';
// 1 件・ヘッダ・合計行の書式は mail-body.js に置く。ここは並べ方だけを持つ
import {
  renderItem,
  renderCompactItem,
  renderHeader,
  renderCompactInfo,
  renderSummary,
  renderCompactTotal,
  tally,
} from './mail-body.js';

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
  const counts = tally(items);

  /**
   * 依頼者・宛先まわりの文脈。フル版のヘッダと簡略版の情報行が同じものを見る。
   * ここで 1 度だけ解決しておくと、財源の引き当てが 2 箇所に散らない
   * （散ると片方だけ直したときに「フル版と簡略版で予算代表者が違う」が起きる）。
   */
  const context = {
    isCoop,
    fundingMode,
    requester: p.requester,
    fundingLabel: fundingLabel(p, order),
    representative: findFundingSource(p, fundingSourceId)?.representative || p.requester.name,
    receiveMethod,
    storeName,
    memberNumber: dest?.memberNumber || '',
  };

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

  const header = renderHeader(context);

  // 利用者が自分で書いた文章（ひとこと・備考）は簡略版では落ちる。それを黙って
  // 捨てるのは不可なので、compact を指定されていてもフル版に戻す。UI 側の判定に
  // 頼らず core で担保する（落としても実行時エラーにはならず、気づけないため）。
  // フル版に戻れば長さ制限を超えるので、UI は自然に「コピー + ヘッダのみ」に落ちる
  const hasFreeText =
    Boolean(String(message).trim()) || items.some((i) => String(i.note || '').trim());
  const useCompact = compact && !hasFreeText;

  const rule = '-'.repeat(32);

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
    renderSummary(counts),
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
    // 合計行は 2 点以上のときだけ（1 点では書名行の価格と同じ数字が並ぶだけ）。
    // 空文字は keepBlankLines を通ってしまうので、ここで false に潰して落とす
    renderCompactTotal(counts) || false,
    '',
    renderCompactInfo(context),
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
 *   mode 'copy' のときだけ copyText を書き込む。open の開き方は mailopen.js が決める。
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
