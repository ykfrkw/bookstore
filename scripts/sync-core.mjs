/**
 * src/core/*.js を拡張機能ディレクトリへコピーする。
 *
 * なぜ必要か: Chrome 拡張は manifest.json のあるディレクトリより上を
 * 参照できないため、core をそのまま相対 import できない。
 * バンドラを入れずに済ませるための最小限の同期。
 *
 *   node scripts/sync-core.mjs        1 回だけ同期
 *   node scripts/sync-core.mjs --watch  変更を監視して同期
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src/core');
const DEST = join(root, 'src/adapters/extension/core');

/** tmp 名の衝突回避。同一プロセス内の同時 sync（watch の連続発火）も分ける */
let temporarySequence = 0;

/**
 * 1 ファイルを atomic に置き換える。
 *
 * なぜ `cp()` ではないか: `cp()` は既定（force: true）で **destination を
 * unlink してから書く**。sync が 2 つ同時に走ると、片方の unlink が
 * もう片方の unlink 済みファイルに当たって ENOENT で落ちる。
 * `npm test` は sync を走らせるので、**`npm run dev`（watch）を回したまま
 * `npm test` する** という CLAUDE.md 推奨の開発ループがそのまま踏む。
 * エラー文面は「core が壊れた」に見えるので原因（同時実行）に辿り着きにくい。
 *
 * `copyFile`（O_TRUNC）にも変えない。ENOENT は消えるが、切り詰めてから
 * 書き終えるまでの間に**書きかけのファイルを読む**窓が残る。
 * 同一ファイルシステム上の rename は atomic なので、読み手は旧・新
 * どちらかの完全な中身しか見ない。
 */
async function copyAtomic(name) {
  const destination = join(DEST, name);
  const temporary = `${destination}.${process.pid}.${temporarySequence++}.tmp`;
  try {
    await writeFile(temporary, await readFile(join(SRC, name)));
    await rename(temporary, destination);
  } finally {
    // 失敗しても tmp を残さない（rename 済みなら ENOENT。無視してよい）
    await unlink(temporary).catch(() => {});
  }
}

async function sync() {
  await mkdir(DEST, { recursive: true });
  for (const f of await readdir(SRC)) {
    if (f.endsWith('.js')) await copyAtomic(f);
  }
  console.log(`[sync-core] ${new Date().toISOString()} -> ${DEST}`);
}

await sync();

if (process.argv.includes('--watch')) {
  watch(SRC, { persistent: true }, () => sync().catch(console.error));
  console.log('[sync-core] watching src/core …');
}
