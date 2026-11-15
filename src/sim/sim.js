// Sim = one car on the track + lap timing + track-limit bookkeeping.
// Shared verbatim by the browser game, the headless RL environment and tests.
import { Vehicle, SIM_DT } from './vehicle.js';
import { poseAt, trackEdge } from './track.js';

export class Sim {
  constructor(track, spec) {
    this.track = track;
    this.car = new Vehicle(spec, track);
    this.dt = SIM_DT;
    this.onLap = null;
    this.reset();
  }

  // Place the car at arc length s (default: grid slot just before the line).
  reset({ s = -12, d = 0, speed = 0, headingOffset = 0 } = {}) {
    const t = this.track;
    const p = poseAt(t, s, d);
    this.car.reset({ x: p.x, y: p.y, yaw: p.heading + headingOffset, speed, idxHint: p.idx });
    this.time = 0;
    this.lap = 0;                 // completed laps
    this.lapStart = null;         // sim time the current lap started (null until first line crossing)
    this.lastLap = null; this.bestLap = null;
    this.lapValid = true;
    this.sectorIdx = 0;
    this.sectorTimes = []; this.lastSectors = null; this.bestSectors = null;
    this.sectorStart = 0;
    this.prevS = this.car.s;
    this.progress = 0;            // total signed metres travelled along the lap
    this.offTrack = false; this.offCount = 0;
    this.nextGate = s < 0 || s > t.length * 0.9 ? 0 : -1; // -1: must reach S1 first
    this.gate = 0;
    this._armGates(s);
  }

  // Wet track: a state from src/sim/wet.js, or null for dry (the default). Survives reset().
  setWet(wet) { this.car.wet = wet || null; }

  _armGates(s) {
    const t = this.track;
    const sm = ((s % t.length) + t.length) % t.length;
    // which sector are we in?
    const b1 = t.s[t.sectors[1]], b2 = t.s[t.sectors[2]];
    this.sectorIdx = sm < b1 ? 0 : sm < b2 ? 1 : 2;
    // starting behind the line on the grid counts as "sector 3 of lap 0"
    this.passed = [false, sm >= b1 || s < 0, sm >= b2 || s < 0];
  }

  step(controls) {
    const car = this.car, t = this.track;
    car.step(this.dt, controls);
    this.time += this.dt;
    // progress with wrap handling
    let ds = car.s - this.prevS;
    if (ds < -t.length / 2) ds += t.length; else if (ds > t.length / 2) ds -= t.length;
    this.progress += ds;
    const L = t.length;

    // track limits: all four wheels beyond the line/kerb
    const off = car.wheelsOff() === 4;
    if (off && !this.offTrack) { this.offCount++; }
    this.offTrack = off;
    if (off) this.lapValid = false;

    // sector gates
    const b1 = t.s[t.sectors[1]], b2 = t.s[t.sectors[2]];
    if (ds > 0) {
      if (!this.passed[1] && this.prevS < b1 && car.s >= b1 && car.s - this.prevS < 50) this._sector(1, (b1 - this.prevS) / ds);
      if (this.passed[1] && !this.passed[2] && this.prevS < b2 && car.s >= b2 && car.s - this.prevS < 50) this._sector(2, (b2 - this.prevS) / ds);
      if (car.s < this.prevS - L / 2) {
        // crossed start/finish going forward
        const frac = (L - this.prevS) / ds;
        const tc = this.time - this.dt * (1 - frac);
        if (this.lapStart !== null && this.passed[1] && this.passed[2]) {
          const lt = tc - this.lapStart;
          this.sectorTimes[2] = tc - this.sectorStart;
          this.lastLap = lt; this.lastLapValid = this.lapValid;
          this.lastSectors = this.sectorTimes.slice();
          this.lap++;
          if (this.lapValid && (this.bestLap === null || lt < this.bestLap)) { this.bestLap = lt; this.bestSectors = this.lastSectors; }
          if (this.onLap) this.onLap(lt, this.lapValid, this.lastSectors);
        }
        if (this.lapStart === null || (this.passed[1] && this.passed[2])) {
          this.lapStart = tc; this.sectorStart = tc; this.sectorTimes = [];
          this.lapValid = !off; this.passed = [true, false, false]; this.sectorIdx = 0;
        }
      }
    }
    this.prevS = car.s;
  }

  _sector(k, frac) {
    const tc = this.time - this.dt * (1 - frac);
    if (this.lapStart !== null) this.sectorTimes[k - 1] = tc - this.sectorStart;
    this.sectorStart = tc; this.passed[k] = true; this.sectorIdx = k;
  }

  get lapTime() { return this.lapStart === null ? 0 : this.time - this.lapStart; }
  edge() { return trackEdge(this.track, this.car.idx); }
}
