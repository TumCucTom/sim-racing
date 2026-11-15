// In-car cameras: the driver's-eye (cockpit) view and the bonnet / nose camera.
//
// Nothing here is tuned per car. The body is scanned once into a height map (cockpit-scan.js),
// the cabin is measured from it (cockpit-fit.js: roof, windscreen, belt line, glasshouse width ->
// eye point, bonnet camera, cabin hull) and a procedural cockpit is built on those measurements:
// dashboard, instruments with live readouts, steering wheel, hands and arms, pillars, roof
// header, door tops, and a roll cage and window net in race cars. While you sit inside, whatever
// the exterior model has within the cabin hull (its own static interior, opaque or tinted glass,
// the roof) is clipped away per fragment, so every car gets the same working cockpit whether
// its model came with an interior or not.
//
// The kit lives in its own group beside the car (not under it), is only visible in the cockpit
// view, casts no shadow and is never seen by the reflection camera.
import * as THREE from 'three';
import { scanBody } from './cockpit-scan.js';
import { fitCabin } from './cockpit-fit.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0), clamp = THREE.MathUtils.clamp;
const _a = V(), _b = V(), _c = V(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();

// ---------------------------------------------------------------------------------- fit cache
const fits = new Map();
export function cabinFit(model, spec) {
  const key = `${spec.id}:${model.glb ? 'glb' : 'proc'}`;
  if (!fits.has(key)) fits.set(key, fitCabin(scanBody(model), spec));
  return fits.get(key);
}

// ---------------------------------------------------------------------------------- materials
// The cabin is lit by the sky, not by the sun: direct light is turned well down in the shader
// (the roof is clipped away while you are inside, so shadow maps cannot do it).
const SUN_CHUNK = THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= 0.16;');
function cabinMat(p) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide, ...p });
  m.envMapIntensity = p.envMapIntensity ?? 0.5;
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', SUN_CHUNK); };
  m.customProgramCacheKey = () => 'cabin';
  return m;
}
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
}
const carbonTex = () => canvasTex(32, 32, (g) => {
  g.fillStyle = '#17181b'; g.fillRect(0, 0, 32, 32);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { g.fillStyle = (x + y) % 2 ? '#24262a' : '#101113'; g.fillRect(x * 8 + 1, y * 8 + 1, 6, 6); }
}, 14);
const netTex = () => canvasTex(128, 128, (g) => {
  g.clearRect(0, 0, 128, 128); g.strokeStyle = '#0a0a0b'; g.lineWidth = 9;
  for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
  g.strokeStyle = '#b01a1a'; g.lineWidth = 2; for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); }
});

// ---------------------------------------------------------------------------------- geometry helpers
class Kit {
  constructor() { this.group = new THREE.Group(); this.group.matrixAutoUpdate = false; this.geos = []; this.mats = []; this.texs = []; }
  mat(p) { const m = cabinMat(p); this.mats.push(m); return m; }
  tex(t) { this.texs.push(t); return t; }
  mesh(geo, mat, parent = this.group) { const m = new THREE.Mesh(geo, mat); m.castShadow = false; m.receiveShadow = false; m.userData.cockpitOnly = true; this.geos.push(geo); parent.add(m); return m; }
  // flat panel through four corners (a-b-c-d around the outline)
  quad(mat, a, b, c, d, parent) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray()], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2)); g.setIndex([0, 1, 2, 0, 2, 3]); g.computeVertexNormals();
    return this.mesh(g, mat, parent);
  }
  // rectangular beam from p0 to p1; `w` is its size along `across` (made square to the beam), `h` the other way.
  // The beam is shifted by `off` = [across, other] fractions of its own size, so [0.5, 0] puts one face on the line.
  beam(mat, p0, p1, w, h, across, off = [0, 0], parent) {
    const x = _a.subVectors(p1, p0), len = x.length(); x.divideScalar(len);
    const y = _b.copy(across).addScaledVector(x, -across.dot(x)).normalize(), z = _c.crossVectors(x, y);
    const m = this.mesh(new THREE.BoxGeometry(len, w, h), mat, parent);
    m.quaternion.setFromRotationMatrix(_m.makeBasis(x, y, z));
    m.position.addVectors(p0, p1).multiplyScalar(0.5).addScaledVector(y, off[0] * w).addScaledVector(z, off[1] * h);
    return m;
  }
  tube(mat, p0, p1, r, parent) {
    const m = this.mesh(new THREE.CylinderGeometry(r, r, 1, 10, 1), mat, parent); place(m, p0, p1); return m;
  }
  dispose() { this.group.parent?.remove(this.group); for (const g of this.geos) g.dispose(); for (const m of this.mats) m.dispose(); for (const t of this.texs) t.dispose(); }
}
// stretch a unit-height (Y) mesh from p0 to p1
function place(m, p0, p1) {
  const d = _a.subVectors(p1, p0), len = d.length() || 1e-6;
  m.position.addVectors(p0, p1).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(UP, d.divideScalar(len)); m.scale.set(1, len, 1);
}
// orientation of a panel at `pos` facing `target` (its +Z towards the target, +Y as upright as possible)
function facing(obj, pos, target) {
  const z = _a.subVectors(target, pos).normalize(), x = _b.crossVectors(UP, z).normalize(), y = _c.crossVectors(z, x);
  obj.position.copy(pos); obj.quaternion.setFromRotationMatrix(_m.makeBasis(x, y, z)); return obj;
}

