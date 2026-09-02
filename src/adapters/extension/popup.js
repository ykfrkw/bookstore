import { withDefaults, validate, findDestination, destinationLabel } from './core/profile.js';
import { composeOrder } from './core/compose.js';
import { loadProfile, loadCart, removeFromCart, clearCart } from './core/storage.js';

const $ = (id) => document.getElementById(id);
let profile;
let cart = [];

// 冊数の下限は 1。非数値・0 以下が composeOrder に流れ込むのを防ぐ
function clampQty(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function renderCart() {
  const list = $('list');
  list.textContent = '';
  if (!cart.length) {
    // 静的な文言のみ（変数補間なし）なので innerHTML で問題ない
    list.innerHTML = '<div class="empty">書籍ページで「カートに入れる」を押すと<br />ここに溜まります</div>';
    return;
  }
  cart.forEach((item, i) => {
    // 書名は Amazon 由来の文字列なので textContent で入れる（innerHTML 補間はしない）
    const row = document.createElement('div');
    row.className = 'item';

    const t = document.createElement('div');
    t.className = 't';
    const title = document.createElement('b');
    title.textContent = item.book.title || '(書名不明)';
    const isbn = document.createElement('span');
    isbn.textContent = item.book.isbn13;
    t.append(title, isbn);

    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '1';
    qty.inputMode = 'numeric';
    qty.value = String(item.quantity ?? 1);
    qty.addEventListener('input', () => {
      cart[i].quantity = clampQty(qty.value);
    });
    qty.addEventListener('change', () => {
      qty.value = String(clampQty(qty.value));
    });

    const del = document.createElement('button');
    del.title = '削除';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      cart = await removeFromCart(item.book.isbn13);
      renderCart();
    });

    row.append(t, qty, del);
    list.append(row);
  });
}

function syncVisibility() {
  // 研究費・財源は生協の宛先でしか意味がない
  const isCoop = findDestination(profile, $('dest').value)?.kind === 'coop';
  $('funding-row').style.display = isCoop ? '' : 'none';
  $('source').style.display = $('funding').value === 'research' ? '' : 'none';
}

function draft() {
  return composeOrder({
    destinationId: $('dest').value,
    items: cart,
    profile,
    fundingMode: $('funding').value,
    fundingSourceId: $('source').value,
  });
}

async function init() {
  profile = withDefaults(await loadProfile());
  cart = await loadCart();

  // option のラベルはユーザー設定由来の文字列なので new Option で生成する
  const dest = $('dest');
  dest.textContent = '';
  if (profile.destinations.length) {
    for (const d of profile.destinations) dest.append(new Option(destinationLabel(d), d.id));
  } else {
    dest.append(new Option('宛先未登録 — 設定から追加', ''));
  }
  dest.value = profile.defaults.destinationId;
  // 保存済みの既定 id が消えている場合に「何も選ばれていない」状態にしない
  if (!dest.value) dest.selectedIndex = 0;
  $('funding').value = profile.defaults.fundingMode;

  const source = $('source');
  source.textContent = '';
  if (profile.fundingSources.length) {
    for (const s of profile.fundingSources) {
      source.append(new Option(`${s.label}${s.code ? ` (${s.code})` : ''}`, s.id));
    }
  } else {
    source.append(new Option('財源未登録', ''));
  }
  source.value = profile.defaults.fundingSourceId || profile.fundingSources[0]?.id || '';

  renderCart();
  syncVisibility();
}

$('dest').addEventListener('change', syncVisibility);
$('funding').addEventListener('change', syncVisibility);

$('mail').addEventListener('click', async () => {
  if (!cart.length) return;
  const missing = validate(profile, $('dest').value);
  if (missing.length) {
    // 黙って設定画面へ飛ばすと何が起きたか分からないため、まず理由を見せてから開く
    $('status').textContent = `設定が未入力です: ${missing.join(' / ')}`;
    setTimeout(() => chrome.runtime.openOptionsPage(), 600);
    return;
  }
  const d = draft();
  if (d.tooLongForMailto) {
    // tabs.create で popup が閉じるため、コピー完了を待ってから開く
    await navigator.clipboard.writeText(d.body);
    chrome.tabs.create({ url: d.mailtoHeaderOnly });
    return;
  }
  chrome.tabs.create({ url: d.mailto });
});

$('copy').addEventListener('click', async () => {
  if (!cart.length) return;
  const d = draft();
  await navigator.clipboard.writeText(d.plain);
  $('copy').textContent = 'コピー済み';
  setTimeout(() => ($('copy').textContent = 'コピー'), 1600);
});

$('clear').addEventListener('click', async () => {
  cart = await clearCart();
  renderCart();
});

$('opt').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
