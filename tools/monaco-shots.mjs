// Several screenshots of one circuit from one page load (software GL is slow to start).
//   PORT=5210 node tools/monaco-shots.mjs <out dir> <query> <name:station:view>...
// view: chase | tv | cockpit (the game's own cameras, car parked at the station)
//       low | high | side:L | side:R | top | over (free debug cameras, as tools/trackside-shot.mjs)
//       at:x,y,z:lx,ly,lz (free camera in sim coordinates: x east, y north, z up; looking at lx,ly,lz)
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [dir, query = 'track=monaco&car=gt3&q=medium', ...shots] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: +(process.env.W || 1280), height: +(process.env.H || 720) }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', e => errs.push('[pageerror] ' + e.message));
const t0 = Date.now();
await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?autostart&${query}`, { timeout: 240000, waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game && window.__game.sim, null, { timeout: 240000 });
await p.waitForTimeout(3000);
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await p.evaluate(() => { const g = window.__game; g.__uc = g.updateCamera; });
for (const sh of shots) {
  const [name, station, ...vw] = sh.split(':'), view = vw.join(':');
  const info = await p.evaluate(([s, view]) => {
    const g = window.__game, t = g.sim.track, n = t.n;
    g.sim.reset({ s: +s, d: 0, speed: 0 });
    const at = (ds, d, up) => { const i = ((Math.round((+s + ds) / t.ds) % n) + n) % n, h = t.heading[i]; return [t.x[i] - Math.sin(h) * d, t.z[i] + up, -(t.y[i] + Math.cos(h) * d)]; };
    const i0 = Math.round(+s / t.ds) % n;
    let pos, look; g.camera.up.set(0, 1, 0);
    const game = { chase: 0, cockpit: 3, tv: 4 }[view];
    if (game !== undefined) { delete g.updateCamera; g.cam = game; g.camInit = false; return { i: i0, game: view }; }
    g.camera.fov = 62; g.camera.updateProjectionMatrix();
    if (view === 'top') { pos = at(0, 0, 150); look = at(0.5, 0, 0); }
    else if (view === 'over') { pos = [1150, 520, 650]; look = [300, 0, -60]; }
    else if (view === 'high') { pos = at(-30, 0, 12); look = at(25, 0, 0); }
    else if (view.startsWith('side')) { const sg = view.endsWith('R') ? -1 : 1, w = sg > 0 ? t.wallL[i0] : t.wallR[i0]; pos = at(-12, sg * (w + 6), 7); look = at(18, 0, 0); }
    else if (view.startsWith('at')) { const [, a, c] = view.split(':'), P = a.split(',').map(Number), Q = c.split(',').map(Number); pos = [P[0], P[2], -P[1]]; look = [Q[0], Q[2], -Q[1]]; }
    else if (view === 'drv') { pos = at(0, 0, 1.15); look = at(40, 0, 1.0); }
    else { pos = at(-18, 0, 2.2); look = at(30, 0, 0.5); }
    g.updateCamera = () => { g.camera.position.set(...pos); if (view === 'top') g.camera.up.set(Math.cos(t.heading[i0]), 0, -Math.sin(t.heading[i0])); g.camera.lookAt(...look); };
    return { i: i0 };
  }, [station, view]);
  await p.waitForTimeout(info.game ? 6000 : 4000);
  try { await p.screenshot({ path: `${dir}/${name}.png`, timeout: 150000 }); } catch (e) { console.log(name, 'SCREENSHOT FAILED'); continue; }
  const st = await p.evaluate(() => { const g = window.__game; return { calls: g.perf.calls, tris: g.perf.tris, fps: +g.perf.fps.toFixed(1) }; });
  console.log(name, JSON.stringify(info), JSON.stringify(st));
}
if (errs.length) console.log([...new Set(errs)].slice(0, 12).join('\n'));
await b.close();
