// Where are the overtakes? Runs a whole all-AI race in the headless browser (no rendering, fast-forward)
// and lists every on-track pass with its time, lap, place and the cars involved, for filming:
//   node tools/race-moments.mjs "race=12&laps=5&track=monza&car=gt3&field=class&aiskill=0.96&seed=2&grid=quali&ai&wx=clear" [...]
// A race is deterministic for a given URL *in a given JavaScript engine*: Node and Chromium differ in the last
// bit of some Math functions, so the same seed gives a different race in tools/race-sim.js. Film from this list.
// Times are seconds after the lights go out (raceInfo().time); `ff` is what to pass to __game.fastForward()
// straight after loading to arrive 6 s before the pass. Needs a dev or preview server (PORT, default 5173).
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
for (const query of process.argv.slice(2)) {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?${query}&q=low`, { timeout: 300000, waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__game && window.__game.race, null, { timeout: 300000 });
  const t0 = await p.evaluate(() => { const g = window.__game; g.paused = true; return { time: g.race.time, green: g.race.greenTime }; });
  let r;
  do { r = await p.evaluate(() => { const g = window.__game, R = g.race; g.fastForward(30); return { over: R.over, time: R.time }; }); } while (!r.over && r.time < 3000);
  const out = await p.evaluate(() => { const R = window.__game.race, nm = (i) => `${R.cars[i].name} (#${R.cars[i].number}, index ${i}, ${R.cars[i].spec.id})`;
    return { hash: R.hash(), green: R.greenTime, cls: R.classification().map(c => `${c.pos}.${c.name}[g${c.grid}]`).join(' '), heavy: R.events.filter(e => e.dv >= 6).length, contacts: R.events.length,
      log: R.overtakeLog.map(e => ({ t: e.t, lap: e.lap + 1, s: Math.round(e.s), clean: e.clean, by: nm(e.by), on: nm(e.on), byIdx: e.by })) }; });
  console.log(`\n?${query}\n  lights out ${out.green.toFixed(2)} s after load (+ the ${t0.time.toFixed(2)} s that ran before this tool paused the page); hash ${out.hash}; contacts ${out.contacts} (${out.heavy} heavy)\n  result: ${out.cls}`);
  for (const e of out.log) console.log(`  t=${e.t.toFixed(1)}s lap ${e.lap} s=${e.s} m ${e.clean ? 'CLEAN' : 'untidy'}: ${e.by} passes ${e.on}   ff=${(e.t + out.green - 6).toFixed(1)} followCar(${e.byIdx})`);
  await b.close();
}
