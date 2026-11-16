// Weather and time of day: applies a condition from wx.js to the world (sky,
// sun, image-based lighting, fog, wet surfaces) and runs everything that moves:
// rain streaks, the mirrored car in the wet road, lightning, headlights and
// lamp glows, and the lens pass (light shafts, water on the lens).
import * as THREE from 'three';
import { CONDITIONS, WX } from './wx.js';
import { proceduralSky } from './skygen.js';
import { getSky } from './sky.js';
import { skipOverride } from './world.js';

const REFL_LAYER = 2;
const rad = THREE.MathUtils.degToRad;

// ---- screen-space pass, in scene-referred HDR (before bloom and tone mapping) ----
export const LensShader = {
  uniforms: {
    tDiffuse: { value: null }, sunUv: { value: new THREE.Vector2(0.5, 0.5) }, rays: { value: 0 }, rayThr: { value: 1.2 },
    aspect: { value: 1.78 }, time: { value: 0 }, drops: { value: 0 }, flash: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 sunUv; uniform float rays, rayThr, aspect, time, drops, flash; varying vec2 vUv;
    float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    // one layer of water beads on the lens: xy = offset inside the bead, z = coverage
    vec3 beads(vec2 uv, float sc, float t){
      vec2 g = uv * vec2(aspect, 1.0) * sc, id = floor(g), f = fract(g) - 0.5;
      float h = h21(id + sc), life = fract(t * (0.05 + 0.08 * h) + h * 13.0);
      if (h21(id + 5.3) > drops * 0.55) return vec3(0.0);
      vec2 c = (vec2(h21(id + 3.1), h21(id + 7.7)) - 0.5) * 0.55;
      c.y -= life * life * life * 0.35;                                  // heavy ones start to run
      float r = 0.04 + 0.09 * h21(id + 1.3);
      vec2 q = (f - c) * vec2(1.0, 0.82 - 0.2 * life);
      float m = smoothstep(r, r * 0.72, length(q)) * smoothstep(0.0, 0.04, life) * smoothstep(1.0, 0.85, life);
      return vec3(q / r * m, m);
    }
    void main(){
      vec2 uv = vUv; float bead = 0.0; vec2 bo = vec2(0.0);
      if (drops > 0.001) {
        vec3 a = beads(uv, 7.0, time), b = beads(uv + 0.37, 15.0, time * 1.3);
        bo = a.xy * 0.05 + b.xy * 0.022; bead = max(a.z, b.z);
        uv -= bo;                                                          // each bead is a tiny lens: it shows the scene flipped
      }
      vec3 c = texture2D(tDiffuse, uv).rgb;
      c *= 1.0 - 0.22 * bead * smoothstep(0.3, 1.0, length(bo) * 30.0);    // dark rim
      c += 0.05 * bead * smoothstep(0.0, 0.6, bo.y * 40.0) * dot(c, vec3(0.33));     // a little sky caught in the top of each bead
      if (rays > 0.001) {
        const int N = 28;
        vec2 stp = (sunUv - vUv) * (0.92 / float(N));
        vec2 p = vUv + stp * h21(gl_FragCoord.xy + fract(time) * 61.0);
        vec3 acc = vec3(0.0); float w = 1.0;
        for (int i = 0; i < N; i++) {
          vec4 t = texture2D(tDiffuse, clamp(p, 0.001, 0.999)); vec3 s = min(t.rgb, vec3(14.0));
          acc += s * smoothstep(rayThr, rayThr * 2.5, dot(s, vec3(0.2126, 0.7152, 0.0722))) * clamp(1.0 - t.a, 0.0, 1.0) * w;   // only open sky shines (the sky dome writes alpha 0)
          w *= 0.965; p += stp;
        }
        c += acc * (rays / float(N));
      }
      c += vec3(0.6, 0.68, 0.9) * flash;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

// ---- rain: streaks in a box that follows the camera ---------------------------------
function makeRain(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  g.instanceCount = count;
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uCam: { value: new THREE.Vector3() }, uFall: { value: new THREE.Vector3() }, uRel: { value: new THREE.Vector3(0, -9, 0) },
      uBox: { value: 28 }, uShutter: { value: 1 / 90 }, uColor: { value: new THREE.Color(0.7, 0.75, 0.8) }, uAmount: { value: 1 }, uPx: { value: 0.001 },
      uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(0, 0, 0) },
    },
    vertexShader: `attribute vec4 aSeed; uniform vec3 uCam, uFall, uRel, uSun; uniform float uBox, uShutter, uAmount, uPx; varying float vA; varying float vT; varying float vSun;
      void main(){
        // drops live in a repeating box: subtracting what has fallen so far and wrapping keeps it full
        vec3 p = aSeed.xyz * uBox + uFall;
        p = mod(p - uCam + 0.5 * uBox, uBox) - 0.5 * uBox + uCam;
        vec3 a = (viewMatrix * vec4(p, 1.0)).xyz;
        // what the camera sees during the exposure is the drop's motion relative to the camera
        vec3 st = mat3(viewMatrix) * uRel * uShutter * (0.7 + 0.6 * aSeed.w);
        vec3 b = a + st;
        vec3 c = mix(a, b, position.y);
        vec2 dir = b.xy / max(-b.z, 0.05) - a.xy / max(-a.z, 0.05);
        vec2 side = normalize(vec2(-dir.y, dir.x) + 1e-6);
        float depth = max(-c.z, 0.05);
        c.xy += side * position.x * max(0.0016, uPx * depth * 0.5);
        vT = position.y; vSun = pow(max(dot(normalize(p - uCam), uSun), 0.0), 6.0);
        float near = smoothstep(0.4, 2.0, depth), far = 1.0 - smoothstep(uBox * 0.3, uBox * 0.5, depth);
        vA = near * far * step(aSeed.w, uAmount) * (0.45 + 0.55 * fract(aSeed.w * 7.0));
        gl_Position = projectionMatrix * vec4(c, 1.0);
      }`,
    fragmentShader: `uniform vec3 uColor, uSunCol; varying float vA; varying float vT; varying float vSun;
      void main(){
        float a = vA * sin(vT * 3.14159);
        gl_FragColor = vec4(uColor + uSunCol * vSun, a * 0.36);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 6;
  return skipOverride(mesh);
}

// ---- lamp glows: additive point sprites that travel with the car --------------------
function makeGlows(n) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('face', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));   // +1 shines forward, -1 backward
  const m = GLOW_MAT || (GLOW_MAT = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 600 } },
    vertexShader: `attribute float size, face; attribute vec3 color; varying vec3 vC; uniform float scale;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // a lamp is only seen from the side it points to
        float f = dot(normalize(mat3(modelViewMatrix) * vec3(face, 0.0, 0.0)), normalize(-mv.xyz));
        vC = color * smoothstep(0.0, 0.3, f);
        gl_PointSize = min(240.0, size * scale / max(0.5, -mv.z)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 3.0) + 0.6 * smoothstep(0.22, 0.0, d);
      gl_FragColor = vec4(vC * a, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  const p = new THREE.Points(g, m); p.frustumCulled = false; p.renderOrder = 7;
  return p;
}
let GLOW_MAT = null, POOL_MAT = null, POOL_GEO = null;

// Fake headlight pool for cars that do not carry real lights: an additive patch on the road
// ahead with two overlapping lobes (left and right lamp). One shared texture and material.
function poolMaterial() {
  if (POOL_MAT) return POOL_MAT;
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64; const c = cv.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, 128, 64); c.globalCompositeOperation = 'lighter';
  for (const y of [23, 41]) {                       // u = distance ahead, v = across
    c.save(); c.translate(0, y); c.scale(1, 0.26);
    const g = c.createRadialGradient(30, 0, 2, 44, 0, 78); g.addColorStop(0, 'rgba(255,244,222,.95)'); g.addColorStop(0.35, 'rgba(255,240,214,.4)'); g.addColorStop(1, 'rgba(255,240,214,0)');
    c.fillStyle = g; c.fillRect(0, -120, 128, 240); c.restore();
  }
  const fade = c.createLinearGradient(0, 0, 14, 0); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalCompositeOperation = 'source-over'; c.fillStyle = fade; c.fillRect(0, 0, 14, 64);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  POOL_GEO = new THREE.PlaneGeometry(24, 7.5); POOL_GEO.rotateX(-Math.PI / 2); POOL_GEO.translate(12, 0, 0);
  POOL_MAT = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, opacity: 0 });
  return POOL_MAT;
}

