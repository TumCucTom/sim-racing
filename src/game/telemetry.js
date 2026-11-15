// Telemetry recording + interactive overlay.
//
// Data is recorded per lap in fixed 2 m distance bins so laps can be overlaid
// on a common axis. The overlay offers: distance-based traces vs a reference
// lap (your best or the AI's), a live g-g diagram, and a tyre panel. Channels
// are toggled by clicking their chips; the trace view zooms with the wheel,
// pans by dragging and shows a cursor readout that is mirrored on the map.
import { SURF } from '../sim/track.js';

export const BIN = 2;
export const CHANNELS = [
  { id: 'speed', label: 'Speed', unit: 'km/h', color: '#4fc3f7', on: true, min: 0, max: null },
  { id: 'throttle', label: 'Throttle', unit: '%', color: '#66dd77', on: true, min: 0, max: 100 },
  { id: 'brake', label: 'Brake', unit: '%', color: '#ff5d5d', on: true, min: 0, max: 100 },
  { id: 'steer', label: 'Steer', unit: '%', color: '#ffd166', on: true, min: -100, max: 100 },
  { id: 'gear', label: 'Gear', unit: '', color: '#c792ea', on: false, min: 0, max: 8 },
  { id: 'rpm', label: 'RPM', unit: '', color: '#ff9f43', on: false, min: 0, max: null },
  { id: 'latG', label: 'Lat g', unit: 'g', color: '#f78fb3', on: false, min: null, max: null, sym: true },
  { id: 'longG', label: 'Long g', unit: 'g', color: '#7bed9f', on: false, min: null, max: null, sym: true },
  { id: 'delta', label: 'Δ to ref', unit: 's', color: '#ffffff', on: true, min: null, max: null, sym: true },
];
const REC = ['speed', 'throttle', 'brake', 'steer', 'gear', 'rpm', 'latG', 'longG', 'time', 'x', 'y', 'yaw'];

export class LapTrace {
  constructor(nBins) {
    this.n = nBins; this.filled = new Uint8Array(nBins); this.lapTime = null; this.label = '';
    for (const c of REC) this[c] = new Float32Array(nBins);
  }
  clear() { this.filled.fill(0); this.lapTime = null; }
  copyFrom(o) { for (const c of REC) this[c].set(o[c]); this.filled.set(o.filled); this.lapTime = o.lapTime; }
  // fill any skipped bins by carrying the previous value forward
  seal() {
    let last = -1;
    for (let i = 0; i < this.n; i++) {
      if (this.filled[i]) last = i;
      else if (last >= 0) { for (const c of REC) this[c][i] = this[c][last]; this.filled[i] = 1; }
    }
  }
}

export class Recorder {
  constructor(track) {
    this.track = track; this.nBins = Math.ceil(track.length / BIN);
    this.cur = new LapTrace(this.nBins); this.best = new LapTrace(this.nBins); this.ai = new LapTrace(this.nBins);
    this.hasBest = false; this.hasAI = false;
    this.gg = new Float32Array(900 * 2); this.ggi = 0; this.ggn = 0;
  }
  reset() { this.cur.clear(); this.best.clear(); this.hasBest = false; this.ggn = 0; this.ggi = 0; }
  // call once per physics step (cheap)
  sample(sim, trace = this.cur) {
    const car = sim.car;
    if (sim.lapStart === null) return;
    const b = Math.min(this.nBins - 1, Math.floor(car.s / BIN));
    trace.filled[b] = 1;
    trace.speed[b] = car.speed * 3.6; trace.throttle[b] = car.throttle * 100; trace.brake[b] = car.brake * 100;
    trace.steer[b] = car.steer * 100; trace.gear[b] = car.gear; trace.rpm[b] = car.rpm;
    trace.latG[b] = car.ayF / 9.81; trace.longG[b] = car.axF / 9.81; trace.time[b] = sim.time - sim.lapStart;
    trace.x[b] = car.x; trace.y[b] = car.y; trace.yaw[b] = car.yaw;
  }
  sampleGG(car) {
    this.gg[this.ggi * 2] = car.ayF / 9.81; this.gg[this.ggi * 2 + 1] = car.axF / 9.81;
    this.ggi = (this.ggi + 1) % 900; this.ggn = Math.min(900, this.ggn + 1);
  }
  lapDone(lapTime, valid) {
    this.cur.seal(); this.cur.lapTime = lapTime;
    let isBest = false;
    if (valid && (!this.hasBest || lapTime < this.best.lapTime)) { this.best.copyFrom(this.cur); this.hasBest = true; isBest = true; }
    this.cur.clear();
    return isBest;
  }
  // live delta (s) to a reference at the car's current distance
  delta(sim, ref) {
    if (!ref || sim.lapStart === null) return null;
    const b = Math.min(this.nBins - 1, Math.floor(sim.car.s / BIN));
    if (!ref.filled[b]) return null;
    return (sim.time - sim.lapStart) - ref.time[b];
  }
}

