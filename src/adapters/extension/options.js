import {
  withDefaults,
  DEFAULT_PROFILE,
  DESTINATION_KINDS,
  createDestination,
  destinationLabel,
} from './core/profile.js';
import { loadProfile, saveProfile } from './core/storage.js';

const $ = (id) => document.getElementById(id);

const FIELDS = [
  ['req-name', 'requester.name'],
  ['req-kana', 'requester.kana'],
  ['req-affiliation', 'requester.affiliation'],
  ['req-email', 'requester.email'],
  ['req-phone', 'requester.phone'],
  ['req-delivery', 'requester.deliveryPlace'],
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
let destinations = [];

/** 既定の宛先セレクト。表示名は編集中に変わるので、宛先を触るたび作り直す */
function renderDefaultDest(selected) {
  const sel = $('def-dest');
  const keep = selected ?? sel.value;
  sel.textContent = '';
  if (destinations.length) {
    // ラベルはユーザー入力由来なので new Option で入れる（innerHTML 補間はしない）
    for (const d of destinations) sel.append(new Option(destinationLabel(d), d.id));
  } else {
    sel.append(new Option('宛先未登録', ''));
  }
  sel.value = keep || '';
  if (!sel.value) sel.selectedIndex = 0;
}

function renderDestinations() {
  const wrap = $('destinations');
  wrap.innerHTML = '';
  destinations.forEach((dest, i) => {
    const box = document.createElement('div');
    box.className = 'src';
    // 静的テンプレートのみ（変数補間なし）。値は下で property 経由で入れる
    box.innerHTML = `
      <div class="grid">
        <label>種別<select data-k="kind"></select></label>
        <label>表示名<input data-k="label" placeholder="○○大学生協 書籍部" /></label>
      </div>
      <div class="grid">
        <label>宛先メール<input data-k="to" type="email" /></label>
        <label>CC<input data-k="cc" /></label>
      </div>
      <div class="grid">
        <label>受取方法<input data-k="receiveMethod" placeholder="研究室へ配達" /></label>
        <label>受取店舗<input data-k="storeName" /></label>
      </div>
      <div class="grid">
        <label>組合員番号 / 会員番号<input data-k="memberNumber" /></label>
        <label>&nbsp;<button type="button" data-del>削除</button></label>
      </div>`;
    box
      .querySelector('select[data-k="kind"]')
      .append(...DESTINATION_KINDS.map((k) => new Option(k.label, k.value)));
    box.querySelectorAll('[data-k]').forEach((field) => {
      field.value = dest[field.dataset.k] || '';
      field.addEventListener('input', () => {
        destinations[i][field.dataset.k] = field.value;
        renderDefaultDest();
      });
    });
    box.querySelector('[data-del]').addEventListener('click', () => {
      destinations.splice(i, 1);
      renderDestinations();
      renderDefaultDest();
    });
    wrap.append(box);
  });
}

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
  destinations = p.destinations.map((d) => ({ ...d }));
  renderDestinations();
  renderDefaultDest(p.defaults.destinationId);
}

$('add-source').addEventListener('click', () => {
  sources.push({ id: `src-${Date.now()}`, label: '', code: '', representative: '' });
  renderSources();
});

$('add-dest').addEventListener('click', () => {
  destinations.push(createDestination('coop'));
  renderDestinations();
  renderDefaultDest();
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
  // 名前も宛先も空の行は保存しない（追加ボタンの押し間違いを残さない）。
  // 浅コピーするのは、destinations の要素が renderDestinations の input
  // ハンドラに書き換えられ続けるオブジェクトだから。そのまま代入すると
  // 保存後のプロフィールが編集中の値をエイリアスする。この画面は保存後に
  // 注文を組まないので実害は出ないが、同じ書き方をローカル版に残した結果
  // 「未保存の宛先が下書きに載る」事故になったので、こちらも揃える
  p.destinations = destinations.filter((d) => d.label || d.to).map((d) => ({ ...d }));
  const selectedDest = $('def-dest').value;
  p.defaults.destinationId = p.destinations.some((d) => d.id === selectedDest)
    ? selectedDest
    : p.destinations[0]?.id || '';
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
