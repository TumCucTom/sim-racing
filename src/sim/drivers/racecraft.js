// Racecraft: a racing driver for wheel-to-wheel racing, layered on BaselineDriver.
//
// BaselineDriver does the driving (pure-pursuit steering along a path, a
// curvature speed profile with trail braking, the wet set-up). RaceDriver decides
// WHICH path and WHICH speed, 30 times a second, from what the cars around it do:
//
//   path   = racing line + lateral offset o(t), clamped to the road and to a lane
//            that leaves a car's width to anyone alongside
//   speed  = min( speed profile of that shifted path, safe following speed )
//
// and runs a small state machine: line -> pass (pull out, draw alongside, clear,
// return) | defend (one move to the inside, hold it) | yield (blue flag).
// In free air (o = 0, nobody near) it reduces exactly to BaselineDriver.
// No rubber-banding: nobody is given grip or power they would not have alone.
import { BaselineDriver, speedProfile, lineDriverOptions } from './baseline.js';
import { RNG } from '../rng.js';
import { CARS } from '../cars.js';

const OFFS = [-6, -3, -1.5, 0, 1.5, 3, 6];      // lateral shifts of the racing line that get their own speed profile
const THINK = 10;                               // tactical update every 10 physics steps (30 Hz)
const HOLD = { steer: 0, throttle: 0, brake: 1 };

export const DRIVER_NAMES = ['Hartmann', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Rossi', 'Kowalski', 'Achterberg', 'Silva', 'Novak',
  'Brennan', 'Iwata', 'Castell', 'Vance', 'Duarte', 'Eriksen', 'Petrov', 'Marchetti', 'Osei', 'Falk', 'Reyes', 'Keller', 'Sato', 'Whitlock'];

// Car classes for building fields (ids that do not exist are dropped).
export const CLASSES = {
  gt3: ['gt3', 'r8lms', 'huracan', 'amggt3', 'f296gt3', 'mc720s'],
  proto: ['hypercar', 'lmp1'],
  road: ['f458', 'coupe', 'hatch', 'ev', 'mini'],
  formula: ['formula'],
};
export function classOf(id) { for (const k in CLASSES) if (CLASSES[k].includes(id)) return k; return 'road'; }

// A seeded personality. `difficulty` scales everybody (1 = the tuned racing-line driver).
export function makePersonality(rng, difficulty = 0.96) {
  const skill = Math.min(1, difficulty * (1 - 0.06 * rng.next())), slip = Math.max(0.1, Math.min(1.5, (1.02 - skill) / 0.1));
  return {
    skill,   // share of the tuned grip and braking the driver uses
    aggression: rng.uniform(0.2, 0.95),            // how small a gap / pace advantage they will go for
    consistency: rng.uniform(0.6, 1.0),            // 1 = every lap the same
    mistake: rng.uniform(0.002, 0.015) * slip,             // chance of a lock-up / wide exit per braking zone (x2.5 under pressure)
    reaction: rng.uniform(0.16, 0.42),             // seconds from lights-out to throttle
  };
}

// Per-track corner table (shared by all drivers): for every sample, the next apex ahead.
const cornerCache = new WeakMap();
function corners(track) {
  let c = cornerCache.get(track); if (c) return c;
  const n = track.n, k = track.line.curv, apex = [];
  for (let i = 0; i < n; i++) {
    const a = Math.abs(k[i]); if (a < 0.006) continue;
    let peak = true;
    for (let q = -12; q <= 12 && peak; q++) if (Math.abs(k[((i + q) % n + n) % n]) > a) peak = false;
    if (peak && (!apex.length || i - apex[apex.length - 1] > 40)) apex.push(i);
  }
  const next = new Int32Array(n);
  if (apex.length) { let cur = apex[0] + n, p = apex.length - 1; for (let i = n - 1; i >= 0; i--) { while (p >= 0 && apex[p] >= i) { cur = apex[p]; p--; } next[i] = cur % n; } }
  // the first corner of the race: the first apex after the line that needs real braking
  let first = 300; for (const a of apex) if (a * track.ds > 60 && Math.abs(k[a]) > 0.012) { first = a * track.ds; break; }
  // run[i]: metres from the next apex ahead of sample i to the apex after it (how much straight follows the corner)
  const run = new Float32Array(n), after = new Map();
  apex.forEach((a, q) => after.set(a, (((apex[(q + 1) % apex.length] - a) % n + n) % n || n) * track.ds));
  for (let i = 0; i < n; i++) run[i] = after.get(next[i]) || 0;
  cornerCache.set(track, c = { apex, next, first, run });
  return c;
}

