// 공용 유틸
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function formatNum(n) { return Number(n || 0).toLocaleString('ko-KR'); }

// 한국시간 기준 기간 시작 시각(ms). 주간은 월요일 00:00 시작
const KST = 9 * 3600 * 1000;
export function periodStart(period, now = Date.now()) {
  const d = new Date(now + KST);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (period === 'day') return Date.UTC(y, m, day) - KST;
  if (period === 'week') { const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(y, m, day - dow) - KST; }
  return Date.UTC(y, m, 1) - KST;
}

export function kstDateLabel(ts) {
  const d = new Date(ts + KST);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// 막대그래프 구간 폭 (서버 SQL private.nice_step 과 동일한 규칙)
export function niceStep(raw) {
  if (!(raw > 1)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return Math.ceil(m * p);
}

// DOM 헬퍼: 사용자 입력은 항상 textContent 로만 넣는다 (XSS 방지)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// localStorage 안전 래퍼 (사생활 보호 모드 등에서 예외가 나도 게임은 계속)
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* noop */ } },
};

export function uid() {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}
