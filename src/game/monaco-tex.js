// Procedural façade / surface atlas for Monaco: one texture array of albedo (+ tint mask in alpha) and one of
// normal xy, roughness and night-light mask. Every layer is drawn in metres on three canvases at once (colour,
// relief, properties); the relief gives the normal map and the baked contact shadows under balconies and cornices.
import * as THREE from 'three';
import { RNG } from '../sim/rng.js';

// layer ids
export const L = { BELLE: 0, PLAIN: 1, BANDS: 2, LOGGIA: 3, GLASS: 4, SHOPS: 5, ARCADE: 6, STONE: 7, CORNICE: 8, TILES: 9, ZINC: 10, BLANK: 11, HOTEL: 12, CROWD: 13, CONCRETE: 14, RUSTIC: 15, BELLE2: 16, PARAPET: 17, COPPER: 18, PALACE: 19 };
// metres covered by one repeat of each layer [w, h]
export const LSIZE = { 0: [12.8, 6.2], 1: [12.8, 6.2], 2: [12.8, 6.2], 3: [12.8, 6.2], 4: [12.8, 6.2], 5: [12.8, 4.2], 6: [12.8, 4.2], 7: [6.4, 6.4], 8: [12.8, 1.6], 9: [6.4, 6.4], 10: [12.8, 3.1], 11: [12.8, 6.2], 12: [12.8, 6.2], 13: [12.8, 6.4], 14: [6.4, 6.4], 15: [12.8, 4.2], 16: [12.8, 6.2], 17: [12.8, 1.6], 18: [6.4, 6.4], 19: [12.8, 6.2] };
const NL = 20;

class Painter {
  constructor(S, W, H, seed) {
    this.S = S; this.W = W; this.H = H; this.rng = new RNG(seed);
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d', { willReadFrequently: true }); x.setTransform(S / W, 0, 0, -S / H, 0, S); return x; };
    this.a = mk(); this.h = mk(); this.p = mk();
    this.fill('#eee9de', 0, 0.92, 1, 0);
  }
  zc(z) { const v = Math.max(0, Math.min(255, Math.round(128 + z * 254))); return `rgb(${v},${v},${v})`; }
  pc(r, t, e) { return `rgb(${Math.round(r * 255)},${Math.round(t * 255)},${Math.round(e * 255)})`; }
  fill(c, z, r, t, e) { this.box(0, 0, this.W, this.H, c, z, r, t, e); }
  // c: css colour, or [bottom, top] for a vertical gradient
  box(x, y, w, h, c, z = 0, r = 0.9, t = 0, e = 0) {
    const A = this.a;
    if (Array.isArray(c)) { const g = A.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, c[0]); g.addColorStop(1, c[1]); A.fillStyle = g; } else A.fillStyle = c;
    A.fillRect(x, y, w, h);
    if (z !== null) { this.h.fillStyle = this.zc(z); this.h.fillRect(x, y, w, h); }
    if (r !== null) { this.p.fillStyle = this.pc(r, t, e); this.p.fillRect(x, y, w, h); }
  }
  // same on all three canvases for an arbitrary path builder
  path(fn, c, z = 0, r = 0.9, t = 0, e = 0) {
    for (const [X, col] of [[this.a, c], [this.h, z === null ? null : this.zc(z)], [this.p, r === null ? null : this.pc(r, t, e)]]) { if (col === null) continue; X.fillStyle = col; X.beginPath(); fn(X); X.fill(); }
  }
  // fine texture on the colour only: streaks / speckle
  grime(n, col, w, h, alpha = 0.05) { const A = this.a, q = this.rng; for (let k = 0; k < n; k++) { A.fillStyle = col.replace('A', (alpha * (0.4 + q.next())).toFixed(3)); A.fillRect(q.next() * this.W, q.next() * this.H, w * (0.3 + q.next()), h * (0.3 + q.next())); } }
  text(s, x, y, hgt, col, maxW) { const A = this.a; A.save(); A.translate(x, y); A.scale(1, -1); A.fillStyle = col; A.font = `bold ${hgt}px Georgia, serif`; A.textAlign = 'center'; A.textBaseline = 'middle'; A.fillText(s, 0, 0, maxW); A.restore(); }
}

