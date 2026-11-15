// Engine voices for the nearest opponents (race mode).
//
// The player's car has the full engine synthesis (synth.js, one worklet voice). The cars
// around it get something much cheaper, built from stock WebAudio nodes so that it costs
// nothing on the main thread and nothing in the worklet: per voice two oscillators at the
// firing frequency and half of it, a low-pass that opens with throttle and closes with
// distance, a gain with distance roll-off and a stereo panner. Pitch carries the Doppler
// shift of the relative speed along the line of sight. Three voices by default.
const SOUND = 343;

export class OpponentAudio {
  constructor(ctx, dest, n = 3) {
    this.ctx = ctx; this.voices = [];
    for (let i = 0; i < n; i++) {
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g1 = ctx.createGain(), g2 = ctx.createGain();
      const lp = ctx.createBiquadFilter(), gain = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      o1.type = 'sawtooth'; o2.type = 'square'; o1.frequency.value = 80; o2.frequency.value = 40;
      g1.gain.value = 0.55; g2.gain.value = 0.3; lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 0.9; gain.gain.value = 0;
      o1.connect(g1); o2.connect(g2); g1.connect(lp); g2.connect(lp); lp.connect(gain);
      if (pan) { gain.connect(pan); pan.connect(dest); } else gain.connect(dest);
      o1.start(); o2.start();
      this.voices.push({ o1, o2, lp, gain, pan, id: -1 });
    }
  }

  // sources: [{ id, x, y, z, vx, vy, vz, rpm, throttle, cylinders, electric }] in world space, any order.
  // listener: { x, y, z, vx, vy, vz, rx, rz } (position, velocity, unit vector to its right). master: 0..1.
  update(sources, listener, master) {
    const now = this.ctx.currentTime, V = this.voices;
    for (const s of sources) { const dx = s.x - listener.x, dy = s.y - listener.y, dz = s.z - listener.z; s._d = Math.sqrt(dx * dx + dy * dy + dz * dz); }
    sources.sort((a, b) => a._d - b._d);
    const top = sources.slice(0, V.length).filter(s => s._d < 260);
    // keep a voice on the car it already has; hand free voices to newcomers
    for (const v of V) if (v.id >= 0 && !top.some(s => s.id === v.id)) { v.id = -1; v.gain.gain.setTargetAtTime(0, now, 0.03); }
    for (const s of top) {
      let v = V.find(q => q.id === s.id);
      if (!v) { v = V.find(q => q.id < 0); if (!v) continue; v.id = s.id; v.gain.gain.setTargetAtTime(0, now, 0.01); v.fresh = true; }
      const d = Math.max(1, s._d);
      const ux = (s.x - listener.x) / d, uy = (s.y - listener.y) / d, uz = (s.z - listener.z) / d;
      // closing speed along the line of sight (+ = approaching)
      let vr = -((s.vx - listener.vx) * ux + (s.vy - listener.vy) * uy + (s.vz - listener.vz) * uz); vr = vr > 90 ? 90 : vr < -90 ? -90 : vr;
      const dop = SOUND / (SOUND - vr);
      const fire = s.electric ? s.rpm / 60 * 4 : s.rpm / 60 * (s.cylinders || 6) / 2;
      const f = Math.max(20, Math.min(1400, fire * dop));
      const tc = v.fresh ? 0.005 : 0.04; v.fresh = false;
      v.o1.frequency.setTargetAtTime(f, now, tc); v.o2.frequency.setTargetAtTime(f / 2, now, tc);
      const thr = Math.max(0, Math.min(1, s.throttle));
      v.lp.frequency.setTargetAtTime((450 + 2600 * thr + f * 1.5) / (1 + d / 70), now, 0.06);
      const roll = 1 / (1 + (d / 13) * (d / 13));
      v.gain.gain.setTargetAtTime(master * (s.electric ? 0.05 : 0.2) * (0.3 + 0.7 * thr) * roll, now, 0.06);
      if (v.pan) v.pan.pan.setTargetAtTime(Math.max(-0.85, Math.min(0.85, (ux * listener.rx + uz * listener.rz) * Math.min(1, d / 4))), now, 0.08);
    }
  }

  silence() { const now = this.ctx.currentTime; for (const v of this.voices) { v.id = -1; v.gain.gain.setTargetAtTime(0, now, 0.03); } }
}
