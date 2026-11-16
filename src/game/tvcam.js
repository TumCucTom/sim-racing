// Trackside TV camera that can actually see the car.
//
// The old camera took the nearest of a row of posts placed blindly beside the track, so it
// could sit inside a building, behind a grandstand, in the trees or below a rise. This one
//   * proposes several positions per station (outside of the corner, further back and
//     higher, the inside, a tall mast) and takes the first that stands clear of all world
//     geometry (nothing within 2.5 m, a known surface below it) and sees the road there;
//   * at run time checks the line of sight four times a second by casting rays against the
//     world: to the car and to where it will be in half a second. A post that is about to
//     lose the car is left for the best one that sees it now, will still see it then and
//     preferably in two seconds as well (so the picture does not flicker between posts); if
//     no post sees the car, a helicopter-style camera above it takes over;
//   * keeps a minimum distance to the car and clamps the zoom.
// Occluders are read from whatever meshes the built world contains (no names needed), so it
// keeps working when the scenery changes. Posts are validated lazily, one station at a time.
import * as THREE from 'three';

const STATION = 110;                 // metres of track between camera stations
const CHECK = 0.25;                  // seconds between line-of-sight checks
const CLEAR = 2.5;                   // free space required around a camera
const A = new THREE.Vector3(), B = new THREE.Vector3(), D = new THREE.Vector3(), BOX = new THREE.Box3();
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0.7, 0, 0.7], [-0.7, 0, 0.7], [0.7, 0, -0.7], [-0.7, 0, -0.7]].map(a => new THREE.Vector3(...a).normalize());

export class TvCam {
  constructor(track, world) {
    this.track = track; this.world = world;
    this.ray = new THREE.Raycaster(); this.hits = [];
    this.nSt = Math.max(4, Math.round(track.length / STATION));
    this.posts = new Array(this.nSt).fill(undefined);      // undefined = not validated yet, null = no usable position
    this.cur = null; this.curSt = -1; this.hidden = 0; this.t = CHECK; this.heli = false; this.high = false; this.occT = -1; this.occ = [];
    this.pos = new THREE.Vector3(); this.heliPos = new THREE.Vector3(); this.init = false; this.soon = new THREE.Vector3(); this.later = new THREE.Vector3();
    this.stats = { checks: 0, seen: 0, heli: 0, switches: 0 };
    this.refreshOccluders();
  }

