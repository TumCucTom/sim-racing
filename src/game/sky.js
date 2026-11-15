// Photographic sky + image-based lighting.
//
// A 1k HDRI (Poly Haven, CC0) drives the lighting: its sun is measured and
// removed from the environment map (so the shadow-casting directional light can
// supply it without double counting), the mirrored lower hemisphere is replaced
// by a ground bounce colour, and the result is prefiltered with PMREM. The
// visible sky is the same panorama as an 8k tone-mapped JPG, expanded back to
// scene-referred values so it sits correctly under the tone mapper and blooms
// only around the sun. Until (or unless) the files load, the analytic sky that
// world.js builds is used instead.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { ASSETS, loadBinary, loadTexture } from './assets.js';

// Rotation of the panorama about the vertical axis (fraction of a turn). Chosen
// so the sun sits where the old analytic sun was (low over the pit straight's left).
const ROT = 0.49;
const SUN_CLAMP = 24;          // radiance above this is treated as the sun disc
const GROUND = [0.105, 0.12, 0.085];
const LUM = [0.2126, 0.7152, 0.0722];

let singleton = null;

function processHDR(buf) {
  const hdr = new HDRLoader().setDataType(THREE.FloatType).parse(buf);
  const W = hdr.width, H = hdr.height, src = hdr.data, st = src.length / (W * H);
  const out = new Float32Array(W * H * 4);
  const shift = Math.round(ROT * W);
  // pass 1: find the sun, sum its energy, clamp it out
  let best = 0, bx = 0, by = 0; const E = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const dw = Math.sin((y + 0.5) / H * Math.PI) * (Math.PI / H) * (2 * Math.PI / W);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * st, o = (y * W + ((x + shift) % W)) * 4;
      let r = src[i], g = src[i + 1], b = src[i + 2];
      const L = r * LUM[0] + g * LUM[1] + b * LUM[2];
      if (L > best) { best = L; bx = (x + shift) % W; by = y; }
      if (L > SUN_CLAMP) {
        const k = SUN_CLAMP / L;
        E[0] += r * (1 - k) * dw; E[1] += g * (1 - k) * dw; E[2] += b * (1 - k) * dw;
        r *= k; g *= k; b *= k;
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 1;
    }
  }
  // horizon colour (for the fog) before the ground replaces the lower half
  const hz = [0, 0, 0]; let hn = 0;
  for (let y = Math.round(H * 0.465); y < Math.round(H * 0.495); y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; hz[0] += out[o]; hz[1] += out[o + 1]; hz[2] += out[o + 2]; hn++; }
  // pass 2: lower hemisphere -> ground bounce
  for (let y = Math.floor(H / 2) - 4; y < H; y++) {
    const t = Math.min(1, Math.max(0, (y - (H / 2 - 4)) / 8)), s = t * t * (3 - 2 * t);
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; for (let c = 0; c < 3; c++) out[o + c] += (GROUND[c] - out[o + c]) * s; }
  }
  const el = (0.5 - (by + 0.5) / H) * Math.PI, az = ((bx + 0.5) / W - 0.5) * 2 * Math.PI;
  const sunDir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
  const half = new Uint16Array(out.length);
  for (let i = 0; i < out.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(out[i], 65000));
  const tex = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.flipY = true; tex.needsUpdate = true;
  return { tex, sunDir, sunE: E, horizon: hz.map(v => v / hn) };
}

const domeShader = {
  uniforms: { map: { value: null }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, horizon: { value: new THREE.Color(0.5, 0.55, 0.65) }, rot: { value: ROT }, sunGain: { value: 1 } },
  vertexShader: `varying vec3 vDir;
    void main(){ vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: `uniform sampler2D map; uniform vec3 sunDir; uniform vec3 horizon; uniform float rot; uniform float sunGain; varying vec3 vDir;
    void main(){
      vec3 d = normalize(vDir);
      float u = atan(d.z, d.x) * 0.15915494 + 0.5 - rot;
      float v = asin(clamp(d.y, -1.0, 1.0)) * 0.63661977;
      vec3 c = texture2D(map, vec2(u, clamp(v, 0.004, 0.999))).rgb;
      // undo the display tone curve of the panorama (fitted against the HDR)
      float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c *= 1.25 / (1.0 - 0.87 * pow(clamp(L, 0.0, 1.0), 2.6));
      // haze: the sky meets the fogged terrain at the horizon colour
      c = mix(c, horizon, smoothstep(0.075, -0.005, d.y) * 0.92);
      float cs = max(dot(d, sunDir), 0.0);
      c += sunGain * vec3(1.0, 0.96, 0.88) * (220.0 * smoothstep(0.99996, 0.999985, cs) + 2.2 * pow(cs, 900.0) + 0.16 * pow(cs, 48.0));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

export function getSky(renderer) {
  if (singleton) return singleton;
  const geo = new THREE.SphereGeometry(8000, 48, 24);
  const mat = new THREE.ShaderMaterial({ ...domeShader, uniforms: THREE.UniformsUtils.clone(domeShader.uniforms), side: THREE.BackSide, depthWrite: false, fog: false });
  const sky = singleton = {
    ready: false, dome: null, domeMaterial: mat, domeGeometry: geo,
    sunDir: new THREE.Vector3(), sunColor: new THREE.Color(1, 0.95, 0.86), sunIntensity: 4.4,
    fogColor: new THREE.Color(0.5, 0.55, 0.65), env: null, listeners: [],
    // world.js builds a dome per world from the shared geometry / material
    makeDome() { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 900; m.matrixAutoUpdate = false; m.userData.isSky = true; return m; },
    whenReady(fn) { if (sky.ready) fn(sky); else sky.listeners.push(fn); },
  };
  const small = renderer.capabilities.maxTextureSize < 8192;
  Promise.all([loadBinary(ASSETS.skyHDR), loadTexture(ASSETS.skyJPG, { repeat: false, aniso: 1 })]).then(([buf, jpg]) => {
    if (!buf || !jpg) return;
    const p = processHDR(buf);
    const pm = new THREE.PMREMGenerator(renderer);
    sky.env = pm.fromEquirectangular(p.tex).texture; pm.dispose(); p.tex.dispose();
    if (small) { const c = document.createElement('canvas'); c.width = 4096; c.height = 1024; c.getContext('2d').drawImage(jpg.image, 0, 0, 4096, 1024); jpg.image = c; }
    jpg.wrapS = THREE.RepeatWrapping; jpg.wrapT = THREE.ClampToEdgeWrapping;
    jpg.generateMipmaps = false; jpg.minFilter = jpg.magFilter = THREE.LinearFilter; jpg.needsUpdate = true;
    mat.uniforms.map.value = jpg;
    sky.sunDir.copy(p.sunDir); mat.uniforms.sunDir.value.copy(p.sunDir);
    const m = Math.max(...p.sunE); sky.sunIntensity = m; sky.sunColor.setRGB(p.sunE[0] / m, p.sunE[1] / m, p.sunE[2] / m);
    sky.fogColor.setRGB(p.horizon[0] * 1.12, p.horizon[1] * 1.12, p.horizon[2] * 1.12); mat.uniforms.horizon.value.copy(sky.fogColor);
    sky.ready = true;
    for (const fn of sky.listeners.splice(0)) fn(sky);
  }).catch((e) => { console.warn('sky: falling back to the analytic sky', e); });
  return sky;
}
