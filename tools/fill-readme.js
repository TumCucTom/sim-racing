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
const rows = [b.baseline, ...b.policies].map(p => `| ${p.name}${p.run === b.champion ? ' ★' : ''} | ${p.completed}/${p.trials} | ${f(p.mean)} | ${p.sd.toFixed(2)} | ${f(p.best)} | ${f(p.worst)} |`).join('\n');
const rl = `The AI driver is trained with PPO on the **same** \`src/sim\` code the game runs.

- **Environment** (\`rl/env.js\`): 20 Hz decisions over 300 Hz physics. 22 observations (speeds, yaw rate, lateral offset, heading error, steering, g-forces, rear slip, gradient, curvature at 10 look-ahead distances up to 200 m). Two actions: steering (through the same speed-sensitive steering map the keyboard uses) and a combined throttle/brake pedal. Reward = metres of progress; leaving the circuit ends the episode with a speed-scaled penalty. Starts are randomised around the lap (12 % from the grid) with ±4 % track-grip variation, all from the episode seed.
- **Learner** (\`rl/ppo.js\`): dependency-free PPO-clip, 64×64 tanh MLPs, GAE(0.95), γ = 0.992, 32 envs × 128 steps, 5 epochs, KL-adaptive learning rate. The policy is mirror-equivariant by construction (a left-hander and its mirror image share weights) and its action means are tanh-bounded.
- **Determinism**: a (car, seed, steps) triple fully determines training; evaluation is bit-reproducible (re-running the champion on the benchmark seeds gave identical lap times: **${b.deterministic?.identical}**).
- **Protocol**: policies are selected on 5 validation seeds (9001–9005). The benchmark uses ${b.trials} different seeds (1–${b.trials}): standing start, two timed laps, score = the second (flying) lap, counted only if it stays inside track limits. The baseline gets its best shot — its grip factor is swept and the fastest setting that completes all ${b.trials} trials cleanly is used (grip ${b.baseline.grip}).

**Result — ${b.track}, Arrow GT3-R, ${b.trials} fixed-seed trials each:**

| Driver | Clean laps | Mean (s) | SD | Best | Worst |
|---|---|---|---|---|---|
${rows}

★ = champion chosen by validation score. ${champ && champ.mean ? `It laps in **${f(champ.mean)} s** against the baseline's **${f(b.baseline.mean)} s** — **${((1 - champ.mean / b.baseline.mean) * 100).toFixed(1)} % faster**${champ.completed < champ.trials ? `, but only ${champ.completed} of ${champ.trials} trials were clean` : `, with all ${champ.trials} trials clean`}.` : ''}

![Learning curves](docs/learning-curve-gt3.svg)

![Benchmark](docs/benchmark-gt3.svg)

Why it is faster: the baseline follows the centre line and brakes in a straight line; the policy learned to use the full width, trail-brake and carry more apex speed. In the game, press **I** to let it drive, **G** to race its ghost, or pick "AI lap" in the telemetry panel to overlay its traces on yours.

What didn't work first: the initial 4 × 2.5M-step runs never completed a lap — agents sped up until they flew off at the one significant right-hand corner. See the changelog for the diagnosis and the three fixes.`;
const perfMd = perf ? `Measured in this repository's CI-like container (4 vCPU, **no GPU**: Chromium renders with SwiftShader software rasterisation, so frame rates are a pessimistic floor, not what a GPU will do).

| Metric | Value |
|---|---|
| Physics throughput (headless Node, 1 core) | ${perf.simStepsPerSec.toLocaleString()} steps/s = ${perf.realtimeFactor}× real time |
| Physics cost per 60 Hz frame (5 steps) | ${perf.simMsPerFrame} ms |
| RL training throughput | ${perf.trainSps} env steps/s per process (4 in parallel) |
| Training time | ${perf.trainMinutes} min per 3M-step seed |
| Build size | ${perf.bundleKb} kB JS (${perf.gzipKb} kB gzip), no external assets |
${perf.render.map(r => `| Render, ${r.quality} @ ${r.track} (software GL, 1280×720) | ${r.fps} fps, ${r.calls} draw calls, ${r.tris} triangles, CPU ${r.frameMs} ms/frame |`).join('\n')}
| Test suite | ${perf.tests} |` : '_run tools/perf.mjs_';
md = md.replace('VALIDATION_TABLE', table).replace('RL_SECTION', rl).replace('PERF_SECTION', perfMd);
fs.writeFileSync('README.md', md);
console.log('README filled');
