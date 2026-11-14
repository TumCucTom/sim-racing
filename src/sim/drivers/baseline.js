// Scripted baseline driver: follows the centreline with pure-pursuit steering
// and tracks a speed profile computed from track curvature and the car's grip
// envelope (friction circle + aero), with a backward braking pass.
// Deliberately simple: it does not use the track width or trail-brake.
const G = 9.81, RHO = 1.2;

export function speedProfile(track, spec, { grip = 0.9, brake = 0.8, offset = null } = {}) {
  const n = track.n, v = new Float64Array(n);
  // 0.86: nominal tyre mu -> usable axle grip after load transfer / sensitivity,
  // so that grip = 1.0 means 'at the car's measured cornering limit'.
  const muY = spec.tire.muY * 0.86 * grip, muX = spec.tire.muX * 0.9 * brake;
  const c = 0.5 * RHO * spec.ClA / spec.mass;         // downforce accel per v^2 (in g-units * g)
  const vTop = 110;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(offset ? offset.curv[i] : track.curv[i]);
    const den = k - muY * c;
    v[i] = den > 1e-6 ? Math.min(vTop, Math.sqrt(muY * G / den)) : vTop;
  }
  // backward pass: respect braking capability (two laps for wrap-around)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const vj = v[j];
      const aLatMax = muY * (G + c * vj * vj);
      const aLat = vj * vj * Math.abs(track.curv[j]);
      const use = Math.min(1, aLat / aLatMax);
      // conservative 'diamond' instead of a friction circle: little trail-braking
      const aBrk = muX * (G + c * vj * vj) * Math.max(0.08, 1 - use)
        + 0.5 * RHO * spec.CdA * vj * vj / spec.mass + G * track.grade[j];
      const vi = Math.sqrt(vj * vj + 2 * Math.max(1, aBrk) * track.ds);
      if (vi < v[i]) v[i] = vi;
    }
  }
  return v;
}

export class BaselineDriver {
  constructor(track, spec, opts = {}) {
    this.track = track; this.spec = spec;
    this.opts = { grip: 0.9, brake: 0.8, lookBase: 5.0, lookGain: 0.42, yawDamp: 0.06, ...opts };
    this.vT = speedProfile(track, spec, this.opts);
    this.out = { steer: 0, throttle: 0, brake: 0 };
  }
  control(car) {
    const t = this.track, o = this.opts, n = t.n;
    const v = Math.max(1, car.vx);
    const Ld = o.lookBase + o.lookGain * v;
    const j = (car.idx + Math.round(Ld / t.ds)) % n;
    const dx = t.x[j] - car.x, dy = t.y[j] - car.y;
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    const lx = dx * cy + dy * sy, ly = -dx * sy + dy * cy;
    const kappa = 2 * ly / (lx * lx + ly * ly);
    let steer = Math.atan(this.spec.wheelbase * kappa) / this.spec.steerLock;
    // yaw-rate damping against the path's expected rate keeps it from weaving
    steer -= o.yawDamp * (car.r - v * kappa) / this.spec.steerLock;
    // speed tracking with a short preview so braking starts on time
    const k = (car.idx + Math.round(v * 0.12 / t.ds)) % n;
    const err = this.vT[k] - car.vx;
    let throttle = 0, brake = 0;
    if (err > 0) throttle = Math.min(1, 0.15 + err * 0.6);
    else if (err < -0.4) brake = Math.min(1, -err * 0.35);
    // lift if the car is sliding
    if (Math.abs(car.vy) > 0.12 * v + 0.5) throttle *= 0.3;
    this.out.steer = Math.max(-1, Math.min(1, steer));
    this.out.throttle = throttle; this.out.brake = brake;
    return this.out;
  }
}
