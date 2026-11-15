// Race = N cars on one track, stepped together at 300 Hz in a fixed order.
//
// Each car is a solo `Sim` (vehicle + lap timing, untouched) plus race state.
// What this file adds on top, all deterministic and DOM-free:
//   * car-to-car collision: oriented rectangles, bounding-circle broad phase,
//     separating-axis narrow phase, one impulse with restitution and Coulomb
//     friction per pair and step (momentum-conserving, never adds energy)
//   * slipstream: drag and downforce multipliers on `Vehicle.dragK / downK`
//   * race logic: staggered grid, start lights, positions, gaps, finish and
//     classification, blue flags, stuck/backwards recovery, track-limit penalties
//
// A driver is any object with control(raceCar, race) -> { steer, throttle, brake }.
// A car without a driver is driven by the controls passed to step() (the player).
import { Sim } from './sim.js';
import { SIM_DT } from './vehicle.js';
import { project, poseAt } from './track.js';
import { RNG } from './rng.js';

export const GRID_GAP = 8;            // metres between consecutive grid slots (two-wide, staggered)
const GRID_FIRST = 4;                 // pole position: car centre this far behind the line
const BIN = 25, BIN0 = 400;           // gap timing: time stamps every 25 m of race distance
const RESTITUTION = 0.18, FRICTION = 0.35, SLOP = 0.01, CORRECT = 0.6;
const WAKE_LEN = 120, WAKE_DRAG = 0.50, WAKE_DOWN = 0.12;
const HOLD = { steer: 0, throttle: 0, brake: 1 };
const COAST = { steer: 0, throttle: 0, brake: 0 };

export const SEVERITY = { light: 2, heavy: 6 };   // closing speed at the contact point, m/s
export function severityOf(dv) { return dv < SEVERITY.light ? 'light' : dv < SEVERITY.heavy ? 'medium' : 'heavy'; }

// Grid slot k (0 = pole): arc length (negative = behind the line) and lateral offset.
export function gridSlot(track, k, gap = GRID_GAP) {
  const s = -(GRID_FIRST + gap * k);
  const i = Math.min(track.n - 1, Math.floor((((s % track.length) + track.length) % track.length) / track.ds));
  const lat = Math.min(0.45 * track.hw[i], track.hw[i] - 1.5);
  return { s, d: k % 2 === 0 ? lat : -lat };
}

export class Race {
  // entries: [{ spec, driver?, name?, player?, color? }] in grid order (index 0 = pole)
  // opts: { laps, seed, wet, lights (default true), gridGap, maxRespawns, autoRespawnPlayer }
  constructor(track, entries, opts = {}) {
    this.track = track; this.L = track.length; this.dt = SIM_DT;
    this.opts = { laps: 3, seed: 1, wet: null, lights: true, gridGap: GRID_GAP, maxRespawns: 4, autoRespawnPlayer: false, ...opts };
    this.laps = this.opts.laps;
    this.cars = entries.map((e, index) => {
      const sim = new Sim(track, e.spec), car = sim.car, b = e.spec.body;
      const c = {
        index, spec: e.spec, sim, car, driver: e.driver || null, name: e.name || `Car ${index + 1}`, player: !!e.player, color: e.color ?? null,
        number: e.number ?? index + 1,
        hl: b.length / 2, hw: b.width / 2, cx: (car.a - car.b) / 2, rad: Math.hypot(b.length, b.width) / 2,
        ctrl: { steer: 0, throttle: 0, brake: 1 },
        bins: new Float64Array(256), nextBin: 0,
      };
      sim.onLap = (lt, valid, sectors) => this._onLap(c, lt, valid, sectors);
      return c;
    });
    this.onLap = null; this.onContact = null; this.onEvent = null;
    this._proj = { idx: 0, s: 0, d: 0, frac: 0 };
    this.reset();
  }

