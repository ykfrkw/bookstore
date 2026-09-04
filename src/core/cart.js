/**
 * カートの純ロジック。DOM・chrome API・window に触らない。
 *
 * 置き場所の理由: 冊数の下限と「カートを数える」の 2 つは、パネル・popup・
 * ローカル版・service worker の 4 箇所が同じ答えを返さないと困る。
 * clampQty は実際に 3 面へコピーされていて（コメントまで同一だった）、
 * 片方だけ直せば composeOrder に 0 冊が流れ込む形が残っていた。
 */

/** 冊数の下限は 1。非数値・0 以下が composeOrder に流れ込むのを防ぐ */
export function clampQty(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * ツールバーアイコンのバッジ文字列。
 *
 * **冊数の合計ではなく「点数」（cart.length）を出す。** 理由は 2 つある。
 * (a) 既存の唯一の数表示 — パネルのトースト「注文リストに追加（N点）」— と
 *     揃う。2 箇所で違う数を見せると、どちらが正しいのか利用者に分からない。
 * (b) 冊数合計にすると、popup で冊数を変えたときにバッジが動く必要がある。
 *     冊数の編集は storage を経由するようになったので技術的には可能だが、
 *     「2 点・合計 7 冊」で 7 と出るバッジは点数と読み違えられる。
 *
 * 0 点では空文字を返す（`'0'` を出すと「0 という数のバッジ」が常駐する）。
 */
export function badgeText(cart) {
  return cart.length ? String(cart.length) : '';
}
