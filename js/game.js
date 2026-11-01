// 게임 엔진: 경기장·골대·키퍼 그리기, 조준(손) → 슛(발) → 키퍼 → 결과, 점수·HUD
import { CONFIG, RULES, DIFFICULTY, KICK } from './config.js';
import { TAU, clamp, lerp, rand, choice, easeOutBack, easeOutCubic, formatNum } from './util.js';
import { KickDetector, heightOf, HEIGHT_LABEL } from './kick.js';

const FONT = 'system-ui, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
const INK = '#2b2140';
export const DIRS = ['left', 'center', 'right'];
export const DIR_LABEL = { left: '왼쪽', center: '가운데', right: '오른쪽' };
const DIR_COLOR = { left: '#ff6b6b', center: '#ffd93d', right: '#4d96ff' };
const CONFETTI = ['#ffd93d', '#ff6b6b', '#4d96ff', '#6bcb77', '#9b5de5', '#ffffff'];

// 경기장 배치 (1280×720 기준). 골대는 멀리 있어서 화면 위쪽에 작게
const GOAL = { x0: 400, x1: 880, top: 92, bottom: 292 };
const GW = GOAL.x1 - GOAL.x0, GH = GOAL.bottom - GOAL.top;
const KEEPER_STAND_Y = GOAL.bottom - 60; // 키퍼 몸통 가운데 (서 있을 때)
const BALL_R0 = 38, BALL_R1 = 15;        // 공 크기: 발 앞 → 골대

const segDist2 = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = clamp(t, 0, 1);
  const x = ax + dx * t - px, y = ay + dy * t - py; return x * x + y * y;
};

