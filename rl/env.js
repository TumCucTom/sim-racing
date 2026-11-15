// Deterministic RL environment around the shared Sim.
// Everything random (start position, track grip) comes from the episode seed.
import { Sim } from '../src/sim/sim.js';
import { RNG } from '../src/sim/rng.js';
import { speedProfile } from '../src/sim/drivers/baseline.js';
import { buildObs, applyAction, OBS_DIM, ACT_DIM } from '../src/sim/drivers/rl-interface.js';
import { CONTROL_SUBSTEPS } from '../src/sim/drivers/policy-driver.js';

export { OBS_DIM, ACT_DIM };
export const CONTROL_DT = CONTROL_SUBSTEPS / 300;

export class RaceEnv {
  constructor(track, spec, { maxSteps = 1200, progressScale = 0.02 } = {}) {
    this.track = track; this.spec = spec;
    this.sim = new Sim(track, spec);
    this.obs = new Float64Array(OBS_DIM);
    this.controls = { steer: 0, throttle: 0, brake: 0 };
    this.maxSteps = maxSteps; this.progressScale = progressScale;
    this.safeV = speedProfile(track, spec, { grip: 0.7 }); // only used to pick sane start speeds
  }

  // Training reset: random place on the lap, rolling start.
  reset(seed) {
    const rng = new RNG(seed), t = this.track;
    if (rng.next() < 0.12) {
      // a share of episodes start from the grid so launches are in-distribution
      this.sim.reset({ s: -rng.uniform(8, 24), d: rng.uniform(-1.5, 1.5), speed: 0 });
      this.sim.car.gripScale = rng.uniform(0.96, 1.04);
      this.steps = 0; this.slow = -60; this.prevA0 = 0;
      return buildObs(this.sim.car, t, this.obs);
    }
    const s = rng.uniform(0, t.length);
    const idx = Math.min(t.n - 1, Math.floor(s / t.ds));
    const speed = this.safeV[idx] * rng.uniform(0.35, 0.9);
    this.sim.reset({ s, d: rng.uniform(-3, 3), speed: Math.min(speed, 70), headingOffset: rng.uniform(-0.04, 0.04) });
    this.sim.car.gripScale = rng.uniform(0.96, 1.04);
    this.steps = 0; this.slow = 0; this.prevA0 = 0;
    return buildObs(this.sim.car, t, this.obs);
  }

  // Evaluation reset: standing start on the grid, as in the benchmark.
  resetGrid(seed) {
    const rng = new RNG(seed);
    this.sim.reset({ s: -rng.uniform(8, 24), d: rng.uniform(-1.5, 1.5), speed: 0 });
    this.sim.car.gripScale = rng.uniform(0.97, 1.03);
    this.steps = 0; this.slow = 0; this.prevA0 = 0;
    return buildObs(this.sim.car, this.track, this.obs);
  }

  // Returns reward; sets this.done / this.truncated / this.info.
  step(a0, a1) {
    const sim = this.sim, car = sim.car;
    applyAction(car, a0, a1, this.controls);
    const p0 = sim.progress;
    let crashed = false;
    for (let k = 0; k < CONTROL_SUBSTEPS; k++) {
      sim.step(this.controls);
      if (car.wallContact > 0) crashed = true;
    }
    this.steps++;
    const dp = sim.progress - p0;
    let r = dp * this.progressScale;
    const c0 = a0 < -1 ? -1 : a0 > 1 ? 1 : a0;
    r -= 0.01 * Math.abs(c0 - this.prevA0);       // discourage steering chatter
    this.prevA0 = c0;
    this.done = false; this.truncated = false;
    if (car.speed < 3) this.slow++; else this.slow = 0;
    if (crashed || sim.offTrack || Math.abs(car.headErr) > 1.4 || this.slow > 100) {
      // leaving the circuit ends the episode; the penalty grows with speed so
      // 'arrive slower' is always an improvement the learner can find
      const vc = car.speed / 50;
      this.done = true; r -= 2.0 + 3.0 * vc * vc;
    } else if (this.steps >= this.maxSteps) this.truncated = true;
    buildObs(car, this.track, this.obs);
    return r;
  }
}

// Deterministic evaluation of any controller: standing start, then `laps`
// timed laps. controlFn(car) is called once per physics step.
export function evaluateDriver(track, spec, makeController, seed, { laps = 2, timeLimit = 400 } = {}) {
  const env = new RaceEnv(track, spec);
  env.resetGrid(seed);
  const sim = env.sim, car = sim.car;
  const ctl = makeController(sim);
  const times = [], valids = [];
  sim.onLap = (t, v) => { times.push(t); valids.push(v); };
  let fail = null, vmax = 0;
  while (sim.lap < laps) {
    sim.step(ctl(car));
    if (car.vx > vmax) vmax = car.vx;
    if (car.wallContact > 0) { fail = 'crash'; break; }
    if (Math.abs(car.headErr) > 1.6) { fail = 'spin'; break; }
    if (sim.time > timeLimit) { fail = 'timeout'; break; }
  }
  return {
    seed, fail, times, valids, vmax, offs: sim.offCount, gripScale: car.gripScale,
    // flying lap = the last timed lap; only counts if completed within track limits
    flying: !fail && valids[laps - 1] ? times[laps - 1] : null,
    lap1: times[0] ?? null,
  };
}
