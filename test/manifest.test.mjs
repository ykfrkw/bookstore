/**
 * manifest.json の宣言と実体の整合を、ファイル読み取りだけで固定する。
 *
 * なぜこれが要るか: 拡張の壊れ方は「宣言と実体がズレていても実行時まで誰も
 * 気づかない」種類が多い。service worker の宣言漏れ、web_accessible_resources の
 * 過不足、content script からは呼べない API の呼び出し — どれも例外を出さず
 * 静かに no-op する。node:test は DOM も chrome API も持たないが、
 * ファイルの存在と文字列の対応なら守れる。
 *
 * version の一致は extension-source.test.mjs が既に固定しているので、ここでは
 * 重複させない（同じ事実を 2 箇所で主張すると、直すべき場所が分からなくなる）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const EXTENSION_DIR = new URL('../src/adapters/extension/', import.meta.url);

const readExtensionFile = (relativePath) =>
  readFileSync(new URL(relativePath, EXTENSION_DIR), 'utf8');

const extensionFileExists = (relativePath) =>
  existsSync(new URL(relativePath, EXTENSION_DIR));

const manifest = JSON.parse(readExtensionFile('manifest.json'));

test('background service worker が宣言され、ファイルが実在する', () => {
  // 無いと content script からの「設定を開く」sendMessage が
  // Receiving end does not exist で失敗する
  const serviceWorkerPath = manifest.background?.service_worker;
  assert.ok(serviceWorkerPath, 'manifest に background.service_worker が無い');
  assert.ok(
    extensionFileExists(serviceWorkerPath),
    `background.service_worker の参照先が無い: ${serviceWorkerPath}`,
  );
});

test('manifest が参照する資産がすべて実在する', () => {
  const referencedPaths = [
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    manifest.options_page,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);

  for (const path of referencedPaths) {
    assert.ok(extensionFileExists(path), `manifest の参照先が無い: ${path}`);
  }
});

test('web_accessible_resources に options.html を出していない', () => {
  // 設定画面は background 経由で開く。ここに出すとホストページへの露出面が
  // 広がり、「注入パネルは closed shadow に閉じて露出を最小化する」設計に逆行する
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(!exposed.includes('options.html'), 'options.html を公開してはいけない');
});

test('permissions は storage だけ', () => {
  // 権限を増やさない方針の固定。sendMessage は無条件に使えるので追加は不要
  assert.deepEqual(manifest.permissions, ['storage']);
});

test('content.js は openOptionsPage を呼ばない', () => {
  // 拡張ページ専用 API で content script には存在せず、?.() で呼ぶと
  // 例外も出さず静かに no-op する（「設定を押しても何も起きない」の原因）
  const source = readExtensionFile('content.js');
  assert.doesNotMatch(source, /chrome\.runtime\.openOptionsPage/);
});

test('content.js が使う .jimoto-actions-stack が content.css に定義されている', () => {
  // shadow DOM 越しの CSS/JS の結合は壊れても静かなので、文字列レベルで対にする。
  // 外れるとボタンが縦積みにならず、flex: 1 のまま文字高まで潰れる
  const source = readExtensionFile('content.js');
  const style = readExtensionFile('content.css');
  assert.match(source, /jimoto-actions-stack/);
  assert.match(style, /\.jimoto-actions-stack\s*\{/);
});
