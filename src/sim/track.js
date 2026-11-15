// Circuits. Each track is a closed centreline resampled at uniform ~1 m
// arc-length spacing, with per-sample half-width, heading, curvature,
// elevation, grade, kerbs, run-off type and wall offsets precomputed into
// typed arrays so physics lookups are allocation-free and deterministic.
//
//  * "Ravenscar Ridge" is an original 2.9 km circuit defined by hand-placed
//    spline control points (used for the RL benchmark).
//  * Silverstone, Spa-Francorchamps and Monza use surveyed centreline and
//    left/right track-width data from the open TUMFTM racetrack-database
//    (LGPL-3.0). That data has no height channel, so their elevation is a
//    hand-approximated profile — see each JSON's `source` note.
import silverstone from './tracks/silverstone.json' with { type: 'json' };
import spa from './tracks/spa.json' with { type: 'json' };
import monza from './tracks/monza.json' with { type: 'json' };

export const SURF = { ASPHALT: 0, KERB: 1, GRASS: 2, GRAVEL: 3 };

// [x, y] in metres. Driven counter-clockwise. Start/finish is on the long
// bottom straight heading +x.
const CONTROL_POINTS = [
  [-300, 0], [-120, 0], [80, 0], [270, 0],        // start/finish straight
  [372, 6], [424, 52], [432, 120],                // T1  "Anvil" (heavy braking left)
  [418, 178], [446, 236], [436, 300],             // T2/T3 "Switchback" esses
  [392, 362], [310, 398], [200, 404],             // T4  "Longbow" (long left sweeper)
  [70, 392], [-50, 384],                          // back straight
  [-128, 368], [-170, 320], [-140, 268],          // T5  "Crow's Nest" hairpin
  [-70, 256], [20, 262],                          // short chute
  [100, 244], [136, 190], [112, 132],             // T6/T7 "Quarry" double right
  [40, 108], [-90, 112], [-200, 128],             // T8  flat-out kink
  [-300, 150], [-388, 140],                       // T9  "Kestrel" fast left
  [-440, 96], [-446, 40], [-404, 4],              // T10 "Home" final corner
];

const KERB_WIDTH = 1.5;
const DS = 1.0;

export const TRACKS = {
  ravenscar: { id: 'ravenscar', name: 'Ravenscar Ridge', country: 'Original circuit', real: false },
  silverstone: { ...silverstone, real: true },
  spa: { ...spa, real: true },
  monza: { ...monza, real: true },
};
export const TRACK_ORDER = ['ravenscar', 'silverstone', 'spa', 'monza'];

function catmullRomClosed(pts, perSeg = 40) {
  const n = pts.length;
  const out = [];
  const alpha = 0.5;
  const tj = (ti, a, b) => ti + Math.pow(Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1])), alpha);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let k = 0; k < perSeg; k++) {
      const t = t1 + (t2 - t1) * (k / perSeg);
      const o = [0, 0];
      for (let c = 0; c < 2; c++) {
        const A1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
        const A2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
        const A3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
        const B1 = (t2 - t) / (t2 - t0) * A1 + (t - t0) / (t2 - t0) * A2;
        const B2 = (t3 - t) / (t3 - t1) * A2 + (t - t1) / (t3 - t1) * A3;
        o[c] = (t2 - t) / (t2 - t1) * B1 + (t - t1) / (t2 - t1) * B2;
      }
      out.push(o);
    }
  }
  return out;
}

function smoothClosed(arr, passes, radius) {
  const n = arr.length;
  let a = Float64Array.from(arr);
  let b = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += a[(k + n) % n];
    for (let i = 0; i < n; i++) {
      b[i] = acc / (2 * radius + 1);
      acc += a[(i + radius + 1) % n] - a[(i - radius + n) % n];
    }
    [a, b] = [b, a];
  }
  return a;
}

// Periodic smooth interpolation of [fraction, value] key points.
function periodicProfile(keys, u) {
  const m = keys.length;
  let k = 0; while (k < m - 1 && keys[k + 1][0] <= u) k++;
  const a = keys[k], b = keys[(k + 1) % m];
  const span = (k === m - 1 ? 1 + b[0] : b[0]) - a[0];
  const t = (u - a[0]) / span, f = t * t * (3 - 2 * t);
  return a[1] + (b[1] - a[1]) * f;
}