  // every solid mesh of the world: not the sky, not invisible, not see-through (catch fences)
  refreshOccluders() {
    const occ = [];
    this.world.group.updateMatrixWorld(true);
    this.world.group.traverse(o => {
      if (!o.isMesh || !o.visible || o.userData.isSky) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!m || m.visible === false) return;
      if (m.transparent && !(m.alphaTest > 0.2)) return;       // blended, see-through
      const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
      let box;
      if (o.isInstancedMesh) { if (!o.boundingBox) o.computeBoundingBox(); box = o.boundingBox.clone().applyMatrix4(o.matrixWorld); }
      else box = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
      const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y, sz = box.max.z - box.min.z;
      if (sx > 7000 || sz > 7000) { if (sy < 1 || sy > 7000) return; }       // sky dome, sea plane
      for (let p = o.parent; p; p = p.parent) if (!p.visible) return;
      occ.push({ o, box });
    });
    this.occ = occ;
  }

  // first hit along from -> to (distance), or Infinity. `skip` metres at the far end are ignored.
  cast(from, to, skip = 0) {
    D.subVectors(to, from); const len = D.length() - skip; if (len <= 0.05) return Infinity;
    D.normalize();
    const r = this.ray; r.ray.origin.copy(from); r.ray.direction.copy(D); r.near = 0.02; r.far = len;
    let best = Infinity;
    for (const { o, box } of this.occ) {
      if (!r.ray.intersectBox(box, A) && !box.containsPoint(from)) continue;
      if (!box.containsPoint(from) && A.distanceTo(from) > len) continue;
      this.hits.length = 0; o.raycast(r, this.hits);
      for (const h of this.hits) if (h.distance < best) best = h.distance;
    }
    return best;
  }
  // can a camera at `from` see a car at `carPos`? (aims at the roof line; the last 3 m do not count)
  visible(from, carPos) { B.copy(carPos); B.y += 0.9; return this.cast(from, B, 3) === Infinity; }

  trackPoint(i, up, out) { const t = this.track, k = ((i % t.n) + t.n) % t.n; return out.set(t.x[k], t.z[k] + up, -t.y[k]); }

  // find a camera position for station st; null if every candidate is buried or blind
  validate(st) {
    const t = this.track, i = Math.round(st * t.n / this.nSt) % t.n, h = t.heading[i];
    const out = t.curv[i] > 0 ? -1 : 1;                       // outside of the corner (+ = left of the track)
    const wall = (s) => (s > 0 ? t.wallL[i] : t.wallR[i]);
    const cands = [[out, 4, 6.5], [out, 9, 9], [-out, 4, 6.5], [out, 2.5, 12], [-out, 9, 10], [out, 16, 14], [out, 1.5, 20]];
    const P = new THREE.Vector3(), Q = new THREE.Vector3(), T = new THREE.Vector3();
    for (const [side, back, up] of cands) {
      const off = side * (wall(side) + back);
      P.set(t.x[i] - Math.sin(h) * off, t.z[i] + up, -(t.y[i] + Math.cos(h) * off));
      // what is underneath? (a roof, a bank, a grandstand: stand on top of it, within reason)
      Q.set(P.x, t.z[i] + 60, P.z); T.set(P.x, t.z[i] - 30, P.z);
      const d = this.cast(Q, T);
      if (d !== Infinity) { const top = Q.y - d; if (top > P.y - 3.5) P.y = top + 3.5; }
      if (P.y > t.z[i] + 30) continue;
      // free space all round, and nothing just in front of the lens
      let ok = true;
      for (const a of AXES) { T.copy(P).addScaledVector(a, CLEAR); if (this.cast(P, T) !== Infinity) { ok = false; break; } }
      if (!ok) continue;
      // must see the road at its own station and a little either side of it
      let seen = 0;
      for (const ds of [-45, 0, 45]) { this.trackPoint(i + Math.round(ds / t.ds), 0, T); if (this.visible(P, T)) seen++; }
      if (seen >= 2) return { pos: P.clone(), i, st };
    }
    return null;
  }
  post(st) { st = ((st % this.nSt) + this.nSt) % this.nSt; if (this.posts[st] === undefined) this.posts[st] = this.validate(st); return this.posts[st]; }

  // the best post that sees the car right now: prefer one the car is approaching, not too near, not too far
  choose(carPos, idx, soon, later) {
    const st0 = Math.round(idx * this.nSt / this.track.n);
    let best = null, bs = Infinity, budget = 3;                     // at most three new validations per search
    for (const k of [1, 0, 2, -1, 3, -2]) {
      const st = ((st0 + k) % this.nSt + this.nSt) % this.nSt;
      if (this.posts[st] === undefined) { if (budget-- <= 0) continue; }
      const p = this.post(st); if (!p) continue;
      const d = p.pos.distanceTo(carPos); if (d < 12 || d > 330) continue;
      if (!this.visible(p.pos, carPos) || (soon && !this.visible(p.pos, soon))) continue;
      const s = Math.abs(d - 70) + (k < 0 ? 60 : 0) + (later && !this.visible(p.pos, later) ? 80 : 0);
      if (s < bs) { bs = s; best = p; }
    }
    return best;
  }

  // place `cam`; returns the field of view (degrees). carPos: model position; car: sim vehicle
  update(dt, carPos, car, cam) {
    if (performance.now() - this.occT > 4000) { this.refreshOccluders(); this.occT = performance.now(); }
    this.t += dt;
    if (this.t >= CHECK || !this.cur && !this.heli) {
      this.t = 0;
      // where the car will be in half a second and in two: a post that is about to lose it is left
      // early, a new one is only taken if it will keep it for a while (so the picture does not flicker)
      const fx = Math.cos(car.yaw), fz = -Math.sin(car.yaw), v = Math.max(0, car.vx);
      const soon = this.soon.set(carPos.x + fx * v * 0.5, carPos.y, carPos.z + fz * v * 0.5);
      this.trackPoint(car.idx + Math.round(v * 2 / this.track.ds), 0, this.later);
      const p = this.cur, d = p ? p.pos.distanceTo(carPos) : Infinity, inRange = !!p && d < 340 && d > 9;
      const sees = inRange && this.visible(p.pos, carPos), keeps = sees && this.visible(p.pos, soon);
      if (!keeps || this.heli) {
        const q = this.choose(carPos, car.idx, soon, this.later);
        if (q && q !== this.cur) { this.cur = q; this.heli = false; this.stats.switches++; }
        else if (!q && !sees) { if (!this.heli) { this.heli = true; this.init = false; this.high = false; this.tail = false; this.stats.switches++; } this.cur = null; }
      }
      // the helicopter must see the car too: if something still hides it, go straight overhead
      const ok = this.heli || !this.cur ? (this.init ? this.visible(this.pos, carPos) : true) : this.visible(this.cur.pos, carPos);
      // ... and if even that is blind (a tunnel, a bridge), ride along just behind the car
      if (this.heli && !ok && this.init) { if (this.high) this.tail = true; this.high = true; }
      this.stats.checks++; if (this.heli) this.stats.heli++; if (ok) this.stats.seen++;
    }
    let fov;
    if (this.heli || !this.cur) {
      // helicopter: high behind the car, above the trees and roofs
      const fx = Math.cos(car.yaw), fz = -Math.sin(car.yaw);
      if (this.tail) this.heliPos.set(carPos.x - fx * 11, carPos.y + 2.6, carPos.z - fz * 11);
      else if (this.high) this.heliPos.set(carPos.x - fx * 5, carPos.y + 42, carPos.z - fz * 5); else this.heliPos.set(carPos.x - fx * 16, carPos.y + 24, carPos.z - fz * 16);
      if (!this.init) { this.pos.copy(this.heliPos); this.init = true; } else this.pos.lerp(this.heliPos, 1 - Math.exp(-dt * (this.tail ? 8 : 2.5)));
      cam.position.copy(this.pos); fov = this.tail ? 55 : 34;
    } else { cam.position.copy(this.cur.pos); this.init = false; const d = Math.max(10, cam.position.distanceTo(carPos)); fov = THREE.MathUtils.clamp(2 * Math.atan(9 / d) * 57.3, 9, 50); }
    cam.lookAt(carPos.x, carPos.y + 0.6, carPos.z);
    return fov;
  }
}
