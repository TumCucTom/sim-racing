// Trackside model: surfaces beside the road, kerb types, gravel drag, barriers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack, TRACK_ORDER, TRACKS, surfaceXAt, surfaceAt, trackEdge, SX, SX_CLASS, SX_MU, SX_ROLL, SURF, BAR } from '../src/sim/track.js';
import { CARS } from '../src/sim/cars.js';
import { Sim } from '../src/sim/sim.js';

const count = (t, fn) => { let c = 0; for (let i = 0; i < t.n; i++) if (fn(i)) c++; return c; };

test('Ravenscar keeps its original on-track, kerb and verge surfaces', () => {
  const t = buildTrack('ravenscar');
  // the legacy rule, re-stated: kerbs both sides where the track turns, then at least 2 m of grass
  for (let i = 0; i < t.n; i += 3) for (const d of [0, 3, -6.4, 6.6, -7.9, 8.1, -9.4, 9.9]) {
    const ad = Math.abs(d), h = t.hw[i], sx = surfaceXAt(t, i, d);
    if (ad <= h) assert.equal(sx, SX.ASPHALT);
    else if (t.kerb[i] && ad <= h + t.kerbWidth) assert.equal(sx, SX.KERB);
    else if (ad <= h + (t.kerb[i] ? t.kerbWidth : 0) + 2.0) assert.equal(sx, SX.GRASS, `sample ${i} d ${d}`);   // 2 m of grass verge everywhere
    assert.equal(surfaceAt(t, i, d), SX_CLASS[sx]);
  }
  for (let i = 0; i < t.n; i++) { assert.equal(t.kerbL[i], t.kerbR[i]); assert.equal(t.edgeL[i], t.edgeR[i]); assert.equal(trackEdge(t, i), t.hw[i] + (t.kerb[i] ? t.kerbWidth : 0)); }
  assert.deepEqual([SX_MU[0], SX_MU[1], SX_MU[2], SX_ROLL[0], SX_ROLL[1], SX_ROLL[2]], [1.0, 0.93, 0.45, 0.013, 0.016, 0.07]);
});

test('every circuit: bands are ordered and inside the barriers', () => {
  for (const id of TRACK_ORDER) {
    const t = buildTrack(id);
    for (const sd of ['L', 'R']) for (let i = 0; i < t.n; i++) {
      const wall = t['wall' + sd][i], e = t['edge' + sd][i];
      assert.ok(wall >= t.hw[i] + 1.4, `${id} ${sd} wall at ${i}`);
      if (t['gB' + sd][i] > 0) { assert.ok(t['gA' + sd][i] >= e, `${id} gravel starts on the road at ${i}`); assert.ok(t['gB' + sd][i] <= wall, `${id} gravel beyond the barrier at ${i}`); assert.ok(t['gB' + sd][i] - t['gA' + sd][i] > 1); }
      if (t['ro' + sd][i]) assert.ok(t['roA' + sd][i] >= e - 1e-9, `${id} run-off starts on the road at ${i}`);
      assert.ok(t['bar' + sd][i] <= BAR.TECPRO);
    }
    assert.ok(count(t, i => t.kerbL[i] || t.kerbR[i]) > 50, `${id} has kerbs`);
  }
});

test('circuit data: the expected kinds of trackside are present and sourced', () => {
  const has = (id, sx) => { const t = buildTrack(id); let c = 0; for (let i = 0; i < t.n; i += 2) for (const sg of [1, -1]) { const w = sg > 0 ? t.wallL[i] : t.wallR[i]; for (let d = t.hw[i] + 0.2; d < w; d += 0.7) if (surfaceXAt(t, i, sg * d) === sx) { c++; break; } } return c; };
  for (const id of ['silverstone', 'spa', 'monza', 'laguna', 'ravenscar']) { assert.ok(has(id, SX.GRAVEL) > 200, `${id} gravel`); }
  for (const id of ['silverstone', 'spa', 'monza', 'ravenscar']) assert.ok(has(id, SX.RUNOFF) > 100, `${id} paved run-off`);
  assert.ok(has('nordschleife', SX.GRAVEL) > 50);
  assert.equal(has('monaco', SX.GRAVEL), 0, 'no gravel in Monaco');
  assert.ok(has('monaco', SX.RUNOFF) > 30, 'Monaco escape roads');
  for (const id of ['spa', 'monza', 'monaco']) assert.ok(has(id, SX.SAUSAGE) > 10, `${id} sausage kerbs`);
  assert.ok(has('silverstone', SX.ASTRO) > 50);
  // hand-authored entries say so; OSM surveys record their georeference
  for (const id of TRACK_ORDER) for (const c of TRACKS[id].trackside.corners) assert.ok(['memory', 'designed'].includes(c.src), `${id} ${c.n}`);
  for (const id of ['silverstone', 'spa', 'monza']) { const g = TRACKS[id].trackside.osm.georef; assert.ok(g.residual < 3 && g.matched > 0.9, `${id} georeference`); }
});

