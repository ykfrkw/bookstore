/**
 * パネルのメール送出とコピー。content script の 3 ファイル目。
 *
 * **メール送出のシーケンス（pickMailPlan → クリップボード → メーラーを開く）は
 * このファイルに閉じる。** test/extension-source.test.mjs の「コピーが opener より
 * 前」は pickMailPlan( の出現位置から後方を slice して index を比較しているため、
 * 3 つが同一ファイルにあることが前提になっている。別ファイルに散らすとテストは
 * green のまま意味を失い、経路 3 でコピー漏れが起きても誰も気づけない。
 */

/**
 * パネルのボタンに渡すハンドラを作る。
 *
 * @param {object} deps
 * @param {object} deps.core        loadCore() の戻り（compose / profile / storage）
 * @param {object} deps.profile     withDefaults 済みのプロファイル
 * @param {() => object} deps.getArgs composeOrder の引数を今の UI 状態から作る。
 *   宛先・支払区分・財源・冊数はクリック時点の値である必要があるので関数で受ける
 * @param {{toast: Function, openOptions: Function}} deps.ui
 *   通知と設定画面。どちらも content.js / content-ui.js 側の実装を借りる
 * @returns {{openMail: Function, copyBody: Function, copyRemarks: Function}}
 */
function jimotoMakeMailActions({ core, profile, getArgs, ui }) {
  const openMail = async () => {
    // 宛先・冊数は「押した瞬間」の値で 1 度だけ読む。validate と composeOrder に
    // 別々に読ませると、間に利用者が select を触った場合に食い違う
    const args = getArgs();
    const missing = core.validate(profile, args.destinationId);
    if (missing.length) {
      // 設定画面が開けた場合はこちらが最後に残る。開けなかった場合は
      // openOptions() の失敗トーストがこの文言を前置して引き継ぐ
      const detail = `設定が未入力です: ${missing.join(' / ')}`;
      ui.toast(detail, 'error');
      ui.openOptions(`${detail}。`);
      return;
    }
    // 情報量の多い経路から順に試す（フル版 → 簡略版 → コピー）。
    // 判定は core の pickMailPlan に寄せてあり、長さの再計算はしない。
    // パネルには自由記述の入力欄が無いので簡略版は常に候補にできる
    const plan = core.pickMailPlan({
      full: core.composeOrder(args),
      compact: core.composeOrder({ ...args, compact: true }),
    });
    if (plan.mode === 'copy') {
      // window.open でフォーカスが移ると clipboard.writeText が拒否されうるので、
      // コピーを先に済ませる。この順序を入れ替えない
      await navigator.clipboard.writeText(plan.copyText);
      window.open(plan.open, '_blank');
      ui.toast('本文をコピーしました。開いたメールに貼り付けてください');
      return;
    }
    window.open(plan.open, '_blank');
    // 簡略版は貼り付けが要らない代わりに書誌が減る。黙って差し替えると
    // 「いつもと文面が違う」だけが残るので、簡略版であることを明示する
    if (plan.mode === 'compact') ui.toast('本文入りでメーラーを開きました（簡略版の文面）');
  };

  const copyBody = async () => {
    const draft = core.composeOrder(getArgs());
    await navigator.clipboard.writeText(draft.plain);
    ui.toast('宛先・件名・本文をコピーしました');
  };

  const copyRemarks = async () => {
    const draft = core.composeOrder(getArgs());
    if (!draft.remarks) return ui.toast('備考欄は生協の宛先のみです');
    await navigator.clipboard.writeText(draft.remarks);
    ui.toast('備考欄用の1行をコピーしました');
  };

  return { openMail, copyBody, copyRemarks };
}
