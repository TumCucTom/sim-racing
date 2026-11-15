// Headless smoke test / screenshot helper.
//   node tools/shot.mjs <out.png> [query] [seconds] [keys...]
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [out, query = 'autostart&ai&q=medium', secs = '6', ...keys] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', e => errs.push('[pageerror] ' + e.message));
await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?${query}`);
await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
await p.waitForTimeout(1500);
await p.evaluate((s) => window.__game.fastForward(s), +secs);
await p.waitForTimeout(2500);
for (const k of keys) { await p.keyboard.press(k); await p.waitForTimeout(1500); }
const st = await p.evaluate(() => { const g = window.__game, c = g.sim.car; return { speed: +(c.speed * 3.6).toFixed(1), s: +c.s.toFixed(0), simTime: +g.sim.time.toFixed(2), lap: g.sim.lap, fps: +g.perf.fps.toFixed(1), simMs: +g.perf.simMs.toFixed(3), calls: g.perf.calls, tris: g.perf.tris, audio: g.audio.mode, audioState: g.audio.ctx?.state, ai: g.ai.label, aiLap: g.aiLap }; });
await p.screenshot({ path: out, timeout: 120000 });
console.log(JSON.stringify(st)); if (errs.length) console.log(errs.slice(0, 12).join('\n'));
await b.close();
