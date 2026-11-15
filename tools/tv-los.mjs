// Is the trackside TV camera's view of the car clear? Drives one AI lap per circuit in a headless
// browser, samples every 0.25 s and casts a ray from the camera to the car against the built world:
//   before = the old rule (nearest of the blindly placed posts), after = src/game/tvcam.js.
//   node tools/tv-los.mjs [track ...]        needs a dev server (PORT, default 5173); optional SHOTS=dir
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const tracks = process.argv.slice(2).length ? process.argv.slice(2) : ['ravenscar', 'silverstone', 'spa', 'monza', 'nordschleife', 'monaco', 'laguna'];
const q = process.env.Q || 'medium', shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const out = {};
for (const tr of tracks) {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?track=${tr}&car=gt3&autostart&ai&q=${q}`, { timeout: 300000, waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__game && window.__game.setCamera, null, { timeout: 300000 });
  await p.evaluate(() => { window.__game.setCamera('tv'); });
  await p.waitForFunction(() => window.__game.tv, null, { timeout: 300000 });
  await p.evaluate(() => { const g = window.__game; g.paused = true; g.fastForward(4); window.__los = { n: 0, before: 0, after: 0, heli: 0, sw: 0, minD: 1e9, done: false, blocked: [] }; });
  let r, guard = 0;
  do {
    r = await p.evaluate(() => {
      const g = window.__game, L = window.__los, tv = g.tv, lap0 = L.lap0 ?? (L.lap0 = g.sim.lap);
      for (let k = 0; k < 40 && !L.done; k++) {
        g.fastForward(0.25); g.syncVisuals(0);
        const pos = g.model.root.position, car = g.sim.car;
        let best = g.tvPosts[0], bd = Infinity; for (const q of g.tvPosts) { const d = q.distanceToSquared(pos); if (d < bd) { bd = d; best = q; } }
        if (tv.visible(best, pos)) L.before++;
        const sw = tv.stats.switches; tv.update(0.25, pos, car, g.camera);
        const ok = tv.visible(g.camera.position, pos); if (ok) L.after++; else L.blocked.push(Math.round(car.s));
        if (tv.heli) L.heli++; L.sw += tv.stats.switches - sw; L.minD = Math.min(L.minD, g.camera.position.distanceTo(pos)); L.n++;
        if (g.sim.lap >= lap0 + 2 || L.n >= 2400) L.done = true;
      }
      return { ...L, posts: tv.posts.filter(x => x).length, noPost: tv.posts.filter(x => x === null).length, stations: tv.nSt, occ: tv.occ.length };
    });
  } while (!r.done && guard++ < 200);
  out[tr] = { samples: r.n, beforePct: +(100 * r.before / r.n).toFixed(1), afterPct: +(100 * r.after / r.n).toFixed(1), heliPct: +(100 * r.heli / r.n).toFixed(1), cuts: r.sw, minDistance: +r.minD.toFixed(1), stations: r.stations, validPosts: r.posts, rejected: r.noPost, occluders: r.occ, blockedAt: r.blocked.slice(0, 12) };
  console.log(tr, JSON.stringify(out[tr]), errs.length ? 'ERRORS ' + errs.slice(0, 3).join(' | ') : '');
  if (shots) { await p.evaluate(() => { window.__game.paused = false; }); await p.waitForTimeout(6000); await p.screenshot({ path: `${shots}/tv-${tr}.png`, timeout: 300000 }); }
  await b.close();
}
fs.mkdirSync('docs', { recursive: true }); fs.writeFileSync('docs/tv-camera.json', JSON.stringify(out, null, 1));
