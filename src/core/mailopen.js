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
 * 読めない）ため、**退路（Gmail の作成画面を直接開く）と推定**しか手が無い。
 *
 * 長さは原因ではない。Gmail をハンドラにすると `mailto:` 全体が `url=` へ
 * 再エンコードされるが、膨張率は 1.63 倍（`%` 1 文字 → 3 文字なので ×3 では
 * ない）で、簡略版の Gmail URL 全体でも 2,936 文字。Gmail の実効上限にも
 * ブラウザの上限にも届かない。**だから MAILTO_SAFE_LENGTH は変えない。**
 */

/**
 * mailto を開いてからページを離れたかを見るまでの待ち時間（ミリ秒）。
 *
 * ハンドラが登録されていれば数十〜数百ミリ秒で visibility が変わる。
 * 短すぎると「開いたのに退路が出る」、長すぎると「無反応のまま黙って待つ」。
 * 1.2 秒は、遅い環境の取りこぼしと待たされ感の折り合い。
 */
export const MAIL_LEAVE_TIMEOUT_MS = 1200;

/**
 * Gmail の作成画面（compose）の URL を組む。
 *
 * `view=cm&fs=1` が作成画面のフルスクリーン表示。`/u/0/` は 1 つ目の
 * ログイン中アカウント。複数アカウントの利用者では意図と違うアカウントに
 * なりうるが、アカウント番号を当てる手段が無いので既定に寄せる
 * （開いた画面で切り替えられる。送信前に人が必ず確認する前提）。
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
  return `https://mail.google.com/mail/u/0/?${query.toString()}`;
}

/**
 * 開く URL と、その開き方を決める。
 *
 * @param {object} args
 * @param {{mode:'full'|'compact'|'copy', open:string, copyText:string, draft:object}} args.plan
 *   compose.js の pickMailPlan の戻り。**ここで作り直さない**
 * @param {'auto'|'mailto'|'gmail'} [args.opener] 利用者の設定（defaults.mailOpener）
 * @param {boolean} [args.keepPage] 今のページを残したいか（ローカル版は手編集した
 *   本文が画面にあるので必ず true。同じタブを Gmail に置き換えると編集が消える）
 * @returns {{url:string, via:'mailto'|'gmail', newTab:boolean}}
 *
 * `opener` が 'gmail' 以外のときは **plan.open をそのまま返す**。
 * mailto の URL を UI 側で組み直すと、3 段階（フル版 / 簡略版 / ヘッダのみ）の
 * 判定が pickMailPlan と二重実装になり、長さの判定が面ごとにズレる。
 */
export function resolveMailTarget({ plan, opener = 'auto', keepPage = false }) {
  if (opener !== 'gmail') {
    return { url: plan.open, via: 'mailto', newTab: Boolean(keepPage) };
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

/**
 * mailto が不発だった可能性が高いかを推定する。
 *
 * 真になるのは **1 通りだけ**:
 *   opener === 'auto' && via === 'mailto' && !newTab && !leftPage
 *
 * - `opener === 'mailto'` は利用者が「既定のメーラーで開く」を意図的に選んだ
 *   状態。ここで退路を出すと、選択を毎回否定して押し返すことになる。
 *   **絶対に含めない**
 * - `newTab` が真なら判定不能。自分が作った新しいタブでも visibility は
 *   変わるので、mailto が不発でも「開けた」に見える
 *   （だからパネルの mailto は target なしの anchor で開く）
 * - `leftPage` が真なら実際にどこかへ渡っている
 *
 * 推定は外れうる（ハンドラの登録状況は照会できない）。外れたときのコストを
 * 「消せる案内 1 つ」に留めるため、**推定だけで設定を書き換えない**。
 */
export function looksUnopened({ opener, via, newTab, leftPage }) {
  return opener === 'auto' && via === 'mailto' && !newTab && !leftPage;
}
