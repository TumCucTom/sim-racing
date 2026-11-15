#!/usr/bin/env node
// Verifies the SHIPPED audio path in a real browser (needs the Vite dev server
// or a preview of the build):
//
//   node tools/audio-page-check.mjs [--url http://127.0.0.1:5173/] [car ...]
//
// For each car it loads the game, waits for the worklet and the sample bank,
// pins the engine at each reference rpm / load (AudioEngine.hold), records what
// actually leaves the master bus (after reverb + compressor) and scores it
// with the same metrics as tools/audio-compare.mjs. Then it lets the AI drive
// for a while and reports level, clipping and console errors, and finally
// reloads with the bank request blocked to prove the synthesis fallback.
import { createRequire } from 'node:module';
import { SR, loadRef, score, mean } from './audio-compare.mjs';
import { audioConfigFor } from '../src/audio/synth.js';
import { CARS } from '../src/sim/cars.js';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const argv = process.argv.slice(2); let url = 'http://127.0.0.1:5173/';
const ui = argv.indexOf('--url'); if (ui >= 0) { url = argv[ui + 1]; argv.splice(ui, 2); }
const cars = argv.length ? argv : Object.keys(CARS);

const TAP = `(() => { const a = window.__game.audio, c = a.ctx; const sp = c.createScriptProcessor(4096, 2, 1); const z = c.createGain(); z.gain.value = 0;
  window.__tap = { chunks: [], on: false, sr: c.sampleRate, sp, z };
  sp.onaudioprocess = (e) => { if (!window.__tap.on) return; const l = e.inputBuffer.getChannelData(0), r = e.inputBuffer.getChannelData(1), m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) / 2; window.__tap.chunks.push(m); };
  a.out.connect(sp); sp.connect(z); z.connect(c.destination); })()`;
const GRAB = `(() => { const t = window.__tap; t.on = false; let n = 0; for (const c of t.chunks) n += c.length; const o = new Float32Array(n); let p = 0; for (const c of t.chunks) { o.set(c, p); p += c.length; } t.chunks = [];
  const b = new Uint8Array(o.buffer); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); })()`;
const decode = (b64, sr) => { const b = Buffer.from(b64, 'base64'); const x = new Float32Array(b.buffer, b.byteOffset, b.length >> 2); if (sr === SR) return x; const n = Math.floor(x.length * SR / sr), y = new Float32Array(n); for (let i = 0; i < n; i++) { const q = i * sr / SR, k = q | 0; y[i] = x[k] + (q - k) * ((x[k + 1] || 0) - x[k]); } return y; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function open(browser, id, block) {
  const page = await browser.newPage(); const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !(block && /Failed to load resource/.test(m.text()))) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  if (block) await page.route('**/audio/*.wav', r => r.abort());
  await page.goto(`${url}?autostart&ai&q=low&car=${id}`);
  await page.waitForFunction(() => window.__game && window.__game.audio && window.__game.audio.ctx && window.__game.audio.ctx.state === 'running' && window.__game.audio.mode !== 'off', null, { timeout: 120000 });
  return { page, errors };
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const f1 = (v) => Number.isFinite(v) ? v.toFixed(1) : '-';
for (const id of cars) {
  if (!CARS[id]) continue;
  const cfg = audioConfigFor(CARS[id]), ref = loadRef(cfg.bankName || id);
  const { page, errors } = await open(browser, id, false);
  if (cfg.bankName) await page.waitForFunction(() => window.__game.audio.voice === 'samples', null, { timeout: 90000 }).catch(() => {});
  const st = await page.evaluate(() => ({ mode: window.__game.audio.mode, voice: window.__game.audio.voice, sr: window.__game.audio.ctx.sampleRate }));
  await page.evaluate(TAP);
  let line = `${id.padEnd(9)} mode=${st.mode} voice=${st.voice} sr=${st.sr}`;
  if (ref) {
    const quiet = { speed: 0, squeal: 0, scrub: 0, grass: 0, gravel: 0, kerb: 0, brake: 0, boost: 0, wheelRps: 0, cockpit: 0, tv: 0, master: 0.8 };
    const caps = new Map();
    for (const b of ref.bands) {
      const on = b.state === 'on', rpm = b.rpm / (ref.rpmScale || 1);
      await page.evaluate(([h]) => { window.__game.audio.hold = h; }, [Object.assign({ rpm, throttle: on ? 1 : 0, load: on ? 1 : -0.12, motor: on ? 1 : 0 }, quiet)]);
      await sleep(350);
      await page.evaluate(() => { window.__tap.on = true; });
      await sleep(900);
      caps.set(b, decode(await page.evaluate(GRAB), st.sr));
    }
    await page.evaluate(() => { window.__game.audio.hold = null; });
    const rows2 = []; for (const b of ref.bands) rows2.push(...score({ ...ref, bands: [b] }, () => caps.get(b)));
    const on = r => r.state === 'on', off = r => r.state === 'off';
    line += ` | in-page LSD on ${f1(mean(rows2, 'lsd', on))} dB, off ${f1(mean(rows2, 'lsd', off))} dB, ORD on ${f1(mean(rows2, 'ord', on))} dB (${rows2.length} bands)`;
  } else line += ' | no reference recording (synthesis only)';
  // free driving: level and clipping of the real mix
  await page.evaluate(() => { window.__tap.on = true; });
  await sleep(8000);
  const x = decode(await page.evaluate(GRAB), st.sr);
  let pk = 0, e = 0, clip = 0; for (const v of x) { const a = Math.abs(v); if (a > pk) pk = a; if (a >= 0.999) clip++; e += v * v; }
  line += ` | drive 8 s: rms ${(20 * Math.log10(Math.sqrt(e / x.length) + 1e-9)).toFixed(1)} dBFS peak ${pk.toFixed(2)} clipped ${clip} | errors ${errors.length}`;
  console.log(line); for (const er of errors.slice(0, 3)) console.log('   ', er);
  await page.close();
  if (cfg.bankName) {
    const fb = await open(browser, id, true); await sleep(2500);
    await fb.page.evaluate(TAP); await fb.page.evaluate(() => { window.__tap.on = true; }); await sleep(5000);
    const y = decode(await fb.page.evaluate(GRAB), st.sr); let e2 = 0; for (const v of y) e2 += v * v;
    const v2 = await fb.page.evaluate(() => window.__game.audio.voice);
    console.log(`          bank blocked -> voice=${v2}, rms ${(20 * Math.log10(Math.sqrt(e2 / Math.max(1, y.length)) + 1e-9)).toFixed(1)} dBFS, errors ${fb.errors.length}`);
    await fb.page.close();
  }
}
await browser.close();
