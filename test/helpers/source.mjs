/**
 * ソース文字列を検査するテストの共有ヘルパ。
 *
 * `npm test` の glob は `test/*.test.mjs` なので、この階層は拾われない
 * （テストファイルではなく、テストから import される部品）。
 *
 * ここに置く理由: コメント除去は extension-source.test.mjs だけの都合ではなく、
 * 「ソースを文字列で検査するなら常にコードだけを見る」という共通の作法。
 * 片方のテストだけがコメント込みで見ていると、ソース側に
 * 「この語を書くな」という制約が染み出す（実際に background.js のコメントが
 * 「値そのものはここに書けない」という説明できない文面になっていた）。
 */
import { readFileSync } from 'node:fs';

/** リポジトリのルートからの相対パスで読む */
export const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

/**
 * コメントを落とす。**検査はコードに対して行う。**
 *
 * コメント込みで検査すると 2 つのことが起きる。(a) 守りたい形（`window.open(` や
 * `location.href =`、`--destructive` の色）を説明に書き写した時点でテスト自身に
 * 引っかかる。(b) 逆に「pickMailPlan を通している」等の肯定側は、コメントに
 * 名前が出るだけで満たされてしまう。どちらもテストの意味を壊す。
 *
 * `(^|[^:])` は `https://` の `//` を守るためのもの。行コメントの `//` の直前は
 * 行頭か非コロン、URL の `//` の直前は必ず `:` になる。文字列リテラルの中に
 * `:` を伴わない `//` を書くと落ちるが（正規表現リテラルも同様）、対象ファイルに
 * その形は無い。除去しすぎていないことは extension-source.test.mjs の
 * 「コメント除去が検査対象のコードまで消していない」で見る。
 */
export const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 検査用に読む。コメントを落としたコードだけを返す */
export const readCode = (relativePath) => stripComments(read(relativePath));

/**
 * content.css からデザイントークンの値を抜く。
 *
 * service worker は CSS を読めないので、バッジの色リテラルが JS に入るのは
 * 避けられない。せめて期待値の側を CSS から導出して、リテラルの重複を
 * 「実装 1 箇所 + CSS のトークン」に留める（テストにも三つ目を書くと、
 * ブランド色を変えたときに「テストだけが落ちる」状態が生まれる）。
 */
export const cssTokenValue = (name) =>
  read('src/adapters/extension/content.css')
    .match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
    ?.trim();
