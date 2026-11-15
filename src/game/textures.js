// Procedural textures (no external assets): asphalt, grass, gravel, barriers.
import * as THREE from 'three';

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function finish(c, { repeat = [1, 1], srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Tileable value noise on a grid, used for height fields.
function noiseField(size, cells, r) {
  const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = x / size * cells, fy = y / size * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
    const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
    out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  return out;
}

function fbm(size, r, octaves = [4, 8, 16, 32, 64]) {
  const out = new Float32Array(size * size); let amp = 1, tot = 0;
  for (const c of octaves) { const f = noiseField(size, c, r); for (let i = 0; i < out.length; i++) out[i] += f[i] * amp; tot += amp; amp *= 0.55; }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

function normalFromHeight(h, size, strength) {
  const c = canvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
    const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
    let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const o = (y * size + x) * 4;
    img.data[o] = (nx * 0.5 + 0.5) * 255; img.data[o + 1] = (ny * 0.5 + 0.5) * 255; img.data[o + 2] = (nz * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// U runs across the track (edge to edge), V along it.
export function asphaltTextures(aniso) {
  const S = 512, r = rng(11);
  const c = canvas(S, S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  const big = fbm(S, r, [3, 6, 12]), fine = new Float32Array(S * S);
  for (let i = 0; i < fine.length; i++) fine[i] = r();
  const rc = canvas(S, S), rctx = rc.getContext('2d'), rimg = rctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, i = y * S + x, o = i * 4;
    // rubbered-in racing groove through the middle, dusty edges
    const groove = Math.exp(-Math.pow((u - 0.5) / 0.26, 2));
    let v = 58 + (big[i] - 0.5) * 9 + (fine[i] - 0.5) * 20 - groove * 13;
    const edge = Math.min(u, 1 - u);
    v += Math.max(0, 0.08 - edge) * 160;
    let R = v, G = v, B = v * 1.03;
    // painted white edge lines (slightly worn)
    if (edge > 0.012 && edge < 0.034) { const wv = 205 + (fine[i] - 0.5) * 50 - big[i] * 25; R = G = B = wv; }
    img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
    const rough = 0.86 - groove * 0.22 + (fine[i] - 0.5) * 0.12;
    rimg.data[o] = rimg.data[o + 1] = rimg.data[o + 2] = Math.max(0, Math.min(1, rough)) * 255; rimg.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0); rctx.putImageData(rimg, 0, 0);
  const h = new Float32Array(S * S); for (let i = 0; i < h.length; i++) h[i] = fine[i];
  return {
    map: finish(c, { aniso }),
    roughnessMap: finish(rc, { srgb: false, aniso }),
    normalMap: finish(normalFromHeight(h, S, 1.4), { srgb: false, aniso }),
  };
}

export function grassTexture(aniso) {
  const S = 256, r = rng(23), c = canvas(S, S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  const big = fbm(S, r, [4, 8, 16]);
  for (let i = 0; i < S * S; i++) {
    const n = r(), o = i * 4, b = big[i];
    img.data[o] = 52 + b * 42 + n * 22; img.data[o + 1] = 92 + b * 52 + n * 30; img.data[o + 2] = 30 + b * 20 + n * 12; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

export function gravelTexture(aniso) {
  const S = 256, r = rng(37), c = canvas(S, S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const n = r(), o = i * 4;
    img.data[o] = 150 + n * 70; img.data[o + 1] = 135 + n * 65; img.data[o + 2] = 105 + n * 60; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Plain asphalt tile (fallback when the photographic set is unavailable).
export function asphaltTile(aniso) {
  const S = 256, r = rng(11), c = canvas(S, S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  const big = fbm(S, r, [3, 6, 12]), fine = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) { fine[i] = r(); const v = 74 + (big[i] - 0.5) * 10 + (fine[i] - 0.5) * 26, o = i * 4; img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v * 1.03; img.data[o + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return { map: finish(c, { aniso }), normalMap: finish(normalFromHeight(fine, S, 1.2), { srgb: false, aniso }) };
}

// Armco: three galvanised W-beams. U runs up the barrier, V along it (one 4 m panel).
// The beam shape itself is geometry; the texture adds the centre groove, panel
// joints, bolts and weathering.
export function armcoTexture(aniso) {
  const W = 128, H = 512, c = canvas(W, H), ctx = c.getContext('2d'), r = rng(71);
  ctx.fillStyle = '#b9bdc0'; ctx.fillRect(0, 0, W, H);
  // galvanising streaks along the rail
  for (let k = 0; k < 900; k++) { const v = 150 + r() * 80; ctx.fillStyle = `rgba(${v},${v + 2},${v + 5},0.10)`; ctx.fillRect(r() * W, r() * H, 1 + r() * 2, 20 + r() * 120); }
  for (let b = 0; b < 3; b++) {
    const u0 = (b + 0.5) / 3 * W;
    const g = ctx.createLinearGradient(u0 - 6, 0, u0 + 6, 0);
    g.addColorStop(0, 'rgba(40,44,48,0)'); g.addColorStop(0.5, 'rgba(40,44,48,0.55)'); g.addColorStop(1, 'rgba(40,44,48,0)');
    ctx.fillStyle = g; ctx.fillRect(u0 - 6, 0, 12, H);                       // W groove
    ctx.fillStyle = 'rgba(30,32,34,0.75)'; ctx.fillRect(b / 3 * W - 1.5, 0, 3, H);  // gap between beams
    // rain streaks / grime under each beam
    const d = ctx.createLinearGradient(b / 3 * W, 0, b / 3 * W + 12, 0); d.addColorStop(0, 'rgba(60,50,35,0.35)'); d.addColorStop(1, 'rgba(60,50,35,0)');
    ctx.fillStyle = d; ctx.fillRect(b / 3 * W, 0, 12, H);
    // panel joint: overlap shadow + bolts
    ctx.fillStyle = 'rgba(20,22,24,0.55)'; ctx.fillRect(b / 3 * W, 0, W / 3, 3);
    ctx.fillStyle = 'rgba(235,238,240,0.5)'; ctx.fillRect(b / 3 * W, 3, W / 3, 2);
    for (const du of [-9, 9]) for (const v of [14, 30]) { ctx.fillStyle = '#4a4e52'; ctx.beginPath(); ctx.arc(u0 + du, v, 2.6, 0, 7); ctx.fill(); ctx.fillStyle = '#d5d8da'; ctx.beginPath(); ctx.arc(u0 + du - 0.6, v - 0.6, 1.2, 0, 7); ctx.fill(); }
  }
  // occasional rust blooms and tyre scuffs
  for (let k = 0; k < 26; k++) { const x = r() * W, y = r() * H, rad = 3 + r() * 9, g = ctx.createRadialGradient(x, y, 0, x, y, rad); const rust = r() < 0.6; g.addColorStop(0, rust ? 'rgba(110,62,30,0.45)' : 'rgba(15,15,15,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad * (rust ? 1 : 4), 2 * rad, 2 * rad * (rust ? 1 : 4)); }
  return finish(c, { aniso });
}

// Tyre wall: columns of stacked tyres. U runs up the wall, V along it (two columns).
export function tyreWallTexture(aniso) {
  const W = 256, H = 256, c = canvas(W, H), ctx = c.getContext('2d'), r = rng(9);
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H);
  const rows = 5, cols = 2, top = 0.86;              // u > top is the top face
  for (let col = 0; col < cols; col++) for (let row = 0; row < rows; row++) {
    const u0 = row / rows * top * W, u1 = (row + 1) / rows * top * W, v0 = col / cols * H, v1 = (col + 1) / cols * H;
    // tread face of one tyre: cylindrical shading across the column, darker gaps between tyres
    for (let y = Math.floor(v0); y < v1; y++) {
      const t = (y - v0) / (v1 - v0), sh = Math.pow(Math.sin(Math.PI * t), 0.6), v = 16 + 34 * sh + r() * 5;
      ctx.fillStyle = `rgb(${v},${v},${v + 1})`; ctx.fillRect(u0 + 2, y, u1 - u0 - 4, 1);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; for (let g = 0; g < 4; g++) ctx.fillRect(u0 + 2 + (g + 0.5) * (u1 - u0 - 4) / 4, v0 + 6, 1.5, v1 - v0 - 12); // tread grooves
    ctx.fillStyle = 'rgba(70,70,72,0.5)'; ctx.fillRect(u0 + 2, v0 + 2, 2.5, v1 - v0 - 4); ctx.fillRect(u1 - 4.5, v0 + 2, 2.5, v1 - v0 - 4);               // sidewall shoulders
  }
  // top face: looking down into the tyres
  for (let col = 0; col < cols; col++) {
    const cy = (col + 0.5) / cols * H, cx = (top + (1 - top) / 2) * W;
    ctx.fillStyle = '#262626'; ctx.fillRect(top * W, col / cols * H + 3, (1 - top) * W, H / cols - 6);
    ctx.fillStyle = '#020202'; ctx.beginPath(); ctx.ellipse(cx, cy, (1 - top) * W * 0.3, H / cols * 0.3, 0, 0, 7); ctx.fill();
  }
  return finish(c, { aniso });
}

// Debris fence: chain-link mesh with posts and cables. U along (one 3 m bay), V up.
export function fenceTexture(aniso) {
  const W = 256, H = 256, c = canvas(W, H), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(150,156,160,0.62)'; ctx.lineWidth = 1.1;
  for (let k = -H; k < W + H; k += 8) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + H, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(k, H); ctx.lineTo(k + H, 0); ctx.stroke(); }
  ctx.fillStyle = 'rgba(96,102,106,1)'; ctx.fillRect(0, 0, 7, H); ctx.fillRect(W - 3, 0, 3, H);
  ctx.fillStyle = 'rgba(120,126,130,0.95)'; for (const y of [3, 84, 168, 250]) ctx.fillRect(0, y, W, 3);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function concreteTexture(aniso) {
  const S = 128, r = rng(5), c = canvas(S, S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const n = r(), o = i * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 150 + n * 40; img.data[o + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return finish(c, { aniso });
}

// Soft radial sprite for smoke / dust particles.
export function puffTexture() {
  const S = 64, c = canvas(S, S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.4, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function labelTexture(text, { w = 256, h = 128, bg = '#111', fg = '#fff', font = 'bold 72px sans-serif' } = {}) {
  const c = canvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
