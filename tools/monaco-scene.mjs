// Monaco surroundings from OpenStreetMap (ODbL) and SRTM terrain. Writes src/sim/tracks/monaco.scene.json.
//   node tools/monaco-scene.mjs <dir with .osm extracts>      (extracts: api.openstreetmap.org/api/0.6/map?bbox=… tiles
//                                                              covering 7.411–7.435 E, 43.726–43.746 N)
// tools/monaco-cfg/dem.json holds SRTM 30 m heights (opentopodata.org) on a 50 m grid around the circuit and a 250 m grid
// around the principality. Everything is in the circuit's own frame: metres east / north of 43.7365 N, 7.4215 E.
// Output units: decimetres for near buildings / coast / pools / piers, metres elsewhere (see `note`).
import fs from 'node:fs';
import { buildTrack, nearestIndexGlobal } from '../src/sim/track.js';
const dir = process.argv[2], t = buildTrack('monaco');
const lat0 = 43.7365, lon0 = 7.4215, R = 6371000, kx = Math.cos(lat0 * Math.PI / 180) * R * Math.PI / 180, ky = R * Math.PI / 180;
const nodes = new Map(), ways = new Map(), rels = new Map(), pois = [];
const tagsOf = (s) => Object.fromEntries([...s.matchAll(/<tag k="([^"]*)" v="([^"]*)"/g)].map(q => [q[1], q[2].replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')]));
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.osm'))) {
  const txt = fs.readFileSync(dir + '/' + f, 'utf8');
  for (const m of txt.matchAll(/<node id="(\d+)"[^>]*? lat="([-\d.]+)" lon="([-\d.]+)"/g)) if (!nodes.has(m[1])) nodes.set(m[1], [(+m[3] - lon0) * kx, (+m[2] - lat0) * ky]);
  for (const w of txt.matchAll(/<way id="(\d+)"[\s\S]*?<\/way>/g)) if (!ways.has(w[1])) ways.set(w[1], { id: w[1], nd: [...w[0].matchAll(/<nd ref="(\d+)"/g)].map(m => m[1]), tags: tagsOf(w[0]) });
  for (const r of txt.matchAll(/<relation id="(\d+)"[\s\S]*?<\/relation>/g)) if (!rels.has(r[1])) rels.set(r[1], { id: r[1], tags: tagsOf(r[0]), members: [...r[0].matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"/g)].map(m => ({ ref: m[1], role: m[2] })) });
}
const ptsOf = (w) => w.nd.map(q => nodes.get(q)).filter(Boolean);
const dTrack = (p) => { const i = nearestIndexGlobal(t, p[0], p[1]); return Math.hypot(t.x[i] - p[0], t.y[i] - p[1]); };
// Douglas–Peucker on an open polyline
const dp = (P, tol) => { if (P.length < 3) return P.slice(); const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1; const st = [[0, P.length - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; const ax = P[a][0], ay = P[a][1], ex = P[b][0] - ax, ey = P[b][1] - ay, L = Math.hypot(ex, ey) || 1;
    for (let k = a + 1; k < b; k++) { const d = L > 1e-6 ? Math.abs((P[k][0] - ax) * ey - (P[k][1] - ay) * ex) / L : Math.hypot(P[k][0] - ax, P[k][1] - ay); if (d > md) { md = d; mi = k; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  return P.filter((_, k) => keep[k]); };
// closed ring (no repeated end point): split at the two extreme vertices so the simplification cannot collapse it
const dpRing = (P, tol) => { if (P.length < 5) return P; let far = 0, fd = 0; for (let k = 1; k < P.length; k++) { const d = Math.hypot(P[k][0] - P[0][0], P[k][1] - P[0][1]); if (d > fd) { fd = d; far = k; } }
  const a = dp(P.slice(0, far + 1), tol), b = dp(P.slice(far).concat([P[0]]), tol); return a.slice(0, -1).concat(b.slice(0, -1)); };
const area = (P) => { let A = 0; for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; A += a[0] * b[1] - b[0] * a[1]; } return A / 2; };
const cen = (P) => [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length];
const inside = (P, x, y) => { let c = false; for (let k = 0, j = P.length - 1; k < P.length; j = k++) { const a = P[k], b = P[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const ring = (w) => { if (!w || w.nd.length < 4 || w.nd[0] !== w.nd.at(-1)) return null; const P = ptsOf(w).slice(0, -1); return P.length >= 3 ? P : null; };
// outer rings of a multipolygon relation: closed member ways, plus open ones chained end to end
const outers = (r) => { const out = [], open = [];
  for (const m of r.members) { if (m.role === 'inner') continue; const w = ways.get(m.ref); if (!w) continue; if (w.nd[0] === w.nd.at(-1)) { const P = ring(w); if (P) out.push(P); } else open.push(w.nd.slice()); }
  let grew = true; while (grew && open.length) { grew = false; for (let a = 0; a < open.length && !grew; a++) for (let b = 0; b < open.length; b++) { if (a === b) continue;
    if (open[a].at(-1) === open[b][0]) { open[a] = open[a].concat(open[b].slice(1)); open.splice(b, 1); grew = true; break; }
    if (open[a].at(-1) === open[b].at(-1)) { open[a] = open[a].concat(open[b].slice(0, -1).reverse()); open.splice(b, 1); grew = true; break; } } }
  for (const c of open) if (c[0] === c.at(-1) && c.length > 3) { const P = c.slice(0, -1).map(q => nodes.get(q)).filter(Boolean); if (P.length >= 3) out.push(P); }
  return out; };
const dm = (v) => Math.round(v * 10), flat = (P, f = dm) => P.flatMap(p => [f(p[0]), f(p[1])]);
const WIN = { x0: -620, y0: -900, x1: 1180, y1: 1000 };                       // the modelled window
const inWin = (p, pad = 0) => p[0] > WIN.x0 - pad && p[0] < WIN.x1 + pad && p[1] > WIN.y0 - pad && p[1] < WIN.y1 + pad;

// ---- buildings -------------------------------------------------------------------------------
const heightOf = (g) => { const h = parseFloat(g.height), l = parseFloat(g['building:levels']), rl = parseFloat(g['roof:levels']) || 0; return h > 2 ? h : l > 0 ? (l + rl) * 3.05 + 1.5 : 0; };
const KIND = (g) => /church|chapel|cathedral/.test(g.building) || g.amenity === 'place_of_worship' ? 2 : g.building === 'hotel' || g.tourism === 'hotel' ? 3 : /apartments|residential/.test(g.building) ? 1 : /commercial|office|public|civic|retail|government|school|hospital|industrial/.test(g.building) ? 4 : /house|detached|villa/.test(g.building) ? 5 : 0;
const parts = []; for (const w of ways.values()) if (w.tags['building:part'] && w.tags['building:part'] !== 'no') { const P = ring(w), h = heightOf(w.tags); if (P && h) parts.push({ c: cen(P), h }); }
const B = [], seen = new Set(), MARK = /Casino de Monte|H[ôo]tel de Paris|Op[ée]ra de Monaco|Fairmont|Auditorium Rainier|Palais Princier|Palais de Monaco|Sainte-D[ée]vote|Caf[ée] de Paris|Hermitage|Oc[ée]anographique|Cath[ée]drale|Yacht Club|Rascasse|Stade Nautique|Sporting|Grimaldi Forum|Port Palace|Miramar|Tour Od[ée]on|Millefiori|Mirabeau|Ermanno|Automobile Club/i;
const addB = (P, tags, id) => {
  if (!P || seen.has(id)) return; seen.add(id);
  if (/^(roof|no|construction|tent|bridge|pier)$/.test(tags.building) || tags.location === 'underground' || parseFloat(tags.layer) < 0) return;
  let A = area(P); if (Math.abs(A) < 22) return; if (A < 0) P = P.slice().reverse();
  const c = cen(P); if (!inWin(c, 40)) return;
  const near = Math.min(dTrack(c), ...P.map(dTrack));
  let h = heightOf(tags), g = 0;
  if (!h) { let ph = 0; for (const q of parts) if (Math.abs(q.c[0] - c[0]) < 80 && inside(P, q.c[0], q.c[1])) ph = Math.max(ph, q.h); if (ph) h = ph; }
  B.push({ P, h, a: Math.abs(A), near, c, kind: KIND(tags), name: tags.name || '', lev: parseFloat(tags['building:levels']) || 0 });
};
for (const r of rels.values()) if (r.tags.building && r.tags.type === 'multipolygon') outers(r).forEach((P, k) => addB(P, r.tags, 'r' + r.id + '_' + k));
for (const r of rels.values()) if (r.tags.building && r.tags.type === 'multipolygon') for (const m of r.members) seen.add(m.ref);
for (const w of ways.values()) if (w.tags.building) addB(ring(w), w.tags, w.id);
// buildings mapped only as 3D parts (the Casino, the Hôtel de Paris...): parts not inside any outline stand in for it
{ const base = B.slice(); for (const w of ways.values()) { if (!w.tags['building:part'] || w.tags['building:part'] === 'no' || seen.has(w.id)) continue; const P = ring(w); if (!P) continue; const c = cen(P); if (base.some(b => Math.abs(b.c[0] - c[0]) < 150 && Math.abs(b.c[1] - c[1]) < 150 && inside(b.P, c[0], c[1]))) continue; addB(P, { ...w.tags, building: 'yes' }, w.id); } }
// untagged heights: the median of tagged neighbours within 90 m, scaled by footprint, with a deterministic spread
const tagged = B.filter(b => b.h > 0), known = tagged.length;
const hsh = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v); };
for (const b of B) if (!b.h) {
  const nb = tagged.filter(q => Math.hypot(q.c[0] - b.c[0], q.c[1] - b.c[1]) < 90).map(q => q.h).sort((p, q) => p - q);
  const med = nb.length ? nb[nb.length >> 1] : 17, sz = Math.sqrt(b.a);
  b.h = Math.round(Math.max(b.kind === 5 || b.a < 90 ? 6.5 : 10, Math.min(med, 9 + sz * 1.0) * (0.75 + 0.5 * hsh(b.c[0], b.c[1])))); b.g = 1;
  if (b.a < 45) b.h = Math.min(b.h, 7);
}
const nearB = B.filter(b => b.near <= 330), farB = B.filter(b => b.near > 330);
const marks = [];
const bOut = nearB.map((b, k) => { const tol = b.near < 120 ? 0.7 : b.near < 220 ? 1.3 : 2.2; let P = dpRing(b.P, tol); if (P.length < 3) P = b.P; if (MARK.test(b.name)) marks.push([b.name, k]); return [dm(b.h), (b.g ? 1 : 0) | (b.kind << 1), ...flat(P)]; });
// far buildings: oriented bounding boxes [cx, cy, w, d, angle deg, h] in metres
const obb = (P) => { let best = null; for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 2) continue; const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L; let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9; for (const p of P) { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); } const A = (u1 - u0) * (v1 - v0); if (!best || A < best.A) best = { A, cx: (u0 + u1) / 2 * ux - (v0 + v1) / 2 * uy, cy: (u0 + u1) / 2 * uy + (v0 + v1) / 2 * ux, w: u1 - u0, d: v1 - v0, ang: Math.atan2(uy, ux) }; } return best; };
const fOut = []; for (const b of farB) { if (b.a < 60) continue; const o = obb(b.P); if (!o) continue; const fill = Math.sqrt(Math.min(1, b.a / o.A)); fOut.push(Math.round(o.cx), Math.round(o.cy), Math.round(o.w * fill), Math.round(o.d * fill), Math.round(o.ang * 180 / Math.PI), Math.round(b.h)); }

// ---- coastline: chained ways, water on the right-hand side of the direction of travel ------------
const coast = [...ways.values()].filter(w => w.tags.natural === 'coastline').map(ptsOf).filter(p => p.length > 1);
let merged = true; while (merged) { merged = false; outer: for (let a = 0; a < coast.length; a++) for (let b = 0; b < coast.length; b++) { if (a === b) continue; const e = coast[a].at(-1), s = coast[b][0]; if (Math.hypot(e[0] - s[0], e[1] - s[1]) < 0.5) { coast[a] = coast[a].concat(coast[b].slice(1)); coast.splice(b, 1); merged = true; break outer; } } }
const C = coast.filter(c => c.length > 100).map(c => dp(c, 0.6));

// ---- areas and lines -----------------------------------------------------------------------------
const polys = (f, tol, minA, maxD = 420) => { const out = [];
  const push = (P) => { if (!P) return; const A = Math.abs(area(P)); if (A < minA) return; const c = cen(P); if (!inWin(c) || dTrack(c) > maxD + Math.sqrt(A)) return; const S = dpRing(P, tol); if (S.length >= 3) out.push(S); };
  for (const w of ways.values()) if (f(w.tags)) push(ring(w));
  for (const r of rels.values()) if (r.tags.type === 'multipolygon' && f(r.tags)) outers(r).forEach(push);
  return out; };
const green = polys(g => /^(park|garden)$/.test(g.leisure) || /^(grass|flowerbed|meadow|forest|orchard|village_green)$/.test(g.landuse) || /^(wood|scrub|heath)$/.test(g.natural), 1.5, 40);
const pools = polys(g => g.leisure === 'swimming_pool' || (g.natural === 'water' && g.water !== 'sea') || g.amenity === 'fountain', 0.5, 12, 330);
const plaza = polys(g => g.highway === 'pedestrian' && g.area === 'yes' || g.place === 'square' || g.amenity === 'parking' && !g.building && g.parking !== 'underground' && g.parking !== 'multi-storey', 1.2, 60, 330);
const pitch = polys(g => g.leisure === 'pitch' || g.leisure === 'track', 1, 60, 500);
const WID = { motorway: 10, trunk: 10, primary: 9.5, secondary: 9, tertiary: 8, unclassified: 6.5, residential: 6.5, living_street: 5.5, service: 4.2, pedestrian: 5, primary_link: 6, secondary_link: 6, raceway: 9 };
const streets = [];
for (const w of ways.values()) { const g = w.tags, wd = WID[g.highway]; if (!wd || g.area === 'yes') continue; if (g.tunnel && g.tunnel !== 'no' && g.tunnel !== 'building_passage' || parseFloat(g.layer) < 0 || g.covered === 'yes' || g.indoor) continue;
  if (g.highway === 'service' && /parking_aisle|driveway/.test(g.service || '')) continue;
  const P = ptsOf(w); if (P.length < 2 || !P.some(p => inWin(p) && dTrack(p) < 480)) continue;
  const width = parseFloat(g.width) > 2 ? Math.min(14, parseFloat(g.width)) : g.lanes > 2 ? wd + 3 * (g.lanes - 2) : g.oneway === 'yes' && wd > 6 ? wd - 1.5 : wd;
  streets.push([Math.round(width * 10) / 10 * (parseFloat(g.layer) > 0 || g.bridge ? -1 : 1), ...flat(dp(P, 0.9), v => Math.round(v))]); }
const steps = [];
for (const w of ways.values()) { const g = w.tags; if (!/^(footway|steps|path)$/.test(g.highway) || g.tunnel || parseFloat(g.layer) < 0 || g.indoor || g.footway === 'crossing' || g.footway === 'sidewalk') continue; const P = ptsOf(w); if (P.length < 2 || !P.some(p => dTrack(p) < 200)) continue; let L = 0; for (let k = 1; k < P.length; k++) L += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); if (L < 25) continue; steps.push(flat(dp(P, 1.2), v => Math.round(v))); }
const piers = [];
for (const w of ways.values()) { const g = w.tags; if (!/^(pier|breakwater|quay)$/.test(g.man_made)) continue; const P = ptsOf(w); if (P.length < 2 || !P.some(p => inWin(p))) continue; const closed = w.nd[0] === w.nd.at(-1);
  piers.push([closed ? 0 : Math.round((parseFloat(g.width) || (g.man_made === 'breakwater' ? 8 : g.floating === 'yes' ? 2.5 : 3)) * 10), ...flat(closed ? dpRing(P.slice(0, -1), 0.4) : dp(P, 0.4))]); }
const walls = [];
for (const w of ways.values()) { const g = w.tags; if (g.barrier !== 'retaining_wall' && g.natural !== 'cliff') continue; const P = ptsOf(w); if (P.length < 2 || !P.some(p => dTrack(p) < 260)) continue; walls.push([g.natural === 'cliff' ? 1 : 0, ...flat(dp(P, 1.5), v => Math.round(v))]); }

// ---- tunnel: circuit-relation ways tagged tunnel / covered -----------------------------------------
const rel = rels.get('148194'), tun = [];
for (const m of rel.members) { const w = ways.get(m.ref); if (!w || !(w.tags.tunnel && w.tags.tunnel !== 'no' || w.tags.covered === 'yes')) continue; const idx = ptsOf(w).filter(p => dTrack(p) < 8).map(p => nearestIndexGlobal(t, p[0], p[1])); if (idx.length) tun.push([Math.min(...idx), Math.max(...idx)]); }
tun.sort((a, b) => a[0] - b[0]);
for (let k = tun.length - 1; k > 0; k--) if (tun[k][0] - tun[k - 1][1] < 8) { tun[k - 1][1] = Math.max(tun[k - 1][1], tun[k][1]); tun.splice(k, 1); }

const dem = JSON.parse(fs.readFileSync(new URL('./monaco-cfg/dem.json', import.meta.url)));
const out = { note: 'Derived from OpenStreetMap (ODbL) by tools/monaco-scene.mjs; terrain from SRTM 30 m. Circuit frame (m east / north of 43.7365 N, 7.4215 E). buildings: [height dm, flags (bit0 height guessed, bits1.. kind: 1 apartments 2 church 3 hotel 4 commercial/public 5 house), x0, y0, ...] in dm, counter-clockwise. far: flat [cx, cy, w, d, angle deg, h] in m. coast (water on the right), pools, piers ([width dm or 0 = closed outline, ...]) in dm. green, plaza, pitch, streets ([width m (negative: bridge), ...]), steps, walls ([1 = cliff, ...]) in m. dem: SRTM heights (m above sea level) row by row from the south-west corner.',
  win: WIN, buildings: bOut, marks, far: fOut, coast: C.map(c => flat(c)), pools: pools.map(p => flat(p)), piers, green: green.map(p => flat(p, Math.round)), plaza: plaza.map(p => flat(p, Math.round)), pitch: pitch.map(p => flat(p, Math.round)), streets, steps, walls, tunnel: tun,
  dem: { fine: dem.fine, coarse: dem.coarse } };
const js = JSON.stringify(out);
fs.writeFileSync(new URL('../src/sim/tracks/monaco.scene.json', import.meta.url), js);
const sz = (v) => JSON.stringify(v).length;
console.log(`buildings near ${bOut.length} (${sz(bOut)} B), far ${fOut.length / 6} (${sz(fOut)} B), tagged heights ${known}/${B.length}; coast ${C.length} chains ${sz(out.coast)} B; pools ${pools.length} ${sz(out.pools)}; piers ${piers.length} ${sz(piers)}; green ${green.length} ${sz(out.green)}; plaza ${plaza.length}; streets ${streets.length} ${sz(streets)}; steps ${steps.length} ${sz(steps)}; walls ${walls.length} ${sz(walls)}; dem ${sz(out.dem)}; tunnel ${JSON.stringify(tun)}; total ${js.length} B`);
console.log('marks', JSON.stringify(marks));
