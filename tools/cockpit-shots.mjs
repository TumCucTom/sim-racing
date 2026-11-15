// In-car camera check: one headless browser, every car, several views each.
//   node tools/cockpit-shots.mjs <outDir> [cars|all] [views] [query]
//   views: comma list of  straight | left | right | bonnet | chase   (default: straight,left,right,bonnet)
//   query: extra URL parameters (default: q=medium&track=spa&wx=clear)
// "left" / "right" fast-forward the AI to the next corner in that direction and freeze the sim there.
// Prints the steering numbers per shot: car.steer (+ = left), road-wheel angle, steering-wheel angle shown.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [outDir = 'shots', carsArg = 'all', viewsArg = 'straight,left,right,bonnet', query = 'q=medium&track=spa&wx=clear'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: +(process.env.W || 1280), height: +(process.env.H || 720) }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', e => errs.push('[pageerror] ' + e.message));
await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?autostart&ai&${query}`);
await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
const cars = carsArg === 'all' ? await p.evaluate(async () => (await import('/src/sim/cars.js')).CAR_ORDER) : carsArg.split(',');
for (const id of cars) {
  await p.evaluate((id) => { const g = window.__game; g.setCar(id); g.restart(); g.setAutopilot(true); g.acc = -1e9; }, id);
  await p.waitForFunction(() => window.__game.model.glb, null, { timeout: 20000 }).catch(() => {});
  let first = true;
  for (const view of viewsArg.split(',')) {
    const st = await p.evaluate(async ({ view, first }) => {
      const g = window.__game, car = g.sim.car, cams = ['chase', 'far', 'bonnet', 'cockpit', 'tv'];
      g.acc = 0;
      if (first) g.fastForward(7);
      if (view === 'left' || view === 'right') { const sg = view === 'left' ? 1 : -1; for (let i = 0; i < 1500 && !(car.steer * g.spec.steerLock * sg > 0.06 && car.speed > 12); i++) g.fastForward(0.1); g.fastForward(0.25); }
      else if (view === 'straight') { for (let i = 0; i < 600 && Math.abs(car.steer) > 0.02; i++) g.fastForward(0.1); }
      g.cam = cams.indexOf(view === 'bonnet' || view === 'chase' ? view : 'cockpit'); g.camInit = false;
      g.acc = -1e9;      // freeze the simulation, keep rendering
      return null;
    }, { view, first });
    first = false;
    const t0 = Date.now(); await p.evaluate(() => new Promise((res) => { let n = 0; const f = () => (++n >= 7 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
    const info = await p.evaluate(async () => {
      const g = window.__game, car = g.sim.car, d = (await import('/src/game/cockpit.js')).inCar.debug();
      return { car: g.spec.id, glb: !!g.model.glb, kmh: +(car.speed * 3.6).toFixed(0), steer: +car.steer.toFixed(3), roadWheelDeg: +(car.steer * g.spec.steerLock * 57.3).toFixed(1), wheelDeg: d ? +(d.wheelAngle * 57.3).toFixed(1) : null, rawWheelDeg: d ? +(d.rawWheelAngle * 57.3).toFixed(1) : null, yawRate: +car.r.toFixed(3), kit: d?.meshes ?? 0, calls: g.perf.calls, tris: g.perf.tris };
    });
    await p.screenshot({ path: `${outDir}/${id}_${view}.png`, timeout: 300000 });
    console.log(view.padEnd(9), JSON.stringify(info), `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
if (errs.length) console.log([...new Set(errs)].slice(0, 20).join('\n')); else console.log('no console errors or warnings');
await b.close();
