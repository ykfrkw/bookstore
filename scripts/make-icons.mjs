/**
 * Purpose: 拡張機能のアイコン PNG を生成する。
 * Inputs:  なし（デザインは下記の定数で完結する）
 * Outputs: src/adapters/extension/icons/icon-{16,32,48,128}.png
 * Depends: node:zlib / node:fs のみ。外部依存なし
 *
 *   node scripts/make-icons.mjs
 *
 * なぜスクリプトで作るか: 画像編集ソフトを挟むとアイコンの由来が追えなくなり、
 * 色をブランド色に合わせ直すたびに手作業が要る。デザインを数値で持っておけば
 * トークン（--primary）が変わったときにここだけ直せば再生成できる。
 * 生成結果は commit する。ビルド時には走らせない（ビルドステップを増やさない）。
 *
 * SVG ではなく PNG なのは、MV3 の icons が SVG を受け付けないため。
 */

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

//----------------------------------------------------------------
// 定数
//----------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = join(ROOT, 'src/adapters/extension/icons');

const ICON_SIZES = [16, 32, 48, 128];

/** 1 ピクセルあたりの一辺のサブサンプル数。8×8=64 点の平均でアンチエイリアスする */
const SUBSAMPLES_PER_SIDE = 8;

/** ui.css の --primary と同じブランド色 */
const BACKGROUND_COLOR = [0x1f, 0x6f, 0xeb];
const MARK_COLOR = [0xff, 0xff, 0xff];

/** 背景の角丸。辺の長さに対する比 */
const BACKGROUND_RADIUS_RATIO = 0.22;

/**
 * 「棚に並んだ本」のマーク。すべて 0..1 の相対座標で持つ。
 * 16px でも潰れないよう、棚板を入れて縦棒が何であるかを示す。
 *
 * 幅を揃えて直立させると棒グラフに見えてしまうため、幅を変え、
 * 右端の 1 冊を傾ける。この «寄りかかった本» が本棚だと読ませる主要な手がかり。
 */
const SHELF = { left: 0.16, right: 0.84, top: 0.78, bottom: 0.845, radius: 0.02 };
const BOOK_GAP = 0.055;
const BOOK_RADIUS = 0.025;
const BOOK_BASELINE = SHELF.top;

/** tilt は時計回りのラジアン。各冊の下端中央を軸に回す */
const BOOKS = [
  { width: 0.155, height: 0.44, tilt: 0 },
  { width: 0.115, height: 0.53, tilt: 0 },
  { width: 0.13, height: 0.40, tilt: 0.28 },
];

/** 傾けた 1 冊が右に張り出す分、全体を左へ寄せる */
const BOOK_GROUP_OFFSET = -0.045;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH = 8;

//----------------------------------------------------------------
// 関数定義
//----------------------------------------------------------------

/** 角丸長方形の内側か。r が 0 なら素の長方形と同じ判定になる */
function isInsideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;

  const maxRadius = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
  if (maxRadius <= 0) return true;

  // 角の 4 領域だけ円で判定し、それ以外は長方形として通す
  const nearLeft = x < left + maxRadius;
  const nearRight = x > right - maxRadius;
  const nearTop = y < top + maxRadius;
  const nearBottom = y > bottom - maxRadius;
  if (!((nearLeft || nearRight) && (nearTop || nearBottom))) return true;

  const cornerX = nearLeft ? left + maxRadius : right - maxRadius;
  const cornerY = nearTop ? top + maxRadius : bottom - maxRadius;
  return Math.hypot(x - cornerX, y - cornerY) <= maxRadius;
}

