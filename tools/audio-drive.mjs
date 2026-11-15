#!/usr/bin/env node
// Renders a scripted drive offline, through the real vehicle model and the
// real synth class, so that transients (launch, gear changes, lifts, downshift
// blips, limiter) can be measured and auditioned instead of steady rpm only.
//
//   node tools/audio-drive.mjs --out <dir> [--synth <synth.js>] [--bankdir <dir>] [--cam chase|bonnet] [car ...]
//
// Timeline (same for every car):
//    0.0 -  2.0 s  idle on the grid
//    2.0 - 24.0 s  the baseline AI driver does a standing start and drives (pulls through the gears,
//                  lifts, brakes and downshifts for the corners)
//   24.0 - 27.0 s  first gear held flat out, auto-shift off: wheelspin into the rev limiter
//   27.0 - 29.0 s  throttle closed, engine falls back to idle
// Writes <car>.wav (stereo, the full mix as the synth outputs it, before the page's reverb/compressor),
// <car>-engine.wav (mono, engine only: tyres, wind and gear whine muted) and <car>.json (60 Hz trace of
// rpm, throttle, load, gear, speed ...) for tools/audio-eval.py.
// --synth / --bankdir let an older synth and bank set be rendered through the same script (before/after).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTrack, SURF } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100, FPS = 60;

// Mirror of AudioEngine.update() in src/audio/audio.js (keep in step with it).
export function paramsFromCar(car, spec, peakTorque, cam) {
  let squeal = 0, scrub = 0, grass = 0, gravel = 0, kerb = 0;
  for (let i = 0; i < 4; i++) {
    const sf = car.surf[i], loadF = Math.min(1.5, car.fz[i] / (spec.mass * 2.45));
    if (sf === SURF.ASPHALT || sf === SURF.KERB) {
      squeal = Math.max(squeal, Math.min(1, Math.max(0, car.slipV[i] - 1.8) / 7) * loadF);
      scrub += Math.min(1, car.slipV[i] / 4) * 0.25 * loadF;
    } else if (sf === SURF.GRAVEL) gravel += 0.25; else grass += 0.25;
    if (sf === SURF.KERB) kerb += 0.5;
  }
  const v = car.speed, vf = Math.min(1, v / 18);
  const tq = (car.engineTorque || 0) / peakTorque;
  const load = car.limiterOn || car.shiftTimer > 0 ? 0 : Math.max(-0.3, Math.min(1, tq));
  return {
    rpm: Math.max(spec.engine.electric ? 0 : spec.engine.idle * 0.9, car.rpm), throttle: car.limiterOn ? 0 : car.throttle, load,
    speed: v, squeal, scrub, grass: grass * vf, gravel: gravel * vf, kerb: Math.min(1, kerb) * (v > 3 ? 1 : 0),
    brake: (car.brake || 0) * (v > 2 ? 1 : 0),
    boost: car.boost, wheelRps: v / (6.2832 * spec.wheelRadius), motor: tq,
    gear: car.gear, limiter: car.limiterOn ? 1 : 0, shifting: car.shiftTimer > 0 ? 1 : 0,
    cockpit: cam === 'bonnet' ? 1 : 0, tv: 0, master: 0.8,
  };
}

function wav(file, chans) {
  const n = chans[0].length, nc = chans.length, b = Buffer.alloc(44 + n * nc * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * nc * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(nc, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * nc * 2, 28); b.writeUInt16LE(nc * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * nc * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chans[c][i] * 32767))), 44 + (i * nc + c) * 2);
  fs.writeFileSync(file, b);
}

