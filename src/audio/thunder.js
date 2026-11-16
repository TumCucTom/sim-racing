// Thunder as pure functions (no Web Audio): renderThunder() fills two Float32Arrays that
// the page plays through an AudioBufferSourceNode, so the exact same code can be rendered
// and measured in Node (tests/thunder.test.js, tools/thunder-render.mjs).
//
// Model: a lightning channel is a long, tortuous line source. Every piece of it emits the
// same short broadband pulse at the same instant; what the listener hears is those pulses
// arriving in order of distance. So one random channel (ground stroke, in-cloud leader,
// a few branches) gives everything at once:
//   - the nearest part arrives first and loudest: the crack (only bright when close);
//   - the rest arrives over (r_max - r_min) / c seconds: the 5-15 s rumble, swelling
//     whenever a stretch of channel lies at one range (irregular claps and rolls);
//   - later sound has travelled further, so the air has taken more of the top off:
//     the low-pass corner falls with arrival time and the spectrum sinks to 20-200 Hz;
//   - each piece has its own bearing: stereo spread, wide when close.
// A diffuse late tail (terrain and cloud echoes) is added from the running energy.
const C_SOUND = 343;

function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Random channel as points [x, y, z, strength]; listener at the origin, z up, metres.
function channel(rand, km) {
  const pts = [], az = rand() * 6.2832, gx = Math.cos(az) * km * 1000, gy = Math.sin(az) * km * 1000;
  const walk = (x, y, z, dx, dy, dz, len, strength) => {
    const step = 2.5; let kx = 0, ky = 0, kz = 0, next = 0, k = 1;
    for (let s = 0; s < len; s += step) {
      // tortuosity: a new kink every 20-150 m (these make the separate claps: a stretch that
      // happens to lie across the line of sight arrives all at once), plus metre-scale jitter
      if (s >= next) { kx = (rand() - 0.5) * 2.2; ky = (rand() - 0.5) * 2.2; kz = (rand() - 0.5) * 1.6; next = s + 20 + rand() * rand() * 260; k = 0.15 + 2.6 * rand() * rand() * rand() + 0.5 * rand(); }
      const ux = dx + kx + (rand() - 0.5) * 0.8, uy = dy + ky + (rand() - 0.5) * 0.8, uz = dz + kz + (rand() - 0.5) * 0.6;
      const l = Math.hypot(ux, uy, uz) || 1; x += ux / l * step; y += uy / l * step; z = Math.max(0, z + uz / l * step);
      pts.push([x, y, z, strength * k]);                              // k: the current (so the pulse energy) varies along the channel
    }
    return [x, y, z];
  };
  // return stroke: ground to the cloud base and into the cloud
  const top = 3000 + rand() * 2500, n0 = pts.length;
  const [tx, ty, tz] = walk(gx, gy, 0, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5, 1.5, top * 1.5, 1);
  // in-cloud leader: mostly horizontal, kilometres long (the long roll at the end)
  const a2 = rand() * 6.2832; walk(tx, ty, tz, Math.cos(a2) * 1.4, Math.sin(a2) * 1.4, 0.05, 1500 + rand() * 3500, 0.5);
  // branches off the lower half, heading down and out
  const nb = 2 + Math.floor(rand() * 3), nMain = Math.round((pts.length - n0) * 0.45);
  for (let b = 0; b < nb; b++) { const p = pts[n0 + Math.floor(rand() * nMain * 0.6 + nMain * 0.15)], a = rand() * 6.2832; walk(p[0], p[1], p[2], Math.cos(a), Math.sin(a), -0.7, 250 + rand() * 900, 0.3); }
  return { pts, az };
}

