// Top-down height map of a car body, in the chassis frame (+X forward, +Y up, +Z right, metres):
// every triangle of the visible body is rasterised once into a 2.5 cm grid that keeps the highest
// surface per cell. The cabin measurements in cockpit-fit.js read everything from this map, so
// placing the driver costs one pass over the model instead of hundreds of raycasts.
import * as THREE from 'three';

export const SCAN = { x0: -3.0, x1: 3.3, zh: 1.2, cell: 0.025 };

export function scanBody(model) {
  const { x0, x1, zh, cell } = SCAN, nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil(2 * zh / cell), inv = 1 / cell;
  const T = new Float32Array(nx * nz);
  model.root.updateMatrixWorld(true);
  const Mi = model.chassis.matrixWorld.clone().invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
  const put = (x, y, z) => { const i = Math.floor((x - x0) * inv), j = Math.floor((z + zh) * inv); if (i >= 0 && i < nx && j >= 0 && j < nz && y > T[i * nz + j]) T[i * nz + j] = y; };
  model.chassis.traverse((o) => {
    if (!o.isMesh || o === model.shadow || !o.geometry?.attributes.position) return;
    for (let p = o; p && p !== model.root; p = p.parent) if (!p.visible) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = pos.count, P = new Float32Array(n * 3);
    m.multiplyMatrices(Mi, o.matrixWorld);
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; put(v.x, v.y, v.z); }
    const nt = (idx ? idx.count : n) / 3;
    for (let t = 0; t < nt; t++) {
      const ia = (idx ? idx.getX(t * 3) : t * 3) * 3, ib = (idx ? idx.getX(t * 3 + 1) : t * 3 + 1) * 3, ic = (idx ? idx.getX(t * 3 + 2) : t * 3 + 2) * 3;
      const ax = P[ia], ay = P[ia + 1], az = P[ia + 2], bx = P[ib], by = P[ib + 1], bz = P[ib + 2], cx = P[ic], cy = P[ic + 1], cz = P[ic + 2];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) * inv)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) * inv));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) + zh) * inv)), j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) + zh) * inv));
      if (i1 <= i0 && j1 <= j0) continue;                      // inside one cell: the vertices already did it
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(den) < 1e-10) continue;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * cell;
        for (let j = j0; j <= j1; j++) {
          const z = -zh + (j + 0.5) * cell;
          const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den, w = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den, q = 1 - u - w;
          if (u < -1e-4 || w < -1e-4 || q < -1e-4) continue;
          const y = u * ay + w * by + q * cy; if (y > T[i * nz + j]) T[i * nz + j] = y;
        }
      }
    }
  });
  // cars are symmetric; wipers, aerials and one-sided details are not
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz >> 1; j++) { const a = i * nz + j, b = i * nz + nz - 1 - j, y = Math.max(T[a], T[b]); T[a] = T[b] = y; }
  return { x0, zh, cell, nx, nz, T };
}
