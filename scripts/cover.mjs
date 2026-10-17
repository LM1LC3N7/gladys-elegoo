// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-teal gradient and
// a 3D printer (frame, print head, a layered print). Plain Node (zlib), no
// dependency.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [16, 32, 44];
const TEAL = [0, 150, 160];
const WHITE = [255, 255, 255];
const ACCENT = [255, 196, 64];

/** 1 inside the axis-aligned box, with a soft edge. */
const box = (x, y, x0, y0, x1, y1) =>
  Math.min(smooth(0, x0 - x), smooth(0, x - x1), smooth(0, y0 - y), smooth(0, y - y1));

/** The colour of one pixel: a 3D printer frame, its print head and a layered print. */
function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  // The frame: two uprights, the top bar, the base.
  const frame = Math.max(
    box(x, y, 220, 70, 250, 450),
    box(x, y, 550, 70, 580, 450),
    box(x, y, 220, 70, 580, 100),
    box(x, y, 200, 440, 600, 470),
  );
  color = mix(color, WHITE, frame);
  // The gantry and the print head with its nozzle.
  color = mix(color, WHITE, box(x, y, 250, 170, 550, 186) * 0.85);
  color = mix(color, ACCENT, box(x, y, 365, 150, 435, 215));
  const nozzle = box(x, y, 390, 215, 410, 240) * (Math.abs(x - 400) < 10 - (y - 215) / 4 ? 1 : 0);
  color = mix(color, ACCENT, nozzle);
  // The print: layers, narrower towards the top.
  for (let i = 0; i < 7; i += 1) {
    const half = 110 - i * 10;
    const top = 418 - i * 24;
    color = mix(
      color,
      i % 2 ? WHITE : ACCENT,
      box(x, y, 400 - half, top, 400 + half, top + 18) * 0.9,
    );
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
