import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RaceAudioSynth, audioConfigFor, parseBank } from '../src/audio/synth.js';
import { CARS } from '../src/sim/cars.js';

const SR = 48000;
const BANK_DIR = new URL('../public/audio/', import.meta.url);
const bankCache = new Map();
// the recorded-cycle bank shipped for a car, or null (then the car is synthesis only)
function bankFor(carId) {
  const name = audioConfigFor(CARS[carId]).bankName;
  if (!name) return null;
  if (!bankCache.has(name)) {
    let b = null;
    try { const f = fs.readFileSync(new URL(name + '.wav', BANK_DIR)); b = parseBank(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)); } catch (e) { b = null; }
    bankCache.set(name, b);
  }
  return bankCache.get(name);
}
// voice: 'synth' = physical model only (the fallback path), 'bank' = recorded cycles (the shipped path)
function render(carId, rpm, { seconds = 1.5, throttle = 1, voice = 'synth', set = {} } = {}) {
  const s = new RaceAudioSynth(SR), cfg = audioConfigFor(CARS[carId]);
  s.configure(cfg);
  if (voice === 'bank') { const b = bankFor(carId); assert.ok(b, `${carId} has a bank`); assert.ok(s.setBank(Object.assign({}, b.meta, { car: cfg.id }), b.pcm)); }
  s.set(Object.assign({ rpm, throttle, load: throttle > 0 ? throttle : -0.1, speed: 0, master: 0.6, motor: throttle }, set));
  s.p.rpm = rpm;
  const n = Math.round(SR * seconds), L = new Float32Array(n), R = new Float32Array(n);
  for (let o = 0; o < n; o += 128) s.process(L.subarray(o, o + 128), R.subarray(o, o + 128), Math.min(128, n - o));
  const m = new Float32Array(n - SR / 2); // mono mix, transient skipped
  for (let i = 0; i < m.length; i++) m[i] = (L[i + SR / 2] + R[i + SR / 2]) / 2;
  return m;
}
function goertzel(x, f) {
  const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (x.length - 1)); const s0 = x[i] * hann + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}
const stats = (x) => { let peak = 0, rms = 0; for (const v of x) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); rms += v * v; } return { peak, rms: Math.sqrt(rms / x.length) }; };
const voicesOf = (id) => bankFor(id) ? ['synth', 'bank'] : ['synth'];
const ICE = Object.keys(CARS).filter(id => !CARS[id].engine.electric);

test('output is finite, bounded and audible for every car, both engine voices', () => {
  for (const id of Object.keys(CARS)) for (const voice of voicesOf(id)) {
    const { peak, rms } = stats(render(id, CARS[id].engine.redline * 0.6, { voice }));
    assert.ok(peak <= 1.0, `${id}/${voice} peak ${peak}`);
    assert.ok(rms > 0.01, `${id}/${voice} rms ${rms}`);
  }
});

test('no hard clipping at the redline under full load, and off-load is quieter than on-load', () => {
  for (const id of ICE) for (const voice of voicesOf(id)) {
    const red = CARS[id].engine.redline;
    const on = stats(render(id, red, { voice })), off = stats(render(id, red, { voice, throttle: 0 }));
    assert.ok(on.peak < 0.97, `${id}/${voice} redline peak ${on.peak}`);
    assert.ok(on.rms < 0.4, `${id}/${voice} redline rms ${on.rms}`);
    assert.ok(off.rms < on.rms * 0.8, `${id}/${voice} off ${off.rms} vs on ${on.rms}`);
  }
});