  reset() {
    const o = this.opts, t = this.track;
    this.rng = new RNG(o.seed * 7919 + 13);
    this.tick = 0; this.time = 0;
    this.lightsOn = 0; this.green = !o.lights;
    this.greenTime = o.lights ? 5 + this.rng.uniform(0.7, 2.4) : 0;
    this.raceTime = this.green ? 0 : -this.greenTime;
    this.leaderFinished = false; this.leaderFinishTime = null; this.over = false; this.finishers = 0;
    this.events = []; this.pairT = new Map();
    this.overtakes = 0; this.cleanOvertakes = 0; this.overtakeLog = []; this.rel = null;
    this.order = this.cars.map((_, i) => i);
    for (const c of this.cars) {
      const g = gridSlot(t, c.index, o.gridGap);
      c.sim.reset({ s: g.s, d: g.d }); c.sim.setWet(o.wet);
      c.car.dragK = 1; c.car.downK = 1;
      const a = c.car.aids; a.abs = c.spec.abs; a.tc = c.spec.tc; a.autoShift = true;
      Object.assign(c, {
        startS: g.s, gridD: g.d, dist: g.s, pos: c.index + 1, gridPos: c.index + 1,
        finished: false, finishTime: null, finishLaps: 0, retired: false, retireReason: '', classified: 0,
        gapLeader: 0, interval: 0, lapsDown: 0, blue: false, wake: 0,
        hit: 0, hitSide: 0, lastContactT: -1e9, contacts: 0,
        stuckT: 0, wrongT: 0, waitT: 0, needRespawn: false, respawns: 0, lastRespawnT: -1e9,
        offs: 0, strikes: 0, penalty: 0, lastOff: 0, lastOffT: -1e9, walls: 0, lastWallT: -1e9, spins: 0, spinning: false,
        lapTimes: [], bestLap: null, nextBin: 0, lastPos: c.index + 1,
      });
      c.ctrl.steer = 0; c.ctrl.throttle = 0; c.ctrl.brake = 1;
      c.driver?.reset?.(c, this);
    }
    this._positions();
  }

  setWet(wet) { this.opts.wet = wet || null; for (const c of this.cars) c.sim.setWet(wet); }
  get player() { return this.cars.find(c => c.player) || null; }

  // Advance one physics step. `ext` are the controls for driver-less (player) cars.
  step(ext) {
    const cars = this.cars, n = cars.length;
    if (!this.green) {
      this.lightsOn = Math.min(5, Math.floor(this.time));
      if (this.time >= this.greenTime) { this.green = true; this.greenAt = this.time; this.lightsOn = 0; this.onEvent?.('green'); }
    }
    // 1. every driver decides from the same pre-step state
    for (let i = 0; i < n; i++) {
      const c = cars[i]; if (c.retired) continue;
      let u;
      if (!this.green) u = HOLD;
      else if (c.driver) u = c.driver.control(c, this);
      else u = ext || COAST;
      c.ctrl.steer = u.steer; c.ctrl.throttle = u.throttle; c.ctrl.brake = u.brake;
    }
    // 2. integrate each vehicle (solo dynamics, untouched)
    for (let i = 0; i < n; i++) { const c = cars[i]; if (!c.retired) c.sim.step(c.ctrl); }
    this.time += this.dt; this.tick++;
    this.raceTime = this.time - this.greenTime;
    // 3. car-to-car contact as an external impulse stage
    this._collide();
    // 4. slipstream
    if (this.tick % 3 === 0) this._aero();
    // 5. race bookkeeping
    for (let i = 0; i < n; i++) {
      const c = cars[i]; if (c.retired) continue;
      c.dist = c.startS + c.sim.progress;
      const lim = (c.nextBin + 1) * BIN - BIN0;
      if (c.dist >= lim - BIN) {
        while (c.nextBin * BIN - BIN0 <= c.dist) {
          if (c.nextBin >= c.bins.length) { const b = new Float64Array(c.bins.length * 2); b.set(c.bins); c.bins = b; }
          c.bins[c.nextBin++] = this.time;
        }
      }
      if (c.hit > 0) c.hit = Math.max(0, c.hit - this.dt * 6);
      if (this.green) this._watch(c);
    }
    if (this.tick % 15 === 0) this._positions();
    if (this.leaderFinished && !this.over) {
      let running = 0; for (const c of cars) if (!c.retired && !c.finished) running++;
      if (running === 0 || this.raceTime - this.leaderFinishTime > this.finishWindow) this._finishRace();
    }
  }

