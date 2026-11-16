// Monaco: the principality around the circuit, built from OpenStreetMap footprints, SRTM relief and authored
// street dressing (src/sim/tracks/monaco.scene.json, baked by tools/monaco-scene.mjs).
//   monacoSetup(track)  -> terrain function, land mask, tunnel range (cheap; world.js needs these early)
//   M.build(ctx)        -> every Monaco mesh, added to ctx.group
// Sim (x, y) maps to Three (x, height, -y).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nearestIndexGlobal } from '../sim/track.js';
import { RNG } from '../sim/rng.js';
import { facadeArrays, L, LSIZE } from './monaco-tex.js';
import { prepMonaco, dressMonaco } from './monaco-props.js';
import { ASSETS, loadTexture } from './assets.js';

const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash2 = (ix, iy) => { let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const srgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
export const polyArea = (P) => { let A = 0; for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; A += a[0] * b[1] - b[0] * a[1]; } return A / 2; };
export const inPoly = (P, x, y) => { let c = false; for (let k = 0, j = P.length - 1; k < P.length; j = k++) { const a = P[k], b = P[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const pairs = (flat, s = 1) => { const P = []; for (let k = 0; k + 1 < flat.length; k += 2) P.push([flat[k] * s, flat[k + 1] * s]); return P; };
// polygon shrunk by d (counter-clockwise input); null when the result is not a sane polygon
export function insetPoly(P, d) {
  const n = P.length, Q = [];
  for (let k = 0; k < n; k++) {
    const a = P[(k + n - 1) % n], b = P[k], c = P[(k + 1) % n];
    let ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1]; const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy); if (lu < 1e-3 || lv < 1e-3) return null;
    ux /= lu; uy /= lu; vx /= lv; vy /= lv;
    const n1x = -uy, n1y = ux, n2x = -vy, n2y = vx, den = 1 + n1x * n2x + n1y * n2y; if (den < 0.25) return null;
    Q.push([b[0] + (n1x + n2x) * d / den, b[1] + (n1y + n2y) * d / den]);
  }
  for (let k = 0; k < n; k++) { const a = P[k], b = P[(k + 1) % n], qa = Q[k], qb = Q[(k + 1) % n]; if ((b[0] - a[0]) * (qb[0] - qa[0]) + (b[1] - a[1]) * (qb[1] - qa[1]) <= 0) return null; }
  return polyArea(Q) > 0.2 * polyArea(P) ? Q : null;
}

export function monacoSetup(track) {
  const sc = track.scene, W = sc.win, n = track.n;
  let zMin = Infinity; for (let i = 0; i < n; i++) zMin = Math.min(zMin, track.z[i]);
  const SEA = zMin - 3;
  // the hotel stands over the road some 25 m before OSM's tunnel way begins: the covered section starts there
  const tun = sc.tunnel.filter(([a, b]) => b - a >= 60).map(([a, b]) => [a - 24, b]), under = sc.tunnel.filter(([a, b]) => b - a < 60);
  const inTun = (i) => { for (const [a, b] of tun) if (i >= a && i <= b) return true; return false; };
  // the ground over the tunnel starts a few metres inside each portal (the portal structure covers the join)
  const podium = (i) => { for (const [a, b] of tun) if (i >= a + 7 && i <= b - 7) return true; return false; };

  // ---- land mask: anti-aliased coverage on a 1 m raster of the window, from the coastline polygon ----
  const MW = W.x1 - W.x0, MH = W.y1 - W.y0, cov = new Uint8Array(MW * MH);
  {
    const acc = new Float32Array(MW);
    for (const flat of sc.coast) {
      const P = pairs(flat, 0.1), a = P[0], b = P.at(-1);
      // close the chain round the land side (water is on the right of the direction of travel)
      P.push([b[0], 9000], [-9000, 9000], [-9000, a[1]]);
      const E = []; for (let k = 0; k < P.length; k++) { const p = P[k], q = P[(k + 1) % P.length]; if (p[1] !== q[1]) E.push(p[1] < q[1] ? [p[0], p[1], q[0], q[1]] : [q[0], q[1], p[0], p[1]]); }
      const xs = [];
      for (let j = 0; j < MH; j++) {
        acc.fill(0);
        for (let s = 0; s < 4; s++) {
          const y = W.y0 + j + (s + 0.5) / 4; xs.length = 0;
          for (const e of E) if (y >= e[1] && y < e[3]) xs.push(e[0] + (e[2] - e[0]) * (y - e[1]) / (e[3] - e[1]) - W.x0);
          xs.sort((p, q) => p - q);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const xa = Math.max(0, xs[k]), xb = Math.min(MW, xs[k + 1]); if (xb <= xa) continue;
            const ia = Math.floor(xa), ib = Math.min(MW - 1, Math.floor(xb));
            if (ia === ib) acc[ia] += (xb - xa) * 0.25; else { acc[ia] += (ia + 1 - xa) * 0.25; for (let i = ia + 1; i < ib; i++) acc[i] += 0.25; acc[ib] += (xb - ib) * 0.25; }
          }
        }
        for (let i = 0; i < MW; i++) cov[j * MW + i] = Math.max(cov[j * MW + i], Math.min(255, Math.round(acc[i] * 255)));
      }
    }
    // the circuit itself always stands on land (OSM's quay line wanders under the widened road in places)
    for (let i = 0; i < n; i += 2) {
      const r = Math.max(track.wallL[i], track.wallR[i]) + 3.2, cx = track.x[i] - W.x0, cy = track.y[i] - W.y0;
      for (let j = Math.max(0, Math.floor(cy - r - 1)); j <= Math.min(MH - 1, Math.ceil(cy + r + 1)); j++) for (let k = Math.max(0, Math.floor(cx - r - 1)); k <= Math.min(MW - 1, Math.ceil(cx + r + 1)); k++) {
        const v = Math.round(255 * Math.max(0, Math.min(1, 0.5 + r - Math.hypot(k + 0.5 - cx, j + 0.5 - cy)))); if (v > cov[j * MW + k]) cov[j * MW + k] = v;
      }
    }
  }
  const covAt = (x, y) => {                          // bilinear coverage 0..1 (matches the shader's texture lookup)
    const fx = x - W.x0 - 0.5, fy = y - W.y0 - 0.5, i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= MW - 1 || j >= MH - 1) return -1;
    const u = fx - i, v = fy - j, k = j * MW + i;
    return ((cov[k] * (1 - u) + cov[k + 1] * u) * (1 - v) + (cov[k + MW] * (1 - u) + cov[k + MW + 1] * u) * v) / 255;
  };

  // ---- relief: SRTM, smoothed; fine grid near the circuit, coarse grid beyond ----
  const grid = (g, pass) => {
    let h = Float32Array.from(g.h);
    for (let p = 0; p < pass; p++) { const o = new Float32Array(h.length); for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) { let s = 0, w = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const x = i + a, y = j + b; if (x < 0 || y < 0 || x >= g.nx || y >= g.ny) continue; const k = (2 - Math.abs(a)) * (2 - Math.abs(b)); s += k * h[y * g.nx + x]; w += k; } o[j * g.nx + i] = s / w; } h = o; }
    const at = (i, j) => h[Math.max(0, Math.min(g.ny - 1, j)) * g.nx + Math.max(0, Math.min(g.nx - 1, i))];
    const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
    return (x, y) => { const fx = (x - g.x0) / g.dx, fy = (y - g.y0) / g.dx, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j; const r = []; for (let b = -1; b <= 2; b++) r.push(cr(at(i - 1, j + b), at(i, j + b), at(i + 1, j + b), at(i + 2, j + b), u)); return cr(r[0], r[1], r[2], r[3], v); };
  };
  const F = sc.dem.fine, Cg = sc.dem.coarse, fineH = grid(F, 1), coarseH = grid(Cg, 0);
  const fx1 = F.x0 + (F.nx - 1) * F.dx, fy1 = F.y0 + (F.ny - 1) * F.dx;
  const demH = (x, y) => { const e = Math.min(x - F.x0, fx1 - x, y - F.y0, fy1 - y); if (e <= 0) return coarseH(x, y); const w = smooth(0, 200, e); return w >= 1 ? fineH(x, y) : coarseH(x, y) * (1 - w) + fineH(x, y) * w; };

  // ---- distance to the shore on a 4 m raster (chamfer transform of the mask): + in the sea, - on land ----
  const DW = Math.ceil(MW / 4), DH = Math.ceil(MH / 4), dIn = new Float32Array(DW * DH), dOut = new Float32Array(DW * DH);
  {
    for (let j = 0; j < DH; j++) for (let i = 0; i < DW; i++) { const land = cov[Math.min(MH - 1, j * 4 + 2) * MW + Math.min(MW - 1, i * 4 + 2)] > 127; dIn[j * DW + i] = land ? 1e6 : 0; dOut[j * DW + i] = land ? 0 : 1e6; }
    for (const d of [dIn, dOut]) {
      for (let j = 0; j < DH; j++) for (let i = 0; i < DW; i++) { const k = j * DW + i; let v = d[k]; if (i > 0) v = Math.min(v, d[k - 1] + 4); if (j > 0) { v = Math.min(v, d[k - DW] + 4); if (i > 0) v = Math.min(v, d[k - DW - 1] + 5.66); if (i < DW - 1) v = Math.min(v, d[k - DW + 1] + 5.66); } d[k] = v; }
      for (let j = DH - 1; j >= 0; j--) for (let i = DW - 1; i >= 0; i--) { const k = j * DW + i; let v = d[k]; if (i < DW - 1) v = Math.min(v, d[k + 1] + 4); if (j < DH - 1) { v = Math.min(v, d[k + DW] + 4); if (i > 0) v = Math.min(v, d[k + DW - 1] + 5.66); if (i < DW - 1) v = Math.min(v, d[k + DW + 1] + 5.66); } d[k] = v; }
    }
  }
  const seaDist = (x, y) => {
    const fx = (x - W.x0) / 4 - 0.5, fy = (y - W.y0) / 4 - 0.5, i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= DW - 1 || j >= DH - 1) return demH(x, y) > 0.8 ? -300 : 300;
    const u = fx - i, v = fy - j, k = j * DW + i, s = (d) => (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + DW] * (1 - u) + d[k + DW + 1] * u) * v;
    const a = s(dOut), b = s(dIn); return a > 0.01 ? Math.min(a, 600) : -Math.min(b, 600);
  };
  const isSea = (x, y) => { const c = covAt(x, y); return c < 0 ? demH(x, y) <= 0.8 : c < 0.5; };
  // open ground away from the circuit: the terrain model, eased down to quay level at the shore
  const QUAY = SEA + 3.2;
  const farH = (x, y) => { const d = -seaDist(x, y), b = Math.max(QUAY, demH(x, y) - 3.5); return d >= 80 ? b : QUAY + (b - QUAY) * smooth(3, 80, d); };

  // ---- the circuit's own levels spread into the ground beside it (inverse-distance weighting) ----
  const BC = 48, bx0 = track.grid.minX - 200, by0 = track.grid.minY - 200, bnx = Math.ceil((track.grid.maxX - track.grid.minX + 400) / BC), bny = Math.ceil((track.grid.maxY - track.grid.minY + 400) / BC);
  const buckets = Array.from({ length: bnx * bny }, () => []);
  const lvl = new Float32Array(n), dOff = new Float32Array(n);
  for (let i = 0; i < n; i++) { lvl[i] = track.z[i] + (podium(i) ? 7.2 : 0); dOff[i] = lvl[i] - farH(track.x[i], track.y[i]); }
  for (let i = 0; i < n; i += 3) { const a = Math.floor((track.x[i] - bx0) / BC), b = Math.floor((track.y[i] - by0) / BC); buckets[b * bnx + a].push(i); }
  const WD = 1 / (30 ** 4);
  const raw = (x, y, out) => {
    const a0 = Math.floor((x - bx0) / BC), b0 = Math.floor((y - by0) / BC);
    let sw = 0, sz = 0, so = 0, dmin = 1e9;
    for (let b = b0 - 3; b <= b0 + 3; b++) { if (b < 0 || b >= bny) continue; for (let a = a0 - 3; a <= a0 + 3; a++) { if (a < 0 || a >= bnx) continue; const c = buckets[b * bnx + a];
      for (let q = 0; q < c.length; q++) { const i = c[q], dx = x - track.x[i], dy = y - track.y[i], d = Math.max(0, Math.sqrt(dx * dx + dy * dy) - 9), w = 1 / ((d * d + 9) * (d * d + 9)); sw += w; sz += w * lvl[i]; so += w * dOff[i]; if (d < dmin) dmin = d; } } }
    const hf = farH(x, y); if (sw <= 0) { out.dmin = 1e9; return hf; }
    out.dmin = dmin;
    const flat = sz / sw, off = hf + so / (sw + WD), k = smooth(0, 28, dmin);
    return flat + (off - flat) * k;
  };

  // ---- pavement and terraces beside the track: per sample and side, how far the flat apron reaches, then a retaining
  // wall up (or a drop) to a terrace wherever the hillside is more than a step away from the road level ----
  const AP = 4.5, TW = 8, tmp = {};
  const apron = { 1: new Float32Array(n), '-1': new Float32Array(n) }, terr = { 1: new Float32Array(n), '-1': new Float32Array(n) }, step = { 1: new Float32Array(n), '-1': new Float32Array(n) }, lim = { 1: new Float32Array(n), '-1': new Float32Array(n) };
  for (const side of [1, -1]) {
    const wall = side > 0 ? track.wallL : track.wallR, lm = lim[side];
    for (let i = 0; i < n; i++) {
      const h = track.heading[i], nx = -Math.sin(h) * side, ny = Math.cos(h) * side; let o = wall[i] + 0.5;
      for (; o < 40; o += 1) { const px = track.x[i] + nx * (o + 1), py = track.y[i] + ny * (o + 1), j = nearestIndexGlobal(track, px, py); if (Math.hypot(px - track.x[j], py - track.y[j]) < o + 1 - 0.35) break; }
      lm[i] = o;
    }
    const lm2 = Float32Array.from(lm); for (let i = 0; i < n; i++) { let m = lm2[i]; for (let q = -3; q <= 3; q++) m = Math.min(m, lm2[(i + q + n) % n]); lm[i] = m; }
    const rawStep = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      apron[side][i] = Math.max(wall[i] + 0.4, Math.min(wall[i] + AP, lm[i]));
      if (inTun(i)) { apron[side][i] = wall[i] + 0.4; continue; }
      const h = track.heading[i], nx = -Math.sin(h) * side, ny = Math.cos(h) * side, o = Math.min(wall[i] + AP + 6.5, lm[i] - 0.5);
      if (o < wall[i] + AP + 1.5) continue;
      const px = track.x[i] + nx * o, py = track.y[i] + ny * o; if (seaDist(px, py) > -6) continue;
      rawStep[i] = Math.max(-14, Math.min(10, raw(px, py, tmp) - track.z[i]));
    }
    for (let i = 0; i < n; i++) { let s = 0; for (let q = -5; q <= 5; q++) s += rawStep[(i + q + n) % n]; s /= 11; step[side][i] = Math.abs(s) < 1.4 ? 0 : s; }
    // close short gaps and drop short runs so walls do not flicker in and out
    for (let i = 0; i < n; i++) terr[side][i] = step[side][i] ? Math.max(apron[side][i], Math.min(wall[i] + AP + TW, lm[i])) : apron[side][i];
  }

  const out = {};
  function terrain(x, y) {
    const i = nearestIndexGlobal(track, x, y), hd = track.heading[i], lat = -(x - track.x[i]) * Math.sin(hd) + (y - track.y[i]) * Math.cos(hd), dist = Math.hypot(x - track.x[i], y - track.y[i]);
    const side = lat >= 0 ? 1 : -1, wall = side > 0 ? track.wallL[i] : track.wallR[i], corr = wall + 1.5;
    let h, strip = 0;
    if (inTun(i) && dist < wall + 3) { h = track.z[i] + (podium(i) ? 7.2 : 0); strip = podium(i) ? 2 : 1; }
    else if (!inTun(i) && dist <= apron[side][i]) { h = track.z[i]; strip = 1; }
    else if (!inTun(i) && dist <= terr[side][i]) { h = track.z[i] + step[side][i]; strip = 1; }
    else h = raw(x, y, out);
    const sd = seaDist(x, y);
    return { h, idx: i, dist, corr, t: 1, zMin, sea: sd, strip, side };
  }

  const M = { track, sc, W, SEA, QUAY, tun, under, inTun, podium, cov, MW, MH, covAt, isSea, seaDist, demH, farH, raw, terrain, apron, terr, step, lim };
  M.build = (ctx) => buildMonaco(M, ctx);
  return M;
}

