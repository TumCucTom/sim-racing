// Scripted baseline driver: follows the centreline with pure-pursuit steering
// and tracks a speed profile computed from track curvature and the car's grip
// envelope (friction circle + aero), with a backward braking pass.
// Deliberately simple: it does not use the track width or trail-brake.
const G = 9.81, RHO = 1.2;

export function speedProfile(track, spec, { grip = 0.9, brake = 0.8, line = null, trail = false } = {}) {
  const n = track.n, v = new Float64Array(n);
  const curv = line ? line.curv : track.curv, dsA = line ? line.ds : null;
  // 0.86: nominal tyre mu -> usable axle grip after load transfer / sensitivity,
  // so that grip = 1.0 means 'at the car's measured cornering limit'.
  const muY = spec.tire.muY * 0.86 * grip, muX = spec.tire.muX * 0.9 * brake;
  const c = 0.5 * RHO * spec.ClA / spec.mass;         // downforce accel per v^2
  const vTop = 110;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(curv[i]);
    const den = k - muY * c;
    v[i] = den > 1e-6 ? Math.min(vTop, Math.sqrt(muY * G / den)) : vTop;
  }
  // backward pass: respect braking capability (two laps for wrap-around)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const vj = v[j];
      const aLatMax = muY * (G + c * vj * vj);
      const aLat = vj * vj * Math.abs(curv[j]);
      const use = Math.min(1, aLat / aLatMax);
      // blend between a conservative 'diamond' (brake in a straight line) and
      // the full friction circle (trail-braking into the apex)
      const tb = +trail || 0;   // 0 = straight-line braking, 1 = full trail-braking
      const share = Math.max(0.08, tb * 0.92 * Math.sqrt(Math.max(0, 1 - use * use)) + (1 - tb) * (1 - use));
      const aBrk = muX * (G + c * vj * vj) * share
        + 0.5 * RHO * spec.CdA * vj * vj / spec.mass + G * track.grade[j];
      const vi = Math.sqrt(vj * vj + 2 * Math.max(1, aBrk) * (dsA ? dsA[i] : track.ds));
      if (vi < v[i]) v[i] = vi;
    }
  }
  return v;
}

export class BaselineDriver {
  // opts.line = track.line makes it a racing-line driver: it steers along the
  // optimised line and takes its corner speeds from that line's curvature.
  constructor(track, spec, opts = {}) {
    this.track = track; this.spec = spec;
    this.opts = { grip: 0.9, brake: 0.8, lookBase: 5.0, lookGain: 0.42, yawDamp: 0.06, line: null, trail: false, ...opts };
    this.vT = speedProfile(track, spec, this.opts);
    this.out = { steer: 0, throttle: 0, brake: 0 };
  }
  control(car) {
    const t = this.track, o = this.opts, n = t.n, L = o.line;
    const v = Math.max(1, car.vx);
    const Ld = o.lookBase + o.lookGain * v;
    const j = (car.idx + Math.round(Ld / t.ds)) % n;
    const dx = (L ? L.x[j] : t.x[j]) - car.x, dy = (L ? L.y[j] : t.y[j]) - car.y;
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

// Per-car settings for the racing-line driver, found by tools/tune-line.js:
// the fastest (grip, trail-braking) pair that laps every circuit cleanly.
const LINE_TUNE = {
  gt3: { grip: 0.97, trail: 0.6 }, f458: { grip: 0.92, trail: 0.6 }, hatch: { grip: 0.97, trail: 0.6 },
  coupe: { grip: 0.97, trail: 0.3 }, formula: { grip: 0.8, trail: 0.9 }, ev: { grip: 0.8, trail: 0.3 },
};
// The Nordschleife is narrow, bumpy in gradient and unforgiving: separate, more
// conservative settings (also from a sweep; every car laps it cleanly).
const NORDSCHLEIFE_TUNE = {
  gt3: { grip: 0.86, trail: 0 }, f458: { grip: 0.8, trail: 0.4 }, hatch: { grip: 0.8, trail: 0 },
  coupe: { grip: 0.8, trail: 0 }, formula: { grip: 0.92, trail: 0 }, ev: { grip: 0.86, trail: 0 },
};
export function lineDriverOptions(track, spec) {
  if (track.id === 'nordschleife') return { ...(NORDSCHLEIFE_TUNE[spec.id] || { grip: 0.8, trail: 0 }), line: track.line, brake: spec.abs ? 0.8 : 0.6 };
  const t = LINE_TUNE[spec.id] || { grip: 0.85, trail: 0 };
  return { ...t, line: track.line, brake: spec.abs ? 0.85 : 0.65 };
}
