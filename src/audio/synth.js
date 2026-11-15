// Race-car audio voice. One self-contained class (no imports, no outer
// references) so the same code runs inside an AudioWorklet, a ScriptProcessor
// fallback and plain Node for the spectral tests and tools/audio-compare.mjs.
//
// Engine, primary voice: pitch-synchronous playback of REAL engine cycles.
// A "bank" (public/audio/<car>.wav, built by tools/audio-build.py from openly
// licensed recordings) holds single 720-degree engine cycles cut from a real
// recording, sorted into rpm bands and into on-load / off-load. Every engine
// cycle the voice picks a random recorded cycle from the two rpm bands around
// the current rpm, for both load states, reads them at exactly the current
// engine phase (so pitch follows rpm continuously) and crossfades by rpm and
// load. Consecutive cycles are spliced with a short overlap.
//
// Engine, fallback voice (no bank loaded / fetch failed): physical synthesis.
// Every cylinder fires once per 720 degrees at its own crank offset, pulses are
// collected per exhaust bank, coloured by a pipe comb and formants.
//
// Around the engine: turbo whistle and blow-off, straight-cut gear whine,
// overrun pops, tonal tyre squeal, scrub, tyre roll, wind, kerbs, gravel and
// grass, brake hiss, impacts, shift clunk, and an exterior / cockpit / trackside
// mix selected by `cam`.
export class RaceAudioSynth {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.ph = 0; this.cyc = 0;
    this.seed = 22222;
    // smoothed parameters
    this.p = { rpm: 900, throttle: 0, load: 0, speed: 0, squeal: 0, scrub: 0, rough: 0, grass: 0, gravel: 0, kerb: 0, boost: 0, wheelRps: 0, master: 0.8, motor: 0, brake: 0, cockpit: 0, tv: 0, onMix: 0 };
    this.t = Object.assign({}, this.p);
    this.cfg = null; this.bank = null;
    this.z = new Float64Array(96);        // misc filter state
    this.dl = [new Float32Array(2048), new Float32Array(2048)]; this.dli = 0;
    this.kerbPh = 0; this.whinePh = 0; this.whinePh2 = 0; this.turboPh = 0; this.mPh = new Float64Array(6);
    this.bov = 0; this.bovF = 0; this.thump = 0; this.thumpPh = 0; this.clunk = 0; this.clunkPh = 0; this.pop = 0; this.crunch = 0;
    this.prevThrottle = 0; this.sqPh = 0; this.lfo = 0; this.lfo2 = 0; this.grit = 0;
    // grain voice slots: [lo-off, lo-on, hi-off, hi-on]
    this.vAt = new Int32Array(4); this.vL = new Int32Array(4); this.tAt = new Int32Array(4); this.tL = new Int32Array(4); this.vK = new Int32Array(4);
    // time constants (no exp() in the audio loop)
    const k = (tau) => 1 - Math.exp(-1 / (tau * sampleRate));
    this.kS = k(0.03); this.kR = k(0.018); this.kF = k(0.008);
    this.dPop = Math.exp(-1 / (0.012 * sampleRate)); this.dBov = Math.exp(-1 / (0.16 * sampleRate)); this.dBovF = Math.exp(-1 / (0.2 * sampleRate));
    this.dThump = Math.exp(-1 / (0.09 * sampleRate)); this.dClunk = Math.exp(-1 / (0.02 * sampleRate)); this.dCrunch = Math.exp(-1 / (0.05 * sampleRate));
    this.configure(RaceAudioSynth.layouts().I4);
  }

  static layouts() {
    return {
      // off: firing offsets as fractions of the 720° cycle; bank: which exhaust bank
      I4: { off: [0, 0.5, 0.25, 0.75], bank: [0, 0, 0, 0], sharp: 9, drive: 1.5, formants: [[105, 2.5, 1.0], [390, 3, 0.7], [1500, 2.5, 0.35]], pipe: [5.2, 5.2], bright: 0.9, pops: 0.15, gain: 0.95, jitter: 0.07, intake: 0.5 },
      // cross-plane V8, firing order 1-5-4-8-6-3-7-2: banks see L R R L R L L R
      V8X: { off: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875], bank: [0, 1, 1, 0, 1, 0, 0, 1], sharp: 6.5, drive: 2.3, formants: [[72, 2.2, 1.3], [210, 2.5, 0.9], [760, 2, 0.4]], pipe: [7.4, 8.1], bright: 0.75, pops: 0.5, gain: 1.0, merge: 0.12, jitter: 0.1, intake: 0.4 },
      // flat-plane V8: banks alternate evenly, so each bank fires like an inline four
      V8F: { off: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875], bank: [0, 1, 0, 1, 0, 1, 0, 1], sharp: 12, drive: 2.7, formants: [[190, 2.5, 0.8], [700, 3.2, 1.0], [2700, 3, 0.65]], pipe: [3.0, 3.2], bright: 1.35, pops: 0.4, gain: 1.0, merge: 0.35, jitter: 0.05, intake: 0.9 },
      F6: { off: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], bank: [0, 1, 0, 1, 0, 1], sharp: 12, drive: 2.9, formants: [[150, 2.5, 0.8], [560, 3.5, 1.0], [2300, 3, 0.6]], pipe: [3.6, 3.9], bright: 1.25, pops: 0.35, gain: 1.15, merge: 0.6, jitter: 0.06, intake: 0.9 },
      // 120° twin-turbo V6: even firing, turbines soak up the pulse edges
      V6T: { off: [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6], bank: [0, 1, 0, 1, 0, 1], sharp: 8, drive: 2.2, formants: [[130, 2.5, 1.0], [430, 3, 0.9], [1700, 2.5, 0.45]], pipe: [4.4, 4.7], bright: 1.0, pops: 0.3, gain: 1.1, merge: 0.3, jitter: 0.05, intake: 0.7 },
      V10: { off: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], bank: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], sharp: 13, drive: 2.4, formants: [[310, 2.5, 0.7], [1150, 3.5, 1.0], [3600, 3, 0.75]], pipe: [1.7, 1.85], bright: 1.6, pops: 0.25, gain: 0.9, merge: 0.7, jitter: 0.04, intake: 1.0 },
      EV: { off: [], bank: [], sharp: 1, drive: 1, formants: [], pipe: [1, 1], bright: 1, pops: 0, gain: 0, jitter: 0, intake: 0, electric: true },
    };
  }

  configure(c) {
    const cfg = Object.assign({ turbo: false, gearWhine: 0, squealGain: 1, redline: 7000, merge: 0, whineTeeth: 41, bankGain: 1, offGain: 0.42, turboGain: 1, id: '', bankName: '' }, c);
    this.cfg = cfg;
    this.amp = new Float64Array(cfg.off.length).fill(1);
    this.lastPhi = new Float64Array(cfg.off.length);
    // band-pass biquads (RBJ, constant 0 dB peak) per bank per formant
    this.bq = [];
    for (let b = 0; b < 2; b++) for (const [f, q, g] of cfg.formants) {
      const f2 = f * (b ? 1.06 : 1), w = 2 * Math.PI * f2 / this.sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
      this.bq.push({ b, g, b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 });
    }
    this.pipeN = cfg.pipe.map(ms => Math.max(8, Math.min(2040, Math.round(ms * 0.001 * this.sr))));
    this.two = cfg.bank.indexOf(1) >= 0;
    if (this.bank && this.bank.car !== cfg.id) this.bank = null;     // a bank belongs to one car
  }

  // Install a grain bank: meta = JSON index from the wav's 'rsim' chunk, pcm =
  // Float32Array of the grains. Called outside the audio callback.
  setBank(meta, pcm) {
    if (!meta || !pcm || !meta.bands || meta.bands.length < 2) { this.bank = null; return false; }
    const nb = meta.bands.length, K = 16;
    const bk = { car: meta.car, pcm, nb, K, ov: meta.ov || 0.125, cyl: meta.cyl, rpm: new Float64Array(nb), inv: new Float64Array(nb),
      at: new Int32Array(nb * 2 * K), n: new Int32Array(nb * 2), L: new Int32Array(nb * 2), fake: new Float32Array(nb), b: 0 };
    // game rpm -> bank rpm (a bank recorded on a lower-revving engine is stretched over the car's range)
    const scale = meta.rpmScale || 1;
    for (let b = 0; b < nb; b++) bk.rpm[b] = meta.bands[b].rpm / scale;
    for (let b = 0; b < nb - 1; b++) bk.inv[b] = 1 / (bk.rpm[b + 1] - bk.rpm[b]);
    const has = (b, key) => meta.bands[b][key] && meta.bands[b][key].n > 0;
    const nearest = (b, key) => { for (let d = 0; d < nb; d++) { if (b - d >= 0 && has(b - d, key)) return b - d; if (b + d < nb && has(b + d, key)) return b + d; } return -1; };
    for (let b = 0; b < nb; b++) for (let st = 0; st < 2; st++) {
      let key = st ? 'on' : 'off', src = nearest(b, key);
      // no recording of this load state near this rpm: borrow the other state and filter it at run time
      const other = nearest(b, st ? 'off' : 'on');
      if (src < 0 || (other >= 0 && Math.abs(other - b) + 2 < Math.abs(src - b))) { src = other; key = st ? 'off' : 'on'; if (!st) bk.fake[b] = 1; }
      if (src < 0) { this.bank = null; return false; }
      const e = meta.bands[src][key], i = b * 2 + st, n = Math.min(K, e.n);
      bk.n[i] = n; bk.L[i] = meta.bands[src].L;
      for (let k = 0; k < n; k++) bk.at[i * K + k] = e.at[k];
    }
    this.bank = bk; this.vL.fill(0); this.tL.fill(0);
    return true;
  }

  // non-finite values are ignored: a single NaN would otherwise stick in the smoothed state for good
  set(o) { for (const k in o) { const v = o[k]; if (k in this.t && typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) this.t[k] = v; } }
  trigger(name, amount) {
    if (!(amount > 0)) return;
    if (name === 'impact') { this.thump = Math.max(this.thump, Math.min(1.5, amount)); this.crunch = Math.max(this.crunch, Math.min(1.5, amount)); }
    else if (name === 'shift') { this.clunk = Math.min(1, amount); this.clunkPh = 0; }
  }

  rnd() { let s = this.seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seed = s; return (s >>> 0) / 4294967296; }

  // new engine cycle: choose the rpm band pair and one recorded cycle per slot
  _cycle() {
    const bk = this.bank, r = this.p.rpm, K = bk.K;
    let b = bk.b;
    while (b < bk.nb - 2 && r > bk.rpm[b + 1]) b++;
    while (b > 0 && r < bk.rpm[b]) b--;
    const d = b - bk.b; bk.b = b;
    const vAt = this.vAt, vL = this.vL, tAt = this.tAt, tL = this.tL, vK = this.vK;
    for (let s = 0; s < 4; s++) {
      // what this slot was playing continues as its tail; follow the band when the pair moved
      const from = d === 1 ? s + 2 : d === -1 ? s - 2 : d === 0 ? s : -1;
      if (from >= 0 && from < 4) { tAt[s] = vAt[from]; tL[s] = vL[from]; } else tL[s] = 0;
    }
    for (let s = 0; s < 4; s++) {
      const i = (b + (s >> 1)) * 2 + (s & 1), n = bk.n[i];
      let k = (this.rnd() * n) | 0; if (k === vK[s] && n > 1) k = (k + 1) % n;
      vK[s] = k; vAt[s] = bk.at[i * K + k]; vL[s] = bk.L[i];
    }
  }

  process(L, R, n) {
    const p = this.p, t = this.t, cfg = this.cfg, sr = this.sr, z = this.z;
    const nc = cfg.off.length, off = cfg.off, bank = cfg.bank, amp = this.amp, lastPhi = this.lastPhi;
    const kS = this.kS, kR = this.kR, kF = this.kF;
    const d0 = this.dl[0], d1 = this.dl[1];
    const bk = this.bank, pcm = bk ? bk.pcm : null, vAt = this.vAt, vL = this.vL, tAt = this.tAt, tL = this.tL;
    const TAU = 6.283185307179586;
    // block-rate targets
    const x = Math.max(0, t.load) * 0.85 + t.throttle * 0.15;
    t.onMix = Math.min(1, x * 2.2);
    for (let i = 0; i < n; i++) {
      p.rpm += (t.rpm - p.rpm) * kR;
      p.throttle += (t.throttle - p.throttle) * kS; p.load += (t.load - p.load) * kS; p.onMix += (t.onMix - p.onMix) * kF;
      p.speed += (t.speed - p.speed) * kS; p.squeal += (t.squeal - p.squeal) * kS; p.scrub += (t.scrub - p.scrub) * kS;
      p.rough += (t.rough - p.rough) * kS; p.grass += (t.grass - p.grass) * kS; p.gravel += (t.gravel - p.gravel) * kS;
      p.kerb += (t.kerb - p.kerb) * kS; p.boost += (t.boost - p.boost) * kS; p.brake += (t.brake - p.brake) * kS;
      p.wheelRps += (t.wheelRps - p.wheelRps) * kS; p.master += (t.master - p.master) * kS; p.motor += (t.motor - p.motor) * kS;
      p.cockpit += (t.cockpit - p.cockpit) * kS * 0.2; p.tv += (t.tv - p.tv) * kS * 0.2;
      const white = this.rnd() * 2 - 1;
      const ext = 1 - p.cockpit;                  // 1 outside the car, 0 inside
      let eL = 0, eR = 0;                         // engine + drivetrain
      let outL = 0, outR = 0;                     // everything else

      // ---------------- combustion engine ----------------
      if (nc > 0) {
        const rev = p.rpm / cfg.redline;
        this.ph += p.rpm / 120 / sr;
        const load = p.load < 0 ? 0 : p.load;
        let wrap = false;
        if (this.ph >= 1) { this.ph -= 1; wrap = true; }
        if (bk) {
          // ---- recorded engine cycles ----
          if (wrap || vL[0] === 0) this._cycle();
          const ph = this.ph, b = bk.b;
          let f = (p.rpm - bk.rpm[b]) * bk.inv[b]; f = f < 0 ? 0 : f > 1 ? 1 : f;
          const comp = 1 + 0.62 * f * (1 - f);
          const gLo = (1 - f) * comp, gHi = f * comp;
          const inTail = ph < bk.ov, fa = inTail ? ph / bk.ov : 1;
          let sOn = 0, sOff = 0;
          const on = p.onMix, aOn = on > 0.999 ? 1 : Math.sqrt(on), aOff = on > 0.999 ? 0 : Math.sqrt(1 - on);
          for (let s = 0; s < 4; s++) {
            const st = s & 1;
            if ((st ? aOn : aOff) < 0.003) continue;
            const g = s < 2 ? gLo : gHi;
            if (g < 0.003) continue;
            const Lg = vL[s], q = ph * Lg, qi = q | 0, a = vAt[s] + qi;
            let v = pcm[a] + (q - qi) * (pcm[a + 1] - pcm[a]);
            if (inTail) {
              const Lt = tL[s];
              if (Lt > 0) { const q2 = (1 + ph) * Lt, q2i = q2 | 0, a2 = tAt[s] + q2i; v = v * fa + (pcm[a2] + (q2 - q2i) * (pcm[a2 + 1] - pcm[a2])) * (1 - fa); }
            }
            if (st) sOn += v * g; else sOff += v * g;
          }
          // off-load cycles borrowed from the on-load recording are muffled like a closed throttle
          const fk = bk.fake[b];
          if (fk > 0) { z[40] += (sOff - z[40]) * 0.11; z[41] += (z[40] - z[41]) * 0.11; sOff += (z[41] * 0.8 - sOff) * fk; }
          const lvl = cfg.bankGain * 0.25;
          let e = (sOn * aOn * (0.5 + 0.5 * load) * (0.62 + 0.38 * rev) + sOff * aOff * cfg.offGain * (0.75 + 0.5 * rev)) * lvl;
          // overrun pops: short broadband bangs through the exhaust resonance
          if (wrap && p.throttle < 0.06 && rev > 0.45 && this.rnd() < cfg.pops * 0.5) this.pop = 0.5 + this.rnd() * 0.6;
          if (this.pop > 0.001) {
            const fc = 0.09; z[42] += fc * z[43]; const hp = white * this.pop - z[42] - 0.5 * z[43]; z[43] += fc * hp;
            e += z[43] * 0.35; this.pop *= this.dPop;
          }
          eL += e; eR += e;
        } else {
          // ---- physical synthesis fallback ----
          // on load the pulses are sharper (brighter); off load they are soft
          const sharp = cfg.sharp * (0.55 + 0.75 * load + 0.25 * rev) * nc / 4;
          let b0 = 0, b1 = 0, env = 0;
          for (let k = 0; k < nc; k++) {
            let phi = this.ph - off[k]; if (phi < 0) phi += 1;
            if (phi < lastPhi[k]) {
              // new firing event: combustion varies cycle to cycle, more so at idle
              amp[k] = 1 + (this.rnd() - 0.5) * 2 * cfg.jitter * (1.6 - rev);
              if (p.throttle < 0.06 && rev > 0.45 && this.rnd() < cfg.pops * 0.09) this.pop = 0.9 + this.rnd() * 0.8;
            }
            lastPhi[k] = phi;
            const a = phi * sharp;
            const pulse = amp[k] * (a < 30 ? Math.exp(-a) * (1 - Math.exp(-a * 9)) : 0);
            env += pulse;
            if (bank[k]) b1 += pulse; else b0 += pulse;
          }
          // decel pops: short broadband bangs in the exhaust
          if (this.pop > 0.001) { const pv = this.pop * white * 1.6; b0 += pv; b1 += pv * 0.8; this.pop *= this.dPop; }
          // remove DC (running mean)
          z[0] += (b0 - z[0]) * 0.0006; z[1] += (b1 - z[1]) * 0.0006; b0 -= z[0]; b1 -= z[1];
          // collector / cross-over: how much the two banks share one exhaust
          if (cfg.merge > 0) { const m0 = b0 + cfg.merge * b1, m1 = b1 + cfg.merge * b0; b0 = m0 / (1 + cfg.merge); b1 = m1 / (1 + cfg.merge); }
          // exhaust pipe: feedback comb per bank (fixed resonances = the car's "voice")
          const i0 = this.dli, N0 = this.pipeN[0], N1 = this.pipeN[1];
          const r0 = d0[(i0 - N0) & 2047], r1 = d1[(i0 - N1) & 2047];
          const c0 = b0 - 0.42 * r0, c1 = b1 - 0.42 * r1;
          d0[i0] = c0; d1[i0] = c1; this.dli = (i0 + 1) & 2047;
          // formant band-passes
          let e0 = c0 * 0.35, e1 = c1 * 0.35;
          const bq = this.bq;
          for (let q = 0; q < bq.length; q++) {
            const f = bq[q], xx = f.b ? c1 : c0;
            const y = f.b0 * xx + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
            f.x2 = f.x1; f.x1 = xx; f.y2 = f.y1; f.y1 = y;
            if (f.b) e1 += y * f.g * 2.2; else e0 += y * f.g * 2.2;
          }
          // load-dependent saturation adds the hard edge of an engine under power
          const drive = cfg.drive * (0.35 + 1.0 * load + 0.4 * rev);
          e0 = Math.tanh(e0 * drive); e1 = Math.tanh(e1 * drive);
          // intake / mechanical noise, chopped by the firing envelope
          z[2] += (white * (0.25 + env) - z[2]) * 0.32; z[3] += (z[2] - z[3]) * 0.05;
          const intake = (z[2] - z[3]) * cfg.intake * (0.05 + 0.5 * p.throttle) * (0.3 + rev);
          // throttle-controlled tone: closed throttle is muffled
          const cut = Math.min(0.92, (0.035 + 0.5 * p.throttle * cfg.bright + 0.2 * rev * cfg.bright));
          z[4] += (e0 + intake - z[4]) * cut; z[5] += (e1 + intake - z[5]) * cut;
          const lvl = cfg.gain * (0.16 + 0.5 * load + 0.22 * rev + 0.1 * p.throttle) * 0.55;
          // single-bank engines are centred; twin-bank engines get stereo width
          if (this.two) { eL += (z[4] * 0.8 + z[5] * 0.35) * lvl; eR += (z[5] * 0.8 + z[4] * 0.35) * lvl; }
          else { eL += z[4] * lvl; eR += z[4] * lvl; }
        }

        if (cfg.turbo) {
          // compressor whistle rises with boost; blow-off valve vents on lift
          this.turboPh += (2600 + 6200 * p.boost) / sr; if (this.turboPh >= 1) this.turboPh -= 1;
          z[6] += (white - z[6]) * 0.5;
          const wh = (Math.sin(this.turboPh * TAU) * 0.6 + z[6] * 0.25) * p.boost * p.boost * 0.07 * cfg.turboGain;
          if (this.prevThrottle - t.throttle > 0.4 && p.boost > 0.45 && this.bov < 0.05) { this.bov = p.boost; this.bovF = 0.5; }
          if (this.bov > 0.001) {
            z[7] += (white - z[7]) * this.bovF; z[8] += (z[7] - z[8]) * this.bovF * 0.25;
            // flutter: the pressure wave chops the vent a few dozen times a second
            const fl = 0.65 + 0.35 * Math.sin(this.lfo2 * TAU * 5);
            const s = (z[7] - z[8]) * this.bov * 0.42 * fl * cfg.turboGain;
            eL += s; eR += s;
            this.bov *= this.dBov; this.bovF = Math.max(0.06, this.bovF * this.dBovF);
          }
          eL += wh; eR += wh;
        }
      } else {
        // ---------------- electric drive unit ----------------
        // motor electrical orders + reduction-gear mesh + inverter switching whine
        const f = p.rpm / 60, ld = Math.abs(p.motor), mPh = this.mPh;
        let s = 0;
        // k:      0 pole-pass  1 2x      2 gear mesh  3 mesh sideband
        const o0 = 4, o1 = 8.03, o2 = 23.9, o3 = 24.9;
        mPh[0] += f * o0 / sr; if (mPh[0] >= 1) mPh[0] -= 1;
        mPh[1] += f * o1 / sr; if (mPh[1] >= 1) mPh[1] -= 1;
        mPh[2] += f * o2 / sr; if (mPh[2] >= 1) mPh[2] -= 1;
        mPh[3] += f * o3 / sr; if (mPh[3] >= 1) mPh[3] -= 1;
        const roll = (fr) => fr > 9000 ? 0 : fr > 5000 ? (9000 - fr) / 4000 : 1;
        s += Math.sin(mPh[0] * TAU + 0.3 * Math.sin(mPh[1] * TAU)) * (0.05 + 0.14 * ld) * roll(f * o0);
        s += Math.sin(mPh[1] * TAU) * (0.02 + 0.07 * ld) * roll(f * o1);
        s += Math.sin(mPh[2] * TAU) * (0.012 + 0.05 * ld) * roll(f * o2);
        s += Math.sin(mPh[3] * TAU) * (0.004 + 0.02 * ld) * roll(f * o3);
        // inverter: fixed carrier with sidebands at the electrical frequency, audible mostly under torque
        mPh[4] += 8000 / sr; if (mPh[4] >= 1) mPh[4] -= 1;
        s += Math.sin(mPh[4] * TAU + 1.5 * Math.sin(mPh[0] * TAU)) * 0.012 * ld;
        // torque-dependent broadband "whoosh" of the gear train and cooling
        z[44] += (white - z[44]) * 0.25; z[45] += (z[44] - z[45]) * 0.03;
        s += (z[44] - z[45]) * (0.004 + 0.03 * ld) * Math.min(1, f / 80);
        const fade = Math.min(1, p.rpm / 400);
        eL += s * fade; eR += s * fade;
      }
      this.prevThrottle += (t.throttle - this.prevThrottle) * 0.002;
      this.lfo += 1 / sr; if (this.lfo >= 1) this.lfo -= 1;
      this.lfo2 += 7 / sr; if (this.lfo2 >= 1) this.lfo2 -= 1;

      // ---------------- straight-cut gear whine (race boxes) ----------------
      if (cfg.gearWhine > 0) {
        const f = p.wheelRps * cfg.whineTeeth;
        this.whinePh += f / sr; if (this.whinePh >= 1) this.whinePh -= 1;
        this.whinePh2 += f * 1.52 / sr; if (this.whinePh2 >= 1) this.whinePh2 -= 1;
        const g = cfg.gearWhine * Math.min(1, p.wheelRps / 12) * (0.35 + 0.65 * Math.abs(p.load)) * 0.045 * (1 + 1.2 * p.cockpit);
        // mesh tone with a little tooth-to-tooth roughness and its second harmonic
        const w1 = this.whinePh * TAU;
        const s = (Math.sin(w1 + 0.4 * z[12]) + 0.3 * Math.sin(2 * w1) + 0.45 * Math.sin(this.whinePh2 * TAU)) * g;
        eL += s; eR += s;
      }

      // cockpit: the cabin low-passes the engine and adds its own boom
      if (p.cockpit > 0.01) {
        z[46] += (eL - z[46]) * 0.16; z[47] += (z[46] - z[47]) * 0.16;
        z[48] += (eR - z[48]) * 0.16; z[49] += (z[48] - z[49]) * 0.16;
        eL += (z[47] * 1.25 - eL) * p.cockpit * 0.85; eR += (z[49] * 1.25 - eR) * p.cockpit * 0.85;
      }

      // ---------------- tyres, road, wind ----------------
      const v = p.speed;
      // squeal: a howling rubber resonance (two detuned narrow resonators excited by noise,
      // rough at the stick-slip rate), pitch falling as the tyre slides faster
      const sq = p.squeal * cfg.squealGain;
      if (sq > 0.001) {
        const sl = sq > 1 ? 1 : sq;
        z[50] += (white - z[50]) * 0.0007;                           // slow pitch wander
        const fq = 1020 - 330 * sl + z[50] * 2600;
        const f1 = 2 * Math.sin(3.14159 * fq / sr), f2 = 2 * Math.sin(3.14159 * fq * 1.37 / sr);
        const rough = 0.72 + 0.28 * Math.sin(this.lfo * TAU * 43 + 3 * z[50] * 60);
        const ex = white * rough;
        z[10] += f1 * z[11]; const h1 = ex * 0.14 - z[10] - 0.035 * z[11]; z[11] += f1 * h1;
        z[51] += f2 * z[52]; const h2 = ex * 0.10 - z[51] - 0.05 * z[52]; z[52] += f2 * h2;
        const a = sl * sl * (3 - 2 * sl) * 0.95 * (1 - 0.45 * p.cockpit);
        const s1 = Math.tanh(z[11] * 1.4) * a, s2 = Math.tanh(z[52] * 1.4) * a * 0.7;
        outL += s1 + s2 * 0.4; outR += s1 * 0.5 + s2;
      }
      // scrub: mid-band "shhh" of a loaded tyre below the squeal threshold
      z[53] += (white - z[53]) * 0.25; z[54] += (z[53] - z[54]) * 0.04;
      const scrub = (z[53] - z[54]) * p.scrub * 0.2;
      // tyre roll / road roar: low-passed noise, brighter and louder with speed
      const vr = v > 80 ? 1 : v / 80;
      z[12] += (white - z[12]) * (0.02 + 0.05 * vr); z[13] += (z[12] - z[13]) * 0.25; z[55] += (z[13] - z[55]) * 0.002;
      const roar = (z[13] - z[55]) * vr * (0.55 + 0.6 * p.cockpit) * (1 - p.tv);
      // grass: soft low rumble; gravel: rumble plus a spray of stones on the floor
      z[56] += (white - z[56]) * 0.018;
      let loose = z[56] * (p.grass * 1.3 + p.gravel * 1.6 + p.rough * 0.9);
      if (p.gravel > 0.01) {
        if (this.rnd() < p.gravel * (0.002 + 0.01 * vr)) this.grit = 0.4 + this.rnd() * 0.6;
        z[57] += 0.35 * z[58]; const hg = white * this.grit - z[57] - 0.4 * z[58]; z[58] += 0.35 * hg;
        loose += z[58] * 0.22 * p.gravel; this.grit *= 0.985;
      }
      // wind: noise low-passed lower than the tyres, level ~ v^2, slow buffeting; none on the TV camera
      z[14] += (white - z[14]) * (0.05 + 0.17 * vr); z[15] += (z[14] - z[15]) * 0.02;
      z[59] += (white - z[59]) * 0.0004;
      const wq = v * v / 6400;
      const wind = (z[14] - z[15]) * (wq > 1 ? 1 : wq) * 0.3 * (1 + z[59] * 18) * (1 - p.tv) * (1 - 0.35 * p.cockpit);
      // brakes: pad hiss on the disc
      z[60] += (white - z[60]) * 0.6; z[61] += (z[60] - z[61]) * 0.25;
      const brake = (z[60] - z[61]) * p.brake * (0.3 + 0.7 * vr) * 0.11;
      // kerb: serrations pass under the tyre at speed / pitch, shaking tyre and chassis
      let kerb = 0;
      if (p.kerb > 0.01) {
        this.kerbPh += Math.max(4, v / 0.55) / sr; if (this.kerbPh >= 1) this.kerbPh -= 1;
        const pulse = this.kerbPh < 0.3 ? 1 : -0.43;
        z[16] += (pulse - z[16]) * 0.06;
        // body boom excited by each serration
        z[62] += 0.012 * z[63]; const hk = pulse * 0.05 - z[62] - 0.12 * z[63]; z[63] += 0.012 * hk;
        kerb = (z[16] * 0.14 + z[63] * 0.3 + white * (pulse > 0 ? 0.02 : 0)) * p.kerb;
      }
      // impact: low thump + crunch of bodywork; gear change: damped mechanical knock
      let hit = 0;
      if (this.thump > 0.001) {
        this.thumpPh += (48 + 30 * this.thump) / sr; hit = Math.sin(this.thumpPh * TAU) * this.thump * 0.55;
        this.thump *= this.dThump;
      }
      if (this.crunch > 0.001) {
        z[64] += 0.22 * z[65]; const hc = white * this.crunch - z[64] - 0.9 * z[65]; z[65] += 0.22 * hc;
        hit += z[65] * 0.3; this.crunch *= this.dCrunch;
      }
      if (this.clunk > 0.001) {
        this.clunkPh += 1 / sr;
        z[17] += (white - z[17]) * 0.12;
        hit += (Math.sin(this.clunkPh * TAU * 190) * 0.5 + Math.sin(this.clunkPh * TAU * 870) * 0.25 + z[17] * 0.5) * this.clunk * 0.32;
        this.clunk *= this.dClunk;
      }
      const amb = scrub + roar + loose + wind + brake + kerb + hit;
      outL += amb + eL; outR += amb + eR;

      // master + soft limiter
      L[i] = Math.tanh(outL * p.master * 1.25);
      R[i] = Math.tanh(outR * p.master * 1.25);
    }
  }
}

