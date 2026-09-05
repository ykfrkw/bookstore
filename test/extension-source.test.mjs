/**
 * アダプタ側のソースを「文字列として」検査する回帰テスト。
 *
 * なぜこんな検査をするのか: content.js / options.js / app.js は DOM と
 * chrome API に依存していて Node では import すら通らない。つまり
 * ネットワークにも DOM にも触らないテスト環境では、実行して確かめる手段が無い。
 * それでも壊れたら困る性質（shadow root が closed であること、innerHTML に
 * 変数を混ぜないこと）があるので、ソース文字列の検査で最低限を固定する。
 *
 * 検査は「壊れたら落ちる」ためのものであって、安全性を証明するものではない。
 * ここを増やすより、ロジックを src/core/ に寄せて普通のテストで守る方が良い。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { MAIL_OPENERS } from '../src/core/profile.js';
// 検査はコードに対して行う（ソース側に「この語を書くな」という制約を書き込むのは
// 筋が悪い）。manifest.test.mjs も同じ readCode を使う。→ test/helpers/source.mjs
import { read, readCode } from './helpers/source.mjs';

const EXTENSION_DIR = new URL('../src/adapters/extension/', import.meta.url);

/**
 * content script として注入されるファイル。manifest の宣言ではなくディスク上の
 * 実体から拾うのは、宣言を忘れたファイル（注入されないので実機では死んでいる）も
 * 検査対象に入れておきたいから。宣言漏れ自体は test/manifest.test.mjs が落とす。
 */
const CONTENT_SCRIPT_SOURCES = readdirSync(EXTENSION_DIR)
  .filter((name) => /^content.*\.js$/.test(name))
  .sort()
  .map((name) => `src/adapters/extension/${name}`);

/**
 * innerHTML を書く可能性のあるアダプタのファイル。core は DOM を触らない。
 *
 * content script 側は列挙せず CONTENT_SCRIPT_SOURCES から広げる。手で並べると、
 * 次に content-*.js を足した人が追記を忘れた時点で、そのファイルだけ
 * innerHTML 補間の検査が静かに素通りする（追記漏れ自体を落とすテストは無い）。
 * ディスクから拾っておけば新しい content script が自動で対象に入る。
 * 拡張ページとローカル版は命名規約が無いのでここに書き足す。
 */
const DOM_WRITING_SOURCES = [
  ...CONTENT_SCRIPT_SOURCES,
  'src/adapters/extension/options.js',
  'src/adapters/extension/popup.js',
  'src/adapters/local/app.js',
  'src/adapters/local/settings.js',
];

/**
 * `innerHTML = ` の右辺を切り出す。テンプレートリテラルなら閉じバッククォート
 * まで、そうでなければ文末（; か改行）まで。
 */
