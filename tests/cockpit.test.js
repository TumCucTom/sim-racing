// Seating fit for the in-car cameras (src/game/cockpit-fit.js): pure geometry on a height map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCabin, cockpitClass } from '../src/game/cockpit-fit.js';
import { CARS, CAR_ORDER } from '../src/sim/cars.js';

// a plain three-box saloon: 0.9 m shoulders, roof at 1.35 m from x = -1.2 to 0.4, screen down to the bonnet at x = 1.1
function saloon({ roof = 1.35, open = false } = {}) {
  const x0 = -3, zh = 1.2, cell = 0.025, nx = 252, nz = 96, T = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = x0 + (i + 0.5) * cell, z = Math.abs(-zh + (j + 0.5) * cell);
    if (x < -2 || x > 2.3 || z > 0.9) continue;
    let y = x > 1.1 ? 0.9 - (x - 1.1) * 0.12 : 0.9;
    let top = x < -1.6 ? 0 : x < -1.2 ? 0.9 + (x + 1.6) / 0.4 * (roof - 0.9) : x <= 0.4 ? roof : x <= 1.1 ? roof - (x - 0.4) / 0.7 * (roof - 0.9) : 0;
    if (open && x < 0.3) top = 0;                       // roadster: only the screen frame stands
    const half = 0.78 - 0.18 * Math.max(0, (top - 0.9) / (roof - 0.9));     // tumblehome
    if (top > 0.9 && z <= half + 0.18 * (1 - 0)) { const edge = 0.78 - 0.18 * 1; y = z <= edge ? top : Math.max(0.9, top - (z - edge) / 0.18 * (top - 0.9)); }
    T[i * nz + j] = y;
  }
  return { x0, zh, cell, nx, nz, T };
}
const road = { id: 'test', klass: 'Road car', wheelbase: 2.7, frontWeight: 0.55, steerLock: 0.55, body: { style: 'sedan', length: 4.3, width: 1.8, height: 1.35 }, engine: {} };

test('driver sits on the left, under the roof, behind the screen', () => {
  const f = fitCabin(saloon(), road), [ex, ey, ez] = f.eye;
  assert.equal(f.klass, 'road');
  assert.ok(Math.abs(f.header.x - 0.4) < 0.12, `header ${f.header.x}`);
  assert.ok(Math.abs(f.cowl.x - 1.1) < 0.12, `cowl ${f.cowl.x}`);
  assert.ok(ez < -0.25 && ez > -0.5, `left seat, ${ez}`);
  assert.ok(ex < f.header.x - 0.2 && ex > -1.0, `eye x ${ex}`);
  assert.ok(ey > f.cowl.y + 0.1 && ey < 1.35 - 0.12, `eye y ${ey}`);
  assert.equal(f.openTop, false);
  // the eye is inside the cabin hull that gets clipped out of the exterior model; the bonnet camera is not
  assert.equal(f.planes.length, 5);
  for (const p of f.planes) assert.ok(p[0] * ex + p[1] * ey + p[2] * ez + p[3] < -0.05);
  const [bx, by] = f.bonnet;
  assert.ok(f.planes.some(p => p[0] * bx + p[1] * by + p[3] > 0), 'bonnet camera outside the hull');
  assert.ok(by > 0.9 + 0.1 && Math.abs(bx - f.cowl.x) < 0.2);
});

test('overrides: right-hand drive, eye nudge', () => {
  const f = fitCabin(saloon(), { ...road, cockpit: { side: 1, eye: [0, 0.05, 0] } }), g = fitCabin(saloon(), road);
  assert.ok(f.eye[2] > 0.25);
  assert.ok(Math.abs(f.eye[1] - g.eye[1] - 0.05) < 1e-9);
});

test('an open-top car is recognised and still gets a seat', () => {
  const f = fitCabin(saloon({ open: true }), road);
  assert.equal(f.openTop, true);
  assert.ok(f.eye[1] > f.cowl.y + 0.1 && f.eye[1] < 1.5 && f.eye[2] < -0.25);
});

test('every car in the game has a cockpit class with a full set of ergonomics', () => {
  for (const id of CAR_ORDER) {
    const k = cockpitClass(CARS[id]);
    assert.ok(['road', 'gt', 'proto', 'formula'].includes(k), `${id}: ${k}`);
  }
  assert.equal(cockpitClass(CARS.formula), 'formula');
  assert.equal(cockpitClass(CARS.gt3), 'gt');
  assert.equal(cockpitClass(CARS.hypercar), 'proto');
  assert.equal(cockpitClass(CARS.mini), 'road');
  for (const id of CAR_ORDER) if (/supercar/i.test(CARS[id].klass)) assert.equal(cockpitClass(CARS[id]), 'road', id);
});
