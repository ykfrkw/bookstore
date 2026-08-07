import { withDefaults, DEFAULT_PROFILE } from './core/profile.js';
import { loadProfile, saveProfile } from './core/storage.js';

const $ = (id) => document.getElementById(id);

const FIELDS = [
  ['req-name', 'requester.name'],
  ['req-kana', 'requester.kana'],
  ['req-affiliation', 'requester.affiliation'],
  ['req-email', 'requester.email'],
  ['req-phone', 'requester.phone'],
  ['req-delivery', 'requester.deliveryPlace'],
  ['coop-label', 'coop.label'],
  ['coop-store', 'coop.storeName'],
  ['coop-to', 'coop.to'],
  ['coop-cc', 'coop.cc'],
  ['coop-receive', 'coop.receiveMethod'],
  ['coop-member', 'coop.memberNumber'],
  ['bs-store', 'bookstore.storeName'],
  ['bs-to', 'bookstore.to'],
  ['bs-receive', 'bookstore.receiveMethod'],
  ['bs-customer', 'bookstore.customerNumber'],
  ['def-route', 'defaults.route'],
  ['def-funding', 'defaults.fundingMode'],
  ['tpl-coop-subject', 'templates.coopSubject'],
  ['tpl-coop-greeting', 'templates.coopGreeting'],
  ['tpl-coop-closing', 'templates.coopClosing'],
  ['tpl-bs-subject', 'templates.bookstoreSubject'],
  ['tpl-bs-greeting', 'templates.bookstoreGreeting'],
  ['tpl-bs-closing', 'templates.bookstoreClosing'],
  ['tpl-remarks', 'templates.remarksLine'],
];

const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const set = (obj, path, val) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = val;
};

let sources = [];

function renderSources() {
  const wrap = $('sources');
  wrap.innerHTML = '';
  sources.forEach((s, i) => {
    const box = document.createElement('div');
    box.className = 'src';
    box.innerHTML = `
      <div class="grid">
        <label>名称<input data-k="label" placeholder="科研費 基盤(C)" /></label>
        <label>課題番号<input data-k="code" placeholder="00X00000" /></label>
      </div>
      <div class="grid">
        <label>予算代表者<input data-k="representative" /></label>
        <label>&nbsp;<button type="button" data-del>削除</button></label>
      </div>`;
    box.querySelectorAll('input[data-k]').forEach((input) => {
      input.value = s[input.dataset.k] || '';
      input.addEventListener('input', () => {
        sources[i][input.dataset.k] = input.value;
        if (!sources[i].id) sources[i].id = `src-${i}-${Date.now()}`;
      });
    });
    box.querySelector('[data-del]').addEventListener('click', () => {
      sources.splice(i, 1);
      renderSources();
    });
    wrap.append(box);
  });
}

async function init() {
  const p = withDefaults(await loadProfile());
  for (const [id, path] of FIELDS) {
    const node = $(id);
    if (node) node.value = get(p, path) ?? '';
  }
  sources = p.fundingSources.map((s) => ({ ...s }));
  renderSources();
}

$('add-source').addEventListener('click', () => {
  sources.push({ id: `src-${Date.now()}`, label: '', code: '', representative: '' });
  renderSources();
});

$('save').addEventListener('click', async () => {
  const p = withDefaults(await loadProfile());
  for (const [id, path] of FIELDS) {
    const node = $(id);
    if (node) set(p, path, node.value);
  }
  p.fundingSources = sources.filter((s) => s.label || s.code).map((s, i) => ({ ...s, id: s.id || `src-${i}` }));
  if (!p.defaults.fundingSourceId && p.fundingSources[0]) {
    p.defaults.fundingSourceId = p.fundingSources[0].id;
  }
  await saveProfile(p);
  $('status').textContent = '保存しました';
  setTimeout(() => ($('status').textContent = ''), 2000);
});

// テンプレート未設定のまま保存されても既定値に戻せるようにしておく
window.__resetTemplates = async () => {
  const p = withDefaults(await loadProfile());
  p.templates = { ...DEFAULT_PROFILE.templates };
  await saveProfile(p);
  location.reload();
};

init();