export class Engine {
  constructor(canvas, sound) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.W = CONFIG.W; this.H = CONFIG.H;
    this.sound = sound;
    this.input = null; this.difficulty = 'normal'; this.state = 'title';
    this.parts = []; this.texts = []; this.rings = [];
    this.retryTarget = null; this.retryProg = 0;
    this.cb = {}; this.debug = false;
    this.bg = buildStadium(this.W, this.H);
    this.kicker = new KickDetector(KICK.normal, KICK);
    this.kicker.onKick = (ev) => this._onCameraKick(ev);
    this.keeper = { x: 640, y: KEEPER_STAND_Y, rot: 0, gl: null, gr: null, dive: null };
    this.ballPos = { x: 640, y: 640 };
    this._clock = 0;
    window.addEventListener('keydown', (e) => this._onKey(e));
    this._last = performance.now();
    this.reset();
    this._raf = requestAnimationFrame(this._frame);
  }

  on(name, fn) { this.cb[name] = fn; }
  emit(name, ...a) { try { this.cb[name]?.(...a); } catch (e) { console.error(e); } }

  reset() {
    this.parts.length = 0; this.texts.length = 0; this.rings.length = 0;
    this.results = []; this.points = 0; this.streak = 0; this.bestStreak = 0; this.corners = 0; this.maxSpeed = 0;
    this.shotIdx = 0; this.phase = 'aim'; this.phaseT = 0; this.aim = null; this.aimProg = { left: 0, center: 0, right: 0 };
    this.ball = null; this.shot = null; this.lastKick = null; this.netHit = null;
    this.banner = null; this.countT = 0; this.startProg = 0; this.retryProg = 0; this.shake = 0;
    this.absentMs = 0; this.absent = false; this.backMs = 0; this.demoIn = 1.2;
    this.keeper.dive = null;
    this.kicker.arm(false); this.kicker.reset();
  }

  get diff() { return DIFFICULTY[this.difficulty] || DIFFICULTY.normal; }
  get goals() { return this.results.filter((r) => r === 'goal').length; }
  setDifficulty(d) { this.difficulty = DIFFICULTY[d] ? d : 'normal'; this.kicker.setConfig(KICK[this.difficulty]); }

  setInput(input) {
    if (this.input && this.input !== input) this.input.destroy?.();
    if (this.input) { this.input.onPose = null; this.input.onRelease = null; }
    this.input = input;
    if (input?.kind === 'camera') input.onPose = (bodies, t) => this.kicker.push(bodies, t);
    if (input?.kind === 'touch') input.onRelease = (r) => this._onSwipe(r);
  }
  resize() { /* 16:9 고정 */ }

  // ── 카메라 속 사람 → 화면 좌표 (사람은 조금 줄여서 화면 아래쪽에 그림) ──
  get personRect() {
    const s = this.input?.kind === 'camera' ? CONFIG.PERSON_SCALE : 1;
    const w = this.W * s, h = this.H * s;
    return { x: (this.W - w) / 2, y: this.H - h, w, h, s };
  }
  toScreen(x, y) { const R = this.personRect; return { x: R.x + x * R.s, y: R.y + y * R.s }; }
  // 화면 위 동그라미(x, y, r)에 손이 닿았나 (폰 모드는 손가락)
  handHit(x, y, r) {
    const inp = this.input; if (!inp) return false;
    if (inp.kind !== 'camera') return inp.hitTest(x, y, r);
    const R = this.personRect;
    return inp.hitTest((x - R.x) / R.s, (y - R.y) / R.s, r / R.s, 2);
  }

  showTitle() { this.reset(); this.state = 'title'; }
  enterLobby() { this.reset(); this.state = 'lobby'; this.emit('state', 'lobby'); }
  startCountdown() {
    if (this.state !== 'lobby') return;
    this.reset(); this.state = 'countdown'; this.countT = 3.999; this._lastBeep = 4;
    this.emit('countdown'); this.emit('state', 'countdown');
  }
  pause() { if (this.state === 'play') { this.state = 'paused'; this.kicker.arm(false); this.emit('state', 'paused'); } }
  resume() {
    if (this.state !== 'paused') return;
    this.state = 'play'; this._last = performance.now();
    if (this.phase === 'kick' && this.input?.kind === 'camera') this.kicker.arm(true);
    this.emit('state', 'play');
  }

  lobbyBubble() { return { x: this.W / 2, y: 300, r: 84 }; }
  balloons() {
    return [
      { dir: 'left', x: 420, y: 345, r: 64 },
      { dir: 'center', x: 640, y: 250, r: 64 },
      { dir: 'right', x: 860, y: 345, r: 64 },
    ];
  }
  zoneRect(dir) { const i = DIRS.indexOf(dir); return { x: GOAL.x0 + GW / 3 * i, y: GOAL.top, w: GW / 3, h: GH }; }

  // ── 메인 루프 ──
  _frame = (now) => {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    if (dt > 0) this._fpsEma = this._fpsEma ? this._fpsEma * 0.95 + (1 / dt) * 0.05 : 1 / dt;
    try { this.update(dt, now); this.render(now); } catch (e) { console.error(e); }
    this._raf = requestAnimationFrame(this._frame);
  };

  update(dt, now) {
    this._clock += dt;
    this._updateFx(dt);
    this._updateBallRest(dt);
    this._updateKeeper(dt);
    const inp = this.input;
    switch (this.state) {
      case 'title': this._updateDemo(dt); break;
      case 'lobby': {
        const B = this.lobbyBubble();
        const hit = this.handHit(B.x, B.y, B.r * 0.85);
        const prev = this.startProg;
        this.startProg = clamp(this.startProg + (hit ? dt / 0.9 : -dt / 0.6), 0, 1);
        if (hit && Math.floor(this.startProg * 6) !== Math.floor(prev * 6)) this.sound.tick();
        if (this.startProg >= 1) { this.sound.beep(true); this._burst(B.x, B.y, 24); this.startCountdown(); }
        break;
      }
      case 'countdown': {
        this.countT -= dt;
        const n = Math.ceil(this.countT);
        if (n !== this._lastBeep && n > 0) { this._lastBeep = n; this.sound.beep(false); }
        if (this.countT <= 0) {
          this.state = 'play'; this.sound.whistle();
          this._startAim();
          this.emit('state', 'play');
        }
        break;
      }
      case 'play': this._updatePlay(dt, now); break;
      case 'over': {
        const T = this.retryTarget;
        if (T && inp?.kind === 'camera') {
          const hit = this.handHit(T.x, T.y, T.r * 0.85);
          this.retryProg = clamp(this.retryProg + (hit ? dt / 1.1 : -dt / 0.6), 0, 1);
          this.emit('retryProgress', this.retryProg);
          if (this.retryProg >= 1) { this.retryProg = 0; this.retryTarget = null; this.emit('retry'); }
        }
        break;
      }
      default: break;
    }
    if (this.banner) { this.banner.t += dt; if (this.banner.t > this.banner.max) this.banner = null; }
  }

  _updatePlay(dt, now) {
    const inp = this.input;
    // 화면에 사람이 없으면 잠시 멈춤 (조준·슛 차례에만)
    if (inp?.kind === 'camera' && (this.phase === 'aim' || this.phase === 'kick')) {
      if (!inp.present) { this.absentMs += dt * 1000; this.backMs = 0; }
      else { this.backMs += dt * 1000; if (this.backMs > 600) this.absentMs = 0; }
      if (!this.absent && this.absentMs > RULES.ABSENT_PAUSE_MS) { this.absent = true; this.kicker.arm(false); }
      if (this.absent && this.backMs > 800) { this.absent = false; this.absentMs = 0; if (this.phase === 'kick') this.kicker.arm(true); }
      if (this.absent) return;
    }
    this.phaseT += dt;
    this.kicker.tick(now);
    switch (this.phase) {
      case 'aim': {
        for (const b of this.balloons()) {
          const hit = this.handHit(b.x, b.y, b.r * 0.85);
          const prev = this.aimProg[b.dir];
          this.aimProg[b.dir] = clamp(prev + (hit ? dt / RULES.AIM_HOLD_SEC : -dt / 0.5), 0, 1);
          if (hit && Math.floor(this.aimProg[b.dir] * 4) !== Math.floor(prev * 4)) this.sound.tick();
          if (this.aimProg[b.dir] >= 1) { this.chooseAim(b.dir); break; }
        }
        break;
      }
      case 'kick': break; // 발차기는 인식 결과가 올 때 (KickDetector → _onCameraKick)
      case 'fly': this._updateFlight(dt); break;
      case 'result':
        this._updateFlight(dt);
        if (this.phaseT >= RULES.RESULT_SEC) this._nextShot();
        break;
      default: break;
    }
  }

  // ── 차례 진행 ──
  _startAim() {
    this.phase = 'aim'; this.phaseT = 0; this.aim = null; this.aimProg = { left: 0, center: 0, right: 0 };
    this.ball = null; this.shot = null; this.netHit = null; this.keeper.dive = null;
    this.kicker.arm(false);
    const nth = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'][this.shotIdx] || `${this.shotIdx + 1}`;
    this.banner = { text: `${nth} 번째 슛!`, sub: this.shotIdx === RULES.SHOTS - 1 ? '마지막 슛이에요' : null, t: 0, max: 1.2 };
  }

  chooseAim(dir) {
    if (this.state !== 'play' || this.phase !== 'aim' || !DIRS.includes(dir)) return;
    this.aim = dir; this.phase = 'kick'; this.phaseT = 0; this.banner = null;
    this.sound.select();
    const b = this.balloons().find((x) => x.dir === dir);
    this._burst(b.x, b.y, 16, [DIR_COLOR[dir], '#ffffff']);
    if (this.input?.kind === 'camera') { this.kicker.reset(); this.kicker.arm(true); }
  }

  _onCameraKick(ev) {
    if (this.state !== 'play' || this.phase !== 'kick') return;
    this.shoot(ev.power, { over: ev.over, speed: ev.speed, lift: ev.lift });
  }

  // 폰 모드: 풍선을 톡 눌러 방향 → 공을 위로 휙 밀면 슛 (밀어 올린 속도 = 세기, 그냥 톡 누르면 땅볼)
  _onSwipe(r) {
    if (this.state !== 'play') return;
    if (this.phase === 'aim') {
      const b = this.balloons().find((q) => Math.hypot(r.x - q.x, r.y - q.y) < q.r + 24 || Math.hypot(r.x0 - q.x, r.y0 - q.y) < q.r + 24);
      if (b) this.chooseAim(b.dir);
      return;
    }
    if (this.phase !== 'kick') return;
    const B = this.ballPos;
    if (Math.hypot(r.x0 - B.x, r.y0 - B.y) > 170) return;
    if (r.vy > -250) { if (Math.hypot(r.x - r.x0, r.y - r.y0) < 30) this.shoot(0.2, { speed: 0 }); return; }
    const sp = -r.vy / this.H; // 화면 높이/초
    const k = this.difficulty === 'baby' ? { low: 0.6, high: 3.0, over: Infinity } : { low: 0.9, high: 4.2, over: 6.2 };
    this.shoot(clamp((sp - k.low) / (k.high - k.low), 0, 1), { over: sp >= k.over, speed: sp });
  }

  // 키보드 (PC에서 해보기·테스트용): ← ↑ → 로 방향, 1 2 3 = 약·중·강, 4 = 너무 세게
  _onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.state !== 'play') return;
    const aimKeys = { ArrowLeft: 'left', ArrowUp: 'center', ArrowRight: 'right', a: 'left', w: 'center', d: 'right' };
    const powKeys = { 1: 0.12, 2: 0.5, 3: 0.92, 4: 1, ' ': 0.5 };
    if (this.phase === 'aim' && aimKeys[e.key]) { e.preventDefault(); this.chooseAim(aimKeys[e.key]); }
    else if (this.phase === 'kick' && e.key in powKeys) { e.preventDefault(); this.shoot(powKeys[e.key], { over: e.key === '4' }); }
  }

  // ── 슛: 높이·키퍼 방향·결과를 정하고 공을 날림 ──
  shoot(power, { over = false, speed = null, lift = null, demo = false, dir = null } = {}) {
    if (!demo && (this.state !== 'play' || this.phase !== 'kick')) return;
    const aim = dir || this.aim;
    const d = this.diff;
    power = clamp(power, 0, 1);
    const height = heightOf(power);
    over = over && d.overBar;
    // 키퍼가 뛸 방향: 정해진 확률로 같은 방향, 아니면 나머지 둘 중 하나
    const others = DIRS.filter((x) => x !== aim);
    const keeperDir = Math.random() < d.sameDir ? aim : choice(others);
    let outcome = 'goal';
    if (over) outcome = 'over';
    else if (keeperDir === aim && Math.random() < d.reach[height]) outcome = 'save';

    // 골대 안 목표 지점
    const zx = { left: GOAL.x0 + GW * 0.16, center: GOAL.x0 + GW * 0.5, right: GOAL.x0 + GW * 0.84 }[aim];
    let tx = zx + rand(-18, 18), ty = GOAL.bottom - BALL_R1 - 4 - power * (GH - BALL_R1 * 2 - 18);
    if (height === 'high' && aim !== 'center') tx += aim === 'left' ? -12 : 12; // 위쪽 구석은 더 구석으로
    if (over) { ty = GOAL.top - 70; tx = zx + rand(-30, 30); }
    const B = this.ballPos;
    const T = over ? 0.62 : lerp(0.92, 0.55, power);
    this.ball = {
      x0: B.x, y0: B.y, tx, ty, cx: (B.x + tx) / 2, cy: Math.min(B.y, ty) - lerp(10, 90, power) - (over ? 60 : 0),
      t: 0, T, x: B.x, y: B.y, r: BALL_R0, rot: 0, done: false, inNet: false, vx: 0, vy: 0, over,
    };
    this.shot = { aim, power, height, keeperDir, outcome, speed, lift, demo };
    this._planKeeper(keeperDir, outcome, tx, ty, height);
    if (!demo) {
      this.phase = 'fly'; this.phaseT = 0; this.kicker.arm(false);
      this.lastKick = { power, height, speed, over };
      if (speed != null && this.input?.kind === 'camera') this.maxSpeed = Math.max(this.maxSpeed, speed);
    }
    if (!demo) this.sound.kick(power);
    this._burst(B.x, B.y + 20, 8, ['#ffffff', '#c9f2a0']);
  }

  _updateFlight(dt) {
    const b = this.ball; if (!b) return;
    b.rot += dt * (b.done ? 3 : 14);
    if (!b.done) {
      b.t += dt;
      const u = clamp(b.t / b.T, 0, 1), iu = 1 - u;
      b.x = iu * iu * b.x0 + 2 * iu * u * b.cx + u * u * b.tx;
      b.y = iu * iu * b.y0 + 2 * iu * u * b.cy + u * u * b.ty;
      b.r = lerp(BALL_R0, BALL_R1, Math.pow(u, 0.75));
      if (u >= 1) this._arrive();
    } else {
      b.vy += (b.inNet ? 300 : 900) * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.inNet) {
        const floor = GOAL.bottom - b.r - 2;
        if (b.y > floor) { b.y = floor; b.vy = -b.vy * 0.25; b.vx *= 0.6; }
        b.x = clamp(b.x, GOAL.x0 + b.r + 8, GOAL.x1 - b.r - 8);
      } else if (b.over) b.r = Math.max(6, b.r - dt * 10);
    }
  }

  _arrive() {
    const b = this.ball, s = this.shot;
    b.done = true;
    if (s.outcome === 'goal') {
      b.inNet = true; b.vx = (b.tx - 640) * 0.15; b.vy = 40;
      this.netHit = { x: b.x, y: b.y, t: this._clock };
      if (!s.demo) {
        this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak);
        const corner = s.height === 'high' && s.aim !== 'center';
        if (corner) this.corners++;
        const pts = RULES.GOAL_POINTS + (corner ? RULES.CORNER_BONUS : 0) + (this.streak >= 2 ? (this.streak - 1) * RULES.STREAK_BONUS : 0);
        this.points += pts;
        this.texts.push({ text: `+${pts}`, x: b.x, y: b.y - 30, life: 0, max: 1.4, color: '#ffd93d' });
        const sub = corner ? '구석 슛! 보너스 +50' : this.streak >= 2 ? `${this.streak}연속 골!` : null;
        this.banner = { text: '골~~~!', sub, t: 0, max: 1.8 };
        this.shake = 0.25;
      }
      if (!s.demo) this.sound.goal();
      this._burst(b.x, b.y, s.demo ? 14 : 46);
    } else if (s.outcome === 'save') {
      b.vx = (b.x < 640 ? -1 : 1) * rand(260, 420) * (s.aim === 'center' ? (Math.random() < 0.5 ? -1 : 1) : 1); b.vy = -rand(260, 380);
      if (!s.demo) { this.streak = 0; this.banner = { text: '선방! 아깝다~', sub: '키퍼가 막았어요', t: 0, max: 1.8 }; }
      if (!s.demo) this.sound.save();
      this._burst(b.x, b.y, 12, ['#ffffff', '#ffd93d']);
    } else {
      b.vx = (b.tx - b.x0) * 0.4; b.vy = -520;
      if (!s.demo) { this.streak = 0; this.banner = { text: '하늘로 슝~', sub: '너무 세게 찼어요!', t: 0, max: 1.8 }; }
      if (!s.demo) this.sound.sky();
    }
    if (!s.demo) {
      this.results.push(s.outcome);
      this.phase = 'result'; this.phaseT = 0;
      this.emit('shot', s);
    }
  }

  _nextShot() {
    this.shotIdx++;
    if (this.shotIdx >= RULES.SHOTS) { this._gameOver(); return; }
    this._startAim();
  }

  get score() { return this.points; }
  _gameOver() {
    this.state = 'over'; this.retryProg = 0; this.kicker.arm(false);
    this.sound.fanfare();
    this.emit('state', 'over');
    this.emit('gameOver', {
      score: this.points, goals: this.goals, shots: RULES.SHOTS, results: [...this.results],
      bestStreak: this.bestStreak, corners: this.corners, maxSpeed: this.maxSpeed,
      difficulty: this.difficulty, input: this.input?.kind || 'touch',
    });
  }

  // ── 시작 화면: 혼자 차는 구경용 슛 ──
  _updateDemo(dt) {
    this._updateFlight(dt);
    this.demoIn -= dt;
    if (this.demoIn > 0) return;
    if (!this.ball || this.ball.done) {
      this.ballPos = { x: 640 + rand(-120, 120), y: 640 };
      this.shoot(rand(0, 1), { demo: true, dir: choice(DIRS) });
      this.demoIn = 2.8;
    }
  }

  // ── 공이 발 앞에 놓인 위치 (조준·슛 차례) ──
  _updateBallRest(dt) {
    let tx = 640, ty = 640;
    const inp = this.input;
    if (inp?.kind === 'camera' && inp.bodies?.length) {
      // 화면 가운데에 가장 가까운 사람의 두 발 앞
      let best = null, bd = Infinity;
      for (const b of inp.bodies) {
        const f = b.feet.filter((q) => q.ok); if (!f.length) continue;
        const p = this.toScreen(f.reduce((s, q) => s + q.x, 0) / f.length, Math.max(...f.map((q) => q.y)));
        const d = Math.abs(p.x - this.ballPos.x) + Math.abs(p.x - 640) * 0.3;
        if (d < bd) { bd = d; best = p; }
      }
      if (best) { tx = clamp(best.x, 220, 1060); ty = clamp(best.y + 26, 520, 684); }
    }
    if (this.state === 'title') return;
    const k = 1 - Math.exp(-dt * 8);
    this.ballPos.x += (tx - this.ballPos.x) * k; this.ballPos.y += (ty - this.ballPos.y) * k;
  }

  // ── 키퍼: 평소엔 좌우로 살랑, 슛하면 정한 방향으로 다이빙 ──
  _planKeeper(dir, outcome, tx, ty, height) {
    const K = this.keeper;
    // 장갑이 갈 곳: 막으면 공 자리, 같은 방향인데 못 막으면 살짝 모자라게, 다른 방향이면 그쪽 중간 높이
    let hx, hy;
    const zx = { left: GOAL.x0 + GW * 0.18, center: 640, right: GOAL.x0 + GW * 0.82 }[dir];
    if (outcome === 'save') { hx = tx; hy = ty; }
    else if (dir === this.shot?.aim) { hx = tx + (dir === 'left' ? 46 : dir === 'right' ? -46 : 0); hy = height === 'high' ? ty + 52 : ty + 34; }
    else if (dir === 'center') { hx = 640; hy = GOAL.top + rand(28, 50); } // 가운데로 헛짚으면 두 손 들고 점프
    else { hx = zx + rand(-20, 20); hy = GOAL.bottom - GH * rand(0.3, 0.6); }
    const rot = dir === 'center' ? 0 : (dir === 'left' ? -1 : 1) * lerp(0.55, 1.35, clamp((GOAL.bottom - hy) / GH, 0, 1) * 0.6 + 0.4);
    // 몸통 위치 = 장갑 위치에서 팔 길이만큼 몸 쪽으로
    const reach = 92;
    let bx = hx - Math.sin(rot) * reach, by = hy + Math.cos(rot) * reach;
    by = Math.min(by, KEEPER_STAND_Y + 18);
    if (dir === 'center') by = clamp(hy + reach, KEEPER_STAND_Y - 70, KEEPER_STAND_Y + 10);
    bx = clamp(bx, GOAL.x0 - 10, GOAL.x1 + 10);
    K.dive = { t: 0, delay: 0.1 + rand(0, 0.06), dur: 0.4, from: { x: K.x, y: K.y, rot: K.rot }, to: { x: bx, y: by, rot }, hx, hy };
  }

  _updateKeeper(dt) {
    const K = this.keeper, D = K.dive;
    if (!D) {
      const t = this._clock;
      const x = 640 + Math.sin(t * 1.5) * 34, y = KEEPER_STAND_Y + Math.abs(Math.sin(t * 3)) * -6;
      const k = 1 - Math.exp(-dt * 6);
      K.x += (x - K.x) * k; K.y += (y - K.y) * k; K.rot += (0 - K.rot) * k;
      K.reachOut = 0;
      return;
    }
    D.t += dt;
    const u = clamp((D.t - D.delay) / D.dur, 0, 1), e = easeOutCubic(u);
    K.x = lerp(D.from.x, D.to.x, e); K.y = lerp(D.from.y, D.to.y, e) - Math.sin(u * Math.PI) * 24; K.rot = lerp(D.from.rot, D.to.rot, e);
    K.reachOut = e;
    // 다이빙 후 바닥으로 떨어짐
    if (u >= 1 && this.ball?.done) {
      const fall = Math.min(1, (D.t - D.delay - D.dur) / 0.5);
      if (D.to.rot !== 0) K.y = lerp(D.to.y, GOAL.bottom - 30, easeOutCubic(Math.max(0, fall)));
    }
  }

  // ── 효과 ──
  _burst(x, y, n, colors = CONFETTI) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = rand(160, 460);
      this.parts.push({ type: Math.random() < 0.5 ? 'star' : 'dot', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 100, life: 0, max: rand(0.6, 1.0), size: rand(8, 16), color: choice(colors), rot: rand(0, TAU), vr: rand(-6, 6), g: 520 });
    }
  }
  _updateFx(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]; p.life += dt;
      if (p.life > p.max) { this.parts.splice(i, 1); continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    }
    for (let i = this.texts.length - 1; i >= 0; i--) { const t = this.texts[i]; t.life += dt; t.y -= 60 * dt; if (t.life > t.max) this.texts.splice(i, 1); }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
  }

  // ── 그리기 ──
  render(now) {
    const c = this.ctx, W = this.W, H = this.H, inp = this.input;
    c.save();
    if (this.shake > 0) c.translate(rand(-1, 1) * this.shake * 22, rand(-1, 1) * this.shake * 22);
    c.drawImage(this.bg, 0, 0, W, H);
    this._drawNet(c);
    if (this.ball?.inNet) this._drawBall(c, this.ball);
    this._drawPosts(c);
    this._drawKeeper(c);
    if (this.state === 'play' && this.aim && (this.phase === 'kick' || this.phase === 'fly')) this._drawZone(c, this.aim, now);

    const showPerson = this.state !== 'title' && inp?.kind === 'camera' && inp.hasFrame;
    if (showPerson) { inp.updatePerson?.(); const R = this.personRect; c.drawImage(inp.person, R.x, R.y, R.w, R.h); }

    const aiming = this.state === 'play' && this.phase === 'aim' && !this.absent;
    if (aiming) this._drawBalloons(c, now);
    if (showPerson && inp.poseOk && (aiming || this.state === 'lobby' || this.state === 'over')) this._drawHands(c, now);
    if (showPerson && this.state === 'play' && this.phase === 'kick') this._drawFeet(c, now);

    // 발 앞의 공 (조준·슛 기다리는 중) / 날아가는 공
    const resting = (this.state === 'play' && (this.phase === 'aim' || this.phase === 'kick')) || this.state === 'lobby' || this.state === 'countdown'
      || (this.state === 'title' && (!this.ball || this.ball.done) && this.demoIn < 1.6);
    if (resting) this._drawBall(c, { x: this.ballPos.x, y: this.ballPos.y, r: BALL_R0, rot: 0 }, true, now);
    if (this.ball && !this.ball.inNet && !(this.state === 'play' && this.phase === 'aim')) this._drawBall(c, this.ball, false);
    this._drawFx(c);
    c.restore();

    if (this.state === 'lobby') this._drawLobby(c, now);
    else if (this.state === 'countdown') this._drawCountdown(c);
    if (['play', 'paused', 'countdown', 'over'].includes(this.state)) this._drawHud(c, now);
    if (this.state === 'play' && !this.absent) this._drawPrompt(c, now);
    if (this.state === 'play' && (this.phase === 'result' || this.phase === 'fly') && this.lastKick) this._drawPowerGauge(c);
    if (this.state === 'play' && this.absent) this._drawAbsent(c);
    if (inp?.kind === 'camera' && inp.close?.on && ['lobby', 'countdown', 'play'].includes(this.state) && !this.absent) this._drawTooClose(c, now);
    if (this.banner) this._drawBanner(c);
    if (this.debug && inp?.kind === 'camera') this._drawDebug(c);
  }

  _drawNet(c) {
    const { x0, x1, top, bottom } = GOAL, d = 26;
    c.save();
    c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(x0, top, GW, GH);
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 1.5;
    const hit = this.netHit, age = hit ? this._clock - hit.t : 9;
    const bulge = (x, y) => {
      if (age > 1.2) return [x, y];
      const dist = Math.hypot(x - hit.x, y - hit.y), k = Math.max(0, 1 - dist / 120) * Math.sin(age * 18) * Math.exp(-age * 3);
      return [x + (x - hit.x) * k * 0.15, y + (y - hit.y) * k * 0.15 - k * 6];
    };
    c.beginPath();
    for (let x = x0 + d; x < x1; x += d) { for (let y = top; y <= bottom; y += 10) { const [px, py] = bulge(x, y); if (y === top) c.moveTo(px, py); else c.lineTo(px, py); } }
    for (let y = top + d; y < bottom; y += d) { for (let x = x0; x <= x1; x += 10) { const [px, py] = bulge(x, y); if (x === x0) c.moveTo(px, py); else c.lineTo(px, py); } }
    c.stroke();
    c.restore();
  }

  _drawPosts(c) {
    const { x0, x1, top, bottom } = GOAL;
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = 'rgba(30,20,60,0.35)'; c.lineWidth = 16;
    c.beginPath(); c.moveTo(x0 + 3, bottom + 3); c.lineTo(x0 + 3, top + 3); c.lineTo(x1 + 3, top + 3); c.lineTo(x1 + 3, bottom + 3); c.stroke();
    c.strokeStyle = '#ffffff'; c.lineWidth = 12;
    c.beginPath(); c.moveTo(x0, bottom); c.lineTo(x0, top); c.lineTo(x1, top); c.lineTo(x1, bottom); c.stroke();
    c.restore();
  }

  _drawZone(c, dir, now) {
    const z = this.zoneRect(dir), a = 0.22 + 0.12 * Math.sin(now / 150);
    c.save();
    c.fillStyle = hexA(DIR_COLOR[dir], a); c.beginPath(); c.roundRect(z.x + 8, z.y + 8, z.w - 16, z.h - 14, 14); c.fill();
    c.setLineDash([12, 10]); c.lineWidth = 4; c.strokeStyle = DIR_COLOR[dir]; c.stroke();
    c.restore();
  }

  // 키퍼: 원래 있는 캐릭터를 닮지 않은 단순한 손그림 (모자·장갑·줄무늬 옷)
  _drawKeeper(c) {
    const K = this.keeper;
    const sh = (side) => { const a = K.rot; const ox = side * 24, oy = -26; return { x: K.x + ox * Math.cos(a) - oy * Math.sin(a), y: K.y + ox * Math.sin(a) + oy * Math.cos(a) }; };
    // 장갑 위치: 평소엔 몸 옆 / 다이빙하면 목표 쪽으로 쭉
    const D = K.dive;
    const gloves = [-1, 1].map((side) => {
      const s = sh(side), a = K.rot;
      const rest = { x: s.x + side * 26 * Math.cos(a) + 14 * Math.sin(a) * -1, y: s.y + 30 * Math.cos(a) + side * 26 * Math.sin(a) };
      if (!D || !K.reachOut) return rest;
      const spread = K.rot === 0 || Math.abs(K.rot) < 0.2 ? 36 : 14; // 가운데: 두 손을 머리 양옆으로
      const tgt = { x: D.hx + side * spread * Math.cos(a), y: D.hy + side * spread * Math.sin(a) };
      const dx = tgt.x - s.x, dy = tgt.y - s.y, L = Math.hypot(dx, dy), m = Math.min(L, 96) / (L || 1);
      const reach = { x: s.x + dx * m, y: s.y + dy * m };
      return { x: lerp(rest.x, reach.x, K.reachOut), y: lerp(rest.y, reach.y, K.reachOut) };
    });
    c.save();
    // 그림자
    c.fillStyle = 'rgba(20,40,10,0.25)'; c.beginPath(); c.ellipse(K.x, GOAL.bottom + 2, 42, 9, 0, 0, TAU); c.fill();
    // 팔
    c.lineCap = 'round'; c.lineWidth = 14; c.strokeStyle = '#ff9f1c';
    for (const [i, side] of [-1, 1].entries()) { const s = sh(side); c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(gloves[i].x, gloves[i].y); c.stroke(); }
    c.translate(K.x, K.y); c.rotate(K.rot);
    // 다리
    c.fillStyle = '#2b2140';
    c.beginPath(); c.roundRect(-20, 22, 15, 36, 7); c.roundRect(5, 22, 15, 36, 7); c.fill();
    c.fillStyle = '#ffffff'; c.beginPath(); c.roundRect(-24, 52, 21, 11, 5); c.roundRect(3, 52, 21, 11, 5); c.fill();
    // 몸통 (줄무늬 옷)
    c.fillStyle = '#ff9f1c'; c.beginPath(); c.roundRect(-30, -32, 60, 62, 18); c.fill();
    c.fillStyle = '#ffd166'; c.fillRect(-30, -10, 60, 9); c.fillRect(-30, 8, 60, 9);
    c.lineWidth = 3.5; c.strokeStyle = INK; c.beginPath(); c.roundRect(-30, -32, 60, 62, 18); c.stroke();
    // 머리
    c.fillStyle = '#ffd7b5'; c.beginPath(); c.arc(0, -56, 25, 0, TAU); c.fill(); c.stroke();
    c.fillStyle = INK; c.beginPath(); c.arc(-9, -56, 3.4, 0, TAU); c.arc(9, -56, 3.4, 0, TAU); c.fill();
    c.lineWidth = 3; c.beginPath(); c.arc(0, -50, 8, 0.2, Math.PI - 0.2); c.stroke();
    c.fillStyle = 'rgba(255,120,120,0.5)'; c.beginPath(); c.arc(-15, -48, 5, 0, TAU); c.arc(15, -48, 5, 0, TAU); c.fill();
    // 모자
    c.fillStyle = '#3ecfb2'; c.beginPath(); c.arc(0, -64, 24, Math.PI, 0); c.closePath(); c.fill();
    c.lineWidth = 3; c.stroke();
    c.beginPath(); c.roundRect(-4, -72, 36, 9, 4); c.fill(); c.stroke();
    c.restore();
    // 장갑
    for (const g of gloves) {
      c.fillStyle = '#ffffff'; c.beginPath(); c.arc(g.x, g.y, 15, 0, TAU); c.fill();
      c.lineWidth = 3.5; c.strokeStyle = INK; c.stroke();
      c.fillStyle = '#4d96ff'; c.beginPath(); c.arc(g.x, g.y, 6, 0, TAU); c.fill();
    }
  }

  _drawBall(c, b, resting = false, now = 0) {
    const r = b.r;
    // 그림자 (땅 위)
    let gy = resting ? b.y + r * 0.85 : lerp(b.y0 + BALL_R0 * 0.85, GOAL.bottom + 4, clamp(b.t / b.T, 0, 1));
    if (b.inNet) gy = GOAL.bottom + 2;
    if (!b.over || !b.done) {
      c.fillStyle = 'rgba(20,40,10,0.28)';
      c.beginPath(); c.ellipse(b.x, gy, r * 0.95, r * 0.28, 0, 0, TAU); c.fill();
    }
    const bob = resting ? Math.sin(now / 300) * 2 : 0;
    drawSoccerBall(c, b.x, b.y + bob, r, b.rot || 0);
  }

  _drawBalloons(c, now) {
    for (const b of this.balloons()) {
      const p = this.aimProg[b.dir], bob = Math.sin(now / 380 + b.x) * 7, col = DIR_COLOR[b.dir];
      const z = this.zoneRect(b.dir);
      // 골대 쪽을 가리키는 점선
      c.save(); c.setLineDash([10, 10]); c.lineWidth = 4; c.strokeStyle = hexA(col, 0.8);
      c.beginPath(); c.moveTo(b.x, b.y - b.r + bob); c.lineTo(z.x + z.w / 2, z.y + z.h * 0.55); c.stroke(); c.restore();
      if (p > 0) { c.fillStyle = hexA(col, 0.18 + p * 0.25); c.beginPath(); c.roundRect(z.x + 8, z.y + 8, z.w - 16, z.h - 14, 14); c.fill(); }
      c.save(); c.translate(b.x, b.y + bob);
      c.fillStyle = 'rgba(255,255,255,0.35)'; c.beginPath(); c.arc(0, 0, b.r + 10, 0, TAU); c.fill();
      c.fillStyle = col; c.beginPath(); c.arc(0, 0, b.r, 0, TAU); c.fill();
      c.lineWidth = 5; c.strokeStyle = INK; c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.55)'; c.beginPath(); c.ellipse(-b.r * 0.38, -b.r * 0.4, b.r * 0.18, b.r * 0.28, -0.6, 0, TAU); c.fill();
      if (p > 0) {
        c.lineWidth = 14; c.strokeStyle = '#ffffff'; c.lineCap = 'round';
        c.beginPath(); c.arc(0, 0, b.r + 4, -Math.PI / 2, -Math.PI / 2 + TAU * p); c.stroke();
      }
      const arrow = { left: '↖', center: '↑', right: '↗' }[b.dir];
      this._text(c, arrow, 0, -14, 38, INK);
      this._text(c, DIR_LABEL[b.dir], 0, 24, 28, INK);
      c.restore();
    }
  }

  // 인식된 손: 노란 동그라미 (와르르 캐치와 같은 모양)
  _drawHands(c, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 160), R = this.personRect;
    for (const h of this.input.hands) {
      const x = R.x + h.x * R.s, y = R.y + h.y * R.s, r = Math.max(22, h.r * R.s * 0.8);
      c.fillStyle = 'rgba(255,255,255,0.16)'; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      c.lineWidth = 4 + pulse * 2; c.strokeStyle = 'rgba(255,217,61,0.9)'; c.stroke();
    }
  }
  // 인식된 발: 하얀 동그라미 (슛 차례에 "내 발"이 보이게)
  _drawFeet(c, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 140);
    for (const b of this.input.bodies || []) {
      for (const f of b.feet) {
        if (!f.ok) continue;
        const p = this.toScreen(f.x, f.y);
        c.lineWidth = 4 + pulse * 2; c.strokeStyle = 'rgba(255,255,255,0.9)';
        c.beginPath(); c.arc(p.x, p.y, 20, 0, TAU); c.stroke();
      }
    }
  }

  _drawFx(c) {
    for (const p of this.parts) {
      const a = 1 - p.life / p.max;
      c.globalAlpha = a; c.fillStyle = p.color;
      if (p.type === 'star') { c.save(); c.translate(p.x, p.y); c.rotate(p.rot); this._star(c, 0, 0, p.size, p.size * 0.45); c.fill(); c.restore(); }
      else { c.beginPath(); c.arc(p.x, p.y, p.size * 0.5, 0, TAU); c.fill(); }
    }
    c.globalAlpha = 1;
    for (const t of this.texts) {
      c.globalAlpha = 1 - Math.max(0, (t.life / t.max - 0.6) / 0.4);
      this._text(c, t.text, t.x, t.y, 48, t.color, 'center', 900, INK);
    }
    c.globalAlpha = 1;
  }

  _star(c, x, y, R, r, n = 5) {
    c.beginPath();
    for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n, rr = i % 2 ? r : R; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    c.closePath();
  }
  _panel(c, x, y, w, h, r = 22, fill = 'rgba(255,255,255,0.92)') {
    c.fillStyle = 'rgba(30,20,60,0.35)'; c.beginPath(); c.roundRect(x, y + 5, w, h, r); c.fill();
    c.fillStyle = fill; c.beginPath(); c.roundRect(x, y, w, h, r); c.fill();
    c.lineWidth = 4; c.strokeStyle = INK; c.stroke();
  }
  _text(c, s, x, y, size, color = INK, align = 'center', weight = 900, outline = null) {
    c.font = `${weight} ${size}px ${FONT}`; c.textAlign = align; c.textBaseline = 'middle';
    if (outline) { c.lineJoin = 'round'; c.lineWidth = Math.max(4, size / 7); c.strokeStyle = outline; c.strokeText(s, x, y); }
    c.fillStyle = color; c.fillText(s, x, y);
  }

  // ── HUD: 왼쪽 점수, 오른쪽 슛 기록 ──
  _drawHud(c, now) {
    this._panel(c, 16, 14, 260, 104, 26);
    this._text(c, '점수', 40, 44, 26, '#7a6b8f', 'left', 800);
    this._text(c, formatNum(this.points), 40, 88, 50, INK, 'left');
    if (this.streak >= 2 && this.state === 'play') this._text(c, `🔥${this.streak}연속`, 258, 44, 24, '#ff6b6b', 'right', 900);
    const n = RULES.SHOTS, step = 37, pw = n * step + 40, x0 = this.W - pw - 16;
    this._panel(c, x0, 14, pw, 104, 26);
    const goalsTxt = `${this.difficulty === 'baby' ? '🍼 ' : ''}골 ${this.goals} / 슛 ${this.results.length}`;
    this._text(c, goalsTxt, x0 + 24, 44, 26, '#7a6b8f', 'left', 800);
    for (let i = 0; i < n; i++) {
      const x = x0 + 20 + step * (i + 0.5), y = 88, r = this.results[i];
      const cur = i === this.results.length && this.state === 'play';
      c.beginPath(); c.arc(x, y, 14 * (cur ? 1 + 0.12 * Math.sin(now / 130) : 1), 0, TAU);
      c.fillStyle = r === 'goal' ? '#6bcb77' : r ? '#ff6b6b' : cur ? '#fff3b0' : '#ece4f7'; c.fill();
      c.lineWidth = 2.5; c.strokeStyle = r ? INK : '#cfc3e0'; c.stroke();
      if (r) this._text(c, r === 'goal' ? '✓' : '✕', x, y + 1, 20, '#ffffff');
    }
  }

  // 아래쪽 안내 말 (지금 할 일)
  _drawPrompt(c, now) {
    let msg = null;
    const cam = this.input?.kind === 'camera';
    if (this.phase === 'aim') msg = cam ? '어디로 찰까? 손으로 풍선을 골라요!' : '어디로 찰까? 풍선을 눌러요!';
    else if (this.phase === 'kick') {
      const late = this.phaseT > 6;
      if (cam) {
        const anyFeet = this.input.bodies?.some((b) => b.feet.some((f) => f.ok));
        msg = !anyFeet ? '발이 안 보여요! 발까지 보이게 뒤로 가 주세요' : late ? '한 발을 앞으로 휙! 세게 차면 높이 날아가요' : `${DIR_LABEL[this.aim]}으로! 공을 뻥 차요!`;
      } else msg = late ? '공을 손가락으로 위로 휙 밀어요! 빠를수록 높이' : `${DIR_LABEL[this.aim]}으로! 공을 위로 휙 밀어요`;
    }
    if (!msg) return;
    const tw = Math.min(this.W - 60, msg.length * 32 + 90);
    const y = this.H - 104 + (this.phase === 'kick' ? Math.sin(now / 200) * 3 : 0);
    // 슛 차례에는 공과 겹치지 않게 공 위쪽에
    const py = this.phase === 'kick' && this.ballPos.y > this.H - 190 ? Math.min(452, this.ballPos.y - 150) : y;
    this._panel(c, (this.W - tw) / 2, py, tw, 76, 38, 'rgba(255,255,255,0.94)');
    this._text(c, msg, this.W / 2, py + 39, 32);
  }

  // 방금 찬 세기 (땅볼·중간·높게) — 아이도 "세게 찼다!"를 볼 수 있게
  _drawPowerGauge(c) {
    const k = this.lastKick, x = this.W - 112, y = 170, h = 300;
    this._panel(c, x, y, 86, h + 70, 24);
    this._text(c, '세기', x + 43, y + 26, 24, '#7a6b8f', 'center', 800);
    const gx = x + 26, gy = y + 50, gw = 34, gh = h - 34;
    c.fillStyle = '#ece4f7'; c.beginPath(); c.roundRect(gx, gy, gw, gh, 12); c.fill();
    const p = k.over ? 1 : k.power, fh = gh * Math.max(0.06, p);
    c.fillStyle = k.over ? '#ff6b6b' : p > 0.67 ? '#ff9f1c' : p > 0.34 ? '#ffd93d' : '#6bcb77';
    c.beginPath(); c.roundRect(gx, gy + gh - fh, gw, fh, 12); c.fill();
    c.lineWidth = 3; c.strokeStyle = INK; c.beginPath(); c.roundRect(gx, gy, gw, gh, 12); c.stroke();
    this._text(c, k.over ? '너무 셈' : HEIGHT_LABEL[k.height], x + 43, y + h + 40, 22, INK);
  }

  _drawLobby(c, now) {
    const inp = this.input, B = this.lobbyBubble(), bob = Math.sin(now / 400) * 8;
    this._panel(c, 340, 20, 600, 60, 30);
    this._text(c, `⚽ 승부차기 ${RULES.SHOTS}번!${this.difficulty === 'baby' ? ' 🍼' : ''}`, 640, 51, 34);
    c.save(); c.translate(B.x, B.y + bob);
    c.fillStyle = 'rgba(255,255,255,0.35)'; c.beginPath(); c.arc(0, 0, B.r + 14, 0, TAU); c.fill();
    c.fillStyle = '#ffd93d'; c.beginPath(); c.arc(0, 0, B.r, 0, TAU); c.fill();
    c.lineWidth = 6; c.strokeStyle = INK; c.stroke();
    if (this.startProg > 0) { c.lineWidth = 16; c.strokeStyle = '#ff6b6b'; c.lineCap = 'round'; c.beginPath(); c.arc(0, 0, B.r + 2, -Math.PI / 2, -Math.PI / 2 + TAU * this.startProg); c.stroke(); }
    this._text(c, inp?.kind === 'camera' ? '손으로' : '눌러서', 0, -16, 28);
    this._text(c, '시작!', 0, 22, 42, '#ff4d6d');
    c.restore();
    let msg;
    if (inp?.kind === 'camera') {
      const feet = inp.bodies?.some((b) => b.feet.some((f) => f.ok));
      if (!inp.present) msg = '카메라에 발까지 다 보이게 3걸음 뒤로 서 주세요';
      else if (inp.close?.on && !inp.hands.length) msg = '카메라에 너무 가까워요! 뒤로 가 주세요';
      else if (inp.poseOk && !feet) msg = '발이 안 보여요! 폰을 낮게 두거나 뒤로 가 주세요';
      else if (inp.poseOk && !inp.hands.length) msg = '손이 보이게 팔을 들어 주세요';
      else msg = '준비 완료! 손을 들어 노란 풍선을 터치하면 시작';
    } else msg = '풍선을 눌러서 시작! (폰 모드)';
    // 아래 모서리 버튼(카메라 바꾸기·바로 시작)과 겹치지 않게 조금 위에
    const tw = Math.min(this.W - 60, msg.length * 31 + 90);
    this._panel(c, (this.W - tw) / 2, this.H - 190, tw, 72, 36, 'rgba(255,255,255,0.94)');
    this._text(c, msg, this.W / 2, this.H - 153, 31);
  }

  _drawCountdown(c) {
    const n = Math.ceil(this.countT), f = this.countT - Math.floor(this.countT);
    const s = 1 + (1 - f) * 0.15 + easeOutBack(Math.min(1, (1 - f) * 3)) * 0.2;
    c.save(); c.translate(this.W / 2, this.H / 2);
    c.save(); c.scale(s, s); this._text(c, String(n), 0, 0, 220, '#ffd93d', 'center', 900, INK); c.restore();
    this._text(c, '준비~', 0, 150, 46, '#fff', 'center', 900, INK);
    c.restore();
  }

  _drawBanner(c) {
    const b = this.banner, k = b.t / b.max;
    const s = easeOutBack(Math.min(1, k * 4)), a = 1 - Math.max(0, (k - 0.7) / 0.3);
    c.save(); c.globalAlpha = a; c.translate(this.W / 2, this.state === 'play' ? 500 : this.H * 0.47); c.scale(s, s);
    this._text(c, b.text, 0, 0, 96, '#ffd93d', 'center', 900, INK);
    if (b.sub) this._text(c, b.sub, 0, 82, 44, '#ffffff', 'center', 900, INK);
    c.restore();
  }

  _drawAbsent(c) {
    c.fillStyle = 'rgba(20,10,50,0.45)'; c.fillRect(0, 0, this.W, this.H);
    this._panel(c, 300, 280, 680, 160, 40);
    this._text(c, '사람이 안 보여요!', 640, 332, 48, '#ff4d6d');
    this._text(c, '화면 안으로 들어오면 이어서 해요', 640, 392, 32);
  }

  _drawTooClose(c, now) {
    const cl = this.input.close, p = this.toScreen(cl.x, cl.y);
    const bw = 380, bh = 86, x = clamp(p.x - bw / 2, 20, this.W - bw - 20), y = clamp(p.y - 200, 140, this.H - bh - 140) + Math.sin(now / 220) * 6;
    this._panel(c, x, y, bw, bh, 40, '#fff7c2');
    this._text(c, '한 걸음 뒤로! 👣', x + bw / 2, y + bh / 2 + 2, 40, '#e8505a');
  }

  _drawDebug(c) {
    const inp = this.input, k = this.kicker, lk = this.lastKick;
    const s = `화면 ${Math.round(this._fpsEma || 0)}fps · 인식 ${inp.fps.toFixed(0)}fps · 자세 ${inp.poseMs.toFixed(0)}ms · ${inp.people}명 · 발 속도 ${k.live.toFixed(1)} 들림 ${k.liveLift.toFixed(2)}${lk?.speed != null ? ` · 마지막 슛 ${lk.speed.toFixed(1)}→${Math.round(lk.power * 100)}%` : ''}`;
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(this.W / 2 - 470, 124, 940, 28);
    this._text(c, s, this.W / 2, 138, 17, '#ffffff', 'center', 600);
  }
}

