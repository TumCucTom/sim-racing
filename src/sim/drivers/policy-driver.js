// Runs a trained policy as a driver. Decisions are made at the RL control
// rate (every CONTROL_SUBSTEPS physics steps) and held in between, exactly as
// in training.
import { MLP } from './mlp.js';
import { buildObs, applyAction, policyMean, OBS_DIM } from './rl-interface.js';

export const CONTROL_SUBSTEPS = 15; // 300 Hz physics -> 20 Hz decisions

export class PolicyDriver {
  constructor(track, policyJson) {
    this.track = track;
    this.net = MLP.fromJSON(policyJson.policy);
    this.obs = new Float64Array(OBS_DIM); this.tmp = new Float64Array(OBS_DIM); this.act = new Float64Array(2);
    this.out = { steer: 0, throttle: 0, brake: 0 };
    this.tick = 0;
  }
  reset() { this.tick = 0; }
  control(car) {
    if (this.tick++ % CONTROL_SUBSTEPS === 0) {
      const a = policyMean(this.net, buildObs(car, this.track, this.obs), this.tmp, this.act);
      applyAction(car, a[0], a[1], this.out);
    }
    return this.out;
  }
}
