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
  content-sites.js       JIMOTO_SITES（サイト別セレクタ）・jimotoPageText
  content-ui.js          jimotoUrl / jimotoEl / jimotoToast / jimotoInjectPanelStyle
  content-mail.js        jimotoMakeMailActions（メール送出とコピー）
  content.js             パネルの組み立て・差し込み・URL 監視。attachShadow はここ
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
- **content script は 4 ファイルで、順序に意味がある。** `manifest.json` の
  `content_scripts[0].js` は
  `content-sites.js` → `content-ui.js` → `content-mail.js` → `content.js` の順。
  ESM ではなく classic script なので、各ファイルのトップレベル宣言が同じ
  isolated world で共有される（`import` 文は無い）。**順序を変えると
  `JIMOTO_SITES` の参照が TDZ で落ち、`run()` の catch に飲まれて「パネルが
  出ない」だけが残る。** 並び順は `test/manifest.test.mjs` が `deepEqual` で
  固定してある。ファイル間の契約は grep できるように `JIMOTO_` / `jimoto`
  接頭で統一する（`el` のような裸の名前を新しく足さない）。
  分割を `chrome.runtime.getURL` + 動的 `import()` に変えないこと。分割した
  全ファイルを `web_accessible_resources` に載せる必要が生じ、パネルを
  closed shadow root に閉じて露出を絞る設計に逆行する。
- **`attachShadow` は `content.js` に置く。** `test/extension-source.test.mjs` の
  closed shadow の検査が `content.js` を読み先にしている。
- **メール送出の 3 手（`pickMailPlan` → `clipboard.writeText` → メーラーを開く）は
  `content-mail.js` に閉じる。** 順序テストが `pickMailPlan(` 以降を slice して
  index を比較するため、別ファイルに散らすとテストは green のまま意味を失う。
- **DOM セレクタは 1 箇所に集める。** `content-sites.js` の `JIMOTO_SITES` 以外に
  対応サイトのセレクタを散らさない。各サイトの DOM は予告なく変わる前提で、
  壊れたら該当サイトのエントリを直すだけで済む状態を保つ。
- **文面は `profile.templates` 経由で差し替え可能にする。** 生協の決まり文句を
  コードに直書きしない。大学ごとに運用が違うため。
- **日本語のコメントで良い。** 「なぜそうしたか」を書く。「何をしているか」は
  コードで読める。
- 新しい挙動を足したら `test/` にケースを足す。特に `compose.js` は
  文面が壊れても実行時エラーにならないので、テストが唯一の防波堤。
- **例示データに実在の人名・所属・居室を書かない。** placeholder・コメントの例・
  テスト fixture は次の架空値に揃える。公開リポジトリなので、所属と居室の
  組み合わせだけでも個人が特定される。

  | 用途 | 値 |
  | --- | --- |
  | 人名（UI placeholder・テスト fixture 共通） | `山田 太郎` / かな `やまだ たろう` / メール `taro@example.ac.jp` |
  | 書誌（書名・著者名） | `テスト書名` / `テスト 著者` |
  | 所属 | `○○大学 △△学部 ××研究室` |
  | 配達場所 | `△△棟 3F 305号室` |
  | 電話 | `03-0000-0000` |

  依頼者名と書誌の著者名は役割が違うので値を分ける。「簡略版は著者を落とす」の
  検査は人名ではなく `著者:` というラベルで書くこと。人名で書くと署名に出る
  依頼者名と衝突し、人名を UI とテストで二本立てにする羽目になる。
  **`LICENSE` の著作権表示と README のリポジトリ URL は対象外**（本人を指すことに
  意味があるので消しにかからないこと）。`test/placeholders.test.mjs` が
  placeholder の一致と実名の不在を固定している。

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
  経路 3 を単純な `location.href = mailto` に潰さない（3 面が `pickMailPlan` を
  通していることと、コピーがメーラーを開く前にあることを
  `test/extension-source.test.mjs` がソース文字列で固定している）。
  簡略版でも**利用者が入力した項目は落とさない**（組合員番号・会員番号）。
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
