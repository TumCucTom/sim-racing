// Turns a downloaded car glTF/GLB into the small, canonical file the game loads
// (see GLB_MODELS in src/game/carmodel.js and ASSETS.md for sources and licences).
//
//   GLTF_TOOLS=/path/with/node_modules node tools/models-build.mjs <in.glb> <out.glb> <config.json | inline JSON>
//
// GLTF_TOOLS is a scratch directory with `npm i @gltf-transform/cli` in it (the
// project itself does not depend on these packages).
//
// What it does:
//  * bakes every node transform into the vertices and re-expresses the car in
//    game space: +X forward, +Y up, +Z right, metres, origin on the ground at
//    the middle of the wheelbase;
//  * finds the four wheels (from the tyre material / node names), cuts every
//    triangle that lies inside a wheel's cylinder out of the body and puts it in
//    one of four nodes `wheel_fl|fr|rl|rr` whose origin is the wheel centre, so
//    the game can steer and spin them whatever the source hierarchy looked like;
//  * merges everything else into one `body` mesh with one primitive per material;
//  * drops unwanted parts, welds, simplifies to a triangle budget, shrinks and
//    re-encodes textures and Draco-compresses the result.
//
// Config keys (all optional except fwd):
//   fwd: '+z' | '-z' | '+x' | '-x'   model's forward axis (after its node transforms), up: '+y' | '+z'
//   wheelbase: metres                 scale the model so its wheelbase is this
//   tyre: { mat: 'regex', node: 'regex' }   what identifies tyre triangles
//   wheelMats: 'regex'                only these materials may be cut into wheels (default: any)
//   wheelExclude: 'regex'             materials/nodes that stay on the body (calipers)
//   dropMats / dropNodes: 'regex'     removed entirely
//   bodyTris / wheelTris: budgets     (wheelTris is for all four wheels together)
//   protect: 'regex'                  materials simplified only very gently (protectError, default 0.0015)
//   texSize: 1024, texFormat: 'webp' | 'jpeg', texQuality: 80
//   alpha: { 'material': 'OPAQUE' }   override a material's alpha mode (blended bodywork sorts badly)
//   rename: { 'old material name': 'new name' }, tint: { 'material': [r,g,b] } (multiplies base colour)
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire((process.env.GLTF_TOOLS || process.cwd()) + '/node_modules/');
const { NodeIO, Primitive } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { dedup, prune, weld, simplifyPrimitive, textureCompress, draco, unpartition } = require('@gltf-transform/functions');
const { MeshoptSimplifier } = require('meshoptimizer');
const draco3d = require('draco3dgltf');
const sharp = require('sharp');

const [, , inFile, outFile, cfgArg] = process.argv;
const cfg = cfgArg.trim().startsWith('{') ? JSON.parse(cfgArg) : JSON.parse(fs.readFileSync(cfgArg, 'utf8'));
const rx = (s) => (s ? new RegExp(s, 'i') : null);
const R = { tyreMat: rx(cfg.tyre?.mat), tyreNode: rx(cfg.tyre?.node), wheelMats: rx(cfg.wheelMats), wheelExclude: rx(cfg.wheelExclude), dropMats: rx(cfg.dropMats), dropNodes: rx(cfg.dropNodes) };

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule() });
const doc = await io.read(inFile);
const root = doc.getRoot(), scene = root.getDefaultScene() || root.listScenes()[0];
await doc.transform(dedup());

// model axes -> game axes (a proper rotation), then a uniform scale chosen below
const up = cfg.up || '+y';
const toGame = (() => {
  const f = cfg.fwd, m = (x, y, z) => [x, y, z];
  if (up === '+y') {
    if (f === '+z') return (p) => m(p[2], p[1], -p[0]);
    if (f === '-z') return (p) => m(-p[2], p[1], p[0]);
    if (f === '+x') return (p) => m(p[0], p[1], p[2]);
    if (f === '-x') return (p) => m(-p[0], p[1], -p[2]);
  } else {                                       // Z up
    if (f === '+x') return (p) => m(p[0], p[2], -p[1]);
    if (f === '-x') return (p) => m(-p[0], p[2], p[1]);
    if (f === '+y') return (p) => m(p[1], p[2], p[0]);
    if (f === '-y') return (p) => m(-p[1], p[2], -p[0]);
  }
  throw new Error('bad fwd/up');
})();

