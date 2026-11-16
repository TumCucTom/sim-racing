# Changelog

All notable changes, newest first. Numbers quoted here were measured by the
tools in this repo (`npm test`, `npm run validate`, `npm run benchmark`).

## Unreleased — racecraft round two: equal cars fight
- The first race mode was clean but processional (12 GT3 at Spa: 0.4 clean passes in five laps). Followers now
  run as close as the corner allows, the tow reaches further, lunges are decided in time and judged at turn-in
  (nose alongside or back out), the attacker brakes later from the tune's reserve, the inside car alongside keeps
  its lane and the outside car gives the corner up, a blocked attacker tries the outside, patience runs out
  behind the same car, and form, corner-type weaknesses and time-costing mistakes bring cars together
  (`src/sim/drivers/racecraft.js`, `src/sim/race.js`).
- Clean on-track passes per race, before -> after (`node tools/race-sim.js`, GT3, level 0.96): Spa 0.4 -> 3.4,
  Monza 1.0 -> 8.2, Monza reverse grid 1.3 -> 10.3, Ravenscar 3.0 -> 3.6, Laguna Seca 0 -> 0, 20 cars at
  Silverstone 9.3 -> 7.0. Heavy contacts per car-lap 0.007 / 0.007 / 0.006 / 0.017 / 0 / 0.010. Nordschleife
  (8 cars, 1 lap): spins 5.0 -> 0, heavy contacts 0.25 -> 0 per car-lap in these three seeds. The pass counter no
  longer drops passes of a car below 8 m/s (the Monza chicane); the old count is still printed as "strict".
- `tools/race-moments.mjs` lists the passes of a race as the browser runs it (Node and Chromium do not run the
  same seed identically); `?grid=quali` starts the player's car where its pace puts it, as the headless tool does.

## Unreleased — race mode: a field of AI cars, contact, slipstream, racecraft
- **Multi-car racing** (`src/sim/race.js`): N cars at 300 Hz in a fixed order, deterministic and DOM-free.
  Car-to-car contact (oriented rectangles, impulse with restitution and friction at the contact point,
  momentum-conserving, no energy gain, no tunnelling at 300 km/h closing), slipstream (`Vehicle.dragK` /
  `downK`, exactly 1 in free air), staggered grid, start lights, positions, gaps, classification, blue flags,
  marshals for stuck cars, track-limit penalties. A solo `Sim` is bit-identical to before (hash test).
- **Racecraft** (`src/sim/drivers/racecraft.js`): on top of the tuned racing-line driver (and identical to it
  in free air): awareness of the cars around in track coordinates, pace-matched following, lanes that leave
  a car's width, tow, pulling out late, taking the inside for the braking zone, backing out, conceding,
  one defensive move, lane-keeping starts, local yellows, seeded personalities. No rubber-banding.
- **In the game** (`src/game/racemode.js`, `racehud.js`, `src/audio/opponents.js`): **Race** in the menu (2–20
  cars, laps, grid slot, same car / class / mixed, AI level) and `?race=12&laps=5&grid=6&field=class&aiskill=0.95`
  (`&ai` for an all-AI race). A model, colour and number board per car, LOD boxes at distance, brake lights,
  smoke and spray; start lights, timing tower, map dots, CAR LEFT / RIGHT, results; follow any car with every
  camera (**J** / **K** / **U**), extra cameras (**B**), TV director (**O**); the three nearest opponents are
  audible. Scriptable for filming: `__game.startRace / followCar / setCamera / fastForward / setTimeScale`.
- **Measured** (`node tools/race-sim.js`, 38 all-AI races, every one finished, no DNF): 12 GT3 over 5 laps:
  Ravenscar 4.2 overtakes and 2.6 contacts a race (none heavy), Monza 2.0 and 2.6, Spa 0.6 and 3.0; 20 cars
  at Silverstone 9.7 overtakes, 0.3 contacts; Monaco no overtakes, 1.4 light or medium contacts. Weak spots,
  reported in the README: equal cars rarely pass each other, and the Nordschleife in traffic is scruffy
  (2 heavy contacts and 5 spins per 8-car lap). Physics: 1.4 µs per car-step, 0.14 ms a frame for 20 cars.