// =============================================================================================================
function buildMonaco(M, ctx) {
  const { track, sc, W, SEA, terrain } = M, { group, quality, patch, wettable } = ctx, n = track.n;
  const detail = quality.detail, aniso = ctx.aniso;
  const cast = (m, c = true, r = true) => { m.castShadow = c && quality.shadows; m.receiveShadow = r; return m; };
  const groundAt = (x, y) => terrain(x, y).h;
  M.groundAt = groundAt;

  // ---- shared façade material: texture-array layers, tinted stucco, relief, glazing, night windows ----
  const FA = facadeArrays(detail > 0 ? 512 : 256, aniso), uNight = { value: 0 }, uTunK = { value: 0 };
  ctx.nightMats.push([{ set emissiveIntensity(v) { uNight.value = v; } }, 1]);
  const facadeMat = (key, extra = {}) => patch(new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...extra }), 'mcfac' + key, {
    uniforms: { uFacA: { value: FA.albedo }, uFacX: { value: FA.aux }, uNightK: uNight },
    vpars: 'attribute vec3 aFac; attribute vec3 aTint; varying vec3 vFac; varying vec3 vTint;', vmain: 'vFac = aFac; vTint = aTint;',
    fpars: 'precision highp sampler2DArray; uniform sampler2DArray uFacA; uniform sampler2DArray uFacX; uniform float uNightK; varying vec3 vFac; varying vec3 vTint; vec4 gAux;',
    color: `{
      vec4 tx = texture(uFacA, vFac); gAux = texture(uFacX, vFac);
      diffuseColor.rgb = mix(tx.rgb, tx.rgb * vTint, tx.a);
      gWet = uWet * 0.6; diffuseColor.rgb *= mix(1.0, 0.8, gWet * tx.a);
    }`,
    rough: 'roughnessFactor = mix(gAux.b, gAux.b * 0.6, gWet);',
    normal: `{
      vec3 upV = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0)); vec3 T = cross(upV, normal); float tl = length(T);
      if (tl > 0.15) { T /= tl; vec3 Bt = cross(normal, T); float fd = smoothstep(220.0, 30.0, vViewPosition.z);
        normal = normalize(normal + ((gAux.r * 2.0 - 1.0) * T + (gAux.g * 2.0 - 1.0) * Bt) * 1.25 * fd); }
    }`,
    out: `{
      vec2 wc = floor(vFac.xy * vec2(4.0, 2.0));
      float lit = step(0.42, hash12(wc + vFac.z * 7.0));
      outgoingLight += vec3(1.0, 0.7, 0.4) * gAux.a * lit * uNightK * 1.6;
    }`,
  });
  const facMat = facadeMat('');
  // geometry accumulator for anything drawn with the façade material
  const mkAcc = () => ({ pos: [], nor: [], fac: [], tint: [] });
  const accGeo = (A) => { if (!A.pos.length) return null; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(A.nor, 3)); g.setAttribute('aFac', new THREE.Float32BufferAttribute(A.fac, 3)); g.setAttribute('aTint', new THREE.Float32BufferAttribute(A.tint, 3)); return g; };
  // quad a-b-c-d (counter-clockwise seen from the front), each [x, h, y_sim, u, v]
  const quad = (A, a, b, c, d, layer, tint, nrm) => {
    let nx, ny, nz;
    if (nrm) [nx, ny, nz] = nrm; else { const ux = b[0] - a[0], uy = b[1] - a[1], uz = -(b[2] - a[2]), vx = d[0] - a[0], vy = d[1] - a[1], vz = -(d[2] - a[2]); nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; }
    let V = [a, b, c, a, c, d];
    if (nrm) { const ux = b[0] - a[0], uy = b[1] - a[1], uz = -(b[2] - a[2]), vx = d[0] - a[0], vy = d[1] - a[1], vz = -(d[2] - a[2]); if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < 0) V = [a, c, b, a, d, c]; }
    for (const p of V) { A.pos.push(p[0], p[1], -p[2]); A.nor.push(nx, ny, nz); A.fac.push(p[3], p[4], layer); A.tint.push(tint[0], tint[1], tint[2]); }
  };
  // vertical wall from (ax, ay) to (bx, by), front on the right-hand side of a->b... i.e. outward for a counter-clockwise ring
  const wall = (A, ax, ay, bx, by, z0, z1, layer, tint, u0, u1, v0, v1) => {
    if (z1 - z0 < 0.02) return;
    const [lw, lh] = LSIZE[layer]; if (u0 === undefined) { u0 = 0; u1 = Math.hypot(bx - ax, by - ay) / lw; } if (v0 === undefined) { v0 = z0 / lh; v1 = z1 / lh; }
    quad(A, [ax, z0, ay, u0, v0], [bx, z0, by, u1, v0], [bx, z1, by, u1, v1], [ax, z1, ay, u0, v1], layer, tint);
  };
  const box = (A, cx, cy, hw, hd, rot, z0, z1, layer, tint, top = L.CONCRETE, topTint = tint) => {
    const c = Math.cos(rot), s = Math.sin(rot), P = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
    for (let k = 0; k < 4; k++) wall(A, P[k][0], P[k][1], P[(k + 1) % 4][0], P[(k + 1) % 4][1], z0, z1, layer, tint);
    if (top !== null) quad(A, [P[0][0], z1, P[0][1], 0, 0], [P[1][0], z1, P[1][1], hw / 3, 0], [P[2][0], z1, P[2][1], hw / 3, hd / 3], [P[3][0], z1, P[3][1], 0, hd / 3], top, topTint);
    return P;
  };
  const K = { M, ctx, track, sc, W, SEA, terrain, groundAt, group, quality, detail, aniso, cast, facMat, facadeMat, mkAcc, accGeo, quad, wall, box, uNight, uTunK, smooth, hash2, srgb, pairs };

  // ---- ground: one grid over the window (4 m cells near the circuit, 16 m beyond), cut at the shore in the shader ----
  const landTex = new THREE.DataTexture(M.cov, M.MW, M.MH, THREE.RedFormat, THREE.UnsignedByteType);
  landTex.magFilter = landTex.minFilter = THREE.LinearFilter; landTex.unpackAlignment = 1; landTex.needsUpdate = true; landTex.userData.shared = true;
  const paint = document.createElement('canvas'); paint.width = paint.height = detail > 0 ? 2048 : 1024;
  {
    const x = paint.getContext('2d'), S = paint.width;
    x.setTransform(S / (W.x1 - W.x0), 0, 0, -S / (W.y1 - W.y0), -W.x0 * S / (W.x1 - W.x0), S + W.y0 * S / (W.y1 - W.y0));
    x.fillStyle = '#000'; x.fillRect(W.x0, W.y0, W.x1 - W.x0, W.y1 - W.y0); x.lineCap = x.lineJoin = 'round';
    x.globalCompositeOperation = 'lighter';
    const poly = (flat, col, s = 1) => { x.fillStyle = col; x.beginPath(); for (let k = 0; k < flat.length; k += 2) (k ? x.lineTo : x.moveTo).call(x, flat[k] * s, flat[k + 1] * s); x.closePath(); x.fill(); };
    for (const g of sc.green) poly(g, '#00ff00'); for (const g of sc.pitch) poly(g, '#00ff00');
    for (const g of sc.plaza) poly(g, '#0000ff');
    x.strokeStyle = '#0000b0'; x.lineWidth = 2.6; for (const s of sc.steps) { x.beginPath(); for (let k = 0; k < s.length; k += 2) (k ? x.lineTo : x.moveTo).call(x, s[k], s[k + 1]); x.stroke(); }
    // streets wipe green / paving and set red
    for (const pass of [0, 1]) for (const s of sc.streets) { const w = Math.abs(s[0]); x.globalCompositeOperation = pass ? 'lighter' : 'source-over'; x.strokeStyle = pass ? '#ff0000' : '#000000'; x.lineWidth = pass ? w : w + 3.4; x.beginPath(); for (let k = 1; k < s.length; k += 2) (k > 1 ? x.lineTo : x.moveTo).call(x, s[k], s[k + 1]); x.stroke(); }
  }
  const paintTex = new THREE.CanvasTexture(paint); paintTex.colorSpace = THREE.NoColorSpace; paintTex.anisotropy = aniso; paintTex.generateMipmaps = true; paintTex.minFilter = THREE.LinearMipmapLinearFilter;
  const uWin = { value: new THREE.Vector4(W.x0, W.y0, 1 / (W.x1 - W.x0), 1 / (W.y1 - W.y0)) };
  const asphaltU = { value: ctx.asphaltMap }, grassU = { value: ctx.grassMap };
  loadTexture(ASSETS.asphaltDiff, { aniso }).then((t) => { if (t) asphaltU.value = t; }); loadTexture(ASSETS.grassDiff, { aniso }).then((t) => { if (t) grassU.value = t; });
  const groundMat = patch(new THREE.MeshStandardMaterial({ map: ctx.concreteMap, roughness: 0.9 }), 'mcground', {
    uniforms: { tLand: { value: landTex }, tPaint: { value: paintTex }, uWin, tAsph: asphaltU, tGrass: grassU },
    vpars: 'varying vec3 vWPos; varying vec3 vWN;', vmain: 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normal;',
    fpars: 'uniform sampler2D tLand, tPaint, tAsph, tGrass; uniform vec4 uWin; varying vec3 vWPos; varying vec3 vWN;',
    color: `{
      vec2 p = vec2(vWPos.x, -vWPos.z), uvw = (p - uWin.xy) * uWin.zw;
      if (uvw.x > 0.0 && uvw.x < 1.0 && uvw.y > 0.0 && uvw.y < 1.0 && texture2D(tLand, uvw).r < 0.5) discard;
      vec3 mk = texture2D(tPaint, uvw).rgb;
      float street = smoothstep(0.42, 0.58, mk.r), green = smoothstep(0.42, 0.58, mk.g) * (1.0 - street), plaza = smoothstep(0.3, 0.5, mk.b) * (1.0 - street);
      float cn = lum(texture2D(map, p / 3.1).rgb) / 0.55, big = 0.8 + 0.4 * vnoise(p / 37.0);
      // paving slabs: warm stone
      vec2 sl = p / vec2(0.8, 0.8), sf = abs(fract(sl) - 0.5); float fadeJ = smoothstep(70.0, 15.0, vViewPosition.z);
      float joint = 1.0 - 0.22 * fadeJ * smoothstep(0.44, 0.48, max(sf.x, sf.y));
      vec3 pave = mix(vec3(0.36, 0.33, 0.29), vec3(0.47, 0.41, 0.34), plaza) * cn * big * joint * (0.92 + 0.16 * hash12(floor(sl)) * fadeJ);
      vec3 asph = texture2D(tAsph, p / 4.2).rgb * 1.5 * (0.85 + 0.3 * vnoise(p / 11.0));
      vec3 gr = texture2D(tGrass, p / 2.3).rgb * vec3(0.8, 1.0, 0.72) * (0.75 + 0.5 * vnoise(p / 9.0)) * mix(1.0, lum(texture2D(tGrass, p / 31.0).rgb) / 0.075, 0.5);
      vec3 alb = mix(mix(pave, gr, green), asph, street);
      // steep ground reads as rock / retaining stonework
      float steep = smoothstep(0.82, 0.62, normalize(vWN).y);
      float cour = abs(fract(vWPos.y / 0.45) - 0.5);
      vec3 rock = vec3(0.42, 0.37, 0.3) * cn * (0.75 + 0.5 * vnoise(vec2(p.x + p.y, vWPos.y * 3.0) / 2.5)) * (1.0 - 0.25 * fadeJ * smoothstep(0.42, 0.48, cour));
      alb = mix(alb, rock, steep);
      gWet = uWet; gPud = uPuddle * uWet * (1.0 - steep) * (1.0 - green) * smoothstep(0.6, 0.72, vnoise(p * 0.45 + 9.0) * 0.7 + vnoise(p * 1.7) * 0.3);
      alb *= mix(1.0, 0.55, gWet); alb = mix(alb, alb * vec3(0.5, 0.54, 0.6), gPud);
      diffuseColor.rgb = alb;
    }`,
    rough: 'roughnessFactor = mix(mix(0.93, 0.4, gWet), 0.05, gPud);',
  });
  ctx.photo(groundMat, { map: [ASSETS.concrete, { aniso }] });
  K.groundMat = groundMat;
  {
    const C = 16, F = 4, NX = Math.ceil((W.x1 - W.x0) / C), NY = Math.ceil((W.y1 - W.y0) / C), R = C / F;
    const pos = [], idx = [], vid = new Map(), T = {};
    const hCoarse = new Float32Array((NX + 1) * (NY + 1)), fine = new Uint8Array(NX * NY), keep = new Uint8Array(NX * NY);
    const hAt = (x, y) => { const t = terrain(x, y); return t.h - (t.strip === 1 ? 0.4 : 0); };
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) hCoarse[j * (NX + 1) + i] = hAt(W.x0 + i * C, W.y0 + j * C);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const cx = W.x0 + (i + 0.5) * C, cy = W.y0 + (j + 0.5) * C;
      let land = false; for (let b = 0; b <= 4 && !land; b++) for (let a = 0; a <= 4; a++) if (M.covAt(Math.min(W.x1 - 1, W.x0 + (i + a / 4) * C), Math.min(W.y1 - 1, W.y0 + (j + b / 4) * C)) > 0.01) { land = true; break; }
      keep[j * NX + i] = land ? 1 : 0;
      const k = nearestIndexGlobal(track, cx, cy); fine[j * NX + i] = land && Math.hypot(cx - track.x[k], cy - track.y[k]) < (detail > 0 ? 105 : 60) ? 1 : 0;
    }
    const isFine = (i, j) => i >= 0 && j >= 0 && i < NX && j < NY && fine[j * NX + i] === 1;
    const vert = (gi, gj, h) => { const key = gj * (NX * R + 1) + gi; let v = vid.get(key); if (v === undefined) { v = pos.length / 3; pos.push(W.x0 + gi * F, h, -(W.y0 + gj * F)); vid.set(key, v); } return v; };
    const hc = (i, j) => hCoarse[j * (NX + 1) + i];
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      if (!keep[j * NX + i]) continue;
      if (!fine[j * NX + i]) { const a = vert(i * R, j * R, hc(i, j)), b = vert((i + 1) * R, j * R, hc(i + 1, j)), c = vert((i + 1) * R, (j + 1) * R, hc(i + 1, j + 1)), d = vert(i * R, (j + 1) * R, hc(i, j + 1)); idx.push(a, b, c, a, c, d); continue; }
      const cL = !isFine(i - 1, j), cR = !isFine(i + 1, j), cB = !isFine(i, j - 1), cT = !isFine(i, j + 1), vv = [];
      for (let b = 0; b <= R; b++) for (let a = 0; a <= R; a++) {
        let h; const u = a / R, v = b / R;
        // edges shared with a coarse cell follow its straight edge so the surface stays watertight
        if ((a === 0 && cL) || (a === R && cR)) { const ii = a === 0 ? i : i + 1; h = hc(ii, j) * (1 - v) + hc(ii, j + 1) * v; }
        else if ((b === 0 && cB) || (b === R && cT)) { const jj = b === 0 ? j : j + 1; h = hc(i, jj) * (1 - u) + hc(i + 1, jj) * u; }
        else if ((a === 0 || a === R) && (b === 0 || b === R)) h = hc(i + a / R, j + b / R);
        else h = hAt(W.x0 + (i * R + a) * F, W.y0 + (j * R + b) * F);
        vv.push(vert(i * R + a, j * R + b, h));
      }
      for (let b = 0; b < R; b++) for (let a = 0; a < R; a++) { const p = b * (R + 1) + a; idx.push(vv[p], vv[p + 1], vv[p + R + 2], vv[p], vv[p + R + 2], vv[p + R + 1]); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, groundMat); m.receiveShadow = true; group.add(m);
  }

  // ---- far relief: the amphitheatre behind the town and the mountains above it ----
  {
    const C = 110, x0 = -5400, y0 = -4400, NX = 98, NY = 88, pos = [], col = [], idx = [];
    const inWin = (x, y) => x > W.x0 + 20 && x < W.x1 - 20 && y > W.y0 + 20 && y < W.y1 - 20;
    const H = new Float32Array((NX + 1) * (NY + 1));
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { const x = x0 + i * C, y = y0 + j * C; H[j * (NX + 1) + i] = M.demH(x, y) - 3.5; }
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const x = x0 + i * C, y = y0 + j * C, k = j * (NX + 1) + i, h = H[k];
      const gx = (H[k + (i < NX ? 1 : 0)] - H[k - (i > 0 ? 1 : 0)]) / (2 * C), gy = (H[k + (j < NY ? NX + 1 : 0)] - H[k - (j > 0 ? NX + 1 : 0)]) / (2 * C), sl = Math.hypot(gx, gy);
      pos.push(x, h - (inWin(x, y) ? 14 : 0), -y);
      const rock = smooth(0.75, 1.25, sl + 0.3 * hash2(i, j)) * smooth(60, 200, h), town = (1 - smooth(140, 330, h)) * (1 - rock), v = 0.8 + 0.4 * hash2(i * 3, j * 7);
      const sc0 = [0.085 * v, 0.115 * v, 0.055 * v], rk = [0.36 * v, 0.33 * v, 0.28 * v], tw = [0.2, 0.19, 0.15];
      col.push(sc0[0] + (rk[0] - sc0[0]) * rock + (tw[0] - sc0[0]) * town * 0.5, sc0[1] + (rk[1] - sc0[1]) * rock + (tw[1] - sc0[1]) * town * 0.5, sc0[2] + (rk[2] - sc0[2]) * rock + (tw[2] - sc0[2]) * town * 0.5);
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + 1, d = a + NX + 1, e = d + 1;
      if (Math.max(H[a], H[b], H[d], H[e]) < SEA + 0.5) continue;
      const cx = x0 + (i + 0.5) * C, cy = y0 + (j + 0.5) * C; if (cx > W.x0 + C * 1.5 && cx < W.x1 - C * 1.5 && cy > W.y0 + C * 1.5 && cy < W.y1 - C * 1.5) continue;
      idx.push(a, b, e, a, e, d);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, wettable(patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), 'mcfar', {
      vpars: 'varying vec3 vWPos;', vmain: 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;', fpars: 'varying vec3 vWPos;',
      color: 'diffuseColor.rgb *= 0.7 + 0.6 * (0.6 * vnoise(vWPos.xz / 23.0) + 0.4 * vnoise(vWPos.xz / 5.0 + vWPos.y * 0.2));' }), 0.3));
    m.receiveShadow = false; group.add(m);
  }

  // ---- the sea ----
  {
    const seaMat = patch(new THREE.MeshStandardMaterial({ color: 0x0a2f4a, roughness: 0.12, metalness: 0 }), 'mcsea', {
      vpars: 'varying vec3 vWPos;', vmain: 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      fpars: `varying vec3 vWPos;
        vec2 seaSlope(vec2 p, float t){
          vec2 s = vec2(0.0); float a = 1.0;
          vec2 d = normalize(vec2(0.8, 0.6));
          for (int k = 0; k < 5; k++) { float f = 0.11 * pow(1.9, float(k)); float ph = dot(p, d) * f + t * (0.7 + 0.35 * float(k)) + 3.0 * vnoise(p * f * 0.23 + float(k) * 7.0); s += d * cos(ph) * a * 0.12; a *= 0.72; d = normalize(vec2(d.x * 0.62 - d.y * 0.78, d.x * 0.78 + d.y * 0.62)); }
          return s;
        }`,
      color: `{
        float dv = length(vViewPosition);
        // harbour water is greener and paler than the open sea; depth tint by a slow noise
        vec3 deep = vec3(0.006, 0.045, 0.1), shallow = vec3(0.014, 0.095, 0.13);
        diffuseColor.rgb = mix(deep, shallow, 0.5 * vnoise(vWPos.xz / 90.0) + 0.25 * vnoise(vWPos.xz / 17.0)) * (1.0 - 0.35 * uWet);
      }`,
      rough: 'roughnessFactor = mix(0.07, 0.3, smoothstep(150.0, 1500.0, length(vViewPosition))) + 0.12 * uRain;',
      normal: `{
        float dv = length(vViewPosition), fd = smoothstep(900.0, 60.0, dv);
        vec2 sl = seaSlope(vWPos.xz, uWxTime) * (0.25 + 0.75 * fd) + 0.035 * (vec2(vnoise(vWPos.xz * 1.7 + uWxTime * 0.6), vnoise(vWPos.zx * 1.9 - uWxTime * 0.5)) - 0.5) * smoothstep(120.0, 10.0, dv);
        if (uRain > 0.01) sl += rainRipple(vWPos.xz * 0.6, uWxTime) * 0.12 * uRain * smoothstep(60.0, 8.0, dv);
        normal = normalize(normal + mat3(viewMatrix) * vec3(-sl.x, 0.0, -sl.y));
      }`,
    });
    seaMat.envMapIntensity = 1.25;
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(26000, 26000).rotateX(-Math.PI / 2), seaMat);
    sea.position.set(300, SEA, 0); sea.receiveShadow = true; group.add(sea);
    K.seaMat = seaMat;
  }

  prepMonaco(K);
  buildCity(K);
  dressMonaco(K);
  K.flushCity();
  M.stats = K.cityStats();
  return {
    // per frame: where the car is (drives the tunnel's lighting state)
    update(target) {
      const i = nearestIndexGlobal(track, target.x, -target.z);
      let k = 0; for (const [a, b] of M.tun) if (i >= a && i <= b) k = Math.min(1, (i - a) / 25, (b - i) / 25);
      uTunK.value = k;
    },
  };
}