// ── 그림 도우미 ──
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// 축구공: 흰 공 + 가운데 검은 오각형 + 둘레 조각 (돌아가는 느낌)
function drawSoccerBall(c, x, y, r, rot) {
  c.save(); c.translate(x, y);
  c.fillStyle = '#ffffff'; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
  c.save(); c.beginPath(); c.arc(0, 0, r, 0, TAU); c.clip(); c.rotate(rot);
  c.fillStyle = INK;
  const pent = (px, py, s) => { c.beginPath(); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * TAU / 5; c.lineTo(px + Math.cos(a) * s, py + Math.sin(a) * s); } c.closePath(); c.fill(); };
  pent(0, 0, r * 0.36);
  for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * TAU / 5 + Math.PI / 5; pent(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92, r * 0.3); }
  c.strokeStyle = INK; c.lineWidth = Math.max(1, r * 0.06);
  for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * TAU / 5; c.beginPath(); c.moveTo(Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.36); c.lineTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7); c.stroke(); }
  c.restore();
  c.fillStyle = 'rgba(255,255,255,0.35)'; c.beginPath(); c.ellipse(-r * 0.35, -r * 0.4, r * 0.22, r * 0.14, -0.6, 0, TAU); c.fill();
  c.lineWidth = Math.max(2, r * 0.09); c.strokeStyle = INK; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.stroke();
  c.restore();
}

