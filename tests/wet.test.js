// Wet-track model: the dry default must stay bit-identical, wet must cost grip, and the
// racing-line driver must still lap cleanly with its wet speed profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver, lineDriverOptions } from '../src/sim/drivers/baseline.js';
import { WET, wetFor, wetMu, puddleDepth } from '../src/sim/wet.js';
import { SURF } from '../src/sim/track.js';

const track = buildTrack('ravenscar');
function lap(spec, wet, laps = 2) {
  const sim = new Sim(track, spec); sim.setWet(wet);
  const drv = new BaselineDriver(track, spec, { ...lineDriverOptions(track, spec), wet });
  const times = []; sim.onLap = (t, v) => times.push({ t, v }); let crash = false;
  while (sim.lap < laps && sim.time < 400) { sim.step(drv.control(sim.car)); if (sim.car.wallContact > 0) { crash = true; break; } }
  return { times, crash, car: sim.car, off: sim.offCount };
}

test('dry default: setWet(null) and an untouched sim give the same state, bit for bit', () => {
  const a = new Sim(track, CARS.gt3), b = new Sim(track, CARS.gt3); b.setWet(null);
  const da = new BaselineDriver(track, CARS.gt3, lineDriverOptions(track, CARS.gt3));
  const db = new BaselineDriver(track, CARS.gt3, { ...lineDriverOptions(track, CARS.gt3), wet: null });
  for (let i = 0; i < 6000; i++) { a.step(da.control(a.car)); b.step(db.control(b.car)); }
  for (const k of ['x', 'y', 'yaw', 'vx', 'vy', 'r']) assert.equal(a.car[k], b.car[k], k);
  assert.equal(a.car.wet, null);
});

test('wet model: conditions map to states, grip falls, puddles sit at the edges', () => {
  assert.equal(wetFor('clear'), null); assert.equal(wetFor('golden'), null); assert.equal(wetFor('dusk'), null);
  assert.equal(wetFor('rain'), WET.rain); assert.equal(wetFor('storm'), WET.storm); assert.equal(wetFor('overcast'), WET.damp);
  const mid = wetMu(WET.rain, SURF.ASPHALT, 100, 0, 6, 0);
  assert.ok(mid > 0.7 && mid < 0.8, `rain grip ${mid}`);
  assert.ok(wetMu(WET.storm, SURF.ASPHALT, 100, 0, 6, 0) < mid);
  assert.ok(wetMu(WET.rain, SURF.KERB, 100, 6.3, 6, 0) < mid);
  // damp track: the dried line grips better than the rest
  assert.ok(wetMu(WET.damp, SURF.ASPHALT, 100, 2, 6, 2) > wetMu(WET.damp, SURF.ASPHALT, 100, -3, 6, 2) + 0.05);
  let edge = 0, centre = 0;
  for (let s = 0; s < 3000; s += 7) { edge = Math.max(edge, puddleDepth(s, 5.6, 6)); centre = Math.max(centre, puddleDepth(s, 0, 6)); }
  assert.ok(edge > 0.9 && centre === 0, `puddles: edge ${edge}, centre ${centre}`);
});

test('racing-line driver laps cleanly in rain and storm, slower than in the dry', () => {
  for (const id of ['gt3', 'mini']) {
    const dry = lap(CARS[id], null), rain = lap(CARS[id], WET.rain), storm = lap(CARS[id], WET.storm);
    for (const [n, r] of [['dry', dry], ['rain', rain], ['storm', storm]]) assert.ok(!r.crash && r.times.length === 2 && r.times[1].v, `${id} ${n}: clean flying lap`);
    const k = rain.times[1].t / dry.times[1].t;
    assert.ok(k > 1.08 && k < 1.3, `${id}: rain lap ${rain.times[1].t.toFixed(2)} vs dry ${dry.times[1].t.toFixed(2)}`);
    assert.ok(storm.times[1].t > rain.times[1].t, `${id}: storm slower than rain`);
  }
});

test('every GT3 car laps Ravenscar cleanly in the dry and in rain, inside a tight class window', () => {
  const ids = ['gt3', 'r8lms', 'huracan', 'amggt3', 'f296gt3', 'mc720s'], dryT = [];
  for (const id of ids) {
    const dry = lap(CARS[id], null), rain = lap(CARS[id], WET.rain);
    for (const [n, r] of [['dry', dry], ['rain', rain]]) assert.ok(!r.crash && r.times.length === 2 && r.times[1].v, `${id} ${n}: clean flying lap`);
    assert.ok(rain.times[1].t > dry.times[1].t * 1.08, `${id}: rain slower than dry`);
    dryT.push(dry.times[1].t);
  }
  // balance of performance: the class stays within 1.5 % of the benchmark car
  for (let i = 1; i < ids.length; i++) assert.ok(Math.abs(dryT[i] / dryT[0] - 1) < 0.015, `${ids[i]}: ${dryT[i].toFixed(2)} vs gt3 ${dryT[0].toFixed(2)}`);
});
