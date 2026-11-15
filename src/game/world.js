// Builds the 3D environment from the sim's track description.
// Sim (x, y) maps to Three (x, height, -y); heading θ maps to rotation.y = θ.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nearestIndexGlobal, SX, BAR, KERB_COLOURS } from '../sim/track.js';
import { RNG } from '../sim/rng.js';
import * as TX from './textures.js';
import { ASSETS, loadTexture, applyTextures } from './assets.js';
import { getSky } from './sky.js';
import { WX, WX_GLSL, wxUniforms } from './wx.js';
import { monacoSetup } from './monaco.js';

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

export function makeTerrainFn(track, { sea = false } = {}) {
  let cx = 0, cy = 0;
  for (let i = 0; i < track.n; i++) { cx += track.x[i]; cy += track.y[i]; }
  cx /= track.n; cy /= track.n;
  let zMin = Infinity, zMax = -Infinity, zMean = 0;
  for (let i = 0; i < track.n; i++) { zMin = Math.min(zMin, track.z[i]); zMax = Math.max(zMax, track.z[i]); zMean += track.z[i] / track.n; }
  // surrounding relief follows the circuit's own: flat circuits (Monza, Silverstone) sit in flat country
  const amp0 = Math.max(0.12, Math.min(1.6, (zMax - zMin) / 23)), amp = amp0 < 1 ? amp0 * amp0 : amp0;
  let ext = 0; for (let i = 0; i < track.n; i += 10) ext = Math.max(ext, Math.hypot(track.x[i] - cx, (track.y[i] - cy) * 1.4));
  // coastal circuits: the land falls away into the sea beyond the lowest part of the lap
  let sx = 0, sy = 0, lx0 = 0, ly0 = 0, ln = 0;
  if (sea) {
    for (let i = 0; i < track.n; i++) if (track.z[i] < zMin + 0.12 * (zMax - zMin)) { lx0 += track.x[i]; ly0 += track.y[i]; ln++; }
    lx0 /= ln; ly0 /= ln; const d = Math.hypot(lx0 - cx, ly0 - cy) || 1; sx = (lx0 - cx) / d; sy = (ly0 - cy) / d;
  }
  // real coastline (OSM, water on the right of each chain): signed distance, + = in the sea
  const coast = sea && track.scene?.coast ? track.scene.coast.map(c => Float64Array.from(c, v => v / 10)) : null;
  const seaDist = coast ? (x, y) => {
    let bd = Infinity, sg = -1;
    for (const c of coast) for (let k = 0; k + 3 < c.length; k += 2) {
      const ax = c[k], ay = c[k + 1], ex = c[k + 2] - ax, ey = c[k + 3] - ay, px = x - ax, py = y - ay;
      const u = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey))), dx = px - ex * u, dy = py - ey * u, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; sg = ex * py - ey * px < 0 ? 1 : -1; }
    }
    return sg * Math.sqrt(bd);
  } : null;
  return (x, y) => {
    let i = nearestIndexGlobal(track, x, y);
    if (track.deck && track.deck[i]) i = track.under[i];          // crossover: the ground under a bridge belongs to the lower road
    const d = latOffset(track, i, x, y);
    const dist = Math.hypot(x - track.x[i], y - track.y[i]);
    const corr = (d > 0 ? track.wallL[i] : track.wallR[i]) + 1.5;
    const near = track.z[i] - 0.25;
    const rc = Math.hypot(x - cx, (y - cy) * 1.4);
    // surrounding land follows the circuit's own relief: flat circuits sit on flat land
    const far = zMean + amp * (22 * (vnoise(x / 420 + 3.1, y / 420 + 7.7) - 0.4) + 8 * (vnoise(x / 130, y / 130) - 0.4)) + 1.2 * vnoise(x / 28, y / 28)
      + (25 + 110 * amp) * smooth(ext + 300, ext + 1200, rc) * (0.45 + 0.9 * vnoise(x / 300 + 11, y / 300 + 5));
    const t = smooth(corr, corr + 80, dist);
    let h = near + (far - near) * t;
    let sd = -1;
    if (sea) {
      const p = (x - lx0) * sx + (y - ly0) * sy;
      let w = smooth(20, 260, p) * smooth(corr + 4, corr + 60, dist);
      // with a real coastline the quay drops straight into the harbour
      if (seaDist) { sd = seaDist(x, y); w = smooth(0, 3, sd) * smooth(corr + 0.5, corr + 3, dist); }
      h += (zMin - 14 - h) * w;                       // sea bed
      h += (1 - smooth(-200, 500, p)) * smooth(corr + 30, corr + 400, dist) * 60;   // the town climbs the hill behind
    }
    return { h, idx: i, dist, corr, t, zMin, sea: sd };
  };
}

// ---------------------------------------------------------------- shader glue
const GLSL_NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
// Extend a built-in material: `color` runs after the albedo map is sampled
// (diffuseColor is live), `rough` after the roughness map (roughnessFactor).
// `wet: [albedo factor, roughness]` gives a simple response to rain; materials that
// need more (asphalt, paving) write gWet / gPud themselves. `out` runs after lighting.
function patch(mat, key, { uniforms = {}, vpars = '', vmain = '', fpars = '', color = '', rough = '', normal = '', wet = null, out = '' }) {
  if (wet) {
    color += `\ngWet = uWet; diffuseColor.rgb *= mix(1.0, ${wet[0].toFixed(3)}, gWet);`;
    rough += `\nroughnessFactor = mix(roughnessFactor, ${wet[1].toFixed(3)}, gWet);`;
  }
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms); wxUniforms(sh);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + vpars).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vmain);
    let f = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL_NOISE + WX_GLSL + fpars)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + color)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + rough);
    if (normal) f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + normal);
    if (out) f = f.replace('#include <opaque_fragment>', out + '\n#include <opaque_fragment>');
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}
// Alpha-cut cards and see-through meshes must not be drawn by passes that
// replace materials (the GTAO normal pass would treat them as solid walls).
export function skipOverride(mesh) {
  const own = new Set([].concat(mesh.material, mesh.customDepthMaterial || []));
  if (mesh.isInstancedMesh) { const n = mesh.count; mesh.onBeforeRender = (r, s, c, g, m) => { mesh.count = own.has(m) ? n : 0; }; mesh.onAfterRender = () => { mesh.count = n; }; }
  else { const g0 = mesh.geometry; mesh.onBeforeRender = (r, s, c, g, m) => { g0.setDrawRange(0, own.has(m) ? Infinity : 0); }; mesh.onAfterRender = () => { g0.setDrawRange(0, Infinity); }; }
  return mesh;
}
const ROAD_V = { vpars: 'attribute vec4 aRoad; attribute float aRub; varying vec4 vRoad; varying float vRub; varying vec3 vWPos;', vmain: 'vRoad = aRoad; vRub = aRub; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;' };
// the same plus the per-sample pair from strip()'s `aux` (flat: it carries ids as well as distances)
const AUX_V = { vpars: ROAD_V.vpars + ' attribute vec2 aAux; varying vec2 vAux; flat varying vec2 vAuxF;', vmain: ROAD_V.vmain + ' vAux = aAux; vAuxF = aAux;' };
const AUX_F = 'varying vec4 vRoad; varying float vRub; varying vec2 vAux; flat varying vec2 vAuxF;';
// Wet ground after lighting: the mirrored car (rendered by weather.js) shows in the water film.
const WET_REFLECT = `
  if (uReflOn > 0.5 && gWet > 0.02) {
    vec4 rc = uReflMat * vec4(vWPos, 1.0);
    vec2 ruv = rc.xy / rc.w + (normal.xy - nonPerturbedNormal.xy) * 0.22 * (1.0 - 0.85 * gPud);
    vec2 px = vec2(0.0, 0.006);
    vec4 r = 0.4 * texture2D(tRefl, ruv) + 0.3 * texture2D(tRefl, ruv + px) + 0.3 * texture2D(tRefl, ruv - px);
    float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
    float fr = 0.07 + 0.93 * pow(1.0 - nv, 5.0);
    outgoingLight = mix(outgoingLight, r.rgb, r.a * clamp(fr * 2.4, 0.0, 0.92) * clamp(0.5 * gWet + gPud, 0.0, 1.0));
  }`;
// Rain ripples and the flattening of the surface texture under water.
const WET_NORMAL = `
  normal = normalize(mix(normal, nonPerturbedNormal, clamp(0.35 * gWet + gPud, 0.0, 1.0)));
  float rpk = gPud * uRain * smoothstep(55.0, 12.0, vViewPosition.z);        // rings are too fine to resolve far away
  if (rpk > 0.01) { vec2 rp = rainRipple(vWPos.xz, uWxTime); normal = normalize(normal + mat3(viewMatrix) * vec3(rp.x, 0.0, rp.y) * 0.3 * rpk); }`;

// Along-track sample list: dense where the track curves or crests, sparse on straights.
function sampleList(track, minM, maxM, sag) {
  const n = track.n, ds = track.ds, ks = [0];
  let k = 0;
  while (k < n) {
    const i = k % n, j = (k + 1) % n;
    const kv = Math.abs(track.grade[j] - track.grade[i]) / ds;                 // vertical curvature
    const curv = Math.max(Math.abs(track.curv[i]), kv * 3, 1e-5);
    let step = Math.max(1, Math.round(Math.min(maxM, Math.max(minM, Math.sqrt(8 * sag / curv))) / ds));
    // never step over a tighter section that is coming up
    for (let q = 1; q < step; q++) { const c2 = Math.abs(track.curv[(k + q) % n]); if (c2 > 2.5 * curv) { step = Math.max(1, q); break; } }
    k = Math.min(n, k + step); ks.push(k);
  }
  return ks;
}

