/**
 * 対応サイトの書籍ページに注文パネルを差し込む content script（組み立て役）。
 *
 * MV3 の content script は classic script なので、ESM の core は
 * chrome.runtime.getURL + 動的 import で読み込む（ビルド不要を維持するため）。
 *
 * content script は content-sites.js → content-ui.js → content-mail.js →
 * content-panel.js → content.js の 5 ファイルを manifest の content_scripts.js に
 * この順で並べたもので、classic script なのでトップレベル宣言を同じ
 * isolated world で共有する
 * （ファイル間の import 文は無い。契約は JIMOTO_ / jimoto 接頭で grep する）。
 * 分割を動的 import 化しないのは、全ファイルを web_accessible_resources に
 * 載せる必要が生じ、パネルを closed shadow root に閉じて露出を絞る方針に
 * 逆行するため。順序の固定については content-sites.js の冒頭を読むこと。
 */

const PANEL_ID = 'jimoto-panel';

/**
 * core を 1 つのオブジェクトに畳んで返す。
 *
 * **core にファイルを足したらここにも足す。** 足し忘れると、そのモジュールの
 * 関数は `core.xxx` が undefined になり、呼んだ時点の TypeError が
 * run().catch に飲まれて「パネルが静かに出ない」だけが残る
 * （test/extension-source.test.mjs が src/core/ の実体と突き合わせている）。
 */
