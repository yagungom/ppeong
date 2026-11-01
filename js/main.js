// 뻥! 승부차기 — 화면 흐름 담당
import { CONFIG, DIFFICULTY, RULES } from './config.js';
import { $, $$, el, store, formatNum } from './util.js';
import { Engine } from './game.js';
import { Sound } from './audio.js';
import { CameraVision, TouchInput } from './vision.js';
import { validateName } from './nickname.js';
import { addLocal, localBoard, normalizeOnline, clearLocal } from './ranking.js';
import { online, errorText } from './api.js';
import { renderBoard } from './chart.js';
import * as fs from './fullscreen.js';

const params = new URLSearchParams(location.search);
const canvas = $('#game');
const sound = new Sound();
const engine = new Engine(canvas, sound);

// ── 설정 ──
const DEFAULTS = { play: 'camera', facing: 'environment', difficulty: 'normal', mirror: true, sfx: true, quality: 'high', cameraId: '', debug: false };
const settings = { ...DEFAULTS, ...store.get('pk.settings.v1', {}) };
const saveSettings = () => store.set('pk.settings.v1', settings);
const applySettings = () => {
  sound.sfxOn = settings.sfx; sound.bgmOn = false;
  engine.debug = settings.debug || params.has('debug');
  if (vision) vision.mirror = settings.mirror;
};

let vision = null;          // CameraVision (재사용)
let team = '';
let lastResult = null;
let sessionPromise = null;
let loadCancelled = false;
let wakeLock = null;

// ── 화면 전환 ──
function show(name) {
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === `scr-${name}`));
  document.body.dataset.screen = name;
}

// ── 타이틀 ──
const teamInput = $('#team');
const teamErr = $('#team-err');
const recent = () => store.get('pk.teams.v1', []).filter((t) => typeof t === 'string' && validateName(t).ok).slice(0, 6);

function renderRecent() {
  const box = $('#recent'); box.replaceChildren();
  for (const t of recent()) {
    box.append(el('button', { type: 'button', class: `chip${t === teamInput.value ? ' on' : ''}`, text: t, onclick: () => { teamInput.value = t; teamErr.textContent = ''; renderRecent(); } }));
  }
}
function saveRecent(t) { store.set('pk.teams.v1', [t, ...recent().filter((x) => x !== t)].slice(0, 6)); }

function renderMode() {
  $$('.seg-btn[data-play]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.play === settings.play)));
  $('#facing-row').hidden = settings.play !== 'camera';
  $$('.seg-btn[data-facing]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.facing === settings.facing)));
  $$('.seg-btn[data-diff]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.diff === settings.difficulty)));
  checkRotate();
}
$$('.seg-btn[data-play]').forEach((b) => b.addEventListener('click', () => { settings.play = b.dataset.play; saveSettings(); renderMode(); }));
$$('.seg-btn[data-facing]').forEach((b) => b.addEventListener('click', () => { settings.facing = b.dataset.facing; settings.cameraId = ''; saveSettings(); renderMode(); }));
$$('.seg-btn[data-diff]').forEach((b) => b.addEventListener('click', () => { settings.difficulty = b.dataset.diff; saveSettings(); renderMode(); }));
teamInput.addEventListener('input', () => { teamErr.textContent = ''; renderRecent(); });

function goTitle() {
  if (vision) vision.stopCamera(); // 카메라는 쓰지 않을 때 바로 끔
  engine.setInput(null); engine.retryTarget = null;
  releaseWake();
  engine.showTitle();
  teamInput.value = teamInput.value || recent()[0] || '';
  renderRecent(); renderMode();
  show('title');
}
$('#start-form').addEventListener('submit', (e) => { e.preventDefault(); startGame(); });

// ── 전체화면 (OS·브라우저별 처리는 fullscreen.js) ──
const NS = 'http://www.w3.org/2000/svg';
function fsIcon(exit) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', exit ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5');
  p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2.6');
  p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  svg.append(p); return svg;
}
function renderFsButtons() {
  const on = fs.isFullscreen();
  const hide = fs.isStandalone() && !on && (!fs.supported() || fs.platform.iOS);
  const key = fs.keyHint(), label = on ? '창 모드' : '전체화면';
  for (const b of $$('[data-fs]')) {
    b.hidden = hide;
    b.replaceChildren(fsIcon(on));
    if (b.classList.contains('fs-title')) b.append(el('span', { class: 'fs-label', text: label }));
    b.title = key ? `${label} (${key})` : label;
    b.setAttribute('aria-label', label);
  }
}
let fsGuideBack = 'title';
function openFsGuide() {
  if (engine.state === 'play') engine.pause();
  const g = fs.guide();
  fsGuideBack = engine.state === 'paused' ? 'pause' : (document.body.dataset.screen || 'title');
  $('#fsguide-title').textContent = g.title;
  $('#fsguide-note').textContent = g.note;
  $('#fsguide-steps').replaceChildren(...g.steps.map((t) => el('li', { text: t })));
  show('fsguide');
}
$('#fsguide-close').addEventListener('click', () => show(fsGuideBack));
$$('[data-fs]').forEach((b) => b.addEventListener('click', async () => {
  sound.unlock();
  if (fs.isFullscreen()) { await fs.exit(); return; }
  const ok = await fs.enter();
  if (!ok || !fs.isFullscreen()) { await new Promise((r) => setTimeout(r, 300)); if (!fs.isFullscreen()) openFsGuide(); }
}));
fs.onChange(renderFsButtons);
window.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
  if (fs.supported()) fs.toggle();
});
async function enterFullscreen() { if (fs.supported() && !fs.isFullscreen()) await fs.enter(); }
async function requestWake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); } } catch { /* noop */ }
}
function releaseWake() { try { wakeLock?.release(); } catch { /* noop */ } wakeLock = null; }