const INNER_HTML_ASSIGNMENT = /innerHTML\s*=\s*(`(?:[^`\\]|\\[\s\S])*`|[^;\n]*)/g;

test('注入パネルの shadow root は closed のまま', () => {
  // 'open' だと host.shadowRoot からページ側に読まれ、宛先ラベルと
  // 科研費の課題番号が露出する（SPEC「注入パネルは closed shadow DOM に閉じる」）
  assert.match(
    readCode('src/adapters/extension/content.js'),
    /attachShadow\(\s*\{\s*mode:\s*['"]closed['"]\s*\}\s*\)/,
    'content.js: パネルの attachShadow は mode: "closed" のまま置く',
  );

  // 否定側は content script の全ファイルに回す。content.js だけを読むと、
  // 別ファイルに足した 2 枚目のパネルやダイアログが既定値の mode: 'open' で
  // 開かれても green のまま通り、露出が静かに戻る
  for (const path of CONTENT_SCRIPT_SOURCES) {
    assert.doesNotMatch(
      readCode(path),
      /attachShadow\(\s*\{\s*mode:\s*['"]open['"]/,
      `${path}: open shadow はホストページから shadowRoot 経由で読める`,
    );
  }
});

test('innerHTML に変数を補間しているアダプタが無い', () => {
  for (const path of DOM_WRITING_SOURCES) {
    const source = readCode(path);
    for (const [, rightHandSide] of source.matchAll(INNER_HTML_ASSIGNMENT)) {
      // 書誌・宛先ラベルはユーザー入力や外部サイト由来。補間すると XSS になる。
      // 値は textContent か property 経由（new Option / field.value）で入れる
      assert.ok(
        !rightHandSide.includes('${'),
        `${path}: innerHTML に変数を補間している -> ${rightHandSide.slice(0, 60)}`,
      );
    }
  }
});

/**
 * ファイル間の契約（提供側の `return { … }` と消費側の分割代入）。
 *
 * content script は import 文を持たない classic script なので、提供側の return から
 * キーを 1 つ落としても、消費側は undefined を受け取るだけでテストは全件 green の
 * まま通る。実機では buildPanel 内で TypeError（syncVisibility is not a function /
 * rows is not iterable）や addToCart(undefined) になるが、run() の throw は
 * tick() の .catch に吸われるため、**利用者から見た症状は「パネルが静かに出ない」
 * だけ**になる（SPEC と content-ui.js が名指ししている最悪の壊れ方）。
 *
 * Node からは import できないので、既存の流儀どおりソース文字列で突き合わせる。
 * 契約が増えたらこの配列に 1 行足す。
 */
const CROSS_FILE_CONTRACTS = [
  {
    path: 'src/adapters/extension/content-panel.js',
    factory: 'jimotoBuildOrderForm',
    consumer: 'src/adapters/extension/content.js',
    keys: ['rows', 'getArgs', 'syncVisibility'],
  },
  {
    path: 'src/adapters/extension/content-mail.js',
    factory: 'jimotoMakeMailActions',
    consumer: 'src/adapters/extension/content.js',
    // fallback は退路の DOM。落とすと「メーラーが開かない環境で退路が出ない」
    // ＝元の症状（押しても何も起きない）にそのまま戻る
    keys: ['openMail', 'copyBody', 'copyRemarks', 'fallback'],
  },
];

/**
 * `return {` の右辺を波括弧の対応で切り出し、ソース中の全ブロックを返す。
 * 文字列やコメント中の括弧は数えてしまうが、対象は数行のオブジェクトリテラルで
 * あり、そこに裸の波括弧は現れない。
 */
const returnedObjectLiterals = (source) => {
  const blocks = [];
  for (const match of source.matchAll(/return\s*\{/g)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let cursor = start;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}' && --depth === 0) break;
    }
    blocks.push(source.slice(start, cursor + 1));
  }
  return blocks;
};

const hasKey = (text, key) => new RegExp(`\\b${key}\\b`).test(text);

test('ファイル間の契約が提供側の return と消費側の分割代入で揃っている', () => {
  for (const { path, factory, consumer, keys } of CROSS_FILE_CONTRACTS) {
    // 提供側: キーが最も揃っている return ブロックを契約とみなす。
    // 「どれか 1 つでも欠けた」を、欠けたキー名つきで落とす
    const blocks = returnedObjectLiterals(readCode(path));
    const [provided = []] = blocks
      .map((block) => keys.filter((key) => hasKey(block, key)))
      .sort((a, b) => b.length - a.length);
    for (const key of keys) {
      assert.ok(
        provided.includes(key),
        `${path}: ${factory} の return { … } に ${key} が無い。消費側は undefined を ` +
          '受け取り、例外は run().catch に飲まれてパネルが静かに出なくなる',
      );
    }

    // 消費側: 受け取り忘れも同じ症状になるので、分割代入の中身まで見る
    const destructuring = readCode(consumer).match(
      new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${factory}\\b`),
    );
    assert.ok(destructuring, `${consumer}: ${factory} の戻りを分割代入していない`);
    for (const key of keys) {
      assert.ok(
        hasKey(destructuring[1], key),
        `${consumer}: ${factory} から ${key} を受け取っていない`,
      );
    }
  }
});