async function loadCore() {
  const [isbnMod, biblio, profileMod, compose, storage, mailopen, cart] = await Promise.all([
    import(jimotoUrl('core/isbn.js')),
    import(jimotoUrl('core/bibliography.js')),
    import(jimotoUrl('core/profile.js')),
    import(jimotoUrl('core/compose.js')),
    import(jimotoUrl('core/storage.js')),
    import(jimotoUrl('core/mailopen.js')),
    import(jimotoUrl('core/cart.js')),
  ]);
  return { ...isbnMod, ...biblio, ...profileMod, ...compose, ...storage, ...mailopen, ...cart };
}

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
function requestBackground(type, context = '') {
  const { what, howTo } = JIMOTO_BACKGROUND_REQUESTS[type];
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
function openOptions(context = '') {
  requestBackground('jimoto:open-options', context);
}

/**
 * 注文リスト（popup.html）をタブで開く。ツールバーの popup を開く API
 * （chrome.action.openPopup）は content script からは使えないので、同じ
 * popup.html をタブとして開いて実装の重複を作らない（→ SPEC「カートへの導線」）。
 */
function openCart() {
  requestBackground('jimoto:open-cart');
}

async function buildPanel(core, book) {
  const profile = core.withDefaults(await core.loadProfile());

  // 入力欄（注文先・支払・財源・冊数）は content-panel.js に切り出してある。
  // ここに残すのは書誌の表示・ボタン・パネル木の組み立てだけ
  const { rows, getArgs, syncVisibility } = jimotoBuildOrderForm(core, profile, book);

  // パネルは closed shadow root に閉じ込める。
  // <select> には利用者が設定した宛先ラベルと財源ラベル（科研費の課題番号を
  // 含む）が入るため、light DOM のままだとホストページ上の任意のスクリプトが
  // querySelectorAll('#jimoto-panel option') で読めてしまう。
  // closed なら host.shadowRoot が null になり DOM 走査で到達できない。
  // 'open' では shadowRoot 経由で読めてしまい対策にならないので使わない。
  //
  // 中身より先に作るのは、メール送出が anchor の click で開くため
  // （→ content-mail.js）。**その anchor の href には下書きが乗る**ので、
  // 挿す先が light DOM ではなくこの shadow root である必要がある
  const host = jimotoEl('div', { id: PANEL_ID, class: 'jimoto-host' });
  const shadow = host.attachShadow({ mode: 'closed' });

  const ui = { toast: jimotoToast, openOptions };
  const { openMail, copyBody, copyRemarks, fallback } =
    jimotoMakeMailActions({ core, profile, getArgs, ui, root: shadow });

  /**
   * 注文リストへのテキストリンク。点数を文字として持つので参照を保持する。
   *
   * ピル（.jimoto-btn）を 3 つに増やさないのは、主導線が縦積み 2 段という
   * ボタン階層（SPEC「主導線のボタン階層」）を崩さないため。
   */
  const cartLink = jimotoEl('a', {
    href: '#',
    onclick: (e) => {
      e.preventDefault();
      openCart();
    },
  });
  const setCartCount = (count) => {
    cartLink.textContent = `注文リスト（${count}点）`;
  };
  // 初期表示は storage から。以降は addToCart の戻りで更新するので読み直さない
  setCartCount((await core.loadCart()).length);

  const addCart = async () => {
    // 冊数は入力欄の現在値。getArgs() が items に畳み込んでいるのでそこから
    // 1 冊ぶんを取り出す（同じ値を作る経路を 2 本に増やさない）
    const cart = await core.addToCart(getArgs().items[0]);
    // 追加した直後にリンクの点数を合わせる。ここを忘れると、パネルの数だけが
    // 古いままバッジと食い違う（どちらが正しいか利用者に判断できない）
    setCartCount(cart.length);
    // 次の一手はリンクが担うので、トーストは結果だけを短く出す
    jimotoToast(`注文リストに追加（${cart.length}点）`);
  };

  // 書誌はあとから（openBD 応答後に）更新できるよう、要素参照を保持しておく
  const bookEl = jimotoEl('div', { class: 'jimoto-book' });
  const isbnEl = jimotoEl('div', { class: 'jimoto-isbn' });
  const refreshBook = (loading = false) => {
    if (loading) {
      bookEl.textContent = '書誌を確認中…';
      bookEl.classList.add('jimoto-muted');
      isbnEl.textContent = `ISBN ${book.isbn13}`;
      return;
    }
    bookEl.classList.remove('jimoto-muted');
    bookEl.textContent = book.title || '(書名を取得できませんでした)';
    isbnEl.textContent = `ISBN ${book.isbn13}${book.source === 'openbd' ? '' : '（書誌未確認）'}`;
  };
  refreshBook();

  const panel = jimotoEl('div', { class: 'jimoto-panel' }, [
    jimotoEl('div', { class: 'jimoto-title', text: '地元で買う' }),
    bookEl,
    isbnEl,
    // 注文先 → 支払 → 冊数。並びは content-panel.js が rows の順で決めている
    ...rows,
    // 主導線は Amazon の購入ボックスと同じ縦 2 段。「今すぐ買う」を採らないのは、
    // 実際には買わずメール下書きを作るだけで、Amazon 本物のボタンがすぐ近くに
    // あるため、同じ語だと双方向の誤クリックを招くから
    jimotoEl('div', { class: 'jimoto-actions jimoto-actions-stack' }, [
      jimotoEl('button', {
        class: 'jimoto-btn',
        text: 'カートに入れる',
        // Amazon 自身のカートと紛らわしいので、何のカートかを title で補う。
        // 「これは Amazon のカートではない」は見出し「地元で買う」・この title・
        // 追加後のトースト文言の 3 つで伝える設計。どれかを削ると誤クリックの温床になる
        title: 'この拡張のまとめ注文リストに追加し、複数冊を1通のメールにする',
        onclick: addCart,
      }),
      jimotoEl('button', { class: 'jimoto-btn jimoto-primary', text: '今すぐ注文メール', onclick: openMail }),
    ]),
    jimotoEl('div', { class: 'jimoto-actions' }, [
      jimotoEl('button', { class: 'jimoto-btn jimoto-ghost', text: '文面をコピー', onclick: copyBody }),
      jimotoEl('button', { class: 'jimoto-btn jimoto-ghost', text: '備考欄をコピー', onclick: copyRemarks }),
    ]),
    // メーラーが開かなかったと推定できたときだけ出る退路（既定は非表示）。
    // 実体は content-mail.js が持つ。ボタンの下に置くのは、押した直後に
    // 目が行っている場所の続きに出したいため
    fallback,
    // 二次導線はテキストリンクの 1 行にまとめる。ここをピルにすると
    // 主導線（縦積み 2 段）との強調差が消え、押してほしい順序が読めなくなる
    jimotoEl('div', { class: 'jimoto-links' }, [
      jimotoEl('a', {
        text: '設定',
        href: '#',
        onclick: (e) => {
          e.preventDefault();
          openOptions();
        },
      }),
      cartLink,
    ]),
  ]);

  syncVisibility();

  // CSS は拡張内リソースなので実質即座に解決する。ここで待つことで
  // 無スタイルのパネルが一瞬見える状態を避ける（失敗しても素通りする）
  await jimotoInjectPanelStyle(shadow);
  shadow.append(panel);

  return { host, refreshBook };
}

/**
 * ホスト要素をページに差し込む。
 * shadow の中身ではなくホスト（light DOM 側）を挿す点が要。
 * jimoto-floating の position: fixed はページのレイアウト上で効く必要があり、
 * ホストは light DOM にあるので manifest 注入の content.css がそのまま効く。
 */
function mount(host, site) {
  document.getElementById(PANEL_ID)?.remove();
  for (const sel of site.anchors) {
    const anchor = document.querySelector(sel);
    if (anchor) {
      anchor.prepend(host);
      return true;
    }
  }
  host.classList.add('jimoto-floating');
  document.body.append(host);
  return true;
}

async function run() {
  const site = JIMOTO_SITES.find((s) => s.host.test(location.hostname));
  if (!site) return; // 対応サイト以外では何もしない

  const core = await loadCore();
  const { isbn13, source } = core.extractIsbn({
    url: location.href,
    text: jimotoPageText(site),
  });
  if (!isbn13) return; // 書籍ページでない、または ISBN を持たない商品

  // openBD の応答（最大 8 秒）を待たずに、まず骨組みを表示する。
  // book はボタンのハンドラと参照共有しているので、あとから中身を
  // 書き換えれば、クリック時点では常に最新の書誌でメールが組まれる。
  const book = { isbn13, source: 'loading' };
  const { host, refreshBook } = await buildPanel(core, book);
  refreshBook(true);
  mount(host, site);

  const fetched = await core.fetchBook(isbn13);
  const merged = core.mergeFallback(fetched, { isbn13, ...site.fallback() });
  merged.isbn13 = isbn13;
  if (!fetched) merged.source = `page:${source}`;
  Object.assign(book, merged);
  refreshBook();
}

let lastHref = '';
function tick() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  run().catch((e) => console.warn('[jimoto]', e));
}

tick();
setInterval(tick, 1500); // Amazon 等は部分遷移するため URL を監視する
