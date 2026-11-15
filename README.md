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

| car | hp | kg | 0-100 s | 100-0 m | lat g (R60) | top km/h |
|---|---|---|---|---|---|---|
| Arrow GT3-R | 531 | 1320 | 2.93 [2.9,3.6] ok | 24.2 [22,29] ok | 1.54 [1.45,1.75] ok | 283 [270,295] ok |
| Ferrari 458 Italia | 562 | 1565 | 3.40 [3.2,3.7] ok | 31.8 [30,35] ok | 1.07 [1,1.15] ok | 335 [315,335] ok |
| Vanta RS | 315 | 1455 | 5.50 [5,6] ok | 31.8 [31,37] ok | 1.09 [0.98,1.12] ok | 273 [262,282] ok |
| Brawler GT 5.0 | 480 | 1795 | 4.70 [4.2,5] ok | 32.5 [31.5,37] ok | 0.98 [0.93,1.05] ok | 300 [270,300] ok |
| FX-10 | 883 | 655 | 2.34 [2.2,2.9] ok | 20.6 [15,21] ok | 2.35 [2.3,3.2] ok | 333 [320,350] ok |
| Volt-R Quad | 766 | 2330 | 3.14 [2.6,3.2] ok | 32.0 [31,37] ok | 1.07 [0.95,1.1] ok | 269 [250,270] ok |

Format: measured `[reference range]`. The muscle coupe's top speed is unrestricted (the real car is limited to 250 km/h).

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

The AI driver is trained with PPO on the **same** `src/sim` code the game runs.

- **Environment** (`rl/env.js`): 20 Hz decisions over 300 Hz physics. 24 observations (speeds, yaw rate, lateral offset, heading error, steering, g-forces, rear slip, gradient, front/rear tyre temperature, curvature at 10 look-ahead distances up to 200 m). Two actions: steering (through the same speed-sensitive steering map the keyboard uses) and a combined throttle/brake pedal. Reward = metres of progress; leaving the circuit ends the episode with a speed-scaled penalty. Starts are randomised around the lap (12 % from the grid), with ±4 % track grip and tyre temperatures anywhere from cool to badly overheated — all drawn from the episode seed.
- **Learner** (`rl/ppo.js`): dependency-free PPO-clip, 64×64 tanh MLPs, GAE(0.95), γ = 0.992, 32 envs × 128 steps, 5 epochs, KL-adaptive learning rate. The policy is mirror-equivariant by construction (a left-hander and its mirror image share weights) and its action means are tanh-bounded.
- **Determinism**: a (car, seed, steps) triple fully determines training; evaluation is bit-reproducible (re-running the champion on the benchmark seeds gave identical lap times: **true**). The same policy produces the same lap in Node and in Chromium.
- **Protocol**: every trial is a standing start plus a 6-lap stint. *Flying lap* = lap 2, counted only inside track limits. *Stint* = all 6 laps clean, scored on the mean of laps 2–6. Checkpoints are kept during training on 4 validation seeds (8-lap stints); the champion is chosen among runs on 20 further validation seeds (clean stints first, then pace). The benchmark uses 20 different seeds (1–20). The baseline gets its best shot: its grip factor is swept and the fastest setting with every stint clean is used (grip 1.04).

**Result — Ravenscar Ridge, Arrow GT3-R, 20 fixed-seed trials each:**

| Driver | Clean stints | Stint pace (s/lap) | Clean flying laps | Flying lap mean (s) | Best | Hottest tyre | Validation (20 seeds) |
|---|---|---|---|---|---|---|---|
| Scripted baseline (grip 1.04) | 20/20 | 69.19 | 20/20 | 69.15 | 68.85 | 105 °C | — |
| PPO gt3_s1 | 20/20 | 63.72 | 20/20 | 63.66 | 63.12 | 112 °C | 20/20, 63.71 s |
| PPO gt3_s2 ★ | 20/20 | 62.98 | 20/20 | 62.94 | 62.28 | 115 °C | 20/20, 62.95 s |
| PPO gt3_s3 | 6/20 | 62.99 | 16/20 | 62.93 | 62.61 | 114 °C | 11/20, 63.02 s |
| PPO gt3_s4 | 20/20 | 63.96 | 20/20 | 63.81 | 63.44 | 109 °C | 20/20, 63.95 s |

★ = champion chosen by validation. Over a 6-lap stint it averages **62.98 s** per lap against the baseline's **69.19 s** — **9.0 % faster** — with 20 of 20 stints fully clean (baseline 20/20).

![Learning curves](docs/learning-curve-gt3.svg)

![Benchmark](docs/benchmark-gt3.svg)

Why it is faster: the baseline follows the centre line and brakes in a straight line; the policy learned to use the full width, trail-brake and carry more apex speed. In the game, press **I** to let it drive, **G** to race its ghost, or pick "AI lap" in the telemetry panel to overlay its traces on yours.

Two things that did not work first (details in the changelog): (1) the initial runs never completed a lap — agents flew off at the one significant right-hander until the policy was made mirror-symmetric; (2) the first successful policies set 62–64 s flying laps but **crashed on lap 3 of every stint** with tyres at 120–160 °C, because 60-second training episodes never showed them overheated tyres. Tyre temperature was added to the observations and to the start-state randomisation, and selection moved from one hot lap to multi-lap stints.

## Measured performance

Measured in this repository's CI-like container (4 vCPU, **no GPU**: Chromium renders with SwiftShader software rasterisation, so frame rates are a pessimistic floor, not what a GPU will do).

| Metric | Value |
|---|---|
| Physics throughput (headless Node, 1 core) | 1,083,425 steps/s = 3611× real time |
| Physics cost per 60 Hz frame (5 steps) | 0.005 ms |
| RL training throughput | 1930 env steps/s per process (4 in parallel) |
| Training time | 23.8 min per 3M-step seed |
| Build size | 1903 kB JS (502 kB gzip) + 1.7 MB car model and Draco decoder |
| Render, low @ ravenscar (software GL, 1280×720) | 55.6 fps, 178 draw calls, 112896 triangles, CPU 24.37 ms/frame |
| Render, medium @ ravenscar (software GL, 1280×720) | 24.7 fps, 290 draw calls, 231488 triangles, CPU 2.87 ms/frame |
| Render, medium @ spa (software GL, 1280×720) | 23.6 fps, 248 draw calls, 503522 triangles, CPU 2.74 ms/frame |
| Test suite | pass 16 fail 0  |

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