- **Top AI level no longer crashes the single-seater** (owner report). 8 Formula cars at level 1.0 over 13
  circuit / weather combinations, 2 seeds each: spins 103 -> 14.5, barrier hits 39 -> 7.5. Causes: full-pedal
  braking for traffic without ABS, no allowance for downforce lost in a wake, offset lanes on the grass.
  Still untidy: the Nordschleife (all classes) and the Formula car at Monaco in rain.
- **Trackside TV camera sees the car** (`src/game/tvcam.js`; owner report "blocked or clipped into something").
  Posts are checked against the built scene, the line of sight is ray-cast four times a second with a look
  ahead, with helicopter and on-track fallbacks. Car visible over a lap (`node tools/tv-los.mjs`): Ravenscar
  77.5 -> 100 %, Silverstone 73.6 -> 100 %, Spa 75.1 -> 100 %, Monza 79.1 -> 100 %, Laguna Seca 92.7 -> 100 %,
  Monaco 74.1 -> 99.5 %, Nordschleife 78.6 -> 100 %.
- 11 new tests (`tests/race.test.js`).

## Unreleased — a driver's seat in every car
- **Cockpit view rebuilt** (`src/game/cockpit.js`, `cockpit-fit.js`, `cockpit-scan.js`; **C** cycles chase,
  far, bonnet, cockpit, TV). The first attempt put the eye at the windscreen and floated a wheel in front of
  it. Now the body is rasterised once into a 2.5 cm top-down height map (2–50 ms per car in the software-GL
  test browser, cached per car) and the cabin is measured from it: roof, windscreen header and base, belt
  line, glasshouse width and plan sweep of the screen. No car is hand-placed; `spec.cockpit` can override
  (`side`, `eye` nudge, any ergonomic field). The Mini is right-hand drive, everything else with two seats
  is left-hand drive, the prototypes sit offset-centre, the single-seater central.
- **Seating.** Eye = header minus a class distance (0.33 m road, 0.44 m GT, 0.45 m prototype), clamped to
  the stretch of wheelbase where a driver can sit (0.36–0.50 of the wheelbase ahead of the rear axle for
  road cars, 0.33–0.47 GT, 0.36–0.56 prototype), 20–21 cm under the roof skin above the seat and never less
  than 12.5 cm above the scuttle. The single-seater's eyes are 0.47 m ahead of the airbox peak, 13.5 cm
  above the cockpit rim. Open-top cars (the 458 is a Spider) are detected and get no roof.
- **A procedural cockpit**, built on first use and shown only in that view: dashboard and scuttle,
  instrument cluster drawn to one 512×192 canvas at 20 Hz (rev counter, speedometer, gear, shift lights,
  ABS / TC lamps; a race logger with rev bar, gear, speed, lap time, gap to the reference lap and pedal
  bars in GT cars; on the wheel in prototypes and the formula car), steering column, round road wheel or
  flat butterfly wheel with buttons, rotaries, paddles and ten shift LEDs, gloved hands on the rim with
  two-bone IK arms, A-pillars, header, mirror, roof lining, door tops, sun strip, a roll cage and window
  net in GT cars, a centre screen in road cars, and a gear lever the inboard hand goes to on each change
  in the three manual cars. Paddles flick on a shift.
- **The model's own cabin is cut away while you sit in it.** A convex hull (windscreen plane, two
  side-glass planes, front and rear limits) is clipped per fragment out of every material of the exterior
  model, so third-party models never show a second, static steering wheel, and opaque or tinted glass
  cannot black out the view. What you see through the openings is the real model: bonnet, wings, door
  mirrors, front tyres on the formula car. The ambient-occlusion pass is skipped in this view (it cannot
  see the clipping). The kit sits beside the car in the scene graph, casts no shadow and is not seen by
  the wet-road reflection camera. It is drawn in the near half of the depth range, so rain streaks and the
  car's own spray show through the windows and never inside the cabin (before that, the cockpit greyed out
  in the wet).