// 1. gather triangles soup per (node, material), in game axes
const parts = [];                                 // { mat, name, node, pos[], nrm[], uv[] | null }
const nodePath = (n) => { const out = []; for (let p = n; p && p.getName; p = p.getParentNode?.()) out.push(p.getName()); return out.join('/'); };
let dropped = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const path = nodePath(node);
  const M = node.getWorldMatrix();
  const det = M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
    const mat = prim.getMaterial(), mname = mat ? mat.getName() : '';
    const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), U = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices();
    const count = I ? I.getCount() : P.getCount();
    if ((R.dropMats && R.dropMats.test(mname)) || (R.dropNodes && R.dropNodes.test(path))) { dropped += count / 3; continue; }
    const part = { mat, mname, path, pos: [], nrm: N ? [] : null, uv: U ? [] : null };
    const p = [0, 0, 0], n = [0, 0, 0], u = [0, 0];
    const idx = (k) => (I ? I.getScalar(k) : k);
    for (let t = 0; t < count; t += 3) {
      const tri = det < 0 ? [idx(t), idx(t + 2), idx(t + 1)] : [idx(t), idx(t + 1), idx(t + 2)];
      for (const i of tri) {
        P.getElement(i, p);
        const w = toGame([M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]]);
        part.pos.push(w[0], w[1], w[2]);
        if (N) {
          N.getElement(i, n);
          const q = toGame([M[0] * n[0] + M[4] * n[1] + M[8] * n[2], M[1] * n[0] + M[5] * n[1] + M[9] * n[2], M[2] * n[0] + M[6] * n[1] + M[10] * n[2]]);
          const l = Math.hypot(q[0], q[1], q[2]) || 1; part.nrm.push(q[0] / l, q[1] / l, q[2] / l);
        }
        if (U) { U.getElement(i, u); part.uv.push(u[0], u[1]); }
      }
    }
    parts.push(part);
  }
}

