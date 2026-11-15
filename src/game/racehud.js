// Race HUD: start lights, position and lap, live timing tower, proximity indicator,
// minimap dots and the results screen. Plain DOM on top of the driver HUD (hud.js).
import { fmtTime } from './hud.js';

const CSS = `
#r-top { position:absolute; left:50%; top:10px; transform:translateX(-50%); display:none; gap:14px; align-items:center; background:rgba(10,13,18,.74); border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:6px 16px; font-variant-numeric:tabular-nums; }
#r-top b { font-size:26px; } #r-top small { font-size:12px; opacity:.65; letter-spacing:.08em; margin-right:4px; }
#r-top .flag { font-size:12px; font-weight:700; padding:2px 8px; border-radius:3px; display:none; }
#r-lights { position:absolute; left:50%; top:22%; transform:translateX(-50%); display:none; gap:14px; background:rgba(8,9,12,.88); padding:14px 18px; border-radius:12px; border:1px solid rgba(255,255,255,.15); }
#r-lights i { width:38px; height:38px; border-radius:50%; background:#2a0b0b; box-shadow:inset 0 0 6px #000; display:block; }
#r-lights i.on { background:#ff2a1a; box-shadow:0 0 22px #ff2a1a, inset 0 0 6px #ffb0a0; }
#r-lights.go i { background:#1dd35a; box-shadow:0 0 22px #1dd35a; }
#r-tower { position:absolute; left:12px; top:238px; width:238px; display:none; background:rgba(10,13,18,.74); border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:5px 0; font-size:12.5px; font-variant-numeric:tabular-nums; backdrop-filter:blur(6px); }
#r-tower .h { display:flex; justify-content:space-between; padding:0 10px 4px; font-size:10.5px; opacity:.6; letter-spacing:.08em; }
#r-tower .row { display:flex; align-items:center; gap:6px; padding:1.5px 10px; white-space:nowrap; }
#r-tower .row.focus { background:rgba(255,209,102,.22); } #r-tower .row.me .n { color:#ffd166; font-weight:700; }
#r-tower .row.out { opacity:.45; }
#r-tower .p { width:17px; text-align:right; font-weight:700; } #r-tower .c { width:5px; height:13px; border-radius:1px; }
#r-tower .n { flex:1; overflow:hidden; text-overflow:ellipsis; } #r-tower .g { text-align:right; opacity:.9; }
#r-tower .k { width:14px; font-size:10px; opacity:.6; }
#r-prox { position:absolute; left:50%; bottom:22%; transform:translateX(-50%); display:flex; gap:150px; font-size:15px; font-weight:800; letter-spacing:.06em; pointer-events:none; }
#r-prox span { padding:5px 12px; border-radius:5px; background:rgba(255,160,40,.92); color:#111; opacity:0; transition:opacity .12s; }
#r-prox span.on { opacity:1; } #r-prox span.close { background:rgba(255,60,50,.95); color:#fff; }
#r-results { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:none; max-height:86vh; overflow:auto; background:rgba(10,13,18,.9); border:1px solid rgba(255,255,255,.2); border-radius:10px; padding:16px 20px; pointer-events:auto; font-variant-numeric:tabular-nums; }
#r-results h2 { margin:0 0 8px; font-size:22px; } #r-results table { border-collapse:collapse; font-size:13.5px; }
#r-results td, #r-results th { padding:3px 10px; text-align:right; } #r-results th { font-size:11px; opacity:.6; font-weight:600; letter-spacing:.06em; }
#r-results td:nth-child(2), #r-results td:nth-child(3), #r-results th:nth-child(2), #r-results th:nth-child(3) { text-align:left; }
#r-results tr.me td { color:#ffd166; font-weight:700; } #r-results p { margin:10px 0 0; font-size:12.5px; opacity:.75; }
#racerow { border-top:1px solid rgba(255,255,255,.12); padding-top:12px; }
#racerow label { font-size:13px; }
@media (max-width: 900px) { #r-tower { top:214px; width:200px; font-size:11.5px; } }
`;

