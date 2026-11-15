// Headless browser check of race mode: screenshots at scripted moments + state + console errors.
//   node tools/race-shot.mjs <outDir> [query] [step ...]
// A step is "<seconds to fast-forward>:<camera>:<car to follow>:<name>", e.g. "20:tv:battle:fight".
// Defaults film the grid under the lights, the first corner, a mid-race battle and the timing tower.
// Needs a dev server (PORT, default 5173).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [outDir = 'docs/shots', query = 'race=12&laps=3&ai&q=medium&track=spa', ...stepsIn] = process.argv.slice(2);
const steps = stepsIn.length ? stepsIn : ['3:heli:p3:grid', '9:heli:p4:turn1', '5:chase:battle:lap1', '70:chase:battle:battle', '0:tv:battle:tv', '25:far:leader:tower'];
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', e => errs.push('[pageerror] ' + e.message));
await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?${query}`, { timeout: 240000, waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game && window.__game.race, null, { timeout: 240000 });
await p.waitForTimeout(2500);
for (const st of steps) {
  const [secs, cam, who, name] = st.split(':');
  const info = await p.evaluate(([s, c, w]) => { const g = window.__game; if (+s > 0) g.fastForward(+s); if (w) g.followCar(isNaN(+w) ? w : +w); if (c) g.setCamera(c); return g.raceInfo(); }, [secs, cam, who]);
  await p.waitForTimeout(3500);          // let the models, the camera and the HUD settle (software GL is slow)
  const perf = await p.evaluate(() => { const g = window.__game, q = g.perf; return { fps: +q.fps.toFixed(1), simMs: +q.simMs.toFixed(3), frameMs: +q.frameMs.toFixed(2), calls: q.calls, tris: q.tris, audio: g.audio.mode }; });
  await p.screenshot({ path: `${outDir}/race-${name}.png`, timeout: 300000 });
  const f = info.order.find(r => r.index === info.focus) || info.order[0];
  console.log(`${name}: t=${info.time}s lights=${info.lights} green=${info.green} following ${f.name} P${f.pos} lap ${f.lap} ${f.speed} km/h  leader ${info.order[0].name}  overtakes ${info.overtakes} contacts ${info.contacts}  ${JSON.stringify(perf)}`);
}
console.log(errs.length ? errs.slice(0, 15).join('\n') : 'no console errors or warnings');
await b.close();