const GLASS = ['#1b2733', '#3d5568'], GLASS_L = ['#3a4654', '#7f97a8'];
const pane = (P, x, y, w, h, lit, z = -0.2, dark = false) => {
  const q = P.rng, cur = q.next();
  P.box(x, y, w, h, dark ? ['#11181f', '#26343f'] : cur < 0.3 ? GLASS_L : GLASS, z, 0.07, 0, lit ? 0.5 + 0.5 * q.next() : 0);
  if (cur > 0.72) P.box(x, y, w, h, 'rgba(226,218,200,0.5)', null, 0.5, 0, lit ? 0.9 : 0);                  // drawn curtain
  else if (cur > 0.5) { P.box(x, y, w * 0.28, h, 'rgba(226,218,200,0.55)', null, null); P.box(x + w * 0.72, y, w * 0.28, h, 'rgba(226,218,200,0.55)', null, null); }
};
const louvres = (P, x, y, w, h, col, z) => { P.box(x, y, w, h, col, z, 0.7, 0, 0); const A = P.a; A.fillStyle = 'rgba(0,0,0,0.28)'; for (let v = y + 0.05; v < y + h - 0.03; v += 0.075) A.fillRect(x + 0.04, v, w - 0.08, 0.028); A.fillStyle = 'rgba(255,255,255,0.1)'; A.fillRect(x, y + h - 0.03, w, 0.03); };
const railing = (P, x, y, w, h, z, col = '#1d1d20') => {
  P.box(x, y + h - 0.05, w, 0.05, col, z, 0.5, 0, 0); P.box(x, y, w, 0.04, col, z, 0.5, 0, 0);
  for (let u = x; u < x + w; u += 0.115) P.box(u, y, 0.028, h, col, z, 0.5, 0, 0);
  for (let u = x + 0.3; u < x + w - 0.2; u += 0.69) P.path(X => { X.ellipse(u, y + h * 0.5, 0.11, h * 0.3, 0, 0, 7); X.ellipse(u, y + h * 0.5, 0.07, h * 0.22, 0, 0, 7); }, col, null, null);
};
const awning = (P, x, y, w, h, c1, c2) => { const n = Math.round(w / 0.22); for (let k = 0; k < n; k++) P.box(x + k * w / n, y, w / n + 0.005, h, k % 2 ? c1 : c2, 0.34, 0.85, 0, 0); P.box(x, y, w, 0.07, 'rgba(0,0,0,0.18)', 0.36, null); const A = P.a, g = A.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, 'rgba(0,0,0,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0.08)'); A.fillStyle = g; A.fillRect(x, y, w, h); };
const plants = (P, x, y, w) => { const q = P.rng; for (let k = 0; k < 9; k++) { const u = x + q.next() * w, r = 0.1 + q.next() * 0.14; P.path(X => X.arc(u, y + r * 0.6, r, 0, 7), `hsl(${95 + q.int(40)},${35 + q.int(25)}%,${18 + q.int(16)}%)`, 0.42, 0.95, 0, 0); } };

const AWN = [['#b4412c', '#efe6d4'], ['#2f5d7c', '#efe6d4'], ['#c98a2b', '#f1e3c0'], ['#4d6b4a', '#e8e2cf'], ['#8c2f39', '#8c2f39'], ['#d9cfb8', '#d9cfb8']];
const SIGNS = ['CAFÉ RIVA', 'TABAC', 'PHARMACIE', 'GALERIE AZUR', 'BOULANGERIE', 'FLEURS', 'OPTIQUE', 'LE PETIT PORT', 'BIJOUX', 'GLACIER', 'LIBRAIRIE', 'CHEZ NINO', 'BAR DU QUAI', 'COIFFURE', 'MODE', 'PRESSE'];

