# Audio: design, measurements and asset credits

Nobody who worked on this audio could listen to it; it was built the way an
engineer without monitors would, by measuring against real recordings. Read
the "What the numbers prove" and "Known weaknesses" sections before trusting it.

## Architecture

```
vehicle state --(once per frame)--> AudioEngine.update()            src/audio/audio.js
                                       |  parameters (rpm, load, slip, surface, camera ...)
                                       v
                          RaceAudioSynth (AudioWorklet)             src/audio/synth.js
     engine: recorded engine cycles (bank)  --or--  physical synthesis (fallback)
     + turbo whistle / blow-off, gear whine, overrun pops
     + tyre squeal, scrub, tyre roll, wind, kerb, grass, gravel, brake hiss, impact, shift
     + cockpit / exterior / trackside mix
                                       |
        delay (Doppler, TV camera) -> distance gain -+-> compressor -> master -> speakers
                                                     +-> reverb send -> convolver -^
```

### Engine voice: recorded engine cycles ("bank")

Every combustion car's engine is played back from a real recording. What is
stored is not a set of loops but single **engine cycles** (720 degrees of crank,
i.e. every cylinder firing once), cut pitch-synchronously from the recording:

1. `tools/audio-build.py` tracks the firing frequency of the recording
   (harmonic-comb salience + Viterbi path, then phase refinement by
   heterodyning), so the crank angle is known at every sample.
2. Each engine cycle is resampled to a fixed length per rpm band (angle-domain
   resampling), labelled on-load (rpm rising) or off-load (rpm falling), and
   scored by its correlation with the next cycle. Noisy cycles (crowd, PA,
   limiter, mistracking) fail that score and are dropped.
3. Per rpm band and load state the 8 most typical cycles (closest to the
   medoid) are kept, phase-aligned to each other and to the neighbouring
   bands, and written to `public/audio/<car>.wav` (plain mono 16-bit WAV, so it
   can be auditioned in any player, plus an `rsim` chunk with the JSON index).
4. At run time the worklet keeps an engine-phase accumulator driven by the
   simulated rpm. Each cycle it picks a random recorded cycle from the two rpm
   bands around the current rpm, for both load states, reads them **at the
   current engine phase** (pitch therefore follows rpm exactly and
   continuously, like `playbackRate` on a loop but phase-locked), crossfades
   by rpm and by load, and splices consecutive cycles over 1/8 of a cycle.
   Random choice among real cycles gives real cycle-to-cycle roughness instead
   of a looped or perfectly periodic tone.

Bands for which a recording has no clean cycles reuse the nearest band's
cycles (they are then pitch-shifted further); a missing off-load set borrows
the on-load set through a low-pass. Which bands are real is listed below.

Why this and not classic loops: none of the openly licensed recordings holds
a steady rpm; they are rev blips, pull-aways and drive-bys. Cycle-synchronous
cutting gets phase-continuous material out of sweeps, lets on- and off-load
be separated by the sign of the rpm slope, and makes rpm labelling verifiable.

### Fallback voice: physical synthesis

If the bank cannot be fetched or parsed (or for a car without a bank) the
worklet's original per-cylinder firing-pulse model plays instead: same class,
same parameters, no gap. `AudioEngine.voice` is `'samples'` or `'synth'`.
The electric car is synthesis only (see below).

### Everything else

* Tyres: squeal is two detuned narrow resonators (about 0.7-1.4 kHz, falling
  with slip speed) excited by noise with stick-slip roughness, level follows
  slip x vertical load; separate mid-band scrub; tyre roll / road roar.
* Wind (v squared, slow buffeting), kerb serrations (pulse train + body boom),
  grass rumble, gravel rumble + stone spray, brake pad hiss, impact thump +
  crunch, gear-change knock, straight-cut gear whine, turbo whistle, blow-off
  with flutter, overrun pops.
* Camera mix: `chase`/`far` exterior; `bonnet` = cockpit (engine low-passed,
  more gear whine and road roar, almost dry); `tv` = trackside (no wind or
  tyre roar, a delay line of distance/343 s gives true Doppler shift, level
  falls with distance, more reverb).
* Bus: algorithmic early reflections + 0.5 s tail (generated in code, no IR
  asset), then a compressor (-16 dB threshold, 4:1). The synth soft-limits its
  own sum; tests assert peak < 0.97 at the redline.
* `set()` ignores non-finite values. (Found by the browser check: the first
  audio frame could arrive before the first physics step, `engineTorque` was
  `undefined`, and a single NaN silenced the voice for good.)

## Asset credits