test('even-firing engines peak at cylinders/2 x crank frequency (synth and recorded voices)', () => {
  for (const id of ICE) {
    if (CARS[id].engine.layout === 'V8X') continue;           // uneven per-bank firing: separate test
    const e = CARS[id].engine, cyl = e.cylinders;
    for (const voice of voicesOf(id)) for (const frac of [0.45, 0.65]) {
      const rpm = Math.round(e.redline * frac), firing = rpm / 60 * cyl / 2;
      const x = render(id, rpm, { voice });
      // firing fundamental plus its octave (exhaust formants can favour either)
      const atFiring = goertzel(x, firing) + goertzel(x, firing * 2), half = goertzel(x, firing * 0.5);
      // Energy at the firing order must dominate the half-order and an inharmonic neighbour. One physical
      // exception: a V10 recorded trackside is heard one exhaust bank at a time, and a bank of five fires at
      // HALF the engine's firing frequency (2.5x crank) - in the real F1 recordings that order is the
      // strongest. There the firing order must still be clearly present and the series strictly harmonic.
      if (voice === 'bank' && cyl === 10) {
        assert.ok(atFiring > 0.25 * half, `${id}/${voice}@${rpm} firing order present next to the bank order`);
        assert.ok(atFiring + half > 8 * (goertzel(x, firing * 1.37) + goertzel(x, firing * 0.685)), `${id}/${voice}@${rpm} harmonic vs inharmonic`);
      } else {
        assert.ok(atFiring > 2 * half, `${id}/${voice}@${rpm} firing vs half order`);
        assert.ok(atFiring > 8 * goertzel(x, firing * 1.37), `${id}/${voice}@${rpm} firing vs inharmonic`);
      }
    }
  }
});

test('cross-plane V8 has the half-order burble an even-firing engine lacks', () => {
  const rpm = 3000;
  const rel = (x, cyl) => { const f = rpm / 60 * cyl / 2; return (goertzel(x, f / 4) + goertzel(x, f / 2) + goertzel(x, f * 0.75)) / goertzel(x, f); };
  for (const voice of voicesOf('coupe')) {
    // V8: sub-orders of the 4x firing order (1x, 2x, 3x crank) from uneven per-bank firing
    const v8 = render('coupe', rpm, { voice });
    assert.ok(rel(v8, 8) > 0.15, `V8/${voice} sub-order ratio ${rel(v8, 8)}`);
  }
  for (const voice of voicesOf('hatch')) {
    const i4 = render('hatch', rpm, { voice });
    const i4half = goertzel(i4, rpm / 60) / goertzel(i4, rpm / 60 * 2);
    assert.ok(i4half < (voice === 'synth' ? 0.05 : 0.2), `I4/${voice} half-order ratio ${i4half}`);
  }
});

test('pitch tracks rpm continuously for both voices; electric motor whine tracks motor speed', () => {
  for (const voice of voicesOf('gt3')) {
    const lo = render('gt3', 4000, { voice }), hi = render('gt3', 8000, { voice });
    assert.ok(goertzel(hi, 400) > 2 * goertzel(hi, 200), `${voice} hi`);
    assert.ok(goertzel(lo, 200) > 2 * goertzel(lo, 100), `${voice} lo`);
    assert.ok(goertzel(lo, 200) > 20 * goertzel(lo, 260), `${voice} inharmonic`);
  }
  // recorded cycles are re-pitched to the exact rpm, also between and outside the recorded bands
  for (const id of ICE) {
    if (!bankFor(id)) continue;
    const e = CARS[id].engine;
    for (const rpm of [e.idle * 1.3, e.redline * 0.37, e.redline * 0.53, e.redline * 0.83]) {
      const f = rpm / 60 * e.cylinders / 2, x = render(id, rpm, { voice: 'bank' });
      const on = goertzel(x, f) + goertzel(x, 2 * f) + goertzel(x, f / 2), offPitch = goertzel(x, f * 1.19) + goertzel(x, 2 * f * 1.19) + goertzel(x, f / 2 * 1.19);
      assert.ok(on > 5 * offPitch, `${id}@${Math.round(rpm)} harmonic ${on} vs detuned ${offPitch}`);
    }
  }
  const ev = render('ev', 9000);
  assert.ok(goertzel(ev, 9000 / 60 * 4) > 6 * goertzel(ev, 9000 / 60 * 4 * 1.2));
});

