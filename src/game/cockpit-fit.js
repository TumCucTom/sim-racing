// Where the driver sits. Pure geometry on the body height map from cockpit-scan.js (no three.js,
// so it runs under node): finds the roof, the windscreen and its base, the belt line and the
// width of the glasshouse, and from those places the eye point, the bonnet camera and the convex
// "cabin hull" (windscreen plane, two side-glass planes, front and rear limits) that the cockpit
// kit is built on and that is cut out of the exterior model while you sit inside it.
// Everything is in the chassis frame: +X forward, +Y up, +Z right, origin under the CG.

// Ergonomics per class. Distances in metres; `back` = eye behind the windscreen header, `lo`/`hi` =
// allowed eye position as a fraction of the wheelbase ahead of the rear axle, `drop` = eye below
// the roof skin, `seat` = seat centre as a fraction of the body half-width, `reach`/`fall` = wheel
// centre ahead of / below the eye, `rake` = column angle above horizontal (rad), `ratio` = steering
// ratio (wheel angle / road-wheel angle), `maxTurn` = most the wheel is shown turned (rad).
export const COCKPIT_CLASS = {
  road: { back: 0.33, lo: 0.36, hi: 0.50, drop: 0.215, seat: 0.40, reach: 0.50, fall: 0.265, rake: 0.40, wheelR: 0.185, ratio: 14, maxTurn: 2.2, fov: 58 },
  gt: { back: 0.44, lo: 0.33, hi: 0.47, drop: 0.25, seat: 0.40, reach: 0.46, fall: 0.225, rake: 0.24, wheelR: 0.155, ratio: 11, maxTurn: 2.0, fov: 58 },
  proto: { back: 0.45, lo: 0.36, hi: 0.56, drop: 0.20, seat: 0.22, reach: 0.44, fall: 0.20, rake: 0.20, wheelR: 0.145, ratio: 9, maxTurn: 1.9, fov: 58 },
  formula: { reach: 0.40, fall: 0.17, rake: 0.16, wheelR: 0.13, ratio: 7, maxTurn: 1.8, fov: 58 },
};
// Per-car exceptions; a car spec may carry the same fields in `spec.cockpit`.
//   klass, side (-1 left-hand drive, +1 right-hand drive, 0 central), eye: [dx, dy, dz] nudge in metres,
//   plus any COCKPIT_CLASS field.
const OVERRIDES = {
  mini: { side: 1 },          // a Mini is driven from the right
};

