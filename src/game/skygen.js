// Procedural sky for the weather conditions: clouds, sun glow and horizon haze
// are generated once per condition into an HDR panorama (so the per-frame cost
// is one texture lookup), and the same panorama is prefiltered into the
// environment map. Everything is expressed in a sun-relative frame (the sun
// sits over +X); the dome mesh is rotated to put the sun where the condition
// wants it on the current circuit.
import * as THREE from 'three';

const NOISE = `
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) { s += a * vn(p); p = m * p + 11.7; a *= 0.5; } return s; }
`;

const bakeShader = {
  uniforms: {
    sunDir: { value: new THREE.Vector3(1, 0.2, 0) }, zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
    glow: { value: new THREE.Color() }, glowPow: { value: 6 }, cover: { value: 0.5 }, soft: { value: 0.2 }, gap: { value: 0 },
    dark: { value: new THREE.Color() }, lit: { value: new THREE.Color() }, amb: { value: new THREE.Color() }, scale: { value: 1 }, seed: { value: 0 },
    fogCol: { value: new THREE.Color() }, fogGlow: { value: new THREE.Color() }, fogPow: { value: 4 }, hazeK: { value: 16 }, gapW: { value: 0.5 }, litPow: { value: 3 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `precision highp float; varying vec2 vUv;
    uniform vec3 sunDir, zenith, horizon, glow, dark, lit, amb, fogCol, fogGlow; uniform float glowPow, cover, soft, gap, scale, seed, fogPow, hazeK, gapW, litPow;
    ${NOISE}
    float cloudN(vec2 p){
      vec2 w = vec2(fbm(p * 0.6 + seed), fbm(p * 0.6 + seed + 31.4)) - 0.5;      // domain warp: wispy, sheared edges
      return (fbm(p + 1.6 * w + seed * 3.1) * 0.74 + fbm(p * 3.3 - w + seed) * 0.26) * 1.25;
    }
    void main(){
      float az = (vUv.x - 0.5) * 6.2831853, el = vUv.y * 1.5707963;
      vec3 d = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
      float cs = max(dot(d, sunDir), 0.0), h = d.y;
      // clear air: gradient plus forward scattering round the sun, strongest in the low haze
      vec3 sky = mix(horizon, zenith, pow(h, 0.42));
      float low = exp(-h * 5.0);
      sky += glow * (pow(cs, glowPow * 6.0) * 1.6 + pow(cs, glowPow) * (0.35 + 0.9 * low) + pow(cs, 2.0) * 0.1 * low);
      // cloud deck on a plane overhead; the divisor bends it down to the horizon
      vec2 p = d.xz / (h + 0.11) * 0.55 * scale;
      vec2 sp = sunDir.xz / (sunDir.y + 0.11) * 0.55 * scale;
      // storms leave a gap where the sun comes through
      float ang = acos(clamp(dot(normalize(d.xz), normalize(sunDir.xz)), -1.0, 1.0));
      float hole = gap * exp(-ang * ang / gapW) * exp(-h * h / (gapW * 0.12));
      float thr = 1.0 - cover + hole * 0.8;
      float n = cloudN(p), dn = smoothstep(thr - soft, thr + soft, n);
      // self-shadowing: how much cloud lies between here and the sun
      vec2 L = normalize(sp - p + 1e-4);
      float n1 = cloudN(p + L * 0.09), n2 = cloudN(p + L * 0.26);
      float t0 = max(thr, 0.34);
      float occ = clamp((n1 - t0) / 0.42, 0.0, 1.0) * 0.6 + clamp((n2 - t0) / 0.42, 0.0, 1.0) * 0.4;
      float body = clamp((n - t0) / 0.5, 0.0, 1.0);
      float thick = clamp(body * 0.65 + occ * 0.6 - (n1 - n) * 1.6, 0.0, 1.0);
      // direct sun only reaches the cloud that faces it; the rest is lit by the sky
      vec3 litC = mix(amb, lit, pow(cs, litPow) * 0.85 + 0.15 * sunDir.y);
      vec3 cc = mix(litC, dark, smoothstep(0.05, 0.95, thick));
      // edges and thin veils light up toward the sun (silver lining)
      cc += glow * pow(cs, litPow * 2.0 + glowPow * 0.4) * (1.0 - thick) * (1.0 - thick) * 1.1;
      // bases darken overhead
      cc *= mix(1.0, 0.75, smoothstep(0.25, 0.9, h) * cover);
      vec3 c = mix(sky, cc, dn);
      vec3 hz = fogCol + fogGlow * pow(cs, fogPow);
      c = mix(c, hz, exp(-h * hazeK) * 0.94);
      gl_FragColor = vec4(c, 1.0 - dn * (1.0 - 0.9 * hole));
    }`,
};

const domeShader = {
  uniforms: {
    map: { value: null }, sunL: { value: new THREE.Vector3(1, 0, 0) }, sunCol: { value: new THREE.Color(1, 1, 1) }, disc: { value: 0 },
    haze: { value: new THREE.Color() }, hazeGlow: { value: new THREE.Color() }, hazePow: { value: 4 },
    ground: { value: new THREE.Color(0.05, 0.05, 0.04) }, env: { value: 0 }, flash: { value: 0 }, flashDir: { value: new THREE.Vector3(0, 0.4, 1) },
  },
  vertexShader: `varying vec3 vDir;
    void main(){ vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * mat3(modelMatrix) * position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: `uniform sampler2D map; uniform vec3 sunL, sunCol, haze, hazeGlow, ground, flashDir; uniform float disc, hazePow, env, flash; varying vec3 vDir;
    void main(){
      vec3 d = normalize(vDir);
      float u = atan(d.z, d.x) * 0.15915494 + 0.5, v = asin(clamp(d.y, 0.0, 1.0)) * 0.63661977;
      vec4 t = texture2D(map, vec2(u, clamp(v, 0.002, 0.998)));
      vec3 c = t.rgb;
      float cs = max(dot(d, sunL), 0.0);
      vec3 hz = haze + hazeGlow * pow(cs, hazePow);
      c = mix(c, hz, smoothstep(0.0, -0.02, d.y));
      // the sun itself, dimmed by whatever cloud the panorama has in front of it
      float su = atan(sunL.z, sunL.x) * 0.15915494 + 0.5, sv = asin(clamp(sunL.y, 0.0, 1.0)) * 0.63661977;
      float vis = texture2D(map, vec2(su, clamp(sv, 0.002, 0.998))).a;
      if (env < 0.5) {
        c += sunCol * vis * disc * (smoothstep(0.99990, 0.99997, cs) + 0.012 * pow(cs, 1200.0) + 0.0012 * pow(cs, 90.0));
        // sheet lightning inside the cloud
        float fl = exp(-(1.0 - max(dot(d, flashDir), 0.0)) * 5.0);
        c += vec3(0.75, 0.82, 1.0) * flash * (0.25 + 2.2 * fl) * (1.0 - t.a * 0.7);
      } else {
        // environment map: no disc (the directional light supplies the sun), scenery at
        // the horizon instead of open sky, and ground bounce below
        float sc = smoothstep(0.075, 0.02, d.y);
        c = mix(c, mix(ground * 1.6, c, 0.22), sc);
        c = mix(c, ground, smoothstep(0.0, -0.05, d.y));
      }
      gl_FragColor = vec4(c, 0.0);          // alpha 0 marks open sky for the light-shaft pass
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

const baked = new Map();   // condition id -> { rt }
let quad = null, bakeMat = null, domeGeo = null;

function bake(renderer, id, cond) {
  if (baked.has(id)) return baked.get(id);
  const small = renderer.capabilities.maxTextureSize < 8192;
  const W = small ? 2048 : 4096, H = W / 4;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, colorSpace: THREE.LinearSRGBColorSpace });
  bakeMat ??= new THREE.ShaderMaterial({ ...bakeShader, uniforms: THREE.UniformsUtils.clone(bakeShader.uniforms), depthTest: false, depthWrite: false, fog: false });
  quad ??= new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat); quad.frustumCulled = false;
  const U = bakeMat.uniforms, s = cond.sky, el = THREE.MathUtils.degToRad(cond.sun.el);
  U.sunDir.value.set(Math.cos(el), Math.sin(el), 0);
  for (const k of ['zenith', 'horizon', 'glow', 'dark', 'lit']) U[k].value.setRGB(...s[k]);
  U.amb.value.setRGB(...(s.amb || s.lit));
  for (const k of ['glowPow', 'cover', 'soft', 'gap', 'scale', 'seed']) U[k].value = s[k];
  U.hazeK.value = s.hazeK ?? 16; U.gapW.value = s.gapW ?? 0.5; U.litPow.value = s.litPow ?? 3;
  U.fogCol.value.setRGB(...cond.fog.color); U.fogGlow.value.setRGB(...cond.fog.glow); U.fogPow.value = cond.fog.pow;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), sc = new THREE.Scene(); sc.add(quad);
  const prev = renderer.getRenderTarget(), tm = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt); renderer.render(sc, cam); renderer.setRenderTarget(prev);
  renderer.toneMapping = tm; sc.remove(quad);
  const out = { rt };
  baked.set(id, out);
  return out;
}

