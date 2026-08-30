/**
 * ローカル版の設定 UI（依頼者・宛先・財源・既定値）。
 *
 * app.js から切り出してあるのは、宛先を複数編集できるようにした結果
 * 1 ファイルが長くなりすぎるため。注文の組み立てには関与せず、
 * index.html の <details> 配下の DOM だけを触る。
 */
import { DESTINATION_KINDS, createDestination, destinationLabel } from '../../core/profile.js';
import { saveProfile } from '../../core/storage.js';

const $ = (id) => document.getElementById(id);
const get = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const set = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((x, k) => (x[k] ??= {}), o)[last] = v;
};

let profile;
let destinations = [];
let sources = [];
let notifySaved = () => {};

/**
 * 繰り返し編集 UI の共通処理。data-k を持つ入力を list[i] に書き戻し、
 * data-del のボタンで 1 件消す。宛先と財源で同じ挙動にするために共通化した。
 */
function renderCards(wrapId, list, createCard, onChange) {
  const wrap = $(wrapId);
  wrap.innerHTML = '';
  list.forEach((entry, i) => {
    const box = createCard();
    box.querySelectorAll('[data-k]').forEach((field) => {
      field.value = entry[field.dataset.k] || '';
      field.addEventListener('input', () => {
        list[i][field.dataset.k] = field.value;
        onChange();
      });
    });
    box.querySelector('[data-del]').addEventListener('click', () => {
      list.splice(i, 1);
      renderCards(wrapId, list, createCard, onChange);
      onChange();
    });
    wrap.append(box);
  });
}

function destinationCard() {
  const box = document.createElement('div');
  box.className = 'card';
  // 静的テンプレートのみ（変数補間なし）。値は renderCards が property 経由で入れる
  box.innerHTML = `
    <div class="grid">
      <label>種別<select data-k="kind"></select></label>
      <label>表示名<input data-k="label" placeholder="○○大学生協 書籍部" /></label>
    </div>
    <div class="grid">
      <label>宛先メール<input data-k="to" /></label>
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
  return box;
}

function sourceCard() {
  const box = document.createElement('div');
  box.className = 'card';
  box.innerHTML = `
    <div class="grid">
      <label>名称<input data-k="label" placeholder="科研費 基盤(C)" /></label>
      <label>課題番号<input data-k="code" placeholder="00X00000" /></label>
    </div>
    <div class="grid">
      <label>予算代表者<input data-k="representative" /></label>
      <label>&nbsp;<button type="button" data-del>削除</button></label>
    </div>`;
  return box;
}

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

async function save() {
  document.querySelectorAll('[data-p]').forEach((n) => set(profile, n.dataset.p, n.value));
  // 名前も宛先も空の行は保存しない（追加ボタンの押し間違いを残さない）
  profile.destinations = destinations.filter((d) => d.label || d.to);
  profile.fundingSources = sources.filter((s) => s.label || s.code);
  const selectedDest = $('def-dest').value;
  profile.defaults.destinationId = profile.destinations.some((d) => d.id === selectedDest)
    ? selectedDest
    : profile.destinations[0]?.id || '';
  profile.defaults.fundingMode = $('def-funding').value;
  if (!profile.fundingSources.some((s) => s.id === profile.defaults.fundingSourceId)) {
    profile.defaults.fundingSourceId = profile.fundingSources[0]?.id || '';
  }
  await saveProfile(profile);
  notifySaved();
  $('saved').textContent = '保存しました';
  setTimeout(() => ($('saved').textContent = ''), 2000);
}

/**
 * @param {object} currentProfile withDefaults 済みのプロフィール。ここで直接書き換える
 * @param {() => void} onSaved 保存後に注文側のセレクトを作り直させるコールバック
 */
export function initSettings(currentProfile, onSaved) {
  profile = currentProfile;
  notifySaved = onSaved;
  destinations = profile.destinations.map((d) => ({ ...d }));
  sources = profile.fundingSources.map((s) => ({ ...s }));

  document.querySelectorAll('[data-p]').forEach((n) => (n.value = get(profile, n.dataset.p) ?? ''));
  renderCards('destinations', destinations, destinationCard, () => renderDefaultDest());
  renderCards('fs-list', sources, sourceCard, () => {});
  renderDefaultDest(profile.defaults.destinationId);
  $('def-funding').value = profile.defaults.fundingMode;

  $('add-dest').addEventListener('click', () => {
    destinations.push(createDestination('coop'));
    renderCards('destinations', destinations, destinationCard, () => renderDefaultDest());
    renderDefaultDest();
  });
  $('add-fs').addEventListener('click', () => {
    sources.push({ id: `src-${Date.now()}`, label: '', code: '', representative: '' });
    renderCards('fs-list', sources, sourceCard, () => {});
  });
  $('save').addEventListener('click', save);
}
