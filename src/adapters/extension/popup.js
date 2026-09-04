import { withDefaults, validate, findDestination, destinationLabel } from './core/profile.js';
import { composeOrder, pickMailPlan } from './core/compose.js';
import { resolveMailTarget } from './core/mailopen.js';
import { clampQty } from './core/cart.js';
import {
  loadProfile,
  loadCart,
  setCartQuantity,
  removeFromCart,
  clearCart,
} from './core/storage.js';

const $ = (id) => document.getElementById(id);
let profile;
let cart = [];

function renderCart() {
  const list = $('list');
  list.textContent = '';
  if (!cart.length) {
    // 静的な文言のみ（変数補間なし）なので innerHTML で問題ない
    list.innerHTML = '<div class="empty">書籍ページで「カートに入れる」を押すと<br />ここに溜まります</div>';
    renderMailHint();
    return;
  }
  cart.forEach((item) => {
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
    // 保存は change（フォーカスが外れる / Enter）だけで行う。input ごとに
    // 書くと 1 桁打つ間に chrome.storage への書き込みが並び、次の PR で
    // storage.onChanged からバッジを更新するときに無駄な発火が増える。
    // メモリ上の配列だけ書き換えて保存しない形には戻さないこと（popup を
    // 閉じて開き直すと冊数が戻る、という実バグだった）
    qty.addEventListener('change', async () => {
      const quantity = clampQty(qty.value);
      qty.value = String(quantity);
      cart = await setCartQuantity(item.book.isbn13, quantity);
      // 冊数でも本文の長さは動くので、経路の予告を出し直す
      renderMailHint();
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
  renderMailHint();
}

function syncVisibility() {
  // 研究費・財源は生協の宛先でしか意味がない
  const isCoop = findDestination(profile, $('dest').value)?.kind === 'coop';
  $('funding-row').style.display = isCoop ? '' : 'none';
  $('source').style.display = $('funding').value === 'research' ? '' : 'none';
  // 宛先・支払区分で本文の長さが変わるため、経路の予告も評価し直す
  renderMailHint();
}

function draft(compact = false) {
  return composeOrder({
    destinationId: $('dest').value,
    items: cart,
    profile,
    fundingMode: $('funding').value,
    fundingSourceId: $('source').value,
    compact,
  });
}

/**
 * メールボタンの下に「どの経路で開くか」を押す前に出す。
 * popup は chrome.tabs.create で即座に閉じるため、クリック後に書いた案内は
 * 切り離し表示のときしか読めない。SPEC の「経路 2 で開いたことは必ず利用者に
 * 伝える」を満たすには、押す前に静的に見せておくしかない。
 */
function renderMailHint() {
  const hint = $('mail-hint');
  // カートが空・設定未入力のときは経路を評価しても意味が無い（押しても止まる）
  if (!cart.length || validate(profile, $('dest').value).length) {
    hint.textContent = '';
    return;
  }
  const plan = pickMailPlan({ full: draft(), compact: draft(true) });
  if (plan.mode === 'copy') {
    hint.textContent = '本文をコピーして開きます（メールに貼り付けが必要です）';
  } else if (plan.mode === 'compact') {
    hint.textContent = '本文入りで開きます（簡略版の文面。貼り付け不要）';
  } else {
    hint.textContent = '本文入りで開きます（貼り付け不要）';
  }
}

/**
 * #status への表示。赤（--destructive）はエラー専用なので、
 * 案内は info クラスに切り替えて muted 色で出す（SPEC「UI / デザインシステム」）。
 */
function setStatus(message, kind = 'error') {
  const status = $('status');
  status.className = kind === 'error' ? '' : 'info';
  status.textContent = message;
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
    setStatus(`設定が未入力です: ${missing.join(' / ')}`);
    setTimeout(() => chrome.runtime.openOptionsPage(), 600);
    return;
  }
  // 情報量の多い経路から順に試す（フル版 → 簡略版 → コピー）。
  // popup には自由記述の入力欄が無いので簡略版は常に候補にできる
  const plan = pickMailPlan({ full: draft(), compact: draft(true) });
  // 利用者への案内はクリック前の #mail-hint が本体。ここは popup を切り離して
  // 開いている場合にだけ読める補助（tabs.create で popup は即座に閉じる）
  if (plan.mode === 'compact') {
    setStatus('本文入りでメーラーを開きました（簡略版の文面）', 'info');
  } else if (plan.mode === 'copy') {
    setStatus('本文をコピーしました。開いたメールに貼り付けてください', 'info');
  } else {
    setStatus('');
  }
  // どの URL を開くかは core が決める（3 面で同じ判断にするため）。
  // popup は tabs.create で必ず新しいタブになるので「開けたか」の推定は
  // できない（自分が作ったタブで visibility が変わるため）。
  // したがってこの面に退路は出さず、設定（mailOpener）にそのまま従う
  const target = resolveMailTarget({ plan, opener: profile.defaults.mailOpener });
  // tabs.create で popup が閉じるため、コピー完了を待ってから開く
  if (plan.mode === 'copy') await navigator.clipboard.writeText(plan.copyText);
  chrome.tabs.create({ url: target.url });
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