export class RaceDriver {
  constructor(track, spec, { personality, wet = null, seed = 1 } = {}) {
    this.track = track; this.spec = spec; this.wet = wet;
    const p = this.p = personality || { skill: 0.96, aggression: 0.5, consistency: 1, mistake: 0, reaction: 0.25 };
    this.rng = new RNG(seed);
    const tune = lineDriverOptions(track, spec);
    // skill is a share of the validated tune, never more: the best drivers are fast because they are
    // precise and consistent, not because they ask more of the car than it has
    const sk = Math.min(1, p.skill);
    const opts = this.opts = { ...tune, grip: tune.grip * sk, brake: tune.brake * (0.4 + 0.6 * sk), wet };
    this.aeroC = 0.5 * 1.2 * spec.ClA / spec.mass;      // downforce acceleration per v^2
    this.base = new BaselineDriver(track, spec, opts);
    const n = track.n, w = spec.body.width;
    this.vLine = this.base.vT;
    // usable lateral range for the car centre (never narrower than the racing line itself)
    const lim = this.lim = new Float32Array(n);
    // (off the line a car keeps 0.7 m between its wheels and the grass: at speed the tracking error is real)
    for (let i = 0; i < n; i++) lim[i] = Math.max(track.hw[i] - w / 2 - 0.7, Math.abs(track.lineD[i]));
    // speed profiles of the racing line shifted sideways (and clamped to the road): what the
    // car can carry when it is off line. Off the line there is less rubber (and, in the wet, the
    // line may be the only dry part), so a little grip is taken off as well.
    const offK = 0.97 * (wet && wet.lineDry > 0 ? wet.grip / (wet.grip + (1 - wet.grip) * wet.lineDry * 0.4) : 1);
    this.prof = OFFS.map(o => (o === 0 ? this.vLine : speedProfile(track, spec, { ...opts, grip: opts.grip * (Math.abs(o) < 2 ? (1 + offK) / 2 : offK), line: shiftedLine(track, lim, o) })));
    let lap = 0; for (let i = 0; i < n; i++) lap += track.line.ds[i] / this.vLine[i];
    this.lapEst = lap;
    this.cn = corners(track);
    // scratch arrays through which BaselineDriver is fed the target point and target speed
    this.px = new Float64Array(n); this.py = new Float64Array(n); this.vCmd = new Float64Array(n);
    this.base.opts = { ...this.base.opts, line: { x: this.px, y: this.py } };
    this.base.vT = this.vCmd;
    // a car without ABS or with a lot of downforce punishes over-driving harder: smaller liberties
    const tame = (spec.abs ? 1 : 0.5) * (spec.ClA > 2.5 ? 0.6 : 1);
    this.slipK = 1 + 0.045 * tame; this.atkK = tame;
    this.reset();
  }

  reset(rc) {
    this.base.reset();
    this.mode = 'line'; this.side = 0; this.target = null; this.passT = 0; this.cool = 0;
    this.o = rc ? rc.gridD - this.track.lineD[rc.car.idx] : 0; this.oT = this.o;
    this.nL = false; this.nR = false; this.lOff = 0; this.lSep = 0; this.rOff = 0; this.rSep = 0;   // cars alongside, left and right
    this.vF = Infinity; this.speedK = 1; this.paceK = 1; this.extra = 0;
    this.held = 0; this.defApex = -1; this.defD = 0; this.mistakeT = 0; this.braking = false; this.lastLap = -1;
    this.yieldTo = null; this.keepT = 0; this.started = false; this.spun = false; this.slowPass = false; this.atk = 1; this.panic = false; this.wakeF = 0; this.lastBrakeT = -1e9;
    this.passes = 0; this.aborts = 0; this.defends = 0; this.mistakes = 0; this.why = {};
    this.info = { ahead: null, gapA: 0, behind: null, gapB: 0, left: false, right: false };
  }
  onRespawn(rc) { this.nL = this.nR = false; this.mode = 'line'; this.target = null; this.o = rc.car.d - this.track.lineD[rc.car.idx]; this.oT = 0; this.cool = 3; this.yieldTo = null; this.mistakeT = 0; }

  // Lateral position at sample i, given a wanted position d: kept a car's width from the cars
  // alongside (which are assumed to follow the shape of the racing line at their present offset,
  // within the road) and on the road.
  lane(i, d) {
    const t = this.track, L = this.lim[i], ln = t.lineD[i];
    let lo = -L, hi = L;
    if (this.nL) { const dO = ln + this.lOff, b = (dO > L ? L : dO < -L ? -L : dO) - this.lSep; if (b < hi) hi = b; }
    if (this.nR) { const dO = ln + this.rOff, b = (dO > L ? L : dO < -L ? -L : dO) + this.rSep; if (b > lo) lo = b; }
    if (lo > hi) { const m = (lo + hi) / 2; lo = hi = m > L ? L : m < -L ? -L : m; }
    return d < lo ? lo : d > hi ? hi : d;
  }

  // speed the car can carry at sample k when its path is the racing line shifted by o
  vAt(k, o) {
    if (o === 0) return this.vLine[k];
    const P = this.prof;
    if (o <= OFFS[0]) return P[0][k];
    for (let q = 1; q < OFFS.length; q++) if (o <= OFFS[q]) { const f = (o - OFFS[q - 1]) / (OFFS[q] - OFFS[q - 1]); return P[q - 1][k] + (P[q][k] - P[q - 1][k]) * f; }
    return P[OFFS.length - 1][k];
  }

