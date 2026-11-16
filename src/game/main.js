// Browser entry point: renderer, fixed-step sim loop, cameras, ghosts, UI.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

// Final grade: filmic contrast, saturation, tint and vignette. The defaults are the
// clear-day look; each weather condition sets its own (see wx.js).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, sat: { value: 1.2 }, contrast: { value: 0.26 }, tint: { value: new THREE.Vector3(1.015, 1.0, 0.975) }, vignette: { value: 0.42 }, lift: { value: new THREE.Vector3(0, 0, 0) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float sat, contrast, vignette; uniform vec3 tint, lift; varying vec2 vUv;
    void main(){ vec4 c=texture2D(tDiffuse,vUv); vec3 x=c.rgb;
      float l=dot(x,vec3(0.2126,0.7152,0.0722)); x=mix(vec3(l),x,sat);
      x=mix(x, x*x*(3.0-2.0*x), contrast);
      x*=tint; x+=lift*(1.0-x);
      vec2 d=vUv-0.5; x*=1.0-dot(d,d)*vignette;
      gl_FragColor=vec4(x,c.a); }`,
};
import { buildTrack, nearestIndexGlobal, TRACKS, TRACK_ORDER, TRACK_GROUPS, TRACK_KM } from '../sim/track.js';
import { CARS, CAR_ORDER, CAR_GROUPS } from '../sim/cars.js';
import { Sim } from '../sim/sim.js';
import { SIM_DT, peakPower } from '../sim/vehicle.js';
import { BaselineDriver, lineDriverOptions } from '../sim/drivers/baseline.js';
import { PolicyDriver } from '../sim/drivers/policy-driver.js';
import { OBS_DIM } from '../sim/drivers/rl-interface.js';
import { buildWorld, trackHeight } from './world.js';
import { inCar } from './cockpit.js';
import { buildCarModel } from './carmodel.js';
import { getSky } from './sky.js';
import { Input } from './input.js';
import { TouchControls } from './touch.js';
import { DriveAssist, DIFFICULTY, DIFFICULTY_ORDER } from './assist.js';
import { Effects } from './effects.js';
import { HUD, fmtTime } from './hud.js';
import { Recorder, TelemetryPanel, LapTrace, BIN } from './telemetry.js';
import { Props } from './props.js';
import { buildLineGuide } from './lineviz.js';
import { AudioEngine } from '../audio/audio.js';
import { RaceMode } from './racemode.js';
import { TvCam } from './tvcam.js';
import { CONDITIONS, CONDITION_ORDER, patchFog } from './wx.js';
import { Weather, LensShader } from './weather.js';
import { wetFor } from '../sim/wet.js';

patchFog();   // before any material is compiled
import validation from '../data/car-validation.json';
import { Menu } from './menu.js';

const policyModules = import.meta.glob('../policies/*.json', { eager: true });
const POLICIES = {};
for (const [path, mod] of Object.entries(policyModules)) POLICIES[path.match(/([^/]+)\.json$/)[1]] = mod.default ?? mod;

// storage can be unavailable (private windows, sandboxed embeds): never let it break the game
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const QUALITY = {
  // trees: impostor cards per km of track (capped by treeCap); detail: trackside geometry level
  low: { shadows: false, shadowMap: 1024, shadowRange: 70, trees: 260, treeCap: 3500, detail: 0, maxDpr: 1, bloom: false },
  medium: { shadows: true, shadowMap: 2048, shadowRange: 80, trees: 750, treeCap: 9000, detail: 1, maxDpr: 1.5, bloom: false },
  high: { shadows: true, shadowMap: 4096, shadowRange: 110, trees: 1500, treeCap: 20000, detail: 2, maxDpr: 2, bloom: true },
};
const params = new URLSearchParams(location.search);
const CAMS = ['chase', 'far', 'bonnet', 'cockpit', 'tv'];

class Game {
  constructor() {
    this.trackId = TRACKS[params.get('track')] ? params.get('track') : (TRACKS[store.get('rr-track')] ? store.get('rr-track') : 'ravenscar');
    this.track = buildTrack(this.trackId);
    this.qualityName = params.get('q') || store.get('rr-quality') || (window.matchMedia?.('(pointer: coarse)').matches ? 'medium' : 'high');
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
    this.scene.fog = new THREE.FogExp2(this.world.fogColor.clone(), 0.00021);
    r.info.autoReset = false;   // reset once per frame (updateCamera) so the counters cover every pass
    // image-based lighting: analytic sky now, the photographed HDRI as soon as it has loaded
    const pm = new THREE.PMREMGenerator(r), envScene = new THREE.Scene();
    const skyClone = this.world.sky.clone(); envScene.add(skyClone);
    this.scene.environment = pm.fromScene(envScene, 0, 1, 10000).texture; this.scene.environmentIntensity = 0.55;
    pm.dispose();
    // tone mapping once the photographed sky (or a weather condition) is in charge; ?tm= and ?ev= override
    this.toneMapping = { aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping, agx: THREE.AgXToneMapping }[params.get('tm')] ?? THREE.AgXToneMapping;
    this.exposureOverride = params.has('ev') ? +params.get('ev') : null;
    this.wet = null;              // wet-track state for the sim and the AI (src/sim/wet.js); null = dry
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
    this.touch = new TouchControls(this.input, { onKey: (k) => this.input.handlers[k]?.(), store, toast: (m, t) => this.hud?.toast(m, t) });
    this.wx = new Weather(this, { env: this.scene.environment });
    this.cam = 0; this.camPos = new THREE.Vector3(); this.camLook = new THREE.Vector3(); this.camInit = false;
    this.diffId = DIFFICULTY[params.get('diff')] ? params.get('diff') : (DIFFICULTY[store.get('rr-diff')] ? store.get('rr-diff') : 'assist');
    this.ghostMode = 'best'; this.autopilot = false; this.paused = true; this.acc = 0; this.last = performance.now();
    this.perf = { show: params.has('perf'), frames: 0, t: 0, fps: 0, simMs: 0, frameMs: 0, simAcc: 0, frameAcc: 0, worst: 0 };
    this.wheelWorld = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.tvPosts = this.buildTvPosts();
    this.bindKeys();
    this.buildMenu();
    this.raceMode = new RaceMode(this, params, CAMS);   // race against AI cars (racemode.js); ?race=12&laps=3...
    this.setCar(params.get('car') || store.get('rr-car') || 'gt3');
    this.setWeather(params.get('wx') || (this.track.night ? 'dusk' : store.get('rr-wx')) || 'clear', true);   // night-race circuits open floodlit
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
    k.on('KeyH', () => { this.setDifficulty(DIFFICULTY_ORDER[(DIFFICULTY_ORDER.indexOf(this.diffId) + 1) % DIFFICULTY_ORDER.length]); });
    k.on('KeyZ', () => { const a = this.sim.car.aids; a.abs = !a.abs; this.hud.toast(`ABS ${a.abs ? 'on' : 'off'}`, 1.2); });
    k.on('KeyX', () => { const a = this.sim.car.aids; a.tc = !a.tc; this.hud.toast(`Traction control ${a.tc ? 'on' : 'off'}`, 1.2); });
    k.on('KeyN', () => this.hud.toast(this.audio.toggleMute() ? 'Sound off' : 'Sound on', 1.2));
    k.on('KeyF', () => { this.perf.show = !this.perf.show; document.getElementById('perf').style.display = this.perf.show ? 'block' : 'none'; });
    k.on('KeyG', () => { this.ghostMode = { off: 'best', best: 'ai', ai: 'off' }[this.ghostMode]; this.hud.toast(`Ghost: ${{ off: 'off', best: 'your best lap', ai: 'AI lap' }[this.ghostMode]}`, 1.5); });
    k.on('KeyI', () => this.setAutopilot(!this.autopilot));
    k.on('KeyV', () => this.setWeather(CONDITION_ORDER[(CONDITION_ORDER.indexOf(this.wxId) + 1) % CONDITION_ORDER.length]));
    k.on('KeyL', () => { this.showLine = !this.showLine; store.set('rr-line', this.showLine ? '1' : '0'); this.refreshLineGuide(); this.hud.toast(`Racing line ${this.showLine ? 'shown — green: power, red: brake' : 'hidden'}`, 1.6); });
    k.on('Escape', () => this.showMenu(document.getElementById('menu').classList.contains('hidden')));
    // 1-9 and 0 pick the first ten cars; [ and ] step through all of them
    CAR_ORDER.slice(0, 10).forEach((id, i) => k.on('Digit' + ((i + 1) % 10), () => { if (!this.paused) { this.setCar(id); this.restart(); } }));
    for (const [code, d] of [['BracketLeft', -1], ['BracketRight', 1]]) k.on(code, () => { if (this.paused) return; const n = CAR_ORDER.length; this.setCar(CAR_ORDER[(CAR_ORDER.indexOf(this.spec.id) + d + n) % n]); this.restart(); this.hud.toast(this.spec.name, 1.5); });
  }

  buildMenu() {
    // the front end (car rail, selected-car panel, chips) lives in menu.js
    this.menu = new Menu(this, { validation, store, conditions: CONDITIONS, conditionOrder: CONDITION_ORDER, difficulty: DIFFICULTY, difficultyOrder: DIFFICULTY_ORDER });
    const ts = document.getElementById('track');
    for (const [label, ids] of TRACK_GROUPS) { const g = document.createElement('optgroup'); g.label = label; for (const id of ids) { const o = document.createElement('option'); o.value = id; o.textContent = `${TRACKS[id].name}${TRACKS[id].real ? ' — ' + TRACKS[id].country : ' (original)'}${TRACK_KM[id] ? ' · ' + TRACK_KM[id].toFixed(2) + ' km' : ''}`; g.appendChild(o); } ts.appendChild(g); }
    ts.value = this.trackId;
    ts.onchange = () => this.setTrack(ts.value);
    this.updateTrackInfo();
    const q = document.getElementById('quality'); q.value = this.qualityName;
    q.onchange = () => this.applyQuality(q.value);
    const ws = document.getElementById('weather');
    for (const id of CONDITION_ORDER) { const o = document.createElement('option'); o.value = id; o.textContent = CONDITIONS[id].label; ws.appendChild(o); }
    ws.onchange = () => this.setWeather(ws.value);
    const ds = document.getElementById('difficulty');
    for (const id of DIFFICULTY_ORDER) { const o = document.createElement('option'); o.value = id; o.textContent = DIFFICULTY[id].label; ds.appendChild(o); }
    ds.value = this.diffId; ds.onchange = () => this.setDifficulty(ds.value);
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
    this.wx.apply();
    this.resize();
    this.menu?.sync();
  }

  // Change weather / time of day live. Wet conditions also change the physics
  // (track grip) and the AI's speed profile; the dry default leaves both untouched.
  setWeather(id, quiet = false) {
    if (!CONDITIONS[id]) id = 'clear';
    this.wxId = id; store.set('rr-wx', id);
    const ws = document.getElementById('weather'); if (ws) ws.value = id;
    this.wx.set(id); this.menu?.sync();
    this.setupComposer(); this.resize();
    const c = CONDITIONS[id], wet = wetFor(c.sim);
    if (wet !== this.wet) {
      this.wet = wet; this.sim.setWet(wet);
      this.ai = this.makeAI(this.spec); this.rec.hasAI = false; this.aiLap = null; this.refreshAssist();
      this.refreshLineGuide();
      document.getElementById('aiinfo').textContent = `AI driver for this car: ${this.ai.label}`;
      clearTimeout(this.aiTimer); this.aiTimer = setTimeout(() => this.computeAILap(this.spec), 50);
      this.raceMode?.onWet();
    }
    this.audio.setWeather?.({ rain: c.rain, wet: this.effects.wet });
    if (!quiet) this.hud.toast(`${c.label}${wet ? ` — track grip ${(wet.grip * 100).toFixed(0)} %` : ''}`, 2.2);
  }

  // Post-processing. High quality always runs the full chain (ambient occlusion, bloom,
  // SMAA); weather that needs the lens pass (light shafts, water on the lens) adds a
  // short chain on medium; low never post-processes.
  setupComposer() {
    this.composer?.dispose(); this.composer = null; this.wx?.bindPasses(null, null);
    const ql = this.quality, lensOn = !!this.wx?.needsLens, r = this.renderer;
    if (!ql.bloom && !lensOn) return;
    let rt;
    if (!ql.bloom) { const sz = r.getDrawingBufferSize(new THREE.Vector2()); rt = new THREE.WebGLRenderTarget(sz.x, sz.y, { type: THREE.HalfFloatType, samples: 4 }); }
    this.composer = new EffectComposer(r, rt);
    if (rt) this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    let lens = null;          // straight after the scene: it reads the sky mask in alpha
    if (lensOn) { lens = new ShaderPass(LensShader); this.composer.addPass(lens); }
    if (ql.bloom) {
      const ao = new GTAOPass(this.scene, this.camera, 1, 1);
      ao.blendIntensity = 0.9; ao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
      this.composer.addPass(ao);
    }
    if (ql.bloom) { const b = this.wx?.cond.bloom || [0.16, 6.0]; this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), b[0], 0.5, b[1])); }
    this.composer.addPass(new OutputPass());
    const grade = new ShaderPass(GradeShader); this.composer.addPass(grade);
    if (ql.bloom) this.composer.addPass(new SMAAPass());
    this.wx?.bindPasses(lens, grade);
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
    this.wx.apply();
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
    if (show) { this.camInit = false; this.menu?.sync(); } else this.menu?.help(false);
    this.last = performance.now();
  }

  async start(ai) {
    this.raceMode.stop(true);
    this.showMenu(false);
    this.audio.start().then(() => this.audio.setCar(this.spec));
    this.restart();
    this.setAutopilot(ai);
  }

  // Driving difficulty for the human driver (see assist.js). Never affects the AI.
  setDifficulty(id, quiet) {
    if (!DIFFICULTY[id]) id = 'assist';
    this.diffId = id; store.set('rr-diff', id);
    const sel = document.getElementById('difficulty'); if (sel) sel.value = id;
    this.menu?.sync();
    this.refreshAssist();
    if (!quiet) this.hud.toast(`Driving: ${DIFFICULTY[id].label}`, 1.8);
  }
  refreshAssist() {
    if (!this.sim || !this.spec) return;
    this.assist = new DriveAssist(this.track, this.spec, this.diffId || 'assist', this.wet);
    if (!this.autopilot) this.assist.setup(this.sim.car); else { this.sim.car.gripScale = 1; this.sim.car.aids.abs = this.spec.abs; this.sim.car.aids.tc = this.spec.tc; }
  }

  makeAI(spec) {
    // trained policies are specific to the circuit they were trained on
    // ... and to a dry track: in the wet the racing-line driver takes over with a scaled speed profile
    const pol = this.trackId === 'ravenscar' && !this.wet ? POLICIES[spec.id] : null;
    // ignore a policy trained against a different observation layout
    if (pol && pol.policy.sizes[0] === OBS_DIM) return { driver: new PolicyDriver(this.track, pol), label: 'RL policy' };
    return { driver: new BaselineDriver(this.track, spec, { ...lineDriverOptions(this.track, spec), wet: this.wet }), label: this.wet ? 'racing-line driver (wet set-up)' : 'racing-line driver' };
  }

  setCar(id) {
    this.raceMode?.stop(true);
    if (!CARS[id]) id = 'gt3';
    const spec = this.spec = CARS[id];
    store.set('rr-car', id);
    document.querySelectorAll('.card').forEach(c => { const on = c.dataset.id === id; c.classList.toggle('sel', on); if (on && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); });
    this.sim = new Sim(this.track, spec); this.sim.setWet(this.wet);
    this.sim.onLap = (t, valid) => this.onLap(t, valid);
    if (this.model) { this.scene.remove(this.model.root); this.model.dispose(); this.scene.remove(this.ghost.root); this.ghost.dispose(); }
    this.model = buildCarModel(spec); this.scene.add(this.model.root);
    this.ghost = buildCarModel(spec, { ghost: true }); this.ghost.root.visible = false; this.scene.add(this.ghost.root);
    this.wx.attachCar(this.model, spec);
    this.rec.reset(); this.rec.hasAI = false;
    this.ai = this.makeAI(spec); this.refreshAssist();
    this.hud.setCar(spec);
    this.refreshLineGuide();
    this.audio.setCar(spec);
    document.getElementById('aiinfo').textContent = `AI driver for this car: ${this.ai.label}`;
    this.camInit = false;
    // record the AI's reference lap in the background (deterministic, headless)
    clearTimeout(this.aiTimer);
    this.aiTimer = setTimeout(() => this.computeAILap(spec), 50);
    this.syncVisuals(0);
    this.menu?.sync();
  }

  refreshLineGuide() {
    if (this.lineGuide) { this.scene.remove(this.lineGuide); this.lineGuide.geometry.dispose(); this.lineGuide = null; }
    if (this.showLine === undefined) this.showLine = store.get('rr-line') === '1';
    if (this.showLine) { this.lineGuide = buildLineGuide(this.track, this.spec, this.wet); this.scene.add(this.lineGuide); }
  }

  computeAILap(spec) {
    const sim = new Sim(this.track, spec), ai = this.makeAI(spec), trace = new LapTrace(this.rec.nBins);
    sim.setWet(this.wet);
    let done = false;
    sim.onLap = (t, valid) => { if (sim.lap === 2) { trace.seal(); trace.lapTime = t; done = true; } else trace.clear(); };
    for (let i = 0; i < 300 * 400 && !done; i++) { sim.step(ai.driver.control(sim.car)); if (sim.lap >= 1) this.rec.sample(sim, trace); if (sim.car.wallContact > 0) break; }
    if (done && spec === this.spec) { this.rec.ai.copyFrom(trace); this.rec.hasAI = true; this.aiLap = trace.lapTime; document.getElementById('aiinfo').textContent = `AI driver for this car: ${ai.label} — flying lap ${fmtTime(trace.lapTime)}`; }
  }

  restart() {
    if (this.raceMode.active) return this.raceMode.restart();
    this.sim.reset(); const a = this.sim.car.aids; a.abs = this.spec.abs; a.tc = this.spec.tc; a.autoShift = true;
    this.rec.cur.clear(); this.effects.clear(); this.props.reset(); this.ai.driver.reset?.();
    this.input.steerPos = 0; this.camInit = false; this.acc = 0;
    this.refreshAssist();
    this.hud.toast(this.autopilot ? 'AI driving' : 'Go!', 1.2);
  }

  recover() {
    if (this.raceMode.active) return this.raceMode.recover();
    const car = this.sim.car, t = this.track, i = nearestIndexGlobal(t, car.x, car.y);
    car.reset({ x: t.x[i], y: t.y[i], yaw: t.heading[i], speed: 0, idxHint: i });
    this.sim.prevS = car.s; this.sim.lapValid = false; this.camInit = false;
    this.hud.toast('Recovered to track — lap invalidated', 1.6);
  }

  manualShift(dir) { const car = this.sim.car; if (car.aids.autoShift && !this.spec.engine.electric) { car.aids.autoShift = false; this.hud.toast('Manual gearbox (M for auto)', 1.5); } car.requestShift(dir); }

  setAutopilot(on) {
    this.autopilot = on; this.ai.driver.reset?.(); this.refreshAssist();
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
    this.composer?.setSize(w, h); this.wx?.resize();
  }

  // ------------------------------------------------------------------ frame
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    this.touch?.update(this.paused);
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.1) dt = 0.1;
    const f0 = performance.now();
    if (!this.paused && this.raceMode.active) this.raceMode.advance(dt);
    else if (!this.paused) {
      this.acc += dt;
      const s0 = performance.now();
      let n = 0;
      while (this.acc >= SIM_DT && n < 40) {
        const car = this.sim.car;
        const c = this.autopilot ? this.ai.driver.control(car) : this.assist.apply(this.input.read(car, SIM_DT), car, SIM_DT);
        this.sim.step(c);
        this.rec.sample(this.sim);
        this.acc -= SIM_DT; n++;
      }
      if (n === 40) this.acc = 0;
      this.rec.sampleGG(this.sim.car);
      this.perf.simAcc += performance.now() - s0;
    }
    this.syncVisuals(dt);
    this.raceMode.sync(dt);
    this.updateCamera(dt);
    this.wx.update(dt, this.sim.car, CAMS[this.cam], this.paused);
    this.wx.renderReflection();
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    const car = this.sim.car;
    this.audio.update(car, this.paused, CAMS[this.cam], this.camera.position.distanceTo(this.model.root.position));
    if (!this.paused) {
      const ref = this.tel.ref();
      this.hud.update(dt, this.sim, {
        delta: this.rec.delta(this.sim, ref), refLabel: this.tel.refMode === 'ai' ? 'AI' : 'best',
        ghost: this.ghost.root.visible ? this.ghostPose : null, cursorS: this.cursorS, autopilot: this.autopilot,
        modeText: `${car.aids.autoShift ? 'AUTO' : 'MANUAL'} · ghost ${this.ghostMode}${this.autopilot ? ' · AI DRIVING' : ''}${this.wet ? ` · ${this.wxId.toUpperCase()} ${(this.wet.grip * 100).toFixed(0)}%` : ''}` + (this.aiLap ? `\nAI lap ${fmtTime(this.aiLap)}` : ''),
      });
      this.tel.draw(this.sim);
    }
    // perf
    const p = this.perf; p.frames++; p.t += dt; const fm = performance.now() - f0; p.frameAcc += fm; p.worst = Math.max(p.worst, dt * 1000);
    if (p.t >= 0.5) {
      p.fps = p.frames / p.t; p.simMs = p.simAcc / p.frames; p.frameMs = p.frameAcc / p.frames; p.worstMs = p.worst;
      const info = this.renderer.info.render; p.calls = info.calls; p.tris = info.triangles;
      if (p.show) document.getElementById('perf').textContent = `${p.fps.toFixed(0)} fps  worst ${p.worst.toFixed(1)} ms\nCPU ${p.frameMs.toFixed(2)} ms/frame (sim ${p.simMs.toFixed(3)})\n${info.calls} draws  ${(info.triangles / 1000).toFixed(0)}k tris\naudio: ${this.audio.mode}  q: ${this.qualityName}  wx: ${this.wxId}`;
      p.frames = 0; p.t = 0; p.simAcc = 0; p.frameAcc = 0; p.worst = 0;
    }
  }

  // Test / tooling hook: advance the simulation without rendering.
  fastForward(seconds) {
    if (this.raceMode.active) return this.raceMode.fastForward(seconds);
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) {
      const car = this.sim.car;
      this.sim.step(this.autopilot ? this.ai.driver.control(car) : this.assist.apply(this.input.read(car, SIM_DT), car, SIM_DT));
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
    this.renderer.info.reset();
    // direction of travel blended with heading so slides are visible
    const travel = spd > 3 ? Math.atan2(car.vx * Math.sin(car.yaw) + car.vy * Math.cos(car.yaw), car.vx * Math.cos(car.yaw) - car.vy * Math.sin(car.yaw)) : car.yaw;
    let dyaw = travel - car.yaw; while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    const yaw = car.yaw + THREE.MathUtils.clamp(dyaw, -0.6, 0.6) * (car.vx > 0 ? 0.55 : 0);
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    // in-car cameras (src/game/cockpit.js): sets the pose for 'cockpit' / 'bonnet', shows or hides the cockpit kit
    const inFov = inCar.update({ renderer: this.renderer, scene: this.scene, composer: this.composer, camera: cam, model: this.model, spec: this.spec, car, mode: this.paused ? 'menu' : mode, dt,
      info: { lapTime: this.sim.lapStart === null ? null : this.sim.lapTime, lastLap: this.sim.lastLap, delta: this.rec.delta(this.sim, this.tel.ref()) } });
    const hudIn = inFov !== null && mode === 'cockpit'; if (this.hudCockpit !== hudIn) { this.hudCockpit = hudIn; const cl = this.hud.cl.style; cl.transformOrigin = '100% 100%'; cl.transform = this.hudCockpit ? 'scale(0.62)' : ''; cl.opacity = this.hudCockpit ? 0.85 : 1; }
    if (this.paused) {
      // showroom orbit behind the menu
      const a = performance.now() * 0.00012;
      cam.position.set(pos.x + Math.cos(a) * 7.5, pos.y + 2.1, pos.z + Math.sin(a) * 7.5);
      cam.lookAt(pos.x, pos.y + 0.6, pos.z); cam.fov = 42; cam.updateProjectionMatrix();
      return;
    }
    if (this.raceMode.camera(dt, car, pos)) return;   // race mode's extra cameras
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
    } else if (mode === 'bonnet' || mode === 'cockpit') {
      fov = inFov;
    } else {
      // trackside camera with a checked line of sight to the car (tvcam.js)
      if (!this.tv || this.tv.world !== this.world) this.tv = new TvCam(this.track, this.world);
      fov = this.tv.update(dt, pos, car, cam);
    }
    if (mode !== 'tv') {
      // engine / road vibration grows with speed; kerbs and grass rattle the camera
      const t = performance.now() * 0.001, k = Math.min(1, spd / 75), off = car.surf && (car.surf[0] || car.surf[1] || car.surf[2] || car.surf[3]) ? Math.min(1, spd / 25) : 0;
      const onBoard = mode === 'bonnet' || mode === 'cockpit';
      const amp = (mode === 'cockpit' ? 0.0025 : onBoard ? 0.007 : 0.0035) * k * k + off * (mode === 'cockpit' ? 0.008 : onBoard ? 0.016 : 0.008);
      cam.position.y += amp * (Math.sin(t * 61) + 0.6 * Math.sin(t * 37.3));
      cam.rotation.z += amp * 0.35 * Math.sin(t * 29.1); cam.rotation.x += amp * 0.25 * Math.sin(t * 43.7);
    }
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 6); cam.updateProjectionMatrix(); }
  }
}

window.__game = new Game();
