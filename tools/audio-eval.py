#!/usr/bin/env python3
"""Transient-aware scoring of the engine voice (what steady-state LSD cannot see).

  python3 -I tools/audio-eval.py ref   tools/audio-recipes.json <dir with recordings> [car ...] [--json out.json]
  python3 -I tools/audio-eval.py drive <dir written by tools/audio-drive.mjs>          [car ...] [--json out.json]
  python3 -I tools/audio-eval.py table ref.json before.json after.json

`ref` analyses the source recordings (rpm from the order tracker of audio-build.py),
`drive` analyses <car>-engine.wav / <car>.wav + <car>.json of a scripted drive
(rpm from the trace). Both print the same engine metrics:

  HNR lo/mid/hi/top  harmonic-to-noise ratio in 40-250 / 250-1000 / 1000-4000 / 4000-12000 Hz (dB), measured in
                     the angle domain over 8 engine cycles: energy on multiples of the cycle frequency against
                     the energy between them. Too high = too clean ("synthetic"); too low = hissy.
  REP                share of cycle pairs (2..12 cycles apart) whose NON-periodic part above 1 kHz is the same
                     waveform again (correlation > 0.6). Real engines: ~0. Granular replay of a few stored
                     cycles: well above 0 = frozen, "vocoder" noise.
  FIX                formant fixedness: share of the variance of the firing-harmonic amplitudes (after
                     removing per-harmonic and per-rpm means) explained by a filter that is fixed in Hz.
                     0 = formants move with the pitch (pitch-shifted sample), higher = fixed resonances.
  CYC lo/hi          correlation of consecutive engine cycles below 500 Hz / above 1.5 kHz.
  MOD slow/fast      modulation depth of the 1-6 kHz envelope at 2-8 Hz / 8-30 Hz (dB re mean): lumpiness.
  FLUX               mean frame-to-frame change of the 1/6-octave log spectrum (dB, 23 ms hop).
  LOAD dL/dC         on- minus off-load level (dB) and spectral-centroid ratio at comparable rpm
                     (recordings: revs rising vs falling; drive: throttle > 0.9 vs < 0.05).
  LTAS               long-term spectrum, share of energy (dB) < 150, 150-600, 600-2400, 2400-5000, > 5000 Hz.
  CREST              peak / rms (dB).
`drive` adds, from the full stereo mix: level, crest, L/R correlation, and the depth (dB) and length (ms) of
the level dip at up-shifts and the engine level swing at the rev limiter.
"""
import sys, os, json, importlib.util
import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('audio_build', os.path.join(here, 'audio-build.py'))
ab = importlib.util.module_from_spec(spec); spec.loader.exec_module(ab)
SR = ab.SR
from scipy.signal import butter, sosfiltfilt

def bandpass(x, lo, hi):
    if hi >= SR / 2 - 100: sos = butter(4, lo / (SR / 2), 'highpass', output='sos')
    elif lo <= 0: sos = butter(4, hi / (SR / 2), 'lowpass', output='sos')
    else: sos = butter(4, [lo / (SR / 2), hi / (SR / 2)], 'bandpass', output='sos')
    return sosfiltfilt(sos, x)

def to_angle(x, th, ts, k0, ncyc, L):
    """ncyc cycles starting at cycle k0, resampled to L samples per cycle."""
    a = k0 + np.arange(int(L * ncyc)) / L
    tt = np.interp(a, th, ts) * SR
    i = np.clip(np.floor(tt).astype(int), 0, len(x) - 2); fr = tt - i
    return x[i] * (1 - fr) + x[i + 1] * fr

HB = [(40, 250), (250, 1000), (1000, 4000), (4000, 12000)]

