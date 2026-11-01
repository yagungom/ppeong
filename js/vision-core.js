// 영상 인식 핵심 — 메인 스레드와 워커(별도 처리)에서 같이 씀
//  1) 자세 인식(Pose Landmarker): 멀리 있는 사람도 찾고 사람마다 손·발 위치 → 조준은 손, 슛은 발
//  2) 셀피 분리(Selfie Segmentation): 사람 윤곽 마스크 (가까이 있을 때 특히 정확)
//  → 자세 인식으로 찾은 사람 영역 안은 마스크를 또렷하게 + 뼈대 실루엣 덧칠
//  → 자세 인식이 못 찾은 큰 덩어리(카메라 바로 앞 얼굴 등)는 반투명 + '한 걸음 뒤로' 안내
// 개인정보: 영상 프레임은 이 기기 안에서만 처리되고 저장·전송되지 않습니다.

const HANDS = [[15, 17, 19, 21], [16, 18, 20, 22]];
const ARMS = [[11, 13], [13, 15], [12, 14], [14, 16]];
const LEGS = [[23, 25], [25, 27], [24, 26], [26, 28]];
const FEET = [[27, 29, 31], [28, 30, 32]]; // 발목·뒤꿈치·발끝 (왼발, 오른발)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

async function withGpuFallback(create) {
  try { return { task: await create('GPU'), delegate: 'GPU' }; }
  catch (e) { console.warn('GPU 가속 불가, CPU로 전환', e); return { task: await create('CPU'), delegate: 'CPU' }; }
}

export class VisionCore {
  // o: { W, H, segW, segH, poseW, poseH, bundleUrl, wasmBase, segModel, poseModel, multiclass, maxPeople }
  constructor(o) {
    Object.assign(this, o);
    const { segW: SW, segH: SH, poseW: PW, poseH: PH } = o;
    this.SW = SW; this.SH = SH; this.PW = PW; this.PH = PH;
    this.segCv = makeCanvas(SW, SH); this.segCtx = this.segCv.getContext('2d');
    this.poseCv = makeCanvas(PW, PH); this.poseCtx = this.poseCv.getContext('2d');
    this.silCv = makeCanvas(SW, SH); this.silCtx = this.silCv.getContext('2d', { willReadFrequently: true });
    this.mask = new Float32Array(SW * SH);
    this.hands = []; this.bodies = []; this.poseSeq = 0; this.people = 0; this.sil = null;
    this.poseEvery = 1; this.frame = 0; this.lastTs = -1; this.lastPoseTs = -1;
    this.segMs = 0; this.poseMs = 0;
    this.close = { on: false, x: 0, y: 0, ratio: 0 };
    this.closePose = null;
  }

