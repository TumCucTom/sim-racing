// Weather / time-of-day conditions and the shader state every material shares.
//
// A condition describes the whole look in one place so that sky, sun light,
// image-based lighting, fog and the wet-surface shading can never disagree:
// the sky generator, the fog and the light all read the same numbers.
import * as THREE from 'three';

// Angles in degrees. `az` is measured from the direction of travel on the
// start/finish straight (positive = to the left), so every circuit gets the
// same composition: low suns sit ahead of the grid, slightly off to one side.
export const CONDITIONS = {
  clear: {
    label: 'Clear day', photo: true, exposure: 0.8, fogDensity: 0.00021,
    wet: 0, puddle: 0, lineDry: 0, rain: 0, rays: 0, night: 0, sim: null,
    grade: { sat: 1.2, contrast: 0.26, tint: [1.015, 1.0, 0.975], vignette: 0.42, lift: [0, 0, 0] },
  },
  golden: {
    label: 'Golden hour', exposure: 0.92, fogDensity: 0.00052,
    sun: { el: 8.5, az: 16, color: [1.0, 0.6, 0.3], intensity: 4.6, disc: 150 },
    sky: { zenith: [0.06, 0.14, 0.42], horizon: [0.62, 0.36, 0.2], glow: [1.7, 0.7, 0.2], glowPow: 13, cover: 0.44, soft: 0.1, dark: [0.16, 0.12, 0.2], lit: [1.15, 0.5, 0.2], amb: [0.42, 0.3, 0.34], gap: 0.3, scale: 1.0, seed: 3.0, hazeK: 34 },
    fog: { color: [0.55, 0.38, 0.27], glow: [1.4, 0.62, 0.2], pow: 5 },
    ground: [0.07, 0.06, 0.04], shadow: 0.7,
    wet: 0, puddle: 0, lineDry: 0, rain: 0, rays: 0.9, rayThr: 1.3, night: 0, sim: null, bloom: [0.3, 3.0],
    grade: { sat: 1.18, contrast: 0.36, tint: [1.04, 1.0, 0.93], vignette: 0.5, lift: [0.0, 0.004, 0.012] },
  },
  overcast: {
    label: 'Overcast, damp track', exposure: 1.0, fogDensity: 0.00065,
    sun: { el: 38, az: 60, color: [1.0, 0.98, 0.95], intensity: 0.55, disc: 0 },
    sky: { zenith: [0.3, 0.36, 0.46], horizon: [0.62, 0.64, 0.66], glow: [0.5, 0.48, 0.44], glowPow: 3, cover: 0.82, soft: 0.25, dark: [0.22, 0.24, 0.27], lit: [1.1, 1.1, 1.1], gap: 0, scale: 0.8, seed: 11.0, hazeK: 22 },
    fog: { color: [0.6, 0.63, 0.66], glow: [0.1, 0.09, 0.08], pow: 3 },
    ground: [0.07, 0.075, 0.06], shadow: 1.0,
    wet: 0.72, puddle: 0.5, lineDry: 1, rain: 0, rays: 0, night: 0, sim: 'overcast',
    grade: { sat: 1.02, contrast: 0.3, tint: [0.985, 1.0, 1.02], vignette: 0.45, lift: [0, 0, 0] },
  },
  rain: {
    label: 'Rain', exposure: 1.12, fogDensity: 0.0024,
    sun: { el: 42, az: 50, color: [0.92, 0.95, 1.0], intensity: 0.22, disc: 0 },
    sky: { zenith: [0.16, 0.19, 0.23], horizon: [0.4, 0.43, 0.46], glow: [0.2, 0.2, 0.2], glowPow: 3, cover: 0.95, soft: 0.3, dark: [0.07, 0.08, 0.1], lit: [0.34, 0.36, 0.39], gap: 0, scale: 0.7, seed: 5.0, hazeK: 12 },
    fog: { color: [0.4, 0.43, 0.46], glow: [0.05, 0.05, 0.05], pow: 3 },
    ground: [0.035, 0.04, 0.035], shadow: 1.0,
    wet: 1, puddle: 1, lineDry: 0, rain: 0.8, rays: 0, night: 0.35, sim: 'rain', bloom: [0.24, 2.2],
    grade: { sat: 0.94, contrast: 0.38, tint: [0.97, 1.0, 1.04], vignette: 0.55, lift: [0.0, 0.004, 0.01] },
  },
  storm: {
    label: 'Storm at low sun', exposure: 1.0, fogDensity: 0.0015,
    sun: { el: 7, az: 13, color: [1.0, 0.68, 0.38], intensity: 5.2, disc: 260 },
    sky: { zenith: [0.035, 0.05, 0.08], horizon: [0.5, 0.36, 0.24], glow: [2.6, 1.5, 0.62], glowPow: 14, cover: 0.84, soft: 0.2, dark: [0.018, 0.024, 0.04], lit: [0.9, 0.5, 0.24], amb: [0.1, 0.115, 0.15], gap: 1.0, gapW: 0.16, litPow: 10, scale: 0.85, seed: 8.0, hazeK: 26 },
    fog: { color: [0.17, 0.175, 0.2], glow: [1.15, 0.66, 0.3], pow: 9 },
    ground: [0.03, 0.03, 0.028], shadow: 0.7,
    wet: 1, puddle: 1, lineDry: 0, rain: 0.6, rays: 1.25, rayThr: 1.2, night: 0.25, lightning: true, sim: 'storm', bloom: [0.32, 2.6],
    grade: { sat: 1.0, contrast: 0.5, tint: [1.03, 1.0, 0.95], vignette: 0.62, lift: [0.0, 0.006, 0.016] },
  },
  dusk: {
    label: 'Dusk, lights on', exposure: 1.1, fogDensity: 0.0006,
    sun: { el: 5, az: 22, color: [0.75, 0.5, 0.62], intensity: 0.2, disc: 0 },
    sky: { zenith: [0.012, 0.022, 0.07], horizon: [0.07, 0.07, 0.13], glow: [0.7, 0.22, 0.07], glowPow: 9, cover: 0.27, soft: 0.2, dark: [0.01, 0.012, 0.028], lit: [0.3, 0.1, 0.07], amb: [0.03, 0.032, 0.06], gap: 0.3, scale: 1.0, seed: 21.0 },
    fog: { color: [0.05, 0.055, 0.1], glow: [0.5, 0.18, 0.06], pow: 4 },
    ground: [0.01, 0.01, 0.012], shadow: 1.2,
    wet: 0, puddle: 0, lineDry: 0, rain: 0, rays: 0, night: 1, sim: null, bloom: [0.42, 1.6],
    grade: { sat: 1.1, contrast: 0.4, tint: [0.98, 1.0, 1.05], vignette: 0.6, lift: [0.0, 0.002, 0.012] },
  },
};
export const CONDITION_ORDER = ['clear', 'golden', 'overcast', 'rain', 'storm', 'dusk'];

