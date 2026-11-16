// Pre-race front end. The markup and CSS live in index.html (#menu); this module fills
// the car rail, the selected-car panel, the circuit preview and the chip / segmented
// controls. The original <select>s (#track, #weather, #difficulty, #quality) stay in the
// DOM as the source of truth, so the rest of the game keeps reading and writing them.
import { CARS, CAR_ORDER, CAR_GROUPS } from '../sim/cars.js';
import { TRACKS } from '../sim/track.js';
import { peakPower } from '../sim/vehicle.js';
import aiLaps from '../../docs/ai-laps.json';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const P = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>';
const CLOUD = '<path d="M7 17h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 10.2 3.4 3.4 0 0 0 7 17z"/>';
const CLOUD_HI = '<path d="M7 14h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 7.2 3.4 3.4 0 0 0 7 14z"/>';
const WX_ICON = {
  clear: P(SUN),
  golden: P('<path d="M3 18h18M6 14.5a6 6 0 0 1 12 0M12 4v2.5M4.6 8.6l1.8 1.6M19.4 8.6l-1.8 1.6M8 21h8"/>'),
  overcast: P(CLOUD),
  rain: P(CLOUD_HI + '<path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>'),
  storm: P(CLOUD_HI + '<path d="M12.5 15l-2.5 3.5h3.5L11 22"/>'),
  dusk: P('<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/><path d="M17 4v3M15.5 5.5h3"/>'),
};
const WX_SHORT = { clear: 'Clear', golden: 'Golden', overcast: 'Damp', rain: 'Rain', storm: 'Storm', dusk: 'Dusk' };
const DIFF_SHORT = { easy: 'Easy', assist: 'Assisted', sim: 'Simulation' };
const fmtLap = (t) => { t = +t; if (!(t > 0)) return null; const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };

