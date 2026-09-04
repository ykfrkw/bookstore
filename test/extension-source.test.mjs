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
import { readdirSync, readFileSync } from 'node:fs';

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

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
    read('src/adapters/extension/content.js'),
    /attachShadow\(\s*\{\s*mode:\s*['"]closed['"]\s*\}\s*\)/,
    'content.js: パネルの attachShadow は mode: "closed" のまま置く',
  );

  // 否定側は content script の全ファイルに回す。content.js だけを読むと、
  // 別ファイルに足した 2 枚目のパネルやダイアログが既定値の mode: 'open' で
  // 開かれても green のまま通り、露出が静かに戻る
  for (const path of CONTENT_SCRIPT_SOURCES) {
    assert.doesNotMatch(
      read(path),
      /attachShadow\(\s*\{\s*mode:\s*['"]open['"]/,
      `${path}: open shadow はホストページから shadowRoot 経由で読める`,
    );
  }
});

test('innerHTML に変数を補間しているアダプタが無い', () => {
  for (const path of DOM_WRITING_SOURCES) {
    const source = read(path);
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
    keys: ['openMail', 'copyBody', 'copyRemarks'],
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
    const blocks = returnedObjectLiterals(read(path));
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
    const destructuring = read(consumer).match(
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
 * opener は「メーラーを開く」呼び出し。面ごとに手段が違う（拡張の content script は
 * window.open、popup は tabs.create、ローカル版は location.href）。
 *
 * content 側が content-mail.js なのは、下の「コピーが opener より前」が
 * pickMailPlan( 以降を slice して index を比較する＝ pickMailPlan・
 * clipboard.writeText・opener が同一ファイルにあることを前提にしているため。
 * 送出シーケンスを別ファイルへ散らすとこのテストは green のまま意味を失う。
 */
const MAIL_ADAPTERS = [
  { path: 'src/adapters/extension/content-mail.js', opener: /window\.open\(/ },
  { path: 'src/adapters/extension/popup.js', opener: /chrome\.tabs\.create\(/ },
  { path: 'src/adapters/local/app.js', opener: /location\.href\s*=/ },
];

test('メール導線の 3 面が pickMailPlan を通している', () => {
  for (const { path } of MAIL_ADAPTERS) {
    const source = read(path);
    // 長さ判定と 3 段階の選択を UI 側に書き写すと、面ごとに挙動がずれる
    // （SPEC「注文導線 — 情報量の多い経路から順に選ぶ」）
    assert.match(source, /pickMailPlan\(/, `${path}: pickMailPlan を通していない`);
  }
});

test('メール導線でクリップボード書き込みがメーラーを開く前にある', () => {
  for (const { path, opener } of MAIL_ADAPTERS) {
    const source = read(path);
    // 判定より前のコピー（二次アクションの「全文をコピー」など）は対象外なので、
    // pickMailPlan 以降だけを見る
    const tail = source.slice(source.search(/pickMailPlan\(/));
    const copyAt = tail.search(/clipboard\.writeText\(/);
    const openAt = tail.search(opener);
    assert.ok(copyAt !== -1, `${path}: コピー経路の clipboard.writeText が無い`);
    assert.ok(openAt !== -1, `${path}: メーラーを開く呼び出しが無い`);
    // window.open / tabs.create でフォーカスが移ると writeText が拒否されうる。
    // 経路 3 を単純な「開くだけ」に潰すと本文が失われる（SPEC 6）
    assert.ok(
      copyAt < openAt,
      `${path}: メーラーを開いた後にコピーしている（フォーカスが移ると拒否されうる）`
    );
  }
});

test('package.json と manifest.json の version が一致する', () => {
  const packageVersion = JSON.parse(read('package.json')).version;
  const manifestVersion = JSON.parse(read('src/adapters/extension/manifest.json')).version;
  // ずれると、利用者の拡張のバージョンが上がらず更新に気づけない
  assert.equal(manifestVersion, packageVersion);
});
