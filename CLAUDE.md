# CLAUDE.md

Claude Code 向けのプロジェクト規約。**作業前に必ず読むこと。**

## このプロジェクトは何か

Amazon の書籍ページを起点に、**大学生協**（研究費／私費の区別つき）または
**地元書店**への注文メール下書きを作るツール。Chrome 拡張とローカルページの
2 つのフロントを持ち、ロジックは `src/core/` に一本化してある。

背景と設計判断の根拠は `SPEC.md` と `docs/research.md` に書いてある。
仕様に迷ったら推測せず、まずそちらを読むこと。

## 絶対に破ってはいけない前提

1. **自動発注はしない。** 生協や書店のサイトに自動ログインしたり、フォームを
   自動送信したりする機能は追加しない。人が最終確認して送るための「下書き」を
   作るところで止める。誤発注は研究費の執行事故になる。
2. **Amazon から取得した情報を保存・再配布しない。** ページから拾うのは
   その場でメール下書きを作るための一時利用に留める。永続化するのは
   ISBN・ユーザー自身の設定・ユーザーが明示的に「カートに入れる」を押した項目だけ。
3. **書誌の一次ソースは openBD。** Amazon のスクレイピング結果は openBD が
   空振りしたときのフォールバックにすぎない。この優先順位を逆にしない。
4. **個人情報は端末内に留める。** 外部送信は openBD への ISBN 問い合わせのみ。
   分析・テレメトリの類は入れない。
5. **ビルドステップを増やさない。** 素の ESM で完結させる。バンドラ、
   トランスパイラ、フレームワークを導入したくなったら、まず理由を提案して
   合意を取ること（`SPEC.md` の「スタック方針」参照）。

## ディレクトリ

```
src/core/                環境非依存のロジック。ここに副作用と DOM を持ち込まない
  isbn.js                ISBN の検証・変換・ページからの抽出（純関数）
  bibliography.js        openBD 照会とフォールバック合成
  profile.js             設定スキーマ・既定値・バリデーション
  compose.js             注文メールの組み立て（本体）
  storage.js             chrome.storage / localStorage の抽象化
src/adapters/extension/  Chrome 拡張（MV3）
src/adapters/local/      ローカル単体ページ（同じ core を相対 import）
scripts/sync-core.mjs    core を拡張ディレクトリへコピー（拡張は上位を参照できないため）
test/                    node:test。ネットワークに触らないこと
```

## 開発コマンド

```bash
npm test          # node:test。ネットワーク不要
npm run dev       # core の変更を拡張ディレクトリへ自動同期
npm run local     # ローカル版を http://localhost:8787 で開く
npm run build     # dist/bookstore-<version>.zip を作る
```

拡張の読み込み: `npm run sync` のあと、Chrome の
`chrome://extensions` →「パッケージ化されていない拡張機能を読み込む」で
`src/adapters/extension` を指定する。

## コードの約束

- **`src/core/` は DOM・chrome API・`window` を直接触らない。** 環境依存は
  adapter 側か `storage.js` に閉じ込める。core のテストが Node で走ることを
  常に維持すること。
- **`src/core/` を編集したら `npm run sync` を走らせる。** 忘れると拡張だけ
  古いコードで動き、原因の分かりにくいバグになる。`src/adapters/extension/core/`
  は生成物なので直接編集しない。
- **DOM セレクタは 1 箇所に集める。** `content.js` の `SITES` 配列以外に
  対応サイトのセレクタを散らさない。各サイトの DOM は予告なく変わる前提で、
  壊れたら該当サイトのエントリを直すだけで済む状態を保つ。
- **文面は `profile.templates` 経由で差し替え可能にする。** 生協の決まり文句を
  コードに直書きしない。大学ごとに運用が違うため。
- **日本語のコメントで良い。** 「なぜそうしたか」を書く。「何をしているか」は
  コードで読める。
- 新しい挙動を足したら `test/` にケースを足す。特に `compose.js` は
  文面が壊れても実行時エラーにならないので、テストが唯一の防波堤。

## 罠として知っておくこと

- **mailto の長さ制限。** 日本語 1 文字がパーセントエンコードで 9 文字になるため、
  **フル版**の注文メールは 1 冊でも 2000 文字制限を超える。ただし挨拶・結び・罫線・
  著者・出版社・合計行を削った簡略版（`composeOrder({ compact: true })`）なら収まる。
  UI は `compose.js` の `pickMailPlan` を通して 3 段階で選ぶこと。
  (1) フル版が収まる → 本文入り `mailto`、
  (2) 簡略版が収まる → 簡略版の本文入り `mailto`（貼り付け不要。簡略版で開いたことを
  利用者に伝える）、(3) どちらも超える → **フル版の本文**をコピーして
  `mailtoHeaderOnly` で開く。
  長さ判定を UI 側に二重実装しない。件数で決め打ちしない（長さで判定すれば足りる）。
  経路 3 を単純な `location.href = mailto` に潰さない（テストで固定してある）。
  簡略版は書名と ISBN を必ず残す（ISBN の 1 桁違いに人が気づける唯一の手がかり）。
  利用者が書いた `message` / `item.note` があるときは `composeOrder` が
  `compact` を無視してフル版に戻す。ここを UI 側の判定に移さない。
- **ASIN ≠ ISBN。** 和書はだいたい一致するが、Kindle 版・洋書・ISBN-13 のみの
  新刊では一致しない。必ず `isValidIsbn10` を通す。
- **MV3 の content script は ESM ではない。** `chrome.runtime.getURL` +
  動的 `import()` で core を読んでいる。`web_accessible_resources` に
  `core/*.js` を入れ忘れると黙って失敗する。
- **`chrome.runtime.openOptionsPage` は content script では `undefined`。**
  拡張ページ（popup / options / background）専用の API。`?.()` で呼ぶと例外も
  出さず静かに no-op するため、原因に気づくまでが長い。設定画面は
  `background.js` へ `sendMessage`（`'jimoto:open-options'`）して開くこと。
  `options.html` を `web_accessible_resources` に足す方法は、ホストページへの
  露出面を増やすので採らない。MV3 の service worker は ephemeral で
  「Receiving end does not exist」が返りうるので、`chrome.runtime.lastError` を
  必ず読んで失敗を利用者に見せる。
- **`file://` ではローカル版が動かない。** ES module が CORS で弾かれるため、
  必ず `npm run local`（http 経由）で開く。

## まだ決めていないこと

`SPEC.md` の「未決事項」を参照。勝手に決めずに確認すること。特に、
どの大学生協を最初のターゲットにするかが決まっていない。
