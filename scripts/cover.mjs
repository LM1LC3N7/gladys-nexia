// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a night-blue gradient, a
// wall thermostat with its display, a warm and a cool setpoint mark, a cloud
// linked by waves, and three zone dots. Plain Node (zlib), no dependency.
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

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const NIGHT = [14, 24, 48];
const BLUE = [24, 70, 120];
const WHITE = [240, 244, 248];
const STEEL = [180, 190, 204];
const SCREEN = [16, 28, 40];
const CYAN = [90, 200, 240];
const ORANGE = [255, 140, 50];
const GREEN = [110, 210, 140];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Distance to a segment. */
function segment(x, y, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

/** Seven-segment digits drawn as strokes, top-left at (ox, oy), 30×56. */
const SEGMENTS = {
  a: [0, 0, 30, 0],
  b: [30, 0, 30, 28],
  c: [30, 28, 30, 56],
  d: [0, 56, 30, 56],
  e: [0, 28, 0, 56],
  f: [0, 0, 0, 28],
  g: [0, 28, 30, 28],
};
const DIGITS = { 7: 'abc', 2: 'abged' };

function digit(x, y, ox, oy, value) {
  let d = Infinity;
  for (const s of DIGITS[value]) {
    const [x0, y0, x1, y1] = SEGMENTS[s];
    d = Math.min(d, segment(x, y, ox + x0, oy + y0, ox + x1, oy + y1));
  }
  return d;
}

function pixel(x, y) {
  let color = mix(NIGHT, BLUE, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);

  // The thermostat: a white wall unit with a dark display.
  const body = roundedBox(x, y, 300, 270, 170, 190, 28);
  color = mix(color, STEEL, smooth(0, Math.abs(body) - 3));
  color = mix(color, WHITE, smooth(0, body + 3));
  const display = roundedBox(x, y, 300, 220, 125, 95, 14);
  color = mix(color, SCREEN, smooth(0, display));
  // "72" on the display.
  color = mix(color, CYAN, smooth(4, Math.min(digit(x, y, 248, 190, 7), digit(x, y, 302, 190, 2))));
  // A heating (orange) and a cooling (cyan) setpoint mark under the digits.
  color = mix(color, ORANGE, smooth(7, Math.hypot(x - 255, y - 280)));
  color = mix(color, CYAN, smooth(7, Math.hypot(x - 345, y - 280)));
  // Two buttons under the display.
  for (const bx of [250, 350]) {
    const button = roundedBox(x, y, bx, 385, 34, 16, 14);
    color = mix(color, STEEL, smooth(0, button));
  }

  // Three zones: dots on the right, linked to the thermostat.
  for (const [zy, zc] of [
    [170, GREEN],
    [270, ORANGE],
    [370, CYAN],
  ]) {
    color = mix(color, STEEL, smooth(2, segment(x, y, 470, 270, 600, zy)));
    color = mix(color, zc, smooth(16, Math.hypot(x - 620, y - zy)));
    color = mix(color, WHITE, smooth(6, Math.hypot(x - 620, y - zy)));
  }

  // The cloud, top right, with waves.
  const cloud = Math.min(
    Math.hypot(x - 690, y - 70) - 30,
    Math.hypot(x - 730, y - 60) - 38,
    Math.hypot(x - 770, y - 78) - 26,
    roundedBox(x, y, 730, 92, 52, 16, 14),
  );
  color = mix(color, WHITE, smooth(0, cloud));
  const waves = Math.hypot(x - 620, y - 170);
  if (y < 160 && x > 620 && x < 700) {
    for (const r of [40, 62]) color = mix(color, CYAN, smooth(2.5, Math.abs(waves - r)));
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
