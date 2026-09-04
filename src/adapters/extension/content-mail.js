/**
 * パネルのメール送出とコピー。content script の 3 ファイル目。
 *
 * **メール送出のシーケンス（pickMailPlan() → クリップボード → メーラーを開く）は
 * このファイルに閉じる。** test/extension-source.test.mjs の「コピーが opener より
 * 前」は pickMailPlan() の呼び出し位置から後方を slice して index を比較している
 * ため、3 つが同一ファイルにあることが前提になっている。別ファイルに散らすと
 * テストは green のまま意味を失い、経路 3 でコピー漏れが起きても誰も気づけない。
 * 検査はコメントを除去した後のコードに対して行うので、この説明文が slice の
 * 起点を動かすことはない（以前はそれを避けるための注意書きがここにあった）。
 *
 * 「どの URL を開くか」は core の mailopen.js が決める。ここは開き方（DOM 操作）
 * と、開けなかったときの退路の見せ方だけを持つ。
 */

/**
 * URL を開く。**anchor を作って click する**（window.open は使わない）。
 *
 * window.open にしない理由が 2 つある。
 * (1) `mailto:` を window.open で開くと空白タブが残る。
 * (2) コピー経路は `await navigator.clipboard.writeText()` の後に開くため、
 *     transient user activation を失って**無言でブロックされうる**
 *     （2026-09-04 に確定した今回の症状の原因ではなかったが、実在する問題）。
 * anchor の click は activation を要求しないので、どちらも起きない。
 *
 * @param {object} args
 * @param {string} args.url
 * @param {boolean} args.newTab **target を付けるか。** mailto では必ず false。
 *   target="_blank" を付けると、自分が作った新しいタブで visibility が変わり、
 *   mailto が不発でも「開けた」と誤判定する（→ core の looksUnopened）
 * @param {ShadowRoot} args.root パネルの closed shadow root
 *
 * **anchor は root（closed shadow root）に挿して即座に外す。**
 * `document.body` に挿すと、href に乗った下書き（氏名・所属・科研費の課題番号）が
 * ホストページの `document.querySelectorAll('a[href^="mailto"]')` から読める。
 * パネルを closed shadow root に閉じた目的を丸ごと打ち消すので、絶対にしない。
 */
function jimotoOpenMailUrl({ url, newTab, root }) {
  const link = jimotoEl('a', { href: url, style: 'display: none' });
  if (newTab) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
  }
  root.append(link);
  // click が throw しても anchor を残さない。パネルは SPA の部分遷移で
  // 作り直されるので、残すとクリックのたびに href 付きの anchor が積もる
  try { link.click(); } finally { link.remove(); }
}

/**
 * ページを離れたか（＝メーラーやタブに渡ったか）を待つ。
 *
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} 離れたら true、時間切れなら false
 *
 * ハンドラが登録されていれば数十〜数百ミリ秒で visibility が変わる。
 * listener は必ず解除する（パネルは SPA の部分遷移で作り直されるので、
 * 残すとクリックのたびに積もる）。
 */