def engine_metrics(x, th, ts, cyl, firing_mul=1, load_flag=None):
    """x: mono signal, th: engine-cycle phase per sample (monotonic), ts: sample times. Returns dict."""
    out = {}
    k0 = int(np.ceil(th[0] + 0.5)); k1 = int(np.floor(th[-1] - 9))
    tk = np.interp(np.arange(k0, k1 + 10), th, ts)
    rpm_k = 120.0 / np.maximum(1e-6, np.diff(tk))
    lvl = np.sqrt(np.mean(x ** 2)) + 1e-12
    # ---- HNR per band (angle domain, 8 cycles, Hann) ----
    W = 8; Hs = np.zeros(4); Ns = np.zeros(4)
    for k in range(k0, k1 - W, 4):
        i = k - k0; fc = rpm_k[i:i + W].mean() / 120.0
        if abs(rpm_k[i + W - 1] / rpm_k[i] - 1) > 0.25: continue
        Lc = int(min(4096, 2 ** np.ceil(np.log2(SR / fc))))
        seg = to_angle(x, th, ts, k, W, Lc)
        if np.sqrt(np.mean(seg ** 2)) < lvl * 0.05: continue
        P = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
        j = np.arange(len(P)); f = j * fc / W; m = j % W
        nmask = (m >= 3) & (m <= 5); hmask = (m == 0) | (m == 1) | (m == W - 1)
        for b, (lo, hi) in enumerate(HB):
            inb = (f >= lo) & (f < hi)
            if inb.sum() < 2 * W: continue
            n0 = P[inb & nmask].mean() if (inb & nmask).any() else 0.0
            tot = P[inb].sum(); noise = n0 * inb.sum()
            Hs[b] += max(0.0, tot - noise); Ns[b] += noise
    out['hnr'] = [float(10 * np.log10((Hs[b] + 1e-20) / (Ns[b] + 1e-20))) if Ns[b] > 0 else None for b in range(4)]
    # ---- cycle matrices for CYC / REP ----
    Lc = 256
    xl = bandpass(x, 0, 500); xh = bandpass(x, 1500, 12000); xr = bandpass(x, 1000, 12000)
    def cyc_mat(sig, L=Lc):
        a = k0 + np.arange((k1 - k0) * L) / L
        tt = np.interp(a, th, ts) * SR
        i = np.clip(np.floor(tt).astype(int), 0, len(sig) - 2); fr = tt - i
        return (sig[i] * (1 - fr) + sig[i + 1] * fr).reshape(k1 - k0, L)
    def cc(M):
        a, b = M[:-1], M[1:]
        num = (a * b).sum(1); den = np.sqrt((a * a).sum(1) * (b * b).sum(1)) + 1e-12
        e = np.sqrt((a * a).mean(1)); ok = e > np.percentile(e, 60) * 0.1
        return float(np.mean((num / den)[ok]))
    Ml = cyc_mat(xl); out['cyc_lo'] = cc(Ml)
    # the high band needs more samples per cycle to hold 1.5 kHz+ at low rpm
    Lh = 1024; Mh = cyc_mat(xh, Lh); out['cyc_hi'] = cc(Mh)
    Mr = cyc_mat(xr, Lh)
    n = len(Mr); hw = 6
    if n > 40:
        cs = np.cumsum(np.vstack([np.zeros((1, Lh)), Mr]), axis=0)
        idx = np.arange(n); a0 = np.clip(idx - hw, 0, n); a1 = np.clip(idx + hw + 1, 0, n)
        mean = (cs[a1] - cs[a0] - Mr) / (a1 - a0 - 1)[:, None]
        Rm = Mr - mean
        Rn = Rm / (np.linalg.norm(Rm, axis=1, keepdims=True) + 1e-12)
        e = np.linalg.norm(Mr, axis=1); ok = e > np.percentile(e, 60) * 0.1
        hits = 0; tot = 0
        for lag in range(2, 13):
            c = (Rn[:-lag] * Rn[lag:]).sum(1)[ok[:-lag] & ok[lag:]]
            hits += int((c > 0.6).sum()); tot += len(c)
        out['rep'] = hits / max(1, tot)
    else: out['rep'] = None
    # ---- formant fixedness from firing-harmonic amplitudes ----
    fo = cyl / firing_mul          # firing order in cycle harmonics
    rows = []
    W = 4
    for k in range(k0, k1 - W, 2):
        i = k - k0; fc = rpm_k[i:i + W].mean() / 120.0
        if abs(rpm_k[i + W - 1] / rpm_k[i] - 1) > 0.2: continue
        Lc2 = int(min(4096, 2 ** np.ceil(np.log2(SR / fc))))
        seg = to_angle(x, th, ts, k, W, Lc2)
        if np.sqrt(np.mean(seg ** 2)) < lvl * 0.05: continue
        P = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
        tot = P.sum() + 1e-20
        for h in range(1, 25):
            j = int(round(h * fo * W)); f = h * fo * fc
            if j + 1 >= len(P) or f > 6000: break
            rows.append((h, np.log2(fc), np.log2(f), 10 * np.log10(P[j - 1:j + 2].sum() / tot + 1e-12)))
    out['fix'] = None
    if len(rows) > 400:
        R = np.array(rows); y = R[:, 3]
        hb = R[:, 0].astype(int) - 1
        rb = np.floor((R[:, 1] - R[:, 1].min()) * 6).astype(int)          # 1/6-octave rpm buckets
        fb = np.floor((R[:, 2] - R[:, 2].min()) * 4).astype(int)          # 1/4-octave frequency bins
        if rb.max() >= 4:
            def design(cols):
                A = np.zeros((len(y), sum(c.max() + 1 for c in cols))); o = 0
                for c in cols: A[np.arange(len(y)), o + c] = 1; o += c.max() + 1
                return A
            def rss(cols):
                A = design(cols); w, *_ = np.linalg.lstsq(A, y, rcond=None); return float(((y - A @ w) ** 2).sum())
            r0 = rss([hb, rb]); r1 = rss([hb, rb, fb])
            out['fix'] = 1 - r1 / (r0 + 1e-12)
    # ---- envelope modulation of the presence band ----
    hop = 256
    env = np.sqrt(np.convolve(bandpass(x, 1000, 6000) ** 2, np.ones(hop) / hop, 'same')[::hop]) + 1e-9
    le = 20 * np.log10(env); fe = SR / hop
    loud = le > np.percentile(le, 90) - 30
    trend = sosfiltfilt(butter(2, 1.0 / (fe / 2), output='sos'), le)
    d = (le - trend) * loud
    def modband(lo, hi):
        sos = butter(2, [lo / (fe / 2), min(0.99, hi / (fe / 2))], 'bandpass', output='sos')
        return float(np.sqrt(np.mean(sosfiltfilt(sos, d)[loud] ** 2)))
    out['mod_slow'] = modband(2, 8); out['mod_fast'] = modband(8, 30)
    # ---- spectral flux, LTAS, crest ----
    nw = 2048; hp = 1024
    fr_ = np.lib.stride_tricks.sliding_window_view(x, nw)[::hp] * np.hanning(nw)
    P = np.abs(np.fft.rfft(fr_, axis=1)) ** 2; F = np.fft.rfftfreq(nw, 1 / SR)
    ed = 50.0 * 2 ** (np.arange(45) / 6.0)
    B = np.stack([P[:, (F >= ed[i]) & (F < ed[i + 1])].sum(1) for i in range(44)], 1) + 1e-14
    lb = 10 * np.log10(B); fl = lb.mean(1) if False else None
    e = B.sum(1); act = e > np.percentile(e, 90) * 1e-3
    lbn = lb - lb.mean(1, keepdims=True)
    fx = np.sqrt(np.mean(np.diff(lbn, axis=0) ** 2, axis=1))
    out['flux'] = float(np.mean(fx[act[1:] & act[:-1]]))
    Pm = P[act].mean(0)
    lt = [Pm[(F >= lo) & (F < hi)].sum() for lo, hi in ((20, 150), (150, 600), (600, 2400), (2400, 5000), (5000, 20000))]
    out['ltas'] = [float(10 * np.log10(v / sum(lt) + 1e-12)) for v in lt]
    cent = (P * F).sum(1) / (P.sum(1) + 1e-20)
    out['crest'] = float(20 * np.log10(np.max(np.abs(x)) / lvl))
    # ---- load contrast ----
    out['load_dL'] = out['load_dC'] = None
    if load_flag is not None:
        tf = (np.arange(len(e)) * hp + nw / 2) / SR
        lf = np.interp(tf, load_flag[0], load_flag[1]); rf = np.interp(tf, load_flag[0], load_flag[2])
        on = (lf > 0.5) & act; off = (lf < -0.5) & act
        dl = []; dc = []
        rb = np.floor(np.log2(np.maximum(rf, 1)) * 4)
        for r in np.unique(rb):
            a = on & (rb == r); b = off & (rb == r)
            if a.sum() >= 4 and b.sum() >= 4:
                dl.append(10 * np.log10(np.median(e[a]) / np.median(e[b]))); dc.append(np.median(cent[a]) / np.median(cent[b]))
        if dl: out['load_dL'] = float(np.mean(dl)); out['load_dC'] = float(np.mean(dc))
    return out

