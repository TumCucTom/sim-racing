// Procedural car models. Bodies are lofted from a handful of key cross-section
// stations per body style, so each car has a recognisable silhouette without
// any external assets. Model space: +X forward, +Y up, +Z right; origin at
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

function sampleStations(keys, n) {
  const out = [];
  for (let s = 0; s < n; s++) {
    // denser sampling at the ends where the shape changes quickly
    const u = s / (n - 1), x = -0.5 + (0.5 - 0.5 * Math.cos(u * Math.PI)) * 0.35 + u * 0.65;
    let k = 0; while (k < keys.length - 2 && keys[k + 1][0] < x) k++;
    const a = keys[k], b = keys[k + 1], t = Math.max(0, Math.min(1, (x - a[0]) / (b[0] - a[0])));
    out.push(a.map((v, i) => (i === 0 ? x : v + (b[i] - v) * t)));
  }
  for (let pass = 0; pass < 2; pass++) for (let c = 1; c < 6; c++) {
    const col = out.map(r => r[c]);
    for (let s = 1; s < n - 1; s++) out[s][c] = (col[s - 1] + 2 * col[s] + col[s + 1]) / 4;
  }
  return out;
}

function loftBody(style, L, W, H) {
  const st = sampleStations(STYLES[style], 56);
  const refH = style === 'gt' ? 1.25 : style === 'hatch' ? 1.41 : 1.38;
  const ys = H / refH, hw = W / 2 - 0.035;
  const P = 10; // half-section points
  const sect = st.map(([xf, wf, yb, belt, roof, rwf]) => {
    const w = wf * hw, b = belt * ys, r = Math.max(roof * ys, b + 0.015), f = yb * ys, rw = rwf * hw * (r - b > 0.12 ? 1 : 1.25);
    const cabin = r - b;
    return {
      x: xf * L, cabin, roof: r,
      pts: [[0, f], [0.74 * w, f], [0.965 * w, f + 0.13 * (b - f)], [w, f + 0.5 * (b - f)], [0.975 * w, b - 0.1 * (b - f)], [0.91 * w, b],
        [Math.min(0.86 * w, rw + 0.16 * Math.min(1, cabin * 3) + 0.02), b + 0.02 + Math.min(0.03, cabin * 0.2)], [rw + 0.03, r - 0.09 * cabin], [rw * 0.82, r], [0, r + 0.02 * Math.min(1, cabin * 4)]],
    };
  });
  const paint = { pos: [], idx: [], map: new Map() }, glass = { pos: [], idx: [], map: new Map() };
  const vert = (grp, s, p, side) => {
    const key = s * 100 + p * 2 + (side > 0 ? 1 : 0);
    let i = grp.map.get(key);
    if (i === undefined) { i = grp.pos.length / 3; const [z, y] = sect[s].pts[p]; grp.pos.push(sect[s].x, y, z * side); grp.map.set(key, i); }
    return i;
  };
  for (let s = 0; s < sect.length - 1; s++) {
    const A = sect[s], B = sect[s + 1];
    const slope = Math.abs(B.roof - A.roof) / (B.x - A.x), cab = Math.min(A.cabin, B.cabin);
    for (let p = 0; p < P - 1; p++) {
      let isGlass = false;
      if (p === 6 && cab > 0.2) isGlass = true;                      // side windows
      if (p >= 7 && cab > 0.06 && slope > 0.28) isGlass = true;       // windscreen / rear screen
      if (p === 6 && cab > 0.06 && slope > 0.28) isGlass = true;
      const grp = isGlass ? glass : paint;
      for (const side of [1, -1]) {
        if (side < 0 && sect[s].pts[p][0] === 0 && sect[s].pts[p + 1][0] === 0) continue;
        const a = vert(grp, s, p, side), b = vert(grp, s + 1, p, side), c = vert(grp, s, p + 1, side), d = vert(grp, s + 1, p + 1, side);
        if (side > 0) grp.idx.push(a, b, c, c, b, d); else grp.idx.push(a, c, b, c, d, b);
      }
    }
  }
  // end caps
  for (const [s, flip] of [[0, true], [sect.length - 1, false]]) {
    const cy = (sect[s].pts[0][1] + sect[s].pts[P - 1][1]) / 2;
    const ci = paint.pos.length / 3; paint.pos.push(sect[s].x, cy, 0);
    for (const side of [1, -1]) for (let p = 0; p < P - 1; p++) {
      const a = vert(paint, s, p, side), b = vert(paint, s, p + 1, side);
      if ((side > 0) !== flip) paint.idx.push(ci, b, a); else paint.idx.push(ci, a, b);
    }
  }
  const mk = (g) => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3)); geo.setIndex(g.idx); geo.computeVertexNormals(); return geo; };
  return { paint: mk(paint), glass: mk(glass), sect, hw, ys };
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
  g.userData = { spokes, disc, sw };
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function box(w, h, d, mat, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; return m; }

