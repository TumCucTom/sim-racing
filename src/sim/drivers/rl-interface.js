// Observation / action interface shared by the headless RL environment and
// the in-browser AI driver, so a trained policy sees exactly the same inputs
// in both places.
const G = 9.81, RHO = 1.2;

export const LOOKAHEAD = [0, 10, 20, 35, 50, 70, 95, 125, 160, 200]; // metres
const BASE = 14;
export const OBS_DIM = BASE + LOOKAHEAD.length;
export const ACT_DIM = 2;

// Speed-sensitive steering authority (like a variable-ratio rack): the
// largest useful steer fraction at speed v is roughly the kinematic angle for
// twice the grip limit plus a little headroom for counter-steer.
export function steerLimit(spec, v) {
  const c = 0.5 * RHO * spec.ClA / spec.mass;
  const aLat = 2.0 * spec.tire.muY * (G + c * v * v);
  const dMax = Math.atan(spec.wheelbase * aLat / Math.max(v * v, 4)) + 0.04;
  return Math.min(1, dMax / spec.steerLock);
}

export function buildObs(car, track, out) {
  const spec = car.spec, n = track.n;
  const half = track.hw[car.idx];
  const edge = half + (track.kerb[car.idx] ? track.kerbWidth : 0);
  let k = 0;
  out[k++] = car.vx / 50 - 0.8;
  out[k++] = car.vy / 8;
  out[k++] = car.r / 1.2;
  out[k++] = car.d / half;
  out[k++] = (edge - Math.abs(car.d)) / half;
  out[k++] = Math.max(-1.5, Math.min(1.5, car.headErr * 2.5));
  out[k++] = car.steer / Math.max(0.05, steerLimit(spec, car.vx));
  out[k++] = car.throttle - car.brake;
  out[k++] = car.axF / 15;
  out[k++] = car.ayF / 15;
  out[k++] = Math.max(-2, Math.min(2, (car.alpha[2] + car.alpha[3]) * 0.5 / spec.tire.peakAlpha));
  out[k++] = track.grade[car.idx] * 15;
  // tyre temperature relative to the optimum, per axle (grip falls off either side)
  const tt = car.tireT, ty = spec.tire;
  out[k++] = ((tt[0] + tt[1]) * 0.5 - ty.tOpt) / ty.tWin;
  out[k++] = ((tt[2] + tt[3]) * 0.5 - ty.tOpt) / ty.tWin;
  for (let j = 0; j < LOOKAHEAD.length; j++) {
    let i = car.idx + Math.round(LOOKAHEAD[j] / track.ds);
    if (i >= n) i -= n;
    out[k++] = track.curv[i] * 40;
  }
  return out;
}

// action = [steer, pedal] in [-1, 1]; pedal > 0 throttle, < 0 brake.
export function applyAction(car, a0, a1, controls) {
  const s = a0 < -1 ? -1 : a0 > 1 ? 1 : a0;
  const p = a1 < -1 ? -1 : a1 > 1 ? 1 : a1;
  controls.steer = s * steerLimit(car.spec, car.vx);
  controls.throttle = p > 0 ? p : 0;
  controls.brake = p < 0 ? -p : 0;
  return controls;
}

// Mirror symmetry: reflecting the world left<->right negates these observation
// entries (lateral velocity, yaw rate, offset, heading error, steering,
// lateral g, rear slip angle and all curvatures) and the steering action.
export const MIRROR = (() => {
  const m = new Float64Array(OBS_DIM).fill(1);
  for (const i of [1, 2, 3, 5, 6, 9, 10]) m[i] = -1;
  for (let j = 0; j < LOOKAHEAD.length; j++) m[BASE + j] = -1;
  return m;
})();

// Policy mean with left/right equivariance built in:
//   steer(o) = -steer(mirror(o)),  pedal(o) = pedal(mirror(o))
// followed by tanh so actions are bounded. `tmp` is scratch of size OBS_DIM.
export function policyMean(net, obs, tmp, out) {
  const y = net.forward(obs); const s1 = y[0], p1 = y[1];
  for (let i = 0; i < OBS_DIM; i++) tmp[i] = obs[i] * MIRROR[i];
  const y2 = net.forward(tmp);
  out[0] = Math.tanh(0.5 * (s1 - y2[0]));
  out[1] = Math.tanh(0.5 * (p1 + y2[1]));
  return out;
}
