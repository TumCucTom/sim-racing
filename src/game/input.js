// Keyboard + gamepad input with the smoothing a digital input needs to drive
// an analogue car: speed-sensitive steering, ramped pedals, auto-reverse.
import { steerLimit } from '../sim/drivers/rl-interface.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.handlers = {};
    this.steerPos = 0; this.thr = 0; this.brk = 0;
    this.out = { steer: 0, throttle: 0, brake: 0 };
    this.padPrev = [];
    this.device = 'keyboard';
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      const h = this.handlers[e.code]; if (h) h();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
  on(code, fn) { for (const c of [].concat(code)) this.handlers[c] = fn; }
  down(...codes) { for (const c of codes) if (this.keys.has(c)) return true; return false; }

  // Returns controls for the sim. May request gear changes on `car`.
  read(car, dt) {
    let steerT = (this.down('ArrowLeft', 'KeyA') ? 1 : 0) - (this.down('ArrowRight', 'KeyD') ? 1 : 0);
    let fwd = this.down('ArrowUp', 'KeyW') ? 1 : 0, back = this.down('ArrowDown', 'KeyS') ? 1 : 0;
    let analog = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92);
      const sx = dz(gp.axes[0] || 0), rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      if (Math.abs(sx) > 0.02 || rt > 0.02 || lt > 0.02) { analog = true; steerT = -Math.sign(sx) * Math.pow(Math.abs(sx), 1.6); fwd = rt; back = lt; this.device = 'gamepad'; }
      const edge = (i) => { const p = gp.buttons[i]?.pressed; const was = this.padPrev[i]; this.padPrev[i] = p; return p && !was; };
      if (edge(5) || edge(0)) this.handlers.KeyE?.();
      if (edge(4) || edge(2)) this.handlers.KeyQ?.();
      if (edge(3)) this.handlers.KeyR?.();
      if (edge(1)) this.handlers.KeyC?.();
      break;
    }
    const tc = this.touch;
    if (!analog && tc && tc.on && (tc.analog || tc.steer || tc.thr || tc.brk)) {
      // touch screen: tilt is an analogue axis; on-screen buttons behave like keys (ramped below)
      if (tc.analog) { analog = true; steerT = Math.sign(tc.steer) * Math.pow(Math.abs(tc.steer), 1.3); } else steerT = tc.steer;
      fwd = tc.thr; back = tc.brk; this.device = 'touch';
    } else
    if (!analog && (steerT || fwd || back)) this.device = 'keyboard';
    // steering: move the wheel toward the target, faster when returning to centre
    if (analog) this.steerPos += (steerT - this.steerPos) * Math.min(1, dt * 14);
    else {
      const rate = (steerT === 0 || Math.sign(steerT) !== Math.sign(this.steerPos) ? 5.5 : 2.6) * dt;
      this.steerPos += Math.max(-rate, Math.min(rate, steerT - this.steerPos));
    }
    // auto-reverse: holding brake at a standstill selects reverse
    let thrT = fwd, brkT = back;
    if (car.gear === -1) {
      if (fwd > 0.1 && car.vx > -1.0) { car.requestShift(1); if (car.gear === 0) car.requestShift(1); }
      else { thrT = back; brkT = fwd; }
    } else if (back > 0.5 && fwd < 0.1 && Math.abs(car.vx) < 0.6 && car.gear >= 1) {
      this.revHold = (this.revHold || 0) + dt;
      if (this.revHold > 0.25) { while (car.gear > -1 && car.gear !== -1) { const g = car.gear; car.shiftTimer = 0; car.requestShift(-1); if (car.gear === g) break; } this.revHold = 0; }
    } else this.revHold = 0;
    if (analog && this.device !== 'touch') { this.thr = thrT; this.brk = brkT; }
    else {
      const tr = (thrT > this.thr ? 4.5 : 9) * dt, br = (brkT > this.brk ? 6 : 12) * dt;
      this.thr += Math.max(-tr, Math.min(tr, thrT - this.thr));
      this.brk += Math.max(-br, Math.min(br, brkT - this.brk));
    }
    this.out.steer = this.steerPos * steerLimit(car.spec, Math.abs(car.vx));
    this.out.throttle = this.thr; this.out.brake = this.brk;
    return this.out;
  }
}
