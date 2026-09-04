/**
 * 「メーラーをどう開くか」の純ロジック。
 *
 * なぜ core に切り出すか: 開き方は 3 面（注入パネル・popup・ローカル版）で
 * 手段が違う（anchor.click / tabs.create / 新タブ）が、**どの URL を開くか**は
 * 3 面で同じでなければならない。UI 側に書くと Gmail の URL 組み立てが 3 つに
 * 増え、片方だけ直した時点で面ごとに挙動がズレる。
 *
 * 背景（2026-09-04 に実機で確定した原因）:
 * Gmail が `chrome://settings/handlers` で `mailto:` のハンドラとして登録されて
 * いないと、Chrome は OS の既定メーラーへ投げ、それも無ければ**無反応**になる。
 * 押しても何も起きないので、利用者からは拡張の不具合と区別がつかない。
 * ハンドラの登録状況は API から照会できない（`registerProtocolHandler` は
 * 読めない）ため、手は**退路（Gmail の作成画面を直接開く）**しかない。
 *
 * **推定はやめた（2026-09-05）。** 以前は「ページを離れたか」を 1.2 秒待って
 * 見張り、離れなければ退路を出していた。だが「新しいタブで開く」と両立しない:
 * 自分が作った新タブでも visibility は変わるので、mailto が不発でも「開けた」に
 * なる。実機で「同じタブが Gmail に置き換わって書籍ページが消える」と指摘され、
 * 新タブを採る＝推定を捨てる、と決めた（→ SPEC「メールの開き方」）。
 * 退路は推定の有無に関わらず**常設のリンク**として残るので、失うのは
 * 「開けなかった人にだけ出す」という出し分けだけ。ハンドラが無い人には
 * **空白タブが開く**という目に見える signal が出るので、以前の「何も起きない」
 * より状況が読める。1.2 秒という推測値（OS のメーラーのコールドスタートが
 * 3〜5 秒かかると誤検知した）も消える。
 *
 * 長さは原因ではない。Gmail をハンドラにすると `mailto:` 全体が `url=` へ
 * 再エンコードされるが、膨張率は 1.63 倍（`%` 1 文字 → 3 文字なので ×3 では
 * ない）で、簡略版の Gmail URL 全体でも 2,936 文字。Gmail の実効上限にも
 * ブラウザの上限にも届かない。**だから MAILTO_SAFE_LENGTH は変えない。**
 */

/**
 * Gmail の作成画面（compose）の URL を組む。
 *
 * `view=cm&fs=1` が作成画面のフルスクリーン表示。
 *
 * **`/u/0/`（1 つ目のログイン中アカウント）は付けない。** 付けると、個人の
 * Google がアカウント 0・大学の Google がアカウント 1 という利用者で、所属と
 * 科研費の課題番号を載せた下書きが**個人アカウントの作成画面**に開く。
 * 気づかずに送ると個人アドレスから大学の発注メールが飛ぶ。アカウント番号を
 * 当てる手段は無いので、番号を落として Google 側の「最後に使ったアカウント」に
 * 解決させる（利用者の意図に近い。送信前に人が必ず確認する前提）。
 *
 * **エンコードは URLSearchParams の 1 回だけ。** mailto の本文を
 * `encodeURIComponent` 済みの文字列として渡すと二重エンコードになり、
 * Gmail の本文に `%E3%81%82` がそのまま並ぶ（`%` → `%25` で判別できる）。
 * だから呼び出し側は plan.open ではなく plan.draft の生の値を渡すこと。
 */
export function buildGmailCompose({ to, cc = '', subject = '', body = '' }) {
  const query = new URLSearchParams({ view: 'cm', fs: '1', to: to || '' });
  if (cc) query.set('cc', cc);
  if (subject) query.set('su', subject);
  if (body) query.set('body', body);
  return `https://mail.google.com/mail/?${query.toString()}`;
}

/**
 * 開く URL と、その開き方を決める。
 *
 * @param {object} args
 * @param {{mode:'full'|'compact'|'copy', open:string, copyText:string, draft:object}} args.plan
 *   compose.js の pickMailPlan の戻り。**ここで作り直さない**
 * @param {'auto'|'mailto'|'gmail'} [args.opener] 利用者の設定（defaults.mailOpener）
 * @returns {{url:string, via:'mailto'|'gmail', newTab:boolean}}
 *
 * `opener` が 'gmail' 以外のときは **plan.open をそのまま返す**。
 * mailto の URL を UI 側で組み直すと、3 段階（フル版 / 簡略版 / ヘッダのみ）の
 * 判定が pickMailPlan と二重実装になり、長さの判定が面ごとにズレる。
 *
 * **`newTab` は常に true。** 3 面とも新しいタブで開く。
 * - パネル: `mailto:` に web ハンドラ（Gmail 等）が登録されていると、target なしの
 *   anchor は**現在のタブ**を遷移させ、見ていた書籍ページが消える（実機での指摘）
 * - ローカル版: 手編集した本文が画面にあるので、現在のタブを潰せない
 * - popup: `chrome.tabs.create` なので構造的に常に新しいタブ
 *
 * 以前は `opener === 'auto'` だけ false にして「開けたか」を推定していたが、
 * 新タブにすると推定が必ず外れる（自分が作ったタブでも visibility は変わる）ので
 * 推定ごと捨てた。代わりに退路（Gmail）を常設にしてある。
 * 代償: OS のメーラーを使っている利用者には `mailto:` ＋ target="_blank" の
 * 既知の挙動で**空白タブが残りうる**。ハンドラが 1 つも無い利用者にとっては、
 * その空白タブが「渡す先が無い」という唯一の目に見える signal でもある。
 */
export function resolveMailTarget({ plan, opener = 'auto' }) {
  if (opener !== 'gmail') {
    return { url: plan.open, via: 'mailto', newTab: true };
  }
  const draft = plan.draft || {};
  return {
    // コピー経路では本文を載せない。mailtoHeaderOnly と対称にしてある。
    // Gmail 側の URL の実効上限は未実測で、収まらない長さを載せると黙って
    // 切られる（切れたことに気づけないのが最悪）。plan.copyText は不変なので
    // 手元のクリップボードにはフル版の本文が残っている
    url: buildGmailCompose({
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      body: plan.mode === 'copy' ? '' : draft.body,
    }),
    via: 'gmail',
    // Gmail はページ遷移なので、今のタブを潰さないよう必ず新しいタブで開く
    newTab: true,
  };
}
