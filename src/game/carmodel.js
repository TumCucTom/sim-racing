// Car models. Every car has a procedural body, lofted from a handful of key
// cross-section stations per body style; it is what the ghost car uses, what is
// shown while a detailed glTF model (GLB_MODELS below) is loading, and what
// remains if that file cannot be loaded. Model space: +X forward, +Y up, +Z right; origin at
// the CG's ground projection.
import * as THREE from 'three';
import { labelTexture } from './textures.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

let gltfLoader = null;
const glbCache = new Map();
function loadGLB(url) {
  if (!glbCache.has(url)) {
    if (!gltfLoader) { const d = new DRACOLoader(); d.setDecoderPath('draco/'); gltfLoader = new GLTFLoader(); gltfLoader.setDRACOLoader(d); }
    // hosted single-file builds embed binary assets as base64 (see tools/make-artifact.js)
    const inline = globalThis.__INLINE_ASSETS?.[url];
    if (inline) {
      const bin = atob(inline), buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      glbCache.set(url, gltfLoader.parseAsync(buf.buffer, ''));
    } else glbCache.set(url, gltfLoader.loadAsync(url));
  }
  return glbCache.get(url);
}

// [xFrac, halfWidthFrac, floorY, beltY, roofY, roofWidthFrac] (heights in metres, scaled by style height)
const STYLES = {
  hatch: [[-0.50, 0.82, 0.40, 0.78, 0.80, 0.60], [-0.48, 0.93, 0.30, 0.96, 1.05, 0.62], [-0.44, 0.98, 0.22, 1.00, 1.33, 0.66], [-0.36, 1.00, 0.19, 1.00, 1.40, 0.70],
    [-0.10, 1.00, 0.17, 0.98, 1.41, 0.72], [0.06, 1.00, 0.17, 0.97, 1.36, 0.70], [0.20, 1.00, 0.17, 0.95, 0.99, 0.66], [0.34, 0.99, 0.18, 0.86, 0.88, 0.62],
    [0.45, 0.95, 0.22, 0.72, 0.74, 0.60], [0.495, 0.84, 0.32, 0.60, 0.62, 0.55], [0.50, 0.78, 0.36, 0.52, 0.54, 0.50]],
  coupe: [[-0.50, 0.80, 0.42, 0.80, 0.82, 0.55], [-0.47, 0.94, 0.30, 0.92, 0.94, 0.58], [-0.40, 0.99, 0.22, 0.98, 1.02, 0.60], [-0.30, 1.00, 0.19, 0.99, 1.16, 0.62],
    [-0.14, 1.00, 0.17, 0.97, 1.35, 0.66], [-0.02, 1.00, 0.17, 0.95, 1.38, 0.67], [0.08, 1.00, 0.17, 0.94, 1.30, 0.66], [0.17, 1.00, 0.17, 0.93, 0.97, 0.64],
    [0.32, 0.99, 0.18, 0.88, 0.90, 0.62], [0.45, 0.96, 0.22, 0.78, 0.80, 0.60], [0.495, 0.86, 0.32, 0.66, 0.68, 0.55], [0.50, 0.80, 0.38, 0.56, 0.58, 0.50]],
  gt: [[-0.50, 0.84, 0.36, 0.74, 0.76, 0.50], [-0.47, 0.97, 0.24, 0.86, 0.90, 0.52], [-0.38, 1.00, 0.14, 0.90, 1.00, 0.54], [-0.22, 1.00, 0.10, 0.90, 1.16, 0.56],
    [-0.06, 0.98, 0.09, 0.88, 1.25, 0.58], [0.04, 0.97, 0.09, 0.86, 1.22, 0.58], [0.15, 0.97, 0.09, 0.84, 0.90, 0.56], [0.30, 0.99, 0.09, 0.74, 0.76, 0.54],
    [0.44, 0.98, 0.10, 0.62, 0.64, 0.50], [0.495, 0.88, 0.14, 0.50, 0.52, 0.45], [0.50, 0.82, 0.18, 0.42, 0.44, 0.40]],
  sedan: [[-0.50, 0.80, 0.40, 0.84, 0.86, 0.55], [-0.47, 0.95, 0.28, 0.98, 1.00, 0.58], [-0.40, 0.99, 0.20, 1.02, 1.06, 0.60], [-0.30, 1.00, 0.16, 1.00, 1.22, 0.62],
    [-0.15, 1.00, 0.15, 0.98, 1.36, 0.66], [0.00, 1.00, 0.15, 0.96, 1.38, 0.67], [0.10, 1.00, 0.15, 0.95, 1.30, 0.66], [0.21, 1.00, 0.15, 0.94, 0.98, 0.64],
    [0.35, 0.99, 0.16, 0.86, 0.88, 0.62], [0.46, 0.95, 0.20, 0.76, 0.78, 0.58], [0.495, 0.85, 0.30, 0.62, 0.64, 0.52], [0.50, 0.78, 0.36, 0.54, 0.56, 0.48]],
};

// Mini: upright, short overhangs, almost vertical tail and screen.
STYLES.mini = [[-0.50, 0.86, 0.36, 0.82, 0.84, 0.72], [-0.488, 0.95, 0.26, 0.97, 1.22, 0.78], [-0.462, 0.99, 0.21, 1.00, 1.37, 0.82], [-0.38, 1.00, 0.19, 1.00, 1.41, 0.84],
  [-0.02, 1.00, 0.18, 0.99, 1.41, 0.84], [0.13, 1.00, 0.18, 0.98, 1.38, 0.82], [0.225, 1.00, 0.18, 0.97, 1.01, 0.78], [0.36, 0.99, 0.19, 0.93, 0.95, 0.72],
  [0.455, 0.96, 0.22, 0.87, 0.89, 0.68], [0.492, 0.88, 0.30, 0.74, 0.76, 0.62], [0.50, 0.80, 0.38, 0.62, 0.64, 0.56]];