  async init(progress) {
    progress?.('사람 인식 엔진 불러오는 중… (처음 한 번만 조금 걸려요)');
    const mod = await import(this.bundleUrl);
    const fileset = await mod.FilesetResolver.forVisionTasks(this.wasmBase);
    progress?.('손 인식 준비 중…');
    const [seg, pose] = await Promise.all([
      withGpuFallback((delegate) => mod.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: this.segModel, delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
      })),
      withGpuFallback((delegate) => mod.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: this.poseModel, delegate }, runningMode: 'VIDEO',
        numPoses: this.maxPeople, minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
        outputSegmentationMasks: false,
      })).catch((e) => { console.warn('자세 인식 불러오기 실패 → 몸 전체로 판정', e); return null; }),
    ]);
    this.segmenter = seg.task; this.delegate = seg.delegate;
    this.poser = pose?.task || null; this.poseDelegate = pose?.delegate || '-';
    return { delegate: this.delegate, poseDelegate: this.poseDelegate, poseOk: !!this.poser };
  }

  // src: 이미 좌우반전·16:9로 잘린 프레임 (자세 인식 크기 PW×PH)
  process(src) {
    if (this.poser && (this.frame++ % this.poseEvery === 0)) {
      const t0 = performance.now();
      let ts = t0; if (ts <= this.lastPoseTs) ts = this.lastPoseTs + 1; this.lastPoseTs = ts;
      try { this.poser.detectForVideo(src, ts, (res) => this._onPose(res)); } catch (e) { console.warn('pose error', e); }
      this.poseMs = this.poseMs * 0.85 + (performance.now() - t0) * 0.15;
      this.poseEvery = this.poseMs > 60 ? 2 : 1;
    }
    this.segCtx.drawImage(src, 0, 0, this.SW, this.SH);
    const t1 = performance.now();
    let ts = t1; if (ts <= this.lastTs) ts = this.lastTs + 1; this.lastTs = ts;
    const out = { rgba: null, coverage: 0, cols: null };
    try {
      this.segmenter.segmentForVideo(this.segCv, ts, (res) => {
        const m = res.confidenceMasks;
        if (m?.length) Object.assign(out, this._updateMask(m[0].getAsFloat32Array(), this.multiclass));
      });
    } catch (e) { console.warn('segment error', e); }
    this.segMs = this.segMs * 0.85 + (performance.now() - t1) * 0.15;
    return {
      ...out, hands: this.hands, bodies: this.bodies, poseSeq: this.poseSeq, people: this.people, close: this.close,
      segMs: this.segMs, poseMs: this.poseMs, poseEvery: this.poseEvery, poseDbg: this.poseDbg,
    };
  }

  _onPose(res) {
    const { W, H } = this;
    const all = res.landmarks || [];
    // 카메라 바로 앞(얼굴이 아주 크게 보임) → 사람 영역에서 빼서 반투명 + '뒤로' 안내
    const lms = [], near = [], dbg = [];
    for (const lm of all) {
      const ear = Math.hypot((lm[7].x - lm[8].x) * W, (lm[7].y - lm[8].y) * H);
      const sh = Math.hypot((lm[11].x - lm[12].x) * W, (lm[11].y - lm[12].y) * H);
      if (ear > W * 0.1 || sh > W * 0.38) near.push(lm); else lms.push(lm); // 대략 1m 이내
      dbg.push([Math.round(ear), Math.round(sh), +(lm[7].visibility ?? -1).toFixed(2), +(lm[11].visibility ?? -1).toFixed(2)]);
    }
    this.poseDbg = dbg;
    this.closePose = near.length ? { x: near[0][0].x * W, y: near[0][0].y * H } : null;
    const prev = this.hands, next = [];
    for (const lm of all) {
      // 사람 크기(어깨 폭)에 맞춰 손 판정 크기 → 멀리 있어도, 가까이 있어도 비슷하게 잡힘
      const shoulder = Math.hypot((lm[11].x - lm[12].x) * W, (lm[11].y - lm[12].y) * H);
      const torso = Math.hypot((lm[11].x - lm[23].x) * W, (lm[11].y - lm[23].y) * H);
      const r = clamp(Math.max(shoulder, torso * 0.7) * 0.42, 34, 110);
      for (const [w, pk, ix, th] of HANDS) {
        if (Math.max(lm[w].visibility ?? 1, lm[ix].visibility ?? 1) < 0.35) continue;
        const wx = lm[w].x * W, wy = lm[w].y * H;
        const kx = (lm[pk].x + lm[ix].x + lm[th].x) / 3 * W, ky = (lm[pk].y + lm[ix].y + lm[th].y) / 3 * H;
        const x = wx + (kx - wx) * 1.25, y = wy + (ky - wy) * 1.25; // 손바닥 가운데
        next.push({ x, y, r, px: x, py: y });
      }
    }
    // 이전 손과 짝지어서 '휘두른 경로' 전체로 판정 (빠르게 쳐도 놓치지 않게)
    for (const h of next) {
      let best = null, bd = 260 * 260;
      for (const q of prev) { const d = (q.x - h.x) ** 2 + (q.y - h.y) ** 2; if (d < bd) { bd = d; best = q; } }
      if (best) { h.px = best.x; h.py = best.y; }
    }
    this.hands = next; this.people = all.length;
    this.bodies = all.map((lm) => this._body(lm)); this.poseSeq++;
    this._drawSilhouettes(lms);
  }

  // 발차기 판정용: 사람마다 엉덩이 가운데, 다리 길이(엉덩이~발목), 두 발 위치
  _body(lm) {
    const { W, H } = this;
    const vis = (i) => lm[i].visibility ?? 1;
    const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H);
    const feet = FEET.map(([a, h, t]) => {
      const pts = [a, h, t].filter((i) => vis(i) > 0.3);
      if (!pts.length) return { x: lm[a].x * W, y: lm[a].y * H, ok: false };
      let x = 0, y = 0; for (const i of pts) { x += lm[i].x; y += lm[i].y; }
      return { x: x / pts.length * W, y: y / pts.length * H, ok: vis(a) > 0.3 || vis(t) > 0.3 };
    });
    const legs = [[23, 25, 27], [24, 26, 28]].filter(([h, k, a]) => vis(h) > 0.3 && vis(k) > 0.3 && vis(a) > 0.3).map(([h, k, a]) => d(h, k) + d(k, a));
    const torso = (d(11, 23) + d(12, 24)) / 2;
    const leg = legs.length ? legs.reduce((s, v) => s + v, 0) / legs.length : torso * 1.15;
    return { hx: (lm[23].x + lm[24].x) / 2 * W, hy: (lm[23].y + lm[24].y) / 2 * H, leg: Math.max(leg, 20), feet };
  }

  // 작은 캔버스에 R = 뼈대 실루엣, G = 사람 영역(박스)
  _drawSilhouettes(lms) {
    const c = this.silCtx, SW = this.SW, SH = this.SH;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, SW, SH);
    if (!lms.length) { this.sil = null; return; }
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round'; c.lineJoin = 'round';
    const P = (lm, i) => [lm[i].x * SW, lm[i].y * SH];
    const ok = (lm, i) => (lm[i].visibility ?? 1) > 0.3;
    for (const lm of lms) {
      const [lsx, lsy] = P(lm, 11), [rsx, rsy] = P(lm, 12);
      const shoulder = Math.hypot(lsx - rsx, lsy - rsy);
      const torso = Math.hypot(lsx - lm[23].x * SW, lsy - lm[23].y * SH);
      const b = Math.max(shoulder, torso * 0.7, 4);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < 33; i++) { if (!ok(lm, i)) continue; const [x, y] = P(lm, i); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (x1 < x0) continue;
      const pad = b * 0.45;
      c.fillStyle = 'rgb(0,255,0)';
      c.fillRect(x0 - pad, y0 - b * 0.9, x1 - x0 + pad * 2, y1 - y0 + b * 0.9 + pad);
      c.strokeStyle = 'rgb(255,0,0)'; c.fillStyle = 'rgb(255,0,0)';
      const limb = (pairs, w) => {
        c.lineWidth = w; c.beginPath();
        for (const [a, z] of pairs) { if (!ok(lm, a) || !ok(lm, z)) continue; const [ax, ay] = P(lm, a), [zx, zy] = P(lm, z); c.moveTo(ax, ay); c.lineTo(zx, zy); }
        c.stroke();
      };
      limb(ARMS, b * 0.2);
      limb(LEGS, b * 0.25);
      if (ok(lm, 11) && ok(lm, 12) && ok(lm, 23) && ok(lm, 24)) {
        c.beginPath(); for (const i of [11, 12, 24, 23]) { const [x, y] = P(lm, i); c.lineTo(x, y); } c.closePath(); c.fill();
        c.lineWidth = b * 0.12; c.stroke();
      }
      if (ok(lm, 0)) {
        const [nx, ny] = P(lm, 0);
        c.lineWidth = b * 0.28; c.beginPath(); c.moveTo((lsx + rsx) / 2, (lsy + rsy) / 2); c.lineTo(nx, ny); c.stroke();
        c.beginPath(); c.arc(nx, ny - b * 0.08, b * 0.27, 0, Math.PI * 2); c.fill();
      }
    }
    this.sil = c.getImageData(0, 0, SW, SH).data;
  }

  _updateMask(f, invert) {
    const m = this.mask, n = m.length, SW = this.SW, SH = this.SH;
    const rgba = new Uint8ClampedArray(n * 4);
    const cols = new Float32Array(32), nc = 32;
    const sil = this.sil, ghost = !!this.poser; // 자세 인식이 있을 때만 '가까운 덩어리' 반투명 처리
    let cov = 0, closeN = 0, cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      let v = invert ? 1 - f[i] : f[i];
      let inPerson = false;
      if (sil) {
        const j = i * 4;
        inPerson = sil[j + 1] > 0;
        if (inPerson) v = Math.min(1, v * 2.2);                 // 사람으로 확인된 영역: 흐릿한 마스크를 또렷하게
        const sv = sil[j] / 255 * 0.85; if (sv > v) v = sv;      // 뼈대 실루엣으로 빈 곳 채우기
      }
      v = m[i] * 0.3 + v * 0.7; // 깜빡임 줄이기
      m[i] = v;
      let a = clamp((v - 0.3) / 0.4, 0, 1);
      if (ghost && !inPerson && v > 0.5) {                       // 손이 안 보일 만큼 가까운 사람 → 반투명
        a *= 0.4; closeN++; cx += i % SW; cy += (i / SW) | 0;
      }
      const k = i * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = 255; rgba[k + 3] = a * 255;
      if (v > 0.5) { cov++; cols[Math.floor((i % SW) / SW * nc)]++; }
    }
    const colTotal = n / nc;
    for (let i = 0; i < nc; i++) cols[i] /= colTotal;
    // 카메라 바로 앞 큰 덩어리 → '한 걸음 뒤로!' (켜고 끄는 기준을 달리해 깜빡임 방지)
    const ratio = closeN / n, cl = this.close;
    cl.ratio = ratio;
    const cp = this.closePose;
    if (!cl.on && (ratio > 0.07 || cp)) cl.on = true; else if (cl.on && ratio < 0.04 && !cp) cl.on = false;
    if (cp) { cl.x = cp.x; cl.y = cp.y; } else if (closeN) { cl.x = cx / closeN / SW * this.W; cl.y = cy / closeN / SH * this.H; }
    return { rgba, coverage: cov / n, cols };
  }
}
