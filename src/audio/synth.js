// Procedural race-car audio. One self-contained class (no imports, no outer
// references) so the same code runs inside an AudioWorklet, a ScriptProcessor
// fallback and plain Node for the spectral tests.
//
// The engine voice is built the way the real sound is: every cylinder fires
// once per 720° cycle at its own crank offset, each firing is an exhaust
// pressure pulse, pulses are collected per cylinder bank and coloured by that
// bank's exhaust resonances. Firing order therefore shapes the sound exactly
// as it does on a real engine: an even-firing inline four buzzes at 2x crank
// speed, a flat-six howls at 3x, a V10 screams at 5x, and a cross-plane V8 —
// whose banks each fire unevenly — gets its off-beat burble for free.
export class RaceAudioSynth {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.ph = 0;
    this.seed = 22222;
    // smoothed parameters
    this.p = { rpm: 900, throttle: 0, load: 0, speed: 0, squeal: 0, scrub: 0, rough: 0, kerb: 0, boost: 0, wheelRps: 0, master: 0.8, motor: 0 };
    this.t = Object.assign({}, this.p);
    this.cfg = null;
    this.z = new Float64Array(64);        // misc filter state
    this.dl = [new Float32Array(2048), new Float32Array(2048)]; this.dli = 0;
    this.kerbPh = 0; this.whinePh = 0; this.whinePh2 = 0; this.turboPh = 0; this.mPh = [0, 0, 0];
    this.bov = 0; this.bovF = 0; this.thump = 0; this.thumpPh = 0; this.clunk = 0; this.pop = 0;
    this.prevThrottle = 0;
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
      V10: { off: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], bank: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1], sharp: 13, drive: 2.4, formants: [[310, 2.5, 0.7], [1150, 3.5, 1.0], [3600, 3, 0.75]], pipe: [1.7, 1.85], bright: 1.6, pops: 0.25, gain: 0.9, merge: 0.7, jitter: 0.04, intake: 1.0 },
      EV: { off: [], bank: [], sharp: 1, drive: 1, formants: [], pipe: [1, 1], bright: 1, pops: 0, gain: 0, jitter: 0, intake: 0, electric: true },
    };
  }

  configure(c) {
    const cfg = Object.assign({ turbo: false, gearWhine: 0, squealGain: 1, redline: 7000, merge: 0 }, c);
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
  }

  set(o) { for (const k in o) if (k in this.t) this.t[k] = o[k]; }
  trigger(name, amount) {
    if (name === 'impact') this.thump = Math.max(this.thump, Math.min(1.5, amount));
    else if (name === 'shift') this.clunk = Math.min(1, amount);
  }

  rnd() { let s = this.seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seed = s; return (s >>> 0) / 4294967296; }

  process(L, R, n) {
    const p = this.p, t = this.t, cfg = this.cfg, sr = this.sr, z = this.z;
    const nc = cfg.off.length, off = cfg.off, bank = cfg.bank, amp = this.amp, lastPhi = this.lastPhi;
    const kS = 1 - Math.exp(-1 / (0.03 * sr)), kR = 1 - Math.exp(-1 / (0.018 * sr));
    const d0 = this.dl[0], d1 = this.dl[1];
    for (let i = 0; i < n; i++) {
      p.rpm += (t.rpm - p.rpm) * kR;
      p.throttle += (t.throttle - p.throttle) * kS; p.load += (t.load - p.load) * kS;
      p.speed += (t.speed - p.speed) * kS; p.squeal += (t.squeal - p.squeal) * kS; p.scrub += (t.scrub - p.scrub) * kS;
      p.rough += (t.rough - p.rough) * kS; p.kerb += (t.kerb - p.kerb) * kS; p.boost += (t.boost - p.boost) * kS;
      p.wheelRps += (t.wheelRps - p.wheelRps) * kS; p.master += (t.master - p.master) * kS; p.motor += (t.motor - p.motor) * kS;
      const white = this.rnd() * 2 - 1;
      let outL = 0, outR = 0;

      // ---------------- combustion engine ----------------
      if (nc > 0) {
        const rev = p.rpm / cfg.redline;
        this.ph += p.rpm / 120 / sr; if (this.ph >= 1) this.ph -= 1;
        const load = p.load < 0 ? 0 : p.load;
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
        if (this.pop > 0.001) { const pv = this.pop * white * 1.6; b0 += pv; b1 += pv * 0.8; this.pop *= Math.exp(-1 / (0.012 * sr)); }
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
          const f = bq[q], x = f.b ? c1 : c0;
          const y = f.b0 * x + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
          f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
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
        const lvl = cfg.gain * (0.16 + 0.5 * load + 0.22 * rev + 0.1 * p.throttle);
        // single-bank engines are centred; twin-bank engines get stereo width
        const two = bank.indexOf(1) >= 0;
        if (two) { outL += (z[4] * 0.8 + z[5] * 0.35) * lvl; outR += (z[5] * 0.8 + z[4] * 0.35) * lvl; }
        else { outL += z[4] * lvl; outR += z[4] * lvl; }

        if (cfg.turbo) {
          // compressor whistle rises with boost; blow-off valve vents on lift
          this.turboPh += (2600 + 6200 * p.boost) / sr; if (this.turboPh >= 1) this.turboPh -= 1;
          z[6] += (white - z[6]) * 0.5;
          const wh = (Math.sin(this.turboPh * 6.2832) * 0.6 + z[6] * 0.25) * p.boost * p.boost * 0.05;
          if (this.prevThrottle - t.throttle > 0.4 && p.boost > 0.45 && this.bov < 0.05) { this.bov = p.boost; this.bovF = 0.5; }
          if (this.bov > 0.001) {
            z[7] += (white - z[7]) * this.bovF; z[8] += (z[7] - z[8]) * this.bovF * 0.25;
            const s = (z[7] - z[8]) * this.bov * 0.5;
            outL += s; outR += s;
            this.bov *= Math.exp(-1 / (0.16 * sr)); this.bovF = Math.max(0.06, this.bovF * Math.exp(-1 / (0.2 * sr)));
          }
          outL += wh; outR += wh;
        }
      } else {
        // ---------------- electric drive unit ----------------
        const f = p.rpm / 60, ld = Math.abs(p.motor);
        const orders = [4, 8.03, 23.9];
        const gains = [0.05 + 0.14 * ld, 0.02 + 0.07 * ld, 0.012 + 0.05 * ld];
        let s = 0;
        for (let k = 0; k < 3; k++) {
          this.mPh[k] += f * orders[k] / sr; if (this.mPh[k] >= 1) this.mPh[k] -= 1;
          const fr = f * orders[k];
          const roll = fr > 9000 ? 0 : fr > 5000 ? (9000 - fr) / 4000 : 1;
          s += Math.sin(this.mPh[k] * 6.2832 + (k === 0 ? 0.3 * Math.sin(this.mPh[1] * 6.2832) : 0)) * gains[k] * roll;
        }
        const fade = Math.min(1, p.rpm / 400);
        outL += s * fade; outR += s * fade;
      }
      this.prevThrottle += (t.throttle - this.prevThrottle) * 0.002;

      // ---------------- straight-cut gear whine (race boxes) ----------------
      if (cfg.gearWhine > 0) {
        const f = p.wheelRps * 41;
        this.whinePh += f / sr; if (this.whinePh >= 1) this.whinePh -= 1;
        this.whinePh2 += f * 1.52 / sr; if (this.whinePh2 >= 1) this.whinePh2 -= 1;
        const g = cfg.gearWhine * Math.min(1, p.wheelRps / 12) * (0.35 + 0.65 * Math.abs(p.load)) * 0.05;
        const s = (Math.sin(this.whinePh * 6.2832) + 0.45 * Math.sin(this.whinePh2 * 6.2832)) * g;
        outL += s; outR += s;
      }

      // ---------------- tyres, road, wind ----------------
      const v = p.speed;
      // squeal: resonant band of noise whose pitch falls as the tyre slides faster
      const sq = p.squeal * cfg.squealGain;
      if (sq > 0.001) {
        const fc = 2 * Math.sin(Math.PI * (1250 - 420 * Math.min(1, sq)) / sr);
        z[10] += fc * z[11]; const hp = white * 0.5 - z[10] - 0.06 * z[11]; z[11] += fc * hp;
        const s = Math.tanh(z[11] * 0.9) * sq * 0.2;
        outL += s * 0.95; outR += s * 1.05;
      }
      // scrub / road roar / loose-surface rumble (low-passed noise)
      z[12] += (white - z[12]) * 0.045; z[13] += (z[12] - z[13]) * 0.2;
      const roar = z[13] * (Math.min(1, v / 70) * 0.22 + p.scrub * 0.3 + p.rough * 0.9);
      // wind: band-limited hiss growing with v^2
      z[14] += (white - z[14]) * 0.22; z[15] += (z[14] - z[15]) * 0.02;
      const wind = (z[14] - z[15]) * Math.min(1, v * v / 6400) * 0.11;
      // kerb: serrations pass under the tyre at speed / pitch
      let kerb = 0;
      if (p.kerb > 0.01) {
        this.kerbPh += Math.max(4, v / 0.55) / sr; if (this.kerbPh >= 1) this.kerbPh -= 1;
        z[16] += ((this.kerbPh < 0.3 ? 1 : -0.43) - z[16]) * 0.06;
        kerb = z[16] * p.kerb * 0.3;
      }
      // impact thump and gear-change clunk
      let hit = 0;
      if (this.thump > 0.001) {
        this.thumpPh += 62 / sr; hit = (Math.sin(this.thumpPh * 6.2832) * 0.8 + white * 0.5) * this.thump * 0.6;
        this.thump *= Math.exp(-1 / (0.09 * sr));
      }
      if (this.clunk > 0.001) { z[17] += (white - z[17]) * 0.12; hit += z[17] * this.clunk * 0.5; this.clunk *= Math.exp(-1 / (0.014 * sr)); }
      const amb = roar + wind + kerb + hit;
      outL += amb; outR += amb;

      // master + soft limiter
      L[i] = Math.tanh(outL * p.master * 1.25);
      R[i] = Math.tanh(outR * p.master * 1.25);
    }
  }
}

// Sound-design presets per car (layout comes from the spec's engine.layout).
export function audioConfigFor(spec) {
  const base = RaceAudioSynth.layouts()[spec.engine.layout];
  const extra = {
    hatch: { turbo: true, gearWhine: 0, squealGain: 1.0, bright: 0.7 },
    coupe: { gearWhine: 0, squealGain: 1.1 },
    gt3: { gearWhine: 1.0, squealGain: 0.55 },
    f458: { gearWhine: 0.15, squealGain: 0.9 },
    formula: { gearWhine: 0.7, squealGain: 0.35 },
    ev: { gearWhine: 0, squealGain: 1.0 },
  }[spec.id] || {};
  return Object.assign({}, base, extra, { redline: spec.engine.redline });
}