export function buildCarModel(spec, { ghost = false, colorOverride = null } = {}) {
  const glb = spec.body.style === 'glb' && !ghost ? spec.body : null;
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

  if (b.style !== 'formula') {
    const loft = loftBody(b.style, b.length, b.width, b.height);
    const shift = mid + (b.style === 'gt' ? -0.05 : 0.06);
    const body = new THREE.Mesh(loft.paint, paintMat), glass = new THREE.Mesh(loft.glass, glassMat);
    for (const m of [body, glass]) { m.position.x = shift; m.castShadow = true; m.receiveShadow = true; chassis.add(m); }
    const hw = b.width / 2, front = shift + b.length / 2, rear = shift - b.length / 2;
    const sectAt = (x) => loft.sect.reduce((best, s) => (Math.abs(s.x + shift - x) < Math.abs(best.x + shift - x) ? s : best));
    // lights
    const fs = sectAt(front - 0.12), rs = sectAt(rear + 0.1);
    for (const sgn of [1, -1]) {
      chassis.add(box(0.1, 0.11, 0.34, headMat, front - 0.13, fs.pts[5][1] - 0.1, sgn * (fs.pts[5][0] - 0.22)));
      chassis.add(box(0.06, 0.09, b.style === 'gt' ? 0.5 : 0.34, tailMat, rear + 0.05, rs.pts[5][1] - 0.1, sgn * (rs.pts[5][0] - 0.24)));
      // mirrors
      const ms = sectAt(shift + b.length * 0.14);
      chassis.add(box(0.12, 0.09, 0.18, paintMat, shift + b.length * 0.14, ms.pts[5][1] + 0.05, sgn * (ms.pts[5][0] + 0.08)));
    }
    if (b.style === 'gt' || b.style === 'sedan') chassis.add(box(0.05, 0.05, b.width * 0.72, tailMat, rear + 0.06, rs.pts[5][1] - 0.02, 0));
    // grille / intakes
    chassis.add(box(0.06, 0.2, b.width * 0.5, black, front - 0.03, fs.pts[0][1] + 0.16, 0));
    chassis.add(box(0.06, 0.12, b.width * 0.7, black, rear + 0.02, rs.pts[0][1] + 0.08, 0));
    // exhausts
    if (!spec.engine.electric) for (const sgn of b.style === 'hatch' ? [0.25, 0, -0.25] : [1, -1]) {
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 10).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 1, roughness: 0.25 }));
      tip.position.set(rear + 0.02, rs.pts[0][1] + 0.06, b.style === 'hatch' ? sgn * 0.5 : sgn * b.width * 0.28); chassis.add(tip);
    }
    if (b.style === 'gt') {
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
      const stripeM = new THREE.MeshStandardMaterial({ color: 0xd4002a, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
      chassis.add(box(b.length * 0.2, 0.012, 0.42, stripeM, shift - 0.03 * b.length, b.height + 0.016, 0));
    }
    if (b.style === 'hatch') chassis.add(box(0.28, 0.03, b.width * 0.72, paintMat, rear + 0.36, b.height * 0.985, 0));
    if (b.style === 'coupe') chassis.add(box(0.12, 0.04, b.width * 0.7, paintMat, rear + 0.12, rs.pts[5][1] + 0.04, 0));
    // wheel-arch liners
    for (const [ax, ] of [[a, 0], [-bb, 1]]) for (const sgn of [1, -1]) {
      const arch = new THREE.Mesh(new THREE.CircleGeometry(R * 1.17, 28), black);
      const s = sectAt(ax);
      arch.position.set(ax, R * 1.02, sgn * (s.pts[3][0] + 0.004)); arch.rotation.y = sgn > 0 ? 0 : Math.PI; chassis.add(arch);
    }
    wheelZ.push(hw - tyreW[0] / 2 + 0.012, hw - tyreW[1] / 2 + 0.012);
  } else {
    buildFormula(chassis, spec, { paintMat, carbon, black, tailMat, a, bb });
    wheelZ.push(spec.trackF / 2, spec.trackR / 2);
  }

  const rimColor = b.style === 'formula' ? 0x202024 : b.style === 'gt' ? 0xc9a227 : b.style === 'coupe' ? 0x2a2a2c : 0xb8bcc4;
  for (let i = 0; i < 4; i++) {
    const front = i < 2, sgn = i % 2 === 0 ? -1 : 1; // sim wheel 0 = front-left = -Z
    const steer = new THREE.Group();
    const w = buildWheel(R, tyreW[front ? 0 : 1], rimColor, race);
    w.userData.spokes.position.z = sgn * (w.userData.sw - 0.04); w.userData.disc.position.z = sgn * (w.userData.sw - 0.11);
    steer.position.set(front ? a : -bb, R, sgn * wheelZ[front ? 0 : 1]);
    steer.add(w); root.add(steer);
    wheels.push({ steer, spin: w });
  }

  if (ghost) {
    root.traverse(o => {
      if (o.isMesh) { o.material = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.28, depthWrite: false }); o.castShadow = false; }
    });
  }
  const model = {
    root, chassis, wheels, tailMat,
    // steer angle (rad) for front wheels, spin increment (rad) for all
    setWheel(i, steer, dSpin) { const w = wheels[i]; if (i < 2) w.steer.rotation.y = steer; w.spin.rotation.z -= dSpin; },
    setBrake(on) { tailMat.emissiveIntensity = on ? 3.2 : 0.35; },
    dispose() { this.disposed = true; root.traverse(o => { if (o.isMesh && !o.userData.shared) { o.geometry.dispose(); } }); },
  };
  if (glb) attachGLB(model, spec, glb, { a, bb });
  return model;
}

