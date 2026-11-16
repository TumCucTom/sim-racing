// Frame-exact capture of the real game for video: the page's clock is driven by hand, so
// every frame advances the simulation by exactly 1/fps regardless of how slowly it renders.
//   node tools/film.mjs <outDir> <shots.json> [shotName ...]
// shots.json: [{ name, url, ff, follow, cam, secs, hud, cuts:[{at, cam, follow}], pre }]
//   url    query string (race or solo), ff = seconds to fast-forward before filming
//   cuts   camera / target changes at `at` seconds into the shot
//   hud    true keeps the HUD; default hides everything but the 3D view
// Needs a static build served on PORT (default 8400). Writes <outDir>/<name>/f00001.jpg ...
// and <name>/audio.json (the parameter stream sent to the audio worklet, one entry per frame).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [outDir, shotsFile, ...only] = process.argv.slice(2);
const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8')).filter(s => !only.length || only.includes(s.name));
const FPS = +(process.env.FPS || 30), W = +(process.env.W || 1280), H = +(process.env.H || 720), PORT = process.env.PORT || 8400;
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
for (const s of shots) {
  const dir = `${outDir}/${s.name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.clock.install();
  await p.goto(`http://127.0.0.1:${PORT}/?${s.url}`);
  await p.waitForFunction(() => window.__game && !document.getElementById('loading')?.offsetParent, null, { timeout: 180000 });
  await p.waitForTimeout(4000);                       // models, textures, audio banks
  await p.evaluate(({ s }) => {
    const g = window.__game;
    if (!s.hud) for (const id of ['ui', 'touch', 'menu']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
    if (!s.hud) document.querySelectorAll('body > div').forEach(e => { if (e.id !== 'loading') e.style.visibility = 'hidden'; });
    g.paused = true;
    const t = g.race ? g.race.time : g.sim.time;
    if (s.ff > t) g.fastForward(s.ff - t);
    if (s.follow !== undefined && g.followCar) g.followCar(s.follow);
    if (s.cam) (g.setCamera ? g.setCamera(s.cam) : null);
    if (s.pre) (0, eval)(s.pre);
    // log what the audio engine tells the synth, per frame (replayed offline by tools/film-audio.mjs)
    window.__alog = []; const a = g.audio;
    if (a && a._send) { if (a.cfg) window.__alog.push([-1, { cfg: a.cfg }]); const send = a._send.bind(a); a._send = (m, tr) => { if (m && !m.pcm && !m.bank) window.__alog.push([window.__frame | 0, m]); return send(m, tr); }; }
  }, { s });
  await p.clock.pauseAt(await p.evaluate(() => Date.now() + 8000));   // the page is slow: leave a wide margin (game is paused meanwhile)
  await p.evaluate(() => { const g = window.__game; g.paused = false; g.last = performance.now(); });
  for (let i = 0; i < 12; i++) await p.clock.runFor(1000 / FPS);   // settle camera, LOD, exposure
  const grab = async (file) => { const url = await p.evaluate(() => { const g = window.__game; if (g.composer) g.composer.render(); else g.renderer.render(g.scene, g.camera); return g.renderer.domElement.toDataURL('image/jpeg', 0.94); }); fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')); };
  // scouting: single frames at several times / cameras from one page load (times must increase)
  for (const [k, st] of (s.stills || []).entries()) {
    await p.evaluate((st) => { const g = window.__game; g.paused = true; const t = g.race ? g.race.time : g.sim.time; if (st.ff > t) g.fastForward(st.ff - t); if (st.follow !== undefined && g.followCar) g.followCar(st.follow); if (st.cam) g.setCamera(st.cam); if (st.js) (0, eval)(st.js); g.paused = false; g.last = performance.now(); }, st);
    for (let i = 0; i < 8; i++) await p.clock.runFor(1000 / FPS);
    await grab(`${dir}/s${String(k).padStart(2, '0')}_${st.ff}_${st.cam || ''}_${st.follow ?? ''}.jpg`); console.log(s.name, 'still', k, new Date().toISOString().slice(11, 19));
  }
  const N = Math.round((s.secs || 0) * FPS), t0 = Date.now();
  for (let f = 0; f < N; f++) {
    for (const c of s.cuts || []) if (Math.round(c.at * FPS) === f) await p.evaluate((c) => { const g = window.__game; if (c.follow !== undefined) g.followCar(c.follow); if (c.cam) g.setCamera(c.cam); if (c.js) (0, eval)(c.js); }, c);
    await p.evaluate((f) => { window.__frame = f; }, f);
    await p.clock.runFor(1000 / FPS);
    await grab(`${dir}/f${String(f + 1).padStart(5, '0')}.jpg`);
    if (f % 30 === 0) console.log(s.name, f, '/', N, ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
  fs.writeFileSync(`${dir}/audio.json`, JSON.stringify(await p.evaluate(() => window.__alog)));
  const info = await p.evaluate(() => { const g = window.__game; return { t: g.race ? g.race.time : g.sim.time, speed: g.sim.car.speed * 3.6 }; });
  console.log(s.name, 'done', JSON.stringify(info), errs.length ? 'ERRORS ' + errs.slice(0, 3).join(' | ') : 'no errors');
  await p.close();
}
await b.close();
