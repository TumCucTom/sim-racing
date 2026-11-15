// Skid marks (ring buffer of quads) and tyre smoke / dust (point sprites).
import * as THREE from 'three';
import { SURF } from '../sim/track.js';
import { puffTexture } from './textures.js';

export class Effects {
  constructor(scene) {
    // ---- skid marks ----
    this.maxQuads = 2400; this.q = 0;
    const g = new THREE.BufferGeometry();
    this.skPos = new Float32Array(this.maxQuads * 4 * 3); this.skCol = new Float32Array(this.maxQuads * 4 * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.skPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.skCol, 4));
    const idx = []; for (let i = 0; i < this.maxQuads; i++) { const b = i * 4; idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3); }
    g.setIndex(idx);
    this.skid = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    this.skid.frustumCulled = false; this.skid.renderOrder = 1; scene.add(this.skid);
    this.last = [null, null, null, null];

    // ---- particles ----
    this.N = 1100; this.pi = 0;
    this.wet = 0; this.sprayCol = [0.7, 0.72, 0.75]; this.sprayAcc = [0, 0, 0, 0];   // set by the weather system
    this.pPos = new Float32Array(this.N * 3); this.pVel = new Float32Array(this.N * 3);
    this.pLife = new Float32Array(this.N); this.pMax = new Float32Array(this.N).fill(1);
    this.pSize = new Float32Array(this.N); this.pCol = new Float32Array(this.N * 4);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 4));
    this.points = new THREE.Points(pg, new THREE.ShaderMaterial({
      uniforms: { map: { value: puffTexture() }, scale: { value: 600 } },
      vertexShader: 'attribute float size; attribute vec4 color; varying vec4 vC; uniform float scale; void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*scale/max(0.5,-mv.z); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'uniform sampler2D map; varying vec4 vC; void main(){ vec4 t=texture2D(map,gl_PointCoord); gl_FragColor=vec4(vC.rgb, vC.a*t.a); }',
      transparent: true, depthWrite: false,
    }));
    this.points.frustumCulled = false; this.points.renderOrder = 2; scene.add(this.points);
    this.tmp = new THREE.Vector3();
    this.seed = 1;
  }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  emit(x, y, z, vx, vy, vz, size, life, r, g, b, a) {
    const i = this.pi; this.pi = (i + 1) % this.N;
    this.pPos[i * 3] = x; this.pPos[i * 3 + 1] = y; this.pPos[i * 3 + 2] = z;
    this.pVel[i * 3] = vx; this.pVel[i * 3 + 1] = vy; this.pVel[i * 3 + 2] = vz;
    this.pLife[i] = life; this.pMax[i] = life; this.pSize[i] = size;
    this.pCol[i * 4] = r; this.pCol[i * 4 + 1] = g; this.pCol[i * 4 + 2] = b; this.pCol[i * 4 + 3] = a;
  }

  // wheelWorld: array of 4 Vector3 contact points; car: sim vehicle
  update(dt, car, wheelWorld, heading, pixelScale) {
    this.points.material.uniforms.scale.value = pixelScale;
    this.emitFor(dt, car, wheelWorld, heading);
    this.integrate(dt);
  }

  // Skid marks, smoke, dust and spray for one car. `st` = { last, sprayAcc } keeps the per-wheel
  // state of a second (third, ...) car, so several cars can share the one particle system (race mode).
  emitFor(dt, car, wheelWorld, heading, st = null) {
    if (st) { const l = this.last, a = this.sprayAcc; this.last = st.last; this.sprayAcc = st.sprayAcc; try { this.emitFor(dt, car, wheelWorld, heading); } finally { st.last = this.last; this.last = l; this.sprayAcc = a; } return; }
    const spec = car.spec, hx = Math.cos(heading), hz = -Math.sin(heading);
    for (let i = 0; i < 4; i++) {
      const sf = car.surf[i], p = wheelWorld[i], slip = car.slipV[i];
      const w = i < 2 ? 0.13 : 0.15;
      const marking = (sf === SURF.ASPHALT || sf === SURF.KERB) && slip > 2.6 && car.fz[i] > 300;
      if (marking) {
        const alpha = Math.min(0.55, (slip - 2.2) * 0.07);
        const L = this.last[i];
        // perpendicular to travel direction of the contact patch
        const px = -hz * w, pz = hx * w;
        if (L && L.distanceToSquared(p) < 9 && L.distanceToSquared(p) > 0.0025) {
          const b = this.q * 12, c = this.q * 16;
          const P = this.skPos, C = this.skCol;
          P[b] = L.x - L.px; P[b + 1] = L.y + 0.02; P[b + 2] = L.z - L.pz; P[b + 3] = L.x + L.px; P[b + 4] = L.y + 0.02; P[b + 5] = L.z + L.pz;
          P[b + 6] = p.x - px; P[b + 7] = p.y + 0.02; P[b + 8] = p.z - pz; P[b + 9] = p.x + px; P[b + 10] = p.y + 0.02; P[b + 11] = p.z + pz;
          for (let k = 0; k < 4; k++) { C[c + k * 4] = 0.03; C[c + k * 4 + 1] = 0.03; C[c + k * 4 + 2] = 0.03; C[c + k * 4 + 3] = k < 2 ? L.a : alpha; }
          this.q = (this.q + 1) % this.maxQuads;
          this.skid.geometry.attributes.position.needsUpdate = true; this.skid.geometry.attributes.color.needsUpdate = true;
        }
        if (!L || L.distanceToSquared(p) > 0.0025) { const n = p.clone(); n.px = px; n.pz = pz; n.a = alpha; this.last[i] = n; }
        if (slip > 5 && this.rnd() < dt * 40) {
          const hot = Math.min(1, (slip - 5) / 10);
          this.emit(p.x, p.y + 0.15, p.z, (this.rnd() - 0.5) * 1.5, 0.8 + this.rnd(), (this.rnd() - 0.5) * 1.5, 0.9, 1.3, 0.86, 0.86, 0.88, 0.12 + 0.2 * hot);
        }
      } else this.last[i] = null;
      if ((sf === SURF.GRASS || sf === SURF.GRAVEL) && car.speed > 4 && this.rnd() < dt * Math.min(60, car.speed * 2)) {
        const gr = sf === SURF.GRAVEL;
        this.emit(p.x, p.y + 0.1, p.z, -hx * car.speed * 0.15 + (this.rnd() - 0.5) * 2, 1 + this.rnd() * 1.5, -hz * car.speed * 0.15 + (this.rnd() - 0.5) * 2, gr ? 1.0 : 0.6, gr ? 1.6 : 0.9, gr ? 0.72 : 0.42, gr ? 0.66 : 0.38, gr ? 0.55 : 0.25, gr ? 0.4 : 0.3);
      }
    }
    // wet track: every tyre lifts a mist that hangs in the air behind the car; the rear
    // wheels throw the tall rooster tail. Amount and height grow with speed.
    if (this.wet > 0.05 && car.speed > 5) {
      const v = car.speed, k = Math.min(1, v / 55), c = this.sprayCol, vx = hx * v, vz = hz * v;
      for (let i = 0; i < 4; i++) {
        const sf = car.surf[i]; if (sf !== SURF.ASPHALT && sf !== SURF.KERB) continue;
        const rear = i >= 2, p = wheelWorld[i];
        this.sprayAcc[i] += dt * this.wet * (rear ? 80 : 30) * (0.25 + 0.75 * k);
        while (this.sprayAcc[i] >= 1) {
          this.sprayAcc[i] -= 1;
          const back = this.rnd() * v * dt, drag = 0.22 + 0.2 * this.rnd();       // spread along the distance covered this frame
          const up = (rear ? 1.6 + 4.2 * k : 0.7 + 1.6 * k) * (0.5 + this.rnd());
          this.emit(p.x - hx * (0.35 + back), p.y + 0.12 + 0.2 * this.rnd(), p.z - hz * (0.35 + back),
            vx * drag + (this.rnd() - 0.5) * (1.2 + 2 * k), up, vz * drag + (this.rnd() - 0.5) * (1.2 + 2 * k),
            (rear ? 0.5 : 0.35) + 0.5 * k, 0.4 + 0.55 * k * this.rnd() + (rear ? 0.3 * k : 0),
            c[0], c[1], c[2], (0.06 + 0.12 * k) * (0.6 + 0.4 * this.rnd()) * this.wet * (rear ? 1 : 0.55));
        }
      }
    }
  }

  // age and move every particle (once per frame)
  integrate(dt) {
    for (let i = 0; i < this.N; i++) {
      if (this.pLife[i] <= 0) { if (this.pCol[i * 4 + 3] !== 0) this.pCol[i * 4 + 3] = 0; continue; }
      this.pLife[i] -= dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt; this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt; this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      this.pVel[i * 3 + 1] *= 1 - dt * 1.5;
      this.pSize[i] += dt * 1.6;
      this.pCol[i * 4 + 3] *= 1 - dt / Math.max(0.05, this.pLife[i] + dt) * 0.9;
      if (this.pLife[i] <= 0) this.pCol[i * 4 + 3] = 0;
    }
    const a = this.points.geometry.attributes; a.position.needsUpdate = true; a.size.needsUpdate = true; a.color.needsUpdate = true;
  }
  clear() { this.skCol.fill(0); this.skid.geometry.attributes.color.needsUpdate = true; this.last = [null, null, null, null]; }
}
