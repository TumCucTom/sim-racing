// Deterministic vehicle dynamics.
//
// Planar 3-DOF chassis (surge / sway / yaw) + 4 wheel-spin DOF, with:
//   * combined-slip Magic-Formula tyres with load sensitivity and a thermal model
//   * lagged longitudinal / lateral load transfer with a roll-stiffness split
//   * speed-squared aero drag and downforce with a front/rear balance
//   * engine torque curve, turbo lag, rev limiter, clutch slip on launch,
//     gearbox with shift torque-cut, viscous+preload limited-slip differential
//   * FWD / RWD / AWD, ABS and traction control where the real car has them
//   * road gradient, per-wheel surface (asphalt / kerb / grass / gravel), walls
//
// No Math.random, no wall-clock: identical inputs give bit-identical outputs.

import { project, surfaceAt, SURF } from './track.js';
import { wetMu } from './wet.js';

export const SIM_HZ = 300;
export const SIM_DT = 1 / SIM_HZ;
const G = 9.81, RHO = 1.2;

const SURF_MU = [1.0, 0.93, 0.45, 0.40];
const SURF_ROLL = [0.013, 0.016, 0.07, 0.30];

export function interpCurve(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  const n = curve.length;
  if (x >= curve[n - 1][0]) return curve[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (x <= curve[i][0]) {
      const a = curve[i - 1], b = curve[i];
      return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
    }
  }
  return curve[n - 1][1];
}

export function peakPower(spec) {
  let best = 0, at = 0;
  const e = spec.engine;
  for (let rpm = Math.max(500, e.idle); rpm <= e.limiter; rpm += 50) {
    const p = interpCurve(e.torque, rpm) * rpm * Math.PI / 30;
    if (p > best) { best = p; at = rpm; }
  }
  return { watts: best, rpm: at };
}

export class Vehicle {
  constructor(spec, track) {
    this.spec = spec;
    this.track = track;
    const s = spec;
    this.a = s.wheelbase * (1 - s.frontWeight);   // CG -> front axle
    this.b = s.wheelbase * s.frontWeight;         // CG -> rear axle
    this.Iz = s.yawK * s.mass * this.a * this.b;
    this.wx = [this.a, this.a, -this.b, -this.b];
    this.wy = [s.trackF / 2, -s.trackF / 2, s.trackR / 2, -s.trackR / 2];
    // Nominal tyre load per axle. `tireStagger` says how far the tyre sizes are
    // matched to the static axle loads (1 = fully staggered, 0 = square setup).
    const stg = s.tireStagger ?? 0.5;
    const q = s.mass * G / 4;
    this.fz0 = [q + stg * (s.mass * G * s.frontWeight / 2 - q), q + stg * (s.mass * G * (1 - s.frontWeight) / 2 - q)];
    const t = s.tire;
    this.B = Math.tan(Math.PI / (2 * t.C));
    this.tanPeakAlpha = Math.tan(t.peakAlpha);
    this.driven = s.drive === 'FWD' ? [1, 1, 0, 0] : s.drive === 'RWD' ? [0, 0, 1, 1] : [1, 1, 1, 1];
    this.nGears = s.gears.length;
    // Optimal upshift rpm per gear: shift when the next gear makes more thrust.
    this.upRpm = [];
    const e = s.engine;
    for (let g = 0; g < this.nGears - 1; g++) {
      const r = s.gears[g + 1] / s.gears[g];
      let up = e.redline;
      for (let rpm = e.redline * 0.6; rpm < e.redline; rpm += 25) {
        if (interpCurve(e.torque, rpm) * s.gears[g] < interpCurve(e.torque, rpm * r) * s.gears[g + 1]) { up = rpm; break; }
      }
      this.upRpm.push(up);
    }
    this.upRpm.push(Infinity);

    this.omega = new Float64Array(4);
    this.fz = new Float64Array(4);
    this.fx = new Float64Array(4);
    this.fy = new Float64Array(4);
    this.kappa = new Float64Array(4);
    this.alpha = new Float64Array(4);
    this.slipV = new Float64Array(4);
    this.tireT = new Float64Array(4);
    this.absF = new Float64Array(4);
    this.muEff = new Float64Array(4).fill(s.tire.muX);
    this.latUse = new Float64Array(4).fill(1);
    this.surf = new Uint8Array(4);
    this.wheelD = new Float64Array(4);
    this._proj = { idx: 0, s: 0, d: 0, frac: 0 };
    this.aids = { abs: s.abs, tc: s.tc, autoShift: true };
    this.gripScale = 1;   // track-condition multiplier (domain randomisation / weather)
    this.wet = null;      // wet-track state (src/sim/wet.js); null = dry, exactly the original behaviour
    // slipstream (src/sim/race.js): multipliers on drag and downforce; exactly 1 = free air, bit-identical
    this.dragK = 1; this.downK = 1;
    this.reset({ x: 0, y: 0, yaw: 0, speed: 0 });
  }

