// Sweep the baseline's grip factor per car: 3 laps each, report lap times.
import { buildTrack } from '../src/sim/track.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';
const track = buildTrack();
export function runBaseline(id, opts, laps = 3) {
  const sim = new Sim(track, CARS[id]);
  const drv = new BaselineDriver(track, CARS[id], opts);
  const out = []; let tmax = 0, crashed = false;
  sim.onLap = (t, valid) => out.push({ t, valid });
  while (sim.lap < laps && sim.time < 150 * laps) {
    sim.step(drv.control(sim.car));
    if (sim.car.wallContact > 0 || Math.abs(sim.car.headErr) > 1.5) { crashed = true; break; }
    for (let i = 0; i < 4; i++) tmax = Math.max(tmax, sim.car.tireT[i]);
  }
  return { laps: out, crashed, tmax, temps: [...sim.car.tireT], off: sim.offCount };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const id of CAR_ORDER) {
    const row = [];
    for (const grip of [0.75, 0.8, 0.85, 0.9, 0.95, 1.0]) {
      const r = runBaseline(id, { grip });
      row.push(`${grip}: ${r.crashed ? 'CRASH' : r.laps.map(l => l.t.toFixed(2) + (l.valid ? '' : '*')).join(' ')} T${r.tmax.toFixed(0)}`);
    }
    console.log(id.padEnd(8), row.join(' | '));
  }
}
