/**
 * 注文の入力欄（注文先・支払・財源・冊数）の組み立て。content script の 4 ファイル目。
 *
 * content-sites.js の冒頭に書いたとおり、content script は classic script として
 * トップレベル宣言を共有する。ここは content-ui.js の `jimotoEl` に依存するので、
 * manifest では content-ui.js より後・content.js より前に並べる。
 *
 * なぜこの切り口にしたか（継ぎ目を動かすときはここを読むこと）:
 * - `(core, profile, book)` を取って `{ rows, getArgs, syncVisibility }` を返すだけで
 *   済む唯一きれいなブロック。content.js 側へ個々の要素参照が戻らない。
 * - **`attachShadow` と `PANEL_ID` は content.js に残す。**
 *   test/extension-source.test.mjs の closed shadow の肯定側は content.js を読み先に
 *   固定しているので、動かすと検査の読み先がずれる（否定側は content*.js 全件を
 *   ディスクから拾うので、このファイルも自動で対象に入る）。
 * - `clampQty` は唯一の消費者である冊数入力と一緒に置く。content.js に残すと
 *   使い手のいない迷子のグローバルになる。名前は分割前から裸のままで改名しない。
 * - 書誌の表示・ボタン・メールの退路といった「見せ方」は content.js のパネル木の
 *   隣に残す。読む人が探す場所と実体を一致させておく。
 */

// 冊数の下限は 1。非数値・0 以下が composeOrder に流れ込むのを防ぐ
function clampQty(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 注文の入力欄を作る。
 *
 * @param {object} core loadCore() の戻り（profile / compose / storage）
 * @param {object} profile withDefaults 済みのプロファイル
 * @param {object} book 書誌。openBD の応答後に content.js が中身を差し替えるので、
 *   参照を保持しておき getArgs() でクリック時点の最新を読む
 * @returns {{rows: HTMLElement[], getArgs: () => object, syncVisibility: () => void}}
 *   - rows: パネル木にそのまま並べる 3 行（注文先 → 支払 → 冊数の順）
 *   - getArgs: composeOrder / validate に渡す引数一式（items を内包）
 *   - syncVisibility: 宛先種別と支払区分に応じた行の出し入れ
 */
function jimotoBuildOrderForm(core, profile, book) {
  const defaults = profile.defaults;

  const state = {
    destinationId: defaults.destinationId || profile.destinations[0]?.id || '',
    fundingMode: defaults.fundingMode,
    fundingSourceId: defaults.fundingSourceId || profile.fundingSources[0]?.id || '',
    quantity: defaults.quantity || 1,
  };

  // option のラベルはユーザー設定由来の文字列なので text で入れる（innerHTML 補間はしない）
  const destSel = jimotoEl(
    'select',
    { class: 'jimoto-input' },
    profile.destinations.length
      ? profile.destinations.map((x) =>
          jimotoEl('option', { value: x.id, text: core.destinationLabel(x) })
        )
      : [jimotoEl('option', { value: '', text: '宛先未登録 — 設定から追加' })]
  );
  destSel.value = state.destinationId;
  // 保存済みの既定 id が消えている場合に「何も選ばれていない」状態にしない
  if (!destSel.value) destSel.selectedIndex = 0;

  const fundingSel = jimotoEl('select', { class: 'jimoto-input' }, [
    jimotoEl('option', { value: 'private', text: '私費' }),
    jimotoEl('option', { value: 'research', text: '研究費' }),
  ]);
  fundingSel.value = state.fundingMode;

  const sourceSel = jimotoEl(
    'select',
    { class: 'jimoto-input' },
    profile.fundingSources.length
      ? profile.fundingSources.map((s) =>
          jimotoEl('option', { value: s.id, text: `${s.label}${s.code ? ` (${s.code})` : ''}` })
        )
      : [jimotoEl('option', { value: '', text: '財源未登録 — 設定から追加' })]
  );
  sourceSel.value = state.fundingSourceId;

  const qty = jimotoEl('input', {
    class: 'jimoto-input jimoto-qty',
    type: 'number',
    min: '1',
    inputmode: 'numeric',
    value: String(clampQty(state.quantity)),
  });
  // 空欄・0・マイナスのまま送信されないよう、フォーカスが外れた時点で 1 に戻す
  qty.addEventListener('change', () => {
    qty.value = String(clampQty(qty.value));
  });

  const destinationRow = jimotoEl('div', { class: 'jimoto-row' }, [
    jimotoEl('label', { class: 'jimoto-label', text: '注文先' }),
    destSel,
  ]);

  const fundingRow = jimotoEl('div', { class: 'jimoto-row' }, [
    jimotoEl('label', { class: 'jimoto-label', text: '支払' }),
    fundingSel,
    sourceSel,
  ]);

  const quantityRow = jimotoEl('div', { class: 'jimoto-row' }, [
    jimotoEl('label', { class: 'jimoto-label', text: '冊数' }),
    qty,
  ]);

  const syncVisibility = () => {
    // 研究費・財源は生協の宛先でしか意味がない。composeOrder と同じ解決経路で種別を見る
    const isCoop = core.findDestination(profile, destSel.value)?.kind === 'coop';
    fundingRow.style.display = isCoop ? '' : 'none';
    sourceSel.style.display = fundingSel.value === 'research' ? '' : 'none';
  };
  destSel.addEventListener('change', syncVisibility);
  fundingSel.addEventListener('change', syncVisibility);

  const item = () => ({ book, quantity: clampQty(qty.value) });
  // composeOrder / validate に渡す引数。クリック時点の UI 状態で作る
  const orderArgs = () => ({
    destinationId: destSel.value,
    profile,
    fundingMode: fundingSel.value,
    fundingSourceId: sourceSel.value,
    items: [item()],
  });

  // rows は配列で返す。content.js 側が `...rows` で展開すれば、パネル木の
  // 注文先 → 支払 → 冊数の並びをこのファイルだけで決められる
  return {
    rows: [destinationRow, fundingRow, quantityRow],
    getArgs: orderArgs,
    syncVisibility,
  };
}
