// One contact sheet per car: six showroom angles (front 3/4, side, rear 3/4, rear, front, top).
//   PORT=5230 node tools/car-angles.mjs <outDir> <car,car,...> [quality] [wx]
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [outDir, cars = 'huracan,huracan610,svj', q = 'medium', wx = 'clear'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const W = 640, H = 380;
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('[pageerror] ' + e.message));
await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?q=${q}&wx=${wx}&track=ravenscar`, { timeout: 300000 });
await p.waitForFunction(() => window.__game && !document.getElementById('loading'), null, { timeout: 300000 });
await p.evaluate(() => { document.getElementById('menu').style.display = 'none'; document.getElementById('ui').style.display = 'none'; });
const views = [['f34', 0.6, 1.3, 5.6], ['side', 1.571, 0.9, 6.0], ['r34', 2.6, 1.4, 5.6], ['rear', 3.1416, 0.9, 5.4], ['front', 0, 0.8, 5.4], ['top', 1.2, 4.5, 4.0]];
for (const id of cars.split(',')) {
  const shots = [];
  for (const [name, ang, hgt, dist] of views) {
    await p.evaluate(([id, ang, hgt, dist]) => {
      const g = window.__game; if (g.spec.id !== id) g.setCar(id);
      g.updateCamera = () => { const r = g.model.root, pos = r.position, c = g.camera, a = ang - r.rotation.y; c.position.set(pos.x + Math.cos(a) * dist, pos.y + hgt, pos.z - Math.sin(a) * dist); c.lookAt(pos.x, pos.y + 0.55, pos.z); c.fov = 36; c.updateProjectionMatrix(); };
    }, [id, ang, hgt, dist]);
    await p.waitForTimeout(name === 'f34' ? 6000 : 2500);
    shots.push((await p.screenshot({ timeout: 300000 })).toString('base64'));
  }
  const s = await b.newPage({ viewport: { width: W * 3, height: H * 2 } });
  await s.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(3,${W}px)">${shots.map(x => `<img src="data:image/png;base64,${x}">`).join('')}</body>`);
  await s.screenshot({ path: `${outDir}/${id}-${q}-${wx}.png` }); await s.close();
  console.log('done', id);
}
await b.close();
