// Where does a policy fail? Runs deterministic grid starts and prints the
// failure location / state for each seed.
import fs from 'node:fs';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { RaceEnv } from '../rl/env.js';
import { PolicyDriver } from '../src/sim/drivers/policy-driver.js';
const track = buildTrack();
const file = process.argv[2], pol = JSON.parse(fs.readFileSync(file));
const spec = CARS[pol.carId || process.argv[3] || 'gt3'];
for (const seed of [9001, 9002, 9003, 1, 2, 3]) {
  const env = new RaceEnv(track, spec); env.resetGrid(seed);
  const sim = env.sim, car = sim.car, drv = new PolicyDriver(track, pol);
  const laps = []; sim.onLap = (t, v) => laps.push(t.toFixed(2) + (v ? '' : '*'));
  let why = 'ok', firstOff = null;
  while (sim.lap < 2 && sim.time < 300) {
    sim.step(drv.control(car));
    if (sim.offTrack && firstOff === null) firstOff = `s=${car.s.toFixed(0)} v=${(car.vx * 3.6).toFixed(0)}km/h t=${sim.time.toFixed(1)}`;
    if (car.wallContact > 0) { why = 'crash'; break; }
    if (Math.abs(car.headErr) > 1.6) { why = 'spin'; break; }
  }
  console.log(`seed ${seed}: ${why} at s=${car.s.toFixed(0)} t=${sim.time.toFixed(1)} v=${(car.vx * 3.6).toFixed(0)} laps [${laps}] firstOff ${firstOff}`);
}
