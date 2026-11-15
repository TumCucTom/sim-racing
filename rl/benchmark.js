// Fixed-seed benchmark: scripted baseline vs trained RL policies.
//   node rl/benchmark.js [--car gt3] [--trials 20]
// Every trial is a standing start followed by a six-lap stint. Two metrics:
//   flying lap  = lap 2, counted only if completed inside track limits
//   stint       = all six laps clean (no crash, no track-limit breach) and
//                 the mean of laps 2-6, which punishes cooking the tyres
// Benchmark seeds (1..N) are disjoint from training and validation seeds.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { evaluateDriver } from './env.js';
import { BaselineDriver, lineDriverOptions } from '../src/sim/drivers/baseline.js';
import { PolicyDriver } from '../src/sim/drivers/policy-driver.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const carId = args.car || 'gt3', trials = +(args.trials || 20);
const track = buildTrack(), spec = CARS[carId];
const seeds = Array.from({ length: trials }, (_, i) => i + 1);
const VAL_SEEDS = Array.from({ length: 20 }, (_, i) => 9011 + i);

function stats(res) {
  const ok = res.filter(r => r.flying !== null).map(r => r.flying);
  const mean = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  const sd = ok.length > 1 ? Math.sqrt(ok.reduce((a, b) => a + (b - mean) ** 2, 0) / (ok.length - 1)) : 0;
  return { completed: ok.length, trials: res.length, mean, sd, best: ok.length ? Math.min(...ok) : null, worst: ok.length ? Math.max(...ok) : null,
    fails: res.filter(r => !r.allClean).map(r => `seed ${r.seed}: ${r.fail || 'track limits'} (${r.cleanLaps} clean laps)`), laps: res.map(r => r.flying), vmaxKmh: Math.max(...res.map(r => r.vmax)) * 3.6,
    stintClean: res.filter(r => r.allClean).length, stintMean: (() => { const k = res.filter(r => r.allClean).map(r => r.stintMean); return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null; })(),
    stints: res.map(r => r.stintMean), tyreMaxC: Math.max(...res.map(r => r.tmax)) };
}
const STINT = 6;
const run = (make) => seeds.map(s => evaluateDriver(track, spec, make, s, { laps: STINT }));
const baselineAt = (grip) => run(() => { const d = new BaselineDriver(track, spec, { grip }); return c => d.control(c); });

// Give the baseline its best shot: the fastest grip setting that still
// completes every trial cleanly.
const sweep = [];
for (const grip of [0.84, 0.88, 0.92, 0.96, 1.0, 1.04]) { const st = stats(baselineAt(grip)); sweep.push({ grip, completed: st.stintClean, mean: st.stintMean, flying: st.mean }); }
const clean = sweep.filter(s => s.completed === trials).sort((a, b) => a.mean - b.mean)[0] || sweep.sort((a, b) => b.completed - a.completed)[0];
const baseline = { name: `Scripted baseline (grip ${clean.grip})`, grip: clean.grip, ...stats(baselineAt(clean.grip)) };

// A stronger scripted reference: the same controller following the optimised
// racing line with trail-braking (grip swept the same way).
const lineAt = (grip) => run(() => { const d = new BaselineDriver(track, spec, { ...lineDriverOptions(track, spec), grip }); return c => d.control(c); });
const lsweep = [];
for (const grip of [0.9, 0.94, 0.98, 1.02, 1.06]) { const st = stats(lineAt(grip)); lsweep.push({ grip, completed: st.stintClean, mean: st.stintMean }); }
const lclean = lsweep.filter(s => s.completed === trials).sort((a, b) => a.mean - b.mean)[0] || lsweep.sort((a, b) => b.completed - a.completed)[0];
const lineDriver = { name: `Racing-line driver (grip ${lclean.grip})`, grip: lclean.grip, ...stats(lineAt(lclean.grip)) };

const policies = [];
const dir = 'rl/runs';
for (const d of fs.readdirSync(dir).filter(n => n.startsWith(`${carId}_s`) && fs.existsSync(`${dir}/${n}/policy.json`)).sort()) {
  const pol = JSON.parse(fs.readFileSync(`${dir}/${d}/policy.json`));
  const res = run(() => { const drv = new PolicyDriver(track, pol); return c => drv.control(c); });
  // model selection uses a separate, larger validation set (seeds 9001-9030)
  const val = stats(VAL_SEEDS.map(v => evaluateDriver(track, spec, () => { const drv = new PolicyDriver(track, pol); return c => drv.control(c); }, v, { laps: STINT })));
  policies.push({ name: `PPO ${d}`, run: d, trainSeed: pol.seed, trainSteps: pol.steps, validationLap: val.stintMean, validationClean: val.stintClean, validationTrials: VAL_SEEDS.length, ...stats(res) });
}
// champion = best validation score (chosen without looking at benchmark seeds)
// reliability first, then pace
const champ = policies.filter(p => p.validationLap !== null).sort((a, b) => (b.validationClean - a.validationClean) || (a.validationLap - b.validationLap))[0];
// determinism: re-run the champion and hash the lap times
let deterministic = null;
if (champ) {
  const pol = JSON.parse(fs.readFileSync(`${dir}/${champ.run}/policy.json`));
  const again = stats(run(() => { const drv = new PolicyDriver(track, pol); return c => drv.control(c); }));
  const h = (x) => crypto.createHash('sha256').update(JSON.stringify(x.laps)).digest('hex').slice(0, 16);
  deterministic = { identical: h(again) === h(champ), hash: h(champ) };
  fs.mkdirSync('src/policies', { recursive: true }); fs.copyFileSync(`${dir}/${champ.run}/policy.json`, `src/policies/${carId}.json`);
}
const out = { carId, track: track.name, trials, seeds, stintLaps: STINT, baselineSweep: sweep, baseline, lineSweep: lsweep, lineDriver, policies, champion: champ?.run ?? null, deterministic };
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(`docs/benchmark-${carId}.json`, JSON.stringify(out, null, 2));
const f = (v) => (v === null ? '   -   ' : v.toFixed(3));
console.log(`Benchmark: ${spec.name} @ ${track.name}, ${trials} fixed seeds, ${STINT}-lap stints`);
console.table([baseline, lineDriver, ...policies].map(p => ({ driver: p.name, 'stints clean': `${p.stintClean}/${p.trials}`, 'stint pace': f(p.stintMean), 'tyre max C': p.tyreMaxC.toFixed(0), 'flying clean': `${p.completed}/${p.trials}`, flying: f(p.mean), sd: p.sd.toFixed(3), best: f(p.best), worst: f(p.worst), 'vmax km/h': p.vmaxKmh.toFixed(0), validation: p.validationTrials ? `${p.validationClean}/${p.validationTrials} stints @ ${p.validationLap?.toFixed(2) ?? '-'}` : '' })));
if (champ) console.log(`Champion (by validation): ${champ.run}  ->  stint ${f(champ.stintMean)} s vs baseline ${f(baseline.stintMean)} s  (${((1 - champ.stintMean / baseline.stintMean) * 100).toFixed(1)} % faster); flying ${f(champ.mean)} vs ${f(baseline.mean)}; deterministic re-run identical: ${deterministic.identical}`);
