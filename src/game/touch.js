// Touch-screen controls. Two steering schemes, switchable on screen:
//   buttons - hold left / right on the left side of the screen
//   tilt    - hold the phone like a steering wheel (rotation about the screen normal,
//             measured from gravity, so it needs no calibration)
// Pedals (brake, throttle) are on the right in both. Writes into `input.touch`, which
// Input.read() treats like a key press (buttons) or an analogue axis (tilt).
const CSS = `
#touch { position:fixed; inset:0; z-index:3; pointer-events:none; touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; display:none; }
body.touch #touch { display:block; } body.touch.inmenu #touch { display:none; }
#touch .tb { position:absolute; pointer-events:auto; touch-action:none; display:flex; align-items:center; justify-content:center; color:#fff; font:700 15px system-ui, sans-serif;
  background:rgba(14,18,25,.42); border:2px solid rgba(255,255,255,.38); border-radius:16px; backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px); }
#touch .tb.on { background:rgba(255,209,102,.5); border-color:#ffd166; }
#touch .steer { bottom:max(18px, env(safe-area-inset-bottom)); width:min(17vw, 120px); height:min(26vh, 120px); font-size:34px; }
#touch #tL { left:max(14px, env(safe-area-inset-left)); } #touch #tR { left:calc(max(14px, env(safe-area-inset-left)) + min(17vw, 120px) + 12px); }
#touch .pedal { bottom:max(18px, env(safe-area-inset-bottom)); width:min(15vw, 104px); }
#touch #tGas { right:max(14px, env(safe-area-inset-right)); height:min(40vh, 170px); background:rgba(40,160,80,.34); }
#touch #tBrk { right:calc(max(14px, env(safe-area-inset-right)) + min(15vw, 104px) + 12px); height:min(30vh, 128px); background:rgba(200,50,40,.34); }
#touch .mini { top:max(8px, env(safe-area-inset-top)); height:34px; padding:0 11px; font-size:12px; border-radius:9px; border-width:1px; }
#touch #tBar { position:absolute; left:50%; top:max(8px, env(safe-area-inset-top)); transform:translateX(-50%); display:flex; gap:6px; }
#touch #tBar .mini { position:static; }
#touch #tTilt { position:absolute; left:50%; bottom:max(10px, env(safe-area-inset-bottom)); transform:translateX(-50%); width:150px; height:6px; border-radius:3px; background:rgba(255,255,255,.22); display:none; }
#touch #tTilt i { position:absolute; top:-4px; left:50%; width:6px; height:14px; margin-left:-3px; border-radius:3px; background:#ffd166; }
body.touch.tilt #touch .steer { display:none; } body.touch.tilt #touch #tTilt { display:block; }
body.touch #cluster { right:auto; left:50%; bottom:2px; transform:translateX(-50%) scale(.62); transform-origin:50% 100%; }
body.touch #timing { transform:scale(.8); transform-origin:0 0; } body.touch #map { transform:scale(.75); transform-origin:100% 0; top:48px; }
body.touch #keys { display:none; } body.touch #cars { max-height:46vh; }
`;

