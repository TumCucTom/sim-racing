// Renders docs/learning-curve-<car>.svg and docs/benchmark-<car>.svg from the
// training logs and benchmark JSON. Plain SVG, no dependencies.
import fs from 'node:fs';
const carId = process.argv[2] || 'gt3';
const C = { surface: '#fcfcfb', text: '#0b0b0b', text2: '#52514e', grid: '#e4e3df', base: '#2a78d6', rl: '#eb6834' };
const bench = JSON.parse(fs.readFileSync(`docs/benchmark-${carId}.json`));
const runs = fs.readdirSync('rl/runs').filter(n => n.startsWith(`${carId}_s`) && fs.existsSync(`rl/runs/${n}/progress.jsonl`)).sort()
  .map(n => ({ name: n, rows: fs.readFileSync(`rl/runs/${n}/progress.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l)) }));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const font = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif"';

function frame(W, H, title, sub) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${font}><rect width="${W}" height="${H}" fill="${C.surface}"/>
<text x="24" y="30" font-size="17" font-weight="700" fill="${C.text}">${esc(title)}</text><text x="24" y="50" font-size="12.5" fill="${C.text2}">${esc(sub)}</text>`;
}
function axes(x0, y0, x1, y1, xt, yt, X, Y, xl, yl) {
  let s = '';
  for (const v of yt) s += `<line x1="${x0}" x2="${x1}" y1="${Y(v)}" y2="${Y(v)}" stroke="${C.grid}"/><text x="${x0 - 8}" y="${Y(v) + 4}" font-size="11.5" text-anchor="end" fill="${C.text2}">${v}</text>`;
  for (const v of xt) s += `<text x="${X(v)}" y="${y1 + 18}" font-size="11.5" text-anchor="middle" fill="${C.text2}">${v}</text>`;
  s += `<line x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}" stroke="${C.text2}"/><text x="${(x0 + x1) / 2}" y="${y1 + 38}" font-size="12" text-anchor="middle" fill="${C.text2}">${esc(xl)}</text>`;
  s += `<text transform="translate(${x0 - 42},${(y0 + y1) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${C.text2}">${esc(yl)}</text>`;
  return s;
}

// ---------- learning curves: two stacked panels sharing the x axis ----------
{
  const W = 860, H = 640, x0 = 70, x1 = W - 150;
  const maxSteps = Math.max(...runs.flatMap(r => r.rows.map(q => q.steps))) / 1e6;
  const X = (m) => x0 + m / maxSteps * (x1 - x0);
  const xt = []; for (let v = 0; v <= maxSteps + 1e-9; v += maxSteps > 2 ? 0.5 : 0.25) xt.push(+v.toFixed(2));
  let svg = frame(W, H, `Learning curves — PPO driver, ${bench.track}`, `${runs.length} training seeds; thin lines = individual seeds, thick = mean. Baseline = tuned scripted driver.`);
  // panel A: validation flying lap
  const evals = runs.map(r => r.rows.filter(q => q.evalLap != null && q.evalCompleted === (q.evalFails?.length ?? 0)));
  const allLap = evals.flat().map(q => q.evalLap).concat([(bench.baseline.stintMean ?? bench.baseline.mean)]);
  const lo = Math.floor(Math.min(...allLap) - 1), hi = Math.ceil(Math.min(Math.max(...allLap), (bench.baseline.stintMean ?? bench.baseline.mean) + 6) + 1);
  const ya0 = 80, ya1 = 320, YA = (v) => ya1 - (Math.min(hi, v) - lo) / (hi - lo) * (ya1 - ya0);
  const yt = []; for (let v = lo; v <= hi; v += Math.max(1, Math.round((hi - lo) / 6))) yt.push(v);
  svg += `<text x="${x0}" y="${ya0 - 10}" font-size="12.5" font-weight="600" fill="${C.text}">Validation stint pace (s/lap) — checkpoints where every validation start gave a clean 8-lap stint</text>`;
  svg += axes(x0, ya0, x1, ya1, xt, yt, X, YA, '', 'lap time (s), lower is better');
  svg += `<line x1="${x0}" x2="${x1}" y1="${YA((bench.baseline.stintMean ?? bench.baseline.mean))}" y2="${YA((bench.baseline.stintMean ?? bench.baseline.mean))}" stroke="${C.base}" stroke-width="2" stroke-dasharray="6 4"/><text x="${x1 + 8}" y="${YA((bench.baseline.stintMean ?? bench.baseline.mean)) + 4}" font-size="12" fill="${C.text}">Baseline ${(bench.baseline.stintMean ?? bench.baseline.mean).toFixed(2)} s</text>`;
  for (const ev of evals) {
    svg += `<path d="${ev.map((q, i) => `${i ? 'L' : 'M'}${X(q.steps / 1e6).toFixed(1)},${YA(q.evalLap).toFixed(1)}`).join('')}" fill="none" stroke="${C.rl}" stroke-width="1" opacity="0.45"/>`;
    for (const q of ev) svg += `<circle cx="${X(q.steps / 1e6).toFixed(1)}" cy="${YA(q.evalLap).toFixed(1)}" r="4" fill="${C.rl}" opacity="0.001"><title>${(q.steps / 1e6).toFixed(2)}M steps: ${q.evalLap.toFixed(2)} s</title></circle>`;
  }
  // best-so-far mean across seeds
  const grid = []; for (let m = 0.05; m <= maxSteps + 1e-9; m += 0.05) grid.push(m);
  const bestSoFar = grid.map(m => { const v = evals.map(ev => { const b = ev.filter(q => q.steps / 1e6 <= m).map(q => q.evalLap); return b.length ? Math.min(...b) : null; }).filter(x => x !== null); return v.length === evals.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
  const pts = grid.map((m, i) => (bestSoFar[i] === null ? null : [X(m), YA(bestSoFar[i])])).filter(Boolean);
  if (pts.length) { svg += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')}" fill="none" stroke="${C.rl}" stroke-width="2.5"/>`;
    const last = pts[pts.length - 1]; svg += `<text x="${x1 + 8}" y="${last[1] + 4}" font-size="12" fill="${C.text}">PPO best-so-far</text><text x="${x1 + 8}" y="${last[1] + 19}" font-size="12" fill="${C.text}">(mean of seeds) ${bestSoFar.filter(v => v !== null).pop().toFixed(2)} s</text>`; }
  // panel B: training progress per episode
  const yb0 = 380, yb1 = 580, maxP = Math.max(...runs.flatMap(r => r.rows.map(q => q.epProg)));
  const YB = (v) => yb1 - v / (Math.ceil(maxP / 500) * 500) * (yb1 - yb0);
  const ytb = []; for (let v = 0; v <= Math.ceil(maxP / 500) * 500; v += 500) ytb.push(v);
  svg += `<text x="${x0}" y="${yb0 - 10}" font-size="12.5" font-weight="600" fill="${C.text}">Training: mean distance covered per 60 s episode (m), exploration noise on</text>`;
  svg += axes(x0, yb0, x1, yb1, xt, ytb, X, YB, 'environment steps (millions, 20 Hz control)', 'metres per episode');
  for (const r of runs) svg += `<path d="${r.rows.filter((_, i) => i % 3 === 0).map((q, i) => `${i ? 'L' : 'M'}${X(q.steps / 1e6).toFixed(1)},${YB(q.epProg).toFixed(1)}`).join('')}" fill="none" stroke="${C.rl}" stroke-width="1" opacity="0.45"/>`;
  const nmin = Math.min(...runs.map(r => r.rows.length)); let d = '';
  for (let i = 0; i < nmin; i += 3) { const m = runs.reduce((a, r) => a + r.rows[i].epProg, 0) / runs.length; d += `${i ? 'L' : 'M'}${X(runs[0].rows[i].steps / 1e6).toFixed(1)},${YB(m).toFixed(1)}`; }
  svg += `<path d="${d}" fill="none" stroke="${C.rl}" stroke-width="2.5"/>`;
  fs.writeFileSync(`docs/learning-curve-${carId}.svg`, svg + '</svg>');
}

// ---------- benchmark: one dot per fixed-seed trial ----------
{
  const rows = [bench.baseline, ...bench.policies];
  const W = 880, rowH = 46, x0 = 215, x1 = W - 170, y0 = 84, H = y0 + rows.length * rowH + 64;
  const all = rows.flatMap(r => r.laps.filter(v => v !== null));
  const lo = Math.floor(Math.min(...all) - 0.5), hi = Math.ceil(Math.max(...all) + 0.5);
  const X = (v) => x0 + (v - lo) / (hi - lo) * (x1 - x0);
  let svg = frame(W, H, `Fixed-seed benchmark — ${CAR(bench)} at ${bench.track}`, `${bench.trials} trials per driver (seeds 1–${bench.trials}, unseen in training). Each dot = one trial's flying lap (lap 2); bar = mean. Right: ${bench.stintLaps}-lap stint results.`);
  for (let v = lo; v <= hi; v += Math.max(1, Math.round((hi - lo) / 8))) svg += `<line x1="${X(v)}" x2="${X(v)}" y1="${y0 - 8}" y2="${y0 + rows.length * rowH}" stroke="${C.grid}"/><text x="${X(v)}" y="${y0 + rows.length * rowH + 18}" font-size="11.5" text-anchor="middle" fill="${C.text2}">${v}</text>`;
  svg += `<text x="${(x0 + x1) / 2}" y="${y0 + rows.length * rowH + 40}" font-size="12" text-anchor="middle" fill="${C.text2}">flying lap time (s), lower is better</text>`;
  rows.forEach((r, i) => {
    const y = y0 + i * rowH + rowH / 2 - 4, col = i === 0 ? C.base : C.rl, champ = r.run && r.run === bench.champion;
    svg += `<text x="${x0 - 12}" y="${y + 4}" font-size="12.5" text-anchor="end" font-weight="${champ || i === 0 ? 700 : 400}" fill="${C.text}">${esc(r.name)}${champ ? ' ★' : ''}</text>`;
    r.laps.forEach((v, k) => { if (v !== null) svg += `<circle cx="${X(v).toFixed(1)}" cy="${(y + ((k * 7) % 13) - 6).toFixed(1)}" r="4" fill="${col}" stroke="${C.surface}" stroke-width="1.5" opacity="0.9"><title>seed ${bench.seeds[k]}: ${v.toFixed(3)} s</title></circle>`; });
    if (r.mean !== null) svg += `<line x1="${X(r.mean)}" x2="${X(r.mean)}" y1="${y - 14}" y2="${y + 14}" stroke="${C.text}" stroke-width="2"/>`;
    svg += `<text x="${x1 + 12}" y="${y - 2}" font-size="12.5" font-weight="600" fill="${C.text}">${r.mean === null ? '—' : r.mean.toFixed(2) + ' s'}</text><text x="${x1 + 12}" y="${y + 13}" font-size="11.5" fill="${C.text2}">stint ${r.stintClean}/${r.trials} · ${r.stintMean === null ? '—' : r.stintMean.toFixed(2) + ' s'}</text>`;
  });
  svg += `<text x="24" y="${H - 8}" font-size="11.5" fill="${C.text2}">★ = policy selected on separate validation seeds. “stint a/b · t” = stints with all laps clean, and mean pace of laps 2–${bench.stintLaps}.</text>`;
  fs.writeFileSync(`docs/benchmark-${carId}.svg`, svg + '</svg>');
}
function CAR(b) { return { gt3: 'Arrow GT3-R', hatch: 'Vanta RS', coupe: 'Brawler GT 5.0', formula: 'FX-10', ev: 'Volt-R Quad' }[b.carId] || b.carId; }
console.log('wrote docs/learning-curve-' + carId + '.svg, docs/benchmark-' + carId + '.svg');