  reset({ x, y, yaw, speed = 0, idxHint = 0 }) {
    const s = this.spec;
    this.x = x; this.y = y; this.yaw = yaw;
    this.vx = speed; this.vy = 0; this.r = 0;
    this.steer = 0; this.throttle = 0; this.brake = 0;
    this.axF = 0; this.ayF = 0; this.ax = 0; this.ay = 0;
    this.boost = 0; this.tcCut = 0; this.drvSlip = 0; this.shiftTimer = 0; this.shiftCooldown = 0;
    this.limiterOn = false; this.clutchSlip = 0;
    this.impact = 0; this.wallContact = 0;
    this.time = 0;
    for (let i = 0; i < 4; i++) {
      this.omega[i] = speed / s.wheelRadius;
      this.tireT[i] = s.tire.tOpt - 12;
      this.absF[i] = 1; this.muEff[i] = s.tire.muX; this.latUse[i] = 1;
      this.fx[i] = 0; this.fy[i] = 0; this.kappa[i] = 0; this.alpha[i] = 0; this.slipV[i] = 0;
    }
    // pick the gear that suits the starting speed
    this.gear = 1;
    if (s.engine.electric) this.gear = 1;
    else {
      for (let g = 1; g <= this.nGears; g++) {
        this.gear = g;
        const rpm = speed / s.wheelRadius * s.gears[g - 1] * s.finalDrive * 30 / Math.PI;
        if (rpm < this.upRpm[g - 1] * 0.9) break;
      }
    }
    this.rpm = Math.max(s.engine.idle, speed / s.wheelRadius * this.ratio() * 30 / Math.PI);
    project(this.track, x, y, idxHint, this._proj);
    this.idx = this._proj.idx; this.s = this._proj.s; this.d = this._proj.d;
    this.headErr = wrapPi(yaw - this.track.heading[this.idx]);
    this._staticLoads();
  }

  ratio() {
    const s = this.spec;
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -s.gears[0] * 0.92 * s.finalDrive;
    return s.gears[this.gear - 1] * s.finalDrive;
  }

