/**
 * service worker（background.js）を実際に評価して、振る舞いを固定する。
 *
 * なぜソース文字列の検査（manifest.test.mjs）だけでは足りないか:
 * MV3 の SW の失敗は**静かに死ぬ**形が多い。import が 1 つ解決できないだけで
 * SW は起動せず、バッジが出ないどころか onMessage も登録されないので
 * **注入パネルの「設定」リンクまで同時に壊れる**。しかもエラーは
 * `chrome://extensions` の Service Worker の DevTools にしか出ない。
 * 文字列検査は「書いてあるか」しか見られず、「実際に応答するか」は見られない。
 *
 * ここでやること: `chrome` をスタブして background.js を import し、
 * 登録された listener を自分で呼んで、`chrome.action.*` の呼び出しを検査する。
 * ネットワークにも DOM にも触らない（test/ の方針どおり）。
 *
 * **このテストは `npm run sync` を前提とする。**
 * 読み先は `src/adapters/extension/background.js` で、その import 先
 * `./core/*.js` は `.gitignore` された `sync-core.mjs` の生成物。未 sync だと
 * ここで落ちるが、それは実機の SW が黙って死ぬのと同じ状態なので**検出したい
 * 失敗**である（下の requireSyncedCore が理由と直し方を出す）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const EXTENSION_DIR = new URL('../src/adapters/extension/', import.meta.url);
const BACKGROUND = new URL('background.js', EXTENSION_DIR);

const SYNC_HINT =
  'src/adapters/extension/core/ は .gitignore された scripts/sync-core.mjs の生成物。' +
  '**`npm run sync` を実行してから test を走らせること。** ' +
  '未 sync のまま拡張を読み込むと、service worker は同じ ERR_MODULE_NOT_FOUND で ' +
  '静かに起動に失敗し、バッジも「設定」リンクも動かなくなる（エラーは SW の ' +
  'DevTools にしか出ない）。';

/** 生成物が無いことを、import が失敗する前に分かる言葉で伝える */
function requireSyncedCore() {
  for (const generated of ['core/storage.js', 'core/cart.js']) {
    if (existsSync(new URL(generated, EXTENSION_DIR))) continue;
    throw new Error(`${generated} が無い（background.js の import が解決できない）。${SYNC_HINT}`);
  }
}

/**
 * chrome API のスタブ。呼び出しを記録し、listener を捕まえる。
 *
 * `storage.local.get` はカートを返す（core/storage.js は import 時に
 * `chrome.storage.local` の有無で backend を選ぶが、実際の get/set は
 * 呼び出し時に `globalThis.chrome` を読むので、テストごとの差し替えが効く）。
 */
function makeChromeStub({ cart = [] } = {}) {
  const calls = [];
  const listeners = {};
  const record = (name) => (argument) => calls.push([name, argument]);

  return {
    calls,
    listeners,
    chrome: {
      action: {
        setBadgeText: record('setBadgeText'),
        setBadgeBackgroundColor: record('setBadgeBackgroundColor'),
        setBadgeTextColor: record('setBadgeTextColor'),
      },
      runtime: {
        lastError: undefined,
        openOptionsPage: (callback) => callback(),
        onMessage: { addListener: (fn) => (listeners.onMessage = fn) },
        onStartup: { addListener: (fn) => (listeners.onStartup = fn) },
        onInstalled: { addListener: (fn) => (listeners.onInstalled = fn) },
      },
      storage: {
        local: {
          get: async (key) => ({ [key]: cart }),
          set: async () => {},
        },
        onChanged: { addListener: (fn) => (listeners.onChanged = fn) },
      },
    },
  };
}

/**
 * background.js は**この 1 回だけ** import する。
 *
 * ESM は解決済み URL でキャッシュされるので、テストごとに評価し直すには
 * `import(url + '?v=n')` でクエリを変える手が要る。**採らない。**
 * (a) クエリ違いは background.js だけを別モジュールにするが、その中の
 *     `./core/storage.js` はクエリが伝播しないので共有されたまま——
 *     「毎回まっさらに評価している」という見た目が嘘になる
 * (b) 検査したいのは「トップレベルで 1 回だけ同期登録される」ことなので、
 *     1 回の評価で全部見るほうが対象に忠実
 *
 * 呼び出し履歴の独立は import ではなく `withChrome` で担保する
 * （listener は登録時のスタブを閉じ込めず、呼び出し時の `globalThis.chrome` を
 * 読むので、スタブを差し替えれば記録先も切り替わる）。
 */
requireSyncedCore();
const boot = makeChromeStub();
const originalChrome = globalThis.chrome;
globalThis.chrome = boot.chrome;
try {
  await import(BACKGROUND);
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    throw new Error(`background.js の import が解決できない: ${error.message} / ${SYNC_HINT}`, {
      cause: error,
    });
  }
  throw error;
} finally {
  globalThis.chrome = originalChrome;
}

/** テストごとにまっさらなスタブを差し込み、必ず元に戻す */
async function withChrome(options, run) {
  const previous = globalThis.chrome;
  const stub = makeChromeStub(options);
  globalThis.chrome = stub.chrome;
  try {
    await run(stub);
  } finally {
    globalThis.chrome = previous;
  }
}

