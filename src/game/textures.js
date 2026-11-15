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

// Armco barrier: two corrugated rails on posts.
export function armcoTexture(aniso) {
  const W = 256, H = 128, c = canvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#3c4138'; ctx.fillRect(0, 0, W, H);
  for (const y0 of [8, 62]) {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + 50);
    g.addColorStop(0, '#7d8388'); g.addColorStop(0.2, '#d6dade'); g.addColorStop(0.35, '#8d9398'); g.addColorStop(0.5, '#5d6368');
    g.addColorStop(0.65, '#8d9398'); g.addColorStop(0.8, '#cdd1d5'); g.addColorStop(1, '#6d7378');
    ctx.fillStyle = g; ctx.fillRect(0, y0, W, 50);
  }
  ctx.fillStyle = '#55595c'; ctx.fillRect(W / 2 - 5, 0, 10, H);
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, 2, H);
  return finish(c, { aniso });
}

export function tyreWallTexture(aniso) {
  const W = 128, H = 128, c = canvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, W, H);
  for (let row = 0; row < 4; row++) {
    const y = row * 32;
    const g = ctx.createLinearGradient(0, y, 0, y + 32);
    g.addColorStop(0, '#0a0a0a'); g.addColorStop(0.5, '#2e2e2e'); g.addColorStop(1, '#050505');
    ctx.fillStyle = g; ctx.fillRect(0, y, W, 30);
    for (let k = 0; k < 2; k++) { const x = (k + (row % 2) * 0.5) * 64; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(x + 32, y + 15, 26, 9, 0, 0, 7); ctx.fill(); }
  }
  ctx.fillStyle = '#c22'; ctx.fillRect(0, 0, W, 5);
  return finish(c, { aniso });
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