// ---------------------------------------------------------------------------------- instruments
const FONT = 'system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
const gearText = (car, e) => (e.electric ? (car.gear < 0 ? 'R' : 'D') : car.gear < 0 ? 'R' : car.gear === 0 ? 'N' : String(car.gear));
const lapText = (t) => { if (t == null || !isFinite(t)) return '-:--.-'; const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
function lamps(car) {
  let abs = false; if (car.absF) for (let i = 0; i < 4; i++) if (car.absF[i] < 0.95) abs = true;
  return { abs: !!car.aids?.abs && abs && car.brake > 0.1, tc: !!car.aids?.tc && car.tcCut > 0.04 };
}
// analogue-style road-car cluster: rev counter, speedometer, gear and trip display between them
function drawRoad(g, W, H, car, spec, info) {
  const e = spec.engine, maxRpm = Math.ceil(e.limiter / 1000) * 1000, kmh = Math.abs(car.speed) * 3.6, vmax = info.vmax;
  g.fillStyle = '#050608'; g.fillRect(0, 0, W, H);
  const dial = (cx, val, max, step, red, unit, div) => {
    const R = H * 0.44, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ang = (v) => a0 + (a1 - a0) * Math.min(1, Math.max(0, v / max));
    g.fillStyle = '#0d0f13'; g.beginPath(); g.arc(cx, H / 2, R + 6, 0, 6.2832); g.fill();
    g.lineWidth = 5; g.strokeStyle = '#c9ced6'; g.beginPath(); g.arc(cx, H / 2, R, a0, a1); g.stroke();
    if (red) { g.strokeStyle = '#e02626'; g.beginPath(); g.arc(cx, H / 2, R, ang(red), a1); g.stroke(); }
    g.fillStyle = '#e8ebf0'; g.font = `bold ${Math.round(H * 0.105)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= max + 1e-6; v += step) { const a = ang(v); g.fillText(String(Math.round(v / div)), cx + Math.cos(a) * (R - 19), H / 2 + Math.sin(a) * (R - 19)); g.fillRect(cx + Math.cos(a) * (R - 4) - 1.5, H / 2 + Math.sin(a) * (R - 4) - 1.5, 3, 3); }
    g.fillStyle = '#8a909a'; g.font = `${Math.round(H * 0.075)}px ${FONT}`; g.fillText(unit, cx, H * 0.74);
    const a = ang(val); g.strokeStyle = '#ff5a1f'; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx - Math.cos(a) * 10, H / 2 - Math.sin(a) * 10); g.lineTo(cx + Math.cos(a) * (R - 8), H / 2 + Math.sin(a) * (R - 8)); g.stroke(); g.lineCap = 'butt';
    g.fillStyle = '#1b1d22'; g.beginPath(); g.arc(cx, H / 2, 11, 0, 6.2832); g.fill();
  };
  dial(H * 0.52, car.rpm, maxRpm, maxRpm > 12000 ? 2000 : 1000, e.redline, e.electric ? 'motor x1000' : 'rpm x1000', 1000);
  dial(W - H * 0.52, kmh, vmax, vmax > 240 ? 40 : 20, 0, 'km/h', 1);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${Math.round(H * 0.4)}px ${FONT}`; g.fillText(gearText(car, e), W / 2, H * 0.36);
  g.font = `bold ${Math.round(H * 0.2)}px ${FONT}`; g.fillText(String(Math.round(kmh)), W / 2, H * 0.72);
  const frac = car.rpm / e.redline, L = lamps(car);
  for (let k = 0; k < 5; k++) { g.fillStyle = frac > 0.8 + k * 0.04 ? (k < 2 ? '#39d353' : k < 4 ? '#ffd166' : '#ff3b30') : '#1c1f25'; g.beginPath(); g.arc(W / 2 - 36 + k * 18, H * 0.09, 6, 0, 6.2832); g.fill(); }
  g.font = `bold ${Math.round(H * 0.085)}px ${FONT}`;
  g.fillStyle = L.abs ? '#ffb020' : '#22252b'; g.fillText('ABS', W / 2 - 28, H * 0.92); g.fillStyle = L.tc ? '#ffb020' : '#22252b'; g.fillText('TC', W / 2 + 28, H * 0.92);
}
// race dash logger: rpm bar, big gear, speed, lap time and gap, ABS / TC activity
function drawRace(g, W, H, car, spec, info) {
  const e = spec.engine, frac = car.rpm / e.redline, kmh = Math.abs(car.speed) * 3.6, L = lamps(car), big = info.onWheel;
  g.fillStyle = car.limiterOn ? '#3a0508' : '#020304'; g.fillRect(0, 0, W, H);
  const n = 24, bw = (W - 16) / n;
  for (let k = 0; k < n; k++) {
    const t = (k + 1) / n, on = frac * 1.02 >= t;
    g.fillStyle = on ? (t > 0.94 ? '#ff2d2d' : t > 0.82 ? '#ffd21f' : '#27e06a') : '#14171c'; g.fillRect(8 + k * bw + 1, 6, bw - 2, H * (big ? 0.16 : 0.13));
  }
  g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillStyle = frac > 0.97 ? '#ff4d4d' : '#ffffff'; g.font = `bold ${Math.round(H * (big ? 0.72 : 0.66))}px ${FONT}`; g.fillText(gearText(car, e), W / 2, H * 0.6);
  g.fillStyle = '#e8ebf0'; g.font = `bold ${Math.round(H * (big ? 0.34 : 0.3))}px ${FONT}`; g.fillText(String(Math.round(kmh)), W * 0.19, H * 0.5);
  g.fillStyle = '#7d8590'; g.font = `${Math.round(H * 0.1)}px ${FONT}`; g.fillText('km/h', W * 0.19, H * 0.72);
  if (big) { g.fillStyle = '#e8ebf0'; g.font = `bold ${Math.round(H * 0.3)}px ${FONT}`; g.fillText((car.rpm / 1000).toFixed(1), W * 0.81, H * 0.5); g.fillStyle = '#7d8590'; g.font = `${Math.round(H * 0.1)}px ${FONT}`; g.fillText('rpm x1000', W * 0.81, H * 0.72); }
  else {
    g.fillStyle = '#e8ebf0'; g.font = `bold ${Math.round(H * 0.2)}px ${FONT}`; g.fillText(lapText(info.lapTime), W * 0.81, H * 0.4);
    const d = info.delta;
    if (d != null && isFinite(d)) { g.fillStyle = d <= 0 ? '#27e06a' : '#ff5d5d'; g.fillText(`${d <= 0 ? '-' : '+'}${Math.abs(d).toFixed(2)}`, W * 0.81, H * 0.64); }
    else { g.fillStyle = '#7d8590'; g.font = `${Math.round(H * 0.12)}px ${FONT}`; g.fillText(`LAST ${lapText(info.lastLap)}`, W * 0.81, H * 0.64); }
    g.font = `bold ${Math.round(H * 0.11)}px ${FONT}`;
    g.fillStyle = L.abs ? '#ffb020' : '#1d2026'; g.fillRect(W * 0.06, H * 0.82, W * 0.11, H * 0.14); g.fillStyle = L.tc ? '#ffb020' : '#1d2026'; g.fillRect(W * 0.2, H * 0.82, W * 0.11, H * 0.14);
    g.fillStyle = L.abs ? '#111' : '#59606b'; g.fillText('ABS', W * 0.115, H * 0.9); g.fillStyle = L.tc ? '#111' : '#59606b'; g.fillText('TC', W * 0.255, H * 0.9);
    g.fillStyle = '#14171c'; g.fillRect(W * 0.66, H * 0.84, W * 0.3, H * 0.045); g.fillRect(W * 0.66, H * 0.905, W * 0.3, H * 0.045);
    g.fillStyle = '#27e06a'; g.fillRect(W * 0.66, H * 0.84, W * 0.3 * car.throttle, H * 0.045); g.fillStyle = '#ff4d4d'; g.fillRect(W * 0.66, H * 0.905, W * 0.3 * car.brake, H * 0.045);
  }
}

// ---------------------------------------------------------------------------------- steering wheel, hands, arms
const LED_COLS = [0x27e06a, 0x27e06a, 0x27e06a, 0xffd21f, 0xffd21f, 0xffd21f, 0xff2d2d, 0xff2d2d, 0x3d7bff, 0x3d7bff];
function buildWheel(kit, fit, spec, C, look) {
  const E = fit.E, R = E.wheelR, race = fit.klass !== 'road', rt = race ? 0.019 : 0.0165;
  const g = new THREE.Group(), spin = new THREE.Group(); g.add(spin); kit.group.add(g);
  // wheel frame: X = car right, Y = up along the wheel face, Z = out of the wheel towards the driver
  const r = E.rake; g.position.copy(C); g.quaternion.setFromRotationMatrix(_m.makeBasis(V(0, 0, 1), V(Math.sin(r), Math.cos(r), 0), V(-Math.cos(r), Math.sin(r), 0)));
  const grip = kit.mat({ color: race ? 0x1b1b1d : 0x121213, roughness: race ? 0.95 : 0.6 }), dark = kit.mat({ color: 0x0c0c0d, roughness: 0.6 });
  const metal = kit.mat({ color: 0x8a8d92, roughness: 0.35, metalness: 0.8, envMapIntensity: 1 });
  const out = { group: g, spin, leds: [], paddles: [], screen: null, R };
  const col = kit.mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.34, 12).rotateX(Math.PI / 2), dark, g); col.position.z = -0.19;
  if (!race) {
    kit.mesh(new THREE.BoxGeometry(0.11, 0.085, 0.15), dark, g).position.set(0, -0.005, -0.1);                       // column shroud
    for (const s of [-1, 1]) { const st = kit.mesh(new THREE.BoxGeometry(0.13, 0.016, 0.02), dark, g); st.position.set(s * 0.115, 0.012, -0.07); st.rotation.z = s * 0.12; }   // stalks
    kit.mesh(new THREE.TorusGeometry(R, rt, 12, 48), grip, spin);
    for (const s of [-1, 1]) kit.mesh(new THREE.BoxGeometry(R - 0.05, 0.036, 0.014), dark, spin).position.set(s * (R + 0.045) / 2, -0.004, -0.002);
    kit.mesh(new THREE.BoxGeometry(0.042, R - 0.05, 0.014), dark, spin).position.set(0, -(R + 0.045) / 2, -0.002);
    kit.mesh(new THREE.CylinderGeometry(0.064, 0.07, 0.04, 24).rotateX(Math.PI / 2), dark, spin).position.z = 0.004;
    const pad = kit.mesh(new THREE.SphereGeometry(1, 20, 12), grip, spin); pad.scale.set(0.062, 0.052, 0.014); pad.position.z = 0.024;
    kit.mesh(new THREE.CircleGeometry(0.013, 16), metal, spin).position.z = 0.0385;
    if (/supercar|GT\b/i.test(spec.klass || '')) {      // drive-mode dial and start button
      const red = kit.mat({ color: 0xc8141c, roughness: 0.4 });
      kit.mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.014, 14).rotateX(Math.PI / 2), red, spin).position.set(0.075, -0.045, 0.012);
      kit.mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 14).rotateX(Math.PI / 2), red, spin).position.set(-0.075, -0.045, 0.012);
    }
  } else {
    const arc = 1.5, yb = R * Math.sin(arc / 2), xb = R * Math.cos(arc / 2);
    for (const c of [0, Math.PI]) kit.mesh(new THREE.TorusGeometry(R, rt, 10, 16, arc).rotateZ(c - arc / 2), grip, spin);
    for (const s of [-1, 1]) kit.mesh(new THREE.BoxGeometry(2 * xb + 0.02, 0.03, 0.022), dark, spin).position.set(0, s * yb, 0);
    const carbon = kit.mat({ color: 0xffffff, map: kit.tex(carbonTex()), roughness: 0.45, metalness: 0.2 });
    kit.mesh(new THREE.BoxGeometry(2 * R - 0.03, 2 * yb, 0.012), carbon, spin).position.z = -0.003;
    const cols = [0xff3b30, 0xffcc00, 0x34c759, 0x0a84ff, 0xf2f2f2, 0xff9500], bg = new THREE.CylinderGeometry(0.0085, 0.0085, 0.009, 12).rotateX(Math.PI / 2); kit.geos.push(bg);
    let k = 0; for (const s of [-1, 1]) for (let row = 0; row < 3; row++) for (let c = 0; c < (row === 1 ? 1 : 2); c++) {
      const b = new THREE.Mesh(bg, kit.mat({ color: cols[k++ % 6], roughness: 0.5 })); b.position.set(s * (R * 0.5 + c * 0.024 - (row === 1 ? -0.012 : 0)), (row - 1) * yb * 0.52 + 0.004, 0.006); spin.add(b);
    }
    for (const x of [-0.3, 0, 0.3]) { const d = kit.mesh(new THREE.CylinderGeometry(0.0115, 0.013, 0.014, 14).rotateX(Math.PI / 2), metal, spin); d.position.set(x * R, -yb * 0.62, 0.009); kit.mesh(new THREE.BoxGeometry(0.003, 0.011, 0.002), kit.mat({ color: 0xffffff }), d).position.set(0, 0.004, 0.0075); }
    const lg = new THREE.BoxGeometry(0.0095, 0.007, 0.004); kit.geos.push(lg);
    for (let i = 0; i < LED_COLS.length; i++) { const m = new THREE.MeshBasicMaterial({ color: 0x15171a, toneMapped: false }); kit.mats.push(m); const l = new THREE.Mesh(lg, m); l.position.set((i - (LED_COLS.length - 1) / 2) * 0.0128, yb, 0.0125); spin.add(l); out.leds.push(m); }
    const onWheel = fit.klass !== 'gt';
    if (onWheel) out.screenAt = { parent: spin, pos: V(0, 0.008, 0.0045), w: Math.min(0.105, R * 0.78), h: Math.min(0.105, R * 0.78) * 0.375 };
    else kit.mesh(new THREE.BoxGeometry(0.07, 0.045, 0.006), dark, spin).position.set(0, 0.008, 0.004);
  }
  if (race || (!spec.engine.electric && (spec.shiftTime ?? 1) <= 0.15)) {
    for (const s of [-1, 1]) { const p = kit.mesh(new THREE.BoxGeometry(race ? 0.055 : 0.04, race ? 0.1 : 0.13, 0.005), race ? dark : metal, spin); p.position.set(s * (R - (race ? 0.025 : 0.05)), 0.012, -0.034); p.rotation.y = s * 0.25; out.paddles.push(p); }
  }
  // hands: rigid on the rim at nine and three; the arms follow through the wrists
  const glove = kit.mat({ color: race ? 0x1a1b1f : 0x6a4a2e, roughness: race ? 0.8 : 0.55 }), trim = kit.mat({ color: race ? (spec.body?.color ?? 0xc8141c) : 0x4a321e, roughness: 0.7 });
  out.wrists = [];
  for (const s of [-1, 1]) {
    const hand = new THREE.Group(); spin.add(hand); hand.rotation.z = s > 0 ? 0 : Math.PI; hand.scale.y = s;       // left hand = right hand turned half a turn and mirrored
    const fa = 0.0195 / R;
    for (let f = 0; f < 4; f++) kit.mesh(new THREE.TorusGeometry(R, rt + 0.0105 - (f === 3 ? 0.0015 : 0), 8, 4, fa * 0.9).rotateZ((1.3 - f) * fa * 1.08 - fa * 0.45), f % 2 ? glove : glove, hand);
    const back = kit.mesh(new THREE.SphereGeometry(1, 14, 10), glove, hand); back.scale.set(0.03, 0.047, 0.026); back.position.set(R + 0.012, -0.002, 0.03); back.rotation.y = 0.5;
    kit.mesh(new THREE.BoxGeometry(0.022, 0.05, 0.004), trim, hand).position.set(R + 0.03, -0.002, 0.048);
    const th = kit.mesh(new THREE.CapsuleGeometry(0.0115, 0.036, 4, 8), glove, hand); th.position.set(R - 0.006, 0.05, 0.022); th.rotation.z = 0.25;
    out.wrists.push({ s, hand, local: V(R + 0.034, -0.034, 0.078) });
  }
  return out;
}

