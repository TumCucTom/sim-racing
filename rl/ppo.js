// Minimal PPO (clip) with Gaussian policy, GAE and Adam — dependency-free so
// the learner runs against the exact simulation code that ships to the browser.
import { MLP } from '../src/sim/drivers/mlp.js';
import { policyMean, MIRROR } from '../src/sim/drivers/rl-interface.js';

export class Net extends MLP {
  constructor(sizes) {
    super(sizes);
    this.gW = this.W.map(w => new Float64Array(w.length));
    this.gb = this.b.map(w => new Float64Array(w.length));
    this.delta = this.act.map(a => new Float64Array(a.length));
  }
  init(rng, outScale = 0.01) {
    const L = this.W.length;
    for (let l = 0; l < L; l++) {
      const nin = this.sizes[l], nout = this.sizes[l + 1];
      const lim = Math.sqrt(6 / (nin + nout)) * (l === L - 1 ? outScale : 1);
      for (let i = 0; i < this.W[l].length; i++) this.W[l][i] = rng.uniform(-lim, lim);
      this.b[l].fill(0);
    }
    return this;
  }
  zeroGrad() { for (const g of this.gW) g.fill(0); for (const g of this.gb) g.fill(0); }
  // Accumulate gradients for the sample last passed to forward().
  backward(dOut) {
    const L = this.W.length;
    let d = this.delta[L];
    for (let j = 0; j < d.length; j++) d[j] = dOut[j];
    for (let l = L - 1; l >= 0; l--) {
      const nin = this.sizes[l], nout = this.sizes[l + 1];
      const a = this.act[l], W = this.W[l], gW = this.gW[l], gb = this.gb[l], dp = this.delta[l];
      if (l > 0) dp.fill(0);
      for (let j = 0; j < nout; j++) {
        const dj = d[j]; if (dj === 0) continue;
        gb[j] += dj; const off = j * nin;
        for (let i = 0; i < nin; i++) gW[off + i] += dj * a[i];
        if (l > 0) for (let i = 0; i < nin; i++) dp[i] += dj * W[off + i];
      }
      if (l > 0) { for (let i = 0; i < nin; i++) dp[i] *= 1 - a[i] * a[i]; d = dp; }
    }
  }
  params() { return [...this.W, ...this.b]; }
  grads() { return [...this.gW, ...this.gb]; }
}

export class Adam {
  constructor(params, lr = 3e-4) {
    this.p = params; this.lr = lr; this.t = 0;
    this.m = params.map(p => new Float64Array(p.length));
    this.v = params.map(p => new Float64Array(p.length));
  }
  step(grads, scale = 1) {
    this.t++;
    const b1 = 0.9, b2 = 0.999, c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
    for (let k = 0; k < this.p.length; k++) {
      const p = this.p[k], g = grads[k], m = this.m[k], v = this.v[k];
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] * scale;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        p[i] -= this.lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8);
      }
    }
  }
}

function gradNorm(gs) { let s = 0; for (const g of gs) for (let i = 0; i < g.length; i++) s += g[i] * g[i]; return Math.sqrt(s); }

export class PPO {
  constructor({ obsDim, actDim, rng, hidden = [64, 64], lr = 3e-4, gamma = 0.992, lam = 0.95, clip = 0.2,
    entCoef = 0.002, epochs = 5, minibatch = 512, maxGrad = 0.5, initLogStd = -0.7 }) {
    Object.assign(this, { obsDim, actDim, rng, gamma, lam, clip, entCoef, epochs, minibatch, maxGrad, lr0: lr });
    this.pi = new Net([obsDim, ...hidden, actDim]).init(rng, 0.01);
    this.vf = new Net([obsDim, ...hidden, 1]).init(rng, 1.0);
    this.logStd = new Float64Array(actDim).fill(initLogStd);
    this.gLogStd = new Float64Array(actDim);
    this.tmp = new Float64Array(obsDim); this.mu = new Float64Array(actDim);
    this.optPi = new Adam([...this.pi.params(), this.logStd], lr);
    this.optVf = new Adam(this.vf.params(), lr);
  }
  setLr(lr) { this.optPi.lr = lr; this.optVf.lr = lr; }

