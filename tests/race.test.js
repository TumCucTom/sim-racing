import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildTrack, TRACK_ORDER, poseAt } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver, lineDriverOptions } from '../src/sim/drivers/baseline.js';
import { Race, overlapDepth, gridSlot } from '../src/sim/race.js';
import { RaceDriver, buildField } from '../src/sim/drivers/racecraft.js';

const track = buildTrack('ravenscar'), gt3 = CARS.gt3;
const COAST = { steer: 0, throttle: 0, brake: 0 };

// sha256 over the car state once a second and at the end of a 150 s GT3 run at Ravenscar
function soloHash(step, car, sim) {
  const h = crypto.createHash('sha256'), f = new Float64Array(1), add = (v) => { f[0] = v; h.update(Buffer.from(f.buffer.slice(0))); };
  for (let i = 0; i < 300 * 150; i++) { step(); if (i % 300 === 0) for (const v of car.snapshot()) add(v); }
  for (const v of [...car.snapshot(), sim.lastLap, sim.bestLap, sim.lap, sim.progress]) add(v);
  return h.digest('hex');
}

test('solo Sim is bit-identical to the build before race mode existed', () => {
  // Recorded from the code as it was before src/sim/race.js and the Vehicle.dragK / downK hooks were
  // added. If the vehicle or track model is changed on purpose, this value has to be re-recorded.
  const BEFORE = '7ad4f827b9bb55014b2558d6198f05406d45ddfc0e560f76ade8eac7629e4825';
  const sim = new Sim(track, gt3), drv = new BaselineDriver(track, gt3, lineDriverOptions(track, gt3));
  assert.equal(soloHash(() => sim.step(drv.control(sim.car)), sim.car, sim), BEFORE);
  assert.equal(sim.car.dragK, 1); assert.equal(sim.car.downK, 1);
});

test('a one-car Race is the solo Sim (collision and slipstream stages change nothing)', () => {
  const sim = new Sim(track, gt3), drv = new BaselineDriver(track, gt3, lineDriverOptions(track, gt3));
  const d2 = new BaselineDriver(track, gt3, lineDriverOptions(track, gt3));
  const race = new Race(track, [{ spec: gt3, driver: { control: (c) => d2.control(c.car) } }], { lights: false, laps: 99 });
  // same grid slot as the race gives its pole car
  const g = gridSlot(track, 0); sim.reset({ s: g.s, d: g.d });
  for (let i = 0; i < 300 * 70; i++) { sim.step(drv.control(sim.car)); race.step(); }
  assert.deepEqual(race.cars[0].car.snapshot(), sim.car.snapshot());
  assert.equal(race.cars[0].sim.lastLap, sim.lastLap);
});

test('RaceDriver in free air is exactly the racing-line BaselineDriver', () => {
  const a = new Sim(track, gt3), b = new Sim(track, gt3);
  const base = new BaselineDriver(track, gt3, lineDriverOptions(track, gt3));
  const rd = new RaceDriver(track, gt3, { personality: { skill: 1, aggression: 0.5, consistency: 1, mistake: 0, reaction: 0 } });
  const rc = { car: b.car, index: 0 };
  for (let i = 0; i < 300 * 70; i++) { a.step(base.control(a.car)); b.step(rd.control(rc, null)); }
  assert.deepEqual(b.car.snapshot(), a.car.snapshot());
});

function field(n, seed, opts = {}) { return buildField(track, { n, car: 'gt3', klass: 'class', seed, aiPlayer: true, ...opts }); }

test('a seeded 8-car race is deterministic; another seed gives another race', () => {
  const run = (seed) => { const r = new Race(track, field(8, seed), { laps: 2, seed }); for (let i = 0; i < 300 * 45; i++) r.step(); return r; };
  const a = run(5), b = run(5), c = run(6);
  assert.equal(a.hash(), b.hash());
  assert.notEqual(a.hash(), c.hash());
  assert.ok(a.green && a.raceTime > 30);
  for (const car of a.cars) for (const v of car.car.snapshot()) assert.ok(Number.isFinite(v));
});

