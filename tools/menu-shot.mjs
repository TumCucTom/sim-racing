// Screenshots of the pre-race menu at desktop and phone-landscape sizes.
//   PORT=5230 node tools/menu-shot.mjs <outDir> [query]
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const [outDir, query = 'q=medium'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errs = [];
for (const [name, w, h, touch, mode] of [['1280x720', 1280, 720, false, 'hot'], ['1920x1080', 1920, 1080, false, 'race'], ['844x390-touch', 844, 390, true, 'race'], ['844x390-touch-hot', 844, 390, true, 'hot']]) {
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) continue;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') errs.push(`[${name}] ${m.text()}`); });
  p.on('pageerror', e => errs.push(`[${name}] pageerror ${e.message}`));
  await p.goto(`http://127.0.0.1:${process.env.PORT || 5173}/?${query}`, { timeout: 180000 });
  await p.waitForFunction(() => window.__game && !document.getElementById('loading'), null, { timeout: 300000 });
  await p.waitForTimeout(1500); await p.waitForFunction(() => window.__game?.menu, null, { timeout: 300000 });
  await p.evaluate((m) => window.__game.menu.setMode(m), mode);
  await p.waitForTimeout(+process.env.WAIT || 9000);
  await p.screenshot({ path: `${outDir}/menu-${name}.png`, timeout: 300000 });
  if (name === '1280x720') {
    // keyboard: down = next car, right = next class, Controls panel, Enter = drive
    await p.waitForFunction(() => window.__game?.menu, null, { timeout: 300000 });
    const r = await p.evaluate(async () => {
      const g = window.__game, key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })), out = { car0: g.spec.id };
      key('ArrowDown'); out.down = g.spec.id; key('ArrowRight'); out.right = g.spec.id;
      document.getElementById('m-help').click(); out.help = getComputedStyle(document.getElementById('keys')).display;
      return out;
    });
    await p.waitForTimeout(3000);
    await p.screenshot({ path: `${outDir}/menu-${name}-controls.png`, timeout: 300000 });
    r.afterEnter = await p.evaluate(async () => { const g = window.__game; window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })); const helpClosed = !document.getElementById('menu').classList.contains('help'); window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); await new Promise(r => setTimeout(r, 300)); return { helpClosed, paused: g.paused, menuHidden: document.getElementById('menu').classList.contains('hidden') }; });
    console.log(JSON.stringify(r));
  }
  await ctx.close();
}
if (errs.length) console.log(errs.slice(0, 12).join('\n'));
await b.close();