const css = `
#tel { position:absolute; left:12px; bottom:12px; width:min(540px, 40vw); background:rgba(10,13,18,.82); border:1px solid rgba(255,255,255,.12);
  border-radius:8px; color:#e8ecf1; font:12px/1.3 system-ui,sans-serif; backdrop-filter:blur(6px); user-select:none; pointer-events:auto; }
#tel.hidden { display:none; }
#tel header { display:flex; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.1); flex-wrap:wrap; }
#tel header b { font-size:12px; letter-spacing:.08em; margin-right:6px; }
#tel button { background:rgba(255,255,255,.07); color:#cfd6df; border:1px solid rgba(255,255,255,.14); border-radius:4px; padding:2px 8px; font:inherit; cursor:pointer; }
#tel button.on { background:rgba(255,255,255,.2); color:#fff; border-color:rgba(255,255,255,.45); }
#tel .chip { border-left-width:4px; }
#tel .spacer { flex:1; }
#tel canvas { display:block; width:100%; }
#tel .row { display:flex; }
#tel .hint { opacity:.55; padding:3px 8px 6px; font-size:11px; }
`;

export class TelemetryPanel {
  constructor(parent, recorder, track, onCursor) {
    this.rec = recorder; this.track = track; this.onCursor = onCursor;
    this.view = 'traces'; this.refMode = 'best';
    this.x0 = 0; this.x1 = track.length; this.cursor = null; this.follow = false;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const el = this.el = document.createElement('div'); el.id = 'tel'; el.className = 'hidden';
    el.innerHTML = `<header><b>TELEMETRY</b>
      <button data-view="traces" class="on">Traces</button><button data-view="gg">G-G</button><button data-view="tyres">Tyres</button>
      <span class="spacer"></span><span>Ref:</span><button data-ref="best" class="on">Best lap</button><button data-ref="ai">AI lap</button>
      <button data-act="follow" title="Keep the view centred on the car">Follow</button><button data-act="fit">Fit</button></header>
      <header class="chips"></header><canvas height="260"></canvas>
      <div class="hint">Click chips to toggle channels · wheel = zoom · drag = pan · hover = readout (mirrored on the map) · T hides</div>`;
    parent.appendChild(el);
    this.cv = el.querySelector('canvas'); this.ctx = this.cv.getContext('2d');
    const chips = el.querySelector('.chips');
    for (const ch of CHANNELS) {
      const b = document.createElement('button'); b.className = 'chip' + (ch.on ? ' on' : ''); b.textContent = ch.label; b.style.borderLeftColor = ch.color;
      b.onclick = () => { ch.on = !ch.on; b.classList.toggle('on', ch.on); };
      chips.appendChild(b);
    }
    this.chips = chips;
    el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { this.view = b.dataset.view; el.querySelectorAll('[data-view]').forEach(o => o.classList.toggle('on', o === b)); chips.style.display = this.view === 'traces' ? '' : 'none'; });
    el.querySelectorAll('[data-ref]').forEach(b => b.onclick = () => { this.refMode = b.dataset.ref; el.querySelectorAll('[data-ref]').forEach(o => o.classList.toggle('on', o === b)); });
    el.querySelector('[data-act=fit]').onclick = () => { this.x0 = 0; this.x1 = this.track.length; this.follow = false; el.querySelector('[data-act=follow]').classList.remove('on'); };
    el.querySelector('[data-act=follow]').onclick = (e) => { this.follow = !this.follow; e.target.classList.toggle('on', this.follow); if (this.follow) { this.x0 = 0; this.x1 = 600; } };
    const cv = this.cv;
    cv.addEventListener('wheel', (e) => {
      if (this.view !== 'traces') return; e.preventDefault();
      const r = cv.getBoundingClientRect(), f = (e.clientX - r.left - 44) / (r.width - 52);
      const xc = this.x0 + (this.x1 - this.x0) * Math.max(0, Math.min(1, f)), k = e.deltaY > 0 ? 1.25 : 0.8;
      let w = Math.max(120, Math.min(this.track.length, (this.x1 - this.x0) * k));
      this.x0 = Math.max(0, xc - w * f); this.x1 = Math.min(this.track.length, this.x0 + w); this.x0 = Math.max(0, this.x1 - w);
    }, { passive: false });
    let drag = null;
    cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, x0: this.x0, x1: this.x1 }; });
    window.addEventListener('mouseup', () => { drag = null; });
    cv.addEventListener('mousemove', (e) => {
      const r = cv.getBoundingClientRect();
      if (drag && this.view === 'traces') {
        const dx = -(e.clientX - drag.x) / (r.width - 52) * (drag.x1 - drag.x0), w = drag.x1 - drag.x0;
        this.x0 = Math.max(0, Math.min(this.track.length - w, drag.x0 + dx)); this.x1 = this.x0 + w;
      }
      const f = (e.clientX - r.left - 44) / (r.width - 52);
      this.cursor = f >= 0 && f <= 1 ? this.x0 + (this.x1 - this.x0) * f : null;
      this.onCursor?.(this.view === 'traces' ? this.cursor : null);
    });
    cv.addEventListener('mouseleave', () => { this.cursor = null; this.onCursor?.(null); });
  }
  setTrack(recorder, track) { this.rec = recorder; this.track = track; this.x0 = 0; this.x1 = track.length; this.cursor = null; }
  get visible() { return !this.el.classList.contains('hidden'); }
  toggle() { this.el.classList.toggle('hidden'); if (!this.visible) this.onCursor?.(null); }
  ref() { return this.refMode === 'ai' ? (this.rec.hasAI ? this.rec.ai : null) : (this.rec.hasBest ? this.rec.best : null); }

  draw(sim) {
    if (!this.visible) return;
    const cv = this.cv, dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = 260;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = this.ctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    if (this.view === 'traces') this.drawTraces(g, W, H, sim);
    else if (this.view === 'gg') this.drawGG(g, W, H, sim);
    else this.drawTyres(g, W, H, sim);
  }

  drawTraces(g, W, H, sim) {
    const rec = this.rec, cur = rec.cur, ref = this.ref(), car = sim.car, L = this.track.length;
    if (this.follow) { const w = this.x1 - this.x0; this.x0 = Math.max(0, Math.min(L - w, car.s - w * 0.7)); this.x1 = this.x0 + w; }
    const chans = CHANNELS.filter(c => c.on);
    const left = 44, right = W - 8, top = 14, rowH = (H - top - 18) / Math.max(1, chans.length);
    const X = (s) => left + (s - this.x0) / (this.x1 - this.x0) * (right - left);
    const b0 = Math.max(0, Math.floor(this.x0 / BIN)), b1 = Math.min(rec.nBins - 1, Math.ceil(this.x1 / BIN));
    const stride = Math.max(1, Math.floor((b1 - b0) / (right - left)));
    // corner shading from curvature
    g.fillStyle = 'rgba(255,255,255,0.045)';
    for (let b = b0; b <= b1; b++) { const i = Math.min(this.track.n - 1, Math.round(b * BIN / this.track.ds)); if (Math.abs(this.track.curv[i]) > 0.006) g.fillRect(X(b * BIN), top, Math.max(1, X((b + 1) * BIN) - X(b * BIN)), H - top - 18); }
    g.font = '10px system-ui'; g.textBaseline = 'middle';
    const value = (tr, id, b) => (id === 'delta' ? (ref && ref.filled[b] && tr.filled[b] ? tr.time[b] - ref.time[b] : NaN) : tr[id][b]);
    chans.forEach((ch, r) => {
      const y0 = top + r * rowH, y1 = y0 + rowH - 4;
      let lo = ch.min, hi = ch.max;
      if (lo === null || hi === null) {
        let mn = Infinity, mx = -Infinity;
        for (const tr of [cur, ref]) { if (!tr) continue; for (let b = b0; b <= b1; b += stride) { if (!tr.filled[b]) continue; const v = value(tr, ch.id, b); if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; } } }
        if (!(mx > mn)) { mn = 0; mx = 1; }
        if (ch.sym) { const m = Math.max(Math.abs(mn), Math.abs(mx), 0.05); mn = -m; mx = m; }
        if (lo === null) lo = mn; if (hi === null) hi = mx * 1.05;
      }
      const Y = (v) => y1 - (v - lo) / (hi - lo) * (y1 - y0);
      g.strokeStyle = 'rgba(255,255,255,0.1)'; g.lineWidth = 1; g.beginPath(); g.moveTo(left, y1 + 2); g.lineTo(right, y1 + 2); g.stroke();
      if (ch.sym) { g.setLineDash([2, 3]); g.beginPath(); g.moveTo(left, Y(0)); g.lineTo(right, Y(0)); g.stroke(); g.setLineDash([]); }
      g.fillStyle = ch.color; g.textAlign = 'left'; g.fillText(ch.label, 2, y0 + 6);
      g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillText(fmt(hi), 2, y0 + 17); g.fillText(fmt(lo), 2, y1 - 4);
      const plot = (tr, style, dash, width) => {
        if (!tr) return; g.strokeStyle = style; g.lineWidth = width; g.setLineDash(dash); g.beginPath(); let pen = false;
        for (let b = b0; b <= b1; b += stride) {
          const v = tr.filled[b] ? value(tr, ch.id, b) : NaN;
          if (v !== v) { pen = false; continue; }
          const x = X(b * BIN), y = Math.max(y0, Math.min(y1, Y(v)));
          if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
        }
        g.stroke(); g.setLineDash([]);
      };
      if (ch.id !== 'delta') plot(ref, 'rgba(255,255,255,0.42)', [4, 3], 1);
      plot(cur, ch.color, [], 1.6);
      // cursor readout
      const cs = this.cursor ?? (sim.lapStart !== null ? car.s : null);
      if (cs !== null && cs >= this.x0 && cs <= this.x1) {
        const b = Math.min(rec.nBins - 1, Math.floor(cs / BIN));
        const cvv = cur.filled[b] ? value(cur, ch.id, b) : NaN, rv = ref && ref.filled[b] && ch.id !== 'delta' ? value(ref, ch.id, b) : NaN;
        g.textAlign = 'right'; g.fillStyle = ch.color;
        let txt = cvv === cvv ? `${fmt(cvv)} ${ch.unit}` : '–';
        if (rv === rv) txt += `  (ref ${fmt(rv)})`;
        g.fillText(txt, right - 2, y0 + 6);
      }
    });
    // axis + cursors
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.textAlign = 'center';
    const span = this.x1 - this.x0, tick = span > 1500 ? 500 : span > 600 ? 200 : span > 250 ? 100 : 50;
    for (let s = Math.ceil(this.x0 / tick) * tick; s <= this.x1; s += tick) g.fillText(`${s} m`, X(s), H - 8);
    const line = (s, col) => { if (s < this.x0 || s > this.x1) return; g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.moveTo(X(s), top); g.lineTo(X(s), H - 18); g.stroke(); };
    line(car.s, 'rgba(255,220,80,0.9)');
    if (this.cursor !== null) line(this.cursor, 'rgba(255,255,255,0.8)');
    if (!ref) { g.fillStyle = 'rgba(255,255,255,0.5)'; g.textAlign = 'right'; g.fillText(this.refMode === 'ai' ? 'AI reference lap not loaded' : 'complete a valid lap to set a reference', right, H - 8); }
  }

  drawGG(g, W, H, sim) {
    const rec = this.rec, car = sim.car, spec = car.spec;
    const cx = H / 2 + 20, cy = H / 2, maxG = spec.tire.muY > 1.5 ? (spec.ClA > 3 ? 5 : 3) : 1.5, sc = (H / 2 - 18) / maxG;
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = '10px system-ui'; g.textAlign = 'left';
    for (let r = maxG > 3 ? 1 : 0.5; r <= maxG + 1e-6; r += maxG > 3 ? 1 : 0.5) { g.beginPath(); g.arc(cx, cy, r * sc, 0, 6.2832); g.stroke(); g.fillText(`${r}g`, cx + r * sc * 0.71 + 2, cy - r * sc * 0.71); }
    g.beginPath(); g.moveTo(cx - maxG * sc, cy); g.lineTo(cx + maxG * sc, cy); g.moveTo(cx, cy - maxG * sc); g.lineTo(cx, cy + maxG * sc); g.stroke();
    for (let k = 0; k < rec.ggn; k++) {
      const i = (rec.ggi - 1 - k + 900) % 900, a = 1 - k / rec.ggn;
      g.fillStyle = `rgba(79,195,247,${0.08 + a * 0.5})`;
      g.fillRect(cx - rec.gg[i * 2] * sc - 1, cy - rec.gg[i * 2 + 1] * sc - 1, 2.5, 2.5);
    }
    g.fillStyle = '#ffd166'; g.beginPath(); g.arc(cx - car.ayF / 9.81 * sc, cy - car.axF / 9.81 * sc, 4.5, 0, 6.2832); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.textAlign = 'center'; g.fillText('accel', cx, 9); g.fillText('brake', cx, H - 6); g.fillText('left', cx - maxG * sc + 12, cy - 6); g.fillText('right', cx + maxG * sc - 14, cy - 6);
    // live numbers
    const x = H + 70; g.textAlign = 'left'; g.font = '12px system-ui';
    const rows = [['Lateral', `${(car.ayF / 9.81).toFixed(2)} g`], ['Longitudinal', `${(car.axF / 9.81).toFixed(2)} g`], ['Combined', `${(Math.hypot(car.ayF, car.axF) / 9.81).toFixed(2)} g`],
      ['Speed', `${(car.speed * 3.6).toFixed(0)} km/h`], ['Yaw rate', `${(car.r * 57.3).toFixed(0)} °/s`], ['Side-slip β', `${(Math.atan2(car.vy, Math.max(1, Math.abs(car.vx))) * 57.3).toFixed(1)} °`],
      ['Downforce', `${(0.6 * spec.ClA * car.speed * car.speed).toFixed(0)} N`], ['Drag', `${(0.6 * spec.CdA * car.speed * car.speed).toFixed(0)} N`], ['Engine torque', `${car.engineTorque.toFixed(0)} Nm`],
      ['TC cut', `${(car.tcCut * 100).toFixed(0)} %`], ['Boost', spec.engine.turbo ? `${(car.boost * 100).toFixed(0)} %` : '—'], ['Track grip', `${(car.gripScale * 100).toFixed(0)} %`]];
    rows.forEach(([k, v], i) => { const yy = 22 + i * 19; g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillText(k, x, yy); g.fillStyle = '#fff'; g.fillText(v, x + 110, yy); });
  }

  drawTyres(g, W, H, sim) {
    const car = sim.car, t = car.spec.tire, names = ['FL', 'FR', 'RL', 'RR'], surf = ['asphalt', 'kerb', 'grass', 'gravel'];
    const bw = Math.min(150, (W - 60) / 2 - 10), bh = 108;
    g.font = '11px system-ui'; g.textBaseline = 'alphabetic';
    for (let i = 0; i < 4; i++) {
      const x = W / 2 + (i % 2 ? 10 : -bw - 10), y = 8 + (i > 1 ? bh + 12 : 0);
      const dT = (car.tireT[i] - t.tOpt) / t.tWin;
      const col = dT < 0 ? `rgb(${60 + 60 * (1 + Math.max(-1, dT))},${150 + 60 * (1 + Math.max(-1, dT))},${255 + 120 * Math.max(-1, dT)})` : `rgb(${110 + 145 * Math.min(1, dT * 1.6)},${210 - 150 * Math.min(1, dT * 1.6)},${90 - 50 * Math.min(1, dT)})`;
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x, y, bw, bh);
      g.fillStyle = col; g.fillRect(x + 6, y + 6, 26, bh - 12);
      // grip usage bar
      const sx = car.kappa[i] / t.peakKappa, sy = Math.tan(car.alpha[i]) / Math.tan(t.peakAlpha), use = Math.min(1.6, Math.hypot(sx, sy));
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x + 40, y + bh - 16, bw - 48, 8);
      g.fillStyle = use > 1 ? '#ff5d5d' : use > 0.8 ? '#ffd166' : '#66dd77'; g.fillRect(x + 40, y + bh - 16, (bw - 48) * Math.min(1, use / 1.6), 8);
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(x + 40 + (bw - 48) / 1.6, y + bh - 18, 1, 12);
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = 'bold 12px system-ui'; g.fillText(`${names[i]}  ${car.tireT[i].toFixed(0)}°C`, x + 40, y + 18);
      g.font = '11px system-ui'; g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fillText(`load ${(car.fz[i] / 1000).toFixed(2)} kN`, x + 40, y + 34);
      g.fillText(`slip angle ${(car.alpha[i] * 57.3).toFixed(1)}°`, x + 40, y + 49);
      g.fillText(`slip ratio ${(car.kappa[i] * 100).toFixed(1)}%`, x + 40, y + 64);
      g.fillStyle = car.surf[i] === SURF.ASPHALT ? 'rgba(255,255,255,0.6)' : '#ffd166'; g.fillText(surf[car.surf[i]], x + 40, y + 79);
    }
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.textAlign = 'center';
    g.fillText(`${t === car.spec.tire ? '' : ''}optimum ${t.tOpt}°C · bar = share of peak grip in use (line = limit)`, W / 2, H - 6);
  }
}

function fmt(v) { const a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2); }