// 2. wheels: bounds of the tyre triangles in each corner
const isTyre = (p) => (R.tyreMat && R.tyreMat.test(p.mname)) || (R.tyreNode && R.tyreNode.test(p.path));
let wheels = null;
const tyreParts = parts.filter(isTyre);
if (tyreParts.length) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of tyreParts) for (let i = 0; i < p.pos.length; i += 3) { x0 = Math.min(x0, p.pos[i]); x1 = Math.max(x1, p.pos[i]); z0 = Math.min(z0, p.pos[i + 2]); z1 = Math.max(z1, p.pos[i + 2]); }
  const xm = (x0 + x1) / 2, zm = (z0 + z1) / 2;
  const box = [0, 1, 2, 3].map(() => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  for (const p of tyreParts) for (let i = 0; i < p.pos.length; i += 3) {
    const c = (p.pos[i] > xm ? 0 : 2) + (p.pos[i + 2] > zm ? 1 : 0);     // FL, FR, RL, RR (left = -Z)
    for (let k = 0; k < 3; k++) { box[c].min[k] = Math.min(box[c].min[k], p.pos[i + k]); box[c].max[k] = Math.max(box[c].max[k], p.pos[i + k]); }
  }
  // a wheel that was left steered in the source file is straightened: the axle direction is the
  // direction of least spread of the tyre's vertices in plan view
  wheels = box.map((b0, ci) => {
    const c0 = [(b0.min[0] + b0.max[0]) / 2, (b0.min[2] + b0.max[2]) / 2];
    let sxx = 0, szz = 0, sxz = 0, n = 0; const pts = [];
    for (const p of tyreParts) for (let i = 0; i < p.pos.length; i += 3) {
      const c = (p.pos[i] > xm ? 0 : 2) + (p.pos[i + 2] > zm ? 1 : 0); if (c !== ci) continue;
      const x = p.pos[i] - c0[0], z = p.pos[i + 2] - c0[1]; sxx += x * x; szz += z * z; sxz += x * z; n++; pts.push(x, p.pos[i + 1], z);
    }
    // principal (largest-variance) axis in the XZ plane is the rolling direction
    let yaw = 0.5 * Math.atan2(2 * sxz, sxx - szz);            // angle of rolling direction from +X
    if (Math.abs(yaw) < 0.012 || Math.abs(yaw) > 0.8) yaw = 0;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < pts.length; i += 3) { const q = [pts[i] * cs + pts[i + 2] * sn, pts[i + 1], -pts[i] * sn + pts[i + 2] * cs]; for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], q[k]); b.max[k] = Math.max(b.max[k], q[k]); } }
    // c: wheel centre in the straightened local frame (relative to c0 in x/z); pivot = c0
    return { c0, yaw, cs, sn, c: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2], r: ((b.max[0] - b.min[0]) + (b.max[1] - b.min[1])) / 4, z0: b.min[2], z1: b.max[2], y0: b.min[1] };
  });
  // back to model axes: world centre of each wheel, lateral extent stays in the wheel's own frame
  for (const w of wheels) { w.w = [w.c0[0] + w.c[0] * w.cs - w.c[2] * w.sn, w.c[1], w.c0[1] + w.c[0] * w.sn + w.c[2] * w.cs]; }
}
// 3. placement: origin at wheelbase midpoint on the ground, optional scale to a target wheelbase
let ox = 0, oy = 0, oz = 0, k = cfg.scale || 1;
if (wheels) {
  const xf = (wheels[0].w[0] + wheels[1].w[0]) / 2, xr = (wheels[2].w[0] + wheels[3].w[0]) / 2;
  ox = (xf + xr) / 2; oz = (wheels[0].w[2] + wheels[1].w[2] + wheels[2].w[2] + wheels[3].w[2]) / 4; oy = Math.min(...wheels.map(w => w.y0));
  if (cfg.wheelbase) k = cfg.wheelbase / (xf - xr);
} else {
  let b0 = [Infinity, Infinity, Infinity], b1 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let i = 0; i < p.pos.length; i++) { b0[i % 3] = Math.min(b0[i % 3], p.pos[i]); b1[i % 3] = Math.max(b1[i % 3], p.pos[i]); }
  ox = (b0[0] + b1[0]) / 2; oy = b0[1]; oz = (b0[2] + b1[2]) / 2; if (cfg.length) k = cfg.length / (b1[0] - b0[0]);
}
for (const p of parts) for (let i = 0; i < p.pos.length; i += 3) { p.pos[i] = (p.pos[i] - ox) * k; p.pos[i + 1] = (p.pos[i + 1] - oy) * k; p.pos[i + 2] = (p.pos[i + 2] - oz) * k; }
if (wheels) for (const w of wheels) {
  w.w = [(w.w[0] - ox) * k, (w.w[1] - oy) * k, (w.w[2] - oz) * k]; w.r *= k; w.hz = (w.z1 - w.z0) / 2 * k;   // half width
}
// where each wheel is put back: left/right symmetric (a steered source wheel sits slightly off its axle line)
if (wheels) for (const [l, r] of [[0, 1], [2, 3]]) {
  const x = (wheels[l].w[0] + wheels[r].w[0]) / 2, y = (wheels[l].w[1] + wheels[r].w[1]) / 2, z = (wheels[r].w[2] - wheels[l].w[2]) / 2;
  wheels[l].at = [x, y, -z]; wheels[r].at = [x, y, z];
}