export async function renderDrive(id, { synthPath, bankDir, cam = 'chase', seconds = 29 } = {}) {
  const mod = await import(pathToFileURL(path.resolve(synthPath || path.join(here, '../src/audio/synth.js'))).href);
  const { RaceAudioSynth, audioConfigFor, parseBank } = mod;
  const spec = CARS[id], cfg = audioConfigFor(spec), track = buildTrack('ravenscar');
  const sim = new Sim(track, spec), drv = new BaselineDriver(track, spec, { grip: 0.9 });
  const peakTorque = Math.max(1, ...spec.engine.torque.map(t => t[1]));
  const mk = () => {
    const s = new RaceAudioSynth(SR); s.configure(cfg);
    if (cfg.bankName) {
      try { const f = fs.readFileSync(path.join(bankDir || path.join(here, '../public/audio'), cfg.bankName + '.wav')); const b = parseBank(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)); if (b) s.setBank(Object.assign({}, b.meta, { car: cfg.id }), b.pcm); } catch (e) { /* synth fallback */ }
    }
    return s;
  };
  const full = mk(), eng = mk();
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n), E = new Float32Array(n), E2 = new Float32Array(n);
  const trace = []; let o = 0, lastGear = sim.car.gear, acc = 0;
  for (let fr = 0; fr < seconds * FPS; fr++) {
    const t = fr / FPS; acc += 1 / FPS;
    while (acc > 0) {
      const car = sim.car; let c;
      if (t < 2) c = { steer: 0, throttle: 0, brake: 1 };
      else if (t < 24) c = drv.control(car);
      else if (t < 27) { if (car.aids.autoShift) { car.aids.autoShift = false; if (!spec.engine.electric) { car.gear = 1; } } c = { steer: drv.control(car).steer, throttle: 1, brake: 0 }; }
      else c = { steer: drv.control(car).steer, throttle: 0, brake: 0.3 };
      sim.step(c); acc -= sim.dt;
    }
    const car = sim.car, p = paramsFromCar(car, spec, peakTorque, cam);
    if (car.gear !== lastGear) { const a = spec.shiftTime < 0.1 ? 0.9 : 0.35; full.trigger('shift', a); eng.trigger('shift', a); lastGear = car.gear; }
    if (car.impact > 0.8) full.trigger('impact', car.impact / 7);
    full.set(p);
    eng.set(Object.assign({}, p, { speed: 0, squeal: 0, scrub: 0, grass: 0, gravel: 0, kerb: 0, brake: 0, wheelRps: 0 }));
    const end = Math.min(n, Math.round((fr + 1) * SR / FPS));
    for (; o < end; o += 128) { const m = Math.min(128, end - o); full.process(L.subarray(o, o + m), R.subarray(o, o + m), m); eng.process(E.subarray(o, o + m), E2.subarray(o, o + m), m); }
    o = end;
    trace.push([+t.toFixed(4), Math.round(p.rpm), +p.throttle.toFixed(3), +p.load.toFixed(3), car.gear, +p.speed.toFixed(2), p.limiter, p.shifting, +(p.boost || 0).toFixed(2)]);
  }
  for (let i = 0; i < n; i++) E[i] = (E[i] + E2[i]) / 2;
  return { L, R, E, trace, cyl: spec.engine.cylinders };
}