// Le Mans prototype: [xFrac, halfWidthFrac, floorY, fenderY, deckY, roofY, canopyWidthFrac]
STYLES.proto = [[-0.50, 0.95, 0.22, 0.60, 0.50, 0.50, 0.30], [-0.465, 1.00, 0.11, 0.80, 0.56, 0.56, 0.30], [-0.34, 1.00, 0.07, 0.86, 0.62, 0.64, 0.30], [-0.21, 1.00, 0.06, 0.70, 0.64, 0.88, 0.31],
  [-0.08, 0.98, 0.06, 0.58, 0.60, 1.06, 0.35], [0.02, 0.97, 0.06, 0.56, 0.57, 1.08, 0.36], [0.11, 0.97, 0.06, 0.60, 0.53, 0.98, 0.35], [0.21, 0.98, 0.06, 0.74, 0.47, 0.50, 0.33],
  [0.31, 1.00, 0.06, 0.84, 0.40, 0.41, 0.30], [0.42, 0.99, 0.07, 0.70, 0.31, 0.32, 0.30], [0.485, 0.94, 0.09, 0.40, 0.24, 0.25, 0.30], [0.50, 0.88, 0.11, 0.30, 0.22, 0.23, 0.30]];
const REF_H = { gt: 1.25, hatch: 1.41, mini: 1.41, proto: 1.08 };

function sampleStations(keys, n) {
  const out = [], C = keys[0].length;
  for (let s = 0; s < n; s++) {
    // denser sampling at the ends where the shape changes quickly
    const u = s / (n - 1), x = -0.5 + (0.5 - 0.5 * Math.cos(u * Math.PI)) * 0.35 + u * 0.65;
    let k = 0; while (k < keys.length - 2 && keys[k + 1][0] < x) k++;
    const a = keys[k], b = keys[k + 1], t = Math.max(0, Math.min(1, (x - a[0]) / (b[0] - a[0])));
    out.push(a.map((v, i) => (i === 0 ? x : v + (b[i] - v) * t)));
  }
  for (let pass = 0; pass < 5; pass++) for (let c = 1; c < C; c++) {
    const col = out.map(r => r[c]);
    for (let s = 1; s < n - 1; s++) out[s][c] = (col[s - 1] + 2 * col[s] + col[s + 1]) / 4;
  }
  return out;
}

// Each 10-point half section is refined with a Catmull-Rom spline so there is
// enough mesh on the flanks to cut wheel arches into.
const SUB = [2, 4, 4, 4, 3, 2, 2, 2, 2];
function refine(base) {
  const pts = [], seg = [], cr = (a, b, c, d, t) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  for (let k = 0; k < base.length - 1; k++) {
    const p0 = base[Math.max(0, k - 1)], p1 = base[k], p2 = base[k + 1], p3 = base[Math.min(base.length - 1, k + 2)];
    for (let j = 0; j < SUB[k]; j++) {
      const t = j / SUB[k];
      pts.push(k === 0 ? [p1[0] + (p2[0] - p1[0]) * t, p1[1]] : [Math.max(0, cr(p0[0], p1[0], p2[0], p3[0], t)), cr(p0[1], p1[1], p2[1], p3[1], t)]);
      seg.push(k);
    }
  }
  pts.push(base[base.length - 1]); seg.push(base.length - 2);
  return { pts, seg };
}

