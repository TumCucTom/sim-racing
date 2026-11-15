// Race mode for the browser game: a field of AI cars around the player's car.
//
// The simulation is src/sim/race.js + src/sim/drivers/racecraft.js (DOM-free). This file is
// the glue: it builds the field and its car models, steps the race from the game loop, moves
// the opponents' models, drives the race HUD, the opponents' engine voices, the extra
// cameras and the TV director, and exposes a small scripting API on `window.__game`:
//
//   __game.startRace({ n, laps, grid, klass, skill, seed, order, ai })   start (or restart) a race
//   __game.followCar(i | 'leader' | 'player' | 'battle' | 'next' | 'prev' | 'p3')   car to watch
//   __game.setCamera('chase' | 'far' | 'bonnet' | 'cockpit' | 'tv' | 'heli' | 'side' | 'front' | 'rear' | 'orbit' | 'director')
//   __game.fastForward(seconds)      advance the whole race without rendering (deterministic with &ai)
//   __game.setTimeScale(k)           slow motion / fast forward of the rendered race
//   __game.raceInfo()                time, order, gaps and current battles
//
// While a race runs, `game.sim`, `game.model` and `game.spec` point at the car being followed,
// so the existing cameras, instrument cluster, engine audio and effects work for any car.
import * as THREE from 'three';
import { SIM_DT } from '../sim/vehicle.js';
import { Race } from '../sim/race.js';
import { buildField } from '../sim/drivers/racecraft.js';
import { buildCarModel } from './carmodel.js';
import { trackHeight } from './world.js';
import { RaceHUD, hex } from './racehud.js';
import { OpponentAudio } from '../audio/opponents.js';
import { fmtTime } from './hud.js';

// liveries for the opponents: distinct at a glance, also between cars of the same model
const PALETTE = [0xd62828, 0x1d6fd6, 0xf2c200, 0x1fa64a, 0xf07a13, 0x7a3fc4, 0x12b5b5, 0xe85d9a, 0xf4f4f0, 0x23262b,
  0x8ac926, 0x9d0208, 0x00509d, 0xb08968, 0x6c757d, 0xff9f1c, 0x2ec4b6, 0xc77dff, 0x386641, 0xffd6a5];
const EXTRA_CAMS = ['heli', 'side', 'front', 'rear', 'orbit'];
const LOD_DIST = { low: 60, medium: 120, high: 200 };          // beyond this an opponent is drawn as two boxes
const FX_DIST = { low: 0, medium: 90, high: 160 };             // tyre smoke / spray / skid marks for opponents within this
const SKILLS = [[0.88, 'Rookie'], [0.92, 'Amateur'], [0.95, 'Pro'], [0.98, 'Expert'], [1.0, 'Alien']];
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// far-away stand-in: body, cabin and a tail-light strip (3 draw calls instead of a whole model)
const unitBox = new THREE.BoxGeometry(1, 1, 1);
function makeLod(spec, color) {
  const b = spec.body, g = new THREE.Group(), open = b.style === 'formula';
  const body = new THREE.Mesh(unitBox, new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.3 }));
  body.scale.set(b.length, b.height * (open ? 0.42 : 0.52), b.width * (open ? 0.5 : 0.96)); body.position.y = b.height * (open ? 0.3 : 0.34);
  const cab = new THREE.Mesh(unitBox, new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.3 }));
  cab.scale.set(b.length * 0.42, b.height * 0.42, b.width * (open ? 0.3 : 0.8)); cab.position.set(-b.length * 0.06, b.height * 0.78, 0);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1010, emissiveIntensity: 0.3 });
  const tail = new THREE.Mesh(unitBox, tailMat); tail.scale.set(0.05, 0.07, b.width * 0.8); tail.position.set(-b.length / 2 - 0.01, b.height * 0.5, 0);
  g.add(body, cab, tail); g.userData.tail = tailMat; g.visible = false;
  return g;
}

