// Builds the 3D environment from the sim's track description.
// Sim (x, y) maps to Three (x, height, -y); heading θ maps to rotation.y = θ.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nearestIndexGlobal } from '../sim/track.js';
import { RNG } from '../sim/rng.js';
import * as TX from './textures.js';

const hash2 = (ix, iy) => { let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function vnoise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0), b = hash2(x0 + 1, y0), c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export function trackHeight(track, idx, frac = 0) {
  const j = idx + 1 === track.n ? 0 : idx + 1;
  return track.z[idx] + (track.z[j] - track.z[idx]) * frac;
}

// Signed lateral offset of an arbitrary point relative to sample i.
function latOffset(track, i, x, y) {
  const h = track.heading[i];
  return -(x - track.x[i]) * Math.sin(h) + (y - track.y[i]) * Math.cos(h);
}

export function makeTerrainFn(track) {
  let cx = 0, cy = 0;
  for (let i = 0; i < track.n; i++) { cx += track.x[i]; cy += track.y[i]; }
  cx /= track.n; cy /= track.n;
  let zMin = Infinity, zMax = -Infinity, zMean = 0;
  for (let i = 0; i < track.n; i++) { zMin = Math.min(zMin, track.z[i]); zMax = Math.max(zMax, track.z[i]); zMean += track.z[i] / track.n; }
  const amp = Math.max(0.12, Math.min(1.6, (zMax - zMin) / 23));
  let ext = 0; for (let i = 0; i < track.n; i += 10) ext = Math.max(ext, Math.hypot(track.x[i] - cx, (track.y[i] - cy) * 1.4));
  return (x, y) => {
    const i = nearestIndexGlobal(track, x, y);
    const d = latOffset(track, i, x, y);
    const dist = Math.hypot(x - track.x[i], y - track.y[i]);
    const corr = (d > 0 ? track.wallL[i] : track.wallR[i]) + 1.5;
    const near = track.z[i] - 0.25;
    const rc = Math.hypot(x - cx, (y - cy) * 1.4);
    // surrounding land follows the circuit's own relief: flat circuits sit on flat land
    const far = zMean + amp * (22 * (vnoise(x / 420 + 3.1, y / 420 + 7.7) - 0.4) + 8 * (vnoise(x / 130, y / 130) - 0.4)) + 1.2 * vnoise(x / 28, y / 28)
      + (60 + 90 * amp) * smooth(ext + 300, ext + 1200, rc) * (0.45 + 0.9 * vnoise(x / 300 + 11, y / 300 + 5));
    const t = smooth(corr, corr + 80, dist);
    return { h: near + (far - near) * t, idx: i, dist, corr, t };
  };
}