/** listener が `void refreshBadge()` で投げた非同期処理の完了を待つ */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** バッジ 1 回ぶんの期待値（色は毎回入れ直す。詳細は SPEC「バッジ」） */
const badgeCalls = (text) => [
  ['setBadgeText', { text }],
  ['setBadgeBackgroundColor', { color: '#1f6feb' }],
  ['setBadgeTextColor', { color: '#ffffff' }],
];

test('トップレベルで 4 つの listener が登録される', () => {
  // import しただけで（＝どの関数も呼ばずに）登録が終わっていること。
  // MV3 の SW は起動直後の同期実行中に登録が終わっていないとイベントを
  // 取りこぼす。manifest.test.mjs は行頭一致で書き方を見るが、こちらは
  // 「実際に addListener が呼ばれたか」を見る
  assert.deepEqual(Object.keys(boot.listeners).sort(), [
    'onChanged',
    'onInstalled',
    'onMessage',
    'onStartup',
  ]);
});

test('onChanged(local): カートの点数と色をバッジに入れる', async () => {
  await withChrome({}, async ({ calls }) => {
    boot.listeners.onChanged({ 'bookstore.cart': { newValue: [{}, {}] } }, 'local');
    // 点数（cart.length）。冊数の合計ではない（→ core/cart.js の badgeText）
    assert.deepEqual(calls, badgeCalls('2'));
  });
});

test('onChanged(sync): local 以外は無視する', async () => {
  await withChrome({}, async ({ calls }) => {
    boot.listeners.onChanged({ 'bookstore.cart': { newValue: [{}, {}] } }, 'sync');
    // カートは chrome.storage.local にしか置かない。area を絞らないと、
    // 他の area（将来 sync を使ったとき）の変化でバッジが動く
    assert.deepEqual(calls, [], 'areaName の絞り込みが効いていない');
  });
});

test('onChanged: 自分のキー以外では何もしない', async () => {
  await withChrome({}, async ({ calls }) => {
    boot.listeners.onChanged({ 'bookstore.profile': { newValue: {} } }, 'local');
    assert.deepEqual(calls, [], '設定の保存でバッジを触ってはいけない');
  });
});

test('onChanged: newValue が無いとき（キー削除・clear）はバッジを消す', async () => {
  await withChrome({}, async ({ calls }) => {
    boot.listeners.onChanged({ 'bookstore.cart': { oldValue: [{}] } }, 'local');
    // 空文字でバッジが消える。'0' を渡すと「0 のバッジ」が常駐する
    assert.deepEqual(calls, badgeCalls(''), 'remove / clear でバッジが消えない');
  });
});

test('onStartup: storage を読んで点数を復元する', async () => {
  // MV3 の action.* はブラウザセッションを越えて永続しないので、Chrome の
  // 再起動でバッジが消える。ここが腐ると「再起動したら数が消えた」になる
  await withChrome({ cart: [{ isbn13: '9784000000000', quantity: 5 }] }, async ({ calls }) => {
    boot.listeners.onStartup();
    await flush();
    // 1 点・5 冊 → '1'。合計冊数ではない
    assert.deepEqual(calls, badgeCalls('1'));
  });
});

test('onInstalled: storage を読んで点数を復元する', async () => {
  // onStartup と両方が必要。onInstalled だけでは Chrome の再起動を拾えず、
  // onStartup だけでは更新直後・拡張の再読み込み直後を拾えない
  await withChrome({ cart: [{ isbn13: '9784000000000', quantity: 5 }] }, async ({ calls }) => {
    boot.listeners.onInstalled();
    await flush();
    assert.deepEqual(calls, badgeCalls('1'));
  });
});

test('onMessage: 既知の型は true を返して非同期に応答する', async () => {
  await withChrome({}, async () => {
    const responses = [];
    const result = boot.listeners.onMessage(
      { type: 'jimoto:open-options' },
      {},
      (response) => responses.push(response),
    );
    // true を返さないと sendResponse の前にチャネルが閉じ、送信側は
    // 「Receiving end does not exist」を見る
    assert.equal(result, true, 'onMessage が true を返さない（非同期応答が閉じられる）');
    assert.equal(responses.length, 1, 'sendResponse が 1 回だけ呼ばれていない');
    // 応答は { ok, error }。lastError が無いので ok: true / error: undefined
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].error, undefined);
  });
});

test('onMessage: 未知の型には応答しない', async () => {
  await withChrome({}, async () => {
    const responses = [];
    const result = boot.listeners.onMessage({ type: 'jimoto:nope' }, {}, (response) =>
      responses.push(response),
    );
    // 自分の型以外を掴むと、将来足す listener を塞ぐ
    assert.equal(result, undefined);
    assert.deepEqual(responses, []);
  });
});

test('onMessage: prototype 由来の名前を handler として引き当てない', async () => {
  await withChrome({}, async () => {
    const responses = [];
    // HANDLERS を素のプロパティアクセスで引くと Object.prototype.toString が
    // 引き当たり、message と sendResponse を渡して呼ばれてしまう。
    // Object.hasOwn による絞り込みが効いていることの確認
    const result = boot.listeners.onMessage({ type: 'toString' }, {}, (response) =>
      responses.push(response),
    );
    assert.equal(result, undefined, 'prototype の名前が handler として引き当てられている');
    assert.deepEqual(responses, []);
  });
});