  control(rc, race) {
    const car = rc.car, t = this.track, n = t.n, b = this.base, bo = b.opts;
    if (race && !this.started) {
      if (race.raceTime < this.p.reaction) return HOLD;
      this.started = true;
    }
    if (race && (race.tick + rc.index * 3) % THINK === 0) this.think(rc, race);
    // spun round: stop where we are (predictable for the others) and wait for the marshals
    if (Math.abs(car.headErr) > 1.25) { this.spun = true; return HOLD; }
    if (this.spun) { if (Math.abs(car.headErr) < 0.6) this.spun = false; }
    const v = Math.max(1, car.vx);
    // target point: same look-ahead as BaselineDriver, on the shifted and bounded path
    const j = (car.idx + Math.round((bo.lookBase + bo.lookGain * v) / t.ds)) % n;
    let dT = t.lineD[j] + this.o;
    if (this.o !== 0 || this.nL || this.nR) dT = this.lane(j, dT);
    const h = t.heading[j];
    this.px[j] = t.x[j] - Math.sin(h) * dT; this.py[j] = t.y[j] + Math.cos(h) * dT;
    // target speed
    const k = (car.idx + Math.round(v * 0.12 / t.ds)) % n;
    // where the car actually is counts too when it has been moved off its line (not when it is alone
    // on the line: then the profile is exactly the solo one)
    let oE = 0;
    if (this.o !== 0 || this.nL || this.nR) { oE = car.d - t.lineD[car.idx]; oE = oE > 0.6 ? oE - 0.6 : oE < -0.6 ? oE + 0.6 : 0; }
    let vt = this.vAt(k, this.o);
    if (oE !== 0) { const v2 = this.vAt(k, oE); if (v2 < vt) vt = v2; }
    const oJ = dT - t.lineD[j];            // where the bounded path really goes
    if (oJ !== this.o && Math.abs(oJ - this.o) > 0.3) { const v2 = this.vAt(k, oJ); if (v2 < vt) vt = v2; }
    if (this.extra > 0) {   // brake earlier (dirty air, first-corner caution)
      const k2 = (car.idx + Math.round(v * (0.12 + this.extra) / t.ds)) % n, v2 = this.vAt(k2, this.o); if (v2 < vt) vt = v2;
    }
    const kk = this.speedK * this.paceK * (this.mistakeT > 0 ? this.slipK : this.atk);
    if (kk !== 1) vt *= kk;
    if (this.vF < vt) vt = this.vF;
    // two or more wheels on the grass: ease off and come back gently
    let onGrass = 0; for (let i = 0; i < 4; i++) if (car.surf[i] >= 2) onGrass++;
    // (alone on the line the tuned driver is left exactly as it is, kerb-hopping included)
    const traffic = this.o !== 0 || this.nL || this.nR || this.vF < 1e9;
    if (onGrass < 3 && !traffic) onGrass = 0;
    if (onGrass >= 2 && vt > v - 1) vt = Math.max(12, v - 1);
    this.vCmd[k] = vt;
    const u = b.control(car);
    // Braking for traffic harder than the profile ever does leaves the front tyres nothing to steer
    // with: unless it is an emergency keep a little in hand (and be gentle on the grass).
    let cap = onGrass >= 2 ? 0.5 : this.panic ? 1 : 0.82;
    if (!this.spec.abs && traffic) {
      // no ABS: threshold braking. Never ask for more than the tyres can take at the present load
      // (which, on a downforce car, falls away as the speed comes down), on either axle.
      const sp = this.spec, mu = 0.9 * sp.tire.muX * sp.wheelRadius / sp.brakeTorque;
      const lock = Math.min((car.fz[0] + car.fz[1]) * mu / sp.brakeBias, (car.fz[2] + car.fz[3]) * mu / (1 - sp.brakeBias));
      if (lock < cap) cap = Math.max(0.15, lock);
    }
    if (traffic && cap < 1) {
      // braking for traffic while cornering: only what the cornering leaves of the friction circle
      const sp = this.spec, use = Math.abs(car.ayF) / (0.9 * sp.tire.muY * (9.81 + this.aeroC * v * v));
      if (use > 0.3) cap *= Math.sqrt(Math.max(0.06, 1 - Math.min(1, use) * Math.min(1, use)));
    }
    if (traffic) {
      // Keep it on the road: in traffic the car is not on the path the line follower was tuned on, and
      // pure pursuit is slow to notice a drift toward the edge. If the car is about to run out of
      // road, steer back and free the front tyres to do it.
      const dP = car.d + 0.4 * (car.vx * Math.sin(car.headErr) + car.vy * Math.cos(car.headErr));
      const edge = Math.max(t.hw[car.idx] - this.spec.body.width / 2 - 0.15, Math.abs(t.lineD[car.idx]) + 0.35), over = Math.abs(dP) - edge;
      if (over > 0 && onGrass < 3) {
        const fix = Math.min(0.4, 0.14 * over) * (dP > 0 ? -1 : 1);
        u.steer = Math.max(-1, Math.min(1, u.steer + fix)); cap = Math.min(cap, 0.45); if (u.throttle > 0.5) u.throttle = 0.5;
      }
    }
    if (u.brake > cap && (this.vF < 1e9 || !this.spec.abs && traffic)) u.brake = cap; else if (onGrass >= 2 && u.brake > 0.5) u.brake = 0.5;
    return u;
  }