function ribbon(track, step, offA, offB, { zA = 0, zB = 0, vScale = 13, mask = null, closed = true } = {}) {
  // Build a strip between lateral offsets offA(i) and offB(i). When `mask` is
  // given only the masked spans are emitted.
  const pos = [], uv = [], idx = [];
  const n = track.n;
  let prev = -1;
  const f = (v, i) => (typeof v === 'function' ? v(i) : v);
  for (let k = 0; k <= n; k += step) {
    const i = k % n;
    if (mask && !mask(i)) { prev = -1; continue; }
    if (!closed && k === n) break;
    const h = track.heading[i], nx = -Math.sin(h), ny = Math.cos(h);
    const a = f(offA, i), b = f(offB, i);
    const base = pos.length / 3;
    pos.push(track.x[i] + nx * a, track.z[i] + f(zA, i), -(track.y[i] + ny * a));
    pos.push(track.x[i] + nx * b, track.z[i] + f(zB, i), -(track.y[i] + ny * b));
    const v = (k * track.ds) / vScale;
    uv.push(0, v, 1, v);
    if (prev >= 0) idx.push(prev, base, prev + 1, prev + 1, base, base + 1);
    prev = base;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildWorld(track, renderer, quality) {
  const group = new THREE.Group();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const terrain = makeTerrainFn(track);
  const HW = track.halfWidth, KW = track.kerbWidth, hwA = track.hw;
  const hwP = (i) => hwA[i], hwN = (i) => -hwA[i];

  // ---- sky, sun, fog ------------------------------------------------------
  const sky = new Sky(); sky.scale.setScalar(9000);
  const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 34), THREE.MathUtils.degToRad(-128));
  const U = sky.material.uniforms;
  U.turbidity.value = 3.2; U.rayleigh.value = 1.25; U.mieCoefficient.value = 0.004; U.mieDirectionalG.value = 0.86;
  U.sunPosition.value.copy(sun);
  group.add(sky);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x55603a, 0.7);
  const sunLight = new THREE.DirectionalLight(0xfff1dc, 2.5);
  sunLight.position.copy(sun).multiplyScalar(300);
  sunLight.castShadow = quality.shadows;
  sunLight.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
  const sc = sunLight.shadow.camera; sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 50; sc.far = 700;
  sunLight.shadow.bias = -0.0004; sunLight.shadow.normalBias = 0.05;
  group.add(hemi, sunLight, sunLight.target);
  const fogColor = new THREE.Color(0xb9cee0);

  // ---- asphalt ------------------------------------------------------------
  const asp = TX.asphaltTextures(aniso);
  const asphaltMat = new THREE.MeshStandardMaterial({ map: asp.map, roughnessMap: asp.roughnessMap, normalMap: asp.normalMap, normalScale: new THREE.Vector2(0.18, 0.18), roughness: 1, metalness: 0 });
  const road = new THREE.Mesh(ribbon(track, 2, hwN, hwP, { vScale: 2 * HW }), asphaltMat);
  road.receiveShadow = true; group.add(road);

  // ---- kerbs (red/white, slightly raised) -----------------------------------
  {
    const geos = [];
    for (const side of [1, -1]) {
      const g1 = ribbon(track, 1, i => side * hwA[i], i => side * (hwA[i] + KW * 0.5), { zA: 0.004, zB: 0.045, mask: i => track.kerb[i], closed: false });
      const g2 = ribbon(track, 1, i => side * (hwA[i] + KW * 0.5), i => side * (hwA[i] + KW), { zA: 0.045, zB: 0.012, mask: i => track.kerb[i], closed: false });
      for (const g of [g1, g2]) {
        if (side < 0) g.index.array.reverse();
        const col = [], p = g.attributes.uv;
        for (let k = 0; k < p.count; k++) { const red = Math.floor(p.getY(k) * 13 / 2.2) % 2 === 0; col.push(red ? 0.72 : 0.92, red ? 0.07 : 0.92, red ? 0.07 : 0.9); }
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.computeVertexNormals();
        geos.push(g);
      }
    }
    const kerbs = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
    kerbs.receiveShadow = true; group.add(kerbs);
  }

  // ---- verges: grass run-off and gravel traps ------------------------------
  const grassTex = TX.grassTexture(aniso);
  const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, color: 0xd6e6c8 });
  const gravelMat = new THREE.MeshStandardMaterial({ map: TX.gravelTexture(aniso), roughness: 1 });
  for (const side of [1, -1]) {
    const wall = i => side * (side > 0 ? track.wallL[i] : track.wallR[i]);
    const isGravel = i => (side > 0 ? track.gravelL[i] : track.gravelR[i]);
    const inner = i => side * (hwA[i] + (track.kerb[i] ? KW : 0));
    const gStart = i => side * Math.min(hwA[i] + KW + 2.0, (side > 0 ? track.wallL[i] : track.wallR[i]));
    const fix = g => { if (side < 0) { g.index.array.reverse(); g.computeVertexNormals(); } scaleUV(g, 1, 13 / 6); return g; };
    // grass from track edge to wall (or to gravel start)
    const g1 = fix(ribbon(track, 2, inner, i => (isGravel(i) ? gStart(i) : wall(i)), { zA: 0.0, zB: -0.02, vScale: 6 }));
    const grass = new THREE.Mesh(g1, grassMat); grass.receiveShadow = true; group.add(grass);
    const g2 = fix(ribbon(track, 2, gStart, wall, { zA: -0.02, zB: -0.02, vScale: 6, mask: isGravel, closed: false }));
    const gravel = new THREE.Mesh(g2, gravelMat); gravel.receiveShadow = true; group.add(gravel);
    // skirt behind the wall down to the terrain
    const g3 = fix(ribbon(track, 4, wall, i => wall(i) + side * 5, { zA: -0.02, zB: -0.6, vScale: 6 }));
    group.add(new THREE.Mesh(g3, grassMat));
  }

  // ---- barriers -------------------------------------------------------------
  {
    const armco = TX.armcoTexture(aniso), tyres = TX.tyreWallTexture(aniso);
    const armcoMat = new THREE.MeshStandardMaterial({ map: armco, roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide });
    const tyreMat = new THREE.MeshStandardMaterial({ map: tyres, roughness: 0.9, side: THREE.DoubleSide });
    for (const side of [1, -1]) {
      const wallOff = i => side * (side > 0 ? track.wallL[i] : track.wallR[i]);
      const isTyre = i => (side > 0 ? track.gravelL[i] : track.gravelR[i]);
      for (const [mask, mat, hgt, vs] of [[i => !isTyre(i), armcoMat, 0.95, 4], [isTyre, tyreMat, 1.15, 1.6]]) {
        const pos = [], uv = [], idx = []; let prev = -1;
        for (let k = 0; k <= track.n; k += 2) {
          const i = k % track.n;
          if (!mask(i)) { prev = -1; continue; }
          const h = track.heading[i], o = wallOff(i);
          const x = track.x[i] - Math.sin(h) * o, y = track.y[i] + Math.cos(h) * o;
          const b = pos.length / 3;
          pos.push(x, track.z[i] - 0.05, -y, x, track.z[i] + hgt, -y);
          uv.push(k * track.ds / vs, 0, k * track.ds / vs, 1);
          if (prev >= 0) idx.push(prev, b, prev + 1, prev + 1, b, b + 1);
          prev = b;
        }
        if (!pos.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.setIndex(idx); g.computeVertexNormals();
        const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; group.add(m);
      }
    }
  }

  // ---- terrain ---------------------------------------------------------------
  {
    const g = track.grid, pad = 1500, cell = 10;
    const x0 = g.minX - pad, y0 = g.minY - pad, x1 = g.maxX + pad, y1 = g.maxY + pad;
    // non-uniform grid: fine near the circuit, coarse towards the horizon
    const axis = (a, b, lo, hi) => { const out = []; let v = a; while (v < b) { out.push(v); const far = v < lo ? lo - v : v > hi ? v - hi : 0; v += cell + far * 0.09; } out.push(b); return out; };
    const xs = axis(x0, x1, g.minX + 120, g.maxX - 120), ys = axis(y0, y1, g.minY + 120, g.maxY - 120);
    const pos = new Float32Array(xs.length * ys.length * 3), col = new Float32Array(xs.length * ys.length * 3), uv = new Float32Array(xs.length * ys.length * 2);
    let p = 0, q = 0, c = 0;
    for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
      const X = xs[i], Y = ys[j], t = terrain(X, Y);
      pos[p++] = X; pos[p++] = t.h; pos[p++] = -Y;
      uv[q++] = X / 7; uv[q++] = Y / 7;
      const n1 = vnoise(X / 60, Y / 60), n2 = vnoise(X / 9, Y / 9);
      const rock = smooth(55, 120, t.h) * (0.5 + 0.5 * n1);
      const dry = 0.82 + 0.3 * n1 + 0.1 * n2;
      col[c++] = (0.80 * dry) * (1 - rock) + 0.62 * rock;
      col[c++] = (0.95 * dry) * (1 - rock) + 0.60 * rock;
      col[c++] = (0.72 * dry) * (1 - rock) + 0.58 * rock;
    }
    const idx = [];
    for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
      const a = j * xs.length + i, b = a + 1, d = a + xs.length, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: grassTex, vertexColors: true, roughness: 1 }));
    mesh.receiveShadow = true; group.add(mesh);
  }

  // ---- trees (instanced) -------------------------------------------------------
  {
    const rng = new RNG(4242), N = Math.round(quality.trees * Math.min(2.2, track.length / 2900));
    const trunkG = new THREE.CylinderGeometry(0.22, 0.34, 1, 6); trunkG.translate(0, 0.5, 0);
    const pineG = mergeGeometries([
      new THREE.ConeGeometry(1.0, 1.1, 7).translate(0, 0.55, 0),
      new THREE.ConeGeometry(0.78, 1.0, 7).translate(0, 1.15, 0),
      new THREE.ConeGeometry(0.5, 0.9, 7).translate(0, 1.75, 0)]);
    const leafG = new THREE.IcosahedronGeometry(1, 1); leafG.scale(1, 0.85, 1); leafG.translate(0, 0.8, 0);
    const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 }), N);
    const pines = new THREE.InstancedMesh(pineG, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), N);
    const leaves = new THREE.InstancedMesh(leafG, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), N);
    const m = new THREE.Matrix4(), qn = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), cc = new THREE.Color();
    const g = track.grid; let np = 0, nl = 0, nt = 0, guard = 0;
    while (nt < N && guard++ < N * 40) {
      const X = rng.uniform(g.minX - 150, g.maxX + 150), Y = rng.uniform(g.minY - 150, g.maxY + 150);
      const t = terrain(X, Y);
      if (t.dist < t.corr + 7) continue;
      const density = vnoise(X / 90 + 40, Y / 90 + 40);
      if (density < 0.42 && rng.next() > 0.12) continue;
      // keep the main-straight facilities clear
      { const dx = X - track.x[0], dy = Y - track.y[0], c0 = Math.cos(track.heading[0]), s0 = Math.sin(track.heading[0]);
        const lx = dx * c0 + dy * s0, ly = -dx * s0 + dy * c0; if (lx > -230 && lx < 190 && ly > -75 && ly < 75) continue; }
      const pine = vnoise(X / 200, Y / 200) > 0.5 ? rng.next() < 0.8 : rng.next() < 0.2;
      const hgt = rng.uniform(6, 13) * (pine ? 1.15 : 0.9), th = hgt * (pine ? 0.22 : 0.42);
      qn.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rng.uniform(0, 6.28));
      v.set(X, t.h - 0.2, -Y);
      trunks.setMatrixAt(nt++, m.compose(v, qn, s.set(1, th, 1)));
      v.y += th * 0.8;
      if (pine) {
        const w = hgt * 0.26; m.compose(v, qn, s.set(w, (hgt - th * 0.8) / 2.2, w));
        pines.setMatrixAt(np, m); pines.setColorAt(np++, cc.setHSL(0.33 + rng.uniform(-0.03, 0.03), 0.42, 0.14 + rng.uniform(0, 0.07)));
      } else {
        const w = hgt * 0.38; m.compose(v, qn, s.set(w, (hgt - th * 0.8) / 1.65, w));
        leaves.setMatrixAt(nl, m); leaves.setColorAt(nl++, cc.setHSL(0.26 + rng.uniform(-0.05, 0.04), 0.5, 0.2 + rng.uniform(0, 0.1)));
      }
    }
    trunks.count = nt; pines.count = np; leaves.count = nl;
    for (const im of [trunks, pines, leaves]) { im.castShadow = quality.shadows; im.receiveShadow = false; im.frustumCulled = false; group.add(im); }
  }

  // ---- start/finish furniture ---------------------------------------------------
  const z0 = track.z[0], H0 = track.hw[0];
  {
    const sf = new THREE.Group(); sf.position.set(track.x[0], 0, -track.y[0]); sf.rotation.y = track.heading[0]; group.add(sf);
    const c0 = Math.cos(track.heading[0]), s0 = Math.sin(track.heading[0]);
    // does a local-frame rectangle (lx along the track, lz to the right) stay clear of every piece of track?
    const fits = (lx0, lx1, lz0, lz1) => {
      for (let a = 0; a <= 12; a++) for (let b = 0; b <= 3; b++) {
        const lx = lx0 + (lx1 - lx0) * a / 12, lz = lz0 + (lz1 - lz0) * b / 3;
        const t = terrain(track.x[0] + lx * c0 + lz * s0, track.y[0] + lx * s0 - lz * c0);
        if (t.dist < t.corr + 0.5) return false;
      }
      return true;
    };
    // chequered line
    const c = document.createElement('canvas'); c.width = 256; c.height = 32; const ctx = c.getContext('2d');
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { ctx.fillStyle = (i + j) % 2 ? '#eee' : '#111'; ctx.fillRect(i * 16, j * 16, 16, 16); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2 * H0), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }));
    tex.rotation = Math.PI / 2; tex.center.set(0.5, 0.5);
    line.rotation.x = -Math.PI / 2; line.position.set(0, z0 + 0.012, 0); line.receiveShadow = true;
    sf.add(line);
    // grid slots
    const slotMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 });
    for (let k = 0; k < 8; k++) {
      const s = track.n - 10 - k * 9, side = k % 2 ? -1 : 1, i = ((s % track.n) + track.n) % track.n;
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 2.6), slotMat);
      const hh = track.heading[i];
      bar.rotation.set(-Math.PI / 2, 0, hh);
      bar.position.set(track.x[i] + Math.cos(hh) * 2.6 - Math.sin(hh) * side * 2.8, track.z[i] + 0.012, -(track.y[i] + Math.sin(hh) * 2.6 + Math.cos(hh) * side * 2.8)); group.add(bar);
    }
    // gantry
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.7 });
    const gantry = new THREE.Group();
    for (const s of [1, -1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), steel); post.position.set(0, 3.75, s * (H0 + 3.2)); gantry.add(post); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 2 * H0 + 7), steel); beam.position.set(0, 7.3, 0); gantry.add(beam);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.6), new THREE.MeshStandardMaterial({ map: TX.labelTexture(track.name.toUpperCase().slice(0, 22), { w: 1024, h: 128, bg: '#0d1b2a', fg: '#f4f4f4', font: track.name.length > 16 ? 'bold 62px sans-serif' : 'bold 84px sans-serif' }), roughness: 0.6 }));
    sign.rotation.y = -Math.PI / 2; sign.position.set(-0.47, 7.3, 0); gantry.add(sign);
    sign.scale.x = Math.min(1, (2 * H0 + 4) / 14);
    gantry.position.set(0, z0, 0);
    gantry.traverse(o => { if (o.isMesh) o.castShadow = true; });
    sf.add(gantry);

    // grandstand (left of the straight) and pit building (right)
    const concrete = new THREE.MeshStandardMaterial({ map: TX.concreteTexture(aniso), roughness: 0.9 });
    const crowdC = document.createElement('canvas'); crowdC.width = 512; crowdC.height = 64; const cx = crowdC.getContext('2d');
    const rr = new RNG(77); cx.fillStyle = '#2b2f37'; cx.fillRect(0, 0, 512, 64);
    for (let i = 0; i < 5200; i++) { cx.fillStyle = `hsl(${rr.int(360)},${8 + rr.int(26)}%,${22 + rr.int(38)}%)`; cx.fillRect(rr.int(512), rr.int(64), 2, 3); }
    const crowdT = new THREE.CanvasTexture(crowdC); crowdT.colorSpace = THREE.SRGBColorSpace;
    const crowdMat = new THREE.MeshStandardMaterial({ map: crowdT, roughness: 1 });
    const stand = new THREE.Group();
    const wl0 = track.wallL[0] + 4.5, wr0 = track.wallR[0] + 4.5;
    const L = [220, 120, 60].find(l => fits(-30 - l / 2, -30 + l / 2, -wl0, -(wl0 + 16))) || 0;
    for (let r = 0; r < 9; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(L, 0.9, 1.5), r % 1 === 0 ? crowdMat : concrete);
      step.position.set(0, 1.6 + r * 0.9, -r * 1.5); stand.add(step);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(L, 13, 0.6), concrete); back.position.set(0, 6.5, -14); stand.add(back);
    const base = new THREE.Mesh(new THREE.BoxGeometry(L, 1.6, 15), concrete); base.position.set(0, 0.5, -6.5); stand.add(base);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(L + 4, 0.35, 17), new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.4, metalness: 0.3 }));
    roof.position.set(0, 13.4, -6.5); roof.rotation.x = -0.07; stand.add(roof);
    for (let k = -5; k <= 5; k++) { const col = new THREE.Mesh(new THREE.BoxGeometry(0.4, 13, 0.4), steel); col.position.set(k * L / 10.5, 6.5, -13.4); stand.add(col); }
    stand.position.set(-30, z0 - 0.4, -wl0 - 0.5); stand.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    if (L) sf.add(stand);

    const pit = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(190, 6.5, 12), new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.7 })); body.position.y = 3.25; pit.add(body);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(190.2, 1.6, 12.2), new THREE.MeshStandardMaterial({ color: 0x1b2a3a, roughness: 0.1, metalness: 0.8 })); glass.position.y = 5.0; pit.add(glass);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.6 });
    for (let k = 0; k < 16; k++) { const d = new THREE.Mesh(new THREE.BoxGeometry(8, 3.4, 0.2), doorMat); d.position.set(-84 + k * 11.2, 1.7, -6.05); pit.add(d); }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(190.3, 0.5, 12.3), new THREE.MeshStandardMaterial({ color: 0xd22030, roughness: 0.5 })); stripe.position.y = 6.2; pit.add(stripe);
    pit.position.set(-20, z0 - 0.4, wr0 + 6.5); pit.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const pitScale = [1, 0.55, 0.3].find(k => fits(-20 - 95 * k, -20 + 95 * k, wr0, wr0 + 13));
    if (pitScale) { pit.scale.x = pitScale; sf.add(pit); }
  }

  // ---- trackside boards: braking distance markers and sponsor hoardings -------------
  const brakeMarkers = [];
  {
    const n = track.n;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(track.curv[i]), kp = Math.abs(track.curv[(i - 1 + n) % n]);
      if (k > 0.0105 && kp <= 0.0105) {
        // only for corners approached after a straight-ish section
        let straight = 0; for (let b = 20; b < 160; b += 10) if (Math.abs(track.curv[(i - b + n) % n]) < 0.004) straight++;
        if (straight < 7) continue;
        const side = track.curv[i] > 0 ? -1 : 1; // outside of the corner
        for (const dist of [150, 100, 50]) {
          const j = (i - dist + 20 + n) % n, h = track.heading[j], off = side * (track.hw[j] + 2.2);
          brakeMarkers.push({ dist, x: track.x[j] - Math.sin(h) * off, y: track.y[j] + Math.cos(h) * off, z: track.z[j], heading: h });
        }
      }
    }
    const rng = new RNG(99), names = ['VANTA', 'ARROW', 'VOLT-R', 'BRAWLER', 'FX RACING', 'KESTREL OIL', 'ANVIL TOOLS', 'RIDGE TYRES'];
    const cols = [['#0d3b66', '#faf0ca'], ['#d62828', '#ffffff'], ['#111111', '#ffd60a'], ['#f4f4f4', '#1d3557'], ['#1b4332', '#d8f3dc'], ['#ff7b00', '#111']];
    for (let i = 60; i < n; i += 97) {
      if (Math.abs(track.curv[i]) > 0.006) continue;
      const side = rng.next() > 0.5 ? 1 : -1, h = track.heading[i];
      const off = side * ((side > 0 ? track.wallL[i] : track.wallR[i]) + 0.6);
      const [bg, fg] = cols[rng.int(cols.length)];
      const board = new THREE.Mesh(new THREE.PlaneGeometry(12, 1.5), new THREE.MeshStandardMaterial({ map: TX.labelTexture(names[rng.int(names.length)], { w: 512, h: 64, bg, fg, font: 'bold 44px sans-serif' }), roughness: 0.7, side: THREE.DoubleSide }));
      board.position.set(track.x[i] - Math.sin(h) * off, track.z[i] + 1.75, -(track.y[i] + Math.cos(h) * off));
      board.rotation.y = h + (side > 0 ? 0 : Math.PI);
      group.add(board);
    }
  }

  function updateSun(target) {
    sunLight.target.position.copy(target);
    sunLight.position.copy(target).addScaledVector(sun, 320);
  }

  return { group, sky, sun, sunLight, hemi, fogColor, terrain, brakeMarkers, updateSun };
}

function scaleUV(g, su, sv) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv); }
