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


# ---------------------------------------------------------------- grains ----
OV = 0.125          # grains carry 1/8 cycle of overlap for the splice
NFEAT = 44          # 1/6-octave bands 50 Hz .. 8 kHz

def feat_bands():
    return 50.0 * 2 ** (np.arange(NFEAT + 1) / 6.0)

def chunk_features(chunks, sr=SR):
    """Average power spectrum of equal-length chunks -> 1/6-octave band levels (dB, total-normalised)."""
    n = len(chunks[0]); w = np.hanning(n)
    P = np.zeros(n // 2 + 1)
    for c in chunks: P += np.abs(np.fft.rfft(c * w)) ** 2
    P /= len(chunks); F = np.fft.rfftfreq(n, 1 / sr)
    e = feat_bands(); out = np.zeros(NFEAT)
    for i in range(NFEAT):
        m = (F >= e[i]) & (F < e[i + 1])
        out[i] = P[m].sum() if m.any() else np.interp((e[i] * e[i + 1]) ** 0.5, F, P) * (e[i + 1] - e[i]) / F[1]
    return out, P, F

def cycles_from_source(src, refdir):
    """Track one source segment and return every engine cycle found in it."""
    x = load(os.path.join(refdir, src['file']), src.get('t0', 0), src.get('t1'))
    x = x - np.mean(x)
    cyl = src['cyl']
    t, f, conf = track_f0(x, src['fmin'], src['fmax'], halfpen=src.get('halfpen', 1.0), jump=src.get('jump', 0.5))
    ph, h, env = refine_phase(x, t, f, harm=src.get('harm', 1))
    ph = np.maximum.accumulate(ph)
    th = ph / cyl                                   # 720-degree cycles
    ts = np.arange(len(x)) / SR
    k0 = int(np.ceil(th[0] + 0.01)); k1 = int(np.floor(th[-1] - 2.3))
    ks = np.arange(k0, max(k0, k1))
    tk = np.interp(ks, th, ts)                      # time of each cycle start
    cycles = []
    for i in range(1, len(ks) - 1):
        dur = tk[i + 1] - tk[i]
        rpm = 120.0 / dur
        slope = (120.0 / (tk[i + 1] - tk[i]) - 120.0 / (tk[i] - tk[i - 1])) / dur
        a = int(tk[i] * SR)
        lvl = np.sqrt(np.mean(x[a:a + int(dur * SR) + 1] ** 2))
        cycles.append(dict(k=ks[i], t=tk[i], rpm=rpm, slope=slope, lvl=lvl, src=src))
    return dict(x=x, th=th, ts=ts, cycles=cycles, t0=src.get('t0', 0), name=src['file'])

def extract(trk, k, L, ncyc=2.3):
    """Resample cycles [k, k+ncyc) of a track to L samples per cycle (angle domain)."""
    th = k + np.arange(int(L * ncyc)) / L
    tt = np.interp(th, trk['th'], trk['ts']) * SR
    i = np.floor(tt).astype(int); fr = tt - i; x = trk['x']
    i = np.clip(i, 1, len(x) - 3)
    y0, y1, y2, y3 = x[i - 1], x[i], x[i + 1], x[i + 2]     # Catmull-Rom
    return y1 + 0.5 * fr * (y2 - y0 + fr * (2 * y0 - 5 * y1 + 4 * y2 - y3 + fr * (3 * (y1 - y2) + y3 - y0)))

def ncorr(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))

def best_shift(g, tpl):
    """Circular shift s such that g[s:s+L] best matches tpl (both one cycle long)."""
    L = len(tpl)
    c = np.fft.irfft(np.fft.rfft(g[:L]) * np.conj(np.fft.rfft(tpl)), L)
    s = int(np.argmax(c)); return s, c[s] / (np.linalg.norm(g[:L]) * np.linalg.norm(tpl) + 1e-12)

