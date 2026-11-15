// WebAudio glue for RaceAudioSynth. Prefers an AudioWorklet (built from the
// class source via a Blob so it survives bundling); falls back to a
// ScriptProcessor on the main thread if worklets are unavailable.
//
// Graph:  synth -> doppler delay -> distance gain -+-> compressor -> master -> out
//                                                  +-> reverb send -> convolver -^
// The synth's engine voice plays recorded engine cycles from a per-car bank
// (audio/<car>.wav, fetched lazily); until that arrives, or if it never does,
// the synth's physical engine model is heard instead.
import { RaceAudioSynth, audioConfigFor, parseBank } from './synth.js';
import { SURF } from '../sim/track.js';

const SOUND_SPEED = 343;

export class AudioEngine {
  constructor() {
    this.ctx = null; this.node = null; this.local = null; this.volume = 0.8; this.muted = false; this.mode = 'off'; this.lastGear = 1;
    this.voice = 'synth';           // 'samples' once a recorded bank is playing for the current car
    this.banks = new Map();         // bank name -> Promise<{meta, pcm} | null>
    this.bankBase = 'audio/';
    this.lastCam = ''; this.hold = null;
  }

  async start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ latencyHint: 'interactive' });
    try {
      const src = `const Synth = (${RaceAudioSynth.toString()});
        class P extends AudioWorkletProcessor {
          constructor() { super(); this.s = new Synth(sampleRate);
            this.port.onmessage = (e) => { const m = e.data; if (m.cfg) this.s.configure(m.cfg); if (m.bank) this.port.postMessage({ bank: this.s.setBank(m.bank, m.pcm) ? m.bank.car : '' }); if (m.set) this.s.set(m.set); if (m.trig) this.s.trigger(m.trig, m.amount); }; }
          process(inputs, outputs) { const o = outputs[0]; this.s.process(o[0], o[1] || o[0], o[0].length); return true; }
        }
        registerProcessor('race-synth', P);`;
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'race-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.port.onmessage = (e) => { if (e.data && 'bank' in e.data) this.voice = e.data.bank && this.cfg && e.data.bank === this.cfg.id ? 'samples' : 'synth'; };
      this.mode = 'worklet';
    } catch (err) {
      // fallback: run the synth on the main thread
      this.local = new RaceAudioSynth(this.ctx.sampleRate);
      const sp = this.ctx.createScriptProcessor(1024, 0, 2);
      sp.onaudioprocess = (e) => this.local.process(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1), 1024);
      this.node = sp; this.mode = 'scriptprocessor';
    }
    this._buildBus();
    if (this.cfg) { this._send({ cfg: this.cfg }); this._loadBank(this.cfg); }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // master bus: Doppler/distance for the trackside camera, a short reverb of
  // barriers and grandstands, then a compressor so nothing clips or drowns.
  _buildBus() {
    const c = this.ctx;
    try {
      this.delay = c.createDelay(2.0);
      this.dist = c.createGain();
      this.send = c.createGain(); this.send.gain.value = 0.1;
      this.verb = c.createConvolver(); this.verb.buffer = this._impulse();
      this.comp = c.createDynamicsCompressor();
      this.comp.threshold.value = -16; this.comp.knee.value = 10; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.18;
      this.out = c.createGain(); this.out.gain.value = 1.0;
      this.node.connect(this.delay); this.delay.connect(this.dist);
      this.dist.connect(this.comp); this.dist.connect(this.send); this.send.connect(this.verb); this.verb.connect(this.comp);
      this.comp.connect(this.out); this.out.connect(c.destination);
    } catch (err) {
      this.delay = null; this.out = this.node;
      try { this.node.disconnect(); } catch (e) { /* not connected yet */ }
      this.node.connect(c.destination);
    }
  }

  // Algorithmic impulse response (generated, so no asset or licence needed):
  // a few discrete early reflections (pit wall, barriers) and a short diffuse tail.
  _impulse() {
    const sr = this.ctx.sampleRate, n = Math.round(sr * 0.9), buf = this.ctx.createBuffer(2, n, sr);
    let seed = 1234567; const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const taps = [[0.021, 0.5, -0.6], [0.034, 0.42, 0.7], [0.052, 0.3, -0.2], [0.071, 0.26, 0.4], [0.097, 0.2, -0.8], [0.131, 0.15, 0.9]];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, env = t < 0.04 ? 0 : Math.exp(-(t - 0.04) / 0.19) * 0.16;
        lp += ((rnd() * 2 - 1) - lp) * 0.35;                       // air and distance take the top off
        d[i] = lp * env;
      }
      for (const [t, g, pan] of taps) { const i = Math.round(t * sr), a = g * (ch ? 0.5 + 0.5 * pan : 0.5 - 0.5 * pan); d[i] += a; d[i + 1] += a * 0.5; }
    }
    return buf;
  }

  _send(m, transfer) {
    if (this.mode === 'worklet') this.node.port.postMessage(m, transfer || []);
    else if (this.local) {
      if (m.cfg) this.local.configure(m.cfg);
      if (m.bank) this.voice = this.local.setBank(m.bank, m.pcm) ? 'samples' : 'synth';
      if (m.set) this.local.set(m.set); if (m.trig) this.local.trigger(m.trig, m.amount);
    }
  }

  // Fetch + parse the recorded-cycle bank for this car (cached). Any failure
  // resolves to null and the synth simply keeps its physical engine model.
  _fetchBank(name) {
    if (!this.banks.has(name)) {
      const url = this.bankBase + name + '.wav', inline = globalThis.__INLINE_ASSETS && globalThis.__INLINE_ASSETS[url];
      // hosted single-file builds may embed the bank as base64 (same convention as src/game/assets.js)
      const load = inline
        ? Promise.resolve().then(() => { const bin = atob(inline.replace(/^data:[^,]*,/, '')), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8.buffer; })
        : fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      this.banks.set(name, load.then(buf => parseBank(buf)).catch(() => null));
    }
    return this.banks.get(name);
  }

  _loadBank(cfg) {
    this.voice = 'synth';
    if (!cfg.bankName || !this.ctx) return;
    this._fetchBank(cfg.bankName).then(bank => {
      if (!bank || this.cfg !== cfg) return;                      // failed, or the car changed meanwhile
      const meta = Object.assign({}, bank.meta, { car: cfg.id });
      const pcm = bank.pcm.slice();                               // keep the cached copy; transfer this one
      this._send({ bank: meta, pcm }, [pcm.buffer]);
    });
  }

  setCar(spec) {
    this.spec = spec; this.cfg = audioConfigFor(spec);
    this.peakTorque = Math.max(1, ...spec.engine.torque.map(t => t[1]));
    this._send({ cfg: this.cfg }); this._loadBank(this.cfg);
  }
  trigger(name, amount) { this._send({ trig: name, amount }); }

  // Derive synth parameters from the car state (called once per frame).
  // cam: 'chase' | 'far' | 'bonnet' | 'tv'; camDist: metres from camera to car.
  update(car, paused, cam, camDist) {
    if (!this.ctx || !this.spec) return;
    const spec = this.spec;
    let squeal = 0, scrub = 0, grass = 0, gravel = 0, kerb = 0;
    for (let i = 0; i < 4; i++) {
      const sf = car.surf[i], loadF = Math.min(1.5, car.fz[i] / (spec.mass * 2.45));
      if (sf === SURF.ASPHALT || sf === SURF.KERB) {
        squeal = Math.max(squeal, Math.min(1, Math.max(0, car.slipV[i] - 1.8) / 7) * loadF);
        scrub += Math.min(1, car.slipV[i] / 4) * 0.25 * loadF;
      } else if (sf === SURF.GRAVEL) gravel += 0.25; else grass += 0.25;
      if (sf === SURF.KERB) kerb += 0.5;
    }
    const v = car.speed, vf = Math.min(1, v / 18);
    const tq = (car.engineTorque || 0) / this.peakTorque;      // engineTorque is undefined before the first sim step
    const load = car.limiterOn || car.shiftTimer > 0 ? 0 : Math.max(-0.3, Math.min(1, tq));
    if (car.gear !== this.lastGear) { this.trigger('shift', spec.shiftTime < 0.1 ? 0.9 : 0.35); this.lastGear = car.gear; }
    if (car.impact > 0.8) this.trigger('impact', car.impact / 7);
    const tv = cam === 'tv', cockpit = cam === 'bonnet';
    const set = {
      rpm: Math.max(spec.engine.electric ? 0 : spec.engine.idle * 0.9, car.rpm), throttle: car.limiterOn ? 0 : car.throttle, load,
      speed: v, squeal, scrub, grass: grass * vf, gravel: gravel * vf, kerb: Math.min(1, kerb) * (v > 3 ? 1 : 0),
      brake: (car.brake || 0) * (v > 2 ? 1 : 0),
      boost: car.boost, wheelRps: v / (6.2832 * spec.wheelRadius), motor: tq,
      cockpit: cockpit ? 1 : 0, tv: tv ? 1 : 0,
      master: this.muted || paused ? 0 : this.volume,
    };
    if (this.hold) Object.assign(set, this.hold);                // test hook (tools/audio-page-check.mjs): pin parameters
    this._send({ set });
    // camera-dependent bus: a moving delay gives the trackside camera its Doppler shift
    if (this.delay) {
      const now = this.ctx.currentTime, d = tv && camDist > 0 ? Math.min(600, camDist) : 0;
      if (cam !== this.lastCam) {      // camera cut: jump, do not glide (a glide would be a pitch sweep)
        this.delay.delayTime.cancelScheduledValues(now); this.delay.delayTime.setValueAtTime(d / SOUND_SPEED, now);
        this.lastCam = cam;
      } else this.delay.delayTime.setTargetAtTime(d / SOUND_SPEED, now, 0.05);
      this.dist.gain.setTargetAtTime(tv ? Math.max(0.12, Math.min(1, 14 / (d + 6))) : 1, now, 0.05);
      this.send.gain.setTargetAtTime(tv ? 0.3 : cockpit ? 0.03 : cam === 'far' ? 0.16 : 0.1, now, 0.1);
    }
  }
  toggleMute() { this.muted = !this.muted; return this.muted; }
}