// optional per-car lamp positions (metres, car frame): fx / rx = ahead of / behind the centre, fy / ry height, fz / rz half spacing
const LAMP_POS = {
  formula: { fy: 0.42, fz: 0.28, ry: 0.5, rz: 0.3 }, lmp1: { fy: 0.5, fz: 0.78, ry: 0.55, rz: 0.82 }, hypercar: { fy: 0.5, fz: 0.76, ry: 0.6, rz: 0.78 },
  huracan: { fy: 0.6, fz: 0.72, ry: 0.84, rz: 0.6 }, huracan610: { fy: 0.6, fz: 0.72, ry: 0.84, rz: 0.6 }, svj: { fy: 0.58, fz: 0.74, ry: 0.82, rz: 0.62 },
  gt3: { ry: 0.82, rz: 0.6 }, r8lms: { ry: 0.86, rz: 0.62 },
};

// Lamps of one car: two headlights, two tail / brake lamps and the rain light as glow sprites,
// plus the fake pool. Attached to the detailed model and to its distant stand-in alike.
class CarLamps {
  constructor(model, spec) {
    this.model = model; this.spec = spec; this.brake = false; this.real = false; this.nodes = [];
    const b = spec.body, L = b.length, W = b.width, o = LAMP_POS[spec.id] || {};
    const fy = o.fy ?? Math.min(0.72, b.height * 0.5), fz = o.fz ?? W * 0.36, ry = o.ry ?? fy + 0.16, rz = o.rz ?? fz * 0.9;
    this.proto = makeGlows(5); this.geo = this.proto.geometry;
    const P = this.geo.attributes.position;
    P.setXYZ(0, (o.fx ?? L / 2 - 0.12), fy, -fz); P.setXYZ(1, (o.fx ?? L / 2 - 0.12), fy, fz);            // headlights
    P.setXYZ(2, -(o.rx ?? L / 2 + 0.02), ry, -rz); P.setXYZ(3, -(o.rx ?? L / 2 + 0.02), ry, rz);        // tail / brake lamps
    P.setXYZ(4, -L / 2 - 0.04, b.style === 'formula' ? 0.36 : Math.max(0.3, ry - 0.3), 0);            // rain light
    this.geo.attributes.face.array.set([1, 1, -1, -1, -1]);
    this.head = [fy, fz];
  }
  attach(parent) {
    if (!parent || this.nodes.some(n => n.parent === parent)) return;
    const p = this.nodes.length ? new THREE.Points(this.geo, this.proto.material) : this.proto; p.frustumCulled = false; p.renderOrder = 7; p.layers.enable(REFL_LAYER);
    const pool = new THREE.Mesh((poolMaterial(), POOL_GEO), POOL_MAT); pool.position.set(this.spec.body.length / 2 + 0.3, 0.06, 0); pool.renderOrder = 3; pool.userData.pool = true; pool.userData.shared = true;
    parent.add(p, pool); this.nodes.push(p, pool);
  }
  update(c, time) {
    const C = this.geo.attributes.color, S = this.geo.attributes.size, k = c.night, on = k > 0.2 ? 1 : 0;
    const dim = Math.max(k, c.rain * 0.45);            // lamps only bloom when the light is low
    const hl = on * (0.5 + 1.5 * k), br = this.brake ? (0.45 + 1.8 * dim) : 0.3 * on * (0.4 + k);
    const rl = c.rain > 0 && Math.floor(time * 8) % 2 === 0 ? 3.2 : 0;
    for (const i of [0, 1]) { C.setXYZ(i, 6 * hl, 5.4 * hl, 4.2 * hl); S.setX(i, 0.22 + 0.2 * k); }
    for (const i of [2, 3]) { C.setXYZ(i, 4 * br, 0.22 * br, 0.1 * br); S.setX(i, this.brake ? 0.16 + 0.16 * dim : 0.13); }
    C.setXYZ(4, 3 * rl, 0.15 * rl, 0.07 * rl); S.setX(4, 0.24);
    C.needsUpdate = true; S.needsUpdate = true;
    for (const n of this.nodes) if (n.userData.pool) n.visible = !!on && !this.real;
  }
  dispose() { for (const n of this.nodes) n.parent?.remove(n); this.geo.dispose(); this.nodes.length = 0; }
}

