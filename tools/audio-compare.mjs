#!/usr/bin/env node
// Scores the game's engine sound against the measured reference recordings.
//
//   node tools/audio-compare.mjs [car ...]
//
// For every rpm band / load state for which tools/audio-build.py found real
// engine cycles in the reference recording (tools/audio-ref/<car>.json), the
// engine is rendered offline at the matching rpm and load and compared by
//   LSD   log-spectral distance, 1/6-octave bands 50 Hz - 8 kHz, level-normalised (dB rms)
//   ORD   mean |error| of the crank half-order amplitudes (dB), orders within 30 dB of the strongest
//   CYC   cycle-to-cycle correlation of the waveform (roughness): reference vs before vs after
// for  "before" = the original pure synth (tools/audio-legacy-synth.js)
//      "synth"  = the current synth with no bank loaded (the fallback path)
//      "after"  = the shipped voice: current synth + public/audio/<car>.wav
// The reference cycles used for scoring are, where enough exist, cycles that
// were NOT copied into the bank (heldOut = yes).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RaceAudioSynth, audioConfigFor, parseBank } from '../src/audio/synth.js';
import * as legacy from './audio-legacy-synth.js';
import { CARS } from '../src/sim/cars.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SR = 44100, NFEAT = 44;
const edges = Array.from({ length: NFEAT + 1 }, (_, i) => 50 * 2 ** (i / 6));