// Lofted body shell. `arches` = [{ x, R }] in shell coordinates: wheel openings are
// cut by snapping nearby vertices onto the arch circle and sinking the ones
// inside it into a dark wheel well. Returns paint / liner / roof / glass
// geometry plus helpers to lay conformal patches (lights) and shut lines on the surface.
function loftBody(style, L, W, H, { arches = [], zInner = 0.6, glassFront = -1 } = {}) {
  const NS = 96, proto = style === 'proto';
  const st = sampleStations(STYLES[style], NS);
  const ys = H / (REF_H[style] || 1.38), hw = W / 2 - 0.035;
  const sect = st.map((row) => {
    const [xf, wf, yb] = row, w = wf * hw, f = yb * ys;
    let base, cabin, r;
    if (proto) {
      const b = row[3] * ys, deck = row[4] * ys; r = Math.max(row[5] * ys, deck + 0.01); cabin = r - deck;
      const rw = row[6] * hw, k = Math.min(1, cabin * 4);
      base = [[0, f], [0.78 * w, f], [0.97 * w, f + 0.15 * (b - f)], [w, f + 0.55 * (b - f)], [0.975 * w, b - 0.09 * (b - f)], [0.87 * w, b],
        [0.66 * w, deck + 0.3 * (b - deck)], [rw + 0.07 + 0.2 * w * (1 - k), deck + 0.03 * k], [rw * 0.85, r - 0.14 * cabin], [0, r + 0.012]];
    } else {
      const b = row[3] * ys; r = Math.max(row[4] * ys, b + 0.015); cabin = r - b;
      const rw = row[5] * hw * (cabin > 0.12 ? 1 : 1.25);
      base = [[0, f], [0.74 * w, f], [0.965 * w, f + 0.13 * (b - f)], [w, f + 0.5 * (b - f)], [0.975 * w, b - 0.1 * (b - f)], [0.91 * w, b],
        [Math.min(0.86 * w, rw + 0.16 * Math.min(1, cabin * 3) + 0.02), b + 0.02 + Math.min(0.03, cabin * 0.2)], [rw + 0.03, r - 0.09 * cabin], [rw * 0.82, r], [0, r + 0.02 * Math.min(1, cabin * 4)]];
    }
    const hi = refine(base);
    return { x: xf * L, xf, cabin, roof: r, pts: base, hp: hi.pts, seg: hi.seg };
  });
  const P = sect[0].hp.length, seg = sect[0].seg, g0 = proto ? 7 : 6;
  const paint = { pos: [], idx: [], map: new Map(), tri: [] }, glass = { pos: [], idx: [], map: new Map() };
  const vert = (grp, s, p, side) => {
    const key = s * 1000 + p * 2 + (side > 0 ? 1 : 0);
    let i = grp.map.get(key);
    if (i === undefined) { i = grp.pos.length / 3; const [z, y] = sect[s].hp[p]; grp.pos.push(sect[s].x, y, z * side); grp.map.set(key, i); }
    return i;
  };
  for (let s = 0; s < sect.length - 1; s++) {
    const A = sect[s], B = sect[s + 1];
    const slope = Math.abs(B.roof - A.roof) / (B.x - A.x), cab = Math.min(A.cabin, B.cabin);
    for (let p = 0; p < P - 1; p++) {
      const k = seg[p];
      let isGlass = false;
      if (k === g0 && cab > 0.2) isGlass = true;                         // side windows
      if (k >= g0 && cab > (proto ? 0.16 : 0.06) && slope > 0.28) isGlass = true;         // windscreen / rear screen
      if (isGlass && A.xf < glassFront) isGlass = false;
      const grp = isGlass ? glass : paint;
      for (const side of [1, -1]) {
        if (side < 0 && A.hp[p][0] === 0 && A.hp[p + 1][0] === 0 && B.hp[p][0] === 0 && B.hp[p + 1][0] === 0) continue;
        const a = vert(grp, s, p, side), b = vert(grp, s + 1, p, side), c = vert(grp, s, p + 1, side), d = vert(grp, s + 1, p + 1, side);
        if (side > 0) grp.idx.push(a, b, c, c, b, d); else grp.idx.push(a, c, b, c, d, b);
        if (!isGlass) { const tk = k >= 7 && cab > 0.25 ? 7 : Math.min(k, 6); paint.tri.push(tk, tk); }
      }
    }
  }
  // end caps
  for (const [s, flip] of [[0, true], [sect.length - 1, false]]) {
    const cy = (sect[s].hp[0][1] + sect[s].hp[P - 1][1]) / 2;
    const ci = paint.pos.length / 3; paint.pos.push(sect[s].x, cy, 0);
    for (const side of [1, -1]) for (let p = 0; p < P - 1; p++) {
      const a = vert(paint, s, p, side), b = vert(paint, s, p + 1, side);
      if ((side > 0) !== flip) paint.idx.push(ci, b, a); else paint.idx.push(ci, a, b);
      paint.tri.push(0);
    }
  }
  // wheel arches
  const nV = paint.pos.length / 3, inside = new Uint8Array(nV), SNAP = 0.042;
  for (let i = 0; i < nV; i++) {
    const x = paint.pos[i * 3], y = paint.pos[i * 3 + 1], z = paint.pos[i * 3 + 2];
    if (Math.abs(z) < zInner) continue;
    for (const ar of arches) {
      const dx = x - ar.x, dy = y - ar.R, d = Math.hypot(dx, dy), Ra = ar.Ra;
      if (d < Ra - SNAP) { inside[i] = 1; paint.pos[i * 3 + 2] = Math.sign(z) * zInner; }
      else if (d < Ra + SNAP) { paint.pos[i * 3] = ar.x + dx / d * Ra; paint.pos[i * 3 + 1] = ar.R + dy / d * Ra; }
    }
  }
  const body = [], liner = [], roof = [];
  for (let t = 0; t < paint.idx.length; t += 3) {
    const a = paint.idx[t], b = paint.idx[t + 1], c = paint.idx[t + 2];
    (inside[a] || inside[b] || inside[c] ? liner : paint.tri[t / 3] >= 7 ? roof : body).push(a, b, c);
  }
  const mk = (pos, idx) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals(); return geo; };
  const paintG = mk(paint.pos, [...body, ...roof, ...liner]);
  paintG.addGroup(0, body.length, 0); paintG.addGroup(body.length, roof.length, 1); paintG.addGroup(body.length + roof.length, liner.length, 2);
  const nrm = paintG.attributes.normal.array;
  const surf = (s, p, side, lift, out) => { const i = paint.map.get(s * 1000 + p * 2 + (side > 0 ? 1 : 0)); if (i === undefined || inside[i]) return false; out.push(paint.pos[i * 3] + nrm[i * 3] * lift, paint.pos[i * 3 + 1] + nrm[i * 3 + 1] * lift, paint.pos[i * 3 + 2] + nrm[i * 3 + 2] * lift); return true; };
  // a patch of the shell between two body-length fractions and two section segments, floated just off the paint
  const patchGeo = (xf0, xf1, k0, k1, lift = 0.004) => {
    const pos = [], idx = [];
    for (const side of [1, -1]) {
      let prev = null;
      for (let s = 0; s < sect.length; s++) {
        if (sect[s].xf < xf0 || sect[s].xf > xf1) { prev = null; continue; }
        const row = [];
        for (let p = 0; p < P; p++) if (seg[p] >= k0 && seg[p] <= k1 || (p > 0 && seg[p - 1] >= k0 && seg[p - 1] <= k1)) { const b = pos.length / 3; row.push(surf(s, p, side, lift, pos) ? b : -1); }
        if (prev) for (let j = 0; j < row.length - 1; j++) { const a = prev[j], b = row[j], c = prev[j + 1], d = row[j + 1]; if (a < 0 || b < 0 || c < 0 || d < 0) continue; if (side > 0) idx.push(a, b, c, c, b, d); else idx.push(a, c, b, c, d, b); }
        prev = row;
      }
    }
    return mk(pos, idx);
  };
  // shut line around the section at one station, between two segments
  const shutLine = (xf, k0, k1) => {
    let s = 0; while (s < sect.length - 1 && sect[s].xf < xf) s++;
    const out = [];
    for (const side of [1, -1]) { const pos = []; for (let p = 0; p < P; p++) if (seg[p] >= k0 && seg[p] <= k1) surf(s, p, side, 0.003, pos); if (pos.length >= 6) out.push(pos); }
    return out;
  };
  return { paint: paintG, glass: mk(glass.pos, glass.idx), sect, hw, ys, patchGeo, shutLine };
}

