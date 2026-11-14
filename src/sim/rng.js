// Deterministic PRNG (mulberry32). All randomness in the sim / RL stack flows
// through this so that a seed fully determines a run.
export class RNG {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 0x9e3779b9;
    this._spare = null;
  }
  next() {
    let t = (this.s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  normal() {
    if (this._spare !== null) { const v = this._spare; this._spare = null; return v; }
    let u, v, r;
    do { u = 2 * this.next() - 1; v = 2 * this.next() - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
    const f = Math.sqrt(-2 * Math.log(r) / r);
    this._spare = v * f;
    return u * f;
  }
}
