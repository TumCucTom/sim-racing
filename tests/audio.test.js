import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceAudioSynth, audioConfigFor } from '../src/audio/synth.js';
import { CARS } from '../src/sim/cars.js';

const SR = 48000;
function render(carId, rpm, seconds = 1.5, throttle = 1) {
  const s = new RaceAudioSynth(SR);
  s.configure(audioConfigFor(CARS[carId]));
  s.set({ rpm, throttle, load: throttle, speed: 0, master: 0.6, motor: throttle });
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

test('output is finite, bounded and audible for every car', () => {
  for (const id of Object.keys(CARS)) {
    const x = render(id, CARS[id].engine.redline * 0.6);
    let peak = 0, rms = 0;
    for (const v of x) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); rms += v * v; }
    rms = Math.sqrt(rms / x.length);
    assert.ok(peak <= 1.0, `${id} peak ${peak}`);
    assert.ok(rms > 0.01, `${id} rms ${rms}`);
  }
});

test('even-firing engines peak at cylinders/2 x crank frequency', () => {
  for (const [id, rpm] of [['hatch', 4500], ['gt3', 6000], ['formula', 12000]]) {
    const cyl = CARS[id].engine.cylinders, firing = rpm / 60 * cyl / 2;
    const x = render(id, rpm);
    // firing fundamental plus its octave (exhaust formants can favour either)
    const atFiring = goertzel(x, firing) + goertzel(x, firing * 2);
    // energy at the firing order must dominate the half-order and an inharmonic neighbour
    assert.ok(atFiring > 2 * goertzel(x, firing * 0.5), `${id} firing vs half order`);
    assert.ok(atFiring > 8 * goertzel(x, firing * 1.37), `${id} firing vs inharmonic`);
  }
});

test('cross-plane V8 has the half-order burble an even-firing engine lacks', () => {
  const rpm = 3000;
  const v8 = render('coupe', rpm), i4 = render('hatch', rpm);
  const rel = (x, cyl) => { const f = rpm / 60 * cyl / 2; return (goertzel(x, f / 4) + goertzel(x, f / 2) + goertzel(x, f * 0.75)) / goertzel(x, f); };
  // V8: sub-orders of the 4x firing order (1x, 2x, 3x crank) from uneven per-bank firing
  assert.ok(rel(v8, 8) > 0.15, `V8 sub-order ratio ${rel(v8, 8)}`);
  const i4half = goertzel(i4, rpm / 60) / goertzel(i4, rpm / 60 * 2);
  assert.ok(i4half < 0.05, `I4 half-order ratio ${i4half}`);
});

test('pitch tracks rpm and electric motor whine tracks motor speed', () => {
  const lo = render('gt3', 4000), hi = render('gt3', 8000);
  assert.ok(goertzel(hi, 400) > 2 * goertzel(hi, 200));
  assert.ok(goertzel(lo, 200) > 2 * goertzel(lo, 100));
  assert.ok(goertzel(lo, 200) > 20 * goertzel(lo, 260));
  const ev = render('ev', 9000);
  assert.ok(goertzel(ev, 9000 / 60 * 4) > 6 * goertzel(ev, 9000 / 60 * 4 * 1.2));
});
