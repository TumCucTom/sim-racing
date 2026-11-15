#!/usr/bin/env python3
"""Order tracking + pitch-synchronous grain extraction for the engine banks.

  python3 -I tools/audio-build.py track  ref.wav --cyl 8 --fmin 40 --fmax 520 [--t0 .. --t1 ..]
  python3 -I tools/audio-build.py bank   tools/audio-recipes.json <car> <refdir> <outdir>

`track` prints the firing-frequency track of a recording (to inspect what a
file contains).  `bank` reads a recipe (which recording, which time ranges,
cylinder count, rpm limits) and writes public/audio/<car>.wav: a plain mono
16-bit WAV holding single engine cycles (720 deg of crank) cut from the
recording, resampled to a fixed length per rpm band, plus an 'rsim' chunk with
the JSON index.  It also writes tools/audio-ref/<car>.json with the measured
reference spectra that tools/audio-compare.mjs scores the game against.
"""
import sys, json, os, struct, argparse, subprocess
import numpy as np
from scipy.signal import stft, butter, sosfiltfilt

SR = 44100

def load(path, t0=0, t1=None):
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-']
    x = np.frombuffer(subprocess.run(cmd, capture_output=True).stdout, dtype=np.float32).astype(np.float64)
    a = int(t0 * SR); b = len(x) if t1 is None else int(t1 * SR)
    return x[a:b]

def track_f0(x, fmin, fmax, H=8, nwin=2048, hop=256, nfft=16384, halfpen=1.0, jump=0.5):
    """Firing-frequency track by harmonic-comb salience + Viterbi. Returns t, f, salience-confidence."""
    F, T, Z = stft(x, SR, window='hann', nperseg=nwin, noverlap=nwin - hop, nfft=nfft, boundary=None, padded=False)
    A = np.abs(Z) ** 0.5
    A = A / (A.mean(axis=0, keepdims=True) + 1e-9)
    df = F[1]
    cands = np.exp(np.arange(np.log(fmin), np.log(fmax), 0.006))
    S = np.zeros((len(cands), A.shape[1]))
    for i, f in enumerate(cands):
        s = 0
        for h in range(1, H + 1):
            if h * f > SR / 2 - 200: break
            w = h ** -0.4
            s = s + w * (A[int(round(h * f / df))] - halfpen * A[int(round((h - 0.5) * f / df))])
        S[i] = s
    # Viterbi
    nC, nT = S.shape
    lf = np.log(cands)
    pen = np.abs(lf[:, None] - lf[None, :]) / 0.006
    trans = -jump * np.minimum(pen, 40) ** 1.0 * (S.std() * 0.12)
    D = S[:, 0].copy(); back = np.zeros((nC, nT), dtype=np.int32)
    # restrict transitions to +-12 bins per hop for speed
    W = 12
    for t in range(1, nT):
        best = np.full(nC, -1e18); arg = np.zeros(nC, dtype=np.int32)
        for d in range(-W, W + 1):
            src = np.roll(D, d) + trans[0, abs(d)] if True else None
            if d > 0: src[:d] = -1e18
            elif d < 0: src[d:] = -1e18
            m = src > best; best[m] = src[m]; arg[m] = (np.arange(nC) - d)[m]
        D = best + S[:, t]; back[:, t] = arg
    path = np.zeros(nT, dtype=np.int32); path[-1] = int(np.argmax(D))
    for t in range(nT - 1, 0, -1): path[t - 1] = back[path[t], t]
    f = cands[path]
    conf = S[path, np.arange(nT)] / (np.percentile(S, 99) + 1e-9)
    t = T
    return t, f, conf

def refine_phase(x, t, f, harm=1, bw=0.18):
    """Phase of the firing order by heterodyning with the coarse track. Returns per-sample phase (cycles of firing)."""
    n = len(x); ts = np.arange(n) / SR
    fi = np.interp(ts, t, f)
    ph = np.cumsum(fi) / SR
    best = None
    for h in ([harm] if harm else [1, 2]):
        z = x * np.exp(-2j * np.pi * h * ph)
        # low-pass proportional to a fraction of the firing frequency (use median)
        fc = max(6.0, bw * np.median(fi))
        sos = butter(2, fc / (SR / 2), output='sos')
        zl = sosfiltfilt(sos, z.real) + 1j * sosfiltfilt(sos, z.imag)
        e = np.mean(np.abs(zl))
        if best is None or e > best[0]: best = (e, h, zl)
    _, h, zl = best
    dph = np.unwrap(np.angle(zl)) / (2 * np.pi * h)
    # only keep the slow part of the correction (the fast part is the waveform itself)
    return ph + dph, h, np.abs(zl)

def cmd_track(a):
    x = load(a.file, a.t0, a.t1)
    t, f, c = track_f0(x, a.fmin, a.fmax, halfpen=a.halfpen)
    step = max(1, int(a.every * SR / 256))
    for i in range(0, len(t), step):
        rms = 20 * np.log10(np.sqrt(np.mean(x[int(t[i] * SR) - 1024:int(t[i] * SR) + 1024] ** 2)) + 1e-9)
        print(f"{t[i] + a.t0:7.2f}s  f={f[i]:6.1f}Hz  rpm={f[i] * 120 / a.cyl:6.0f}  conf={c[i]:.2f}  {rms:6.1f}dB")

if __name__ == '__main__':
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest='cmd')
    s = sub.add_parser('track'); s.add_argument('file'); s.add_argument('--cyl', type=int, default=4)
    s.add_argument('--fmin', type=float, default=20); s.add_argument('--fmax', type=float, default=500)
    s.add_argument('--t0', type=float, default=0); s.add_argument('--t1', type=float, default=None)
    s.add_argument('--every', type=float, default=0.1); s.add_argument('--halfpen', type=float, default=1.0)
    a = p.parse_args()
    if a.cmd == 'track': cmd_track(a)