  // ---------------------------------------------------------------- contact
  _collide() {
    const cars = this.cars, n = cars.length;
    for (let i = 0; i < n; i++) {
      const A = cars[i]; if (A.retired) continue;
      const a = A.car, ca = Math.cos(a.yaw), sa = Math.sin(a.yaw);
      const ax = a.x + A.cx * ca, ay = a.y + A.cx * sa;
      for (let j = i + 1; j < n; j++) {
        const B = cars[j]; if (B.retired) continue;
        const b = B.car;
        const dx0 = b.x - a.x, dy0 = b.y - a.y, rr = A.rad + B.rad + 1.5;
        if (dx0 * dx0 + dy0 * dy0 > rr * rr) continue;           // broad phase
        const cb = Math.cos(b.yaw), sb = Math.sin(b.yaw);
        const bx = b.x + B.cx * cb, by = b.y + B.cx * sb;
        const dx = bx - ax, dy = by - ay;
        // separating axes: the two body axes of each rectangle
        let depth = Infinity, nx = 0, ny = 0;
        for (let k = 0; k < 4; k++) {
          const ux = k === 0 ? ca : k === 1 ? -sa : k === 2 ? cb : -sb, uy = k === 0 ? sa : k === 1 ? ca : k === 2 ? sb : cb;
          const ra = A.hl * Math.abs(ca * ux + sa * uy) + A.hw * Math.abs(-sa * ux + ca * uy);
          const rb = B.hl * Math.abs(cb * ux + sb * uy) + B.hw * Math.abs(-sb * ux + cb * uy);
          const dd = dx * ux + dy * uy, ov = ra + rb - Math.abs(dd);
          if (ov < depth) { depth = ov; if (dd < 0) { nx = -ux; ny = -uy; } else { nx = ux; ny = uy; } if (ov <= 0) break; }
        }
        if (depth <= 0) continue;
        // contact point: average of the corners of each box that lie inside the other
        let px = 0, py = 0, m = 0;
        for (let k = 0; k < 4; k++) {
          const e1 = k < 2 ? 1 : -1, e2 = k % 2 ? -1 : 1;
          let qx = ax + ca * A.hl * e1 - sa * A.hw * e2, qy = ay + sa * A.hl * e1 + ca * A.hw * e2;
          let lx = (qx - bx) * cb + (qy - by) * sb, ly = -(qx - bx) * sb + (qy - by) * cb;
          if (Math.abs(lx) <= B.hl + 1e-6 && Math.abs(ly) <= B.hw + 1e-6) { px += qx; py += qy; m++; }
          qx = bx + cb * B.hl * e1 - sb * B.hw * e2; qy = by + sb * B.hl * e1 + cb * B.hw * e2;
          lx = (qx - ax) * ca + (qy - ay) * sa; ly = -(qx - ax) * sa + (qy - ay) * ca;
          if (Math.abs(lx) <= A.hl + 1e-6 && Math.abs(ly) <= A.hw + 1e-6) { px += qx; py += qy; m++; }
        }
        if (m > 0) { px /= m; py /= m; } else { px = (ax + bx) / 2; py = (ay + by) / 2; }
        // world velocities
        let avx = a.vx * ca - a.vy * sa, avy = a.vx * sa + a.vy * ca, ar = a.r;
        let bvx = b.vx * cb - b.vy * sb, bvy = b.vx * sb + b.vy * cb, br = b.r;
        const rax = px - a.x, ray = py - a.y, rbx = px - b.x, rby = py - b.y;
        const ima = 1 / A.spec.mass, imb = 1 / B.spec.mass, iia = 1 / a.Iz, iib = 1 / b.Iz;
        let rvx = (bvx - br * rby) - (avx - ar * ray), rvy = (bvy + br * rbx) - (avy + ar * rax);
        const vn = rvx * nx + rvy * ny;
        let jn = 0;
        if (vn < 0) {
          const ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx;
          const kn = ima + imb + ran * ran * iia + rbn * rbn * iib;
          jn = -(1 + (vn < -1.5 ? RESTITUTION : 0)) * vn / kn;
          avx -= jn * nx * ima; avy -= jn * ny * ima; ar -= ran * jn * iia;
          bvx += jn * nx * imb; bvy += jn * ny * imb; br += rbn * jn * iib;
          // friction along the contact tangent, limited by the normal impulse
          const tx = -ny, ty = nx;
          rvx = (bvx - br * rby) - (avx - ar * ray); rvy = (bvy + br * rbx) - (avy + ar * rax);
          const vt = rvx * tx + rvy * ty;
          const rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
          const kt = ima + imb + rat * rat * iia + rbt * rbt * iib;
          let jt = -vt / kt; const lim = FRICTION * jn;
          if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
          avx -= jt * tx * ima; avy -= jt * ty * ima; ar -= rat * jt * iia;
          bvx += jt * tx * imb; bvy += jt * ty * imb; br += rbt * jt * iib;
          a.vx = avx * ca + avy * sa; a.vy = -avx * sa + avy * ca; a.r = ar;
          b.vx = bvx * cb + bvy * sb; b.vy = -bvx * sb + bvy * cb; b.r = br;
        }
        // push the bodies apart (split by inverse mass)
        const corr = Math.max(0, depth - SLOP) * CORRECT / (ima + imb);
        if (corr > 0) {
          a.x -= nx * corr * ima; a.y -= ny * corr * ima; b.x += nx * corr * imb; b.y += ny * corr * imb;
          this._reproject(a); this._reproject(b);
        }
        this._contact(A, B, -vn, jn, px, py, nx, ny);
      }
    }
  }