- **Steering wheel**: road-wheel angle × ratio (14 road, 11 GT, 9 prototype, 7 formula), eased with a tanh
  towards 126° / 115° / 109° / 103° so the hands never leave nine and three, 40 ms lag. Positive steer is
  left and turns the wheel anticlockwise as the driver sees it; `tools/cockpit-shots.mjs` prints steer,
  road-wheel and steering-wheel angle with each photograph.
- **Camera**: rides the sprung body, so the cabin is fixed and the horizon pitches and rolls; 58–62°
  vertical field of view; looks up to 11° into the corner, moves up to 3 cm with the g-forces and tilts up
  to 1.7°; kerb and speed shake is between a third and a half of the bonnet camera's.
- **Bonnet camera**: on the centreline 14 cm above everything around the base of the windscreen (nose
  camera ahead of the cockpit on the formula car), pitched so the far edge of the bodywork sits low in the
  frame. Near plane 7 cm in the cockpit, 10 cm on the bonnet, 30 cm elsewhere as before.
- The HUD's dial shrinks in the cockpit view, where the dash shows the same numbers.
- Tests: `tests/cockpit.test.js` (seating on a synthetic saloon and roadster, overrides, class of every car).

## Unreleased — Singapore, Imola, Albert Park
- **Marina Bay** (`singapore`), **Imola** (`imola`) and **Albert Park** (`melbourne`) built from OpenStreetMap
  `type=circuit` relations by the new `tools/osm-circuit.mjs` (lengths +0.2 %, −0.2 %, +0.4 % of official;
  Singapore and Imola anticlockwise). All 16 cars lap each cleanly, the GT3 in rain too, and a 12-car GT3 race
  finishes on each without wall contact. Singapore is a walled street circuit (Monaco treatment) that opens
  at dusk: night-race circuits (`night` in the trackside file) get floodlight poles round the whole lap and a
  fill light. Flat street circuits no longer get the "falls into the sea" landscape (it produced NaN terrain).
- Barcelona and Zandvoort are built and surveyed but not registered: with OSM's coarse corner geometry several
  cars leave the road (Zandvoort around 2.26 km, Barcelona around 2.44 km). Rounding the kinks made it worse
  and was reverted. Six circuits remain unbuilt (Yas Marina, Baku, Jeddah, Miami, Lusail, Las Vegas).

## Unreleased — nine Grand Prix circuits (of twenty requested)
- **Added**: Circuit of the Americas, Hungaroring, Mexico City, Montreal, Bahrain, Interlagos, Shanghai,
  Red Bull Ring, Suzuka (`cota`, `hungaroring`, `mexico`, `montreal`, `bahrain`, `interlagos`, `shanghai`,
  `redbullring`, `suzuka`): TUMFTM centreline and widths, lengths within 0.1 % of official, direction checked
  (COTA and Interlagos anticlockwise), terrain-model elevation through `fitElevation` with per-circuit limits
  and published relief, OSM barrier lines and gravel via `tools/trackside-osm.mjs`. All 16 cars lap each
  cleanly, the GT3 also in rain, and a 12-car three-lap GT3 race finishes on each with no wall contact or DNF.
- **Suzuka's crossover**: the upper road is lifted 6.5 m onto a bridge deck (`def.crossover`; `track.deck`,
  `track.under`), verge and terrain are left out under the deck, and a test drives both roads through the
  crossing checking the car is never snapped to, or stopped by, the other one.
- **Compact circuit format** (`src/sim/tracks/gp/*.json`, `tools/add-circuit.mjs`): centreline as base64
  byte deltas in decimetres, heights as uint16; 131 kB for nine circuits. Circuits are only offered once
  marked `ready`. Hosted page 15.29 MB (limit 16). The seven older circuits were not re-encoded.
