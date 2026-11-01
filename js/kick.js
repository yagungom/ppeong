// 발차기 판정: 자세 인식으로 찾은 발 위치를 시간 순서로 모아서 "빠르게 올라간 발"을 찾음
//  - 속도는 다리 길이(엉덩이~발목) 기준 → 카메라에서 멀리 서든 가까이 서든 같은 기준
//  - 반대쪽 발보다 올라가야 슛 (제자리 점프·걷기로 잘못 차지는 것 방지)
//  - 슛 시작 뒤 잠깐(windowMs) 동안 가장 빠른 속도를 세기로 씀
//  카메라 쪽(앞)으로 차면 화면에서는 발이 위로 올라가는 모습으로 보여서, 화면 속 위·옆 움직임으로 잼

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class KickDetector {
  // cfg: { trigger, lift, low, high, over } (config.js 의 KICK.normal / KICK.baby), windowMs, cooldownMs
  constructor(cfg, { windowMs = 260, cooldownMs = 900 } = {}) {
    this.setConfig(cfg); this.windowMs = windowMs; this.cooldownMs = cooldownMs;
    this.tracks = []; this.armed = false; this.pending = null; this.lastKickAt = -1e9;
    this.live = 0; this.liveLift = 0; // 지금 가장 빠른 발 속도 (성능 정보 표시용)
    this.onKick = null;
  }

  setConfig(cfg) { this.cfg = cfg; }
  arm(on = true) { this.armed = on; if (!on) this.pending = null; }
  reset() { this.tracks = []; this.pending = null; this.live = 0; this.liveLift = 0; }

  // 사람 목록을 이전 사람과 짝지음 (엉덩이 가운데가 가장 가까운 사람)
  _match(bodies, t) {
    const used = new Set(), next = [];
    for (const b of bodies) {
      let best = null, bd = Infinity;
      for (const tr of this.tracks) {
        if (used.has(tr)) continue;
        const d = Math.hypot(tr.hx - b.hx, tr.hy - b.hy);
        if (d < bd && d < b.leg * 1.6) { bd = d; best = tr; }
      }
      const tr = best || { samples: [] };
      used.add(tr);
      tr.hx = b.hx; tr.hy = b.hy; tr.leg = tr.leg ? tr.leg * 0.8 + b.leg * 0.2 : b.leg; // 다리 길이는 흔들리지 않게 부드럽게
      tr.samples.push({ t, feet: b.feet });
      while (tr.samples.length > 2 && t - tr.samples[0].t > 500) tr.samples.shift();
      next.push(tr);
    }
    this.tracks = next;
  }

  // 한 발의 속도(다리 길이/초)와 높이(반대 발보다 얼마나 위에 있는지, 다리 길이 단위)
  _footState(tr, i) {
    const S = tr.samples, cur = S[S.length - 1], f = cur.feet[i], o = cur.feet[1 - i];
    if (!f?.ok) return null;
    // 40~200ms 전 기록들과 하나씩 비교해 가장 빠른 값 (인식이 느린 폰도 계산되고, 차기 직전 멈춰 있던 시간에 묻히지 않게)
    const lift = o?.ok ? (o.y - f.y) / tr.leg : 0;
    let v = 0, up = false;
    for (const s of S) {
      const dt = (cur.t - s.t) / 1000, r = s.feet[i];
      if (dt > 0.2 || dt < 0.04 || !r?.ok) continue;
      const sp = Math.hypot(f.x - r.x, f.y - r.y) / dt / tr.leg;
      if (sp > v) { v = sp; up = f.y < r.y; }
    }
    return { v, lift, x: f.x, y: f.y, up };
  }

  // 자세 인식 결과가 나올 때마다 호출. 슛이 확정되면 onKick({ power, speed, lift, x, y, over }) 호출
  push(bodies, t) {
    this._match(bodies || [], t);
    let best = null;
    for (const tr of this.tracks) {
      for (const i of [0, 1]) {
        const st = this._footState(tr, i);
        if (st && (!best || st.v > best.v)) best = { ...st, leg: tr.leg };
      }
    }
    this.live = best ? best.v : 0; this.liveLift = best ? best.lift : 0;
    const c = this.cfg;
    if (this.pending) {
      const p = this.pending;
      if (best && best.v > p.speed) { p.speed = best.v; p.x = best.x; p.y = best.y; }
      if (best && best.lift > p.lift) p.lift = best.lift;
      if (t - p.t0 >= this.windowMs) this._fire(t);
      return;
    }
    if (!this.armed || !best || t - this.lastKickAt < this.cooldownMs) return;
    if (best.v >= c.trigger && best.lift >= c.lift && best.up) {
      this.pending = { t0: t, speed: best.v, lift: best.lift, x: best.x, y: best.y };
    }
  }

  // 아직 창이 안 끝났는데 인식이 끊기면 그대로 확정 (게임 루프에서 호출)
  tick(t) { if (this.pending && t - this.pending.t0 >= this.windowMs + 150) this._fire(t); }

  _fire(t) {
    const p = this.pending, c = this.cfg; this.pending = null;
    this.lastKickAt = t; this.armed = false;
    const power = clamp((p.speed - c.low) / Math.max(0.01, c.high - c.low), 0, 1);
    const ev = { power, speed: p.speed, lift: p.lift, x: p.x, y: p.y, over: p.speed >= c.over };
    try { this.onKick?.(ev); } catch (e) { console.error(e); }
  }
}

// 세기(0~1) → 높이 이름
export function heightOf(power) { return power < 0.34 ? 'low' : power < 0.67 ? 'mid' : 'high'; }
export const HEIGHT_LABEL = { low: '땅볼', mid: '중간', high: '높게' };
