// Trackside survey from OpenStreetMap (ODbL): gravel/sand traps, paved run-off areas and
// barrier lines around a circuit, expressed in the sim's track coordinates.
//
//   node tools/trackside-osm.mjs <track id> <extract.osm | extract.json> [--write] [--svg out.svg]
//
// The extract is a plain OSM XML download (api/0.6/map?bbox=..., several files may be given
// separated by commas) or an Overpass JSON result. Steps:
//   1. georeference: fit rotation + translation between the sim centreline and the OSM
//      highway=raceway geometry by ICP (the TUMFTM circuits are in local metres with an
//      unknown origin); the fit residual is printed and stored,
//   2. cast a ray along the track normal on both sides every few metres and record where it
//      crosses gravel / sand polygons, paved areas and barrier ways,
//   3. --write stores the result as `trackside.osm` in src/sim/tracks/<id>.json (run-length
//      encoded, lateral offsets in metres from the centreline). src/sim/track.js consumes it.
// Nothing here is needed at run time; it documents how the OSM-derived part of the data
// was produced. Hand-authored corner data lives next to it in `trackside.corners`.
import fs from 'node:fs';
import { buildTrack } from '../src/sim/track.js';

const [id, files, ...flags] = process.argv.slice(2);
const WRITE = flags.includes('--write'), svgOut = flags.includes('--svg') ? flags[flags.indexOf('--svg') + 1] : null;
const STEP = 4, REACH = 110;