  _staticLoads() {
    const s = this.spec, w = s.mass * G;
    this.fz[0] = this.fz[1] = w * s.frontWeight / 2;
    this.fz[2] = this.fz[3] = w * (1 - s.frontWeight) / 2;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  requestShift(dir) {
    const s = this.spec;
    if (s.engine.electric) {
      // single-speed: only forward <-> reverse
      if (dir < 0 && this.gear === 1 && Math.abs(this.vx) < 1.5) this.gear = -1;
      else if (dir > 0 && this.gear === -1 && Math.abs(this.vx) < 1.5) this.gear = 1;
      return;
    }
    if (this.shiftTimer > 0) return;
    let g = this.gear + dir;
    if (g === 0) g = dir > 0 ? 1 : -1;
    if (g > this.nGears || g < -1) return;
    if (g === -1 && this.vx > 1.5) return;
    if (g > 0 && dir < 0) {
      // refuse a downshift that would over-rev the engine
      const rpm = this.vx / s.wheelRadius * s.gears[g - 1] * s.finalDrive * 30 / Math.PI;
      if (rpm > s.engine.limiter + 200) return;
    }
    this.gear = g;
    this.shiftTimer = s.shiftTime;
    this.shiftCooldown = s.shiftTime + 0.12;
    this.lastShiftDir = dir;
  }

  // controls: { steer [-1,1] (+ = left), throttle [0,1], brake [0,1] }
  step(dt, c) {
    const s = this.spec, e = s.engine, t = s.tire, trk = this.track;
    const R = s.wheelRadius;

    // --- actuators -------------------------------------------------------
    const st = c.steer < -1 ? -1 : c.steer > 1 ? 1 : c.steer;
    const dsMax = 4.5 * dt;
    this.steer += clamp(st - this.steer, -dsMax, dsMax);
    const dpMax = 14 * dt;
    this.throttle += clamp(clamp(c.throttle, 0, 1) - this.throttle, -dpMax, dpMax);
    this.brake += clamp(clamp(c.brake, 0, 1) - this.brake, -dpMax * 1.5, dpMax * 1.5);
    const delta = this.steer * s.steerLock;
    const cd = Math.cos(delta), sd = Math.sin(delta);

    // --- loads -----------------------------------------------------------
    const v2 = this.vx * this.vx + this.vy * this.vy;
    const down = 0.5 * RHO * s.ClA * v2 * this.downK;
    const w = s.mass * G;
    const dLong = s.mass * this.axF * s.cgHeight / s.wheelbase;
    const latTot = s.mass * this.ayF * s.cgHeight;
    const dLatF = latTot * s.rollStiffFront / s.trackF;
    const dLatR = latTot * (1 - s.rollStiffFront) / s.trackR;
    const ff = (w * s.frontWeight + down * s.aeroBalance - dLong) / 2;
    const fr = (w * (1 - s.frontWeight) + down * (1 - s.aeroBalance) + dLong) / 2;
    const fz = this.fz;
    fz[0] = ff - dLatF; fz[1] = ff + dLatF; fz[2] = fr - dLatR; fz[3] = fr + dLatR;
    for (let i = 0; i < 4; i++) if (fz[i] < 0) fz[i] = 0;

    // --- drivetrain ------------------------------------------------------
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    if (this.shiftCooldown > 0) this.shiftCooldown -= dt;
    const drv = this.driven;
    const nDrv = drv[0] + drv[1] + drv[2] + drv[3];
    let wd = 0;
    for (let i = 0; i < 4; i++) if (drv[i]) wd += this.omega[i];
    wd /= nDrv;
    let ratio = this.ratio();
    let wheelRpm = wd * ratio * 30 / Math.PI;

    if (this.aids.autoShift && !e.electric && this.gear > 0 && this.shiftCooldown <= 0) {
      const g = this.gear;
      if (g < this.nGears && wheelRpm > this.upRpm[g - 1] && this.throttle > 0.05) this.requestShift(1);
      else if (g > 1) {
        const lowRpm = wheelRpm * s.gears[g - 2] / s.gears[g - 1];
        const thresh = this.upRpm[g - 2] * (0.70 + 0.12 * Math.max(this.throttle, this.brake));
        if (lowRpm < thresh) this.requestShift(-1);
      }
      ratio = this.ratio();
      wheelRpm = wd * ratio * 30 / Math.PI;
    }

    // turbo boost state (first-order spool; faster at high rpm)
    if (e.turbo) {
      const target = this.throttle;
      const tau = target > this.boost ? 0.10 + 0.55 * clamp(1 - (this.rpm - 1500) / 3500, 0, 1) : 0.12;
      this.boost += (target - this.boost) * Math.min(1, dt / tau);
    }

    let engineTorque = 0;     // torque delivered at the gearbox input
    let locked = false;
    const shifting = this.shiftTimer > 0;
    const thr = this.throttle;
    if (e.electric) {
      locked = true;
      this.rpm = Math.abs(wheelRpm);
      const sgn = ratio < 0 ? -1 : 1;
      const regenFade = clamp(Math.abs(this.vx) / 4, 0, 1);
      engineTorque = interpCurve(e.torque, this.rpm) * thr - (e.friction[0]) * (1 - this.throttle) * regenFade * (this.vx * sgn > 0 ? 1 : 0);
      if (this.gear < 0) engineTorque = Math.min(engineTorque, 500) ;
    } else if (this.gear === 0 || shifting) {
      // clutch open: free-rev toward where the new gear will put the engine
      const target = this.gear !== 0 ? Math.max(e.idle, Math.abs(wheelRpm)) : e.idle + this.throttle * (e.redline - e.idle);
      this.rpm += (target - this.rpm) * Math.min(1, dt / Math.max(0.02, s.shiftTime * 0.5));
      engineTorque = 0;
    } else {
      const absW = Math.abs(wheelRpm);
      const launchRpm = e.idle + this.throttle * (0.48 * e.redline - e.idle * 0.5);
      if (absW >= launchRpm || (absW >= e.idle * 1.05 && this.throttle < 0.05)) {
        locked = true;
        this.rpm = absW;
      } else {
        // slipping clutch (launch / crawling)
        this.rpm += (Math.max(e.idle, launchRpm) - this.rpm) * Math.min(1, dt / 0.12);
      }
      if (this.rpm > e.limiter) this.limiterOn = true;
      else if (this.rpm < e.limiter - 120) this.limiterOn = false;
      const thrEff = this.limiterOn ? 0 : thr;
      let wot = interpCurve(e.torque, this.rpm);
      if (e.turbo) wot *= 0.42 + 0.58 * clamp(this.boost / Math.max(0.05, this.throttle), 0, 1);
      const fric = (e.friction[0] + e.friction[1] * this.rpm);
      engineTorque = wot * thrEff - fric * (1 - thrEff);
      if (!locked) engineTorque = Math.max(0, wot * thrEff) * (this.throttle > 0.02 ? 1 : 0);
    }
    this.clutchSlip = locked ? 0 : 1;
    this.engineTorque = engineTorque;
    const wheelTorqueTotal = engineTorque * ratio * s.efficiency;
    const iDrvExtra = locked ? e.inertia * ratio * ratio / nDrv : 0;

    // per-wheel drive torque incl. limited-slip diff
    const td = this._td || (this._td = new Float64Array(4));
    td[0] = td[1] = td[2] = td[3] = 0;
    const split = s.drive === 'AWD' ? s.frontTorqueSplit : s.drive === 'FWD' ? 1 : 0;
    const axleT = [wheelTorqueTotal * split, wheelTorqueTotal * (1 - split)];
    // Traction control: model-based torque limiter. Each driven axle is
    // capped at what its tyres can transmit given load, surface, temperature
    // and how much of the friction circle cornering is already using.
    this.tcCut = 0;
    if (this.aids.tc && wheelTorqueTotal * (ratio < 0 ? -1 : 1) > 0) {
      // slip-based backstop for situations the torque model can't see (sliding sideways)
      const over = this.drvSlip / (3 * t.peakKappa);
      const backstop = over > 1 ? Math.max(0.15, 1 / over) : 1;
      let want = 0, got = 0;
      for (let ax = 0; ax < 2; ax++) {
        const l = ax * 2, r = l + 1;
        if (!drv[l]) continue;
        const I = s.wheelInertia + iDrvExtra;
        const cl = fz[l] * this.muEff[l] * R * this.latUse[l] + I * Math.abs(this.ax) / R;
        const cr = fz[r] * this.muEff[r] * R * this.latUse[r] + I * Math.abs(this.ax) / R;
        const wl = clamp(s.diff.lock / 150, 0, 1);
        const cap = backstop * (wl * (cl + cr) + (1 - wl) * 2 * Math.min(cl, cr));
        const T = Math.abs(axleT[ax]);
        want += T;
        if (T > cap) { axleT[ax] *= cap / T; got += cap; } else got += T;
      }
      if (want > 1e-6) this.tcCut = 1 - got / want;
    }
    for (let ax = 0; ax < 2; ax++) {
      const l = ax * 2, r = l + 1;
      if (!drv[l]) continue;
      const T = axleT[ax];
      const lim = s.diff.preload + s.diff.ramp * Math.abs(T);
      const tl = clamp(s.diff.lock * (this.omega[l] - this.omega[r]), -lim, lim);
      td[l] = T / 2 - tl; td[r] = T / 2 + tl;
    }

    // --- tyres -----------------------------------------------------------
    const he = wrapPi(this.yaw - trk.heading[this.idx]);
    const che = Math.cos(he), she = Math.sin(he);
    let Fx = 0, Fy = 0, Mz = 0;
    let maxDrvSlip = 0, rollF = 0;
    const B = this.B, C = t.C;
    for (let i = 0; i < 4; i++) {
      const xw = this.wx[i], yw = this.wy[i];
      const vxw = this.vx - this.r * yw, vyw = this.vy + this.r * xw;
      let vl, vt;
      if (i < 2) { vl = vxw * cd + vyw * sd; vt = -vxw * sd + vyw * cd; }
      else { vl = vxw; vt = vyw; }
      const dW = this.d + xw * she + yw * che;
      this.wheelD[i] = dW;
      const sf = surfaceAt(trk, this.idx, dW);
      this.surf[i] = sf;

      const avl = vl < 0 ? -vl : vl;
      const vden = avl > 2.0 ? avl : 2.0;
      const wR = this.omega[i] * R;
      const kap = (wR - vl) / vden;
      const tanA = vt / vden;
      // Cornering stiffness grows less than linearly with load: the slip angle
      // at peak grip rises with load (Pacejka's BCD(Fz) saturation).
      const fzn = fz[i] / this.fz0[i >> 1];
      const pk = fzn < 0.2 ? 0.64 : fzn > 3 ? 1.9 : 0.55 + 0.45 * fzn;
      const sx = kap / t.peakKappa, sy = tanA / (this.tanPeakAlpha * pk);
      const rho = Math.sqrt(sx * sx + sy * sy);
      const dT = (this.tireT[i] - t.tOpt) / t.tWin;
      const gT = 1 - 0.10 * Math.min(1.6, dT * dT);
      const ls = clamp(1 - t.loadSens * (fzn - 1), 0.55, 1.12);
      let mu = SURF_MU[sf] * gT * ls * this.gripScale;
      if (this.wet !== null) mu *= wetMu(this.wet, sf, this.s + xw * che, dW, trk.hw[this.idx], trk.lineD[this.idx]);
      const Br = B * rho;
      const at = Math.atan(Br);
      const gm = Math.sin(C * at);
      let fxi = 0, fyi = 0, stiff = 0;
      if (rho > 1e-9) {
        const k = fz[i] * mu * gm / rho;
        fxi = k * sx * t.muX;
        fyi = -k * sy * t.muY;
        const dgm = C * B * Math.cos(C * at) / (1 + Br * Br);
        stiff = fz[i] * mu * t.muX * Math.max(0.02 * C * B, dgm) / t.peakKappa * R * R / vden;
      } else {
        stiff = fz[i] * mu * t.muX * C * B / t.peakKappa * R * R / vden;
      }
      // rolling resistance (opposes wheel travel)
      const roll = SURF_ROLL[sf] * fz[i] * clamp(vl / 0.5, -1, 1);
      rollF += roll;
      this.kappa[i] = kap; this.alpha[i] = Math.atan(tanA);
      this.muEff[i] = mu * t.muX;
      this.latUse[i] = Math.sqrt(Math.max(0.03, 1 - Math.min(1, sy * sy)));
      this.fx[i] = fxi; this.fy[i] = fyi;
      const svx = wR - vl;
      this.slipV[i] = Math.sqrt(svx * svx + vt * vt) * Math.min(1, rho);

      // tyre thermal state
      const heat = (Math.abs(fxi * svx) + Math.abs(fyi * vt)) * 0.34;
      // convective + (above the working window) rapidly growing losses, so an
      // abused tyre settles at a hot equilibrium instead of running away
      const over = this.tireT[i] - t.tOpt;
      const cool = (7 + 0.55 * Math.sqrt(v2)) * (this.tireT[i] - 28) * (over > 0 ? 1 + over / 30 : 1);
      this.tireT[i] += dt * (Math.min(heat, 60000) - cool) / 9000;
      if (this.tireT[i] > 160) this.tireT[i] = 160;

      // chassis forces
      const fxr = fxi - roll;
      let fbx, fby;
      if (i < 2) { fbx = fxr * cd - fyi * sd; fby = fxr * sd + fyi * cd; }
      else { fbx = fxr; fby = fyi; }
      Fx += fbx; Fy += fby; Mz += xw * fby - yw * fbx;

      // wheel spin (semi-implicit in the tyre force for unconditional stability)
      const I = s.wheelInertia + (drv[i] ? iDrvExtra : 0);
      // ABS
      let bt = this.brake * s.brakeTorque * (i < 2 ? s.brakeBias : 1 - s.brakeBias) * 0.5;
      if (this.aids.abs) {
        // rear axle releases earlier (EBD) so it keeps lateral grip in reserve
        if (kap < -t.peakKappa * (i < 2 ? 1.15 : 0.75) && avl > 2.5) this.absF[i] = Math.max(0.05, this.absF[i] - 30 * dt);
        else this.absF[i] = Math.min(1, this.absF[i] + 9 * dt);
        bt *= this.absF[i];
      }
      // Semi-implicit update of the slip velocity u = wR - vl (not of w
      // itself, which would add phantom inertia while the car accelerates).
      const om0 = this.omega[i];
      const aW = this.ax * dt / R;
      const den = 1 + dt * stiff / I;
      let om = om0 + aW + (dt * (td[i] - fxi * R) / I - aW) / den;
      if (bt > 0) {
        const dOm = dt * bt / (I * den);
        if (om > dOm) om -= dOm; else if (om < -dOm) om += dOm; else om = 0;
      }
      this.omega[i] = om;
      if (drv[i]) {
        const ak = this.gear < 0 ? -kap : kap;
        if (ak > maxDrvSlip) maxDrvSlip = ak;
      }
    }

    this.drvSlip = maxDrvSlip;

    // --- aero, gravity ----------------------------------------------------
    const spd = Math.sqrt(v2);
    const drag = 0.5 * RHO * s.CdA * spd * this.dragK;
    Fx -= drag * this.vx; Fy -= drag * this.vy;
    const fg = -w * trk.grade[this.idx];
    Fx += fg * che; Fy += -fg * she;

    // --- integrate chassis -------------------------------------------------
    const ax = Fx / s.mass, ay = Fy / s.mass;
    this.ax = ax; this.ay = ay;
    const kf = Math.min(1, dt / 0.07);
    this.axF += (ax - this.axF) * kf; this.ayF += (ay - this.ayF) * kf;
    this.vx += dt * (ax + this.r * this.vy);
    this.vy += dt * (ay - this.r * this.vx);
    this.r += dt * Mz / this.Iz;
    this.yaw += dt * this.r;
    const cy = Math.cos(this.yaw), sy_ = Math.sin(this.yaw);
    this.x += dt * (this.vx * cy - this.vy * sy_);
    this.y += dt * (this.vx * sy_ + this.vy * cy);

    // --- track projection + walls -------------------------------------------
    const p = project(trk, this.x, this.y, this.idx, this._proj);
    this.idx = p.idx; this.s = p.s; this.d = p.d;
    this.impact = 0;
    const margin = 0.95;
    const limL = trk.wallL[p.idx] - margin, limR = trk.wallR[p.idx] - margin;
    if (p.d > limL || p.d < -limR) {
      const h = trk.heading[p.idx];
      const side = p.d > 0 ? 1 : -1;
      const nx = -Math.sin(h) * side, ny = Math.cos(h) * side; // outward normal
      const pen = side > 0 ? p.d - limL : -p.d - limR;
      this.x -= nx * pen; this.y -= ny * pen;
      let wvx = this.vx * cy - this.vy * sy_, wvy = this.vx * sy_ + this.vy * cy;
      const vn = wvx * nx + wvy * ny;
      if (vn > 0) {
        const tx = -ny, ty = nx;
        let vtg = wvx * tx + wvy * ty;
        vtg *= 1 - Math.min(0.5, 0.06 + vn * 0.03);
        const vnNew = -0.18 * vn;
        wvx = vnNew * nx + vtg * tx; wvy = vnNew * ny + vtg * ty;
        this.vx = wvx * cy + wvy * sy_; this.vy = -wvx * sy_ + wvy * cy;
        this.r *= 0.6;
        this.impact = vn;
      }
      this.wallContact = 0.3;
      project(trk, this.x, this.y, this.idx, this._proj);
      this.idx = this._proj.idx; this.s = this._proj.s; this.d = this._proj.d;
    } else if (this.wallContact > 0) this.wallContact -= dt;
    this.headErr = wrapPi(this.yaw - trk.heading[this.idx]);
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI; else if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
    this.time += dt;
  }

  // Number of wheels beyond the track-limit line.
  wheelsOff() {
    const trk = this.track;
    const edge = trk.hw[this.idx] + (trk.kerb[this.idx] ? trk.kerbWidth : 0);
    let n = 0;
    for (let i = 0; i < 4; i++) if (Math.abs(this.wheelD[i]) > edge) n++;
    return n;
  }

  // Compact numeric snapshot (used by determinism tests and replays).
  snapshot() {
    return [this.x, this.y, this.yaw, this.vx, this.vy, this.r, this.steer, this.throttle, this.brake,
      this.rpm, this.gear, this.boost, this.tcCut, this.axF, this.ayF,
      ...this.omega, ...this.tireT, ...this.absF];
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
export { SURF };
