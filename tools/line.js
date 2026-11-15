// Racing-line driver sweep: lap times per car / track / grip, vs centre line.
import { buildTrack, TRACK_ORDER } from '../src/sim/track.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';
const tracks = process.argv[2] ? process.argv[2].split(',') : TRACK_ORDER, cars = process.argv[3] ? process.argv[3].split(',') : CAR_ORDER;
const grips = (process.argv[4] || '0.9,0.95,1.0').split(',').map(Number), trail = process.argv[5] !== 'notrail';
export function lapWith(track, spec, opts, laps = 3) {
  const sim = new Sim(track, spec), drv = new BaselineDriver(track, spec, opts); const out = [];
  sim.onLap = (t, v) => out.push(t.toFixed(2) + (v ? '' : '*'));
  while (sim.lap < laps && sim.time < 260 * laps) { sim.step(drv.control(sim.car)); if (sim.car.wallContact > 0) return 'CRASH@' + sim.car.s.toFixed(0); if (Math.abs(sim.car.headErr) > 1.6) return 'SPIN@' + sim.car.s.toFixed(0); }
  return out.slice(1).join(' ');
}
for (const tid of tracks) { const t0 = performance.now(), track = buildTrack(tid); let mx = 0; for (let i = 0; i < track.n; i++) mx = Math.max(mx, Math.abs(track.lineD[i]));
  console.log(`${tid}: line ${track.line.length.toFixed(0)} m vs centre ${track.length.toFixed(0)} m, max offset ${mx.toFixed(1)} m, built in ${(performance.now() - t0).toFixed(0)} ms`);
  for (const id of cars) { const spec = CARS[id];
    console.log('  ' + id.padEnd(8), 'centre 0.9:', lapWith(track, spec, { grip: 0.9 }, 2), '| line', grips.map(g => `${g}: ${lapWith(track, spec, { grip: g, line: track.line, trail, brake: spec.abs ? 0.85 : 0.65 })}`).join(' | ')); } }
