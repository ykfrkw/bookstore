/**
 * Chrome ウェブストア提出用の zip を作る（依存なし・zip コマンドを使う）。
 *   node scripts/pack.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'src/adapters/extension');
const dist = join(root, 'dist');
const version = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).version;
const out = join(dist, `bookstore-${version}.zip`);

// 「ディレクトリ丸ごと」ではなく allowlist 方式で zip する。
// .DS_Store やエディタの一時ファイル等が提出物に紛れ込む事故を防ぐため。
const files = (await readdir(ext)).filter(
  (f) => f === 'manifest.json' || /\.(html|js|css)$/.test(f)
);
const coreFiles = (await readdir(join(ext, 'core')))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `core/${f}`);
const iconFiles = (await readdir(join(ext, 'icons')))
  .filter((f) => f.endsWith('.png'))
  .map((f) => `icons/${f}`);

const packed = [...files, ...coreFiles, ...iconFiles];

await rm(out, { force: true });
await mkdir(dist, { recursive: true });
execFileSync('zip', ['-q', out, ...packed], { cwd: ext });
console.log(`[pack] ${out} (${packed.length} files)`);