function jimotoWaitForLeave(timeoutMs) {
  return new Promise((resolve) => {
    const watched = [
      [document, 'visibilitychange'],
      [window, 'blur'],
      [window, 'pagehide'],
    ];
    let timer = 0;
    const finish = (leftPage) => {
      clearTimeout(timer);
      for (const [target, type] of watched) target.removeEventListener(type, onLeave);
      resolve(leftPage);
    };
    const onLeave = (event) => {
      // visibilitychange は「戻ってきた」ときにも発火する。hidden 以外は無視
      if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
      finish(true);
    };
    for (const [target, type] of watched) target.addEventListener(type, onLeave);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * パネルのボタンに渡すハンドラを作る。
 *
 * @param {object} deps
 * @param {object} deps.core        loadCore() の戻り（compose / profile / storage / mailopen）
 * @param {object} deps.profile     withDefaults 済みのプロファイル
 * @param {() => object} deps.getArgs composeOrder の引数を今の UI 状態から作る。
 *   宛先・支払区分・財源・冊数はクリック時点の値である必要があるので関数で受ける
 * @param {{toast: Function, openOptions: Function}} deps.ui
 *   通知と設定画面。どちらも content.js / content-ui.js 側の実装を借りる
 * @param {ShadowRoot} deps.root パネルの closed shadow root。anchor の置き場所
 * @returns {{openMail: Function, copyBody: Function, copyRemarks: Function,
 *            fallback: HTMLElement}}
 *   fallback は既定で非表示の退路。content.js がパネル木に挿す
 */
function jimotoMakeMailActions({ core, profile, getArgs, ui, root }) {
  // クリック時に読む開き方。退路からの学習を、同じページの次のクリックにも
  // 効かせるためにローカルに持つ（profile 自体は書き換えない）
  let mailOpener = profile.defaults.mailOpener;

  const hideFallback = () => fallback.classList.remove('jimoto-fallback-shown');

  /**
   * 押した瞬間のフォーム状態から plan を組む。**クリックごとに呼び直す。**
   *
   * 宛先・冊数は「押した瞬間」の値で 1 度だけ読む。validate と composeOrder に
   * 別々に読ませると、間に利用者が select を触った場合に食い違う。
   * 逆に、**組んだ plan を保持して別のボタンで使い回すこともしない。**
   * 退路は 1.2 秒後に出て閉じるまで残るので、間に財源や冊数が変わりうる。
   * 古い plan を開き直すと、利用者には「同じ下書きを別の方法で開くボタン」に
   * 見えたまま旧課題番号の下書きが飛ぶ（誤発注は研究費の執行事故になる）。
   *
   * @returns {object|null} 設定が未入力なら null（案内は出し切ってある）
   */
  const buildPlan = () => {
    const args = getArgs();
    const missing = core.validate(profile, args.destinationId);
    if (missing.length) {
      // 設定画面が開けた場合はこちらが最後に残る。開けなかった場合は
      // openOptions() の失敗トーストがこの文言を前置して引き継ぐ
      const detail = `設定が未入力です: ${missing.join(' / ')}`;
      ui.toast(detail, 'error');
      ui.openOptions(`${detail}。`);
      return null;
    }
    // 情報量の多い経路から順に試す（フル版 → 簡略版 → コピー）。
    // 判定は core の pickMailPlan に寄せてあり、長さの再計算はしない。
    // パネルには自由記述の入力欄が無いので簡略版は常に候補にできる
    return core.pickMailPlan({
      full: core.composeOrder(args),
      compact: core.composeOrder({ ...args, compact: true }),
    });
  };

  /**
   * 退路の「Gmail で開く」。**開き方の学習はここ 1 箇所だけが行う。**
   *
   * (a) その場のフォーム状態から組み直して Gmail を開く（このクリックは
   *     新しいユーザー操作なので、コピーも開くのも確実に通る）
   * (b) **開いてから**保存する。保存が失敗しても Gmail は開いている
   * (c) 次回から変わることと、戻せることを伝える
   *
   * 推定（looksUnopened）が外れても設定は書き換えない。誤検知のコストを
   * 「消せる案内 1 つ」に留めるため、書き換えは利用者のクリックだけを根拠にする。
   */
  const rememberGmailChoice = async () => {
    const plan = buildPlan();
    if (!plan) return;
    const target = core.resolveMailTarget({ plan, opener: 'gmail' });
    try {
      // コピー経路は退路のクリックでも打ち直す。前のクリックで入れた本文は
      // 古い可能性があるうえ、間に別のコピーで上書きされていることもある
      if (plan.mode === 'copy') await navigator.clipboard.writeText(plan.copyText);
      jimotoOpenMailUrl({ url: target.url, newTab: target.newTab, root });
    } catch (error) {
      // 黙って失敗すると、この PR が消そうとしている「押しても何も起きない」と
      // 見分けがつかなくなる
      ui.toast(`Gmail を開けませんでした: ${error.message}`, 'error');
      return;
    }
    hideFallback();
    mailOpener = 'gmail';
    try {
      await core.saveProfile(core.setMailOpener(profile, 'gmail'));
    } catch {
      // 拡張を再読み込みした後の content script は chrome.storage が
      // "Extension context invalidated" で throw する。実際によく起きる。
      // 開けたことと保存できなかったことは切り分けて伝える
      ui.toast('この 1 回は Gmail で開きました。設定は保存できませんでした', 'error');
      return;
    }
    ui.toast('次回から Gmail で開きます（設定で戻せます）');
  };

  // 退路。既定は非表示で、mailto が不発だったと推定できたときだけ見せる。
  // エラーではなく案内なので赤は使わない（→ content.css の .jimoto-fallback）
  const fallback = jimotoEl('div', { class: 'jimoto-fallback' }, [
    jimotoEl('div', { text: 'メーラーが開きませんでしたか？' }),
    jimotoEl('div', { class: 'jimoto-actions' }, [
      jimotoEl('button', {
        class: 'jimoto-btn',
        text: 'Gmail で開く',
        onclick: rememberGmailChoice,
      }),
      jimotoEl('button', {
        class: 'jimoto-btn jimoto-ghost',
        text: '閉じる',
        onclick: hideFallback,
      }),
    ]),
  ]);

  const openMail = async () => {
    // 前のクリックで出た退路を先に消す。再試行が成功しても残っていると、
    // 「メーラーが開きませんでしたか？」が新しい下書きの上に居座る
    hideFallback();
    const plan = buildPlan();
    if (!plan) return;
    // どの URL をどう開くかは core が決める。mailto を組み直さない
    const target = core.resolveMailTarget({ plan, opener: mailOpener });
    try {
      if (plan.mode === 'copy') {
        // フォーカスが移ると clipboard.writeText が拒否されうるので、
        // コピーを先に済ませる。この順序を入れ替えない
        await navigator.clipboard.writeText(plan.copyText);
      }
      jimotoOpenMailUrl({ url: target.url, newTab: target.newTab, root });
    } catch (error) {
      // writeText が拒否されると（document がフォーカスを失っている等）、
      // 以前はメーラーも開かずトーストも出ず「何も起きない」だけが残った
      ui.toast(`メールを開けませんでした: ${error.message}`, 'error');
      return;
    }
    if (plan.mode === 'copy') {
      ui.toast('本文をコピーしました。開いたメールに貼り付けてください');
    } else if (plan.mode === 'compact') {
      // 簡略版は貼り付けが要らない代わりに書誌が減る。黙って差し替えると
      // 「いつもと文面が違う」だけが残るので、簡略版であることを明示する
      ui.toast('本文入りでメーラーを開きました（簡略版の文面）');
    }
    // mailto のハンドラが 1 つも無いと Chrome は無反応になる。API では
    // 照会できないので、ページを離れたかどうかから推定する
    const leftPage = await jimotoWaitForLeave(core.MAIL_LEAVE_TIMEOUT_MS);
    if (core.looksUnopened({ opener: mailOpener, via: target.via, newTab: target.newTab, leftPage })) {
      fallback.classList.add('jimoto-fallback-shown');
    }
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

  return { openMail, copyBody, copyRemarks, fallback };
}
