import test from 'node:test';
import assert from 'node:assert/strict';
import { renderThunder, thunderPeak } from '../src/audio/thunder.js';
import { analyse } from '../tools/thunder-analyse.mjs';

test('thunder: near strike is a sharp crack then a long, darkening rumble', () => {
  const th = renderThunder({ sampleRate: 24000, km: 0.3, seed: 11 }), a = analyse(th);
  assert.ok(a.peak <= 0.91 && a.peak > 0.85, `peak ${a.peak}`);
  assert.ok(a.peakAt < 0.3, `the crack is the loudest part (peak at ${a.peakAt} s)`);
  assert.ok(a.riseMs <= 10, `rise ${a.riseMs} ms`);
  assert.ok(a.crackDb > 6, `crack ${a.crackDb} dB over the rumble`);
  assert.ok(a.durS >= 5 && a.durS <= 18, `duration ${a.durS} s`);
  const c = a.centroidHz; assert.ok(c[0] > 2000 && c[c.length - 1] < 250, `centroid ${c}`);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] < c[i - 1] * 1.15, `centroid falls: ${c}`);
  assert.ok(a.lowShare[a.lowShare.length - 1] > 0.6, 'the late rumble is mostly 20-200 Hz');
  for (const v of th.left) assert.ok(Number.isFinite(v));
});

test('thunder: far strike is only a soft low rumble; deterministic per seed', () => {
  const far = renderThunder({ sampleRate: 12000, km: 4, seed: 3 }), a = analyse(far);
  assert.ok(Math.abs(a.peak - thunderPeak(4)) < 0.01 && a.peak < 0.25);
  assert.ok(a.centroidHz[0] < 300 && a.lowShare[0] > 0.7, `far strike is dull: ${a.centroidHz} ${a.lowShare}`);
  assert.ok(a.durS >= 5);
  const again = renderThunder({ sampleRate: 12000, km: 4, seed: 3 });
  assert.deepEqual(Array.from(again.left.subarray(5000, 5050)), Array.from(far.left.subarray(5000, 5050)));
  const dbl = renderThunder({ sampleRate: 12000, km: 1, seed: 21, double: true });
  assert.ok(analyse(dbl).peak <= thunderPeak(1) + 0.01);
});
