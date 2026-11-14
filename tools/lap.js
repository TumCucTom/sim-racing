// Run the scripted baseline for N laps with a given car and print lap times.
import { buildTrack } from '../src/sim/track.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';
const track = buildTrack();
const ids = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : CAR_ORDER;
const grip = +(process.argv[3] || 0.9);
for (const id of ids) {
  const sim = new Sim(track, CARS[id]);
  const drv = new BaselineDriver(track, CARS[id], { grip });
  const laps = []; let vmax = 0, maxD = 0, tmax = 0;
  sim.onLap = (t, valid) => laps.push(t.toFixed(3) + (valid ? '' : '*'));
  const t0 = performance.now(); let steps = 0;
  while (sim.lap < 3 && sim.time < 400) {
    sim.step(drv.control(sim.car)); steps++;
    vmax = Math.max(vmax, sim.car.vx); maxD = Math.max(maxD, Math.abs(sim.car.d));
    tmax = Math.max(tmax, ...sim.car.tireT);
  }
  const wall = (performance.now() - t0) / 1000;
  console.log(id.padEnd(8), 'laps', laps.join(' '), '| vmax', (vmax * 3.6).toFixed(0), 'km/h | max|d|', maxD.toFixed(2), '| tyreT', [...sim.car.tireT].map(v => v.toFixed(0)).join('/'), 'max', tmax.toFixed(0), '| off', sim.offCount, '|', (steps / wall / 1e6).toFixed(2), 'M steps/s');
}