function buildArms(kit, fit, spec) {
  const race = fit.klass !== 'road', e = V(...fit.eye);
  const sleeve = kit.mat({ color: race ? 0xe6e7ea : 0x2a323c, roughness: 0.9 }), cuffM = kit.mat({ color: race ? 0x1a1b1f : 0x6a4a2e, roughness: 0.7 });
  const narrow = fit.klass === 'formula' || fit.klass === 'proto';
  return [-1, 1].map((s) => ({
    s, shoulder: V(e.x - (narrow ? 0.05 : 0.1), e.y - (narrow ? 0.2 : 0.215), e.z + s * (narrow ? 0.17 : 0.2)),
    upper: kit.mesh(new THREE.CylinderGeometry(0.052, 0.043, 1, 10), sleeve), fore: kit.mesh(new THREE.CylinderGeometry(0.043, 0.034, 1, 10), sleeve),
    elbow: kit.mesh(new THREE.SphereGeometry(0.044, 10, 8), sleeve), cuff: kit.mesh(new THREE.SphereGeometry(0.036, 10, 8), cuffM), ball: kit.mesh(new THREE.SphereGeometry(0.056, 10, 8), sleeve),
  }));
}

// ---------------------------------------------------------------------------------- the cockpit
function buildCockpit(model, spec, fit) {
  const kit = new Kit(), E = fit.E, k = fit.klass, race = k !== 'road', e = V(...fit.eye), s = fit.side;
  const C = V(e.x + E.reach, e.y - E.fall, e.z);
  const dash = kit.mat({ color: race ? 0x111214 : 0x18191b, roughness: 0.9 }), trim = kit.mat({ color: race ? 0x141517 : 0x2a2b2e, roughness: 0.92 });
  const dark = kit.mat({ color: 0x08080a, roughness: 0.9 }), soft = kit.mat({ color: 0x1f2023, roughness: 0.95 });
  const rig = { kit, fit, C, t: 0, phi: 0, gear: null, flick: [0, 0], head: { yaw: 0, sway: 0, surge: 0, roll: 0 } };

  // live instrument texture
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 192;
  const tex = kit.tex(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const screenM = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }); kit.mats.push(screenM);
  rig.canvas = cv; rig.ctx = cv.getContext('2d'); rig.tex = tex; rig.screenM = screenM;
  const screen = (parent, w, h) => { const m = kit.mesh(new THREE.PlaneGeometry(w, h), screenM, parent); return m; };

  if (fit.open) {
    // single-seater: the inside of the tub, padded rim, wheel
    const w = fit.halfW, y1 = fit.rim - 0.015, xa = e.x - 0.4, xb = e.x + 0.68, yf = 0.22;
    for (const z of [-w, w]) kit.quad(dark, V(xa, yf, z), V(xb, yf, z), V(xb, y1, z), V(xa, y1, z));
    kit.quad(dark, V(xa, yf, -w), V(xb, yf, -w), V(xb, yf, w), V(xa, yf, w)); kit.quad(dark, V(xb, yf, -w), V(xb, y1, -w), V(xb, y1, w), V(xb, yf, w));
    for (const z of [-w - 0.012, w + 0.012]) kit.tube(soft, V(e.x - 0.42, y1 + 0.01, z), V(e.x + 0.36, y1 - 0.005, z), 0.032);
    kit.quad(soft, V(e.x - 0.14, yf, -w), V(e.x - 0.14, yf, w), V(e.x - 0.2, e.y + 0.2, w), V(e.x - 0.2, e.y + 0.2, -w));      // seat back / headrest behind you
  } else {
    const ws = fit.ws, sg = fit.sideGlass;
    const wsX = (y, inset = 0.03) => (-(ws.d + inset) - ws.n[1] * y) / ws.n[0];
    const sideZ = (x, y, inset = 0.03) => (-(sg.d + inset) - sg.n[0] * x - sg.n[1] * y) / sg.n[2];
    const yD = fit.cowl.y - 0.035, yDr = Math.min(yD + 0.02, e.y - 0.135), xD1 = C.x + 0.085, xD0 = Math.min(wsX(yD, 0), fit.xFront) + 0.012;
    const yL = fit.openTop ? fit.header.y - 0.03 : Math.max(e.y + 0.09, fit.roof - 0.045), xH = wsX(yL), xR = fit.xRear, yF = 0.2;
    Object.assign(rig, { yD, yL, xH, xD1 });
    // dashboard: top from the lip to the base of the screen, fascia down to the floor
    { const pos = [], idx = [], n = 8;
      for (let i = 0; i <= n; i++) { const t = i / n, x = xD1 + (xD0 - xD1) * t, y = yDr + (yD - yDr) * t, z = sideZ(Math.min(x, fit.xFront - 0.05), y, 0); pos.push(x, y, -z, x, y, z); if (i) { const a = 2 * i - 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); kit.mesh(g, dash);
      const zl = sideZ(xD1, yDr, 0);
      kit.quad(dash, V(xD1, yDr, -zl), V(xD1, yDr, zl), V(xD1 + 0.09, yF, zl), V(xD1 + 0.09, yF, -zl));
      kit.tube(soft, V(xD1, yDr - 0.004, -zl), V(xD1, yDr - 0.004, zl), 0.016);                                 // padded lip
      kit.quad(dark, V(xD0, yD, -zl), V(xD0, yD, zl), V(xD0, yD + 0.05, zl), V(xD0, yD + 0.05, -zl));           // scuttle under the wipers
      kit.quad(dark, V(xD0 - 0.02, yD + 0.004, -zl), V(xD0 - 0.02, yD + 0.004, zl), V(xD0 - 0.16, yD + 0.004, zl * 0.96), V(xD0 - 0.16, yD + 0.004, -zl * 0.96));   // demister vent strip
    }
    // floor, tunnel, back wall, door cards and door tops
    { const zf = sideZ(e.x, fit.belt, 0) + 0.02;
      kit.quad(dark, V(xR, yF, -zf), V(xD1 + 0.1, yF, -zf), V(xD1 + 0.1, yF, zf), V(xR, yF, zf));
      kit.quad(dark, V(xR, yF, -zf), V(xR, yF, zf), V(xR, yL, zf), V(xR, yL, -zf));
      const tw = k === 'proto' ? 0 : 0.12, ty = Math.max(yF + 0.12, fit.belt - (race ? 0.42 : 0.3));
      if (tw) { kit.mesh(new THREE.BoxGeometry(xD1 - xR + 0.1, ty - yF, 2 * tw), race ? dark : soft).position.set((xD1 + 0.1 + xR) / 2, (ty + yF) / 2, 0);
        if (!race && !spec.engine.electric && (spec.shiftTime ?? 0) > 0.15) {                               // manual: gear lever
          const base = V(e.x + 0.34, ty, 0), knob = V(e.x + 0.3, ty + 0.17, s * 0.015); kit.tube(kit.mat({ color: 0x9a9da3, metalness: 0.8, roughness: 0.3 }), base, knob, 0.007);
          kit.mesh(new THREE.SphereGeometry(0.027, 12, 10), soft).position.copy(knob); kit.mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.05, 12), dark).position.copy(base).y += 0.02; rig.lever = { knob };
        } }
      for (const sd of [-1, 1]) {
        const p0 = V(xR, fit.belt, sd * sideZ(xR, fit.belt)), p1 = V(wsX(fit.belt), fit.belt, sd * sideZ(wsX(fit.belt), fit.belt));
        kit.beam(trim, p0, p1, 0.1, 0.06, V(0, 0, -sd), [0.5, -sd * 0.5]);                             // door top / window sill
        const zi = sd * (sideZ(e.x, fit.belt) - 0.085), zj = sd * (sideZ(xD1 + 0.4, fit.belt) - 0.085);
        kit.quad(trim, V(xR, yF, zi), V(xD1 + 0.4, yF, zj), V(xD1 + 0.4, fit.belt - 0.02, zj), V(xR, fit.belt - 0.02, zi));
        kit.beam(soft, V(e.x - 0.25, fit.belt - 0.15, zi), V(e.x + 0.45, fit.belt - 0.13, sd * (sideZ(e.x + 0.45, fit.belt) - 0.085)), 0.07, 0.07, V(0, 0, -sd), [0.5, 0]);   // arm rest
      }
    }
    // A-pillars, header, roof lining and side rails
    const wP = k === 'proto' ? 0.13 : race ? 0.085 : 0.1, base = [], topP = [];
    for (const sd of [-1, 1]) {
      const yb = yD - 0.03, xb = wsX(yb), b = V(xb, yb, sd * sideZ(xb, yb)), t = V(xH, yL, sd * sideZ(xH, yL));
      base.push(b); topP.push(t);
      kit.beam(trim, b, t, wP, 0.075, V(0, 0, -sd), [0.5, sd * 0.5]);
      if (!fit.openTop) kit.beam(trim, t, V(xR, yL, sd * sideZ(xR, yL)), 0.085, 0.06, V(0, 0, -sd), [0.5, sd * 0.5]);
    }
    kit.beam(trim, topP[0], topP[1], fit.openTop ? 0.06 : 0.12, 0.05, V(-1, 0, 0), [0.5, 0.5]);
    if (!fit.openTop) { const zh = sideZ(xH, yL, 0), zr = sideZ(xR, yL, 0); kit.quad(trim, V(xH, yL, -zh), V(xH, yL, zh), V(xR, yL, zr), V(xR, yL, -zr)); }
    // tinted band along the top of the screen
    { const y1 = yL - 0.085, x1 = wsX(y1, 0.012), x0 = wsX(yL, 0.012), z0 = sideZ(x0, yL), z1 = sideZ(x1, y1);
      const sun = new THREE.MeshBasicMaterial({ color: race ? (spec.body?.color ?? 0x101010) : 0x05070a, transparent: true, opacity: race ? 0.9 : 0.6, side: THREE.DoubleSide, depthWrite: false }); kit.mats.push(sun);
      if (race) sun.color.multiplyScalar(0.35);
      kit.quad(sun, V(x0, yL, -z0), V(x0, yL, z0), V(x1, y1, z1), V(x1, y1, -z1)).renderOrder = 3; }
    // interior mirror
    if (k !== 'proto') {
      const mp = V(xH - 0.03, yL - 0.085, 0), mm = kit.mat({ color: 0xffffff, roughness: 0.25, metalness: 0.2, envMapIntensity: 0.9, map: kit.tex(canvasTex(64, 16, (g) => { const gr = g.createLinearGradient(0, 0, 0, 16); gr.addColorStop(0, '#30363d'); gr.addColorStop(0.45, '#6f7780'); gr.addColorStop(0.55, '#1b1d20'); gr.addColorStop(1, '#0c0d0e'); g.fillStyle = gr; g.fillRect(0, 0, 64, 16); })) });
      const h = new THREE.Group(); kit.group.add(h); facing(h, mp, V(e.x, e.y - 0.02, e.z * 0.75));
      kit.mesh(new THREE.BoxGeometry(race ? 0.3 : 0.23, 0.062, 0.02), dark, h); kit.mesh(new THREE.PlaneGeometry(race ? 0.285 : 0.215, 0.05), mm, h).position.z = 0.0105;
      kit.tube(dark, V(xH + 0.03, yL - 0.01, 0), V(mp.x + 0.008, mp.y + 0.02, 0), 0.009);
    }
    // instruments
    if (k === 'road') {
      const cw = 0.29, ch = cw * 192 / 512, pc = V(xD1 - 0.012, C.y + 0.105, e.z), sc = screen(kit.group, cw, ch); facing(sc, pc, V(e.x, e.y - 0.03, e.z));
      const top = pc.y + ch / 2 + 0.022, bot = Math.min(yDr, pc.y - ch / 2) - 0.01, hw = cw / 2 + 0.03, sh = new THREE.Shape();
      sh.moveTo(-hw, bot); sh.lineTo(-hw, top - 0.04); sh.quadraticCurveTo(-hw, top, -hw + 0.05, top); sh.lineTo(hw - 0.05, top); sh.quadraticCurveTo(hw, top, hw, top - 0.04); sh.lineTo(hw, bot); sh.lineTo(-hw, bot);
      const hood = kit.mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.2, bevelEnabled: false, curveSegments: 6 }).rotateY(Math.PI / 2), dash); hood.position.set(pc.x + 0.004, 0, e.z);
      // centre screen and vents
      const cs = kit.mesh(new THREE.PlaneGeometry(0.23, 0.13), new THREE.MeshBasicMaterial({ toneMapped: false, map: kit.tex(canvasTex(256, 144, (g, W, H) => {
        g.fillStyle = '#0a1016'; g.fillRect(0, 0, W, H); g.strokeStyle = '#1f3b52'; g.lineWidth = 2; for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(0, 20 + i * 22); g.bezierCurveTo(80, 10 + i * 18, 160, 50 + i * 20, W, 14 + i * 24); g.stroke(); }
        g.strokeStyle = '#3aa0ff'; g.lineWidth = 4; g.beginPath(); g.moveTo(30, 130); g.bezierCurveTo(90, 90, 120, 100, 150, 60); g.lineTo(215, 34); g.stroke(); g.fillStyle = '#ff5a1f'; g.beginPath(); g.arc(150, 60, 6, 0, 6.3); g.fill();
        g.fillStyle = '#0e151c'; g.fillRect(0, 0, W, 20); g.fillStyle = '#9fb3c4'; g.font = `12px ${FONT}`; g.fillText(spec.name || '', 8, 14);
      })) }));
      kit.mats.push(cs.material); facing(cs, V(xD1 - 0.006, yDr - 0.085, 0), V(e.x, e.y, e.z * 0.5)); kit.mesh(new THREE.BoxGeometry(0.25, 0.15, 0.02), dark, cs).position.z = -0.011;
      for (const zz of [-1, 1]) { const v = kit.mesh(new THREE.BoxGeometry(0.012, 0.045, 0.11), soft); v.position.set(xD1 - 0.004, yDr - 0.05, zz * (sideZ(xD1, yDr) - 0.14)); }
    } else if (k === 'gt') {
      // dash logger on the column, switch panel in the middle
      const cw = 0.235, ch = cw * 192 / 512, pc = V(C.x + 0.1, C.y + 0.112, e.z), pod = new THREE.Group(); kit.group.add(pod); facing(pod, pc, V(e.x, e.y - 0.02, e.z));
      kit.mesh(new THREE.BoxGeometry(cw + 0.02, ch + 0.02, 0.03), dark, pod).position.z = -0.016; screen(pod, cw, ch);
      kit.tube(dark, V(pc.x + 0.02, pc.y - 0.02, pc.z), V(xD1 + 0.05, yDr - 0.04, pc.z), 0.014);
      const pp = V(xD1 - 0.01, yDr - 0.1, 0), pn = new THREE.Group(); kit.group.add(pn); facing(pn, pp, V(e.x, e.y, e.z * 0.6));
      const carbon = kit.mat({ color: 0xffffff, map: kit.tex(carbonTex()), roughness: 0.5 }); kit.mesh(new THREE.BoxGeometry(0.24, 0.17, 0.02), carbon, pn);
      const cols = [0xff3b30, 0xffcc00, 0x34c759, 0x0a84ff, 0xf2f2f2, 0xff9500, 0xf2f2f2, 0x34c759], bg = new THREE.CylinderGeometry(0.009, 0.009, 0.01, 10).rotateX(Math.PI / 2); kit.geos.push(bg);
      for (let i = 0; i < 12; i++) { const b = new THREE.Mesh(bg, kit.mat({ color: cols[i % 8], roughness: 0.5 })); b.position.set(-0.088 + (i % 4) * 0.058, 0.05 - Math.floor(i / 4) * 0.05, 0.013); pn.add(b); }
    }
    // roll cage and window net
    if (k === 'gt') {
      const cage = kit.mat({ color: 0xb9bcc2, roughness: 0.45, metalness: 0.35, envMapIntensity: 0.8 }), r = 0.021, tp = [];
      for (const sd of [-1, 1]) {
        const i = sd < 0 ? 0 : 1, b = base[i].clone().add(V(-0.12, 0.0, -sd * 0.1)), t = topP[i].clone().add(V(-0.1, -0.045, -sd * 0.085)), rr = V(xR, yL - 0.05, sd * (sideZ(xR, yL) - 0.085));
        tp.push(t); kit.tube(cage, V(b.x + 0.25, yF, b.z), b, r); kit.tube(cage, b, t, r); kit.tube(cage, t, rr, r);
        const zd = sd * (sideZ(e.x, fit.belt) - 0.06);
        kit.tube(cage, V(b.x - 0.05, fit.belt - 0.06, zd), V(xR, fit.belt - 0.3, zd), r * 0.9); kit.tube(cage, V(b.x - 0.05, fit.belt - 0.34, zd), V(xR, fit.belt - 0.04, zd), r * 0.9);
      }
      kit.tube(cage, tp[0], tp[1], r);
      if (s) { const net = new THREE.MeshBasicMaterial({ map: kit.tex(netTex()), transparent: true, side: THREE.DoubleSide, depthWrite: false }); kit.mats.push(net);
        const xa = e.x + 0.34, y0 = fit.belt + 0.02, y1 = yL - 0.04, q = kit.quad(net, V(xR, y0, s * sideZ(xR, y0, 0.06)), V(xa, y0, s * sideZ(xa, y0, 0.06)), V(xa, y1, s * sideZ(xa, y1, 0.06)), V(xR, y1, s * sideZ(xR, y1, 0.06)));
        net.map.repeat.set(Math.round((xa - xR) / 0.07), Math.round((y1 - y0) / 0.07)); net.map.wrapS = net.map.wrapT = THREE.RepeatWrapping; q.renderOrder = 3; }
    }
  }
  rig.wheel = buildWheel(kit, fit, spec, C);
  if (rig.wheel.screenAt) { const a = rig.wheel.screenAt; screen(a.parent, a.w, a.h).position.copy(a.pos); kit.mesh(new THREE.BoxGeometry(a.w + 0.012, a.h + 0.012, 0.006), dark, a.parent).position.copy(a.pos).z -= 0.0035; }
  rig.arms = buildArms(kit, fit, spec);
  // neutral reach sets the arm length, so every car is driven with the same bend at the elbow
  const w0 = rig.wheel.wrists[1], wp = wristPos(rig, w0, V()), d0 = wp.distanceTo(rig.arms[1].shoulder);
  rig.L = d0 * 0.56; rig.vmax = Math.ceil((spec.reference?.topKmh?.[1] ?? 300) / 40) * 40 + 20;
  rig.info = { vmax: Math.max(200, rig.vmax), onWheel: !!rig.wheel.screenAt };
  return rig;
}

