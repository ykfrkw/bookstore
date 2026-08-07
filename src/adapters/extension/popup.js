import { withDefaults, validate } from './core/profile.js';
import { composeOrder } from './core/compose.js';
import { loadProfile, loadCart, removeFromCart, clearCart } from './core/storage.js';

const $ = (id) => document.getElementById(id);
let profile;
let cart = [];

function renderCart() {
  const list = $('list');
  list.innerHTML = '';
  if (!cart.length) {
    list.innerHTML = '<div class="empty">Amazon の書籍ページで「まとめる」を押すと<br />ここに溜まります</div>';
    return;
  }
  cart.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div class="t">
        <b>${(item.book.title || '(書名不明)').replace(/</g, '&lt;')}</b>
        <span>${item.book.isbn13}</span>
      </div>
      <input type="number" min="1" value="${item.quantity ?? 1}" />
      <button title="削除">×</button>`;
    row.querySelector('input').addEventListener('input', (e) => {
      cart[i].quantity = Number(e.target.value) || 1;
    });
    row.querySelector('button').addEventListener('click', async () => {
      cart = await removeFromCart(item.book.isbn13);
      renderCart();
    });
    list.append(row);
  });
}

function syncVisibility() {
  const isCoop = $('route').value === 'coop';
  $('funding-row').style.display = isCoop ? '' : 'none';
  $('source').style.display = $('funding').value === 'research' ? '' : 'none';
}

function draft() {
  return composeOrder({
    route: $('route').value,
    items: cart,
    profile,
    fundingMode: $('funding').value,
    fundingSourceId: $('source').value,
  });
}

async function init() {
  profile = withDefaults(await loadProfile());
  cart = await loadCart();

  $('route').innerHTML = `
    <option value="coop">${profile.coop.label}</option>
    <option value="bookstore">${profile.bookstore.storeName || profile.bookstore.label}</option>`;
  $('route').value = profile.defaults.route;
  $('funding').value = profile.defaults.fundingMode;
  $('source').innerHTML = profile.fundingSources.length
    ? profile.fundingSources
        .map((s) => `<option value="${s.id}">${s.label}${s.code ? ` (${s.code})` : ''}</option>`)
        .join('')
    : '<option value="">財源未登録</option>';
  $('source').value = profile.defaults.fundingSourceId || profile.fundingSources[0]?.id || '';

  renderCart();
  syncVisibility();
}

$('route').addEventListener('change', syncVisibility);
$('funding').addEventListener('change', syncVisibility);

$('mail').addEventListener('click', () => {
  if (!cart.length) return;
  const missing = validate(profile, $('route').value);
  if (missing.length) return chrome.runtime.openOptionsPage();
  const d = draft();
  if (d.tooLongForMailto) {
    navigator.clipboard.writeText(d.body);
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
