/**
 * background service worker。役割は 2 つ。
 *
 * 1. **拡張ページを開く代理実行。** 設定画面（options.html）と注文リスト
 *    （popup.html）。chrome.runtime.openOptionsPage は拡張ページ
 *    （popup / options / background）専用の API で content script には存在しない。
 *    content script からは sendMessage で依頼を投げ、ここで代理実行する。
 * 2. **ツールバーアイコンのバッジ更新。** カートの点数を出す。
 *
 * **core を import するので manifest 側に `"type": "module"` が必要。**
 * （以前は「import を一切しないので付けない」と書いてあった。ここを読んで
 * manifest 側を「間違い」と判断して消すと、SW は起動時に
 * `Cannot use import statement outside a module` で死ぬ。エラーは SW の
 * DevTools にしか出ないので、バッジだけでなく**設定リンクも同時に壊れる**。
 * `test/manifest.test.mjs` が `background.type === 'module'` を固定してある。）
 */
import { CART_KEY, loadCart } from './core/storage.js';
import { badgeText } from './core/cart.js';

const OPEN_OPTIONS = 'jimoto:open-options';
const OPEN_CART = 'jimoto:open-cart';

/**
 * 注文リストの実体。ツールバーの popup と**同じページをタブとして開く**。
 *
 * chrome.action.openPopup は Chrome 127+ に存在するが使えない。content script に
 * chrome.action は露出せず、ここ（SW）から呼んでもユーザージェスチャを要求されて
 * メッセージ経由の呼び出しでは失敗する。タブで開けば popup.js をそのまま再利用
 * できるので、実装の重複がゼロで済む（→ SPEC「カートへの導線」）。
 *
 * **`tabs` 権限は要らない。** tabs.create は URL やタイトルを読まないので
 * 権限なしで呼べる。**web_accessible_resources への追加も要らない。**
 * WAR はホストページからの参照を許すための宣言で、ここは拡張自身の呼び出し。
 * どちらも test/manifest.test.mjs が「増えていないこと」で固定している。
 */
const CART_PAGE = 'popup.html';

/**
 * バッジの色。**content.css のトークンと同値**:
 * `--primary: #1f6feb` / `--primary-foreground: #fff`。
 *
 * service worker は CSS を読めないのでリテラルの重複は避けられない。
 * ズレは `test/manifest.test.mjs` が content.css から値を抜いて見ている。
 *
 * **`--destructive: #dc2626`（赤）は使わない。** 赤はエラー専用
 * （SPEC「トークン」/「バッジ」）で、カートに本が入っているのは正常な状態。
 * エラー色で出すと「拡張が壊れた」と読まれる。
 */
const BADGE_BACKGROUND = '#1f6feb';
const BADGE_FOREGROUND = '#ffffff';

/**
 * バッジを現在のカートに合わせる。
 *
 * 色は毎回入れ直す。`action.*` の設定はブラウザセッションを越えて永続しないので、
 * 「初回だけ色を塗る」形にすると再起動後に既定色（赤）のバッジが出る。
 *
 * 0 点のときは `badgeText` が空文字を返し、Chrome はバッジを消す
 * （`'0'` を渡すと「0 という数のバッジ」が常駐する）。
 *
 * 周期的な呼び出し（setInterval / alarms）はしない。SW を無用に延命させる。
 * 更新契機は下の listener だけで足りる。
 */
function applyBadge(cart) {
  chrome.action.setBadgeText({ text: badgeText(cart) });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND });
  // setBadgeTextColor は Chrome 110+。MV3 の下限より新しいが、対象は現行 Chrome
  // なので分岐は持たない（無い環境では前景色が既定のままになるだけ）
  chrome.action.setBadgeTextColor({ color: BADGE_FOREGROUND });
}

/** storage を読んでからバッジを合わせる（起動時・インストール時の初期化用） */
async function refreshBadge() {
  applyBadge(await loadCart());
}