  _reproject(car) {
    const p = project(this.track, car.x, car.y, car.idx, car._proj);
    car.idx = p.idx; car.s = p.s; car.d = p.d;
  }

  _contact(A, B, dv, jn, px, py, nx, ny) {
    const key = A.index * 64 + B.index, t = this.time;
    let ev = this.pairT.get(key);
    if (!ev || t - ev.tLast > 0.5) {
      ev = { t: this.raceTime, a: A.index, b: B.index, dv: Math.max(0, dv), tLast: t, s: A.car.s, lap: Math.max(0, A.sim.lap) };
      this.pairT.set(key, ev); this.events.push(ev); A.contacts++; B.contacts++;
    } else { ev.tLast = t; if (dv > ev.dv) ev.dv = dv; }
    A.lastContactT = B.lastContactT = t;
    if (jn > 0) {
      const ha = jn / A.spec.mass, hb = jn / B.spec.mass;
      if (ha > A.hit) A.hit = ha; if (hb > B.hit) B.hit = hb;
      // which side of each car was hit (+ left / - right in body frame), for audio and the HUD
      const a = A.car, b = B.car;
      A.hitSide = -(px - a.x) * Math.sin(a.yaw) + (py - a.y) * Math.cos(a.yaw) > 0 ? 1 : -1;
      B.hitSide = -(px - b.x) * Math.sin(b.yaw) + (py - b.y) * Math.cos(b.yaw) > 0 ? 1 : -1;
      if (this.onContact && dv > 0.3) this.onContact(A, B, dv, px, py);
    }
  }