  // Sample an action; returns log-prob. `act` is filled in place.
  act(obs, act) {
    const mu = policyMean(this.pi, obs, this.tmp, this.mu);
    let logp = 0;
    for (let j = 0; j < this.actDim; j++) {
      const sd = Math.exp(this.logStd[j]);
      const e = this.rng.normal();
      act[j] = mu[j] + sd * e;
      logp += -0.5 * e * e - this.logStd[j] - 0.9189385332046727;
    }
    return logp;
  }
  value(obs) { return this.vf.forward(obs)[0]; }

  // buf: { n, obs, act, logp, adv, ret }
  update(buf) {
    const { n } = buf, od = this.obsDim, ad = this.actDim;
    // normalise advantages
    let mean = 0; for (let i = 0; i < n; i++) mean += buf.adv[i]; mean /= n;
    let sd = 0; for (let i = 0; i < n; i++) sd += (buf.adv[i] - mean) ** 2; sd = Math.sqrt(sd / n) + 1e-8;
    const idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
    const dPi = new Float64Array(ad), dV = new Float64Array(1);
    const stats = { piLoss: 0, vLoss: 0, kl: 0, clipFrac: 0, count: 0 };
    for (let ep = 0; ep < this.epochs; ep++) {
      for (let i = n - 1; i > 0; i--) { const j = this.rng.int(i + 1); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
      for (let start = 0; start + this.minibatch <= n; start += this.minibatch) {
        this.pi.zeroGrad(); this.vf.zeroGrad(); this.gLogStd.fill(0);
        const B = this.minibatch;
        for (let q = 0; q < B; q++) {
          const s = idx[start + q];
          const obs = buf.obs.subarray(s * od, (s + 1) * od);
          // symmetric, tanh-squashed mean (leaves the net holding the mirrored pass)
          const mu = policyMean(this.pi, obs, this.tmp, this.mu);
          let logp = 0;
          for (let j = 0; j < ad; j++) {
            const sdj = Math.exp(this.logStd[j]);
            const z = (buf.act[s * ad + j] - mu[j]) / sdj;
            logp += -0.5 * z * z - this.logStd[j] - 0.9189385332046727;
          }
          const A = (buf.adv[s] - mean) / sd;
          const lr_ = logp - buf.logp[s];
          const ratio = Math.exp(lr_ > 20 ? 20 : lr_ < -20 ? -20 : lr_);
          const clipped = (A > 0 && ratio > 1 + this.clip) || (A < 0 && ratio < 1 - this.clip);
          const dLdLogp = clipped ? 0 : -A * ratio;
          for (let j = 0; j < ad; j++) {
            const sdj = Math.exp(this.logStd[j]);
            const z = (buf.act[s * ad + j] - mu[j]) / sdj;
            // d/d(pre-tanh mean), halved because each pass contributes half
            dPi[j] = dLdLogp * z / sdj / B * (1 - mu[j] * mu[j]) * 0.5;
            this.gLogStd[j] += (dLdLogp * (z * z - 1) - this.entCoef) / B;
          }
          if (!clipped) {
            dPi[0] = -dPi[0]; this.pi.backward(dPi);      // mirrored pass: steer enters negated
            dPi[0] = -dPi[0]; this.pi.forward(obs); this.pi.backward(dPi);
          }
          const v = this.vf.forward(obs)[0];
          const err = v - buf.ret[s];
          dV[0] = err / B;
          this.vf.backward(dV);
          stats.piLoss += -A * Math.min(ratio, A > 0 ? 1 + this.clip : Infinity); stats.vLoss += 0.5 * err * err;
          stats.kl += -lr_; stats.clipFrac += clipped ? 1 : 0; stats.count++;
        }
        const gp = [...this.pi.grads(), this.gLogStd];
        const np = gradNorm(gp); this.optPi.step(gp, np > this.maxGrad ? this.maxGrad / np : 1);
        const gv = this.vf.grads();
        const nv = gradNorm(gv); this.optVf.step(gv, nv > this.maxGrad ? this.maxGrad / nv : 1);
        for (let j = 0; j < ad; j++) this.logStd[j] = Math.max(-2.6, Math.min(0.0, this.logStd[j]));
      }
    }
    for (const k of ['piLoss', 'vLoss', 'kl', 'clipFrac']) stats[k] /= stats.count;
    return stats;
  }

  exportPolicy(meta = {}) {
    return { ...meta, symmetric: true, squash: true, policy: this.pi.toJSON(), logStd: Array.from(this.logStd) };
  }
}
