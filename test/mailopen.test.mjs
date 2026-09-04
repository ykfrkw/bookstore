/**
 * メールの開き方の純ロジック（src/core/mailopen.js）。
 *
 * ここで守りたいのは 3 つ。
 * (1) Gmail の URL を 1 回だけエンコードする（二重エンコードは本文に
 *     %E3%81%82 が並ぶ形で出るが、実機で開くまで気づけない）
 * (2) mailto を組み直さない（pickMailPlan の 3 段階の判定を二重実装しない）
 * (3) 退路を出す条件が 1 通りだけであること（利用者が「既定のメーラー」を
 *     選んでいるのに退路を出すと、選択を毎回否定して押し返すことになる）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_LEAVE_TIMEOUT_MS,
  buildGmailCompose,
  looksUnopened,
  resolveMailTarget,
} from '../src/core/mailopen.js';

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
  assert.ok(url.startsWith('https://mail.google.com/mail/u/0/?'));
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
    newTab: false,
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

test('newTab は gmail のとき、または keepPage のときだけ真', () => {
  const plan = planOf('compact');
  assert.equal(resolveMailTarget({ plan, opener: 'auto' }).newTab, false);
  assert.equal(resolveMailTarget({ plan, opener: 'mailto' }).newTab, false);
  // Gmail はページ遷移なので、今のタブを潰さないよう必ず新しいタブ
  assert.equal(resolveMailTarget({ plan, opener: 'gmail' }).newTab, true);
  // keepPage はローカル版（手編集した本文が画面にある面）が渡す
  assert.equal(resolveMailTarget({ plan, opener: 'auto', keepPage: true }).newTab, true);
  assert.equal(resolveMailTarget({ plan, opener: 'gmail', keepPage: true }).newTab, true);
});

test('looksUnopened が真になるのは 1 通りだけ', () => {
  const truthy = { opener: 'auto', via: 'mailto', newTab: false, leftPage: false };
  assert.equal(looksUnopened(truthy), true);

  // 1 つずつ崩すと必ず偽になる（＝真の条件が 1 通りであることの確認）
  assert.equal(looksUnopened({ ...truthy, opener: 'mailto' }), false);
  assert.equal(looksUnopened({ ...truthy, opener: 'gmail' }), false);
  assert.equal(looksUnopened({ ...truthy, via: 'gmail' }), false);
  assert.equal(looksUnopened({ ...truthy, newTab: true }), false);
  assert.equal(looksUnopened({ ...truthy, leftPage: true }), false);
});

test("opener が 'mailto' のときは退路を出さない", () => {
  // 「既定のメーラーで開く」は利用者の意図的な選択。メーラーが無い環境でも、
  // ここで退路を出すとその選択を毎回否定して押し返すことになる。
  // 上のテストと重なるが、これは仕様そのものなので単独で残す
  for (const leftPage of [true, false]) {
    for (const newTab of [true, false]) {
      assert.equal(
        looksUnopened({ opener: 'mailto', via: 'mailto', newTab, leftPage }),
        false,
        `leftPage=${leftPage} newTab=${newTab}`,
      );
    }
  }
});

test('待ち時間は 1.2 秒', () => {
  // 短すぎると「開いたのに退路が出る」、長すぎると「無反応のまま黙って待つ」。
  // 値そのものより、UI 側が独自の秒数を持たないことが要点
  assert.equal(MAIL_LEAVE_TIMEOUT_MS, 1200);
});
