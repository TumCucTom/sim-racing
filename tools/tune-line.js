// For each car: which trail-braking fraction / grip is fastest while staying
// clean on every circuit? Prints a table used to set LINE_TUNE in baseline.js.
import { buildTrack, TRACK_ORDER } from '../src/sim/track.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';
function run(track, spec, opts) {
  const sim = new Sim(track, spec), drv = new BaselineDriver(track, spec, opts); let ok = true;
  sim.onLap = (t, v) => { if (!v) ok = false; };
  while (sim.lap < 3 && sim.time < 800) { sim.step(drv.control(sim.car)); if (sim.car.wallContact > 0 || Math.abs(sim.car.headErr) > 1.6) return null; }
  return ok && sim.lap === 3 ? sim.lastLap : null;
}
for (const id of (process.argv[2] ? process.argv[2].split(',') : CAR_ORDER)) {
  const spec = CARS[id]; let best = null;
  for (const trail of [0, 0.3, 0.6, 0.9]) for (const grip of [0.8, 0.86, 0.92, 0.97, 1.02]) {
    let tot = 0, ok = true;
    for (const tid of TRACK_ORDER.filter(x => x !== 'nordschleife' && x !== 'monaco')) { const t = buildTrack(tid); const r = run(t, spec, { grip, trail, line: t.line, brake: spec.abs ? 0.85 : 0.65 }); if (r === null) { ok = false; break; } tot += r; }
    if (ok && (!best || tot < best.tot)) best = { trail, grip, tot };
  }
  console.log(id.padEnd(8), JSON.stringify(best));
}