test('gravel drags a car down far harder than grass, and harder still deep in the bed', () => {
  const t = buildTrack('monza');
  // deceleration (m/s^2) over the first 0.8 s coasting at 45 m/s with all four wheels at about offset d
  const decel = (i, d) => { const sim = new Sim(t, CARS.gt3); sim.reset({ s: i * t.ds, d, speed: 45 }); for (let k = 0; k < 240; k++) sim.step({ steer: 0, throttle: 0, brake: 0 }); return { a: (45 - sim.car.speed) / 0.8, surf: [...sim.car.surfX] }; };
  let gi = -1; for (let i = 0; i < t.n && gi < 0; i++) { let ok = true; for (let q = 0; q < 60; q++) { const j = (i + q) % t.n; if (!(t.gBL[j] - t.gAL[j] > 14) || Math.abs(t.curv[j]) > 0.006) { ok = false; break; } } if (ok) gi = i; }
  assert.ok(gi >= 0, 'a wide gravel bed exists');
  const shallow = decel(gi, t.gAL[gi] + 2.2), deep = decel(gi, t.gAL[gi] + 9);
  assert.ok(deep.surf.every(v => v === SX.GRAVEL), `in the gravel: ${deep.surf}`);
  let wi = -1; for (let i = 0; i < t.n && wi < 0; i++) { let ok = true; for (let q = 0; q < 60; q++) { const j = (i + q) % t.n; if (t.gBR[j] > 0 || t.roR[j] || t.apronR[j] || t.wallR[j] - t.hw[j] < 6 || Math.abs(t.curv[j]) > 0.002) { ok = false; break; } } if (ok) wi = i; }
  assert.ok(wi >= 0);
  const grass = decel(wi, -(t.hw[wi] + 3.2));
  assert.ok(grass.surf.every(v => v === SX.GRASS), `on the grass: ${grass.surf}`);
  assert.ok(deep.a > 6 && deep.a > 2.2 * grass.a, `gravel ${deep.a.toFixed(1)} vs grass ${grass.a.toFixed(1)} m/s^2`);
  assert.ok(deep.a > shallow.a + 0.2, `deep ${deep.a.toFixed(2)} vs shallow ${shallow.a.toFixed(2)}`);
});

test('kerb types: rumble signal, sausage kerbs slow the car and are off track', () => {
  const t = buildTrack('monza');
  let si = -1, sd = 0; for (let i = 0; i < t.n && si < 0; i++) { if (t.apronL[i] === SX.SAUSAGE) { si = i; sd = 1; } else if (t.apronR[i] === SX.SAUSAGE) { si = i; sd = -1; } }
  assert.ok(si >= 0);
  const e = sd > 0 ? t.edgeL[si] : t.edgeR[si];
  assert.equal(surfaceXAt(t, si, sd * (e + 0.3)), SX.SAUSAGE);
  assert.equal(surfaceAt(t, si, sd * (e + 0.3)), SURF.KERB);
  assert.ok(SX_MU[SX.SAUSAGE] < SX_MU[SX.KERB] && SX_ROLL[SX.SAUSAGE] > 5 * SX_ROLL[SX.KERB]);
  const sim = new Sim(t, CARS.gt3); sim.reset({ s: 300, d: 0, speed: 40 });
  for (let k = 0; k < 60; k++) sim.step({ steer: 0, throttle: 0.3, brake: 0 });
  assert.equal(sim.car.rumble, 0, 'no rumble on the road');
  // put the left wheels on a kerb
  let ki = -1; for (let i = 0; i < t.n && ki < 0; i++) if (t.kerbL[i] && t.kerbL[(i + 30) % t.n]) ki = i;
  sim.reset({ s: ki * t.ds, d: t.hw[ki] + 0.6 - CARS.gt3.trackF / 2, speed: 40 });
  sim.step({ steer: 0, throttle: 0.3, brake: 0 });
  assert.ok(sim.car.rumble > 0.1, `rumble ${sim.car.rumble}`);
  assert.equal(sim.car.wheelsOff(), 0, 'kerbs count as track');
});

test('Suzuka crossover: the bridge clears the lower road and the two never get confused', async () => {
  const { project } = await import('../src/sim/track.js');
  const t = buildTrack('suzuka');
  const gap2 = (i) => (t.x[i] - t.x[t.under[i]]) ** 2 + (t.y[i] - t.y[t.under[i]]) ** 2;
  let up = -1; for (let i = 0; i < t.n; i++) if (t.deck[i] && (up < 0 || gap2(i) < gap2(up))) up = i;
  const low = t.under[up];
  assert.ok(Math.hypot(t.x[up] - t.x[low], t.y[up] - t.y[low]) < 6, 'the roads cross in plan');
  assert.ok(t.z[up] - t.z[low] > 6, `clearance ${(t.z[up] - t.z[low]).toFixed(1)} m`);
  for (let i = 0; i < t.n; i++) assert.ok(Math.abs(t.grade[i]) < 0.12, `gradient at ${i}`);
  // a car driven along the lower road through the crossing stays on the lower road's samples and touches nothing
  for (const [start, name] of [[low, 'lower'], [up, 'upper']]) {
    const sim = new Sim(t, CARS.gt3); sim.reset({ s: (start - 70) * t.ds, d: 0, speed: 22 });
    for (let k = 0; k < 300 * 6; k++) {
      const c = sim.car, he = c.headErr; sim.step({ steer: Math.max(-1, Math.min(1, -0.25 * c.d - 2.5 * he)), throttle: c.vx < 22 ? 0.3 : 0, brake: 0 });
      let gap = Math.abs(c.idx - start); gap = Math.min(gap, t.n - gap);
      assert.ok(gap < 400, `${name} road: car jumped to sample ${c.idx}`);
      assert.ok(c.wallContact <= 0, `${name} road: hit a wall at ${c.idx}`);
    }
    assert.ok(sim.progress > 110, `${name} road: drove through (${sim.progress.toFixed(0)} m)`);
  }
  const out = {}; project(t, t.x[low], t.y[low], low, out); assert.ok(Math.abs(out.idx - low) <= 1);
  project(t, t.x[up], t.y[up], up, out); assert.ok(Math.abs(out.idx - up) <= 1);
});
