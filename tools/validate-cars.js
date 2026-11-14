// Measures each car's straight-line / skidpad performance in the sim and
// compares against the published envelope for its real-world class.
// Uses a flat, endless test surface so results are independent of the circuit.
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Vehicle, SIM_DT, peakPower } from '../src/sim/vehicle.js';
import fs from 'node:fs';

function flatTrack() {
  // Endless straight along +x, 2 km wide: reuse the Vehicle's track interface.
  const n = 40000;
  const z = new Float64Array(n);
  const x = new Float64Array(n), y = new Float64Array(n), s = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { x[i] = i - 2000; s[i] = i; } s[n] = n;
  const big = new Float64Array(n).fill(1e5);
  return { n, ds: 1, length: n, halfWidth: 1e4, kerbWidth: 0, x, y, z, grade: z, heading: z, curv: z, s, kerb: new Uint8Array(n), gravelL: new Uint8Array(n), gravelR: new Uint8Array(n), wallL: big, wallR: big };
}
const track = flatTrack();

export function measure(spec) {
  const out = {};
  const car = new Vehicle(spec, track);
  // 0-100, 0-200, quarter mile
  car.reset({ x: 0, y: 0, yaw: 0, speed: 0, idxHint: 2000 });
  let t = 0; out.t100 = null; out.t200 = null; out.quarter = null;
  while (t < 40) {
    car.step(SIM_DT, { steer: 0, throttle: 1, brake: 0 }); t += SIM_DT;
    if (out.t100 === null && car.vx >= 100 / 3.6) out.t100 = t;
    if (out.t200 === null && car.vx >= 200 / 3.6) out.t200 = t;
    if (out.quarter === null && car.x >= 402.3) out.quarter = t;
    if (out.t200 !== null && out.quarter !== null) break;
  }
  // top speed
  car.reset({ x: 0, y: 0, yaw: 0, speed: 60, idxHint: 2000 });
  let prev = 0;
  for (let i = 0; i < 300 * SIM_HZ_; i++) {
    car.step(SIM_DT, { steer: 0, throttle: 1, brake: 0 });
    if (car.x > 30000) car.x -= 20000, car.idx -= 20000;
    if (i % (10 * SIM_HZ_) === 0) { if (Math.abs(car.vx - prev) < 0.01) break; prev = car.vx; }
  }
  out.top = car.vx * 3.6;
  // braking 100-0 and 200-0. Cars without ABS are threshold-braked: the best
  // constant pedal position is found by search, as a skilled driver would.
  for (const v0 of [100, 200]) {
    if (v0 / 3.6 > out.top / 3.6) continue;
    let best = Infinity;
    for (const pedal of spec.abs ? [1] : [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 1]) {
      car.reset({ x: 0, y: 0, yaw: 0, speed: v0 / 3.6, idxHint: 2000 });
      for (let i = 0; i < 4; i++) car.tireT[i] = spec.tire.tOpt;
      for (let i = 0; i < 60; i++) car.step(SIM_DT, { steer: 0, throttle: 0.3, brake: 0 });
      const x0 = car.x; let tt = 0;
      while (car.vx > 0.1 && tt < 20) { car.step(SIM_DT, { steer: 0, throttle: 0, brake: pedal }); tt += SIM_DT; }
      best = Math.min(best, car.x - x0);
    }
    out['brake' + v0] = best;
  }
  // skidpad: steady-state max lateral g on a 60 m radius circle (ramp speed up
  // with a simple driver until the car can no longer hold the radius)
  const latAt = (Rad) => {
    car.reset({ x: 0, y: 0, yaw: 0, speed: 10, idxHint: 2000 });
    for (let i = 0; i < 4; i++) car.tireT[i] = spec.tire.tOpt;
    let best = 0, target = Math.sqrt(0.6 * 9.81 * Rad), steer = 0;
    car.vx = target; for (let i = 0; i < 4; i++) car.omega[i] = target / spec.wheelRadius;
    car.reset.call(car, { x: 0, y: 0, yaw: 0, speed: target, idxHint: 2000 });
    for (let i = 0; i < 4; i++) car.tireT[i] = spec.tire.tOpt;
    for (let i = 0; i < 120 * SIM_HZ_; i++) {
      target += SIM_DT * 0.35;
      const wantR = car.vx / Rad;
      steer += SIM_DT * 1.5 * (wantR - car.r);
      steer = Math.max(0, Math.min(1, steer));
      const thr = Math.max(0, Math.min(1, 0.4 * (target - car.vx)));
      car.step(SIM_DT, { steer, throttle: thr, brake: 0 });
      for (let k = 0; k < 4; k++) car.tireT[k] = spec.tire.tOpt;   // isolate grip from heat
      if (car.x > 30000 || car.x < -1000) { car.x = 0; car.idx = 2000; }
      if (i > 3 * SIM_HZ_) {
        const rad = car.speed / Math.max(1e-6, Math.abs(car.r));
        const g = Math.abs(car.ayF) / 9.81;
        if (rad < Rad * 1.05 && Math.abs(car.vy) < 0.12 * car.vx && g > best) best = g;
        if (rad > Rad * 1.4) break;
      }
    }
    return best;
  };
  out.latG = latAt(60);       // ~80-110 km/h: mostly mechanical grip
  out.latGFast = latAt(250);  // high speed: shows aero
  const pp = peakPower(spec);
  out.kw = pp.watts / 1000; out.hp = pp.watts / 745.7; out.powerRpm = pp.rpm;
  out.kgPerHp = spec.mass / out.hp;
  return out;
}
const SIM_HZ_ = Math.round(1 / SIM_DT);

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  let allOk = true;
  for (const id of CAR_ORDER) {
    const spec = CARS[id], m = measure(spec), ref = spec.reference;
    const chk = (v, [lo, hi]) => (v >= lo && v <= hi ? 'ok' : 'OUT');
    const r = {
      car: spec.name, hp: m.hp.toFixed(0), kg: spec.mass,
      '0-100 s': `${m.t100.toFixed(2)} [${ref.zeroTo100}] ${chk(m.t100, ref.zeroTo100)}`,
      '0-200 s': m.t200 ? m.t200.toFixed(2) : '-',
      '1/4 mi s': m.quarter?.toFixed(2),
      '100-0 m': `${m.brake100.toFixed(1)} [${ref.brake100}] ${chk(m.brake100, ref.brake100)}`,
      '200-0 m': m.brake200?.toFixed(1),
      'lat g (R60)': `${m.latG.toFixed(2)} [${ref.latG}] ${chk(m.latG, ref.latG)}`,
      'lat g (R250)': m.latGFast.toFixed(2),
      'top km/h': `${m.top.toFixed(0)} [${ref.topKmh}] ${chk(m.top, ref.topKmh)}`,
    };
    if (JSON.stringify(r).includes('OUT')) allOk = false;
    rows.push(r);
  }
  console.table(rows);
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/car-validation.json', JSON.stringify(rows, null, 2));
  console.log(allOk ? 'ALL WITHIN REFERENCE ENVELOPE' : 'SOME METRICS OUTSIDE ENVELOPE');
}
