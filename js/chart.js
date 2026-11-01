// 랭킹 화면: 상위 N% + 점수 분포(기록이 적으면 팀별 점, 많으면 막대그래프) + TOP 10 표
import { el, formatNum, kstDateLabel } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };

export function renderBoard(root, board, { myScore = null, myTeam = null, scopeLabel = '' } = {}) {
  root.replaceChildren();
  if (!board || board.total === 0) {
    root.append(el('div', { class: 'board-empty' },
      el('div', { class: 'big', text: '🏁' }),
      el('div', { text: '아직 기록이 없어요' }),
      el('div', { class: 'sub', text: '첫 기록의 주인공이 되어 보세요!' })));
    return;
  }

  // 요약
  const head = el('div', { class: 'board-head' });
  if (myScore != null && board.my_rank) {
    // 상위 N% = 내 순위 ÷ 전체 (1등이면 가장 작은 값). 기록이 나 하나면 '첫 기록'
    const pct = Math.max(1, Math.ceil(board.my_rank / board.total * 100));
    head.append(
      board.total === 1
        ? el('div', { class: 'pct first' }, el('b', { text: '🎉 첫 기록!' }))
        : el('div', { class: 'pct' }, el('span', { class: 'pct-label', text: board.my_rank === 1 ? '🏆 상위' : '상위' }), el('b', { text: `${pct}%` })),
      el('div', { class: 'rank-line', text: `${scopeLabel} ${formatNum(board.total)}팀 중 ${formatNum(board.my_rank)}등` }),
    );
  } else {
    head.append(el('div', { class: 'rank-line', text: `${scopeLabel} 기록 ${formatNum(board.total)}개 · 최고 ${formatNum(board.max)}점` }));
  }
  root.append(head);

  const body = el('div', { class: 'board-body' });
  body.append(board.total < 20 ? dotPlot(board, myScore) : histogram(board, myScore), table(board, myTeam, myScore));
  root.append(body);
}

// 기록이 적을 때: 팀 하나 = 점 하나. 같은 구간이면 위로 쌓음 (내 팀은 빨간 큰 점)
function dotPlot(board, myScore) {
  const wrap = el('div', { class: 'hist card-inner' });
  wrap.append(el('div', { class: 'card-title', text: '점수 분포 · 점 하나가 한 팀' }));
  const W = 640, H = 230, L = 24, R = 616, B = 176;
  const step = board.step, maxX = Math.max(board.max, myScore || 0, step) * 1.06;
  const X = (v) => L + (v / maxX) * (R - L);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hist-svg', role: 'img', 'aria-label': '팀별 점수 점 그래프' });
  svg.append(svgEl('line', { x1: L, x2: R, y1: B, y2: B, class: 'axis' }));
  const tip = el('div', { class: 'tip', hidden: true });
  // 내 점수가 들어 있는 구간에서는 한 팀을 '우리 팀' 점으로 따로 그림
  const myBin = myScore == null ? -1 : Math.floor(myScore / step);
  let mineLeft = myScore != null;
  for (const { b, c } of board.bins) {
    let n = c;
    if (mineLeft && b === myBin) { n--; mineLeft = false; }
    for (let k = 0; k < n; k++) {
      const cx = X((b + 0.5) * step), cy = B - 14 - k * 24;
      const dot = svgEl('circle', { cx, cy, r: 10, class: 'dot' });
      const show = () => { tip.textContent = `${formatNum(b * step)}~${formatNum((b + 1) * step - 1)}점`; tip.hidden = false; tip.style.left = `${(cx / W) * 100}%`; };
      dot.addEventListener('pointerenter', show); dot.addEventListener('pointerdown', show);
      dot.addEventListener('pointerleave', () => { tip.hidden = true; });
      svg.append(dot);
    }
  }
  if (myScore != null) {
    const mx = X(myScore);
    svg.append(svgEl('line', { x1: mx, x2: mx, y1: 30, y2: B, class: 'marker' }));
    svg.append(svgEl('circle', { cx: mx, cy: B - 14, r: 14, class: 'dot mine' }));
    const g = svgEl('g', { transform: `translate(${Math.min(R - 46, Math.max(L + 46, mx))},22)` });
    g.append(svgEl('rect', { x: -46, y: -14, width: 92, height: 28, rx: 14, class: 'marker-pill' }));
    const t = svgEl('text', { x: 0, y: 5, 'text-anchor': 'middle', class: 'marker-text' }); t.textContent = '우리 팀';
    g.append(t); svg.append(g);
  }
  // 축 눈금: 0, 중간, 최대
  for (const v of [0, maxX / 2, maxX]) {
    const t = svgEl('text', { x: X(v), y: B + 24, class: 'tick', 'text-anchor': v === 0 ? 'start' : v === maxX ? 'end' : 'middle' });
    t.textContent = formatNum(Math.round(v / 10) * 10); svg.append(t);
  }
  const lo = svgEl('text', { x: L, y: H - 4, class: 'tick dim', 'text-anchor': 'start' }); lo.textContent = '← 낮은 점수';
  const hi = svgEl('text', { x: R, y: H - 4, class: 'tick dim', 'text-anchor': 'end' }); hi.textContent = '높은 점수 →';
  svg.append(lo, hi);
  wrap.append(el('div', { class: 'hist-box' }, svg, tip));
  return wrap;
}