export class TouchControls {
  constructor(input, { onKey, store, toast }) {
    this.input = input; this.toast = toast; this.store = store;
    this.state = input.touch = { on: false, analog: false, steer: 0, thr: 0, brk: 0 };
    const coarse = window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
    const q = new URLSearchParams(location.search);
    if (!(coarse || q.has('touch'))) return;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
    const root = document.createElement('div'); root.id = 'touch';
    root.innerHTML = `<div class="tb steer" id="tL">◀</div><div class="tb steer" id="tR">▶</div>
      <div class="tb pedal" id="tBrk">BRAKE</div><div class="tb pedal" id="tGas">GAS</div>
      <div id="tBar"><div class="tb mini" id="tMode">Tilt</div><div class="tb mini" data-k="KeyC">Cam</div><div class="tb mini" data-k="KeyR">Reset</div><div class="tb mini" data-k="KeyH">Assist</div><div class="tb mini" data-k="Escape">Menu</div></div>
      <div id="tTilt"><i></i></div>`;
    document.body.appendChild(root); document.body.classList.add('touch');
    this.state.on = true; this.held = { L: 0, R: 0 };
    const hold = (id, set) => {
      const el = root.querySelector(id), ids = new Set();
      const upd = () => { el.classList.toggle('on', ids.size > 0); set(ids.size > 0 ? 1 : 0); };
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); ids.add(e.pointerId); try { el.setPointerCapture(e.pointerId); } catch {} upd(); });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => { ids.delete(e.pointerId); upd(); });
    };
    hold('#tL', v => { this.held.L = v; }); hold('#tR', v => { this.held.R = v; });
    hold('#tGas', v => { this.state.thr = v; }); hold('#tBrk', v => { this.state.brk = v; });
    root.querySelectorAll('[data-k]').forEach(el => el.addEventListener('pointerdown', (e) => { e.preventDefault(); onKey(el.dataset.k); }));
    this.modeBtn = root.querySelector('#tMode'); this.tiltDot = root.querySelector('#tTilt i');
    this.modeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.setMode(this.mode === 'tilt' ? 'buttons' : 'tilt', true); });
    for (const t of ['touchmove', 'gesturestart', 'contextmenu']) root.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    this.onOrient = (e) => this.orient(e);
    this.setMode('buttons');
    if (store.get('rr-touch') === 'tilt') this.wantTilt = true;   // sensor access needs a tap: offered again on first touch
    if (this.wantTilt) root.addEventListener('pointerdown', () => { if (this.wantTilt) { this.wantTilt = false; this.setMode('tilt', false); } }, { once: true });
  }

  setMode(mode, announce) {
    if (!this.state.on) return;
    if (mode === 'tilt') {
      const start = () => {
        this.gotTilt = false; window.addEventListener('deviceorientation', this.onOrient);
        clearTimeout(this.tiltCheck); this.tiltCheck = setTimeout(() => { if (!this.gotTilt && this.mode === 'tilt') { this.toast('Tilt sensor not available here — using buttons', 2.6); this.setMode('buttons'); } }, 1800);
      };
      const D = window.DeviceOrientationEvent;
      if (!D) { this.toast('This device has no tilt sensor — using buttons', 2.4); return this.setMode('buttons'); }
      if (typeof D.requestPermission === 'function') D.requestPermission().then(r => { if (r === 'granted') start(); else { this.toast('Tilt permission denied — using buttons', 2.4); this.setMode('buttons'); } }).catch(() => this.setMode('buttons'));
      else start();
    } else { window.removeEventListener('deviceorientation', this.onOrient); clearTimeout(this.tiltCheck); }
    this.mode = mode; this.state.analog = mode === 'tilt'; this.state.steer = 0;
    document.body.classList.toggle('tilt', mode === 'tilt');
    this.modeBtn.textContent = mode === 'tilt' ? 'Buttons' : 'Tilt';   // the button offers the other scheme
    this.store.set('rr-touch', mode);
    if (announce) this.toast(mode === 'tilt' ? 'Tilt steering: turn the phone like a wheel' : 'Button steering', 1.8);
  }

  // Steering angle = roll of the screen about its normal, from the direction of gravity.
  orient(e) {
    if (e.beta == null || e.gamma == null) return;
    this.gotTilt = true;
    const b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
    const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b);                 // world "up" in device axes (z = out of the screen)
    const a = ((screen.orientation?.angle ?? window.orientation ?? 0) % 360 + 360) % 360;
    // screen-up and screen-right expressed in device axes for each screen rotation
    const [sux, suy, srx, sry] = a === 90 ? [1, 0, 0, -1] : a === 270 ? [-1, 0, 0, 1] : a === 180 ? [0, -1, -1, 0] : [0, 1, 1, 0];
    const up = ux * sux + uy * suy, right = ux * srx + uy * sry, flat = Math.hypot(up, right);
    if (flat < 0.25) { this.state.steer *= 0.9; return; }                    // lying flat: roll is undefined, relax to centre
    let roll = Math.atan2(right, up) * 180 / Math.PI;                         // + = top of the screen turned to the left = steer left
    const dz = 2, lock = 32;
    roll = Math.abs(roll) < dz ? 0 : (roll - Math.sign(roll) * dz) / (lock - dz);
    this.state.steer = Math.max(-1, Math.min(1, roll));
    if (this.tiltDot) this.tiltDot.style.left = `${50 - this.state.steer * 50}%`;
  }

  // called every frame before Input.read
  update(paused) {
    if (!this.state.on) return;
    document.body.classList.toggle('inmenu', !!paused);
    if (this.mode !== 'tilt') this.state.steer = this.held.L - this.held.R;
  }
}