const cache = new Map();
export function buildTrack(id = 'ravenscar') {
  if (cache.has(id)) return cache.get(id);
  const def = TRACKS[id];
  if (!def) throw new Error(`unknown track ${id}`);
  const real = !!def.pts;
  // dense polyline [x, y, halfWidth]
  let dense;
  if (real) {
    // shift the surveyed centreline to the true middle of the road
    const P = def.pts, m = P.length, mid = [];
    for (let i = 0; i < m; i++) {
      const a = P[(i - 1 + m) % m], b = P[(i + 1) % m], h = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const off = (P[i][3] - P[i][2]) / 2;
      mid.push([P[i][0] - Math.sin(h) * off, P[i][1] + Math.cos(h) * off, (P[i][2] + P[i][3]) / 2]);
    }
    dense = catmullRomClosed(mid, 6);
    for (let i = 0; i < dense.length; i++) { const k = Math.floor(i / 6), f = (i % 6) / 6; dense[i].push(mid[k][2] + (mid[(k + 1) % m][2] - mid[k][2]) * f); }
  } else {
    dense = catmullRomClosed(CONTROL_POINTS, 60);
    for (const d of dense) d.push(6.5);
  }
  const dn = dense.length;
  const cum = new Float64Array(dn + 1);
  for (let i = 0; i < dn; i++) {
    const a = dense[i], b = dense[(i + 1) % dn];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const rawLen = cum[dn];
  const n = Math.round(rawLen / DS);
  const ds = rawLen / n;
  let x = new Float64Array(n), y = new Float64Array(n), hw = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    while (cum[j + 1] < s) j++;
    const f = (s - cum[j]) / (cum[j + 1] - cum[j]);
    const a = dense[j], b = dense[(j + 1) % dn];
    x[i] = a[0] + (b[0] - a[0]) * f;
    y[i] = a[1] + (b[1] - a[1]) * f;
    hw[i] = a[2] + (b[2] - a[2]) * f;
  }
  // light smoothing removes curvature discontinuities at spline joints
  const sr = real ? 3 : 6;
  x = smoothClosed(x, 2, sr); y = smoothClosed(y, 2, sr); hw = smoothClosed(hw, 2, 8);
  let HALF_WIDTH = 0; for (let i = 0; i < n; i++) HALF_WIDTH += hw[i]; HALF_WIDTH /= n;

  const heading = new Float64Array(n), curv = new Float64Array(n);
  const segLen = new Float64Array(n), sArr = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    segLen[i] = Math.hypot(x[i1] - x[i], y[i1] - y[i]);
    sArr[i + 1] = sArr[i] + segLen[i];
    heading[i] = Math.atan2(y[i1] - y[i], x[i1] - x[i]);
  }
  const length = sArr[n];
  for (let i = 0; i < n; i++) {
    const ip = (i - 1 + n) % n;
    let dh = heading[i] - heading[ip];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    curv[i] = dh / (0.5 * (segLen[i] + segLen[ip]));
  }
  const curvS = smoothClosed(curv, 2, 4);

  // Elevation. Ravenscar: analytic, ~23 m relief, grades up to ~4 %.
  let z = new Float64Array(n); const grade = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = sArr[i] / length, u = f * 2 * Math.PI;
    z[i] = real ? periodicProfile(def.elevation, f)
      : 14 + 9.0 * Math.sin(u - 1.9) + 4.0 * Math.sin(2 * u + 0.6) + 1.5 * Math.sin(5 * u + 2.0);
  }
  if (real) z = smoothClosed(z, 3, 40);
  for (let i = 0; i < n; i++) {
    grade[i] = (z[(i + 1) % n] - z[(i - 1 + n) % n]) / (segLen[i] + segLen[(i - 1 + n) % n]);
  }

  // Kerbs wherever the track is turning noticeably (plus lead in/out).
  const kerbRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) kerbRaw[i] = Math.abs(curvS[i]) > 0.0045 ? 1 : 0;
  const kerbSm = smoothClosed(kerbRaw, 1, 18);
  const kerb = new Uint8Array(n);
  for (let i = 0; i < n; i++) kerb[i] = kerbSm[i] > 0.02 ? 1 : 0;

  // Gravel traps on the outside of slow corners, starting in the braking zone.
  const gravelL = new Uint8Array(n), gravelR = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.abs(curvS[i]) > 0.011) {
      const outsideLeft = curvS[i] < 0; // right-hander -> outside is left
      for (let k = -90; k <= 35; k++) {
        const q = (i + k + n) % n;
        if (outsideLeft) gravelL[q] = 1; else gravelR[q] = 1;
      }
    }
  }

  // Wall offsets. Generous run-off, but never past the centre of curvature on
  // the inside of a tight corner, and never into a neighbouring piece of track.
  let wallL = new Float64Array(n), wallR = new Float64Array(n);
  const pre = { n, x, y, ds }; buildGrid(pre);
  for (let i = 0; i < n; i++) {
    const R = Math.abs(curvS[i]) > 1e-4 ? 1 / Math.abs(curvS[i]) : 1e4;
    const base = hw[i] + 9;
    const outer = hw[i] + (gravelL[i] || gravelR[i] ? 22 : 9);
    const inner = Math.min(base, Math.max(hw[i] + 2.5, 0.62 * R));
    if (curvS[i] > 0) { wallL[i] = inner; wallR[i] = gravelR[i] ? outer : base; }
    else { wallR[i] = inner; wallL[i] = gravelL[i] ? outer : base; }
    // neighbouring track: probe along each normal for foreign samples
    if (i % 2 === 0 || true) {
      const nx = -Math.sin(heading[i]), ny = Math.cos(heading[i]);
      for (const side of [1, -1]) {
        let lim = side > 0 ? wallL[i] : wallR[i];
        for (let o = hw[i] + 3; o < lim + 14; o += 3) {
          const px = x[i] + nx * o * side, py = y[i] + ny * o * side;
          const q = nearestCoarse(pre, px, py);
          let gap = Math.abs(q - i); gap = Math.min(gap, n - gap);
          if (gap > 60) {
            const dq = Math.hypot(x[q] - px, y[q] - py);
            const mid = (o + dq - hw[q] + hw[i]) / 2;   // split the gap between the two roads
            lim = Math.min(lim, Math.max(hw[i] + 1.6, mid - 0.5)); break;
          }
        }
        if (side > 0) wallL[i] = lim; else wallR[i] = lim;
      }
    }
  }
  wallL = smoothClosed(wallL, 2, real ? 8 : 14); wallR = smoothClosed(wallR, 2, real ? 8 : 14);
  for (let i = 0; i < n; i++) { wallL[i] = Math.max(wallL[i], hw[i] + 1.5); wallR[i] = Math.max(wallR[i], hw[i] + 1.5); }

  const t = {
    id, name: def.name, country: def.country, real, source: def.source || null,
    n, ds, length, halfWidth: HALF_WIDTH, hw, kerbWidth: KERB_WIDTH,
    x, y, z, grade, heading, curv: curvS, s: sArr, kerb, gravelL, gravelR, wallL, wallR,
    sectors: [0, Math.round(n * 0.33), Math.round(n * 0.67)],
  };
  buildGrid(t);
  cache.set(id, t);
  return t;
}

