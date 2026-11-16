// Renders the soundtrack for a shot captured by tools/film.mjs: replays the exact messages the
// game sent to its audio synth (logged per video frame in <shot>/audio.json) through the same
// RaceAudioSynth class, offline, so sound and picture stay frame-locked.
//   node tools/film-audio.mjs <shotDir> [fps=30]   -> <shotDir>/audio.wav (48 kHz stereo)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RaceAudioSynth, parseBank } from '../src/audio/synth.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const [dir, fpsArg] = process.argv.slice(2), FPS = +(fpsArg || 30), SR = 48000;
const log = JSON.parse(fs.readFileSync(path.join(dir, 'audio.json'), 'utf8'));
const frames = fs.readdirSync(dir).filter(f => /^f\d+\.jpg$/.test(f)).length;
const s = new RaceAudioSynth(SR);
const configure = (cfg) => { s.configure(cfg); if (cfg.bankName) { try { const f = fs.readFileSync(path.join(here, '../public/audio', cfg.bankName + '.wav')); const b = parseBank(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)); if (b) s.setBank(b.meta, b.pcm); } catch (e) { console.log('no bank for', cfg.bankName); } } };
const apply = (m) => { if (m.cfg) configure(m.cfg); if (m.set) s.set(m.set.master ? m.set : { ...m.set, master: 0.8 });   // the game was paused while seeking
   if (m.trig) s.trigger(m.trig, m.amount); };
const per = SR / FPS, N = Math.round(frames * per), L = new Float32Array(N), R = new Float32Array(N);
let k = 0; while (k < log.length && log[k][0] < 0) apply(log[k++][1]);
// warm the synth up on the first frame's parameters so the shot does not start from silence
const first = log.slice(k).find(e => e[1].set); if (first) { s.set({ ...first[1].set, master: 0.8 }); const w = new Float32Array(128), w2 = new Float32Array(128); for (let i = 0; i < SR * 1.5 / 128; i++) s.process(w, w2, 128); }
for (let f = 0; f < frames; f++) {
  while (k < log.length && log[k][0] <= f) apply(log[k++][1]);
  const a = Math.round(f * per), b = Math.round((f + 1) * per);
  for (let o = a; o < b; o += 128) { const m = Math.min(128, b - o); s.process(L.subarray(o, o + m), R.subarray(o, o + m), m); }
}
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
const g = peak > 0.98 ? 0.98 / peak : 1;
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4); }
fs.writeFileSync(path.join(dir, 'audio.wav'), buf);
console.log(dir, frames, 'frames', (N / SR).toFixed(2) + ' s', 'peak', peak.toFixed(3), 'messages', log.length);
