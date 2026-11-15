// Browser entry point: renderer, fixed-step sim loop, cameras, ghosts, UI.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

// Final grade: gentle filmic contrast, a touch of saturation, vignette.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec4 c=texture2D(tDiffuse,vUv); vec3 x=c.rgb;
      float l=dot(x,vec3(0.2126,0.7152,0.0722)); x=mix(vec3(l),x,1.12);
      x=mix(x, x*x*(3.0-2.0*x), 0.22);
      x*=vec3(1.02,1.0,0.97);
      vec2 d=vUv-0.5; x*=1.0-dot(d,d)*0.55;
      gl_FragColor=vec4(x,c.a); }`,
};
import { buildTrack, nearestIndexGlobal, TRACKS, TRACK_ORDER } from '../sim/track.js';
import { CARS, CAR_ORDER } from '../sim/cars.js';
import { Sim } from '../sim/sim.js';
import { SIM_DT, peakPower } from '../sim/vehicle.js';
import { BaselineDriver, lineDriverOptions } from '../sim/drivers/baseline.js';
import { PolicyDriver } from '../sim/drivers/policy-driver.js';
import { OBS_DIM } from '../sim/drivers/rl-interface.js';
import { buildWorld, trackHeight } from './world.js';
import { buildCarModel } from './carmodel.js';
import { Input } from './input.js';
import { Effects } from './effects.js';
import { HUD, fmtTime } from './hud.js';
import { Recorder, TelemetryPanel, LapTrace, BIN } from './telemetry.js';
import { Props } from './props.js';
import { buildLineGuide } from './lineviz.js';
import { AudioEngine } from '../audio/audio.js';
import validation from '../data/car-validation.json';

const policyModules = import.meta.glob('../policies/*.json', { eager: true });
const POLICIES = {};
for (const [path, mod] of Object.entries(policyModules)) POLICIES[path.match(/([^/]+)\.json$/)[1]] = mod.default ?? mod;

// storage can be unavailable (private windows, sandboxed embeds): never let it break the game
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const QUALITY = {
  low: { shadows: false, shadowMap: 1024, trees: 350, maxDpr: 1, bloom: false },
  medium: { shadows: true, shadowMap: 2048, trees: 800, maxDpr: 1.5, bloom: false },
  high: { shadows: true, shadowMap: 4096, trees: 1400, maxDpr: 2, bloom: true },
};
const params = new URLSearchParams(location.search);
const CAMS = ['chase', 'far', 'bonnet', 'tv'];

class Game {
  constructor() {
    this.trackId = TRACKS[params.get('track')] ? params.get('track') : (TRACKS[store.get('rr-track')] ? store.get('rr-track') : 'ravenscar');
    this.track = buildTrack(this.trackId);
    this.qualityName = params.get('q') || store.get('rr-quality') || 'high';
    this.quality = QUALITY[this.qualityName] || QUALITY.high;
    const canvas = document.getElementById('gl');
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.maxDpr));
    r.shadowMap.enabled = this.quality.shadows; r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.62;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.3, 9000);
    this.world = buildWorld(this.track, r, this.quality);
    this.scene.add(this.world.group);
    this.scene.fog = new THREE.Fog(this.world.fogColor, 350, 4200);
    // image-based lighting from the procedural sky
    const pm = new THREE.PMREMGenerator(r), envScene = new THREE.Scene();
    const skyClone = this.world.sky.clone(); envScene.add(skyClone);
    this.scene.environment = pm.fromScene(envScene, 0, 1, 10000).texture; this.scene.environmentIntensity = 0.55;
    pm.dispose();
    this.setupComposer();
    this.effects = new Effects(this.scene);
    this.props = new Props(this.scene, this.track, this.world);
    this.ui = document.getElementById('ui');
    this.hud = new HUD(this.ui, this.track);
    this.rec = new Recorder(this.track);
    this.cursorS = null;
    this.tel = new TelemetryPanel(this.ui, this.rec, this.track, (s) => { this.cursorS = s; });
    this.audio = new AudioEngine();
    this.input = new Input();
    this.cam = 0; this.camPos = new THREE.Vector3(); this.camLook = new THREE.Vector3(); this.camInit = false;
    this.ghostMode = 'best'; this.autopilot = false; this.paused = true; this.acc = 0; this.last = performance.now();
    this.perf = { show: params.has('perf'), frames: 0, t: 0, fps: 0, simMs: 0, frameMs: 0, simAcc: 0, frameAcc: 0, worst: 0 };
    this.wheelWorld = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.tvPosts = this.buildTvPosts();
    this.bindKeys();
    this.buildMenu();
    this.setCar(params.get('car') || store.get('rr-car') || 'gt3');
    window.addEventListener('resize', () => this.resize()); this.resize();
    document.getElementById('loading').remove();
    if (params.has('autostart')) this.start(params.has('ai')); else this.showMenu(true);
    requestAnimationFrame((t) => this.frame(t));
  }

  buildTvPosts() {
    const t = this.track, posts = [];
    for (let i = 40; i < t.n; i += 230) {
      const side = t.curv[i] > 0 ? -1 : 1, h = t.heading[i], off = side * ((side > 0 ? t.wallL[i] : t.wallR[i]) + 3);
      posts.push(new THREE.Vector3(t.x[i] - Math.sin(h) * off, t.z[i] + 6.5, -(t.y[i] + Math.cos(h) * off)));
    }
    return posts;
  }

  bindKeys() {
    const k = this.input;
    k.on('KeyC', () => { this.cam = (this.cam + 1) % CAMS.length; this.camInit = false; this.hud.toast(`Camera: ${CAMS[this.cam]}`, 1.2); });
    k.on('KeyT', () => this.tel.toggle());
    k.on('KeyR', () => this.recover());
    k.on(['Enter', 'Backspace'], () => { if (!this.paused) this.restart(); });
    k.on('KeyE', () => this.manualShift(1)); k.on('KeyQ', () => this.manualShift(-1));
    k.on('KeyM', () => { const a = this.sim.car.aids; a.autoShift = !a.autoShift; this.hud.toast(a.autoShift ? 'Automatic gearbox' : 'Manual gearbox (Q / E)', 1.5); });
    k.on('KeyZ', () => { const a = this.sim.car.aids; a.abs = !a.abs; this.hud.toast(`ABS ${a.abs ? 'on' : 'off'}`, 1.2); });
    k.on('KeyX', () => { const a = this.sim.car.aids; a.tc = !a.tc; this.hud.toast(`Traction control ${a.tc ? 'on' : 'off'}`, 1.2); });
    k.on('KeyN', () => this.hud.toast(this.audio.toggleMute() ? 'Sound off' : 'Sound on', 1.2));
    k.on('KeyF', () => { this.perf.show = !this.perf.show; document.getElementById('perf').style.display = this.perf.show ? 'block' : 'none'; });
    k.on('KeyG', () => { this.ghostMode = { off: 'best', best: 'ai', ai: 'off' }[this.ghostMode]; this.hud.toast(`Ghost: ${{ off: 'off', best: 'your best lap', ai: 'AI lap' }[this.ghostMode]}`, 1.5); });
    k.on('KeyI', () => this.setAutopilot(!this.autopilot));
    k.on('KeyL', () => { this.showLine = !this.showLine; store.set('rr-line', this.showLine ? '1' : '0'); this.refreshLineGuide(); this.hud.toast(`Racing line ${this.showLine ? 'shown — green: power, red: brake' : 'hidden'}`, 1.6); });
    k.on('Escape', () => this.showMenu(document.getElementById('menu').classList.contains('hidden')));
    CAR_ORDER.forEach((id, i) => k.on('Digit' + (i + 1), () => { if (!this.paused) { this.setCar(id); this.restart(); } }));
  }

  buildMenu() {
    const wrap = document.getElementById('cars');
    for (const id of CAR_ORDER) {
      const s = CARS[id], v = validation.find(r => r.car === s.name) || {}, pp = peakPower(s);
      const num = (x) => (typeof x === 'string' ? x.split(' ')[0] : '–');
      const el = document.createElement('div'); el.className = 'card'; el.dataset.id = id;
      el.innerHTML = `<h3>${s.name}</h3><div class="k">${s.klass}</div><div class="b">${s.blurb}</div><table>
        <tr><td>Power / mass</td><td>${Math.round(pp.watts / 745.7)} hp / ${s.mass} kg</td></tr>
        <tr><td>0–100 km/h</td><td>${num(v['0-100 s'])} s</td></tr>
        <tr><td>100–0 km/h</td><td>${num(v['100-0 m'])} m</td></tr>
        <tr><td>Cornering</td><td>${num(v['lat g (R60)'])} g</td></tr>
        <tr><td>Top speed</td><td>${num(v['top km/h'])} km/h</td></tr></table>`;
      el.onclick = () => this.setCar(id);
      el.ondblclick = () => { this.setCar(id); this.start(false); };
      wrap.appendChild(el);
    }
    const ts = document.getElementById('track');
    for (const id of TRACK_ORDER) { const o = document.createElement('option'); o.value = id; o.textContent = `${TRACKS[id].name}${TRACKS[id].real ? ' — ' + TRACKS[id].country : ' (original)'}`; ts.appendChild(o); }
    ts.value = this.trackId;
    ts.onchange = () => this.setTrack(ts.value);
    this.updateTrackInfo();
    const q = document.getElementById('quality'); q.value = this.qualityName;
    q.onchange = () => this.applyQuality(q.value);
    document.getElementById('go').onclick = () => this.start(false);
    document.getElementById('watch').onclick = () => this.start(true);
  }

  // Change graphics quality live. Tree density is fixed at world-build time, so
  // it follows the new setting the next time a circuit is loaded.
  applyQuality(name) {
    if (!QUALITY[name]) return;
    store.set('rr-quality', name);
    this.qualityName = name; const ql = this.quality = QUALITY[name], r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, ql.maxDpr));
    r.shadowMap.enabled = ql.shadows; this.world.sunLight.castShadow = ql.shadows;
    this.world.sunLight.shadow.mapSize.set(ql.shadowMap, ql.shadowMap);
    if (this.world.sunLight.shadow.map) { this.world.sunLight.shadow.map.dispose(); this.world.sunLight.shadow.map = null; }
    this.scene.traverse(o => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
    this.setupComposer();
    this.resize();
  }

  setupComposer() {
    this.composer = null;
    if (!this.quality.bloom) return;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const ao = new GTAOPass(this.scene, this.camera, 1, 1);
    ao.blendIntensity = 0.9; ao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
    this.composer.addPass(ao);
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.1, 0.4, 3.0));
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new SMAAPass());
  }

  // Swap circuits in place (no page reload).
  setTrack(id) {
    if (!TRACKS[id] || id === this.trackId) return;
    store.set('rr-track', id);
    this.scene.remove(this.world.group);
    this.world.group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); } } });
    this.props.dispose(this.scene); this.effects.clear();
    this.trackId = id; this.track = buildTrack(id);
    this.world = buildWorld(this.track, this.renderer, this.quality); this.scene.add(this.world.group);
    this.props = new Props(this.scene, this.track, this.world);
    this.rec = new Recorder(this.track); this.tel.setTrack(this.rec, this.track); this.hud.setTrack(this.track);
    this.tvPosts = this.buildTvPosts(); this.aiLap = null;
    this.updateTrackInfo();
    this.setCar(this.spec.id);
  }

  updateTrackInfo() {
    const t = this.track; let zmin = Infinity, zmax = -Infinity; for (let i = 0; i < t.n; i++) { zmin = Math.min(zmin, t.z[i]); zmax = Math.max(zmax, t.z[i]); }
    document.getElementById('trackname').innerHTML = `${t.name} <small>${(t.length / 1000).toFixed(2)} km · ${(2 * t.halfWidth).toFixed(0)} m wide · ${(zmax - zmin).toFixed(0)} m elevation change</small>`;
    document.getElementById('tracknote').textContent = t.real ? 'Real circuit: centreline and track width from open survey data (TUMFTM racetrack-database). Elevation is approximated; scenery is procedural.' : 'Original circuit designed for this simulator; the RL driver was trained here.';
  }

  showMenu(show) {
    document.getElementById('menu').classList.toggle('hidden', !show);
    this.paused = show;
    if (show) this.camInit = false;
    this.last = performance.now();
  }

  async start(ai) {
    this.showMenu(false);
    this.audio.start().then(() => this.audio.setCar(this.spec));
    this.restart();
    this.setAutopilot(ai);
  }

  makeAI(spec) {
    // trained policies are specific to the circuit they were trained on
    const pol = this.trackId === 'ravenscar' ? POLICIES[spec.id] : null;
    // ignore a policy trained against a different observation layout
    if (pol && pol.policy.sizes[0] === OBS_DIM) return { driver: new PolicyDriver(this.track, pol), label: 'RL policy' };
    return { driver: new BaselineDriver(this.track, spec, lineDriverOptions(this.track, spec)), label: 'racing-line driver' };
  }

  setCar(id) {
    if (!CARS[id]) id = 'gt3';
    const spec = this.spec = CARS[id];
    store.set('rr-car', id);
    document.querySelectorAll('.card').forEach(c => c.classList.toggle('sel', c.dataset.id === id));
    this.sim = new Sim(this.track, spec);
    this.sim.onLap = (t, valid) => this.onLap(t, valid);
    if (this.model) { this.scene.remove(this.model.root); this.model.dispose(); this.scene.remove(this.ghost.root); this.ghost.dispose(); }
    this.model = buildCarModel(spec); this.scene.add(this.model.root);
    this.ghost = buildCarModel(spec, { ghost: true }); this.ghost.root.visible = false; this.scene.add(this.ghost.root);
    this.rec.reset(); this.rec.hasAI = false;
    this.ai = this.makeAI(spec);
    this.hud.setCar(spec);
    this.refreshLineGuide();
    this.audio.setCar(spec);
    document.getElementById('aiinfo').textContent = `AI driver for this car: ${this.ai.label}`;
    this.camInit = false;
    // record the AI's reference lap in the background (deterministic, headless)
    clearTimeout(this.aiTimer);
    this.aiTimer = setTimeout(() => this.computeAILap(spec), 50);
    this.syncVisuals(0);
  }

  refreshLineGuide() {
    if (this.lineGuide) { this.scene.remove(this.lineGuide); this.lineGuide.geometry.dispose(); this.lineGuide = null; }
    if (this.showLine === undefined) this.showLine = store.get('rr-line') === '1';
    if (this.showLine) { this.lineGuide = buildLineGuide(this.track, this.spec); this.scene.add(this.lineGuide); }
  }

  computeAILap(spec) {
    const sim = new Sim(this.track, spec), ai = this.makeAI(spec), trace = new LapTrace(this.rec.nBins);
    let done = false;
    sim.onLap = (t, valid) => { if (sim.lap === 2) { trace.seal(); trace.lapTime = t; done = true; } else trace.clear(); };
    for (let i = 0; i < 300 * 400 && !done; i++) { sim.step(ai.driver.control(sim.car)); if (sim.lap >= 1) this.rec.sample(sim, trace); if (sim.car.wallContact > 0) break; }
    if (done && spec === this.spec) { this.rec.ai.copyFrom(trace); this.rec.hasAI = true; this.aiLap = trace.lapTime; document.getElementById('aiinfo').textContent = `AI driver for this car: ${ai.label} — flying lap ${fmtTime(trace.lapTime)}`; }
  }

  restart() {
    this.sim.reset(); const a = this.sim.car.aids; a.abs = this.spec.abs; a.tc = this.spec.tc; a.autoShift = true;
    this.rec.cur.clear(); this.effects.clear(); this.props.reset(); this.ai.driver.reset?.();
    this.input.steerPos = 0; this.camInit = false; this.acc = 0;
    this.hud.toast(this.autopilot ? 'AI driving' : 'Go!', 1.2);
  }

  recover() {
    const car = this.sim.car, t = this.track, i = nearestIndexGlobal(t, car.x, car.y);
    car.reset({ x: t.x[i], y: t.y[i], yaw: t.heading[i], speed: 0, idxHint: i });
    this.sim.prevS = car.s; this.sim.lapValid = false; this.camInit = false;
    this.hud.toast('Recovered to track — lap invalidated', 1.6);
  }

  manualShift(dir) { const car = this.sim.car; if (car.aids.autoShift && !this.spec.engine.electric) { car.aids.autoShift = false; this.hud.toast('Manual gearbox (M for auto)', 1.5); } car.requestShift(dir); }

  setAutopilot(on) {
    this.autopilot = on; this.ai.driver.reset?.();
    if (on) { const a = this.sim.car.aids; a.abs = this.spec.abs; a.tc = this.spec.tc; a.autoShift = true; }
    this.hud.toast(on ? `AI driving (${this.ai.label}) — press I to take over` : 'You have control', 2);
  }

  onLap(t, valid) {
    const isBest = this.rec.lapDone(t, valid);
    this.hud.lapCompleted(this.sim);
    this.hud.toast(`${fmtTime(t)}${valid ? (isBest ? '  — new best' : '') : '  (invalid)'}`, 3);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
  }

  // ------------------------------------------------------------------ frame
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.1) dt = 0.1;
    const f0 = performance.now();
    if (!this.paused) {
      this.acc += dt;
      const s0 = performance.now();
      let n = 0;
      while (this.acc >= SIM_DT && n < 40) {
        const car = this.sim.car;
        const c = this.autopilot ? this.ai.driver.control(car) : this.input.read(car, SIM_DT);
        this.sim.step(c);
        this.rec.sample(this.sim);
        this.acc -= SIM_DT; n++;
      }
      if (n === 40) this.acc = 0;
      this.rec.sampleGG(this.sim.car);
      this.perf.simAcc += performance.now() - s0;
    }
    this.syncVisuals(dt);
    this.updateCamera(dt);
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    const car = this.sim.car;
    this.audio.update(car, this.paused);
    if (!this.paused) {
      const ref = this.tel.ref();
      this.hud.update(dt, this.sim, {
        delta: this.rec.delta(this.sim, ref), refLabel: this.tel.refMode === 'ai' ? 'AI' : 'best',
        ghost: this.ghost.root.visible ? this.ghostPose : null, cursorS: this.cursorS, autopilot: this.autopilot,
        modeText: `${car.aids.autoShift ? 'AUTO' : 'MANUAL'} · ghost ${this.ghostMode}${this.autopilot ? ' · AI DRIVING' : ''}` + (this.aiLap ? `\nAI lap ${fmtTime(this.aiLap)}` : ''),
      });
      this.tel.draw(this.sim);
    }
    // perf
    const p = this.perf; p.frames++; p.t += dt; const fm = performance.now() - f0; p.frameAcc += fm; p.worst = Math.max(p.worst, dt * 1000);
    if (p.t >= 0.5) {
      p.fps = p.frames / p.t; p.simMs = p.simAcc / p.frames; p.frameMs = p.frameAcc / p.frames; p.worstMs = p.worst;
      const info = this.renderer.info.render; p.calls = info.calls; p.tris = info.triangles;
      if (p.show) document.getElementById('perf').textContent = `${p.fps.toFixed(0)} fps  worst ${p.worst.toFixed(1)} ms\nCPU ${p.frameMs.toFixed(2)} ms/frame (sim ${p.simMs.toFixed(3)})\n${info.calls} draws  ${(info.triangles / 1000).toFixed(0)}k tris\naudio: ${this.audio.mode}  q: ${this.qualityName}`;
      p.frames = 0; p.t = 0; p.simAcc = 0; p.frameAcc = 0; p.worst = 0;
    }
  }

  // Test / tooling hook: advance the simulation without rendering.
  fastForward(seconds) {
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) {
      const car = this.sim.car;
      this.sim.step(this.autopilot ? this.ai.driver.control(car) : this.input.read(car, SIM_DT));
      this.rec.sample(this.sim);
      if (i % 5 === 0) this.rec.sampleGG(car);
    }
    this.camInit = false;
  }

  syncVisuals(dt) {
    const car = this.sim.car, spec = this.spec, t = this.track, m = this.model;
    const h = trackHeight(t, car.idx, this.sim.car._proj.frac);
    const g = Math.atan(t.grade[car.idx]), che = Math.cos(car.headErr), she = Math.sin(car.headErr);
    m.root.position.set(car.x, h, -car.y);
    m.root.rotation.set(-g * she, car.yaw, g * che, 'YXZ');
    // body motion on the suspension: stiff race cars barely move
    const soft = spec.body.style === 'formula' ? 0.12 : spec.body.style === 'gt' ? 0.3 : 1;
    let bump = 0; for (let i = 0; i < 4; i++) if (car.surf[i] !== 0) bump += 0.25;
    const shake = bump * Math.min(1, car.speed / 20) * 0.006 * Math.sin(performance.now() * 0.09);
    m.chassis.rotation.z = THREE.MathUtils.clamp(car.axF * 0.0032 * soft, -0.05, 0.05) + shake;
    m.chassis.rotation.x = THREE.MathUtils.clamp(car.ayF * 0.0042 * soft, -0.07, 0.07) + shake * 0.7;
    m.chassis.position.y = -Math.min(0.03, 0.6 * spec.ClA * car.speed * car.speed / (spec.mass * 9.81) * 0.02) + shake * 2;
    const delta = car.steer * spec.steerLock;
    for (let i = 0; i < 4; i++) {
      m.setWheel(i, delta, car.omega[i] * dt);
      // contact patch world position for effects
      const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw), wx = car.wx[i], wy = car.wy[i];
      this.wheelWorld[i].set(car.x + wx * cy - wy * sy, h, -(car.y + wx * sy + wy * cy));
    }
    m.setBrake(car.brake > 0.05);
    if (!this.paused) {
      this.effects.update(dt, car, this.wheelWorld, car.yaw, this.renderer.domElement.height * 0.9);
      this.props.update(dt, car, spec);
    }
    this.world.updateSun(m.root.position);
    this.updateGhost();
  }

  updateGhost() {
    const g = this.ghost.root, sim = this.sim, rec = this.rec;
    const ref = this.ghostMode === 'ai' ? (rec.hasAI ? rec.ai : null) : this.ghostMode === 'best' ? (rec.hasBest ? rec.best : null) : null;
    if (!ref || sim.lapStart === null || this.autopilot && this.ghostMode === 'ai') { g.visible = false; return; }
    // find where the reference car was at the current lap time (binary search on time)
    const tNow = sim.time - sim.lapStart; let lo = 0, hi = rec.nBins - 1;
    if (tNow > ref.time[hi]) { g.visible = false; return; }
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ref.time[mid] < tNow) lo = mid + 1; else hi = mid; }
    const b = lo, t = this.track, i = Math.min(t.n - 1, Math.round(b * BIN / t.ds));
    g.visible = true; g.position.set(ref.x[b], t.z[i], -ref.y[b]); g.rotation.set(0, ref.yaw[b], 0);
    this.ghostPose = { x: ref.x[b], y: ref.y[b] };
  }

  updateCamera(dt) {
    const car = this.sim.car, cam = this.camera, pos = this.model.root.position, mode = CAMS[this.cam];
    const spd = car.speed;
    // direction of travel blended with heading so slides are visible
    const travel = spd > 3 ? Math.atan2(car.vx * Math.sin(car.yaw) + car.vy * Math.cos(car.yaw), car.vx * Math.cos(car.yaw) - car.vy * Math.sin(car.yaw)) : car.yaw;
    let dyaw = travel - car.yaw; while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    const yaw = car.yaw + THREE.MathUtils.clamp(dyaw, -0.6, 0.6) * (car.vx > 0 ? 0.55 : 0);
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    if (this.paused) {
      // showroom orbit behind the menu
      const a = performance.now() * 0.00012;
      cam.position.set(pos.x + Math.cos(a) * 7.5, pos.y + 2.1, pos.z + Math.sin(a) * 7.5);
      cam.lookAt(pos.x, pos.y + 0.6, pos.z); cam.fov = 42; cam.updateProjectionMatrix();
      return;
    }
    let fov = 58;
    if (mode === 'chase' || mode === 'far') {
      const dist = mode === 'chase' ? 6.4 : 11, hgt = mode === 'chase' ? 2.15 : 4.2;
      const tx = pos.x - fx * dist, ty = pos.y + hgt, tz = pos.z - fz * dist;
      if (!this.camInit) { this.camPos.set(tx, ty, tz); this.camInit = true; }
      const k = 1 - Math.exp(-dt * 7.5);
      this.camPos.x += (tx - this.camPos.x) * k; this.camPos.z += (tz - this.camPos.z) * k; this.camPos.y += (ty - this.camPos.y) * (1 - Math.exp(-dt * 4));
      cam.position.copy(this.camPos);
      cam.lookAt(pos.x + fx * 4.5, pos.y + 1.0, pos.z + fz * 4.5);
      fov = 56 + Math.min(18, spd * 0.2);
    } else if (mode === 'bonnet') {
      const b = this.spec.body, form = b.style === 'formula';
    const low = b.style === 'glb';
      const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw), ox = form ? 0.05 : 0.25, oy = form ? 0.78 : low ? b.height * 0.93 : b.height * 0.86;
      cam.position.set(pos.x + cy * ox, pos.y + oy, pos.z - sy * ox);
      const look = car.yaw + THREE.MathUtils.clamp(car.r * 0.12, -0.25, 0.25);
      cam.lookAt(cam.position.x + Math.cos(look) * 10, cam.position.y - 0.6 + Math.atan(this.track.grade[car.idx]) * 10 * Math.cos(car.headErr), cam.position.z - Math.sin(look) * 10);
      fov = 68 + Math.min(10, spd * 0.1);
    } else {
      let best = this.tvPosts[0], bd = Infinity;
      for (const p of this.tvPosts) { const d = p.distanceToSquared(pos); if (d < bd) { bd = d; best = p; } }
      cam.position.copy(best); cam.lookAt(pos.x, pos.y + 0.6, pos.z);
      fov = THREE.MathUtils.clamp(2 * Math.atan(9 / Math.sqrt(bd)) * 57.3, 7, 50);
    }
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 6); cam.updateProjectionMatrix(); }
  }
}

window.__game = new Game();