// Coarse spatial hash for global nearest-sample queries (used for reset,
// off-track recovery and terrain generation).
function buildGrid(t) {
  const cell = 25;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < t.n; i++) {
    minX = Math.min(minX, t.x[i]); maxX = Math.max(maxX, t.x[i]);
    minY = Math.min(minY, t.y[i]); maxY = Math.max(maxY, t.y[i]);
  }
  minX -= 200; minY -= 200; maxX += 200; maxY += 200;
  const nx = Math.ceil((maxX - minX) / cell), ny = Math.ceil((maxY - minY) / cell);
  const cells = new Array(nx * ny);
  for (let i = 0; i < t.n; i += 4) {
    const cx = Math.floor((t.x[i] - minX) / cell), cy = Math.floor((t.y[i] - minY) / cell);
    (cells[cy * nx + cx] ||= []).push(i);
  }
  t.grid = { cell, minX, minY, maxX, maxY, nx, ny, cells };
}

function nearestCoarse(t, px, py) {
  const g = t.grid, cx = Math.floor((px - g.minX) / g.cell), cy = Math.floor((py - g.minY) / g.cell);
  let best = 0, bd = Infinity;
  for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = cx - 1; xx <= cx + 1; xx++) {
    if (xx < 0 || yy < 0 || xx >= g.nx || yy >= g.ny) continue;
    const c = g.cells[yy * g.nx + xx]; if (!c) continue;
    for (let k = 0; k < c.length; k++) { const i = c[k], d = (t.x[i] - px) ** 2 + (t.y[i] - py) ** 2; if (d < bd) { bd = d; best = i; } }
  }
  return best;
}