function histogram(board, myScore) {
  const wrap = el('div', { class: 'hist card-inner' });
  wrap.append(el('div', { class: 'card-title', text: '점수 분포' }));
  const W = 640, H = 230, L = 16, R = 624, T = 34, B = 188;
  const step = board.step;
  const counts = new Map(board.bins.map((x) => [x.b, x.c]));
  const maxB = Math.max(Math.floor(Math.max(board.max, myScore || 0) / step), 7);
  const n = maxB + 1;
  const maxC = Math.max(1, ...board.bins.map((x) => x.c));
  const bw = (R - L) / n;
  const myBin = myScore == null ? -1 : Math.floor(myScore / step);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hist-svg', role: 'img', 'aria-label': '점수 분포 막대그래프' });
  // 격자(아주 연하게)
  for (const f of [0.5, 1]) svg.append(svgEl('line', { x1: L, x2: R, y1: B - (B - T) * f, y2: B - (B - T) * f, class: 'grid' }));
  const tip = el('div', { class: 'tip', hidden: true });

  for (let b = 0; b < n; b++) {
    const c = counts.get(b) || 0;
    const x = L + b * bw + 1, w = Math.max(2, bw - 2);
    const h = c ? Math.max(4, (c / maxC) * (B - T)) : 0;
    const mine = b === myBin;
    if (h) {
      const r = Math.min(4, w / 2), y = B - h;
      const d = `M${x},${B} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${B} Z`;
      svg.append(svgEl('path', { d, class: mine ? 'bar mine' : 'bar' }));
    }
    const hit = svgEl('rect', { x: L + b * bw, y: T - 10, width: bw, height: B - T + 10, class: 'hit' });
    const show = () => {
      tip.textContent = `${formatNum(b * step)}~${formatNum((b + 1) * step - 1)}점 · ${c}팀`;
      tip.hidden = false;
      tip.style.left = `${((L + b * bw + bw / 2) / W) * 100}%`;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    svg.append(hit);
  }
  svg.append(svgEl('line', { x1: L, x2: R, y1: B, y2: B, class: 'axis' }));

  // x축 눈금 (최대 6개)
  const every = Math.ceil(n / 6);
  for (let b = 0; b <= n; b += every) {
    const tx = L + b * bw;
    const t = svgEl('text', { x: tx, y: B + 24, class: 'tick', 'text-anchor': b === 0 ? 'start' : tx > R - 30 ? 'end' : 'middle' });
    t.textContent = formatNum(b * step);
    svg.append(t);
  }

  // 우리 팀 위치 표시
  if (myScore != null) {
    const mx = L + (myScore / step) * bw;
    svg.append(svgEl('line', { x1: mx, x2: mx, y1: T - 4, y2: B, class: 'marker' }));
    const g = svgEl('g', { transform: `translate(${Math.min(R - 46, Math.max(L + 46, mx))},${T - 16})` });
    g.append(svgEl('rect', { x: -46, y: -14, width: 92, height: 28, rx: 14, class: 'marker-pill' }));
    const t = svgEl('text', { x: 0, y: 5, 'text-anchor': 'middle', class: 'marker-text' }); t.textContent = '우리 팀';
    g.append(t); svg.append(g);
  }
  wrap.append(el('div', { class: 'hist-box' }, svg, tip));
  return wrap;
}

function table(board, myTeam, myScore) {
  const wrap = el('div', { class: 'top card-inner' });
  wrap.append(el('div', { class: 'card-title', text: 'TOP 10' }));
  const tb = el('table', { class: 'top-table' });
  tb.append(el('thead', {}, el('tr', {}, el('th', { text: '순위' }), el('th', { text: '팀' }), el('th', { text: '점수' }), el('th', { text: '골' }), el('th', { text: '날짜' }))));
  const body = el('tbody');
  const medal = ['🥇', '🥈', '🥉'];
  let markedMine = false;
  for (const r of board.top) {
    const mine = !markedMine && myTeam && r.team === myTeam && (myScore == null || r.score === myScore);
    if (mine) markedMine = true;
    body.append(el('tr', { class: mine ? 'mine' : '' },
      el('td', { class: 'rk', text: medal[r.rank - 1] || String(r.rank) }),
      el('td', { class: 'tm', text: r.team }),
      el('td', { class: 'sc', text: formatNum(r.score) }),
      el('td', { class: 'stg', text: `${r.goals}/${r.shots}` }),
      el('td', { class: 'dt', text: kstDateLabel(r.at) }),
    ));
  }
  tb.append(body);
  wrap.append(tb);
  return wrap;
}
