// ─────────────────────────────────────────────────────────────
//  뻥! 승부차기 설정 파일 — 숫자를 바꾸고 싶으면 여기만 고치면 됩니다.
// ─────────────────────────────────────────────────────────────

export const CONFIG = Object.freeze({
  // 사람 분리(배경 합성) 모델과 자세 인식 모델. 이 폴더에 같이 들어 있어 외부 서버를 부르지 않습니다.
  MODEL: { path: 'models/selfie_segmentation.tflite', kind: 'person' },
  POSE_MODELS: { full: 'models/pose_landmarker_full.task', lite: 'models/pose_landmarker_lite.task' },
  MAX_PEOPLE: 4,            // 이만큼 찾아본 뒤
  SINGLE_PLAYER: true,      // 차는 사람 한 명만 골라서 화면에 보여 주고 판정 (가운데에 선 사람, 차례마다 다시 고름)
  WASM_PATH: 'vendor/mediapipe/wasm',

  // 카메라 속 사람을 화면에 그리는 크기·위치
  //  골대가 사람에게 가리지 않게 조금 작게 줄여 화면 아래쪽에 붙여 그립니다 (1 = 화면 꽉 차게)
  PERSON_SCALE: 0.74,

  // true 면 카메라 없이 손가락(터치)으로만 플레이 (미리보기용)
  FORCE_TOUCH: false,

  // 화면 기준 해상도 (16:9 고정, TV 미러링용)
  W: 1280,
  H: 720,
});

// 한 판 규칙
export const RULES = Object.freeze({
  SHOTS: 10,               // 한 판에 차는 횟수
  GOAL_POINTS: 100,        // 골 1개
  CORNER_BONUS: 50,        // 위쪽 구석(왼쪽·오른쪽 + 높게)에 넣으면 추가
  STREAK_BONUS: 20,        // 연속 골: 2연속부터 (연속 수 − 1) × 20 추가
  AIM_HOLD_SEC: 0.5,       // 방향 풍선에 손을 이만큼 대고 있으면 선택
  RESULT_SEC: 2.2,         // 골/선방 연출 시간
  ABSENT_PAUSE_MS: 4000,   // 화면에 사람이 없으면 이 시간 뒤 자동 일시정지
});

// 발차기 판정 (단위: 다리 길이/초 — 엉덩이~발목 길이를 1로 봄. 멀리 서든 가까이 서든 같은 기준)
//  trigger: 발이 이보다 빨리 움직이면서 반대쪽 발보다 lift 만큼 올라가면 '슛'
//  low~high: 이 사이 속도를 0~1 세기로 바꿈 (0 = 땅볼, 0.5 = 가운데 높이, 1 = 위쪽 구석)
//  over: 이보다 빠르면 크로스바 위로 (일반 모드만)
//  ⚙️ 설정 → '성능 정보 표시'를 켜면 화면에 발 속도가 나오니, 우리 집 아이에 맞게 조절해 보세요.
export const KICK = Object.freeze({
  normal: { trigger: 1.2, lift: 0.1, low: 1.2, high: 6.0, over: 8.5 },
  baby: { trigger: 0.8, lift: 0.05, low: 0.8, high: 4.0, over: Infinity },
  windowMs: 260,           // 슛 시작 뒤 이 시간 동안 가장 빠른 속도를 세기로 씀
  cooldownMs: 900,         // 한 번 찬 뒤 다시 인식하기까지
});

// 난이도: 키퍼가 같은 방향으로 뛸 확률, 같은 방향일 때 높이별로 막을 확률
export const DIFFICULTY = Object.freeze({
  normal: { label: '일반', sameDir: 1 / 3, reach: { low: 0.95, mid: 0.7, high: 0.3 }, overBar: true },
  baby: { label: '아기 모드', sameDir: 0.15, reach: { low: 0.6, mid: 0.4, high: 0.1 }, overBar: false },
});

// 화질 프리셋: 사람 분리 입력 크기 + 자세 인식 입력 크기·모델
//  발차기는 빠른 동작이라 기본값을 '고화질'(가벼운 모델, 큰 입력)으로 둠
export const QUALITY = Object.freeze({
  best: { segW: 384, segH: 216, poseW: 640, poseH: 360, pose: 'full', label: '최고' },
  high: { segW: 384, segH: 216, poseW: 512, poseH: 288, pose: 'lite', label: '고화질' },
  normal: { segW: 288, segH: 162, poseW: 448, poseH: 252, pose: 'lite', label: '표준' },
  low: { segW: 224, segH: 126, poseW: 384, poseH: 216, pose: 'lite', label: '절전' },
});
