/**
 * ローカル版。Chrome 拡張と同じ core を相対 import で読む。
 * file:// では ES module が読めないので http で開くこと（README 参照）。
 */
import { extractIsbn, toIsbn13 } from '../../core/isbn.js';
import { fetchBook, mergeFallback } from '../../core/bibliography.js';
import { withDefaults, validate } from '../../core/profile.js';
import { composeOrder } from '../../core/compose.js';
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

function renderList() {
  const list = $('list');
  list.innerHTML = '';
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div class="t">
        <b></b>
        <span></span>
      </div>
      <input type="number" min="1" value="${item.quantity}" />
      <button>削除</button>`;
    row.querySelector('b').textContent = item.book.title || '(書名不明)';
    row.querySelector('span').textContent =
      [item.book.author, item.book.publisher, item.book.isbn13].filter(Boolean).join(' / ');
    row.querySelector('input').addEventListener('input', (e) => {
      items[i].quantity = Number(e.target.value) || 1;
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
  $('source').innerHTML = profile.fundingSources.length
    ? profile.fundingSources
        .map((s) => `<option value="${s.id}">${s.label}${s.code ? ` (${s.code})` : ''}</option>`)
        .join('')
    : '<option value="">財源未登録</option>';
  $('source').value = profile.defaults.fundingSourceId || profile.fundingSources[0]?.id || '';
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

$('mailto').addEventListener('click', async () => {
  const d = lastDraft || compose();
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
  const d = lastDraft || compose();
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