def analyse_ref(rc, refdir):
    """One metrics dict per car: energy-weighted mean over the recipe's source segments."""
    res = []
    for s in rc['sources']:
        src = dict(s, cyl=rc['cyl'])
        x = ab.load(os.path.join(refdir, src['file']), src.get('t0', 0), src.get('t1')); x = x - x.mean()
        if len(x) < SR * 2: continue
        t, f, conf = ab.track_f0(x, src['fmin'], src['fmax'], halfpen=src.get('halfpen', 1.0), jump=src.get('jump', 0.5), w1=src.get('w1', 2.5))
        ph, h, env = ab.refine_phase(x, t, f, harm=src.get('harm', 1)); ph = np.maximum.accumulate(ph)
        fm = src.get('firingMul', 1)
        th = ph / (rc['cyl'] / fm); ts = np.arange(len(x)) / SR
        # load flag from the rpm slope (rev/s^2 thresholds as in the bank builder), restricted to confident frames
        rpm = f * 120 / (rc['cyl'] / fm)
        sl = np.gradient(sosfiltfilt(butter(2, 0.05, output='sos'), rpm), t)
        flag = np.where(sl > rc.get('slopeOn', 250), 1.0, np.where(sl < rc.get('slopeOff', -120), -1.0, 0.0)) * (conf > 0.25)
        m = engine_metrics(x, th, ts, rc['cyl'], fm, (t, flag, rpm))
        m['_w'] = float(len(x)); m['_file'] = src['file']; res.append(m)
    return merge(res)