function drawLayer(id, S) {
  const [W, H] = LSIZE[id], P = new Painter(S, W, H, 9100 + id * 37), q = P.rng, A = P.a;
  const BW = 3.2, FH = 3.1;
  const stucco = () => { P.fill('#ece6da', 0, 0.93, 1, 0); P.grime(260, 'rgba(120,105,85,A)', 0.25, 1.6, 0.045); P.grime(500, 'rgba(255,255,255,A)', 0.5, 0.2, 0.05); };
  switch (id) {
    case L.BELLE: case L.BELLE2: {
      stucco();
      const shCol = id === L.BELLE ? ['#5c7868', '#6b8191', '#5c7868', '#7a8a6c'] : ['#8a8f8f', '#d9d6cc', '#7d6a55', '#8a8f8f'];
      for (let f = 0; f < 2; f++) {
        const y0 = f * FH;
        P.box(0, y0, W, 0.2, '#f6f2ea', 0.09, 0.85, 0.25, 0); P.box(0, y0 + 0.2, W, 0.05, '#d8d2c6', 0.05, 0.85, 0.25, 0);       // string course
        for (let b = 0; b < 4; b++) {
          const x0 = b * BW, ww = 1.16, wx = x0 + (BW - ww) / 2, wy = y0 + 0.42, wh = 2.2, lit = q.next() < 0.4, st = q.next();
          P.box(wx - 0.16, wy - 0.06, ww + 0.32, wh + 0.2, '#f7f3ec', 0.05, 0.85, 0.2, 0);                                  // surround
          if (id === L.BELLE2) P.path(X => { X.moveTo(wx - 0.3, wy + wh + 0.14); X.lineTo(wx + ww / 2, wy + wh + 0.5); X.lineTo(wx + ww + 0.3, wy + wh + 0.14); }, '#f7f3ec', 0.12, 0.85, 0.2, 0);
          else { P.box(wx - 0.24, wy + wh + 0.14, ww + 0.48, 0.13, '#faf7f1', 0.14, 0.85, 0.2, 0); P.box(wx + ww / 2 - 0.1, wy + wh - 0.02, 0.2, 0.3, '#faf7f1', 0.16, 0.85, 0.2, 0); }
          pane(P, wx, wy, ww, wh, lit, -0.2);
          P.box(wx + ww / 2 - 0.025, wy, 0.05, wh, '#efeae0', -0.15, 0.6, 0, 0); for (const v of [0.72, 1.44]) P.box(wx, wy + v, ww, 0.035, '#efeae0', -0.15, 0.6, 0, 0);
          const sc = shCol[(b + f * 2) % 4];
          if (st < 0.2) { louvres(P, wx, wy, ww / 2 - 0.01, wh, sc, -0.08); louvres(P, wx + ww / 2 + 0.01, wy, ww / 2 - 0.01, wh, sc, -0.08); }           // closed
          else if (st < 0.86) { louvres(P, wx - 0.6, wy, 0.56, wh, sc, 0.06); louvres(P, wx + ww + 0.04, wy, 0.56, wh, sc, 0.06); }
          // balcony: full on the first of the two floors, a Juliet rail on the other
          if (f === 0) { P.box(x0 + 0.42, y0 + 0.22, BW - 0.84, 0.14, '#e9e4da', 0.42, 0.85, 0.3, 0); for (const u of [x0 + 0.6, x0 + BW - 0.78]) P.box(u, y0 + 0.02, 0.18, 0.2, '#ddd7cb', 0.3, 0.85, 0.3, 0); railing(P, x0 + 0.45, y0 + 0.36, BW - 0.9, 0.95, 0.4); }
          else railing(P, wx - 0.05, wy, ww + 0.1, 0.92, 0.02);
        }
      }
      break;
    }
    case L.PLAIN: {
      stucco();
      for (let f = 0; f < 2; f++) for (let b = 0; b < 4; b++) {
        const x0 = b * BW, y0 = f * FH, big = (b + f) % 2 === 0, ww = big ? 1.9 : 1.2, wx = x0 + (BW - ww) / 2, wy = y0 + (big ? 0.3 : 1.0), wh = big ? 2.25 : 1.45, lit = q.next() < 0.4;
        pane(P, wx, wy, ww, wh, lit, -0.22);
        P.box(wx + ww / 2 - 0.02, wy, 0.04, wh, '#dcd8cf', -0.16, 0.6, 0, 0);
        const dn = q.next(); if (dn > 0.35) { const sh = wh * (0.25 + 0.75 * q.next() * (dn > 0.8 ? 1 : 0.5)); P.box(wx, wy + wh - sh, ww, sh, '#c9c5bb', -0.1, 0.7, 0, 0); A.fillStyle = 'rgba(0,0,0,0.16)'; for (let v = wy + wh - sh; v < wy + wh; v += 0.06) A.fillRect(wx, v, ww, 0.018); }
        P.box(wx - 0.06, wy - 0.08, ww + 0.12, 0.08, '#f4f0e8', 0.06, 0.85, 0.3, 0);
        if (big) { P.box(x0 + 0.25, y0 + 0.1, BW - 0.5, 0.16, '#e6e1d6', 0.5, 0.88, 0.5, 0); if (q.next() < 0.5) { P.box(x0 + 0.25, y0 + 0.26, BW - 0.5, 0.9, '#ebe6db', 0.48, 0.9, 0.8, 0); P.box(x0 + 0.25, y0 + 1.12, BW - 0.5, 0.05, '#f6f3ec', 0.5, 0.8, 0.3, 0); } else railing(P, x0 + 0.27, y0 + 0.26, BW - 0.54, 0.92, 0.48, '#2a2c30'); if (q.next() < 0.45) plants(P, x0 + 0.4, y0 + 1.0, BW - 0.8); if (q.next() < 0.4) { const c = AWN[q.int(AWN.length)]; awning(P, wx - 0.15, wy + wh - 0.5, ww + 0.3, 0.55, c[0], c[1]); } }
      }
      break;
    }
    case L.BANDS: {
      P.fill('#2b3640', -0.5, 0.2, 0, 0);
      for (let f = 0; f < 2; f++) {
        const y0 = f * FH;
        for (let k = 0; k < 8; k++) { const x = k * 1.6, lit = q.next() < 0.33, cur = q.next(); P.box(x + 0.05, y0 + 0.3, 1.5, 2.5, cur < 0.5 ? ['#2a3540', '#4e6272'] : ['#34414c', '#5d7282'], -0.5, 0.08, 0, lit ? 0.5 + 0.5 * q.next() : 0); if (cur > 0.55) P.box(x + 0.05, y0 + 0.3, 1.5 * (cur > 0.8 ? 1 : 0.45), 2.5, 'rgba(232,226,210,0.62)', null, 0.6, 0, lit ? 0.9 : 0); P.box(x, y0 + 0.3, 0.06, 2.5, '#a9adb1', -0.46, 0.4, 0, 0); }
        P.box(0, y0 + 2.86, W, 0.24, ['#161b21', '#2a333c'], -0.3, 0.9, 0, 0);                                          // soffit shadow
        P.box(0, y0 - 0.04, W, 0.36, '#f4f0e8', 0.5, 0.9, 0.6, 0); P.box(0, y0 + 0.3, W, 0.03, '#cfcabf', 0.5, 0.9, 0.5, 0);    // slab edge
        for (let k = 0; k < 4; k++) {
          const x = k * BW, solid = (k + f) % 2 === 1;
          if (solid) P.box(x + 0.03, y0 + 0.32, BW - 0.06, 0.98, '#efebe2', 0.48, 0.9, 0.7, 0);
          else { P.box(x + 0.03, y0 + 0.32, BW - 0.06, 0.98, 'rgba(176,208,210,0.78)', 0.46, 0.06, 0, 0); P.box(x + 0.03, y0 + 0.32, BW - 0.06, 0.98, ['rgba(255,255,255,0.0)', 'rgba(255,255,255,0.2)'], null, null); }
          P.box(x, y0 + 1.28, BW, 0.06, '#e2e5e6', 0.5, 0.3, 0, 0); P.box(x, y0 + 0.32, 0.05, 0.98, '#d0d3d5', 0.5, 0.3, 0, 0);
          if (q.next() < 0.4) plants(P, x + 0.2, y0 + 1.15, BW - 0.4);
          if (q.next() < 0.3) { const c = AWN[q.int(AWN.length)]; awning(P, x + 0.1, y0 + 2.2, BW - 0.2, 0.6, c[0], c[1]); }
        }
        for (const x of [0, 6.4]) P.box(x - 0.14, y0, 0.28, FH, '#efebe2', 0.52, 0.9, 0.7, 0);
      }
      break;
    }
    case L.LOGGIA: {
      stucco();
      for (let f = 0; f < 2; f++) for (let b = 0; b < 4; b++) {
        const x0 = b * BW, y0 = f * FH, lit = q.next() < 0.36;
        P.box(x0 + 0.22, y0 + 0.3, BW - 0.44, FH - 0.55, ['#2a323a', '#161b20'], -0.5, 0.5, 0, 0);
        pane(P, x0 + 0.5, y0 + 0.34, BW - 1.0, FH - 0.9, lit, -0.5, true);
        P.box(x0 + BW / 2 - 0.03, y0 + 0.34, 0.06, FH - 0.9, '#9a9da1', -0.46, 0.4, 0, 0);
        if ((b + f) % 3 !== 0) P.box(x0 + 0.22, y0 + 0.3, BW - 0.44, 1.0, '#e9e4d9', 0.02, 0.9, 0.8, 0); else railing(P, x0 + 0.22, y0 + 0.3, BW - 0.44, 1.0, 0.0, '#34373c');
        if (q.next() < 0.35) plants(P, x0 + 0.4, y0 + 1.2, BW - 0.8);
        if (q.next() < 0.25) { const c = AWN[q.int(AWN.length)]; awning(P, x0 + 0.22, y0 + FH - 0.85, BW - 0.44, 0.6, c[0], c[1]); }
      }
      break;
    }
    case L.GLASS: {
      P.fill('#2c4854', -0.05, 0.05, 0, 0);
      for (let f = 0; f < 2; f++) { const y0 = f * FH; for (let k = 0; k < 8; k++) { const x = k * 1.6, lit = q.next() < 0.3; P.box(x, y0 + 0.9, 1.6, FH - 0.9, [`hsl(${190 + q.int(16)},${22 + q.int(10)}%,${18 + q.int(8)}%)`, `hsl(${196 + q.int(12)},${26 + q.int(10)}%,${32 + q.int(10)}%)`], -0.05, 0.05, 0, lit ? 0.6 : 0); P.box(x, y0, 1.6, 0.9, '#1d2c33', -0.03, 0.12, 0, 0); P.box(x - 0.03, y0, 0.06, FH, '#aeb4b8', 0.03, 0.3, 0, 0); } P.box(0, y0 + 0.87, W, 0.05, '#aeb4b8', 0.03, 0.3, 0, 0); P.box(0, y0 - 0.03, W, 0.06, '#aeb4b8', 0.03, 0.3, 0, 0); }
      break;
    }
    case L.SHOPS: {
      P.fill('#e2dccf', 0, 0.92, 0.85, 0); P.grime(150, 'rgba(90,80,65,A)', 0.3, 1.2, 0.06);
      P.box(0, 0, W, 0.35, '#8f8a80', 0.04, 0.8, 0.2, 0);                                                                   // plinth
      P.box(0, H - 0.3, W, 0.3, '#f4f0e8', 0.12, 0.85, 0.3, 0);
      for (let b = 0; b < 4; b++) {
        const x0 = b * BW, door = b === 2;
        if (door) { P.box(x0 + 0.9, 0, 1.4, 3.0, '#f1ece2', 0.06, 0.85, 0.3, 0); P.box(x0 + 1.02, 0, 1.16, 2.85, ['#2b1f18', '#3d2c22'], -0.25, 0.4, 0, 0); P.box(x0 + 1.02, 2.2, 1.16, 0.65, GLASS, -0.25, 0.08, 0, 0.5); P.box(x0 + 1.58, 0, 0.04, 2.2, '#17110d', -0.2, 0.5, 0, 0); continue; }
        const c = AWN[q.int(AWN.length)], lit = q.next() < 0.75;
        P.box(x0 + 0.22, 0.35, BW - 0.44, 2.75, '#22262a', -0.12, 0.5, 0, 0);
        P.box(x0 + 0.3, 0.45, BW - 0.6, 2.2, ['#3a3128', '#6d6253'], -0.3, 0.06, 0, lit ? 0.8 : 0.1);
        for (let k = 0; k < 6; k++) P.box(x0 + 0.4 + q.next() * (BW - 1.1), 0.5 + q.next() * 1.0, 0.2 + q.next() * 0.3, 0.3 + q.next() * 0.5, `hsl(${q.int(360)},${20 + q.int(40)}%,${30 + q.int(40)}%)`, null, null);
        P.box(x0 + BW / 2 - 0.03, 0.45, 0.06, 2.2, '#22262a', -0.12, 0.5, 0, 0);
        P.box(x0 + 0.22, 3.1, BW - 0.44, 0.55, c[0], 0.1, 0.6, 0, 0.25); P.text(SIGNS[(b * 5 + q.int(SIGNS.length)) % SIGNS.length], x0 + BW / 2, 3.38, 0.34, c[1] === c[0] ? '#f1e9d6' : c[1], BW - 0.7);
        if (q.next() < 0.7) awning(P, x0 + 0.15, 2.45, BW - 0.3, 0.7, c[0], c[1]);
      }
      break;
    }
    case L.ARCADE: case L.RUSTIC: {
      P.fill('#e6e0d3', 0, 0.9, 0.7, 0);
      for (let v = 0.0; v < H; v += 0.42) { P.box(0, v, W, 0.035, '#b9b2a4', -0.06, 0.9, 0.5, 0); for (let u = (Math.round(v / 0.42) % 2) * 0.6; u < W; u += 1.2) P.box(u, v, 0.035, 0.42, '#bdb6a8', -0.06, 0.9, 0.5, 0); }
      P.grime(160, 'rgba(100,90,70,A)', 0.4, 0.5, 0.06);
      P.box(0, 0, W, 0.4, '#9d978b', 0.05, 0.85, 0.3, 0); P.box(0, H - 0.25, W, 0.25, '#f4f0e8', 0.14, 0.85, 0.3, 0);
      for (let b = 0; b < 4; b++) {
        const x0 = b * BW, cx = x0 + BW / 2, hw = id === L.ARCADE ? 1.15 : 0.7, top = id === L.ARCADE ? 2.5 : 2.3, lit = q.next() < 0.6;
        const arch = (X, g) => { X.moveTo(cx - hw - g, 0.4); X.lineTo(cx - hw - g, top); X.arc(cx, top, hw + g, Math.PI, 0, true); X.lineTo(cx + hw + g, 0.4); };
        P.path(X => arch(X, 0.16), '#f5f1e9', 0.08, 0.85, 0.3, 0);
        P.path(X => arch(X, 0), '#14181c', -0.45, 0.4, 0, 0);
        if (id === L.ARCADE) { P.box(cx - hw + 0.12, 0.45, 2 * hw - 0.24, 1.95, ['#3b3229', '#6f6455'], -0.45, 0.07, 0, lit ? 0.8 : 0.1); P.box(cx - 0.03, 0.45, 0.06, 1.95, '#1d2125', -0.4, 0.5, 0, 0); for (let k = 0; k < 5; k++) P.box(cx - hw + 0.2 + q.next() * (2 * hw - 0.8), 0.5 + q.next() * 0.8, 0.25, 0.4, `hsl(${q.int(360)},${30 + q.int(30)}%,${35 + q.int(35)}%)`, null, null); if (q.next() < 0.6) { const c = AWN[q.int(AWN.length)]; awning(P, cx - hw, 2.2, 2 * hw, 0.5, c[0], c[1]); } }
        else { pane(P, cx - hw + 0.08, 1.0, 2 * hw - 0.16, top - 0.6, lit, -0.4); P.box(cx - 0.025, 1.0, 0.05, top - 0.6, '#ece7dc', -0.36, 0.6, 0, 0); P.box(cx - hw - 0.05, 0.92, 2 * hw + 0.1, 0.08, '#f4f0e8', 0.1, 0.85, 0.3, 0); railing(P, cx - hw, 1.0, 2 * hw, 0.8, -0.05); }
      }
      break;
    }
    case L.STONE: {
      P.fill('#b9ad98', 0, 0.95, 0.35, 0);
      let v = 0; while (v < H) { const ch = [0.32, 0.4, 0.4, 0.53][q.int(4)], hh = Math.min(ch, H - v); let u = -q.next() * 0.6; while (u < W) { const bw = 0.45 + q.next() * 0.75, l = 62 + q.int(16); P.box(u + 0.015, v + 0.015, bw - 0.03, hh - 0.03, `hsl(${34 + q.int(10)},${14 + q.int(12)}%,${l}%)`, 0.03 + q.next() * 0.05, 0.95, 0.35, 0); u += bw; } P.box(0, v, W, 0.018, '#6f675a', -0.05, 0.95, 0.2, 0); v += ch; }
      P.grime(300, 'rgba(60,55,40,A)', 0.2, 1.4, 0.07); P.grime(120, 'rgba(70,90,50,A)', 0.5, 0.3, 0.05);
      break;
    }
    case L.CORNICE: case L.PARAPET: {
      stucco();
      if (id === L.CORNICE) {
        P.box(0, 0.0, W, 0.2, '#f4f0e8', 0.06, 0.85, 0.3, 0);
        for (let u = 0.05; u < W; u += 0.32) P.box(u, 0.38, 0.16, 0.2, '#f1ede4', 0.2, 0.85, 0.3, 0);                        // dentils
        P.box(0, 0.58, W, 0.14, '#f8f5ef', 0.34, 0.85, 0.3, 0); P.box(0, 0.72, W, 0.1, '#ffffff', 0.46, 0.85, 0.3, 0);
        P.box(0, 0.82, W, 0.1, '#e9e4da', 0.1, 0.85, 0.3, 0);
        for (let u = 0.1; u < W; u += 0.2) P.path(X => X.ellipse(u, 1.2, 0.055, 0.25, 0, 0, 7), '#f1ede4', 0.12, 0.85, 0.3, 0);   // balusters
        for (let u = 0; u < W; u += 3.2) P.box(u - 0.2, 0.9, 0.4, 0.62, '#f4f0e8', 0.16, 0.85, 0.3, 0);
        P.box(0, 1.48, W, 0.12, '#faf8f3', 0.2, 0.85, 0.3, 0);
        // gaps between balusters read dark
        A.globalCompositeOperation = 'destination-over'; A.globalCompositeOperation = 'source-over';
      } else { P.box(0, 0.0, W, 0.12, '#d9d3c7', 0.05, 0.9, 0.5, 0); P.box(0, 1.42, W, 0.18, '#f3efe7', 0.14, 0.85, 0.4, 0); P.box(0, 1.36, W, 0.06, '#cfc9bd', 0.08, 0.9, 0.4, 0); }
      break;
    }
    case L.TILES: {
      P.fill('#a8583a', 0, 0.9, 0.5, 0);
      for (let u = 0; u < W; u += 0.2) for (let v = 0; v < H; v += 0.4) { const l = 36 + q.int(18); P.box(u, v, 0.115, 0.4, `hsl(${12 + q.int(12)},${42 + q.int(20)}%,${l}%)`, 0.05, 0.9, 0.5, 0); P.box(u + 0.115, v, 0.085, 0.4, `hsl(${12 + q.int(8)},${38 + q.int(14)}%,${l - 14}%)`, -0.02, 0.9, 0.5, 0); P.box(u, v, 0.2, 0.03, 'rgba(40,20,10,0.35)', -0.02, null); }
      P.grime(160, 'rgba(60,50,30,A)', 0.4, 0.8, 0.08); P.grime(60, 'rgba(210,200,170,A)', 0.3, 0.5, 0.06);
      break;
    }
    case L.ZINC: case L.COPPER: {
      const cu = id === L.COPPER;
      P.fill(cu ? '#6fa391' : '#7d8890', 0, cu ? 0.75 : 0.45, 0, 0);
      for (let u = 0; u < W; u += cu ? 0.5 : 0.64) { P.box(u, 0, 0.03, H, cu ? '#92bfae' : '#9aa5ad', 0.05, 0.4, 0, 0); P.box(u + 0.03, 0, 0.03, H, cu ? '#4e7c6c' : '#5c666e', -0.02, 0.5, 0, 0); }
      P.grime(200, cu ? 'rgba(40,70,60,A)' : 'rgba(40,45,50,A)', 0.5, 1.2, 0.08); P.grime(120, 'rgba(230,240,240,A)', 0.4, 0.6, 0.05);
      if (!cu) for (let b = 0; b < 4; b++) { const x0 = b * BW + 0.95, lit = q.next() < 0.4; P.box(x0 - 0.12, 0.55, 1.54, 1.95, '#eeeae0', 0.3, 0.85, 0.3, 0); P.path(X => { X.moveTo(x0 - 0.25, 2.5); X.lineTo(x0 + 0.65, 2.95); X.lineTo(x0 + 1.55, 2.5); }, '#68727a', 0.36, 0.5, 0, 0); pane(P, x0 + 0.1, 0.7, 1.1, 1.6, lit, 0.1); P.box(x0 + 0.625, 0.7, 0.05, 1.6, '#eeeae0', 0.14, 0.6, 0, 0); }
      break;
    }
    case L.BLANK: { stucco(); P.grime(40, 'rgba(90,80,60,A)', 0.3, 3.5, 0.06); for (let f = 0; f < 2; f++) P.box(0, f * FH, W, 0.14, '#f2eee6', 0.05, 0.88, 0.4, 0); break; }
    case L.HOTEL: {
      stucco();
      for (let f = 0; f < 2; f++) for (let b = 0; b < 4; b++) {
        const x0 = b * BW, y0 = f * FH, cx = x0 + BW / 2, lit = q.next() < 0.45;
        P.path(X => { X.moveTo(x0 + 0.2, y0 + 0.28); X.lineTo(x0 + 0.2, y0 + 2.0); X.quadraticCurveTo(cx, y0 + 3.3, x0 + BW - 0.2, y0 + 2.0); X.lineTo(x0 + BW - 0.2, y0 + 0.28); }, '#15191d', -0.5, 0.5, 0, 0);
        pane(P, x0 + 0.45, y0 + 0.3, BW - 0.9, 2.05, lit, -0.5, true);
        P.box(x0 + 0.2, y0 + 0.28, BW - 0.4, 0.95, '#efeadf', 0.1, 0.9, 0.8, 0); P.box(x0 + 0.2, y0 + 1.18, BW - 0.4, 0.06, '#faf8f2', 0.14, 0.8, 0.4, 0);
        if (q.next() < 0.3) plants(P, x0 + 0.4, y0 + 1.15, BW - 0.8);
        P.box(x0, y0, BW, 0.26, '#f3efe6', 0.2, 0.9, 0.6, 0);
      }
      break;
    }
    case L.CROWD: {
      // a grandstand seen from the track: rows of spectators, aisles, a few flags
      P.fill('#3a3d44', 0, 0.95, 0, 0);
      const rows = 14, rh = H / rows;
      for (let r = 0; r < rows; r++) { const y = r * rh; P.box(0, y, W, rh * 0.28, '#b9bcc2', 0.05, 0.8, 0, 0);
        for (let u = 0.08; u < W; u += 0.46) { if (Math.abs((u % 3.2) - 1.6) < 0.22) continue; if (q.next() < 0.12) { P.box(u, y + rh * 0.28, 0.4, rh * 0.5, `hsl(${[2, 215, 205][q.int(3)]},55%,${30 + q.int(12)}%)`, 0.02, 0.6, 0, 0); continue; }
          const hue = [0, 0, 210, 40, 350, 120, 28, 200][q.int(8)], sat = q.next() < 0.45 ? 8 : 45 + q.int(35), li = 28 + q.int(50);
          P.box(u + 0.04, y + rh * 0.28, 0.34, rh * 0.42, `hsl(${hue},${sat}%,${li}%)`, 0.06, 0.95, 0, 0);
          P.path(X => X.arc(u + 0.21, y + rh * 0.8, 0.095, 0, 7), q.next() < 0.35 ? `hsl(${[0, 0, 210, 48][q.int(4)]},${q.next() < 0.5 ? 70 : 5}%,${30 + q.int(55)}%)` : `hsl(${18 + q.int(14)},${30 + q.int(20)}%,${42 + q.int(28)}%)`, 0.1, 0.9, 0, 0); } }
      break;
    }
    case L.CONCRETE: {
      P.fill('#b8b4ab', 0, 0.9, 0.6, 0); P.grime(500, 'rgba(60,58,50,A)', 0.3, 1.5, 0.05); P.grime(300, 'rgba(240,240,235,A)', 0.6, 0.3, 0.05);
      for (let v = 0; v < H; v += 1.6) P.box(0, v, W, 0.02, '#8a867d', -0.03, 0.9, 0.4, 0); for (let u = 0; u < W; u += 3.2) P.box(u, 0, 0.02, H, '#8a867d', -0.03, 0.9, 0.4, 0);
      break;
    }
    case L.PALACE: {
      // pale stone, tall arched windows between pilasters: casino / opera / palace elevations
      P.fill('#efe8d8', 0, 0.9, 0.9, 0); P.grime(200, 'rgba(120,105,80,A)', 0.3, 1.8, 0.05);
      for (let b = 0; b < 4; b++) {
        const x0 = b * BW, cx = x0 + BW / 2, lit = q.next() < 0.6;
        P.box(x0 - 0.22, 0, 0.44, H, '#f6f1e6', 0.14, 0.88, 0.5, 0); P.box(x0 - 0.3, 0, 0.6, 0.5, '#f8f4ea', 0.2, 0.88, 0.5, 0); P.box(x0 - 0.3, H - 0.75, 0.6, 0.3, '#f8f4ea', 0.2, 0.88, 0.5, 0);
        const arch = (X, g) => { X.moveTo(cx - 0.8 - g, 0.7); X.lineTo(cx - 0.8 - g, 3.9); X.arc(cx, 3.9, 0.8 + g, Math.PI, 0, true); X.lineTo(cx + 0.8 + g, 0.7); };
        P.path(X => arch(X, 0.18), '#faf6ee', 0.08, 0.85, 0.4, 0); P.path(X => arch(X, 0), lit ? '#4b4332' : '#1b242c', -0.3, 0.07, 0, lit ? 1 : 0);
        P.box(cx - 0.03, 0.7, 0.06, 4.0, '#e9e3d6', -0.25, 0.6, 0, 0); for (const v of [1.6, 2.6, 3.6]) P.box(cx - 0.8, v, 1.6, 0.045, '#e9e3d6', -0.25, 0.6, 0, 0);
        P.path(X => X.arc(cx, 5.35, 0.3, 0, 7), '#d9d0bc', -0.1, 0.8, 0.4, 0); railing(P, cx - 0.85, 0.7, 1.7, 0.85, 0.02);
      }
      P.box(0, H - 0.45, W, 0.45, '#faf6ee', 0.26, 0.85, 0.4, 0); P.box(0, H - 0.5, W, 0.05, '#cfc7b6', 0.1, 0.85, 0.4, 0); P.box(0, 0, W, 0.14, '#f6f1e6', 0.1, 0.85, 0.4, 0);
      break;
    }
  }
  return P;
}

