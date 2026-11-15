// Driver HUD: instrument cluster, lap timing tower, track map, toasts.
import { SURF } from '../sim/track.js';

export function fmtTime(t, signed = false) {
  if (t === null || t === undefined || !isFinite(t)) return '--:--.---';
  const sg = t < 0 ? '-' : signed ? '+' : ''; t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return signed ? `${sg}${t.toFixed(3)}` : `${sg}${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export class HUD {
  constructor(root, track) {
    this.track = track;
    root.insertAdjacentHTML('beforeend', `
      <div id="timing">
        <div class="carname"></div>
        <div class="big"><span class="lbl">LAP <span id="lapn">–</span></span><span id="cur">0:00.000</span></div>
        <div id="delta" class="delta"></div>
        <div class="line"><span class="lbl">LAST</span><span id="last">--:--.---</span></div>
        <div class="line"><span class="lbl">BEST</span><span id="best">--:--.---</span></div>
        <div class="sectors"><span id="s1">S1</span><span id="s2">S2</span><span id="s3">S3</span></div>
        <div id="invalid">TRACK LIMITS — LAP INVALID</div>
        <div id="mode"></div>
      </div>
      <canvas id="map" width="460" height="300"></canvas>
      <canvas id="cluster" width="760" height="360"></canvas>
      <div id="toast"></div><div id="perf"></div>`);
    this.$ = (id) => root.querySelector('#' + id);
    this.map = this.$('map'); this.mctx = this.map.getContext('2d');
    this.cl = this.$('cluster'); this.cctx = this.cl.getContext('2d');
    this.toastT = 0;
    this.setTrack(track);
    this.sectorBest = [null, null, null];
  }

  setTrack(track) {
    this.track = track;
    const t = track; let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < t.n; i++) { minX = Math.min(minX, t.x[i]); maxX = Math.max(maxX, t.x[i]); minY = Math.min(minY, t.y[i]); maxY = Math.max(maxY, t.y[i]); }
    const W = 460, H = 300, pad = 22, sc = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    this.mx = (x) => pad + (x - minX) * sc + ((W - 2 * pad) - (maxX - minX) * sc) / 2;
    this.my = (y) => H - pad - (y - minY) * sc - ((H - 2 * pad) - (maxY - minY) * sc) / 2;
    this.path = new Path2D();
    for (let i = 0; i <= t.n; i += 3) { const k = i % t.n; if (i === 0) this.path.moveTo(this.mx(t.x[k]), this.my(t.y[k])); else this.path.lineTo(this.mx(t.x[k]), this.my(t.y[k])); }
  }

  toast(msg, secs = 2.5) { const el = this.$('toast'); el.textContent = msg; el.style.opacity = 1; this.toastT = secs; }

  setCar(spec) { this.$('timing').querySelector('.carname').textContent = `${spec.name} — ${spec.klass}`; this.sectorBest = [null, null, null]; }

  lapCompleted(sim) {
    const s = sim.lastSectors || [];
    for (let i = 0; i < 3; i++) if (sim.lastLapValid && s[i] != null && (this.sectorBest[i] === null || s[i] < this.sectorBest[i])) this.sectorBest[i] = s[i];
  }

  update(dt, sim, ctx) {
    const car = sim.car;
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.$('toast').style.opacity = 0; }
    this.$('lapn').textContent = sim.lapStart === null ? 'OUT' : sim.lap + 1;
    this.$('cur').textContent = fmtTime(sim.lapStart === null ? 0 : sim.lapTime);
    this.$('last').textContent = fmtTime(sim.lastLap) + (sim.lastLap !== null && !sim.lastLapValid ? ' ✕' : '');
    this.$('best').textContent = fmtTime(sim.bestLap);
    const d = ctx.delta, de = this.$('delta');
    if (d === null || d === undefined) de.textContent = ''; else { de.textContent = `${fmtTime(d, true)}  vs ${ctx.refLabel}`; de.className = 'delta ' + (d <= 0 ? 'gain' : 'loss'); }
    for (let i = 0; i < 3; i++) {
      const el = this.$('s' + (i + 1));
      const live = sim.sectorTimes[i], last = sim.lastSectors?.[i];
      const v = live ?? (sim.sectorIdx <= i ? null : last);
      el.textContent = `S${i + 1} ${v != null ? v.toFixed(2) : '–'}`;
      el.className = v == null ? '' : (this.sectorBest[i] !== null && v <= this.sectorBest[i] + 1e-9 ? 'pb' : this.sectorBest[i] === null ? 'pb' : 'slow');
      if (sim.sectorIdx === i && sim.lapStart !== null) el.classList.add('active');
    }
    this.$('invalid').style.display = sim.lapStart !== null && !sim.lapValid ? 'block' : 'none';
    this.$('mode').textContent = ctx.modeText || '';
    this.drawCluster(car, ctx);
    this.drawMap(sim, ctx);
  }

  drawMap(sim, ctx) {
    const g = this.mctx, t = this.track, car = sim.car;
    g.clearRect(0, 0, 460, 300);
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 11; g.stroke(this.path);
    g.strokeStyle = 'rgba(255,255,255,0.92)'; g.lineWidth = 5; g.stroke(this.path);
    // sector ticks + start line
    g.strokeStyle = '#111'; g.lineWidth = 3;
    for (const [k, col] of [[0, '#ff4444'], [t.sectors[1], '#ffd166'], [t.sectors[2], '#ffd166']]) {
      const h = t.heading[k], nx = -Math.sin(h), ny = Math.cos(h), x = this.mx(t.x[k]), y = this.my(t.y[k]);
      g.strokeStyle = col; g.beginPath(); g.moveTo(x - nx * 8, y + ny * 8); g.lineTo(x + nx * 8, y - ny * 8); g.stroke();
    }
    const dot = (x, y, col, r) => { g.fillStyle = '#000'; g.beginPath(); g.arc(this.mx(x), this.my(y), r + 2, 0, 6.2832); g.fill(); g.fillStyle = col; g.beginPath(); g.arc(this.mx(x), this.my(y), r, 0, 6.2832); g.fill(); };
    if (ctx.ghost) dot(ctx.ghost.x, ctx.ghost.y, '#66ccff', 5);
    if (ctx.cursorS !== null && ctx.cursorS !== undefined) { const i = Math.min(t.n - 1, Math.floor(ctx.cursorS / t.ds)); g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(this.mx(t.x[i]), this.my(t.y[i]), 9, 0, 6.2832); g.stroke(); }
    dot(car.x, car.y, '#ffcc00', 6);
  }

  drawCluster(car, ctx) {
    const g = this.cctx, W = 760, H = 360, spec = car.spec, e = spec.engine;
    g.clearRect(0, 0, W, H);
    const cx = 520, cy = 215, R = 150;
    const a0 = Math.PI * 0.78, a1 = Math.PI * 2.22, maxRpm = Math.ceil(e.limiter / 1000) * 1000;
    const ang = (rpm) => a0 + (a1 - a0) * Math.min(1, rpm / maxRpm);
    g.lineCap = 'butt';
    g.fillStyle = 'rgba(8,10,14,0.72)'; g.beginPath(); g.arc(cx, cy, R + 22, 0, 6.2832); g.fill();
    g.lineWidth = 16;
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    g.strokeStyle = 'rgba(255,60,60,0.55)'; g.beginPath(); g.arc(cx, cy, R, ang(e.redline), a1); g.stroke();
    const frac = car.rpm / e.redline;
    g.strokeStyle = frac > 0.97 ? '#ff4d4d' : frac > 0.88 ? '#ffd166' : '#4fc3f7';
    g.beginPath(); g.arc(cx, cy, R, a0, ang(car.rpm)); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = '15px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const stepK = maxRpm > 12000 ? 2000 : 1000;
    for (let r = 0; r <= maxRpm; r += stepK) { const a = ang(r); g.fillText(String(r / 1000), cx + Math.cos(a) * (R - 26), cy + Math.sin(a) * (R - 26)); }
    // gear, speed
    g.fillStyle = '#fff'; g.font = 'bold 92px system-ui';
    const gearTxt = e.electric ? (car.gear < 0 ? 'R' : 'D') : car.gear < 0 ? 'R' : car.gear === 0 ? 'N' : String(car.gear);
    g.fillText(gearTxt, cx, cy - 26);
    g.font = 'bold 46px system-ui'; g.fillText(String(Math.round(Math.abs(car.speed) * 3.6)), cx, cy + 52);
    g.font = '14px system-ui'; g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillText('km/h', cx, cy + 84);
    g.fillText(e.electric ? 'motor rpm x1000' : 'rpm x1000', cx, cy + 108);
    // shift lights
    for (let k = 0; k < 8; k++) { const on = frac > 0.78 + k * 0.027; g.fillStyle = on ? (k < 3 ? '#39d353' : k < 6 ? '#ffd166' : '#ff4d4d') : 'rgba(255,255,255,0.12)'; g.beginPath(); g.arc(cx - 77 + k * 22, cy - 98, 7, 0, 6.2832); g.fill(); }
    // pedals + steering
    const bar = (x, v, col, label) => { g.fillStyle = 'rgba(8,10,14,0.72)'; g.fillRect(x - 4, 96, 38, 236); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, 100, 30, 200); g.fillStyle = col; g.fillRect(x, 300 - 200 * v, 30, 200 * v); g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = '13px system-ui'; g.fillText(label, x + 15, 318); };
    bar(250, car.brake, '#ff5d5d', 'BRK'); bar(296, car.throttle, '#66dd77', 'THR');
    g.fillStyle = 'rgba(8,10,14,0.72)'; g.fillRect(96, 300, 140, 32);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(100, 310, 132, 12);
    g.fillStyle = '#ffd166'; const sx = 166 - car.steer * 62; g.fillRect(sx - 4, 306, 8, 20);
    // lamps
    const lamp = (x, y, txt, on, col) => { g.fillStyle = on ? col : 'rgba(255,255,255,0.1)'; g.fillRect(x, y, 62, 24); g.fillStyle = on ? '#111' : 'rgba(255,255,255,0.4)'; g.font = 'bold 13px system-ui'; g.fillText(txt, x + 31, y + 13); };
    let absOn = false; for (let i = 0; i < 4; i++) if (car.absF[i] < 0.95) absOn = true;
    lamp(100, 236, 'ABS', car.aids.abs && absOn && car.brake > 0.1, '#ffd166');
    lamp(170, 236, 'TC', car.aids.tc && car.tcCut > 0.04, '#ffd166');
    lamp(100, 266, car.aids.abs ? 'ABS on' : 'ABS off', !car.aids.abs, '#ff5d5d');
    lamp(170, 266, car.aids.tc ? 'TC on' : 'TC off', !car.aids.tc, '#ff5d5d');
    if (e.turbo) { g.fillStyle = 'rgba(8,10,14,0.72)'; g.fillRect(96, 196, 140, 30); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(100, 206, 132, 10); g.fillStyle = '#4fc3f7'; g.fillRect(100, 206, 132 * car.boost, 10); g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '11px system-ui'; g.fillText('BOOST', 166, 201); }
    let offSurf = 0; for (let i = 0; i < 4; i++) if (car.surf[i] >= SURF.GRASS) offSurf++;
    if (car.limiterOn) lamp(cx - 31, cy + 124, 'LIMIT', true, '#ff4d4d');
    else if (ctx.autopilot) lamp(cx - 31, cy + 124, 'AI', true, '#66ccff');
    else if (offSurf >= 2) lamp(cx - 31, cy + 124, 'OFF', true, '#ff9f43');
  }
}
