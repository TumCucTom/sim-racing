// Trackside model: what lies to the left and right of the road at every sample.
//
// Across the track, each side is a sequence of bands (offsets from the centreline):
//
//   road | kerb (kerbL/R: flat or serrated) | apron (astro-turf, paint or a sausage kerb)
//        | grass verge | asphalt run-off from roA | gravel bed gA..gB | barrier at wall
//
// Any band may be missing. The bands are filled from three sources, in this order:
//   1. rules (curvature): apex kerb on the inside, exit kerb on the outside, a uniform
//      barrier distance. This is all Ravenscar's physics ever uses near the road.
//   2. `trackside.osm` in the circuit's JSON: gravel beds and barrier lines surveyed from
//      OpenStreetMap by tools/trackside-osm.mjs,
//   3. `trackside.corners`: hand-authored per-corner entries (kerb placement, type and
//      colours, run-off surface and depth, barrier type, escape roads). These are written
//      from memory of the real venue, not surveyed; each carries `src: 'memory'`.
// Stations in the data are metres along the lap (sample index * ds).

// Detailed surface ids. 0-3 are the original SURF ids; `SX_CLASS` folds the new ones back
// onto those four for code that only cares about asphalt / kerb / grass / gravel.
export const SX = { ASPHALT: 0, KERB: 1, GRASS: 2, GRAVEL: 3, RUNOFF: 4, PAINT: 5, ASTRO: 6, RUMBLE: 7, SAUSAGE: 8, PAVE: 9 };
export const SX_NAME = ['asphalt', 'kerb', 'grass', 'gravel', 'run-off', 'paint', 'astro', 'rumble', 'sausage', 'paving'];
export const SX_CLASS = [0, 1, 2, 3, 0, 0, 2, 1, 1, 0];
// tyre-road friction (fraction of the tyre's own mu) and rolling-resistance coefficient
export const SX_MU = [1.0, 0.93, 0.45, 0.42, 0.95, 0.86, 0.62, 0.9, 0.5, 0.8];
export const SX_ROLL = [0.013, 0.016, 0.07, 0.17, 0.015, 0.015, 0.035, 0.024, 0.12, 0.02];
// extra loss when the surface is wet, on top of src/sim/wet.js (paint and plastic grass are treacherous)
export const SX_WET = [1, 1, 1, 1, 0.97, 0.8, 0.82, 0.95, 0.9, 0.92];
// vibration fed to audio / camera, 0..1 per wheel
export const SX_RUMBLE = [0, 0.35, 0.3, 0.55, 0, 0, 0.12, 1, 1, 0.2];
// Gravel is deep: resistance grows with how far into the bed the wheel is and with speed
// (ploughing), on top of SX_ROLL[GRAVEL]. See Vehicle.step.
export const GRAVEL = { depthGain: 0.09, depthFull: 6, speedGain: 0.3, speedFull: 25 };