export function cockpitClass(spec) {
  const k = `${spec.klass || ''} ${spec.name || ''}`;
  if (spec.body.style === 'formula' || /single-seater|formula/i.test(k)) return 'formula';
  if (/prototype|hypercar|LMP|LMH|LMDh/i.test(k)) return 'proto';
  if (spec.body.style === 'gt' || /GT[234]\b|race car|touring car/i.test(k)) return 'gt';
  return 'road';
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function fitCabin(hm, spec) {
  const ov = { ...OVERRIDES[spec.id], ...spec.cockpit }, klass = ov.klass || cockpitClass(spec);
  const E = { ...COCKPIT_CLASS[klass], ...ov }, { x0, zh, cell, nx, nz, T } = hm;
  const a = spec.wheelbase * (1 - spec.frontWeight), bb = spec.wheelbase * spec.frontWeight, wb = spec.wheelbase;
  const top = (x, z) => { const i = Math.floor((x - x0) / cell), j = Math.floor((z + zh) / cell); return i < 0 || i >= nx || j < 0 || j >= nz ? 0 : T[i * nz + j]; };
  const band = (x, z0, z1) => { let m = 0; for (let z = z0; z <= z1 + 1e-6; z += cell) m = Math.max(m, top(x, z)); return m; };
  const area = (xa, xb, zmax) => { let m = 0; for (let x = xa; x <= xb + 1e-6; x += cell) m = Math.max(m, band(x, 0, zmax)); return m; };
  const side = ov.side ?? (klass === 'formula' ? 0 : -1);
  const fit = { klass, side, E, a, bb, open: klass === 'formula' };

  if (klass === 'formula') {
    // open cockpit: the eyes are just ahead of the airbox, a hand's width above the cockpit rim
    let xPk = 0, H = 0; for (let x = -bb + 0.5; x <= a - 0.8; x += cell) { const y = band(x, 0, 0.06); if (y > H) { H = y; xPk = x; } }
    const ex = clamp(xPk + 0.47, -bb + 0.42 * wb, -bb + 0.62 * wb);
    let rim = 0; for (let x = ex; x <= ex + 0.3; x += cell) rim = Math.max(rim, band(x, 0.17, 0.3));
    const scuttle = area(ex + 0.5, ex + 0.75, 0.08);
    const ey = clamp(Math.max(rim, scuttle) + 0.135, 0.66, 0.86);
    Object.assign(fit, { H, rim: rim || 0.58, scuttle: scuttle || 0.56, halfW: 0.24, eye: [ex, ey, 0] });
    // nose camera: on the scuttle ahead of the cockpit, clear of everything around it
    const nx0 = ex + 0.72; fit.bonnet = [nx0, area(nx0 - 0.12, nx0 + 0.45, 0.14) + 0.13, 0]; fit.bonnetPitch = -0.1;
    fit.planes = [];
    return nudge(fit, ov);
  }

  // roof profile under the driver's head (a band off the centreline: fins, scoops and aerials sit on it)
  const X0 = -bb - 0.1, N = Math.ceil((a + 1.0 - X0) / cell), P = new Float32Array(N), Ps = new Float32Array(N), xi = (i) => X0 + i * cell;
  for (let i = 0; i < N; i++) P[i] = band(xi(i), 0.10, 0.30);
  for (let i = 0; i < N; i++) { let s = 0, n = 0; for (let k = -2; k <= 2; k++) if (i + k >= 0 && i + k < N) { s += P[i + k]; n++; } Ps[i] = s / n; }
  const at = (x) => Ps[clamp(Math.round((x - X0) / cell), 0, N - 1)];
  let H = 0; for (let i = 0; i < N; i++) if (xi(i) > -bb + 0.15 && xi(i) < a - 0.25) H = Math.max(H, Ps[i]);
  let iTop = 0; for (let i = 0; i < N; i++) if (xi(i) > -bb + 0.15 && xi(i) < a - 0.25 && Ps[i] >= H - 0.03) iTop = i;
  const d1 = (i) => Ps[i] - Ps[Math.min(N - 1, i + 4)], d2 = (i) => Ps[i] - Ps[Math.min(N - 1, i + 8)];
  // header: where the roof turns down into the windscreen
  let iH = iTop; for (let i = Math.max(0, iTop - 16); i < N - 8; i++) if (d1(i) > 0.028 && d2(i) > 0.07) { iH = i; break; }
  // base of the windscreen: where the steep glass meets the flatter bonnet (kink or wiper trench)
  const iLim = Math.min(N - 9, Math.round((Math.min(a + 0.3, xi(iH) + 1.3) - X0) / cell));
  let iC = -1; for (let i = iH + 10; i <= iLim; i++) if (d1(i) < 0.022 && d2(i) < 0.05) { iC = i; break; }
  if (iC < 0) iC = Math.min(iLim, Math.round((xi(iH) + 0.9 - X0) / cell));
  const header = { x: xi(iH), y: Ps[iH] }, cowl = { x: xi(iC), y: Math.min(Ps[iC], Ps[Math.min(N - 1, iC + 2)]) };

  // open-top car: there is a windscreen frame but nothing over the seats
  const openTop = at(header.x - 0.4) < H - 0.25;
  // eye: behind the header, kept within the part of the wheelbase where people actually sit
  const ex = clamp(header.x - E.back, -bb + E.lo * wb, -bb + E.hi * wb);
  // body half-width beside the driver (mirrors are further forward)
  let halfW = 0; for (let x = ex - 0.3; x <= ex + 0.1; x += cell) { let w = 0; for (let z = 0; z < zh; z += cell) if (top(x, z) > 0.4) w = z + cell; halfW = Math.max(halfW, w); }
  // glasshouse: half-width at height y (first gap going outwards), belt = where the side glass lands on the shoulder
  const gw = (x, y) => { let z = 0.1; while (z < zh && top(x, z) >= y) z += cell; return z; };
  const roofC = openTop ? header.y : at(ex);
  const beltAt = (x) => {
    if (openTop) return Math.max(top(x, halfW - 0.12), top(x, halfW - 0.17));
    let z = gw(x, at(x) - 0.12), y = top(x, z);
    for (; z < halfW + cell; z += cell) { const y1 = top(x, z + 2 * cell); if (y1 < 0.3) break; if (y - y1 < 0.03) { y = Math.max(y, y1); break; } y = y1 > 0 ? y1 : y; }
    return y;
  };
  let belt = clamp((beltAt(ex) + beltAt(ex + 0.25)) / 2, cowl.y - 0.07, cowl.y + 0.11);
  if (klass === 'proto') belt = clamp(belt, cowl.y - 0.04, cowl.y + 0.2);
  const headW = openTop ? halfW - 0.1 : gw(ex, roofC - E.drop + 0.08);
  const ez = side * Math.max(0, Math.min(E.seat * halfW, headW - 0.19));
  const roofE = openTop ? header.y + 0.11 : Math.max(top(ex, Math.abs(ez)), top(ex - 0.08, Math.abs(ez)), top(ex + 0.08, Math.abs(ez))) || roofC;
  const ey = clamp(roofE - E.drop, cowl.y + 0.125, roofE - 0.13);
  fit.openTop = openTop;
  Object.assign(fit, { H, halfW, header, cowl, belt, roof: roofE, eye: [ex, ey, ez] });

  // cabin hull, planes as [nx, ny, nz, d] with n.p + d < 0 inside
  const hull = [];
  { // windscreen: through header and base on the head band, lifted clear of every bit of glass across the car
    const dx = cowl.x - header.x, dy = cowl.y - header.y, l = Math.hypot(dx, dy), n = [-dy / l, dx / l, 0];
    let d = -1e9; for (let x = header.x - 0.1; x <= cowl.x + 1e-6; x += cell) for (let z = 0; z <= halfW; z += cell) { const y = top(x, z); if (y > 0.3) d = Math.max(d, n[0] * x + n[1] * y); }
    fit.ws = { n, d: -(d + 0.015), slope: Math.atan2(-dy, dx) }; hull.push([n[0], n[1], 0, -(d + 0.015)]);
  }
  { // side glass: plane through the glass at belt and roof-rail height, at two stations along the cabin
    const yLo = belt + 0.05, yHi = Math.max(yLo + 0.08, roofC - 0.09), s1 = ex - 0.15, s2 = Math.min(ex + 0.4, header.x);
    const wO = halfW - 0.1, A = [s1, yLo, openTop ? wO : gw(s1, yLo)], B = [s1, yHi, openTop ? wO - 0.25 * (yHi - yLo) : gw(s1, yHi)], C = [s2, yLo, openTop ? wO - 0.03 : gw(s2, Math.min(yLo, at(s2) - 0.1))];
    if (C[2] > A[2]) C[2] = A[2]; if (A[2] - C[2] > 0.12) C[2] = A[2] - 0.12;          // plan taper: narrower forward, a little
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; const l = Math.hypot(...n) * Math.sign(n[2] || 1); n = n.map(c => c / l);
    const d = -(n[0] * A[0] + n[1] * A[1] + n[2] * A[2] + 0.02);
    fit.sideGlass = { n, d, wBelt: A[2], wRoof: B[2], yLo, yHi };
    hull.push([n[0], n[1], n[2], d], [n[0], n[1], -n[2], d]);
  }
  fit.xFront = cowl.x + 0.03; fit.xRear = ex - 0.62;
  hull.push([1, 0, 0, -fit.xFront], [-1, 0, 0, fit.xRear]);
  fit.planes = hull;
  // bonnet camera: on the centreline just above the base of the windscreen, clear of glass, wipers and bonnet
  const bx = cowl.x - 0.06; fit.bonnet = [bx, area(bx - 0.14, bx + 0.4, 0.22) + 0.15, 0]; fit.bonnetPitch = -0.13;
  return nudge(fit, ov);
}

function nudge(fit, ov) { if (ov.eye) for (let i = 0; i < 3; i++) fit.eye[i] += ov.eye[i] || 0; return fit; }