function wristPos(rig, w, out) {
  const wh = rig.wheel; wh.spin.updateMatrix(); wh.group.updateMatrix(); w.hand.updateMatrix();
  return out.copy(w.local).applyMatrix4(w.hand.matrix).applyMatrix4(wh.spin.matrix).applyMatrix4(wh.group.matrix);
}

const _s = V(), _w = V(), _e = V(), _d = V(), _p = V();
function updateRig(rig, dt, car, spec, info) {
  const E = rig.fit.E, wh = rig.wheel;
  // steering: road-wheel angle through the steering ratio, eased off towards the most a driver would wind on
  // without moving his hands, then lagged a little like a real column
  const raw = car.steer * spec.steerLock * E.ratio, target = E.maxTurn * Math.tanh(raw / E.maxTurn);
  rig.phi += (target - rig.phi) * (1 - Math.exp(-dt * 26)); rig.rawPhi = raw;
  wh.spin.rotation.z = rig.phi;                 // + = anticlockwise seen from the seat = left
  // paddles flick on a gear change (right = up, left = down); manual cars: the lever moves instead
  if (rig.gear !== null && car.gear !== rig.gear) { const up = car.gear > rig.gear ? 1 : 0; rig.flick[up] = 0.16; }
  rig.gear = car.gear;
  for (let i = 0; i < 2; i++) { rig.flick[i] = Math.max(0, rig.flick[i] - dt); if (wh.paddles[i]) wh.paddles[i].position.z = -0.034 + (rig.flick[i] > 0 ? 0.016 : 0); }
  // arms: two-bone IK from the shoulders to the wrists, elbows down and out
  for (let i = 0; i < 2; i++) {
    const arm = rig.arms[i], L = rig.L, S = _s.copy(arm.shoulder), W = wristPos(rig, wh.wrists[i], _w);
    let d = _d.subVectors(W, S), dist = d.length(); const max = 2 * L * 0.985;
    if (dist > max) { S.addScaledVector(d, (dist - max) / dist); d.subVectors(W, S); dist = max; }      // lean the shoulder into a long reach
    d.divideScalar(dist);
    const h = Math.sqrt(Math.max(0, L * L - dist * dist / 4)), pole = _p.set(-0.1, -1, arm.s * 0.5); pole.addScaledVector(d, -pole.dot(d)).normalize();
    const El = _e.copy(S).addScaledVector(d, dist / 2).addScaledVector(pole, h);
    place(arm.upper, El, S); place(arm.fore, W, El); arm.elbow.position.copy(El); arm.cuff.position.copy(W); arm.ball.position.copy(S);
  }
  // instruments and shift lights, at most 20 times a second
  rig.t -= dt;
  if (rig.t <= 0) {
    rig.t = 0.05;
    const inf = Object.assign(rig.info, info), g = rig.ctx;
    if (rig.fit.klass === 'road') drawRoad(g, 512, 192, car, spec, inf); else drawRace(g, 512, 192, car, spec, inf);
    rig.tex.needsUpdate = true;
    const frac = car.rpm / spec.engine.redline, n = wh.leds.length;
    for (let i = 0; i < n; i++) wh.leds[i].color.setHex(car.limiterOn ? (Math.floor(performance.now() / 60) % 2 ? 0x3d7bff : 0x15171a) : frac > 0.8 + i * 0.019 ? LED_COLS[i] : 0x15171a);
  }
}

