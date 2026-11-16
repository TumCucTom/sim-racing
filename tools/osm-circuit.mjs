// Builds a street / OSM circuit from a `type=circuit` relation (or a list of way ids) in an Overpass JSON file:
// chains the member ways (pit lane left out) into a closed loop, resamples every 5 m and writes the compact
// circuit file. Projection: equirectangular about the given origin (stored as the georeference).
//   node tools/osm-circuit.mjs <id> <overpass.json> <relation id> "<name>" "<country>" <width m> <ccw|cw> [startLat,startLon] [--street]   (--street: barriers at the kerb, as Monaco)
import fs from 'node:fs';
import { pack } from './add-circuit.mjs';
const [id, file, relId, name, country, width, dir, startLL] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file)), N = new Map(j.elements.filter(e => e.type === 'node').map(n => [n.id, n])), W = new Map(j.elements.filter(e => e.type === 'way').map(w => [w.id, w]));
const rel = j.elements.find(e => e.type === 'relation' && String(e.id) === relId);
const mem = rel.members.filter(m => m.type === 'way' && W.has(m.ref) && !/pit/i.test(m.role)).map(m => W.get(m.ref));
let lat0 = 0, lon0 = 0, c = 0; for (const w of mem) for (const q of w.nodes) { const p = N.get(q); lat0 += p.lat; lon0 += p.lon; c++; } lat0 = +(lat0 / c).toFixed(5); lon0 = +(lon0 / c).toFixed(5);
const R = 6371000, kx = Math.cos(lat0 * Math.PI / 180) * R * Math.PI / 180, ky = R * Math.PI / 180, xy = (q) => { const p = N.get(q); return [(p.lon - lon0) * kx, (p.lat - lat0) * ky]; };
// chain greedily by shared end nodes, starting from the longest way
const left = new Set(mem), first = [...mem].sort((a, b) => b.nodes.length - a.nodes.length)[0]; left.delete(first);
let chain = first.nodes.slice();
for (let guard = 0; guard < 500 && left.size; guard++) {
  const end = chain.at(-1); let hit = null, rev = false;
  for (const w of left) { if (w.nodes[0] === end) { hit = w; break; } if (w.nodes.at(-1) === end) { hit = w; rev = true; break; } }
  if (!hit) break; left.delete(hit); chain = chain.concat((rev ? hit.nodes.slice().reverse() : hit.nodes).slice(1));
  if (chain.at(-1) === chain[0]) break;
}
const closed = chain.at(-1) === chain[0]; if (closed) chain.pop();
let P = chain.map(xy), A = 0, L = 0; for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; A += a[0] * b[1] - b[0] * a[1]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
if ((A > 0) !== (dir === 'ccw')) P.reverse();
if (startLL) { const [la, lo] = startLL.split(',').map(Number), sx = (lo - lon0) * kx, sy = (la - lat0) * ky; let b = 0, bd = Infinity; P.forEach((p, k) => { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bd) { bd = d; b = k; } }); P = P.slice(b).concat(P.slice(0, b)); }
const cum = [0]; for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; cum.push(cum[k] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
const m = Math.round(L / 5), out = []; let k = 0;
for (let q = 0; q < m; q++) { const s = q * L / m; while (cum[k + 1] < s) k++; const f = (s - cum[k]) / (cum[k + 1] - cum[k]), a = P[k], b = P[(k + 1) % P.length]; out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, width / 2, width / 2]); }
const dirU = new URL('../src/sim/tracks/gp/', import.meta.url), f = new URL(id + '.json', dirU), old = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : {};
fs.writeFileSync(f, JSON.stringify({ ...old, id, name, country, source: `Centreline: OpenStreetMap contributors (ODbL), circuit relation ${relId}. Width: uniform ${width} m (estimate; streets are not width-tagged).`, ...pack(out), ...(process.argv.includes('--street') ? { runoff: 1.7 } : {}), trackside: { ...(old.trackside || {}), osm: { ...(old.trackside?.osm || {}), georef: { lat0, lon0, note: 'centreline is OSM geometry in this projection' } } } }));
console.log(id, 'ways', mem.length, 'unused', left.size, 'closed', closed, 'length', L.toFixed(0), 'm', A > 0 ? 'was ccw' : 'was cw', 'points', out.length);