export function nearestIndexGlobal(t, px, py) {
  const g = t.grid;
  const cx = Math.floor((px - g.minX) / g.cell), cy = Math.floor((py - g.minY) / g.cell);
  let best = -1, bd = Infinity;
  for (let ring = 0; ring < Math.max(g.nx, g.ny); ring++) {
    for (let yy = cy - ring; yy <= cy + ring; yy++) {
      if (yy < 0 || yy >= g.ny) continue;
      for (let xx = cx - ring; xx <= cx + ring; xx++) {
        if (xx < 0 || xx >= g.nx) continue;
        if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== ring) continue;
        const c = g.cells[yy * g.nx + xx];
        if (!c) continue;
        for (let k = 0; k < c.length; k++) {
          const i = c[k];
          const d = (t.x[i] - px) ** 2 + (t.y[i] - py) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    if (best >= 0 && ring * g.cell > Math.sqrt(bd) + g.cell) break;
  }
  return refineIndex(t, px, py, best, 6);
}

function refineIndex(t, px, py, idx, win) {
  const n = t.n;
  let best = idx, bd = Infinity;
  for (let k = -win; k <= win; k++) {
    const i = ((idx + k) % n + n) % n;
    const d = (t.x[i] - px) ** 2 + (t.y[i] - py) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Project a point onto the centreline near `hint`. Writes into `out`:
//   idx  sample index of the segment start
//   s    arc length along the lap (m)
//   d    signed lateral offset (m, + = left of centreline)
// Allocation-free. The search walks downhill in distance so it stays correct
// even when the hint is several samples stale.
export function project(t, px, py, hint, out) {
  const n = t.n;
  let i = ((hint % n) + n) % n;
  let bd = (t.x[i] - px) ** 2 + (t.y[i] - py) ** 2;
  for (let iter = 0; iter < 64; iter++) {
    const a = i + 1 === n ? 0 : i + 1, b = i === 0 ? n - 1 : i - 1;
    const da = (t.x[a] - px) ** 2 + (t.y[a] - py) ** 2;
    const db = (t.x[b] - px) ** 2 + (t.y[b] - py) ** 2;
    if (da < bd && da <= db) { i = a; bd = da; }
    else if (db < bd) { i = b; bd = db; }
    else break;
  }
  // choose the segment (i-1,i) or (i,i+1) containing the foot point
  const h = t.heading[i];
  let tx = Math.cos(h), ty = Math.sin(h);
  let along = (px - t.x[i]) * tx + (py - t.y[i]) * ty;
  if (along < 0) {
    i = i === 0 ? n - 1 : i - 1;
    const h2 = t.heading[i];
    tx = Math.cos(h2); ty = Math.sin(h2);
    along = (px - t.x[i]) * tx + (py - t.y[i]) * ty;
  }
  out.idx = i;
  out.frac = Math.min(1, Math.max(0, along / t.ds));
  out.s = t.s[i] + along;
  out.d = -(px - t.x[i]) * ty + (py - t.y[i]) * tx;
  return out;
}

// Surface under a point with lateral offset d at sample idx.
export function surfaceAt(t, idx, d) {
  const ad = d < 0 ? -d : d;
  const h = t.hw[idx];
  if (ad <= h) return SURF.ASPHALT;
  if (t.kerb[idx] && ad <= h + t.kerbWidth) return SURF.KERB;
  if (d > 0 ? t.gravelL[idx] : t.gravelR[idx]) {
    if (ad > h + t.kerbWidth + 2.0) return SURF.GRAVEL;
  }
  return SURF.GRASS;
}

// The outermost lateral offset that still counts as "on track" for track
// limits (kerbs count as track).
export function trackEdge(t, idx) {
  return t.hw[idx] + (t.kerb[idx] ? t.kerbWidth : 0);
}

export function wrapIdx(t, i) { return ((i % t.n) + t.n) % t.n; }

// World-space pose on the centreline at arc length s with lateral offset d.
export function poseAt(t, s, d = 0) {
  const sm = ((s % t.length) + t.length) % t.length;
  let i = Math.min(t.n - 1, Math.floor(sm / t.ds));
  const h = t.heading[i];
  const f = sm - t.s[i];
  return {
    x: t.x[i] + Math.cos(h) * f - Math.sin(h) * d,
    y: t.y[i] + Math.sin(h) * f + Math.cos(h) * d,
    heading: h, idx: i, z: t.z[i],
  };
}
