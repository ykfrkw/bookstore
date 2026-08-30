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
import { readFileSync } from 'node:fs';

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

/** innerHTML を書く可能性のあるアダプタのファイル。core は DOM を触らない */
const DOM_WRITING_SOURCES = [
  'src/adapters/extension/content.js',
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
  const source = read('src/adapters/extension/content.js');
  // 'open' だと host.shadowRoot からページ側に読まれ、宛先ラベルと
  // 科研費の課題番号が露出する（SPEC「注入パネルは closed shadow DOM に閉じる」）
  assert.match(source, /attachShadow\(\s*\{\s*mode:\s*['"]closed['"]\s*\}\s*\)/);
  assert.doesNotMatch(source, /attachShadow\(\s*\{\s*mode:\s*['"]open['"]/);
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

test('package.json と manifest.json の version が一致する', () => {
  const packageVersion = JSON.parse(read('package.json')).version;
  const manifestVersion = JSON.parse(read('src/adapters/extension/manifest.json')).version;
  // ずれると、利用者の拡張のバージョンが上がらず更新に気づけない
  assert.equal(manifestVersion, packageVersion);
});
