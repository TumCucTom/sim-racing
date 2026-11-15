// Driving difficulty for the human driver. The physics model is never altered for the AI,
// tests or RL: assists act on the player's inputs, plus (on the easier levels) a grip bonus
// applied through the vehicle's existing track-condition multiplier.
//   sim     - nothing: the car as specified (ABS / TC only where the real car has them)
//   assist  - ABS, TC and stability help on every car, a little extra grip
//   easy    - arcade: steering help toward the racing line, automatic braking for corners,
//             counter-steer help, a lot of extra grip. Meant for keyboards; knowingly unrealistic.
import { BaselineDriver, lineDriverOptions } from '../sim/drivers/baseline.js';

export const DIFFICULTY = {
  easy: { label: 'Easy (arcade, keyboard-friendly)', grip: 1.3, steerHelp: 1, autoBrake: 1, stability: 1, forceAids: true },
  assist: { label: 'Assisted', grip: 1.08, steerHelp: 0, autoBrake: 0, stability: 0.6, forceAids: true },
  sim: { label: 'Simulation', grip: 1, steerHelp: 0, autoBrake: 0, stability: 0, forceAids: false },
};
export const DIFFICULTY_ORDER = ['easy', 'assist', 'sim'];

export class DriveAssist {
  constructor(track, spec, level, wet) {
    this.cfg = DIFFICULTY[level] || DIFFICULTY.sim; this.level = DIFFICULTY[level] ? level : 'sim';
    this.out = { steer: 0, throttle: 0, brake: 0 };
    // a slightly cautious racing-line driver supplies "what a sensible driver would do here"
    const o = lineDriverOptions(track, spec);
    this.guide = this.cfg.steerHelp || this.cfg.autoBrake ? new BaselineDriver(track, spec, { ...o, grip: o.grip * 0.93, wet }) : null;
    this.spec = spec; this.blend = 0;
  }
  // Called once when the car is (re)created.
  setup(car) {
    const c = this.cfg, s = this.spec;
    car.gripScale = c.grip;
    if (c.forceAids) { car.aids.abs = true; car.aids.tc = true; car.aids.autoShift = true; }
    else { car.aids.abs = s.abs; car.aids.tc = s.tc; }
  }
  // `inp` = { steer, throttle, brake } from the input device; returns the controls to simulate.
  apply(inp, car, dt) {
    const c = this.cfg, o = this.out;
    o.steer = inp.steer; o.throttle = inp.throttle; o.brake = inp.brake;
    if (c === DIFFICULTY.sim || car.gear === -1) return o;
    const v = Math.max(1, Math.abs(car.vx)), lock = this.spec.steerLock;
    if (this.guide && car.vx > 1.5) {
      const g = this.guide.control(car);
      // steering: with no key held the car follows the road by itself; a held key adds to
      // (and can override) the help, so the player still chooses the line
      const steering = Math.abs(inp.steer) > 0.02;
      const want = steering ? 0.4 : 1; this.blend += (want - this.blend) * Math.min(1, dt * (steering ? 10 : 3));
      const offLine = Math.min(1, Math.max(0, (Math.abs(car.headErr || 0) - 1.0) / 0.5));          // facing the wrong way: let the player sort it out
      o.steer = clamp(inp.steer + g.steer * c.steerHelp * this.blend * (1 - offLine), -1, 1);
      // braking: slow the car to the speed the corner ahead allows
      if (c.autoBrake && g.brake > 0.02) { o.brake = Math.max(o.brake, g.brake * c.autoBrake); o.throttle = 0; }
      else if (c.autoBrake && g.throttle < 0.95) o.throttle = Math.min(o.throttle, g.throttle + 0.08);
    }
    if (c.stability) {
      // stability control: catch slides with a throttle cut and a touch of opposite lock
      const slide = Math.abs(car.vy) - (0.07 * v + 0.4);
      if (slide > 0 && car.vx > 5) {
        const k = Math.min(1, slide / (0.08 * v + 0.5)) * c.stability;
        o.throttle *= 1 - 0.85 * k;
        o.steer = clamp(o.steer + Math.atan2(car.vy, v) / lock * 0.9 * k, -1, 1);
      }
    }
    return o;
  }
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
