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

/** content_scripts で注入される js の相対パス（宣言順のまま） */
const contentScriptFiles = manifest.content_scripts.flatMap((entry) => entry.js || []);

/** 全 content script を 1 本の文字列として見る（型やリテラルの有無を見るとき用） */
const contentScriptSource = () => contentScriptFiles.map(readExtensionFile).join('\n');

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

test('web_accessible_resources に content script が fetch/import する資産がある', () => {
  // 「出してはいけないもの」だけを固定すると、消しても green のまま実機だけ壊れる。
  // core/*.js が抜けると loadCore() の動的 import が失敗してパネルが出ず、
  // content.css が抜けると shadow root へ流し込む CSS が取れず完全に無スタイルになる
  // （CLAUDE.md「入れ忘れると黙って失敗する」）
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  for (const required of ['core/*.js', 'content.css']) {
    assert.ok(exposed.includes(required), `web_accessible_resources に ${required} が無い`);
  }
});

test('permissions は storage だけ', () => {
  // 権限を増やさない方針の固定。sendMessage は無条件に使えるので追加は不要
  assert.deepEqual(manifest.permissions, ['storage']);
});

test('content script のどのファイルも openOptionsPage を呼ばない', () => {
  // 拡張ページ専用 API で content script には存在せず、?.() で呼ぶと
  // 例外も出さず静かに no-op する（「設定を押しても何も起きない」の原因）。
  //
  // 守りたいのは「呼ばない」ことであって「名前を書かない」ことではない。
  // 名前ごと禁じると罠の説明が婉曲表現になり、一番読まれる場所から grep 可能な
  // 固有名詞が消えるので、呼び出し形 `openOptionsPage(` / `openOptionsPage?.(`
  // だけを禁じる。
  // content script は 4 ファイルに分かれているので、content.js だけを見ると
  // 別ファイルに書かれた呼び出しを見逃す。宣言されている全ファイルを回す
  for (const path of contentScriptFiles) {
    assert.doesNotMatch(
      readExtensionFile(path),
      /openOptionsPage\s*(\?\.)?\s*\(/,
      `${path}: content script では openOptionsPage は undefined`,
    );
  }
});

test('content script と background.js のメッセージ型が一致する', () => {
  // MV3 の制約で content script と service worker は定数を共有できず、型は
  // 2 ファイルに直書きになる。片方だけ改名すると npm test は green のまま、
  // 実機では毎回「設定画面を開けませんでした」が出る（元のバグに近い症状）。
  // 対をテストで固定するのがその代わりの防波堤。
  // 送信側がどのファイルにあっても良いよう、content script 全体を読み先にする
  const background = readExtensionFile('background.js');
  const messageType = background.match(/OPEN_OPTIONS\s*=\s*['"]([^'"]+)['"]/)?.[1];
  assert.ok(messageType, 'background.js から OPEN_OPTIONS の値を取り出せない');
  assert.ok(
    contentScriptSource().includes(messageType),
    `content script が background.js のメッセージ型 ${messageType} を送っていない`,
  );
});

test('content_scripts.js が期待した順序で宣言されている', () => {
  // classic script の 4 分割はトップレベル宣言の共有で成立している。
  // 定義より前に使う順序（例: content.js が先）にすると JIMOTO_SITES の参照が
  // TDZ で落ち、run() の catch に飲まれて「パネルが出ない」だけが残る。
  // 「manifest の参照先が実在する」テストは配列から抜けても素通りするので、
  // 抜け・並び替えの両方をここで受け止める
  assert.deepEqual(manifest.content_scripts[0].js, [
    'content-sites.js',
    'content-ui.js',
    'content-mail.js',
    'content.js',
  ]);
});

test('JIMOTO_SITES の定義と参照が対になっている', () => {
  // ファイル間の契約はグローバル 1 個ぶんの名前だけで成立していて、
  // 片方を改名しても構文エラーにならない（実行時に undefined になるだけ）。
  // 定義側と参照側を対で固定する。接頭 JIMOTO_ / jimoto はこの grep 可能性のため
  assert.match(readExtensionFile('content-sites.js'), /JIMOTO_SITES\s*=/);
  assert.match(readExtensionFile('content.js'), /JIMOTO_SITES/);
});

test('background.js は onMessage listener をトップレベルで同期登録する', () => {
  // MV3 の SW は idle で停止し、メッセージ受信で起動する。起動直後の同期実行中に
  // 登録が終わっていないとイベントを取りこぼすため、await の後ろや関数の中に
  // 入れてはいけない。行頭一致で「ネストしていない」ことを固定する
  const background = readExtensionFile('background.js');
  assert.match(background, /^chrome\.runtime\.onMessage\.addListener\(/m);
});

test('content.js が使う .jimoto-actions-stack が content.css に定義されている', () => {
  // shadow DOM 越しの CSS/JS の結合は壊れても静かなので、文字列レベルで対にする。
  // 外れるとボタンが縦積みにならず、flex: 1 のまま文字高まで潰れる
  const source = readExtensionFile('content.js');
  const style = readExtensionFile('content.css');
  assert.match(source, /jimoto-actions-stack/);
  assert.match(style, /\.jimoto-actions-stack\s*\{/);
});