export function loadBank(name) {
  try { const b = fs.readFileSync(path.join(here, '../public/audio', name + '.wav')); return parseBank(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch (e) { return null; }
}
export function loadRef(car) {
  try { return JSON.parse(fs.readFileSync(path.join(here, 'audio-ref', car + '.json'), 'utf8')); } catch (e) { return null; }
}

function fft(re, im) {          // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}

// Same features as tools/audio-build.py chunk_features(): Hann windows of 2 engine cycles.
export function features(x, L, ncyl2) {
  const n = 2 * L, N = 1 << Math.ceil(Math.log2(n)), P = new Float64Array(N / 2 + 1);
  const re = new Float64Array(N), im = new Float64Array(N); let cnt = 0;
  const nOrd = ncyl2, ord = new Float64Array(nOrd);
  for (let o = 0; o + n <= x.length; o += L) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < n; i++) re[i] = x[o + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
    // crank half-orders: exact DFT bins of the 2-cycle window (bin 2*h for half-order h), +-1 bin
    for (let h = 1; h <= nOrd; h++) for (let d = -1; d <= 1; d++) {
      const k = 2 * h + d, w = 2 * Math.PI * k / n; let sr = 0, si = 0;
      for (let i = 0; i < n; i++) { sr += re[i] * Math.cos(w * i); si -= re[i] * Math.sin(w * i); }
      ord[h - 1] += sr * sr + si * si;
    }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
    cnt++;
  }
  // cycle-to-cycle correlation (1 = every engine cycle identical, lower = rougher)
  let qs = 0, qn = 0;
  for (let o = 0; o + n <= x.length; o += L) { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < L; i++) { ab += x[o + i] * x[o + L + i]; aa += x[o + i] * x[o + i]; bb += x[o + L + i] * x[o + L + i]; } qs += ab / Math.sqrt(aa * bb + 1e-30); qn++; }
  const feat = new Float64Array(NFEAT), df = SR / N;
  for (let b = 0; b < NFEAT; b++) { let s = 0, m = 0; for (let k = Math.ceil(edges[b] / df); k * df < edges[b + 1]; k++) { s += P[k]; m++; } feat[b] = m ? s / cnt : P[Math.round(Math.sqrt(edges[b] * edges[b + 1]) / df)] * (edges[b + 1] - edges[b]) / df / cnt; }
  return { feat, orders: Array.from(ord, v => v / cnt), q: qn ? qs / qn : NaN };
}

const dB = (v) => 10 * Math.log10(v + 1e-30);
export function lsd(a, b) {
  const sa = a.reduce((s, v) => s + v, 0), sb = b.reduce((s, v) => s + v, 0);
  let e = 0, n = 0; const pk = Math.max(...b) / sb;
  for (let i = 0; i < a.length; i++) {
    const fl = pk * 1e-5;                                   // 50 dB below the reference peak band
    const d = dB(Math.max(a[i] / sa, fl)) - dB(Math.max(b[i] / sb, fl)); e += d * d; n++;
  }
  return Math.sqrt(e / n);
}
export function orderErr(a, b) {
  const n = Math.min(a.length, b.length); if (!n) return NaN;
  const sa = a.slice(0, n).reduce((s, v) => s + v, 0), sb = b.slice(0, n).reduce((s, v) => s + v, 0), pk = Math.max(...b.slice(0, n)) / sb;
  let e = 0, m = 0;
  for (let i = 0; i < n; i++) { if (b[i] / sb < pk * 1e-3) continue; e += Math.abs(dB(Math.max(a[i] / sa, pk * 1e-4)) - dB(b[i] / sb)); m++; }
  return m ? e / m : NaN;
}

export function renderSynth(Synth, cfg, bank, rpm, on, seconds = 2.5) {
  const s = new Synth(SR); s.configure(cfg);
  if (bank && s.setBank) s.setBank(Object.assign({}, bank.meta, { car: cfg.id }), bank.pcm);
  s.set({ rpm, throttle: on ? 1 : 0, load: on ? 1 : -0.12, speed: 0, master: 0.5, motor: on ? 1 : 0, boost: 0 });
  s.p.rpm = rpm;
  const n = Math.round(SR * seconds), Lb = new Float32Array(n), Rb = new Float32Array(n);
  for (let o = 0; o < n; o += 128) s.process(Lb.subarray(o, o + 128), Rb.subarray(o, o + 128), Math.min(128, n - o));
  const skip = SR >> 1, m = new Float32Array(n - skip);
  for (let i = 0; i < m.length; i++) m[i] = (Lb[i + skip] + Rb[i + skip]) / 2;
  return m;
}

// score(render) where render(rpmGame, on) -> Float32Array mono @ SR
export function score(ref, render) {
  const rows = [];
  for (const b of ref.bands) {
    const x = render(b.rpm / (ref.rpmScale || 1), b.state === 'on'); if (!x) continue;
    const L = Math.round(b.L);
    const f = features(x, L, b.orders.length);
    rows.push({ rpm: b.rpm, state: b.state, held: b.heldOut, lsd: lsd(f.feat, b.feat), ord: orderErr(f.orders, b.orders), q: f.q, qref: b.q });
  }
  return rows;
}
export const mean = (rows, k, flt = () => true) => { const v = rows.filter(flt).map(r => r[k]).filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-')), verbose = process.argv.includes('-v');
  const cars = args.length ? args : Object.keys(CARS);
  const f1 = (v) => Number.isFinite(v) ? v.toFixed(1).padStart(5) : '    -';
  console.log('car        bands  held-out | LSD dB: before  synth  after | ORD dB: before  synth  after | off-load LSD: before after | CYC: ref before after');
  for (const id of cars) {
    const spec = CARS[id]; if (!spec) continue;
    const cfg = audioConfigFor(spec), ref = loadRef(cfg.bankName || id), bank = cfg.bankName ? loadBank(cfg.bankName) : null;
    if (!ref) { console.log(`${id.padEnd(10)} no reference recording -> synthesis only (not scored)`); continue; }
    let lcfg; try { lcfg = Object.assign(legacy.audioConfigFor(spec), {}); if (!lcfg.off) throw 0; } catch (e) { lcfg = Object.assign({}, legacy.RaceAudioSynth.layouts()[spec.engine.cylinders === 6 ? 'F6' : 'I4'], { redline: spec.engine.redline, turbo: !!spec.engine.turbo }); }
    const before = score(ref, (rpm, on) => renderSynth(legacy.RaceAudioSynth, lcfg, null, rpm, on));
    const synth = score(ref, (rpm, on) => renderSynth(RaceAudioSynth, cfg, null, rpm, on));
    const after = bank ? score(ref, (rpm, on) => renderSynth(RaceAudioSynth, cfg, bank, rpm, on)) : null;
    const on = r => r.state === 'on', offf = r => r.state === 'off';
    const held = before.filter(r => r.held).length;
    console.log(`${id.padEnd(10)} ${String(before.length).padStart(5)}  ${String(held).padStart(8)} |        ${f1(mean(before, 'lsd', on))}  ${f1(mean(synth, 'lsd', on))}  ${after ? f1(mean(after, 'lsd', on)) : '    -'} |        ${f1(mean(before, 'ord', on))}  ${f1(mean(synth, 'ord', on))}  ${after ? f1(mean(after, 'ord', on)) : '    -'} |               ${f1(mean(before, 'lsd', offf))} ${after ? f1(mean(after, 'lsd', offf)) : '    -'} |     ${mean(before, 'qref', on).toFixed(2)}  ${mean(before, 'q', on).toFixed(2)}  ${after ? mean(after, 'q', on).toFixed(2) : '-'}`);
    if (verbose) for (let i = 0; i < before.length; i++) console.log(`    ${before[i].rpm.toFixed(0).padStart(6)} rpm ${before[i].state.padEnd(3)} held=${before[i].held ? 'y' : 'n'}  LSD ${f1(before[i].lsd)} -> ${after ? f1(after[i].lsd) : '-'}   ORD ${f1(before[i].ord)} -> ${after ? f1(after[i].ord) : '-'}`);
  }
}
