// Loose trackside objects (cones, braking-distance boards) simulated with
// cannon-es rigid bodies. The car is a kinematic body in that world, so it
// knocks props around without the props influencing the deterministic sim.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { labelTexture } from './textures.js';

export class Props {
  constructor(scene, track, world3d) {
    this.track = track; this.items = [];
    const w = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
    w.allowSleep = true; w.broadphase = new CANNON.SAPBroadphase(w);
    w.defaultContactMaterial.friction = 0.6; w.defaultContactMaterial.restitution = 0.15;
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0); w.addBody(ground);
    this.carBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, shape: new CANNON.Box(new CANNON.Vec3(2.2, 0.45, 0.95)) });
    this.carBody.position.set(0, -50, 0); w.addBody(this.carBody);

    const coneGeo = new THREE.Group();
    const orange = new THREE.MeshStandardMaterial({ color: 0xff5a0a, roughness: 0.6 }), white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
    const mkCone = () => {
      const g = new THREE.Group();
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.66, 12), orange); c.position.y = 0.02; g.add(c);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.118, 0.14, 12), white); band.position.y = 0.04; g.add(band);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.4), orange); base.position.y = -0.31; g.add(base);
      g.traverse(o => { if (o.isMesh) o.castShadow = true; });
      return g;
    };
    const add = (mesh, body, baseY) => { scene.add(mesh); w.addBody(body); body.allowSleep = true; body.sleepSpeedLimit = 0.25; body.sleepTimeLimit = 0.6; this.items.push({ mesh, body, baseY, home: body.position.clone(), homeQ: body.quaternion.clone() }); body.sleep(); };

    // cones: pit-exit line on the main straight and inside a few apexes
    const t = track;
    const coneAt = (i, off) => {
      const h = t.heading[i], x = t.x[i] - Math.sin(h) * off, y = t.y[i] + Math.cos(h) * off;
      const body = new CANNON.Body({ mass: 1.4, shape: new CANNON.Cylinder(0.06, 0.2, 0.66, 8), linearDamping: 0.15, angularDamping: 0.25 });
      body.position.set(x, 0.33, -y);
      add(mkCone(), body, t.z[i]);
    };
    for (let k = 0; k < 9; k++) coneAt(120 + k * 14, -(t.hw[120 + k * 14] + 0.9));
    for (let i = 0; i < t.n; i++) {
      const k = Math.abs(t.curv[i]), kn = Math.abs(t.curv[(i + 1) % t.n]), kp = Math.abs(t.curv[(i - 1 + t.n) % t.n]);
      if (k > 0.012 && k >= kn && k > kp) { const side = t.curv[i] > 0 ? 1 : -1; for (const d of [-8, 0, 8]) coneAt((i + d + t.n) % t.n, side * (t.hw[i] + t.kerbWidth + 0.7)); }
    }
    // braking boards
    for (const m of world3d.brakeMarkers) {
      const g = new THREE.Group();
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 1.1), [null, null, null, null, null, null].map((_, f) => new THREE.MeshStandardMaterial(f < 2 ? { map: labelTexture(String(m.dist), { w: 256, h: 192, bg: '#f4f4f4', fg: '#111', font: 'bold 130px sans-serif' }), roughness: 0.7 } : { color: 0xdddddd })));
      board.position.y = 0.25; g.add(board);
      for (const s of [-0.4, 0.4]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.05), white); leg.position.set(0, -0.38, s); g.add(leg); }
      g.traverse(o => { if (o.isMesh) o.castShadow = true; });
      const body = new CANNON.Body({ mass: 5, shape: new CANNON.Box(new CANNON.Vec3(0.05, 0.63, 0.55)), linearDamping: 0.1, angularDamping: 0.2 });
      body.position.set(m.x, 0.63, -m.y); body.quaternion.setFromEuler(0, m.heading, 0);
      add(g, body, m.z);
    }
    for (const it of this.items) { it.home = it.body.position.clone(); it.homeQ = it.body.quaternion.clone(); }
    this.sync();
  }
  reset() { for (const it of this.items) { it.body.position.copy(it.home); it.body.quaternion.copy(it.homeQ); it.body.velocity.setZero(); it.body.angularVelocity.setZero(); it.body.sleep(); } this.sync(); }
  update(dt, car, spec) {
    const b = this.carBody, cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    b.shapes[0].halfExtents.set(spec.body.length / 2, 0.45, spec.body.width / 2); b.shapes[0].updateConvexPolyhedronRepresentation();
    b.position.set(car.x, 0.5, -car.y);
    b.quaternion.setFromEuler(0, car.yaw, 0);
    b.velocity.set(car.vx * cy - car.vy * sy, 0, -(car.vx * sy + car.vy * cy));
    b.angularVelocity.set(0, car.r, 0);
    // only step while something near the car could be moving
    let active = false;
    for (const it of this.items) {
      if (it.body.sleepState !== CANNON.Body.SLEEPING) { active = true; break; }
      const dx = it.body.position.x - car.x, dz = it.body.position.z + car.y;
      if (dx * dx + dz * dz < 36) { it.body.wakeUp(); active = true; }
    }
    if (active) { this.world.step(1 / 120, Math.min(dt, 0.05), 6); this.sync(); }
  }
  sync() { for (const it of this.items) { it.mesh.position.set(it.body.position.x, it.body.position.y + it.baseY, it.body.position.z); it.mesh.quaternion.copy(it.body.quaternion); } }
}
