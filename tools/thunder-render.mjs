// Renders thunder strikes offline with the same code the page plays (src/audio/thunder.js),
// writes WAVs and prints the measurements that stand in for listening.
//   node tools/thunder-render.mjs <outDir>
import fs from 'node:fs';
import { renderThunder } from '../src/audio/thunder.js';
import { analyse } from './thunder-analyse.mjs';
const out = process.argv[2]; if (out) fs.mkdirSync(out, { recursive: true });
function wav(path, L, R, sr) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4); b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4); }
  fs.writeFileSync(path, b);
}
for (const [name, o] of [['near-0.3km', { km: 0.3, seed: 11 }], ['close-0.7km', { km: 0.7, seed: 5 }], ['mid-1.5km', { km: 1.5, seed: 7 }], ['far-4km', { km: 4, seed: 3 }], ['double-1km', { km: 1, seed: 21, double: true }], ['near-0.4km-b', { km: 0.4, seed: 99 }]]) {
  const t0 = performance.now(), th = renderThunder({ sampleRate: 48000, ...o }), ms = performance.now() - t0;
  const th24 = renderThunder({ sampleRate: 24000, ...o });
  console.log(name, JSON.stringify(analyse(th)), `render48k ${ms.toFixed(0)} ms`, `peak24k ${th24.left.reduce((m, v) => Math.max(m, Math.abs(v)), 0).toFixed(2)}`);
  if (out) wav(`${out}/thunder-${name}.wav`, th.left, th.right, th.sampleRate);
}