// 4. split triangles into body + 4 wheels, bucketed by material
const NAMES = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
const buckets = new Map();                         // group|material -> { group, mat, pos, nrm, uv }
const bucket = (group, part) => {
  const key = group + '|' + (part.mat ? root.listMaterials().indexOf(part.mat) : -1);
  let b = buckets.get(key);
  if (!b) { b = { group, mat: part.mat, pos: [], nrm: [], uv: [], hasUv: true, hasN: true }; buckets.set(key, b); }
  return b;
};
for (const p of parts) {
  const mayWheel = wheels && (!R.wheelMats || R.wheelMats.test(p.mname) || isTyre(p)) && !(R.wheelExclude && (R.wheelExclude.test(p.mname) || R.wheelExclude.test(p.path)));
  for (let t = 0; t < p.pos.length; t += 9) {
    let g = -1;
    if (mayWheel) for (let w = 0; w < 4 && g < 0; w++) {
      const W = wheels[w], rr = (W.r * 1.025) ** 2, pad = 0.03;
      let inside = true;
      for (let v = 0; v < 3 && inside; v++) {
        const dx = p.pos[t + v * 3] - W.w[0], y = p.pos[t + v * 3 + 1] - W.w[1], dz = p.pos[t + v * 3 + 2] - W.w[2];
        const x = dx * W.cs + dz * W.sn, z = -dx * W.sn + dz * W.cs;
        if (x * x + y * y > rr || Math.abs(z) > W.hz + pad) inside = false;
      }
      if (inside) g = w;
    }
    const b = bucket(g < 0 ? 'body' : NAMES[g], p);
    const W = g < 0 ? null : wheels[g];
    for (let v = 0; v < 3; v++) {
      let x = p.pos[t + v * 3], y = p.pos[t + v * 3 + 1], z = p.pos[t + v * 3 + 2], nx = p.nrm ? p.nrm[t + v * 3] : 0, ny = p.nrm ? p.nrm[t + v * 3 + 1] : 1, nz = p.nrm ? p.nrm[t + v * 3 + 2] : 0;
      if (W) {                                    // into the wheel's own straightened frame
        const dx = x - W.w[0], dz = z - W.w[2]; x = dx * W.cs + dz * W.sn; z = -dx * W.sn + dz * W.cs; y -= W.w[1];
        const mx = nx * W.cs + nz * W.sn; nz = -nx * W.sn + nz * W.cs; nx = mx;
      }
      b.pos.push(x, y, z); b.nrm.push(nx, ny, nz); if (!p.nrm) b.hasN = false;
      if (p.uv) b.uv.push(p.uv[t / 9 * 6 + v * 2], p.uv[t / 9 * 6 + v * 2 + 1]); else { b.hasUv = false; b.uv.push(0, 0); }
    }
  }
}

// 5. rebuild the scene: body + four wheel nodes
for (const s of root.listScenes()) for (const c of s.listChildren()) s.removeChild(c);
for (const a of root.listAnimations()) a.dispose();
for (const s of root.listSkins()) s.dispose();
for (const n of root.listNodes()) n.dispose();
for (const m of root.listMeshes()) m.dispose();
const buffer = root.listBuffers()[0] || doc.createBuffer();
const usesTex = (m) => m && (m.getBaseColorTexture() || m.getNormalTexture() || m.getMetallicRoughnessTexture() || m.getEmissiveTexture() || m.getOcclusionTexture());
const groups = new Map();
for (const b of buckets.values()) {
  if (!b.pos.length) continue;
  let g = groups.get(b.group);
  if (!g) { const mesh = doc.createMesh(b.group); const node = doc.createNode(b.group).setMesh(mesh); scene.addChild(node); g = { mesh, node, prims: [] }; groups.set(b.group, g); const wi = NAMES.indexOf(b.group); if (wi >= 0) node.setTranslation(wheels[wi].at); }
  const prim = doc.createPrimitive().setMaterial(b.mat)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.pos)).setBuffer(buffer));
  if (b.hasN) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.nrm)).setBuffer(buffer));
  if (b.hasUv && usesTex(b.mat)) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(b.uv)).setBuffer(buffer));
  g.mesh.addPrimitive(prim); g.prims.push(prim);
}
for (const m of root.listMaterials()) {
  const n = m.getName();
  if (cfg.tint?.[n]) { const c = m.getBaseColorFactor(), t = cfg.tint[n]; m.setBaseColorFactor([c[0] * t[0], c[1] * t[1], c[2] * t[2], c[3]]); }
  if (cfg.alpha?.[n]) m.setAlphaMode(cfg.alpha[n]);          // 'OPAQUE' | 'MASK' | 'BLEND'
  if (cfg.rename?.[n]) m.setName(cfg.rename[n]);
}
await doc.transform(prune(), weld());

