// Procedural body for the stock Mini hatch (F56 proportions): a lofted lower body
// with cut wheel arches, a dark glass house lofted in horizontal slices, a
// contrast "floating" roof, and surface-following details (lamps, grille, stripes,
// shut lines) projected onto the shell.
//
// Everything is built in "body" coordinates: u along the car (0 = middle of the
// body, + forward), y up from the road, z to the right; the group is then placed
// so the axles land on the simulated wheelbase.
import * as THREE from 'three';

// monotone cubic through [[u, v], ...] (no overshoot between keys)
function curve(keys) {
  const n = keys.length, x = keys.map(k => k[0]), y = keys.map(k => k[1]), d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 * d[i - 1] * d[i] / (d[i - 1] + d[i]);
  return (u) => {
    if (u <= x[0]) return y[0]; if (u >= x[n - 1]) return y[n - 1];
    let i = 0; while (x[i + 1] < u) i++;
    const h = x[i + 1] - x[i], t = (u - x[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const L = 3.85, HL = L / 2, HWMAX = 0.865;
// side profile of the lower body: top line (tail, waist under the cabin, bonnet, nose), floor, shoulder, plan half-width
const TOP = curve([[-HL, 0.64], [-1.90, 0.85], [-1.84, 0.935], [-1.74, 0.972], [-1.5, 0.975], [0.86, 0.975], [0.95, 0.972], [1.2, 0.945], [1.45, 0.90], [1.65, 0.85], [1.78, 0.80], [1.86, 0.745], [1.905, 0.685], [HL, 0.60]]);
const FLOOR = curve([[-HL, 0.36], [-1.90, 0.29], [-1.8, 0.25], [-1.6, 0.21], [-1.0, 0.17], [1.0, 0.17], [1.6, 0.19], [1.84, 0.21], [1.90, 0.245], [HL, 0.30]]);
const SHOULDER = curve([[-HL, 0.95], [0.86, 0.95], [1.1, 0.925], [1.4, 0.875], [1.65, 0.81], [1.8, 0.75], [HL, 0.59]]);
const HALFW = curve([[-HL, 0.63], [-1.90, 0.725], [-1.84, 0.79], [-1.7, 0.84], [-1.45, 0.862], [-1.0, HWMAX], [1.2, HWMAX], [1.45, 0.858], [1.62, 0.84], [1.75, 0.805], [1.85, 0.75], [1.90, 0.68], [HL, 0.57]]);
// glass house (horizontal slices) and roof
const BELT = 0.95, GTOP = 1.368, ROOF_H = 1.41;
const houseAt = (y) => {
  const t = (y - BELT) / (GTOP - BELT);
  return { xF: 0.88 - 0.36 * t, xR: -1.74 + 0.26 * t, w: 0.775 - 0.115 * t - 0.03 * t * t, rF: 0.25, rR: 0.17 };
};
const SUB = [2, 3, 5, 8, 7, 3, 3, 5, 4];

export function buildMiniBody({ a, bb, wheelR, archR, zInner, ghost, mats }) {
  const { paintMat, roofMat, glassMat, black, tailMat } = mats;
  const X0 = (a - bb) / 2 + 0.0925;                 // 0.77 m front overhang, 0.585 m rear
  const g = new THREE.Group(); g.position.x = X0;
  const arches = ghost ? [] : [{ u: a - X0, R: wheelR, Ra: archR }, { u: -bb - X0, R: wheelR, Ra: archR }];
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, metalness: 1, roughness: 0.16 });
  const linerMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.95 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.62 });
  const gloss = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.25, metalness: 0.3 });
  const mk = (pos, idx) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals(); return geo; };
  const add = (geo, mat, shadow = false) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; m.receiveShadow = shadow; g.add(m); return m; };

  // ---- lower body: sections along u -------------------------------------------------
  const sectionAt = (u) => {
    const f = FLOOR(u), t = TOP(u), w = HALFW(u), b = Math.min(SHOULDER(u), t - 0.006), h = b - f, crown = t - b;
    const base = [[0, f], [w - 0.14, f], [w - 0.045, f + Math.min(0.05, 0.1 * h)], [w - 0.01, f + 0.26 * h], [w, f + 0.56 * h], [w - 0.012, f + 0.84 * h],
      [w - 0.04, b - 0.022], [w - 0.085, b + Math.min(0.012, crown * 0.3)], [0.55 * w, b + crown * 0.86], [0, t]];
    const pts = [], cr = (p0, p1, p2, p3, s) => 0.5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);
    for (let k = 0; k < base.length - 1; k++) {
      const p0 = base[Math.max(0, k - 1)], p1 = base[k], p2 = base[k + 1], p3 = base[Math.min(base.length - 1, k + 2)];
      for (let j = 0; j < SUB[k]; j++) {
        const s = j / SUB[k];
        pts.push(k === 0 ? [p1[0] + (p2[0] - p1[0]) * s, p1[1]] : [Math.max(0, Math.min(w, cr(p0[0], p1[0], p2[0], p3[0], s))), cr(p0[1], p1[1], p2[1], p3[1], s)]);
      }
    }
    pts.push(base[base.length - 1]);
    return pts;
  };
  const NS = 150, us = [], sect = [];
  for (let s = 0; s < NS; s++) { const q = s / (NS - 1); us.push(-HL + L * ((0.5 - 0.5 * Math.cos(q * Math.PI)) * 0.3 + q * 0.7)); sect.push(sectionAt(us[s])); }
  const P = sect[0].length;
  const pos = [], idx = [], vmap = new Map(), rowOf = [], CLAD = SUB[0] + SUB[1] + 2;
  const vert = (s, p, side) => {
    const key = s * 1000 + p * 2 + (side > 0 ? 1 : 0);
    let i = vmap.get(key);
    if (i === undefined) { i = pos.length / 3; pos.push(us[s], sect[s][p][1], sect[s][p][0] * side); vmap.set(key, i); }
    return i;
  };
  for (let s = 0; s < NS - 1; s++) for (let p = 0; p < P - 1; p++) for (const side of [1, -1]) {
    const A = vert(s, p, side), B = vert(s + 1, p, side), C = vert(s, p + 1, side), D = vert(s + 1, p + 1, side);
    if (side > 0) idx.push(A, B, C, C, B, D); else idx.push(A, C, B, C, D, B);
    rowOf.push(p, p);
  }
  for (const [s, flip] of [[0, true], [NS - 1, false]]) {
    const ci = pos.length / 3; pos.push(us[s], (sect[s][0][1] + sect[s][P - 1][1]) / 2, 0);
    for (const side of [1, -1]) for (let p = 0; p < P - 1; p++) {
      const A = vert(s, p, side), B = vert(s, p + 1, side);
      if ((side > 0) !== flip) idx.push(ci, B, A); else idx.push(ci, A, B);
    }
  }
  // wheel arches: snap the ring of vertices nearest the opening onto its circle, sink the ones inside into a dark well
  const nV = pos.length / 3, inside = new Uint8Array(nV), SNAP = 0.024;
  for (let i = 0; i < nV; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (Math.abs(z) < zInner) continue;
    for (const ar of arches) {
      const dx = x - ar.u, dy = y - ar.R, d = Math.hypot(dx, dy);
      if (d < ar.Ra - SNAP) { inside[i] = 1; pos[i * 3 + 2] = Math.sign(z) * zInner; }
      else if (d < ar.Ra + SNAP) { pos[i * 3] = ar.u + dx / d * ar.Ra; pos[i * 3 + 1] = ar.R + dy / d * ar.Ra; }
    }
  }
  const tris = [[], [], []];   // paint, black sill / valance, wheel-well liner
  for (let t = 0; t < idx.length; t += 3) {
    const A = idx[t], B = idx[t + 1], C = idx[t + 2];
    const low = t / 3 < rowOf.length && rowOf[t / 3] < CLAD;
    tris[inside[A] || inside[B] || inside[C] ? 2 : low ? 1 : 0].push(A, B, C);
  }
  const bodyGeo = mk(pos, [...tris[0], ...tris[1], ...tris[2]]);
  bodyGeo.addGroup(0, tris[0].length, 0); bodyGeo.addGroup(tris[0].length, tris[1].length, 1); bodyGeo.addGroup(tris[0].length + tris[1].length, tris[2].length, 2);
  add(bodyGeo, [paintMat, trimMat, linerMat], true);

  // ---- queries on the analytic shell ---------------------------------------------------
  const secLerp = (u) => {
    let lo = 0, hi = NS - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (us[m] <= u) lo = m; else hi = m; }
    return [sect[lo], sect[hi], Math.max(0, Math.min(1, (u - us[lo]) / (us[hi] - us[lo])))];
  };
  const inBody = (u, y, z) => {
    if (u < -HL || u > HL) return false;
    const [A, B, t] = secLerp(u), az = Math.abs(z);
    let c = false;       // half polygon, closed along the centre line: even-odd crossing test
    for (let i = 0, j = P - 1; i < P; j = i++) {
      const zi = A[i][0] + (B[i][0] - A[i][0]) * t, yi = A[i][1] + (B[i][1] - A[i][1]) * t, zj = A[j][0] + (B[j][0] - A[j][0]) * t, yj = A[j][1] + (B[j][1] - A[j][1]) * t;
      if ((yi > y) !== (yj > y) && az < (zj - zi) * (y - yi) / (yj - yi) + zi) c = !c;
    }
    return c;
  };
  const inHouse = (u, y, z) => {
    if (y < 0.9 || y > GTOP) return false;
    const h = houseAt(y), az = Math.abs(z);
    if (az > h.w || u > h.xF || u < h.xR) return false;
    if (u > h.xF - h.rF && az > h.w - h.rF) return Math.hypot(u - (h.xF - h.rF), az - (h.w - h.rF)) <= h.rF;
    if (u < h.xR + h.rR && az > h.w - h.rR) return Math.hypot(u - (h.xR + h.rR), az - (h.w - h.rR)) <= h.rR;
    return true;
  };
  const solid = (u, y, z) => inBody(u, y, z) || inHouse(u, y, z);
  // first point of the shell along a ray (march, then bisect)
  const hit = (o, d, far = 1.3, step = 0.02) => {
    if (solid(o.x, o.y, o.z)) return null;
    for (let s = step; s <= far; s += step) {
      if (!solid(o.x + d.x * s, o.y + d.y * s, o.z + d.z * s)) continue;
      let lo = s - step, hi = s;
      for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (solid(o.x + d.x * m, o.y + d.y * m, o.z + d.z * m)) hi = m; else lo = m; }
      return new THREE.Vector3(o.x + d.x * lo, o.y + d.y * lo, o.z + d.z * lo);
    }
    return null;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // a (nu x nv) sheet whose vertices are dropped onto the shell along `dir` and floated `lift` above it
  const patchGeo = (nu, nv, origin, dir, lift = 0.004) => {
    const p = [], ix = [], ok = [];
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const h = hit(origin(i / nu, j / nv), dir);
      ok.push(!!h); if (h) p.push(h.x - dir.x * lift, h.y - dir.y * lift, h.z - dir.z * lift); else p.push(0, 0, 0);
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const A = i * (nv + 1) + j, B = A + nv + 1, C = A + 1, D = B + 1;
      if (ok[A] && ok[B] && ok[C] && ok[D]) ix.push(A, B, C, C, B, D);
    }
    return mk(p, ix);
  };
  const decalMat = (m) => { const c = m.clone(); c.side = THREE.DoubleSide; c.polygonOffset = true; c.polygonOffsetFactor = -2; c.polygonOffsetUnits = -2; return c; };
  // filled outline (closed list of [p, q] offsets around a centre), mapped to ray origins by `map`
  const disc = (outline, map, dir, mat, lift, rings = 3) => add(patchGeo(rings, outline.length, (r, k) => { const o = outline[Math.round(k * outline.length) % outline.length]; return map(o[0] * r, o[1] * r); }, dir, lift), mat);
  const superEllipse = (ra, rb, n, N = 28) => Array.from({ length: N }, (_, k) => { const th = k / N * Math.PI * 2, c = Math.cos(th), s = Math.sin(th), r = Math.pow(Math.pow(Math.abs(c / ra), n) + Math.pow(Math.abs(s / rb), n), -1 / n); return [c * r, s * r]; });
  const poly = (pts, per = 5) => { const out = []; for (let i = 0; i < pts.length; i++) { const A = pts[i], B = pts[(i + 1) % pts.length]; for (let j = 0; j < per; j++) out.push([A[0] + (B[0] - A[0]) * j / per, A[1] + (B[1] - A[1]) * j / per]); } return out; };
  const FWD = V(-1, 0, 0), BACK = V(1, 0, 0), DOWN = V(0, -1, 0);
  const sideZ = (u, y) => { const h = hit(V(u, y, 1.2), V(0, 0, -1), 1.2, 0.03); return h ? h.z : 0; };

  // ---- glass house and roof ------------------------------------------------------------
  const outline = (h, grow = 0) => {
    const w = h.w + grow, xF = h.xF + grow, xR = h.xR - grow, rF = h.rF + grow, rR = h.rR + grow, o = [];
    for (let k = 0; k < 5; k++) o.push([xR, (w - rR) * k / 5]);
    for (let k = 0; k < 9; k++) { const th = Math.PI - k / 9 * Math.PI / 2; o.push([xR + rR + Math.cos(th) * rR, w - rR + Math.sin(th) * rR]); }
    for (let k = 0; k < 16; k++) o.push([xR + rR + (xF - rF - xR - rR) * k / 16, w]);
    for (let k = 0; k < 11; k++) { const th = Math.PI / 2 - k / 11 * Math.PI / 2; o.push([xF - rF + Math.cos(th) * rF, w - rF + Math.sin(th) * rF]); }
    for (let k = 0; k <= 6; k++) o.push([xF, (w - rF) * (1 - k / 6)]);
    return o;
  };
  // rings: [outline, y(u)] pairs joined into a closed band (both sides)
  const band = (rings) => {
    const p = [], ix = [], M = rings[0].o.length;
    for (const r of rings) for (const side of [1, -1]) for (let k = 0; k < M; k++) p.push(r.o[k][0], typeof r.y === 'function' ? r.y(r.o[k][0], r.o[k][1]) : r.y, r.o[k][1] * side);
    for (let r = 0; r < rings.length - 1; r++) for (let sd = 0; sd < 2; sd++) for (let k = 0; k < M - 1; k++) {
      const A = (r * 2 + sd) * M + k, B = A + 2 * M, C = A + 1, D = B + 1;
      if (sd === 0) ix.push(A, C, B, C, D, B); else ix.push(A, B, C, C, B, D);
    }
    return mk(p, ix);
  };
  const NY = 9, hr = [];
  for (let k = 0; k <= NY; k++) { const y = 0.9 + (GTOP - 0.9) * k / NY; hr.push({ o: outline(houseAt(y)), y }); }
  add(band(hr), glassMat, true);
  // chrome waist rail
  add(band([{ o: outline(houseAt(0.955), 0.004), y: 0.955 }, { o: outline(houseAt(0.975), 0.006), y: 0.966 }, { o: outline(houseAt(0.975), 0.002), y: 0.977 }]), chrome);
  // roof: slightly proud of the glass, longer at the back (spoiler lip), crowned
  const top = houseAt(GTOP), roofO = (grow, back) => outline({ ...top, xR: top.xR - back, rR: 0.12, rF: top.rF + 0.03 }, grow);
  const uc = (top.xF + top.xR - 0.1) / 2, hl = (top.xF - top.xR + 0.1) / 2, shrink = (o, k, kz = k) => o.map(([u, z]) => [uc + (u - uc) * k, z * kz]);
  const sag = (dy) => (u) => dy - 0.016 * Math.pow(Math.max(0, (uc + 0.3 - u) / hl), 2) - 0.012 * Math.pow(Math.max(0, (u - uc - 0.3) / hl), 2);
  const ro = roofO(0.016, 0.115);
  add(band([{ o: shrink(ro, 0.9, 0.86), y: sag(GTOP - 0.004) }, { o: shrink(ro, 0.992, 0.985), y: sag(GTOP - 0.006) }, { o: ro, y: sag(GTOP + 0.006) }, { o: shrink(ro, 0.997, 0.99), y: sag(GTOP + 0.022) },
    { o: shrink(ro, 0.975, 0.95), y: sag(ROOF_H - 0.012) }, { o: shrink(ro, 0.9, 0.84), y: sag(ROOF_H - 0.004) }, { o: shrink(ro, 0.6, 0.5), y: sag(ROOF_H) }, { o: shrink(ro, 0.02, 0.02), y: sag(ROOF_H) }]), roofMat, true);
  // pillars (satin black over the glass) and a stubby aerial
  const pillar = decalMat(trimMat);
  for (const sgn of [1, -1]) {
    add(patchGeo(2, 8, (i, j) => V(-0.47 + 0.1 * i, 0.96 + (GTOP - 0.96) * j, sgn * 1.2), V(0, 0, -sgn), 0.003), pillar);                  // B
    add(patchGeo(4, 8, (i, j) => V(-1.24 - 0.3 * i - 0.12 * j * (1 - i), 0.96 + (GTOP - 0.96) * j, sgn * 1.2), V(0, 0, -sgn), 0.003), pillar);   // C
    add(patchGeo(3, 8, (i, j) => { const y = 0.96 + (GTOP - 0.964) * j, h = houseAt(y); return V(h.xF + 0.5, y, sgn * (h.w - 0.035 - 0.05 * i)); }, FWD, 0.003), pillar);   // A
  }
  const aerial = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.007, 0.2, 6), trimMat); aerial.position.set(top.xR + 0.12, ROOF_H + 0.07, 0); aerial.rotation.z = 0.5; g.add(aerial);

  // ---- black wheel-arch flares --------------------------------------------------------
  for (const ar of arches) for (const sgn of [1, -1]) {
    const p = [], ix = [], N = 40, t0 = -0.3, t1 = Math.PI + 0.3, rows = [[-0.006, -0.05], [-0.004, 0.013], [0.03, 0.016], [0.06, 0.004], [0.066, -0.006]];
    for (let k = 0; k <= N; k++) {
      const th = t0 + (t1 - t0) * k / N, c = Math.cos(th), s = Math.sin(th);
      const z0 = sideZ(ar.u + c * (ar.Ra + 0.03), Math.max(ar.R + s * (ar.Ra + 0.03), FLOOR(ar.u) + 0.07));
      for (const [dr, dz] of rows) p.push(ar.u + c * (ar.Ra + dr), ar.R + s * (ar.Ra + dr), sgn * (z0 + dz));
    }
    const nr = rows.length;
    for (let k = 0; k < N; k++) for (let r = 0; r < nr - 1; r++) { const A = k * nr + r, B = A + nr, C = A + 1, D = B + 1; if (sgn < 0) ix.push(A, B, C, C, B, D); else ix.push(A, C, B, C, D, B); }
    add(mk(p, ix), trimMat, true);
  }

  // ---- nose ---------------------------------------------------------------------------
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xcfd6de, roughness: 0.08, metalness: 0.9, clearcoat: 1, emissive: 0xfff2d8, emissiveIntensity: 0.3 });
  const ledMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e0, emissiveIntensity: 1.8, roughness: 0.3 });
  const frontMap = (cy, cz) => (p, q) => V(HL + 0.4, cy + q, cz + p);
  // hexagonal grille: chrome surround, black mesh, body-colour bar with the plate
  const hex = (k) => poly([[-0.30 * k, 0.175 * k], [0.30 * k, 0.175 * k], [0.405 * k, 0.05 * k], [0.29 * k, -0.175 * k], [-0.29 * k, -0.175 * k], [-0.405 * k, 0.05 * k]], 6);
  disc(hex(1.07), frontMap(0.485, 0), FWD, decalMat(chrome), 0.004, 4);
  disc(hex(1), frontMap(0.485, 0), FWD, decalMat(gloss), 0.008, 4);
  add(patchGeo(12, 2, (i, j) => V(HL + 0.4, 0.405 + 0.085 * j, -0.385 + 0.77 * i), FWD, 0.012), decalMat(trimMat));
  const plateW = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.5 }), plateY = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.5 });
  add(patchGeo(6, 2, (i, j) => V(HL + 0.4, 0.40 + 0.095 * j, -0.24 + 0.48 * i), FWD, 0.016), decalMat(plateW));
  for (const sgn of [1, -1]) {
    // lower corner intakes with round fog lamps
    disc(superEllipse(0.085, 0.06, 2.6, 20), frontMap(0.365, sgn * 0.6), FWD, decalMat(gloss), 0.005, 2);
    disc(superEllipse(0.036, 0.036, 2, 14), frontMap(0.365, sgn * 0.6), FWD, decalMat(ledMat), 0.009, 2);
    // big oval headlamps lying back on the wings, chrome rings
    const aim = V(-0.86, -0.5, -sgn * 0.1).normalize(), tgt = V(1.71, 0.79, sgn * 0.60), o = tgt.clone().addScaledVector(aim, -0.5);
    const h0 = hit(o, aim), h1 = hit(o.clone().add(V(0, 0, 0.04)), aim), h2 = hit(o.clone().add(V(0.03, 0.05, 0)), aim);
    if (h0 && h1 && h2) {
      const n = h1.clone().sub(h0).cross(h2.clone().sub(h0)).normalize(); if (n.dot(aim) > 0) n.negate();
      n.lerp(V(0.76, 0.63, sgn * 0.16).normalize(), 0.6).normalize();
      const lamp = new THREE.Group(); lamp.position.copy(h0).addScaledVector(n, 0.012); lamp.lookAt(h0.clone().add(n));
      const ra = 0.155, rb = 0.128;
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.16, 28, 1, true).rotateX(Math.PI / 2), chrome); cup.scale.set(ra, rb, 1); cup.position.z = -0.075;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.085, 8, 32), chrome); ring.scale.set(ra, rb, 0.16);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), lensMat); lens.scale.set(ra * 0.93, rb * 0.93, 0.045);
      const drl = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 6, 32), ledMat); drl.scale.set(ra * 0.74, rb * 0.74, 0.1); drl.position.z = 0.03;
      lamp.add(cup, ring, lens, drl); g.add(lamp);
    }
    // bonnet stripes
    add(patchGeo(40, 2, (i, j) => V(0.93 + 0.94 * i, 1.3, sgn * (0.17 + 0.15 * j)), DOWN, 0.003), decalMat(roofMat));
  }
  disc(superEllipse(0.13, 0.022, 3, 20), (p, q) => V(1.5 + q, 1.3, p), DOWN, decalMat(gloss), 0.006, 2);   // bonnet scoop

  // ---- tail ---------------------------------------------------------------------------
  const rearMap = (cy, cz) => (p, q) => V(-HL - 0.4, cy + q, cz + p);
  for (const sgn of [1, -1]) {
    disc(superEllipse(0.108, 0.158, 3.2, 28), rearMap(0.775, sgn * 0.6), BACK, decalMat(chrome), 0.004, 3);
    disc(superEllipse(0.09, 0.14, 3.2, 28), rearMap(0.775, sgn * 0.6), BACK, decalMat(tailMat), 0.008, 3);
    disc(superEllipse(0.05, 0.022, 3, 14), rearMap(0.40, sgn * 0.56), BACK, decalMat(tailMat), 0.005, 2);   // bumper reflectors
  }
  add(patchGeo(6, 2, (i, j) => V(-HL - 0.4, 0.60 + 0.11 * j, -0.26 + 0.52 * i), BACK, 0.008), decalMat(plateY));
  add(patchGeo(8, 1, (i, j) => V(-HL - 0.4, 0.735 + 0.022 * j, -0.33 + 0.66 * i), BACK, 0.012), decalMat(chrome));       // handle strip
  disc(poly([[-0.34, 0.07], [0.34, 0.07], [0.27, -0.055], [-0.27, -0.055]], 5), rearMap(0.375, 0), BACK, decalMat(trimMat), 0.004, 2);   // diffuser panel
  for (const sgn of [1, -1]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.16, 14).rotateZ(Math.PI / 2), chrome); tip.position.set(-HL + 0.04, 0.345, sgn * 0.065); g.add(tip);
    const bore = new THREE.Mesh(new THREE.CircleGeometry(0.035, 14).rotateY(-Math.PI / 2), linerMat); bore.position.set(-HL - 0.042, 0.345, sgn * 0.065); g.add(bore);
  }

  // ---- flanks --------------------------------------------------------------------------
  for (const sgn of [1, -1]) {
    const from = V(0, 0, -sgn);
    // mirrors: black foot, roof-colour cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), roofMat); cap.scale.set(0.085, 0.07, 0.115); cap.position.set(0.63, 1.035, sgn * 0.93); cap.castShadow = true; g.add(cap);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.035, 0.16), trimMat); foot.position.set(0.63, 0.99, sgn * 0.84); g.add(foot);
    // door handle, side scuttle behind the front arch
    add(patchGeo(3, 1, (i, j) => V(-0.33 + 0.16 * i, 0.862 + 0.028 * j, sgn * 1.2), from, 0.012), decalMat(chrome));
    disc(poly([[-0.10, 0.03], [0.07, 0.03], [0.10, -0.03], [-0.07, -0.03]], 3), (p, q) => V(0.60 + p, 0.76 + q, sgn * 1.2), from, decalMat(gloss), 0.006, 2);
    if (!ghost) {
      // door shut lines
      const pts = [];
      const path = [[0.68, 0.955], [0.68, 0.60], [0.61, 0.30], [-0.36, 0.30], [-0.44, 0.50], [-0.44, 0.955]];
      for (let k = 0; k < path.length - 1; k++) for (let j = 0; j <= 8; j++) {
        const u = path[k][0] + (path[k + 1][0] - path[k][0]) * j / 8, y = path[k][1] + (path[k + 1][1] - path[k][1]) * j / 8, h = hit(V(u, y, sgn * 1.2), from, 1.2, 0.03);
        if (h) pts.push(h.x, h.y, h.z + sgn * 0.003);
      }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); g.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x030303 })));
    }
  }
  return g;
}

export const MINI_BODY = { length: L, halfWidth: HWMAX };
