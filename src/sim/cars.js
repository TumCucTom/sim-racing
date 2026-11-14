// Car specifications. All fictional models, but every number is chosen to sit
// inside the envelope of a real class of car (see tools/validate-cars.js,
// which measures 0-100, braking distance, skidpad g and top speed against
// published ranges for that class).
//
// Units: SI unless noted. Torque curves are [rpm, Nm] at wide-open throttle.

const TIRES = {
  // mu0 at nominal load, load sensitivity, peak slip angle (rad) / ratio,
  // Pacejka shape factor C (lower = more progressive breakaway).
  street: { muX: 1.27, muY: 1.10, loadSens: 0.10, peakAlpha: 0.150, peakKappa: 0.115, C: 1.42, tOpt: 80, tWin: 50, squeal: 1.0 },
  sport:  { muX: 1.31, muY: 1.19, loadSens: 0.10, peakAlpha: 0.140, peakKappa: 0.110, C: 1.45, tOpt: 85, tWin: 48, squeal: 0.9 },
  slick:  { muX: 1.72, muY: 1.66, loadSens: 0.12, peakAlpha: 0.115, peakKappa: 0.090, C: 1.55, tOpt: 90, tWin: 40, squeal: 0.5 },
  f1:     { muX: 1.95, muY: 1.88, loadSens: 0.10, peakAlpha: 0.100, peakKappa: 0.080, C: 1.60, tOpt: 100, tWin: 38, squeal: 0.35 },
};