// ---- parse -------------------------------------------------------------------------------
const nodes = new Map(), ways = new Map(), rels = [];
for (const f of files.split(',')) {
  const txt = fs.readFileSync(f, 'utf8');
  if (txt.trimStart().startsWith('{')) {
    for (const e of JSON.parse(txt).elements) {
      if (e.type === 'node') nodes.set(String(e.id), [e.lat, e.lon]);
      else if (e.type === 'way') { if (!ways.has(String(e.id)) || e.tags) ways.set(String(e.id), { id: String(e.id), nd: e.nodes.map(String), tags: e.tags || {} }); }
      else if (e.type === 'relation') rels.push({ id: String(e.id), tags: e.tags || {}, members: e.members.filter(m => m.type === 'way').map(m => ({ ref: String(m.ref), role: m.role })) });
    }
  } else {
    for (const m of txt.matchAll(/<node id="(\d+)"[^>]*? lat="([-\d.]+)" lon="([-\d.]+)"/g)) nodes.set(m[1], [+m[2], +m[3]]);
    const tagsOf = (s) => Object.fromEntries([...s.matchAll(/<tag k="([^"]*)" v="([^"]*)"/g)].map(t => [t[1], t[2]]));
    for (const w of txt.matchAll(/<way id="(\d+)"[\s\S]*?<\/way>/g)) ways.set(w[1], { id: w[1], nd: [...w[0].matchAll(/<nd ref="(\d+)"/g)].map(m => m[1]), tags: tagsOf(w[0]) });
    for (const r of txt.matchAll(/<relation id="(\d+)"[\s\S]*?<\/relation>/g)) rels.push({ id: r[1], tags: tagsOf(r[0]), members: [...r[0].matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"/g)].map(m => ({ ref: m[1], role: m[2] })) });
  }
}

// ---- georeference ------------------------------------------------------------------------
const track = buildTrack(id), n = track.n;
const isRace = (w) => w.tags.highway === 'raceway' && !/pit|box|kart|service|rally|drift|stowe circuit|anbindung|grand-prix|sprint|müllenbach/i.test((w.tags.name || '') + (w.tags.service || '') + (w.tags.sport || '')) && w.tags.area !== 'yes';
let lat0 = 0, lon0 = 0, cnt = 0;
for (const w of ways.values()) if (isRace(w)) for (const q of w.nd) { const p = nodes.get(q); if (p) { lat0 += p[0]; lon0 += p[1]; cnt++; } }
lat0 /= cnt; lon0 /= cnt;
{ const k = process.argv.indexOf('--origin'); if (k > 0) [lat0, lon0] = process.argv[k + 1].split(',').map(Number); }
const RE = 6371000, kx = Math.cos(lat0 * Math.PI / 180) * RE * Math.PI / 180, ky = RE * Math.PI / 180;
const ll = (p) => [(p[1] - lon0) * kx, (p[0] - lat0) * ky];
const T = [];   // densified OSM raceway points (5 m)
for (const w of ways.values()) if (isRace(w)) for (let k = 0; k < w.nd.length - 1; k++) {
  const a = nodes.get(w.nd[k]), b = nodes.get(w.nd[k + 1]); if (!a || !b) continue;
  const A = ll(a), B = ll(b), L = Math.hypot(B[0] - A[0], B[1] - A[1]), m = Math.max(1, Math.round(L / 5));
  for (let q = 0; q < m; q++) T.push([A[0] + (B[0] - A[0]) * q / m, A[1] + (B[1] - A[1]) * q / m]);
}
const S = []; for (let i = 0; i < n; i += 2) S.push([track.x[i], track.y[i]]);
const mean = (A) => [A.reduce((a, p) => a + p[0], 0) / A.length, A.reduce((a, p) => a + p[1], 0) / A.length];
// ICP from the sim centreline to the OSM raceway points (OSM usually holds more layouts than
// the one we want, so every sim sample must find a partner, not the other way round)
function fit() {
  let best = null;
  const cs = mean(S), cell = 40, grid = new Map();
  T.forEach((p, k) => { const key = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(k); });
  let tb = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of T) { tb = [Math.min(tb[0], p[0]), Math.min(tb[1], p[1]), Math.max(tb[2], p[0]), Math.max(tb[3], p[1])]; }
  const starts = [];
  for (let a = 0; a < 24; a++) for (const fx of [0.5, 0.3, 0.7]) for (const fy of [0.5, 0.3, 0.7]) starts.push([a * Math.PI / 12, tb[0] + (tb[2] - tb[0]) * fx, tb[1] + (tb[3] - tb[1]) * fy]);
  for (const [th0, tx0, ty0] of starts) {
    let th = th0, tx = tx0, ty = ty0, err = 0, used = 0, inl = 0;
    for (let it = 0; it < 40; it++) {
      const c = Math.cos(th), s = Math.sin(th);
      const lim = it < 6 ? 240 : it < 20 ? 40 : 10, P = [], Q = [];
      for (const p of S) {
        const x = (p[0] - cs[0]) * c - (p[1] - cs[1]) * s + tx, y = (p[0] - cs[0]) * s + (p[1] - cs[1]) * c + ty;
        let bd = Infinity, bk = -1; const gx = Math.floor(x / cell), gy = Math.floor(y / cell), rr = Math.ceil(lim / cell);
        for (let yy = gy - rr; yy <= gy + rr; yy++) for (let xx = gx - rr; xx <= gx + rr; xx++) { const l = grid.get(xx + ',' + yy); if (l) for (const k of l) { const d = (T[k][0] - x) ** 2 + (T[k][1] - y) ** 2; if (d < bd) { bd = d; bk = k; } } }
        if (bk >= 0 && bd < lim * lim) { P.push(p); Q.push(T[bk]); }
      }
      if (P.length < 20) break;
      const mp = mean(P), mq = mean(Q); let a = 0, b = 0;
      for (let k = 0; k < P.length; k++) { const px = P[k][0] - mp[0], py = P[k][1] - mp[1], qx = Q[k][0] - mq[0], qy = Q[k][1] - mq[1]; a += px * qx + py * qy; b += px * qy - py * qx; }
      th = Math.atan2(b, a); const c2 = Math.cos(th), s2 = Math.sin(th);
      tx = mq[0] - ((mp[0] - cs[0]) * c2 - (mp[1] - cs[1]) * s2); ty = mq[1] - ((mp[0] - cs[0]) * s2 + (mp[1] - cs[1]) * c2);
      err = 0; inl = 0; for (let k = 0; k < P.length; k++) { const x = (P[k][0] - cs[0]) * c2 - (P[k][1] - cs[1]) * s2 + tx, y = (P[k][0] - cs[0]) * s2 + (P[k][1] - cs[1]) * c2 + ty; const e = Math.hypot(x - Q[k][0], y - Q[k][1]); err += e; if (e < 6) inl++; }
      err /= P.length; used = P.length;
    }
    if (!best || inl > best.inl || (inl === best.inl && err < best.err)) best = { th, tx, ty, cs, err, used, inl };
  }
  best.total = S.length;
  return best;
}
const ORIGIN = flags.includes('--origin') ? flags[flags.indexOf('--origin') + 1].split(',').map(Number) : null;
// circuits whose centreline was itself taken from OSM are already in a known local projection
const G = ORIGIN ? { th: 0, tx: (0 - 0), ty: 0, cs: [0, 0], err: 0, used: S.length, inl: S.length, total: S.length, fixed: true } : fit();
console.log(`${id}: OSM raceway points ${T.length}, sim samples ${G.total}, matched ${G.used} (${G.inl} within 6 m), mean residual ${G.err.toFixed(2)} m, rotation ${(G.th * 180 / Math.PI).toFixed(2)} deg`);
// OSM lat/lon -> sim x,y (inverse of the fit)
const cG = Math.cos(G.th), sG = Math.sin(G.th);
const toSim = (p) => { const q = ll(p), dx = q[0] - G.tx, dy = q[1] - G.ty; return [dx * cG + dy * sG + G.cs[0], -dx * sG + dy * cG + G.cs[1]]; };

// ---- features ----------------------------------------------------------------------------
const GRAVEL = (t) => /^(gravel|sand|fine_gravel|pebblestone)$/.test(t.surface || '') || /^(sand|shingle)$/.test(t.natural || '') || t.landuse === 'sand' || t.leisure === 'sand';
const PAVED = (t) => (/^(asphalt|concrete|paved)$/.test(t.surface || '') && (!t.highway || t.area === 'yes') && !t.building && !t.barrier && !t.amenity && !t.leisure) || t['area:highway'] === 'raceway' || (t.highway === 'raceway' && t.area === 'yes') || (t.highway === 'service' && t.area === 'yes');
const BARRIER = (t) => /^(wall|guard_rail|fence|block|jersey_barrier|retaining_wall|city_wall|tyres|tire|kerb)$/.test(t.barrier || '');
const polys = [], lines = [];
const ring = (w) => w.nd.map(q => nodes.get(q)).filter(Boolean).map(toSim);
for (const w of ways.values()) {
  const t = w.tags, closed = w.nd.length > 3 && w.nd[0] === w.nd.at(-1);
  if (BARRIER(t)) lines.push({ kind: t.barrier === 'kerb' ? 'kerb' : 'barrier', sub: t.barrier, pts: ring(w), id: w.id });
  else if (closed && GRAVEL(t) && !t.highway) polys.push({ kind: 'gravel', pts: ring(w), id: w.id });
  else if (closed && PAVED(t)) polys.push({ kind: 'paved', pts: ring(w), id: w.id });
  if (t.building) lines.push({ kind: 'barrier', sub: 'building', pts: ring(w), id: w.id });
}
for (const r of rels) {
  if (r.tags.type !== 'multipolygon') continue;
  const kind = GRAVEL(r.tags) ? 'gravel' : PAVED(r.tags) ? 'paved' : null; if (!kind) continue;
  for (const m of r.members) { const w = ways.get(m.ref); if (w && m.role !== 'inner' && w.nd[0] === w.nd.at(-1)) polys.push({ kind, pts: ring(w), id: 'r' + r.id }); }
}
const TG = new Map(), TC = 30;
for (let q = 0; q < n; q += 2) { const key = Math.floor(track.x[q] / TC) + ',' + Math.floor(track.y[q] / TC); if (!TG.has(key)) TG.set(key, []); TG.get(key).push(q); }
const nearTrack = (px, py, r, fn) => { const gx = Math.floor(px / TC), gy = Math.floor(py / TC), rr = Math.ceil(r / TC); for (let yy = gy - rr; yy <= gy + rr; yy++) for (let xx = gx - rr; xx <= gx + rr; xx++) { const l = TG.get(xx + ',' + yy); if (l) for (const q of l) if ((track.x[q] - px) ** 2 + (track.y[q] - py) ** 2 < r * r && fn(q)) return true; } return false; };
const bbox = (o) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of o.pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); } o.bb = [a, b, c, d]; };
polys.forEach(bbox); lines.forEach(bbox);
const near = (o) => o.pts.some(p => nearTrack(p[0], p[1], REACH + 20, () => true));
const P2 = polys.filter(near), L2 = lines.filter(near);
console.log(` features near the circuit: gravel ${P2.filter(p => p.kind === 'gravel').length}, paved areas ${P2.filter(p => p.kind === 'paved').length}, barrier ways ${L2.filter(l => l.kind === 'barrier').length}, kerb ways ${L2.filter(l => l.kind === 'kerb').length}`);