def merge(res):
    if not res: return None
    out = {}
    for k in res[0]:
        if k.startswith('_'): continue
        vals = [(r[k], r['_w']) for r in res if r.get(k) is not None]
        if not vals: out[k] = None
        elif isinstance(vals[0][0], list):
            out[k] = [float(np.average([v[0][i] for v in vals if v[0][i] is not None], weights=[v[1] for v in vals if v[0][i] is not None])) if any(v[0][i] is not None for v in vals) else None for i in range(len(vals[0][0]))]
        else: out[k] = float(np.average([v[0] for v in vals], weights=[v[1] for v in vals]))
    return out

def read_wav(path):
    import wave
    w = wave.open(path, 'rb'); n = w.getnframes(); nc = w.getnchannels()
    a = np.frombuffer(w.readframes(n), dtype='<i2').astype(np.float64) / 32768.0
    assert w.getframerate() == SR
    return a.reshape(-1, nc)

def analyse_drive(d, car):
    tr = json.load(open(os.path.join(d, car + '.json')))
    T = np.array(tr['trace'], dtype=float); cyl = tr['cyl']
    out = {}
    full = read_wav(os.path.join(d, car + '.wav'))
    if cyl > 0:
        x = read_wav(os.path.join(d, car + '-engine.wav'))[:, 0]
        ts = np.arange(len(x)) / SR
        rpm = np.interp(ts, T[:, 0], T[:, 1])
        # the synth smooths rpm with an 18 ms one-pole; follow it, then refine the phase on the signal itself
        from scipy.signal import lfilter
        k = 1 - np.exp(-1 / (0.018 * SR)); rpm = lfilter([k], [1, -(1 - k)], rpm, zi=[rpm[0] * (1 - k)])[0]
        fire = rpm / 120.0 * cyl
        tt = ts[::256]; ph, h, env = ab.refine_phase(x, tt, fire[::256], harm=1); ph = np.maximum.accumulate(ph)
        th = ph / cyl
        rev = tr.get('kind') == 'rev'
        flag = np.where(T[:, 2] > 0.9, 1.0, np.where(T[:, 2] < 0.05, -1.0, 0.0)) * (T[:, 7] < 0.5) * (T[:, 6] < 0.5) * (T[:, 0] > 2.5)
        if rev: flag = np.where(np.gradient(T[:, 1]) > 0, 1.0, np.where(np.gradient(T[:, 1]) < 0, -1.0, 0.0))
        out = engine_metrics(x, th, ts, cyl, 1, (T[:, 0], flag, T[:, 1]))
        if rev: return out
        # ---- transients on the engine-only render ----
        hop = 64; env = np.sqrt(np.convolve(x ** 2, np.ones(441) / 441, 'same')[::hop]) + 1e-9; le = 20 * np.log10(env); te = np.arange(len(le)) * hop / SR
        ups = [T[i, 0] for i in range(1, len(T)) if T[i, 4] > T[i - 1, 4] and T[i - 1, 4] >= 1 and T[i - 1, 2] > 0.8]
        dips = []; lens = []
        for t0 in ups:
            pre = np.median(le[(te > t0 - 0.25) & (te < t0 - 0.03)]); w = (te > t0 - 0.03) & (te < t0 + 0.45)
            mn = le[w].min(); dips.append(pre - mn); lens.append(1000 * np.sum(le[w] < pre - 3) * hop / SR)
        out['shift_dip'] = float(np.mean(dips)) if dips else None; out['shift_ms'] = float(np.mean(lens)) if lens else None; out['n_up'] = len(ups)
        lim = (te > 24.8) & (te < 26.9)
        out['lim_swing'] = float(np.percentile(le[lim], 95) - np.percentile(le[lim], 5))
    if tr.get('kind') == 'rev': return out
    m = full.mean(1); out['mix_rms'] = float(10 * np.log10(np.mean(m ** 2) + 1e-12)); out['mix_crest'] = float(20 * np.log10(np.abs(full).max() / (np.sqrt(np.mean(m ** 2)) + 1e-9)))
    drv = slice(int(2.5 * SR), int(24 * SR))
    l, r = full[drv, 0], full[drv, 1]; out['lr_corr'] = float(np.dot(l, r) / (np.linalg.norm(l) * np.linalg.norm(r) + 1e-12))
    if cyl > 0:
        e = read_wav(os.path.join(d, car + '-engine.wav'))[drv, 0]
        out['eng_share'] = float(10 * np.log10(np.mean(e ** 2) / (np.mean(m[drv] ** 2) + 1e-12)))
    return out

