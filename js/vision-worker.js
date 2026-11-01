// 별도 처리(Web Worker): 무거운 인식을 여기서 돌려 게임 화면이 끊기지 않게
// 일반(classic) 워커로 띄움 → MediaPipe 가 엔진 파일을 importScripts 로 불러올 수 있음
let core = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const { VisionCore } = await import('./vision-core.js');
      core = new VisionCore(m.cfg);
      const info = await core.init((msg) => self.postMessage({ type: 'progress', msg }));
      self.postMessage({ type: 'ready', info });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (m.type === 'frame' && core) {
    let r;
    try { r = core.process(m.bitmap); } catch (err) { r = { error: String(err?.message || err) }; }
    try { m.bitmap.close(); } catch { /* noop */ }
    const transfer = [];
    if (r.rgba) transfer.push(r.rgba.buffer);
    if (r.cols) transfer.push(r.cols.buffer);
    self.postMessage({ type: 'result', id: m.id, ...r }, transfer);
  }
};
