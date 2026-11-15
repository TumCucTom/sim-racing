// Monaco surroundings from OpenStreetMap (ODbL): building footprints with heights, the coastline
// (harbour quays and piers) and where the circuit runs in tunnel. Writes src/sim/tracks/monaco.scene.json.
//   node tools/monaco-scene.mjs <monaco.osm>
// Coordinates are the circuit's own local metres (equirectangular about 43.7365 N, 7.4215 E), in decimetres.
import fs from 'node:fs';
import { buildTrack, nearestIndexGlobal } from '../src/sim/track.js';
const txt = fs.readFileSync(process.argv[2], 'utf8'), t = buildTrack('monaco');
const lat0 = 43.7365, lon0 = 7.4215, R = 6371000, kx = Math.cos(lat0 * Math.PI / 180) * R * Math.PI / 180, ky = R * Math.PI / 180;
const nodes = new Map(); for (const m of txt.matchAll(/<node id="(\d+)"[^>]*? lat="([-\d.]+)" lon="([-\d.]+)"/g)) nodes.set(m[1], [(+m[3] - lon0) * kx, (+m[2] - lat0) * ky]);
const tagsOf = (s) => Object.fromEntries([...s.matchAll(/<tag k="([^"]*)" v="([^"]*)"/g)].map(q => [q[1], q[2]]));
const ways = new Map(); for (const w of txt.matchAll(/<way id="(\d+)"[\s\S]*?<\/way>/g)) ways.set(w[1], { id: w[1], nd: [...w[0].matchAll(/<nd ref="(\d+)"/g)].map(m => m[1]), tags: tagsOf(w[0]) });
const rels = [...txt.matchAll(/<relation id="(\d+)"[\s\S]*?<\/relation>/g)].map(r => ({ id: r[1], tags: tagsOf(r[0]), members: [...r[0].matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"/g)].map(m => ({ ref: m[1], role: m[2] })) }));
const dTrack = (p) => { const i = nearestIndexGlobal(t, p[0], p[1]); return Math.hypot(t.x[i] - p[0], t.y[i] - p[1]); };
const simplify = (pts, tol) => { const out = [pts[0]]; for (let k = 1; k < pts.length; k++) if (Math.hypot(pts[k][0] - out.at(-1)[0], pts[k][1] - out.at(-1)[1]) > tol || k === pts.length - 1) out.push(pts[k]); return out; };
const heightOf = (g) => { const h = parseFloat(g.height), l = parseFloat(g['building:levels']); return h > 2 ? h : l > 0 ? l * 3.1 + 1.5 : 0; };
// buildings (ways, and outer rings of multipolygon relations)
const B = [], seen = new Set();
const addB = (w, tags) => {
  if (!w || seen.has(w.id) || w.nd.length < 4 || w.nd[0] !== w.nd.at(-1)) return; seen.add(w.id);
  let pts = w.nd.slice(0, -1).map(q => nodes.get(q)).filter(Boolean); if (pts.length < 3) return;
  const near = Math.min(...pts.map(dTrack)); if (near > 330) return;
  pts = simplify(pts, 1.2); if (pts.length < 3) return;
  let A = 0; for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; A += a[0] * b[1] - b[0] * a[1]; }
  if (Math.abs(A) / 2 < 25) return; if (A < 0) pts.reverse();
  B.push({ h: heightOf(tags), a: Math.abs(A) / 2, near, pts });
};
for (const r of rels) if (r.tags.building && r.tags.type === 'multipolygon') for (const m of r.members) if (m.role !== 'inner') addB(ways.get(m.ref), r.tags);
for (const w of ways.values()) if (w.tags.building || w.tags['building:part']) addB(w, w.tags);
const known = B.filter(b => b.h > 0).length;
// heights: tagged where OSM has them; otherwise a deterministic guess from footprint area (Monaco builds high)
for (const b of B) if (!b.h) { const hsh = Math.abs(Math.sin(b.pts[0][0] * 12.9898 + b.pts[0][1] * 78.233) * 43758.5453) % 1; b.h = Math.round(12 + Math.min(30, Math.sqrt(b.a) * 0.9) * (0.6 + 0.8 * hsh)); b.g = 1; }
// coastline: chained ways, water on the right-hand side of the direction of travel
const coast = [...ways.values()].filter(w => w.tags.natural === 'coastline').map(w => w.nd.map(q => nodes.get(q)).filter(Boolean)).filter(p => p.length > 1);
let merged = true; while (merged) { merged = false; outer: for (let a = 0; a < coast.length; a++) for (let b = 0; b < coast.length; b++) { if (a === b) continue; const e = coast[a].at(-1), s = coast[b][0]; if (Math.hypot(e[0] - s[0], e[1] - s[1]) < 0.5) { coast[a] = coast[a].concat(coast[b].slice(1)); coast.splice(b, 1); merged = true; break outer; } } }
const C = coast.map(c => simplify(c.filter(p => dTrack(p) < 900), 2)).filter(c => c.length > 3);
// tunnel: circuit-relation ways tagged tunnel / covered
const rel = rels.find(r => r.id === '148194'), tun = [];
for (const m of rel.members) { const w = ways.get(m.ref); if (!w || !(w.tags.tunnel && w.tags.tunnel !== 'no' || w.tags.covered === 'yes')) continue; const idx = w.nd.map(q => nodes.get(q)).filter(Boolean).filter(p => dTrack(p) < 8).map(p => nearestIndexGlobal(t, p[0], p[1])); if (idx.length) tun.push([Math.min(...idx), Math.max(...idx), w.tags.name || '', w.tags.tunnel || 'covered']); }
tun.sort((a, b) => a[0] - b[0]);
const dm = (v) => Math.round(v * 10);
const out = { note: 'Derived from OpenStreetMap (ODbL) by tools/monaco-scene.mjs. Decimetres in the circuit frame. Building: [height dm, guessed 0/1, x0, y0, x1, y1, ...].',
  buildings: B.map(b => [dm(b.h), b.g ? 1 : 0, ...b.pts.flatMap(p => [dm(p[0]), dm(p[1])])]), coast: C.map(c => c.flatMap(p => [dm(p[0]), dm(p[1])])), tunnel: tun.map(x => [x[0], x[1]]) };
fs.writeFileSync(new URL('../src/sim/tracks/monaco.scene.json', import.meta.url), JSON.stringify(out));
console.log(`buildings ${B.length} (${known} with tagged height/levels), coastline chains ${C.length} (${C.reduce((a, c) => a + c.length, 0)} pts), tunnel ways`, JSON.stringify(tun), 'bytes', JSON.stringify(out).length);
