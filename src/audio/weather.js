// Weather layer for the audio bus: rain on the car and the ground, tyre spray on a
// wet road, thunder. Plain Web Audio nodes fed by one looping noise buffer, so it
// needs no asset and stays out of the engine synth (src/audio/synth.js).
//
//   const wx = new WeatherAudio(ctx, destinationNode);
//   wx.set({ rain: 0..1, wet: 0..1 });           // when the conditions change
//   wx.update(speed m/s, level 0..1, cockpit);   // every frame
//   wx.thunder(delaySeconds, loudness 0..1);
export class WeatherAudio {
  constructor(ctx, dest) {
    this.ctx = ctx; this.rain = 0; this.wet = 0;
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
  }

  // A crack (only when close) followed by a long rolling rumble.
  thunder(delay = 0, loud = 0.6) {
    const ctx = this.ctx, t0 = ctx.currentTime + Math.max(0, delay), lvl = this.level * Math.min(1, loud);
    if (lvl <= 0.001) return;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true; src.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(loud > 0.5 ? 1800 : 500, t0); lp.frequency.exponentialRampToValueAtTime(90, t0 + 1.4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(1.4 * lvl, t0 + 0.04);
    // the rumble swells and fades a few times as the sound arrives from along the channel
    let t = t0 + 0.25, a = 0.8 * lvl;
    for (let i = 0; i < 5; i++) { g.gain.linearRampToValueAtTime(a * (0.5 + 0.5 * ((i * 7919) % 5) / 4), t); t += 0.45 + 0.2 * (i % 3); a *= 0.62; }
    g.gain.linearRampToValueAtTime(0, t + 1.2);
    src.connect(lp); lp.connect(g); g.connect(this.dest);
    src.start(t0); src.stop(t + 1.4);
  }
}
