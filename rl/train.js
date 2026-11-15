// Train a PPO driver. Usage:
//   node rl/train.js --car gt3 --seed 1 --steps 3000000 [--out rl/runs/gt3_s1]
// Fully deterministic for a given (car, seed, steps): no wall-clock or
// Math.random enters the learning loop.
import fs from 'node:fs';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { RNG } from '../src/sim/rng.js';
import { RaceEnv, evaluateDriver, OBS_DIM, ACT_DIM } from './env.js';
import { PPO } from './ppo.js';
import { PolicyDriver } from '../src/sim/drivers/policy-driver.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const carId = args.car || 'gt3', seed = +(args.seed || 1), totalSteps = +(args.steps || 3e6);
const N = +(args.envs || 32), T = +(args.horizon || 128);
const out = args.out || `rl/runs/${carId}_s${seed}`;
const evalEvery = +(args.evalEvery || 10);
export const VALIDATION_SEEDS = [9001, 9002, 9003, 9004];

fs.mkdirSync(out, { recursive: true });
const track = buildTrack(), spec = CARS[carId];
const rng = new RNG(seed * 7919 + 13);
const ppo = new PPO({ obsDim: OBS_DIM, actDim: ACT_DIM, rng, lr: +(args.lr || 3e-4), entCoef: +(args.ent || 0.0005) });
ppo.pi.b[ppo.pi.b.length - 1][1] = 0.6; // start with a little throttle so it explores forwards

const envs = [], obs = [];
let epCounter = 0;
const nextSeed = () => seed * 1000003 + (epCounter++);
for (let e = 0; e < N; e++) { const env = new RaceEnv(track, spec); envs.push(env); obs.push(Float64Array.from(env.reset(nextSeed()))); }

const n = N * T;
const buf = { n, obs: new Float64Array(n * OBS_DIM), act: new Float64Array(n * ACT_DIM), logp: new Float64Array(n), adv: new Float64Array(n), ret: new Float64Array(n) };
const rew = new Float64Array(n), val = new Float64Array(n), done = new Uint8Array(n), lastVal = new Float64Array(N);
const epRet = new Float64Array(N), epLen = new Int32Array(N), epProg = new Float64Array(N);
const act = new Float64Array(ACT_DIM);
const logFile = `${out}/progress.jsonl`;
fs.writeFileSync(logFile, '');
fs.writeFileSync(`${out}/config.json`, JSON.stringify({ carId, seed, totalSteps, N, T, gamma: ppo.gamma, lam: ppo.lam, lr: ppo.lr0, entCoef: ppo.entCoef, epochs: ppo.epochs, minibatch: ppo.minibatch, hidden: [64, 64], controlHz: 20 }, null, 2));

let steps = 0, iter = 0, best = { score: -Infinity };
let lr = ppo.lr0; const targetKl = +(args.kl || 0.012), lrMax = +(args.lrMax || 2e-3);
const crashHist = new Int32Array(20);
const t0 = Date.now(); // wall-clock is logged only, never fed back into training
const recent = [];
const iters = Math.ceil(totalSteps / n);

function evaluate() {
  const pol = ppo.exportPolicy();
  const res = VALIDATION_SEEDS.map(s => evaluateDriver(track, spec, () => { const d = new PolicyDriver(track, pol); return c => d.control(c); }, s, { laps: 8 }));
  // a checkpoint only counts on a seed if all eight laps of the stint are clean;
  // it is scored on stint pace (mean of laps 2-8), not on one hot lap
  const ok = res.filter(r => r.allClean);
  const mean = ok.length ? ok.reduce((a, r) => a + r.stintMean, 0) / ok.length : null;
  return { completed: ok.length, lap: mean, fails: res.map(r => r.fail || (r.allClean ? 'ok' : 'invalid')) };
}