// One set of uniform objects, referenced (not copied) by every patched material.
export const WX = {
  uWet: { value: 0 },            // 0 dry .. 1 soaked
  uPuddle: { value: 0 },         // standing water
  uLineDry: { value: 0 },        // how much drier the racing line is
  uRain: { value: 0 },           // rain rate (ripples in puddles)
  uWxTime: { value: 0 },
  tRefl: { value: null },        // planar reflection of the car
  uReflMat: { value: new THREE.Matrix4() },
  uReflOn: { value: 0 },
  uFogSun: { value: new THREE.Vector3(0, 1, 0) },   // world-space direction of the sun
  uFogGlow: { value: new THREE.Color(0, 0, 0) },    // extra in-scatter looking toward the sun
  uFogPow: { value: 4 },
};
export function wxUniforms(shader) { for (const k in WX) shader.uniforms[k] = WX[k]; }

// Fog that glows toward the sun: haze lit from behind is what sells a low sun.
// Patched into three's shader chunks once; materials that never receive the
// uniforms see a zero glow, i.e. the stock fog.
let fogPatched = false;
export function patchFog() {
  if (fogPatched) return; fogPatched = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = C.fog_pars_vertex.replace('varying float vFogDepth;', 'varying float vFogDepth; varying vec3 vFogDir;');
  C.fog_vertex = C.fog_vertex.replace('vFogDepth = - mvPosition.z;', 'vFogDepth = - mvPosition.z; vFogDir = mvPosition.xyz * mat3( viewMatrix );');
  C.fog_pars_fragment = C.fog_pars_fragment.replace('varying float vFogDepth;', 'varying float vFogDepth; varying vec3 vFogDir; uniform vec3 uFogSun; uniform vec3 uFogGlow; uniform float uFogPow;');
  C.fog_fragment = C.fog_fragment.replace('gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
    'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor + uFogGlow * pow( max( dot( normalize( vFogDir ), uFogSun ), 0.0 ), uFogPow ), fogFactor );');
  // built-in materials with no hook of their own still need the uniforms
  THREE.Material.prototype.onBeforeCompile = function (shader) { wxUniforms(shader); };
}

// GLSL shared by the ground materials. puddleDepth mirrors src/sim/wet.js.
export const WX_GLSL = `
uniform float uWet, uPuddle, uLineDry, uRain, uWxTime, uReflOn;
uniform sampler2D tRefl; uniform mat4 uReflMat;
float gWet = 0.0, gPud = 0.0;
float puddleDepth(float s, float off, float hw){
  float de = hw - abs(off);
  float side = off > 0.0 ? 1.7 : 0.0;
  float a = 0.5 + 0.5 * sin(s * 0.021 + 1.3 + side) * sin(s * 0.0057 + 0.4 + side * 2.0);
  return smoothstep(1.4, 0.3, de) * step(-0.2, de) * smoothstep(0.45, 0.7, a);
}
// expanding rings where drops land, as a slope (xz) to add to the normal
vec2 rainRipple(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 q = p * (k == 0 ? 2.3 : 3.7) + float(k) * 17.3, c = floor(q), f = fract(q) - 0.5;
    float h = fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453), ph = fract(t * (0.9 + 0.5 * h) + h * 7.0);
    vec2 o = f - (vec2(h, fract(h * 57.0)) - 0.5) * 0.5;
    float d = length(o), w = sin(40.0 * (d - ph * 0.42)) * smoothstep(0.42, 0.0, d) * (1.0 - ph) * smoothstep(0.0, 0.04, ph * 0.42 + 0.02 - abs(d - ph * 0.42));
    acc += o / max(d, 1e-3) * w;
  }
  return acc;
}
`;