// Soft contact shadow under a car (multiplied onto the road).
let blobTex = null;
function contactShadow(L, W) {
  if (!blobTex) {
    const S = 128, c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, S, S); x.filter = 'blur(9px)'; x.fillStyle = '#2a2a2a';
    x.beginPath(); if (x.roundRect) x.roundRect(20, 26, S - 40, S - 52, 16); else x.rect(24, 30, S - 48, S - 60); x.fill();
    blobTex = new THREE.CanvasTexture(c); blobTex.colorSpace = THREE.SRGBColorSpace;
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(L * 1.16, W * 1.4), new THREE.MeshBasicMaterial({ map: blobTex, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, fog: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.014; m.renderOrder = 2;
  return m;
}

function buildWheel(R, width, rimColor, race) {
  const g = new THREE.Group();
  const pr = [];
  const sw = width / 2, sh = R * (race ? 0.36 : 0.28); // sidewall height
  for (const [z, r] of [[-sw, R - sh], [-sw, R - 0.035], [-sw + 0.03, R], [sw - 0.03, R], [sw, R - 0.035], [sw, R - sh]]) pr.push(new THREE.Vector2(r, z));
  const tyreG = new THREE.LatheGeometry(pr, 28); tyreG.rotateX(Math.PI / 2);
  const tyre = new THREE.Mesh(tyreG, new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.92 }));
  g.add(tyre);
  const rimR = R - sh;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, width * 0.96, 24, 1, true).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.6, metalness: 0.6, side: THREE.DoubleSide }));
  g.add(barrel);
  const rimMat = new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.3, metalness: 0.9 });
  const spokes = new THREE.Group();
  const nS = race ? 10 : 5;
  for (let k = 0; k < nS; k++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(rimR * 0.98, race ? 0.035 : 0.075, 0.03), rimMat);
    sp.position.set(Math.cos(k / nS * 6.2832) * rimR * 0.5, Math.sin(k / nS * 6.2832) * rimR * 0.5, 0);
    sp.rotation.z = k / nS * 6.2832; spokes.add(sp);
  }
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR - 0.012, 0.014, 6, 28), rimMat); spokes.add(lip);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.2, rimR * 0.2, 0.05, 12).rotateX(Math.PI / 2), rimMat); spokes.add(hub);
  g.add(spokes);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.82, rimR * 0.82, 0.03, 20).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x77706a, roughness: 0.45, metalness: 0.8 }));
  g.add(disc);
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(rimR * 0.5, rimR * 0.3, 0.07), new THREE.MeshStandardMaterial({ color: race ? 0xd0a000 : 0xb01818, roughness: 0.45, metalness: 0.3 }));
  g.userData = { spokes, disc, sw, caliper, rimR };
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function box(w, h, d, mat, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; return m; }