// Stationary revving, like most of the source recordings: idle, then blips of rising height (throttle open
// while the revs rise, closed while they fall), then one slow sweep to the redline and back.
export async function renderRev(id, { synthPath, bankDir } = {}) {
  const mod = await import(pathToFileURL(path.resolve(synthPath || path.join(here, '../src/audio/synth.js'))).href);
  const { RaceAudioSynth, audioConfigFor, parseBank } = mod;
  const spec = CARS[id], e = spec.engine, cfg = audioConfigFor(spec), s = new RaceAudioSynth(SR); s.configure(cfg);
  if (cfg.bankName) { try { const f = fs.readFileSync(path.join(bankDir || path.join(here, '../public/audio'), cfg.bankName + '.wav')); const b = parseBank(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)); if (b) s.setBank(Object.assign({}, b.meta, { car: cfg.id }), b.pcm); } catch (err) { /* synth */ } }
  const seg = [[1.5, 0]]; for (const f of [0.35, 0.5, 0.65, 0.8, 0.95]) seg.push([0, f], [0.5, 0]); seg.push([-6, 1], [-4, 0], [1, 0]);   // [hold seconds | -sweep seconds, target fraction of redline]
  const trace = [], chunks = []; let rpm = e.idle, t = 0;
  for (const [dur, frac] of seg) {
    const target = e.idle + (e.redline - e.idle) * frac, up = target > rpm, rate = dur < 0 ? Math.abs(target - rpm) / -dur : (up ? 0.55 : 0.3) * e.redline;
    let left = dur > 0 ? dur : 1e9;
    while (left > 0) {
      const moving = Math.abs(target - rpm) > 1; if (!moving && dur <= 0) break;
      rpm += Math.sign(target - rpm) * Math.min(Math.abs(target - rpm), rate / FPS);
      const thr = moving && up ? 1 : 0;
      s.set({ rpm, throttle: thr, load: thr ? 0.45 : -0.12, speed: 0, boost: thr * 0.5, wheelRps: 0, gear: 0, limiter: 0, shifting: 0, master: 0.8 });
      const L = new Float32Array(SR / FPS), R = new Float32Array(SR / FPS);
      for (let o = 0; o < L.length; o += 128) { const m = Math.min(128, L.length - o); s.process(L.subarray(o, o + m), R.subarray(o, o + m), m); }
      for (let i = 0; i < L.length; i++) L[i] = (L[i] + R[i]) / 2;
      chunks.push(L); trace.push([+t.toFixed(4), Math.round(rpm), thr, thr ? 0.45 : -0.12, 0, 0, 0, 0, 0]); t += 1 / FPS; if (dur > 0) left -= 1 / FPS;
    }
  }
  const E = new Float32Array(chunks.length * chunks[0].length); chunks.forEach((c, i) => E.set(c, i * c.length));
  return { E, trace, cyl: e.cylinders };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const out = opt('--out', '.'), synthPath = opt('--synth'), bankDir = opt('--bankdir'), cam = opt('--cam', 'chase');
  fs.mkdirSync(out, { recursive: true });
  for (const id of argv.length ? argv : Object.keys(CARS)) {
    if (!CARS[id]) continue;
    const r = await renderDrive(id, { synthPath, bankDir, cam });
    if (!CARS[id].engine.electric) {
      const v = await renderRev(id, { synthPath, bankDir });
      wav(path.join(out, id + '-rev.wav'), [v.E]); wav(path.join(out, id + '-rev-engine.wav'), [v.E]);
      fs.writeFileSync(path.join(out, id + '-rev.json'), JSON.stringify({ car: id, kind: 'rev', cyl: v.cyl, sr: SR, fps: FPS, trace: v.trace }));
    }
    wav(path.join(out, id + '.wav'), [r.L, r.R]); wav(path.join(out, id + '-engine.wav'), [r.E]);
    fs.writeFileSync(path.join(out, id + '.json'), JSON.stringify({ car: id, cyl: r.cyl, sr: SR, fps: FPS, cols: ['t', 'rpm', 'throttle', 'load', 'gear', 'speed', 'limiter', 'shifting', 'boost'], trace: r.trace }));
    let pk = 0, e = 0; for (let i = 0; i < r.L.length; i++) { const a = Math.abs(r.L[i]); if (a > pk) pk = a; e += r.L[i] * r.L[i]; }
    const gears = r.trace.map(x => x[4]); let shifts = 0; for (let i = 1; i < gears.length; i++) if (gears[i] !== gears[i - 1]) shifts++;
    console.log(`${id.padEnd(9)} peak ${pk.toFixed(2)} rms ${(10 * Math.log10(e / r.L.length + 1e-12)).toFixed(1)} dBFS, ${shifts} gear changes, vmax ${(Math.max(...r.trace.map(x => x[5])) * 3.6).toFixed(0)} km/h, limiter frames ${r.trace.filter(x => x[6]).length}`);
  }
}