// two driver-less cars placed by hand
function pair(specA = gt3, specB = gt3) {
  const race = new Race(track, [{ spec: specA }, { spec: specB }], { lights: false });
  const place = (c, s, d, speed, dyaw = 0, vy = 0, r = 0) => {
    const p = poseAt(track, s, d); c.car.reset({ x: p.x, y: p.y, yaw: p.heading + dyaw, speed, idxHint: p.idx }); c.car.vy = vy; c.car.r = r; c.sim.prevS = c.car.s;
  };
  return { race, A: race.cars[0], B: race.cars[1], place };
}
function angular(race) {
  let L = 0;
  for (const c of race.cars) { const a = c.car, cy = Math.cos(a.yaw), sy = Math.sin(a.yaw), m = c.spec.mass; L += m * (a.x * (a.vx * sy + a.vy * cy) - a.y * (a.vx * cy - a.vy * sy)) + a.Iz * a.r; }
  return L;
}

test('collision impulse conserves linear and angular momentum and never adds energy', () => {
  for (const [mA, mB] of [[gt3, gt3], [CARS.lmp1, CARS.mini]]) {
    const len = (mA.body.length + mB.body.length) / 2, wid = (mA.body.width + mB.body.width) / 2;
    const cases = [
      // [sA, dA, vA, yawA, sB, dB, vB, yawB]  (B ahead of A)
      [100, 0, 60, 0, 100 + len - 0.3, 0, 40, 0],                  // rear-end
      [100, 0, 60, 0, 100 + len - 0.4, 1.4, 45, 0],                // offset rear-end: spins both
      [100, 0, 50, 0.08, 101.5, wid - 0.15, 50, -0.06],            // side-swipe, converging
      [100, -0.5, 70, 0.3, 103.0, 1.0, 20, -0.9],                  // T-bone-ish
      [100, 0, 83, 0, 100 + len - 0.25, 0.3, 0, 0],                // 300 km/h into a parked car
    ];
    for (const c of cases) {
    const { race, A, B, place } = pair(mA, mB);
    place(A, c[0], c[1], c[2], c[3], 0.4, 0.2); place(B, c[4], c[5], c[6], c[7], -0.3, -0.1);
    assert.ok(overlapDepth(A, B) > 0, 'test case must start in contact');
    const p0 = race.momentum(), L0 = angular(race);
    // position correction moves the bodies, so take angular momentum about the same points
    const xa = A.car.x, ya = A.car.y, xb = B.car.x, yb = B.car.y;
    race._collide();
    const [nxa, nya, nxb, nyb] = [A.car.x, A.car.y, B.car.x, B.car.y];
    A.car.x = xa; A.car.y = ya; B.car.x = xb; B.car.y = yb;
    const p1 = race.momentum(), L1 = angular(race);
    A.car.x = nxa; A.car.y = nya; B.car.x = nxb; B.car.y = nyb;
    const scale = Math.hypot(p0.px, p0.py) + 1;
    assert.ok(Math.abs(p1.px - p0.px) < 1e-9 * scale && Math.abs(p1.py - p0.py) < 1e-9 * scale, 'linear momentum');
    assert.ok(Math.abs(L1 - L0) < 1e-9 * (Math.abs(L0) + 1e6), `angular momentum ${L0} -> ${L1}`);
    assert.ok(p1.ke <= p0.ke * (1 + 1e-12), `energy ${p0.ke} -> ${p1.ke}`);
    assert.equal(race.events.length, 1);
  } }
  // an off-centre hit must change the yaw rates, in opposite senses about the contact
  const { race, A, B, place } = pair();
  place(A, 100, 0, 60); place(B, 104.0, 1.4, 45);
  race._collide();
  assert.ok(Math.abs(A.car.r) > 0.05 && Math.abs(B.car.r) > 0.05);
});

