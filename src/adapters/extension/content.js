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
 * パネルの点数表示とカートの保存キー。buildPanel / run() が代入する可変参照。
 *
 * **listener はトップレベルに 1 本だけ置いて参照を差し替える**（buildPanel ごとに
 * addListener すると SPA 遷移のたびに溜まる）。パネルが作り直されるのは URL が
 * 変わったときだけ（→ tick()）なので、同じ URL に留まったまま popup / カートタブで
 * 削除されると読み直す契機が他に無く、点数だけが古いまま残る——押すと空のリストが
 * 開き、バッジは消えているので 2 箇所で数が食い違う。
 */
let jimotoSetCartCount = null;
let jimotoCartKey = ''; // core.CART_KEY。リテラルを重複させないので loadCore() 後に入る

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !jimotoCartKey || !changes[jimotoCartKey]) return;
  // remove / clear は newValue が undefined で通知される（→ core/cart.js）
  jimotoSetCartCount?.((changes[jimotoCartKey].newValue ?? []).length);
});

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

  const ui = { toast: jimotoToast, openOptions: jimotoOpenOptions };
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
      jimotoOpenCart();
    },
  });
  const setCartCount = (count) => {
    cartLink.textContent = `注文リスト（${count}点）`;
  };
  // 初期表示は storage から。以降の更新はトップレベルの storage.onChanged が担う
  jimotoSetCartCount = setCartCount;
  setCartCount((await core.loadCart()).length);

  const addCart = async () => {
    // 冊数は入力欄の現在値。getArgs() が items に畳み込んでいるのでそこから
    // 1 冊ぶんを取り出す（同じ値を作る経路を 2 本に増やさない）
    const cart = await core.addToCart(getArgs().items[0]);
    // 自分の書き込みも onChanged で戻ってくるが、ここでも合わせる。トーストと
    // 同じ tick で確定させておけば、通知が遅れてもこの 2 つは食い違わない
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
          jimotoOpenOptions();
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
  jimotoCartKey = core.CART_KEY; // 以降 storage.onChanged がカートの変化を拾える
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