export class Menu {
  constructor(game, { validation, store, conditions, conditionOrder, difficulty, difficultyOrder }) {
    this.g = game; this.store = store; this.root = $('menu'); this.conditions = conditions; this.difficulty = difficulty;
    const num = (x) => (typeof x === 'string' ? parseFloat(x) : NaN);
    this.data = {};
    for (const id of CAR_ORDER) {
      const s = CARS[id], v = validation.find(r => r.car === s.name) || {};
      this.data[id] = { hp: Math.round(peakPower(s).watts / 745.7), kg: s.mass, acc: num(v['0-100 s']), top: num(v['top km/h']), g: num(v['lat g (R60)']) };
    }
    // [key, label, unit, digits, lower is better]
    this.stats = [['hp', 'Power', 'hp', 0, false], ['kg', 'Weight', 'kg', 0, true], ['acc', '0–100 km/h', 's', 1, true], ['top', 'Top speed', 'km/h', 0, false], ['g', 'Grip', 'g', 2, false]];
    this.range = {};
    for (const [k] of this.stats) { const xs = Object.values(this.data).map(d => d[k]).filter(Number.isFinite); this.range[k] = [Math.min(...xs), Math.max(...xs)]; }
    this.buildCars(); this.buildStats();
    this.buildChoice('m-wx', 'weather', conditionOrder.map(id => [id, `${WX_ICON[id] || WX_ICON.clear}<span>${WX_SHORT[id] || conditions[id].label}</span>`, conditions[id].label]));
    this.buildChoice('m-diff', 'difficulty', difficultyOrder.map(id => [id, DIFF_SHORT[id] || difficulty[id].label, difficulty[id].label]));
    this.buildChoice('m-q', 'quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]);
    // session type: the race options only exist in Race
    this.mode = new URLSearchParams(location.search).has('race') || store.get('rr-mode') === 'race' ? 'race' : 'hot';
    for (const b of $('m-mode').children) b.onclick = () => this.setMode(b.dataset.v);
    this.setMode(this.mode);
    $('m-help').onclick = () => this.help(!this.root.classList.contains('help'));
    $('keys').onclick = () => this.help(false);
    const step = (d) => { const ts = $('track'), n = ts.options.length; if (!n) return; ts.selectedIndex = (ts.selectedIndex + d + n) % n; ts.dispatchEvent(new Event('change')); };
    $('m-tprev').onclick = () => step(-1); $('m-tnext').onclick = () => step(1);
    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('resize', () => this.drawTrack());
  }

  get open() { return !this.root.classList.contains('hidden'); }
  help(on) { this.root.classList.toggle('help', on); $('m-help').setAttribute('aria-expanded', on); $('m-help').classList.toggle('on', on); }
  setMode(m) {
    this.mode = m; this.store.set('rr-mode', m);
    this.root.classList.toggle('mode-race', m === 'race');
    for (const b of $('m-mode').children) { b.classList.toggle('on', b.dataset.v === m); b.setAttribute('aria-pressed', b.dataset.v === m); }
  }

  buildCars() {
    const tabs = $('m-tabs'), root = $('cars');
    CAR_GROUPS.forEach((grp, gi) => {
      const t = el('button', '', grp.title.replace(/ (race )?cars$/i, '')); t.type = 'button'; t.title = grp.title; t.onclick = () => this.setTab(gi); tabs.appendChild(t);
      for (const id of grp.ids) {
        const s = CARS[id]; if (!s) continue;
        const c = el('button', 'card', `<i></i><b>${s.name}</b><em>${this.data[id].hp} hp</em><small>${s.klass}</small>`);
        c.type = 'button'; c.dataset.id = id; c.dataset.grp = gi; c.style.setProperty('--c', '#' + (s.body?.color ?? 0x888888).toString(16).padStart(6, '0'));
        c.onclick = () => this.g.setCar(id);
        c.ondblclick = () => { this.g.setCar(id); this.go(); };
        root.appendChild(c);
      }
    });
  }
  setTab(gi, pick = true) {
    this.tab = gi;
    [...$('m-tabs').children].forEach((t, i) => t.classList.toggle('on', i === gi));
    let first = null, has = false;
    for (const c of $('cars').children) { const on = +c.dataset.grp === gi; c.hidden = !on; c.style.display = on ? '' : 'none'; if (on) { first ??= c.dataset.id; has ||= c.dataset.id === this.g.spec?.id; } }
    if (pick && !has && first) this.g.setCar(first);
  }
  buildStats() {
    const root = $('m-stats'); this.statEls = {};
    for (const [k, label] of this.stats) {
      const d = el('div', 'stat', `<span>${label}</span><b></b><div class="bar"><i></i></div>`);
      root.appendChild(d); this.statEls[k] = d;
    }
  }
  // a row of buttons mirroring a (hidden) <select>
  buildChoice(rootId, selectId, items) {
    const root = $(rootId), sel = $(selectId);
    for (const [v, html, title] of items) {
      const b = el('button', '', html); b.type = 'button'; b.dataset.v = v; if (title) { b.title = title; b.setAttribute('aria-label', title); }
      b.onclick = () => { sel.value = v; sel.dispatchEvent(new Event('change')); this.sync(); };
      root.appendChild(b);
    }
  }

  // the primary action of the current session type
  go() { const b = $(this.mode === 'race' ? 'race-go' : 'go') || $('go'); b.click(); }

  key(e) {
    if (!this.open || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target?.tagName;
    if (e.code === 'Escape' && this.root.classList.contains('help')) { this.help(false); return; }
    if (tag === 'SELECT' || tag === 'INPUT') return;
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const ids = [...$('cars').children].map(c => c.dataset.id), i = ids.indexOf(this.g.spec.id), n = ids.length;
      this.g.setCar(ids[(i + (e.code === 'ArrowDown' ? 1 : -1) + n) % n]);
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const n = CAR_GROUPS.length; this.setTab((this.tab + (e.code === 'ArrowRight' ? 1 : -1) + n) % n);
    } else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && tag !== 'BUTTON' && !e.repeat) {
      setTimeout(() => { if (this.open) this.go(); }, 0);
    }
  }