// Colour, relief and property canvases -> albedo with baked shading, and normal / roughness / light.
function bake(P, S, outA, outX, off) {
  const a = P.a.getImageData(0, 0, S, S).data, h = P.h.getImageData(0, 0, S, S).data, p = P.p.getImageData(0, 0, S, S).data;
  const hz = new Float32Array(S * S); for (let k = 0; k < S * S; k++) hz[k] = (h[k * 4] - 128) / 254;     // metres
  const pxM = S / P.H, pxX = S / P.W, wrap = (v) => (v + S) % S;
  const up = [3, 7, 12, 20, 30].map(v => Math.max(1, Math.round(v * S / 512)));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = y * S + x, z = hz[k];
    // slope (canvas rows run downwards; v runs upwards)
    const dzx = (hz[y * S + wrap(x + 1)] - hz[y * S + wrap(x - 1)]) * pxX * 0.5, dzy = (hz[wrap(y - 1) * S + x] - hz[wrap(y + 1) * S + x]) * pxM * 0.5;
    const sx = Math.max(-1, Math.min(1, -dzx * 0.55)), sy = Math.max(-1, Math.min(1, -dzy * 0.55));
    // contact shadow from anything standing proud above (sun from above), and recess darkening
    let sh = 0; for (let q = 0; q < up.length; q++) { const d = hz[wrap(y - up[q]) * S + x] - z; if (d > 0.02) sh = Math.max(sh, Math.min(1, d * 3.2) * (1 - q * 0.16)); }
    let amb = 0; for (const [ox, oy] of [[6, 0], [-6, 0], [0, 6], [0, -6], [12, 0], [-12, 0]]) amb += Math.max(0, hz[wrap(y + oy) * S + wrap(x + ox)] - z); amb = Math.min(1, amb * 0.9);
    const m = (1 - 0.5 * sh) * (1 - 0.3 * amb), o = off + k * 4;
    outA[o] = a[k * 4] * m; outA[o + 1] = a[k * 4 + 1] * m; outA[o + 2] = a[k * 4 + 2] * m; outA[o + 3] = p[k * 4 + 1];
    outX[o] = 127.5 + 127.5 * sx; outX[o + 1] = 127.5 + 127.5 * sy; outX[o + 2] = p[k * 4]; outX[o + 3] = p[k * 4 + 2];
  }
}