export class RaceMode {
  constructor(game, params, CAMS) {
    this.g = game; this.params = params; this.CAMS = CAMS;
    this.active = false; this.race = null; this.models = []; this.colors = []; this.focus = 0; this.playerIdx = 0;
    this.extraCam = null; this.director = false; this.dirT = 0; this.dirN = 0; this.timeScale = 1; this.orbitA = 0;
    this.camLast = new THREE.Vector3(); this.camVel = new THREE.Vector3(); this.tmp = new THREE.Vector3();
    this.wheelW = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.prox = { left: 0, right: 0 };
    this.hud = new RaceHUD(game.ui, game.hud);
    const num = (k, d) => { const v = params.get(k) ?? store.get('rr-race-' + k); return v === null || v === '' || isNaN(+v) ? d : +v; };
    const str = (k, d, ok) => { const v = params.get(k) ?? store.get('rr-race-' + k); return ok.includes(v) ? v : d; };
    this.cfg = {
      n: clamp(Math.round(num('race', 12)), 2, 20), laps: clamp(Math.round(num('laps', 3)), 1, 99),
      grid: params.get('grid') ?? store.get('rr-race-grid') ?? 'last',
      klass: str('field', 'class', ['same', 'class', 'mixed']), skill: clamp(num('aiskill', 0.95), 0.7, 1.05),
      seed: Math.round(num('seed', 1)), order: str('order', 'quali', ['quali', 'reverse', 'random']),
    };
    this.buildMenu(); this.bindKeys();
    // the track map gets a dot per car
    const hud = game.hud, draw = hud.drawMap.bind(hud);
    hud.drawMap = (sim, ctx) => { draw(sim, ctx); if (this.active) this.hud.drawMap(this.race, this.race.cars[this.focus], this.colors); };
    // scripting API
    game.startRace = (o) => this.start(o); game.followCar = (i) => this.follow(i); game.setCamera = (n) => this.setCamera(n);
    game.raceInfo = () => this.info(); game.setTimeScale = (k) => { this.timeScale = clamp(+k || 1, 0.05, 8); };
    Object.defineProperty(game, 'race', { get: () => this.race, configurable: true });
    if (params.has('race')) setTimeout(() => {
      this.start({ ai: params.has('ai') });
      if (params.get('cam')) this.setCamera(params.get('cam'));
      if (params.get('follow')) this.follow(isNaN(+params.get('follow')) ? params.get('follow') : +params.get('follow'));
      if (params.has('director')) this.setCamera('director');
    }, 0);
  }