- Menu grouped (Original / Grand Prix circuits / Other) with country and length. `tools/ai-laps.js` takes a
  circuit list. `lineDriverOptions` honours a per-circuit `aiGrip` margin (used by four circuits).
- **Not done**: the other eleven circuits (Jeddah, Albert Park, Miami, Imola, Barcelona, Zandvoort, Baku,
  Singapore, Las Vegas, Lusail, Yas Marina), hand-authored corner data, scenery themes, night floodlighting,
  in-game screenshots of the new circuits.

## Unreleased — trackside from data, and Laguna Seca
- **Kerbs, run-off, gravel and barriers are now data per circuit, per corner and per side**
  (`src/sim/trackside.js`), shared by physics and renderer, instead of one curvature rule and a uniform
  run-off width. Two sources, kept apart in the data: **OpenStreetMap** gravel / sand polygons and barrier
  ways, ray-cast from the centreline by `tools/trackside-osm.mjs` (the TUMFTM circuits are georeferenced
  against OSM's raceway geometry first: mean residual 2.0 m Silverstone, 1.6 m Spa, 1.4 m Monza) and stored
  as `trackside.osm` in each circuit JSON; and **hand-authored corner entries from memory**
  (`src/sim/tracks/<id>.trackside.json`, each tagged `src: memory`): paved run-off, kerb colours and types,
  astro-turf, sausage kerbs, escape roads, pit walls. Kerb placement itself is still rule-made (apex inside,
  exit outside). README "Trackside" has the per-circuit table of what is surveyed, remembered or missing.
  Silverstone 29 OSM gravel beds, Spa 13, Monza 11, Nordschleife 7, Laguna Seca 1 (+8 by hand); Monaco has
  none, barriers at the kerb, and three escape roads modelled as paved spurs.
- **New surfaces with their own physics**: paved run-off (grip 0.95), painted run-off (0.86, 0.80 more in
  the wet), astro-turf (0.62), serrated rumble kerbs (0.90, the racing line uses less of them), sausage
  kerbs (0.50 grip, 0.12 rolling resistance: a strip that drags and yaws the car), Monaco paving (0.80; it
  was grass before). **Gravel is deep**: rolling resistance 0.17 + 0.09 by depth into the bed + 0.30 by
  speed (was a flat 0.30) — a GT3 coasting into gravel at 162 km/h loses about 8 m/s² against 3 m/s² on
  grass, and can only just crawl out. `car.surfX[]` is the detailed surface per wheel (`car.surf[]` keeps
  the four old classes, so HUD, audio and effects work unchanged) and `car.rumble` is a 0–1 vibration
  signal; the audio's kerb layer is louder on serrated and sausage kerbs. Track limits are per side
  (`track.edgeL/R`); asphalt, flat kerb and grass values are untouched.
- **Ravenscar's RL benchmark is bit-identical**: its kerbs and the first 2 m of verge are the original
  layout (`keepKerbs`), only what lies beyond was redesigned (paved run-off with a gravel band at Anvil,
  Crow's Nest and Home, gravel wedges elsewhere). The shipped GT3 policy over seeds 1–20, six-lap stints:
  20/20 clean, stint pace 62.9775 s, and the SHA-256 over the car state sampled every second of all 20
  stints is unchanged (`0a96c6a35cb4143c0982fe1e`). Largest wheel excursion of the policy beyond the kerb
  edge anywhere: 0.99 m.
- **AI laps** (`tools/ai-laps.js`, all 14 cars, all 7 circuits clean): lap times moved by at most 0.31 %
  (Monaco, kerbs now only on the inside; Spa 0.06–0.12 % quicker, the rest within 0.05 %). The Nordschleife
  keeps kerbs on both sides of every corner because four cars crashed with one-sided kerbs under the
  existing per-car tuning; no driver table was changed.
- **Rendering**: kerbs in circuit colours (red/white, red/yellow at Spa, blue/white) with a taller
  serrated profile for rumble kerbs, yellow sausage humps, astro-turf and painted aprons, paved run-off
  with tyre marks, gravel with raked furrows, ruts and a kerbed edge, conveyor-belted tyre walls with
  instanced tyre stacks, TecPro blocks, concrete pit walls, footbridges. All procedural: no new texture
  files. A `dry` landscape theme (golden grass, sparse oaks) for Laguna Seca.
- **Laguna Seca** (`laguna`): OpenStreetMap centreline (ODbL), 3,598 m against the official 3,602 m,
  anticlockwise, start line on the pit straight; USGS 3DEP 10 m elevation with light smoothing: 57.2 m
  relief, the Corkscrew drops 17.3 m in 140 m with a peak gradient of 16.3 %. Widths are estimates.
  Every car laps it cleanly (GT3 1:32.3 dry, 1:49.2 in rain).
- Tools: `tools/trackside-map.mjs` (top-down PNG of the trackside as the physics sees it),
  `tools/trackside-shot.mjs` (screenshots with a free camera). 5 new tests (`tests/trackside.test.js`);
  `npm test` passes (53 tests with the other work in flight).
- **Elevation is fitted, not clipped** (owner feedback: "elevation looks exaggerated"). Three circuits sat
  on the old gradient cap, i.e. terrain-model noise was being clipped rather than removed. `fitElevation`
  fits a periodic smoothing spline (cutoff 110–600 m by terrain-model resolution), robust to rooftops and
  bridges, bridges tunnels, and lengthens the cutoff locally where a circuit's realistic gradient or
  vertical-curvature limit is exceeded. Spa 19.8 → 13.1 % max (the −19.8 % was a false drop after
  Bruxelles), Monza 17.4 → 13.0 m relief and 5.0 → 1.8 %, Nordschleife 19.9 → 15.6 % up / 11.0 % down,
  Monaco 49.3 → 42.0 m and 11.4 → 7.3 %, Laguna unchanged in substance (Corkscrew 17.5 m in 140 m).
  Before / after table in the README. The landscape around flat circuits no longer grows hills. AI lap
  times moved by under 0.2 %; all 16 cars remain clean on all 7 circuits; no driver table changed.
- **Monaco rebuilt from OpenStreetMap** (owner feedback: "Monaco looks pretty dire"): 686 real building
  footprints extruded (tagged heights where present) with procedural Mediterranean façades and tiled
  roofs, the real coastline of Port Hercule with quay walls, water and moored yachts, an enclosed tunnel
  over stations 1,542–1,904 m with lamp rows, zebra crossings, a centre line and manhole covers on the
  road. Physics walls are unchanged. Not done: palm trees, grandstands, pit building, recognisable
  landmarks (Casino, Piscine), hillside backdrop beyond 330 m.
- Not done: real kerb positions, vertical kerb dynamics, the Karussell banking, barrier types that differ
  in a crash, Monaco's real widths. Version number not bumped (other work is in flight).

## 0.9.0 — a GT3 field
- **Five more GT3 cars**, each with its own physics, body, engine sound and AI tuning: Audi R8 LMS GT3
  (5.2 V10), Lamborghini Huracán GT3 (5.2 V10), Mercedes-AMG GT3 (6.2 front-mid V8), Ferrari 296 GT3
  (3.0 twin-turbo V6), McLaren 720S GT3 (4.0 twin-turbo V8). Wheelbase, dimensions, engine type, rev
  range and homologated weight are published figures; power is at typical balance-of-performance levels
  (521–542 hp, 1,310–1,345 kg with driver); track widths, CG heights, aero and differential settings are
  estimates chosen to reflect what the cars are known for (AMG: 49.5 % front weight, highest yaw inertia
  and drag, flat 650 Nm; Huracán: more front aero and a looser diff than the R8 it shares an engine
  with; 296 and 720S: boost-limited torque plateau, low CG, low drag). All five share the class envelope
  the Arrow GT3-R already had; `npm run validate` passes for all 14 cars.
- **Balance**: with identical AI settings (`LINE_TUNE` 0.97 / 0.6) the six GT3 cars cover 1.0 % at Ravenscar
  (64.17–64.82 s) and 0.9 % at Spa (153.33–154.69 s). The first draft had the turbo cars 1.2 % ahead at Spa
  and inside 2.9 s to 100 km/h (outside the envelope): their torque was cut by 2 % and first gear lengthened.
  Every car laps all circuits cleanly (`tools/ai-laps.js`), and the new cars lap Ravenscar and Spa cleanly
  in rain and storm (`tools/wet-laps.js`; new test in `tests/wet.test.js`). No shared
  physics code was touched for this: specs and driver tables only.
- **Models**: road-car models by jasonjliang (Audi R8), jkazulyblanco (Huracán) and Yan Carvalho (AMG GT),
  all CC BY 4.0, with a code-generated GT3 race kit (splitter, skirts, diffuser strakes, swan-neck wing)
  bolted on (`kit` in `GLB_MODELS`). The 296 and 720S have procedural mid-engined bodies (`gtmid`); a
  front-engined loft (`gtfront`) is the AMG's stand-in while its model loads. 1.65 MB of new `.glb`.
  `tools/models-build.mjs` gained `yaw` (car parked at an angle in its file) and `tyre.cyl` (tyres that
  share a material with the trim). See ASSETS.md for what was rejected and why.
- **Engine sound**: four new recorded-cycle banks (1.90 MB) from Wikimedia Commons recordings — the R8 LMS
  race car and a road R8 V10, a Huracán Performante, a McLaren 720S (real cycles from 1,800 to 8,000 rpm),
  and for the AMG one Mercedes SLS band inside a Mustang V8 bank; the 296 GT3 plays the existing Ferrari 296
  bank. The V10 banks have real cycles only up to 3,600 rpm. Sources, authors, licences and the weak
  spots are in AUDIO.md. Not listened to (no audio output here); all 16 audio tests pass for every car.
- **Two road Lamborghinis**: Huracán LP 610-4 (5.2 V10, 610 PS, AWD, 7-speed DCT, 1,630 kg with driver) and
  Aventador SVJ (6.5 V12, 770 PS, AWD, single-clutch ISR with 90 ms shifts, 1,775 kg with driver, moderate fixed
  downforce for ALA), from published figures, each with a reference envelope around the factory numbers. The
  LP 610-4 uses the Huracán model as its author made it (the GT3 car is that model plus the race kit) and the
  Huracán V10 bank; the SVJ has a procedural body and a new even-firing `V12` layout in the synthesiser
  (an SVJ recording exists on Commons but its rev blips could not be cut into cycles with a trustworthy rpm, so the V12 is synthesis). Clean AI laps on every circuit dry, and at Ravenscar, Silverstone, Spa, Monza and Laguna Seca in
  rain and storm; the SVJ's AI setting was lowered to 0.77 after it spun on its out-lap at a wet Spa.
- **Menu**: cars are grouped by class (GT3 / prototypes / single-seater / road) in a scrolling panel. Keys:
  **1–9, 0** select the first ten cars, **[** and **]** step through all sixteen (the hint in the menu said 1–6).
- Hosted page: `node tools/make-artifact.js` after `SINGLE=1 npx vite build` gives a 14.6 MB page (14,575 kB as the tool prints it); the Huracán and AMG
  models were simplified a second time to stay under 15 MB. There is no room left for another car model.

## 0.8.0 — weather, time of day, engine audio round 2
- **Six conditions**, in the menu, on **V** and as `?wx=`: clear, golden hour,
  overcast (damp), rain, storm at low sun, dusk. Generated cloud skies with
  matching sun, image-based lighting and sun-lit haze; wet asphalt with
  puddles, rain rings, a drying line and the car mirrored in the road; rain
  streaks that slant with speed, wheel spray, light shafts, water on the lens,
  lightning and thunder, headlights and floodlights. No new asset files.
- **Wet physics** (`src/sim/wet.js`, off by default and bit-identical when
  off): grip 0.77 (rain) / 0.72 (storm) / 0.88 off-line (damp), worse in
  standing water, on kerbs and grass. The racing-line driver scales its speed
  profile: 160 of 162 car/circuit/condition combinations give a clean flying
  lap (the single-seater's second lap on the damp Nordschleife breaks track
  limits; the Mini's storm lap there is clean but its flying lap runs past the
  tool's time limit). GT3 at Ravenscar 64.49 s dry, 77.79 rain, 80.74 storm.
- Rain, spray and thunder in the audio bus (`src/audio/weather.js`).

- **Engine audio, round 2** (after the first listening feedback: "not as
  realistic as I'd like"). Recorded cycles now carry only the crank-locked part
  of the sound; the rest is a never-repeating noise layer shaped to the
  recording (the old voice repeated identical noise in 4–12 % of nearby
  cycles; recordings: 0 %). Throttle contrast 5 -> 11 dB, real ignition cut on
  upshifts, downshift blips, limiter stutter, fading overrun crackle, stereo
  width, turbo whistle replaced by band-limited rush. The formula car's
  steady-state match got worse (3.4 -> 5.5 dB); still unheard by its developers.

## 0.7.1 — both prototypes
- The Audi R18 model is now its own car (**Audi R18 e-tron quattro**, 2012
  LMP1 turbodiesel, rear-drive only; passes its reference envelope, clean laps
  on all six circuits) instead of standing in for the 499P-class hypercar,
  which gets its red-and-yellow generated body back. Nine cars. The R18's
  engine is synthesised: the petrol V6 recordings failed the pitch and
  firing-order tests when stretched down to diesel revs.

## 0.7.0 — racing line, two more circuits, two more cars, real models and recorded engines
- **AI drives a racing line and trail-brakes.** Minimum-curvature line computed
  for every circuit; a line-following driver with a curvature speed profile
  replaces the centre-line driver for every car/circuit (the RL policy still
  drives the GT3 at Ravenscar). GT3 at Ravenscar: 69.19 -> 64.96 s/lap over
  20 fixed-seed stints (RL: 62.98). Share of braking time above 70 % of
  cornering grip: 8 % -> 42 % (RL 60 %). **L** draws the line on the road.
- **Nürburgring Nordschleife** (20.75 km, OpenStreetMap centreline, EU-DEM
  elevation, 288 m relief) and **Monaco** (3.31 km, barriers at the kerb).
  Spa and Monza elevation replaced by terrain-model data (Spa: 106 m relief).
- **Aurelia LMH** (499P-class Le Mans Hypercar) and a stock **Mini Cooper S**;
  both pass their real-world reference envelopes (`npm run validate`).
  `tools/ai-laps.js`: all 8 cars complete clean flying laps on all 6 circuits.
- **Visual overhaul:** photographed HDR sky and image-based lighting, scanned
  PBR road/grass/gravel, rubbered racing line, tree-line cards, real armco and
  catch-fence geometry, per-circuit themes, AgX tone mapping.
- **Car models:** six more cars use detailed openly licensed glTF models
  (seven of eight in total). Many obvious matches on model-sharing sites were
  rejected as probable game rips; as a result some models are not the exact car
  simulated (see README limitations).
- **Engine audio from real recordings** for all seven combustion cars,
  replayed one engine cycle at a time in phase with the simulated crank.
  Spectral distance to the source recordings fell from 11–16 dB to 2.6–6.4 dB.
  Fixed a bug that could silence the engine permanently if audio started
  before the first physics step (a NaN parameter).
- Failed along the way: the GT3 hit the wall at Spa once real elevation went
  in (line tuning redone per car); the first Monaco import was not a closed
  loop (rebuilt from the node graph); software-rendered performance numbers
  taken while other jobs were running were discarded and re-measured.

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