export function buildCarModel(spec, { ghost = false, colorOverride = null } = {}) {
  const glb = ghost ? null : glbConfig(spec);   // detailed model, swapped in when it has loaded
  const b = spec.body.style === 'glb' ? { ...spec.body, style: spec.body.fallback } : spec.body, R = spec.wheelRadius;
  const root = new THREE.Group();        // follows the sim pose
  const chassis = new THREE.Group();     // pitches / rolls on the suspension
  root.add(chassis);
  const color = colorOverride ?? b.color;
  const paintMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.38, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x05080b, roughness: 0.06, metalness: 0.85, clearcoat: 1 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.7 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.45, metalness: 0.4 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.6, roughness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1010, emissiveIntensity: 0.35, roughness: 0.3 });
  const a = spec.wheelbase * (1 - spec.frontWeight), bb = spec.wheelbase * spec.frontWeight;
  const mid = (a - bb) / 2; // wheelbase midpoint relative to CG
  const race = b.style === 'gt' || b.style === 'formula';
  const tyreW = b.style === 'formula' ? [0.30, 0.38] : b.style === 'gt' ? [0.30, 0.32] : [0.25, 0.27];
  const wheels = [];
  const wheelZ = [];
  let shadow = null;

  const kind = spec.id === 'hypercar' ? 'proto' : spec.id === 'mini' ? 'mini' : b.style;
  if (b.style !== 'formula') {
    const proto = kind === 'proto', mini = kind === 'mini';
    const shift = mid + (proto ? 0 : b.style === 'gt' ? -0.05 : mini ? 0.02 : 0.06);
    const hw = b.width / 2;
    const archR = (R) => R * (race ? 1.1 : 1.16) + 0.012;
    const loft = loftBody(kind, b.length, b.width, b.height, {
      arches: ghost ? [] : [{ x: a - shift, R, Ra: archR(R) }, { x: -bb - shift, R, Ra: archR(R) }],
      zInner: hw - Math.max(tyreW[0], tyreW[1]) - 0.1, glassFront: proto ? -0.1 : -1,
    });
    const linerMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.95 });
    const roofMat = mini ? new THREE.MeshPhysicalMaterial({ color: 0xf2f2ee, roughness: 0.35, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06 }) : paintMat;
    const body = new THREE.Mesh(loft.paint, [paintMat, roofMat, linerMat]), glass = new THREE.Mesh(loft.glass, glassMat);
    for (const m of [body, glass]) { m.position.x = shift; m.castShadow = true; m.receiveShadow = true; chassis.add(m); }
    const front = shift + b.length / 2, rear = shift - b.length / 2;
    const sectAt = (x) => loft.sect.reduce((best, s) => (Math.abs(s.x + shift - x) < Math.abs(best.x + shift - x) ? s : best));
    const fs = sectAt(front - 0.12), rs = sectAt(rear + 0.1);
    const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xdfe6ee, roughness: 0.08, metalness: 0.9, clearcoat: 1, emissive: 0xfff2d8, emissiveIntensity: 0.35 });
    const addPatch = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.position.x = shift; chassis.add(m); return m; };
    // light clusters follow the body surface
    if (proto) {
      addPatch(loft.patchGeo(0.40, 0.475, 4, 4), lensMat);                           // vertical LED blades in the fender fronts
      addPatch(loft.patchGeo(-0.5, -0.47, 3, 4), tailMat);
      const yel = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.4 });
      addPatch(loft.patchGeo(-0.02, 0.10, 8, 8, 0.003), yel);                          // yellow roof flash
      addPatch(loft.patchGeo(0.36, 0.5, 8, 8, 0.003), yel);                            // yellow nose stripe
    } else if (mini) {
      for (const sgn of [1, -1]) {
        // round headlamps with chrome bezels, upright tail lamps
        const s = sectAt(front - 0.13), lamp = new THREE.Group();
        const lens = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2.4).rotateZ(-Math.PI / 2), lensMat);
        const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.014, 8, 24).rotateY(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness: 1, roughness: 0.15 }));
        lamp.add(lens, bezel); lamp.position.set(front - 0.14, s.pts[5][1] - 0.05, sgn * (s.pts[5][0] * 0.74)); lamp.rotation.set(0, -sgn * 0.25, 0.55); chassis.add(lamp);
      }
      addPatch(loft.patchGeo(-0.5, -0.468, 4, 4), tailMat);
      addPatch(loft.patchGeo(0.487, 0.5, 2, 3, 0.006), black);                           // grille mouth
      // bonnet stripes
      const stripe = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4 });
      void stripe;
    } else {
      addPatch(loft.patchGeo(0.405, 0.482, 4, 5), lensMat);
      addPatch(loft.patchGeo(-0.5, -0.468, b.style === 'gt' ? 4 : 3, 4), tailMat);
      if (b.style === 'gt' || b.style === 'sedan') chassis.add(box(0.05, 0.05, b.width * 0.72, tailMat, rear + 0.06, rs.pts[5][1] - 0.02, 0));
    }
    // door and bonnet shut lines
    if (!ghost) {
      const lineMat = new THREE.LineBasicMaterial({ color: 0x030303 });
      const doors = proto ? [[0.17, 2, 6], [-0.07, 2, 6]] : b.style === 'sedan' || b.style === 'hatch' && !mini ? [[0.185, 1, 4], [-0.03, 1, 4], [-0.2, 1, 4]] : [[0.17, 1, 4], [-0.08, 1, 4]];
      for (const [xf, k0, k1] of [...doors, ...(proto ? [] : [[0.2, 5, 8]])]) for (const pos of loft.shutLine(xf, k0, k1)) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const l = new THREE.Line(g, lineMat); l.position.x = shift; chassis.add(l);
      }
    }
    for (const sgn of [1, -1]) {
      // mirrors
      const mx = shift + b.length * (proto ? 0.2 : 0.14), ms = sectAt(mx);
      const mm = box(0.12, 0.09, 0.18, mini ? roofMat : proto ? new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.4 }) : paintMat, mx, ms.pts[proto ? 6 : 5][1] + (proto ? 0.16 : 0.05), sgn * (ms.pts[proto ? 6 : 5][0] + 0.08)); chassis.add(mm);
    }
    // grille / intakes
    if (!mini) chassis.add(box(0.06, proto ? 0.08 : 0.2, b.width * 0.5, black, front - 0.03, fs.pts[0][1] + (proto ? 0.07 : 0.16), 0));
    chassis.add(box(0.06, 0.12, b.width * 0.7, black, rear + 0.02, rs.pts[0][1] + 0.08, 0));
    // exhausts
    if (!spec.engine.electric) for (const sgn of b.style === 'hatch' ? (mini ? [0.08, -0.08] : [0.25, 0, -0.25]) : [1, -1]) {
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 10).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 1, roughness: 0.25 }));
      tip.position.set(rear + 0.02, rs.pts[0][1] + 0.06, b.style === 'hatch' ? sgn * (mini ? 1 : 0.5) : sgn * b.width * 0.28); chassis.add(tip);
    }
    if (proto) {
      // splitter, diffuser, shark fin, full-width wing on swan-neck pylons and tall end plates
      const yel = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.4 });
      chassis.add(box(0.55, 0.02, b.width * 0.98, carbon, front - 0.2, 0.055, 0));
      chassis.add(box(0.8, 0.03, b.width * 0.92, carbon, rear + 0.32, 0.075, 0));
      for (let k = -3; k <= 3; k++) chassis.add(box(0.7, 0.14, 0.012, carbon, rear + 0.3, 0.13, k * b.width * 0.12));
      const cs = sectAt(shift - 0.1 * b.length), finTop = b.height * 0.97;
      const fin = new THREE.Shape(); fin.moveTo(shift - 0.06 * b.length, finTop); fin.lineTo(rear + 0.5, finTop - 0.03); fin.lineTo(rear + 0.22, rs.pts[9][1] + 0.05); fin.lineTo(shift - 0.06 * b.length, cs.pts[9][1] - 0.05);
      const finM = new THREE.Mesh(new THREE.ExtrudeGeometry(fin, { depth: 0.022, bevelEnabled: false }).translate(0, 0, -0.011), paintMat); finM.castShadow = true; chassis.add(finM);
      const wingY = b.height * 0.93;
      chassis.add(box(0.36, 0.028, b.width * 0.97, carbon, rear + 0.16, wingY, 0));
      chassis.add(box(0.12, 0.014, b.width * 0.97, paintMat, rear + 0.02, wingY + 0.045, 0));
      for (const sgn of [1, -1]) {
        chassis.add(box(0.62, 0.42, 0.02, paintMat, rear + 0.2, wingY - 0.15, sgn * b.width * 0.49));
        chassis.add(box(0.2, 0.1, 0.022, yel, rear + 0.2, wingY + 0.01, sgn * (b.width * 0.49 + 0.002)));
        chassis.add(box(0.05, 0.3, 0.03, carbon, rear + 0.3, wingY - 0.16, sgn * b.width * 0.2));
        const ds = sectAt(shift - 0.12 * b.length);
        const num = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.36), new THREE.MeshStandardMaterial({ map: labelTexture('51', { w: 128, h: 128, bg: '#f4f4f4', fg: '#111', font: 'bold 92px sans-serif' }), roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -3 }));
        num.position.set(shift - 0.12 * b.length, ds.pts[3][1], sgn * (ds.pts[3][0] + 0.004)); num.rotation.y = sgn > 0 ? 0 : Math.PI; chassis.add(num);
      }
    } else if (b.style === 'gt') {
      // splitter, wing, diffuser, roundels
      chassis.add(box(0.5, 0.025, b.width * 0.98, carbon, front - 0.12, 0.075, 0));
      chassis.add(box(0.7, 0.03, b.width * 0.9, carbon, rear + 0.3, 0.09, 0));
      const wingY = b.height + 0.02;
      chassis.add(box(0.34, 0.03, b.width * 0.96, carbon, rear + 0.2, wingY, 0));
      chassis.add(box(0.1, 0.012, b.width * 0.96, carbon, rear + 0.04, wingY + 0.05, 0));
      for (const sgn of [1, -1]) {
        chassis.add(box(0.4, 0.2, 0.02, carbon, rear + 0.2, wingY - 0.03, sgn * b.width * 0.48));
        chassis.add(box(0.05, 0.36, 0.03, carbon, rear + 0.3, wingY - 0.19, sgn * b.width * 0.24));
        const ds = sectAt(shift - 0.1);
        const num = new THREE.Mesh(new THREE.CircleGeometry(0.24, 20), new THREE.MeshStandardMaterial({ map: labelTexture('27', { w: 128, h: 128, bg: '#111', fg: '#fff', font: 'bold 84px sans-serif' }), roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -3 }));
        num.position.set(shift - 0.1, ds.pts[3][1], sgn * (ds.pts[3][0] + 0.004)); num.rotation.y = sgn > 0 ? 0 : Math.PI; chassis.add(num);
      }
      const stripeM = new THREE.MeshStandardMaterial({ color: 0xd4002a, roughness: 0.4 });
      addPatch(loft.patchGeo(-0.5, 0.5, 8, 8, 0.003), stripeM);                          // centre stripe over the whole car
    }
    if (b.style === 'hatch') chassis.add(box(mini ? 0.2 : 0.28, 0.03, b.width * 0.72, mini ? roofMat : paintMat, rear + (mini ? 0.12 : 0.36), b.height * 0.985, 0));
    if (b.style === 'coupe') chassis.add(box(0.12, 0.04, b.width * 0.7, paintMat, rear + 0.12, rs.pts[5][1] + 0.04, 0));
    if (!ghost) root.add(shadow = contactShadow(b.length, b.width));
    wheelZ.push(hw - tyreW[0] / 2 - 0.005, hw - tyreW[1] / 2 - 0.005);
  } else {
    buildFormula(chassis, spec, { paintMat, carbon, black, tailMat, a, bb });
    wheelZ.push(spec.trackF / 2, spec.trackR / 2);
    if (!ghost) root.add(shadow = contactShadow(spec.wheelbase + 1.2, 1.5));
  }

  const rimColor = b.style === 'formula' ? 0x202024 : b.style === 'gt' ? 0xc9a227 : b.style === 'coupe' ? 0x2a2a2c : 0xb8bcc4;
  for (let i = 0; i < 4; i++) {
    const front = i < 2, sgn = i % 2 === 0 ? -1 : 1; // sim wheel 0 = front-left = -Z
    const steer = new THREE.Group();
    const w = buildWheel(R, tyreW[front ? 0 : 1], rimColor, race);
    w.userData.spokes.position.z = sgn * (w.userData.sw - 0.04); w.userData.disc.position.z = sgn * (w.userData.sw - 0.11);
    steer.position.set(front ? a : -bb, R, sgn * wheelZ[front ? 0 : 1]);
    const cal = w.userData.caliper; cal.position.set(-w.userData.rimR * 0.62, w.userData.rimR * 0.2, sgn * (w.userData.sw - 0.14)); cal.rotation.z = -0.3; steer.add(cal);
    steer.add(w); root.add(steer);
    wheels.push({ steer, spin: w });
  }

  if (ghost) {
    root.traverse(o => {
      if (o.isMesh) { o.material = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.28, depthWrite: false }); o.castShadow = false; }
    });
  }
  const model = {
    root, chassis, wheels, tailMat, shadow,
    // steer angle (rad) for front wheels, spin increment (rad) for all
    setWheel(i, steer, dSpin) { const w = wheels[i]; if (i < 2) w.steer.rotation.y = steer; w.spin.rotation.z -= dSpin; },
    setBrake(on) { tailMat.emissiveIntensity = on ? 3.2 : 0.35; },
    dispose() { this.disposed = true; root.traverse(o => { if (o.isMesh && !o.userData.shared) { o.geometry.dispose(); } }); },
  };
  if (glb) attachGLB(model, spec, glb, { a, bb, color: colorOverride });
  return model;
}

