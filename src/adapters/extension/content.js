/**
 * 対応サイトの書籍ページに注文パネルを差し込む content script。
 *
 * MV3 の content script は classic script なので、ESM の core は
 * chrome.runtime.getURL + 動的 import で読み込む（ビルド不要を維持するため）。
 *
 * DOM セレクタは各サイト側の変更で壊れる前提。壊れたら SITES の該当エントリを
 * 直すだけで済むように、サイト別設定（アンカー・ヒント・書誌フォールバック）を
 * この 1 箇所に集めてある。
 */

const PANEL_ID = 'jimoto-panel';

// manifest の content_scripts.css と同じファイル。shadow root へも流し込むため
// パスを定数で持つ（CSS の実体は content.css の 1 箇所だけに置く）
const PANEL_CSS_PATH = 'content.css';

/**
 * サイト別設定。
 * - host: location.hostname に対する判定。どれにも当たらなければ何もしない
 * - anchors: パネルを差し込みたい場所の候補（上から順に試す。全滅なら floating）
 * - hints: ISBN 抽出用テキストを拾うセレクタ（title・meta は全サイト共通で拾う）
 * - fallback: openBD が空振りしたときにページから拾う書誌。
 *   実査できていないサイトは「何も拾わない」で openBD に任せる
 */