def f1(v, w=5): return ('%*.1f' % (w, v)) if v is not None else ' ' * (w - 1) + '-'
def f2(v, w=5): return ('%*.2f' % (w, v)) if v is not None else ' ' * (w - 1) + '-'
def line(name, m):
    s = f"{name:16s} HNR {' '.join(f1(v) for v in m['hnr'])} | REP {f2(m['rep'])} | FIX {f2(m['fix'])} | CYC {f2(m['cyc_lo'])} {f2(m['cyc_hi'])} | MOD {f1(m['mod_slow'], 4)} {f1(m['mod_fast'], 4)} | FLUX {f1(m['flux'], 4)} | LOAD {f1(m['load_dL'])}dB x{f2(m['load_dC'])} | LTAS {' '.join(f1(v) for v in m['ltas'])} | CREST {f1(m['crest'], 4)}"
    if 'shift_dip' in m: s += f" | SHIFT {f1(m['shift_dip'], 4)}dB {f1(m['shift_ms'], 4)}ms LIM {f1(m['lim_swing'], 4)}dB"
    if 'mix_rms' in m: s += f" | MIX {f1(m['mix_rms'])}dBFS crest {f1(m['mix_crest'], 4)} LR {f2(m['lr_corr'])} eng {f1(m.get('eng_share'))}dB"
    return s

if __name__ == '__main__':
    a = sys.argv[1:]; js = None
    if '--json' in a: i = a.index('--json'); js = a[i + 1]; del a[i:i + 2]
    res = {}
    if a[0] == 'ref':
        rc = json.load(open(a[1]))
        for car in (a[3:] or [k for k in rc if not k.startswith('_')]):
            m = analyse_ref(rc[car], a[2])
            if m: res[car] = m; print(line(car + ' (recording)', m), flush=True)
    elif a[0] == 'drive':
        cars = a[2:] or sorted(f[:-5] for f in os.listdir(a[1]) if f.endswith('.json'))
        cars = [c for c in cars if c.endswith('-rev')] + [c for c in cars if not c.endswith('-rev')]
        for car in cars:
            m = analyse_drive(a[1], car); res[car] = m
            if 'hnr' in m: print(line(car, m), flush=True)
            else: print(f"{car:16s} (no combustion engine) | MIX {f1(m['mix_rms'])}dBFS crest {f1(m['mix_crest'], 4)} LR {f2(m['lr_corr'])}", flush=True)
    elif a[0] == 'table':
        R, B, A = [json.load(open(p)) for p in a[1:4]]
        for car in A:
            if car in R: print(line(car + ' REF', R[car]))
            if car in B and 'hnr' in B[car]: print(line(car + ' before', B[car]))
            if 'hnr' in A[car]: print(line(car + ' after', A[car]))
    if js: json.dump(res, open(js, 'w'), indent=1)
