// Tiny synthesised sound kit (Web Audio, no samples).
let ctx = null, master = null, dest = null, muted = localStorage.getItem('leapshot:muted') === '1';

export function audioInit() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  master = ctx.createGain(); master.gain.value = muted ? 0 : 0.8;
  master.connect(comp); comp.connect(ctx.destination);
  dest = ctx.createMediaStreamDestination(); comp.connect(dest);
}
export function audioStream() { return dest ? dest.stream : null; }
export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m; localStorage.setItem('leapshot:muted', m ? '1' : '0');
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.02);
}

function tone({ type = 'sine', f0, f1 = f0, t = 0.12, v = 0.2, at = 0, attack = 0.004, pan = 0 }) {
  if (!ctx) return;
  const now = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, now);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + t);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(v, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + t);
  let node = g;
  if (ctx.createStereoPanner && pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
  o.connect(g); node.connect(master);
  o.start(now); o.stop(now + t + 0.05);
}
let noiseBuf = null;
function noise({ t = 0.1, v = 0.2, f = 1200, q = 0.8, at = 0, type = 'lowpass' }) {
  if (!ctx) return;
  if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const now = ctx.currentTime + at;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
  const g = ctx.createGain(); g.gain.setValueAtTime(v, now); g.gain.exponentialRampToValueAtTime(0.0001, now + t);
  s.connect(fl); fl.connect(g); g.connect(master); s.start(now); s.stop(now + t + 0.02);
}

const semi = n => Math.pow(2, n / 12);
export const sfx = {
  jump() { tone({ type: 'square', f0: 220, f1: 520, t: 0.13, v: 0.07 }); tone({ type: 'sine', f0: 440, f1: 880, t: 0.1, v: 0.08 }); },
  land(p = 1) { noise({ t: 0.07, v: 0.12 * p, f: 700 }); tone({ type: 'sine', f0: 140, f1: 70, t: 0.08, v: 0.1 * p }); },
  step() { noise({ t: 0.025, v: 0.035, f: 2400, type: 'bandpass', q: 2 }); },
  coin(combo = 0) {
    const k = semi(Math.min(combo, 12));
    tone({ type: 'triangle', f0: 988 * k, t: 0.07, v: 0.16 });
    tone({ type: 'triangle', f0: 1319 * k, t: 0.22, v: 0.16, at: 0.06 });
    tone({ type: 'sine', f0: 2637 * k, t: 0.18, v: 0.05, at: 0.06 });
    tone({ type: 'sine', f0: 1319 * k, t: 0.2, v: 0.04, at: 0.2, pan: 0.4 });
  },
  die() { tone({ type: 'sawtooth', f0: 420, f1: 50, t: 0.45, v: 0.12 }); noise({ t: 0.3, v: 0.22, f: 900 }); tone({ type: 'square', f0: 90, f1: 40, t: 0.3, v: 0.08 }); },
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => { tone({ type: 'triangle', f0: f, t: 0.35, v: 0.13, at: i * 0.08 }); tone({ type: 'sine', f0: f * 2, t: 0.3, v: 0.04, at: i * 0.08 + 0.02 }); });
    [1047, 1319, 1568].forEach(f => tone({ type: 'sine', f0: f, t: 1.2, v: 0.07, at: 0.45, attack: 0.02 }));
    noise({ t: 0.6, v: 0.05, f: 6000, type: 'highpass', at: 0.4 });
  },
  click() { tone({ type: 'sine', f0: 880, f1: 1200, t: 0.05, v: 0.05 }); },
  whoosh() { noise({ t: 0.5, v: 0.1, f: 1800, type: 'bandpass', q: 0.6 }); tone({ type: 'sine', f0: 200, f1: 900, t: 0.45, v: 0.05 }); },
  paint() { tone({ type: 'sine', f0: 600 + Math.random() * 200, t: 0.03, v: 0.025 }); },
};