const SITES = [
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

const url = (p) => chrome.runtime.getURL(p);

async function loadCore() {
  const [isbnMod, biblio, profileMod, compose, storage] = await Promise.all([
    import(url('core/isbn.js')),
    import(url('core/bibliography.js')),
    import(url('core/profile.js')),
    import(url('core/compose.js')),
    import(url('core/storage.js')),
  ]);
  return { ...isbnMod, ...biblio, ...profileMod, ...compose, ...storage };
}

/**
 * ISBN 抽出に使うテキストを組み立てる。
 * document.title と ISBN 系 meta はサイトを問わず拾う（楽天ブックスの主経路。
 * 他サイトでは単に空振りするだけで害がない）。
 */
function pageText(site) {
  const parts = [document.title];
  for (const m of document.querySelectorAll('meta[name*="isbn" i], meta[property*="isbn" i]')) {
    parts.push(m.getAttribute('content') || '');
  }
  for (const s of site.hints) parts.push(document.querySelector(s)?.innerText || '');
  return parts.join('\n');
}

function el(tag, attrs = {}, children = []) {
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
let panelCssText = null;

/**
 * パネル用の CSS を shadow root の先頭に差し込む。
 *
 * manifest の content_scripts.css は light DOM にしか効かず shadow 境界を
 * 越えないため、同じ content.css を fetch して <style> として入れ直す。
 * 遠回りに見えるが、CSS 文字列を JS 側へ複製しないための措置
 * （見た目の単一ソースを content.css に保つ）。
 */
async function injectPanelStyle(shadow) {
  try {
    if (panelCssText === null) {
      const res = await fetch(url(PANEL_CSS_PATH));
      // 非 OK のボディ（や空文字）を panelCssText に恒久キャッシュすると、
      // 以降ずっと無スタイルのままになる。catch に流して次回やり直させる
      if (!res.ok) throw new Error(`CSS ${res.status}`);
      panelCssText = await res.text();
    }
    shadow.prepend(el('style', { text: panelCssText }));
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
function toast(msg, kind = 'info') {
  const t = el('div', { class: 'jimoto-toast', text: msg });
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

/**
 * 設定画面（options.html）を開く。
 *
 * `chrome.runtime.openOptionsPage` は拡張ページ（popup / options / background）
 * 専用の API で、content script には存在しない（CLAUDE.md「罠として知っておく
 * こと」参照）。以前はそれを optional call `?.()` で呼んでおり、例外も出さず
 * 静かに no-op していた（押しても何も起きない）。`?.()` の形に戻さないこと。
 * 失敗は必ず利用者に見せる。content script が呼んでいないことは
 * test/manifest.test.mjs が文字列レベルで固定している。
 *
 * @param {string} [context] 呼び出し元の文脈。失敗トーストの先頭に前置する。
 *
 * なぜ文脈を引き回すか: トーストは常に最新の 1 枚だけを残す（→ toast()）。
 * openMail() は「設定が未入力です: …」を出した直後にここを呼ぶが、
 * sendMessage が同期的に throw する経路（拡張の更新直後の "Extension context
 * invalidated"）では失敗トーストが同じ tick 内で append される。ブラウザが
 * 描画する前に未入力トーストが消えるため、文脈を引き継がないと「何が未入力か」
 * が一度も表示されない。単発化そのものは正しいので、消える側の情報を
 * 残る側の文言に畳み込む。
 */
function openOptions(context = '') {
  const fail = (detail) => {
    console.warn('[jimoto] 設定画面を開けませんでした', detail);
    toast(
      `${context}設定画面を開けませんでした。拡張のアイコンを右クリック →「オプション」から開いてください`,
      'error'
    );
  };
  try {
    chrome.runtime.sendMessage({ type: 'jimoto:open-options' }, (res) => {
      // SW は ephemeral で「Receiving end does not exist」が返りうる
      const error = chrome.runtime.lastError;
      if (error || !res?.ok) fail(error?.message || res?.error);
    });
  } catch (e) {
    // 拡張の更新直後は sendMessage が同期的に throw する
    // （"Extension context invalidated"）
    fail(e);
  }
}

// 冊数の下限は 1。非数値・0 以下が composeOrder に流れ込むのを防ぐ
function clampQty(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

async function buildPanel(core, book) {
  const profile = core.withDefaults(await core.loadProfile());
  const d = profile.defaults;

  const state = {
    destinationId: d.destinationId || profile.destinations[0]?.id || '',
    fundingMode: d.fundingMode,
    fundingSourceId: d.fundingSourceId || profile.fundingSources[0]?.id || '',
    quantity: d.quantity || 1,
  };

  // option のラベルはユーザー設定由来の文字列なので text で入れる（innerHTML 補間はしない）
  const destSel = el(
    'select',
    { class: 'jimoto-input' },
    profile.destinations.length
      ? profile.destinations.map((x) =>
          el('option', { value: x.id, text: core.destinationLabel(x) })
        )
      : [el('option', { value: '', text: '宛先未登録 — 設定から追加' })]
  );
  destSel.value = state.destinationId;
  // 保存済みの既定 id が消えている場合に「何も選ばれていない」状態にしない
  if (!destSel.value) destSel.selectedIndex = 0;

  const fundingSel = el('select', { class: 'jimoto-input' }, [
    el('option', { value: 'private', text: '私費' }),
    el('option', { value: 'research', text: '研究費' }),
  ]);
  fundingSel.value = state.fundingMode;

  const sourceSel = el(
    'select',
    { class: 'jimoto-input' },
    profile.fundingSources.length
      ? profile.fundingSources.map((s) =>
          el('option', { value: s.id, text: `${s.label}${s.code ? ` (${s.code})` : ''}` })
        )
      : [el('option', { value: '', text: '財源未登録 — 設定から追加' })]
  );
  sourceSel.value = state.fundingSourceId;

  const qty = el('input', {
    class: 'jimoto-input jimoto-qty',
    type: 'number',
    min: '1',
    inputmode: 'numeric',
    value: String(clampQty(state.quantity)),
  });
  // 空欄・0・マイナスのまま送信されないよう、フォーカスが外れた時点で 1 に戻す
  qty.addEventListener('change', () => {
    qty.value = String(clampQty(qty.value));
  });

  const fundingRow = el('div', { class: 'jimoto-row' }, [
    el('label', { class: 'jimoto-label', text: '支払' }),
    fundingSel,
    sourceSel,
  ]);

  const syncVisibility = () => {
    // 研究費・財源は生協の宛先でしか意味がない。composeOrder と同じ解決経路で種別を見る
    const isCoop = core.findDestination(profile, destSel.value)?.kind === 'coop';
    fundingRow.style.display = isCoop ? '' : 'none';
    sourceSel.style.display = fundingSel.value === 'research' ? '' : 'none';
  };
  destSel.addEventListener('change', syncVisibility);
  fundingSel.addEventListener('change', syncVisibility);

  const item = () => ({ book, quantity: clampQty(qty.value) });
  const orderArgs = () => ({
    destinationId: destSel.value,
    profile,
    fundingMode: fundingSel.value,
    fundingSourceId: sourceSel.value,
  });

  const openMail = async () => {
    const missing = core.validate(profile, destSel.value);
    if (missing.length) {
      // 設定画面が開けた場合はこちらが最後に残る。開けなかった場合は
      // openOptions() の失敗トーストがこの文言を前置して引き継ぐ
      const detail = `設定が未入力です: ${missing.join(' / ')}`;
      toast(detail, 'error');
      openOptions(`${detail}。`);
      return;
    }
    const draft = core.composeOrder({ ...orderArgs(), items: [item()] });
    if (draft.tooLongForMailto) {
      // 和文はほぼ必ずここに来る。本文をコピーしてから宛先・件名だけでメーラーを開く。
      await navigator.clipboard.writeText(draft.body);
      window.open(draft.mailtoHeaderOnly, '_blank');
      toast('本文をコピーしました。開いたメールに貼り付けてください');
      return;
    }
    window.open(draft.mailto, '_blank');
  };

  const copyBody = async () => {
    const draft = core.composeOrder({ ...orderArgs(), items: [item()] });
    await navigator.clipboard.writeText(draft.plain);
    toast('宛先・件名・本文をコピーしました');
  };

  const copyRemarks = async () => {
    const draft = core.composeOrder({ ...orderArgs(), items: [item()] });
    if (!draft.remarks) return toast('備考欄は生協の宛先のみです');
    await navigator.clipboard.writeText(draft.remarks);
    toast('備考欄用の1行をコピーしました');
  };

  const addCart = async () => {
    const cart = await core.addToCart(item());
    // content script から popup をプログラムで開く API は無いため、
    // 次の一手（ツールバーのアイコン）を文言で案内して導線を繋ぐ
    toast(`注文リストに追加（${cart.length}点）。ツールバーの拡張アイコンからまとめて1通にできます`);
  };

  // 書誌はあとから（openBD 応答後に）更新できるよう、要素参照を保持しておく
  const bookEl = el('div', { class: 'jimoto-book' });
  const isbnEl = el('div', { class: 'jimoto-isbn' });
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

  const panel = el('div', { class: 'jimoto-panel' }, [
    el('div', { class: 'jimoto-title', text: '地元で買う' }),
    bookEl,
    isbnEl,
    el('div', { class: 'jimoto-row' }, [el('label', { class: 'jimoto-label', text: '注文先' }), destSel]),
    fundingRow,
    el('div', { class: 'jimoto-row' }, [el('label', { class: 'jimoto-label', text: '冊数' }), qty]),
    // 主導線は Amazon の購入ボックスと同じ縦 2 段。「今すぐ買う」を採らないのは、
    // 実際には買わずメール下書きを作るだけで、Amazon 本物のボタンがすぐ近くに
    // あるため、同じ語だと双方向の誤クリックを招くから
    el('div', { class: 'jimoto-actions jimoto-actions-stack' }, [
      el('button', {
        class: 'jimoto-btn',
        text: 'カートに入れる',
        // Amazon 自身のカートと紛らわしいので、何のカートかを title で補う。
        // 「これは Amazon のカートではない」は見出し「地元で買う」・この title・
        // 追加後のトースト文言の 3 つで伝える設計。どれかを削ると誤クリックの温床になる
        title: 'この拡張のまとめ注文リストに追加し、複数冊を1通のメールにする',
        onclick: addCart,
      }),
      el('button', { class: 'jimoto-btn jimoto-primary', text: '今すぐ注文メール', onclick: openMail }),
    ]),
    el('div', { class: 'jimoto-actions' }, [
      el('button', { class: 'jimoto-btn jimoto-ghost', text: '文面をコピー', onclick: copyBody }),
      el('button', { class: 'jimoto-btn jimoto-ghost', text: '備考欄をコピー', onclick: copyRemarks }),
    ]),
    el('a', {
      class: 'jimoto-settings',
      text: '設定',
      href: '#',
      onclick: (e) => {
        e.preventDefault();
        openOptions();
      },
    }),
  ]);

  syncVisibility();

  // パネルは closed shadow root に閉じ込める。
  // <select> には利用者が設定した宛先ラベルと財源ラベル（科研費の課題番号を
  // 含む）が入るため、light DOM のままだとホストページ上の任意のスクリプトが
  // querySelectorAll('#jimoto-panel option') で読めてしまう。
  // closed なら host.shadowRoot が null になり DOM 走査で到達できない。
  // 'open' では shadowRoot 経由で読めてしまい対策にならないので使わない。
  const host = el('div', { id: PANEL_ID, class: 'jimoto-host' });
  const shadow = host.attachShadow({ mode: 'closed' });
  // CSS は拡張内リソースなので実質即座に解決する。ここで待つことで
  // 無スタイルのパネルが一瞬見える状態を避ける（失敗しても素通りする）
  await injectPanelStyle(shadow);
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
  const site = SITES.find((s) => s.host.test(location.hostname));
  if (!site) return; // 対応サイト以外では何もしない

  const core = await loadCore();
  const { isbn13, source } = core.extractIsbn({ url: location.href, text: pageText(site) });
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
