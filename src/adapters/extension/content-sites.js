/**
 * 対応サイト別の設定。content script の 1 ファイル目として読み込まれる。
 *
 * このファイルと content-ui.js / content-mail.js / content.js は
 * manifest の content_scripts.js に**この順で**並べた classic script で、
 * 同じ isolated world のトップレベル宣言を共有する（ESM ではない）。
 * 順序が崩れると JIMOTO_SITES が未定義になりパネルが静かに出なくなるため、
 * 読み込み順は test/manifest.test.mjs が deepEqual で固定している。
 * ファイル間の契約は grep できるように JIMOTO_ / jimoto 接頭で統一する。
 *
 * DOM セレクタは各サイト側の変更で壊れる前提。壊れたら JIMOTO_SITES の該当
 * エントリを直すだけで済むように、サイト別設定（アンカー・ヒント・書誌
 * フォールバック）をこの 1 箇所に集めてある。
 */

/**
 * サイト別設定。
 * - host: location.hostname に対する判定。どれにも当たらなければ何もしない
 * - anchors: パネルを差し込みたい場所の候補（上から順に試す。全滅なら floating）
 * - hints: ISBN 抽出用テキストを拾うセレクタ（title・meta は全サイト共通で拾う）
 * - fallback: openBD が空振りしたときにページから拾う書誌。
 *   実査できていないサイトは「何も拾わない」で openBD に任せる
 */
const JIMOTO_SITES = [
  {
    name: 'amazon',
    host: /(^|\.)amazon\.(co\.jp|com)$/,
    anchors: ['#buybox', '#desktop_buybox', '#rightCol', '#addToCart', '#centerCol'],
    hints: [
      '#detailBullets_feature_div',
      '#productDetailsTable',
      '#bookDescription_feature_div',
      '#detailBullets',
    ],
    fallback: () => {
      const title = document.querySelector('#productTitle')?.textContent?.trim() || '';
      const author =
        document.querySelector('#bylineInfo')?.textContent?.trim().replace(/\s+/g, ' ') || '';
      const priceText =
        document.querySelector('.a-price .a-offscreen')?.textContent ||
        document.querySelector('#price')?.textContent ||
        '';
      const price = Number(String(priceText).replace(/[^0-9]/g, '')) || null;
      return { title, author, price };
    },
  },
  {
    // URL は内部 ID（/rb/<数字>/）で ISBN を含まないため、テキスト経路で取る。
    // meta・title・本文の 3 経路を冗長に渡す（実査 2026-08-07、docs/research.md）
    name: 'rakuten-books',
    host: /(^|\.)books\.rakuten\.co\.jp$/,
    // 実査で確認した ID。上から順に試す
    anchors: ['#purchaseBox', '#productInfo', '#productTitle', '#main'],
    hints: ['#productTitle', '#productInfo'],
    fallback: () => ({
      title: document.querySelector('#productTitle')?.textContent?.trim() || '',
    }),
  },
  {
    // ISBN は URL から取れる（core/isbn.js の url-kinokuniya）ので DOM 依存なし。
    // アンカーは未実査のため汎用の控えめな候補のみ。外れたら floating に任せる
    name: 'kinokuniya',
    host: /(^|\.)kinokuniya\.co\.jp$/,
    anchors: ['main'],
    hints: [],
    fallback: () => ({}), // 書誌セレクタ未実査。openBD 頼みで良い
  },
  {
    // 同上: ISBN は URL 直埋め込み（url-maruzen）。アンカー未実査
    name: 'maruzen',
    host: /(^|\.)maruzenjunkudo\.co\.jp$/,
    anchors: ['main'],
    hints: [],
    fallback: () => ({}),
  },
];

/**
 * ISBN 抽出に使うテキストを組み立てる。
 * document.title と ISBN 系 meta はサイトを問わず拾う（楽天ブックスの主経路。
 * 他サイトでは単に空振りするだけで害がない）。
 */
function jimotoPageText(site) {
  const parts = [document.title];
  for (const m of document.querySelectorAll('meta[name*="isbn" i], meta[property*="isbn" i]')) {
    parts.push(m.getAttribute('content') || '');
  }
  for (const s of site.hints) parts.push(document.querySelector(s)?.innerText || '');
  return parts.join('\n');
}