export const CARS = {
  hatch: {
    id: 'hatch', name: 'Vanta RS', klass: 'Hot hatch · FWD · 2.0 turbo I4',
    blurb: 'Front-drive, torque-rich and nose-heavy. Trail-brake it or it pushes.',
    mass: 1455, wheelbase: 2.70, frontWeight: 0.62, cgHeight: 0.53, trackF: 1.60, trackR: 1.59,
    yawK: 1.0, wheelRadius: 0.335, wheelInertia: 1.5,
    drive: 'FWD', diff: { lock: 60, preload: 60, ramp: 0.25 },
    tireStagger: 0.3, tire: TIRES.sport, rollStiffFront: 0.56,
    CdA: 0.74, ClA: 0.12, aeroBalance: 0.40,
    brakeTorque: 7600, brakeBias: 0.74, abs: true, tc: true,
    engine: {
      layout: 'I4', cylinders: 4, turbo: true, inertia: 0.18,
      idle: 850, redline: 7000, limiter: 7100,
      torque: [[1000, 180], [1500, 260], [2000, 350], [2600, 420], [4000, 420], [5000, 405], [6000, 370], [6500, 345], [7000, 300], [7300, 240]],
      friction: [18, 0.011],       // Nm + Nm/rpm engine braking at closed throttle
    },
    gears: [3.625, 2.115, 1.529, 1.125, 0.911, 0.734], finalDrive: 4.111, shiftTime: 0.22, efficiency: 0.91,
    steerLock: 0.56, body: { style: 'hatch', length: 4.56, width: 1.89, height: 1.41, color: 0x1f6fd0 },
    reference: { zeroTo100: [5.0, 6.0], brake100: [31, 37], latG: [0.98, 1.12], topKmh: [262, 282] },
  },
  coupe: {
    id: 'coupe', name: 'Brawler GT 5.0', klass: 'Muscle coupe · RWD · 5.0 V8',
    blurb: 'Big cross-plane V8, long gearing, soft-ish rear. Steers with the throttle.',
    mass: 1795, wheelbase: 2.72, frontWeight: 0.54, cgHeight: 0.50, trackF: 1.60, trackR: 1.63,
    yawK: 1.0, wheelRadius: 0.345, wheelInertia: 1.8,
    drive: 'RWD', diff: { lock: 90, preload: 80, ramp: 0.35 },
    tireStagger: 0.7, tire: TIRES.street, rollStiffFront: 0.60,
    CdA: 0.86, ClA: 0.06, aeroBalance: 0.35,
    brakeTorque: 9200, brakeBias: 0.70, abs: true, tc: true,
    engine: {
      layout: 'V8X', cylinders: 8, turbo: false, inertia: 0.24,
      idle: 750, redline: 7400, limiter: 7500,
      torque: [[1000, 380], [2000, 470], [3000, 520], [4000, 555], [4800, 570], [5500, 560], [6500, 525], [7000, 488], [7500, 430]],
      friction: [28, 0.016],
    },
    gears: [3.237, 2.104, 1.422, 1.000, 0.814, 0.622], finalDrive: 3.55, shiftTime: 0.25, efficiency: 0.90,
    steerLock: 0.55, body: { style: 'coupe', length: 4.79, width: 1.92, height: 1.38, color: 0xc8102e },
    reference: { zeroTo100: [4.2, 5.0], brake100: [31.5, 37], latG: [0.93, 1.05], topKmh: [270, 300] },
  },
  gt3: {
    id: 'gt3', name: 'Arrow GT3-R', klass: 'GT3 race car · RWD · 4.0 flat-six',
    blurb: 'Slicks, real downforce, race ABS and traction control. The benchmark car.',
    mass: 1320, wheelbase: 2.46, frontWeight: 0.41, cgHeight: 0.40, trackF: 1.66, trackR: 1.64,
    yawK: 0.95, wheelRadius: 0.345, wheelInertia: 1.6,
    drive: 'RWD', diff: { lock: 140, preload: 120, ramp: 0.45 },
    tireStagger: 1.0, tire: TIRES.slick, rollStiffFront: 0.47,
    CdA: 1.02, ClA: 2.45, aeroBalance: 0.40,
    brakeTorque: 11500, brakeBias: 0.66, abs: true, tc: true,
    engine: {
      layout: 'F6', cylinders: 6, turbo: false, inertia: 0.11,
      idle: 1600, redline: 9000, limiter: 9150,
      torque: [[2000, 330], [3500, 390], [5000, 440], [6200, 470], [7000, 465], [8000, 452], [8600, 440], [9000, 415], [9300, 360]],
      friction: [22, 0.012],
    },
    gears: [3.12, 2.33, 1.84, 1.50, 1.24, 1.04], finalDrive: 4.0, shiftTime: 0.05, efficiency: 0.93,
    steerLock: 0.42, body: { style: 'gt', length: 4.57, width: 2.04, height: 1.25, color: 0xf2f2f2 },
    reference: { zeroTo100: [2.9, 3.6], brake100: [22, 29], latG: [1.45, 1.75], topKmh: [270, 295] },
  },
  formula: {
    id: 'formula', name: 'FX-10', klass: 'Grand-prix single-seater · RWD · 3.0 V10',
    blurb: '900 hp, 19,000 rpm, 650 kg. Grip grows with speed — trust the aero.',
    mass: 655, wheelbase: 3.05, frontWeight: 0.455, cgHeight: 0.27, trackF: 1.47, trackR: 1.41,
    yawK: 0.85, wheelRadius: 0.33, wheelInertia: 0.95,
    drive: 'RWD', diff: { lock: 120, preload: 80, ramp: 0.5 },
    tireStagger: 1.0, tire: TIRES.f1, rollStiffFront: 0.52,
    CdA: 1.22, ClA: 3.55, aeroBalance: 0.44,
    brakeTorque: 14500, brakeBias: 0.60, abs: false, tc: true,
    engine: {
      layout: 'V10', cylinders: 10, turbo: false, inertia: 0.035,
      idle: 4000, redline: 18800, limiter: 19000,
      torque: [[4000, 200], [8000, 280], [11000, 322], [14000, 352], [16000, 358], [17500, 352], [18500, 340], [19000, 322], [19500, 270]],
      friction: [14, 0.0042],
    },
    gears: [2.657, 2.088, 1.708, 1.445, 1.255, 1.109, 1.0], finalDrive: 6.85, shiftTime: 0.025, efficiency: 0.94,
    steerLock: 0.36, body: { style: 'formula', length: 4.6, width: 1.8, height: 0.96, color: 0xff6a00 },
    reference: { zeroTo100: [2.2, 2.9], brake100: [15, 21], latG: [2.3, 3.2], topKmh: [320, 350] },
  },
  ev: {
    id: 'ev', name: 'Volt-R Quad', klass: 'Electric super-saloon · AWD · dual motor',
    blurb: 'Instant torque and four driven wheels, but 2.3 tonnes arrive at every corner.',
    mass: 2330, wheelbase: 2.90, frontWeight: 0.49, cgHeight: 0.46, trackF: 1.70, trackR: 1.67,
    yawK: 1.05, wheelRadius: 0.355, wheelInertia: 2.0,
    drive: 'AWD', frontTorqueSplit: 0.40, diff: { lock: 40, preload: 30, ramp: 0.2 },
    tireStagger: 0.6, tire: TIRES.sport, rollStiffFront: 0.56,
    CdA: 0.56, ClA: 0.22, aeroBalance: 0.45,
    brakeTorque: 13500, brakeBias: 0.66, abs: true, tc: true,
    engine: {
      layout: 'EV', cylinders: 0, turbo: false, inertia: 0.06, electric: true,
      idle: 0, redline: 16000, limiter: 16200,
      // constant torque to base speed, then constant ~560 kW
      torque: [[0, 1050], [5000, 1050], [5100, 1049], [6000, 891], [8000, 668], [10000, 535], [12000, 446], [14000, 382], [16000, 334], [16300, 0]],
      friction: [120, 0.0],  // lift-off regen
    },
    gears: [1.0], finalDrive: 8.05, shiftTime: 0, efficiency: 0.95,
    steerLock: 0.55, body: { style: 'sedan', length: 4.96, width: 1.97, height: 1.38, color: 0x2a2f36 },
    reference: { zeroTo100: [2.6, 3.2], brake100: [31, 37], latG: [0.95, 1.10], topKmh: [250, 270] },
  },
};

export const CAR_ORDER = ['gt3', 'hatch', 'coupe', 'formula', 'ev'];
