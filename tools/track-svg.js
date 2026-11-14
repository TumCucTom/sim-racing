// Renders the circuit map to an SVG (docs/track.svg) and prints geometry stats.
import { buildTrack } from '../src/sim/track.js';
import fs from 'node:fs';
const t = buildTrack();
let minR = Infinity, minRi = 0;
for (let i = 0; i < t.n; i++) { const r = 1 / Math.max(1e-9, Math.abs(t.curv[i])); if (r < minR) { minR = r; minRi = i; } }
let zmin = Infinity, zmax = -Infinity, gmax = 0;
for (let i = 0; i < t.n; i++) { zmin = Math.min(zmin, t.z[i]); zmax = Math.max(zmax, t.z[i]); gmax = Math.max(gmax, Math.abs(t.grade[i])); }
// self-proximity check: any two samples > 60 m apart in s closer than 40 m?
let minSep = Infinity;
for (let i = 0; i < t.n; i += 3) for (let j = i + 80; j < t.n; j += 3) {
  if (t.n - (j - i) < 80) continue;
  const d = Math.hypot(t.x[i] - t.x[j], t.y[i] - t.y[j]); if (d < minSep) minSep = d;
}
console.log(JSON.stringify({ length: +t.length.toFixed(1), n: t.n, ds: t.ds, minRadius: +minR.toFixed(1), atS: minRi, relief: +(zmax - zmin).toFixed(1), maxGrade: +gmax.toFixed(3), minSeparation: +minSep.toFixed(1) }));
const pad = 60, g = t.grid;
const X = v => v - g.minX - 140, Y = v => g.maxY - 140 - v;
const W = g.maxX - g.minX - 280, H = g.maxY - g.minY - 280;
const line = (off, f) => { let p = ''; for (let i = 0; i <= t.n; i += 2) { const k = i % t.n; const o = typeof off === 'function' ? off(k) : off; p += `${i ? 'L' : 'M'}${X(t.x[k] - Math.sin(t.heading[k]) * o).toFixed(1)},${Y(t.y[k] + Math.cos(t.heading[k]) * o).toFixed(1)}`; } return p; };
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#2d4a2b"/>`;
svg += `<path d="${line(k => t.wallL[k])}" fill="none" stroke="#999" stroke-width="1"/><path d="${line(k => -t.wallR[k])}" fill="none" stroke="#999" stroke-width="1"/>`;
svg += `<path d="${line(0)}" fill="none" stroke="#333" stroke-width="${2 * t.halfWidth}" stroke-linejoin="round"/>`;
for (let i = 0; i < t.n; i += 100) svg += `<text x="${X(t.x[i])}" y="${Y(t.y[i])}" font-size="11" fill="#fff">${i}</text>`;
for (let i = 0; i < t.n; i += 1) if (t.kerb[i]) svg += `<circle cx="${X(t.x[i])}" cy="${Y(t.y[i])}" r="1" fill="#e33"/>`;
svg += '</svg>';
fs.mkdirSync('docs', { recursive: true }); fs.writeFileSync('docs/track.svg', svg);
