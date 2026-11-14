import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack, project, nearestIndexGlobal, poseAt } from '../src/sim/track.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { Vehicle, SIM_DT } from '../src/sim/vehicle.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';
import { measure } from '../tools/validate-cars.js';

const track = buildTrack();

test('track is closed, smooth and does not self-intersect', () => {
  assert.ok(track.length > 2500 && track.length < 4000);
  const i = track.n - 1;
  assert.ok(Math.hypot(track.x[0] - track.x[i], track.y[0] - track.y[i]) < 1.5 * track.ds);
  let maxK = 0;
  for (let k = 0; k < track.n; k++) maxK = Math.max(maxK, Math.abs(track.curv[k]));
  assert.ok(1 / maxK > 20, 'tightest corner radius > 20 m');
  for (let a = 0; a < track.n; a += 5) for (let b = a + 100; b < track.n; b += 5) {
    if (track.n - (b - a) < 100) continue;
    assert.ok(Math.hypot(track.x[a] - track.x[b], track.y[a] - track.y[b]) > 45);
  }
});

test('projection recovers arc length and lateral offset', () => {
  const out = {};
  for (const [s, d] of [[10, 0], [500, 3], [1234.5, -4], [2800, 5.5]]) {
    const p = poseAt(track, s, d);
    project(track, p.x, p.y, nearestIndexGlobal(track, p.x, p.y), out);
    assert.ok(Math.abs(out.d - d) < 0.25, `d ${out.d} vs ${d}`);
    assert.ok(Math.abs(out.s - s) < 1.5, `s ${out.s} vs ${s}`);
  }
});

test('simulation is bit-for-bit deterministic', () => {
  const run = () => {
    const sim = new Sim(track, CARS.gt3);
    const drv = new BaselineDriver(track, CARS.gt3, { grip: 0.9 });
    for (let i = 0; i < 300 * 40; i++) sim.step(drv.control(sim.car));
    return sim.car.snapshot();
  };
  assert.deepEqual(run(), run());
});

test('car at rest stays at rest and state stays finite', () => {
  const sim = new Sim(track, CARS.coupe);
  for (let i = 0; i < 300 * 5; i++) sim.step({ steer: 0, throttle: 0, brake: 1 });
  assert.ok(sim.car.speed < 0.05);
  for (const v of sim.car.snapshot()) assert.ok(Number.isFinite(v));
});

test('full-lock, full-throttle abuse never produces NaN', () => {
  for (const id of CAR_ORDER) {
    const sim = new Sim(track, CARS[id]);
    for (let i = 0; i < 300 * 30; i++) {
      const ph = Math.floor(i / 450) % 4;
      sim.step({ steer: ph < 2 ? 1 : -1, throttle: ph % 2 ? 0 : 1, brake: ph % 2 ? 1 : 0 });
    }
    for (const v of sim.car.snapshot()) assert.ok(Number.isFinite(v), id);
  }
});

test('every car meets its real-world reference envelope', () => {
  for (const id of CAR_ORDER) {
    const m = measure(CARS[id]), r = CARS[id].reference;
    const within = (v, [lo, hi], what) => assert.ok(v >= lo && v <= hi, `${id} ${what} = ${v.toFixed(2)} not in [${lo}, ${hi}]`);
    within(m.t100, r.zeroTo100, '0-100 s');
    within(m.brake100, r.brake100, '100-0 m');
    within(m.latG, r.latG, 'lateral g');
    within(m.top, r.topKmh, 'top speed km/h');
  }
});

test('class hierarchy: formula < GT3 < road cars on lap time', () => {
  const lap = (id) => {
    const sim = new Sim(track, CARS[id]);
    const drv = new BaselineDriver(track, CARS[id], { grip: 0.85 });
    while (sim.lap < 2 && sim.time < 300) sim.step(drv.control(sim.car));
    return sim.lastLap;
  };
  const f = lap('formula'), g = lap('gt3'), h = lap('hatch'), c = lap('coupe'), e = lap('ev');
  assert.ok(f < g && g < e && g < h && g < c, `${f} ${g} ${e} ${h} ${c}`);
});

test('lap timer: lap time equals sum of sectors and matches sim clock', () => {
  const sim = new Sim(track, CARS.gt3);
  const drv = new BaselineDriver(track, CARS.gt3, { grip: 0.85 });
  const laps = [];
  sim.onLap = (t, valid, sectors) => laps.push({ t, valid, sectors, at: sim.time });
  while (sim.lap < 2 && sim.time < 300) sim.step(drv.control(sim.car));
  assert.equal(laps.length, 2);
  for (const l of laps) {
    assert.ok(l.valid);
    assert.ok(Math.abs(l.sectors[0] + l.sectors[1] + l.sectors[2] - l.t) < 1e-6);
  }
  assert.ok(Math.abs(laps[1].at - laps[0].at - laps[1].t) < 2 * SIM_DT);
});

test('driving off the circuit invalidates the lap', () => {
  const sim = new Sim(track, CARS.gt3);
  sim.reset({ s: 100, d: 0, speed: 30 });
  for (let i = 0; i < 300 * 3; i++) sim.step({ steer: 0.25, throttle: 0.3, brake: 0 });
  assert.equal(sim.lapValid, false);
  assert.ok(sim.offCount >= 1);
});

test('walls contain the car', () => {
  const sim = new Sim(track, CARS.formula);
  sim.reset({ s: 300, d: 0, speed: 80 });
  for (let i = 0; i < 300 * 20; i++) {
    sim.step({ steer: 0.1, throttle: 1, brake: 0 });
    const lim = sim.car.d > 0 ? track.wallL[sim.car.idx] : track.wallR[sim.car.idx];
    assert.ok(Math.abs(sim.car.d) <= lim + 0.5);
  }
});
