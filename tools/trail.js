// How much does each driver trail-brake? Share of braking time (pedal > 20 %)
// spent with more than 0.5 g of lateral load, plus peak combined g while braking.
import fs from 'node:fs';
import { buildTrack } from '../src/sim/track.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver, lineDriverOptions } from '../src/sim/drivers/baseline.js';
import { PolicyDriver } from '../src/sim/drivers/policy-driver.js';
const track = buildTrack(process.argv[2] || 'ravenscar');
function measure(spec, make) {
  const sim = new Sim(track, spec), d = make(); let brk = 0, trail = 0, deep = 0;
  while (sim.lap < 2 && sim.time < 900) { sim.step(d.control(sim.car)); const c = sim.car;
    if (sim.lap === 1 && c.brake > 0.2) { brk++; const lat = Math.abs(c.ayF) / 9.81 / (spec.tire.muY * 0.86 * (1 + 0.6 * spec.ClA * c.speed * c.speed / (spec.mass * 9.81))); if (lat > 0.4) trail++; if (lat > 0.7) deep++; } }
  return `${sim.lastLap?.toFixed(2)} s, braking ${(brk / 300).toFixed(1)} s of which ${(100 * trail / Math.max(1, brk)).toFixed(0)} % above 40 % of cornering grip, ${(100 * deep / Math.max(1, brk)).toFixed(0)} % above 70 %`;
}
for (const id of CAR_ORDER) {
  const spec = CARS[id];
  console.log(id.padEnd(8), 'centre-line:', measure(spec, () => new BaselineDriver(track, spec, { grip: 0.9 })));
  console.log(' '.repeat(8), 'racing line:', measure(spec, () => new BaselineDriver(track, spec, lineDriverOptions(track, spec))));
  if (id === 'gt3' && track.id === 'ravenscar') { const pol = JSON.parse(fs.readFileSync('src/policies/gt3.json')); console.log(' '.repeat(8), 'RL policy:  ', measure(spec, () => new PolicyDriver(track, pol))); }
}
