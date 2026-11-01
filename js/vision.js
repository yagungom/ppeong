// 카메라 + 인식 연결 + 터치 입력
// 무거운 인식(자세·사람 분리)은 별도 처리(Web Worker)에서 돌리고, 여기서는 화면 합성과 판정만 → 게임 화면이 끊기지 않음
// 워커를 못 쓰는 브라우저에서는 같은 코드(vision-core.js)를 화면 쪽에서 그대로 실행
// 개인정보: 카메라 영상은 이 기기의 메모리 안에서만 처리되고, 저장·전송되지 않습니다.
import { CONFIG, QUALITY } from './config.js';
import { VisionCore } from './vision-core.js';

const abs = (p) => new URL(p, document.baseURI).href;

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t - px, y = ay + dy * t - py;
  return x * x + y * y;
}

export class CameraVision {
  constructor({ quality = 'high', mirror = true } = {}) {
    this.kind = 'camera';
    this.W = CONFIG.W; this.H = CONFIG.H;
    this.mirror = mirror;
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true; this.video.setAttribute('playsinline', '');
    this.person = document.createElement('canvas'); this.person.width = this.W; this.person.height = this.H;
    this.pctx = this.person.getContext('2d');
    this.frameCv = document.createElement('canvas'); this.frameCv.width = this.W; this.frameCv.height = this.H;
    this.fctx = this.frameCv.getContext('2d');
    // 사람 합성 방식: true = 영상은 매 프레임(부드러움) / false = 인식된 프레임만(가벼움)
    //  인식이 아주 느리면(초당 7번 미만) 영상과 사람 모양이 어긋나 보여서 가벼운 방식으로, 다시 빨라지면(10번 이상) 부드럽게
    //  화면 자체가 버벅이는 기기는 계속 가벼운 방식 (liveBlocked)
    this.live = true; this.liveBlocked = false;
    this.stream = null; this.running = false;
    this.coverage = 0; this.colProfile = new Float32Array(32);
    this.segMs = 0; this.poseMs = 0; this.fps = 0; this._fpsT = performance.now(); this._fpsN = 0;
    this.hasFrame = false; this.hands = []; this.bodies = []; this.poseSeq = -1; this.people = 0; this.poseOk = false;
    this.onPose = null; // (bodies, 찍은 시각 ms) — 자세 인식 결과가 새로 나올 때마다 (발차기 판정용)
    this.close = { on: false, x: 0, y: 0, ratio: 0 };
    this.delegate = '-'; this.poseDelegate = '-'; this.threaded = false;
    this.worker = null; this.core = null; this.busy = false; this.fid = 0; this.lastRgba = null;
    this.useWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
      && typeof createImageBitmap === 'function' && !/[?&]noworker/.test(location.search);
    this.setQuality(quality);
  }

  setQuality(q) {
    const p = QUALITY[q] || QUALITY.high;
    this.quality = QUALITY[q] ? q : 'high';
    this.SW = p.segW; this.SH = p.segH; this.PW = p.poseW; this.PH = p.poseH; this.poseKind = p.pose;
    this.small = document.createElement('canvas'); this.small.width = this.PW; this.small.height = this.PH;
    this.sctx = this.small.getContext('2d');
    this.maskCv = document.createElement('canvas'); this.maskCv.width = this.SW; this.maskCv.height = this.SH;
    this.mctx = this.maskCv.getContext('2d');
    this._killWorker(); this.core = null; this.engineReady = false;
  }

  _cfg() {
    return {
      W: this.W, H: this.H, segW: this.SW, segH: this.SH, poseW: this.PW, poseH: this.PH,
      bundleUrl: abs('vendor/mediapipe/vision_bundle.mjs'), wasmBase: abs(CONFIG.WASM_PATH).replace(/\/$/, ''),
      segModel: abs(CONFIG.MODEL.path), poseModel: abs(CONFIG.POSE_MODELS[this.poseKind]),
      multiclass: CONFIG.MODEL.kind === 'multiclass', maxPeople: CONFIG.MAX_PEOPLE, single: !!CONFIG.SINGLE_PLAYER,
    };
  }

