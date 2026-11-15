# Changelog

All notable changes, newest first. Numbers quoted here were measured by the
tools in this repo (`npm test`, `npm run validate`, `npm run benchmark`).

## 0.6.0 — graphics pass, a real car
- Added the Ferrari 458 Italia as a sixth car: specification from published
  figures (570 PS, 7-speed DCT ratios, 42/58 weight split), rendered with a
  detailed CC-BY glTF model instead of a procedural body. Measured in the sim:
  0–100 km/h 3.4 s, 100–0 in 32 m, 1.07 g. Flat-plane V8 audio voice (banks
  fire evenly, unlike the cross-plane muscle car).
- High quality now adds ground-truth ambient occlusion, a filmic grade with
  vignette, SMAA and a bloom that only catches real highlights (the first
  bloom setting washed the whole frame out — caught on a screenshot).
- Tyre thermal model: heat loss now rises steeply above the working window.
  Before, an over-driven tyre never reached equilibrium (hotter -> less grip ->
  more sliding -> hotter), which is what ended every RL stint on lap 6.
- RL crash penalty raised 3x so the policy keeps margin; checkpoint selection
  uses 8-lap stints.
- Honest status of visuals: this is not Assetto-Corsa-grade. One car uses a
  detailed model; the other five and all scenery are generated in code.

## 0.5.0 — AI that survives a stint
- Found by watching the AI in the game: the first trained policies lapped
  Ravenscar in 62–64 s (baseline 69.1 s, 20 fixed seeds) but hit the wall on
  lap 3 of *every* stint, with tyres at 120–160 °C. Training episodes last
  60 s, so the agent had never driven on tyres it had overheated itself.
- Fix: front/rear tyre temperature added to the observations (22 -> 24),
  training starts randomised from cool to badly overheated tyres, and both
  checkpoint selection and the benchmark now use multi-lap stints
  (all laps clean, mean pace of laps 2–N) instead of a single flying lap.
- Model selection across runs uses 20 extra validation seeds, clean-rate
  first. Selecting on 5 seeds by lap time alone had picked a fast but fragile
  policy (7/20 clean on the benchmark).
- Circuits and graphics quality now switch in place (no page reload);
  storage access is failure-safe.
- `tools/stint.js` (long-run reliability) and `tools/perf.mjs` (measurements).

## 0.4.0 — real circuits
- Added Silverstone GP, Spa-Francorchamps and Monza. Centreline and left/right
  track widths come from the open TUMFTM racetrack-database (LGPL-3.0); lap
  lengths match the real circuits (5.89 / 7.00 / 5.79 km).
- Track module now supports multiple circuits with per-sample track width.
  Run-off and walls are clipped so neighbouring pieces of track never overlap.
- Start/finish scenery (gantry, grandstand, pit building) is placed relative to
  the start pose and dropped/shrunk automatically where it would hit the track.
- Known limits: the source data has no height channel, so elevation on real
  circuits is a hand-approximated profile; scenery is procedural, not a replica.

## 0.3.0 — reinforcement-learning driver
- Deterministic RL environment (`rl/env.js`) around the shared sim: 20 Hz
  control, seeded starts and ±3–4 % grip variation, progress reward.
- Dependency-free PPO (`rl/ppo.js`): Gaussian policy, GAE, Adam, KL-adaptive
  learning rate.
- Fixed a training plateau: agents drove ~1.4 km then never braked for the
  T6/T7 right-hander (nearly all other corners are lefts). Three changes fixed
  it: a left/right mirror-equivariant policy, tanh-bounded action means, and a
  crash penalty that grows with speed. Clean flying laps now appear after
  ~200k steps instead of never.
- Fixed-seed benchmark and SVG learning-curve / benchmark plots.
- In-game AI: trained policy drives the GT3 at Ravenscar (autopilot, ghost and
  telemetry reference lap); scripted baseline elsewhere.

## 0.2.0 — playable game
- Three.js renderer: procedural sky and image-based lighting, shadows, terrain,
  kerbs, gravel traps, armco / tyre walls, trees, grandstand, pit building.
- Five procedurally lofted car models; chase / far / bonnet / TV cameras.
- Audio synthesised per cylinder firing event (see README) with turbo, gear
  whine, tyre squeal, kerb, wind and impact layers. AudioWorklet with a
  ScriptProcessor fallback.
- HUD: tacho/gear/speed cluster, pedal and steering traces, ABS/TC lamps, lap
  timer with sectors and live delta, track map.
- Interactive telemetry overlay: distance-based traces vs reference lap with
  zoom / pan / cursor, g-g diagram, tyre temperature / load / slip panel.
- Skid marks, tyre smoke, dust; cannon-es rigid-body cones and brake boards.
- Keyboard (speed-sensitive steering, ramped pedals, auto-reverse) and gamepad.

## 0.1.0 — deterministic simulation core
- Original 2.9 km circuit "Ravenscar Ridge" (10 turns, 23 m relief).
- Vehicle model: 3-DOF chassis + 4 wheel-spin DOF, combined-slip Magic Formula
  tyres with load sensitivity, load-dependent cornering stiffness and a thermal
  model; lagged load transfer; aero; engine maps, turbo lag, clutch slip,
  gearbox, limited-slip diff; FWD/RWD/AWD; ABS with EBD; traction control.
- Five cars validated against real-world envelopes for their class.
- Bugs found by running it and fixed:
  - Wheel-speed integrator added phantom inertia while accelerating (EV lost
    ~0.25 g off the line). Now integrates slip velocity semi-implicitly.
  - Slip-feedback traction control oscillated at 300 Hz during clutch-slip
    launches; replaced by a model-based torque limiter with a slip backstop.
  - Rear axle over-braked on corner entry; added realistic brake bias and EBD.
  - Tyre temperature could run away to 1e25 °C when stuck; heat input capped.
- Scripted baseline driver (pure pursuit + curvature speed profile).
- 14 automated tests (determinism, stability, car envelopes, lap timing,
  track limits, walls, audio spectra).