// ---- ray casting -------------------------------------------------------------------------
// distance along a ray (origin o, unit dir u) to each crossing of a polyline
function hits(o, u, pts, closed, out) {
  const m = pts.length - (closed ? 0 : 1);
  for (let k = 0; k < m; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length], ex = b[0] - a[0], ey = b[1] - a[1], den = u[0] * ey - u[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const ax = a[0] - o[0], ay = a[1] - o[1], t = (ax * ey - ay * ex) / den, v = (ax * u[1] - ay * u[0]) / den;
    if (t > 0 && t < REACH && v >= 0 && v < 1) out.push(t);
  }
}
const inBB = (bb, o, u) => { const x1 = o[0] + u[0] * REACH, y1 = o[1] + u[1] * REACH; return !(Math.max(o[0], x1) < bb[0] || Math.min(o[0], x1) > bb[2] || Math.max(o[1], y1) < bb[1] || Math.min(o[1], y1) > bb[3]); };
// how far the ray may go before it is closer to another part of the lap
function ownReach(i, u) {
  for (let o = track.hw[i] + 4; o < REACH; o += 3) {
    const px = track.x[i] + u[0] * o, py = track.y[i] + u[1] * o;
    if (nearTrack(px, py, o - 1, (q) => { const gap = Math.abs(q - i); return Math.min(gap, n - gap) > 70; })) return o;
  }
  return REACH;
}
const m = Math.floor(n / STEP);
const res = { L: [], R: [] };
for (let k = 0; k < m; k++) {
  const i = k * STEP, h = track.heading[i], o = [track.x[i], track.y[i]];
  for (const side of ['L', 'R']) {
    const sg = side === 'L' ? 1 : -1, u = [-Math.sin(h) * sg, Math.cos(h) * sg], lim = ownReach(i, u), edge = track.hw[i];
    const rec = { gravel: null, paved: null, wall: null, kerb: null };
    for (const kind of ['gravel', 'paved']) {
      let lo = Infinity, hi = -Infinity;
      for (const p of P2) {
        if (p.kind !== kind || !inBB(p.bb, o, u)) continue;
        const t = []; hits(o, u, p.pts, true, t); t.sort((a, b) => a - b);
        // inside intervals are [t0,t1], [t2,t3], ... (origin on the road is outside a trap; if it is inside a paved area the count is odd)
        if (t.length % 2) t.unshift(0);
        for (let q = 0; q + 1 < t.length; q += 2) { const a = Math.max(t[q], edge), b = Math.min(t[q + 1], lim); if (b - a > 1.5 && a < edge + 45) { lo = Math.min(lo, a); hi = Math.max(hi, b); } }
      }
      if (hi > lo) rec[kind] = [lo, hi];
    }
    let wd = Infinity, kd = Infinity;
    for (const l of L2) {
      if (!inBB(l.bb, o, u)) continue;
      const t = []; hits(o, u, l.pts, false, t);
      for (const v of t) { if (l.kind === 'kerb') { if (Math.abs(v - edge) < 4) kd = Math.min(kd, v); } else if (v > edge + 1.2 && v < lim) wd = Math.min(wd, v); }
    }
    if (wd < Infinity) rec.wall = wd; if (kd < Infinity) rec.kerb = kd;
    res[side].push(rec);
  }
}
// ---- encode --------------------------------------------------------------------------------
const r1 = (v) => Math.round(v * 10) / 10;
function runs(side, kind) {
  const out = []; let cur = null;
  for (let k = 0; k <= m; k++) {
    const v = k < m ? res[side][k][kind] : null;
    if (v) { if (!cur) { cur = { i0: k * STEP, a: [], b: [] }; } cur.a.push(r1(v[0])); cur.b.push(r1(v[1])); }
    else if (cur) { if (cur.a.length >= 3) out.push([cur.i0, cur.a, cur.b]); cur = null; }
  }
  return out;
}
// barrier distance: median-filtered, then run-length encoded with gaps (null = no mapped barrier)
function wallRuns(side) {
  const raw = res[side].map(r => r.wall), out = []; let cur = null;
  const med = raw.map((v, k) => { const w = []; for (let q = -2; q <= 2; q++) { const x = raw[(k + q + m) % m]; if (x != null) w.push(x); } if (w.length < 3 || v == null) return null; w.sort((a, b) => a - b); return w[w.length >> 1]; });
  for (let k = 0; k <= m; k++) {
    const v = k < m ? med[k] : null;
    if (v != null) { if (!cur) cur = [k * STEP, []]; cur[1].push(Math.round(v)); } else if (cur) { if (cur[1].length >= 4) out.push(cur); cur = null; }
  }
  return out;
}
function kerbRuns(side) {
  const out = []; let cur = null;
  for (let k = 0; k <= m; k++) { const v = k < m ? res[side][k].kerb : null; if (v != null) { if (!cur) cur = [k * STEP, k * STEP]; cur[1] = k * STEP; } else if (cur) { if (cur[1] - cur[0] >= 8) out.push(cur); cur = null; } }
  return out;
}
const osm = {
  note: 'Derived from OpenStreetMap (ODbL) by tools/trackside-osm.mjs. Offsets in metres from the centreline along the track normal; indices are 1 m samples.',
  georef: G.fixed ? { lat0, lon0, note: 'centreline is OSM geometry in this projection: no fit needed' } : { lat0: +lat0.toFixed(6), lon0: +lon0.toFixed(6), rotDeg: +(G.th * 180 / Math.PI).toFixed(3), residual: +G.err.toFixed(2), matched: +(G.inl / G.total).toFixed(3) },
  step: STEP, n,
  gravelL: runs('L', 'gravel'), gravelR: runs('R', 'gravel'), pavedL: runs('L', 'paved'), pavedR: runs('R', 'paved'),
  wallL: wallRuns('L'), wallR: wallRuns('R'), kerbL: kerbRuns('L'), kerbR: kerbRuns('R'),
};
const cover = (rs) => rs.reduce((a, r) => a + r[1].length * STEP, 0);
console.log(` gravel L ${osm.gravelL.length} runs / ${cover(osm.gravelL)} m, R ${osm.gravelR.length} / ${cover(osm.gravelR)} m; paved L ${cover(osm.pavedL)} m, R ${cover(osm.pavedR)} m; barrier L ${cover(osm.wallL)} m, R ${cover(osm.wallR)} m of ${n} m; kerb ways L ${osm.kerbL.length}, R ${osm.kerbR.length}`);
for (const side of ['L', 'R']) for (const r of osm['gravel' + side]) console.log(`  gravel ${side} s=${r[0]}..${r[0] + r[1].length * STEP}  inner ${Math.min(...r[1])}  outer max ${Math.max(...r[2])}`);
for (const side of ['L', 'R']) for (const r of osm['paved' + side]) console.log(`  paved  ${side} s=${r[0]}..${r[0] + r[1].length * STEP}  inner ${Math.min(...r[1])}  outer max ${Math.max(...r[2])}`);
if (WRITE) {
  if (!G.fixed && (G.err > 4 || G.inl < 0.9 * G.total)) { console.log('georeference not trustworthy: not written'); process.exit(1); }
  const file = new URL(`../src/sim/tracks/${id}.json`, import.meta.url), def = JSON.parse(fs.readFileSync(file));
  def.trackside = { ...(def.trackside || {}), osm };
  fs.writeFileSync(file, JSON.stringify(def));
  console.log(' written to', file.pathname);
}
if (svgOut) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, track.x[i]); x1 = Math.max(x1, track.x[i]); y0 = Math.min(y0, track.y[i]); y1 = Math.max(y1, track.y[i]); }
  x0 -= 120; y0 -= 120; x1 += 120; y1 += 120;
  const sc = 2400 / Math.max(x1 - x0, y1 - y0), X = (x) => ((x - x0) * sc).toFixed(1), Y = (y) => ((y1 - y) * sc).toFixed(1);
  const path = (pts, z) => 'M' + pts.map(p => X(p[0]) + ' ' + Y(p[1])).join('L') + (z ? 'Z' : '');
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${((x1 - x0) * sc).toFixed(0)}" height="${((y1 - y0) * sc).toFixed(0)}" style="background:#3d5a36">`;
  for (const p of P2) s += `<path d="${path(p.pts, true)}" fill="${p.kind === 'gravel' ? '#d9c48a' : '#777'}" stroke="none"/>`;
  for (const l of L2) s += `<path d="${path(l.pts, false)}" fill="none" stroke="${l.kind === 'kerb' ? '#f33' : l.sub === 'building' ? '#a86' : '#fff'}" stroke-width="1"/>`;
  const edge = (sg) => { const o = []; for (let i = 0; i < n; i += 2) { const h = track.heading[i]; o.push([track.x[i] - Math.sin(h) * sg * track.hw[i], track.y[i] + Math.cos(h) * sg * track.hw[i]]); } return o; };
  s += `<path d="${path(edge(1), true)}" fill="none" stroke="#111" stroke-width="1.2"/><path d="${path(edge(-1), true)}" fill="none" stroke="#111" stroke-width="1.2"/>`;
  for (let i = 0; i < n; i += 100) s += `<text x="${X(track.x[i])}" y="${Y(track.y[i])}" font-size="13" fill="#ff0">${i}</text>`;
  s += '</svg>'; fs.writeFileSync(svgOut, s);
}