// 경기장 배경 (한 번만 그려 둠): 하늘 · 관중석 · 광고판 · 잔디 줄무늬 · 페널티 박스
function buildStadium(W, H) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  let g = c.createLinearGradient(0, 0, 0, 120); g.addColorStop(0, '#6cc4ff'); g.addColorStop(1, '#bfe6ff');
  c.fillStyle = g; c.fillRect(0, 0, W, 140);
  // 지붕 + 관중석
  c.fillStyle = '#2b2f6b'; c.fillRect(0, 26, W, 16);
  c.fillStyle = '#3b3f8f'; c.fillRect(0, 42, W, 196);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const crowd = ['#ff6b6b', '#ffd93d', '#4d96ff', '#6bcb77', '#ffffff', '#ff9f1c', '#9b5de5', '#f4c6a5'];
  for (let y = 54; y < 228; y += 15) {
    c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(0, y + 6, W, 2);
    for (let x = 6 + ((y / 15) % 2) * 7; x < W; x += 14) {
      c.fillStyle = crowd[Math.floor(rnd() * crowd.length)];
      c.beginPath(); c.arc(x + rnd() * 3, y + rnd() * 3, 4.6, 0, TAU); c.fill();
    }
  }
  // 광고판 (글자·로고 없이 색 띠만)
  const boards = ['#ff6b6b', '#ffd93d', '#3ecfb2', '#4d96ff', '#9b5de5'];
  for (let i = 0, x = 0; x < W; i++, x += 128) {
    c.fillStyle = boards[i % boards.length]; c.fillRect(x, 238, 128, 26);
    c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(x + 12, 246, 104, 10);
  }
  // 잔디 (가까울수록 넓은 줄무늬)
  const top = 264, n = 9;
  for (let i = 0; i < n; i++) {
    const y0 = top + (H - top) * Math.pow(i / n, 1.5), y1 = top + (H - top) * Math.pow((i + 1) / n, 1.5);
    c.fillStyle = i % 2 ? '#5cb85c' : '#4fa94f'; c.fillRect(0, y0, W, y1 - y0 + 1);
  }
  // 선
  c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 4; c.lineJoin = 'round';
  c.beginPath(); c.moveTo(0, GOAL.bottom); c.lineTo(W, GOAL.bottom); c.stroke();
  c.beginPath(); c.moveTo(170, GOAL.bottom); c.lineTo(70, 452); c.lineTo(1210, 452); c.lineTo(1110, GOAL.bottom); c.stroke();
  c.beginPath(); c.moveTo(325, GOAL.bottom); c.lineTo(296, 342); c.lineTo(984, 342); c.lineTo(955, GOAL.bottom); c.stroke();
  c.beginPath(); c.ellipse(640, 452, 170, 46, 0, 0, Math.PI); c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath(); c.ellipse(640, 404, 9, 4, 0, 0, TAU); c.fill();
  return cv;
}