// Swap the procedural stand-in for a detailed glTF model once it has loaded.
function attachGLB(model, spec, body, { a, bb }) {
  loadGLB(body.model).then((gltf) => {
    if (model.disposed) return;
    const car = gltf.scene.clone(true);
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: body.color, metalness: 0.9, roughness: 0.45, clearcoat: 1, clearcoatRoughness: 0.03 });
    const detail = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.4 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1014, metalness: 0.6, roughness: 0.02, transparent: true, opacity: 0.72 });
    const set = (name, mat) => { const o = car.getObjectByName(name); if (o) o.material = mat; };
    set('body', bodyMat); set('glass', glass); set('trim', detail);
    for (const n of ['rim_fl', 'rim_fr', 'rim_rr', 'rim_rl']) set(n, detail);
    car.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.shared = true; } });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.9, metalness: 0 });
    car.traverse(o => { if (o.isMesh && o.name.startsWith('tire')) o.material = rubber; });
    // the model's own tail-light lenses double as brake lights
    const tail = new THREE.MeshStandardMaterial({ color: 0x5a0000, emissive: 0xff1408, emissiveIntensity: 0.25, roughness: 0.3 });
    const lr = car.getObjectByName('lights_red'); if (lr) lr.traverse(o => { if (o.isMesh) o.material = tail; });
    model.setBrake = (on) => { tail.emissiveIntensity = on ? 3.5 : 0.25; };
    const names = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
    const gw = names.map(n => car.getObjectByName(n));
    if (gw.some(w => !w)) return;                 // unexpected model layout: keep the stand-in
    // model faces -Z; ours faces +X. Align axles with the sim's wheelbase.
    const holder = new THREE.Group(); holder.rotation.y = -Math.PI / 2; holder.add(car);
    const zf = gw[0].position.z, zr = gw[2].position.z, k = spec.wheelbase / Math.abs(zf - zr);
    car.scale.setScalar(k);
    car.position.z = -((zf + zr) / 2) * k;
    holder.position.x = (a - bb) / 2;
    // remove procedural parts, keep groups
    for (const w of model.wheels) w.steer.visible = false;
    while (model.chassis.children.length) model.chassis.remove(model.chassis.children[0]);
    model.chassis.add(holder);
    // wheels live inside the chassis in this model; steer + spin them there
    for (const w of gw) w.rotation.order = 'YXZ';
    const spin = [0, 0, 0, 0];
    model.setWheel = (i, steer, dSpin) => { const w = gw[i]; spin[i] -= dSpin; if (i < 2) w.rotation.y = steer; w.rotation.x = spin[i]; };
    // baked contact shadow under the car
    new THREE.TextureLoader().load(globalThis.__INLINE_ASSETS?.['models/ferrari_ao.png'] || 'models/ferrari_ao.png', (tex) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.655 * 4 * k, 1.3 * 4 * k), new THREE.MeshBasicMaterial({ map: tex, blending: THREE.MultiplyBlending, toneMapped: false, transparent: true, premultipliedAlpha: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.renderOrder = 2; m.userData.shared = false; car.add(m);
    });
  }).catch(() => { /* offline or blocked: the procedural stand-in remains */ });
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