def build_bank(car, rc, refdir, outdir, refout, verbose=True):
    cyl = rc['cyl']; K = rc.get('K', 8); qmin = rc.get('qmin', 0.55)
    lo, hi, nb = rc['rpmLo'], rc['rpmHi'], rc['bands']
    centers = lo * (hi / lo) ** (np.arange(nb) / (nb - 1))
    edges = np.sqrt(centers[:-1] * centers[1:])
    Ls = [int(round(SR * 120.0 / c)) for c in centers]
    tracks = [cycles_from_source(dict(s, cyl=cyl), refdir) for s in rc['sources']]
    up, dn = rc.get('slopeOn', 250), rc.get('slopeOff', -120)
    pools = {(b, st): [] for b in range(nb) for st in (0, 1)}      # st 1 = on load, 0 = off
    for ti, trk in enumerate(tracks):
        cs = trk['cycles']
        for c in cs:
            if c['rpm'] < lo * 0.9 or c['rpm'] > hi * 1.1: continue
            b = int(np.searchsorted(edges, c['rpm'])); L = Ls[b]
            g = extract(trk, c['k'], L)
            q = ncorr(g[:L], g[L:2 * L])
            force = c['src'].get('state')
            if force is not None: sts = [1] if force == 'on' else [0] if force == 'off' else [0, 1]
            elif c['slope'] > up: sts = [1]
            elif c['slope'] < dn: sts = [0]
            else: sts = [0, 1] if b == 0 else ([1] if c['src'].get('steady', 'on') == 'on' else [0])
            for st in sts: pools[(b, st)].append(dict(g=g, q=q, ti=ti, **c))
    meta = dict(car=car, sr=SR, cyl=cyl, ov=OV, rpmScale=rc.get('rpmScale', 1.0), bands=[], credit=rc.get('credit', ''))
    pcm = []; pos = 0; prev_tpl = None; ref = dict(car=car, bands=[]); summary = []
    chosen = {}
    for b in range(nb):
        L = Ls[b]
        for st in (1, 0):
            cand = [c for c in pools[(b, st)] if c['q'] >= qmin]
            cand.sort(key=lambda c: -c['q'])
            sel = []
            for c in cand:      # spread the picks in time so they are different combustion events
                if all(c['ti'] != s['ti'] or abs(c['k'] - s['k']) >= 2 for s in sel): sel.append(c)
                if len(sel) >= K: break
            chosen[(b, st)] = sel
    # level of each band/state as recorded (median over the pool)
    def lvl(b, st):
        p = [c['lvl'] for c in pools[(b, st)] if c['q'] >= qmin]
        return float(np.median(p)) if p else None
    for b in range(nb):
        L = Ls[b]; entry = dict(rpm=float(centers[b]), L=L, on=None, off=None)
        for st, key in ((1, 'on'), (0, 'off')):
            sel = chosen[(b, st)]
            real = len(sel) >= rc.get('minGrains', 3)
            if not real:
                entry[key] = None; continue
            tpl = sel[0]['g'][:L]
            if prev_tpl is not None:
                # align this band to the neighbour so crossfades between bands stay in phase
                pt = np.interp(np.arange(L) / L, np.arange(len(prev_tpl)) / len(prev_tpl), prev_tpl, period=1.0)
                s, _ = best_shift(np.concatenate([tpl, tpl]), pt); tpl = np.roll(tpl, -s)
            grains = []
            for c in sel:
                s, cc = best_shift(c['g'], tpl)
                g = c['g'][s:s + int(round(L * (1 + OV)))]
                grains.append(g)
            rms = np.sqrt(np.mean([np.mean(g[:L] ** 2) for g in grains]))
            grains = [g / rms * np.clip(np.sqrt(np.mean(g[:L] ** 2)) / rms, 0.7, 1.4) / (np.sqrt(np.mean(g[:L] ** 2)) / rms) for g in grains]
            offs = []
            for g in grains: offs.append(pos); pcm.append(g); pos += len(g)
            entry[key] = dict(at=offs, n=len(grains), lvl=lvl(b, st), q=float(np.mean([c['q'] for c in sel])))
            if st == 1 or prev_tpl is None or entry['on'] is None: prev_tpl = tpl
            # reference features from the cycles that did NOT go into the bank (hold-out)
            used = {(c['ti'], c['k']) for c in sel}
            rest = [c for c in pools[(b, st)] if c['q'] >= qmin and all(c['ti'] != u[0] or abs(c['k'] - u[1]) >= 2 for u in used)]
            held = len(rest) >= 3
            src = rest if held else sel
            fb, P, F = chunk_features([c['g'][:2 * L] for c in src])
            ref['bands'].append(dict(rpm=float(centers[b]), state=key, L=L, heldOut=held, n=len(src), feat=[float(v) for v in fb]))
            summary.append(f"  {centers[b]:6.0f} rpm {key:3s}: pool {len(pools[(b, st)]):4d}  good {len([c for c in pools[(b, st)] if c['q'] >= qmin]):4d}  used {len(sel)}  q={entry[key]['q']:.2f}  lvl={20 * np.log10(entry[key]['lvl'] + 1e-9):6.1f} dB  holdout={'yes' if held else 'no'}")
        if entry['on'] is None and entry['off'] is None:
            summary.append(f"  {centers[b]:6.0f} rpm : NO DATA (filled from neighbour at run time)")
        meta['bands'].append(entry)
    allp = np.concatenate(pcm) if pcm else np.zeros(1)
    peak = np.max(np.abs(allp)); scale = 0.89 / peak; meta['unit'] = float(1.0 / scale)   # rms 1.0 == `unit`... see synth
    meta['norm'] = float(scale)
    i16 = np.clip(np.round(allp * scale * 32767), -32768, 32767).astype('<i2')
    mj = json.dumps(meta, separators=(',', ':')).encode()
    if len(mj) % 2: mj += b' '
    data = i16.tobytes()
    fmt = struct.pack('<HHIIHH', 1, 1, SR, SR * 2, 2, 16)
    body = b'WAVE' + b'fmt ' + struct.pack('<I', 16) + fmt + b'rsim' + struct.pack('<I', len(mj)) + mj + b'data' + struct.pack('<I', len(data)) + data
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, car + '.wav'), 'wb') as fh: fh.write(b'RIFF' + struct.pack('<I', len(body)) + body)
    os.makedirs(refout, exist_ok=True)
    json.dump(ref, open(os.path.join(refout, car + '.json'), 'w'))
    if verbose:
        print(f"{car}: {len(i16) / SR:.1f}s of grains, {len(data) / 1e6:.2f} MB")
        print('\n'.join(summary))

def cmd_bank(a):
    rc = json.load(open(a.recipes))
    for car in (a.cars or [k for k in rc if not k.startswith('_')]):
        build_bank(car, rc[car], a.refdir, a.outdir, a.refout)

if __name__ == '__main__':
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest='cmd')
    s = sub.add_parser('track'); s.add_argument('file'); s.add_argument('--cyl', type=int, default=4)
    s.add_argument('--fmin', type=float, default=20); s.add_argument('--fmax', type=float, default=500)
    s.add_argument('--t0', type=float, default=0); s.add_argument('--t1', type=float, default=None)
    s.add_argument('--every', type=float, default=0.1); s.add_argument('--halfpen', type=float, default=1.0)
    s = sub.add_parser('bank'); s.add_argument('recipes'); s.add_argument('refdir'); s.add_argument('--outdir', default='public/audio'); s.add_argument('--refout', default='tools/audio-ref'); s.add_argument('cars', nargs='*')
    a = p.parse_args()
    if a.cmd == 'track': cmd_track(a)
    elif a.cmd == 'bank': cmd_bank(a)
