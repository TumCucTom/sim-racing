// Measures physics throughput (Node) and render statistics (headless Chromium,
// software GL) and writes docs/performance.json. Needs `npm run dev` running.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { buildTrack } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';
import { BaselineDriver } from '../src/sim/drivers/baseline.js';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');

const track = buildTrack(), sim = new Sim(track, CARS.gt3), drv = new BaselineDriver(track, CARS.gt3, { grip: 0.9 });
for (let i = 0; i < 30000; i++) sim.step(drv.control(sim.car)); // warm up the JIT
const N = 600000, t0 = performance.now();
for (let i = 0; i < N; i++) sim.step(drv.control(sim.car));
const sps = N / ((performance.now() - t0) / 1000);

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const render = [], errors = [];
for (const [quality, tr] of [['low', 'ravenscar'], ['medium', 'ravenscar'], ['medium', 'spa']]) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`http://127.0.0.1:5173/?autostart&ai&q=${quality}&track=${tr}`);
  await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
  await p.evaluate(() => window.__game.fastForward(12));
  await p.waitForTimeout(6000);
  const s = await p.evaluate(() => { const g = window.__game.perf; return { fps: +g.fps.toFixed(1), calls: g.calls, tris: g.tris, frameMs: +g.frameMs.toFixed(2), simMs: +g.simMs.toFixed(3) }; });
  render.push({ quality, track: tr, ...s });
  await p.close();
}
await b.close();
const js = fs.readdirSync('dist/assets').filter(f => f.endsWith('.js')).map(f => fs.readFileSync('dist/assets/' + f));
const bytes = js.reduce((a, x) => a + x.length, 0), gz = js.reduce((a, x) => a + zlib.gzipSync(x).length, 0);
const summ = fs.readdirSync('rl/runs').filter(d => fs.existsSync(`rl/runs/${d}/summary.json`)).map(d => JSON.parse(fs.readFileSync(`rl/runs/${d}/summary.json`)));
const out = { simStepsPerSec: Math.round(sps), realtimeFactor: Math.round(sps / 300), simMsPerFrame: +(5 / sps * 1000).toFixed(3),
  trainSps: Math.round(summ.reduce((a, s) => a + s.steps / s.wallSeconds, 0) / summ.length), trainMinutes: +(summ.reduce((a, s) => a + s.wallSeconds, 0) / summ.length / 60).toFixed(1),
  bundleKb: Math.round(bytes / 1024), gzipKb: Math.round(gz / 1024), render, tests: process.env.TESTS || '', browserErrors: errors };
fs.writeFileSync('docs/performance.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
