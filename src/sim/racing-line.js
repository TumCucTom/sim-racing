// Racing line by minimum-curvature optimisation.
//
// The line is the centreline shifted sideways by alpha(s), |alpha| limited to
// the usable road width. We minimise the sum of squared second differences of
// the path (a discrete curvature energy) by projected Gauss-Seidel, coarse to
// fine. The result is the classic out-in-out line: widest possible radius
// through every corner, linked smoothly between corners. Deterministic.

function sweepLevel(track, step, alpha, margin, sweeps, kerbUse) {
  const n = track.n, m = Math.floor(n / step);
  const cx = new Float64Array(m), cy = new Float64Array(m), nx = new Float64Array(m), ny = new Float64Array(m), lim = new Float64Array(m);
  const px = new Float64Array(m), py = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = k * step, h = track.heading[i];
    cx[k] = track.x[i]; cy[k] = track.y[i]; nx[k] = -Math.sin(h); ny[k] = Math.cos(h);
    // narrowest usable half-width over the span this node represents
    let w = Infinity;
    for (let q = -step; q <= step; q++) { const j = ((i + q) % n + n) % n; w = Math.min(w, track.hw[j] + (track.kerb[j] ? kerbUse : 0)); }
    lim[k] = Math.max(0.2, w - margin);
    if (alpha[k] > lim[k]) alpha[k] = lim[k]; else if (alpha[k] < -lim[k]) alpha[k] = -lim[k];
    px[k] = cx[k] + alpha[k] * nx[k]; py[k] = cy[k] + alpha[k] * ny[k];
  }
  const omega = 1.6; // over-relaxation
  for (let it = 0; it < sweeps; it++) {
    for (let k = 0; k < m; k++) {
      const a = (k - 2 + m) % m, b = (k - 1 + m) % m, c = (k + 1) % m, d = (k + 2) % m;
      const Ax = px[a] - 2 * px[b] + cx[k], Ay = py[a] - 2 * py[b] + cy[k];
      const Bx = px[b] + px[c] - 2 * cx[k], By = py[b] + py[c] - 2 * cy[k];
      const Cx = cx[k] - 2 * px[c] + px[d], Cy = cy[k] - 2 * py[c] + py[d];
      const An = Ax * nx[k] + Ay * ny[k], Bn = Bx * nx[k] + By * ny[k], Cn = Cx * nx[k] + Cy * ny[k];
      let al = alpha[k] + omega * ((-An + 2 * Bn - Cn) / 6 - alpha[k]);
      if (al > lim[k]) al = lim[k]; else if (al < -lim[k]) al = -lim[k];
      alpha[k] = al; px[k] = cx[k] + al * nx[k]; py[k] = cy[k] + al * ny[k];
    }
  }
  return m;
}

export function computeRacingLine(track, { margin = 1.25, kerbUse = 0.5 } = {}) {
  const n = track.n;
  let alpha = null, prevStep = 0;
  for (const [step, sweeps] of [[24, 600], [12, 500], [6, 400], [3, 300]]) {
    const m = Math.floor(n / step), next = new Float64Array(m);
    if (alpha) {
      // prolong the coarser solution
      const pm = alpha.length;
      for (let k = 0; k < m; k++) { const f = (k * step) / prevStep, i0 = Math.floor(f) % pm, t = f - Math.floor(f); next[k] = alpha[i0] * (1 - t) + alpha[(i0 + 1) % pm] * t; }
    }
    alpha = next; prevStep = step;
    sweepLevel(track, step, alpha, margin, sweeps, kerbUse);
  }
  // back to every sample, lightly smoothed
  const m = alpha.length, step = prevStep;
  let d = new Float64Array(n);
  for (let i = 0; i < n; i++) { const f = i / step, i0 = Math.floor(f) % m, t = f - Math.floor(f); d[i] = alpha[i0] * (1 - t) + alpha[(i0 + 1) % m] * t; }
  for (let pass = 0; pass < 2; pass++) { const s = new Float64Array(n); for (let i = 0; i < n; i++) { let a = 0; for (let q = -3; q <= 3; q++) a += d[((i + q) % n + n) % n]; s[i] = a / 7; } d = s; }
  const x = new Float64Array(n), y = new Float64Array(n), ds = new Float64Array(n), curv = new Float64Array(n), hd = new Float64Array(n);
  for (let i = 0; i < n; i++) { const h = track.heading[i]; x[i] = track.x[i] - Math.sin(h) * d[i]; y[i] = track.y[i] + Math.cos(h) * d[i]; }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; ds[i] = Math.hypot(x[j] - x[i], y[j] - y[i]); hd[i] = Math.atan2(y[j] - y[i], x[j] - x[i]); }
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n; let dh = hd[i] - hd[p];
    while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    curv[i] = dh / (0.5 * (ds[i] + ds[p]));
  }
  // smooth curvature a little (finite-difference noise)
  const cs = new Float64Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let q = -4; q <= 4; q++) a += curv[((i + q) % n + n) % n]; cs[i] = a / 9; }
  let len = 0; for (let i = 0; i < n; i++) len += ds[i];
  return { d, x, y, ds, curv: cs, heading: hd, length: len };
}
