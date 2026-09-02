/**
 * ローカル版。Chrome 拡張と同じ core を相対 import で読む。
 * file:// では ES module が読めないので http で開くこと（README 参照）。
 */
import { extractIsbn, toIsbn13 } from '../../core/isbn.js';
import { fetchBook, mergeFallback } from '../../core/bibliography.js';
import { withDefaults, validate, findDestination, destinationLabel } from '../../core/profile.js';
import { composeOrder, buildMailto, pickMailPlan } from '../../core/compose.js';
import { loadProfile } from '../../core/storage.js';
import { initSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
let profile;
let items = [];
let lastDraft = null;
// lastDraft を作ったときの composeOrder 引数。簡略版を同じ入力から組むために持つ
let lastArgs = null;

// 冊数の下限は 1。非数値・0 以下が composeOrder に流れ込むのを防ぐ
const clampQty = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/**
 * #errors への表示。赤（--destructive）はエラー専用なので、エラーでない案内は
 * info クラスに切り替えて muted 色で出す（SPEC「UI / デザインシステム」）。
 * 表示のたびにクラスを付け替えるのが要点。前回の色が残ると
 * 「コピーしました」が赤字で出る。
 */
function showMessage(text, kind = 'error') {
  const box = $('errors');
  box.className = kind === 'error' ? 'bad' : 'info';
  box.textContent = text;
}

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
  showMessage(errors.join('\n'));
  renderList();
}

function syncVisibility() {
  // 研究費・財源は生協の宛先でしか意味がない
  const isCoop = findDestination(profile, $('dest').value)?.kind === 'coop';
  $('funding').closest('label').style.display = isCoop ? '' : 'none';
  $('source-wrap').style.display = isCoop && $('funding').value === 'research' ? '' : 'none';
}

/** composeOrder への引数。フル版と簡略版で同じものを使い回す */
function orderArgs() {
  return {
    destinationId: $('dest').value,
    items,
    profile,
    fundingMode: $('funding').value,
    fundingSourceId: $('source').value,
    message: $('message').value,
  };
}

function compose() {
  const missing = validate(profile, $('dest').value);
  if (missing.length) {
    showMessage(`設定が未入力です: ${missing.join(' / ')}`);
    return null;
  }
  if (!items.length) {
    showMessage('書籍が 1 件も入っていません');
    return null;
  }
  showMessage('');
  // 簡略版は「lastDraft と同じ入力」から作らないと、フル版と簡略版で宛先や
  // 支払区分が食い違う（このページは選択の変更で本文を作り直さないため）
  lastArgs = orderArgs();
  lastDraft = composeOrder(lastArgs);
  $('out-subject').value = lastDraft.subject;
  $('out-body').value = lastDraft.body;
  return lastDraft;
}

// ラベルはユーザー設定由来の文字列なので new Option で生成する（innerHTML 補間はしない）
function renderOrderOptions() {
  const dest = $('dest');
  // 設定を保存した直後にも呼ばれる。選択中の宛先が残っているならそれを維持する
  const keptDest = dest.value;
  dest.textContent = '';
  if (profile.destinations.length) {
    for (const d of profile.destinations) dest.append(new Option(destinationLabel(d), d.id));
  } else {
    dest.append(new Option('宛先未登録 — 設定から追加', ''));
  }
  dest.value = keptDest || profile.defaults.destinationId;
  // 選択中・既定の宛先が消えている場合に「何も選ばれていない」状態にしない
  if (!dest.value) dest.value = profile.defaults.destinationId;
  if (!dest.value) dest.selectedIndex = 0;

  const source = $('source');
  const keptSource = source.value;
  source.textContent = '';
  if (profile.fundingSources.length) {
    for (const s of profile.fundingSources) {
      source.append(new Option(`${s.label}${s.code ? ` (${s.code})` : ''}`, s.id));
    }
  } else {
    source.append(new Option('財源未登録', ''));
  }
  source.value = keptSource || profile.defaults.fundingSourceId;
  if (!source.value) source.selectedIndex = 0;
}

async function init() {
  profile = withDefaults(await loadProfile());
  renderOrderOptions();
  $('funding').value = profile.defaults.fundingMode;
  syncVisibility();
  // 設定が保存されたら、注文側のセレクトを作り直して表示名のズレを残さない
  initSettings(profile, () => {
    renderOrderOptions();
    syncVisibility();
  });
}

$('lookup').addEventListener('click', lookup);
$('clear').addEventListener('click', () => {
  items = [];
  $('input').value = '';
  showMessage('');
  renderList();
});
$('dest').addEventListener('change', syncVisibility);
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
  // 本文 textarea を手で直している場合は簡略版を候補にしない。
  // 簡略版は生成物なので、差し替えると利用者の編集を黙って捨てることになる。
  // （ひとこと欄が埋まっている場合は composeOrder 側がフル版に戻す）
  const edited = !lastDraft || !lastArgs || $('out-body').value !== lastDraft.body;
  const plan = pickMailPlan({
    full: d,
    compact: edited ? null : composeOrder({ ...lastArgs, compact: true }),
  });
  if (plan.mode === 'copy') {
    // フォーカスが移る前にコピーを済ませる。この順序を入れ替えない
    await navigator.clipboard.writeText(plan.copyText);
    showMessage(
      '本文をコピーしました。開いたメールに貼り付けてください（和文は mailto の長さ制限を超えるため）。',
      'info'
    );
  } else if (plan.mode === 'compact') {
    // 貼り付けは要らない代わりに書誌が減る。文面が変わった理由を明示する
    showMessage(
      '本文入りでメーラーを開きました（簡略版の文面。貼り付けは不要です）。',
      'info'
    );
  } else {
    showMessage('');
  }
  location.href = plan.open;
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

init();
