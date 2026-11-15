// Top-down map of a circuit's trackside exactly as the physics sees it: every pixel is
// coloured by surfaceXAt(), barriers by type. Station numbers (metres) are printed along the lap.
//   node tools/trackside-map.mjs <track id> <out.png> [s0 s1] [px per metre]
// With s0/s1 only that stretch of the lap is drawn (larger scale by default).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildTrack, surfaceXAt, SX, BAR, KERB_COLOURS } from '../src/sim/track.js';

const [id, out, a0, a1, sc0] = process.argv.slice(2);
const t = buildTrack(id), n = t.n;
const s0 = a0 != null ? +a0 : 0, s1 = a1 != null ? +a1 : t.length, part = a0 != null;
const i0 = Math.round(s0 / t.ds), i1 = Math.round(s1 / t.ds) + (s1 < s0 ? n : 0);
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (let k = i0; k < i1; k++) { const i = k % n; x0 = Math.min(x0, t.x[i]); x1 = Math.max(x1, t.x[i]); y0 = Math.min(y0, t.y[i]); y1 = Math.max(y1, t.y[i]); }
const pad = part ? 90 : 110; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
const sc = sc0 ? +sc0 : Math.min(part ? 4 : 1.2, 1900 / Math.max(x1 - x0, y1 - y0));
const W = Math.ceil((x1 - x0) * sc), H = Math.ceil((y1 - y0) * sc), px = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) { px[i * 3] = 52; px[i * 3 + 1] = 78; px[i * 3 + 2] = 44; }
const put = (X, Y, c) => { const u = Math.round((X - x0) * sc), v = Math.round((y1 - Y) * sc); if (u >= 0 && v >= 0 && u < W && v < H) { const o = (v * W + u) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; } };
const lin = (c) => c.map(v => Math.round(255 * Math.pow(v, 1 / 2.2)));
const C = { [SX.ASPHALT]: [58, 58, 62], [SX.GRASS]: [74, 122, 58], [SX.GRAVEL]: [214, 196, 140], [SX.RUNOFF]: [112, 112, 118], [SX.PAINT]: [40, 130, 90], [SX.ASTRO]: [40, 200, 70], [SX.SAUSAGE]: [255, 220, 0], [SX.PAVE]: [150, 146, 138] };
const BARC = { [BAR.ARMCO]: [225, 225, 235], [BAR.TYRES]: [10, 10, 10], [BAR.WALL]: [250, 250, 250], [BAR.TECPRO]: [230, 40, 40] };
const step = 0.45 / sc;
for (let kk = i0 * 2; kk < i1 * 2; kk++) {
  const i = (kk >> 1) % n, f = (kk & 1) * 0.5, j = (i + 1) % n;
  const X = t.x[i] + (t.x[j] - t.x[i]) * f, Y = t.y[i] + (t.y[j] - t.y[i]) * f, h = t.heading[i], nx = -Math.sin(h), ny = Math.cos(h);
  for (let d = -t.wallR[i]; d <= t.wallL[i]; d += step) {
    const sx = surfaceXAt(t, i, d); let c = C[sx];
    if (sx === SX.KERB || sx === SX.RUMBLE) { const col = KERB_COLOURS[(d > 0 ? t.kerbColL : t.kerbColR)[i]]; c = lin(Math.floor(i / (sx === SX.RUMBLE ? 1 : 2)) % 2 ? col[1] : col[2]); }
    if (sx === SX.ASPHALT && Math.abs(d - t.lineD[i]) < 0.5 / sc + 0.2) c = [30, 30, 30];
    put(X + nx * d, Y + ny * d, c);
  }
  for (const sg of [1, -1]) { const w = sg > 0 ? t.wallL[i] : t.wallR[i], c = BARC[(sg > 0 ? t.barL : t.barR)[i]]; for (let e = 0; e < 1.2; e += step) put(X + nx * sg * (w + e), Y + ny * sg * (w + e), c); }
}
// station labels: 3x5 digits
const FONT = { 0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111' };
const text = (u, v, str, c, z) => { for (let q = 0; q < str.length; q++) { const g = FONT[str[q]]; if (!g) continue; for (let r = 0; r < 5; r++) for (let cx = 0; cx < 3; cx++) if (g[r * 3 + cx] === '1') for (let a = 0; a < z; a++) for (let b = 0; b < z; b++) { const U = u + (q * 4 + cx) * z + a, V = v + r * z + b; if (U >= 0 && V >= 0 && U < W && V < H) { const o = (V * W + U) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; } } } };
const every = part ? 50 : t.length > 12000 ? 500 : 200;
for (let s = Math.ceil(s0 / every) * every; s < (s1 < s0 ? s1 + t.length : s1); s += every) {
  const i = Math.round((s % t.length) / t.ds) % n, h = t.heading[i], sg = t.curv[i] > 0 ? -1 : 1, off = sg * ((sg > 0 ? t.wallL[i] : t.wallR[i]) + 6);
  text(Math.round((t.x[i] - Math.sin(h) * off - x0) * sc) - 8, Math.round((y1 - (t.y[i] + Math.cos(h) * off)) * sc) - 5, String(Math.round(s % t.length)), [255, 255, 80], part ? 3 : 2);
  for (let d = -t.hw[i]; d <= t.hw[i]; d += step) put(t.x[i] - Math.sin(h) * d, t.y[i] + Math.cos(h) * d, [255, 255, 80]);
}
// minimal PNG writer
const crcT = new Uint32Array(256).map((_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
const raw = Buffer.alloc((W * 3 + 1) * H); for (let v = 0; v < H; v++) { raw[v * (W * 3 + 1)] = 0; Buffer.from(px.buffer, v * W * 3, W * 3).copy(raw, v * (W * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(out, W + 'x' + H, `${sc.toFixed(2)} px/m`);
