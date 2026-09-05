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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cssTokenValue, readCode } from './helpers/source.mjs';

const EXTENSION_DIR = new URL('../src/adapters/extension/', import.meta.url);

const readExtensionFile = (relativePath) =>
  readFileSync(new URL(relativePath, EXTENSION_DIR), 'utf8');

/** コメントを落とした拡張ファイル（「書いてはいけない値」を見る検査で使う） */
const readExtensionCode = (relativePath) =>
  readCode(`src/adapters/extension/${relativePath}`);

const extensionFileExists = (relativePath) =>
  existsSync(new URL(relativePath, EXTENSION_DIR));

const manifest = JSON.parse(readExtensionFile('manifest.json'));

/** content_scripts で注入される js の相対パス（宣言順のまま） */
const contentScriptFiles = manifest.content_scripts.flatMap((entry) => entry.js || []);

/** 全 content script を 1 本の文字列として見る（型やリテラルの有無を見るとき用）。
 * コメントは落とす（説明に型名を書けなくなるのを避ける。→ test/helpers/source.mjs） */
const contentScriptCode = () => contentScriptFiles.map(readExtensionCode).join('\n');

/**
 * ソース中のメッセージ型リテラル（`'jimoto:…'`）を重複なく拾う。
 *
 * 接頭 `jimoto:` はこの grep のためにある。`[jimoto]`（console.warn の前置）や
 * `jimoto-`（CSS のクラス名）はコロンを含まないので当たらない。
 */
