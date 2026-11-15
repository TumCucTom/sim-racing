// Injects measured results into README.md placeholders (idempotent via markers).
import fs from 'node:fs';
const v = JSON.parse(fs.readFileSync('docs/car-validation.json'));
const b = JSON.parse(fs.readFileSync('docs/benchmark-gt3.json'));
const perf = fs.existsSync('docs/performance.json') ? JSON.parse(fs.readFileSync('docs/performance.json')) : null;
let md = fs.readFileSync('README.md', 'utf8');
const cols = ['car', 'hp', 'kg', '0-100 s', '100-0 m', 'lat g (R60)', 'top km/h'];
const table = `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n` + v.map(r => `| ${cols.map(c => r[c]).join(' | ')} |`).join('\n') + '\n\nFormat: measured `[reference range]`. The muscle coupe\'s top speed is unrestricted (the real car is limited to 250 km/h).';
const f = (x) => (x == null ? '—' : x.toFixed(2));
const champ = b.policies.find(p => p.run === b.champion);
const rows = [b.baseline, ...b.policies].map(p => `| ${p.name}${p.run === b.champion ? ' ★' : ''} | ${p.stintClean}/${p.trials} | ${f(p.stintMean)} | ${p.completed}/${p.trials} | ${f(p.mean)} | ${f(p.best)} | ${p.tyreMaxC.toFixed(0)} °C | ${p.validationTrials ? p.validationClean + '/' + p.validationTrials + ', ' + f(p.validationLap) + ' s' : '—'} |`).join('\n');
const gain = champ && champ.stintMean ? ((1 - champ.stintMean / b.baseline.stintMean) * 100).toFixed(1) : null;
const rl = `The AI driver is trained with PPO on the **same** \`src/sim\` code the game runs.

- **Environment** (\`rl/env.js\`): 20 Hz decisions over 300 Hz physics. 24 observations (speeds, yaw rate, lateral offset, heading error, steering, g-forces, rear slip, gradient, front/rear tyre temperature, curvature at 10 look-ahead distances up to 200 m). Two actions: steering (through the same speed-sensitive steering map the keyboard uses) and a combined throttle/brake pedal. Reward = metres of progress; leaving the circuit ends the episode with a speed-scaled penalty. Starts are randomised around the lap (12 % from the grid), with ±4 % track grip and tyre temperatures anywhere from cool to badly overheated — all drawn from the episode seed.
- **Learner** (\`rl/ppo.js\`): dependency-free PPO-clip, 64×64 tanh MLPs, GAE(0.95), γ = 0.992, 32 envs × 128 steps, 5 epochs, KL-adaptive learning rate. The policy is mirror-equivariant by construction (a left-hander and its mirror image share weights) and its action means are tanh-bounded.
- **Determinism**: a (car, seed, steps) triple fully determines training; evaluation is bit-reproducible (re-running the champion on the benchmark seeds gave identical lap times: **${b.deterministic?.identical}**). The same policy produces the same lap in Node and in Chromium.
- **Protocol**: every trial is a standing start plus a ${b.stintLaps}-lap stint. *Flying lap* = lap 2, counted only inside track limits. *Stint* = all ${b.stintLaps} laps clean, scored on the mean of laps 2–${b.stintLaps}. Checkpoints are kept during training on 4 validation seeds (8-lap stints); the champion is chosen among runs on 20 further validation seeds (clean stints first, then pace). The benchmark uses ${b.trials} different seeds (1–${b.trials}). The baseline gets its best shot: its grip factor is swept and the fastest setting with every stint clean is used (grip ${b.baseline.grip}).

**Result — ${b.track}, Arrow GT3-R, ${b.trials} fixed-seed trials each:**

| Driver | Clean stints | Stint pace (s/lap) | Clean flying laps | Flying lap mean (s) | Best | Hottest tyre | Validation (20 seeds) |
|---|---|---|---|---|---|---|---|
${rows}

★ = champion chosen by validation. ${gain ? `Over a ${b.stintLaps}-lap stint it averages **${f(champ.stintMean)} s** per lap against the baseline's **${f(b.baseline.stintMean)} s** — **${gain} % faster** — with ${champ.stintClean} of ${champ.trials} stints fully clean (baseline ${b.baseline.stintClean}/${b.baseline.trials}).` : 'See the table for which runs produced clean stints.'}

![Learning curves](docs/learning-curve-gt3.svg)

![Benchmark](docs/benchmark-gt3.svg)

Why it is faster: the baseline follows the centre line and brakes in a straight line; the policy learned to use the full width, trail-brake and carry more apex speed. In the game, press **I** to let it drive, **G** to race its ghost, or pick "AI lap" in the telemetry panel to overlay its traces on yours.

Two things that did not work first (details in the changelog): (1) the initial runs never completed a lap — agents flew off at the one significant right-hander until the policy was made mirror-symmetric; (2) the first successful policies set 62–64 s flying laps but **crashed on lap 3 of every stint** with tyres at 120–160 °C, because 60-second training episodes never showed them overheated tyres. Tyre temperature was added to the observations and to the start-state randomisation, and selection moved from one hot lap to multi-lap stints.`;
const perfMd = perf ? `Measured in this repository's CI-like container (4 vCPU, **no GPU**: Chromium renders with SwiftShader software rasterisation, so frame rates are a pessimistic floor, not what a GPU will do).

| Metric | Value |
|---|---|
| Physics throughput (headless Node, 1 core) | ${perf.simStepsPerSec.toLocaleString()} steps/s = ${perf.realtimeFactor}× real time |
| Physics cost per 60 Hz frame (5 steps) | ${perf.simMsPerFrame} ms |
| RL training throughput | ${perf.trainSps} env steps/s per process (4 in parallel) |
| Training time | ${perf.trainMinutes} min per 3M-step seed |
| Build size | ${perf.bundleKb} kB JS (${perf.gzipKb} kB gzip) + 1.7 MB car model and Draco decoder |
${perf.render.map(r => `| Render, ${r.quality} @ ${r.track} (software GL, 1280×720) | ${r.fps} fps, ${r.calls} draw calls, ${r.tris} triangles, CPU ${r.frameMs} ms/frame |`).join('\n')}
| Test suite | ${perf.tests} |` : '_run tools/perf.mjs_';
md = md.replace('VALIDATION_TABLE', table).replace('RL_SECTION', rl).replace('PERF_SECTION', perfMd);
fs.writeFileSync('README.md', md);
console.log('README filled');
