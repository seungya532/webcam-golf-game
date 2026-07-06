// audio.js — Web Audio API 절차적 효과음(오디오 파일 0)
// 타격/홀인/워터 사운드를 코드로 합성한다. 브라우저 자동재생 정책상
// 첫 사용자 제스처에서 resume() 해야 소리가 난다.

export class Sfx {
  constructor() { this.ctx = null; this.enabled = true; }

  _ctx() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  resume() { this._ctx(); }
  toggle(on) { this.enabled = on; }

  // 클럽 타격음 : 짧은 피치 하강 + 노이즈 클릭. 파워 클수록 크고 높게.
  hit(power = 60) {
    const ctx = this._ctx(); if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(360 + power * 4, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 + power * 0.003, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.15);
    this._noise(0.05, 0.3, 1400, t, false);
  }

  // 홀인 : 컵에 '똑' 떨어지는 소리 + 상승 2음 차임
  hole() {
    const ctx = this._ctx(); if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    this._blip(280, 0.12, t, 0.28, 'sine');
    this._blip(660, 0.16, t + 0.11, 0.30, 'sine');
    this._blip(990, 0.32, t + 0.24, 0.30, 'sine');
  }

  // 착지 : 낮은 '툭' + 잔디 스침
  land() {
    const ctx = this._ctx(); if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    this._blip(140, 0.14, t, 0.22, 'sine');
    this._noise(0.08, 0.16, 520, t, false);
  }

  // 워터 해저드 : 첨벙(하강 필터 노이즈 + 저음)
  water() {
    const ctx = this._ctx(); if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    this._noise(0.4, 0.35, 900, t, true);
    this._blip(170, 0.22, t, 0.2, 'sine');
  }

  _blip(freq, dur, t, vol, type) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _noise(dur, vol, cutoff, t, sweep) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(280, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t); src.stop(t + dur);
  }
}