All recordings come from Wikimedia Commons. `public/audio/*.wav` are
adaptations (excerpts cut into single engine cycles, resampled, level
normalised). Banks derived from a CC BY-SA source are themselves CC BY-SA 3.0;
the others are CC BY 3.0. Total size of `public/audio/`: about 3.5 MB.

| Bank (car) | Source recording on Wikimedia Commons | Author | Licence |
|---|---|---|---|
| `gt3.wav` (Arrow GT3-R, 4.0 flat-six) | [Porsche 911 GT3 (991) with Armytrix exhaust - engine and exhaust sound (YouTube aDPmym 3HB0).opus](https://commons.wikimedia.org/wiki/File:Porsche_911_GT3_(991)_with_Armytrix_exhaust_-_engine_and_exhaust_sound_(YouTube_aDPmym_3HB0).opus) | CARSMANIA (YouTube) | CC BY 3.0 |
| `f458.wav` (Ferrari 458 Italia) | [Ferrari 458 Speciale - engine and exhaust sound (YouTube nltPXKAN6BI).opus](https://commons.wikimedia.org/wiki/File:Ferrari_458_Speciale_-_engine_and_exhaust_sound_(YouTube_nltPXKAN6BI).opus) | TvdL Films (YouTube) | CC BY 3.0 |
| | [Ferrari 458 Italia.ogg](https://commons.wikimedia.org/wiki/File:Ferrari_458_Italia.ogg) | Edvvc | CC BY-SA 3.0 |
| `coupe.wav` (Brawler GT 5.0, cross-plane V8) | [Ford Mustang GT (S550) - engine and exhaust sound (YouTube 2ceiDjGgpI8).opus](https://commons.wikimedia.org/wiki/File:Ford_Mustang_GT_(S550)_-_engine_and_exhaust_sound_(YouTube_2ceiDjGgpI8).opus) | Cestni dirkač (YouTube) | CC BY 3.0 |
| | [Ford Mustang Mach 1 (2021) - engine and exhaust sound (YouTube HydyGJGAOrw).opus](https://commons.wikimedia.org/wiki/File:Ford_Mustang_Mach_1_(2021)_-_engine_and_exhaust_sound_(YouTube_HydyGJGAOrw).opus) | LSX632 Performance (YouTube) | CC BY 3.0 |
| `hatch.wav` (Vanta RS, 2.0 turbo I4) | [Honda Civic Type R - engine and exhaust sound (YouTube qxhgUfPQ4Cc).opus](https://commons.wikimedia.org/wiki/File:Honda_Civic_Type_R_-_engine_and_exhaust_sound_(YouTube_qxhgUfPQ4Cc).opus) | Vigor (YouTube) | CC BY 3.0 |
| `mini.wav` (Mini Cooper S) | [Mini Countryman - engine and exhaust sound (YouTube xDeqeAkmRa8).opus](https://commons.wikimedia.org/wiki/File:Mini_Countryman_-_engine_and_exhaust_sound_(YouTube_xDeqeAkmRa8).opus) | seamonkey420 (YouTube) | CC BY 3.0 |
| | [Mini Clubman - engine and exhaust sound (YouTube VoYMO0PugJk).opus](https://commons.wikimedia.org/wiki/File:Mini_Clubman_-_engine_and_exhaust_sound_(YouTube_VoYMO0PugJk).opus) (top rpm band only) | Foot to Pedal (YouTube) | CC BY 3.0 |
| `hypercar.wav` (Aurelia LMH, 3.0 twin-turbo V6) | [Ferrari 296 - engine and exhaust sound (YouTube b9Qx9rpCsA0).opus](https://commons.wikimedia.org/wiki/File:Ferrari_296_-_engine_and_exhaust_sound_(YouTube_b9Qx9rpCsA0).opus) | Supercars and beyond (YouTube) | CC BY 3.0 |
| | [Nissan GT-R SpecV.ogg](https://commons.wikimedia.org/wiki/File:Nissan_GT-R_SpecV.ogg) (6,000 rpm band) | Edvvc | CC BY-SA 3.0 |
| `formula.wav` (FX-10, 3.0 V10) | [Red Bull-Cosworth RB1 (2005).ogg](https://commons.wikimedia.org/wiki/File:Red_Bull-Cosworth_RB1_(2005).ogg) | Edvvc | CC BY-SA 3.0 |
| | [Red-Bull-Cosworth-STR1-2006-David-Coulthard.ogg](https://commons.wikimedia.org/wiki/File:Red-Bull-Cosworth-STR1-2006-David-Coulthard.ogg) | Edvvc | CC BY-SA 3.0 |
| | [Porsche Carrera GT - engine and exhaust sound (YouTube ti9wpsDF4MI).opus](https://commons.wikimedia.org/wiki/File:Porsche_Carrera_GT_-_engine_and_exhaust_sound_(YouTube_ti9wpsDF4MI).opus) (below about 5,400 rpm) | MDS Sportcar (YouTube) | CC BY 3.0 |
| Volt-R Quad (electric) | none: synthesis only | | |

The "YouTube" files are audio tracks of videos their authors published under
YouTube's CC BY licence, imported to Commons; several were fetched as Commons'
own MP3 transcodes of those files. No audio from them other than the
engine cycles in the banks is redistributed.

Used for measurement only (no audio shipped; band spectra in
`tools/audio-ref/x-*.json`): Porsche 911 GT3 (997) (YouTube 3WHXKH Ouc,
ProRallyVids), Porsche 911 GT3 (992) with Fi Exhaust (YouTube -ZK8A1PT-4k,
CARSMANIA), Renault Mégane RS (YouTube TplQIptv-ME, Electric Auto Sport),
Audi S1 (YouTube 2axudw2mPHk, Calvin MotorSport), Porsche Carrera GT (YouTube
JwrOv5WzFCk, MDS Sportcar); all CC BY 3.0, Wikimedia Commons.

### What each bank really contains

Bands = rpm values with real recorded cycles; everything between and beyond is
crossfaded / pitch-shifted from the nearest real band.

| Car | Engine in the recording vs. in the game | Real on-load bands (rpm) | Real off-load bands |
|---|---|---|---|
| gt3 | 911 GT3 (991) 3.8/4.0 flat-six road car, aftermarket exhaust, revved stationary; game: GT3 race car | 1300-9200, all 12 | 1300-1550, 2650-7700 |
| f458 | 458 Speciale (same F136 flat-plane V8 family) revved stationary + 458 Italia pulling away | 740, 1840-9100 | 740, 2900, 5770-9100 |
| coupe | Mustang GT 5.0 (Coyote), revs and drive-bys | 925-4000, 6080, 7500 | 925-3250, 6080, 7500 |
| hatch | Civic Type R 2.0 turbo | 1300, 2460-7100 | 850-7100 |
| mini | Mini Countryman / Clubman (BMW turbo four; trim not stated in the source) | 800-6600, all 10 | all 10 |
| hypercar | Ferrari 296 (3.0 twin-turbo 120-degree V6, the 499P's road relative), low revs only; Nissan GT-R at 6000 | 3030-4290, 6075 | 3030-4290 |
| formula | Real 3.0 F1 V10s (RB1, STR1) trackside at about 14,300 and 16,500 rpm; Carrera GT V10 at 4000-4600 | 4000, 4610, 14300, 16500 | 4610 |

## Measurements

`node tools/audio-compare.mjs` renders the engine offline at each reference
rpm / load and compares it with the recording:

* **LSD**: log-spectral distance, 1/6-octave bands 50 Hz-8 kHz, level-normalised (dB rms).
* **ORD**: mean absolute error of the crank half-order amplitudes (dB).
* **CYC**: correlation between consecutive engine cycles (1.0 = perfectly periodic "synth" tone).

"before" is the original pure synth (kept as `tools/audio-legacy-synth.js`),
"after" is the shipped voice. Where enough exist, the reference cycles are
ones that were not copied into the bank (held-out bands).

| Car | bands (held-out) | LSD on-load before -> after | ORD before -> after | LSD off-load before -> after | CYC ref / before / after |
|---|---|---|---|---|---|
| gt3 | 21 (14) | 11.6 -> 6.4 | 9.5 -> 4.2 | 13.9 -> 5.6 | 0.88 / 0.99 / 0.84 |
| f458 | 14 (9) | 11.2 -> 5.5 | 9.9 -> 3.0 | 13.1 -> 3.4 | 0.79 / 0.99 / 0.81 |
| coupe | 19 (11) | 11.3 -> 6.0 | 7.3 -> 2.9 | 15.6 -> 4.2 | 0.86 / 0.97 / 0.79 |
| hatch | 17 (12) | 13.2 -> 4.2 | 12.2 -> 2.2 | 14.0 -> 3.7 | 0.80 / 0.99 / 0.85 |
| mini | 20 (11) | 11.1 -> 5.3 | 10.5 -> 2.3 | 13.8 -> 3.3 | 0.87 / 1.00 / 0.90 |
| hypercar | 7 (5) | 15.7 -> 2.6 | 15.1 -> 1.8 | 17.9 -> 2.5 | 0.76 / 0.99 / 0.62 |
| formula | 5 (4) | 13.6 -> 3.4 | 14.3 -> 1.8 | 13.6 -> 2.9 | 0.78 / 0.99 / 0.79 |
| ev | not scored (no reference) | | | | |

Cross-recording check (reference = a *different* car of the same engine type
that contributed nothing to the bank):

| Car vs. reference | LSD before -> after | ORD before -> after |
|---|---|---|
| gt3 vs 911 GT3 (997) | 11.5 -> 8.2 | 9.7 -> 6.2 |
| gt3 vs 911 GT3 (992), Fi exhaust | 14.5 -> 8.0 | 11.2 -> 6.1 |
| hatch vs Mégane RS | 12.5 -> 8.0 | 9.5 -> 4.0 |
| hatch vs Audi S1 | 12.9 -> 9.8 | 8.4 -> 6.8 |
| mini vs Mini Clubman | 13.5 -> 8.5 | 10.5 -> 3.4 |
| formula (low range) vs second Carrera GT recording | 14.7 -> 6.2 | 14.6 -> 4.6 |

`node tools/audio-page-check.mjs --url <served build>` repeats the scoring on
what a real Chromium page outputs at the master bus (worklet + reverb +
compressor), then lets the AI drive and checks level, clipping and console
errors, and finally blocks the bank request to prove the fallback. Results of
the last run are in the hand-over report.

### What the numbers prove, and what they do not

* They prove the shipped engine has the spectral envelope, order structure and
  cycle-to-cycle roughness of a real recording of that engine type, within
  3-6 dB, where the old synth was 11-16 dB away and almost perfectly periodic
  (CYC 0.99: the measurable signature of "synthy").
* The same-recording rows are partly circular (the bank is made from that
  recording; only the individual cycles are held out). The cross-recording
  rows are the honest ones: about 8 dB, which is roughly how much two real
  cars of the same type differ from each other through different microphones.
* They say nothing about transients (how a throttle blip, a shift or the
  limiter sounds), about how band crossfades sound while sweeping, about the
  stereo image, or about whether it is pleasant. Nobody has listened to it.
* Steady-state comparison flatters a method that replays steady-state cycles.

## Known weaknesses

* Source material is free-revving road cars (mostly stationary, exhaust-side)
  and trackside pull-aways, not on-board race recordings under load. "On
  load" means "while the revs were rising". The GT3 is a road 911 GT3 with an
  aftermarket exhaust, not a GT3-R; the hypercar has real 296 V6 cycles only
  at 3000-4300 rpm, plus a Nissan GT-R at 6000, so most of its 1800-8500 rpm
  range is pitch-shifted; the Formula car has real F1 V10 cycles only around
  14-16.5k rpm (pitched over 9-19k) and switches to a Carrera GT road V10
  below about 9000 rpm, a change of character somewhere around 8-9.5k.
* Pitch-shifting a cycle far from its recorded rpm moves its formants with it
  (dull when shifted down, thin when shifted up). Worst cases: hypercar idle
  and top end, formula mid range, coupe 4000-6000.
* In the trackside F1 recordings the per-bank order (2.5x crank) is stronger
  than the firing order, so the Formula car's perceived pitch may read an
  octave lower than expected. The rpm labelling of those files rests on one
  inference (see `tools/audio-recipes.json`); if it is wrong the top range is
  an octave off.
* Mixed sources inside one bank (f458 idle vs. pull-away, mini, hypercar,
  formula) can change microphone perspective from band to band.
* Grains are mono; stereo comes only from the reverb and the tyre layers.
* Several sources are lossy transcodes (Opus -> MP3) of YouTube audio.
* The electric car has no recorded reference at all; the only open recording
  found (a Tesla Roadster at Goodwood) is crowd and commentary. Its motor
  whine, gear mesh and inverter tone are plausible guesses.
* Ambient layers (tyres, wind, kerbs, surfaces, brakes, impacts) and the
  reverb are synthesised and were tuned by level meters and spectra, not ears.

## Rebuilding

```
pip install numpy scipy            # ffmpeg must be on PATH
python3 -I tools/audio-build.py track <recording> --cyl 6 --fmin 35 --fmax 460   # inspect a file
python3 -I tools/audio-build.py bank tools/audio-recipes.json <dir with the recordings> [car ...] [-v]
node tools/audio-compare.mjs [-v] [car ...]
node tools/audio-page-check.mjs --url http://127.0.0.1:4173/ [car ...]
```

`tools/audio-recipes.json` lists, per bank, the source files, time ranges and
tracking limits. The recordings themselves are not in the repository.

Hosted single-file build: publish `public/audio/*.wav` next to the page as
`audio/<car>.wav`, or embed them as base64 under `window.__INLINE_ASSETS['audio/<car>.wav']`
(same convention as `src/game/assets.js`). If neither is there the game
plays the synthesis fallback.