test('rpm sweep with a bank stays click-free across band changes', () => {
  for (const id of ICE) {
    const b = bankFor(id); if (!b) continue;
    const e = CARS[id].engine, s = new RaceAudioSynth(SR), cfg = audioConfigFor(CARS[id]);
    s.configure(cfg); s.setBank(Object.assign({}, b.meta, { car: cfg.id }), b.pcm);
    const n = SR * 3, L = new Float32Array(n), R = new Float32Array(n);
    let maxStep = 0, peak = 0;
    for (let o = 0; o < n; o += 128) {
      const t = o / n, rpm = e.idle + (e.redline - e.idle) * (t < 0.5 ? t * 2 : 2 - t * 2), thr = t < 0.5 ? 1 : 0;
      s.set({ rpm, throttle: thr, load: thr ? 1 : -0.1, master: 0.6 });
      s.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128);
    }
    for (let i = SR / 10; i < n; i++) { assert.ok(Number.isFinite(L[i])); maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1])); peak = Math.max(peak, Math.abs(L[i])); }
    assert.ok(peak < 0.97, `${id} sweep peak ${peak}`);
    assert.ok(maxStep < 0.5, `${id} sweep sample-to-sample step ${maxStep}`);
  }
});

test('bank files are valid, small, and a broken bank falls back to synthesis', () => {
  let total = 0;
  for (const f of fs.existsSync(BANK_DIR) ? fs.readdirSync(BANK_DIR) : []) total += fs.statSync(new URL(f, BANK_DIR)).size;
  assert.ok(total < 15e6, `audio assets ${total} bytes`);
  for (const id of ICE) {
    const b = bankFor(id); if (!b) continue;
    assert.ok(b.meta.bands.length >= 2 && b.meta.cyl === CARS[id].engine.cylinders, `${id} bank matches the engine`);
    for (const band of b.meta.bands) for (const k of ['on', 'off']) if (band[k]) for (const at of band[k].at) assert.ok(at >= 0 && at + band.L * (1 + b.meta.ov) <= b.pcm.length, `${id} grain in range`);
  }
  assert.equal(parseBank(new ArrayBuffer(10)), null);
  assert.equal(parseBank(new TextEncoder().encode('<!doctype html><html>404</html>'.repeat(20)).buffer), null);
  const s = new RaceAudioSynth(SR); s.configure(audioConfigFor(CARS.gt3));
  assert.equal(s.setBank(null, null), false);
  assert.equal(s.setBank({ bands: [] }, new Float32Array(4)), false);
  assert.equal(s.setBank({ bands: [{ rpm: 1000, L: 100 }, { rpm: 2000, L: 50 }] }, new Float32Array(400)), false);
  const L = new Float32Array(4800), R = new Float32Array(4800);
  s.set({ rpm: 5000, throttle: 1, load: 1 }); s.process(L, R, 4800);
  assert.ok(stats(L).rms > 0.005, 'synth engine still sounds after a rejected bank');
  // a bank only ever plays for the car it was installed for
  const b = bankFor('gt3');
  if (b) { assert.ok(s.setBank(Object.assign({}, b.meta, { car: 'gt3' }), b.pcm)); s.configure(audioConfigFor(CARS.coupe)); assert.equal(s.bank, null); }
});

test('audioConfigFor never throws: new cars and unknown ids / layouts get a sensible preset', () => {
  for (const id of Object.keys(CARS)) { const c = audioConfigFor(CARS[id]); assert.ok(Array.isArray(c.off) && c.redline > 0, id); }
  if (CARS.hypercar) { const c = audioConfigFor(CARS.hypercar); assert.equal(c.off.length, 6); assert.equal(c.turbo, true); assert.ok(c.gearWhine > 0); }
  if (CARS.mini) { const c = audioConfigFor(CARS.mini); assert.equal(c.off.length, 4); assert.equal(c.turbo, true); assert.notEqual(c.bankName, audioConfigFor(CARS.hatch).bankName); }
  const odd = audioConfigFor({ id: 'nope', engine: { layout: 'W16', cylinders: 16, redline: 6500, torque: [] } });
  assert.ok(odd.off.length > 0 && odd.redline === 6500);
  assert.equal(audioConfigFor({ id: 'x', engine: { layout: '??', cylinders: 8, redline: 7000 } }).off.length, 8);
  assert.equal(audioConfigFor({ id: 'x', engine: { electric: true, cylinders: 0 } }).electric, true);
  assert.ok(audioConfigFor({}).off.length > 0);
  assert.ok(audioConfigFor(undefined).off.length > 0);
  const s = new RaceAudioSynth(SR); s.configure(odd); const L = new Float32Array(2048), R = new Float32Array(2048);
  s.set({ rpm: 4000, throttle: 1, load: 1 }); s.process(L, R, 2048); stats(L);
});

