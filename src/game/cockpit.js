// Driver's-eye and bonnet camera anchors measured from the car's actual geometry (so the
// camera never sits inside bodywork), plus a steering wheel with gloves for the cockpit view.
// Model space: +X forward, +Y up, +Z right; origin at the CG's ground projection.
import * as THREE from 'three';

const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), tmp = new THREE.Vector3();

// Height of the car's top surface above the model origin at model-space (x, z); 0 if nothing there.
function topAt(model, x, z) {
  tmp.set(x, 4, z); model.root.localToWorld(tmp);
  ray.set(tmp, down); ray.far = 5;
  const y0 = model.root.position.y;
  for (const h of ray.intersectObject(model.chassis, true)) {
    if (h.object.userData.cockpitOnly || h.object === model.shadow || !h.object.visible) continue;
    const y = h.point.y - y0; if (y > 0.2) return y;
  }
  return 0;
}

export function viewAnchors(model, spec) {
  const b = spec.body, a = spec.wheelbase * (1 - spec.frontWeight), open = b.style === 'formula';
  model.root.updateMatrixWorld(true);
  const xs = [], top = []; let H = 0;
  for (let x = -b.length * 0.5; x <= b.length * 0.6; x += 0.06) { const t = topAt(model, x, 0); xs.push(x); top.push(t); if (x > -spec.wheelbase * 0.5 && x < a) H = Math.max(H, t); }
  if (H < 0.4) H = b.height;
  // front edge of the roof (or of the roll hoop / airbox on open cars)
  let iRoof = -1; for (let i = xs.length - 1; i >= 0; i--) if (xs[i] < a && top[i] >= 0.9 * H) { iRoof = i; break; }
  const roofX = iRoof >= 0 ? xs[iRoof] : 0.1;
  // base of the windscreen: first point ahead of the roof where the surface has dropped to bonnet level
  let iBase = xs.length - 1; for (let i = Math.max(iRoof, 0); i < xs.length; i++) if (top[i] > 0 && top[i] <= 0.72 * H) { iBase = i; break; }
  const bx = Math.min(xs[iBase] + 0.02, a + 0.2);
  const bTop = Math.max(topAt(model, bx, 0), topAt(model, bx - 0.15, 0), topAt(model, bx + 0.25, 0));
  const bonnet = open ? new THREE.Vector3(0.05, Math.max(0.78, topAt(model, 0.05, 0) + 0.1), 0)
    : new THREE.Vector3(bx, (bTop || 0.7 * H) + 0.2, 0);
  const side = open || spec.id === 'hypercar' || spec.id === 'lmp1' ? (open ? 0 : -0.18) : -Math.min(0.37, b.width * 0.2);
  const eye = open ? new THREE.Vector3(Math.min(roofX + 0.75, 0.35), 0.72, 0)
    : new THREE.Vector3(roofX - 0.38, Math.max(0.62, H - 0.2), side);
  return { bonnet, eye, H, open };
}

// Steering wheel (rim, spokes, hub, rev lights, two gloves). Group origin = wheel centre;
// rotate `spin.rotation.z` to steer. The wheel faces the driver (its axis is model -X, tilted).
export function buildSteeringWheel(spec) {
  const g = new THREE.Group(), spin = new THREE.Group(); g.add(spin);
  const race = /gt3|formula|hypercar|lmp1/.test(spec.id) || spec.abs === false || /GT3/i.test(spec.klass || '');
  const R = race ? 0.14 : 0.18;
  const grip = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 }), metal = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.45, metalness: 0.7 });
  const glove = new THREE.MeshStandardMaterial({ color: race ? 0x1b1d22 : 0xc9a183, roughness: 0.8 }), sleeve = new THREE.MeshStandardMaterial({ color: race ? 0xb8141c : 0x2b3440, roughness: 0.9 });
  const add = (geo, mat, x, y, z, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.z = rz; m.userData.cockpitOnly = true; spin.add(m); return m; };
  if (race) { // flat-bottomed "butterfly" wheel: two grips, a plate, buttons
    for (const s of [-1, 1]) add(new THREE.CapsuleGeometry(0.019, 0.11, 6, 12), grip, s * R, 0.0, 0);
    add(new THREE.BoxGeometry(2 * R - 0.02, 0.1, 0.014), metal, 0, 0.0, -0.004);
    add(new THREE.BoxGeometry(0.12, 0.05, 0.016), new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.3, emissive: 0x16324a, emissiveIntensity: 0.9 }), 0, 0.012, 0.004);
    const cols = [0xff3b30, 0xffcc00, 0x34c759, 0x0a84ff, 0xffffff, 0xff9500];
    cols.forEach((c, i) => add(new THREE.CylinderGeometry(0.008, 0.008, 0.008, 10), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, emissive: c, emissiveIntensity: 0.25 }), (i < 3 ? -1 : 1) * (0.05 + (i % 3) * 0.022), -0.032, 0.008).rotation.x = Math.PI / 2);
  } else {
    add(new THREE.TorusGeometry(R, 0.016, 10, 40), grip, 0, 0, 0);
    for (const ang of [0, Math.PI, -Math.PI / 2]) { const m = add(new THREE.BoxGeometry(R - 0.02, 0.028, 0.012), metal, Math.cos(ang) * R * 0.5, Math.sin(ang) * R * 0.5, -0.004, ang); m.scale.x = 1; }
    add(new THREE.CylinderGeometry(0.05, 0.055, 0.03, 20), grip, 0, 0, 0).rotation.x = Math.PI / 2;
  }
  for (const s of [-1, 1]) { // hands at quarter-to-three, forearms running back towards the driver
    const hand = add(new THREE.SphereGeometry(0.036, 12, 10), glove, s * R, 0.005, 0.012); hand.scale.set(0.8, 1.15, 0.9);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, 0.3, 4, 10), sleeve); arm.userData.cockpitOnly = true;
    arm.position.set(s * (R + 0.035), -0.07, 0.19); arm.rotation.x = Math.PI / 2 - 0.35; arm.rotation.z = -s * 0.16; spin.add(arm);
  }
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.3, 10), metal); col.rotation.x = Math.PI / 2; col.position.z = -0.16; col.userData.cockpitOnly = true; g.add(col);
  g.rotation.y = Math.PI / 2;        // wheel plane faces the driver: local +Z -> model -X... (rim in local XY, axis along model X)
  const tilt = new THREE.Group(); tilt.add(g); tilt.rotation.z = race ? 0.12 : 0.36;   // rake of the column
  tilt.traverse(o => { if (o.isMesh) { o.castShadow = false; } });
  return { group: tilt, spin, lock: race ? 2.2 : 3.6 };   // lock: wheel radians at full steering input
}
