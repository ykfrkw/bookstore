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
 * @param {boolean} [args.keepPage] 今のページを残したいか（ローカル版は手編集した
 *   本文が画面にあるので必ず true。同じタブを Gmail に置き換えると編集が消える）
 * @returns {{url:string, via:'mailto'|'gmail', newTab:boolean}}
 *
 * `opener` が 'gmail' 以外のときは **plan.open をそのまま返す**。
 * mailto の URL を UI 側で組み直すと、3 段階（フル版 / 簡略版 / ヘッダのみ）の
 * 判定が pickMailPlan と二重実装になり、長さの判定が面ごとにズレる。
 *
 * **`newTab` を読むのはパネル（content-mail.js）だけ。** popup は
 * `chrome.tabs.create`、ローカル版は `target="_blank"` 固定で、どちらも構造的に
 * 常に新しいタブになるため、この値を見る必要が無い（＝見ていない）。
 */
export function resolveMailTarget({ plan, opener = 'auto', keepPage = false }) {
  if (opener !== 'gmail') {
    return {
      url: plan.open,
      via: 'mailto',
      // **推定をしない場面では現在のタブを犠牲にしない。**
      // `auto` で target を付けないのは推定を成立させるためだけの制約
      // （target="_blank" を付けると自分が作った新タブで visibility が変わり、
      // mailto が不発でも「開けた」と誤判定して looksUnopened が死ぬ）。
      // `mailto` に固定した時点で推定はしない（looksUnopened が真になるのは
      // opener === 'auto' のときだけ）ので、制約を守る理由も無くなる。
      // web ハンドラ（Gmail 等）を登録している利用者は、固定モードにすれば
      // 見ていた書籍ページが現在のタブに残る。
      //
      // 代償: 固定モードで **OS のメーラー**を使っている利用者には、
      // `mailto:` ＋ target="_blank" の既知の挙動で空白タブが残りうる。
      // 固定は明示的な選択であり、既定の `auto`（target なし）は汚さない。
      newTab: opener === 'mailto' || Boolean(keepPage),
    };
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
