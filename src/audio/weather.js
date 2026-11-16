// Weather layer for the audio bus: rain on the car and the ground, tyre spray on a
// wet road, thunder. Plain Web Audio nodes fed by one looping noise buffer, so it
// needs no asset and stays out of the engine synth (src/audio/synth.js).
//
//   const wx = new WeatherAudio(ctx, destinationNode);
//   wx.set({ rain: 0..1, wet: 0..1 });           // when the conditions change
//   wx.update(speed m/s, level 0..1, cockpit);   // every frame
//   wx.thunder(delaySeconds, loudness 0..1, { km, double });
import { renderThunder } from './thunder.js';

// near strike (0.3 km, buffer peak 0.9) about 3 dB over a full-throttle engine after the master compressor
const THUNDER_GAIN = 1.2;

export class WeatherAudio {
  constructor(ctx, dest, { post = null, verb = null } = {}) {
    this.ctx = ctx; this.post = post; this.verb = verb; this.rain = 0; this.wet = 0;
    const sr = ctx.sampleRate, n = Math.round(sr * 3), buf = ctx.createBuffer(2, n, sr);
    let seed = 987654321; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2147483648 - 1; };
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = rnd(); }
    this.noise = buf;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    // rain: a broad hiss, plus a duller patter that takes over inside the car
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800; hp.Q.value = 0.3;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = 0.3;
    this.hiss = ctx.createGain(); this.hiss.gain.value = 0;
    src.connect(hp); hp.connect(lp); lp.connect(this.hiss); this.hiss.connect(dest);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.6;
    this.patter = ctx.createGain(); this.patter.gain.value = 0;
    src.connect(bp); bp.connect(this.patter); this.patter.connect(dest);
    // spray: band-limited rush whose pitch and level rise with speed
    this.sprayF = ctx.createBiquadFilter(); this.sprayF.type = 'bandpass'; this.sprayF.frequency.value = 900; this.sprayF.Q.value = 0.5;
    this.spray = ctx.createGain(); this.spray.gain.value = 0;
    src.connect(this.sprayF); this.sprayF.connect(this.spray); this.spray.connect(dest);
    src.start();
    this.src = src; this.dest = dest; this.level = 0;
  }

  set({ rain = 0, wet = 0 } = {}) { this.rain = rain; this.wet = wet; }

  update(speed, level, cockpit) {
    const t = this.ctx.currentTime, r = this.rain, k = Math.min(1, speed / 70);
    this.level = level;
    this.hiss.gain.setTargetAtTime(level * r * (cockpit ? 0.035 : 0.075) * (1 + 0.6 * k), t, 0.15);
    this.patter.gain.setTargetAtTime(level * r * (cockpit ? 0.16 : 0.05), t, 0.15);
    this.spray.gain.setTargetAtTime(level * this.wet * 0.22 * k * Math.sqrt(k), t, 0.08);
    this.sprayF.frequency.setTargetAtTime(600 + 1500 * k, t, 0.1);
    if (this.thBus) { this.thBus.gain.setTargetAtTime(level * THUNDER_GAIN * (cockpit ? 0.8 : 1), t, 0.1); this.thLp.frequency.setTargetAtTime(cockpit ? 1400 : 18000, t, 0.2); }   // muffled inside the car
  }

  // Thunder for a strike `km` away, `delay` seconds after the flash. The sound is rendered
  // by src/audio/thunder.js into a buffer (a near crack, then a 5-15 s roll) and played on its
  // own bus: past the master compressor, so it cannot pump the engine, with a little sent to
  // the reverb. `loud` (0..1) is the older interface and only used when km is not given.
  thunder(delay = 0, loud = 0.6, { km = Math.max(0.3, 1 / Math.max(0.2, loud) - 0.6), double = false, seed = (Math.random() * 0x7fffffff) | 0 } = {}) {
    const ctx = this.ctx, t0 = ctx.currentTime + Math.max(0, delay);
    if (this.level <= 0.001) return;
    if (!this.thBus) {
      this.thLp = ctx.createBiquadFilter(); this.thLp.type = 'lowpass'; this.thLp.frequency.value = 18000; this.thLp.Q.value = 0.5;
      this.thBus = ctx.createGain(); this.thBus.gain.value = this.level * THUNDER_GAIN;
      this.thLp.connect(this.thBus); this.thBus.connect(this.post || this.dest);
      if (this.verb) { const send = ctx.createGain(); send.gain.value = 0.22; this.thBus.connect(send); send.connect(this.verb); }
    }
    // rendered a moment after the flash (tens of ms of work); far strikes have no top end and need fewer samples
    const make = () => {
      if (ctx.state === 'closed') return;
      const th = renderThunder({ sampleRate: km < 1.2 ? 24000 : 12000, km, seed, double });
      const buf = ctx.createBuffer(2, th.left.length, th.sampleRate); buf.copyToChannel(th.left, 0); buf.copyToChannel(th.right, 1);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(this.thLp); src.start(Math.max(t0, ctx.currentTime));
    };
    if (delay > 0.3) setTimeout(make, 120); else make();
  }
}