/**
 * メール導線を持つ 3 面。どれも DOM / chrome API 依存で Node からは実行できない。
 * opener は「メーラーを開く」呼び出し。面ごとに手段が違う。
 *
 * **opener は自前の関数名で書く。** 以前は `window.open(` / `location.href =` を
 * 期待していたが、どちらも実機で害があって捨てた手段（前者は空白タブが残り、
 * activation を失うと無言でブロックされる。後者は Gmail がハンドラのとき今の
 * タブが置き換わり、ローカル版の手編集が消える）。ブラウザ API 名で固定すると
 * 「捨てた手段に戻す」変更が緑のまま通ってしまう。
 *
 * **opener は呼び出しの形（行頭 ＋ 任意の `await`）で書く。** 関数名だけで
 * 探すと定義（`function jimotoOpenMailUrl(…)`）も掴む。今は定義が最初の
 * pickMailPlan より前にあるので偶然当たらないが、定義が呼び出しの間に移った
 * 時点で「コピーが opener より前」が偽の失敗を出す（テストが実装の並び順に
 * 依存してしまう）。行頭で縛れば定義は `function ` が前置されるので外れる。
 *
 * content 側が content-mail.js なのは、下の「コピーが opener より前」が
 * pickMailPlan の呼び出し以降を slice して index を比較する＝ pickMailPlan・
 * clipboard.writeText・opener が同一ファイルにあることを前提にしているため。
 * 送出シーケンスを別ファイルへ散らすとこのテストは green のまま意味を失う。
 */
