// Monaco street dressing: pavements, retaining walls and quays, the tunnel, harbour, grandstands, palms, landmarks.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nearestIndexGlobal } from '../sim/track.js';
import { RNG } from '../sim/rng.js';
import { L, LSIZE, boardAtlas } from './monaco-tex.js';
import { polyArea, inPoly, insetPoly } from './monaco.js';
import { ASSETS, loadTexture } from './assets.js';

// What stands beside the road where OpenStreetMap has no building: [from m, to m, side (1 left, -1 right), type].
// Anything not listed is decided from the surroundings ('auto': street-wall buildings, or grandstands by the water).
const ZONES = [
  [3050, 3321, -1, 'pit'], [0, 150, -1, 'pit'],                 // pit lane and garages between the straight and the pool
  [150, 215, -1, 'stand'],
  [205, 330, 1, 'open'], [215, 300, -1, 'open'],                // Sainte Dévote: escape road, chapel square
  [660, 880, 1, 'garden'],                                      // Massenet: terraces below the Hermitage
  [880, 1020, 1, 'garden'], [880, 960, -1, 'open'],             // Casino square
  [1000, 1140, -1, 'garden'], [1120, 1215, 1, 'open'],          // Mirabeau and its escape road
  [1215, 1420, 1, 'garden'], [1215, 1420, -1, 'garden'],        // Fairmont hairpin
  [1420, 1545, 1, 'open'], [1420, 1545, -1, 'garden'],          // Portier
  [1900, 2090, 1, 'open'], [2090, 2200, -1, 'open'],            // tunnel exit, chicane escape road
  [2180, 2400, 1, 'stand'], [2400, 2625, -1, 'stand'], [2400, 2990, 1, 'stand'],
  [2625, 2700, -1, 'pool'], [2700, 2900, -1, 'stand'],
  [2900, 3050, -1, 'open'], [2900, 3060, 1, 'garden'],          // Rascasse, Anthony Noghès
];
// Landmark footprints, found by a point inside them: looks and heights OpenStreetMap does not carry.
const MARKS = [
  { at: [567, 308], name: 'casino', h: 21, style: { body: L.PALACE, ground: L.PALACE, top: L.CORNICE, topH: 1.6, roof: 'mansard', roofLayer: L.COPPER, tint: '#f3e6c4' } },
  { at: [465, 270], name: 'paris', h: 27, style: { body: L.BELLE2, ground: L.ARCADE, top: L.CORNICE, topH: 1.6, roof: 'mansard', tint: '#f6efdc' } },
  { at: [522, 382], name: 'onemc', h: 27, style: { body: L.GLASS, ground: L.SHOPS, top: L.PARAPET, topH: 1.2, roof: 'flat', tint: '#efe9dc', pent: true } },
  { at: [520, 468], name: 'metropole', h: 24, style: { body: L.BELLE, ground: L.ARCADE, top: L.CORNICE, topH: 1.6, roof: 'mansard', tint: '#f1dfb8' } },
  { at: [670, 330], name: 'fairmont', top: 30.5, style: { body: L.HOTEL, ground: L.HOTEL, top: L.PARAPET, topH: 1.2, roof: 'flat', tint: '#f2e7cf' } },
  { at: [574, 182], name: 'star', top: 31, style: { body: L.BANDS, ground: L.CONCRETE, top: L.PARAPET, topH: 1.2, roof: 'flat', tint: '#f0e6d2' } },
  { at: [642, 205], name: 'auditorium', top: 27, style: { body: L.GLASS, ground: L.CONCRETE, top: L.PARAPET, topH: 1.2, roof: 'flat', tint: '#e9e4d8' } },
  { at: [652, 470], name: 'sardanapale', h: 14, style: { body: L.HOTEL, ground: L.SHOPS, top: L.PARAPET, topH: 1.2, roof: 'flat', tint: '#f2e7cf' } },
  { at: [137, -455], name: 'rascasse', h: 7.5, style: { body: L.PLAIN, ground: L.SHOPS, top: L.PARAPET, topH: 0.8, roof: 'flat', tint: '#f3ead6' } },
];

export function prepMonaco(K) {
  const { srgb } = K;
  K.marks = {};
  K.landmark = (b) => {
    for (const m of MARKS) if (!K.marks[m.name] && (Math.hypot(b.c[0] - m.at[0], b.c[1] - m.at[1]) < 14 || (Math.abs(b.c[0] - m.at[0]) < 220 && inPoly(b.P, m.at[0], m.at[1])))) {
      if (m.h) b.h = m.h; if (m.top) b.topAbs = m.top;
      b.style = { ...m.style, tint: srgb(m.style.tint) }; b.mark = m.name; K.marks[m.name] = b;
    }
    if (/Palais princier/.test(b.name)) { b.mark = 'palace'; b.h = 17; b.style = { body: L.PALACE, ground: L.RUSTIC, top: L.CORNICE, topH: 1.6, roof: 'flat', tint: srgb('#f0e2c2') }; }
    if ((b.kind === 0 && b.c[0] > -260 && b.c[0] < 420 && b.c[1] < -560) || b.c[1] < -640) b.oldTown = true;      // on the Rock
  };
}

