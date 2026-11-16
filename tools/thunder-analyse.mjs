// Measurements on a rendered thunder strike { left, right, sampleRate }.
export function analyse({ left, right, sampleRate: sr }) {
  const n = left.length, mono = new Float32Array(n); let peak = 0, ipk = 0;
  for (let i = 0; i < n; i++) { mono[i] = 0.5 * (left[i] + right[i]); const a = Math.max(Math.abs(left[i]), Math.abs(right[i])); if (a > peak) { peak = a; ipk = i; } }
  const rms = (a, b) => { let e = 0; for (let i = a; i < b; i++) e += mono[i] * mono[i]; return Math.sqrt(e / Math.max(1, b - a)); };
  // envelope in 2 ms hops; onset = first hop above 5 % of the largest, rise = time from 10 % to 50 % of the first 150 ms maximum
  const hop = Math.round(sr * 0.002), env = []; for (let i = 0; i + hop <= n; i += hop) env.push(rms(i, i + hop));
  const emax = env.reduce((m, v) => Math.max(m, v), 0), on = env.findIndex(v => v > 0.05 * emax);
  const first = env.slice(on, on + 75), fmax = Math.max(...first), i10 = first.findIndex(v => v > 0.1 * fmax), i90 = first.findIndex(v => v > 0.5 * fmax);
  // duration: last 50 ms block above -40 dB re the loudest block
  const blk = Math.round(sr * 0.05), b = []; for (let i = 0; i + blk <= n; i += blk) b.push(rms(i, i + blk));
  const bmax = Math.max(...b); let last = 0; b.forEach((v, i) => { if (v > 0.01 * bmax) last = i; });
  // spectrum per window (Goertzel bank on log-spaced bands): centroid and share of energy in 20-200 Hz
  const bands = []; for (let f = 20; f < sr * 0.45; f *= 1.26) bands.push(f);
  const spec = (t0, t1) => {
    const a = Math.round(t0 * sr), z = Math.min(n, Math.round(t1 * sr)); if (z - a < 256) return null;
    let num = 0, den = 0, low = 0;
    for (let k = 0; k < bands.length; k++) {
      const f = bands[k], bw = f * 0.26, m = 5; let p = 0;                // average a few bins across the band
      for (let j = 0; j < m; j++) { const ff = f * (1 + 0.26 * (j / m)), w = 2 * Math.cos(6.2832 * ff / sr); let s1 = 0, s2 = 0; for (let i = a; i < z; i += 1) { const s0 = mono[i] + w * s1 - s2; s2 = s1; s1 = s0; } p += s1 * s1 + s2 * s2 - w * s1 * s2; }
      p = p / m * bw; num += p * f; den += p; if (f < 200) low += p;
    }
    return { centroid: Math.round(num / den), low: +(low / den).toFixed(2) };
  };
  const t0 = on * 0.002, cents = [[0, 0.15], [0.3, 1.3], [1.5, 3.5], [4, 7], [7, 11]].map(([a, z]) => spec(t0 + a, t0 + z)).filter(Boolean);
  // irregular amplitude modulation: spread of the 50 ms block levels (dB) over the rumble, after detrending
  const rb = b.slice(Math.round((t0 + 0.5) / 0.05), last).map(v => 20 * Math.log10(v + 1e-9)); let mod = 0;
  for (let i = 5; i < rb.length - 5; i++) { let m = 0; for (let j = -5; j <= 5; j++) m += rb[i + j]; mod += (rb[i] - m / 11) ** 2; }
  mod = Math.sqrt(mod / Math.max(1, rb.length - 10));
  // stereo: correlation of the two ears over the whole strike
  let ll = 0, rr = 0, lr = 0; for (let i = 0; i < n; i++) { ll += left[i] * left[i]; rr += right[i] * right[i]; lr += left[i] * right[i]; }
  return {
    peak: +peak.toFixed(3), peakAt: +(ipk / sr - t0).toFixed(3), riseMs: (i90 - i10) * 2, onsetS: +t0.toFixed(3), durS: +((last + 1) * 0.05 - t0).toFixed(1),
    crackDb: +(20 * Math.log10(rms(on * hop, on * hop + Math.round(0.08 * sr)) / (rms(Math.round((t0 + 1) * sr), Math.round((t0 + 4) * sr)) + 1e-9))).toFixed(1),
    centroidHz: cents.map(c => c.centroid), lowShare: cents.map(c => c.low), modDb: +mod.toFixed(1), rmsRumble: +rms(Math.round((t0 + 1) * sr), Math.round((t0 + 4) * sr)).toFixed(3), lrCorr: +(lr / Math.sqrt(ll * rr)).toFixed(2), balance: +(10 * Math.log10(ll / rr)).toFixed(1),
  };
}