// ---------------------------------------------------------------------------------- per-frame entry point
const Q_FWD = new THREE.Quaternion().setFromAxisAngle(UP, -Math.PI / 2);   // camera -Z -> car +X
const _eul = new THREE.Euler(0, 0, 0, 'YXZ'), _qc = new THREE.Quaternion(), _sc = V();

class InCar {
  constructor() { this.model = null; this.rig = null; this.rigKey = ''; this.clipped = null; this.planes = []; this.bonnetYaw = 0; }

  // Call every frame, whatever the camera. `mode` is the camera name ('cockpit' and 'bonnet' are ours;
  // anything else hides the cockpit and undoes the clipping). Sets the camera pose and near plane and
  // returns the field of view to use, or null when the camera is not an in-car one.
  //   o = { renderer, camera, composer, model, spec, car, mode, dt, info: { lapTime, lastLap, delta } }
  update(o) {
    const { renderer, camera, model, spec, car, mode, dt } = o, inside = mode === 'cockpit', ours = inside || mode === 'bonnet';
    const key = model ? `${spec.id}:${model.glb ? 'glb' : 'proc'}` : '';
    if (this.rig && (model !== this.model || key !== this.rigKey || model.disposed)) { this.unclip(); this.rig.kit.dispose(); this.rig = null; }
    this.model = model;
    const ao = o.composer?.passes.find(p => p.gtaoMaterial); if (ao) ao.enabled = !inside;     // the AO pass cannot see the clipping
    const near = inside ? 0.07 : ours ? 0.15 : 0.3; if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
    if (!ours || !model) { if (this.rig) this.rig.kit.group.visible = false; this.unclip(); return null; }
    const fit = cabinFit(model, spec), ch = model.chassis;
    model.root.updateMatrixWorld(true);
    ch.matrixWorld.decompose(_sc, _qc, _a);
    const yawRate = clamp((car.r || 0) * (inside ? 0.2 : 0.1), -0.2, 0.2), kS = 1 - Math.exp(-dt * 5);
    if (!inside) {
      if (this.rig) this.rig.kit.group.visible = false; this.unclip();
      this.bonnetYaw += (yawRate - this.bonnetYaw) * kS;
      camera.position.set(...fit.bonnet).applyMatrix4(ch.matrixWorld);
      camera.quaternion.copy(_qc).multiply(Q_FWD).multiply(_q.setFromEuler(_eul.set(fit.bonnetPitch, this.bonnetYaw, 0)));
      return 60 + Math.min(6, car.speed * 0.07);
    }
    if (!this.rig) { this.rig = buildCockpit(model, spec, fit); this.rigKey = key; (model.root.parent || o.scene)?.add(this.rig.kit.group); }
    const rig = this.rig, h = rig.head, kit = rig.kit.group;
    kit.visible = true; kit.matrix.copy(ch.matrixWorld); kit.matrixWorldNeedsUpdate = true;
    updateRig(rig, dt, car, spec, o.info);
    this.clip(renderer, model, fit);
    // head: looks into the corner, is pushed about a little by the g-forces, tilts with the turn
    const ay = car.ayF || 0, ax = car.axF || 0, kH = 1 - Math.exp(-dt * 7);
    h.yaw += (yawRate - h.yaw) * kS; h.sway += (clamp(-ay * 0.0012, -0.028, 0.028) - h.sway) * kH; h.surge += (clamp(-ax * 0.0011, -0.025, 0.035) - h.surge) * kH; h.roll += (clamp(ay * 0.0011, -0.03, 0.03) - h.roll) * kH;
    camera.position.set(fit.eye[0] + h.surge, fit.eye[1], fit.eye[2] + h.sway).applyMatrix4(ch.matrixWorld);
    camera.quaternion.copy(_qc).multiply(Q_FWD).multiply(_q.setFromEuler(_eul.set(fit.open ? -0.05 : -0.085, h.yaw, h.roll)));
    return fit.E.fov + Math.min(4, car.speed * 0.05);
  }