// ---------------------------------------------------------------------------
// Detailed glTF car models (sources and licences: ASSETS.md).
//
// One small config per car id. Files made by tools/models-build.mjs are already
// in game space (+X forward, +Y up, metres, on the ground) with four nodes
// `wheel_fl|fr|rl|rr`, so most entries only say which materials are paint,
// glass, tyres and tail lights. Everything is optional except `url`:
//   rotY        turn the model about Y so its nose points along +X
//   wheels      names of the four wheel nodes (FL, FR, RL, RR); `null` = the model has no
//               separable wheels, it is shown as-is and its wheels stay static
//   paint, paint2, glass, tyre, rim, tail
//               lists of material names or mesh / parent-node names ('abc*' = prefix)
//               that are re-materialled: body colour, second colour (roof), dark glass,
//               rubber, bright metal, and the lenses that light up under braking
//   color       paint colour override (default: the car's `body.color`); color2 for paint2
//   paintProps  overrides for the paint material (metalness, roughness, ...)
//   lamps       extra brake lamps for models whose tail lights are only a texture:
//               [x, y, z, width, height] in the model's own metres, facing backwards
//   shadow      [length, width] of the soft contact shadow in metres (default: model bounds)
//   ao          { url, w, l } baked ground-shadow texture laid under the model (model axes)
const GLB_MODELS = {
  f458: {
    url: 'models/ferrari.glb', rotY: -Math.PI / 2, wheels: ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'],
    paint: ['body'], glass: ['glass'], rim: ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl', 'trim'], tyre: ['tire*'], tail: ['lights_red'],
    paintProps: { metalness: 0.9, roughness: 0.45, clearcoatRoughness: 0.03 }, ao: { url: 'models/ferrari_ao.png', w: 0.655 * 4, l: 1.3 * 4 },
  },
  // Porsche 911 Carrera 4S (991) by Karol Miklas, CC BY-SA 4.0 — stands in for the GT3 car
  gt3: { url: 'models/gt3.glb', paint: ['paint'], glass: ['window'], tyre: ['rubber'], color: 0xe9ecef, lamps: [[-2.15, 0.742, -0.56, 0.3, 0.03], [-2.15, 0.742, 0.56, 0.3, 0.03]] },
  // Honda Civic Type R (FK8) by shindedhirendra780, CC BY 4.0
  hatch: { url: 'models/hatch.glb', paint: ['Material.001'], glass: ['Material.002'], tyre: ['tyre_belt', 'tyre_side'], tail: ['Material.003'] },
  // 1967 Mustang fastback restomod by Nick Broad, CC BY 4.0
  coupe: { url: 'models/coupe.glb', paint: ['Paint'], glass: ['Glass'], tyre: ['Tread', 'SideWall'], tail: ['TailLightInside', 'TailLightInsideDark', 'Material.002'] },
  // "RaceCar RC-09" V10-era grand-prix car by Dahie, CC BY 4.0 (own livery, not repainted)
  formula: { url: 'models/formula.glb', lamps: [[-2.0, 0.375, 0, 0.11, 0.11]], shadow: [4.9, 1.75] },
  // Audi R18 e-tron quattro (LMP1) by Godheim, CC BY 4.0 (own livery, not repainted)
  hypercar: { url: 'models/hypercar.glb', lamps: [[-2.185, 0.5, -0.86, 0.05, 0.3], [-2.185, 0.5, 0.86, 0.05, 0.3]] },
  // "Generic Electric sedan" by Antonis_zks, CC BY 4.0
  ev: { url: 'models/ev.glb', paint: ['Material.018'], glass: ['Material.020'], tyre: ['Material.002'], tail: ['Material.067'] },
};
const WHEEL_NODES = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
function glbConfig(spec) {
  const c = GLB_MODELS[spec.id];
  if (c) return c;
  return spec.body.style === 'glb' && spec.body.model ? { url: spec.body.model } : null;   // unknown car: show the file as-is
}