const MAIL_ADAPTERS = [
  {
    path: 'src/adapters/extension/content-mail.js',
    opener: /^\s*(?:await\s+)?jimotoOpenMailUrl\(/m,
  },
  { path: 'src/adapters/extension/popup.js', opener: /^\s*(?:await\s+)?chrome\.tabs\.create\(/m },
  { path: 'src/adapters/local/app.js', opener: /^\s*(?:await\s+)?openMailUrl\(/m },
];

test('メール導線の 3 面が pickMailPlan を通している', () => {
  for (const { path } of MAIL_ADAPTERS) {
    const source = readCode(path);
    // 長さ判定と 3 段階の選択を UI 側に書き写すと、面ごとに挙動がずれる
    // （SPEC「注文導線 — 情報量の多い経路から順に選ぶ」）
    assert.match(source, /pickMailPlan\(/, `${path}: pickMailPlan を通していない`);
  }
});

test('メール導線の 3 面が resolveMailTarget を通している', () => {
  for (const { path } of MAIL_ADAPTERS) {
    // 「どの URL を開くか」は core の 1 箇所で決める。面ごとに mailto を
    // 組み直すと pickMailPlan の 3 段階の判定が二重実装になり、Gmail の
    // URL 組み立てが 3 つに増える（片方だけ直した時点で挙動がズレる）
    assert.match(
      readCode(path),
      /resolveMailTarget\(/,
      `${path}: resolveMailTarget を通していない`,
    );
  }
});

test('Gmail の URL を知っているのは core だけ', () => {
  for (const { path } of MAIL_ADAPTERS) {
    // 面に直書きすると view=cm / fs=1 / su= の組み立てが増殖する。
    // とくに「コピー経路では body を載せない」の対称性は core にしかないので、
    // 直書きした面だけ本文が黙って切られる
    assert.ok(
      !readCode(path).includes('mail.google.com'),
      `${path}: Gmail の URL を直書きしている（core の buildGmailCompose を使う）`,
    );
  }
});

test('メール導線でクリップボード書き込みがメーラーを開く前にある', () => {
  for (const { path, opener } of MAIL_ADAPTERS) {
    const source = readCode(path);
    // 判定より前のコピー（二次アクションの「全文をコピー」など）は対象外なので、
    // pickMailPlan 以降だけを見る
    const tail = source.slice(source.search(/pickMailPlan\(/));
    const copyAt = tail.search(/clipboard\.writeText\(/);
    const openAt = tail.search(opener);
    assert.ok(copyAt !== -1, `${path}: コピー経路の clipboard.writeText が無い`);
    assert.ok(openAt !== -1, `${path}: メーラーを開く呼び出しが無い`);
    // anchor.click() / tabs.create でフォーカスが移ると writeText が拒否されうる。
    // 経路 3 を単純な「開くだけ」に潰すと本文が失われる（SPEC 6）
    assert.ok(
      copyAt < openAt,
      `${path}: メーラーを開いた後にコピーしている（フォーカスが移ると拒否されうる）`
    );
  }
});

test('捨てた開き方に戻っていない（window.open / location.href への代入）', () => {
  // どちらも実機で症状を出した形。名指しで禁じておく。
  // window.open: mailto を開くと空白タブが残り、コピー経路（writeText を
  // await した後）では transient user activation を失って無言でブロックされうる
  assert.doesNotMatch(
    readCode('src/adapters/extension/content-mail.js'),
    /window\.open\(/,
    'content-mail.js: window.open に戻さない。anchor を作って click する',
  );
  // location.href への代入: Gmail が mailto のハンドラだと今のタブが Gmail に
  // 置き換わり、ローカル版で手編集した本文と組み立てた下書きが消える
  assert.doesNotMatch(
    readCode('src/adapters/local/app.js'),
    /location\.href\s*=/,
    'app.js: location.href への代入に戻さない。新しいタブで開く',
  );
});

test('パネルの mailto を新しいタブで開く（target を落としていない）', () => {
  const source = readCode('src/adapters/extension/content-mail.js');
  // target を落とすと、`mailto:` に web ハンドラ（Gmail 等）を登録している
  // 利用者で現在のタブが遷移し、見ていた書籍ページが消える（実機での指摘）。
  // 以前は「開けたか」を推定するために target を付けられなかったが、推定は
  // 捨てた（→ 下の「推定の残骸が content script に無い」）
  assert.match(
    source,
    /target:\s*'_blank'/,
    'content-mail.js: anchor に target="_blank" を付けていない（現在のタブが遷移する）',
  );
  assert.match(
    source,
    /rel:\s*'noopener'/,
    'content-mail.js: rel="noopener" を落とさない',
  );
});

test('推定の残骸が content script に無い', () => {
  // 推定（ページを離れたかを 1.2 秒待つ）は新しいタブと両立しない。自分が
  // 作ったタブでも visibility は変わるので必ず「開けた」に倒れる。
  // 消し忘れると、退路を消す死んだ分岐がテスト green のまま復活する。
  // content script 全ファイルに回すのは、待ちを別ファイルへ移して素通りさせないため
  for (const path of CONTENT_SCRIPT_SOURCES) {
    const source = readCode(path);
    assert.doesNotMatch(
      source,
      /waitForLeave|looksUnopened|MAIL_LEAVE_TIMEOUT_MS/i,
      `${path}: 捨てた推定（waitForLeave / looksUnopened）が残っている`,
    );
  }
});

test('パネルの Gmail 退路が常設リンクになっている', () => {
  const source = readCode('src/adapters/extension/content-mail.js');
  // 既定で見せる。ハンドラの登録状況は API から照会できず、新タブでは推定も
  // 成立しないので、出し分けをやめて最初から置く。クラスを付けて「見せる」
  // 形（jimoto-fallback-shown）に戻すと、押しても何も起きない利用者に何も出ない
  assert.ok(
    !source.includes('jimoto-fallback-shown'),
    'content-mail.js: 退路は常設。表示クラスによる出し分けに戻さない',
  );
  // 隠すのは「既に gmail で開く設定」のときだけ
  assert.match(
    source,
    /jimoto-fallback-hidden/,
    'content-mail.js: gmail 設定済みのときに退路を隠す出し分けが無い',
  );
  const start = source.search(/const syncFallback\b/);
  assert.ok(start !== -1, 'content-mail.js: syncFallback が無い');
  assert.match(
    source.slice(start).split(/\n  const /)[0],
    /mailOpener === 'gmail'/,
    'content-mail.js: 退路を隠す条件が「gmail に設定済み」でない',
  );
  // 常設リンクの実体（Gmail を開くボタン）。文言ではなくハンドラで固定する
  assert.match(
    source,
    /text: 'Gmail で開く',\s*\n\s*onclick: rememberGmailChoice,/,
    'content-mail.js: 「Gmail で開く」が rememberGmailChoice を呼んでいない',
  );
});

test('下書きを載せた anchor を light DOM に出さない', () => {
  const source = readCode('src/adapters/extension/content-mail.js');
  // anchor の href には下書き（氏名・所属・科研費の課題番号）が乗る。
  // ホストページの document に挿すと querySelectorAll('a[href^="mailto"]') で
  // 読める。パネルを閉じた shadow root に隠した目的を丸ごと打ち消す。
  //
  // 挿し方のリテラル 1 つを禁じるだけでは足りない。肯定側（root への append）を
  // 残したまま appendChild を 1 行足せば両方を満たせてしまい、下書き入りの
  // anchor が light DOM に入る形が green のまま通る（実測）。このファイルが
  // document を触る正当な理由は無い（挿し先は引数で受ける）ので、挿し先に
  // なりうる 3 つのノードを名指しで禁じる
  assert.doesNotMatch(
    source,
    /document\.(body|documentElement|head)/,
    'content-mail.js: anchor を light DOM に挿している（href に下書きが乗る）',
  );
  // 肯定側も見る。否定だけだと「append をやめて innerHTML で挿す」等で素通りする
  assert.match(
    source,
    /root\.append\(/,
    'content-mail.js: anchor は閉じた shadow root に挿して即座に外す',
  );
});

test('退路の「Gmail で開く」が押した瞬間のフォーム状態から組み直す', () => {
  const source = readCode('src/adapters/extension/content-mail.js');
  // 退路は 1.2 秒後に出て、閉じるか再マウントまで残る。その間に財源や冊数が
  // 変わりうるので、前のクリックで組んだ plan を保持して開き直してはいけない。
  // 利用者からは「同じ下書きを別の方法で開くボタン」に見えるため、旧課題番号の
  // 下書きが飛んでも差分に気づく手掛かりが無い（誤発注は研究費の執行事故）
  assert.doesNotMatch(
    source,
    /lastPlan/,
    'content-mail.js: 直前の plan を保持している（退路が古い下書きを開く）',
  );
  // 肯定側。rememberGmailChoice の本体が buildPlan() を呼んでいること。
  // クリックハンドラは const の連なりなので、次の const 宣言までを本体とみなす
  const start = source.search(/const rememberGmailChoice\b/);
  assert.ok(start !== -1, 'content-mail.js: rememberGmailChoice が無い');
  const body = source.slice(start).split(/\n  const /)[0];
  assert.match(
    body,
    /buildPlan\(/,
    'content-mail.js: rememberGmailChoice が buildPlan() を呼び直していない',
  );
});

/** #def-mail-opener の <select> を持つ面。3 値をベタ書きしている */
const MAIL_OPENER_SELECTS = [
  'src/adapters/extension/options.html',
  'src/adapters/local/index.html',
];

test('メールの開き方の <option> が MAIL_OPENERS と一致する', () => {
  for (const path of MAIL_OPENER_SELECTS) {
    const html = read(path);
    const start = html.search(/<select[^>]*id="def-mail-opener"/);
    assert.ok(start !== -1, `${path}: #def-mail-opener の select が無い`);
    const select = html.slice(start, html.indexOf('</select>', start));
    const values = [...select.matchAll(/<option\s+value="([^"]*)"/g)].map(([, v]) => v);
    // value="gmial" のような打ち間違いは保存され、読み出しで auto に丸まり、
    // セレクトは「自動」を表示する。エラーは出ず「設定が保存できない」だけが
    // 静かに残るので、HTML の 3 値と MAIL_OPENERS を突き合わせておく
    assert.deepEqual(values, MAIL_OPENERS, `${path}: <option> の値が MAIL_OPENERS と違う`);
  }
});

test('コメント除去が検査対象のコードまで消していない', () => {
  // 除去が過剰だと、検査対象の行が消えて否定側のテストが偽の成功を返す。
  // 各ファイルで「消えては困る 1 行」が残っていることを見ておく
  const mustSurvive = [
    ['src/adapters/extension/content-mail.js', /root\.append\(link\)/],
    ['src/adapters/extension/content-mail.js', /clipboard\.writeText\(/],
    ['src/adapters/extension/popup.js', /chrome\.tabs\.create\(/],
    ['src/adapters/local/app.js', /document\.body\.append\(link\)/],
    // 文字列の中の `//`（URL のスキーム区切り）を巻き添えにしない
    ['src/core/bibliography.js', /'https:\/\/api\.openbd\.jp/],
  ];
  for (const [path, pattern] of mustSurvive) {
    assert.match(readCode(path), pattern, `${path}: コメント除去が行き過ぎている`);
  }
  // 逆に、コメントは確実に落ちていること（落ちないと肯定側がコメントで満たせる）
  assert.doesNotMatch(
    readCode('src/adapters/extension/content-mail.js'),
    /window\.open は使わない/,
    'stripComments がブロックコメントを落としていない',
  );
});

test('開き方の学習は退路のクリック 1 箇所だけが行う', () => {
  const source = readCode('src/adapters/extension/content-mail.js');
  // 推定（looksUnopened）は外れうる。ハンドラの登録状況は API から照会できず、
  // 推定の材料は visibility の変化しかない。だから推定の結果で設定を
  // 書き換えてはいけない（外れると mailto に戻す方法が設定画面しか無くなる）。
  // 書き換えの根拠は利用者のクリックだけ ＝ 呼び出しは 1 箇所であるべき
  const calls = source.match(/setMailOpener\(/g) || [];
  assert.equal(
    calls.length,
    1,
    'content-mail.js: setMailOpener の呼び出しが 1 箇所でない（推定で黙って ' +
      '切り替えていないか確認する）',
  );
  assert.match(
    source,
    /rememberGmailChoice/,
    'content-mail.js: 退路のクリックハンドラ（rememberGmailChoice）が無い',
  );
});

test('content.js の loadCore が core の全モジュールを読む', () => {
  // 足し忘れると core.xxx が undefined になり、呼んだ時点の TypeError が
  // run().catch に飲まれて「パネルが静かに出ない」だけが残る。
  // 読み先を src/core/ にするのは、拡張側の core/ が sync-core.mjs の生成物
  // （git 管理外）で、同期前でもこのテストが意味を持つようにするため
  const loadCore = readCode('src/adapters/extension/content.js');
  const coreModules = readdirSync(new URL('../src/core/', import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .sort();
  assert.ok(coreModules.length > 0, 'src/core に .js が無い');
  for (const name of coreModules) {
    assert.ok(
      loadCore.includes(`core/${name}`),
      `content.js の loadCore() が core/${name} を import していない`,
    );
  }
});

/**
 * `clampQty` を持つ 3 面と、それぞれが core から受け取る形。
 *
 * この 3 つには以前まったく同じ実装が（片方はコメントまで同じで）置かれていた。
 * 冊数の下限がずれると composeOrder に「0冊」の行が入る＝誤発注につながるので、
 * **定義は src/core/cart.js の 1 つだけ**にして、戻らないよう固定する。
 * content-panel.js は import を持たない classic script なので loadCore() 経由の
 * `core.clampQty` を、拡張ページとローカル版は core/cart.js からの import を使う。
 */
const CLAMP_QTY_CONSUMERS = [
  {
    path: 'src/adapters/extension/content-panel.js',
    via: /\bcore\.clampQty\(/,
    how: 'loadCore() の戻りから core.clampQty で受け取る',
  },
  {
    path: 'src/adapters/extension/popup.js',
    via: /import\s*\{[^}]*\bclampQty\b[^}]*\}\s*from\s*'\.\/core\/cart\.js'/,
    how: "'./core/cart.js' から import する",
  },
  {
    path: 'src/adapters/local/app.js',
    via: /import\s*\{[^}]*\bclampQty\b[^}]*\}\s*from\s*'\.\.\/\.\.\/core\/cart\.js'/,
    how: "'../../core/cart.js' から import する",
  },
];

test('clampQty を再定義している面が無い', () => {
  for (const { path, via, how } of CLAMP_QTY_CONSUMERS) {
    const source = readCode(path);
    // 定義の形（宣言・代入）を禁じる。import と core.clampQty はどちらも
    // この形に当たらないので、正しい受け取り方だけが残る
    assert.doesNotMatch(
      source,
      /(?:function|const|let|var)\s+clampQty\b/,
      `${path}: clampQty を再定義している。定義は src/core/cart.js だけに置く`,
    );
    assert.doesNotMatch(
      source,
      /\bclampQty\s*=[^=]/,
      `${path}: clampQty に代入している。定義は src/core/cart.js だけに置く`,
    );
    // 肯定側。禁止だけだと「clampQty を丸ごと消して素の Number() にした」
    // （＝下限 1 が消えて 0 冊が通る）変更が green のまま通る
    assert.match(source, via, `${path}: clampQty を ${how} 形になっていない`);
  }
});

/**
 * カートを書き換える面と、通すべき保存層の API。
 *
 * カートは `chrome.storage` に載る永続状態なので、面が手元の配列だけを
 * 書き換えると popup を閉じて開き直した時点で変更が消える（PR8 で直した
 * 実バグの形が `cart[i].quantity = …` だった）。`storage.js` 側には
 * round-trip のテストがあるが、**面がその API を呼んでいるか**は Node から
 * 確かめられない（popup.js / content.js は document・chrome.* 依存で
 * import すら通らない）。MAIL_ADAPTERS / CLAMP_QTY_CONSUMERS と同じ流儀で
 * ソース文字列を見る。
 *
 * `src/adapters/local/app.js` は対象外。あそこの `items` は永続化されない
 * ページ内リストで、カートではない（直接書き換えるのが正しい）。
 */
const CART_WRITE_SURFACES = [
  {
    path: 'src/adapters/extension/popup.js',
    calls: [/\bsetCartQuantity\(/, /\bremoveFromCart\(/, /\bclearCart\(/],
  },
  // content script は import を持たないので loadCore() の戻り経由で呼ぶ
  { path: 'src/adapters/extension/content.js', calls: [/\bcore\.addToCart\(/] },
];

test('カートを書き換える面が保存層の API を通している', () => {
  for (const { path, calls } of CART_WRITE_SURFACES) {
    const source = readCode(path);
    for (const call of calls) {
      assert.match(source, call, `${path}: ${call.source} を呼んでいない`);
    }
  }
});

test('popup がカートの要素に直接代入していない', () => {
  // 否定側が要る。肯定側だけだと「API を呼びつつメモリも直接書く」形が
  // green のまま通り、保存された値と画面の値が食い違う。`.quantity =` は
  // 実際にあったバグの形（main の popup.js にはこれが書かれている）
  assert.doesNotMatch(
    readCode('src/adapters/extension/popup.js'),
    /\.quantity\s*=[^=]/,
    'popup.js: カートの要素に直接代入している（保存されず、開き直すと戻る）',
  );
});

test('popup の注文メールが冊数を DOM の入力欄から読む', () => {
  const source = readCode('src/adapters/extension/popup.js');
  // 保存の await の後ろでモジュール変数 `cart` を差し替える形だと、冊数を
  // 打った直後にボタンを押したとき**古い冊数で本文が組まれる**。mousedown の
  // blur で change が同期発火し、chrome.storage の await で中断したまま
  // click ハンドラが先に走るため（レースではなく決定論的な順序）。
  // DOM が要るので Node では再現できない。せめて形だけ固定する
  assert.doesNotMatch(
    source,
    /items:\s*cart\b/,
    'popup.js: composeOrder にモジュール変数 cart を渡している（打鍵直後の冊数が載らない）',
  );
  assert.match(
    source,
    /items:\s*draftItems\(\)/,
    'popup.js: composeOrder の items が draftItems() 経由でない',
  );
  // 肯定側だけでは足りない。`draftItems = () => cart` にすると上の 2 つを
  // 満たしたまま元の症状に戻るので、入力欄の value を読むことまで見る
  assert.match(
    source,
    /const draftItems\s*=[^;]*qty\.value/,
    'popup.js: draftItems が冊数入力欄の value を読んでいない',
  );
});

test('popup のタブ表示が CSS と JS の対になっている', () => {
  // popup.html は 2 通りの開かれ方をする（ツールバーの popup と、注入パネルの
  // 「注文リスト」から開くタブ）。タブでは 340px 固定を解く必要があるが、
  // CSS と付与側のどちらが欠けても**例外は出ない**。片方だけ残ると、
  // タブで開いた注文リストが画面の左端に細長い柱として出る（読めるので
  // 「そういうデザイン」に見えてしまい、壊れていると気づきにくい）
  assert.match(
    read('src/adapters/extension/popup.html'),
    /body\.tab\s*\{/,
    'popup.html に body.tab の定義が無い（タブで 340px の柱になる）',
  );
  assert.match(
    readCode('src/adapters/extension/popup.js'),
    /classList\.add\('tab'\)/,
    "popup.js が body へ 'tab' クラスを付けていない（body.tab が効かない）",
  );
  // 判定は chrome.tabs.getCurrent（popup では undefined）。?tab=1 のような URL の
  // 契約に戻すと、開く側が付け忘れた時点で静かに popup 幅のまま出る
  assert.match(
    readCode('src/adapters/extension/popup.js'),
    /chrome\.tabs\.getCurrent\(\)/,
    'popup.js がタブモードを chrome.tabs.getCurrent() で判定していない',
  );
});

test('タブで開いた注文リストが復帰時にカートを読み直す', () => {
  // タブモードの popup.html は長寿命で、開いたまま Amazon 側で「カートに入れる」が
  // 走る。読み直す契機が無いと、注文メールは rows（＝この画面の DOM）から組まれる
  // ので**あとから追加した本が黙って落ちる**（さらに「リストを空にする」は
  // 画面に一度も出ていない本まで消す）。DOM が要るので Node では再現できない。
  // 形だけ固定する: 復帰側で storage を読み直し、その結果で描き直していること
  const source = readCode('src/adapters/extension/popup.js');
  const handler = source.match(
    /addEventListener\(\s*'visibilitychange'\s*,\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)/,
  );
  assert.ok(handler, 'popup.js: visibilitychange でタブへの復帰を拾っていない');
  // 離脱側（hidden）でも走ると、入力中の冊数欄が作り直される
  assert.match(handler[1], /document\.hidden/, 'popup.js: 離脱側で早期 return していない');
  assert.match(
    handler[1],
    /=\s*await loadCart\(\)/,
    'popup.js: 復帰時に storage を読み直していない（init の 1 回きりに戻っている）',
  );
  assert.match(
    handler[1],
    /renderCart\(\)/,
    'popup.js: 読み直した結果で rows を作り直していない（メールは rows から組まれる）',
  );
});

test('package.json と manifest.json の version が一致する', () => {
  const packageVersion = JSON.parse(read('package.json')).version;
  const manifestVersion = JSON.parse(read('src/adapters/extension/manifest.json')).version;
  // ずれると、利用者の拡張のバージョンが上がらず更新に気づけない
  assert.equal(manifestVersion, packageVersion);
});