export const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
const gapText = (c, lead) => {
  if (c.retired) return 'OUT';
  if (c === lead) return c.finished ? 'FINISH' : 'LEADER';
  if (c.lapsDown > 0 && !c.finished) return `+${c.lapsDown} LAP${c.lapsDown > 1 ? 'S' : ''}`;
  return '+' + c.gapLeader.toFixed(c.gapLeader < 100 ? 1 : 0);
};

export class RaceHUD {
  constructor(ui, hud) {
    this.hud = hud;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    ui.insertAdjacentHTML('beforeend', `
      <div id="r-top"><span><small>POS</small><b id="r-p">–</b><span id="r-of"></span></span><span><small>LAP</small><b id="r-lap">–</b><span id="r-laps"></span></span>
        <span><small>GAP</small><span id="r-gap"></span></span><span class="flag" id="r-flag"></span></div>
      <div id="r-lights"><i></i><i></i><i></i><i></i><i></i></div>
      <div id="r-tower"></div>
      <div id="r-prox"><span id="r-left">◀ CAR LEFT</span><span id="r-right">CAR RIGHT ▶</span></div>
      <div id="r-results"></div>`);
    this.$ = (id) => document.getElementById(id);
    this.lamps = [...this.$('r-lights').children];
    this.tick = 0; this.goT = 0; this.towerOn = true; this.rows = [];
  }

  show(on) {
    for (const id of ['r-top']) this.$(id).style.display = on ? 'flex' : 'none';
    this.$('r-tower').style.display = on && this.towerOn ? 'block' : 'none';
    if (!on) { this.$('r-lights').style.display = 'none'; this.$('r-results').style.display = 'none'; this.$('r-left').className = ''; this.$('r-right').className = ''; }
    this.shown = on; this.rows = []; this.$('r-tower').innerHTML = '';
  }
  toggleTower() { this.towerOn = !this.towerOn; this.$('r-tower').style.display = this.shown && this.towerOn ? 'block' : 'none'; return this.towerOn; }

  // race: sim Race; focus: the race car being followed; colors: css colour per car index
  update(dt, race, focus, colors, prox) {
    // start lights
    const L = this.$('r-lights');
    if (!race.green) { L.style.display = 'flex'; L.classList.remove('go'); this.lamps.forEach((l, i) => l.classList.toggle('on', i < race.lightsOn)); this.goT = 1.4; }
    else if (this.goT > 0) { this.goT -= dt; L.classList.add('go'); this.lamps.forEach(l => l.classList.remove('on')); if (this.goT <= 0) L.style.display = 'none'; }
    // proximity
    const l = this.$('r-left'), r = this.$('r-right');
    l.className = prox.left ? (prox.left < 1.2 ? 'on close' : 'on') : ''; r.className = prox.right ? (prox.right < 1.2 ? 'on close' : 'on') : '';
    if (this.tick++ % 6) return;
    const lead = race.cars[race.order[0]], n = race.cars.length;
    this.$('r-p').textContent = focus.pos; this.$('r-of').textContent = ` / ${n}`;
    const lap = Math.min(race.laps, Math.max(1, focus.sim.lap + 1));
    this.$('r-lap').textContent = focus.finished ? 'FIN' : lap; this.$('r-laps').textContent = focus.finished ? '' : ` / ${race.laps}`;
    const ahead = focus.pos > 1 ? race.cars[race.order[focus.pos - 2]] : null, behind = focus.pos < n ? race.cars[race.order[focus.pos]] : null;
    this.$('r-gap').textContent = (ahead && !ahead.finished && !ahead.retired ? `▲ ${focus.interval.toFixed(1)}  ` : '') + (behind && !behind.retired && !behind.finished && !focus.finished ? `▼ ${behind.interval.toFixed(1)}` : '');
    const f = this.$('r-flag');
    const flag = race.over ? ['RACE OVER', '#222', '#fff'] : focus.blue ? ['BLUE FLAG', '#1668ff', '#fff'] : focus.penalty ? [`PENALTY +${focus.penalty}s`, '#b3261e', '#fff'] : focus.strikes % 3 ? [`TRACK LIMITS ${focus.strikes % 3}/3`, '#a68413', '#fff'] : race.leaderFinished ? ['CHEQUERED FLAG', '#f2f2f2', '#111'] : null;
    if (flag) { f.style.display = 'inline-block'; f.textContent = flag[0]; f.style.background = flag[1]; f.style.color = flag[2]; } else f.style.display = 'none';
    // timing tower
    if (!this.towerOn) return;
    const T = this.$('r-tower');
    if (this.rows.length !== n) {
      T.innerHTML = `<div class="h"><span>${race.track.name.toUpperCase()}</span><span>GAP</span></div>` + race.cars.map(() => '<div class="row"><span class="p"></span><span class="c"></span><span class="n"></span><span class="k"></span><span class="g"></span></div>').join('');
      this.rows = [...T.querySelectorAll('.row')].map(el => ({ el, p: el.children[0], c: el.children[1], n: el.children[2], k: el.children[3], g: el.children[4] }));
    }
    for (let p = 0; p < n; p++) {
      const c = race.cars[race.order[p]], row = this.rows[p];
      row.el.className = 'row' + (c === focus ? ' focus' : '') + (c.player ? ' me' : '') + (c.retired ? ' out' : '');
      row.p.textContent = p + 1; row.c.style.background = colors[c.index]; row.n.textContent = `${c.number} ${c.name}`;
      row.k.textContent = c.needRespawn ? '⚠' : c.penalty ? 'P' : c.blue ? 'B' : '';
      row.g.textContent = gapText(c, lead);
    }
  }

