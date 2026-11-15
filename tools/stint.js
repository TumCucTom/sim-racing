// Long-run reliability: how many consecutive clean laps does each policy manage?
import fs from 'node:fs';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { RaceEnv } from '../rl/env.js';
import { PolicyDriver } from '../src/sim/drivers/policy-driver.js';
const track = buildTrack(), LAPS = +(process.argv[2] || 8);
for (const d of fs.readdirSync('rl/runs').filter(n => /^gt3_s\d+$/.test(n))) {
  const pol = JSON.parse(fs.readFileSync(`rl/runs/${d}/policy.json`)); const out = [];
  for (const seed of [9101, 9102, 9103, 9104, 9105]) {
    const env = new RaceEnv(track, CARS.gt3); env.resetGrid(seed); const sim = env.sim, car = sim.car, drv = new PolicyDriver(track, pol);
    let clean = 0, why = 'ok'; const laps = []; sim.onLap = (t, v) => { laps.push(t.toFixed(1) + (v ? '' : '*')); if (v) clean++; };
    while (sim.lap < LAPS && sim.time < 90 * LAPS) { sim.step(drv.control(car)); if (car.wallContact > 0) { why = `wall@${car.s.toFixed(0)} lap${sim.lap + 1}`; break; } }
    out.push(`${clean}/${LAPS} ${why} T${Math.max(...car.tireT).toFixed(0)} [${laps.join(' ')}]`);
  }
  console.log(d, '\n  ' + out.join('\n  '));
}