export class Weather {
  constructor(game, analytic) {
    this.game = game; this.analytic = analytic;      // analytic: the lighting used until the photographed sky has loaded
    this.id = 'clear'; this.cond = CONDITIONS.clear; this.sky = null; this.time = 0;
    this.rain = null; this.rainFall = new THREE.Vector3(); this.camPrev = new THREE.Vector3(); this.camVel = new THREE.Vector3(); this.camInit = false;
    this.wind = new THREE.Vector3(2.2, 0, 1.1);
    this.flash = 0; this.strikeT = 0; this.nextStrike = 5; this.flickers = [];
    this.reflRT = null; this.vcam = new THREE.PerspectiveCamera(); this.vcam.layers.set(REFL_LAYER);
    this.lens = null; this.grade = null;
    this.heads = []; this.lamps = new Set(); this.model = null;
    this.baseFog = new THREE.Color();
    this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    getSky(game.renderer).whenReady(() => { if (this.cond.photo) this.apply(); });
  }

  get needsLens() { const c = this.cond, q = this.game.qualityName; return q !== 'low' && (c.rays > 0 || c.rain > 0 || !!c.lightning); }
  get reflective() { return this.cond.wet > 0.3 && this.game.qualityName !== 'low'; }

  set(id) {
    if (!CONDITIONS[id]) id = 'clear';
    this.id = id; this.cond = CONDITIONS[id];
    this.apply();
  }

