// 효과음·배경음: Web Audio 로 직접 합성 (음원 파일·저작권 걱정 없음)
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

export class Sound {
  constructor() {
    this.ctx = null; this.master = null; this.sfxOn = true; this.bgmOn = true;
    this.bgmTimer = null; this.bgmStep = 0; this.bgmNext = 0; this.bgmRoot = 60; this.tempo = 112;
  }

  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(this.ctx.destination);
        this.bgmGain = this.ctx.createGain(); this.bgmGain.gain.value = 0.11; this.bgmGain.connect(this.master);
        const len = this.ctx.sampleRate * 0.6;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* 소리 없이 진행 */ }
  }

  tone(freq, dur = 0.15, { type = 'sine', vol = 0.25, when = 0, slide = null, dest = null } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  sfx(fn) { if (this.sfxOn && this.ctx) { try { fn(); } catch { /* noop */ } } }

  catch(combo = 0) {
    this.sfx(() => {
      const base = 660 * Math.pow(2, Math.min(combo, 12) / 12);
      this.tone(base, 0.12, { type: 'triangle', vol: 0.28, slide: base * 1.5 });
      this.tone(base * 2, 0.18, { type: 'sine', vol: 0.12, when: 0.05 });
    });
  }
  boom() {
    this.sfx(() => {
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource(); src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(120, t + 0.5);
      const g = this.ctx.createGain(); g.gain.value = 0.7;
      src.connect(f); f.connect(g); g.connect(this.master); src.start(t);
      this.tone(140, 0.35, { type: 'sine', vol: 0.5, slide: 45 });
    });
  }
  miss() { this.sfx(() => this.tone(330, 0.16, { type: 'triangle', vol: 0.12, slide: 220 })); }
  missHeart() { this.sfx(() => [392, 330, 262].forEach((f, i) => this.tone(f, 0.14, { type: 'square', vol: 0.1, when: i * 0.09 }))); }
  heart() { this.sfx(() => [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, { type: 'triangle', vol: 0.2, when: i * 0.07 }))); }
  beep(hi = false) { this.sfx(() => this.tone(hi ? 880 : 523, hi ? 0.35 : 0.18, { type: 'square', vol: 0.12 })); }
  tick() { this.sfx(() => this.tone(1200, 0.04, { type: 'sine', vol: 0.06 })); }
  levelUp() { this.sfx(() => [392, 523, 659].forEach((f, i) => this.tone(f, 0.14, { type: 'square', vol: 0.09, when: i * 0.08 }))); }
  over() { this.sfx(() => [523, 440, 349, 262].forEach((f, i) => this.tone(f, 0.28, { type: 'triangle', vol: 0.22, when: i * 0.18 }))); }
  // ── 승부차기 소리 ──
  whistle() { this.sfx(() => { this.tone(2100, 0.18, { type: 'square', vol: 0.07 }); this.tone(2300, 0.42, { type: 'square', vol: 0.07, when: 0.22 }); }); }
  select() { this.sfx(() => [659, 988].forEach((f, i) => this.tone(f, 0.12, { type: 'triangle', vol: 0.2, when: i * 0.06 }))); }
  kick(power = 0.5) {
    this.sfx(() => {
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource(); src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(900 + power * 1400, t); f.frequency.exponentialRampToValueAtTime(100, t + 0.18);
      const g = this.ctx.createGain(); g.gain.value = 0.5 + power * 0.3;
      src.connect(f); f.connect(g); g.connect(this.master); src.start(t); src.stop(t + 0.25);
      this.tone(160 + power * 60, 0.16, { type: 'sine', vol: 0.5, slide: 60 });
    });
  }
  cheer(dur = 1.4, vol = 0.22) {
    this.sfx(() => {
      const t = this.ctx.currentTime, n = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) { const k = i / n; d[i] = (Math.random() * 2 - 1) * Math.min(1, k * 8) * (1 - k); }
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 0.6;
      const g = this.ctx.createGain(); g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(this.master); src.start(t);
    });
  }
  goal() { this.cheer(1.8, 0.3); this.sfx(() => [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.2, { type: 'triangle', vol: 0.22, when: 0.05 + i * 0.09 }))); }
  save() { this.sfx(() => { this.tone(220, 0.12, { type: 'sine', vol: 0.4, slide: 90 }); [494, 440, 392].forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', vol: 0.14, when: 0.15 + i * 0.13 })); }); this.cheer(0.9, 0.12); }
  sky() { this.sfx(() => this.tone(500, 0.6, { type: 'sine', vol: 0.18, slide: 1400 })); }

  fanfare() { this.sfx(() => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.18, { type: 'triangle', vol: 0.2, when: i * 0.1 }))); }

  // 아주 단순한 반복 멜로디 (스테이지마다 조가 다름)
  startBgm(keyOffset = 0, tempo = 112) {
    this.stopBgm();
    if (!this.ctx || !this.bgmOn) return;
    this.bgmRoot = 60 + (keyOffset % 12) - (keyOffset > 6 ? 12 : 0);
    this.tempo = tempo; this.bgmStep = 0; this.bgmNext = this.ctx.currentTime + 0.1;
    const melody = [0, 2, 4, 2, 5, 4, 2, null, 3, 4, 5, 7, 6, 4, 2, null, 0, 2, 4, 5, 7, 5, 4, 2, 3, 2, 1, 2, 0, null, null, null];
    const bass = [0, null, 7, null, 5, null, 7, null];
    const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    this.bgmTimer = setInterval(() => {
      if (!this.ctx) return;
      const stepDur = 60 / this.tempo / 2;
      while (this.bgmNext < this.ctx.currentTime + 0.25) {
        const i = this.bgmStep % melody.length, m = melody[i];
        const when = this.bgmNext - this.ctx.currentTime;
        if (m != null) this.tone(midi(this.bgmRoot + 12 + PENTA[m % PENTA.length]), stepDur * 0.9, { type: 'triangle', vol: 0.5, when, dest: this.bgmGain });
        const b = bass[i % bass.length];
        if (b != null) this.tone(midi(this.bgmRoot - 12 + b), stepDur * 1.6, { type: 'sine', vol: 0.6, when, dest: this.bgmGain });
        this.bgmNext += stepDur; this.bgmStep++;
      }
    }, 80);
  }
  setTempo(t) { this.tempo = t; }
  stopBgm() { if (this.bgmTimer) clearInterval(this.bgmTimer); this.bgmTimer = null; }
}
