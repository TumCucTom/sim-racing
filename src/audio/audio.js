// WebAudio glue for RaceAudioSynth. Prefers an AudioWorklet (built from the
// class source via a Blob so it survives bundling); falls back to a
// ScriptProcessor on the main thread if worklets are unavailable.
import { RaceAudioSynth, audioConfigFor } from './synth.js';
import { SURF } from '../sim/track.js';

export class AudioEngine {
  constructor() { this.ctx = null; this.node = null; this.local = null; this.volume = 0.8; this.muted = false; this.mode = 'off'; this.lastGear = 1; }

  async start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ latencyHint: 'interactive' });
    try {
      const src = `const Synth = (${RaceAudioSynth.toString()});
        class P extends AudioWorkletProcessor {
          constructor() { super(); this.s = new Synth(sampleRate);
            this.port.onmessage = (e) => { const m = e.data; if (m.cfg) this.s.configure(m.cfg); if (m.set) this.s.set(m.set); if (m.trig) this.s.trigger(m.trig, m.amount); }; }
          process(inputs, outputs) { const o = outputs[0]; this.s.process(o[0], o[1] || o[0], o[0].length); return true; }
        }
        registerProcessor('race-synth', P);`;
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'race-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      this.mode = 'worklet';
    } catch (err) {
      // fallback: run the synth on the main thread
      this.local = new RaceAudioSynth(this.ctx.sampleRate);
      const sp = this.ctx.createScriptProcessor(1024, 0, 2);
      sp.onaudioprocess = (e) => this.local.process(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1), 1024);
      sp.connect(this.ctx.destination);
      this.node = sp; this.mode = 'scriptprocessor';
    }
    if (this.cfg) this._send({ cfg: this.cfg });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  _send(m) {
    if (this.mode === 'worklet') this.node.port.postMessage(m);
    else if (this.local) { if (m.cfg) this.local.configure(m.cfg); if (m.set) this.local.set(m.set); if (m.trig) this.local.trigger(m.trig, m.amount); }
  }

  setCar(spec) { this.spec = spec; this.cfg = audioConfigFor(spec); this.peakTorque = Math.max(...spec.engine.torque.map(t => t[1])); this._send({ cfg: this.cfg }); }
  trigger(name, amount) { this._send({ trig: name, amount }); }

  // Derive synth parameters from the car state (called once per frame).
  update(car, paused) {
    if (!this.ctx || !this.spec) return;
    const spec = this.spec, t = spec.tire;
    let squeal = 0, scrub = 0, rough = 0, kerb = 0;
    for (let i = 0; i < 4; i++) {
      const sf = car.surf[i], loadF = Math.min(1.5, car.fz[i] / (spec.mass * 2.45));
      if (sf === SURF.ASPHALT || sf === SURF.KERB) {
        squeal = Math.max(squeal, Math.min(1, Math.max(0, car.slipV[i] - 1.8) / 7) * loadF);
        scrub += Math.min(1, car.slipV[i] / 4) * 0.25;
      } else rough += 0.25;
      if (sf === SURF.KERB) kerb += 0.5;
    }
    const v = car.speed;
    const load = car.limiterOn || car.shiftTimer > 0 ? 0 : Math.max(-0.3, Math.min(1, car.engineTorque / this.peakTorque));
    if (car.gear !== this.lastGear) { this.trigger('shift', spec.shiftTime < 0.1 ? 0.9 : 0.35); this.lastGear = car.gear; }
    if (car.impact > 0.8) this.trigger('impact', car.impact / 7);
    this._send({ set: {
      rpm: Math.max(spec.engine.electric ? 0 : spec.engine.idle * 0.9, car.rpm), throttle: car.limiterOn ? 0 : car.throttle, load,
      speed: v, squeal, scrub, rough: rough * Math.min(1, v / 18), kerb: Math.min(1, kerb) * (v > 3 ? 1 : 0),
      boost: car.boost, wheelRps: v / (6.2832 * spec.wheelRadius), motor: car.engineTorque / this.peakTorque,
      master: this.muted || paused ? 0 : this.volume,
    } });
  }
  toggleMute() { this.muted = !this.muted; return this.muted; }
}
