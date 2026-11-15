// Wet-track model shared by the sim, the AI driver and (mirrored in GLSL) the renderer.
//
// A wet state is a plain object; `null` means dry and leaves the sim bit-identical
// to a build without this file (vehicle.js only calls in here when car.wet is set).
//   grip     tyre-road friction on wet asphalt as a fraction of dry
//   lineDry  0..1: how far the racing line has dried (damp track: the line grips, off-line does not)
//   puddle   extra fractional loss in standing water (collects along the edges, see puddleDepth)
//   kerb, grass, gravel   further multipliers on those surfaces (wet paint and wet grass are treacherous)
import { SURF } from './track.js';

export const WET = {
  damp: { id: 'damp', grip: 0.88, lineDry: 0.9, puddle: 0.0, kerb: 0.85, grass: 0.85, gravel: 0.97 },
  rain: { id: 'rain', grip: 0.77, lineDry: 0, puddle: 0.14, kerb: 0.72, grass: 0.72, gravel: 0.95 },
  storm: { id: 'storm', grip: 0.72, lineDry: 0, puddle: 0.2, kerb: 0.7, grass: 0.7, gravel: 0.95 },
};
// condition id (as used by the game's ?wx= parameter) -> wet state or null
export function wetFor(wx) { return wx === 'overcast' ? WET.damp : WET[wx] || null; }

const AI_MARGIN = +(globalThis.process?.env?.WET_MARGIN || 0.955);
const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// Standing water, 0..1, at arc length s (m), lateral offset off (m, + left) on a road of half-width hw.
// Water gathers within about 1.4 m of either edge, in stretches that alternate from side to side.
// Keep in step with `puddleDepth` in the road shader (src/game/world.js).
export function puddleDepth(s, off, hw) {
  const de = hw - Math.abs(off);
  if (de > 1.4 || de < -0.2) return 0;
  const side = off > 0 ? 1.7 : 0.0;
  const a = 0.5 + 0.5 * Math.sin(s * 0.021 + 1.3 + side) * Math.sin(s * 0.0057 + 0.4 + side * 2.0);
  return sstep(1.4, 0.3, de) * sstep(0.45, 0.7, a);
}

// Friction multiplier for one wheel. sf: SURF id, s: arc length, d: lateral offset, hw: half-width,
// lineD: lateral offset of the racing line at this point.
export function wetMu(wet, sf, s, d, hw, lineD) {
  if (sf === SURF.ASPHALT) {
    let g = wet.grip;
    if (wet.lineDry > 0) { const x = d - lineD; g += (1 - g) * wet.lineDry * Math.exp(-x * x / 3.6); }
    if (wet.puddle > 0) g *= 1 - wet.puddle * puddleDepth(s, d, hw);
    return g;
  }
  if (sf === SURF.KERB) return wet.grip * wet.kerb;
  return sf === SURF.GRASS ? wet.grass : wet.gravel;
}

// What the racing-line driver may assume: grip on the line, less a safety margin
// (cold tyres, puddles at apex and exit, painted kerbs).
export function wetDriverGrip(wet) {
  if (!wet) return 1;
  const onLine = wet.grip + (1 - wet.grip) * wet.lineDry * 0.4;
  return onLine * (1 - 0.5 * wet.puddle) * (wet.aiMargin ?? AI_MARGIN);
}
