# Racing Simulator

A browser racing simulator with a deterministic vehicle-dynamics core, five
cars from different classes plus a real Ferrari 458 Italia, four circuits (one original, three real layouts),
synthesised engine audio, an interactive telemetry overlay — and an AI driver
trained with reinforcement learning on the same physics code the browser runs.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # 16 tests: physics, determinism, car envelopes, tracks, audio
npm run validate   # measure every car against real-world figures
npm run train -- --car gt3 --seed 1 --steps 3000000
npm run benchmark  # fixed-seed RL vs baseline, writes docs/benchmark-gt3.json
npm run plot       # docs/learning-curve-gt3.svg, docs/benchmark-gt3.svg
```

Controls: **WASD / arrows** drive (gamepad supported) · **Q / E** shift ·
**M** auto/manual · **R** recover · **Enter** restart · **C** camera ·
**T** telemetry · **G** ghost (best / AI) · **I** AI autopilot · **Z** ABS ·
**X** TC · **F** perf stats · **N** mute · **1–6** car · **Esc** menu.

## Architecture

```
src/sim/      deterministic core, no DOM — shared by browser, tests and RL
  track.js      circuits -> typed arrays (centreline, width, curvature, elevation, walls)
  vehicle.js    vehicle dynamics (300 Hz fixed step)
  cars.js       six car specifications + real-world reference envelopes
  sim.js        car + track + lap/sector timing + track limits
  drivers/      scripted baseline, RL observation/action interface, policy runner
src/game/     Three.js renderer, cameras, HUD, telemetry, effects, cannon-es props
src/audio/    procedural audio synthesiser (AudioWorklet)
rl/           environment, PPO, training, benchmark, plots
tools/        car validation, lap runner, headless screenshot helpers
tests/        node:test suites
```

**Physics library choice.** Three.js renders; cannon-es simulates the loose
trackside objects (cones, braking boards) that the car knocks around. The car
itself is *not* a rigid-body-engine vehicle: generic raycast vehicles don't
give believable tyre behaviour and aren't bit-reproducible, and the RL work
needs both. The vehicle model is purpose-written and runs identically in Node
and the browser (same seed + same inputs = identical state, tested).

### Vehicle model
3-DOF planar chassis plus four wheel-spin states at 300 Hz:

- **Tyres** — combined-slip Magic Formula on a normalised slip vector, load
  sensitivity of peak grip, cornering stiffness that grows sub-linearly with
  load, surface-dependent grip (asphalt / kerb / grass / gravel), and a thermal
  state that costs grip when cold or overheated.
- **Load transfer** — lagged longitudinal and lateral transfer with a per-car
  roll-stiffness split, plus speed-squared downforce with an aero balance.
- **Drivetrain** — engine torque curves, turbo spool, rev limiter, clutch slip
  on launch, gear ratios with shift torque-cut, limited-slip differential,
  FWD / RWD / AWD, lift-off regen on the EV.
- **Aids** — ABS with rear-axle EBD and a model-based traction-control torque
  limiter, only on cars whose real counterparts have them (toggle with Z / X).
- **Environment** — road gradient, track limits, walls.

Not modelled: suspension geometry/kinematics, vertical dynamics over crests,
tyre wear, fuel load, car-to-car contact.

### Cars — measured, not asserted
`npm run validate` runs each car through standard tests on a flat pad and
checks the result against a published range for that class of car:

VALIDATION_TABLE

The lap-time hierarchy on the original circuit (same scripted driver):
formula 57 s < GT3 72 s < EV 84 s < hot hatch 90 s ≈ muscle coupe 91 s.

### Circuits
| Circuit | Length | Source |
|---|---|---|
| Ravenscar Ridge | 2.91 km | Original design: 10 turns, 23 m relief, hairpin, esses, flat-out kink |
| Silverstone GP | 5.89 km | Surveyed centreline + widths (TUMFTM racetrack-database, LGPL-3.0) |
| Spa-Francorchamps | 7.00 km | same |
| Monza | 5.79 km | same |

What "real" means here, precisely: the **plan-view layout and track width are
real survey data** (lap lengths are within 0.5 % of the official figures —
tested). The source has **no elevation**, so height on the real circuits is a
hand-approximated profile (Spa's ~100 m of relief is roughly right in shape,
not surveyed). **Kerbs, run-off, barriers, buildings and scenery are
procedurally generated**, not replicas of the real venues. Laser-scan-grade
recreations would need licensed scan data and hand-built art assets.

### Audio
The engine voice is built the way the sound is physically made: each cylinder
fires once per 720° at its own crank offset, each firing is an exhaust pulse,
pulses are collected per bank and coloured by that bank's pipe resonances.
Firing order therefore shapes the timbre as it does on a real engine — the
tests check the spectra:

| Car | Layout | Dominant order (measured) |
|---|---|---|
| Vanta RS | inline-4 turbo | 2×, 4×, 6× crank; turbo whistle + blow-off |
| Brawler GT | cross-plane V8 | 4× with strong 1×, 2×, 3× sub-orders (the burble) |
| Arrow GT3-R | flat-6 | 3× and 6× with some 1.5× (separate banks), straight-cut gear whine |
| FX-10 | V10 | 5× crank — 1.5 kHz fundamental at 18,000 rpm |
| Volt-R | electric | motor orders tracking motor speed, no combustion |
| Ferrari 458 | flat-plane V8 | 4× and 8× crank, no sub-orders — a wail, not a burble |

Plus tyre squeal, scrub, kerb rumble, wind, loose-surface noise, impacts and
shift clunks. I could verify the audio *structurally* (spectral tests, running
worklet in headless Chromium) but could not listen to it in this environment,
so the mix levels are untested by ear.

## Reinforcement learning

RL_SECTION

## Measured performance

PERF_SECTION

## Known limitations
- Visuals are well short of a commercial sim such as Assetto Corsa. The 458
  uses a detailed third-party model; the other five car bodies are procedural
  lofts (recognisable silhouettes, not photoreal) and all scenery is low-poly
  and generated in code. Closing that gap needs authored 3D assets.
- Real circuits: accurate layout/width only (see above); the in-game AI on
  them is the conservative centre-line baseline, so its lap times are well off
  real-world pace.
- The RL policy is trained for one car (GT3) on one circuit (Ravenscar).
- Single car on track (ghosts don't collide); no damage model.
- Audio mix not validated by ear.

## Credits
Real-circuit geometry: [TUMFTM racetrack-database](https://github.com/TUMFTM/racetrack-database)
(LGPL-3.0). Ferrari 458 Italia 3D model by
[vicent091036](https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6) (CC BY), via the
three.js examples. Rendering: three.js. Prop physics: cannon-es. The other five car names are
fictional. This is a non-commercial technical project and is not affiliated with or endorsed by
Ferrari or the circuit owners.