export function dressMonaco(K) {
  const { M, ctx, track, sc, W, SEA, terrain, group, quality, detail, cast, facMat, mkAcc, accGeo, quad, wall, box, srgb, groundMat, hash2, smooth, pairs } = K, n = track.n, ds = track.ds;
  const STONE = srgb('#cdbfa6'), CONC = srgb('#d6d1c6'), WHITE = [1, 1, 1];
  const NC = 8, accs = Array.from({ length: NC }, () => mkAcc()), accOf = (i) => accs[Math.min(NC - 1, Math.floor(((i % n) + n) % n / n * NC))];
  const flat = mkAcc();                                // façade-material geometry that casts no shadow (quays, far things)
  const gp = [], gn = [];                              // ground-material geometry (flat tops)
  const top = (a, b, c, d) => { for (const p of [a, b, c, a, c, d]) { gp.push(p[0], p[1], -p[2]); gn.push(0, 1, 0); } };   // [x, h, y]
  const at = (i, off) => { const k = ((i % n) + n) % n, h = track.heading[k]; return [track.x[k] - Math.sin(h) * off, track.y[k] + Math.cos(h) * off]; };
  const idx = (s) => ((Math.round(s / ds) % n) + n) % n;
  const wl = (side) => (side > 0 ? track.wallL : track.wallR);
  const rng = new RNG(20260);
  const zoneMap = { 1: new Array(n).fill('auto'), '-1': new Array(n).fill('auto') };
  for (const [a, b, side, type] of ZONES) for (let i = idx(a); i !== idx(b); i = (i + 1) % n) zoneMap[side][i] = type;
  // escape roads continue straight on: keep their side clear
  for (const c of track.corners || []) for (const sp of c.spur || []) { const side = sp[0] === 'L' ? 1 : -1; for (let s = sp[1] - 25; s < sp[1] + sp[2] * 0.6; s++) if (zoneMap[side][idx(s)] === 'auto') zoneMap[side][idx(s)] = 'open'; }
  const used = { 1: new Uint8Array(n), '-1': new Uint8Array(n) };      // 1 grandstand, 2 building / structure right behind the barrier

  // swept surface beside the track: prof(i) -> [[offset from the centreline (> 0 outwards), height, v], ...]
  const sweep = (acc, I, side, prof, layer, tint, o = {}) => {
    const lw = o.uw || LSIZE[layer][0]; let u = o.u0 || 0, prev = null, pi = -1;
    for (const i of I) {
      const P = prof(i).map(([off, z, v]) => { const p = at(i, side * off); return [p[0], z, p[1], 0, v]; });
      if (prev) {
        const du = ((i - pi + n) % n) * ds / lw;
        for (let k = 0; k + 1 < P.length; k++) {
          const a = prev[k].slice(), b = P[k].slice(), c = P[k + 1].slice(), d = prev[k + 1].slice(); a[3] = d[3] = u; b[3] = c[3] = u + du;
          if ((side > 0) !== !!o.back) quad(acc, a, b, c, d, layer, tint); else quad(acc, b, a, d, c, layer, tint);
        }
        u += du;
      }
      prev = P; pi = i;
    }
  };
  const range = (i0, i1, st = 2) => { const I = []; const len = (i1 - i0 + n) % n; for (let q = 0; q < len; q += st) I.push((i0 + q) % n); I.push(i1 % n); return I; };

  // footprints on a coarse hash: what already stands where
  const HC = 32, hx0 = W.x0, hy0 = W.y0, hnx = Math.ceil((W.x1 - W.x0) / HC), hny = Math.ceil((W.y1 - W.y0) / HC), fh = Array.from({ length: hnx * hny }, () => []);
  const addFoot = (f) => { for (let b = Math.max(0, Math.floor((f.y0 - hy0) / HC)); b <= Math.min(hny - 1, Math.floor((f.y1 - hy0) / HC)); b++) for (let a = Math.max(0, Math.floor((f.x0 - hx0) / HC)); a <= Math.min(hnx - 1, Math.floor((f.x1 - hx0) / HC)); a++) fh[b * hnx + a].push(f); };
  for (const f of K.foot) addFoot(f);
  const footAt = (x, y) => { const a = Math.floor((x - hx0) / HC), b = Math.floor((y - hy0) / HC); if (a < 0 || b < 0 || a >= hnx || b >= hny) return null; for (const f of fh[b * hnx + a]) if (x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1 && inPoly(f.P, x, y)) return f; return null; };
  const building = (b) => { const k = K.foot.length; if (K.addBuilding(b)) { addFoot(K.foot[k]); return K.foot[k]; } return null; };
  // metres of clear ground behind the barrier (to the next footprint, the water or another piece of track)
  const freeC = { 1: new Float32Array(n).fill(-1), '-1': new Float32Array(n).fill(-1) };
  const free = (i, side) => {
    i = ((i % n) + n) % n; if (freeC[side][i] >= 0) return freeC[side][i];
    let o = 0; const w = wl(side)[i], lm = M.lim[side][i];
    if (!M.inTun(i)) for (o = 1; o < 46; o += 1.5) { if (w + o > lm) break; const p = at(i, side * (w + o)); if (M.isSea(p[0], p[1]) || footAt(p[0], p[1])) break; }
    return (freeC[side][i] = Math.max(0, o - 1.5));
  };
  const seaWithin = (i, side, d) => { const w = wl(side)[i]; for (let o = 2; o <= d; o += 4) { const p = at(i, side * (w + o)); if (M.isSea(p[0], p[1])) return true; } return false; };

  // ---- pavement behind the barriers, retaining walls and terraces ----
  {
    const ST = 2, PV = 0.11;
    for (const side of [1, -1]) {
      const w = wl(side), ap = M.apron[side], tr = M.terr[side], st = M.step[side];
      let per = 0;
      for (let i = 0; i < n; i += ST) {
        const j = (i + ST) % n; per += ST;
        if (M.inTun(i) || M.inTun(j)) continue;
        const A = accOf(i), zi = track.z[i] + PV, zj = track.z[j] + PV;
        const a0 = at(i, side * (w[i] - 0.3)), a1 = at(i, side * ap[i]), b0 = at(j, side * (w[j] - 0.3)), b1 = at(j, side * ap[j]);
        const F = side > 0 ? (p, q, r, s) => top(p, q, r, s) : (p, q, r, s) => top(q, p, s, r);
        F([a0[0], zi, a0[1]], [b0[0], zj, b0[1]], [b1[0], zj, b1[1]], [a1[0], zi, a1[1]]);
        const si = st[i], sj = st[j], u0 = per / 6.4, u1 = (per + ST) / 6.4;
        let oi = a1, oj = b1, hi = zi, hj = zj;
        if (si || sj) {
          const ti = track.z[i] + si, tj = track.z[j] + sj, c1 = at(i, side * Math.max(tr[i], ap[i] + 0.5)), d1 = at(j, side * Math.max(tr[j], ap[j] + 0.5));
          // the wall: faces the road where the hill rises, faces away where the ground drops
          const up = si + sj > 0, lo = [Math.min(zi, ti), Math.min(zj, tj)], hh = [Math.max(zi, ti) + (up ? 0 : 0.0), Math.max(zj, tj)];
          if ((side > 0) === up) quad(A, [b1[0], lo[1], b1[1], u1, lo[1] / 6.4], [a1[0], lo[0], a1[1], u0, lo[0] / 6.4], [a1[0], hh[0], a1[1], u0, hh[0] / 6.4], [b1[0], hh[1], b1[1], u1, hh[1] / 6.4], L.STONE, STONE);
          else quad(A, [a1[0], lo[0], a1[1], u0, lo[0] / 6.4], [b1[0], lo[1], b1[1], u1, lo[1] / 6.4], [b1[0], hh[1], b1[1], u1, hh[1] / 6.4], [a1[0], hh[0], a1[1], u0, hh[0] / 6.4], L.STONE, STONE);
          F([a1[0], ti, a1[1]], [b1[0], tj, b1[1]], [d1[0], tj, d1[1]], [c1[0], ti, c1[1]]);
          oi = c1; oj = d1; hi = ti; hj = tj;
        }
        // skirt down from the outer edge, facing outwards
        const dz = 3.5;
        if (side > 0) quad(A, [oi[0], hi - dz, oi[1], u0, (hi - dz) / 6.4], [oj[0], hj - dz, oj[1], u1, (hj - dz) / 6.4], [oj[0], hj, oj[1], u1, hj / 6.4], [oi[0], hi, oi[1], u0, hi / 6.4], L.STONE, STONE);
        else quad(A, [oj[0], hj - dz, oj[1], u1, (hj - dz) / 6.4], [oi[0], hi - dz, oi[1], u0, (hi - dz) / 6.4], [oi[0], hi, oi[1], u0, hi / 6.4], [oj[0], hj, oj[1], u1, hj / 6.4], L.STONE, STONE);
      }
      // stone parapet with a coping where the ground falls away behind the pavement, a capping on retaining walls
      let run = [];
      const flush = () => { if (run.length > 2) { const I = run, A = accOf(I[0]);
        sweep(A, I, side, (i) => [[ap[i] - 0.45, track.z[i] + PV, 0], [ap[i] - 0.45, track.z[i] + 1.05, 0.15], [ap[i] - 0.5, track.z[i] + 1.05, 0.16], [ap[i] - 0.5, track.z[i] + 1.17, 0.18], [ap[i] + 0.02, track.z[i] + 1.17, 0.26], [ap[i] + 0.02, track.z[i] + PV, 0.42]], L.STONE, srgb('#e2d8c2')); } run = []; };
      for (let i = 0; i < n; i += ST) { if (!M.inTun(i) && st[i] < -1.2) run.push(i); else flush(); } flush();
    }
  }

  // ---- quay walls: the contour of the land mask, dropped into the water ----
  {
    const { cov, MW, MH } = M, TH = 127.5, reach = detail > 0 ? 9e9 : 300;
    const v = (i, j) => cov[j * MW + i];
    for (let j = 0; j < MH - 1; j++) for (let i = 0; i < MW - 1; i++) {
      const c0 = v(i, j), c1 = v(i + 1, j), c2 = v(i + 1, j + 1), c3 = v(i, j + 1), m = (c0 > TH ? 1 : 0) | (c1 > TH ? 2 : 0) | (c2 > TH ? 4 : 0) | (c3 > TH ? 8 : 0);
      if (m === 0 || m === 15) continue;
      const x0 = W.x0 + i + 0.5, y0 = W.y0 + j + 0.5, f = (a, b) => (TH - a) / (b - a);
      const E = [() => [x0 + f(c0, c1), y0], () => [x0 + 1, y0 + f(c1, c2)], () => [x0 + f(c3, c2), y0 + 1], () => [x0, y0 + f(c0, c3)]];
      const segs = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]], 10: [[0, 1], [2, 3]], 11: [[2, 1]], 12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]] }[m];
      for (const [ea, eb] of segs) {
        let a = E[ea](), b = E[eb](); const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len < 0.02) continue;
        // sea must lie on the right of a->b
        let nx = dy / len, ny = -dx / len; if (M.covAt((a[0] + b[0]) / 2 + nx * 0.8, (a[1] + b[1]) / 2 + ny * 0.8) > 0.5) { const t = a; a = b; b = t; nx = -nx; ny = -ny; }
        const ta = terrain(a[0] - nx * 1.3, a[1] - ny * 1.3), tb = terrain(b[0] - nx * 1.3, b[1] - ny * 1.3); if (ta.dist > reach) continue;
        const za = ta.h + 0.14, zb = tb.h + 0.14, tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len, ua = (a[0] * tx + a[1] * ty) / 6.4, ub = ua + len / 6.4;
        quad(flat, [a[0], SEA - 2.5, a[1], ua, (SEA - 2.5) / 6.4], [b[0], SEA - 2.5, b[1], ub, (SEA - 2.5) / 6.4], [b[0], zb, b[1], ub, zb / 6.4], [a[0], za, a[1], ua, za / 6.4], L.STONE, CONC);
        if (ta.dist < 160) quad(flat, [a[0], za, a[1], ua, 0], [b[0], zb, b[1], ub, 0], [b[0] - nx * 0.7, zb, b[1] - ny * 0.7, ub, 0.11], [a[0] - nx * 0.7, za, a[1] - ny * 0.7, ua, 0.11], L.CONCRETE, CONC, [0, 1, 0]);
      }
    }
  }

  // ---- landmark masses on top of their OSM footprints ----
  {
    const A = accs[2], cream = srgb('#f3e6c4');
    const tower = (acc, x, y, hw, z0, z1, layer, tint, capH, capLayer = L.COPPER, rot = 0) => {
      const P = box(acc, x, y, hw, hw, rot, z0, z1, layer, tint, null);
      // pyramid cap in four quads meeting at a small lantern
      const q = 0.28, c = Math.cos(rot), s = Math.sin(rot), Q = [[-q, -q], [q, -q], [q, q], [-q, q]].map(([u, v]) => [x + (u * c - v * s) * hw, y + (u * s + v * c) * hw]);
      for (let k = 0; k < 4; k++) { const a = P[k], e = P[(k + 1) % 4], qa = Q[k], qe = Q[(k + 1) % 4]; quad(acc, [a[0], z1, a[1], 0, 0], [e[0], z1, e[1], hw / 3.2, 0], [qe[0], z1 + capH, qe[1], hw / 4.5, capH / 6.4], [qa[0], z1 + capH, qa[1], hw / 9, capH / 6.4], capLayer, WHITE); }
      box(acc, x, y, hw * q, hw * q, rot, z1 + capH, z1 + capH + hw * 0.5, L.BLANK, tint, capLayer, WHITE);
    };
    const cs = K.marks.casino;
    if (cs) {
      // the façade towards the square (north-west): twin towers either side of the entrance, copper dome behind
      const tgt = [505, 345]; let best = null;
      for (let k = 0; k < cs.P.length; k++) { const a = cs.P[k], e = cs.P[(k + 1) % cs.P.length], len = Math.hypot(e[0] - a[0], e[1] - a[1]); if (len < 14) continue; const mx = (a[0] + e[0]) / 2, my = (a[1] + e[1]) / 2, d = Math.hypot(mx - tgt[0], my - tgt[1]) - len * 0.3; if (!best || d < best.d) best = { d, a, e, len }; }
      const fo = K.foot.find(f => f.mark === 'casino');
      if (best && fo) {
        const ux = (best.e[0] - best.a[0]) / best.len, uy = (best.e[1] - best.a[1]) / best.len, nx = uy, ny = -ux, rot = Math.atan2(uy, ux), zt = fo.top, mx = (best.a[0] + best.e[0]) / 2, my = (best.a[1] + best.e[1]) / 2, sp = Math.min(11, best.len * 0.3);
        for (const sg of [-1, 1]) tower(A, mx + ux * sg * sp - nx * 2.6, my + uy * sg * sp - ny * 2.6, 3.1, zt - 6, zt + 8.5, L.PALACE, cream, 6.5, L.COPPER, rot);
        box(A, mx - nx * 2.2, my - ny * 2.2, sp - 3.2, 2.6, rot, zt - 2, zt + 3.2, L.PALACE, cream, L.COPPER, WHITE);
        tower(A, mx - nx * 22, my - ny * 22, 7.5, zt - 1, zt + 5, L.BLANK, cream, 7, L.COPPER, rot);
      }
    }
    const hp = K.marks.paris, fp = hp && K.foot.find(f => f.mark === 'paris');
    if (fp) { let b = null; for (const p of fp.P) { const d = Math.hypot(p[0] - 480, p[1] - 320); if (!b || d < b.d) b = { d, p }; } const dx = fp.c[0] - b.p[0], dy = fp.c[1] - b.p[1], l = Math.hypot(dx, dy); tower(A, b.p[0] + dx / l * 5, b.p[1] + dy / l * 5, 4.2, fp.top - 3, fp.top + 6, L.BELLE2, srgb('#f6efdc'), 6, L.ZINC, Math.atan2(dy, dx)); }
    // the Prince's palace on the Rock: crenellated towers over the square
    for (const f of K.foot) if (f.mark === 'palace') { const xs = f.P.map(p => p[0]), ys = f.P.map(p => p[1]); for (const [x, y] of [[Math.min(...xs) + 6, Math.max(...ys) - 6], [Math.max(...xs) - 6, Math.max(...ys) - 8], [(Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys) - 4]]) if (inPoly(f.P, x, y)) { box(accs[7], x, y, 4.2, 4.2, 0.3, f.top - 4, f.top + 9, L.STONE, srgb('#e8dcc0')); box(accs[7], x, y, 4.8, 4.8, 0.3, f.top + 9, f.top + 10.4, L.STONE, srgb('#efe4ca')); } }
  }

  // ---- the pit building, grandstands and street-wall infill, walking the lap on both sides ----
  const stands = [];
  {
    const blue = srgb('#27466b'), scaf = srgb('#7d8087');
    const stand = (i0, i1, side, D) => {
      const I = range(i0, i1), w = wl(side), A = accOf(i0), f0 = (i) => w[i] + 1.5, rise = D * 0.52, zb = (i) => track.z[i] + 0.11, rows = D / 0.8 / 14;
      sweep(A, I, side, (i) => [[f0(i), zb(i), 0], [f0(i), zb(i) + 2.0, 0.31]], L.CONCRETE, blue);
      sweep(A, I, side, (i) => [[f0(i), zb(i) + 2.0, 0], [f0(i) + D, zb(i) + 2.0 + rise, rows]], L.CROWD, WHITE);
      sweep(A, I, side, (i) => [[f0(i) + D, zb(i) + 3.1 + rise, 0.6], [f0(i) + D, zb(i) - 1, 0]], L.CONCRETE, scaf, { back: true });
      sweep(A, I, side, (i) => [[f0(i) + D, zb(i) + 2.0 + rise, 0], [f0(i) + D, zb(i) + 3.1 + rise, 0.17]], L.CONCRETE, blue);
      for (const [i, s] of [[i0, -1], [i1, 1]]) {
        const a = at(i, side * f0(i)), b = at(i, side * (f0(i) + D)), z = zb(i), P = [[a[0], z - 1, a[1], 0, 0], [b[0], z - 1, b[1], D / 6.4, 0], [b[0], z + 3.1 + rise, b[1], D / 6.4, (rise + 3) / 6.4], [a[0], z + 2.0, a[1], 0, 0.45]];
        if ((s * side) < 0) quad(A, P[0], P[1], P[2], P[3], L.CONCRETE, blue); else quad(A, P[1], P[0], P[3], P[2], L.CONCRETE, blue);
      }
      for (const i of I) used[side][i] = 1;
      stands.push({ i0, i1, side, D });
    };
    const infill = (i0, i1, side, dep, hgt) => {
      const f = M.apron[side], im = (i0 + Math.round(((i1 - i0 + n) % n) / 2)) % n;
      const P = [at(i0, side * (f[i0] + 0.5)), at(im, side * (f[im] + 0.5)), at(i1, side * (f[i1] + 0.5)), at(i1, side * (f[i1] + 0.5 + dep)), at(im, side * (f[im] + 0.5 + dep)), at(i0, side * (f[i0] + 0.5 + dep))];
      if (side < 0) P.reverse(); if (polyArea(P) < 50) return false;
      if (!building({ P, h: hgt, kind: 0, free: true, c: P[0], a: polyArea(P) })) return false;
      for (const i of range(i0, i1)) used[side][i] = 2; return true;
    };
    // pit building: garages towards the straight, hospitality above
    const pit = (i0, i1, side) => {
      const I = range(i0, i1), w = wl(side), A = accOf(i0), f0 = (i) => w[i] + 5.4, zb = (i) => track.z[i] + 0.05, D = 9, grey = srgb('#e9e7e2'), red = srgb('#c9202c');
      // pit lane apron in front
      sweep(A, I, side, (i) => [[f0(i), zb(i), 0], [f0(i), zb(i) + 3.6, 0.8]], L.LOGGIA, grey, { uw: 12.8 });
      sweep(A, I, side, (i) => [[f0(i), zb(i) + 3.6, 0], [f0(i), zb(i) + 4.2, 0.1], [f0(i) - 1.6, zb(i) + 4.2, 0.4], [f0(i) - 1.6, zb(i) + 4.6, 0.5]], L.CONCRETE, red);
      sweep(A, I, side, (i) => [[f0(i) - 1.6, zb(i) + 4.6, 0], [f0(i) + 0.4, zb(i) + 4.6, 0.3]], L.CONCRETE, grey);
      sweep(A, I, side, (i) => [[f0(i) + 0.4, zb(i) + 4.6, 0], [f0(i) + 0.4, zb(i) + 7.7, 0.5]], L.GLASS, WHITE);
      sweep(A, I, side, (i) => [[f0(i) + 0.4, zb(i) + 7.7, 0], [f0(i) + 0.4, zb(i) + 8.5, 0.5]], L.PARAPET, grey);
      sweep(A, I, side, (i) => [[f0(i) + 0.4, zb(i) + 8.3, 0], [f0(i) + D, zb(i) + 8.3, 1.5]], L.CONCRETE, grey);
      sweep(A, I, side, (i) => [[f0(i) + D, zb(i) + 8.5, 2.74], [f0(i) + D, zb(i) + 2.3, 0.74], [f0(i) + D, zb(i) - 10.1, -1.26]], L.BANDS, grey, { back: true });
      for (const [i, s] of [[i0, -1], [i1, 1]]) { const a = at(i, side * f0(i)), b = at(i, side * (f0(i) + D)), z = zb(i), P = [[a[0], z - 10, a[1], 0, -1.5], [b[0], z - 10, b[1], 1, -1.5], [b[0], z + 8.5, b[1], 1, 1.5], [a[0], z + 8.5, a[1], 0, 1.5]]; if ((s * side) < 0) quad(A, P[0], P[1], P[2], P[3], L.BLANK, grey); else quad(A, P[1], P[0], P[3], P[2], L.BLANK, grey); }
      for (const i of I) used[side][i] = 2;
    };
    for (const side of [1, -1]) {
      // pit runs first
      let i = 0;
      while (i < n) { if (zoneMap[side][i] !== 'pit') { i++; continue; } let j = i; while (j < n - 1 && zoneMap[side][j + 1] === 'pit' && free(j + 1, side) > 13.5 && j - i < 400) j++; if (j - i > 30) pit(i + 2, j - 2, side); i = j + 1; while (i < n && zoneMap[side][i] === 'pit' && free(i, side) <= 13.5) i++; }
      i = 0;
      while (i < n) {
        const z = zoneMap[side][i], d = M.inTun(i) || used[side][i] ? 0 : free(i, side);
        const wantStand = z === 'stand' || (z === 'auto' && seaWithin(i, side, 46));
        if (wantStand && d >= 8.5 && M.step[side][i] >= -1.5) {
          let j = i, dm = d; while (j - i < 64 && j + 2 < n && !M.inTun(j + 2) && !used[side][(j + 2) % n] && zoneMap[side][(j + 2) % n] === z && free(j + 2, side) >= 8.5 && Math.abs(track.curv[(j + 2) % n]) < 0.045) { j += 2; dm = Math.min(dm, free(j, side)); }
          if (j - i >= 16) { stand(i + 1, j - 1, side, Math.min(dm - 2.4, 6 + 6 * hash2(i, 3))); i = j + 4 + Math.round(6 * hash2(i, 11)); continue; }
        }
        if (z === 'auto' && d >= 14 && Math.abs(M.step[side][i]) < 0.1 && detail >= 0) {
          const want = 13 + Math.round(11 * hash2(i, side + 5)); let j = i, dm = d;
          while (j - i < want && j + 2 < n && !M.inTun(j + 2) && zoneMap[side][(j + 2) % n] === 'auto' && free(j + 2, side) >= 12 && Math.abs(M.step[side][(j + 2) % n]) < 0.1 && Math.abs(track.curv[(j + 2) % n]) < 0.03) { j += 2; dm = Math.min(dm, free(j, side)); }
          if (j - i >= 10 && infill(i, j, side, Math.min(dm - 6.5, 9 + 5 * hash2(i, 2)), 12.5 + Math.round(4 * hash2(Math.floor(i / 90), side + 1) + 2 * hash2(i, 8)) * 3.1)) { i = j + (hash2(i, 4) < 0.3 ? 4 : 0); continue; }
        }
        i += 2;
      }
    }
  }

  // ---- hoardings on the fence line, street lamps ----
  {
    const pos = [], uv = [], nor = [];
    for (const side of [1, -1]) {
      const w = wl(side); let i = 12;
      while (i < n - 8) {
        const h = hash2(Math.floor(i / 45), side * 3 + 7);
        if (M.inTun(i) || M.inTun(i + 7) || Math.abs(track.curv[i]) > 0.028 || h < 0.38) { i += 7; continue; }
        const brand = Math.floor(hash2(Math.floor(i / 45), side + 31) * 16), u0 = (brand % 2) * 0.5, v0 = 1 - ((brand >> 1) + 1) / 8, lift = used[side][i] === 1 ? 0.2 : 0;
        for (let q = 0; q < 3; q++) {
          const ia = i + q * 2, ib = i + q * 2 + 2, a = at(ia, side * (w[ia] + 0.62)), b = at(ib, side * (w[ib] + 0.62)), za = track.z[ia] + 1.12 + lift, zb = track.z[ib] + 1.12 + lift, hd = track.heading[ia];
          const nx = Math.sin(hd) * side, nz = Math.cos(hd) * side;                      // towards the track (three space)
          const P = side > 0 ? [[a, za, u0 + q / 6], [b, zb, u0 + (q + 1) / 6]] : [[b, zb, u0 + (2 - q) / 6], [a, za, u0 + (3 - q) / 6]];
          const V = [[P[0][0], P[0][1], P[0][2], v0], [P[1][0], P[1][1], P[1][2], v0], [P[1][0], P[1][1] + 1.05, P[1][2], v0 + 0.125], [P[0][0], P[0][1] + 1.05, P[0][2], v0 + 0.125]];
          for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(V[k][0][0], V[k][1], -V[k][0][1]); uv.push(V[k][2], V[k][3]); nor.push(nx, 0, nz); }
        }
        i += 6.3 | 0;
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const m = new THREE.Mesh(g, ctx.wettable(new THREE.MeshStandardMaterial({ map: boardAtlas(ctx.aniso), roughness: 0.55, side: THREE.DoubleSide }), 0.3)); m.receiveShadow = true; group.add(m);
  }

  // ---- instanced props ----
  const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), cc = new THREE.Color(), UP = new THREE.Vector3(0, 1, 0);
  const instance = (geo, mat, list, { shadow = true, colour = false } = {}) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((o, j) => { qt.setFromAxisAngle(UP, o.rot || 0); im.setMatrixAt(j, m4.compose(pv.set(o.x, o.z, -o.y), qt, sv.set(o.sx ?? o.s ?? 1, o.sy ?? o.s ?? 1, o.sz ?? o.s ?? 1))); if (colour) im.setColorAt(j, cc.setRGB(...(o.col || [1, 1, 1]))); });
    im.castShadow = shadow && quality.shadows; im.receiveShadow = true; im.computeBoundingSphere(); im.computeBoundingBox(); group.add(im); return im;
  };
  const colourGeo = (g, r, gr, b) => { const g2 = g.index ? g.toNonIndexed() : g; const c = new Float32Array(g2.attributes.position.count * 3); for (let k = 0; k < c.length; k += 3) { c[k] = r; c[k + 1] = gr; c[k + 2] = b; } g2.setAttribute('color', new THREE.BufferAttribute(c, 3)); g2.deleteAttribute('uv'); return g2; };

  // street lamps: a mast with a curved arm, lantern lit at night
  {
    const poles = [], heads = [];
    for (let i = 8, k = 0; i < n; i += 27, k++) {
      const side = k % 2 ? 1 : -1; if (M.inTun(i) || used[side][i] === 1) continue;
      const p = at(i, side * (wl(side)[i] + 1.25)); const o = { x: p[0], y: p[1], z: track.z[i] + 0.1, rot: track.heading[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2) };
      poles.push(o); heads.push(o);
    }
    const dark = [0.03, 0.045, 0.04];
    const pg = mergeGeometries([colourGeo(new THREE.CylinderGeometry(0.06, 0.1, 7.6, 6).translate(0, 3.8, 0), ...dark), colourGeo(new THREE.CylinderGeometry(0.16, 0.2, 0.9, 6).translate(0, 0.45, 0), ...dark), colourGeo(new THREE.BoxGeometry(1.7, 0.07, 0.07).rotateZ(0.22).translate(0.82, 7.75, 0), ...dark), colourGeo(new THREE.CylinderGeometry(0.22, 0.12, 0.3, 6).translate(1.62, 7.86, 0), ...dark)]);
    instance(pg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }), poles, { shadow: detail > 0 });
    const hm = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.3, emissive: 0xffd9a0, emissiveIntensity: 0 }); ctx.nightMats.push([hm, 6]);
    instance(new THREE.SphereGeometry(0.2, 8, 5).scale(1, 0.6, 1).translate(1.62, 7.66, 0), hm, heads, { shadow: false });
  }

  // palms: bark trunk and a crown of drooping fronds (alpha-cut leaf texture)
  const palms = [], cards = [];
  {
    // along the pavements in stretches, in the zones marked as gardens, on the terraces
    for (const side of [1, -1]) for (let i = 5; i < n; i += 11) {
      if (M.inTun(i) || used[side][i]) continue;
      const z = zoneMap[side][i], stretch = hash2(Math.floor(i / 130), side + 20) > 0.42 || z === 'garden';
      if (!stretch || free(i, side) < 3.6 || z === 'pit') continue;
      const st = M.step[side][i], off = st > 0.5 ? M.apron[side][i] + 2.2 : wl(side)[i] + 3.1, p = at(i, side * off);
      if (M.isSea(p[0], p[1]) || off > M.lim[side][i] - 1) continue;
      palms.push({ x: p[0], y: p[1], z: track.z[i] + (st > 0.5 ? st : 0.1), s: 0.8 + 0.5 * hash2(i, 77), rot: hash2(i, 5) * 6.28, tall: hash2(Math.floor(i / 130), 2) > 0.6 });
      if (z === 'garden' && free(i, side) > 12) for (let q = 0; q < 2; q++) { const o2 = off + 5 + 7 * hash2(i, q + 40), p2 = at(i + Math.round(8 * hash2(i, q + 9)), side * o2); if (o2 < Math.min(free(i, side) + wl(side)[i] - 2, M.lim[side][i] - 2) && !M.isSea(p2[0], p2[1]) && !footAt(p2[0], p2[1])) { const t = terrain(p2[0], p2[1]); (hash2(i, q) < 0.55 ? palms : cards).push({ x: p2[0], y: p2[1], z: t.h, s: 0.8 + 0.6 * hash2(i, q + 3), rot: hash2(i, q + 8) * 6.28, k: 4 + Math.floor(hash2(i, q + 13) * 4) }); } }
    }
    // parks and gardens from OSM
    const r2 = new RNG(515);
    for (const g of sc.green) {
      const P = pairs(g), A = Math.abs(polyArea(P)); let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const cnt = Math.min(detail > 0 ? 90 : 25, Math.round(A / (detail > 1 ? 70 : 110)));
      for (let k = 0, tries = 0; k < cnt && tries < cnt * 6; tries++) {
        const x = r2.uniform(x0, x1), y = r2.uniform(y0, y1); if (!inPoly(P, x, y)) continue; const t = terrain(x, y); if (t.strip || t.dist < t.corr + 3 || t.dist > 330 || M.isSea(x, y) || footAt(x, y)) continue;
        k++; const o = { x, y, z: t.h - 0.2, s: 0.75 + 0.7 * r2.next(), rot: r2.next() * 6.28, k: 4 + r2.int(4), tall: r2.next() < 0.3 };
        (r2.next() < 0.24 ? palms : cards).push(o);
      }
    }
    // palm geometry
    const pc = document.createElement('canvas'); pc.width = 1024; pc.height = 256; const x = pc.getContext('2d');
    x.clearRect(0, 0, 1024, 256); x.lineCap = 'round';
    // frond: rib along x, long narrow leaflets swept back, shorter towards the tip
    x.strokeStyle = '#4a6427'; x.lineWidth = 5; x.beginPath(); x.moveTo(0, 96); x.lineTo(760, 96); x.stroke();
    for (let u = 16; u < 760; u += 5.2) { const len = 92 * Math.pow(Math.sin(Math.PI * Math.min(1, (u + 110) / 880)), 0.8) * (0.85 + 0.15 * Math.sin(u * 7.3)); for (const s2 of [-1, 1]) { x.strokeStyle = `hsl(${84 + 12 * Math.sin(u + s2)},${42 + 10 * Math.sin(u * 3.1)}%,${19 + 8 * Math.sin(u * 1.7 + s2)}%)`; x.lineWidth = 3.4; x.beginPath(); x.moveTo(u, 96); x.quadraticCurveTo(u + len * 0.25, 96 + s2 * len * 0.5, u + len * 0.62, 96 + s2 * len); x.stroke(); } }
    // bark: ringed, with old frond bases
    for (let v = 192; v < 256; v += 2) for (let u = 0; u < 1024; u += 8) { x.fillStyle = `hsl(${26 + (u * 7 + v * 3) % 9},22%,${19 + ((u * 13 + v * 29) % 15)}%)`; x.fillRect(u, v, 8, 2); }
    for (let u = 0; u < 1024; u += 26) { x.fillStyle = 'rgba(18,12,7,0.6)'; x.fillRect(u, 192, 5, 64); }
    const pt = new THREE.CanvasTexture(pc); pt.colorSpace = THREE.SRGBColorSpace; pt.anisotropy = 4;
    const parts = [];
    { // trunk: a few rings, gentle lean; uv into the bark strip
      const R = 4, S = 5, pos = [], uv = [], idx2 = [];
      for (let r = 0; r <= R; r++) { const t = r / R, y = t * 7.2, rad = 0.25 - 0.09 * t + (r === 0 ? 0.12 : 0), lean = 0.5 * t * t; for (let s2 = 0; s2 <= S; s2++) { const a = s2 / S * 6.283; pos.push(Math.cos(a) * rad + lean, y, Math.sin(a) * rad); uv.push(t * 3, 0.03 + 0.19 * s2 / S); } }
      for (let r = 0; r < R; r++) for (let s2 = 0; s2 < S; s2++) { const a = r * (S + 1) + s2, b = a + S + 1; idx2.push(a, b, a + 1, a + 1, b, b + 1); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx2); g.computeVertexNormals(); parts.push(g.toNonIndexed());
    }
    { // fronds: three tiers (upright, spreading, hanging), each an arching strip folded along its rib
      const NF = detail > 0 ? 13 : 8, pos = [], uv = [], nor = [], q = new RNG(77);
      for (let f = 0; f < NF; f++) {
        const az = f * 2.399 + q.next() * 0.3, tier = f % 3, el0 = tier === 0 ? 1.15 : tier === 1 ? 0.6 : 0.15, len = 3.3 + q.next() * 0.9, SEG = 3, hw = 0.62;
        let px = 0.5, py = 7.2, ang = el0; const ca = Math.cos(az), sa = Math.sin(az); const P = [];
        for (let s2 = 0; s2 <= SEG; s2++) { P.push([px, py, s2 / SEG]); const st = len / SEG; px += Math.cos(ang) * st; py += Math.sin(ang) * st; ang -= 0.5 + 0.12 * tier; }
        for (let s2 = 0; s2 < SEG; s2++) { const a = P[s2], b = P[s2 + 1]; const V = (p, w) => [0.5 + (p[0] - 0.5) * ca - w * sa, p[1] - Math.abs(w) * 0.45, (p[0] - 0.5) * sa + w * ca, p[2] * 0.742, 0.625 + (w / hw) * 0.37]; const A0 = V(a, -hw), A1 = V(a, hw), B0 = V(b, -hw), B1 = V(b, hw);
          for (const v of [A0, B0, B1, A0, B1, A1]) { pos.push(v[0], v[1], v[2]); uv.push(v[3], v[4]); nor.push(ca * 0.3, 0.9, sa * 0.3); } }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); parts.push(g);
    }
    const pg = mergeGeometries(parts);
    const pm = new THREE.MeshStandardMaterial({ map: pt, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 });
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: pt, alphaTest: 0.4, side: THREE.DoubleSide });
    for (const o of palms) { o.sy = o.s * (o.tall ? 1.7 : 1.05); o.sx = o.sz = o.s * (o.tall ? 0.85 : 1.1); o.col = [0.85 + 0.3 * hash2(o.x, o.y), 0.9 + 0.2 * hash2(o.y, o.x), 0.8]; }
    const byCh = Array.from({ length: 6 }, () => []); for (const o of palms) byCh[Math.min(5, Math.floor(nearestIndexGlobal(track, o.x, o.y) / n * 6))].push(o);
    for (const l of byCh) { const im = instance(pg, pm, l, { colour: true }); if (im) { im.customDepthMaterial = dm; ctx.skipOverride?.(im); } }
  }
  // garden trees: the shared impostor atlas (broadleaves and stone-pine clumps)
  if (cards.length) {
    const TILES = { 4: [0.385, 0.984, 10], 5: [0.465, 0.984, 9], 6: [0.492, 0.741, 8], 7: [0.492, 0.937, 13] };
    const quadG = (ang) => { const c = Math.cos(ang), s = Math.sin(ang), g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-c, 0, -s, c, 0, s, c, 1, s, -c, 1, -s], 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute([-c * 0.7, 0.7, -s * 0.7, c * 0.7, 0.7, s * 0.7, c * 0.5, 0.86, s * 0.5, -c * 0.5, 0.86, -s * 0.5], 3)); g.setIndex([0, 1, 2, 0, 2, 3]); return g; };
    const geo = mergeGeometries([quadG(0), quadG(Math.PI / 2)]);
    const uvP = (m) => { m.onBeforeCompile = (sh) => { ctx.wxUniforms(sh); sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aTile;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = aTile.xy + uv * aTile.zw;'); }; m.customProgramCacheKey = () => 'mctree' + m.type; return m; };
    const tm = uvP(new THREE.MeshStandardMaterial({ roughness: 1, alphaTest: 0.42, side: THREE.DoubleSide, visible: false })), dm = uvP(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.42, side: THREE.DoubleSide }));
    loadTexture(ASSETS.trees, { repeat: false, aniso: 4 }).then((t) => { if (!t) return; tm.map = t; dm.map = t; tm.visible = true; tm.needsUpdate = dm.needsUpdate = true; });
    const tile = new Float32Array(cards.length * 4);
    cards.forEach((o, j) => { const T = TILES[o.k], hgt = T[2] * o.s; o.sy = hgt; o.sx = o.sz = hgt * T[0] / T[1]; o.col = [0.95, 1, 0.85]; const col = o.k % 4, row = o.k >> 2; tile.set([(col + 0.5 - T[0]) / 4, 1 - (row + 1) / 2, 2 * T[0] / 4, T[1] / 2], j * 4); });
    geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 4));
    const im = instance(geo, tm, cards, { colour: true }); if (im) { im.customDepthMaterial = dm; im.receiveShadow = false; ctx.skipOverride?.(im); }
  }

  // ---- harbour: pontoons, yachts moored stern-to, the swimming pools ----
  {
    const deck = mkAcc(), wood = srgb('#b9a58a'), pcol = srgb('#d9d6cf');
    const berths = [];                                   // [x, y, nx, ny] every few metres along quays and pontoons, n pointing to open water
    const zq = SEA + 0.75;
    for (const pr of sc.piers) {
      const P = pairs(pr.slice(1), 0.1), wdt = pr[0] / 10;
      if (!P.some(p => M.isSea(p[0], p[1]))) continue;
      if (wdt > 0) {
        for (let k = 0; k + 1 < P.length; k++) {
          const a = P[k], b = P[k + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.5) continue; const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len, nx = -ty * wdt / 2, ny = tx * wdt / 2;
          const R = [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
          quad(deck, [R[0][0], zq, R[0][1], 0, 0], [R[1][0], zq, R[1][1], len / 3, 0], [R[2][0], zq, R[2][1], len / 3, wdt / 3], [R[3][0], zq, R[3][1], 0, wdt / 3], L.CONCRETE, wood, [0, 1, 0]);
          for (let q = 0; q < 4; q++) wall(deck, R[q][0], R[q][1], R[(q + 1) % 4][0], R[(q + 1) % 4][1], SEA - 0.4, zq, L.CONCRETE, pcol);
          for (let s = 3; s < len - 2; s += 1) for (const sg of [1, -1]) berths.push([a[0] + tx * s + nx * sg, a[1] + ty * s + ny * sg, -ty * sg, tx * sg, 0]);
        }
      } else if (P.length >= 3) {
        if (polyArea(P) < 0) P.reverse();
        const f = THREE.ShapeUtils.triangulateShape(P.map(p => new THREE.Vector2(p[0], p[1])), []);
        for (const t of f) { const [a, b, c] = t.map(k => P[k]); for (const p of [a, b, c]) { deck.pos.push(p[0], zq, -p[1]); deck.nor.push(0, 1, 0); deck.fac.push(p[0] / 3, p[1] / 3, L.CONCRETE); deck.tint.push(...wood); } }
        for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]); wall(deck, a[0], a[1], b[0], b[1], SEA - 0.4, zq, L.CONCRETE, pcol); if (len > 6) for (let s = 3; s < len - 2; s += 1) berths.push([a[0] + (b[0] - a[0]) * s / len, a[1] + (b[1] - a[1]) * s / len, (b[1] - a[1]) / len, -(b[0] - a[0]) / len, 0]); }
      }
    }
    // the quays themselves (water on the right of the OSM coastline)
    for (const flatC of sc.coast) { const P = pairs(flatC, 0.1); for (let k = 0; k + 1 < P.length; k++) { const a = P[k], b = P[k + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 5 || a[0] < -40 || a[0] > 900 || a[1] < -520 || a[1] > 140) continue; for (let s = 2.5; s < len - 2; s += 1) berths.push([a[0] + (b[0] - a[0]) * s / len, a[1] + (b[1] - a[1]) * s / len, (b[1] - a[1]) / len, -(b[0] - a[0]) / len, 1]); } }
    { const g = accGeo(deck); if (g) { const m = new THREE.Mesh(g, facMat); m.receiveShadow = true; group.add(m); } }

    // yacht hulls: three types as unit-length geometry (bow towards +x)
    const yacht = (kind) => {
      const pos = [], col = [];
      const Q = (a, b, c, d, cl) => { for (const p of [a, b, c, a, c, d]) { pos.push(p[0], p[1], p[2]); col.push(cl[0], cl[1], cl[2]); } };
      const white = [0.92, 0.92, 0.9], boot = [0.02, 0.035, 0.07], glass = [0.03, 0.045, 0.06], teak = [0.5, 0.36, 0.2], grey = [0.55, 0.57, 0.6];
      const B = kind === 2 ? 0.085 : 0.105, F = kind === 2 ? 0.04 : kind === 1 ? 0.062 : 0.055;
      const xs = [-0.5, -0.46, -0.3, -0.1, 0.1, 0.25, 0.36, 0.44, 0.5];
      const bd = (x) => x < 0.0 ? B * (kind === 2 ? 0.72 + 0.28 * (x + 0.5) / 0.5 : 0.93 + 0.07 * (x + 0.5) / 0.5) : B * Math.max(0.012, 1 - Math.pow(x / 0.5, 2.3));
      const zd = (x) => F * (1 + 0.5 * Math.pow(Math.max(0, x + 0.1) / 0.6, 2));
      const S = xs.map(x => ({ x: x + (x > 0.3 ? 0 : 0), b: bd(x), z: zd(x) }));
      for (let k = 0; k + 1 < S.length; k++) for (const sg of [1, -1]) {
        const a = S[k], b = S[k + 1], P = (s, lvl) => lvl === 0 ? [s.x - (s.x > 0.3 ? 0.03 * (s.x - 0.3) / 0.2 : 0), -0.02, sg * s.b * 0.8] : lvl === 1 ? [s.x, 0.008, sg * s.b * 0.88] : [s.x + (s.x > 0.3 ? 0.03 * (s.x - 0.3) / 0.2 : 0), s.z, sg * s.b];
        for (const [l0, l1, cl] of [[0, 1, boot], [1, 2, white]]) { if (sg > 0) Q(P(a, l0), P(a, l1), P(b, l1), P(b, l0), cl); else Q(P(b, l0), P(b, l1), P(a, l1), P(a, l0), cl); }
        if (sg > 0) Q([a.x, a.z, a.b], [a.x, a.z, -a.b], [b.x + (b.x > 0.3 ? 0.03 * (b.x - 0.3) / 0.2 : 0), b.z, -b.b], [b.x + (b.x > 0.3 ? 0.03 * (b.x - 0.3) / 0.2 : 0), b.z, b.b], k < 3 ? teak : white);
      }
      { const s = S[0]; Q([s.x, -0.02, -s.b * 0.8], [s.x, s.z, -s.b], [s.x, s.z, s.b], [s.x, -0.02, s.b * 0.8], white); }
      // superstructure tier: raked front, window band
      const tier = (x0, x1, w, z0, z1, rake, band = true) => {
        const A = [[x0, z0, -w], [x1, z0, -w * 0.82], [x1, z0, w * 0.82], [x0, z0, w]], T = [[x0 + rake * 0.25, z1, -w * 0.94], [x1 - rake, z1, -w * 0.74], [x1 - rake, z1, w * 0.74], [x0 + rake * 0.25, z1, w * 0.94]];
        for (let k = 0; k < 4; k++) { const a = A[k], b = A[(k + 1) % 4], c = T[(k + 1) % 4], d = T[k]; Q(b, a, d, c, white);
          if (band && k !== 3) { const e = 0.0012, m0 = 0.3, m1 = 0.78, L2 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t], out = k === 0 ? [0, 0, -e] : k === 2 ? [0, 0, e] : [e, 0, 0], sh = (p) => [p[0] + out[0], p[1], p[2] + out[2]], i0 = 0.06, i1 = 0.94;
            Q(sh(L2(L2(b, a, i0), L2(c, d, i0), m0)), sh(L2(L2(b, a, i1), L2(c, d, i1), m0)), sh(L2(L2(b, a, i1), L2(c, d, i1), m1)), sh(L2(L2(b, a, i0), L2(c, d, i0), m1)), glass); } }
        Q(T[0], T[3], T[2], T[1], white);
      };
      if (kind === 0) { tier(-0.3, 0.2, B * 0.74, zd(-0.2), zd(-0.2) + 0.065, 0.1); tier(-0.24, 0.0, B * 0.5, zd(0) + 0.065, zd(0) + 0.085, 0.05, false); tier(-0.2, -0.17, B * 0.55, zd(0) + 0.085, zd(0) + 0.13, 0.0, false); }
      else if (kind === 1) { tier(-0.38, 0.27, B * 0.86, zd(-0.2), zd(-0.2) + 0.052, 0.07); tier(-0.33, 0.15, B * 0.76, zd(-0.2) + 0.052, zd(-0.2) + 0.1, 0.07); tier(-0.24, 0.05, B * 0.6, zd(-0.2) + 0.1, zd(-0.2) + 0.14, 0.06); tier(-0.14, -0.09, B * 0.3, zd(-0.2) + 0.14, zd(-0.2) + 0.2, 0.01, false); tier(-0.17, -0.06, B * 0.5, zd(-0.2) + 0.2, zd(-0.2) + 0.208, 0.0, false); }
      else { tier(-0.2, 0.12, B * 0.5, zd(0), zd(0) + 0.028, 0.08); const mz = zd(0), mr = 0.0045; for (const [x0, x1, z0, z1] of [[0.05 - mr, 0.05 + mr, mz, mz + 1.15], [-0.36, 0.05, mz + 0.1, mz + 0.112]]) { const w = mr; Q([x0, z0, w], [x1, z0, w], [x1, z1, w], [x0, z1, w], grey); Q([x1, z0, -w], [x0, z0, -w], [x0, z1, -w], [x1, z1, -w], grey); Q([x0, z0, -w], [x0, z0, w], [x0, z1, w], [x0, z1, -w], grey); Q([x1, z0, w], [x1, z0, -w], [x1, z1, -w], [x1, z1, w], grey); } Q([-0.34, mz + 0.115, 0.004], [0.04, mz + 0.115, 0.004], [0.04, mz + 0.13, 0.004], [-0.34, mz + 0.13, 0.004], [0.85, 0.85, 0.8]); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
    };
    const lists = [[], [], []], placed = [], q = new RNG(606), cap = detail > 1 ? 520 : detail > 0 ? 380 : 90;
    const ok = (x, y, nx, ny, len, beam) => {
      const T = [0.03, 0.27, 0.52, 0.77, 1.02], Wd = [-0.5, 0, 0.5];
      for (const t of T) for (const w of Wd) { const px = x + nx * len * t - ny * beam * w, py = y + ny * len * t + nx * beam * w; if (!M.isSea(px, py) || M.seaDist(px, py) < 0.3) return false; }
      const cx = x + nx * len * 0.5, cy = y + ny * len * 0.5;
      for (const o of placed) {
        if (Math.hypot(o.cx - cx, o.cy - cy) > (o.len + len) * 0.5 + 2) continue;
        for (const t of T) for (const w of Wd) { const px = x + nx * len * t - ny * beam * w - o.cx, py = y + ny * len * t + nx * beam * w - o.cy; if (Math.abs(px * o.nx + py * o.ny) < o.len / 2 + 0.6 && Math.abs(-px * o.ny + py * o.nx) < o.beam / 2 + 0.5) return false; }
      }
      return true;
    };
    berths.sort((p, q2) => q2[4] - p[4]);
    let skip = 0;
    for (let k = 0; k < berths.length && placed.length < cap; k++) {
      if (skip > 0) { skip -= 1; continue; }
      const [bx, by, nx, ny, quay] = berths[k]; if (!M.isSea(bx + nx * 3, by + ny * 3)) continue;
      const t = terrain(bx, by); if (t.dist > 520) continue;
      if (q.next() < 0.12) { skip = 6; continue; }
      let room = 0; for (let d = 4; d <= 76; d += 4) { if (!M.isSea(bx + nx * d, by + ny * d)) break; room = d; }
      const big = quay && room > 60 && q.next() < 0.5;
      let len = big ? q.uniform(38, 60) : Math.min(room * 0.72, q.uniform(9, quay ? 30 : 20) * (q.next() < 0.12 ? 1.5 : 1)); if (len < 8) continue;
      const kind = len > 27 ? 1 : q.next() < (quay ? 0.12 : 0.3) ? 2 : 0, beam = len * (kind === 2 ? 0.17 : 0.21), x = bx + nx * 1.2, y = by + ny * 1.2;
      if (!ok(x, y, nx, ny, len, beam)) { continue; }
      placed.push({ cx: x + nx * len / 2, cy: y + ny * len / 2, len, beam, nx, ny });
      const hc = q.next(), cl = hc < 0.72 ? [1, 1, 1] : hc < 0.86 ? [0.16, 0.2, 0.3] : hc < 0.94 ? [0.55, 0.57, 0.6] : [0.9, 0.84, 0.7];
      lists[kind].push({ x: x + nx * len / 2, y: y + ny * len / 2, z: SEA - 0.05, s: len, rot: Math.atan2(ny, nx), col: cl });
      skip = Math.ceil(beam + 0.8 + q.next() * 0.8);
    }
    const ym = ctx.wettable(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.0, side: THREE.DoubleSide }), 0.15);
    lists.forEach((l, kind) => instance(yacht(kind), ym, l, { colour: true }));

    // pools
    const wp = [], wi = [];
    for (const pf of sc.pools) { const P = pairs(pf, 0.1); if (polyArea(P) < 0) P.reverse(); if (P.some(p => M.isSea(p[0], p[1]))) continue; let z = -1e9; for (const p of P) z = Math.max(z, terrain(p[0], p[1]).h); const o = wp.length / 3, f = THREE.ShapeUtils.triangulateShape(P.map(p => new THREE.Vector2(p[0], p[1])), []); for (const p of P) wp.push(p[0], z + 0.06, -p[1]); for (const t of f) wi.push(o + t[0], o + t[1], o + t[2]);
      for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.3) continue; const nx = (b[1] - a[1]) / len * 0.6, ny = -(b[0] - a[0]) / len * 0.6; quad(flat, [a[0], z + 0.1, a[1], 0, 0], [a[0] + nx, z + 0.1, a[1] + ny, 0.1, 0], [b[0] + nx, z + 0.1, b[1] + ny, 0.1, len / 6], [b[0], z + 0.1, b[1], 0, len / 6], L.CONCRETE, srgb('#f1eee6'), [0, 1, 0]); } }
    if (wi.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3)); g.setIndex(wi); g.computeVertexNormals(); const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x18b4c9, roughness: 0.06, emissive: 0x0a5560, emissiveIntensity: 0.25 })); m.receiveShadow = true; group.add(m); }
  }

  // ---- the tunnel ----
  buildTunnel(K, { at, sweep, range, accs, flat });

  { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(gn, 3)); const m = new THREE.Mesh(g, groundMat); m.receiveShadow = true; group.add(m); }
  for (const A of accs) { const g = accGeo(A); if (g) group.add(cast(new THREE.Mesh(g, facMat))); }
  { const g = accGeo(flat); if (g) { const m = new THREE.Mesh(g, facMat); m.receiveShadow = true; group.add(m); } }
}

