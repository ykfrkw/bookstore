/**
 * メールの開き方の純ロジック（src/core/mailopen.js）。
 *
 * ここで守りたいのは 3 つ。
 * (1) Gmail の URL を 1 回だけエンコードする（二重エンコードは本文に
 *     %E3%81%82 が並ぶ形で出るが、実機で開くまで気づけない）
 * (2) mailto を組み直さない（pickMailPlan の 3 段階の判定を二重実装しない）
 * (3) **常に新しいタブで開く**こと。false に戻ると、mailto の web ハンドラ
 *     （Gmail 等）を登録している利用者では現在のタブが遷移し、見ていた
 *     書籍ページが消える（実機で指摘された症状そのもの）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailCompose, resolveMailTarget } from '../src/core/mailopen.js';

/** pickMailPlan の戻りを模した最小の plan。draft は composeOrder の出力の形 */
const planOf = (mode, { body = '本文の1行目\n本文の2行目' } = {}) => ({
  mode,
  open: mode === 'copy' ? 'mailto:coop@example.ac.jp?subject=%E4%BB%B6%E5%90%8D' : 'mailto:coop@example.ac.jp?subject=%E4%BB%B6%E5%90%8D&body=%E6%9C%AC%E6%96%87',
  copyText: mode === 'copy' ? body : '',
  draft: {
    to: 'coop@example.ac.jp',
    cc: 'lab@example.ac.jp',
    subject: '【書籍注文】科研費 山田 太郎（1点）',
    body,
  },
});

test('buildGmailCompose は作成画面の URL を組む', () => {
  const url = buildGmailCompose({
    to: 'coop@example.ac.jp',
    subject: '件名',
    body: '本文',
  });
  assert.ok(url.startsWith('https://mail.google.com/mail/?'), url);
  // `/u/0/` は付けない。個人 Google がアカウント 0、大学 Google が 1 の利用者で、
  // 所属と科研費の課題番号を載せた下書きが個人アカウントの作成画面に開く。
  // 番号を落とすと Google 側が「最後に使ったアカウント」に解決する
  assert.ok(!url.includes('/u/0/'), url);
  const query = new URL(url).searchParams;
  assert.equal(query.get('view'), 'cm');
  assert.equal(query.get('fs'), '1');
  assert.equal(query.get('to'), 'coop@example.ac.jp');
  assert.equal(query.get('su'), '件名');
  assert.equal(query.get('body'), '本文');
});

test('buildGmailCompose は cc を空のまま載せない', () => {
  // 空の cc を載せると Gmail の cc 欄が開いた状態になる（実害は無いが、
  // 「CC を設定していないのに CC 欄が出る」は設定ミスに見える）
  const url = buildGmailCompose({ to: 'a@example.ac.jp', subject: '件名' });
  assert.ok(!url.includes('cc='), url);
  const withCc = buildGmailCompose({ to: 'a@example.ac.jp', cc: 'b@example.ac.jp' });
  assert.equal(new URL(withCc).searchParams.get('cc'), 'b@example.ac.jp');
});

test('buildGmailCompose のエンコードは 1 回だけ', () => {
  // 二重エンコードの印は %25（= % の encode）。mailto の URL をそのまま
  // 渡すとこうなる。だから呼び出し側は plan.draft の生の値を渡すこと
  const url = buildGmailCompose({
    to: 'coop@example.ac.jp',
    subject: '【書籍注文】',
    body: 'あいうえお',
  });
  assert.ok(!url.includes('%25'), `二重エンコードされている: ${url}`);
  // 1 回エンコードされていれば、デコードして元の文字列に戻る
  assert.equal(new URL(url).searchParams.get('body'), 'あいうえお');
});

test("opener が 'auto' / 'mailto' のとき plan.open を一字も変えない", () => {
  for (const opener of ['auto', 'mailto']) {
    for (const mode of ['full', 'compact', 'copy']) {
      const plan = planOf(mode);
      const target = resolveMailTarget({ plan, opener });
      assert.equal(target.url, plan.open, `${opener} / ${mode}`);
      assert.equal(target.via, 'mailto');
    }
  }
});

test('opener を省略すると auto と同じ（mailto をそのまま開く）', () => {
  const plan = planOf('compact');
  assert.deepEqual(resolveMailTarget({ plan }), {
    url: plan.open,
    via: 'mailto',
    newTab: true,
  });
});

test('gmail × 本文入りの経路は body を載せる', () => {
  for (const mode of ['full', 'compact']) {
    const plan = planOf(mode);
    const target = resolveMailTarget({ plan, opener: 'gmail' });
    assert.equal(target.via, 'gmail');
    const query = new URL(target.url).searchParams;
    assert.equal(query.get('body'), plan.draft.body, mode);
    assert.equal(query.get('to'), plan.draft.to);
    assert.equal(query.get('su'), plan.draft.subject);
  }
});

test('gmail × コピー経路は body を載せない', () => {
  // mailtoHeaderOnly と対称。Gmail 側の URL の実効上限は未実測なので、
  // 収まらない長さを載せて黙って切られるのを避ける。
  // 本文は plan.copyText でクリップボードに入っているので失われない
  const plan = planOf('copy');
  const target = resolveMailTarget({ plan, opener: 'gmail' });
  const url = new URL(target.url);
  assert.equal(url.searchParams.get('body'), null, target.url);
  assert.ok(!target.url.includes('body='), target.url);
  assert.equal(url.searchParams.get('su'), plan.draft.subject);
  assert.equal(plan.copyText, plan.draft.body);
});

test('newTab は常に true（どの opener・どの経路でも新しいタブ）', () => {
  // false に戻ると、`mailto:` に web ハンドラ（Gmail 等）を登録している利用者で
  // 現在のタブが遷移し、見ていた書籍ページが消える。**これが実機での指摘。**
  // 以前は opener === 'auto' だけ false にして「開けたか」を推定していたが、
  // 新タブにすると推定は必ず外れる（自分が作ったタブでも visibility は変わる）ので
  // 推定ごと捨てた。退路は常設リンクとして残してある
  for (const opener of ['auto', 'mailto', 'gmail', undefined]) {
    for (const mode of ['full', 'compact', 'copy']) {
      const target = resolveMailTarget({ plan: planOf(mode), opener });
      assert.equal(target.newTab, true, `${opener} / ${mode}`);
    }
  }
});

test('新タブにしても plan.open と Gmail の契約は変わらない', () => {
  // newTab を触ったついでに URL の組み立てまで動かしていないことを見る。
  // mailto を UI 側で組み直すと pickMailPlan の 3 段階が二重実装になる
  for (const mode of ['full', 'compact', 'copy']) {
    const plan = planOf(mode);
    const target = resolveMailTarget({ plan, opener: 'mailto' });
    assert.equal(target.url, plan.open, mode);
    assert.equal(target.via, 'mailto', mode);
  }
});

test('捨てた推定の道具が core に残っていない', async () => {
  // looksUnopened / MAIL_LEAVE_TIMEOUT_MS は「新タブなら必ず外れる」推定の
  // ためだけにあった。export が残っていると、UI 側が呼び戻して
  // 「常に開けたと判定して退路を消す」死んだ分岐が静かに復活する
  const mailopen = await import('../src/core/mailopen.js');
  assert.equal(mailopen.looksUnopened, undefined, 'looksUnopened を戻さない');
  assert.equal(mailopen.MAIL_LEAVE_TIMEOUT_MS, undefined, '1.2 秒の推測値を戻さない');
});
