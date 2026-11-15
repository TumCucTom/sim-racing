// Fixed-seed benchmark: scripted baseline vs trained RL policies.
//   node rl/benchmark.js [--car gt3] [--trials 20]
// Every trial is a standing start followed by two timed laps; the metric is
// the second (flying) lap, counted only if completed inside track limits.
// Benchmark seeds (1..N) are disjoint from training and validation seeds.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { evaluateDriver } from './env.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';
import { PolicyDriver } from '../src/sim/drivers/policy-driver.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const carId = args.car || 'gt3', trials = +(args.trials || 20);
const track = buildTrack(), spec = CARS[carId];
const seeds = Array.from({ length: trials }, (_, i) => i + 1);

function stats(res) {
  const ok = res.filter(r => r.flying !== null).map(r => r.flying);
  const mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  const sd = ok.length > 1 ? Math.sqrt(ok.reduce((a, b) => a + (b - mean) ** 2, 0) / (ok.length - 1)) : 0;
  return { completed: ok.length, trials: res.length, mean, sd, best: ok.length ? Math.min(...ok) : null, worst: ok.length ? Math.max(...ok) : null,
    fails: res.filter(r => r.flying === null).map(r => `seed ${r.seed}: ${r.fail || 'track limits'}`), laps: res.map(r => r.flying), vmaxKmh: Math.max(...res.map(r => r.vmax)) * 3.6 };
}
const run = (make) => seeds.map(s => evaluateDriver(track, spec, make, s));
const baselineAt = (grip) => run(() => { const d = new BaselineDriver(track, spec, { grip }); return c => d.control(c); });

// Give the baseline its best shot: the fastest grip setting that still
// completes every trial cleanly.
const sweep = [];
for (const grip of [0.84, 0.88, 0.92, 0.96, 1.0, 1.04]) { const st = stats(baselineAt(grip)); sweep.push({ grip, completed: st.completed, mean: st.mean }); }
const clean = sweep.filter(s => s.completed === trials).sort((a, b) => a.mean - b.mean)[0] || sweep.sort((a, b) => b.completed - a.completed)[0];
const baseline = { name: `Scripted baseline (grip ${clean.grip})`, grip: clean.grip, ...stats(baselineAt(clean.grip)) };

const policies = [];
const dir = 'rl/runs';
for (const d of fs.readdirSync(dir).filter(n => n.startsWith(`${carId}_s`) && fs.existsSync(`${dir}/${n}/policy.json`)).sort()) {
  const pol = JSON.parse(fs.readFileSync(`${dir}/${d}/policy.json`));
  const res = run(() => { const drv = new PolicyDriver(track, pol); return c => drv.control(c); });
  policies.push({ name: `PPO ${d}`, run: d, trainSeed: pol.seed, trainSteps: pol.steps, validationLap: pol.validationLap, ...stats(res) });
}
// champion = best validation score (chosen without looking at benchmark seeds)
const champ = policies.filter(p => p.validationLap).sort((a, b) => a.validationLap - b.validationLap)[0];
// determinism: re-run the champion and hash the lap times
let deterministic = null;
if (champ) {
  const pol = JSON.parse(fs.readFileSync(`${dir}/${champ.run}/policy.json`));
  const again = stats(run(() => { const drv = new PolicyDriver(track, pol); return c => drv.control(c); }));
  const h = (x) => crypto.createHash('sha256').update(JSON.stringify(x.laps)).digest('hex').slice(0, 16);
  deterministic = { identical: h(again) === h(champ), hash: h(champ) };
  fs.mkdirSync('src/policies', { recursive: true }); fs.copyFileSync(`${dir}/${champ.run}/policy.json`, `src/policies/${carId}.json`);
}
const out = { carId, track: track.name, trials, seeds, baselineSweep: sweep, baseline, policies, champion: champ?.run ?? null, deterministic };
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(`docs/benchmark-${carId}.json`, JSON.stringify(out, null, 2));
const f = (v) => (v === null ? '   -   ' : v.toFixed(3));
console.log(`Benchmark: ${spec.name} @ ${track.name}, ${trials} fixed seeds, flying lap (s)`);
console.table([baseline, ...policies].map(p => ({ driver: p.name, clean: `${p.completed}/${p.trials}`, mean: f(p.mean), sd: p.sd.toFixed(3), best: f(p.best), worst: f(p.worst), 'vmax km/h': p.vmaxKmh.toFixed(0) })));
if (champ) console.log(`Champion (by validation): ${champ.run}  ->  ${f(champ.mean)} s vs baseline ${f(baseline.mean)} s  (${((1 - champ.mean / baseline.mean) * 100).toFixed(1)} % faster), deterministic re-run identical: ${deterministic.identical}`);
