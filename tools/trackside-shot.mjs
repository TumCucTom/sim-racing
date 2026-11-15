// Trackside screenshots with a free debug camera (no game code involved: the page's camera
// update is overridden from the outside).
//   PORT=5173 node tools/trackside-shot.mjs <out.png> <track> <station m> [view] [extra query]
// view: 'low'  (default) driver-height look down the road from 18 m back
//       'high' 12 m up, 30 m back      'top' straight down from 150 m      'side:<L|R>' from outside the corner
// The car is parked at the station so the picture shows scale.
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [out, track = 'ravenscar', station = '0', view = 'low', extra = ''] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', e => errs.push('[pageerror] ' + e.message));
await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?autostart&track=${track}&car=gt3&q=medium${extra ? '&' + extra : ''}`);
await p.waitForFunction(() => window.__game && window.__game.sim, null, { timeout: 120000 });
await p.waitForTimeout(2500);
const info = await p.evaluate(([s, view]) => {
  const g = window.__game, t = g.sim.track, n = t.n;
  g.sim.reset({ s: +s, d: 0, speed: 0 });
  const at = (ds, d, up) => { const i = ((Math.round((+s + ds) / t.ds) % n) + n) % n, h = t.heading[i]; return [t.x[i] - Math.sin(h) * d, t.z[i] + up, -(t.y[i] + Math.cos(h) * d)]; };
  const i0 = Math.round(+s / t.ds) % n;
  let pos, look;
  if (view === 'top') { pos = at(0, 0, 150); look = at(0.5, 0, 0); }
  else if (view === 'high') { pos = at(-30, 0, 12); look = at(25, 0, 0); }
  else if (view.startsWith('side')) { const sg = view.endsWith('R') ? -1 : 1, w = sg > 0 ? t.wallL[i0] : t.wallR[i0]; pos = at(-12, sg * (w + 6), 7); look = at(18, 0, 0); }
  else { pos = at(-18, 0, 2.2); look = at(30, 0, 0.5); }
  g.updateCamera = () => { g.camera.position.set(...pos); if (view === 'top') g.camera.up.set(Math.cos(t.heading[i0]), 0, -Math.sin(t.heading[i0])); g.camera.lookAt(...look); };
  return { i: i0, wallL: t.wallL[i0], wallR: t.wallR[i0] };
}, [station, view]);
await p.waitForTimeout(view === 'top' ? 9000 : 7000);
await p.screenshot({ path: out, timeout: 180000 });
console.log(out, JSON.stringify(info)); if (errs.length) console.log(errs.slice(0, 8).join('\n'));
await b.close();
