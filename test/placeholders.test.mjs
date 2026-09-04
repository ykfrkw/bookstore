/**
 * Purpose: 例示データ（placeholder・コメントの例）が 3 面で食い違わないこと、
 *          および実在の人名が公開対象のファイルに残っていないことを固定する。
 * Inputs:  src/core/profile.js, src/adapters/extension/options.html,
 *          src/adapters/local/index.html, src/**, test/**, scripts/**, docs/**, *.md
 * Outputs: node:test の結果のみ（ファイルは書かない）
 * Depends: node:test, node:assert, node:fs, node:path, node:url
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relativePath) => readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

/** `<input ... id="req-name" ... placeholder="…">` から placeholder を取り出す */
function placeholderOf(html, attribute, value) {
  const tag = html.match(new RegExp(`<input[^>]*${attribute}="${value}"[^>]*>`));
  assert.ok(tag, `${attribute}="${value}" の input が見つからない`);
  const placeholder = tag[0].match(/placeholder="([^"]*)"/);
  assert.ok(placeholder, `${attribute}="${value}" に placeholder が無い`);
  return placeholder[1];
}

/** `affiliation: '', // 例: ○○大学 …` の「例」部分を取り出す */
function exampleOf(source, field) {
  const line = source.match(new RegExp(`${field}: '',\\s*// 例: (.+)`));
  assert.ok(line, `${field} の「例:」コメントが見つからない`);
  return line[1].trim();
}

const optionsHtml = read('src/adapters/extension/options.html');
const localHtml = read('src/adapters/local/index.html');
const profileJs = read('src/core/profile.js');

test('拡張の placeholder が profile.js の例示コメントと一致する', () => {
  // 表記揺れ（「305 号室」と「305号室」の混在）の再発防止。設定 UI で見える例と
  // コードのコメントの例がずれると、どちらが正か次に読む人に分からなくなる
  assert.equal(
    placeholderOf(optionsHtml, 'id', 'req-affiliation'),
    exampleOf(profileJs, 'affiliation')
  );
  assert.equal(
    placeholderOf(optionsHtml, 'id', 'req-delivery'),
    exampleOf(profileJs, 'deliveryPlace')
  );
});

test('ローカル版の placeholder が拡張版と同一文字列である', () => {
  const pairs = [
    ['req-name', 'requester.name'],
    ['req-kana', 'requester.kana'],
    ['req-affiliation', 'requester.affiliation'],
    ['req-delivery', 'requester.deliveryPlace'],
  ];
  for (const [optionsId, localField] of pairs) {
    assert.equal(
      placeholderOf(localHtml, 'data-p', localField),
      placeholderOf(optionsHtml, 'id', optionsId),
      `${localField} の placeholder が options.html と違う`
    );
  }
});

/*
 * 検査する語をソースに直書きすると、このテストファイル自身が検査対象に
 * 含まれて必ずヒットしてしまう（自己参照で常に落ちる）。そのため文字コードから
 * 組み立てる（同じ理由で、どの語なのかもここに書かない）。順に、利用者本人の
 * 姓（漢字）・名（漢字）・姓の読み（ひらがな）・姓のローマ字表記。
 */
const FORBIDDEN_NAMES = [
  [0x53e4, 0x5ddd],
  [0x7531, 0x5df1],
  [0x3075, 0x308b, 0x304b, 0x308f],
  [0x66, 0x75, 0x72, 0x75, 0x6b, 0x61, 0x77, 0x61],
].map((codes) => String.fromCharCode(...codes));

/** LICENSE の著作権表示は本人を指すことに意味があるので対象外 */
const EXCLUDED_FILES = ['LICENSE'];

const SCANNED_DIRECTORIES = ['src', 'test', 'scripts', 'docs'];

function collectFiles(relativeDirectory) {
  const absolute = path.join(REPO_ROOT, relativeDirectory);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relativeDirectory, entry.name);
    return entry.isDirectory() ? collectFiles(child) : [child];
  });
}

test('追跡対象のファイルに実在の人名が残っていない', () => {
  const rootFiles = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const targets = [...rootFiles, ...SCANNED_DIRECTORIES.flatMap(collectFiles)].filter(
    (relativePath) => !EXCLUDED_FILES.includes(relativePath)
  );
  assert.ok(targets.length > 0, '検査対象が 0 件（走査条件が壊れている）');

  const offenders = [];
  for (const relativePath of targets) {
    const lowered = read(relativePath).toLowerCase();
    for (const name of FORBIDDEN_NAMES) {
      if (lowered.includes(name.toLowerCase())) offenders.push(`${relativePath}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `実名が残っている: ${offenders.join(', ')}`);
});