// Generic swept strip. `prof(i, out)` appends [lateral offset, absolute height, u] triples for
// track sample i (same count every sample). Emits road-space attributes for the shaders.
// `aux(i)` returns two numbers per sample, passed to the shaders as `aAux`.
function strip(track, ks, prof, { mask = null, vScale = 1, flip = false, uMetric = 0, color = null, rub = null, aux = null } = {}) {
  const n = track.n, pos = [], uv = [], road = [], rb = [], col = [], idx = [], pts = [], ax = [];
  let prev = -1, P = 0;
  for (const k of ks) {
    const i = k % n;
    if (mask && !mask(i)) { prev = -1; continue; }
    const h = track.heading[i], nx = -Math.sin(h), ny = Math.cos(h), s = k * track.ds;
    pts.length = 0; prof(i, pts); P = pts.length / 3;
    const base = pos.length / 3;
    for (let p = 0; p < P; p++) {
      const off = pts[p * 3], X = track.x[i] + nx * off, Y = track.y[i] + ny * off;
      pos.push(X, pts[p * 3 + 1], -Y);
      uv.push(uMetric ? off / uMetric : pts[p * 3 + 2], s / vScale);
      road.push(off, s, track.lineD ? track.lineD[i] : 0, track.hw[i]); rb.push(rub ? rub[i] : 0);
      if (color) color(X, Y, col);
      if (aux) { const a = aux(i); ax.push(a[0], a[1]); }
    }
    if (prev >= 0) for (let p = 0; p < P - 1; p++) {
      const a = prev + p, b = base + p;
      if (flip) idx.push(a, a + 1, b, a + 1, b + 1, b); else idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    prev = base;
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 4));
  g.setAttribute('aRub', new THREE.Float32BufferAttribute(rb, 1));
  if (color) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aAux', new THREE.Float32BufferAttribute(aux ? ax : new Float32Array(pos.length / 3 * 2), 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

const FOREST_BIAS = { nordschleife: 0.32, spa: 0.12, monza: 0.16, silverstone: -0.14, ravenscar: 0.02, laguna: -0.2 };
// Landscape themes (track.theme). `dry`: sun-bleached Californian hills, golden grass, scattered oaks.
const THEMES = {
  default: { ground: [0.8, 1.0, 0.72], trees: 1, conifer: null, crop: 1 },
  dry: { ground: [1.5, 1.22, 0.6], trees: 0.3, conifer: false, crop: 0, verge: [1.25, 1.12, 0.62] },
};

export function buildWorld(track, renderer, qualityIn) {
  const quality = { detail: 1, trees: 700, treeCap: 9000, shadowRange: 95, ...qualityIn };
  const group = new THREE.Group();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const urban = track.id === 'monaco' || !!track.urban;
  const theme = THEMES[track.theme] || THEMES.default;
  const SD = { 1: { kerb: track.kerbL, col: track.kerbColL, apron: track.apronL, apronW: track.apronWL, ro: track.roL, roA: track.roAL, gA: track.gAL, gB: track.gBL, wall: track.wallL, bar: track.barL, edge: track.edgeL },
    '-1': { kerb: track.kerbR, col: track.kerbColR, apron: track.apronR, apronW: track.apronWR, ro: track.roR, roA: track.roAR, gA: track.gAR, gB: track.gBR, wall: track.wallR, bar: track.barR, edge: track.edgeR } };
  // Monaco has its own ground model (src/game/monaco.js): OSM coastline, SRTM relief, terraces beside the road
  const mc = urban && track.scene?.dem ? monacoSetup(track) : null;
  const terrain = mc ? mc.terrain : makeTerrainFn(track, { sea: urban });
  const HW = track.halfWidth, KW = track.kerbWidth, hwA = track.hw, n = track.n;
  const wallAt = (side, i) => (side > 0 ? track.wallL[i] : track.wallR[i]);
  const gravelAt = (side, i) => SD[side].gB[i] > 0;
  const barAt = (side, i) => SD[side].bar[i];
  const add = (geo, mat, { cast = false, receive = true } = {}) => { if (!geo) return null; const m = new THREE.Mesh(geo, mat); m.castShadow = cast && quality.shadows; m.receiveShadow = receive; group.add(m); return m; };
  const photo = (mat, slots) => { applyTextures(mat, slots); return mat; };

  // ---- sky, sun, fog ------------------------------------------------------
  // Analytic sky first; the photographic sky takes over as soon as it has loaded.
  const skySys = getSky(renderer);
  const sky = new Sky(); sky.scale.setScalar(9000);
  const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 34), THREE.MathUtils.degToRad(-128));
  const U = sky.material.uniforms;
  U.turbidity.value = 3.2; U.rayleigh.value = 1.25; U.mieCoefficient.value = 0.004; U.mieDirectionalG.value = 0.86;
  U.sunPosition.value.copy(sun);
  group.add(sky);
  const dome = skySys.makeDome(); dome.visible = false; group.add(dome);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x55603a, 0.7);
  const sunLight = new THREE.DirectionalLight(0xfff1dc, 2.5);
  sunLight.position.copy(sun).multiplyScalar(300);
  sunLight.castShadow = quality.shadows;
  sunLight.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
  const SR = quality.shadowRange || 95;
  const sc = sunLight.shadow.camera; sc.left = -SR; sc.right = SR; sc.top = SR; sc.bottom = -SR; sc.near = 60; sc.far = 640;
  sunLight.shadow.bias = -0.0003; sunLight.shadow.normalBias = 0.06; sunLight.shadow.radius = 1.6;
  group.add(hemi, sunLight, sunLight.target);
  const fogColor = new THREE.Color(0xb9cee0);
  // weather: a procedural sky (src/game/skygen.js) can stand in for the photographed one
  const procDome = new THREE.Mesh(skySys.domeGeometry, skySys.domeMaterial); procDome.frustumCulled = false; procDome.renderOrder = 900; procDome.visible = false; procDome.userData.isSky = true; group.add(procDome);
  const flash = new THREE.DirectionalLight(0xcfdcff, 0); flash.position.set(0.3, 1, 0.2); group.add(flash);   // lightning
  let proc = null;
  const photoLook = () => {
    if (proc) return;
    procDome.visible = false; sunLight.shadow.radius = 1.6;
    if (skySys.ready) {
      const s = skySys; sun.copy(s.sunDir); sunLight.color.copy(s.sunColor); sunLight.intensity = s.sunIntensity;
      hemi.intensity = 0; sky.visible = false; dome.visible = true; fogColor.copy(s.fogColor);
    } else {
      sun.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 34), THREE.MathUtils.degToRad(-128));
      sunLight.color.set(0xfff1dc); sunLight.intensity = 2.5; hemi.intensity = 0.7; sky.visible = true; dome.visible = false; fogColor.set(0xb9cee0);
    }
  };
  skySys.whenReady(photoLook);
  // p: result of proceduralSky() with the condition it was made for, or null for the photographed clear sky
  function setSky(p, cond) {
    proc = p;
    if (!p) { photoLook(); return; }
    procDome.material = p.material; procDome.rotation.y = p.azimuth; procDome.updateMatrixWorld(); procDome.visible = true;
    dome.visible = false; sky.visible = false; hemi.intensity = 0;
    sun.copy(p.sunDir); sunLight.color.setRGB(...cond.sun.color); sunLight.intensity = cond.sun.intensity;
    sunLight.shadow.radius = 1.6 * (cond.shadow || 1); fogColor.setRGB(...cond.fog.color);
  }
  // direction of travel on the start straight as a rotation about the vertical (used to place low suns)
  const gridYaw = track.heading[0];
  // materials outside the shader-patched ground that should still look rained on
  const wetList = [];
  const wettable = (m, k = 0.5) => { wetList.push({ m, r0: m.roughness, c0: m.color.clone(), k }); return m; };
  function setWet(w) { for (const e of wetList) { e.m.roughness = e.r0 * (1 - e.k * w); e.m.color.copy(e.c0).multiplyScalar(1 - 0.22 * w); } }

  // rubber build-up: everywhere on the line, heaviest through braking zones and corners
  const rub = new Float32Array(n);
  {
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let q = 0; q <= 70; q += 10) m = Math.max(m, Math.abs(track.curv[(i + q) % n]) * (1 - q / 110)); raw[i] = Math.min(1, 0.62 + m * 50); }
    for (let i = 0; i < n; i++) { let a = 0; for (let q = -6; q <= 6; q++) a += raw[(i + q + n) % n]; rub[i] = a / 13; }
  }

  // ---- asphalt ------------------------------------------------------------
  // UVs are metric (4.2 m tile); the shader lays the racing groove along track.lineD,
  // paints the edge lines and adds resurfacing patches, seams and dusty edges.
  const ksRoad = sampleList(track, 1, 4, 0.006), ksEdge = sampleList(track, 1.5, 7, 0.02), ksFar = sampleList(track, 3, 12, 0.08);
  const aspFallback = TX.asphaltTile(aniso);
  const oldU = { value: aspFallback.map }, avgU = { value: 0.068 };
  const asphaltMat = patch(new THREE.MeshStandardMaterial({ map: aspFallback.map, normalMap: aspFallback.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.86, metalness: 0 }), 'road', {
    ...ROAD_V, uniforms: { uOld: oldU, uAvg: avgU, uUrban: { value: urban ? 1 : 0 }, uTun: { value: new THREE.Vector2(...(mc?.tun[0] ? [mc.tun[0][0] * track.ds, mc.tun[0][1] * track.ds] : [-9, -9])) } },
    fpars: 'uniform sampler2D uOld; uniform float uAvg; uniform float uUrban; uniform vec2 uTun; varying vec4 vRoad; varying float vRub; varying vec3 vWPos; float gRub; float gPaint; float gTun;',
    color: `{
      vec2 m = vRoad.xy;                                   // metres across (+left) / along
      gTun = smoothstep(uTun.x, uTun.x + 16.0, m.y) * (1.0 - smoothstep(uTun.y - 16.0, uTun.y, m.y));   // under cover: dry, lamp-lit
      vec3 a1 = diffuseColor.rgb;
      vec3 a2 = texture2D(map, m.yx / 23.0 + 0.37).rgb;    // same tile, large and rotated: breaks up repetition
      vec3 alb = a1 * mix(1.0, lum(a2) / uAvg, 0.55);
      // stretches of older, cracked surface
      float sect = smoothstep(0.55, 0.62, vnoise(vec2(m.y / 310.0, 3.7)));
      vec3 old = texture2D(uOld, m / 7.0).rgb;
      alb = mix(alb, old * 0.78 * mix(1.0, lum(a2) / uAvg, 0.4), sect * 0.85);
      alb = mix(vec3(lum(alb)), alb, 0.55) * 1.08;
      // resurfacing patches with sealed edges
      vec2 pg = vec2(m.x / 3.6, m.y / 19.0), pc = floor(pg), pf = fract(pg);
      float ph = hash12(pc + 11.0);
      if (ph > 0.93) {
        alb *= 0.74 + 0.5 * hash12(pc + 3.1);
        vec2 e = min(pf, 1.0 - pf) * vec2(3.6, 19.0);
        alb *= 0.55 + 0.45 * smoothstep(0.02, 0.07, min(e.x, e.y));
      }
      // paving joint down the middle and broad dark/light lanes left by the paver
      alb *= 0.72 + 0.28 * smoothstep(0.012, 0.04, abs(m.x - 0.3));
      alb *= 0.95 + 0.1 * vnoise(vec2(m.x * 0.55, m.y / 90.0));
      // rubbered-in racing line: two wheel tracks inside a broad dark band
      float x = m.x - vRoad.z;
      float streak = 0.72 + 0.56 * vnoise(vec2(m.x * 2.2, m.y / 28.0));
      float g = 0.72 * exp(-x * x / 3.6) + 0.3 * (exp(-(x - 0.82) * (x - 0.82) / 0.2) + exp(-(x + 0.82) * (x + 0.82) / 0.2));
      gRub = clamp(g * vRub * streak, 0.0, 1.0);
      alb *= 1.0 - 0.68 * gRub;
      // dust and marbles collect towards the edges
      float de = vRoad.w - abs(m.x);
      float dust = smoothstep(2.2, 0.0, de) * (0.5 + 0.5 * vnoise(m * vec2(1.5, 0.12)));
      alb = mix(alb, alb * 1.3 + vec3(0.02, 0.017, 0.011), dust * 0.55);
      // painted edge lines, worn where the aggregate stands proud
      float aa = min(fwidth(de) * 0.8, 0.07);
      float ln = smoothstep(0.04 - aa, 0.04 + aa, de) * (1.0 - smoothstep(0.2 - aa, 0.2 + aa, de));
      float wear = smoothstep(1.2, 1.8, lum(a1) / uAvg + 0.8 * vnoise(m * vec2(7.0, 1.2)));
      gPaint = ln * (1.0 - 0.6 * wear);
      alb = mix(alb, vec3(0.7, 0.7, 0.68) * (0.8 + 0.2 * lum(a1) / uAvg), gPaint);
      if (uUrban > 0.5) {
        // street circuit: zebra crossings, a worn centre line and manhole covers
        float zs = mod(m.y + 40.0, 211.0);
        float zb = step(zs, 3.6) * step(0.5, fract(m.x / 1.0 + 0.25)) * step(abs(m.x), vRoad.w - 0.5);
        float cl = step(abs(m.x), 0.07) * step(0.4, fract(m.y / 9.0)) * step(20.0, zs);
        alb = mix(alb, vec3(0.6, 0.6, 0.57) * (0.7 + 0.3 * lum(a1) / uAvg), max(zb, cl * 0.5) * (0.75 - 0.5 * wear) * (1.0 - 0.6 * gRub));
        vec2 mc = vec2(m.x - 2.6 * (hash12(vec2(floor(m.y / 47.0), 3.0)) - 0.5) * 2.0, mod(m.y, 47.0) - 23.5);
        float mh = smoothstep(0.36, 0.33, length(mc));
        alb = mix(alb, vec3(0.045, 0.04, 0.036) * (0.7 + 0.6 * step(0.5, fract(mc.x * 9.0)) * step(0.5, fract(mc.y * 9.0))), mh * 0.85);
      }
      // rain: a water film darkens the surface (the rubbered line dries first on a damp
      // track), water stands along the edges (same function as the sim) and in low spots
      float wetK = uWet * (1.0 - gTun);
      if (wetK > 0.001) {
        float dryL = clamp(g * 1.25, 0.0, 1.0) * uLineDry;
        float blot = vnoise(m * vec2(0.9, 0.11) + 7.0);
        float film = clamp(wetK * 1.35 - dryL * 0.9 - (1.0 - wetK) * blot * 0.9, 0.0, 1.0);
        float low = vnoise(m * vec2(0.33, 0.055) + 3.0) * 0.62 + vnoise(m * vec2(1.3, 0.35)) * 0.38;
        float pd = max(puddleDepth(m.y, m.x, vRoad.w), 0.8 * smoothstep(0.63, 0.78, low) * film) * uPuddle;
        gWet = film; gPud = clamp(pd, 0.0, 1.0);
        alb *= mix(1.0, 0.5 + 0.28 * gPaint, film);
        alb = mix(alb, alb * vec3(0.5, 0.54, 0.6), gPud);
      }
      diffuseColor.rgb = alb;
    }`,
    rough: `roughnessFactor = clamp(roughnessFactor - 0.3 * gRub - 0.22 * gPaint, 0.28, 1.0);
      roughnessFactor = mix(mix(roughnessFactor, 0.2 + 0.1 * roughnessFactor, gWet), 0.03, gPud);`,
    normal: 'normal = normalize(mix(normal, nonPerturbedNormal, clamp(0.55 * gRub + 0.7 * gPaint, 0.0, 1.0)));' + WET_NORMAL,
    out: 'if (gTun > 0.001) outgoingLight = mix(outgoingLight, diffuseColor.rgb * vec3(2.6, 2.3, 1.8) * (0.72 + 0.28 * cos(vRoad.y * 0.698)), gTun);' + WET_REFLECT,
  });
  photo(asphaltMat, { map: [ASSETS.asphaltDiff, { aniso }], normalMap: [ASSETS.asphaltNor, { aniso, srgb: false }], roughnessMap: [ASSETS.asphaltRough, { aniso, srgb: false }] });
  loadTexture(ASSETS.asphaltOld, { aniso }).then((t) => { if (t) oldU.value = t; });
  loadTexture(ASSETS.asphaltDiff, { aniso }).then((t) => { if (t) { avgU.value = 0.062; asphaltMat.roughness = 1; asphaltMat.normalScale.set(0.9, 0.9); } });
  {
    const g = strip(track, ksRoad, (i, o) => { o.push(-hwA[i], track.z[i], 0, hwA[i], track.z[i], 0); }, { uMetric: 4.2, vScale: 4.2, rub });
    add(g, asphaltMat);
  }

  const concreteFallback = TX.concreteTexture(aniso);
  // ---- kerbs: painted concrete blocks, striped in the shader so the edges stay crisp ----
  // Two types (flat painted kerb, taller serrated rumble kerb) in the circuit's colours; behind
  // them aprons of astro-turf or green paint, and yellow sausage kerbs where the real corner has them.
  {
    const kA = KERB_COLOURS.map(c => new THREE.Vector3(...c[1])), kB = KERB_COLOURS.map(c => new THREE.Vector3(...c[2]));
    const kerbMat = patch(new THREE.MeshStandardMaterial({ map: concreteFallback, roughness: 0.62 }), 'kerb', {
      ...AUX_V, uniforms: { uKA: { value: kA }, uKB: { value: kB } }, fpars: AUX_F + ` uniform vec3 uKA[${kA.length}]; uniform vec3 uKB[${kB.length}];`,
      color: `{
        vec2 m = vRoad.xy; float c = lum(diffuseColor.rgb);
        int ki = int(vAuxF.x + 0.5); float rumble = step(${SX.RUMBLE.toFixed(1)} - 0.5, vAuxF.y);
        float q = m.y / mix(1.6, 1.0, rumble), f = fract(q), aa = fwidth(q);
        float blk = smoothstep(0.5 - aa, 0.5 + aa, f) * (1.0 - smoothstep(1.0 - aa, 1.0, f)) + (1.0 - smoothstep(0.0, aa, f));
        vec3 paint = mix(uKA[ki], uKB[ki], clamp(blk, 0.0, 1.0));
        float chip = smoothstep(0.6, 0.72, vnoise(m * vec2(46.0, 23.0)) * 0.45 + vnoise(m * vec2(9.0, 4.0)) * 0.35 + vnoise(m * vec2(1.6, 0.5)) * 0.3 - 0.06);
        vec3 alb = mix(paint, vec3(0.33, 0.32, 0.3), chip * 0.3) * (0.72 + 0.6 * c);
        float d = abs(m.x) - vRoad.w;                                            // distance onto the kerb
        float scuff = smoothstep(0.75, 0.05, d) * vnoise(vec2(m.x * 3.0, m.y / 6.0)) * (0.4 + 0.6 * vRub);
        alb *= 1.0 - 0.6 * scuff;
        alb *= 0.6 + 0.4 * smoothstep(0.0, 0.03, min(f, 1.0 - f) * 1.6);          // joints between blocks
        // serrations of a rumble kerb: saw-tooth ridges across the direction of travel
        float sr = fract(m.y / 0.16); alb *= 1.0 - rumble * 0.35 * smoothstep(0.55, 1.0, sr) * smoothstep(60.0, 20.0, vViewPosition.z);
        diffuseColor.rgb = alb;
      }`,
      wet: [0.66, 0.14],
    });
    photo(kerbMat, { map: [ASSETS.concrete, { aniso }] });
    const geos = [];
    for (const side of [1, -1]) {
      const A = SD[side];
      const g = strip(track, ksRoad, (i, o) => {
        const h = hwA[i], z = track.z[i], r = A.kerb[i] === SX.RUMBLE ? 1.9 : 1;      // rumble kerbs stand taller with a steeper back
        o.push(side * (h - 0.02), z + 0.003, 0, side * (h + KW * (r > 1 ? 0.6 : 0.45)), z + 0.05 * r, 0.5, side * (h + KW * 0.9), z + 0.035 * r, 0.9, side * (h + KW), z - 0.01, 1);
      }, { mask: i => A.kerb[i], vScale: 1.3, flip: side < 0, uMetric: 1.3, rub, aux: i => [A.col[i], A.kerb[i]] });
      if (g) geos.push(g);
    }
    if (geos.length) add(mergeGeometries(geos), kerbMat);

    // aprons: astro-turf (bright synthetic green) or green-painted asphalt behind the kerb
    const apronMat = patch(new THREE.MeshStandardMaterial({ map: concreteFallback, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), 'apron', {
      ...AUX_V, fpars: AUX_F,
      color: `{
        vec2 m = vRoad.xy; float astro = step(${SX.ASTRO.toFixed(1)} - 0.5, vAuxF.x);
        float fib = vnoise(m * vec2(60.0, 9.0)) * 0.6 + vnoise(m * vec2(7.0, 1.3)) * 0.4;
        vec3 turf = vec3(0.03, 0.2, 0.045) * (0.7 + 0.6 * fib);
        float wear = smoothstep(0.55, 0.8, vnoise(m * vec2(1.1, 0.12)) * 0.7 + vnoise(m * vec2(9.0, 2.0)) * 0.3);
        vec3 pnt = mix(vec3(0.02, 0.15, 0.06), vec3(0.2, 0.2, 0.2) * (0.5 + lum(diffuseColor.rgb)), wear * 0.55) * (0.8 + 0.4 * lum(diffuseColor.rgb));
        diffuseColor.rgb = mix(pnt, turf, astro);
      }`,
      rough: `roughnessFactor = mix(0.5, 0.98, step(${SX.ASTRO.toFixed(1)} - 0.5, vAuxF.x));`,
      wet: [0.7, 0.2],
    });
    const sausMat = wettable(patch(new THREE.MeshStandardMaterial({ color: 0xe8b800, roughness: 0.55 }), 'sausage', {
      ...ROAD_V, fpars: 'varying vec4 vRoad; varying float vRub;',
      color: `{
        vec2 m = vRoad.xy; float f = fract(m.y / 2.0);
        diffuseColor.rgb *= 0.55 + 0.45 * smoothstep(0.0, 0.03, min(f, 1.0 - f));                 // joints between 2 m sections
        diffuseColor.rgb *= 1.0 - 0.55 * smoothstep(0.45, 0.75, vnoise(m * vec2(5.0, 1.4)));       // tyre scuffs and chipped paint
      }` }), 0.3);
    const ap = [], sa = [];
    for (const side of [1, -1]) {
      const A = SD[side];
      ap.push(strip(track, ksRoad, (i, o) => { const e = A.edge[i], z = track.z[i]; o.push(side * (e - 0.03), z - 0.006, 0, side * (e + A.apronW[i]), z - 0.012, 1); },
        { mask: i => A.apron[i] === SX.ASTRO || A.apron[i] === SX.PAINT, vScale: 1.5, flip: side < 0, uMetric: 1.5, rub, aux: i => [A.apron[i], 0] }));
      sa.push(strip(track, ksRoad, (i, o) => {
        const e = A.edge[i] + 0.04, w = A.apronW[i] - 0.08, z = track.z[i] - 0.02;
        for (let k = 0; k <= 6; k++) { const a = k / 6 * Math.PI; o.push(side * (e + w * (0.5 - 0.5 * Math.cos(a))), z + 0.02 + 0.13 * Math.pow(Math.sin(a), 0.7), k / 6); }
      }, { mask: i => A.apron[i] === SX.SAUSAGE, vScale: 1, flip: side < 0, rub }));
    }
    const mg = (l) => { const k = l.filter(Boolean); return k.length ? mergeGeometries(k) : null; };
    add(mg(ap), apronMat); add(mg(sa), sausMat, { cast: true });
  }

  // ---- verges: grass run-off and gravel traps ------------------------------
  const grassFallback = TX.grassTexture(aniso);
  const GROUND_F = `
    vec3 groundAlbedo(sampler2D tex, vec2 uvm, vec3 near){
      vec3 far = texture2D(tex, uvm / 31.0 + 0.19).rgb, mid = texture2D(tex, uvm.yx / 9.0 + 0.6).rgb;
      float fade = smoothstep(25.0, 140.0, vViewPosition.z);                      // detail gives way to tone with distance
      vec3 c = mix(near, mid, 0.15 + 0.6 * fade) * mix(1.0, lum(far) / 0.075, 0.55);
      return c * vec3(${theme.ground.map(v => v.toFixed(3)).join(', ')});
    }`;
  const grassMat = patch(new THREE.MeshStandardMaterial({ map: grassFallback, roughness: 0.95, normalScale: new THREE.Vector2(1.2, 1.2) }), 'verge' + (track.theme || ''), {
    ...ROAD_V, fpars: 'varying vec4 vRoad; varying float vRub;' + GROUND_F,
    color: `{
      vec2 m = vRoad.xy; float d = abs(m.x) - vRoad.w;                           // metres outside the track edge
      vec3 alb = groundAlbedo(map, m, diffuseColor.rgb);
      // mower stripes run with the track
      float q = d / 2.4, aa = fwidth(q) * 1.5, f = abs(fract(q) - 0.5);
      alb *= 0.93 + 0.14 * smoothstep(0.25 - aa, 0.25 + aa, f);
      alb *= 0.8 + 0.42 * vnoise(vec2(m.x / 7.0, m.y / 33.0));
      // drier, yellower patches and a worn dirt strip where cars drop wheels
      float dry = smoothstep(0.5, 0.8, vnoise(vec2(m.x / 3.0 + 5.0, m.y / 14.0)));
      alb = mix(alb, lum(alb) * vec3(1.75, 1.5, 0.75), dry * 0.18);
      float worn = smoothstep(1.5, 0.1, d + 1.1 * vnoise(vec2(m.x * 0.8, m.y / 5.0)));
      alb = mix(alb, vec3(0.2, 0.165, 0.11) * (0.6 + 6.0 * lum(alb)), worn * 0.7);
      diffuseColor.rgb = alb * mix(1.0, 0.55, worn * uWet);                       // the worn strip turns to mud
    }`,
    wet: [0.74, 0.58],
  });
  photo(grassMat, { map: [ASSETS.grassDiff, { aniso }], normalMap: [ASSETS.grassNor, { aniso, srgb: false }] });
  // Gravel beds: granular photo texture, raked furrows parallel to the road, a dark kerbed edge,
  // a few ruts where cars have gone in. vAux = (start, end) of the bed in metres from the centreline.
  const gravelMat = patch(new THREE.MeshStandardMaterial({ map: TX.gravelTexture(aniso), roughness: 0.95, color: 0xcfc3ad, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 'gravel', {
    ...AUX_V, fpars: AUX_F,
    color: `{
      vec2 m = vRoad.xy; float d = abs(m.x) - vAux.x, w = vAux.y - vAux.x, e = min(d, w - d);
      vec3 far = texture2D(map, m / 13.0 + 0.3).rgb;
      diffuseColor.rgb *= mix(1.0, lum(far) / 0.55, 0.5) * (0.86 + 0.24 * vnoise(vec2(m.x / 2.5, m.y / 11.0)));
      // raked furrows running along the trap (fade out with distance: they would alias)
      float rk = sin(d * 14.0 + 1.5 * vnoise(vec2(d * 0.7, m.y * 0.15)));
      diffuseColor.rgb *= 1.0 - 0.11 * rk * smoothstep(70.0, 15.0, vViewPosition.z);
      // ruts dug by cars: they enter at a shallow angle from the road side
      float rut = smoothstep(0.86, 0.93, vnoise(vec2((m.y - d * 3.2) / 9.0, 7.3)) ) * smoothstep(0.35, 0.0, abs(fract((m.y - d * 3.2) / 1.7 + vnoise(vec2(m.y / 30.0, 1.0))) - 0.5)) * smoothstep(w * 0.75, 0.0, d);
      diffuseColor.rgb *= 1.0 - 0.3 * rut;
      // clean edge: a darker settled margin, then the concrete edging strip
      diffuseColor.rgb *= 0.8 + 0.2 * smoothstep(0.0, 0.9, e);
      diffuseColor.rgb = mix(vec3(0.42, 0.41, 0.39) * (0.7 + 0.5 * lum(far)), diffuseColor.rgb, smoothstep(0.1, 0.16, e));
    }`,
    wet: [0.58, 0.62],
  });
  photo(gravelMat, { map: [ASSETS.gravelDiff, { aniso }], normalMap: [ASSETS.gravelNor, { aniso, srgb: false }] });
  // street circuits: paving slabs instead of grass
  const paveMat = patch(new THREE.MeshStandardMaterial({ map: concreteFallback, roughness: 0.85 }), 'pave', {
    ...ROAD_V, fpars: 'varying vec4 vRoad; varying float vRub; varying vec3 vWPos;',
    normal: WET_NORMAL, out: WET_REFLECT,
    rough: 'roughnessFactor = mix(mix(roughnessFactor, 0.34, gWet), 0.04, gPud);',
    color: `{
      vec2 m = vRoad.xy; float d = abs(m.x) - vRoad.w;
      vec3 alb = diffuseColor.rgb * (0.62 + 0.25 * vnoise(vec2(m.x / 3.0, m.y / 9.0)));
      vec2 sl = vec2(d / 0.6, m.y / 0.9), sf = abs(fract(sl) - 0.5);
      alb *= 0.72 + 0.28 * smoothstep(0.47, 0.44, max(sf.x, sf.y));           // slab joints
      alb *= 0.9 + 0.2 * hash12(floor(sl));
      alb = mix(alb, vec3(0.5, 0.5, 0.48), smoothstep(0.32, 0.28, d) * 0.6);   // kerb stone
      alb *= 1.0 - 0.3 * smoothstep(0.5, 0.0, d) * vnoise(vec2(m.x * 4.0, m.y / 3.0));
      gWet = uWet; gPud = uPuddle * uWet * smoothstep(0.58, 0.7, vnoise(m * vec2(0.5, 0.21) + 9.0) * 0.7 + vnoise(m * 1.7) * 0.3);
      alb *= mix(1.0, 0.52, gWet); alb = mix(alb, alb * vec3(0.5, 0.54, 0.6), gPud);
      diffuseColor.rgb = alb;
    }`,
  });
  photo(paveMat, { map: [ASSETS.concrete, { aniso }] });
  const vergeMat = urban ? paveMat : grassMat;
  // Paved run-off: older, dustier asphalt with no racing line, tyre marks from cars that ran wide;
  // painted areas get broad coloured stripes. vAuxF.x = surface id.
  const runoffMat = patch(new THREE.MeshStandardMaterial({ map: aspFallback.map, normalMap: aspFallback.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 'runoff', {
    ...AUX_V, fpars: AUX_F,
    color: `{
      vec2 m = vRoad.xy; float d = abs(m.x) - vRoad.w;
      vec3 a2 = texture2D(map, m.yx / 19.0 + 0.11).rgb;
      vec3 alb = diffuseColor.rgb * mix(1.0, lum(a2) / 0.066, 0.6);
      alb = mix(vec3(lum(alb)), alb, 0.5) * 1.22 + vec3(0.01, 0.008, 0.005);         // paler and dustier than the racing surface
      alb *= 0.9 + 0.2 * vnoise(vec2(m.x / 5.0, m.y / 40.0));
      // paving lanes parallel to the road and their joints
      float lane = abs(fract(d / 4.5) - 0.5) * 4.5; alb *= 0.8 + 0.2 * smoothstep(0.0, 0.05, 2.25 - lane);
      // black lines from locked wheels: long streaks heading away from the road at a shallow angle
      float su = (m.y - d * (3.0 + 2.0 * vnoise(vec2(m.y / 70.0, 5.0)))) ;
      float sk = smoothstep(0.9, 0.96, vnoise(vec2(su / 11.0, 3.1))) * smoothstep(0.12, 0.03, abs(fract(su / 1.7) - 0.5)) * (0.4 + 0.6 * vnoise(vec2(d / 6.0, su / 3.0))) * smoothstep(0.0, 3.0, d);
      alb *= 1.0 - 0.55 * sk;
      if (vAuxF.x > ${SX.PAINT.toFixed(1)} - 0.5 && vAuxF.x < ${SX.PAINT.toFixed(1)} + 0.5) {
        float st = step(0.5, fract((m.y + d * 0.6) / 5.0));
        vec3 pc = mix(vec3(0.03, 0.09, 0.4), vec3(0.45, 0.03, 0.03), step(18.0, d));
        alb = mix(alb, pc * (0.6 + 6.0 * lum(alb)), st * 0.8);
      }
      // white line where the paved area meets the grass verge is left to the road's own edge line
      diffuseColor.rgb = alb;
    }`,
    wet: [0.55, 0.28],
  });
  photo(runoffMat, { map: [ASSETS.asphaltOld, { aniso }], normalMap: [ASSETS.asphaltNor, { aniso, srgb: false }] });
  for (const side of [1, -1]) {
    const A = SD[side];
    const inner = i => A.edge[i] - (A.kerb[i] ? 0.02 : 0.01);
    // base layer: grass (paving on street circuits) from the track edge to the barrier
    add(strip(track, ksEdge, (i, o) => {
      const z = track.z[i], a = inner(i), b = Math.max(a + 0.2, wallAt(side, i)), mid = a + Math.min(1.2, (b - a) * 0.5);
      if (urban) o.push(side * a, z - 0.004, 0, side * (a + 0.03), z + 0.11, 0, side * b, z + 0.11, 0);      // raised pavement
      else o.push(side * a, z - 0.004, 0, side * mid, z - 0.018, 0, side * b, z - 0.05, 0);
    }, { uMetric: 2.3, vScale: 2.3, flip: side < 0, rub, mask: mc ? (i) => !mc.inTun(i) : track.deck ? (i) => !track.deck[i] : null }), vergeMat);
    // paved run-off from roA to the barrier (level with the pavement on street circuits)
    const up = urban ? 0.125 : 0;
    add(strip(track, ksEdge, (i, o) => { const z = track.z[i] + up, a = A.roA[i], b = Math.max(a + 0.1, wallAt(side, i)); o.push(side * a, z - 0.008, 0, side * (a + b) / 2, z - 0.016, 0, side * b, z - 0.03, 0); },
      { uMetric: 4.2, vScale: 4.2, flip: side < 0, mask: i => A.ro[i] && wallAt(side, i) - A.roA[i] > 0.6, rub, aux: i => [A.ro[i], 0] }), runoffMat);
    // gravel bed gA..gB, slightly dished
    add(strip(track, ksEdge, (i, o) => { const z = track.z[i], a = A.gA[i], b = A.gB[i]; o.push(side * a, z - 0.012, 0, side * (a + Math.min(1.5, (b - a) / 3)), z - 0.05, 0, side * (b - Math.min(1.5, (b - a) / 3)), z - 0.05, 0, side * b, z - 0.02, 0); },
      { uMetric: 1.7, vScale: 1.7, flip: side < 0, mask: i => A.gB[i] > 0, rub, aux: i => [A.gA[i], A.gB[i]] }), gravelMat);
  }

  // ---- barriers -------------------------------------------------------------
  // Per sample and side (track.barL/R): armco, a conveyor-belted tyre wall in front of a
  // concrete wall, a bare concrete wall, or TecPro blocks.
  {
    const armcoMat = wettable(new THREE.MeshStandardMaterial({ map: TX.armcoTexture(aniso), roughness: 0.42, metalness: 0.82, side: THREE.DoubleSide, envMapIntensity: 0.9 }), 0.45);
    const tyreMat = wettable(new THREE.MeshStandardMaterial({ map: TX.tyreWallTexture(aniso), roughness: 0.88, side: THREE.DoubleSide }), 0.6);
    const fenceMat = new THREE.MeshStandardMaterial({ map: TX.fenceTexture(aniso), transparent: true, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.02 });
    // conveyor belting bolted across the face of the tyres: dark rubber sheets, seams, a painted band
    const beltMat = wettable(patch(new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.8, side: THREE.DoubleSide }), 'belt', {
      vpars: ROAD_V.vpars + ' varying float vU;', vmain: ROAD_V.vmain + ' vU = uv.x;', fpars: 'varying vec4 vRoad; varying float vRub; varying float vU;',
      color: `{
        float y = vU, sl = vRoad.y / 3.2, f = fract(sl);
        vec3 c = vec3(0.045) * (0.75 + 0.5 * vnoise(vec2(vRoad.y * 0.7, y * 9.0)));
        c *= 0.45 + 0.55 * smoothstep(0.0, 0.012, min(f, 1.0 - f));                                   // seam between sheets
        c = mix(c, vec3(0.62, 0.62, 0.6), step(0.68, y) * step(y, 0.86) * (0.75 + 0.25 * vnoise(vec2(vRoad.y * 2.0, 3.0))));   // white band
        float bolt = step(length(vec2(fract(vRoad.y / 0.8) - 0.5, (y - 0.93) * 1.2)) , 0.045) + step(length(vec2(fract(vRoad.y / 0.8) - 0.5, (y - 0.08) * 1.2)), 0.045);
        c = mix(c, vec3(0.3), clamp(bolt, 0.0, 1.0));
        c *= 1.0 - 0.5 * smoothstep(0.55, 0.8, vnoise(vec2(vRoad.y / 2.3, y * 2.0 + 4.0))) * step(y, 0.66);    // scrapes
        diffuseColor.rgb = c;
      }` }), 0.4);
    // TecPro: interlocking plastic blocks, red and grey
    const tecMat = wettable(patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide }), 'tecpro', {
      vpars: ROAD_V.vpars + ' varying float vU;', vmain: ROAD_V.vmain + ' vU = uv.x;', fpars: 'varying vec4 vRoad; varying float vRub; varying float vU;',
      color: `{
        float q = vRoad.y / 1.5, f = fract(q), y = vU;
        vec3 c = mix(vec3(0.5, 0.03, 0.03), vec3(0.42, 0.43, 0.45), step(0.5, fract(floor(q) * 0.5)));
        c *= 0.35 + 0.65 * smoothstep(0.0, 0.03, min(f, 1.0 - f));                                    // gaps between blocks
        c *= 0.8 + 0.2 * smoothstep(0.0, 0.06, abs(y - 0.5));                                         // strap groove
        c *= 0.85 + 0.25 * vnoise(vec2(vRoad.y * 1.3, y * 5.0));
        diffuseColor.rgb = c;
      }` }), 0.3);
    const beams = quality.detail > 0 ? 3 : 2, bh = 0.31, top = 0.06 + beams * (bh + 0.012);
    const armGeo = [], tyreGeo = [], fenceGeo = [], beltGeo = [], wallGeo = [], tecGeo = [];
    const tyresOn = (side, i) => barAt(side, i) === BAR.TYRES, wallOn = (side, i) => barAt(side, i) === BAR.WALL || barAt(side, i) === BAR.TYRES;
    // debris fence where spectators would be: around the pits and on the outside of fast corners
    const fenceOn = (side, i) => {
      if (mc?.inTun(i)) return false;
      const dPit = Math.min(i, n - i) * track.ds;
      if (dPit < 330 || urban || barAt(side, i) === BAR.WALL) return true;
      if (quality.detail < 1) return false;
      return vnoise(i * track.ds / 420 + (side > 0 ? 17 : 91), 0.5) > 0.56;
    };
    const TH = 1.02;      // height of a tyre stack
    for (const side of [1, -1]) {
      armGeo.push(strip(track, ksEdge, (i, o) => {
        const w = wallAt(side, i), z = track.z[i] - 0.04;
        o.push(side * w, z, 0);
        for (let b = 0; b < beams; b++) {
          const y = z + 0.06 + b * (bh + 0.012), u0 = b / beams, du = 1 / beams;
          o.push(side * w, y, u0 + 0.02 * du, side * (w - 0.075), y + 0.085, u0 + 0.28 * du, side * (w - 0.075), y + bh - 0.085, u0 + 0.72 * du, side * w, y + bh, u0 + 0.98 * du);
        }
        o.push(side * (w + 0.11), z + top, 1, side * (w + 0.11), z, 1);     // posts side: closes the section from behind
      }, { mask: i => barAt(side, i) === BAR.ARMCO && !mc?.inTun(i), vScale: 4, flip: side > 0 }));
      // belting: the face of the tyre wall up to just below the top tyres, folded back over them
      beltGeo.push(strip(track, ksEdge, (i, o) => { const w = wallAt(side, i), z = track.z[i] - 0.05; o.push(side * (w - 0.74), z, 0, side * (w - 0.74), z + TH * 0.82, 0.9, side * (w - 0.7), z + TH * 0.86, 1); },
        { mask: i => tyresOn(side, i), vScale: 1, flip: side > 0 }));
      if (quality.detail < 1) {
        // low detail: the tyres are a textured strip
        tyreGeo.push(strip(track, ksEdge, (i, o) => {
          const w = wallAt(side, i), z = track.z[i] - 0.04, rows = 5, rh = TH / 5;
          for (let r = 0; r < rows; r++) { const y = z + r * rh, u0 = r / rows * 0.86, du = 0.86 / rows; o.push(side * (w - 0.5), y, u0, side * (w - 0.62), y + rh * 0.3, u0 + du * 0.3, side * (w - 0.62), y + rh * 0.7, u0 + du * 0.7); }
          o.push(side * (w - 0.5), z + rows * rh, 0.86, side * (w + 0.1), z + rows * rh, 1);
        }, { mask: i => tyresOn(side, i), vScale: 1.24, flip: side > 0 }));
      }
      // concrete wall: behind the tyres, or on its own (pit walls, street circuits)
      wallGeo.push(strip(track, ksEdge, (i, o) => { const w = wallAt(side, i), z = track.z[i], t = tyresOn(side, i) ? 0.1 : -0.12; o.push(side * (w + t), z - 0.05, 0, side * (w + t), z + 1.2, 0.5, side * (w + t + 0.28), z + 1.2, 0.6, side * (w + t + 0.28), z - 0.3, 1); },
        { mask: i => wallOn(side, i), vScale: 3, flip: side > 0 }));
      tecGeo.push(strip(track, ksEdge, (i, o) => { const w = wallAt(side, i), z = track.z[i] - 0.05; o.push(side * (w - 0.3), z, 0, side * (w - 0.34), z + 0.5, 0.5, side * (w - 0.3), z + 1.0, 1, side * (w + 0.3), z + 1.0, 1, side * (w + 0.3), z, 0); },
        { mask: i => barAt(side, i) === BAR.TECPRO, vScale: 1, flip: side > 0 }));
      fenceGeo.push(strip(track, ksEdge, (i, o) => { const w = wallAt(side, i) + 0.75, z = track.z[i]; o.push(side * w, z + 0.2, 0, side * w, z + 3.3, 0.86, side * (w - 0.55), z + 3.85, 1); },
        { mask: i => fenceOn(side, i), vScale: 3, flip: side > 0 }));
    }
    const merge = (list) => { const l = list.filter(Boolean); return l.length ? mergeGeometries(l) : null; };
    add(merge(armGeo), armcoMat, { cast: true });
    add(merge(tyreGeo), tyreMat, { cast: true });
    add(merge(beltGeo), beltMat, { cast: true });
    add(merge(tecGeo), tecMat, { cast: true });
    const wallMat = wettable(new THREE.MeshStandardMaterial({ map: concreteFallback, roughness: 0.85, color: 0xd9d9d6 }), 0.55); photo(wallMat, { map: [ASSETS.concrete, { aniso }] });
    add(merge(wallGeo), wallMat, { cast: true });
    const fence = add(merge(fenceGeo), fenceMat, { receive: false }); if (fence) { fence.renderOrder = 5; skipOverride(fence); }

    // the tyres themselves: instanced stacks standing behind the belting (the top two tyres show above it)
    if (quality.detail > 0) {
      const prof = []; for (const y0 of [TH - 0.42, TH - 0.21]) prof.push(new THREE.Vector2(0.2, y0), new THREE.Vector2(0.3, y0 + 0.015), new THREE.Vector2(0.325, y0 + 0.105), new THREE.Vector2(0.3, y0 + 0.195), new THREE.Vector2(0.2, y0 + 0.21));
      const stackG = new THREE.LatheGeometry(prof, quality.detail > 1 ? 12 : 8);
      const rubber = wettable(new THREE.MeshStandardMaterial({ color: 0x9a9a9a, map: TX.tyreWallTexture(aniso), roughness: 0.9 }), 0.5);
      const CH = 360, nCh = Math.max(1, Math.ceil(track.length / CH)), chunks = Array.from({ length: nCh }, () => []);
      const pitch = 0.66;
      for (const side of [1, -1]) {
        let carry = 0;
        for (let i = 0; i < n; i++) {
          if (!tyresOn(side, i)) { carry = 0; continue; }
          const j = (i + 1) % n, h = track.heading[i];
          for (; carry < track.ds; carry += pitch) {
            const f = carry / track.ds, off = side * ((wallAt(side, i) + (wallAt(side, j) - wallAt(side, i)) * f) - 0.4);
            chunks[Math.min(nCh - 1, Math.floor(i * track.ds / CH))].push(track.x[i] + (track.x[j] - track.x[i]) * f - Math.sin(h) * off, track.z[i] + (track.z[j] - track.z[i]) * f - 0.05, track.y[i] + (track.y[j] - track.y[i]) * f + Math.cos(h) * off);
          }
          carry -= track.ds;
        }
      }
      const m4 = new THREE.Matrix4(), cc = new THREE.Color();
      for (const list of chunks) {
        if (!list.length) continue;
        const im = new THREE.InstancedMesh(stackG, rubber, list.length / 3);
        for (let k = 0; k < list.length / 3; k++) {
          im.setMatrixAt(k, m4.makeRotationY(hash2(k, 7) * 6.28).setPosition(list[k * 3], list[k * 3 + 1], -list[k * 3 + 2]));
          const v = 0.75 + 0.5 * hash2(k, 3); im.setColorAt(k, cc.setRGB(v, v, v));
        }
        im.castShadow = false; im.receiveShadow = true; im.computeBoundingSphere(); im.computeBoundingBox(); group.add(im);
      }
    }
  }

  // ---- crossover bridge deck: slab under the upper road, where verge and terrain are left out ----
  if (track.deck) {
    const g = strip(track, ksRoad, (i, o) => { const z = track.z[i], l = track.wallL[i] + 0.3, r = track.wallR[i] + 0.3; o.push(l, z + 0.9, 0, l, z - 0.9, 0.2, -r, z - 0.9, 0.8, -r, z + 0.9, 1); }, { mask: i => track.deck[i], vScale: 3 });
    const top = strip(track, ksRoad, (i, o) => { const z = track.z[i] - 0.03; o.push(-track.wallR[i] - 0.3, z, 0, track.wallL[i] + 0.3, z, 1); }, { mask: i => track.deck[i], vScale: 3, flip: true });
    const bm = new THREE.MeshStandardMaterial({ map: concreteFallback, color: 0xb9b9b4, roughness: 0.9, side: THREE.DoubleSide });
    add(g, bm, { cast: true }); add(top, bm);
  }

  // ---- bridges over the track (visual only) ----------------------------------------
  if (track.bridges?.length) {
    const steelB = wettable(new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.55, metalness: 0.5 }), 0.4), deckB = wettable(new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.8 }), 0.4);
    for (const br of track.bridges) {
      const i = Math.round(br.s / track.ds) % n, h = track.heading[i], z = track.z[i], l = track.wallL[i] + 2.5, r = track.wallR[i] + 2.5, span = l + r, mid = (l - r) / 2;
      const g = new THREE.Group(); g.position.set(track.x[i] - Math.sin(h) * mid, z, -(track.y[i] + Math.cos(h) * mid)); g.rotation.y = h;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, span + 3), deckB); deck.position.y = 6.2; g.add(deck);
      for (const e of [1.5, -1.5]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.5, span + 3), steelB); rail.position.set(e, 7.2, 0); g.add(rail); }
      for (const e of [1, -1]) { const tw = new THREE.Mesh(new THREE.BoxGeometry(3.6, 7.6, 3), steelB); tw.position.set(0, 3.3, e * (span / 2 + 0.6)); g.add(tw); }
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(span - 2, 22), 1.5), new THREE.MeshStandardMaterial({ map: TX.labelTexture((track.name.split(' ').slice(-2).join(' ')).toUpperCase(), { w: 1024, h: 96, bg: '#12324f', fg: '#f4f4f4', font: 'bold 64px sans-serif' }), roughness: 0.6 }));
      sign.rotation.y = -Math.PI / 2; sign.position.set(-1.62, 6.9, 0); g.add(sign);
      g.traverse(o => { if (o.isMesh) { o.castShadow = quality.shadows; o.receiveShadow = true; } });
      group.add(g);
    }
  }

  // ---- terrain ---------------------------------------------------------------
  // A coarse landscape grid plus a corridor of finer ground that follows the
  // circuit, so the cost grows with track length rather than with the area the
  // circuit happens to enclose.
  const fbias = FOREST_BIAS[track.id] ?? 0;
  const forestAt = (X, Y) => smooth(0.42, 0.6, vnoise(X / 270 + 40, Y / 270 + 40) * 0.8 + vnoise(X / 75 + 3, Y / 75 + 8) * 0.3 + fbias);
  const tint = (X, Y, h, out) => {
    const n1 = vnoise(X / 60, Y / 60), n2 = vnoise(X / 9, Y / 9), fld = vnoise(X / 190 + 9, Y / 190 + 4), f = forestAt(X, Y);
    const rock = smooth(70, 150, h - zMean) * (0.5 + 0.5 * n1);
    const dry = 0.78 + 0.34 * n1 + 0.12 * n2;
    const crop = smooth(0.58, 0.63, fld) * (1 - f) * theme.crop;                                   // cut hay / crop fields
    let r = dry * (1 + 0.75 * crop), g = dry * (1 + 0.38 * crop), b = dry * (1 - 0.25 * crop);
    const fd = 1 - 0.62 * f; r *= fd * (1 - 0.1 * f); g *= fd; b *= fd * (1 - 0.15 * f);     // forest floor / canopy tone
    out.push(r * (1 - rock) + 1.9 * rock, g * (1 - rock) + 1.5 * rock, b * (1 - rock) + 2.2 * rock);
  };
  // streets and squares between the buildings: warm paving, darker tarmac patches, the odd garden
  const tintUrban = (X, Y, h, out) => { const v = 0.34 + 0.2 * vnoise(X / 23, Y / 23) + 0.1 * vnoise(X / 4, Y / 4), gdn = smooth(0.66, 0.72, vnoise(X / 55 + 9, Y / 55 + 2)); out.push(v * (1 - 0.55 * gdn), v * (0.96 - 0.2 * gdn), v * (0.88 - 0.6 * gdn)); };
  let zMean = 0; for (let i = 0; i < n; i++) zMean += track.z[i] / n;
  const terrainMat = patch(new THREE.MeshStandardMaterial({ map: grassFallback, vertexColors: true, roughness: 0.96 }), 'terrain' + (track.theme || ''), {
    vpars: 'varying vec2 vWxz;', vmain: 'vWxz = (modelMatrix * vec4(position, 1.0)).xz;',
    fpars: 'varying vec2 vWxz;' + GROUND_F,
    color: 'diffuseColor.rgb = groundAlbedo(map, vWxz, diffuseColor.rgb);',
    wet: [0.76, 0.62],
  });
  photo(terrainMat, { map: [ASSETS.grassDiff, { aniso }], normalMap: [ASSETS.grassNor, { aniso, srgb: false }] });
  let groundH;
  if (mc) groundH = (X, Y, t = terrain(X, Y)) => t.h;
  else {
    const g = track.grid, pad = 1700;
    const x0 = g.minX - pad, y0 = g.minY - pad, x1 = g.maxX + pad, y1 = g.maxY + pad;
    const cell = Math.max(14, Math.min(40, Math.sqrt((g.maxX - g.minX) * (g.maxY - g.minY) / 26000)));
    const axis = (a, b, lo, hi) => { const out = []; let v = a; while (v < b) { out.push(v); const far = v < lo ? lo - v : v > hi ? v - hi : 0; v += cell + far * 0.1; } out.push(b); return out; };
    const xs = axis(x0, x1, g.minX + 60, g.maxX - 60), ys = axis(y0, y1, g.minY + 60, g.maxY - 60), NX = xs.length, NY = ys.length;
    const H0 = new Float32Array(NX * NY), pos = new Float32Array(NX * NY * 3), col = [], uv = new Float32Array(NX * NY * 2);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const X = xs[i], Y = ys[j], t = terrain(X, Y), k = j * NX + i;
      H0[k] = t.h;
      // under the corridor the coarse grid is dropped out of sight
      pos[k * 3] = X; pos[k * 3 + 1] = t.h - (t.dist < t.corr + 30 ? 30 : 0); pos[k * 3 + 2] = -Y;
      uv[k * 2] = X / 2.3; uv[k * 2 + 1] = Y / 2.3;
      tint(X, Y, t.h, col);
    }
    const idx = [];
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, d = a + NX, e = d + 1; idx.push(a, b, d, b, e, d); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    add(geo, terrainMat);
    // exact height of the coarse (undropped) grid at any point
    const find = (arr, v) => { let lo = 0, hi = arr.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= v) lo = m; else hi = m - 1; } return lo; };
    const coarseH = (X, Y) => {
      const i = find(xs, X), j = find(ys, Y), fx = Math.min(1, Math.max(0, (X - xs[i]) / (xs[i + 1] - xs[i]))), fy = Math.min(1, Math.max(0, (Y - ys[j]) / (ys[j + 1] - ys[j])));
      const a = H0[j * NX + i], b = H0[j * NX + i + 1], d = H0[(j + 1) * NX + i], e = H0[(j + 1) * NX + i + 1];
      return fx + fy <= 1 ? a + (b - a) * fx + (d - a) * fy : e + (d - e) * (1 - fx) + (b - e) * (1 - fy);
    };
    // ground height everywhere: true terrain near the circuit, the coarse grid further out
    groundH = (X, Y, t = terrain(X, Y)) => { const w = smooth(38, 62, t.dist - t.corr); return w <= 0 ? t.h : t.h + (coarseH(X, Y) + 0.2 - t.h) * w; };
    const rings = [0, 3, 9, 20, 38, 62, 96];
    const geos = [];
    for (const side of [1, -1]) {
      geos.push(strip(track, ksFar, (i, o) => {
        const w = wallAt(side, i), h = track.heading[i], nx = -Math.sin(h), ny = Math.cos(h);
        o.push(side * (w - 0.3), track.z[i] - 0.05, 0);
        let last = 0;
        for (const r of rings) { const off = side * (w + r + 0.4), X = track.x[i] + nx * off, Y = track.y[i] + ny * off; last = groundH(X, Y); o.push(off, last, 0); }
        o.push(side * (w + 97), last - 6, 0);
      }, { flip: side < 0, mask: track.deck ? (i) => !track.deck[i] : null, color: (X, Y, out) => (urban ? tintUrban : tint)(X, Y, terrain(X, Y).h, out) }));
    }
    const cg = mergeGeometries(geos.filter(Boolean));
    { const p = cg.attributes.position, u = cg.attributes.uv; for (let k = 0; k < p.count; k++) u.setXY(k, p.getX(k) / 2.3, -p.getZ(k) / 2.3); }
    cg.deleteAttribute('aRoad'); cg.deleteAttribute('aRub');
    if (urban) {
      const m = patch(new THREE.MeshStandardMaterial({ map: concreteFallback, vertexColors: true, roughness: 0.9 }), 'uground', {
        vpars: 'varying vec2 vWxz;', vmain: 'vWxz = (modelMatrix * vec4(position, 1.0)).xz;', fpars: 'varying vec2 vWxz;',
        color: 'diffuseColor.rgb *= 0.75 + 0.5 * texture2D(map, vWxz / 37.0).g;', wet: [0.55, 0.3] });
      photo(m, { map: [ASSETS.concrete, { aniso }] }); add(cg, m);
    } else add(cg, terrainMat);
  }

  // ---- trees: photographic impostor cards, instanced in chunks along the circuit --------
  {
    const TILES = [ // [half width, height] as fractions of a square atlas tile, typical height (m), conifer?
      [0.179, 0.984, 19, 1], [0.22, 0.984, 17, 1], [0.254, 0.984, 15, 1], [0.344, 0.984, 9, 1],
      [0.385, 0.984, 11, 0], [0.465, 0.984, 9, 0], [0.492, 0.741, 9, 0], [0.492, 0.937, 16, 1]];
    const rng = new RNG(4242);
    const N = Math.round(Math.min(quality.treeCap, quality.trees * track.length / 1000 * (1 + 1.2 * Math.max(0, fbias))) * (mc ? 0 : urban ? 0.1 : 1) * theme.trees);
    const gap = track.narrow ? 2.4 : 4.5;
    // two crossed quads with soft, outward-leaning normals
    const quad = (ang) => {
      const c = Math.cos(ang), s = Math.sin(ang), g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-c, 0, -s, c, 0, s, c, 1, s, -c, 1, -s], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([-c * 0.7, 0.7, -s * 0.7, c * 0.7, 0.7, s * 0.7, c * 0.5, 0.86, s * 0.5, -c * 0.5, 0.86, -s * 0.5], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]); return g;
    };
    const cardG = mergeGeometries(quality.detail > 0 ? [quad(0), quad(Math.PI / 2)] : [quad(0.4)]);
    const uvPatch = (m) => { m.onBeforeCompile = (sh) => {
      wxUniforms(sh);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aTile;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = aTile.xy + uv * aTile.zw;');
      // keep the soft card normals on both faces, and drop cards seen edge-on
      if (!m.isMeshDepthMaterial) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\nnormal = normalize(vNormal);\n{ vec3 fn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))); if (abs(dot(fn, normalize(vViewPosition))) < 0.3) discard; }');
    }; m.customProgramCacheKey = () => 'tree' + m.type; return m; };
    // stand-in until the atlas has loaded: flat dark-green cards would look worse than nothing
    const treeMat = uvPatch(new THREE.MeshPhysicalMaterial({ roughness: 1, metalness: 0, specularIntensity: 0, alphaTest: 0.42, side: THREE.DoubleSide, visible: false }));
    const depthMat = uvPatch(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.42, side: THREE.DoubleSide }));
    loadTexture(ASSETS.trees, { repeat: false, aniso: 4 }).then((t) => { if (!t) return; treeMat.map = t; depthMat.map = t; treeMat.visible = true; treeMat.needsUpdate = depthMat.needsUpdate = true; });
    const c0 = Math.cos(track.heading[0]), s0 = Math.sin(track.heading[0]);
    const CH = 420, nCh = Math.max(1, Math.ceil(track.length / CH)), chunks = Array.from({ length: nCh }, () => []);
    const reach = quality.detail > 0 ? 85 : 55;
    let placed = 0, guard = 0;
    while (placed < N && guard++ < N * 12) {
      const i = rng.int(n), side = rng.next() < 0.5 ? 1 : -1, u = rng.next();
      const off = wallAt(side, i) + gap + reach * Math.pow(u, track.narrow ? 2.4 : 1.8);
      const h = track.heading[i], X = track.x[i] - Math.sin(h) * off * side, Y = track.y[i] + Math.cos(h) * off * side;
      const t = terrain(X, Y);
      if (t.dist < t.corr + 3.5) continue;                       // inside some other part of the circuit
      if (t.sea > 0) continue;                                    // in the harbour
      const f = forestAt(X, Y);
      if (rng.next() > (urban ? 0.5 : 0.07 + 0.93 * f)) continue;
      if (urban && off < wallAt(side, i) + 60) continue;
      // keep the main-straight facilities clear
      { const dx = X - track.x[0], dy = Y - track.y[0], lx = dx * c0 + dy * s0, ly = -dx * s0 + dy * c0; if (lx > -230 && lx < 190 && ly > -75 && ly < 75) continue; }
      const conifer = theme.conifer ?? (!urban && vnoise(X / 210 + 1.5, Y / 210 + 6.5) + (track.id === 'nordschleife' || track.id === 'spa' ? 0.12 : -0.08) > 0.5);
      let k; do { k = rng.int(TILES.length); } while ((TILES[k][3] === 1) !== conifer && rng.next() < 0.82);
      const T = TILES[k], hgt = T[2] * rng.uniform(0.75, 1.3) * (0.8 + 0.35 * f);
      chunks[Math.min(nCh - 1, Math.floor(i * track.ds / CH))].push({ X, Y, y: groundH(X, Y, t) - 0.25, k, hgt, w: hgt * T[0] / T[1], rot: rng.uniform(0, Math.PI), shade: rng.uniform(0.8, 1.12) * (1 - 0.18 * f), hue: rng.uniform(-0.035, 0.035) });
      placed++;
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), cc = new THREE.Color();
    for (const list of chunks) {
      if (!list.length) continue;
      const geo = cardG.clone(), tile = new Float32Array(list.length * 4);
      const im = new THREE.InstancedMesh(geo, treeMat, list.length);
      list.forEach((t, j) => {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, t.rot);
        im.setMatrixAt(j, m4.compose(pv.set(t.X, t.y, -t.Y), q, sv.set(t.w, t.hgt, t.w)));
        im.setColorAt(j, cc.setRGB(t.shade * (1 + t.hue * 4), t.shade, t.shade * (1 - t.hue * 5)));
        const T = TILES[t.k], col = t.k % 4, row = t.k >> 2;
        tile.set([(col + 0.5 - T[0]) / 4, 1 - (row + 1) / 2, 2 * T[0] / 4, T[1] / 2], j * 4);
      });
      geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 4));
      im.customDepthMaterial = depthMat;
      im.castShadow = quality.shadows; im.receiveShadow = false;
      im.computeBoundingSphere(); im.computeBoundingBox();
      group.add(skipOverride(im));
    }
  }

  // ---- generic street circuit (Monaco itself is built by src/game/monaco.js, further down) ----
  if (urban && !mc) {
    const rng = new RNG(1929);
    // one bay x one floor of facade; tinted per building
    const mkFacade = (seed, balcony) => {
      const S = 128, c = document.createElement('canvas'), r = document.createElement('canvas'); c.width = c.height = r.width = r.height = S;
      const x = c.getContext('2d'), y = r.getContext('2d'), q = new RNG(seed);
      x.fillStyle = '#f4efe6'; x.fillRect(0, 0, S, S); y.fillStyle = '#e0e0e0'; y.fillRect(0, 0, S, S);
      for (let k = 0; k < 500; k++) { x.fillStyle = `rgba(90,80,70,${0.03 + q.next() * 0.04})`; x.fillRect(q.int(S), q.int(S), 2 + q.int(5), 1 + q.int(14)); }
      const g = x.createLinearGradient(0, 22, 0, 96); g.addColorStop(0, '#8fb0cc'); g.addColorStop(0.4, '#4a6076'); g.addColorStop(1, '#232d38');
      x.fillStyle = '#c9c2b6'; x.fillRect(26, 18, 76, 84);                     // frame
      x.fillStyle = g; x.fillRect(31, 23, 66, 74); y.fillStyle = '#151515'; y.fillRect(31, 23, 66, 74);
      x.fillStyle = '#c9c2b6'; x.fillRect(62, 23, 4, 74);
      x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(26, 102, 76, 4);
      if (balcony) { x.fillStyle = '#8f8a82'; x.fillRect(8, 98, 112, 6); x.strokeStyle = '#3d4044'; x.lineWidth = 2; for (let k = 10; k < 120; k += 9) { x.beginPath(); x.moveTo(k, 70); x.lineTo(k, 98); x.stroke(); } x.fillStyle = '#3d4044'; x.fillRect(8, 68, 112, 3); }
      x.fillStyle = 'rgba(60,50,40,0.18)'; x.fillRect(0, 0, S, 3);             // floor line
      const map = new THREE.CanvasTexture(c), rough = new THREE.CanvasTexture(r);
      for (const t of [map, rough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; }
      map.colorSpace = THREE.SRGBColorSpace;
      return { map, rough };
    };
    // four walls, no caps; uv.x in bays, uv.y in floors via per-instance repeat
    const wallG = new THREE.BoxGeometry(1, 1, 1); wallG.translate(0, 0.5, 0);
    { const idx = wallG.index.array, keep = []; for (let f = 0; f < 6; f++) if (f !== 2 && f !== 3) for (let k = 0; k < 6; k++) keep.push(idx[f * 6 + k]); wallG.setIndex(keep); }
    const roofG = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const repPatch = (m) => { m.onBeforeCompile = (sh) => {
      wxUniforms(sh);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aRep;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = uv * aRep; vRoughnessMapUv = vMapUv;');
    }; m.customProgramCacheKey = () => 'bldg'; return m; };
    const list = [[], []];
    const c0 = Math.cos(track.heading[0]), s0 = Math.sin(track.heading[0]);
    const clear = (X, Y, hx, hy, ca, sa) => { let lo = Infinity, hi = -Infinity; for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [0, -1], [0, 1]]) { const px = X + a * hx * ca - b * hy * sa, py = Y + a * hx * sa + b * hy * ca, t = terrain(px, py); if (t.dist < t.corr + 3) return null; const dx = px - track.x[0], dy = py - track.y[0], lx = dx * c0 + dy * s0, ly = -dx * s0 + dy * c0; if (lx > -240 && lx < 200 && ly > -60 && ly < 60) return null; const h = groundH(px, py, t); lo = Math.min(lo, h); hi = Math.max(hi, h); } return { lo, hi }; };
    const placed = [];
    for (const row of [0, 1, 2]) for (const side of [1, -1]) {
      let i = Math.floor(rng.uniform(0, 30));
      while (i < n) {
        const w = rng.uniform(16, 34), d = rng.uniform(13, 20), h0 = track.heading[i];
        const off = side * (wallAt(side, i) + 5 + d / 2 + row * rng.uniform(26, 34));
        const X = track.x[i] - Math.sin(h0) * off, Y = track.y[i] + Math.cos(h0) * off;
        const c = clear(X, Y, w / 2, d / 2, Math.cos(h0), Math.sin(h0));
        const seaLevel = terrain(X, Y).zMin - 3;
        if (c && c.lo > seaLevel + 1.5 && !placed.some(p => Math.hypot(p.X - X, p.Y - Y) < (p.r + Math.hypot(w, d) / 2) * 0.82)) {
          const floors = Math.round(rng.uniform(4, 8) + row * rng.uniform(1, 7) + (rng.next() < 0.12 ? 9 : 0));
          const b = { X, Y, w, d, rot: h0, y: c.lo - 1, hgt: floors * 3.1 + (c.hi - c.lo) + 1, floors: floors + (c.hi - c.lo + 1) / 3.1, r: Math.hypot(w, d) / 2,
            tint: [[1, 0.93, 0.8], [0.98, 0.84, 0.7], [1, 1, 0.97], [0.95, 0.78, 0.62], [0.9, 0.9, 0.86], [1, 0.88, 0.62]][rng.int(6)] };
          placed.push(b); list[rng.int(2)].push(b);
        }
        i += Math.round((w + rng.uniform(3, 14)) / track.ds);
      }
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), sv = new THREE.Vector3(), cc = new THREE.Color();
    const roofMat = wettable(new THREE.MeshStandardMaterial({ color: 0x8d6a55, roughness: 0.9 }), 0.6);
    list.forEach((bl, k) => {
      if (!bl.length) return;
      const f = mkFacade(31 + k, k === 0), mat = wettable(repPatch(new THREE.MeshStandardMaterial({ map: f.map, roughnessMap: f.rough, roughness: 1, metalness: 0 })), 0.3);
      const g = wallG.clone(), rep = new Float32Array(bl.length * 2);
      const im = new THREE.InstancedMesh(g, mat, bl.length), roofs = new THREE.InstancedMesh(roofG, roofMat, bl.length);
      bl.forEach((b, j) => {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, b.rot);
        im.setMatrixAt(j, m4.compose(pv.set(b.X, b.y, -b.Y), q, sv.set(b.w, b.hgt, b.d)));
        roofs.setMatrixAt(j, m4.compose(pv.set(b.X, b.y + b.hgt, -b.Y), q, sv.set(b.w, 1, b.d)));
        im.setColorAt(j, cc.setRGB(b.tint[0], b.tint[1], b.tint[2]));
        rep.set([Math.round(b.w / 3.3), b.floors], j * 2);
      });
      g.setAttribute('aRep', new THREE.InstancedBufferAttribute(rep, 2));
      for (const o of [im, roofs]) { o.castShadow = quality.shadows; o.receiveShadow = true; o.computeBoundingSphere(); group.add(o); }
    });
    // sea
    const zs = terrain(track.x[0], track.y[0]).zMin - 3;
    const seaN = TX.asphaltTile(aniso).normalMap; seaN.repeat.set(900, 900);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0a2f48, roughness: 0.16, metalness: 0, normalMap: seaN, normalScale: new THREE.Vector2(0.35, 0.35) }));
    sea.position.set(track.x[0], zs, -track.y[0]); sea.receiveShadow = false; group.add(sea);
  }

  // ---- night: floodlights along the start straight (built the first time they are needed) ----
  const nightMats = [];
  const mcWorld = mc ? mc.build({ group, quality, patch, wettable, photo, aniso, nightMats, strip, skipOverride, wxUniforms, concreteMap: concreteFallback, asphaltMap: aspFallback.map, grassMap: grassFallback, TX }) : null;
  let night = null;
  function setNight(k) {
    for (const [m, e] of nightMats) m.emissiveIntensity = e * k;
    if (k <= 0.01) { if (night) night.visible = false; return; }
    if (!night) {
      night = new THREE.Group(); group.add(night);
      const steelN = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.5, metalness: 0.6 });
      const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 8.2, 6.4), fog: false });
      const poles = [], heads = [];
      const span = Math.min(Math.round(300 / track.ds), Math.floor(n / 4)), step = Math.max(1, Math.round(46 / track.ds));
      let k2 = 0;
      for (let q = -span; q <= span; q += step, k2++) {
        const i = ((q % n) + n) % n, side = k2 % 2 ? 1 : -1, h = track.heading[i], off = side * (wallAt(side, i) + 1.6);
        const X = track.x[i] - Math.sin(h) * off, Y = track.y[i] + Math.cos(h) * off, Z = track.z[i];
        poles.push(new THREE.CylinderGeometry(0.09, 0.14, 11, 6).translate(X, Z + 5.5, -Y));
        // the arm reaches in over the track
        const ax = Math.sin(h) * side * 2.2, ay = -Math.cos(h) * side * 2.2;
        heads.push(new THREE.BoxGeometry(0.9, 0.16, 0.9).rotateY(h).translate(X + ax, Z + 10.9, -(Y + ay)));
        poles.push(new THREE.BoxGeometry(0.12, 0.12, 2.4).rotateY(h + Math.PI / 2).translate(X + ax * 0.5, Z + 11, -(Y + ay * 0.5)));
        if (k2 % 3 === 0 && night.children.length < 4) {
          const L = new THREE.PointLight(0xffe2b8, 450, 95, 2); L.position.set(X + ax * 2, Z + 10.5, -(Y + ay * 2)); night.add(L);
        }
      }
      night.add(new THREE.Mesh(mergeGeometries(poles), steelN), new THREE.Mesh(mergeGeometries(heads), headMat));
    }
    night.visible = true;
    for (const o of night.children) if (o.isLight) o.intensity = 450 * k;
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
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2 * H0), wettable(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }), 0.8));
    tex.rotation = Math.PI / 2; tex.center.set(0.5, 0.5);
    line.rotation.x = -Math.PI / 2; line.position.set(0, z0 + 0.012, 0); line.receiveShadow = true;
    sf.add(line);
    // grid slots
    const slotMat = wettable(new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }), 0.8);
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
    const concrete = wettable(new THREE.MeshStandardMaterial({ map: TX.concreteTexture(aniso), roughness: 0.9 }), 0.55);
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
    if (L && !mc) sf.add(stand);

    const pit = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(190, 6.5, 12), new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.7 })); body.position.y = 3.25; pit.add(body);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1b2a3a, roughness: 0.1, metalness: 0.8, emissive: 0xffd9a0, emissiveIntensity: 0 }); nightMats.push([glassMat, 1.6]);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(190.2, 1.6, 12.2), glassMat); glass.position.y = 5.0; pit.add(glass);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.6 });
    for (let k = 0; k < 16; k++) { const d = new THREE.Mesh(new THREE.BoxGeometry(8, 3.4, 0.2), doorMat); d.position.set(-84 + k * 11.2, 1.7, -6.05); pit.add(d); }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(190.3, 0.5, 12.3), new THREE.MeshStandardMaterial({ color: 0xd22030, roughness: 0.5 })); stripe.position.y = 6.2; pit.add(stripe);
    pit.position.set(-20, z0 - 0.4, wr0 + 6.5); pit.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const pitScale = [1, 0.55, 0.3].find(k => fits(-20 - 95 * k, -20 + 95 * k, wr0, wr0 + 13));
    if (pitScale && !mc) { pit.scale.x = pitScale; sf.add(pit); }
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
    for (let i = 60; i < n && !mc; i += 97) {
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

  // The shadow frustum follows the car; it moves in whole shadow texels so
  // static shadows do not shimmer as it travels.
  const lx = new THREE.Vector3(), ly = new THREE.Vector3(), tgt = new THREE.Vector3();
  function updateSun(target) {
    lx.crossVectors(THREE.Object3D.DEFAULT_UP, sun).normalize(); ly.crossVectors(sun, lx);
    const texel = (sc.right - sc.left) / sunLight.shadow.mapSize.x;
    const px = target.dot(lx), py = target.dot(ly);
    tgt.copy(target).addScaledVector(lx, Math.round(px / texel) * texel - px).addScaledVector(ly, Math.round(py / texel) * texel - py);
    sunLight.target.position.copy(tgt);
    sunLight.position.copy(tgt).addScaledVector(sun, 320);
    mcWorld?.update(target);
  }

  return { group, sky, sun, sunLight, hemi, flash, fogColor, terrain, brakeMarkers, updateSun, setSky, setWet, setNight, gridYaw };
}
