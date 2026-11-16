// In-game AI (racing-line driver, shipped tuning) flying-lap time for every car on every circuit.
// Writes docs/ai-laps.json. '*' = lap outside track limits, CRASH/SPIN = did not finish.
import fs from 'node:fs';
import { buildTrack, TRACK_ORDER, TRACKS } from '../src/sim/track.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver, lineDriverOptions } from '../src/sim/drivers/baseline.js';
// node tools/ai-laps.js [circuit,circuit,...]   (a list re-runs only those and keeps the rest of the file)
const only = process.argv[2] ? process.argv[2].split(',') : null;
const out = only && fs.existsSync('docs/ai-laps.json') ? JSON.parse(fs.readFileSync('docs/ai-laps.json')) : {};
for (const tid of only || TRACK_ORDER) { const track = buildTrack(tid); out[tid] = { length: +track.length.toFixed(0) };
  for (const id of CAR_ORDER) { const spec = CARS[id], sim = new Sim(track, spec), drv = new BaselineDriver(track, spec, lineDriverOptions(track, spec));
    const laps = []; sim.onLap = (t, v) => laps.push({ t: +t.toFixed(2), valid: v }); let res = null;
    while (sim.lap < 2 && sim.time < 1500) { sim.step(drv.control(sim.car)); if (sim.car.wallContact > 0) { res = 'CRASH@' + sim.car.s.toFixed(0); break; } }
    out[tid][id] = res || (laps[1] ? laps[1].t + (laps[1].valid ? '' : '*') : 'DNF'); }
  console.log(tid, JSON.stringify(out[tid])); }
fs.writeFileSync('docs/ai-laps.json', JSON.stringify(out, null, 1));
