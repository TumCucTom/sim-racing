// Driving-line guide: a thin ribbon on the racing line, coloured by what the
// reference driver does there (green = accelerating, amber = coasting / at the
// limit, red = braking). Rebuilt per car because braking points differ.
import * as THREE from 'three';
import { speedProfile, lineDriverOptions } from '../sim/drivers/baseline.js';

export function buildLineGuide(track, spec) {
  const L = track.line, n = track.n, opts = lineDriverOptions(track, spec);
  const v = speedProfile(track, spec, opts);
  const pos = [], col = [], idx = [], w = 0.22;
  for (let k = 0; k <= n; k += 2) {
    const i = k % n, j = (i + 2) % n, h = L.heading[i], nx = -Math.sin(h), ny = Math.cos(h);
    const dv = v[j] - v[i];
    const c = dv < -0.25 ? [0.95, 0.12, 0.1] : dv < 0.02 && v[i] < 105 ? [1.0, 0.72, 0.1] : [0.15, 0.85, 0.3];
    pos.push(L.x[i] + nx * w, track.z[i] + 0.035, -(L.y[i] + ny * w), L.x[i] - nx * w, track.z[i] + 0.035, -(L.y[i] - ny * w));
    col.push(...c, ...c);
    if (k > 0) { const b = pos.length / 3 - 4; idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, toneMapped: false }));
  m.renderOrder = 1; m.frustumCulled = false;
  return m;
}
