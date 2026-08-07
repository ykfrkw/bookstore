/**
 * ローカル版。Chrome 拡張と同じ core を相対 import で読む。
 * file:// では ES module が読めないので http で開くこと（README 参照）。
 */
import { extractIsbn, toIsbn13 } from '../../core/isbn.js';
import { fetchBook, mergeFallback } from '../../core/bibliography.js';
import { withDefaults, validate } from '../../core/profile.js';
import { composeOrder, buildMailto } from '../../core/compose.js';
import { loadProfile, saveProfile } from '../../core/storage.js';

const $ = (id) => document.getElementById(id);
let profile;
let items = [];
let lastDraft = null;

const get = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const set = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((x, k) => (x[k] ??= {}), o)[last] = v;
};

// 冊数の下限は 1。非数値・0 以下が composeOrder に流れ込むのを防ぐ
const clampQty = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

function renderList() {
  const list = $('list');
  list.innerHTML = '';
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'item';
    // 静的テンプレートのみ（変数補間なし）。値は下で property 経由で入れる
    row.innerHTML = `
      <div class="t">
        <b></b>
        <span></span>
      </div>
      <input type="number" min="1" inputmode="numeric" />
      <button>削除</button>`;
    row.querySelector('b').textContent = item.book.title || '(書名不明)';
    row.querySelector('span').textContent =
      [item.book.author, item.book.publisher, item.book.isbn13].filter(Boolean).join(' / ');
    const qty = row.querySelector('input');
    qty.value = String(item.quantity ?? 1);
    qty.addEventListener('input', () => {
      items[i].quantity = clampQty(qty.value);
    });
    qty.addEventListener('change', () => {
      qty.value = String(clampQty(qty.value));
    });
    row.querySelector('button').addEventListener('click', () => {
      items.splice(i, 1);
      renderList();
    });
    list.append(row);
  });
}

async function lookup() {
  const lines = $('input').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const errors = [];
  for (const line of lines) {
    const isbn13 = /^https?:/i.test(line)
      ? extractIsbn({ url: line }).isbn13
      : toIsbn13(line);
    if (!isbn13) {
      errors.push(`ISBN を判別できません: ${line}`);
      continue;
    }
    if (items.some((x) => x.book.isbn13 === isbn13)) continue;
    const fetched = await fetchBook(isbn13);
    if (!fetched) errors.push(`openBD に見つかりません（手で書名を補ってください）: ${isbn13}`);
    items.push({ book: mergeFallback(fetched, { isbn13 }), quantity: 1, note: '' });
  }
  $('errors').textContent = errors.join('\n');
  renderList();
}

function syncVisibility() {
  const isCoop = $('route').value === 'coop';
  $('funding').closest('label').style.display = isCoop ? '' : 'none';
  $('source-wrap').style.display = isCoop && $('funding').value === 'research' ? '' : 'none';
}

function compose() {
  const missing = validate(profile, $('route').value);
  if (missing.length) {
    $('errors').textContent = `設定が未入力です: ${missing.join(' / ')}`;
    return null;
  }
  if (!items.length) {
    $('errors').textContent = '書籍が 1 件も入っていません';
    return null;
  }
  $('errors').textContent = '';
  lastDraft = composeOrder({
    route: $('route').value,
    items,
    profile,
    fundingMode: $('funding').value,
    fundingSourceId: $('source').value,
    message: $('message').value,
  });
  $('out-subject').value = lastDraft.subject;
  $('out-body').value = lastDraft.body;
  return lastDraft;
}

function renderSourceOptions() {
  // ラベルはユーザー設定由来の文字列なので new Option で生成する（innerHTML 補間はしない）
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
}

async function init() {
  profile = withDefaults(await loadProfile());
  document.querySelectorAll('[data-p]').forEach((n) => (n.value = get(profile, n.dataset.p) ?? ''));
  const fs = profile.fundingSources[0];
  if (fs) {
    $('fs-label').value = fs.label || '';
    $('fs-code').value = fs.code || '';
    $('fs-rep').value = fs.representative || '';
  }
  $('route').value = profile.defaults.route;
  $('funding').value = profile.defaults.fundingMode;
  renderSourceOptions();
  syncVisibility();
}

$('lookup').addEventListener('click', lookup);
$('clear').addEventListener('click', () => {
  items = [];
  $('input').value = '';
  $('errors').textContent = '';
  renderList();
});
$('route').addEventListener('change', syncVisibility);
$('funding').addEventListener('change', syncVisibility);
$('compose').addEventListener('click', compose);

/**
 * 「コピー」「メーラーで開く」用の下書き。
 * 本文 textarea はユーザーが手で直せるので、lastDraft の本文ではなく
 * 押下時点の #out-body の値で mailto / plain を組み直す（編集を無視しない）。
 */
function currentDraft() {
  const d = lastDraft || compose();
  if (!d) return null;
  const body = $('out-body').value;
  return { ...d, body, ...buildMailto({ to: d.to, cc: d.cc, subject: d.subject, body }) };
}

$('mailto').addEventListener('click', async () => {
  const d = currentDraft();
  if (!d) return;
  if (d.tooLongForMailto) {
    await navigator.clipboard.writeText(d.body);
    $('errors').textContent =
      '本文をコピーしました。開いたメールに貼り付けてください（和文は mailto の長さ制限を超えるため）。';
    location.href = d.mailtoHeaderOnly;
    return;
  }
  location.href = d.mailto;
});

$('copy').addEventListener('click', async () => {
  const d = currentDraft();
  if (!d) return;
  await navigator.clipboard.writeText(d.plain);
});

$('copy-remarks').addEventListener('click', async () => {
  const d = lastDraft || compose();
  if (!d?.remarks) return;
  await navigator.clipboard.writeText(d.remarks);
});

$('save').addEventListener('click', async () => {
  document.querySelectorAll('[data-p]').forEach((n) => set(profile, n.dataset.p, n.value));
  const label = $('fs-label').value;
  profile.fundingSources = label
    ? [{ id: 'primary', label, code: $('fs-code').value, representative: $('fs-rep').value }]
    : [];
  profile.defaults.route = $('route').value;
  profile.defaults.fundingMode = $('funding').value;
  profile.defaults.fundingSourceId = profile.fundingSources[0]?.id || '';
  await saveProfile(profile);
  renderSourceOptions();
  $('saved').textContent = '保存しました';
  setTimeout(() => ($('saved').textContent = ''), 2000);
});

init();