// Swap the procedural stand-in for a detailed glTF model once it has loaded. If the
// file cannot be fetched or parsed the stand-in simply stays.
function attachGLB(model, spec, cfg, { a, bb, color }) {
  loadGLB(cfg.url).then((gltf) => {
    if (model.disposed) return;
    const car = gltf.scene.clone(true);
    const roles = ['paint', 'paint2', 'glass', 'tyre', 'rim', 'tail'].filter(r => cfg[r]);
    const hit = (list, name) => !!name && list.some(n => (n.endsWith('*') ? name.startsWith(n.slice(0, -1)) : n === name));
    const roleOf = (o) => {
      for (const r of roles) for (let p = o, d = 0; p && d < 3; p = p.parent, d++) if (hit(cfg[r], p.name) || (d === 0 && hit(cfg[r], o.material?.name))) return r;
      return null;
    };
    const paint = (c) => new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.35, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.05, ...cfg.paintProps });
    const tail = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff1408, emissiveIntensity: 0.25, roughness: 0.3 });
    const mats = {
      paint: paint(color ?? cfg.color ?? spec.body.color), paint2: paint(cfg.color2 ?? 0xf2f2ee),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1014, metalness: 0.6, roughness: 0.02, transparent: true, opacity: 0.72 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.9, metalness: 0 }),
      rim: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.4 }), tail,
    };
    car.traverse(o => {
      if (!o.isMesh) return;
      const r = roleOf(o); if (r) { mats[r].side = o.material.side; o.material = mats[r]; }
      o.castShadow = true; o.receiveShadow = true; o.userData.shared = true;   // geometry is shared with the cache
    });
    // nose along +X, then measure in the car's root frame
    const holder = new THREE.Group(); holder.rotation.y = cfg.rotY || 0; holder.add(car);
    if (cfg.ao) new THREE.TextureLoader().load(globalThis.__INLINE_ASSETS?.[cfg.ao.url] || cfg.ao.url, (tex) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(cfg.ao.w, cfg.ao.l), new THREE.MeshBasicMaterial({ map: tex, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.renderOrder = 2; car.add(m);
    });
    holder.updateMatrixWorld(true);
    const names = cfg.wheels === null ? null : (cfg.wheels || WHEEL_NODES);
    let gw = names && names.map(n => car.getObjectByName(n));
    if (gw && gw.some(w => !w)) gw = null;        // no separable wheels: the model is shown whole, wheels static
    const box = new THREE.Box3().setFromObject(holder), mid = (a - bb) / 2;
    let k, x0;
    if (gw) {
      const wp = gw.map(w => new THREE.Vector3().setFromMatrixPosition(w.matrixWorld));
      const xf = (wp[0].x + wp[1].x) / 2, xr = (wp[2].x + wp[3].x) / 2;
      k = spec.wheelbase / Math.abs(xf - xr); x0 = (xf + xr) / 2;   // axles land on the sim's axles
    } else { k = spec.body.length / (box.max.x - box.min.x); x0 = (box.max.x + box.min.x) / 2; }
    holder.scale.setScalar(k); holder.position.set(mid - x0 * k, -Math.min(0, box.min.y) * k, 0);
    holder.updateMatrixWorld(true);
    // extra brake lamps
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xff2a14, toneMapped: false, side: THREE.DoubleSide });
    const lamps = (cfg.lamps || []).map(([x, y, z, w, h]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), lampMat); m.rotation.y = -Math.PI / 2; m.position.set(x, y, z); m.visible = false; car.add(m); return m;
    });
    model.setBrake = (on) => { tail.emissiveIntensity = on ? 3.5 : 0.25; for (const l of lamps) l.visible = on; };
    // replace the procedural parts
    for (const w of model.wheels) w.steer.visible = false;
    while (model.chassis.children.length) model.chassis.remove(model.chassis.children[0]);
    model.chassis.add(holder);
    if (gw) {
      // each wheel moves out of the body into a steer > spin pair on the root, so it stays on the
      // road while the body pitches and rolls, and spins about the car's lateral axis whatever
      // the file's own axes are
      const inv = new THREE.Matrix4(), m = new THREE.Matrix4();
      const rig = gw.map((w) => {
        const steer = new THREE.Group(), spin = new THREE.Group();
        steer.position.setFromMatrixPosition(w.matrixWorld); steer.add(spin); steer.updateMatrixWorld(true);
        m.multiplyMatrices(inv.copy(steer.matrixWorld).invert(), w.matrixWorld).decompose(w.position, w.quaternion, w.scale);
        spin.add(w); model.root.add(steer);
        return { steer, spin };
      });
      model.setWheel = (i, steer, dSpin) => { const w = rig[i]; if (i < 2) w.steer.rotation.y = steer; w.spin.rotation.z -= dSpin; };
    } else model.setWheel = () => {};
    if (model.shadow) {
      const L = cfg.shadow ? cfg.shadow[0] : (box.max.x - box.min.x) * k, W = cfg.shadow ? cfg.shadow[1] : (box.max.z - box.min.z) * k, g = model.shadow.geometry.parameters;
      model.shadow.scale.set(L * 1.16 / g.width, W * 1.4 / g.height, 1); model.shadow.position.x = mid - x0 * k + (box.max.x + box.min.x) / 2 * k;
    }
    model.glb = { holder, scale: k };
  }).catch((e) => { console.warn('car model not loaded, keeping the procedural body:', cfg.url, e?.message || e); });
}