  // ------------------------------------------------------------------ tactics (30 Hz)
  think(rc, race) {
    const car = rc.car, t = this.track, n = t.n, L = t.length, idx = car.idx, p = this.p, dt = THINK * race.dt;
    const v = Math.max(1, car.vx), line = t.line, lim = this.lim[idx];
    // first-corner caution: from the lights until the field is through the first real corner
    const caution = !rc.finished && rc.sim.lap < 1 && race.raceTime < 50 && rc.dist < this.cn.first + 120;
    if (this.cool > 0) this.cool -= dt; if (this.mistakeT > 0) this.mistakeT -= dt; if (this.keepT > 0) this.keepT -= dt;
    if (rc.sim.lap !== this.lastLap) {   // lap-to-lap variation
      this.lastLap = rc.sim.lap; this.paceK = 1 - Math.abs(this.rng.normal()) * (1 - p.consistency) * 0.02;
    }

    // --- who is around me (track coordinates) ---
    let dLo = -Infinity, dHi = Infinity, A = null, gapA = 1e9, B = null, gapB = 1e9, left = false, right = false, concede = false;
    let hazGap = 1e9, hazIn = 1e9, hazV = 0;
    const apexI = this.cn.next[idx], inside = line.curv[apexI] >= 0 ? 1 : -1, dApex = ((apexI - idx + n) % n) * t.ds;
    const sideGap = 0.55 + 0.008 * v + (caution ? 0.25 : 0), kHere = t.curv[idx];
    const cornering = Math.abs(line.curv[idx]) * v * v > 6;
    const tight = Math.abs(line.curv[apexI]) > 0.055 && dApex < 150;       // hairpins and chicanes: single file
    const merge = this.mode !== 'pass' && caution;
    for (const o of race.cars) {
      if (o === rc || o.retired) continue;
      const oc = o.car; let ds = oc.s - car.s; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      if (ds > 500 || ds < -90) continue;
      // arc length is measured on the centreline: on the inside of a tight corner the cars are closer than that
      ds *= Math.max(0.4, Math.min(1.6, 1 - 0.5 * (oc.d + car.d) * kHere));
      // a car that is sideways takes up its length across the road
      const che = Math.abs(Math.cos(oc.headErr)), she = Math.abs(Math.sin(oc.headErr));
      const ohw = she < 0.2 ? o.hw : o.hw * che + o.hl * she, ohl = she < 0.2 ? o.hl : o.hl * che + o.hw * she;
      const dd = oc.d - car.d, sepW = rc.hw + ohw, gap = Math.abs(ds) - rc.hl - ohl, clear = Math.abs(dd) - sepW;
      if (gap < 1.5 + 0.035 * v && clear > -0.6) {
        // alongside (or about to be): keep to my side of them
        // (allow for where they are heading in the next quarter second)
        let lv = (oc.vx * Math.sin(oc.headErr) + oc.vy * Math.cos(oc.headErr)) * 0.25; lv = lv > 0.7 ? 0.7 : lv < -0.7 ? -0.7 : lv;
        const oo = oc.d - t.lineD[oc.idx];      // their offset from the racing line
        if (dd > 0) { const b = oc.d + Math.min(0, lv) - sepW - sideGap; if (b < dHi) { dHi = b; this.lOff = oo + Math.min(0, lv); this.lSep = sepW + sideGap; } left = true; }
        else { const b = oc.d + Math.max(0, lv) + sepW + sideGap; if (b > dLo) { dLo = b; this.rOff = oo + Math.max(0, lv); this.rSep = sepW + sideGap; } right = true; }
        // two abreast into a corner sorts itself out: the car that is behind backs out,
        // unless it is the one on the inside with its nose well alongside
        if (ds > 1 && (dApex < 150 || cornering)) {
          const amInside = (dd > 0 ? -1 : 1) === inside;
          if (!(amInside && ds < 1.2 + 2.5 * p.aggression) || tight) concede = true;
        }
      }
      if (ds > 0) {
        // in my lane; or, when the field funnels into the first corner, in the lane next to mine
        // and clear ahead: they will come across
        if ((clear < 0.3 || (merge && gap > 0.5 && clear < 2.2 && o !== this.target)) && gap < gapA) { A = o; gapA = gap; }
        // a car that is stopped or pointing the wrong way up ahead: local yellow
        if (ds < 260 && (oc.vx < 6 || she > 0.75) && race.raceTime > 4 && !o.finished) { if (gap < hazGap) hazGap = gap; if (clear < 1.5 && gap < hazIn) { hazIn = gap; hazV = Math.max(0, oc.vx * che); } }
      }
      else if (gap < gapB && clear < 2.5) { B = o; gapB = gap; }
    }
    const I = this.info; I.ahead = A; I.gapA = gapA; I.behind = B; I.gapB = gapB; I.left = left; I.right = right;

    // distance to the next braking point on my own line (for a touch more than my present speed:
    // behind a slower car I am below my own profile)
    let dBrake = 600;
    for (let q = 8; q < 600 / t.ds; q += 4) if (this.vLine[(idx + q) % n] < v + 1.5) { dBrake = q * t.ds; break; }
    let kMax = 0; for (let q = -20; q <= 70; q += 10) { const a = Math.abs(line.curv[((idx + Math.round(q / t.ds)) % n + n) % n]); if (a > kMax) kMax = a; }
    const straight = kMax * v * v < 4;
    const inBrake = dBrake < 12 || car.brake > 0.15;
    I.dBrake = dBrake; I.straight = straight; I.inside = inside;
    // a braking zone begins: maybe a mistake (more likely with a car in the mirrors or just ahead)
    if (inBrake && !this.braking && !caution && !rc.finished && race.time - this.lastBrakeT > 3) {
      this.lastBrakeT = race.time;
      const pressure = (B && gapB < 0.5 * v) || (A && gapA < 0.35 * v);
      if (this.rng.next() < p.mistake * (pressure ? 2.5 : 1)) { this.mistakeT = 1.1; this.mistakes++; }
    }
    this.braking = inBrake;

    // --- following: never run into the car ahead ---
    let vF = Infinity, vA = 0, closing = 0, panic = false;
    if (A) {
      vA = Math.max(0, A.car.vx * Math.cos(A.car.headErr)); closing = v - vA;
      // On a straight with room to pull out, close right up in the tow (the slingshot); otherwise keep a
      // gap that grows with speed. Extra room behind a parked car, to be able to steer round it.
      const exiting = !inBrake && this.vLine[(idx + Math.round(12 / t.ds)) % n] > this.vLine[idx] + 0.4;
      const sling = (straight || exiting) && dBrake > 120 && !caution && !rc.finished && this.mode === 'line';
      // Held up into a corner that leads onto a straight: drop back a little before the apex so as to
      // come off the corner at my own speed, not theirs, and arrive in the tow with a run.
      const hang = !sling && this.held > 0.8 && this.mode === 'line' && !caution && !rc.finished && (inBrake || dApex < 100) && this.cn.run[idx] > 300
        ? (0.10 + 0.12 * (1 - p.aggression)) * v : 0;
      let gMin = (sling ? 2.2 + 0.02 * v : 1.0 + 0.06 * v + hang) + (caution ? 3 : 0) + (rc.finished ? 6 : 0) + (vA < 3 ? 4 : 0);
      // The accordion: nose to tail into a slow corner there must be room for both cars at the apex
      // speed, so the time gap has to open before the braking zone (or the follower goes alongside).
      if (!sling && (inBrake || dBrake < 1.5 * v)) {
        let vMin = v; for (let q = 0; q < 160 / t.ds; q += 6) { const u = this.vLine[(idx + q) % n]; if (u < vMin) vMin = u; }
        const need = (rc.hl + A.hl + 1.5) * v / Math.max(8, vMin) - rc.hl - A.hl;
        if (need > gMin) gMin = need;
      }
      // Their pace as a fraction of what I could do where they are; matching that fraction where
      // I am means braking where they braked. The closer I am, the less I may exceed it.
      // (on a straight the profile is just the top-speed cap, so the reference there is my own speed)
      const ia = A.car.idx, rho = Math.min(1.03, vA / Math.max(5, Math.min(this.vAt(ia, A.car.d - t.lineD[ia]), 1.08 * v + 2)));
      const x = gapA - gMin, kk = (idx + Math.round(v * 0.12 / t.ds)) % n;
      vF = Math.max(0, rho * Math.min(this.vAt(kk, this.o), 1.08 * v + 2) + Math.max(-10, x / (0.9 - 0.3 * p.aggression)));
      // a car that is far off the pace (spun, crawling, damaged) is an obstacle: be able to stop short of it
      // The further they are off that pace (a slower class, an early braker, a car in trouble), the more
      // this becomes plain "be able to slow to their speed before I get there"; for a car that is
      // crawling or spun it is a stop.
      if (rho < 0.92 || caution) {
        const aS = caution || rho < 0.75 ? 9 : 9 + (rho - 0.75) * 80;
        const stop = x > 0 ? Math.sqrt(vA * vA + 2 * aS * x) : Math.max(0, vA + 4 * x);
        if (stop < vF) { vF = stop; if (stop < v - 1.5) panic = true; }
      }
      // about to touch: hard on the brakes now, not when the speed error has built up
      if (x < 0.5 || (closing > 0.5 && x < closing * 0.45)) panic = true;
      if (panic && vA - 3 < vF) vF = Math.max(0, vA - 3);
      if (vF < this.vAt((idx + 4) % n, this.o) - 0.5) this.held += dt; else this.held = Math.max(0, this.held - dt);
    } else this.held = 0;
    // local yellow: be able to stop for a car in the road, and do not arrive flat out next to one beside it
    const yellow = hazGap < 200;
    if (hazIn < 1e9) { const stop = Math.sqrt(hazV * hazV + 2 * 8 * Math.max(0, hazIn - 7)); if (stop < vF) { vF = stop; if (hazIn < 30) panic = true; } }
    else if (hazGap < 120) vF = Math.min(vF, Math.max(22, 0.75 * v));
    // dirty air: less downforce and less drag when close behind, so brake a little earlier
    this.extra = (A && gapA < 25 && this.mode !== 'pass' ? 0.07 * (1 - gapA / 25) : 0) + (caution ? 0.12 : 0) + (this.wakeF > 0.02 ? 0.3 * this.wakeF * this.aeroC * v * v / (9.81 + this.aeroC * v * v) : 0);
    let speedK = caution ? 0.97 : rc.finished ? 0.75 : 1, atk = 1;
    // in a wake the car has less downforce (race.js): take off what that costs at this speed. Nothing for
    // a road car, several per cent for a single-seater in a fast corner.
    this.wakeF += (rc.wake - this.wakeF) * (rc.wake > this.wakeF ? 0.2 : 0.03);     // quick to see a wake, slow to forget it
    if (this.wakeF > 0.02) { const dl = this.aeroC * v * v, loss = 0.12 * this.wakeF * dl / (9.81 + dl); speedK *= 1 - 2 * loss; }      // (twice the first-order cost: the tune leaves no margin, a wake is gusty)

    // --- state machine ---
    const lapper = rc.blue, fasterBehind = !!B && B.driver && B.driver.lapEst < this.lapEst * 0.97;
    if (this.mode === 'pass') {
      const T = this.target, tc = T.car; let ds = tc.s - car.s; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
      const she = Math.abs(Math.sin(tc.headErr)), sepW = rc.hw + (she < 0.2 ? T.hw : T.hw + (T.hl - T.hw) * she), sepL = rc.hl + T.hl;
      this.passT += dt;
      // aim a car's width (and a bit) to the side of where they are relative to the racing line
      const oStar = tc.d - t.lineD[tc.idx] + this.side * (sepW + 0.8);
      const limT = this.lim[tc.idx], dStar = Math.max(-limT, Math.min(limT, tc.d + this.side * (sepW + 0.8)));
      const room = Math.abs(dStar - tc.d) - sepW;          // is there (still) a car's width beside them?
      const overlap = ds < sepL - 0.5;                      // my nose is past their tail
      // clear ahead, with room for them not to have to lift when I come back across: done
      if (T.retired || ds < -(sepL + 2 + 0.07 * v + Math.max(0, tc.vx - v) * 1.5)) {
        if (!T.retired) this.passes++;
        this.mode = 'line'; this.target = null; this.keepT = 0.4; this.cool = 0.5;
      } else {
        // not going to work? then tuck back in behind
        const why = ds > 70 ? 'gone' : room < 0.2 && !overlap ? 'room' : this.passT > 9 && !overlap ? 'time'
          : this.slowPass ? '' : inBrake && !overlap && (this.side !== inside || gapOf(ds, sepL) > 4 + 6 * p.aggression) ? 'brake'
            : dBrake < 40 && this.side !== inside && ds > sepL * 0.3 && p.aggression < 0.8 ? 'outside' : '';
        if (why) {
          this.mode = 'line'; this.cool = 2 + 2 * (1 - p.aggression); this.aborts++; this.why[why] = (this.why[why] || 0) + 1;
          this.yieldTo = overlap ? T : null; this.target = null;
        }
      }
      if (this.mode === 'pass') this.oT = oStar;
      // out-braking: on the inside for the corner and not yet clear, use the braking the tuned profile
      // keeps in reserve (brake later, arrive hotter); given up at the apex
      atk = this.mode === 'pass' && !this.slowPass && this.side === inside && dBrake < 200 && dApex > 15 ? 1 + (0.02 + 0.025 * p.aggression) * this.atkK : 1;
    } else if (this.mode === 'defend') {
      // one move, then hold it until the corner; release at the apex
      const passed = ((idx - this.defApex + n) % n) < n / 2;
      if (passed || !B || gapB > 1.2 * v || rc.finished) { this.mode = 'line'; this.keepT = 0; }
      else this.oT = Math.max(-lim, Math.min(lim, this.defD)) - t.lineD[idx];
    }
    if (this.mode === 'line') {
      // off the grid everybody keeps their lane; the field only funnels onto the line near the first corner
      if (this.keepT <= 0) this.oT = caution && dBrake > 220 && rc.dist < this.cn.first - 120 ? Math.max(-lim, Math.min(lim, rc.gridD)) - t.lineD[idx] : 0;
      if (this.yieldTo) {
        // aborted while partly alongside: drop back until clear
        const T = this.yieldTo, tc = T.car; let ds = tc.s - car.s; if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
        if (T.retired || ds > rc.hl + T.hl + 1 || ds < 0) this.yieldTo = null;
        else vF = Math.min(vF, Math.max(5, tc.vx - 2.5));
      }
      // attack?
      const slow = !!A && (vA < 3 || Math.abs(A.car.headErr) > 0.9) && vA < 0.5 * this.vLine[(idx + 2) % n];      // parked or spun: an obstacle      // crawling or spun: an obstacle
      if (A && (this.cool <= 0 || slow) && !this.yieldTo && (slow ? gapA < 40 : !rc.finished && straight && !inBrake && !yellow)) {
        const sepW = rc.hw + A.hw, sepL = rc.hl + A.hl;
        // pull out late: the tow is behind the car, not beside it
        const range = 3 + Math.max(0, closing) * 1.1 + (dBrake < 330 ? 0.12 * v : 0);
        const run = closing > 1.3 - 0.9 * p.aggression || (this.held > 1.2 && rc.wake > 0.2 && closing > 0.1) || slow;
        if (gapA < range && run && (!caution || slow)) {
          const tPass = (gapA + 2 * sepL + 2) / Math.max(1.5, closing + 1.2), dNeed = tPass * v;
          let limMin = lim; for (let q = 20; q <= 80; q += 20) limMin = Math.min(limMin, this.lim[(idx + q) % n]);
          const ad = A.car.d, oA = ad - t.lineD[A.car.idx];
          // room beside them over the stretch where I would draw alongside (they follow the line's shape)
          let roomL = 1e9, roomR = 1e9;
          for (let q = 0; q <= 60; q += 15) { const i = (idx + Math.round(q / t.ds)) % n, dA = t.lineD[i] + oA; roomL = Math.min(roomL, this.lim[i] - (dA + sepW + 0.5)); roomR = Math.min(roomR, (dA - sepW - 0.5) + this.lim[i]); }
          // room to go two abreast through the corner at all?
          let limC = limMin; for (let q = 0; q < dApex + 40 && q < 400; q += 15) limC = Math.min(limC, this.lim[(idx + Math.round(q / t.ds)) % n]);
          const twoWide = 2 * limC > sepW + 0.9;
          const canComplete = dNeed < dBrake * (twoWide ? 1.0 : 0.7);
          const dive = twoWide && dBrake < 260 && gapA < 3 + 5 * p.aggression && p.aggression > 0.3 && closing > -0.5;
          // set up a move for the braking zone: close enough on the approach, take the inside early
          // (late, about two seconds before the brakes: until then the tow is worth more than the position)
          const setup = twoWide && dBrake > 40 && dBrake < 50 + 1.3 * v && gapA < 5 + 11 * p.aggression && closing > -1;
          const ok = (s) => (s > 0 ? roomL >= 0 && !left : roomR >= 0 && !right);
          let side = 0;
          if (slow) { const rl = lim - (ad + sepW + 0.5), rr = (ad - sepW - 0.5) + lim; side = rl >= rr ? (rl >= -0.2 && !left ? 1 : 0) : (rr >= -0.2 && !right ? -1 : 0); }
          else if (ok(inside) && (canComplete || dive || setup)) side = inside;
          else if (ok(-inside) && canComplete && dNeed < dBrake * 0.75) side = -inside;
          if (side) { this.mode = 'pass'; this.side = side; this.target = A; this.passT = 0; this.held = 0; this.slowPass = slow; }
        }
      }
      // defend? one move to the inside on the approach to a braking zone
      if (this.mode === 'line' && B && !lapper && !fasterBehind && !caution && !rc.finished && straight && !this.yieldTo
        && this.defApex !== apexI && dBrake > 50 && dBrake < 320 && gapB < 3 + 0.22 * v && B.car.vx - v > -0.5) {
        this.defApex = apexI;   // one decision per corner
        if (this.rng.next() < 0.25 + 0.7 * p.aggression) {
          const dDef = inside * Math.min(lim - 0.2, Math.abs(t.lineD[idx] - inside * lim) > 0.1 ? lim - 0.2 : lim);
          // cover the inside without leaving room for a car there; not if somebody already is
          if (!(inside > 0 ? left : right) && Math.abs(dDef - car.d) > 1.2) { this.mode = 'defend'; this.defD = car.d + Math.sign(dDef - car.d) * Math.min(Math.abs(dDef - car.d), 4.5); this.defends++; }
        }
      }
    }
    // being lapped: no defending (above), and ease off on the straights when the leader is right there
    if (lapper && B && gapB < 20 && straight && !inBrake) speedK = Math.min(speedK, 0.94);
    if (concede) speedK = Math.min(speedK, 0.94);
    else if ((left || right) && cornering) speedK = Math.min(speedK, 0.975);   // two abreast: leave a margin
    // going round an obstacle: keep rolling so the car can steer
    if (this.mode === 'pass' && this.slowPass && vF < 2.5 && gapA > 1.2) vF = 2.5;
    if (dLo > dHi) speedK = Math.min(speedK, 0.93);        // squeezed from both sides
    this.speedK = speedK; this.atk = atk; this.vF = vF; this.panic = panic; this.nL = left; this.nR = right;

    // Move the offset toward its target at a human rate, and only really on the straights: through a
    // corner the car holds its lane (a constant offset is the path its speed profile was computed for).
    const turning = Math.min(1, Math.abs(line.curv[idx]) * v * v / 7);
    const rate = (0.8 + 0.035 * v) * (this.mode === 'pass' ? 1.35 : 1) * (1 - 0.8 * turning) * dt;
    const e = this.oT - this.o;
    let o = this.o + (e > rate ? rate : e < -rate ? -rate : e);
    // a car alongside moves my lane over (at once: this is avoidance); when it has gone the offset
    // eases back at the rate above instead of darting at the line
    if (left || right || o !== 0) o = this.lane(idx, t.lineD[idx] + o) - t.lineD[idx];
    this.o = o;
  }
}
function gapOf(ds, sepL) { return ds - sepL; }