  // cut the cabin hull out of the exterior model (world-space planes, refreshed every frame)
  clip(renderer, model, fit) {
    if (!fit.planes.length) return;
    if (!this.clipped) {
      renderer.localClippingEnabled = true;
      while (this.planes.length < fit.planes.length) this.planes.push(new THREE.Plane());
      this.planes.length = fit.planes.length;
      const mats = new Set(); model.chassis.traverse((m) => { if (m.isMesh && m !== model.shadow) for (const x of [].concat(m.material)) mats.add(x); });
      this.clipped = [...mats].map((m) => ({ m, planes: m.clippingPlanes, inter: m.clipIntersection }));
      for (const c of this.clipped) { c.m.clippingPlanes = this.planes; c.m.clipIntersection = true; }
    }
    const M = model.chassis.matrixWorld;
    fit.planes.forEach((p, i) => { this.planes[i].normal.set(p[0], p[1], p[2]); this.planes[i].constant = p[3]; this.planes[i].applyMatrix4(M); });
  }
  unclip() { if (!this.clipped) return; for (const c of this.clipped) { c.m.clippingPlanes = c.planes; c.m.clipIntersection = c.inter; } this.clipped = null; }

  // numbers for tools and tests
  debug() { const r = this.rig; return r ? { wheelAngle: r.phi, rawWheelAngle: r.rawPhi, fit: r.fit, meshes: r.kit.geos.length } : null; }
}

export const inCar = new InCar();