/** 本の矩形を相対座標で返す（棚の中央に寄せる） */
function buildBookRects() {
  const totalWidth =
    BOOKS.reduce((sum, book) => sum + book.width, 0) + (BOOKS.length - 1) * BOOK_GAP;
  let left = (1 - totalWidth) / 2 + BOOK_GROUP_OFFSET;

  return BOOKS.map((book) => {
    const rect = {
      left,
      right: left + book.width,
      top: BOOK_BASELINE - book.height,
      bottom: BOOK_BASELINE,
      radius: BOOK_RADIUS,
      tilt: book.tilt,
      // 回転の軸は下端中央。棚に接したまま傾くようにする
      pivotX: left + book.width / 2,
      pivotY: BOOK_BASELINE,
    };
    left += book.width + BOOK_GAP;
    return rect;
  });
}

const BOOK_RECTS = buildBookRects();

/** 傾いた本の内側か。標本点を逆回転させて素の矩形判定に落とす */
function isInsideBook(x, y, book) {
  let localX = x;
  let localY = y;
  if (book.tilt) {
    const dx = x - book.pivotX;
    const dy = y - book.pivotY;
    const cos = Math.cos(-book.tilt);
    const sin = Math.sin(-book.tilt);
    localX = book.pivotX + dx * cos - dy * sin;
    localY = book.pivotY + dx * sin + dy * cos;
  }
  return isInsideRoundedRect(
    localX, localY, book.left, book.top, book.right, book.bottom, book.radius
  );
}

/**
 * 相対座標 1 点の色を返す。透明なら null。
 * 白いマークを先に判定し、外れたら青い背景、それも外れたら透明。
 */
function sampleColor(x, y) {
  const isShelf = isInsideRoundedRect(
    x, y, SHELF.left, SHELF.top, SHELF.right, SHELF.bottom, SHELF.radius
  );
  const isBook = BOOK_RECTS.some((book) => isInsideBook(x, y, book));
  if (isShelf || isBook) return MARK_COLOR;

  const isBackground = isInsideRoundedRect(x, y, 0, 0, 1, 1, BACKGROUND_RADIUS_RATIO);
  return isBackground ? BACKGROUND_COLOR : null;
}

/**
 * size×size の RGBA ピクセル列を作る。
 * 1 ピクセルを SUBSAMPLES_PER_SIDE² 点でサンプリングし、
 * アルファで重みづけして平均する（premultiplied で足してから戻す）。
 */
function renderPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUBSAMPLES_PER_SIDE);
  const sampleCount = SUBSAMPLES_PER_SIDE * SUBSAMPLES_PER_SIDE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sumRed = 0;
      let sumGreen = 0;
      let sumBlue = 0;
      let coverage = 0;

      for (let sy = 0; sy < SUBSAMPLES_PER_SIDE; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES_PER_SIDE; sx += 1) {
          const x = (px * SUBSAMPLES_PER_SIDE + sx + 0.5) * step;
          const y = (py * SUBSAMPLES_PER_SIDE + sy + 0.5) * step;
          const color = sampleColor(x, y);
          if (!color) continue;
          sumRed += color[0];
          sumGreen += color[1];
          sumBlue += color[2];
          coverage += 1;
        }
      }

      const offset = (py * size + px) * 4;
      if (coverage === 0) continue; // 透明のまま
      pixels[offset] = Math.round(sumRed / coverage);
      pixels[offset + 1] = Math.round(sumGreen / coverage);
      pixels[offset + 2] = Math.round(sumBlue / coverage);
      pixels[offset + 3] = Math.round((coverage / sampleCount) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** PNG のチャンク（長さ + 型 + データ + CRC）を組み立てる */
function buildChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGBA;
  // 圧縮方式・フィルタ方式・インタレースはいずれも規格上の既定値（0）

  // 各スキャンラインの先頭にフィルタ種別バイト（0 = None）を置く
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', header),
    buildChunk('IDAT', deflateSync(raw, { level: 9 })),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

//----------------------------------------------------------------
// 実行
//----------------------------------------------------------------

await mkdir(OUTPUT_DIR, { recursive: true });

for (const size of ICON_SIZES) {
  const png = encodePng(size, renderPixels(size));
  const path = join(OUTPUT_DIR, `icon-${size}.png`);
  await writeFile(path, png);
  console.log(`[make-icons] ${path} (${png.length} bytes)`);
}