// =============================================================================================================
// Buildings: OSM footprints extruded in bands (plinth, ground floor, storeys, cornice) with styles chosen per block.
const OLD = ['#e6bd78', '#e3a283', '#f0dfb8', '#e9b9a4', '#ecd08c', '#efc49e', '#dc9672', '#f1e9d8', '#d9d6bf', '#e8c9a0'];
const MOD = ['#f6f1e6', '#f1e4c9', '#f0d5c3', '#e9d3ad', '#efe8da', '#f5e7cc'];
function buildCity(K) {
  const { M, track, sc, terrain, group, detail, cast, facMat, mkAcc, accGeo, quad, wall, srgb, ctx } = K;
  const FH = 3.1, BW = 3.2;
  const CH = 8, chunks = Array.from({ length: CH }, () => mkAcc()), roofChunks = Array.from({ length: CH }, () => ({ pos: [], col: [], idx: [] }));
  const corridorHit = (x, y, pad) => { const t = terrain(x, y); return !M.inTun(t.idx) && t.dist < (t.side > 0 ? track.wallL[t.idx] : track.wallR[t.idx]) + pad ? t : null; };
  const overTunnel = (x, y) => { const i = nearestIndexGlobal(track, x, y); return M.inTun(i) && Math.hypot(x - track.x[i], y - track.y[i]) < Math.max(track.wallL[i], track.wallR[i]) + 2.2 ? track.z[i] + 7.3 : 0; };
  const foot = [];           // footprints kept, for the infill and props to avoid
  K.droppedList = [];
  let dropped = 0;

  const styleOf = (b) => {
    const cellH = hash2(Math.floor(b.c[0] / 75) + 40, Math.floor(b.c[1] / 75) + 40), h1 = hash2(b.P[0][0] * 10, b.P[0][1] * 10), h2 = hash2(b.P[0][1] * 10 + 3, b.P[0][0] * 10);
    const s = { tint: [1, 1, 1], ground: L.SHOPS, body: L.PLAIN, top: L.PARAPET, topH: 1.2, roof: 'flat', roofCol: [0.5, 0.48, 0.45] };
    const pal = (list) => srgb(list[Math.floor((h1 < 0.65 ? cellH : h2) * list.length) % list.length]);
    if (b.style) Object.assign(s, b.style);
    else if (b.oldTown && b.kind !== 2) { s.body = h2 < 0.5 ? L.PLAIN : L.BELLE; s.ground = h1 < 0.5 ? L.RUSTIC : L.SHOPS; s.top = L.PARAPET; s.topH = 0.5; s.roof = 'hip'; s.tint = pal(OLD); s.roofCol = [0.5, 0.25, 0.16]; }
    else if (b.kind === 2) { s.body = L.BLANK; s.ground = L.RUSTIC; s.top = L.CORNICE; s.topH = 1.6; s.roof = 'hip'; s.tint = srgb('#e9dcc0'); }
    else if (b.h >= 31 || (b.kind === 1 && b.h >= 23) || (b.a > 1400 && b.h > 19)) {
      s.body = b.kind === 4 && h2 < 0.6 ? L.GLASS : b.kind === 3 ? L.HOTEL : h2 < 0.55 ? L.BANDS : L.LOGGIA; s.ground = h1 < 0.5 ? L.SHOPS : L.CONCRETE; s.tint = pal(MOD); s.roof = 'flat'; s.pent = h1 > 0.45;
    } else if (b.h < 10.5 || b.kind === 5) { s.body = h2 < 0.5 ? L.PLAIN : L.BELLE; s.ground = L.RUSTIC; s.top = L.PARAPET; s.topH = 0.5; s.roof = 'hip'; s.tint = pal(OLD); s.roofCol = [0.5, 0.25, 0.16]; }
    else if (cellH < 0.62 || b.kind === 3) { s.body = h2 < 0.5 ? L.BELLE : L.BELLE2; s.ground = h1 < 0.4 ? L.ARCADE : h1 < 0.75 ? L.SHOPS : L.RUSTIC; s.top = L.CORNICE; s.topH = 1.6; s.roof = h2 > 0.35 ? 'mansard' : 'tiles'; s.tint = pal(OLD); s.roofCol = [0.5, 0.25, 0.16]; }
    else { s.body = h2 < 0.6 ? L.PLAIN : L.LOGGIA; s.ground = L.SHOPS; s.tint = pal(h1 < 0.5 ? OLD : MOD); s.roof = h2 < 0.4 ? 'tiles' : 'flat'; s.roofCol = h2 < 0.4 ? [0.5, 0.25, 0.16] : [0.5, 0.48, 0.45]; }
    const sh = 0.9 + 0.16 * h2; s.tint = s.tint.map(v => v * sh);
    return s;
  };

  // one building: P counter-clockwise [[x, y]...], h height above its highest ground point
  function addBuilding(b) {
    let P = b.P.map(p => p.slice());
    // footprints that reach into the road corridor (the modelled road is wider than some streets) are pushed back
    if (!b.free) {
      // densify the edges that run into the corridor, then move every point inside it back to the building's own side
      const D = [];
      for (let k = 0; k < P.length; k++) { const a = P[k], c = P[(k + 1) % P.length], Ln = Math.hypot(c[0] - a[0], c[1] - a[1]), st = Math.max(1, Math.ceil(Ln / 2.5)); D.push(a); let any = false; const mid = []; for (let q = 1; q < st; q++) { const p = [a[0] + (c[0] - a[0]) * q / st, a[1] + (c[1] - a[1]) * q / st]; mid.push(p); if (corridorHit(p[0], p[1], 2.2)) any = true; } if (any) D.push(...mid); }
      const cx = D.reduce((v, p) => v + p[0], 0) / D.length, cy = D.reduce((v, p) => v + p[1], 0) / D.length;
      let moved = 0;
      for (const p of D) { const t = corridorHit(p[0], p[1], 1.7); if (!t) continue; const i = t.idx, hd = track.heading[i], latC = -(cx - track.x[i]) * Math.sin(hd) + (cy - track.y[i]) * Math.cos(hd), s = latC >= 0 ? 1 : -1, o = (s > 0 ? track.wallL[i] : track.wallR[i]) + 1.9, along = (p[0] - track.x[i]) * Math.cos(hd) + (p[1] - track.y[i]) * Math.sin(hd); p[0] = track.x[i] + Math.cos(hd) * along - Math.sin(hd) * s * o; p[1] = track.y[i] + Math.sin(hd) * along + Math.cos(hd) * s * o; moved++; }
      if (moved) { P = D.filter((p, k) => { const q = D[(k + 1) % D.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.3; }); 
        // straight runs along the corridor edge collapse back to their end points
        for (let pass = 0; pass < 3; pass++) P = P.filter((p, k) => { const a = P[(k + P.length - 1) % P.length], c = P[(k + 1) % P.length], L2 = Math.hypot(c[0] - a[0], c[1] - a[1]); return L2 < 1e-3 || k % 2 === pass % 2 || Math.abs((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) / L2 > 0.3; });
        if (P.length < 3) { dropped++; return false; } }
      for (let k = 0; k < P.length; k++) { const a = P[k], c = P[(k + 1) % P.length], Ln = Math.hypot(c[0] - a[0], c[1] - a[1]), st = Math.max(1, Math.ceil(Ln / 2)); for (let q = 0; q <= st; q++) if (corridorHit(a[0] + (c[0] - a[0]) * q / st, a[1] + (c[1] - a[1]) * q / st, 0.9)) { dropped++; K.droppedList.push([Math.round(cx), Math.round(cy), b.mark || '']); return false; } }
      if (polyArea(P) < 18) { dropped++; return false; }
    }
    const c = [0, 0]; for (const p of P) { c[0] += p[0] / P.length; c[1] += p[1] / P.length; }
    b.c = c; b.a = Math.abs(polyArea(P));
    const G = P.map(p => { const t = terrain(p[0], p[1]); return t.sea > 0 && M.isSea(p[0], p[1]) ? M.SEA - 1 : t.h; });
    let lo = Infinity, hi = -Infinity; for (const g of G) { lo = Math.min(lo, g); hi = Math.max(hi, g); }
    const landG = G.filter(g => g > M.SEA); if (landG.length) hi = Math.max(...landG);
    const gmid = b.z0 !== undefined ? b.z0 : Math.min(hi, lo + 9 > hi ? (lo + hi) / 2 + 1 : lo + 6);
    const s = styleOf(b), top = b.topAbs ?? gmid + b.h, bodyTop = top - s.topH, base = lo - 2.5;
    const ti = terrain(c[0], c[1]).idx, A = chunks[Math.min(CH - 1, Math.floor(ti / track.n * CH))], Rf = roofChunks[Math.min(CH - 1, Math.floor(ti / track.n * CH))];
    const stone = srgb('#cdbfa6');
    let seed = Math.floor(hash2(P[0][0] * 7, P[0][1] * 7) * 4);
    for (let k = 0; k < P.length; k++) {
      const a = P[k], e = P[(k + 1) % P.length], Ln = Math.hypot(e[0] - a[0], e[1] - a[1]); if (Ln < 0.05) continue;
      // split long edges so the ground floor follows the street, and wherever the wall passes over the tunnel
      const nseg = Math.max(1, Math.round(Ln / 12.8)), runs = [];
      for (let q = 0; q < nseg; q++) {
        const t0 = q / nseg, t1 = (q + 1) / nseg, mx = a[0] + (e[0] - a[0]) * (t0 + t1) / 2, my = a[1] + (e[1] - a[1]) * (t0 + t1) / 2;
        let ot = 0; for (const tt of [t0, (t0 + t1) / 2, t1]) ot = Math.max(ot, overTunnel(a[0] + (e[0] - a[0]) * tt, a[1] + (e[1] - a[1]) * tt));
        const tm = terrain(mx, my), g0 = terrain(a[0] + (e[0] - a[0]) * t0, a[1] + (e[1] - a[1]) * t0).h, g1 = terrain(a[0] + (e[0] - a[0]) * t1, a[1] + (e[1] - a[1]) * t1).h;
        const sea = M.isSea(mx, my);
        runs.push({ t0, t1, ot, ge: ot || (sea ? M.QUAY : Math.max(tm.h, Math.min(g0, g1) + 0.3)), gb: ot ? ot - 0.2 : sea ? M.SEA - 1 : Math.min(g0, g1, tm.h) - 1.5 });
      }
      for (const r of runs) {
        const ax = a[0] + (e[0] - a[0]) * r.t0, ay = a[1] + (e[1] - a[1]) * r.t0, bx = a[0] + (e[0] - a[0]) * r.t1, by = a[1] + (e[1] - a[1]) * r.t1, Lr = Ln * (r.t1 - r.t0);
        const nb = Math.max(1, Math.round(Lr / BW)), narrow = Lr < 2.3, u0 = (seed++ % 4) / 4, u1 = u0 + nb / 4;
        let ge = Math.min(r.ge, bodyTop - 0.5); const gb = Math.min(r.gb, base);
        if (ge < bodyTop - 3.2 && !r.ot) {
          const kf = Math.max(0, Math.floor((bodyTop - (ge + 3.3)) / FH)), fl0 = bodyTop - kf * FH;
          wall(A, ax, ay, bx, by, gb, ge, L.STONE, stone);
          if (narrow) wall(A, ax, ay, bx, by, ge, bodyTop, L.BLANK, s.tint, 0, Lr / 12.8, 0, (bodyTop - ge) / 6.2);
          else {
            wall(A, ax, ay, bx, by, ge, fl0, s.ground, s.ground === L.CONCRETE ? srgb('#d9d4c8') : s.tint, u0, u1, 0, Math.min(1, (fl0 - ge) / 4.2 + 0.12));
            if (kf > 0) wall(A, ax, ay, bx, by, fl0, bodyTop, s.body, s.tint, u0, u1, (kf % 2) / 2, (kf % 2) / 2 + kf / 2);
          }
        } else {
          const z0 = r.ot ? ge : gb, kf = Math.max(0, Math.floor((bodyTop - z0) / FH)), fl0 = bodyTop - kf * FH;
          wall(A, ax, ay, bx, by, z0, fl0, r.ot ? L.CONCRETE : L.STONE, r.ot ? srgb('#cfcabf') : stone);
          if (kf > 0) wall(A, ax, ay, bx, by, fl0, bodyTop, narrow ? L.BLANK : s.body, s.tint, u0, u1, 0, kf / 2);
        }
        wall(A, ax, ay, bx, by, bodyTop, top, s.top, s.tint, u0, u1, 0, s.topH / 1.6);
      }
    }
    // roof
    const tri = (Q, z, col, inner) => { const o = Rf.pos.length / 3, f = THREE.ShapeUtils.triangulateShape(Q.map(p => new THREE.Vector2(p[0], p[1])), []); for (const p of Q) { Rf.pos.push(p[0], z, -p[1]); Rf.col.push(col[0], col[1], col[2]); } for (const t of f) Rf.idx.push(o + t[0], o + t[1], o + t[2]); };
    const sv = 0.85 + 0.3 * hash2(P[0][0] * 3, 9);
    let ring = null;
    if ((s.roof === 'mansard' || s.roof === 'hip') && P.length <= 14) ring = insetPoly(P, s.roof === 'mansard' ? 1.5 : Math.min(4.5, Math.sqrt(b.a) * 0.22));
    if (ring) {
      const rise = s.roof === 'mansard' ? 3.1 : Math.min(2.6, Math.sqrt(b.a) * 0.12 + 0.6), lay = s.roofLayer ?? (s.roof === 'mansard' ? L.ZINC : L.TILES), tn = lay === L.TILES ? [sv, sv, sv] : [1, 1, 1];
      let per = 0;
      for (let k = 0; k < P.length; k++) { const a = P[k], e = P[(k + 1) % P.length], qa = ring[k], qe = ring[(k + 1) % P.length], Ln = Math.hypot(e[0] - a[0], e[1] - a[1]), [lw, lh] = LSIZE[lay]; const nb = Math.max(1, Math.round(Ln / BW)), u0 = lay === L.ZINC ? 0 : per / lw, u1 = lay === L.ZINC ? nb / 4 : (per + Ln) / lw; quad(A, [a[0], top, a[1], u0, 0], [e[0], top, e[1], u1, 0], [qe[0], top + rise, qe[1], u1, lay === L.ZINC ? 1 : 3.2 / lh], [qa[0], top + rise, qa[1], u0, lay === L.ZINC ? 1 : 3.2 / lh], lay, tn); per += Ln; }
      tri(ring, top + rise, s.roof === 'mansard' ? [0.3 * sv, 0.33 * sv, 0.36 * sv] : s.roofCol.map(v => v * sv * 0.9));
    } else {
      tri(P, top - (s.top === L.PARAPET || s.top === L.CORNICE ? 0.7 : 0.05), s.roofCol.map(v => v * sv));
      // set-back penthouse and plant on big flat roofs
      const pin = s.pent && b.a > 260 ? insetPoly(P, 3.2) : null;
      if (pin) { for (let k = 0; k < pin.length; k++) { const a = pin[k], e = pin[(k + 1) % pin.length], Ln = Math.hypot(e[0] - a[0], e[1] - a[1]), nb = Math.max(1, Math.round(Ln / BW)); wall(A, a[0], a[1], e[0], e[1], top - 0.7, top + 3.0, s.body === L.GLASS ? L.GLASS : L.BANDS, s.tint, 0, nb / 4, 0, 0.5); wall(A, a[0], a[1], e[0], e[1], top + 3.0, top + 3.4, L.PARAPET, s.tint, 0, nb / 4, 0.7, 1); } tri(pin, top + 3.35, [0.52, 0.5, 0.47]); }
      else if (b.a > 140 && detail > 0) { const hx = hash2(P[0][0], 5), bx = c[0] + (hx - 0.5) * 3, by = c[1] + (hash2(P[0][1], 7) - 0.5) * 3; if (inPoly(P, bx - 2, by - 2) && inPoly(P, bx + 2, by + 2)) K.box(A, bx, by, 1.8 + hx, 1.6, hx * 3, top - 0.7, top + 1.6 + hx, L.CONCRETE, srgb('#cfcabf')); }
    }
    foot.push({ P, c, r: Math.sqrt(b.a) * 0.9 + 4, top, mark: b.mark, x0: Math.min(...P.map(p => p[0])), x1: Math.max(...P.map(p => p[0])), y0: Math.min(...P.map(p => p[1])), y1: Math.max(...P.map(p => p[1])) });
    return true;
  }
  K.addBuilding = addBuilding; K.foot = foot;

  const names = new Map(sc.marks.map(([nm, k]) => [k, nm])); let bi = 0;
  for (const raw of sc.buildings) {
    const P = []; for (let k = 2; k < raw.length; k += 2) P.push([raw[k] / 10, raw[k + 1] / 10]);
    const c = [0, 0]; for (const p of P) { c[0] += p[0] / P.length; c[1] += p[1] / P.length; }
    const b = { P, h: raw[0] / 10, kind: raw[1] >> 1, c, a: Math.abs(polyArea(P)), name: names.get(bi) || '' }; bi++;
    K.landmark?.(b);
    if (!b.skip) addBuilding(b);
  }
  K.flushCity = () => {
    chunks.forEach((A, k) => { const g = accGeo(A); if (!g) return; group.add(cast(new THREE.Mesh(g, facMat))); A.pos.length = A.nor.length = A.fac.length = A.tint.length = 0; });
    const roofMat = ctx.wettable(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), 0.5);
    roofChunks.forEach((R) => { if (!R.idx.length) return; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(R.pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(R.col, 3)); g.setIndex(R.idx); g.computeVertexNormals(); group.add(cast(new THREE.Mesh(g, roofMat))); });
  };
  K.cityStats = () => ({ kept: foot.length, dropped, list: K.droppedList });

  // ---- the town beyond 330 m: OSM footprints as boxes, then generated blocks up the hill ----
  {
    const A = mkAcc(), F = sc.far, rng = new RNG(8181);
    const one = (cx, cy, w, d, ang, h) => {
      const g = M.farH(cx, cy), tall = h > 30, hh = hash2(cx, cy), body = tall ? (hh < 0.5 ? L.BANDS : L.LOGGIA) : hh < 0.4 ? L.BELLE : hh < 0.8 ? L.PLAIN : L.LOGGIA;
      const tint = srgb((tall ? MOD : OLD)[Math.floor(hash2(Math.floor(cx / 90), Math.floor(cy / 90)) * (tall ? MOD : OLD).length)]).map(v => v * (0.88 + 0.2 * hh));
      const c = Math.cos(ang), s = Math.sin(ang), hw = w / 2, hd = d / 2, P = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
      const kf = Math.max(1, Math.round(h / FH)), top = g + kf * FH + 1;
      for (let k = 0; k < 4; k++) { const a = P[k], e = P[(k + 1) % 4], Ln = Math.hypot(e[0] - a[0], e[1] - a[1]), nb = Math.max(1, Math.round(Ln / BW)); wall(A, a[0], a[1], e[0], e[1], g - 8, top - kf * FH, L.STONE, srgb('#cdbfa6')); wall(A, a[0], a[1], e[0], e[1], top - kf * FH, top, body, tint, 0, nb / 4, 0, kf / 2); }
      const rc = tall || hh > 0.6 ? [0.5, 0.48, 0.45] : [0.5, 0.26, 0.17];
      quad(A, [P[0][0], top, P[0][1], 0, 0], [P[1][0], top, P[1][1], 1, 0], [P[2][0], top, P[2][1], 1, 1], [P[3][0], top, P[3][1], 0, 1], tall || hh > 0.6 ? L.CONCRETE : L.TILES, rc.map(v => v * 1.6));
    };
    for (let k = 0; k < F.length; k += 6) { if (detail === 0 && (k / 6) % 2) continue; one(F[k], F[k + 1], Math.max(8, F[k + 2]), Math.max(8, F[k + 3]), F[k + 4] * Math.PI / 180, F[k + 5]); }
    // beyond the OSM window: Beausoleil and the western districts climbing to the corniches
    const N = detail > 1 ? 2600 : detail > 0 ? 1700 : 500; let made = 0, guard = 0;
    while (made < N && guard++ < N * 30) {
      const x = rng.uniform(-2600, 3200), y = rng.uniform(-2600, 3200); if (x > M.W.x0 - 30 && x < M.W.x1 + 30 && y > M.W.y0 - 30 && y < M.W.y1 + 30) continue;
      const h = M.demH(x, y); if (h < 4 || h > 330) continue;
      const dens = (1 - smooth(120, 330, h)) * (1 - smooth(1500, 3200, Math.hypot(x - 300, y))) * (0.35 + 0.65 * smooth(0.35, 0.6, hash2(Math.floor(x / 160), Math.floor(y / 160)) * 0.6 + 0.4 * rng.next()));
      if (rng.next() > dens) continue;
      const gx = M.demH(x + 20, y) - M.demH(x - 20, y), gy = M.demH(x, y + 20) - M.demH(x, y - 20);
      const tall = rng.next() < 0.16 * (1 - smooth(90, 220, h));
      one(x, y, rng.uniform(14, tall ? 26 : 34), rng.uniform(11, 18), Math.atan2(gy, gx) + Math.PI / 2 + rng.uniform(-0.15, 0.15), tall ? rng.uniform(34, 70) : rng.uniform(9, 24));
      made++;
    }
    const g = accGeo(A); if (g) { const m = new THREE.Mesh(g, facMat); m.receiveShadow = false; m.castShadow = false; group.add(m); }
  }
}