  // (Re)apply the current condition: after a change of condition, circuit or quality.
  apply() {
    const g = this.game, c = this.cond, w = g.world, r = g.renderer, scene = g.scene, sys = getSky(r);
    if (this.sky) { this.sky.dispose(); this.sky = null; }
    let sunDir;
    if (c.photo) {
      w.setSky(null);
      if (sys.ready) {
        scene.environment = sys.env; scene.environmentIntensity = 1; scene.fog.color.copy(sys.fogColor);
        r.toneMapping = g.toneMapping; r.toneMappingExposure = g.exposureOverride ?? c.exposure;
      } else {
        scene.environment = this.analytic.env; scene.environmentIntensity = 0.55; scene.fog.color.copy(w.fogColor);
        r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.62;
      }
      WX.uFogGlow.value.setRGB(0, 0, 0); sunDir = w.sun;
    } else {
      this.sky = proceduralSky(r, this.id, c, w.gridYaw + rad(c.sun.az));
      w.setSky(this.sky, c);
      scene.environment = this.sky.env; scene.environmentIntensity = 1; scene.fog.color.setRGB(...c.fog.color);
      r.toneMapping = g.toneMapping; r.toneMappingExposure = g.exposureOverride ?? c.exposure;
      WX.uFogGlow.value.setRGB(...c.fog.glow); WX.uFogPow.value = c.fog.pow; sunDir = this.sky.sunDir;
    }
    WX.uFogSun.value.copy(sunDir);
    this.baseFog.copy(scene.fog.color);
    scene.fog.density = c.fogDensity;
    WX.uWet.value = c.wet; WX.uPuddle.value = c.puddle; WX.uLineDry.value = c.lineDry; WX.uRain.value = c.rain;
    w.setWet(c.wet); w.setNight(c.night >= 0.9 ? 1 : 0);
    w.group.traverse(o => { if (o.isLight) o.layers.enable(REFL_LAYER); });
    // spray: full in rain, a light mist on a merely damp track
    const fc = scene.fog.color;
    g.effects.wet = c.rain > 0 ? c.wet : c.wet * 0.3;
    { const gl = WX.uFogGlow.value; g.effects.sprayCol = [fc.r * 1.5 + 0.1 + gl.r * 0.2, fc.g * 1.5 + 0.1 + gl.g * 0.2, fc.b * 1.5 + 0.1 + gl.b * 0.2]; }
    // rain streaks
    const n = c.rain > 0 ? { low: 6000, medium: 24000, high: 42000 }[g.qualityName] || 7000 : 0;
    if (this.rain && (!n || this.rain.geometry.instanceCount !== n)) { scene.remove(this.rain); this.rain.geometry.dispose(); this.rain.material.dispose(); this.rain = null; }
    if (n && !this.rain) { this.rain = makeRain(n); scene.add(this.rain); }
    if (this.rain) {
      const U = this.rain.material.uniforms; U.uAmount.value = c.rain; U.uSun.value.copy(sunDir);
      U.uColor.value.setRGB(fc.r * 1.4 + 0.16, fc.g * 1.4 + 0.17, fc.b * 1.4 + 0.19);
      const k = c.sun && c.sun.disc ? 0.55 : 0; U.uSunCol.value.setRGB(...(c.sun ? c.sun.color : [0, 0, 0])).multiplyScalar(k * 2.2);
    }
    // mirrored car in the wet road
    if (this.reflective) { this.resize(); WX.uReflOn.value = 1; } else { WX.uReflOn.value = 0; if (this.reflRT) { this.reflRT.dispose(); this.reflRT = null; WX.tRefl.value = null; } }
    this.flash = 0; this.flickers.length = 0; this.nextStrike = 4 + Math.random() * 5; this.strikeT = 0;
    w.flash.intensity = 0;
    this.applyLamps();
    this.applyGrade();
  }
  applyGrade() {
    if (!this.grade) return;
    const G = this.grade.uniforms, gr = this.cond.grade;
    G.sat.value = gr.sat; G.contrast.value = gr.contrast; G.tint.value.set(...gr.tint); G.vignette.value = gr.vignette; G.lift.value.set(...gr.lift);
  }