  // bring every control in line with the game state (cheap; called after any change)
  sync() {
    const g = this.g, spec = g.spec; if (!spec) return;
    const gi = CAR_GROUPS.findIndex(grp => grp.ids.includes(spec.id));
    if (gi >= 0 && gi !== this.tab) this.setTab(gi, false);
    for (const c of $('cars').children) { const on = c.dataset.id === spec.id; c.classList.toggle('sel', on); c.setAttribute('aria-pressed', on); }
    if (this.carId !== spec.id) {
      this.carId = spec.id;
      const head = $('m-carname'), parts = spec.klass.split(' · ');
      head.innerHTML = `<h2>${spec.name}</h2><div class="k">${parts.join(' &nbsp;·&nbsp; ')}</div><div class="b">${spec.blurb || ''}</div>`;
      head.style.animation = 'none'; void head.offsetWidth; head.style.animation = '';
      const d = this.data[spec.id];
      for (const [k, , unit, dig, low] of this.stats) {
        const v = d[k], [a, b] = this.range[k], e = this.statEls[k], ok = Number.isFinite(v);
        let f = ok && b > a ? (v - a) / (b - a) : 0; if (low) f = 1 - f;
        e.querySelector('b').innerHTML = ok ? `${v.toFixed(dig)}<u>${unit}</u>` : '–';
        e.querySelector('i').style.width = `${ok ? 12 + 88 * f : 0}%`;
      }
    }
    for (const [rootId, v] of [['m-wx', g.wxId], ['m-diff', g.diffId], ['m-q', g.qualityName]])
      for (const b of $(rootId).children) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
    $('m-diffhint').textContent = `${this.difficulty[g.diffId]?.label || ''} · ${this.conditions[g.wxId]?.label || ''}`;
    const ts = $('track'); if (ts.value !== g.trackId) ts.value = g.trackId;
    // circuit facts
    const t = g.track, info = TRACKS[g.trackId] || {};
    let zmin = Infinity, zmax = -Infinity; for (let i = 0; i < t.n; i++) { if (t.z[i] < zmin) zmin = t.z[i]; if (t.z[i] > zmax) zmax = t.z[i]; }
    const lap = fmtLap(aiLaps[g.trackId]?.[spec.id]);
    $('m-cmeta').innerHTML = `<li>${info.real ? info.country || 'Real circuit' : 'Original circuit'}</li><li><b>${(t.length / 1000).toFixed(2)}</b> km · <b>${(2 * t.halfWidth).toFixed(0)}</b> m wide</li><li><b>${(zmax - zmin).toFixed(0)}</b> m elevation</li>${lap ? `<li>AI benchmark <b>${lap}</b></li>` : ''}`;
    if (this.drawn !== t) this.drawTrack();
  }

  // outline of the selected circuit, from the centreline that is already built for it
  drawTrack() {
    const t = this.g.track, cv = $('m-trackcv'); if (!t || !cv) return;
    this.drawn = t;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(60, Math.round(cv.clientWidth * dpr)) || 320, h = Math.round(w * 0.75);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext('2d'); c.clearRect(0, 0, w, h);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < t.n; i++) { x0 = Math.min(x0, t.x[i]); x1 = Math.max(x1, t.x[i]); y0 = Math.min(y0, t.y[i]); y1 = Math.max(y1, t.y[i]); }
    const pad = 9 * dpr, k = Math.min((w - 2 * pad) / (x1 - x0 || 1), (h - 2 * pad) / (y1 - y0 || 1));
    const X = (i) => w / 2 + (t.x[i] - (x0 + x1) / 2) * k, Y = (i) => h / 2 - (t.y[i] - (y0 + y1) / 2) * k;
    const stepN = Math.max(1, Math.floor(t.n / 900));
    c.beginPath(); for (let i = 0; i < t.n; i += stepN) c[i ? 'lineTo' : 'moveTo'](X(i), Y(i)); c.closePath();
    c.lineJoin = c.lineCap = 'round';
    c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = 6 * dpr; c.stroke();
    c.strokeStyle = '#e8ecf1'; c.lineWidth = 2.4 * dpr; c.stroke();
    // start / finish tick and direction
    const j = Math.min(t.n - 1, Math.max(1, Math.round(t.n * 0.012))), dx = X(j) - X(0), dy = Y(j) - Y(0), dl = Math.hypot(dx, dy) || 1, nx = -dy / dl, ny = dx / dl;
    c.strokeStyle = '#ffd166'; c.lineWidth = 2.6 * dpr; c.beginPath(); c.moveTo(X(0) + nx * 6 * dpr, Y(0) + ny * 6 * dpr); c.lineTo(X(0) - nx * 6 * dpr, Y(0) - ny * 6 * dpr); c.stroke();
    c.fillStyle = '#ffd166'; const ax = X(0) + dx / dl * 11 * dpr, ay = Y(0) + dy / dl * 11 * dpr;
    c.beginPath(); c.moveTo(ax + dx / dl * 5 * dpr, ay + dy / dl * 5 * dpr); c.lineTo(ax + nx * 3.5 * dpr, ay + ny * 3.5 * dpr); c.lineTo(ax - nx * 3.5 * dpr, ay - ny * 3.5 * dpr); c.fill();
  }
}
