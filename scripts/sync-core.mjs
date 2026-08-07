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
import { cp, mkdir, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src/core');
const DEST = join(root, 'src/adapters/extension/core');

async function sync() {
  await mkdir(DEST, { recursive: true });
  for (const f of await readdir(SRC)) {
    if (f.endsWith('.js')) await cp(join(SRC, f), join(DEST, f));
  }
  console.log(`[sync-core] ${new Date().toISOString()} -> ${DEST}`);
}

await sync();

if (process.argv.includes('--watch')) {
  watch(SRC, { persistent: true }, () => sync().catch(console.error));
  console.log('[sync-core] watching src/core …');
}