/**
 * メッセージ型 → 処理。マップにしてあるのは型がこの先増えるため。
 * **これが防いでいるのは型の分岐漏れだけ**（未知の型に応答しない判定を
 * `Object.hasOwn` 1 箇所に寄せられる）。`return true` と sendResponse の
 * 責務は各 handler に残るので、そこはマップにしても構造的には防げていない。
 *
 * 各 handler は onMessage と同じ規約で、`true` を返すと非同期に sendResponse する。
 *
 * 呼び出しは `HANDLERS[type](message, sendResponse)` で、**`sender` は渡していない**。
 * 今ある型はどれも送信元を見ないので足していない（YAGNI）。カートのタブも
 * 送信元とは無関係な新しいタブとして開くので sender は要らない。将来
 * 送信元のタブを見る型を足すときに、ここのシグネチャを変える。
 */
const HANDLERS = {
  [OPEN_OPTIONS]: (_message, sendResponse) => {
    chrome.runtime.openOptionsPage(() => {
      const error = chrome.runtime.lastError;
      if (error) console.warn('[jimoto] openOptionsPage に失敗', error.message);
      sendResponse({ ok: !error, error: error?.message });
    });
    return true; // 非同期に sendResponse する
  },
  // 失敗の扱いは OPEN_OPTIONS と同じ形。lastError を読んで { ok, error } を返し、
  // 送信側（content script）が利用者に見せる。握り潰すと「押しても何も起きない」に戻る
  [OPEN_CART]: (_message, sendResponse) => {
    chrome.tabs.create({ url: chrome.runtime.getURL(CART_PAGE) }, () => {
      const error = chrome.runtime.lastError;
      if (error) console.warn('[jimoto] 注文リストのタブを開けなかった', error.message);
      sendResponse({ ok: !error, error: error?.message });
    });
    return true; // 非同期に sendResponse する
  },
};

// MV3 の SW は idle で停止し、イベント受信で起動する。起動直後の同期実行中に
// listener が登録されていないとイベントを取りこぼすため、以下 4 つはすべて
// トップレベルで同期登録する（await の後ろや関数の中に入れてはいけない。
// `test/manifest.test.mjs` が行頭一致で固定している）。

// 送信元の検証はしていない。externally_connectable を宣言していないので、
// ウェブページからの sendMessage は onMessage には届かない（届くのは自分自身の
// content script と拡張ページだけ）。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Object.hasOwn で見るのは、`{ type: 'toString' }` のようなメッセージが
  // prototype 経由で関数を引き当てるのを防ぐため。
  // 自分の型以外には応答しない（他の listener を塞がないため）
  const type = message?.type;
  if (typeof type !== 'string' || !Object.hasOwn(HANDLERS, type)) return;
  return HANDLERS[type](message, sendResponse);
});

/**
 * カートの変化でバッジを更新する。
 *
 * **更新契機を `storage.onChanged` 1 本にしている理由**: カートを書き込む経路は
 * 現在 3 つ（注入パネルの「注文リストに追加」・popup の冊数変更／削除・
 * popup の送信後のクリア）あり、すべて `chrome.storage.local` に落ちる。
 * メッセージ方式にすると経路ごとに送信コードが要り、1 つ落とした時点で
 * **バッジが黙ってズレる**（エラーは出ない）。書き込みが必ず通る場所を唯一の
 * 契機にしておけば、経路が増えても足し忘れが起きない。
 *
 * `changes[CART_KEY].newValue` を使い、`loadCart()` を呼び直さない。
 * 読み直すと storage への往復が増えるうえ、通知の値と読んだ値が食い違う窓が
 * できる（連続更新で古い方を後から書く形になりうる）。
 * `?? []` は remove / clear（`newValue` が undefined で通知される）のため。
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[CART_KEY];
  if (!change) return;
  applyBadge(change.newValue ?? []);
});

/**
 * onStartup と onInstalled の**両方**が要る。
 *
 * MV3 の `chrome.action.*`（バッジのテキストと色）は**ブラウザセッションを
 * 越えて永続しない**ので、Chrome を再起動するとカートが残っていてもバッジが
 * 消える。逆に SW が idle で停止しただけならバッジは残る。
 *
 * - `onInstalled` だけ … インストール・更新・拡張の再読み込みは拾えるが、
 *   **Chrome の再起動を拾えない**（一番普通の操作で消えたままになる）
 * - `onStartup` だけ … 再起動は拾えるが、インストール直後・更新直後・
 *   `chrome://extensions` の再読み込み直後を拾えない
 *
 * どちらも「バッジが消えているのに気づきにくい」失敗の仕方をする。
 */
chrome.runtime.onStartup.addListener(() => {
  void refreshBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  void refreshBadge();
});