function readTeam() {
  const v = validateName(teamInput.value.trim() || '우리 가족');
  if (!v.ok) { teamErr.textContent = v.reason; teamInput.focus(); return null; }
  return v.name;
}

// ── 게임 시작 ──
async function startGame() {
  const t = readTeam(); if (!t) return;
  team = t; saveRecent(team);
  sound.unlock();
  enterFullscreen();
  requestWake();
  if (settings.play === 'touch' || params.has('touch') || CONFIG.FORCE_TOUCH) return startTouchGame();
  loadCancelled = false;
  show('loading'); $('#loading-text').textContent = '카메라 켜는 중… (권한을 허용해 주세요)';
  try {
    if (!vision) vision = new CameraVision({ quality: settings.quality, mirror: settings.mirror });
    vision.mirror = settings.mirror;
    try { await vision.startCamera({ deviceId: settings.cameraId || null, facing: settings.facing }); }
    catch (e) {
      if (!settings.cameraId || e?.name === 'NotAllowedError') throw e;
      settings.cameraId = ''; saveSettings();
      await vision.startCamera({ facing: settings.facing });
    }
    if (loadCancelled) { vision.stopCamera(); return; }
    await vision.init((msg) => { $('#loading-text').textContent = msg.replace('손 인식', '손·발 인식'); });
    if (loadCancelled) { vision.stopCamera(); return; }
    engine.setInput(vision);
    enterLobby();
  } catch (e) {
    console.warn(e);
    if (vision) vision.stopCamera();
    showCamError(e);
  }
}

function startTouchGame() {
  if (vision) vision.stopCamera();
  engine.setInput(new TouchInput(canvas));
  sound.unlock();
  enterLobby();
}

function showCamError(e) {
  const name = e?.name || '';
  let title = '카메라를 켤 수 없어요', text = '';
  if (name === 'NotAllowedError' || name === 'SecurityError') { title = '카메라 권한이 필요해요'; text = '주소창 옆 자물쇠 → 권한 → 카메라 허용 후 다시 시도해 주세요. 영상은 이 기기 밖으로 나가지 않아요.'; }
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') { text = '카메라를 찾지 못했어요. 설정에서 카메라를 "자동"으로 바꿔 보세요.'; settings.cameraId = ''; saveSettings(); }
  else if (name === 'NotReadableError') text = '다른 앱이 카메라를 쓰고 있어요. 그 앱을 닫고 다시 시도해 주세요.';
  else if (!window.isSecureContext) text = '카메라는 https 주소에서만 켜져요.';
  else text = '사람 인식 엔진을 불러오지 못했어요. 다시 시도해 주세요.';
  $('#camerr-title').textContent = title; $('#camerr-text').textContent = text;
  show('camerr');
}
$('#btn-cancel-load').addEventListener('click', () => { loadCancelled = true; goTitle(); });
$('#btn-cam-retry').addEventListener('click', () => startGame());
$('#btn-touch').addEventListener('click', () => startTouchGame());
$('#btn-cam-home').addEventListener('click', () => goTitle());

// ── 대기실 ──
function enterLobby() {
  engine.setDifficulty(settings.difficulty);
  engine.enterLobby();
  $('#btn-cam-switch').hidden = engine.input?.kind !== 'camera';
  show('lobby');
}
$('#btn-go').addEventListener('click', () => { sound.unlock(); toggleCamPicker(false); engine.startCountdown(); });
$('#btn-lobby-home').addEventListener('click', () => goTitle());