function buildFormula(chassis, spec, { paintMat, carbon, black, tailMat, a, bb }) {
  const R = spec.wheelRadius;
  // monocoque + nose as a loft of rounded-rect sections
  const st = [[-bb - 0.35, 0.16, 0.12, 0.42], [-bb + 0.1, 0.30, 0.10, 0.50], [-bb + 0.9, 0.36, 0.08, 0.62], [-bb + 1.3, 0.30, 0.08, 0.94], [-bb + 1.7, 0.27, 0.08, 0.62],
    [-bb + 2.2, 0.26, 0.09, 0.56], [a - 0.3, 0.19, 0.14, 0.46], [a + 0.5, 0.11, 0.20, 0.36], [a + 0.98, 0.06, 0.22, 0.30]];
  const pos = [], idx = [], P = 8;
  const N = 40;
  for (let s = 0; s < N; s++) {
    const x = st[0][0] + (st[st.length - 1][0] - st[0][0]) * s / (N - 1);
    let k = 0; while (k < st.length - 2 && st[k + 1][0] < x) k++;
    const t0 = (x - st[k][0]) / (st[k + 1][0] - st[k][0]), t = t0 * t0 * (3 - 2 * t0);
    const w = st[k][1] + (st[k + 1][1] - st[k][1]) * t, y0 = st[k][2] + (st[k + 1][2] - st[k][2]) * t, y1 = st[k][3] + (st[k + 1][3] - st[k][3]) * t;
    for (let p = 0; p < P * 2; p++) {
      const ang = p / (P * 2) * Math.PI * 2;
      const cz = Math.sin(ang), cy = -Math.cos(ang);
      const sup = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.55);
      pos.push(x, (y0 + y1) / 2 + sup(cy) * (y1 - y0) / 2 * (1 - 0.35 * Math.abs(sup(cz)) * (cy > 0 ? 1 : 0)), sup(cz) * w);
    }
  }
  for (let s = 0; s < N - 1; s++) for (let p = 0; p < P * 2; p++) {
    const q = (p + 1) % (P * 2), A = s * P * 2 + p, B = s * P * 2 + q, C = A + P * 2, D = B + P * 2;
    idx.push(A, B, C, B, D, C);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  const tub = new THREE.Mesh(geo, paintMat); tub.castShadow = true; chassis.add(tub);
  // sidepods
  for (const sgn of [1, -1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.34, 0.42), paintMat); pod.position.set(-bb + 1.15, 0.29, sgn * 0.56); pod.castShadow = true;
    pod.geometry.translate(0, 0, 0); chassis.add(pod);
    chassis.add(box(0.05, 0.3, 0.38, black, -bb + 1.89, 0.3, sgn * 0.56));
    chassis.add(box(0.7, 0.2, 0.02, carbon, -bb + 2.15, 0.26, sgn * 0.78)); // bargeboard
  }
  chassis.add(box(spec.wheelbase + 0.6, 0.02, 1.36, carbon, (a - bb) / 2 - 0.2, 0.05, 0)); // floor
  // airbox + cockpit + helmet
  chassis.add(box(0.5, 0.06, 0.4, black, -bb + 1.85, 0.6, 0));
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf2d400, roughness: 0.3 })); helmet.position.set(-bb + 1.72, 0.72, 0); helmet.castShadow = true; chassis.add(helmet);
  // front wing
  chassis.add(box(0.36, 0.022, 1.42, carbon, a + 0.92, 0.1, 0));
  chassis.add(box(0.16, 0.016, 1.38, paintMat, a + 0.8, 0.17, 0));
  for (const sgn of [1, -1]) chassis.add(box(0.46, 0.2, 0.016, paintMat, a + 0.88, 0.16, sgn * 0.7));
  // rear wing
  chassis.add(box(0.3, 0.02, 0.96, carbon, -bb - 0.42, 0.9, 0));
  chassis.add(box(0.2, 0.018, 0.96, paintMat, -bb - 0.52, 0.98, 0));
  chassis.add(box(0.24, 0.02, 0.96, carbon, -bb - 0.4, 0.42, 0));
  for (const sgn of [1, -1]) chassis.add(box(0.5, 0.72, 0.016, paintMat, -bb - 0.44, 0.68, sgn * 0.485));
  chassis.add(box(0.03, 0.1, 0.1, tailMat, -bb - 0.62, 0.3, 0)); // rain light
  // suspension arms
  const armMat = carbon;
  for (const [ax, tr] of [[a, spec.trackF / 2], [-bb, spec.trackR / 2]]) for (const sgn of [1, -1]) for (const [dx, y] of [[0.22, R + 0.1], [-0.22, R + 0.1], [0.2, R - 0.12], [-0.2, R - 0.12]]) {
    const len = tr - 0.2, arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, Math.hypot(len, dx)), armMat);
    arm.position.set(ax + dx / 2, y, sgn * (0.2 + len / 2)); arm.rotation.y = Math.atan2(dx, len) * sgn; chassis.add(arm);
  }
}