test('contact: no tunnelling at 300 km/h closing speed, no overlap left, no energy gain, no sticking', () => {
  for (const [dv, d] of [[83.3, 0], [83.3, 0.9], [40, 0], [12, 1.6], [3, 0]]) {
    const { race, A, B, place } = pair();
    place(A, 100, 0, 20 + dv); place(B, 100 + 4.6 + Math.min(40, dv * 1.2), d, 20);     // they meet after about a second
    // (the impulse stage itself is checked above; over whole steps the chassis also trades energy with
    // the wheels and engine, which momentum() does not count, so only the totals are compared here)
    const ke0 = race.momentum().ke; let worst = 0, run = 0, touched = false, keTouch = 0;
    for (let i = 0; i < 300 * 4; i++) {
      race.step(COAST);
      if (race.events.length && !touched) keTouch = race.momentum().ke;
      if (race.events.length) touched = true;
      // a fresh impact may bite in by up to closing speed x dt; it must be pushed out within a few steps
      if (overlapDepth(A, B) > 0.03) { run++; worst = Math.max(worst, run); } else run = 0;
      // never through each other: A's centre stays behind B's along the track while they are in line
      if (Math.abs(A.car.d - B.car.d) < 1.2 && Math.abs(A.car.headErr) < 0.5 && Math.abs(B.car.headErr) < 0.5) assert.ok(A.car.s < B.car.s, `tunnelled at dv ${dv}`);
    }
    assert.ok(touched, `no contact detected at dv ${dv}`);
    assert.ok(keTouch < ke0 && race.momentum().ke < ke0, 'the field must not come out of a crash with more energy');
    assert.ok(worst <= 10, `bodies stayed overlapped for ${worst} steps at dv ${dv}`);
    assert.ok(overlapDepth(A, B) < 0.03);
    for (const c of race.cars) for (const v of c.car.snapshot()) assert.ok(Number.isFinite(v));
  }
  // resting / pushing contact must not jitter apart or stick: a car pushing another under power
  const { race, A, B, place } = pair();
  place(A, 100, 0, 15); place(B, 104.6, 0, 15);
  for (let i = 0; i < 300 * 3; i++) { race.cars[0].car.aids.tc = true; race.step(COAST); }
  assert.ok(overlapDepth(A, B) < 0.03);
  assert.ok(Math.abs(A.car.r) < 0.5 && Math.abs(B.car.r) < 0.5);
});

test('slipstream: reduced drag and a little less downforce in a wake, exactly 1 in free air', () => {
  const { race, A, B, place } = pair();
  place(A, 100, 0, 60); place(B, 112, 0, 60);     // A is 12 m behind B
  race._aero();
  assert.ok(A.car.dragK < 0.75 && A.car.dragK > 0.45, `dragK ${A.car.dragK}`);
  assert.ok(A.car.downK < 1 && A.car.downK > 0.85);
  assert.equal(B.car.dragK, 1); assert.equal(B.car.downK, 1);
  place(A, 100, 5.5, 60); race._aero();           // out of the wake sideways: almost nothing
  assert.ok(A.car.dragK > 0.97);
  place(B, 400, 0, 60); race._aero();             // far behind: nothing at all
  assert.equal(A.car.dragK, 1);
  // strength falls with distance
  let last = 0;
  place(B, 112, 0, 60);
  for (const gap of [70, 40, 20, 8]) { place(A, 112 - gap, 0, 60); race._aero(); assert.ok(A.wake > last); last = A.wake; }
});

test('the grid has no overlap and is on the road, on every circuit, for 20 cars', () => {
  for (const id of TRACK_ORDER) {
    const t = buildTrack(id);
    const race = new Race(t, Array.from({ length: 20 }, () => ({ spec: gt3 })), {});
    for (let i = 0; i < 20; i++) {
      const c = race.cars[i];
      assert.ok(Math.abs(c.car.d) + c.hw < t.hw[c.car.idx], `${id}: slot ${i} is off the road`);
      for (let j = i + 1; j < 20; j++) assert.ok(overlapDepth(c, race.cars[j]) < -0.5, `${id}: slots ${i} and ${j} overlap`);
    }
    // behind the line, pole nearest to it
    for (let i = 1; i < 20; i++) assert.ok(race.cars[i].dist < race.cars[i - 1].dist && race.cars[i].dist < 0);
    // and nobody moves before the lights go out
    for (let i = 0; i < 300 * 2; i++) race.step({ steer: 0, throttle: 1, brake: 0 });
    assert.ok(!race.green && race.lightsOn === 1);
    for (const c of race.cars) assert.ok(c.car.speed < 0.2, `${id}: creeping on the grid`);
  }
});