// 카메라 고르기 (전면·후면·광각 등)
const FRONT_RE = /front|user|전면|facetime/i, BACK_RE = /back|rear|environment|후면/i;
function camName(c, i, all) {
  const l = c.label || '';
  for (const [re, name] of [[FRONT_RE, '🤳 전면'], [BACK_RE, '📷 후면']]) {
    if (re.test(l)) { const same = all.filter((x) => re.test(x.label || '')); return same.length > 1 ? `${name} ${same.indexOf(c) + 1}` : name; }
  }
  return l ? l.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '') : `카메라 ${i + 1}`;
}
async function renderCamPicker() {
  const list = $('#cam-list');
  const cams = (await CameraVision.listCameras()).filter((c) => c.deviceId);
  list.replaceChildren();
  if (!cams.length) { list.append(el('div', { class: 'cam-tip', text: '카메라 목록을 가져오지 못했어요' })); return; }
  cams.forEach((c, i) => {
    const on = c.deviceId === vision?.deviceId;
    list.append(el('button', { type: 'button', class: `cam-item${on ? ' on' : ''}`, onclick: () => switchCamera(c) },
      el('span', { text: `${on ? '✔ ' : ''}${camName(c, i, cams)}` }), camName(c, i, cams) !== c.label ? el('small', { text: c.label || '' }) : null));
  });
}
async function switchCamera(c) {
  if (!vision || engine.input !== vision) return;
  try {
    await vision.startCamera({ deviceId: c.deviceId });
    settings.cameraId = c.deviceId;
    if (vision.facing === 'user' || FRONT_RE.test(c.label)) settings.facing = 'user';
    else if (vision.facing === 'environment' || BACK_RE.test(c.label)) settings.facing = 'environment';
    saveSettings();
  } catch (e) {
    console.warn(e);
    try { await vision.startCamera({ facing: settings.facing }); } catch { showCamError(e); return; }
  }
  renderCamPicker();
}
function toggleCamPicker(open) {
  const pk = $('#cam-picker'), btn = $('#btn-cam-switch');
  const on = open ?? pk.hidden;
  pk.hidden = !on; btn.setAttribute('aria-expanded', String(on));
  if (on) renderCamPicker();
}
$('#btn-cam-switch').addEventListener('click', () => toggleCamPicker());

// ── 경기 ──
engine.on('countdown', () => {
  toggleCamPicker(false); show('play');
  // 온라인 랭킹: 경기 시작 때 서버에서 1회용 세션을 받아 둠 (서버 시계로 경기 시간 확인)
  sessionPromise = online.enabled && engine.input
    ? online.startSession(engine.difficulty, team, engine.input.kind).then((id) => ({ id }), (err) => ({ err }))
    : null;
});
engine.on('gameOver', (res) => showResult(res));
engine.on('retry', () => retry());
const bubble = $('#retry-bubble');
engine.on('retryProgress', (p) => bubble.style.setProperty('--p', String(p)));

$('#btn-pause').addEventListener('click', () => { engine.pause(); show('pause'); });
$('#btn-resume').addEventListener('click', () => { engine.resume(); show('play'); });
$('#btn-quit').addEventListener('click', () => goTitle());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (engine.state === 'play') { engine.pause(); show('pause'); } }
  else if (engine.input) requestWake();
});

// ── 결과 ──
const resState = { period: 'day', scope: 'local' };
const diffLabel = (d) => (d === 'baby' ? '🍼 아기 모드' : '🙂 일반');