  async init(progress) {
    if (this.engineReady) return;
    if (this.useWorker) {
      try { await this._initWorker(progress); this.threaded = true; this.engineReady = true; return; }
      catch (e) { console.warn('별도 처리(워커) 사용 불가 → 화면 쪽에서 처리', e); this._killWorker(); }
    }
    this.core = new VisionCore(this._cfg());
    this._setInfo(await this.core.init(progress));
    this.threaded = false; this.engineReady = true;
  }

  _initWorker(progress) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./vision-worker.js', import.meta.url));
      this.worker = w;
      const timer = setTimeout(() => reject(new Error('worker init timeout')), 90000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') progress?.(m.msg);
        else if (m.type === 'ready') { clearTimeout(timer); this._setInfo(m.info); w.onmessage = (ev) => this._apply(ev.data); resolve(); }
        else if (m.type === 'error') { clearTimeout(timer); reject(new Error(m.message)); }
      };
      w.onerror = (ev) => { clearTimeout(timer); ev.preventDefault?.(); reject(new Error(ev.message || 'worker error')); };
      w.postMessage({ type: 'init', cfg: this._cfg() });
    });
  }

  // 차는 사람 다시 고르기 (가운데에 선 사람으로) — 차례가 바뀔 때 게임이 부름
  reselect() { if (this.worker) this.worker.postMessage({ type: 'reselect' }); else this.core?.reselect(); }

  _setInfo(info) { this.delegate = info.delegate; this.poseDelegate = info.poseDelegate; this.poseOk = info.poseOk; }
  _killWorker() { try { this.worker?.terminate(); } catch { /* noop */ } this.worker = null; this.busy = false; }

  static async listCameras() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { return []; }
  }

  async startCamera({ deviceId = null, facing = 'user' } = {}) {
    this.stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no-camera-api'), { name: 'NotSupportedError' });
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = { ideal: facing };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    const st = this.stream.getVideoTracks()[0]?.getSettings?.() || {};
    this.deviceId = st.deviceId || deviceId;
    this.facing = st.facingMode || facing;
    this.running = true; this.hasFrame = false; this.busy = false;
    this._loop();
  }

  stopCamera() {
    this.running = false;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this.coverage = 0; this.hasFrame = false; this.hands = []; this.bodies = []; this.people = 0; this.crowd = 0; this.lastRgba = null; this.fps = 0;
    this.close = { on: false, x: 0, y: 0, ratio: 0 };
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { this._process(); this._loop(); });
    else requestAnimationFrame(() => { if (v.currentTime !== this._lastVT) { this._lastVT = v.currentTime; this._process(); } this._loop(); });
  }

  _process() {
    const v = this.video;
    if (!this.running || !v.videoWidth || !this.engineReady) return;
    // 이전 프레임을 아직 처리 중이면 이번 프레임은 건너뜀 (밀리지 않게)
    if (this.busy) { if (performance.now() - this.busySince < 1500) return; this.busy = false; }
    // 16:9 로 가운데 잘라내기(cover) + 거울 반전 → 인식용 작은 프레임
    if (this.live) this._drawVideo(this.sctx, this.PW, this.PH);
    else { this._drawVideo(this.fctx, this.W, this.H); this.sctx.drawImage(this.frameCv, 0, 0, this.PW, this.PH); }
    this.busy = true; this.busySince = performance.now(); this._capT = this.busySince;
    if (this.worker) {
      createImageBitmap(this.small).then((bmp) => {
        if (!this.worker || !this.running) { bmp.close(); this.busy = false; return; }
        this.worker.postMessage({ type: 'frame', id: ++this.fid, bitmap: bmp }, [bmp]);
      }, () => { this.busy = false; });
    } else {
      try { this._apply({ type: 'result', ...this.core.process(this.small) }); } catch (e) { console.warn(e); this.busy = false; }
    }
  }

  _apply(r) {
    if (r?.type !== 'result') return;
    this.busy = false;
    if (!this.running) return;
    if (r.rgba) {
      this.mctx.putImageData(new ImageData(r.rgba, this.SW, this.SH), 0, 0);
      this._maskDirty = true;
      if (!this.live) this._composite(this.frameCv);
      this.lastRgba = r.rgba; this.coverage = r.coverage; this.colProfile = r.cols; this.hasFrame = true;
    }
    this.hands = r.hands || []; this.people = r.people || 0; this.crowd = r.crowd || 0;
    if (r.poseSeq != null && r.poseSeq !== this.poseSeq) {
      this.poseSeq = r.poseSeq; this.bodies = r.bodies || [];
      try { this.onPose?.(this.bodies, this._capT); } catch (e) { console.warn(e); }
    }
    if (r.close) this.close = r.close;
    this.segMs = r.segMs || 0; this.poseMs = r.poseMs || 0;
    this.poseDbg = r.poseDbg;
    this._fpsN++; const now = performance.now();
    if (now - this._fpsT > 1000) {
      this.fps = this._fpsN * 1000 / (now - this._fpsT); this._fpsN = 0; this._fpsT = now;
      if (this.hasFrame) {
        if (this.live && this.fps < 7) this.setLive(false);
        else if (!this.live && !this.liveBlocked && this.fps >= 10) this.setLive(true);
      }
    }
  }

  // 카메라 영상을 16:9 로 잘라(가운데) 좌우 반전해서 그리기
  _drawVideo(ctx, w, h) {
    const v = this.video, tr = this.W / this.H, vr = v.videoWidth / v.videoHeight;
    let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
    if (vr > tr) { sw = sh * tr; sx = (v.videoWidth - sw) / 2; } else { sh = sw / tr; sy = (v.videoHeight - sh) / 2; }
    ctx.save(); ctx.globalCompositeOperation = 'copy';
    if (this.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    ctx.restore();
  }

  // 사람 합성: 카메라 영상은 새 프레임마다(초당 30번) 바로 쓰고, 사람 모양(마스크)만 인식될 때마다 바꿈
  //  → 인식이 느린 폰에서도 사람이 뚝뚝 끊기지 않고 부드럽게 움직임
  updatePerson() {
    if (!this.live || !this.running || !this.hasFrame || !this.video.videoWidth) return;
    const t = this.video.currentTime;
    if (t === this._liveT && !this._maskDirty) return;
    this._liveT = t; this._maskDirty = false;
    this._composite(null);
  }
  blockLive() { this.liveBlocked = true; this.setLive(false); }
  // 인식된 프레임에만 합성하는 가벼운 방식 ↔ 매 프레임 부드러운 방식
  setLive(on) {
    if (this.live === on) return;
    this.live = on; this._maskDirty = true;
    console.info('[camera] 사람 합성 방식:', on ? '부드럽게(매 프레임)' : '가볍게(인식된 프레임만)');
  }
  _composite(frame) {
    const p = this.pctx, { W, H } = this;
    if (frame) { p.globalCompositeOperation = 'copy'; p.drawImage(frame, 0, 0); } else this._drawVideo(p, W, H);
    p.globalCompositeOperation = 'destination-in';
    p.imageSmoothingEnabled = true; p.imageSmoothingQuality = 'high';
    p.drawImage(this.maskCv, 0, 0, W, H);
    p.globalCompositeOperation = 'source-over';
  }

  // 화면 좌표(1280x720) 지점의 "사람일 정도" (자세 인식이 없을 때 대체 판정용)
  sample(x, y) {
    const a = this.lastRgba; if (!a) return 0;
    const mx = Math.floor(x / this.W * this.SW), my = Math.floor(y / this.H * this.SH);
    if (mx < 0 || my < 0 || mx >= this.SW || my >= this.SH) return 0;
    return a[(my * this.SW + mx) * 4 + 3] / 255;
  }

  // 풍선 판정: 손으로만. (자세 인식을 못 불러온 경우에만 몸 전체로 대체)
  hitTest(x, y, r, need = 2, th = 0.55) {
    if (this.poseOk) {
      for (const h of this.hands) {
        const rr = r * 0.8 + h.r;
        if (segDist2(x, y, h.px, h.py, h.x, h.y) < rr * rr) return true;
      }
      return false;
    }
    let hits = 0;
    if (this.sample(x, y) > th) hits++;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      if (this.sample(x + Math.cos(a) * r * 0.75, y + Math.sin(a) * r * 0.75) > th) { hits++; if (hits >= need) return true; }
    }
    return hits >= need;
  }

  get present() { return this.people > 0 || this.coverage > 0.012; }
  destroy() { this.stopCamera(); }
}