  // ---------------------------------------------------------------- slipstream
  _aero() {
    const cars = this.cars, n = cars.length;
    for (let i = 0; i < n; i++) {
      const F = cars[i]; if (F.retired) continue;
      const f = F.car; let k = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const Ld = cars[j]; if (Ld.retired) continue;
        const l = Ld.car, v = l.vx; if (v < 15) continue;
        const dx = f.x - l.x, dy = f.y - l.y;
        if (dx * dx + dy * dy > WAKE_LEN * WAKE_LEN) continue;
        const cy = Math.cos(l.yaw), sy = Math.sin(l.yaw);
        const back = -(dx * cy + dy * sy); if (back < 1.5 || back > WAKE_LEN) continue;
        const lat = -dx * sy + dy * cy, sg = 1.2 + 0.045 * back, q = 1 - back / WAKE_LEN;
        let w = Math.pow(q, 0.8) * Math.exp(-(lat * lat) / (sg * sg)) * Math.min(1, (v - 15) / 25);
        w *= Math.min(1, Math.sqrt(Ld.spec.CdA / F.spec.CdA));
        if (w > k) k = w;
      }
      F.wake = k;
      f.dragK = 1 - WAKE_DRAG * k; f.downK = 1 - WAKE_DOWN * k;
    }
  }

  // ---------------------------------------------------------------- per-car supervision
  _watch(c) {
    const car = c.car, dt = this.dt, sim = c.sim;
    // track limits: all four wheels off = one strike (not when it was caused by a contact)
    if (sim.offCount !== c.lastOff) {
      c.lastOff = sim.offCount; c.offs++; c.lastOffT = this.time;
      if (!c.finished && this.time - c.lastContactT > 2.5 && this.time - c.lastRespawnT > 3) {
        c.strikes++;
        if (c.strikes % 3 === 0) { c.penalty += 5; this.onEvent?.('penalty', c); }
      }
    }
    // incident counters: barrier hits (above walking pace) and spins
    if (car.impact > 1.5 && this.time - c.lastWallT > 1) { c.walls++; c.lastWallT = this.time; }
    const sp = Math.abs(car.headErr) > 1.25; if (sp && !c.spinning) c.spins++; c.spinning = sp;
    if (c.finished) return;
    if (this.raceTime > 6) {
      if (Math.abs(car.vx) < 2.5) c.stuckT += dt; else if (c.stuckT > 0) c.stuckT = Math.max(0, c.stuckT - 4 * dt);
      if (Math.abs(car.headErr) > 1.9) c.wrongT += dt; else c.wrongT = 0;
      // quick when it is plainly out of it (spun, in the wall, on the grass), patient when it is just queueing
      const out = Math.abs(car.headErr) > 1 || car.wallContact > 0 || sim.offTrack;
      const need = (c.stuckT > (out ? 4 : 12) || c.wrongT > 2.5) && (!!c.driver || this.opts.autoRespawnPlayer);
      if (need && !c.needRespawn) c.waitT = 0;
      c.needRespawn = need;
    }
    if (c.needRespawn && this.tick % 30 === 0) {
      c.waitT += 30 * dt;
      if (c.respawns >= this.opts.maxRespawns) { this.retire(c, 'stuck'); return; }
      this.respawn(c);
    }
  }

  // Marshals: put a car back on the road, off the racing line, rolling slowly, at the nearest
  // place (here, else further back, else a little further on) where nobody is about to arrive.
  // Returns false if there is no safe place yet.
  respawn(c) {
    const t = this.track, car = c.car, n = t.n;
    let at = -1;
    for (const off of [0, -25, -50, -80, -120, -160, 25, 50, 80]) {
      const s = car.s + off; let ok = true;
      for (const o of this.cars) {
        if (o === c || o.retired) continue;
        let ds = o.car.s - s; ds -= Math.round(ds / this.L) * this.L;
        if (ds < 14 && ds > -(14 + Math.max(0, o.car.vx) * 1.7)) { ok = false; break; }
      }
      if (ok) { at = ((car.idx + Math.round(off / t.ds)) % n + n) % n; break; }
    }
    if (at < 0) return false;
    const i = at, lim = Math.max(0, t.hw[i] - c.hw - 0.6), side = t.lineD[i] > 0 ? -1 : 1, d = side * lim * 0.8;
    const h = t.heading[i], x = t.x[i] - Math.sin(h) * d, y = t.y[i] + Math.cos(h) * d;
    const wet = car.wet, s0 = car.s;
    car.reset({ x, y, yaw: h, speed: 12, idxHint: i }); car.wet = wet; car.dragK = 1; car.downK = 1;
    // being moved along the track is not progress (and must not trip the lap gates)
    let moved = car.s - s0; moved -= Math.round(moved / this.L) * this.L;
    c.sim.prevS = car.s; c.sim.lapValid = false; c.sim.offTrack = false; c.startS += moved;
    c.stuckT = 0; c.wrongT = 0; c.needRespawn = false; c.respawns++; c.lastRespawnT = this.time;
    c.driver?.onRespawn?.(c, this);
    this.onEvent?.('respawn', c);
    return true;
  }

  retire(c, reason = 'retired') {
    if (c.retired || c.finished) return;
    c.retired = true; c.retireReason = reason; c.needRespawn = false;
    c.car.vx = 0; c.car.vy = 0; c.car.r = 0;
    this.onEvent?.('dnf', c);
    this._positions();
  }

  // ---------------------------------------------------------------- timing
  _onLap(c, lt, valid, sectors) {
    c.lapTimes.push(lt);
    if (c.bestLap === null || lt < c.bestLap) c.bestLap = lt;
    this.onLap?.(c, lt, valid, sectors);
    if (c.finished || c.retired) return;
    if (this.leaderFinished || c.sim.lap >= this.laps) {
      c.finished = true; c.finishLaps = c.sim.lap; c.finishTime = c.sim.lapStart + lt - this.greenTime; c.finishOrder = this.finishers++;
      if (!this.leaderFinished) {
        this.leaderFinished = true; this.leaderFinishTime = c.finishTime;
        // everybody still running gets to complete the lap they are on
        let slow = c.bestLap ?? 90; for (const o of this.cars) if (!o.retired && o.bestLap !== null && o.bestLap > slow) slow = o.bestLap;
        this.finishWindow = Math.max(60, 1.15 * slow);
      }
      this.onEvent?.('finish', c);
      this._positions();
    }
  }

  // time gap from car `a` back to where car `b` (ahead of it) was at a's present distance
  gap(a, b) {
    const f = (a.dist + BIN0) / BIN, i0 = Math.floor(f);
    if (i0 < 0 || i0 + 1 >= b.nextBin) return 0;
    const tb = b.bins[i0] + (b.bins[i0 + 1] - b.bins[i0]) * (f - i0);
    return Math.max(0, this.time - tb);
  }

  _positions() {
    const cars = this.cars, ord = this.order;
    // finished cars by classification, then running cars by distance, then retirements
    const key = (c) => (c.finished ? 2 : c.retired ? 0 : 1);
    ord.sort((i, j) => {
      const a = cars[i], b = cars[j], ka = key(a), kb = key(b);
      if (ka !== kb) return kb - ka;
      if (ka === 2) return a.finishLaps !== b.finishLaps ? b.finishLaps - a.finishLaps : a.finishOrder - b.finishOrder;
      return b.dist !== a.dist ? b.dist - a.dist : i - j;
    });
    const lead = cars[ord[0]];
    for (let p = 0; p < ord.length; p++) {
      const c = cars[ord[p]];
      c.pos = p + 1;
      if (c.finished || c.retired) continue;
      const ahead = p > 0 ? cars[ord[p - 1]] : null;
      c.lapsDown = Math.max(0, Math.floor((lead.dist - c.dist) / this.L));
      c.gapLeader = p === 0 || lead.finished ? (p === 0 ? 0 : c.gapLeader) : this.gap(c, lead);
      c.interval = ahead && !ahead.finished && !ahead.retired ? this.gap(c, ahead) : (p === 0 ? 0 : c.interval);
    }
    // overtakes: an established order between two running cars flips by more than 5 m of
    // race distance. Lap 1 (the start shuffle) and cars that are stopped or were just
    // respawned do not count.
    if (this.green) {
      const n = cars.length, rel = this.rel || (this.rel = new Int8Array(n * n));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = cars[i], b2 = cars[j]; if (a.retired || b2.retired || a.finished || b2.finished) continue;
        const diff = a.dist - b2.dist, was = rel[i * n + j] || 1;      // 1: i ahead (grid order), -1: j ahead
        const now = diff > 5 ? 1 : diff < -5 ? -1 : was;
        if (now !== was) {
          const by = now > 0 ? a : b2, on = now > 0 ? b2 : a;
          if (by.sim.lap >= 1 && on.sim.lap >= 1 && this.time - on.lastRespawnT > 6 && this.time - by.lastRespawnT > 6 && !on.needRespawn && on.car.vx > 8) {
            const ev = this.pairT.get(i * 64 + j), touched = !!ev && this.time - ev.tLast < 4;
            const clean = !touched && on.car.vx > 0.7 * by.car.vx && this.time - on.lastOffT > 4;
            this.overtakes++; if (clean) this.cleanOvertakes++;
            this.overtakeLog.push({ t: this.raceTime, by: by.index, on: on.index, s: by.car.s, lap: by.sim.lap, clean });
          }
        }
        rel[i * n + j] = now;
      }
    }
    // blue flags: a car a lap (or more) ahead is close behind on the road
    for (const c of cars) {
      c.blue = false; if (c.retired || c.finished) continue;
      for (const o of cars) {
        if (o === c || o.retired) continue;
        if (o.dist - c.dist < this.L * 0.5) continue;
        let ds = c.car.s - o.car.s; if (ds < 0) ds += this.L;
        if (ds < 70) { c.blue = true; break; }
      }
    }
  }

  _finishRace() {
    this.over = true;
    this._positions();
    this.onEvent?.('over');
  }

  // Final classification (also usable mid-race). Time penalties are applied to finishers.
  classification() {
    const rows = this.cars.map(c => ({
      index: c.index, name: c.name, car: c.spec.id, carName: c.spec.name, player: c.player, grid: c.gridPos,
      laps: c.finished ? c.finishLaps : Math.max(0, c.sim.lap), finished: c.finished, retired: c.retired, reason: c.retireReason,
      time: c.finished ? c.finishTime + c.penalty : null, penalty: c.penalty, dist: c.dist,
      bestLap: c.bestLap, lapTimes: c.lapTimes.slice(), contacts: c.contacts, offs: c.offs, strikes: c.strikes, respawns: c.respawns, walls: c.walls, spins: c.spins,
    }));
    const key = (r) => (r.finished ? 2 : r.retired ? 0 : 1);
    rows.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka !== kb) return kb - ka;
      if (ka === 2) return a.laps !== b.laps ? b.laps - a.laps : a.time - b.time;
      return b.dist - a.dist;
    });
    rows.forEach((r, i) => { r.pos = i + 1; });
    const w = rows[0];
    for (const r of rows) r.gap = r.finished && w.finished ? (r.laps === w.laps ? r.time - w.time : null) : null;
    return rows;
  }

  // 32-bit FNV-1a over every car's state: equal hashes <=> identical races.
  hash() {
    const f = new Float64Array(1), u = new Uint8Array(f.buffer);
    let h = 0x811c9dc5;
    const add = (v) => { f[0] = v; for (let k = 0; k < 8; k++) { h ^= u[k]; h = Math.imul(h, 0x01000193); } };
    add(this.time); add(this.events.length); add(this.overtakes);
    for (const c of this.cars) { for (const v of c.car.snapshot()) add(v); add(c.dist); add(c.pos); add(c.sim.lap); add(c.penalty); add(c.respawns); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // total linear momentum and kinetic energy of the field (tests)
  momentum() {
    let px = 0, py = 0, ke = 0;
    for (const c of this.cars) {
      const a = c.car, cy = Math.cos(a.yaw), sy = Math.sin(a.yaw), m = c.spec.mass;
      px += m * (a.vx * cy - a.vy * sy); py += m * (a.vx * sy + a.vy * cy);
      ke += 0.5 * m * (a.vx * a.vx + a.vy * a.vy) + 0.5 * a.Iz * a.r * a.r;
    }
    return { px, py, ke };
  }
}

// Do two race cars' body rectangles overlap by more than `tol` metres? (tests and tools)
export function overlapDepth(A, B) {
  const a = A.car, b = B.car, ca = Math.cos(a.yaw), sa = Math.sin(a.yaw), cb = Math.cos(b.yaw), sb = Math.sin(b.yaw);
  const dx = b.x + B.cx * cb - a.x - A.cx * ca, dy = b.y + B.cx * sb - a.y - A.cx * sa;
  let depth = Infinity;
  for (let k = 0; k < 4; k++) {
    const ux = k === 0 ? ca : k === 1 ? -sa : k === 2 ? cb : -sb, uy = k === 0 ? sa : k === 1 ? ca : k === 2 ? sb : cb;
    const ra = A.hl * Math.abs(ca * ux + sa * uy) + A.hw * Math.abs(-sa * ux + ca * uy);
    const rb = B.hl * Math.abs(cb * ux + sb * uy) + B.hw * Math.abs(-sb * ux + cb * uy);
    depth = Math.min(depth, ra + rb - Math.abs(dx * ux + dy * uy));
  }
  return depth;
}
export { poseAt };