async function showResult(res) {
  lastResult = { ...res, team };
  addLocal({ team, mode: res.difficulty, score: res.score, goals: res.goals, shots: res.shots, corners: res.corners, bestStreak: res.bestStreak, input: res.input });
  const saves = res.results.filter((r) => r === 'save').length;
  $('#res-team').textContent = team;
  $('#res-goals').textContent = `${res.goals}골 / ${res.shots}번 · ${diffLabel(res.difficulty)}`;
  $('#res-score').textContent = formatNum(res.score);
  $('#res-goal').textContent = `${res.goals}개 (+${formatNum(res.goals * RULES.GOAL_POINTS)})`;
  $('#res-corner').textContent = res.corners ? `${res.corners}개 (+${formatNum(res.corners * RULES.CORNER_BONUS)})` : '-';
  $('#res-streak').textContent = res.bestStreak >= 2 ? `${res.bestStreak}연속` : '-';
  $('#res-save').textContent = saves ? `${saves}번` : '없음 👏';
  const note = $('#res-online'); note.className = 'res-online';
  const perfect = res.goals === res.shots ? '🏆 퍼펙트! ' : '';
  resState.period = 'day';
  resState.scope = online.enabled ? 'online' : 'local';
  show('result');
  setupRetryBubble(res.input);

  if (!online.enabled) note.textContent = `${perfect}💾 이 기기에 기록했어요`;
  else {
    note.textContent = '🌐 온라인 랭킹에 등록하는 중…';
    try {
      const s = await sessionPromise;
      if (!s || s.err) throw s?.err || new Error('offline');
      const r = await online.submit(s.id, res);
      if (r?.ok) { note.textContent = `${perfect}🎉 온라인 등록! 오늘 ${formatNum(r.day_total)}팀 중 ${formatNum(r.day_rank)}등`; note.classList.add('good'); }
      else note.textContent = `💾 이 기기에만 기록했어요 · ${errorText(r?.reason)}`;
    } catch (e) {
      note.textContent = `💾 이 기기에만 기록했어요 · ${errorText(e?.code || e?.message)}`;
    }
  }
  renderResultBoard();
}

function setupRetryBubble(mode) {
  bubble.classList.toggle('touch-mode', mode !== 'camera');
  $('#scr-result').classList.toggle('cam', mode === 'camera');
  bubble.style.setProperty('--p', '0');
  engine.retryTarget = null;
  if (mode !== 'camera') return;
  requestAnimationFrame(() => {
    const cr = canvas.getBoundingClientRect(), br = bubble.getBoundingClientRect();
    const k = canvas.width / cr.width;
    engine.retryTarget = { x: (br.left + br.width / 2 - cr.left) * k, y: (br.top + br.height / 2 - cr.top) * k, r: br.width / 2 * k };
  });
}
bubble.addEventListener('click', () => retry());

function renderResultBoard() {
  const r = lastResult; if (!r) return;
  makeTabs($('#res-period'), PERIODS, resState.period, (v) => { resState.period = v; renderResultBoard(); });
  makeTabs($('#res-scope'), scopes(), resState.scope, (v) => { resState.scope = v; renderResultBoard(); });
  loadBoard($('#res-board'), { scope: resState.scope, mode: r.difficulty, input: r.input, period: resState.period, myScore: r.score, myTeam: r.team });
}

function retry() {
  engine.retryTarget = null;
  if (engine.input) enterLobby(); else goTitle();
}
$('#btn-retry').addEventListener('click', () => retry());
$('#btn-home').addEventListener('click', () => goTitle());

// ── 기록 ──
const PERIODS = [{ value: 'day', label: '오늘' }, { value: 'week', label: '이번 주' }, { value: 'month', label: '이번 달' }];
const INPUTS = [{ value: 'camera', label: '📺 카메라' }, { value: 'touch', label: '📱 폰' }];
const scopes = () => [
  { value: 'online', label: online.enabled ? '🌐 전체' : '🌐 전체 (준비 중)', disabled: !online.enabled },
  { value: 'local', label: '🏠 우리 기기' },
];
const MODES = Object.entries(DIFFICULTY).map(([value, d]) => ({ value, label: value === 'baby' ? `🍼 ${d.label}` : `🙂 ${d.label}` }));

function makeTabs(box, items, current, onChange) {
  box.replaceChildren();
  box.setAttribute('role', 'tablist');
  for (const it of items) {
    box.append(el('button', {
      type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(it.value === current), disabled: it.disabled || null, text: it.label,
      onclick: () => { if (!it.disabled && it.value !== current) onChange(it.value); },
    }));
  }
}
let boardToken = 0;
async function loadBoard(box, { scope = 'local', mode, input = 'camera', period, myScore = null, myTeam = null }) {
  const token = ++boardToken;
  box.replaceChildren(el('div', { class: 'board-note', text: '불러오는 중…' }));
  let board;
  if (scope === 'online') {
    try { board = normalizeOnline(await online.board(mode, period, myScore, input)); }
    catch (e) { if (token === boardToken) box.replaceChildren(el('div', { class: 'board-note', text: errorText(e?.code || e?.message) })); return; }
  } else board = localBoard(mode, period, myScore, input);
  if (token !== boardToken) return;
  const tags = [input === 'touch' ? '폰 모드' : null, mode === 'baby' ? '아기 모드' : null].filter(Boolean);
  renderBoard(box, board, { myScore, myTeam, scopeLabel: `${scope === 'online' ? '전체' : '우리 기기'}${tags.length ? `(${tags.join('·')})` : ''}` });
}