let cache = null;
export function facadeArrays(size, aniso) {
  if (cache && cache.size === size) return cache;
  const S = size, A = new Uint8Array(S * S * 4 * NL), X = new Uint8Array(S * S * 4 * NL);
  for (let id = 0; id < NL; id++) bake(drawLayer(id, S), S, A, X, id * S * S * 4);
  const mk = (data, srgb) => { const t = new THREE.DataArrayTexture(data, S, S, NL); t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = aniso; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.userData.shared = true; t.needsUpdate = true; return t; };
  cache = { size, albedo: mk(A, true), aux: mk(X, false) };
  return cache;
}

// Advertising hoardings: one atlas of fictional brands, 8 rows of 4:1 boards.
export function boardAtlas(aniso) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 1024; const x = c.getContext('2d');
  const B = [['AZUR BANK', '#0d3b66', '#faf0ca'], ['RIVA', '#d62828', '#ffffff'], ['KESTREL OIL', '#111111', '#ffd60a'], ['VOLT-R', '#f4f4f4', '#1d3557'], ['MISTRAL', '#1b4332', '#d8f3dc'], ['ORANGINA', '#ff7b00', '#111111'], ['RIDGE TYRES', '#ffd60a', '#111111'], ['HELIOS', '#ffffff', '#c1121f'],
    ['FX RACING', '#5a189a', '#ffffff'], ['ANVIL', '#c1121f', '#ffffff'], ['CÔTE D’OR', '#0a0a0a', '#d4af37'], ['ARROW', '#e9ecef', '#0b6e4f'], ['LUMEN', '#00a6a6', '#ffffff'], ['VANTA', '#0a0a0a', '#f4f4f4'], ['PORTIER', '#1d3557', '#f1faee'], ['BRAWLER', '#e63946', '#f1faee']];
  B.forEach((b, k) => { const X0 = (k % 2) * 512, Y0 = (k >> 1) * 128; x.fillStyle = b[1]; x.fillRect(X0, Y0, 512, 128); x.fillStyle = b[2]; x.font = `bold ${k % 3 === 0 ? 'italic ' : ''}78px ${k % 2 ? 'Georgia, serif' : 'Arial, sans-serif'}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(b[0], X0 + 256, Y0 + 68, 470); x.strokeStyle = b[2]; x.lineWidth = 5; x.strokeRect(X0 + 6, Y0 + 6, 500, 116); });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; return t;
}
