// 우리 기기 기록 + 랭킹 데이터 형식 통일 (온라인 응답과 같은 모양)
import { store, periodStart, niceStep, uid } from './util.js';

const KEY = 'pk.records.v1';
const MAX = 1500;

export function loadLocal() {
  const arr = store.get(KEY, []);
  return Array.isArray(arr) ? arr.filter((r) => r && typeof r.score === 'number') : [];
}

export function addLocal(rec) {
  const arr = loadLocal();
  const row = { id: uid(), ts: Date.now(), ...rec };
  arr.push(row);
  if (arr.length > MAX) arr.splice(0, arr.length - MAX);
  store.set(KEY, arr);
  return row;
}

export function clearLocal() { store.remove(KEY); }

export function buildBoard(rows, myScore = null) {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.ts - b.ts);
  const max = sorted.length ? sorted[0].score : 0;
  let step = niceStep(Math.max(max, 1) / 16); if (step < 10) step = 10;
  const binMap = new Map();
  for (const r of rows) { const b = Math.floor(r.score / step); binMap.set(b, (binMap.get(b) || 0) + 1); }
  const bins = [...binMap.entries()].sort((a, b) => a[0] - b[0]).map(([b, c]) => ({ b, c }));
  // 순위 = 나보다 높은 기록 수 + 1 (같은 점수는 공동 순위 — 온라인 랭킹·'내 순위'와 같은 기준)
  const top = sorted.slice(0, 10).map((r) => ({ rank: sorted.findIndex((x) => x.score === r.score) + 1, team: r.team, score: r.score, goals: r.goals ?? 0, shots: r.shots ?? 10, at: r.ts }));
  const myRank = myScore == null ? null : sorted.filter((r) => r.score > myScore).length + 1;
  return { total: rows.length, step, max, top, bins, my_rank: myRank };
}

export function localBoard(mode, period, myScore = null, input = 'camera') {
  const from = periodStart(period);
  const rows = loadLocal().filter((r) => r.mode === mode && (r.input || 'camera') === input && r.ts >= from);
  return buildBoard(rows, myScore);
}

// 온라인 응답 정규화 (시간 문자열 → ms)
export function normalizeOnline(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    total: Number(data.total) || 0,
    step: Math.max(1, Number(data.step) || 10),
    max: Number(data.max) || 0,
    top: Array.isArray(data.top) ? data.top.map((t) => ({ ...t, at: Date.parse(t.at) || Date.now() })) : [],
    bins: Array.isArray(data.bins) ? data.bins.map((x) => ({ b: Number(x.b), c: Number(x.c) })) : [],
    my_rank: data.my_rank == null ? null : Number(data.my_rank),
  };
}