test('start lights, positions, gaps and intervals', () => {
  // three cars at fixed, different throttle: the order is known
  const thr = [1.0, 0.6, 0.35];
  const mk = (k) => ({ spec: gt3, driver: { control: (c) => ({ steer: -c.car.d * 0.05 - c.car.headErr * 1.2, throttle: c.car.vx < 46 - 8 * k ? thr[k] : 0, brake: 0 }) } });
  const race = new Race(track, [mk(0), mk(1), mk(2)], { seed: 3, laps: 5 });
  assert.equal(race.green, false);
  const seen = new Set();
  while (!race.green) { race.step(); seen.add(race.lightsOn); assert.ok(race.time < 9); }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5]);
  assert.ok(race.greenTime > 5.6 && race.greenTime < 7.5);
  for (let i = 0; i < 300 * 12; i++) race.step();
  const [c, b, a] = race.cars;       // c leads
  assert.ok(c.dist > b.dist && b.dist > a.dist);
  assert.deepEqual([c.pos, b.pos, a.pos], [1, 2, 3]);
  assert.deepEqual(race.order, [0, 1, 2]);
  assert.equal(c.gapLeader, 0);
  // gap = how long ago the car ahead was where I am: distance / my speed, roughly
  const expect = (c.dist - b.dist) / 38;
  assert.ok(Math.abs(b.gapLeader - expect) < 0.35 * expect + 0.1, `gap ${b.gapLeader} vs ~${expect}`);
  assert.ok(a.gapLeader > b.gapLeader && a.interval > 0 && a.interval < a.gapLeader && Math.abs(b.interval - b.gapLeader) < 1e-9);
  assert.equal(race.overtakes, 0);   // the start shuffle does not count
});

test('a short race finishes: every car classified, laps and order consistent', () => {
  const race = new Race(track, field(6, 11), { laps: 2, seed: 11 });
  let guard = 0; while (!race.over && guard++ < 300 * 400) race.step();
  assert.ok(race.over, 'race did not finish');
  const cls = race.classification();
  assert.equal(cls.length, 6);
  assert.ok(cls[0].finished && cls[0].laps === 2);
  for (let i = 1; i < cls.length; i++) {
    const p = cls[i - 1], q = cls[i];
    assert.ok(!q.finished || (p.finished && (p.laps > q.laps || p.time <= q.time)));
  }
  const fin = cls.filter(r => r.finished);
  assert.ok(fin.length >= 5, 'at most one car fails to finish a two-lap race');
  for (const r of fin) { assert.ok(r.bestLap > 55 && r.bestLap < 80, `best lap ${r.bestLap}`); assert.equal(r.lapTimes.length, r.laps); }
  assert.ok(Math.abs(cls[0].time - (race.leaderFinishTime + cls[0].penalty)) < 1e-9);
});

test('a car facing the wrong way is put back on the road; track-limit strikes become a time penalty', () => {
  const { race, A, B, place } = pair();
  A.driver = { control: () => ({ steer: 0, throttle: 0, brake: 1 }) }; B.driver = { control: (c) => ({ steer: -c.car.headErr, throttle: 0.4, brake: 0 }) };
  place(A, 300, 2, 0, Math.PI); place(B, 500, 0, 30);
  race.raceTime = 10; race.greenTime = -10;
  for (let i = 0; i < 300 * 8 && A.respawns === 0; i++) race.step();
  assert.equal(A.respawns, 1);
  assert.ok(Math.abs(A.car.headErr) < 0.2 && A.car.vx > 5 && Math.abs(A.car.d) < track.hw[A.car.idx]);
  // three excursions with all four wheels off = 5 s
  for (let k = 0; k < 3; k++) { A.sim.offCount++; race.time += 5; race._watch(A); }
  assert.equal(A.strikes, 3); assert.equal(A.penalty, 5);
});