// The racing line shifted sideways by `o` metres, clamped to the usable road and smoothed:
// geometry in the shape speedProfile() wants ({ curv, ds }).
function shiftedLine(track, lim, o) {
  const n = track.n;
  let d = new Float64Array(n);
  for (let i = 0; i < n; i++) { const v = track.lineD[i] + o, L = lim[i]; d[i] = v > L ? L : v < -L ? -L : v; }
  for (let pass = 0; pass < 2; pass++) { const s = new Float64Array(n); let a = 0; const R = 8; for (let q = -R; q <= R; q++) a += d[(q + n) % n]; for (let i = 0; i < n; i++) { s[i] = a / (2 * R + 1); a += d[(i + R + 1) % n] - d[(i - R + n) % n]; } d = s; }
  const x = new Float64Array(n), y = new Float64Array(n), ds = new Float64Array(n), hd = new Float64Array(n), curv = new Float64Array(n);
  for (let i = 0; i < n; i++) { const h = track.heading[i]; x[i] = track.x[i] - Math.sin(h) * d[i]; y[i] = track.y[i] + Math.cos(h) * d[i]; }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; ds[i] = Math.hypot(x[j] - x[i], y[j] - y[i]); hd[i] = Math.atan2(y[j] - y[i], x[j] - x[i]); }
  for (let i = 0; i < n; i++) { const p = (i - 1 + n) % n; let dh = hd[i] - hd[p]; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI; curv[i] = dh / (0.5 * (ds[i] + ds[p])); }
  const cs = new Float64Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let q = -4; q <= 4; q++) a += curv[((i + q) % n + n) % n]; cs[i] = a / 9; }
  return { curv: cs, ds };
}

