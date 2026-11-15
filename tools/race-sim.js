// Headless AI races (no browser): runs full races in Node and prints what happened.
//   node tools/race-sim.js [--track spa] [--n 12] [--laps 5] [--car gt3] [--klass class|same|mixed]
//                          [--wx rain] [--diff 0.96] [--grid quali|reverse|random] [--seeds 1,2,3] [--verbose] [--json out.json]
// Overtakes are on-track position changes after lap 1 (start shuffle excluded; a car that is
// stopped or was just respawned does not count). "clean" = no contact between the two within 4 s
// and the passed car at racing speed. Contact severity by closing speed at the contact point:
// light < 2 m/s, medium 2-6 m/s, heavy > 6 m/s.
import fs from 'node:fs';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { Race, severityOf } from '../src/sim/race.js';
import { buildField } from '../src/sim/drivers/racecraft.js';
import { wetFor } from '../src/sim/wet.js';

export function runRace({ track = 'ravenscar', n = 12, laps = 5, car = 'gt3', klass = 'class', wx = null, diff = 0.96, seed = 1, order = 'quali', maxTime = null, onStep = null } = {}) {
  const trk = buildTrack(track), wet = wx ? wetFor(wx) : null;
  const field = buildField(trk, { n, car, klass, difficulty: diff, seed, wet, order, aiPlayer: true });
  const race = new Race(trk, field, { laps, seed, wet });
  const limit = maxTime ?? (laps * field[field.length - 1].driver.lapEst * 1.6 + 120);
  const t0 = performance.now();
  while (!race.over && race.time < limit) { race.step(); if (onStep) onStep(race); }
  const wall = performance.now() - t0;
  const cls = race.classification();
  const sev = { light: 0, medium: 0, heavy: 0 }, sevL1 = { light: 0, medium: 0, heavy: 0 };
  for (const e of race.events) { sev[severityOf(e.dv)]++; if (e.lap < 1) sevL1[severityOf(e.dv)]++; }
  const bests = cls.filter(r => r.bestLap).map(r => r.bestLap).sort((a, b) => a - b);
  let carLaps = 0; for (const r of cls) carLaps += r.laps;
  const drv = race.cars.map(c => c.driver);
  return {
    track, n, laps, car, klass, wx: wx || 'dry', seed, finished: race.over, raceTime: race.raceTime, wallMs: wall, steps: race.tick,
    usPerCarStep: wall * 1000 / (race.tick * n),
    winner: cls[0].name + ' (' + cls[0].car + ', grid ' + cls[0].grid + ')', winTime: cls[0].time,
    order: cls.map(r => `${r.pos}.${r.name}[${r.car} g${r.grid}${r.retired ? ' DNF' : r.finished ? '' : ' NC'}]`),
    overtakes: race.overtakes, clean: race.cleanOvertakes, contacts: sev, contactsLap1: sevL1,
    offs: cls.reduce((a, r) => a + r.offs, 0), strikes: cls.reduce((a, r) => a + r.strikes, 0), penalties: cls.reduce((a, r) => a + r.penalty, 0),
    walls: cls.reduce((a, r) => a + r.walls, 0), spins: cls.reduce((a, r) => a + r.spins, 0),
    respawns: cls.reduce((a, r) => a + r.respawns, 0), dnf: cls.filter(r => r.retired).length, notFinished: cls.filter(r => !r.finished && !r.retired).length,
    lapped: cls.filter(r => r.finished && r.laps < cls[0].laps).length,
    bestLap: bests[0], slowestBest: bests[bests.length - 1], spreadPct: bests.length > 1 ? (bests[bests.length - 1] / bests[0] - 1) * 100 : 0,
    carLaps, heavyPerCarLap: sev.heavy / Math.max(1, carLaps), contactsPerCarLap: (sev.light + sev.medium + sev.heavy) / Math.max(1, carLaps),
    passes: drv.reduce((a, d) => a + d.passes, 0), aborts: drv.reduce((a, d) => a + d.aborts, 0), defends: drv.reduce((a, d) => a + d.defends, 0), mistakes: drv.reduce((a, d) => a + d.mistakes, 0),
    cls, race,
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const seeds = String(arg('seeds', '1,2,3')).split(',').map(Number);
  const cfg = { track: arg('track', 'ravenscar'), n: +arg('n', 12), laps: +arg('laps', 5), car: arg('car', 'gt3'), klass: arg('klass', 'class'), wx: arg('wx', null), diff: +arg('diff', 0.96), order: arg('grid', 'quali') };
  if (!CARS[cfg.car]) throw new Error('unknown car ' + cfg.car);
  const verbose = process.argv.includes('--verbose'), out = [];
  const fmt = (t) => (t == null ? '-' : `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`);
  for (const seed of seeds) {
    const r = runRace({ ...cfg, seed });
    console.log(`${cfg.track} ${cfg.n}x${cfg.klass === 'same' ? cfg.car : cfg.klass} ${cfg.laps}L ${r.wx} seed ${seed}: ${r.finished ? 'finished' : 'TIMEOUT'} ${fmt(r.winTime)}  winner ${r.winner}` +
      `  overtakes ${r.overtakes} (clean ${r.clean})  contacts L/M/H ${r.contacts.light}/${r.contacts.medium}/${r.contacts.heavy} (lap1 ${r.contactsLap1.light}/${r.contactsLap1.medium}/${r.contactsLap1.heavy})` +
      `  offs ${r.offs} pen ${r.penalties}s  walls ${r.walls} spins ${r.spins} respawns ${r.respawns}  DNF ${r.dnf} NC ${r.notFinished} lapped ${r.lapped}  best ${fmt(r.bestLap)} spread ${r.spreadPct.toFixed(1)}%` +
      `  AI: passes ${r.passes} aborts ${r.aborts} defends ${r.defends} mistakes ${r.mistakes}  ${r.usPerCarStep.toFixed(2)} us/car-step`);
    if (verbose) {
      for (const c of r.cls) console.log(`   P${String(c.pos).padStart(2)} ${c.name.padEnd(11)} ${c.car.padEnd(8)} grid ${String(c.grid).padStart(2)} laps ${c.laps} ${c.retired ? 'DNF ' + c.reason : c.finished ? fmt(c.time) + (c.penalty ? ` (+${c.penalty}s)` : '') : 'not classified'}  best ${fmt(c.bestLap)}  contacts ${c.contacts} offs ${c.offs} respawns ${c.respawns}`);
      for (const e of r.race.events) if (e.dv >= 6) console.log(`   heavy contact t=${e.t.toFixed(1)} lap ${e.lap + 1} s=${e.s.toFixed(0)} cars ${e.a},${e.b} dv=${e.dv.toFixed(1)}`);
    }
    delete r.race; out.push(r);
  }
  if (seeds.length > 1) {
    const avg = (f) => out.reduce((a, r) => a + f(r), 0) / out.length;
    console.log(`  mean of ${out.length}: overtakes ${avg(r => r.overtakes).toFixed(1)} (clean ${avg(r => r.clean).toFixed(1)})  contacts/car/lap ${avg(r => r.contactsPerCarLap).toFixed(3)}  heavy/car/lap ${avg(r => r.heavyPerCarLap).toFixed(4)}  offs ${avg(r => r.offs).toFixed(1)}  walls ${avg(r => r.walls).toFixed(1)}  spins ${avg(r => r.spins).toFixed(1)}  respawns ${avg(r => r.respawns).toFixed(1)}  DNF ${avg(r => r.dnf).toFixed(1)}`);
  }
  const jf = arg('json', null); if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 1));
}