  // Called when the composer is rebuilt: the passes this system drives.
  bindPasses(lens, grade) { this.lens = lens; this.grade = grade; this.applyGrade(); }

  resize() {
    if (!this.reflective) return;
    const sz = this.game.renderer.getDrawingBufferSize(new THREE.Vector2()), w = Math.max(64, sz.x >> 1), h = Math.max(64, sz.y >> 1);
    if (!this.reflRT) this.reflRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.LinearSRGBColorSpace });
    else this.reflRT.setSize(w, h);
    WX.tRefl.value = this.reflRT.texture;
  }

  // The car has been (re)built: move the lamps over and make it visible to the mirror camera.
  attachCar(model, spec) {
    for (const h of this.heads) { h.parent?.remove(h, h.target); h.dispose(); } this.heads = [];
    this.model = model; this.spec = spec;
    const lamps = this.lampsFor(model, spec), [fy, fz] = lamps.head, L = spec.body.length;
    for (const l of this.lamps) l.real = l === lamps;
    // real beams only for the followed car: one per headlight, toed out a little so the two pools read separately
    for (const side of [-1, 1]) {
      const h = new THREE.SpotLight(0xfff0d8, 0, 150, 0.4, 0.8, 1.6);
      h.position.set(L / 2 - 0.2, fy, side * fz); h.target.position.set(L / 2 + 30, -0.8, side * (fz + 2.6));
      model.root.add(h, h.target); h.layers.enable(REFL_LAYER); this.heads.push(h);
    }
    this.tagCar();
    this.applyLamps();
  }
  // Lamp glows (and the fake light pool) for any car model; race mode calls this for every car on the grid.
  lampsFor(model, spec) {
    if (!model.lamps) { model.lamps = new CarLamps(model, spec); this.lamps.add(model.lamps); }
    model.lamps.attach(model.root); if (model.lod) model.lamps.attach(model.lod);
    return model.lamps;
  }
  // GLB bodies arrive asynchronously, so the tagging is repeated for a while after a change.
  tagCar() { this.model?.root.traverse(o => { if (o.isMesh || o.isPoints) o.layers.enable(REFL_LAYER); }); this.tagged = 0; }

  applyLamps() {
    if (!this.heads.length) return;
    const k = this.cond.night;
    for (const h of this.heads) { h.intensity = k > 0.2 ? 620 * Math.min(1, k * 1.2) : 0; h.visible = k > 0.2; }
  }

  // Lightning now (also used by tools to capture a strike).
  strike() {
    const n = 2 + Math.floor(Math.random() * 3); this.flickers.length = 0; let t = 0;
    for (let i = 0; i < n; i++) { this.flickers.push([t, 0.5 + Math.random() * 0.5]); t += 0.06 + Math.random() * 0.14; }
    this.strikeT = 0; this.striking = true;
    const a = Math.random() * 6.283, U = this.sky?.material.uniforms;
    this._v[4].set(Math.cos(a), 0.35 + 0.3 * Math.random(), Math.sin(a)).normalize();
    if (U) U.flashDir.value.copy(this._v[4]);
    this.game.world.flash.position.copy(this._v[4]);
    // 0.3-4 km away (sound takes about 3 s per km); now and then a second stroke follows
    const u = Math.random(), km = 0.3 + 3.7 * u * Math.sqrt(u);
    this.game.audio.thunder?.(km / 0.343, 1 / (0.6 + km), { km, double: Math.random() < 0.25 });
  }

  update(dt, car, camMode, paused) {
    const g = this.game, c = this.cond, cam = g.camera;
    this.time += dt; WX.uWxTime.value = this.time;
    if (this.tagged !== undefined && this.tagged < 240) { if (++this.tagged % 30 === 0) this.model?.root.traverse(o => { if (o.isMesh || o.isPoints) o.layers.enable(REFL_LAYER); }); }
    // camera velocity (for the slant of the rain); ignore cuts
    cam.updateMatrixWorld();
    const cp = this._v[0].setFromMatrixPosition(cam.matrixWorld);
    if (this.camInit && dt > 1e-4) { const v = this._v[1].copy(cp).sub(this.camPrev).divideScalar(dt); if (v.length() < 140) this.camVel.lerp(v, Math.min(1, dt * 10)); }
    this.camPrev.copy(cp); this.camInit = true;
    if (this.rain) {
      const U = this.rain.material.uniforms, fall = this._v[2].set(this.wind.x, -9.5, this.wind.z);
      if (!paused || true) this.rainFall.addScaledVector(fall, dt);
      const B = U.uBox.value; this.rainFall.set(this.rainFall.x % B, this.rainFall.y % B, this.rainFall.z % B);
      U.uFall.value.copy(this.rainFall); U.uCam.value.copy(cp); U.uRel.value.copy(fall).sub(this.camVel);
      U.uPx.value = 2 * Math.tan(rad(cam.fov) / 2) / g.renderer.domElement.height;
    }
    // lightning
    let f = 0;
    if (c.lightning && !paused) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) { this.strike(); this.nextStrike = 7 + Math.random() * 13; }
    }
    if (this.striking) {
      this.strikeT += dt;
      for (const [t0, a] of this.flickers) { const x = this.strikeT - t0; if (x >= 0) f = Math.max(f, a * Math.exp(-x / 0.07)); }
      if (this.strikeT > 1.2) this.striking = false;
    }
    if (f !== this.flash) {
      this.flash = f; const w = g.world;
      w.flash.intensity = f * 7; g.scene.environmentIntensity = 1 + f * 2.5;
      g.scene.fog.color.copy(this.baseFog).addScalar(f * 0.5);
      if (this.sky) this.sky.material.uniforms.flash.value = f;
    }
    // lamps
    if (this.lamps.size) {
      for (const l of this.lamps) {
        if (l.model.disposed) { l.dispose(); this.lamps.delete(l); continue; }
        if (l.model === this.model) l.brake = car.brake > 0.05;
        if (l.model.lod) l.attach(l.model.lod);          // the distant stand-in is made after the model
        l.update(c, this.time);
      }
      if (POOL_MAT) POOL_MAT.opacity = 0.5 * Math.min(1, c.night * 1.2);
      this.glowScale = g.renderer.domElement.height * 0.9; if (GLOW_MAT) GLOW_MAT.uniforms.scale.value = this.glowScale;
    }
    // lens pass
    if (this.lens) {
      const U = this.lens.uniforms; U.time.value = this.time; U.aspect.value = cam.aspect; U.flash.value = f * 0.05;
      let rays = 0;
      if (c.rays > 0) {
        const s = this._v[3].copy(WX.uFogSun.value).multiplyScalar(5000).add(cp).project(cam);
        const fwd = cam.getWorldDirection(this._v[2]).dot(WX.uFogSun.value);
        if (fwd > 0.05) {
          U.sunUv.value.set(s.x * 0.5 + 0.5, s.y * 0.5 + 0.5);
          const over = Math.max(Math.abs(s.x), Math.abs(s.y)) - 1;      // how far off screen the sun is
          rays = c.rays * THREE.MathUtils.smoothstep(fwd, 0.05, 0.35) * (1 - THREE.MathUtils.smoothstep(over, 0, 0.7));
        }
      }
      U.rays.value = rays; U.rayThr.value = c.rayThr ?? 1.1;
      // beads on the lens build up while it rains (not on the trackside TV camera's long lens)
      const want = c.rain > 0 && camMode !== 'tv' && camMode !== 'tvstatic' && !paused ? c.rain : 0;
      U.drops.value += (want - U.drops.value) * Math.min(1, dt * (want > U.drops.value ? 0.35 : 2));
    }
  }

  // Render the car alone, from the camera mirrored in the road under it. The road
  // shader projects this onto the water film. Call after the camera has been placed.
  renderReflection() {
    const rt = this.reflRT, g = this.game;
    if (!rt || !this.model || WX.uReflOn.value < 0.5) return;
    const cam = g.camera, r = g.renderer, root = this.model.root, vc = this.vcam;
    const P = this._v[0].copy(root.position), N = this._v[1].set(0, 1, 0).applyQuaternion(root.quaternion);
    cam.updateMatrixWorld();
    const cp = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const view = new THREE.Vector3().subVectors(P, cp);
    if (view.dot(N) > -0.02) { r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(); r.setRenderTarget(null); return; }   // camera at or under the road
    view.reflect(N).negate().add(P);
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(cp);
    const target = new THREE.Vector3().subVectors(P, look).reflect(N).negate().add(P);
    vc.position.copy(view); vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(N); vc.lookAt(target);
    vc.near = cam.near; vc.far = 400; vc.fov = cam.fov; vc.aspect = cam.aspect; vc.updateProjectionMatrix(); vc.updateMatrixWorld();
    WX.uReflMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    const auto = r.shadowMap.autoUpdate, prev = r.getRenderTarget(), ca = r.getClearAlpha(), cc = r.getClearColor(new THREE.Color());
    r.shadowMap.autoUpdate = false;
    if (GLOW_MAT) GLOW_MAT.uniforms.scale.value = (this.glowScale || 600) * rt.height / r.domElement.height;   // point sizes are in pixels of the target
    r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear();
    r.render(g.scene, vc);
    r.setRenderTarget(prev); r.setClearColor(cc, ca); r.shadowMap.autoUpdate = auto;
    if (GLOW_MAT) GLOW_MAT.uniforms.scale.value = this.glowScale || 600;
  }
}
