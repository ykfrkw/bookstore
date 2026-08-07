/**
 * Chrome ウェブストア提出用の zip を作る（依存なし・zip コマンドを使う）。
 *   node scripts/pack.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'src/adapters/extension');
const dist = join(root, 'dist');
const version = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).version;
const out = join(dist, `bookstore-${version}.zip`);

await rm(out, { force: true });
await mkdir(dist, { recursive: true });
execFileSync('zip', ['-r', '-q', out, '.', '-x', '*.DS_Store'], { cwd: ext });
console.log(`[pack] ${out}`);