// 6. simplify to budget
await MeshoptSimplifier.ready;
const triCount = (prim) => (prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount()) / 3;
const protect = rx(cfg.protect);
const simplifyGroup = (prims, budget) => {
  const total = prims.reduce((s, p) => s + triCount(p), 0);
  if (!budget || total <= budget) return;
  const ratio = budget / total;
  for (const p of prims) {
    if (triCount(p) <= 60) continue;
    // "protected" materials (paintwork) only lose detail that is invisible, and keep their panel edges
    const keep = protect && protect.test(p.getMaterial()?.getName() || '');
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error: keep ? (cfg.protectError ?? 0.0015) : (cfg.simplifyError ?? 0.02), lockBorder: keep });
  }
};
const wheelPrims = NAMES.flatMap(n => groups.get(n)?.prims || []);
simplifyGroup(groups.get('body')?.prims || [], cfg.bodyTris ?? 90000);
simplifyGroup(wheelPrims, cfg.wheelTris ?? 24000);
// simplification leaves slightly noisy normals, which shows as dents in glossy paint:
// rebuild smooth (area-weighted) normals for the protected materials
if (protect) for (const g of groups.values()) for (const p of g.prims) {
  if (!protect.test(p.getMaterial()?.getName() || '') || !p.getIndices() || !p.getAttribute('NORMAL')) continue;
  const P = p.getAttribute('POSITION').getArray(), I = p.getIndices().getArray(), N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) { N[v] += f[0]; N[v + 1] += f[1]; N[v + 2] += f[2]; }
  }
  const O = p.getAttribute('NORMAL').getArray();
  for (let v = 0; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]);
    if (l > 0) { N[v] /= l; N[v + 1] /= l; N[v + 2] /= l; } else { N[v] = O[v]; N[v + 1] = O[v + 1]; N[v + 2] = O[v + 2]; }
    if (N[v] * O[v] + N[v + 1] * O[v + 1] + N[v + 2] * O[v + 2] < 0) { N[v] *= -1; N[v + 1] *= -1; N[v + 2] *= -1; }   // keep the source's facing
  }
  p.getAttribute('NORMAL').setArray(N);
}
for (const g of groups.values()) for (const p of g.prims) if (triCount(p) < 1) { g.mesh.removePrimitive(p); p.dispose(); }
await doc.transform(prune());

// 7. textures + compression
if (root.listTextures().length) await doc.transform(textureCompress({ encoder: sharp, targetFormat: cfg.texFormat || 'webp', resize: [cfg.texSize || 1024, cfg.texSize || 1024], quality: cfg.texQuality ?? 80 }));
await doc.transform(unpartition(), draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
const extras = root.getAsset().extras || {};
root.getAsset().extras = { ...extras, ...(cfg.credit || {}), processed: 'tools/models-build.mjs (re-oriented, wheels separated, simplified, textures resized, Draco)' };
await io.write(outFile, doc);

// report
const sum = {}; let all = 0;
for (const [name, g] of groups) { sum[name] = g.prims.filter(p => !p.isDisposed()).reduce((s, p) => s + triCount(p), 0); all += sum[name]; }
const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const p of parts) for (let i = 0; i < p.pos.length; i++) { bb.min[i % 3] = Math.min(bb.min[i % 3], p.pos[i]); bb.max[i % 3] = Math.max(bb.max[i % 3], p.pos[i]); }
console.log(JSON.stringify({
  out: outFile, bytes: fs.statSync(outFile).size, triangles: all, groups: sum, droppedTris: dropped, scale: +k.toFixed(4),
  length: +(bb.max[0] - bb.min[0]).toFixed(3), width: +(bb.max[2] - bb.min[2]).toFixed(3), height: +bb.max[1].toFixed(3), frontOverhangX: +bb.max[0].toFixed(3),
  wheels: wheels && wheels.map(w => ({ x: +w.w[0].toFixed(3), y: +w.w[1].toFixed(3), z: +w.w[2].toFixed(3), r: +w.r.toFixed(3), w: +(w.hz * 2).toFixed(3), yawDeg: +(w.yaw * 57.3).toFixed(1) })),
  materials: root.listMaterials().map(m => m.getName()),
}, null, 1));
