# Audio: design, measurements and asset credits

Nobody who worked on this audio could listen to it; it was built the way an
engineer without monitors would, by measuring against real recordings. Read
the "What the numbers prove" and "Known weaknesses" sections before trusting it.
The second round (after the owner listened and found the engines "still not as
realistic as I'd like") is described under "Round 2"; "What to listen for" at
the end is the checklist for whoever can hear it.

## Architecture

```
vehicle state --(once per frame)--> AudioEngine.update()            src/audio/audio.js
                                       |  parameters (rpm, load, slip, surface, camera ...)
                                       v
                          RaceAudioSynth (AudioWorklet)             src/audio/synth.js
     engine: recorded engine cycles (bank) + measured noise layer  --or--  physical synthesis (fallback)
     + load shaping, shift cut / bark / blip, limiter stutter, overrun crackle
     + turbo rush / blow-off, gear whine
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

5. The stored cycles are only the part of the sound that is locked to the
   crank: the mean cycle of the band plus, for each of the 8 real cycles, the
   low-order part of its deviation from that mean (combustion varying from
   cycle to cycle; kept below 2.5x the firing order, faded out by 5x). The
   rest of what a real engine emits (gas turbulence, clatter, hiss) is stored
   per band and load state as a **noise spectrum** (27 third-octave bands,
   measured as what one cycle has that the next one does not, over all
   reasonably periodic cycles of that band, not only the 8 cleanest) and a
   32-point **envelope over the cycle**. On loading, `parseBank` turns each
   spectrum into a 0.37 s noise texture. At run time that texture is played
   at its recorded speed (its spectrum stays fixed in Hz while the revs
   move), from a read head that jumps to a random place a few times a second
   (so nothing repeats), chopped by the envelope at the current crank angle,
   and read half a texture apart for left and right.

Bands for which a recording has no clean cycles reuse the nearest band's
cycles and noise (the cycles are then pitch-shifted further); a missing
off-load set borrows the on-load set through a low-pass. Which bands are real
is listed below.

### Load, shifts, limiter (all inside the worklet)

The source recordings are free-revving cars, so "on load" in the bank only
means "revs rising". What a loaded engine adds is modelled on top, keyed to
the throttle and the torque the vehicle model reports, with an 8-30 ms attack:

* level: full throttle at the redline is about 11 dB above the overrun at the
  same revs (it was 5 dB), idle to flat-out about 13 dB;
* tone under load: the orders up to 1.5x firing frequency are raised (up to
  +3.5 dB), a little saturation steepens the pulses, the flow noise grows
  faster than the tone, and an intake roar (band noise at a per-layout
  frequency, chopped by the cycle) opens with the square of the throttle;
* up-shift under power: the engine drops to its overrun sound for the car's
  shift time (ignition cut of a sequential box, the driver's lift with an
  H-pattern) and, on fast boxes, comes back with a bang in the exhaust;
* down-shift: a throttle blip (on-load sound, part level) for 70-220 ms;
* rev limiter: while the vehicle model reports the limiter, spark is cut in
  bursts at a per-layout rate (12-30 Hz), each cut with a small bang;
* overrun crackle: "unburnt fuel" builds up under load and burns off as
  random bangs through a resonance during the first second or so after a
  lift, instead of crackling for as long as the throttle is closed;
* a slow (few Hz) drift of tone and noise level, so a held rpm is not static;
* stereo: decorrelated noise left/right and a small all-passed side signal;
  the mono sum is unchanged.

`AudioEngine.update()` passes `gear`, `limiter` and `shifting` for this.

Why this and not classic loops: none of the openly licensed recordings holds
a steady rpm; they are rev blips, pull-aways and drive-bys. Cycle-synchronous
cutting gets phase-continuous material out of sweeps, lets on- and off-load
be separated by the sign of the rpm slope, and makes rpm labelling verifiable.

### Fallback voice: physical synthesis

If the bank cannot be fetched or parsed (or for a car without a bank) the
worklet's original per-cylinder firing-pulse model plays instead: same class,
same parameters, no gap. `AudioEngine.voice` is `'samples'` or `'synth'`.
The shift cut, blip, limiter stutter and crackle model drive it too.
The electric car and the diesel LMP1 are synthesis only (see below).

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
  asset), then a gentle compressor (-12 dB threshold, 3:1; the earlier -16 dB,
  4:1 removed about 4 dB of the difference between full throttle and overrun).
  The synth soft-limits its own sum; tests assert peak < 0.97 at the redline.
* `set()` ignores non-finite values. (Found by the browser check: the first
  audio frame could arrive before the first physics step, `engineTorque` was
  `undefined`, and a single NaN silenced the voice for good.)

## Asset credits

All recordings come from Wikimedia Commons. `public/audio/*.wav` are
adaptations (excerpts cut into single engine cycles, resampled, level
normalised). Banks derived from a CC BY-SA source are themselves CC BY-SA 3.0;
the others are CC BY 3.0. Anyone redistributing the game redistributes these
files: keep this table (attribution) with them, and keep the CC BY-SA banks
(`f458`, `hypercar`, `formula`, `r8lms`, `amggt3`) under CC BY-SA 3.0. Total size of
`public/audio/`: 5.46 MB (the four GT3 banks added in 0.9.0 are 1.90 MB) (the noise layer added about 60 kB of JSON; its
textures are generated at load time).

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
| `r8lms.wav` (Audi R8 LMS GT3, 5.2 V10) | [Audi R8 LMS (2010).ogg](https://commons.wikimedia.org/wiki/File:Audi_R8_LMS_(2010).ogg) (the GT3 race car pulling away, Goodwood 2010) | Edvvc | CC BY-SA 3.0 |
| | [Audi R8 42 with Ragazzon exhaust - engine and exhaust sound (YouTube W8Ii1a8dSNw).opus](https://commons.wikimedia.org/wiki/File:Audi_R8_42_with_Ragazzon_exhaust_-_engine_and_exhaust_sound_(YouTube_W8Ii1a8dSNw).opus) (road R8 5.2 FSI V10, rev blips) | Ragazzon Official (YouTube) | CC BY 3.0 |
| `huracan.wav` (Lamborghini Huracán GT3, 5.2 V10) | [Lamborghini Huracan Performante with modified exhaust - engine and exhaust sound (YouTube 2kZ3XTsrgbA).opus](https://commons.wikimedia.org/wiki/File:Lamborghini_Huracan_Performante_with_modified_exhaust_-_engine_and_exhaust_sound_(YouTube_2kZ3XTsrgbA).opus) (first 40 s) | Auto-chippen.nl (chiptuning) (YouTube) | CC BY 3.0 |
| `amggt3.wav` (Mercedes-AMG GT3, 6.2 V8) | [Mercedes-Benz SLS AMG.ogg](https://commons.wikimedia.org/wiki/File:Mercedes-Benz_SLS_AMG.ogg) (same M159 6.2 V8; one band, 4,400–5,400 rpm) | Edvvc | CC BY-SA 3.0 |
| | the two Ford Mustang recordings of `coupe.wav` above (every other band) | Cestni dirkač; LSX632 Performance (YouTube) | CC BY 3.0 |
| `mc720s.wav` (McLaren 720S GT3, 4.0 twin-turbo V8) | [McLaren 720S with Novitec exhaust - engine and exhaust sound (YouTube XfgP-gX7KNg).opus](https://commons.wikimedia.org/wiki/File:McLaren_720S_with_Novitec_exhaust_-_engine_and_exhaust_sound_(YouTube_XfgP-gX7KNg).opus) | Supercars67 (YouTube) | CC BY 3.0 |
| Ferrari 296 GT3 | no file of its own: plays `hypercar.wav` (the Ferrari 296 recording is this car's own 3.0 120° twin-turbo V6) | see `hypercar.wav` | CC BY-SA 3.0 (bank) |
| Lamborghini Huracán LP 610-4 | no file of its own: plays `huracan.wav` (a Huracán Performante: this car's own 5.2 V10) | see `huracan.wav` | CC BY 3.0 |
| Lamborghini Aventador SVJ (6.5 V12) | none: synthesis only (even-firing `V12` layout) | | |
| Volt-R Quad (electric) | none: synthesis only | | |
| Audi R18 (`lmp1`, 3.7 V6 TDI) | none: synthesis only, balanced against the two R15 TDI recordings listed below | | |

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

Also measurement only, round 2 (long-term spectrum and tonality of a racing
turbodiesel, used to balance the synthesised `lmp1`; nothing shipped):
[Audi R15 TDI (2009).ogg](https://commons.wikimedia.org/wiki/File:Audi_R15_TDI_(2009).ogg) and
[Audi R15 TDI plus (2010).ogg](https://commons.wikimedia.org/wiki/File:Audi_R15_TDI_plus_(2010).ogg)
on Wikimedia Commons (fetched as Commons' MP3 transcodes). Author and licence
are on those file pages; the Commons API was rate-limited when this was
written, so they are NOT verified here. Check them before ever shipping
audio derived from these files.

Searched and not found in round 2 (Wikimedia Commons): an on-board or
close-miked recording under load of any of the engine types (the two
"acceleration" clips that looked promising, Renault Mégane RS and Audi Q7,
have music over the engine or are a petrol engine), an electric car, a
turbodiesel V6. The R15 TDI (V10) and R10 TDI (V12) trackside pass-bys exist,
but their firing order cannot be tracked (they are mostly rushing air), so
no cycles can be cut from them.

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
| r8lms | Audi R8 LMS (GT3 race car, 2010) pulling away, 2300-3700 rpm; road R8 5.2 FSI V10 rev blips for the overrun | 2130-3600 | 1790-2540 |
| huracan | Huracán Performante 5.2 V10 (same engine as the GT3), straight-piped, street drive: idle, short-shifted pulls, overrun | 1500-3600 | 1500-3020 |
| amggt3 | SLS AMG (M159 6.2 V8, the GT3's engine) launching, at 4870 only; all other bands Mustang GT 5.0 (another naturally aspirated DOHC cross-plane V8) | 1100-7450, all 10 (one of them Mercedes) | 1100-3180, 6020, 7450 |
| mc720s | McLaren 720S road car (M840T, the GT3's engine), Novitec exhaust, road drive with full-throttle pulls | 1810-8100 (9 of 10) | 1810-8100 |
| f296gt3 | plays the `hypercar` bank: Ferrari 296 road car, the same engine | as hypercar | as hypercar |

## Measurements

`node tools/audio-compare.mjs` renders the engine offline at each reference
rpm / load and compares it with the recording:

* **LSD**: log-spectral distance, 1/6-octave bands 50 Hz-8 kHz, level-normalised (dB rms).
* **ORD**: mean absolute error of the crank half-order amplitudes (dB).
* **CYC**: correlation between consecutive engine cycles (1.0 = perfectly periodic "synth" tone).

"before" is the original pure synth (kept as `tools/audio-legacy-synth.js`),
"after" is the shipped voice. Where enough exist, the reference cycles are
ones that were not copied into the bank (held-out bands).

| Car | bands (held-out) | LSD on-load before -> round 1 -> round 2 | ORD before -> r1 -> r2 | LSD off-load before -> r1 -> r2 | CYC ref / before / r1 / r2 |
|---|---|---|---|---|---|
| gt3 | 21 (14) | 11.6 -> 6.4 -> 3.8 | 9.5 -> 4.2 -> 2.7 | 13.9 -> 5.6 -> 3.8 | 0.88 / 0.99 / 0.84 / 0.85 |
| f458 | 14 (9) | 11.2 -> 5.5 -> 4.3 | 9.9 -> 3.0 -> 3.0 | 13.1 -> 3.4 -> 3.9 | 0.79 / 0.99 / 0.81 / 0.83 |
| coupe | 19 (11) | 11.3 -> 6.0 -> 5.4 | 7.3 -> 2.9 -> 2.5 | 15.6 -> 4.2 -> 3.9 | 0.86 / 0.97 / 0.79 / 0.85 |
| hatch | 17 (12) | 13.2 -> 4.2 -> 3.5 | 12.2 -> 2.2 -> 2.3 | 14.0 -> 3.7 -> 2.8 | 0.80 / 0.99 / 0.85 / 0.90 |
| mini | 20 (11) | 11.1 -> 5.3 -> 3.8 | 10.5 -> 2.3 -> 2.2 | 13.8 -> 3.3 -> 3.4 | 0.87 / 1.00 / 0.90 / 0.89 |
| hypercar | 7 (5) | 15.7 -> 2.6 -> 2.7 | 15.1 -> 1.8 -> 1.6 | 17.9 -> 2.5 -> 3.0 | 0.76 / 0.99 / 0.62 / 0.72 |
| formula | 5 (4) | 13.6 -> 3.4 -> 5.5 | 14.3 -> 1.8 -> 1.9 | 13.6 -> 2.9 -> 4.7 | 0.78 / 0.99 / 0.79 / 0.78 |
| ev, lmp1 | not scored (no reference) | | | | |

(The Formula car got worse on this steady-state score in round 2: its few
trackside cycles carry low-frequency rumble below the cycle frequency that
the round-1 voice replayed and the harmonic + noise split drops. About 1 dB
of the 2 dB is the load shaping.)

Cross-recording check (reference = a *different* car of the same engine type
that contributed nothing to the bank):

| Car vs. reference | LSD before -> round 1 -> round 2 | ORD before -> r1 -> r2 |
|---|---|---|
| gt3 vs 911 GT3 (997) | 11.5 -> 8.2 -> 5.8 | 9.7 -> 6.2 -> 4.5 |
| gt3 vs 911 GT3 (992), Fi exhaust | 14.5 -> 8.0 -> 6.2 | 11.2 -> 6.1 -> 4.5 |
| hatch vs Mégane RS | 12.5 -> 8.0 -> 7.5 | 9.5 -> 4.0 -> 4.0 |
| hatch vs Audi S1 | 12.9 -> 9.8 -> 8.7 | 8.4 -> 6.8 -> 6.1 |
| mini vs Mini Clubman | 13.5 -> 8.5 -> 7.4 | 10.5 -> 3.4 -> 3.2 |
| formula (low range) vs second Carrera GT recording | 14.7 -> 6.2 -> 7.3 | 14.6 -> 4.6 -> 4.5 |

`node tools/audio-page-check.mjs --url <served build>` repeats the scoring on
what a real Chromium page outputs at the master bus (worklet + reverb +
compressor), then lets the AI drive and checks level, clipping and console
errors, and finally blocks the bank request to prove the fallback. Results of
the last run are in the hand-over report.

### Round 2: transient-aware scoring

`tools/audio-drive.mjs` renders, offline but through the real vehicle model
and the real synth class, the same scripted drive for every car: 2 s idle, a
standing start and 22 s of the AI driver (pull through the gears, lifts,
braking, down-shifts), 3 s held on the rev limiter in first gear, 2 s coasting
down; plus a "stationary revving" script (blips, one slow sweep up and down)
that resembles the source recordings. `tools/audio-eval.py` scores those
renders and the recordings with the same code:

* **REP**: share of cycle pairs 2-12 cycles apart whose non-periodic part
  above 1 kHz is the same waveform again (correlation > 0.6). Real: 0.
* **LOAD**: level at full throttle minus level on a closed throttle at
  comparable revs (in the recordings: revs rising minus revs falling).
* **SHIFT**: depth and length of the level dip at up-shifts under power.
* **LIM**: swing of the engine level (95th - 5th percentile) on the limiter.
* **L/R**: correlation of the two output channels over the drive (1 = mono).
* also printed, not tabulated here: harmonic-to-noise ratio in four bands,
  cycle-to-cycle correlation below 500 Hz / above 1.5 kHz, formant fixedness,
  envelope modulation depth at 2-8 / 8-30 Hz, spectral flux, long-term
  spectrum in five bands, crest factor, share of the engine in the mix.

| Car | REP (rev script) before -> after | LOAD dB before -> after | SHIFT dip dB / ms before -> after | LIM dB before -> after | L/R before -> after |
|---|---|---|---|---|---|
| gt3 | 0.11 -> 0.00 | 5.2 -> 10.9 | 2.6 / 1 -> 10.8 / 66 | 6.1 -> 8.6 | 1.00 -> 0.92 |
| f458 | 0.05 -> 0.00 | 5.6 -> 10.8 | 3.6 / 14 -> 12.1 / 90 | 5.9 -> 9.6 | 1.00 -> 0.89 |
| coupe | 0.04 -> 0.00 | 5.2 -> 10.8 | 6.5 / 135 -> 12.9 / 275 | 4.5 -> 11.1 | 1.00 -> 0.86 |
| hatch | 0.02 -> 0.00 | 4.9 -> 10.6 | 4.6 / 54 -> 13.1 / 246 | 4.6 -> 10.8 | 1.00 -> 0.88 |
| mini | 0.06 -> 0.00 | 5.5 -> 11.3 | 5.8 / 75 -> 13.1 / 286 | 5.4 -> 11.9 | 1.00 -> 0.88 |
| hypercar | 0.05 -> 0.00 | 5.4 -> 10.6 | 3.8 / 16 -> 11.4 / 66 | 4.1 -> 9.4 | 1.00 -> 0.81 |
| formula | 0.04 -> 0.00 | 11.0 -> 15.5 | 8.3 / 103 -> 15.1 / 139 | 15.3 -> 11.1 | 1.00 -> 0.78 |
| lmp1 (synthesis) | 0.00 -> 0.00 | 12.7 -> 16.1 | 2.7 / 0 -> 13.0 / 65 | 7.2 -> 14.1 | 0.37 -> 0.62 |

In the recordings REP is 0.00 for every car and LOAD is between -1 and
+2.4 dB, which is the point: they are unloaded. The only loaded real engine
at hand (a Boxster S in-car pull, Commons, too short and too wet to cut
cycles from) swings about 10-12 dB between power and lift; that and general
knowledge are all the 11 dB rests on.

What the round-2 investigation found, in order of weight:

1. **Frozen noise** (measured): one cycle pair in 8-25 replayed the same
   non-periodic waveform (REP 0.04-0.12); real engines never do. Fixed by the
   harmonic + noise split. The same split made the engines agree better with
   *other* cars of their type (cross-recording table: gt3 8.1 -> 6.0 dB).
2. **Load barely audible** (measured): 5 dB and no change of tone between
   flat out and overrun; flat up-shifts of the sequential cars dipped 2.6 dB
   for 1 ms, i.e. were inaudible; the limiter was a 4-6 dB wobble; lift-off
   crackle ran for as long as the throttle stayed shut.
3. **Mix** (measured): the output was exactly mono while driving; the turbo
   whistle was a pure sine at up to 8.8 kHz, 10 dB above everything else the
   turbo cars had up there (now a band of rushing air at 1.9-5.2 kHz with a
   trace of tone, 10 dB lower); the bus compressor ate 4 of the 11 dB.
4. **Formants dragged by pitch-shifting** (tested, NOT confirmed as a cause
   that can be fixed from this material): predicting a real band from its
   neighbours with a formant-preserving shift (envelope detail held in Hz, or
   a source-filter model fitted on three bands) was no better than a plain
   pitch shift (gt3 8.6 vs 8.8 dB, mini 9.4 vs 9.5, f458 6.5 vs 6.8, coupe
   13.7 vs 14.3; leave-one-band-out with a model fitted on *all* other bands
   gains 0.5-1.7 dB). These close-miked free-rev recordings simply show
   little structure that is fixed in Hz (FIX 0.05-0.16). No formant-corrected
   bands are shipped; only the noise layer is fixed in Hz.

Not closer to the recordings in round 2, and the honest reading is unclear:
below 1 kHz the voice is still cleaner and more periodic than the recordings
taken as a whole (cycle-to-cycle correlation below 500 Hz: 0.89-0.97 against
0.37-0.85). The recordings' figure includes speech, wind and mistracked
stretches, the bank's the cleanest cycles; the truth is in between.

### What the numbers prove, and what they do not

* They prove the shipped engine has the spectral envelope, order structure and
  cycle-to-cycle roughness of a real recording of that engine type, within
  3-6 dB, where the old synth was 11-16 dB away and almost perfectly periodic
  (CYC 0.99: the measurable signature of "synthy").
* The same-recording rows are partly circular (the bank is made from that
  recording; only the individual cycles are held out). The cross-recording
  rows are the honest ones: about 8 dB, which is roughly how much two real
  cars of the same type differ from each other through different microphones.
* The steady-state rows say nothing about transients. The round-2 metrics do
  measure them, but only that a shift, a lift or the limiter now produces a
  level change of plausible size and length, not that it *sounds* like the
  real event: there was no loaded reference to compare the shape with.
* Nothing measures how band crossfades sound while sweeping, or whether any
  of it is pleasant. The development side has still not listened to it.
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
* **GT3 banks (0.9.0), not auditioned and not yet scored with `audio-compare`.** The two V10 banks have
  real cycles only up to 3,600 rpm; the 5.2 V10's whole racing range (5,000-8,500 rpm) is pitch-shifted
  from the 3,600 band, so the howl these engines are known for is an extrapolation. Two higher-rev
  V10 sources were rejected: a Huracán Performante clip that turned out to be music and speech, and the
  Gallardo LP570-4 pull-away, whose octave (2,550 or 5,100 rpm) could not be settled from its spectrum.
  The AMG bank is a Mustang with a single Mercedes band in the middle (the only open M159 recording is
  nine seconds long): expect a change of voice and microphone around 4,400 and 5,400 rpm, and the rpm of
  that SLS band rests on the assumption that the launch was held near 5,000 rpm. The McLaren bank is
  one continuous road recording with wind and tyre noise under the engine; it is the only GT3 bank
  with real full-throttle cycles to the redline. The Ferrari 296 GT3 shares the hypercar's thin 296
  bank (3,000-4,300 rpm real). All sources are road cars except the R8 LMS pull-away; none is a GT3
  car at racing speed, and none has the straight-cut gear whine, which stays synthesised.
* **Aventador SVJ: synthesised.** Commons has SVJ recordings (the one examined:
  [Lamborghini Aventador SVJ with Fi Exhaust (YouTube NCbywZoYDKE)](https://commons.wikimedia.org/wiki/File:Lamborghini_Aventador_SVJ_with_Fi_Exhaust_-_engine_and_exhaust_sound_(YouTube_NCbywZoYDKE).opus),
  FiExhaust, CC BY 3.0). It is music for 110 s, then idle and very short rev blips: only the idle (940 rpm, firing
  order at 94 Hz) tracks reliably, and in the blips the tracker cannot tell the firing order from the per-bank order
  (113 / 227 / 338 / 451 Hz lines fit 1,130 or 2,270 rpm). No bank was built rather than ship cycles an octave out.
  Nothing from that file is shipped. Other Aventador / SV files on Commons were not fetched (rate limits).
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
* Everything a loaded engine adds (level, low orders, edge, intake roar,
  shift cut and bark, blip, limiter, crackle) is modelled, with levels and
  times set from general knowledge, not from a recording. If round 2 sounds
  wrong, these constants are the first suspects: `loadLow`, `loadHi`,
  `edge`, `intakeGain`, `intakeHz`, `popHz`, `pops`, `limHz`, `offGain`,
  `noiseGain`, `unsteady`, `width` in `configure()` / `layouts()` /
  `audioConfigFor()` of `src/audio/synth.js`.
* The noise layer is stationary noise with the right spectrum and cycle
  envelope. Real residual has events in it (valve clatter, individual
  misfires); those are averaged away.
* The engine's stereo width is synthetic (decorrelated noise, small all-pass
  side signal); there is still no interior recording behind the cockpit view,
  only a low-pass.
* The Audi R18 (`lmp1`) is synthesis: a V6 firing-pulse model under a lot of
  rushing-gas noise, balanced to the long-term spectrum of R15 TDI pass-bys.
  It has no recorded cycles and none of the noise-layer work applies to it.
* Several sources are lossy transcodes (Opus -> MP3) of YouTube audio.
* The electric car has no recorded reference at all; the only open recording
  found (a Tesla Roadster at Goodwood) is crowd and commentary. Its motor
  whine, gear mesh and inverter tone are plausible guesses.
* Ambient layers (tyres, wind, kerbs, surfaces, brakes, impacts) and the
  reverb are synthesised and were tuned by level meters and spectra, not ears.

## What to listen for

Files to audition without starting the game are written by
`node tools/audio-drive.mjs --out <dir>`: `<car>.wav` (the scripted drive, as
the synth outputs it, before the page's reverb and compressor),
`<car>-engine.wav` (engine alone), `<car>-rev.wav` (stationary revving).

1. Held revs (pause on a straight in top gear, or the long sweep at the end
   of `<car>-rev.wav`): is the tone alive but clean, or is there a layer of
   hiss sitting *beside* the engine instead of inside it? (`noiseGain`; the
   noise is new in round 2.)
2. Full throttle against lift at the same revs: does the engine get louder
   *and* harder / fuller, or only louder? Too much, too little? (`loadLow`,
   `edge`, `loadHi`, `intakeGain`, `offGain`.)
3. Up-shifts in the GT3 / 458 / hypercar / Formula car: is there a clean
   "brap" gap with a bang, and is the bang too loud, too clicky, too
   frequent? Road cars: is the lift during the shift believable?
4. Down-shifts under braking: a blip per gear? Crackle only just after a
   lift? Too much like popcorn? (`pops`, `popHz`.)
5. Limiter (hold first gear flat out): a hard stutter, at a believable rate?
   (`limHz`.)
6. Sweeping slowly through the rev range: any place where the character
   changes abruptly (Formula 8-9.5k, hypercar around 5k and above 6k, coupe
   4-6k, AMG GT3 at 4.4k and 5.4k where the Mercedes band starts and ends,
   both V10 GT3 cars above 4k where pitch-shifting takes over)? Those are band borders between different source cars.
7. Does each car sound like *its* engine type from the outside, and is the
   cockpit view just "the same, duller"?

## Rebuilding

```
pip install numpy scipy            # ffmpeg must be on PATH
python3 -I tools/audio-build.py track <recording> --cyl 6 --fmin 35 --fmax 460   # inspect a file
python3 -I tools/audio-build.py bank tools/audio-recipes.json <dir with the recordings> [car ...] [-v]
node tools/audio-compare.mjs [-v] [car ...]                                   # steady-state scores
node tools/audio-drive.mjs --out <dir> [--synth old/synth.js --bankdir old/audio] [car ...]   # scripted drive -> WAV + trace
python3 -I tools/audio-eval.py ref tools/audio-recipes.json <dir with the recordings> --json ref.json
python3 -I tools/audio-eval.py drive <dir> --json after.json                   # transient-aware scores
python3 -I tools/audio-eval.py table ref.json before.json after.json
node tools/audio-page-check.mjs --url http://127.0.0.1:4173/ [--wav <dir>] [car ...]
```

`tools/audio-recipes.json` lists, per bank, the source files, time ranges and
tracking limits. The recordings themselves are not in the repository.

Hosted single-file build: the files to publish as of 0.9.0 are `coupe.wav`, `f458.wav`, `formula.wav`,
`gt3.wav`, `hatch.wav`, `hypercar.wav`, `mini.wav` and the four new ones, `amggt3.wav`, `huracan.wav`,
`mc720s.wav`, `r8lms.wav` (11 files, 5.46 MB; the Ferrari 296 GT3 uses `hypercar.wav`).
Publish `public/audio/*.wav` next to the page as
`audio/<car>.wav`, or embed them as base64 under `window.__INLINE_ASSETS['audio/<car>.wav']`
(same convention as `src/game/assets.js`). If neither is there the game
plays the synthesis fallback.
