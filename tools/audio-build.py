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

def track_f0(x, fmin, fmax, H=8, nwin=2048, hop=256, nfft=16384, halfpen=1.0, jump=0.5, w1=2.5):
    """Firing-frequency track by harmonic-comb salience + Viterbi. Returns t, f, salience-confidence."""
    cands = np.exp(np.arange(np.log(fmin), np.log(fmax), 0.006))
    df = SR / nfft
    # salience per chunk (keeps memory flat for recordings several minutes long)
    step = (int(12 * SR) // hop) * hop; Ss = []; Ts = []
    for o in range(0, max(1, len(x) - nwin), step):
        seg = x[o:o + step + nwin - hop]
        if len(seg) < nwin: break
        F, T, Z = stft(seg, SR, window='hann', nperseg=nwin, noverlap=nwin - hop, nfft=nfft, boundary=None, padded=False)
        A = (np.abs(Z) ** 0.5).astype(np.float32)
        A = A / (A.mean(axis=0, keepdims=True) + 1e-9)
        Sc = np.zeros((len(cands), A.shape[1]), dtype=np.float32)
        for i, f in enumerate(cands):
            for h in range(1, H + 1):
                if h * f > SR / 2 - 200: break
                w = h ** -0.4 * (w1 if h == 1 else 1.0)    # the firing order itself must carry energy (guards against octave-down locks)
                Sc[i] += w * (A[int(round(h * f / df))] - halfpen * A[int(round((h - 0.5) * f / df))])
        Ss.append(Sc); Ts.append(T + o / SR)
    S = np.concatenate(Ss, axis=1); T = np.concatenate(Ts)
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
    step = max(1, int(a.every * SR / 256)); row = []
    for i in range(0, len(t), step):
        rms = 20 * np.log10(np.sqrt(np.mean(x[max(0, int(t[i] * SR) - 1024):int(t[i] * SR) + 1024] ** 2)) + 1e-9)
        row.append(f"{t[i] + a.t0:6.2f}s {f[i] * 120 / a.cyl:6.0f}rpm c{c[i]:4.1f} {rms:4.0f}dB")
        if len(row) == 4: print(' | '.join(row)); row = []
    if row: print(' | '.join(row))


# ---------------------------------------------------------------- grains ----
OV = 0.125          # grains carry 1/8 cycle of overlap for the splice
NFEAT = 44          # 1/6-octave bands 50 Hz .. 8 kHz

def feat_bands():
    return 50.0 * 2 ** (np.arange(NFEAT + 1) / 6.0)

def chunk_features(chunks, sr=SR):
    """Average power spectrum of equal-length chunks -> 1/6-octave band powers."""
    n = len(chunks[0]); w = np.hanning(n + 1)[:n]
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
    t, f, conf = track_f0(x, src['fmin'], src['fmax'], halfpen=src.get('halfpen', 1.0), jump=src.get('jump', 0.5), w1=src.get('w1', 2.5))
    ph, h, env = refine_phase(x, t, f, harm=src.get('harm', 1))
    ph = np.maximum.accumulate(ph)
    # 720-degree cycles. firingMul = 2 for recordings whose strongest comb is HALF the firing frequency
    # (V10/V8 with separate bank exhausts heard from one side: the per-bank order dominates)
    th = ph / (cyl / src.get('firingMul', 1))
    ts = np.arange(len(x)) / SR
    k0 = int(np.ceil(th[0] + 0.01)); k1 = int(np.floor(th[-1] - 2.3))
    ks = np.arange(k0, max(k0, k1))
    tk = np.interp(ks, th, ts)                      # time of each cycle start
    cycles = []
    for i in range(2, len(ks) - 2):
        dur = tk[i + 1] - tk[i]
        if dur <= 0: continue
        rpm = 120.0 / dur
        slope = (120.0 / max(1e-6, tk[i + 2] - tk[i + 1]) - 120.0 / max(1e-6, tk[i - 1] - tk[i - 2])) / max(1e-6, tk[i + 1] - tk[i - 2])
        a = int(tk[i] * SR)
        lvl = np.sqrt(np.mean(x[a:a + int(dur * SR) + 1] ** 2))
        cycles.append(dict(k=int(ks[i]), t=float(tk[i]), rpm=rpm, slope=slope, lvl=lvl, src=src))
    # keep only the part of the recording where the car is close (pass-bys fade into crowd and PA noise)
    if cycles and src.get('floor', 18) is not None:
        top = np.percentile([c['lvl'] for c in cycles], 95)
        cycles = [c for c in cycles if c['lvl'] >= top * 10 ** (-src.get('floor', 18) / 20.0)]
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

# ------------------------------------------------- harmonic + noise model ----
QN = 0.5            # cycles at least this periodic count as "engine" for the noise statistics (the stored cycles need qmin)
NB3 = 27            # noise spectrum: 1/3-octave bands 40 Hz .. 16 kHz + (edges 40 * 2^(i/3))
NENV = 32           # noise envelope: points per engine cycle

def noise_edges():
    return 40.0 * 2 ** (np.arange(NB3 + 1) / 3.0)

def res_lowpass(nbin, per_cycle, cyl):
    """Gain per FFT bin that keeps the cycle-to-cycle variation of the low engine orders (combustion
    variation: coherent, cycle-locked) and removes it above (turbulence: replaced by fresh noise at run
    time). Fades between 2.5x and 5x the firing order. per_cycle = FFT bins per cycle harmonic."""
    k = np.arange(nbin) / per_cycle
    return np.clip(0.5 + 0.5 * np.cos(np.pi * (k - 2.5 * cyl) / (2.5 * cyl)), 0, 1) * (k < 5 * cyl) + (k < 2.5 * cyl) * 0

def fft_gain(x, gain_of_bin):
    """Zero-phase filtering of a chunk through a real gain per rfft bin (edges tapered; cut the middle afterwards)."""
    n = len(x); w = np.ones(n); e = max(8, n // 10); r = 0.5 - 0.5 * np.cos(np.pi * np.arange(e) / e); w[:e] = r; w[-e:] = r[::-1]
    return np.fft.irfft(np.fft.rfft(x * w) * gain_of_bin(n // 2 + 1), n)

def build_bank(car, rc, refdir, outdir, refout, verbose=False):
    cyl = rc['cyl']; K = rc.get('K', 8); qmin = rc.get('qmin', 0.55)
    lo, hi, nb = rc['rpmLo'], rc['rpmHi'], rc['bands']
    centers = lo * (hi / lo) ** (np.arange(nb) / (nb - 1))
    edges = np.sqrt(centers[:-1] * centers[1:])
    Ls = [int(round(SR * 120.0 / c)) for c in centers]
    tracks = [cycles_from_source(dict(s, cyl=cyl), refdir) for s in rc['sources']]
    up, dn = rc.get('slopeOn', 250), rc.get('slopeOff', -120)
    pools = {(b, st): [] for b in range(nb) for st in (0, 1)}      # st 1 = on load, 0 = off
    for ti, trk in enumerate(tracks):
        for c in trk['cycles']:
            if c['rpm'] < lo * 0.9 or c['rpm'] > hi * 1.1: continue
            if c['rpm'] < c['src'].get('rpmMin', 0) or c['rpm'] > c['src'].get('rpmMax', 1e9): continue
            b = int(np.searchsorted(edges, c['rpm'])); L = Ls[b]
            g = extract(trk, c['k'], L)
            q = ncorr(g[:L], g[L:2 * L])
            if q < min(rc.get('qn', QN), c['src'].get('q', qmin)): continue  # not periodic enough: noise, crowd, limiter, mistracking
            g = g.astype(np.float32)
            force = c['src'].get('state')
            if force is not None: sts = [1] if force == 'on' else [0] if force == 'off' else [0, 1]
            elif c['slope'] > up: sts = [1]
            elif c['slope'] < dn: sts = [0]
            else: sts = [0, 1] if c['rpm'] < rc.get('idleBelow', lo * 1.25) else ([1] if c['src'].get('steady', 'on') == 'on' else [0])
            for st in sts: pools[(b, st)].append(dict(g=g, q=q, ti=ti, **c))
    meta = dict(car=car, sr=SR, cyl=cyl, ov=OV, v=2, rpmScale=rc.get('rpmScale', 1.0), bands=[])
    pcm = []; pos = 0; prev_tpl = None; summary = []
    ref = dict(car=car, cyl=cyl, rpmScale=rc.get('rpmScale', 1.0), source=[s_['file'] for s_ in rc['sources']], bands=[])
    for b in range(nb):
        L = Ls[b]; entry = dict(rpm=float(centers[b]), L=L, on=None, off=None)
        for st, key in ((1, 'on'), (0, 'off')):
            good = sorted([c for c in pools[(b, st)] if c['q'] >= c['src'].get('q', qmin)], key=lambda c: -c['q'])
            cand = []
            for c in good:      # spread the picks so they are different combustion events
                if all(c['ti'] != s['ti'] or abs(c['k'] - s['k']) >= 2 for s in cand): cand.append(c)
                if len(cand) >= 3 * K: break
            if len(cand) < rc.get('minGrains', 3): continue
            # the most typical cycle (medoid) is the template; keep the K cycles most like it, so that the
            # cycle-to-cycle variation of the playback stays close to that of consecutive real cycles
            if len(cand) > 2:
                C = np.array([[best_shift(a['g'], b_['g'][:L])[1] if a is not b_ else 1.0 for b_ in cand] for a in cand])
                m = int(np.argmax(C.sum(axis=0)))
                order = np.argsort(-C[:, m])
                sel = [cand[i] for i in order[:K]]
            else: sel = cand
            tpl = sel[0]['g'][:L]
            if prev_tpl is not None:
                # align this band to its neighbour so crossfades between bands and load states stay in phase
                pt = np.interp(np.arange(L) / L, np.arange(len(prev_tpl)) / len(prev_tpl), prev_tpl, period=1.0)
                s, _ = best_shift(tpl, pt); tpl = np.roll(tpl, -s)
            offs = []
            # ---- harmonic part: mean cycle M of the candidates, aligned to the template ----
            sh = [best_shift(c['g'], tpl)[0] for c in cand]
            M = np.mean([c['g'][s_:s_ + L] / (np.sqrt(np.mean(c['g'][s_:s_ + L] ** 2)) + 1e-12) for c, s_ in zip(cand, sh)], axis=0)
            # ---- stored cycles = M + the low-order part of each real cycle's deviation from M ----
            GL = int(round(L * (1 + OV))); mg = L // 2; chunks = []; lowres = np.zeros(L // 2 + 1)
            for c in sel:
                s_ = best_shift(c['g'], tpl)[0]
                X = extract(tracks[c['ti']], c['k'] - 1, L, 4.5)[L + s_ - mg: L + s_ + GL + mg]
                X = X / (np.sqrt(np.mean(X[mg:mg + L] ** 2)) + 1e-12)
                Mt = np.resize(np.roll(M, mg), len(X))                           # M tiled, in phase with the chunk
                r = fft_gain(X - Mt, lambda nb_, n_=len(X): res_lowpass(nb_, n_ / L, cyl))
                chunks.append(Mt + r)
                lowres += np.abs(np.fft.rfft(r[mg:mg + L])) ** 2 / L ** 2 / len(sel)
            raw = [ch[mg:mg + GL] for ch in chunks]
            rms = np.sqrt(np.mean([np.mean(g[:L] ** 2) for g in raw]))
            for g in raw:
                r = np.sqrt(np.mean(g[:L] ** 2)) / rms
                g = g / rms * (np.clip(r, 0.75, 1.3) / r)          # unit RMS per band/state, keep mild cycle-to-cycle level variation
                offs.append(pos); pcm.append(g); pos += len(g)
            lv = float(np.median([c['lvl'] for c in good]))
            entry[key] = dict(at=offs, n=len(offs), lvl=lv, q=float(np.mean([c['q'] for c in sel])))
            # ---- stochastic part: what a TYPICAL good cycle has that the next cycle does not (the difference
            # of two consecutive cycles cancels everything periodic), minus what the stored cycles keep ----
            ne = noise_edges(); nacc = np.zeros(NB3); eacc = np.zeros(NENV); nn = 0
            hp = 1 - res_lowpass(L // 2 + 1, 1.0, cyl) ** 2
            typ = sorted([c for c in pools[(b, st)] if c['q'] >= min(rc.get('qn', QN), c['src'].get('q', qmin))], key=lambda c: -c['q'])
            for c in typ[::max(1, len(typ) // 160)]:
                g = c['g']; d = (g[:L] - g[L:2 * L]) / np.sqrt(2.0); pw = np.mean(g[:2 * L] ** 2) + 1e-12
                D = np.fft.rfft(d); P = np.abs(D) ** 2 / L ** 2 * 2 / pw; P[0] = 0
                Pl = np.maximum(0.0, P - 2 * lowres) * (1 - hp) + P * hp          # do not double what the stored cycles carry
                f = np.arange(len(P)) * c['rpm'] / 120.0
                idx = np.searchsorted(ne, f) - 1; ok = (idx >= 0) & (idx < NB3)
                nacc += np.bincount(idx[ok], weights=Pl[ok], minlength=NB3)
                dh = np.roll(np.fft.irfft(D * np.sqrt(hp), L), -best_shift(g, tpl)[0])
                eacc += (dh[:(L // NENV) * NENV] ** 2).reshape(NENV, -1).mean(1) / pw; nn += 1
            env = eacc / (eacc.mean() + 1e-20); env = np.clip((np.roll(env, 1) + 2 * env + np.roll(env, -1)) / 4, 0.1, 5.0)
            entry[key]['nz'] = [round(float(v), 2) for v in 10 * np.log10(nacc / nn + 1e-9)]
            entry[key]['ne'] = [round(float(v), 2) for v in env / env.mean()]
            if key == 'on' or entry['on'] is None: prev_tpl = tpl
            # reference features from cycles that did NOT go into the bank (hold-out) where enough exist
            used = {(c['ti'], c['k']) for c in sel}
            rest = [c for c in good if all(c['ti'] != u[0] or abs(c['k'] - u[1]) >= 2 for u in used)]
            held = len(rest) >= 3
            srcs = rest if held else sel
            fb, P, F = chunk_features([c['g'][:2 * L] for c in srcs])
            # crank half-order amplitudes: the window holds 2 cycles = 4 revs, so half-order h sits at bin 2*h
            no = int(min(cyl * 2, 2 * 8000.0 / (centers[b] / 60.0)))
            orders = [float(P[2 * h - 1:2 * h + 2].sum()) for h in range(1, no + 1)]
            ref['bands'].append(dict(rpm=float(centers[b]), state=key, L=L, heldOut=held, n=len(srcs), feat=[float(v) for v in fb], orders=orders, q=float(np.mean([c['q'] for c in srcs]))))
            ts_ = sorted(trk_t for trk_t in [round(c['t'] + c['src'].get('t0', 0), 1) for c in sel])
            summary.append(f"  {centers[b]:6.0f} rpm {key:3s}: pool {len(pools[(b, st)]):4d} good {len(good):4d} used {len(sel)} q={entry[key]['q']:.2f} lvl={20 * np.log10(lv + 1e-9):6.1f}dB held={'y' if held else 'n'} t={ts_[0]}..{ts_[-1]}")
        if entry['on'] is None and entry['off'] is None:
            summary.append(f"  {centers[b]:6.0f} rpm : no usable cycles (neighbour band is pitch-shifted at run time)")
        meta['bands'].append(entry)
    if not pcm: print(car, ': no grains found'); return
    allp = np.concatenate(pcm)
    scale = 0.89 / np.max(np.abs(allp)); meta['norm'] = float(scale)
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
    print(f"{car}: {len(i16) / SR:.1f}s of grains, {len(data) / 1e6:.2f} MB; real bands on: "
          + ' '.join(f"{e['rpm']:.0f}" for e in meta['bands'] if e['on']) + ' | off: ' + ' '.join(f"{e['rpm']:.0f}" for e in meta['bands'] if e['off']))
    if verbose: print('\n'.join(summary))

def cmd_bank(a):
    rc = json.load(open(a.recipes))
    for car in (a.cars or [k for k in rc if not k.startswith('_')]):
        build_bank(car, rc[car], a.refdir, a.outdir, a.refout, verbose=a.verbose)

if __name__ == '__main__':
    p = argparse.ArgumentParser(); sub = p.add_subparsers(dest='cmd')
    s = sub.add_parser('track'); s.add_argument('file'); s.add_argument('--cyl', type=int, default=4)
    s.add_argument('--fmin', type=float, default=20); s.add_argument('--fmax', type=float, default=500)
    s.add_argument('--t0', type=float, default=0); s.add_argument('--t1', type=float, default=None)
    s.add_argument('--every', type=float, default=0.1); s.add_argument('--halfpen', type=float, default=1.0)
    s = sub.add_parser('bank'); s.add_argument('recipes'); s.add_argument('refdir'); s.add_argument('--outdir', default='public/audio'); s.add_argument('--refout', default='tools/audio-ref'); s.add_argument('cars', nargs='*'); s.add_argument('-v', '--verbose', action='store_true')
    a = p.parse_args()
    if a.cmd == 'track': cmd_track(a)
    elif a.cmd == 'bank': cmd_bank(a)