// Returns everything the weather system needs for one procedural condition.
// `azimuth` is the rotation about the vertical that puts the sun in place.
export function proceduralSky(renderer, id, cond, azimuth) {
  const { rt } = bake(renderer, id, cond);
  domeGeo ??= new THREE.SphereGeometry(8000, 48, 24);
  const el = THREE.MathUtils.degToRad(cond.sun.el);
  const mk = (env) => {
    const m = new THREE.ShaderMaterial({ ...domeShader, uniforms: THREE.UniformsUtils.clone(domeShader.uniforms), side: THREE.BackSide, depthWrite: false, fog: false });
    const U = m.uniforms; U.map.value = rt.texture; U.sunL.value.set(Math.cos(el), Math.sin(el), 0);
    U.sunCol.value.setRGB(...cond.sun.color); U.disc.value = cond.sun.disc;
    U.haze.value.setRGB(...cond.fog.color); U.hazeGlow.value.setRGB(...cond.fog.glow); U.hazePow.value = cond.fog.pow;
    U.ground.value.setRGB(...cond.ground); U.env.value = env;
    return m;
  };
  const material = mk(0);
  // image-based lighting from the same panorama
  const envMat = mk(1), es = new THREE.Scene(), em = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), envMat);
  em.rotation.y = azimuth; es.add(em);
  const pm = new THREE.PMREMGenerator(renderer), envRT = pm.fromScene(es, 0, 0.1, 200);
  pm.dispose(); envMat.dispose(); em.geometry.dispose();
  const sunDir = new THREE.Vector3(Math.cos(el), Math.sin(el), 0).applyAxisAngle(THREE.Object3D.DEFAULT_UP, azimuth);
  return {
    material, geometry: domeGeo, env: envRT.texture, sunDir, azimuth, skyTexture: rt.texture,
    dispose() { material.dispose(); envRT.dispose(); },
  };
}