for (iter = 0; iter < iters; iter++) {
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < N; e++) {
      const k = t * N + e, env = envs[e], o = obs[e];
      buf.obs.set(o, k * OBS_DIM);
      buf.logp[k] = ppo.act(o, act);
      buf.act[k * ACT_DIM] = act[0]; buf.act[k * ACT_DIM + 1] = act[1];
      val[k] = ppo.value(o);
      let r = env.step(act[0], act[1]);
      epRet[e] += r; epLen[e]++;
      if (env.truncated) r += ppo.gamma * ppo.value(env.obs);   // bootstrap through time limits
      rew[k] = r;
      if (env.done || env.truncated) {
        done[k] = 1;
        recent.push({ ret: epRet[e], len: epLen[e], prog: env.sim.progress, crashed: env.done ? 1 : 0 });
        if (env.done) crashHist[Math.min(19, Math.floor(env.sim.car.s / track.length * 20))]++;
        if (recent.length > 200) recent.shift();
        epRet[e] = 0; epLen[e] = 0;
        o.set(env.reset(nextSeed()));
      } else { done[k] = 0; o.set(env.obs); }
    }
  }
  for (let e = 0; e < N; e++) lastVal[e] = ppo.value(obs[e]);
  // GAE
  for (let e = 0; e < N; e++) {
    let gae = 0;
    for (let t = T - 1; t >= 0; t--) {
      const k = t * N + e;
      const nv = done[k] ? 0 : (t === T - 1 ? lastVal[e] : val[k + N]);
      const delta = rew[k] + ppo.gamma * nv - val[k];
      gae = delta + ppo.gamma * ppo.lam * (done[k] ? 0 : gae);
      buf.adv[k] = gae; buf.ret[k] = gae + val[k];
    }
  }
  const st = ppo.update(buf);
  // KL-adaptive learning rate: keep each policy update near the target KL
  if (st.kl > 2 * targetKl) lr = Math.max(1e-5, lr / 1.5); else if (st.kl < targetKl / 2) lr = Math.min(lrMax, lr * 1.5);
  ppo.setLr(lr);
  steps += n;
  const mean = (f) => recent.length ? recent.reduce((a, r) => a + f(r), 0) / recent.length : 0;
  const row = { iter, steps, wall: +((Date.now() - t0) / 1000).toFixed(1), epRet: +mean(r => r.ret).toFixed(3), epLen: +mean(r => r.len).toFixed(1), epProg: +mean(r => r.prog).toFixed(1), crashRate: +mean(r => r.crashed).toFixed(3), std: Array.from(ppo.logStd, v => +Math.exp(v).toFixed(3)), kl: +st.kl.toFixed(4), vLoss: +st.vLoss.toFixed(4), lr: +lr.toExponential(2) };
  if (iter % evalEvery === evalEvery - 1 || iter === iters - 1) {
    const ev = evaluate();
    row.crashHist = Array.from(crashHist); crashHist.fill(0);
    fs.writeFileSync(`${out}/latest.json`, JSON.stringify(ppo.exportPolicy({ carId, seed, steps })));
    row.evalCompleted = ev.completed; row.evalLap = ev.lap === null ? null : +ev.lap.toFixed(3); row.evalFails = ev.fails;
    const score = ev.completed * 1000 - (ev.lap ?? 999);
    if (score > best.score) {
      best = { score, lap: ev.lap, completed: ev.completed, steps };
      fs.writeFileSync(`${out}/policy.json`, JSON.stringify(ppo.exportPolicy({ carId, seed, steps, validationLap: ev.lap, validationCompleted: ev.completed })));
    }
    console.log(`[${carId} s${seed}] it ${iter} steps ${(steps / 1e6).toFixed(2)}M ret ${row.epRet} prog ${row.epProg}m crash ${row.crashRate} | eval ${ev.completed}/${VALIDATION_SEEDS.length} lap ${ev.lap?.toFixed(2) ?? '-'} | best ${best.lap?.toFixed(2) ?? '-'} | lr ${lr.toExponential(1)} kl ${row.kl} std ${row.std} | ${(steps / row.wall).toFixed(0)} sps`);
  }
  fs.appendFileSync(logFile, JSON.stringify(row) + '\n');
}
fs.writeFileSync(`${out}/final.json`, JSON.stringify(ppo.exportPolicy({ carId, seed, steps })));
fs.writeFileSync(`${out}/summary.json`, JSON.stringify({ carId, seed, steps, best, wallSeconds: (Date.now() - t0) / 1000 }, null, 2));
console.log(`[${carId} s${seed}] done. best validation lap ${best.lap?.toFixed(3)} (${best.completed}/${VALIDATION_SEEDS.length}) at ${best.steps} steps`);