test('tyre squeal is tonal and tracks slip; cockpit is darker than outside; trackside has no wind', () => {
  const band = (x, lo, hi) => { let e = 0; for (let f = lo; f < hi; f *= 1.04) e += goertzel(x, f) ** 2; return e; };
  const quiet = { master: 0.6 };
  const none = render('ev', 0, { throttle: 0, set: { ...quiet, squeal: 0, speed: 0 } });
  const sq = render('ev', 0, { throttle: 0, set: { ...quiet, squeal: 0.6, speed: 0 } });
  const sq2 = render('ev', 0, { throttle: 0, set: { ...quiet, squeal: 1.0, speed: 0 } });
  assert.ok(stats(sq).rms > 20 * stats(none).rms + 1e-4, 'squeal audible');
  assert.ok(stats(sq2).rms > 1.3 * stats(sq).rms, 'more slip, more squeal');
  // energy sits in the 0.5-1.6 kHz howl band, not spread like white noise
  assert.ok(band(sq, 500, 1600) > 6 * (band(sq, 100, 400) + band(sq, 2500, 9000)), 'squeal is tonal');
  const out = render('gt3', 7000, { set: { cockpit: 0 }, seconds: 2 }), cab = render('gt3', 7000, { set: { cockpit: 1 }, seconds: 2 });
  const tilt = (x) => band(x, 3000, 9000) / band(x, 100, 1000);
  assert.ok(tilt(cab) < 0.5 * tilt(out), `cockpit tilt ${tilt(cab)} vs ${tilt(out)}`);
  const wind = render('ev', 0, { throttle: 0, set: { ...quiet, speed: 70 } }), tv = render('ev', 0, { throttle: 0, set: { ...quiet, speed: 70, tv: 1 }, seconds: 2.5 });
  assert.ok(stats(wind).rms > 5 * stats(tv).rms, 'no wind or tyre roar at the trackside camera');
});

test('bad parameters (NaN, undefined) never poison the voice', () => {
  for (const id of ['gt3', 'ev']) for (const voice of voicesOf(id)) {
    const s = new RaceAudioSynth(SR), cfg = audioConfigFor(CARS[id]); s.configure(cfg);
    if (voice === 'bank') { const b = bankFor(id); s.setBank(Object.assign({}, b.meta, { car: cfg.id }), b.pcm); }
    const L = new Float32Array(4800), R = new Float32Array(4800);
    s.set({ rpm: NaN, load: NaN, motor: undefined, throttle: Infinity, speed: null, master: 0.6 }); s.trigger('impact', NaN); s.trigger('shift', undefined);
    s.process(L, R, 4800);
    s.set({ rpm: 5000, load: 1, motor: 1, throttle: 1 }); s.process(L, R, 4800);
    assert.ok(stats(L).rms > 0.003, `${id}/${voice} recovers`);
  }
});

test('surfaces, kerbs, brakes, impacts and shifts each add sound', () => {
  const base = stats(render('ev', 0, { throttle: 0, set: { speed: 30 } })).rms;
  for (const k of ['gravel', 'grass', 'kerb', 'brake', 'scrub']) {
    const r = stats(render('ev', 0, { throttle: 0, set: { speed: 30, [k]: 1 } })).rms;
    assert.ok(r > base * 1.15, `${k}: ${r} vs ${base}`);
  }
  for (const trig of ['impact', 'shift']) {
    const s = new RaceAudioSynth(SR); s.configure(audioConfigFor(CARS.ev)); s.set({ rpm: 0, master: 0.6 });
    const L = new Float32Array(SR / 4), R = new Float32Array(SR / 4);
    s.process(L, R, 4800); s.trigger(trig, 1); s.process(L, R, L.length);
    const { peak } = stats(L); assert.ok(peak > 0.03 && peak <= 1, `${trig} peak ${peak}`);
  }
});
