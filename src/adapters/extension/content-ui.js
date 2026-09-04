/**
 * パネルの DOM 組み立てと通知の道具。content script の 2 ファイル目。
 *
 * content-sites.js の冒頭に書いたとおり、content script の 6 ファイルは
 * classic script としてトップレベル宣言を共有する。ここで定義するものは
 * すべて content.js / content-bg.js / content-mail.js / content-panel.js から
 * 呼ばれる契約なので、grep できるように jimoto 接頭で統一している。
 *
 * ここには「見た目と通知」だけを置く。background への代理実行の依頼は
 * content-bg.js に、メール送出は content-mail.js に、注文の入力欄の組み立ては
 * content-panel.js に置く。
 *
 * （代理実行はかつて「content.js に置く」と書いてあった。メッセージ型の双方向
 * テストの読み先を content.js に固定していたころの制約で、いまテストは content
 * script 全件をディスクから拾うので理由が消えている。→ content-bg.js の冒頭）
 */

// manifest の content_scripts.css と同じファイル。shadow root へも流し込むため
// パスを定数で持つ（CSS の実体は content.css の 1 箇所だけに置く）
const JIMOTO_PANEL_CSS_PATH = 'content.css';

const jimotoUrl = (p) => chrome.runtime.getURL(p);

/**
 * 要素を 1 つ作る。`class` / `text` は property に、`on*` は addEventListener に、
 * 残りは setAttribute に振り分ける。
 *
 * **`on*` を渡した呼び出しは、この関数の中でその場でリスナを登録する。**
 * つまり呼び出しの順序を動かすと、その要素のリスナ登録の順序も動く
 * （返り値がまだ DOM に挿さっていなくても登録は済んでいる。「detached だから
 * 無害」という一般化は成り立たない）。継ぎ目を動かすリファクタで生成順が
 * 変わるときは、動かす呼び出しが `on*` を渡していないかを必ず確認すること。
 */
function jimotoEl(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
}

// fetch した CSS のキャッシュ。SPA の部分遷移で再マウントするたびに
// 取り直すのは無駄なので、1 度読めたら使い回す
let jimotoPanelCssText = null;

/**
 * パネル用の CSS を shadow root の先頭に差し込む。
 *
 * manifest の content_scripts.css は light DOM にしか効かず shadow 境界を
 * 越えないため、同じ content.css を fetch して <style> として入れ直す。
 * 遠回りに見えるが、CSS 文字列を JS 側へ複製しないための措置
 * （見た目の単一ソースを content.css に保つ）。
 */
async function jimotoInjectPanelStyle(shadow) {
  try {
    if (jimotoPanelCssText === null) {
      const res = await fetch(jimotoUrl(JIMOTO_PANEL_CSS_PATH));
      // 非 OK のボディ（や空文字）を jimotoPanelCssText に恒久キャッシュすると、
      // 以降ずっと無スタイルのままになる。catch に流して次回やり直させる
      if (!res.ok) throw new Error(`CSS ${res.status}`);
      jimotoPanelCssText = await res.text();
    }
    shadow.prepend(jimotoEl('style', { text: jimotoPanelCssText }));
  } catch (e) {
    // CSS が取れなくてもパネル自体は動く。ここで throw すると
    // 「パネルが出ない」という最悪の壊れ方になるので警告に留める
    console.warn('[jimoto] パネルの CSS を読み込めませんでした', e);
  }
}

/**
 * @param {string} msg
 * @param {'info'|'error'} [kind] エラー時のみ赤系の左ボーダーで区別する
 *
 * トーストは意図的に light DOM のまま残している。表示するのは
 * 「本文をコピーしました」等の固定メッセージだけで、利用者の設定値
 * （宛先・財源ラベル・課題番号）を含まないため、ページ側から読めても
 * 漏れる情報が無い。manifest 注入の content.css でそのまま装飾される
 */
function jimotoToast(msg, kind = 'info') {
  const t = jimotoEl('div', { class: 'jimoto-toast', text: msg });
  if (kind === 'error') t.classList.add('jimoto-toast-error');
  // スクリーンリーダーにも通知内容が届くようにする
  t.setAttribute('aria-live', 'polite');
  t.setAttribute('role', 'status');
  // トーストは left:50% / bottom:32px の固定位置なので、2 枚出ると完全に重なって
  // どちらも読めなくなる。「設定が未入力です」→ openOptions() 失敗の経路は
  // 1 クリックで 2 枚出るため、常に最新の 1 枚だけを残す。
  // 消える側の情報は openOptions(context) で残る側の文言に畳み込んである
  for (const old of document.querySelectorAll('.jimoto-toast')) old.remove();
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