// The tunnel under the Fairmont: lined walls with a painted dado, a flat soffit with two rows of lamps, portals.
function buildTunnel(K, { at, sweep, range, accs, flat }) {
  const { M, ctx, track, group, quad, srgb, mkAcc, accGeo, facMat } = K, n = track.n;
  for (const [a, b] of M.tun) {
    const I = range(a, b), H = 5.6, pos = [], col = [], idx = [];
    // inside: self-lit (the lamps are on day and night), brightness painted per vertex
    const ring = (i) => { const z = track.z[i], l = track.wallL[i] + 0.35, r = track.wallR[i] + 0.35, e = track.hw[i] + 0.03; return [[e, z - 0.04, 0.3], [e, z + 0.2, 0.5], [l, z + 0.2, 0.36], [l, z + 0.45, 0.5], [l, z + 0.46, 0.75], [l, z + 0.95, 0.75], [l, z + 0.96, 0.62], [l, z + 1.3, 0.62], [l, z + 1.32, 0.34], [l, z + 4.2, 0.3], [l - 1.2, z + H, 0.24], [-(r - 1.2), z + H, 0.24], [-r, z + 4.2, 0.3], [-r, z + 1.32, 0.34], [-r, z + 1.3, 0.62], [-r, z + 0.96, 0.62], [-r, z + 0.95, 0.75], [-r, z + 0.46, 0.75], [-r, z + 0.45, 0.5], [-r, z + 0.2, 0.36], [-e, z + 0.2, 0.5], [-e, z - 0.04, 0.3]]; };
    let prev = -1;
    for (const i of I) {
      const P = ring(i), base = pos.length / 3, s = i * track.ds, pool = 0.75 + 0.25 * Math.cos(s / 9 * 6.283);
      const ends = Math.min(1, (i - a) / 30, (b - i) / 30), day = 1 + 1.6 * (1 - ends) * (1 - ends);
      for (const [off, z, v] of P) { const p = at(i, off); pos.push(p[0], z, -p[1]); const k = v * pool * day; col.push(k * 1.0, k * 0.9, k * 0.72); }
      if (prev >= 0) for (let k = 0; k < P.length - 1; k++) idx.push(prev + k, base + k, prev + k + 1, prev + k + 1, base + k, base + k + 1);
      prev = base;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const lining = new THREE.Mesh(g, ctx.patch(new THREE.MeshBasicMaterial({ vertexColors: true, map: ctx.concreteMap, side: THREE.DoubleSide }), 'mctun', {
      vpars: 'varying vec3 vWPos;', vmain: 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;', fpars: 'varying vec3 vWPos;',
      color: 'diffuseColor.rgb *= (0.8 + 0.4 * vnoise(vec2(vWPos.x + vWPos.z, vWPos.y * 2.0) * 0.8)) * (0.92 + 0.08 * step(0.04, fract((vWPos.x + vWPos.z) / 2.4)));' }));
    { const uvs = new Float32Array(pos.length / 3 * 2); for (let k = 0; k < uvs.length / 2; k++) { uvs[k * 2] = (pos[k * 3] - pos[k * 3 + 2]) / 2.2; uvs[k * 2 + 1] = pos[k * 3 + 1] / 2.2 + pos[k * 3] / 5; } g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2)); }
    group.add(lining);
    // lamps: two rows of bright fittings on the soffit
    const lp = [], li = [];
    for (let i = a + 3; i < b - 2; i += 6) for (const off of [2.5, -2.5]) { const o = lp.length / 3; for (const [di, dw] of [[0, -0.28], [3, -0.28], [3, 0.28], [0, 0.28]]) { const p = at(i + di, off + dw); lp.push(p[0], track.z[(i + di) % n] + H - 0.05, -p[1]); } li.push(o, o + 1, o + 2, o, o + 2, o + 3); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setIndex(li);
    group.add(new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ color: new THREE.Color(4.2, 3.6, 2.5), fog: false, side: THREE.DoubleSide })));
    // outside: a concrete box, hidden inside the buildings and the podium for most of its length, and the two portals
    const conc = srgb('#cfcabf'), A = accs[Math.min(accs.length - 1, Math.floor(a / n * accs.length))];
    sweep(A, I, 1, (i) => [[track.wallL[i] + 1.3, track.z[i] - 3, 0], [track.wallL[i] + 1.3, track.z[i] + H + 1.1, 1]], L_CONC, conc, { back: true });
    sweep(A, I, -1, (i) => [[track.wallR[i] + 1.3, track.z[i] - 3, 0], [track.wallR[i] + 1.3, track.z[i] + H + 1.1, 1]], L_CONC, conc, { back: true });
    sweep(A, I, 1, (i) => [[-(track.wallR[i] + 1.3), track.z[i] + H + 1.1, 0], [track.wallL[i] + 1.3, track.z[i] + H + 1.1, 2]], L_CONC, conc);
    for (const [i, dir] of [[a, -1], [b, 1]]) {
      // portal: wing walls and a deep lintel with a parapet, facing the approaching (or departing) driver
      const z = track.z[i], l = track.wallL[i] + 0.35, r = track.wallR[i] + 0.35, top = z + 8.4, wing = 13;
      const P = (off, h, u, v) => { const p = at(i, off); return [p[0], h, p[1], u, v]; };
      const F = (p0, p1, p2, p3) => { if (dir < 0) quad(A, p0, p1, p2, p3, L_CONC, conc); else quad(A, p1, p0, p3, p2, L_CONC, conc); };
      F(P(l + wing, z - 2, 0, 0), P(l, z - 2, wing / 6.4, 0), P(l, top, wing / 6.4, 1.6), P(l + wing, top, 0, 1.6));
      F(P(-r, z - 2, 0, 0), P(-(r + wing), z - 2, wing / 6.4, 0), P(-(r + wing), top, wing / 6.4, 1.6), P(-r, top, 0, 1.6));
      F(P(l, z + 4.2, 0, 0.6), P(-r, z + 4.2, 2, 0.6), P(-r, top, 2, 1.2), P(l, top, 0, 1.2));
    }
  }
}
const L_CONC = L.CONCRETE;