// Sound-design presets per car (layout comes from the spec's engine.layout).
// `bankName` names the recorded-cycle bank in public/audio/ (see AUDIO.md).
export function audioConfigFor(spec) {
  const eng = (spec && spec.engine) || {};
  const all = RaceAudioSynth.layouts();
  const byCyl = { 3: 'I4', 4: 'I4', 5: 'I4', 6: 'F6', 8: 'V8X', 10: 'V10', 12: 'V10' };
  const base = all[eng.layout] || (eng.electric ? all.EV : all[byCyl[eng.cylinders]] || all.I4);
  const id = (spec && spec.id) || '';
  const extra = {
    hatch: { turbo: true, gearWhine: 0, squealGain: 1.0, bright: 0.7, bankGain: 0.9, bankName: 'hatch' },
    mini: { turbo: true, gearWhine: 0, squealGain: 1.05, bright: 0.6, turboGain: 0.6, pops: 0.08, bankGain: 0.72, gain: 0.75, bankName: 'mini' },
    coupe: { gearWhine: 0, squealGain: 1.1, bankName: 'coupe' },
    gt3: { gearWhine: 1.0, squealGain: 0.55, bankGain: 1.08, bankName: 'gt3' },
    f458: { gearWhine: 0.15, squealGain: 0.9, bankName: 'f458' },
    hypercar: { turbo: true, gearWhine: 1.0, squealGain: 0.45, whineTeeth: 37, turboGain: 1.3, bankName: 'hypercar' },
    lmp1: { turbo: true, gearWhine: 1.0, squealGain: 0.45, whineTeeth: 37, turboGain: 1.6, bright: 0.5 },   // no open turbodiesel race recording: synthesised
    formula: { gearWhine: 0.7, squealGain: 0.35, bankName: 'formula' },
    ev: { gearWhine: 0, squealGain: 1.0 },
  }[id] || {};
  if (eng.turbo && extra.turbo === undefined) extra.turbo = true;
  return Object.assign({}, base, extra, { id, redline: eng.redline || 7000 });
}

// Parse a bank file (WAV with an 'rsim' JSON chunk) -> { meta, pcm } or null.
// Lives outside the class: it runs on the main thread / in Node, not in the worklet.
export function parseBank(buf) {
  try {
    const dv = new DataView(buf), tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let o = 12, meta = null, pcm = null;
    while (o + 8 <= dv.byteLength) {
      const id = tag(o), len = dv.getUint32(o + 4, true), body = o + 8;
      if (id === 'rsim') { let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(body + i)); meta = JSON.parse(s); }
      else if (id === 'data') { const n = len >> 1; pcm = new Float32Array(n + 4); for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(body + i * 2, true) / 32768; }
      o = body + len + (len & 1);
    }
    if (!meta || !pcm) return null;
    // grains are stored peak-normalised; undo so that every band/state has unit RMS again
    const g = 1 / (meta.norm || 1); for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
    return { meta, pcm };
  } catch (e) { return null; }
}
