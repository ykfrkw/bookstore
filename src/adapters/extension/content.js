/**
 * Amazon の書籍ページに注文パネルを差し込む content script。
 *
 * MV3 の content script は classic script なので、ESM の core は
 * chrome.runtime.getURL + 動的 import で読み込む（ビルド不要を維持するため）。
 *
 * DOM セレクタは Amazon 側の変更で壊れる前提。壊れたら
 * PANEL_ANCHORS / PAGE_HINTS を足すだけで直るように 1 箇所に集めてある。
 */

const PANEL_ID = 'jimoto-panel';

/** パネルを差し込みたい場所の候補（上から順に試す） */
const PANEL_ANCHORS = [
  '#buybox',
  '#desktop_buybox',
  '#rightCol',
  '#addToCart',
  '#centerCol',
];

/** 書籍ページらしさの手がかり */
const PAGE_HINTS = ['#detailBullets_feature_div', '#productDetailsTable', '#bookDescription_feature_div'];

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

function pageText() {
  const parts = PAGE_HINTS.map((s) => document.querySelector(s)?.innerText || '');
  parts.push(document.querySelector('#detailBullets')?.innerText || '');
  return parts.join('\n');
}

/** Amazon ページから拾える範囲の書誌（openBD が空振りしたときの保険） */
function pageFallback() {
  const title = document.querySelector('#productTitle')?.textContent?.trim() || '';
  const author = document.querySelector('#bylineInfo')?.textContent?.trim().replace(/\s+/g, ' ') || '';
  const priceText =
    document.querySelector('.a-price .a-offscreen')?.textContent ||
    document.querySelector('#price')?.textContent ||
    '';
  const price = Number(String(priceText).replace(/[^0-9]/g, '')) || null;
  return { title, author, price };
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

function toast(msg) {
  const t = el('div', { class: 'jimoto-toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function buildPanel(core, book) {
  const profile = core.withDefaults(await core.loadProfile());
  const d = profile.defaults;

  const state = {
    route: d.route,
    fundingMode: d.fundingMode,
    fundingSourceId: d.fundingSourceId || profile.fundingSources[0]?.id || '',
    quantity: d.quantity || 1,
  };

  const routeSel = el('select', { class: 'jimoto-input' }, [
    el('option', { value: 'coop', text: profile.coop.label }),
    el('option', { value: 'bookstore', text: profile.bookstore.storeName || profile.bookstore.label }),
  ]);
  routeSel.value = state.route;

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

  const qty = el('input', { class: 'jimoto-input jimoto-qty', type: 'number', min: '1', value: String(state.quantity) });

  const fundingRow = el('div', { class: 'jimoto-row' }, [
    el('label', { class: 'jimoto-label', text: '支払' }),
    fundingSel,
    sourceSel,
  ]);

  const syncVisibility = () => {
    const isCoop = routeSel.value === 'coop';
    fundingRow.style.display = isCoop ? '' : 'none';
    sourceSel.style.display = fundingSel.value === 'research' ? '' : 'none';
  };
  routeSel.addEventListener('change', syncVisibility);
  fundingSel.addEventListener('change', syncVisibility);

  const item = () => ({ book, quantity: Number(qty.value) || 1 });
  const orderArgs = () => ({
    route: routeSel.value,
    profile,
    fundingMode: fundingSel.value,
    fundingSourceId: sourceSel.value,
  });

  const openMail = async () => {
    const missing = core.validate(profile, routeSel.value);
    if (missing.length) {
      toast(`設定が未入力です: ${missing.join(' / ')}`);
      chrome.runtime.openOptionsPage?.();
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
    if (!draft.remarks) return toast('備考欄は生協ルートのみです');
    await navigator.clipboard.writeText(draft.remarks);
    toast('備考欄用の1行をコピーしました');
  };

  const addCart = async () => {
    const cart = await core.addToCart(item());
    toast(`まとめ注文リストに追加（${cart.length}点）`);
  };

  const panel = el('div', { id: PANEL_ID, class: 'jimoto-panel' }, [
    el('div', { class: 'jimoto-title', text: '地元で買う' }),
    el('div', { class: 'jimoto-book', text: book.title || '(書名を取得できませんでした)' }),
    el('div', { class: 'jimoto-isbn', text: `ISBN ${book.isbn13}${book.source === 'openbd' ? '' : '（書誌未確認）'}` }),
    el('div', { class: 'jimoto-row' }, [el('label', { class: 'jimoto-label', text: '注文先' }), routeSel]),
    fundingRow,
    el('div', { class: 'jimoto-row' }, [el('label', { class: 'jimoto-label', text: '冊数' }), qty]),
    el('div', { class: 'jimoto-actions' }, [
      el('button', { class: 'jimoto-btn jimoto-primary', text: '注文メールを作る', onclick: openMail }),
      el('button', { class: 'jimoto-btn', text: 'まとめる', title: '複数冊を1通にまとめる', onclick: addCart }),
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
        chrome.runtime.openOptionsPage?.();
      },
    }),
  ]);

  syncVisibility();
  return panel;
}

function mount(panel) {
  document.getElementById(PANEL_ID)?.remove();
  for (const sel of PANEL_ANCHORS) {
    const anchor = document.querySelector(sel);
    if (anchor) {
      anchor.prepend(panel);
      return true;
    }
  }
  panel.classList.add('jimoto-floating');
  document.body.append(panel);
  return true;
}

async function run() {
  const core = await loadCore();
  const { isbn13, source } = core.extractIsbn({ url: location.href, text: pageText() });
  if (!isbn13) return; // 書籍ページでない、または ISBN を持たない商品

  const fetched = await core.fetchBook(isbn13);
  const book = core.mergeFallback(fetched, { isbn13, ...pageFallback() });
  book.isbn13 = isbn13;
  if (!fetched) book.source = `page:${source}`;

  mount(await buildPanel(core, book));
}

let lastHref = '';
function tick() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  run().catch((e) => console.warn('[jimoto]', e));
}

tick();
setInterval(tick, 1500); // Amazon は部分遷移するため URL を監視する