const messageTypesIn = (code) =>
  [...new Set([...code.matchAll(/'(jimoto:[^']+)'/g)].map(([, type]) => type))].sort();

/** ディスク上に実在する content script（命名規約 content*.js で拾う） */
const contentScriptFilesOnDisk = readdirSync(EXTENSION_DIR)
  .filter((name) => /^content.*\.js$/.test(name))
  .sort();

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

test('実在する content*.js がすべて manifest に宣言されている', () => {
  // 上のテストは「宣言 → 実体」の向きしか見ていない。逆向き（実体 → 宣言）が
  // 抜けると、新しいファイルを置いて manifest の配列に書き忘れても全件 green で
  // 通ってしまう。そのファイルは注入されないので、そこで定義した jimoto* は
  // 呼び出し時に undefined になり、例外は run().catch に飲まれて console.warn が
  // 残るだけ。**パネルが静かに出なくなる**（順序 deepEqual が防いでいるのと
  // 同じ失敗モードで、唯一こちらだけが素通りしていた）
  const declared = manifest.content_scripts[0].js;
  for (const name of contentScriptFilesOnDisk) {
    assert.ok(
      declared.includes(name),
      `${name} が content_scripts[0].js に無い: 注入されず、そこで定義した ` +
        'jimoto* は undefined になる。エラーは run().catch に飲まれ、' +
        'console.warn だけ残してパネルが静かに出なくなる',
    );
  }
});

test('web_accessible_resources に options.html を出していない', () => {
  // 設定画面は background 経由で開く。ここに出すとホストページへの露出面が
  // 広がり、「注入パネルは closed shadow に閉じて露出を最小化する」設計に逆行する
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(!exposed.includes('options.html'), 'options.html を公開してはいけない');
});

test('web_accessible_resources に popup.html を出していない', () => {
  // 注文リスト（popup.html）は注入パネルのリンクからも開くが、**開くのは拡張
  // 自身**（background の chrome.tabs.create）であって、ホストページではない。
  // web_accessible_resources はホストページからの参照を許すための宣言なので、
  // ここに足す必要は無い（調査で確定。この事実をテストとして残しておく）。
  // 足すと Amazon 上の任意のスクリプトから注文リストの URL を踏めるようになり、
  // options.html と同じ理由で露出面が広がる
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(
    !exposed.includes('popup.html'),
    'popup.html を公開してはいけない（tabs.create は拡張自身の呼び出しなので WAR は不要）',
  );
});

test('chrome.action.openPopup をどこでも呼んでいない', () => {
  // Chrome 127+ に**存在する**のに使えない、という一番踏みやすい罠。
  // (a) content script に chrome.action は露出しない（undefined）
  // (b) service worker から呼んでもユーザージェスチャを要求されるため、
  //     sendMessage 経由の呼び出しでは失敗する
  // どちらも「注文リストが開かない」で終わるので、tabs.create で popup.html を
  // タブとして開く形を固定する（→ SPEC「カートへの導線」）。
  //
  // コメントを落としてから見るので、罠の説明は API 名を書いて構わない
  // （名前ごと禁じると、一番読まれる場所から grep 可能な固有名詞が消える）
  //
  // 読み先は「どこでも」の名に合わせて拡張ページまで含める。popup / options では
  // chrome.action が実在するぶん呼び出しが通ってしまい、注文リストを開く導線が
  // タブ（tabs.create）と popup の 2 通りに割れる
  for (const path of [...contentScriptFiles, 'background.js', 'popup.js', 'options.js']) {
    assert.doesNotMatch(
      readExtensionCode(path),
      /openPopup\s*(\?\.)?\s*\(/,
      `${path}: chrome.action.openPopup は content script からも SW からも使えない`,
    );
  }
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
  // 権限を増やさない方針の固定。sendMessage は無条件に使えるので追加は不要。
  // **バッジ（chrome.action.setBadgeText / setBadgeBackgroundColor /
  // setBadgeTextColor）にも追加権限は要らない。** manifest に "action" を
  // 宣言してあれば呼べる（調査で確定）。ここが増えたら「バッジのために
  // 権限が必要」という誤解が入り込んだ合図なので、この deepEqual を緩めない
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
  // content script は 6 ファイルに分かれているので、content.js だけを見ると
  // 別ファイルに書かれた呼び出しを見逃す。宣言されている全ファイルを回す。
  // 読むのはコード（readExtensionCode）。上の openPopup 側と流儀を揃える——
  // 片方だけコメント込みで見ると、ソースに「この語を書くな」という制約が
  // 染み出す（→ test/helpers/source.mjs）
  for (const path of contentScriptFiles) {
    assert.doesNotMatch(
      readExtensionCode(path),
      /openOptionsPage\s*(\?\.)?\s*\(/,
      `${path}: content script では openOptionsPage は undefined`,
    );
  }
});

test('content script と background.js のメッセージ型が双方向で一致する', () => {
  // MV3 の制約で content script と service worker は定数を共有できず、型は
  // 2 ファイルに直書きになる。片方だけ改名すると npm test は green のまま、
  // 実機では毎回「設定画面を開けませんでした」が出る（元のバグに近い症状）。
  // 対をテストで固定するのがその代わりの防波堤。
  //
  // **両方向を見る。** 受信側（background）にあって送信側（content）に無い型は
  // 「押しても何も起きない」に、送信側にあって受信側に無い型は「Receiving end
  // does not exist」になる。片方向だけだと、どちらを改名したかで検出できたり
  // できなかったりする（改名は必ずどちらか一方から始まる）。
  //
  // 定数名（OPEN_OPTIONS）ではなくリテラルの形で拾うのは、型が増えるたびに
  // このテストへ追記する運用にしないため。追記漏れは静かに素通りする。
  // 送信側がどのファイルにあっても良いよう、content script 全体を読み先にする
  const inBackground = messageTypesIn(readExtensionCode('background.js'));
  const inContent = messageTypesIn(contentScriptCode());

  // 正規表現が何も拾わないと以下のループは空回りして vacuously green になる。
  // 見たいのは「1 つも拾えない」ことだけなので件数では縛らない。`>= 2` にすると、
  // 型が 1 つに戻った日に落ちて「接頭を変えたのでは」と原因と違うことを言う
  assert.ok(
    inBackground.length > 0,
    'background.js からメッセージ型を 1 つも拾えない（接頭 jimoto: を変えた?）',
  );

  for (const type of inBackground) {
    assert.ok(
      inContent.includes(type),
      `background.js の型 ${type} を送る content script が無い（受信側だけ改名した?）`,
    );
  }
  for (const type of inContent) {
    assert.ok(
      inBackground.includes(type),
      `content script が送る型 ${type} の handler が background.js に無い（送信側だけ改名した?）`,
    );
  }
});

test('jimotoRequestBackground に渡す型が JIMOTO_BACKGROUND_REQUESTS に登録されている', () => {
  // 双方向テストはこれを通す。`messageTypesIn` は呼び出し引数のリテラルも拾うので、
  // background.js と呼び出し側に型があれば、失敗文言の表（この定数）が欠けたままでも
  // green になる。実機では未登録の型を渡した瞬間に何も出ない
  // （jimotoRequestBackground の既定値つき分割代入が最後の砦。それを外すと同期 throw で
  // トーストが 1 枚も出ず、この関数が防いでいるはずの症状に戻る）
  const code = contentScriptCode();
  // 表の参照そのものにも既定値を要求する。上の対応づけが守るのは「今あるコードが
  // 揃っていること」だけで、未登録の型を渡した瞬間の挙動は守れない。素の分割代入に
  // 戻すと TypeError が onclick で同期に throw し、トーストが 1 枚も出なくなる
  assert.match(
    code,
    /JIMOTO_BACKGROUND_REQUESTS\[type\]\s*\?\?/,
    'jimotoRequestBackground: 未登録の型で throw する（JIMOTO_BACKGROUND_REQUESTS[type] に既定値が無い）',
  );
  const table = code.match(/JIMOTO_BACKGROUND_REQUESTS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(table, 'JIMOTO_BACKGROUND_REQUESTS の定義を読み取れない');
  const registered = messageTypesIn(table[1]);
  assert.ok(registered.length > 0, 'JIMOTO_BACKGROUND_REQUESTS からキーを 1 つも拾えない');

  // 接頭で縛らずに拾う。型を打ち間違えた呼び出しも「登録されていない型」として落とす
  const requested = [
    ...new Set([...code.matchAll(/jimotoRequestBackground\(\s*'([^']+)'/g)].map(([, type]) => type)),
  ];
  assert.ok(requested.length > 0, 'jimotoRequestBackground の呼び出しを 1 つも拾えない');
  for (const type of requested) {
    assert.ok(
      registered.includes(type),
      `jimotoRequestBackground('${type}') の文言が JIMOTO_BACKGROUND_REQUESTS に無い`,
    );
  }
});

test('content.js は storage.onChanged の listener をトップレベルで同期登録する', () => {
  // パネルの点数はカートの変化に追随する必要がある（popup / カートタブで削除
  // されても、同じ URL に留まる限り buildPanel は走り直さない）。登録を
  // buildPanel の中に入れると SPA 遷移のたびに listener が溜まり、古いパネルの
  // 分まで動く。background.js の 4 listener と同じく行頭一致で固定する
  const content = readExtensionCode('content.js');
  assert.match(content, /^chrome\.storage\.onChanged\.addListener\(/m);
  // キーは core から。リテラルで持つと storage.js と 2 箇所になり、
  // 片方だけ直した時点で点数が黙って止まる（background.js と同じ話）
  assert.match(content, /core\.CART_KEY/);
  assert.ok(
    !content.includes("'bookstore.cart'"),
    "content.js に 'bookstore.cart' を直書きしない（core/storage.js の CART_KEY を使う）",
  );
});

test('content_scripts.js が期待した順序で宣言されている', () => {
  // classic script の 5 分割はトップレベル宣言の共有で成立している。
  // 定義より前に使う順序（例: content.js が先）にすると、その時点で
  // content-sites.js の束縛はまだ存在せず ReferenceError:
  // JIMOTO_SITES is not defined になる（TDZ ではない。別々の script は
  // 自分自身の instantiation で束縛を作るため）。例外は run() の catch に
  // 飲まれて「パネルが出ない」だけが残る。
  // しかも失敗は間欠的: tick() は run() より先に lastHref を更新するので
  // 同じ URL では再試行せず、URL が変われば（もう全ファイルがロード済みなので）
  // 成功する。静的なページロードでは永久に出ないが、SPA 遷移では 2 つ目の
  // URL から出る——「常に出ない」より debug が難しい。
  // 並び替えのほか、配列からの抜けもここで受け止める（実体 → 宣言の向きは
  // 「実在する content*.js がすべて manifest に宣言されている」が見る）
  assert.deepEqual(manifest.content_scripts[0].js, [
    'content-sites.js',
    'content-ui.js',
    // 代理実行は jimotoToast を使うので content-ui.js より後、
    // 依頼を出す content-mail.js / content.js より前
    'content-bg.js',
    'content-mail.js',
    'content-panel.js',
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

test('background.js は listener をすべてトップレベルで同期登録する', () => {
  // MV3 の SW は idle で停止し、イベント受信で起動する。起動直後の同期実行中に
  // 登録が終わっていないとイベントを取りこぼすため、await の後ろや関数の中に
  // 入れてはいけない。行頭一致で「ネストしていない」ことを固定する
  // （`async function init() { … }` にまとめる形は一見きれいだが、
  // 取りこぼしはエラーを出さない ——「たまにバッジが更新されない」になる）
  const background = readExtensionFile('background.js');
  for (const registration of [
    /^chrome\.runtime\.onMessage\.addListener\(/m,
    /^chrome\.storage\.onChanged\.addListener\(/m,
    /^chrome\.runtime\.onStartup\.addListener\(/m,
    /^chrome\.runtime\.onInstalled\.addListener\(/m,
  ]) {
    assert.match(background, registration);
  }
});

test('background.js は "type": "module" で宣言されている', () => {
  // background.js は core を import する。宣言が無いと SW は起動時に
  // `Cannot use import statement outside a module` で死に、エラーは SW の
  // DevTools にしか出ない。バッジが出ないだけでなく onMessage も登録されず、
  // **注入パネルの「設定」リンクまで同時に壊れる**
  assert.equal(manifest.background?.type, 'module');
});

test('background.js はカートのキーを core から import する', () => {
  // SW は `chrome.storage.onChanged` の changes からカートを拾うのでキー文字列が
  // 要る。リテラルで書くと storage.js と 2 箇所になり、片方だけ直した時点で
  // onChanged が一致しなくなって**バッジが黙って止まる**（エラーは出ない）
  assert.match(readExtensionFile('background.js'), /^import .* from '\.\/core\//m);
  // 「直書きしない」はコードに対する制約。コメント込みで見ると、CART_KEY の
  // 由来を説明するのに値を書けなくなり、注意書きが婉曲表現になる（PR7 と同じ話）
  assert.ok(
    !readExtensionCode('background.js').includes("'bookstore.cart'"),
    "background.js に 'bookstore.cart' を直書きしない（core/storage.js の CART_KEY を import する）",
  );
});

/**
 * バッジの色に関する 2 つのテストは**ドリフト検知**であって、実値の固定ではない。
 *
 * - ここ（source テスト）… `background.js` の定数が `content.css` のトークンと
 *   ズレていないか。SW は CSS を読めないのでリテラルの重複が避けられず、
 *   その 2 箇所が離れていくのを見る
 * - `test/background.test.mjs`（behavior テスト）… `setBadgeBackgroundColor` に
 *   **実際に渡る値**を deepEqual で固定する。守っているのはこちら
 *
 * source テストだけでは守れない。正規表現は最初の 1 件しか見ないので、
 * 定数を残したまま `setBadgeBackgroundColor` に別色を直書きする形や、
 * 定数を 2 箇所に書く形は素通りする。**source テストを厚くしてこれを塞ごうと
 * しないこと**（ソースの書き方に対する制約が増えるだけで、呼び出し引数を
 * 見ている behavior テストの方が安く確実）。
 *
 * 2 つに分けてあるのは、色を間違えたときに**両方**が落ちてほしいため
 * （1 つにまとめると最初の assert で止まり、「赤を使っていないか」は
 * 検査されないまま終わる）。
 */
test('バッジの背景色が content.css の --primary と同値', () => {
  const primary = cssTokenValue('primary');
  assert.ok(primary, 'content.css から --primary の値を取り出せない');
  const declared = readExtensionCode('background.js').match(
    /BADGE_BACKGROUND\s*=\s*['"]([^'"]+)['"]/,
  )?.[1];
  assert.equal(declared, primary, `バッジの背景色が --primary (${primary}) と一致しない`);
});

test('バッジに --destructive の色を使わない', () => {
  // 赤はエラー専用（SPEC「トークン」/「バッジ」）。カートに本が入っているのは
  // 正常な状態なので、エラー色で出すと「壊れた」と読まれる。
  // コメントを落としてから見るので、background.js は色の話を値つきで書ける
  const destructive = cssTokenValue('destructive');
  assert.ok(destructive, 'content.css から --destructive の値を取り出せない');
  assert.ok(
    !readExtensionCode('background.js').includes(destructive),
    `バッジに --destructive (${destructive}) を使わない（赤はエラー専用）`,
  );
});

test('退路の .jimoto-fallback が CSS と対になっている', () => {
  // 退路は常設。CSS 側が display: none に戻ると、JS はリンクを組み立て続けるのに
  // 何も出ない（＝メーラーが開かない利用者から見て、直す前とまったく同じ
  // 「押しても何も起きない」に戻る）。隠すのは gmail 設定済みのときだけで、
  // その出し分けは -hidden クラスが担う
  const source = readExtensionFile('content-mail.js');
  const style = readExtensionFile('content.css');
  assert.match(source, /jimoto-fallback-hidden/);
  assert.match(style, /\.jimoto-fallback\s*\{[^}]*display:\s*block/);
  assert.match(style, /\.jimoto-fallback-hidden\s*\{[^}]*display:\s*none/);
  // 表示側のクラスは消えた。書き戻すと「既定は非表示」の形が静かに復活する
  assert.ok(
    !source.includes('jimoto-fallback-shown') && !style.includes('jimoto-fallback-shown'),
    '退路は常設。jimoto-fallback-shown（出し分け）を戻さない',
  );
  // 赤はエラー専用。案内であって「壊れた」ではない
  assert.ok(
    !/\.jimoto-fallback[^{]*\{[^}]*--destructive/.test(style),
    '.jimoto-fallback に --destructive を使わない（エラーではなく案内）',
  );
});

/**
 * content.js がクラス名で参照するレイアウト。
 *
 * shadow DOM 越しの CSS/JS の結合は壊れても静かなので、文字列レベルで対にする。
 * 増えたらこの配列に 1 行足す（テストを増やさない。壊れ方も直し方も同じなので、
 * 同じ検査の複製が並ぶと「どちらを直すか」を考える手間だけが増える）。
 */
const PANEL_LAYOUT_CLASSES = [
  // 外れるとボタンが縦積みにならず、flex: 1 のまま文字高まで潰れる
  'jimoto-actions-stack',
  // 外れると二次導線のリンクが行にならず、縦に積まれて主導線と見分けが付かなくなる
  'jimoto-links',
];

test('content.js が使うレイアウトのクラスが content.css に定義されている', () => {
  const source = readExtensionFile('content.js');
  const style = readExtensionFile('content.css');
  for (const className of PANEL_LAYOUT_CLASSES) {
    assert.match(source, new RegExp(className), `content.js が ${className} を使っていない`);
    assert.match(
      style,
      new RegExp(`\\.${className}\\s*\\{`),
      `content.css に .${className} の定義が無い`,
    );
  }
});
