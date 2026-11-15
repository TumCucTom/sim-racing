// Monaco street dressing: pavements, retaining walls and quays, the tunnel, harbour, grandstands, palms, landmarks.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nearestIndexGlobal } from '../sim/track.js';
import { RNG } from '../sim/rng.js';
import { L, LSIZE, boardAtlas } from './monaco-tex.js';
import { polyArea, inPoly, insetPoly } from './monaco.js';

export function prepMonaco(K) {
}

export function dressMonaco(K) {
  const { M, ctx, track, sc, W, SEA, terrain, group, quality, detail, cast, facMat, mkAcc, accGeo, quad, wall, srgb, groundMat } = K, n = track.n;
  const STONE = srgb('#cdbfa6'), CONC = srgb('#d6d1c6');
  const A = mkAcc();                                   // façade-material geometry of this module
  const gp = [], gn = [];                              // ground-material geometry (flat tops)
  const top = (a, b, c, d) => { for (const p of [a, b, c, a, c, d]) { gp.push(p[0], p[1], -p[2]); gn.push(0, 1, 0); } };   // [x, h, y]
  const at = (i, off) => { const h = track.heading[i]; return [track.x[i] - Math.sin(h) * off, track.y[i] + Math.cos(h) * off]; };

  // ---- pavement behind the barriers, retaining walls and terraces ----
  {
    const ST = 2, PV = 0.11;
    for (const side of [1, -1]) {
      const wl = side > 0 ? track.wallL : track.wallR, ap = M.apron[side], tr = M.terr[side], st = M.step[side];
      let per = 0;
      for (let i = 0; i < n; i += ST) {
        const j = (i + ST) % n; per += ST;
        if (M.inTun(i) || M.inTun(j)) continue;
        const zi = track.z[i] + PV, zj = track.z[j] + PV;
        const a0 = at(i, side * (wl[i] - 0.3)), a1 = at(i, side * ap[i]), b0 = at(j, side * (wl[j] - 0.3)), b1 = at(j, side * ap[j]);
        const F = side > 0 ? (p, q, r, s) => top(p, q, r, s) : (p, q, r, s) => top(q, p, s, r);
        F([a0[0], zi, a0[1]], [b0[0], zj, b0[1]], [b1[0], zj, b1[1]], [a1[0], zi, a1[1]]);
        const si = st[i], sj = st[j], u0 = per / 6.4, u1 = (per + ST) / 6.4;
        let oi = a1, oj = b1, hi = zi, hj = zj;
        if (si || sj) {
          const ti = track.z[i] + si, tj = track.z[j] + sj, c1 = at(i, side * Math.max(tr[i], ap[i] + 0.5)), d1 = at(j, side * Math.max(tr[j], ap[j] + 0.5));
          // the wall: faces the road where the hill rises, faces away where the ground drops
          const up = si + sj > 0;
          if ((side > 0) === up) quad(A, [b1[0], Math.min(zj, tj), b1[1], u1, Math.min(zj, tj) / 6.4], [a1[0], Math.min(zi, ti), a1[1], u0, Math.min(zi, ti) / 6.4], [a1[0], Math.max(zi, ti), a1[1], u0, Math.max(zi, ti) / 6.4], [b1[0], Math.max(zj, tj), b1[1], u1, Math.max(zj, tj) / 6.4], L.STONE, STONE);
          else quad(A, [a1[0], Math.min(zi, ti), a1[1], u0, Math.min(zi, ti) / 6.4], [b1[0], Math.min(zj, tj), b1[1], u1, Math.min(zj, tj) / 6.4], [b1[0], Math.max(zj, tj), b1[1], u1, Math.max(zj, tj) / 6.4], [a1[0], Math.max(zi, ti), a1[1], u0, Math.max(zi, ti) / 6.4], L.STONE, STONE);
          F([a1[0], ti, a1[1]], [b1[0], tj, b1[1]], [d1[0], tj, d1[1]], [c1[0], ti, c1[1]]);
          oi = c1; oj = d1; hi = ti; hj = tj;
        }
        // skirt down from the outer edge, facing outwards
        const dz = 3.5;
        if (side > 0) quad(A, [oi[0], hi - dz, oi[1], u0, (hi - dz) / 6.4], [oj[0], hj - dz, oj[1], u1, (hj - dz) / 6.4], [oj[0], hj, oj[1], u1, hj / 6.4], [oi[0], hi, oi[1], u0, hi / 6.4], L.STONE, STONE);
        else quad(A, [oj[0], hj - dz, oj[1], u1, (hj - dz) / 6.4], [oi[0], hi - dz, oi[1], u0, (hi - dz) / 6.4], [oi[0], hi, oi[1], u0, hi / 6.4], [oj[0], hj, oj[1], u1, hj / 6.4], L.STONE, STONE);
      }
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
        quad(A, [a[0], SEA - 2.5, a[1], ua, (SEA - 2.5) / 6.4], [b[0], SEA - 2.5, b[1], ub, (SEA - 2.5) / 6.4], [b[0], zb, b[1], ub, zb / 6.4], [a[0], za, a[1], ua, za / 6.4], L.STONE, CONC);
        if (ta.dist < 160) quad(A, [a[0], za, a[1], ua, 0], [b[0], zb, b[1], ub, 0], [b[0] - nx * 0.7, zb, b[1] - ny * 0.7, ub, 0.11], [a[0] - nx * 0.7, za, a[1] - ny * 0.7, ua, 0.11], L.CONCRETE, CONC, [0, 1, 0]);
      }
    }
  }

  { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(gn, 3)); const m = new THREE.Mesh(g, groundMat); m.receiveShadow = true; group.add(m); }
  { const g = accGeo(A); if (g) group.add(cast(new THREE.Mesh(g, facMat))); }
}
