// Renders each car in the paused "showroom" orbit view into one contact sheet per car.
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const outDir = process.argv[2]; const cars = (process.argv[3] || 'gt3,hatch,coupe,formula,ev').split(',');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('[pageerror] ' + e.message));
await p.goto(`http://127.0.0.1:5173/?q=medium`);
await p.waitForFunction(() => window.__game, null, { timeout: 60000 });
await p.evaluate(() => { document.getElementById('menu').style.display = 'none'; document.getElementById('ui').style.display = 'none'; });
for (const id of cars) for (const [name, ang, hgt, dist] of [['a', 0.7, 1.5, 6.2], ['b', 3.6, 1.0, 5.6]]) {
  await p.evaluate(([id, ang, hgt, dist]) => {
    const g = window.__game; if (g.spec.id !== id) g.setCar(id);
    g.updateCamera = () => { const pos = g.model.root.position, c = g.camera; c.position.set(pos.x + Math.cos(ang) * dist, pos.y + hgt, pos.z + Math.sin(ang) * dist); c.lookAt(pos.x, pos.y + 0.55, pos.z); c.fov = 40; c.updateProjectionMatrix(); };
  }, [id, ang, hgt, dist]);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${outDir}/car_${id}_${name}.png`, timeout: 120000 });
}
await b.close();