export const BAR = { ARMCO: 0, TYRES: 1, WALL: 2, TECPRO: 3 };
// kerb paint schemes: [name, colour A, colour B]
export const KERB_COLOURS = [
  ['red-white', [0.5, 0.022, 0.02], [0.66, 0.66, 0.63]],
  ['blue-white', [0.03, 0.1, 0.42], [0.66, 0.66, 0.63]],
  ['red-yellow', [0.5, 0.022, 0.02], [0.72, 0.56, 0.03]],
  ['black-white', [0.03, 0.03, 0.03], [0.66, 0.66, 0.63]],
  ['green-white', [0.03, 0.3, 0.08], [0.66, 0.66, 0.63]],
  ['yellow-black', [0.72, 0.56, 0.03], [0.03, 0.03, 0.03]],
  ['red-white-green', [0.5, 0.022, 0.02], [0.66, 0.66, 0.63]],
];
const COL = Object.fromEntries(KERB_COLOURS.map((c, i) => [c[0], i]));
const KTYPE = { flat: SX.KERB, rumble: SX.RUMBLE };
const ATYPE = { astro: SX.ASTRO, paint: SX.PAINT, sausage: SX.SAUSAGE };
const BTYPE = { armco: BAR.ARMCO, tyres: BAR.TYRES, wall: BAR.WALL, tecpro: BAR.TECPRO };
const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// g: { n, ds, x, y, heading, curv, hw, kerbWidth, urban, legacy: { kerb, gravelL, gravelR, wallL, wallR } }
// Returns the per-sample arrays described above. With no `ts` it reproduces the legacy layout exactly.
export function buildTrackside(ts, g) {
  const { n, ds, hw, curv } = g, KW = g.kerbWidth;
  const F = () => new Float64Array(n), U = () => new Uint8Array(n);
  const o = {
    kerbL: U(), kerbR: U(), kerbColL: U(), kerbColR: U(), apronL: U(), apronR: U(), apronWL: F(), apronWR: F(),
    roL: U(), roR: U(), roAL: F(), roAR: F(), gAL: F().fill(Infinity), gAR: F().fill(Infinity), gBL: F(), gBR: F(),
    wallL: g.legacy.wallL, wallR: g.legacy.wallR, barL: U(), barR: U(), corners: [], bridges: [],
  };
  const S = (side) => (side === 'L' ? 'L' : 'R');
  const idx = (s) => ((Math.round(s / ds) % n) + n) % n;
  const range = (s0, s1, fn) => { const a = Math.round(s0 / ds), b = Math.round(s1 / ds) + (s1 < s0 ? n : 0); for (let k = a; k <= b; k++) fn(((k % n) + n) % n, b > a ? (k - a) / (b - a) : 0.5); };
  const edge = (sd, i) => hw[i] + (o['kerb' + sd][i] ? KW : 0);

  // ---- 1. rules -------------------------------------------------------------------------
  const style = ts?.style || {}, defCol = COL[style.kerb || 'red-white'] ?? 0;
  if (!ts || ts.keepKerbs || style.kerbs === 'both') {
    // legacy: kerbs on both sides wherever the track turns; gravel 2 m behind them on the outside of slow corners
    // (`style.kerbs: 'both'` keeps just the kerb placement, for circuits whose AI tuning depends on it)
    for (let i = 0; i < n; i++) {
      if (g.legacy.kerb[i]) { o.kerbL[i] = o.kerbR[i] = SX.KERB; o.kerbColL[i] = o.kerbColR[i] = defCol; }
      if (g.legacy.gravelL[i]) { o.gAL[i] = hw[i] + KW + 2.0; o.gBL[i] = 1e9; o.barL[i] = BAR.TYRES; }
      if (g.legacy.gravelR[i]) { o.gAR[i] = hw[i] + KW + 2.0; o.gBR[i] = 1e9; o.barR[i] = BAR.TYRES; }
    }
  } else {
    // apex kerb along the inside of every corner, exit kerb on the outside from the apex on
    const thr = style.kerbCurv ?? 0.0045;
    let i = 0;
    while (i < n && Math.abs(curv[i]) > thr) i++;           // start outside a corner
    for (let c = 0; c < n;) {
      const a = (i + c) % n;
      if (Math.abs(curv[a]) <= thr) { c++; continue; }
      const sgn = Math.sign(curv[a]); let len = 0, pk = 0, pkAt = 0;
      while (len < n && Math.abs(curv[(a + len) % n]) > thr && Math.sign(curv[(a + len) % n]) === sgn) { const k = Math.abs(curv[(a + len) % n]); if (k > pk) { pk = k; pkAt = len; } len++; }
      c += len;
      if (len * ds < 12) continue;
      const inside = sgn > 0 ? 'L' : 'R', outside = sgn > 0 ? 'R' : 'L';
      const lead = Math.round(Math.min(14, 6 + len * 0.1) / ds);
      for (let k = -lead; k < len + lead; k++) { const q = (a + k + n) % n; o['kerb' + inside][q] = SX.KERB; o['kerbCol' + inside][q] = defCol; }
      if (pk > (style.exitKerbCurv ?? 0.006)) {
        const ex = Math.round(Math.min(70, 22 + len * 0.45) / ds);
        for (let k = Math.round(pkAt + (len - pkAt) * 0.45); k < len + ex; k++) { const q = (a + k) % n; if (!o['kerb' + inside][q] || k >= len) { o['kerb' + outside][q] = SX.KERB; o['kerbCol' + outside][q] = defCol; } }
      }
    }
  }

  // ---- 2. OpenStreetMap survey ---------------------------------------------------------
  const osm = ts?.osm;
  const useOsmWalls = osm && style.osmWalls !== false;
  if (osm) {
    const st = osm.step, sc = n / osm.n;      // the survey was made on this track; sc guards against a rebuilt centreline
    if (useOsmWalls) for (const sd of ['L', 'R']) {
      const w = o['wall' + sd], raw = new Float32Array(n).fill(NaN);
      for (const [i0, d] of osm['wall' + sd] || []) for (let k = 0; k < d.length; k++) for (let q = 0; q < st; q++) raw[Math.round((i0 + k * st + q) * sc) % n] = d[k];
      const lo = style.wallMin ?? 3.0, hi = style.wallMax ?? 70;
      for (let i = 0; i < n; i++) if (raw[i] === raw[i]) w[i] = Math.min(hw[i] + hi, Math.max(hw[i] + lo, raw[i]));
    }
    for (const sd of ['L', 'R']) for (const [i0, a, b] of osm['gravel' + sd] || []) {
      for (let k = 0; k < a.length; k++) for (let q = 0; q < st; q++) {
        const i = Math.round((i0 + k * st + q) * sc) % n, f = q / st, k1 = Math.min(a.length - 1, k + 1);
        const gA = Math.max(a[k] + (a[k1] - a[k]) * f, hw[i] + (o['kerb' + sd][i] ? KW : 0) + 0.4), gB = b[k] + (b[k1] - b[k]) * f;
        if (gB - gA < 2) continue;
        o['gA' + sd][i] = gA; o['gB' + sd][i] = gB; o['bar' + sd][i] = BAR.TYRES;
        if (o['wall' + sd][i] < gB + 0.8 || !useOsmWalls) o['wall' + sd][i] = gB + 1.0;
      }
    }
  }
  // smooth the barrier lines (surveyed ones are noisy), keeping them outside the gravel
  if (osm) for (const sd of ['L', 'R']) {
    const w = o['wall' + sd], t = new Float64Array(n), r = 5;
    for (let p = 0; p < 2; p++) { for (let i = 0; i < n; i++) { let a = 0; for (let q = -r; q <= r; q++) a += w[(i + q + n) % n]; t[i] = a / (2 * r + 1); } w.set(t); }
    for (let i = 0; i < n; i++) { if (o['gB' + sd][i] > 0 && o['gB' + sd][i] < 1e8 && w[i] < o['gB' + sd][i] + 0.6) o['gB' + sd][i] = w[i] - 0.6; }
  }

  // ---- 3. hand-authored corners ----------------------------------------------------------
  for (const c of ts?.corners || []) {
    if (c.n && c.s) o.corners.push({ name: c.n, s0: c.s[0], s1: c.s[1], src: c.src || 'memory' });
    // k: [side, s0, s1, type, colour]   kerbs (the entry's own range is cleared of rule-made kerbs first)
    if (c.k && c.s && !ts.keepKerbs) range(c.s[0], c.s[1], (i) => { o.kerbL[i] = o.kerbR[i] = 0; });
    if (!ts.keepKerbs) for (const [side, s0, s1, type = 'flat', colour] of c.k || []) {
      const sd = S(side), col = colour ? COL[colour] ?? defCol : defCol;
      range(s0, s1, (i) => { o['kerb' + sd][i] = KTYPE[type] ?? SX.KERB; o['kerbCol' + sd][i] = col; });
    }
    // kc: [s0, s1, colour, type]   repaint / retype whatever kerbs exist in the range
    if (!ts.keepKerbs) for (const [s0, s1, colour, type] of c.kc || []) range(s0, s1, (i) => { for (const sd of ['L', 'R']) if (o['kerb' + sd][i]) { if (colour) o['kerbCol' + sd][i] = COL[colour] ?? defCol; if (type) o['kerb' + sd][i] = KTYPE[type] ?? SX.KERB; } });
    // r: [side, s0, s1, surface, depth, { verge, barrier, shape, keep }]   run-off between the road and the barrier
    for (const [side, s0, s1, surf, depth, opt = {}] of c.r || []) {
      const sd = S(side), wall = o['wall' + sd], bar = BTYPE[opt.barrier ?? (surf === 'grass' || surf === 'wall' ? 'armco' : 'tyres')] ?? 0;
      range(s0, s1, (i, u) => {
        const e = edge(sd, i);
        // wedge: opens through the first half, deepest where cars arrive, closes quickly after the exit
        const prof = opt.shape === 'flat' ? sstep(0, 0.12, u) * (1 - sstep(0.88, 1, u)) : opt.shape === 'late' ? sstep(0.1, 0.75, u) * (1 - sstep(0.9, 1, u)) : sstep(0, 0.5, u) * (1 - sstep(0.8, 1, u));
        if (depth != null && !(opt.keep && osm)) { const base = Math.min(wall[i], hw[i] + (opt.base ?? 6)); wall[i] = Math.max(hw[i] + 1.6, base + (e + depth - base) * prof); }
        o['bar' + sd][i] = bar;
        if (surf === 'grass' || surf === 'wall') { if (!opt.keep) { o['gA' + sd][i] = Infinity; o['gB' + sd][i] = 0; } o['ro' + sd][i] = 0; return; }
        const verge = opt.verge ?? (surf === 'gravel' ? 2.2 : 0);
        if (surf === 'gravel') {
          o['ro' + sd][i] = 0;
          if (wall[i] - 0.7 - (e + verge) > 2.5) { o['gA' + sd][i] = e + verge; o['gB' + sd][i] = wall[i] - 0.7; } else { o['gA' + sd][i] = Infinity; o['gB' + sd][i] = 0; }
        } else {
          // asphalt (or painted asphalt); gravel surveyed from OSM inside it stays, an optional gravel band is added at the back
          o['ro' + sd][i] = surf === 'paint' ? SX.PAINT : SX.RUNOFF; o['roA' + sd][i] = e + verge;
          if (opt.gravel) { const gw = Math.min(opt.gravel, wall[i] - e - 4) * prof; if (gw > 2.5) { o['gB' + sd][i] = wall[i] - 0.7; o['gA' + sd][i] = wall[i] - 0.7 - gw; } }
          else if (!opt.keep) { o['gA' + sd][i] = Infinity; o['gB' + sd][i] = 0; }
          if (wall[i] - (e + verge) < 1.5) o['ro' + sd][i] = 0;
        }
      });
    }
    // a: [side, s0, s1, type, width]   strip directly behind the kerb (or the road edge)
    for (const [side, s0, s1, type, width] of c.a || []) {
      const sd = S(side), w = width ?? (type === 'sausage' ? 0.55 : 1.2);
      range(s0, s1, (i) => { o['apron' + sd][i] = ATYPE[type] || 0; o['apronW' + sd][i] = w; });
    }
    // spur: [side, s, length, width, shift]   escape road straight on from station s
    for (const [side, s, len, width, shift = 0] of c.spur || []) {
      const sd = S(side), sg = sd === 'L' ? 1 : -1, i0 = idx(s), h0 = g.heading[i0], tx = Math.cos(h0), ty = Math.sin(h0);
      const ox = g.x[i0] - ty * shift * sg, oy = g.y[i0] + tx * shift * sg, wall = o['wall' + sd];
      for (let k = 0; k < Math.round(len * 1.6 / ds); k++) {
        const i = (i0 + k) % n, h = g.heading[i], ux = -Math.sin(h) * sg, uy = Math.cos(h) * sg;
        // furthest point along this sample's outward normal that is still inside the spur rectangle
        let far = 0;
        for (let d = hw[i]; d < len + 20; d += 0.5) { const px = g.x[i] + ux * d - ox, py = g.y[i] + uy * d - oy, al = px * tx + py * ty, la = -px * ty + py * tx; if (al >= -2 && al <= len && Math.abs(la) <= width / 2) far = d; else if (far) break; }
        if (far > wall[i]) { wall[i] = far; o['ro' + sd][i] = SX.RUNOFF; o['roA' + sd][i] = hw[i] + (o['kerb' + sd][i] ? KW : 0); o['bar' + sd][i] = BTYPE[c.spurBarrier || 'tecpro']; o['gA' + sd][i] = Infinity; o['gB' + sd][i] = 0; }
      }
    }
    // bridge: [s, kind]   something spanning the track (visual only)
    for (const b of c.bridge || []) o.bridges.push({ s: b[0], kind: b[1] || 'foot', name: c.n });
  }
  return o;
}

// After the barrier lines are final: keep every band inside them and derive the track-limit edges.
export function finishTrackside(o, g) {
  const { n, hw } = g, KW = g.kerbWidth;
  o.edgeL = new Float64Array(n); o.edgeR = new Float64Array(n); o.kerb = new Uint8Array(n);
  for (const sd of ['L', 'R']) {
    const wall = o['wall' + sd], gA = o['gA' + sd], gB = o['gB' + sd], e = o['edge' + sd];
    for (let i = 0; i < n; i++) {
      e[i] = hw[i] + (o['kerb' + sd][i] ? KW : 0);
      if (o['kerb' + sd][i]) o.kerb[i] = 1;
      if (gB[i] > wall[i] - 0.5) gB[i] = wall[i] - 0.5;
      if (!(gB[i] - gA[i] > 1.2)) { gA[i] = Infinity; gB[i] = 0; }
      if (o['apron' + sd][i] && e[i] + o['apronW' + sd][i] > wall[i] - 0.3) o['apron' + sd][i] = 0;
    }
  }
  return o;
}