// One stroke, unnormalised, added into L / R starting at sample `at`. Returns the time its channel takes to arrive.
function stroke(L, R, sr, km, rand, at, gain) {
  const { pts, az } = channel(rand, km), n = L.length;
  let rmin = Infinity, rmax = 0; for (const p of pts) { const r = Math.hypot(p[0], p[1], p[2]); p[4] = r; if (r < rmin) rmin = r; if (r > rmax) rmax = r; }
  // acoustic energy arriving per sample at each ear (inverse-square spreading)
  const EL = new Float32Array(n), ER = new Float32Array(n);
  const look = az + (rand() - 0.5) * 2.4, fx = Math.cos(look), fy = Math.sin(look);
  for (const p of pts) {
    const r = p[4], i = at + Math.round((r - rmin) / C_SOUND * sr); if (i >= n) continue;
    const e = p[3] * Math.pow(rmin / r, 1.5);
    const pan = Math.max(-0.8, Math.min(0.8, (p[0] * fy - p[1] * fx) / r * 1.3)), th = (pan + 1) * 0.7854, cl = Math.cos(th), sn = Math.sin(th);
    EL[i] += e * cl * cl; ER[i] += e * sn * sn;
  }
  // The pulse itself lasts a few ms and lengthens with distance (dispersion, turbulence).
  const tau = 0.0025 + 0.010 * km * km, ks = 1 - Math.exp(-1 / (tau * sr)), dTail = Math.exp(-1 / (2.6 * sr));
  const hpK = Math.exp(-6.2832 * 24 / sr), lowK = 1 - Math.exp(-6.2832 * 80 / sr), tailK = 1 - Math.exp(-6.2832 * 200 / sr);
  // near strikes: a bright crack; from about 1.5 km on only the body is left
  const bright = Math.max(0, Math.min(1, (1.6 - km) / 1.1)), gB = 0.35 + 1.1 * bright, gL = 7, gT = 5;
  const st = [new Float64Array(12), new Float64Array(12)], E = [EL, ER], O = [L, R];
  let kb = 1;
  for (let i = at; i < n; i++) {
    if (((i - at) & 63) === 0) {
      // air absorption: the corner falls with the distance this sample has travelled
      const rk = (rmin + (i - at) / sr * C_SOUND) / 1000, fc = Math.max(70, Math.min(0.4 * sr, 2600 / (rk * rk)));
      kb = 1 - Math.exp(-6.2832 * fc / sr);
    }
    const common = rand() * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const s = st[c], e = E[c][i] * 0.85 + E[1 - c][i] * 0.15;
      s[0] += (e - s[0]) * ks; s[1] += (s[0] - s[1]) * 0.5;           // near-instant attack, tau decay
      s[2] = s[2] * dTail + e;                                        // diffuse late energy (terrain, cloud), about 2.6 s
      const w = 0.55 * common + 0.83 * (rand() * 2 - 1);              // partly shared noise: the crack has a place, the roll is wide
      const x = w * Math.sqrt(s[1]) * sr * 0.02, xt = (rand() * 2 - 1) * Math.sqrt(s[2] * sr) * 0.004;
      s[3] += (x - s[3]) * kb; s[4] += (s[3] - s[4]) * kb;            // bright part (the crack, the claps)
      s[5] += (x - s[5]) * lowK; s[6] += (s[5] - s[6]) * lowK;        // body: the 20-200 Hz that carries the rumble
      s[7] += (xt - s[7]) * tailK; s[8] += (s[7] - s[8]) * tailK;
      const y = gB * s[4] + gL * s[6] + gT * s[8];
      const h1 = hpK * (s[9] + y - s[10]); s[10] = y; const h2 = hpK * (s[11] + h1 - s[9]); s[9] = h1; s[11] = h2;   // nothing below ~24 Hz
      O[c][i] += h2 * gain;
    }
  }
  return (rmax - rmin) / C_SOUND;
}

// Buffer peak for a strike at `km`: near strikes are loud, far ones a soft rumble (about 15 dB less at 4 km).
export const thunderPeak = (km) => 0.9 * Math.pow(0.3 / Math.max(0.3, km), 0.65);

// options: sampleRate, km (0.3..4, distance of the ground strike), seed, double (a second
// stroke a moment later, somewhere else along the storm). Returns { left, right, sampleRate,
// duration (s), km, peak }.
export function renderThunder({ sampleRate = 24000, km = 1, seed = 1, double = false } = {}) {
  km = Math.max(0.3, Math.min(4, km));
  const rand = rng(seed), sr = sampleRate, n = Math.round(sr * 18), L = new Float32Array(n), R = new Float32Array(n);
  let span = stroke(L, R, sr, km, rand, 0, 1);
  if (double) {
    const km2 = Math.max(0.3, Math.min(4.5, km * (0.85 + 0.6 * rand()))), gap = 0.25 + rand() * 1.1 + Math.max(0, km2 - km) * 1000 / C_SOUND;
    span = Math.max(span, gap + stroke(L, R, sr, km2, rand, Math.round(gap * sr), 0.8));
  }
  // length: all of the channel has arrived, plus the diffuse tail
  const dur = Math.max(6, Math.min(18, span + 4.5)), m = Math.round(dur * sr), fade = Math.round(sr * 2);
  // A near crack is physically 20 dB and more above its own rumble, which would leave the roll under the
  // engine: lift the quiet parts with a slow gain that follows a peak-hold envelope (no pumping: 0.5 s release).
  const rel = Math.exp(-1 / (0.5 * sr)); let env = 0, ref = 0;
  for (let i = 0; i < m; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > ref) ref = a; }
  for (let i = 0; i < m; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); env = a > env ? a : env * rel + a * (1 - rel);
    const g = Math.min(6, Math.pow(Math.max(env, 1e-6) / ref, -0.45)); L[i] *= g; R[i] *= g;
  }
  let peak = 0; for (let i = 0; i < m; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > peak) peak = a; }
  const k = thunderPeak(km) / (peak || 1), left = L.subarray(0, m), right = R.subarray(0, m);
  for (let i = 0; i < m; i++) { const f = i > m - fade ? (m - i) / fade : 1, g = k * f * f; left[i] *= g; right[i] *= g; }
  return { left, right, sampleRate: sr, duration: dur, km, peak: thunderPeak(km) };
}
