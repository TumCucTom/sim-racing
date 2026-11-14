// Tiny dense network (tanh hidden layers, linear output). Forward pass only
// is needed in the browser; rl/ppo.js adds backprop on top of this layout.
export class MLP {
  constructor(sizes) {
    this.sizes = sizes;
    this.W = []; this.b = []; this.act = [new Float64Array(sizes[0])];
    for (let l = 0; l < sizes.length - 1; l++) {
      this.W.push(new Float64Array(sizes[l] * sizes[l + 1]));
      this.b.push(new Float64Array(sizes[l + 1]));
      this.act.push(new Float64Array(sizes[l + 1]));
    }
  }
  forward(x) {
    const L = this.W.length;
    let a = this.act[0];
    for (let i = 0; i < a.length; i++) a[i] = x[i];
    for (let l = 0; l < L; l++) {
      const W = this.W[l], b = this.b[l], o = this.act[l + 1];
      const nin = this.sizes[l], nout = this.sizes[l + 1];
      for (let j = 0; j < nout; j++) {
        let z = b[j]; const off = j * nin;
        for (let i = 0; i < nin; i++) z += W[off + i] * a[i];
        o[j] = l < L - 1 ? Math.tanh(z) : z;
      }
      a = o;
    }
    return a;
  }
  toJSON() { return { sizes: this.sizes, W: this.W.map(w => Array.from(w, v => +v.toFixed(6))), b: this.b.map(w => Array.from(w, v => +v.toFixed(6))) }; }
  static fromJSON(o) {
    const m = new MLP(o.sizes);
    o.W.forEach((w, l) => m.W[l].set(w)); o.b.forEach((w, l) => m.b[l].set(w));
    return m;
  }
}