const rankState = { input: 'camera', mode: 'normal', period: 'day', scope: 'local', from: 'title' };
function openRanking(from) {
  rankState.from = from;
  rankState.input = lastResult?.input || settings.play;
  rankState.mode = lastResult?.difficulty || settings.difficulty;
  rankState.scope = online.enabled ? 'online' : 'local';
  show('ranking');
  renderRanking();
}
function renderRanking() {
  makeTabs($('#rank-input'), INPUTS, rankState.input, (v) => { rankState.input = v; renderRanking(); });
  makeTabs($('#rank-mode'), MODES, rankState.mode, (v) => { rankState.mode = v; renderRanking(); });
  makeTabs($('#rank-period'), PERIODS, rankState.period, (v) => { rankState.period = v; renderRanking(); });
  makeTabs($('#rank-scope'), scopes(), rankState.scope, (v) => { rankState.scope = v; renderRanking(); });
  const mine = lastResult && lastResult.difficulty === rankState.mode && lastResult.input === rankState.input ? lastResult : null;
  loadBoard($('#rank-board'), { scope: rankState.scope, mode: rankState.mode, input: rankState.input, period: rankState.period, myScore: mine?.score ?? null, myTeam: mine?.team || team || null });
}
$('#btn-rank').addEventListener('click', () => openRanking('title'));
$('#rank-back').addEventListener('click', () => show(rankState.from === 'result' ? 'result' : 'title'));

// ── 하는 법 / 설정 ──
$('#btn-help').addEventListener('click', () => show('help'));
$('#help-back').addEventListener('click', () => show('title'));

async function openSettings() {
  $('#set-mirror').checked = settings.mirror;
  $('#set-sfx').checked = settings.sfx;
  $('#set-quality').value = settings.quality;
  $('#set-debug').checked = settings.debug;
  $('#set-online').textContent = online.enabled ? '켜짐 ✅' : '꺼짐 (config.js 설정 필요)';
  const sel = $('#set-camera');
  sel.replaceChildren(el('option', { value: '', text: settings.facing === 'user' ? '자동 (전면)' : '자동 (후면)' }));
  const cams = (await CameraVision.listCameras()).filter((c) => c.deviceId);
  if (!cams.some((c) => c.label)) sel.append(el('option', { value: '', disabled: true, text: '카메라를 한 번 켜면 목록이 보여요' }));
  else cams.forEach((c, i) => sel.append(el('option', { value: c.deviceId, text: camName(c, i, cams) })));
  sel.value = cams.some((c) => c.deviceId === settings.cameraId) ? settings.cameraId : '';
  show('settings');
}
$('#btn-settings').addEventListener('click', openSettings);
$('#settings-back').addEventListener('click', () => show('title'));
$('#set-camera').addEventListener('change', (e) => { settings.cameraId = e.target.value; saveSettings(); });
$('#set-mirror').addEventListener('change', (e) => { settings.mirror = e.target.checked; saveSettings(); applySettings(); });
$('#set-sfx').addEventListener('change', (e) => { settings.sfx = e.target.checked; saveSettings(); applySettings(); });
$('#set-debug').addEventListener('change', (e) => { settings.debug = e.target.checked; saveSettings(); applySettings(); });
$('#set-quality').addEventListener('change', (e) => {
  settings.quality = e.target.value; saveSettings();
  if (vision) { vision.stopCamera(); vision.setQuality(settings.quality); }
});

let confirmFn = null;
function confirmDialog(text, fn, back) {
  $('#confirm-text').textContent = text; confirmFn = () => { fn(); show(back); };
  $('#confirm-no').onclick = () => show(back);
  show('confirm');
}
$('#confirm-yes').addEventListener('click', () => confirmFn?.());
$('#btn-clear').addEventListener('click', () => confirmDialog('이 기기 기록을 모두 지울까요?', () => clearLocal(), 'settings'));

// ── 세로 화면 안내 (TV·가로 화면용 게임) ──
let rotateDismissed = false;
function checkRotate() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  $('#rotate-hint').hidden = !(portrait && !rotateDismissed);
}
window.matchMedia('(orientation: portrait)').addEventListener?.('change', checkRotate);
$('#rotate-dismiss').addEventListener('click', () => { rotateDismissed = true; checkRotate(); });

// ── 시작 ──
applySettings();
renderFsButtons();
goTitle();

if (params.has('test')) window.__pk = { engine, settings, get vision() { return vision; }, startTouchGame, show };