// ---------------------------------------------------------------------- fields
// Build race entries (grid order) for `n` cars.
//   order: grid order, see below
//   klass: 'same' (all the player's car) | 'class' (cars of the player's class) | 'mixed' (prototypes, GT3 and road cars)
//   grid: 1-based grid slot of the player's car; aiPlayer: the player's car gets a RaceDriver too
// The grid is "qualifying with noise": sorted by each driver's predicted lap time plus a random error.
export function buildField(track, { n = 12, car = 'gt3', klass = 'class', difficulty = 0.96, seed = 1, wet = null, grid = null, aiPlayer = false, order = 'quali', cars = CARS } = {}) {
  const rng = new RNG(seed * 104729 + 7);
  const have = (ids) => ids.filter(id => cars[id]);
  const mine = cars[car] ? car : 'gt3';
  let pool;
  if (klass === 'same') pool = [mine];
  else if (klass === 'mixed') pool = null;
  else { pool = have(CLASSES[classOf(mine)]); if (!pool.length) pool = [mine]; }
  const names = DRIVER_NAMES.slice();
  for (let i = names.length - 1; i > 0; i--) { const j = rng.int(i + 1); [names[i], names[j]] = [names[j], names[i]]; }
  const entries = [];
  for (let i = 0; i < n; i++) {
    let id;
    if (i === 0) id = mine;
    else if (pool) id = pool[(i + (klass === 'same' ? 0 : pool.indexOf(mine) >= 0 ? pool.indexOf(mine) : 0)) % pool.length];
    else { const q = i / n, g = have(q < 0.25 ? CLASSES.proto : q < 0.7 ? CLASSES.gt3 : ['f458', 'coupe', 'hatch']); id = g[i % g.length] || mine; }
    const spec = cars[id], personality = makePersonality(rng, difficulty);
    const player = i === 0, ai = !player || aiPlayer;
    const driver = ai ? new RaceDriver(track, spec, { personality, wet, seed: seed * 1000 + i * 17 + 3 }) : null;
    const est = driver ? driver.lapEst : new RaceDriver(track, spec, { personality: { ...personality, skill: difficulty * 0.97 }, wet }).lapEst;
    entries.push({ spec, driver, personality, player, name: player && !aiPlayer ? 'You' : names[i % names.length], number: 2 + i * 3 + rng.int(3), quali: est * (1 + 0.006 * rng.normal()) });
  }
  // order: 'quali' (fastest first, with the noise above) | 'reverse' | 'random'
  if (order === 'reverse') for (const e of entries) e.quali = -e.quali;
  else if (order === 'random') for (const e of entries) e.quali = rng.next();
  const me = entries[0], rest = entries.slice(1).sort((a, b) => a.quali - b.quali);
  let field;
  if (grid === null || grid === undefined) field = [me, ...rest].sort((a, b) => a.quali - b.quali);
  else { const g = Math.max(1, Math.min(n, Math.round(grid))) - 1; field = rest.slice(); field.splice(g, 0, me); }
  return field;
}
