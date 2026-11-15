// Racing-line driver: dry vs wet flying laps (and a bit-exact state signature for the dry run).
//   node tools/wet-laps.js [tracks=ravenscar,spa] [cars=gt3,mini] [wx=rain,storm]
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver, lineDriverOptions } from '../src/sim/drivers/baseline.js';
let wetFor = () => null;
try { ({ wetFor } = await import('../src/sim/wet.js')); } catch { /* before the wet model existed */ }
const [tracks = 'ravenscar,spa', cars = 'gt3,mini', wxs = 'rain,storm'] = process.argv.slice(2);
function run(track, spec, wet) {
  const sim = new Sim(track, spec); if (wet) sim.setWet(wet);
  const drv = new BaselineDriver(track, spec, { ...lineDriverOptions(track, spec), wet });
  const laps = []; sim.onLap = (t, v) => laps.push(t.toFixed(2) + (v ? '' : '*')); let res = '';
  let sig = 0;
  while (sim.lap < 2 && sim.time < 1500) { sim.step(drv.control(sim.car)); if (sim.car.wallContact > 0) { res = ' CRASH@' + sim.car.s.toFixed(0); break; } }
  const c = sim.car; const f = new Float64Array([c.x, c.y, c.yaw, c.vx, c.vy, c.r, sim.time]); const u = new Uint32Array(f.buffer); for (const w of u) sig = (Math.imul(sig, 31) + w) >>> 0;
  return { laps: laps.join(' ') + res, off: sim.offCount, sig: sig.toString(16) };
}
for (const tid of tracks.split(',')) { const track = buildTrack(tid);
  for (const id of cars.split(',')) { const spec = CARS[id];
    const dry = run(track, spec, null); console.log(tid, id, 'dry  ', dry.laps, 'off', dry.off, 'sig', dry.sig);
    for (const wx of wxs.split(',')) { const w = wetFor(wx); if (!w) continue; const r = run(track, spec, w); console.log(tid, id, wx.padEnd(5), r.laps, 'off', r.off, `(grip ${w.grip})`); }
  } }