  // ------------------------------------------------------------------ menu and keys
  buildMenu() {
    const row = document.querySelector('#menu .rowb'); if (!row) return;
    const c = this.cfg, opt = (v, label, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${label}</option>`;
    const ns = []; for (let i = 2; i <= 20; i++) ns.push(opt(i, i, i === c.n));
    row.insertAdjacentHTML('afterend', `<div class="rowb" id="racerow">
      <button class="go" id="race-go">Race</button>
      <label>Cars <select id="race-n">${ns.join('')}</select></label>
      <label>Laps <select id="race-laps">${[1, 2, 3, 5, 8, 10, 15, 20, 30].map(v => opt(v, v, v === c.laps)).join('')}</select></label>
      <label>Start from <select id="race-grid"></select></label>
      <label>Opponents <select id="race-klass">${[['same', 'Same car'], ['class', 'Same class'], ['mixed', 'Mixed classes']].map(([v, l]) => opt(v, l, v === c.klass)).join('')}</select></label>
      <label>AI level <select id="race-skill">${SKILLS.map(([v, l]) => opt(v, l, Math.abs(v - c.skill) < 0.011)).join('')}</select></label>
      <button class="alt" id="race-watch">Watch an AI race</button></div>`);
    const $ = (id) => document.getElementById(id);
    const grids = () => { const g = $('race-grid'), cur = this.cfg.grid; g.innerHTML = opt('last', 'the back', cur === 'last') + Array.from({ length: this.cfg.n }, (_, i) => opt(i + 1, i === 0 ? 'pole' : `P${i + 1}`, String(cur) === String(i + 1))).join(''); };
    grids();
    const save = () => {
      Object.assign(this.cfg, { n: +$('race-n').value, laps: +$('race-laps').value, grid: $('race-grid').value, klass: $('race-klass').value, skill: +$('race-skill').value });
      for (const [k, v] of [['race', this.cfg.n], ['laps', this.cfg.laps], ['grid', this.cfg.grid], ['field', this.cfg.klass], ['aiskill', this.cfg.skill]]) store.set('rr-race-' + k, String(v));
    };
    for (const id of ['race-n', 'race-laps', 'race-grid', 'race-klass', 'race-skill']) $(id).onchange = () => { save(); if (id === 'race-n') grids(); };
    $('race-go').onclick = () => { save(); this.start({ ai: false }); };
    $('race-watch').onclick = () => { save(); this.start({ ai: true }); };
    const keys = document.getElementById('keys');
    if (keys) keys.insertAdjacentHTML('beforeend', '<div>Race: <kbd>J</kbd><kbd>K</kbd> watch another car · <kbd>U</kbd> own car · <kbd>O</kbd> TV director · <kbd>B</kbd> more cameras · <kbd>P</kbd> timing tower</div>');
  }

  bindKeys() {
    const k = this.g.input, hud = this.g.hud;
    k.on('KeyK', () => { if (this.active) this.follow('next'); });
    k.on('KeyJ', () => { if (this.active) this.follow('prev'); });
    k.on('KeyU', () => { if (this.active) { this.director = false; this.follow('player'); } });
    k.on('KeyO', () => { if (this.active) this.setCamera(this.director ? 'chase' : 'director'); });
    k.on('KeyP', () => { if (this.active) hud.toast(`Timing tower ${this.hud.toggleTower() ? 'on' : 'off'}`, 1); });
    k.on('KeyB', () => { if (this.active) this.setCamera(EXTRA_CAMS[(EXTRA_CAMS.indexOf(this.extraCam) + 1) % EXTRA_CAMS.length]); });
    // C (the ordinary camera cycle) leaves the extra cameras and the director
    const c = k.handlers.KeyC;
    if (c) k.on('KeyC', () => { if (this.extraCam || this.director) { this.extraCam = null; this.director = false; } c(); });
  }

  // ------------------------------------------------------------------ life cycle
  start(o = {}) {
    const g = this.g; this.stop(true);
    const c = this.cfg; for (const key of ['n', 'laps', 'grid', 'klass', 'skill', 'seed', 'order']) if (o[key] !== undefined) c[key] = o[key];
    const n = clamp(Math.round(c.n), 2, 20), ai = !!o.ai;
    const grid = c.grid === 'last' || isNaN(+c.grid) ? n : clamp(Math.round(+c.grid), 1, n);
    const field = buildField(g.track, { n, car: g.spec.id, klass: c.klass, difficulty: c.skill, seed: c.seed, wet: g.wet, grid, aiPlayer: true, order: c.order });
    const pe = field.find(e => e.player); this.playerDriver = pe.driver; this.playerAiName = pe.name;
    if (!ai) { pe.name = 'You'; pe.driver = null; }
    const race = this.race = new Race(g.track, field, { laps: c.laps, seed: c.seed, wet: g.wet });
    this.playerIdx = race.cars.findIndex(q => q.player); this.focus = this.playerIdx;
    this.saved = { sim: g.sim, ghostMode: g.ghostMode }; this.playerModel = g.model; this.playerSpec = g.spec;
    let k = 0;
    this.models = race.cars.map((q, i) => {
      if (q.player) { this.colors[i] = '#ffcc00'; g.model.lod = makeLod(q.spec, q.spec.body.color); g.scene.add(g.model.lod); return g.model; }
      const col = PALETTE[k++ % PALETTE.length]; this.colors[i] = hex(col);
      const m = buildCarModel(q.spec, { colorOverride: col }); m.lod = makeLod(q.spec, col); g.scene.add(m.root, m.lod);
      return m;
    });
    this.fx = race.cars.map(() => ({ last: [null, null, null, null], sprayAcc: [0, 0, 0, 0] }));
    race.onLap = (q, lt, valid) => { if (q.index === this.focus) g.onLap(lt, valid); };
    race.onContact = (A, B, dv) => this.onContact(A, B, dv);
    race.onEvent = (type, q) => this.onEvent(type, q);
    g.sim = race.cars[this.playerIdx].sim; g.ghostMode = 'off'; g.ghost.root.visible = false;
    this.active = true; this.resultsShown = false; this.wasHuman = !ai; this.extraCam = null; this.director = false;
    g.showMenu(false);
    g.audio.start().then(() => g.audio.setCar(g.spec));
    g.rec.cur.clear(); g.effects.clear(); g.props.reset(); g.input.steerPos = 0; g.camInit = false; g.acc = 0;
    g.setAutopilot(ai);
    this.hud.show(true);
    g.hud.toast(`${n} cars · ${c.laps} lap${c.laps > 1 ? 's' : ''} · you start P${grid}`, 3);
    this.sync(0);
    return this.info();
  }

  // back to the solo session (hot-lap mode)
  stop(quiet = false) {
    if (!this.active) return;
    const g = this.g;
    if (this.focus !== this.playerIdx) this.follow(this.playerIdx);
    this.models.forEach((m, i) => { if (i === this.playerIdx) return; g.scene.remove(m.root, m.lod); m.dispose(); m.lod.traverse(o => { if (o.isMesh) o.material.dispose(); }); });
    g.scene.remove(this.playerModel.lod); this.playerModel.lod.traverse(o => { if (o.isMesh) o.material.dispose(); }); this.playerModel.lod = null;
    this.models = []; this.playerModel.root.visible = true;
    g.sim = this.saved.sim; g.model = this.playerModel; g.spec = this.playerSpec; g.ghostMode = this.saved.ghostMode;
    this.hud.show(false); this.oppAudio?.silence();
    this.active = false; this.race = null; this.extraCam = null; this.director = false; this.timeScale = 1;
    g.camInit = false;
    if (!quiet) g.hud.toast('Left the race', 1.5);
  }

  restart() {
    const g = this.g, race = this.race;
    this.follow(this.playerIdx); this.director = false;
    race.reset();
    for (const f of this.fx) { f.last = [null, null, null, null]; f.sprayAcc = [0, 0, 0, 0]; }
    g.rec.cur.clear(); g.effects.clear(); g.props.reset(); g.input.steerPos = 0; g.camInit = false; g.acc = 0;
    this.resultsShown = false; this.hud.hideResults(); this.wasHuman = !g.autopilot;
    g.refreshAssist();
    g.hud.toast('Back on the grid', 1.5);
  }

  // R: marshals put the player's car back on the road (when nobody is about to arrive)
  recover() {
    const g = this.g, pc = this.race.cars[this.playerIdx];
    if (pc.finished || pc.retired || !this.race.green) return;
    g.hud.toast(this.race.respawn(pc) ? 'Back on track' : 'Marshals are waiting for a gap in the traffic…', 1.6);
    g.camInit = false;
  }

  onWet() { if (this.active) { this.start({ ai: this.g.autopilot }); this.g.hud.toast('Conditions changed — race restarted', 2.5); } }

  // ------------------------------------------------------------------ simulation
  drive(pc) {
    const g = this.g, human = !g.autopilot && !pc.finished && !pc.retired;
    if (human !== this.wasHuman) { if (!human) this.playerDriver.onRespawn(pc, this.race); this.wasHuman = human; }
    pc.driver = human ? null : this.playerDriver;
    return human;
  }

  // called from the game loop instead of the solo stepping
  advance(dt) {
    const g = this.g, race = this.race, pc = race.cars[this.playerIdx], s0 = performance.now();
    const human = this.drive(pc), own = this.focus === this.playerIdx;
    g.acc += dt * this.timeScale;
    let n = 0;
    while (g.acc >= SIM_DT && n < 40) {
      race.step(human ? g.assist.apply(g.input.read(pc.car, SIM_DT), pc.car, SIM_DT) : null);
      if (own) g.rec.sample(g.sim);
      g.acc -= SIM_DT; n++;
    }
    if (n === 40) g.acc = 0;
    if (own) g.rec.sampleGG(g.sim.car);
    g.perf.simAcc += performance.now() - s0;
    this.steps = n;
  }

  // tooling hook: advance the whole race without rendering
  fastForward(seconds) {
    const g = this.g, race = this.race, pc = race.cars[this.playerIdx], own = this.focus === this.playerIdx;
    const human = this.drive(pc), n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) {
      race.step(human ? g.assist.apply(g.input.read(pc.car, SIM_DT), pc.car, SIM_DT) : null);
      if (own) { g.rec.sample(g.sim); if (i % 5 === 0) g.rec.sampleGG(g.sim.car); }
    }
    g.camInit = false; this.camJump = true;
    return this.info();
  }

  onContact(A, B, dv) {
    const g = this.g, f = this.race.cars[this.focus];
    if (A === f || B === f) g.audio.trigger('impact', Math.min(1.6, dv / 5));
    else {   // somebody else's accident: heard if it is close to the camera
      const dx = A.car.x - g.camera.position.x, dz = -A.car.y - g.camera.position.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < 80) g.audio.trigger('impact', Math.min(1, dv / 6) * 14 / (d + 14));
    }
  }

  onEvent(type, c) {
    const g = this.g, mine = c && c.index === this.playerIdx;
    if (type === 'green') g.hud.toast('GO!', 1.2);
    else if (type === 'finish' && mine) g.hud.toast(`Chequered flag — P${c.pos}`, 4);
    else if (type === 'finish' && c.finishOrder === 0) g.hud.toast(`${c.name} wins`, 3);
    else if (type === 'penalty' && mine) g.hud.toast('Track limits: 5 second penalty', 3);
    else if (type === 'dnf') g.hud.toast(`${c.name} is out of the race`, 2.5);
  }

  // ------------------------------------------------------------------ following and cameras
  follow(who) {
    if (!this.active) return null;
    const race = this.race, n = race.cars.length, cur = race.cars[this.focus];
    let i = this.focus;
    if (typeof who === 'number') i = clamp(Math.round(who), 0, n - 1);
    else if (who === 'player') i = this.playerIdx;
    else if (who === 'leader') i = race.order[0];
    else if (who === 'next') i = race.order[(cur.pos) % n];
    else if (who === 'prev') i = race.order[(cur.pos - 2 + n) % n];
    else if (who === 'battle') i = this.battle().index;
    else if (/^p\d+$/i.test(who)) i = race.order[clamp(+who.slice(1), 1, n) - 1];
    if (i === this.focus) return i;
    const g = this.g, c = race.cars[i], m = this.models[i];
    this.focus = i;
    g.sim = c.sim; g.model = m; g.spec = c.spec;
    m.root.visible = true; m.lod.visible = false;
    g.audio.setCar(c.spec); g.wx.attachCar(m, c.spec); g.hud.setCar(c.spec);
    g.camInit = false; this.camJump = true;
    if (!this.director) g.hud.toast(`${c.name} — P${c.pos}`, 1.5);
    return i;
  }

  setCamera(name) {
    const g = this.g, i = this.CAMS.indexOf(name);
    if (name === 'director') { if (!this.active) return false; this.director = true; this.dirT = 0; g.hud.toast('TV director', 1.2); return true; }
    this.director = false;
    if (i >= 0) { g.cam = i; this.extraCam = null; }
    else if (EXTRA_CAMS.includes(name)) { this.extraCam = name; g.cam = Math.max(0, this.CAMS.indexOf('tv')); }
    else return false;
    g.camInit = false; this.camJump = true;
    g.hud.toast(`Camera: ${name}`, 1.2);
    return true;
  }

  // the closest fight on the road (the car doing the chasing); the leader if there is none
  battle() {
    const race = this.race; let best = race.cars[race.order[0]], score = 0.9;
    for (let p = 1; p < race.order.length; p++) {
      const c = race.cars[race.order[p]], a = race.cars[race.order[p - 1]];
      if (c.retired || c.finished || a.retired || a.finished || c.needRespawn) continue;
      let ds = a.car.s - c.car.s; ds -= Math.round(ds / race.L) * race.L;
      if (ds < -6 || ds > 45) continue;
      const s = 1 / (0.25 + Math.abs(ds) / Math.max(15, c.car.vx)) + (p < 4 ? 0.6 : 0) + (c.driver && c.driver.mode === 'pass' ? 1.2 : 0);
      if (s > score) { score = s; best = c; }
    }
    return best;
  }

  direct(dt) {
    const race = this.race;
    this.dirT -= dt;
    if (this.dirT > 0 && !race.cars[this.focus].retired) return;
    const start = !race.green || race.raceTime < 9;
    const c = start ? race.cars[race.order[Math.min(race.order.length - 1, 2)]] : this.battle();
    this.follow(c.index);
    const seq = start ? ['heli'] : ['tv', 'chase', 'tv', 'heli', 'tv', 'side', 'far', 'tv', 'front'];
    const name = seq[this.dirN++ % seq.length], i = this.CAMS.indexOf(name);
    if (i >= 0) { this.g.cam = i; this.extraCam = null; } else { this.extraCam = name; this.g.cam = Math.max(0, this.CAMS.indexOf('tv')); }
    this.g.camInit = false; this.camJump = true;
    this.dirT = start ? 3 : 6 + (this.dirN % 3) * 1.5;
  }

  // extra cameras; returns true when it has placed the camera (main.js then leaves it alone)
  camera(dt, car, pos) {
    if (!this.active || !this.extraCam) return false;
    const cam = this.g.camera, mode = this.extraCam, yaw = car.yaw, fx = Math.cos(yaw), fz = -Math.sin(yaw), rx = -fz, rz = fx, T = this.tmp;
    let fov = 40, k = 1 - Math.exp(-dt * 5);
    if (mode === 'heli') { T.set(pos.x - fx * 20, pos.y + 15, pos.z - fz * 20); fov = 38; k = 1 - Math.exp(-dt * 2.5); }
    else if (mode === 'side') { T.set(pos.x + rx * 9 + fx * 1.5, pos.y + 1.3, pos.z + rz * 9 + fz * 1.5); fov = 34; }
    else if (mode === 'front') { T.set(pos.x + fx * 10 + rx * 1.8, pos.y + 1.1, pos.z + fz * 10 + rz * 1.8); fov = 36; }
    else if (mode === 'rear') { T.set(pos.x - fx * 4.2, pos.y + 0.75, pos.z - fz * 4.2 - rz * 0); fov = 62; k = 1; }
    else { this.orbitA += dt * 0.35; T.set(pos.x + Math.cos(this.orbitA) * 9, pos.y + 2.4, pos.z + Math.sin(this.orbitA) * 9); fov = 40; k = 1; }
    if (this.camJump || !this.g.camInit) { cam.position.copy(T); this.g.camInit = true; } else cam.position.lerp(T, k);
    if (mode === 'rear') cam.lookAt(pos.x + fx * 20, pos.y + 0.9, pos.z + fz * 20); else cam.lookAt(pos.x + fx * 0.8, pos.y + 0.55, pos.z + fz * 0.8);
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 6); cam.updateProjectionMatrix(); }
    return true;
  }

  // ------------------------------------------------------------------ per frame
  sync(dt) {
    if (!this.active) return;
    const g = this.g, race = this.race, t = g.track, cp = g.camera.position, q = g.qualityName;
    const lod2 = (LOD_DIST[q] || 120) ** 2, fx2 = (FX_DIST[q] ?? 90) ** 2, W = this.wheelW;
    if (this.director && !g.paused) this.direct(dt);
    const focus = race.cars[this.focus];
    let pl = 0, pr = 0;
    for (let i = 0; i < race.cars.length; i++) {
      const c = race.cars[i], car = c.car, m = this.models[i];
      if (i !== this.focus) {
        // "car left / right": alongside the followed car and within a lane's width
        let ds = car.s - focus.car.s; ds -= Math.round(ds / race.L) * race.L;
        if (!c.retired && Math.abs(ds) < c.hl + focus.hl + 1.5) { const dd = car.d - focus.car.d, cl = Math.abs(dd) - c.hw - focus.hw; if (cl < 3.2 && cl > -0.5) { if (dd > 0) pl = Math.max(0.01, cl); else pr = Math.max(0.01, cl); } }
      }
      if (i === this.focus) { m.lod.visible = false; m.root.visible = true; continue; }
      if (c.retired) { m.root.visible = false; m.lod.visible = false; continue; }
      const h = trackHeight(t, car.idx, car._proj.frac), dx = car.x - cp.x, dz = -car.y - cp.z, d2 = dx * dx + dz * dz, far = d2 > lod2;
      const gr = Math.atan(t.grade[car.idx]), che = Math.cos(car.headErr), she = Math.sin(car.headErr), o = far ? m.lod : m.root;
      m.root.visible = !far; m.lod.visible = far;
      o.position.set(car.x, h, -car.y); o.rotation.set(-gr * she, car.yaw, gr * che, 'YXZ');
      const braking = car.brake > 0.05;
      if (far) { m.lod.userData.tail.emissiveIntensity = braking ? 3 : 0.3; continue; }
      const spec = c.spec, soft = spec.body.style === 'formula' ? 0.12 : spec.body.style === 'gt' ? 0.3 : 1, delta = car.steer * spec.steerLock;
      m.chassis.rotation.z = clamp(car.axF * 0.0032 * soft, -0.05, 0.05); m.chassis.rotation.x = clamp(car.ayF * 0.0042 * soft, -0.07, 0.07);
      for (let w = 0; w < 4; w++) m.setWheel(w, delta, car.omega[w] * dt);
      m.setBrake(braking);
      if (!g.paused && d2 < fx2) {
        const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
        for (let w = 0; w < 4; w++) W[w].set(car.x + car.wx[w] * cy - car.wy[w] * sy, h, -(car.y + car.wx[w] * sy + car.wy[w] * cy));
        g.effects.emitFor(dt, car, W, car.yaw, this.fx[i]);
      }
    }
    this.prox.left = pl; this.prox.right = pr;
    if (!g.paused) {
      this.hud.update(dt, race, focus, this.colors, this.prox);
      const pc = race.cars[this.playerIdx];
      if (!this.resultsShown && (race.over || (pc.finished && race.raceTime - pc.finishTime > 3))) { this.resultsShown = true; this.showResults(); }
      else if (this.resultsShown && race.over && !this.finalShown) { this.finalShown = true; this.showResults(); }
    }
    this.updateAudio(dt);
  }

  showResults() {
    const race = this.race; let l = 0, m = 0, h = 0;
    for (const e of race.events) { if (e.dv < 2) l++; else if (e.dv < 6) m++; else h++; }
    this.finalShown = race.over;
    this.hud.results(race, `Overtakes after lap 1: ${race.overtakes} · contacts: ${l} light, ${m} medium, ${h} heavy · fastest lap ${fmtTime(Math.min(...race.cars.map(c => c.bestLap ?? Infinity)))}`);
  }

  updateAudio(dt) {
    const g = this.g, a = g.audio;
    if (!a.ctx) return;
    if (!this.oppAudio) { try { this.oppAudio = new OpponentAudio(a.ctx, a.comp || a.ctx.destination, g.qualityName === 'low' ? 2 : 3); } catch { this.oppAudio = { update() {}, silence() {} }; } }
    const cam = g.camera, cp = cam.position, V = this.camVel;
    if (dt > 0 && !this.camJump) { V.copy(cp).sub(this.camLast).divideScalar(dt); if (V.lengthSq() > 130 * 130) V.set(0, 0, 0); } else V.set(0, 0, 0);
    this.camLast.copy(cp); this.camJump = false;
    const e = cam.matrixWorld.elements, src = [];
    for (let i = 0; i < this.race.cars.length; i++) {
      const c = this.race.cars[i]; if (i === this.focus || c.retired) continue;
      const car = c.car, cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
      src.push({ id: i, x: car.x, y: cp.y, z: -car.y, vx: car.vx * cy - car.vy * sy, vy: 0, vz: -(car.vx * sy + car.vy * cy), rpm: car.rpm, throttle: car.throttle, cylinders: c.spec.engine.cylinders, electric: !!c.spec.engine.electric });
    }
    this.oppAudio.update(src, { x: cp.x, y: cp.y, z: cp.z, vx: V.x, vy: V.y, vz: V.z, rx: e[0], rz: e[2] }, a.muted || g.paused ? 0 : a.volume);
  }

  info() {
    const race = this.race; if (!race) return null;
    const row = (c) => ({ pos: c.pos, index: c.index, name: c.name, car: c.spec.id, lap: c.sim.lap + 1, gap: +c.gapLeader.toFixed(2), interval: +c.interval.toFixed(2), speed: +(c.car.speed * 3.6).toFixed(0), s: +c.car.s.toFixed(0), finished: c.finished, retired: c.retired, mode: c.driver ? c.driver.mode : 'human' });
    return { time: +race.raceTime.toFixed(2), green: race.green, lights: race.lightsOn, over: race.over, laps: race.laps, focus: this.focus, player: this.playerIdx,
      order: race.order.map(i => row(race.cars[i])), battle: this.battle().index, overtakes: race.overtakes, contacts: race.events.length };
  }
}
