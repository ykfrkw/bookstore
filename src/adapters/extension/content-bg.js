/**
 * background（service worker）への代理実行の依頼。content script の 3 ファイル目。
 *
 * content-sites.js の冒頭に書いたとおり、content script は classic script として
 * トップレベル宣言を共有する。ここは content-ui.js の `jimotoToast` に依存するので、
 * manifest では content-ui.js より後・呼び出し側（content-mail.js / content.js）より
 * 前に並べる。
 *
 * なぜ content.js から切り出したか: 拡張ページを開く経路は「パネルの組み立て」とは
 * 別の関心で、しかも本体よりコメントが長い（罠の説明が要る）。content.js に置いたまま
 * だと 1 ファイル 300 行の上限を超える。切り出しても検査は緩まない——メッセージ型の
 * 双方向テストも innerHTML / open shadow の否定側も、読み先は content script 全件を
 * ディスクから拾う形になっている。
 */

/**
 * background に代理実行を頼む拡張ページ。**メッセージ型と失敗時の文言の対**。
 *
 * どちらの API（`chrome.runtime.openOptionsPage` / `chrome.tabs.create`）も
 * 拡張ページ（popup / options / background）専用で content script には存在
 * しない（CLAUDE.md「罠として知っておくこと」参照）。設定画面は以前 optional
 * call `?.()` で呼んでいて、例外も出さず静かに no-op していた（押しても何も
 * 起きない）。`?.()` の形に戻さないこと。失敗は必ず利用者に見せる。
 *
 * 型は**リテラルで書く**。MV3 では background と定数を共有できないので、
 * 対は test/manifest.test.mjs が両方向で突き合わせている（片側だけ改名すると
 * npm test は green のまま実機だけ壊れる）。
 *
 * 失敗時の文言には、必ず**その画面に自力で辿り着く道**を書く。ここが
 * 「開けませんでした」だけだと、利用者は次に何をすればいいか分からない。
 */
const JIMOTO_BACKGROUND_REQUESTS = {
  'jimoto:open-options': {
    what: '設定画面',
    howTo: '拡張のアイコンを右クリック →「オプション」から開いてください',
  },
  'jimoto:open-cart': {
    what: '注文リスト',
    howTo: 'ツールバーの拡張アイコンから開いてください',
  },
};

/**
 * 拡張ページを開く依頼を background へ投げる。
 *
 * @param {string} type JIMOTO_BACKGROUND_REQUESTS のキー
 * @param {string} [context] 呼び出し元の文脈。失敗トーストの先頭に前置する。
 *
 * **設定とカートで別実装にしないこと。** ここには 3 つの配慮が畳み込んである。
 * (a) 失敗を必ずトーストに出す（握り潰すと「押しても何も起きない」に戻る）
 * (b) `chrome.runtime.lastError` と `res.ok` の両方を見る（SW は ephemeral で
 *     「Receiving end does not exist」が返りうる）
 * (c) sendMessage の**同期 throw** を catch する（拡張の更新直後の
 *     "Extension context invalidated"。callback には来ない）
 * 片方だけ書き直すと、この 3 つのどれかが落ちた版が生まれる。
 *
 * なぜ文脈を引き回すか: トーストは常に最新の 1 枚だけを残す（→ jimotoToast()）。
 * openMail() は「設定が未入力です: …」を出した直後にここを呼ぶが、(c) の経路では
 * 失敗トーストが同じ tick 内で append される。ブラウザが描画する前に未入力トースト
 * が消えるため、文脈を引き継がないと「何が未入力か」が一度も表示されない。
 * 単発化そのものは正しいので、消える側の情報を残る側の文言に畳み込む。
 */
function jimotoRequestBackground(type, context = '') {
  // 未登録の型でも throw しない。TypeError を出すと onclick が同期に死んで
  // トーストが 1 枚も出ず、この関数が防いでいるはずの「押しても何も起きない」
  // そのものになる（型を足すとき HANDLERS と呼び出し側だけ書いて踏む）
  const { what = '拡張のページ', howTo = 'ツールバーの拡張アイコンから開いてください' } =
    JIMOTO_BACKGROUND_REQUESTS[type] ?? {};
  const fail = (detail) => {
    console.warn(`[jimoto] ${what}を開けませんでした`, detail);
    jimotoToast(`${context}${what}を開けませんでした。${howTo}`, 'error');
  };
  try {
    chrome.runtime.sendMessage({ type }, (res) => {
      const error = chrome.runtime.lastError;
      if (error || !res?.ok) fail(error?.message || res?.error);
    });
  } catch (e) {
    fail(e);
  }
}

/** 設定画面（options.html）を開く。文脈の引き継ぎは content-mail.js が使う */
function jimotoOpenOptions(context = '') {
  jimotoRequestBackground('jimoto:open-options', context);
}

/**
 * 注文リスト（popup.html）をタブで開く。ツールバーの popup を開く API
 * （chrome.action.openPopup）は content script からは使えないので、同じ
 * popup.html をタブとして開いて実装の重複を作らない（→ SPEC「カートへの導線」）。
 */
function jimotoOpenCart() {
  jimotoRequestBackground('jimoto:open-cart');
}