  // dots for every car on the track map (after HUD.drawMap has drawn the circuit)
  drawMap(race, focus, colors) {
    const g = this.hud.mctx, h = this.hud;
    for (let p = race.order.length - 1; p >= 0; p--) {
      const c = race.cars[race.order[p]]; if (c === focus || c.retired) continue;
      const x = h.mx(c.car.x), y = h.my(c.car.y);
      g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, 6, 0, 6.2832); g.fill();
      g.fillStyle = colors[c.index]; g.beginPath(); g.arc(x, y, 4.2, 0, 6.2832); g.fill();
    }
    const x = h.mx(focus.car.x), y = h.my(focus.car.y);
    g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, 9, 0, 6.2832); g.fill();
    g.fillStyle = '#ffcc00'; g.beginPath(); g.arc(x, y, 6.5, 0, 6.2832); g.fill();
  }

  results(race, stats) {
    const el = this.$('r-results'), cls = race.classification(), w = cls[0];
    const row = (r) => `<tr class="${r.player ? 'me' : ''}"><td>${r.retired ? 'DNF' : r.pos}</td><td>${r.name}</td><td>${r.carName}</td><td>${r.grid}</td><td>${r.laps}</td>
      <td>${r.retired ? r.reason : !r.finished ? 'running' : r === w ? fmtTime(r.time) : r.gap !== null ? '+' + r.gap.toFixed(3) : `+${w.laps - r.laps} lap${w.laps - r.laps > 1 ? 's' : ''}`}</td>
      <td>${fmtTime(r.bestLap)}</td><td>${r.penalty ? '+' + r.penalty + ' s' : ''}</td><td>${r.contacts || ''}</td></tr>`;
    el.innerHTML = `<h2>${race.track.name} — ${race.laps} lap${race.laps > 1 ? 's' : ''}${race.over ? '' : ' (provisional)'}</h2>
      <table><tr><th>POS</th><th>DRIVER</th><th>CAR</th><th>GRID</th><th>LAPS</th><th>TIME / GAP</th><th>BEST LAP</th><th>PEN</th><th>CONTACTS</th></tr>${cls.map(row).join('')}</table>
      <p>${stats}</p><p><b>Enter</b> race again · <b>Esc</b> menu · <b>J</b> / <b>K</b> watch another car · <b>O</b> TV director</p>`;
    el.style.display = 'block';
  }
  hideResults() { this.$('r-results').style.display = 'none'; }
}
