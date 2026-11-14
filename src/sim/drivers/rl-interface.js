// Observation / action interface shared by the headless RL environment and
// the in-browser AI driver, so a trained policy sees exactly the same inputs
// in both places.
const G = 9.81, RHO = 1.2;

export const LOOKAHEAD = [0, 10, 20, 35, 50, 70, 95, 125, 160, 200]; // metres
export const OBS_DIM = 12 + LOOKAHEAD.length;
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
  const edge = track.halfWidth + (track.kerb[car.idx] ? track.kerbWidth : 0);
  let k = 0;
  out[k++] = car.vx / 50 - 0.8;
  out[k++] = car.vy / 8;
  out[k++] = car.r / 1.2;
  out[k++] = car.d / track.halfWidth;
  out[k++] = (edge - Math.abs(car.d)) / track.halfWidth;
  out[k++] = Math.max(-1.5, Math.min(1.5, car.headErr * 2.5));
  out[k++] = car.steer / Math.max(0.05, steerLimit(spec, car.vx));
  out[k++] = car.throttle - car.brake;
  out[k++] = car.axF / 15;
  out[k++] = car.ayF / 15;
  out[k++] = Math.max(-2, Math.min(2, (car.alpha[2] + car.alpha[3]) * 0.5 / spec.tire.peakAlpha));
  out[k++] = track.grade[car.idx] * 15;
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