// 폰 모드: 카메라 없이 손가락(또는 마우스)으로 터치
export class TouchInput {
  constructor(canvas) {
    this.kind = 'touch';
    this.W = CONFIG.W; this.H = CONFIG.H; this.canvas = canvas;
    this.pointers = new Map(); this.R = 64;
    this.coverage = 0; this.colProfile = new Float32Array(32);
    const toLocal = (e) => {
      const r = canvas.getBoundingClientRect();
      // 캔버스 크기는 화면비에 따라 바뀔 수 있어 매번 실제 크기로 환산
      return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height };
    };
    this.onRelease = null; // 손가락을 뗄 때 { x0, y0, x, y, vx, vy } (vx·vy = 마지막 0.1초 속도, 화면 px/초) — 폰 모드 슛
    this._paths = new Map();
    this._down = (e) => {
      const q = toLocal(e), now = performance.now();
      this.pointers.set(e.pointerId, { ...q, px: q.x, py: q.y, t: now, mt: now, up: 0 });
      this._paths.set(e.pointerId, [{ ...q, t: now }]);
    };
    this._move = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (e.pointerType !== 'mouse' && (!p || p.up)) return;
      const q = toLocal(e), now = performance.now();
      this.pointers.set(e.pointerId, { ...q, px: p ? p.x : q.x, py: p ? p.y : q.y, t: now, mt: now, up: 0 });
      const path = this._paths.get(e.pointerId);
      if (path) { path.push({ ...q, t: now }); while (path.length > 2 && now - path[0].t > 400) path.shift(); }
    };
    // 손가락을 뗀 뒤에도 잠깐(0.16초) 판정을 유지 → 아주 짧게 '톡' 쳐도 인식
    this._up = (e) => {
      const p = this.pointers.get(e.pointerId); if (p && e.pointerType !== 'mouse') p.up = performance.now();
      const path = this._paths.get(e.pointerId); this._paths.delete(e.pointerId);
      if (!path?.length || !this.onRelease) return;
      const now = performance.now(), last = path[path.length - 1];
      let ref = path[0]; for (const q of path) { if (now - q.t <= 110) { ref = q; break; } }
      const dt = Math.max(0.016, (last.t - ref.t) / 1000);
      try { this.onRelease({ x0: path[0].x, y0: path[0].y, x: last.x, y: last.y, vx: (last.x - ref.x) / dt, vy: (last.y - ref.y) / dt }); } catch (err) { console.warn(err); }
    };
    canvas.addEventListener('pointerdown', this._down);
    canvas.addEventListener('pointermove', this._move);
    window.addEventListener('pointerup', this._up);
    window.addEventListener('pointercancel', this._up);
  }
  get active() {
    const now = performance.now(), out = [];
    for (const [id, p] of this.pointers) {
      if (p.up && now - p.up > 160) { this.pointers.delete(id); continue; }
      out.push(p);
    }
    return out;
  }
  hitTest(x, y, r) {
    const now = performance.now(), rr = (r + this.R * 0.6) ** 2;
    for (const p of this.active) {
      const swept = now - p.mt < 60; // 방금 움직였으면 지나간 경로까지
      if ((swept ? segDist2(x, y, p.px, p.py, p.x, p.y) : (p.x - x) ** 2 + (p.y - y) ** 2) < rr) return true;
    }
    return false;
  }
  get present() { return true; }
  destroy() {
    this.canvas.removeEventListener('pointerdown', this._down);
    this.canvas.removeEventListener('pointermove', this._move);
    window.removeEventListener('pointerup', this._up);
    window.removeEventListener('pointercancel', this._up);
  }
}
