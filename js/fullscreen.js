// 전체화면: 브라우저·OS마다 방식이 달라서 "기능 감지"로 처리
//  - 안드로이드 크롬/삼성 인터넷, PC 크롬·엣지·파이어폭스, 맥·아이패드 사파리 → Fullscreen API (+ 안드로이드는 가로 고정)
//  - 아이폰(사파리·크롬 모두 WebKit) → 웹페이지 전체화면 미지원 → "홈 화면에 추가" 안내
//  - 이미 홈 화면 앱(전체화면/standalone)으로 실행 중이면 버튼 숨김
const ua = navigator.userAgent;
const root = document.documentElement;

export const platform = (() => {
  const iPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const iPhone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua);
  return {
    iPhone, iPad, iOS: iPhone || iPad, android,
    mac: !iPad && /Macintosh/.test(ua),
    windows: /Windows/.test(ua),
    desktop: !iPhone && !iPad && !android && !/Mobi/.test(ua),
    iosChrome: /CriOS/.test(ua),
    samsung: /SamsungBrowser/.test(ua),
  };
})();

export function isStandalone() {
  try {
    return navigator.standalone === true
      || matchMedia('(display-mode: fullscreen)').matches
      || matchMedia('(display-mode: standalone)').matches;
  } catch { return false; }
}

export function supported() {
  return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled)
    && !!(root.requestFullscreen || root.webkitRequestFullscreen || root.webkitRequestFullScreen);
}

export function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

export async function enter() {
  if (!supported()) return false;
  try {
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    else root.webkitRequestFullScreen();
  } catch { return false; }
  if (platform.android) { try { await screen.orientation?.lock?.('landscape'); } catch { /* 지원 안 하면 무시 */ } }
  return true;
}

export async function exit() {
  try { screen.orientation?.unlock?.(); } catch { /* noop */ }
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch { /* noop */ }
}

export function toggle() { return isFullscreen() ? exit() : enter(); }

export function onChange(fn) {
  document.addEventListener('fullscreenchange', fn);
  document.addEventListener('webkitfullscreenchange', fn);
}

// 키보드 단축키 안내 (PC 브라우저 자체 전체화면)
export function keyHint() {
  if (platform.mac) return '⌃⌘F';
  if (platform.desktop) return 'F11';
  return '';
}

// 버튼으로 전체화면이 안 되는 환경의 안내문
export function guide() {
  if (platform.iPhone) {
    return {
      title: '아이폰은 이렇게 전체화면으로!',
      note: '아이폰은 애플 정책상 웹페이지 전체화면 버튼이 동작하지 않아요. 대신 홈 화면 앱으로 실행하면 주소창 없이 꽉 찬 화면이 돼요.',
      steps: platform.iosChrome
        ? ['주소창 오른쪽의 공유 버튼(□↑)을 눌러요', '"홈 화면에 추가"를 눌러요', '홈 화면에 생긴 "뻥! 승부차기" 아이콘으로 실행해요']
        : ['사파리 아래쪽 공유 버튼(□↑)을 눌러요', '목록에서 "홈 화면에 추가"를 눌러요', '홈 화면에 생긴 "뻥! 승부차기" 아이콘으로 실행해요'],
    };
  }
  const key = keyHint();
  return {
    title: '전체화면을 지원하지 않는 브라우저예요',
    note: key ? `키보드 ${key} 를 눌러 브라우저 전체화면으로 해 보세요.` : '크롬이나 삼성 인터넷으로 열면 전체화면 버튼이 동작해요.',
    steps: [],
  };
}
