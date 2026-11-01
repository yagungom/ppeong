// 온라인 랭킹 API (Supabase RPC 3개만 호출, 테이블 직접 접근 없음)
//  와르르 캐치와 같은 Supabase 프로젝트를 쓰고, 승부차기 함수(pk_*)만 부름
import { CONFIG } from './config.js';

function validUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password; } catch { return false; }
}

export const online = {
  get enabled() { return validUrl(CONFIG.SUPABASE_URL) && typeof CONFIG.SUPABASE_KEY === 'string' && CONFIG.SUPABASE_KEY.length > 20; },

  async rpc(fn, body, timeoutMs = 7000) {
    if (!this.enabled) throw new Error('offline');
    const key = CONFIG.SUPABASE_KEY;
    const headers = { 'Content-Type': 'application/json', apikey: key };
    // 예전 형식(anon JWT) 키만 Authorization 헤더에 넣음. 새 publishable 키는 apikey 헤더만 사용
    if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${CONFIG.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', mode: 'cors',
      });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
      if (!res.ok) {
        // 함수가 없으면(404) 아직 supabase/schema.sql 을 실행하지 않은 것
        const msg = res.status === 404 ? 'server_update' : (data && (data.message || data.hint)) || `http_${res.status}`;
        throw Object.assign(new Error(msg), { code: msg, status: res.status });
      }
      return data;
    } finally { clearTimeout(timer); }
  },

  startSession(mode, team, input = 'camera') { return this.rpc('pk_start_session', { p_mode: mode, p_team: team, p_input: input }); },
  // 점수와 슛 10개 결과(G 골 · C 구석 골 · S 선방 · O 넘김)를 보내면 서버가 점수를 다시 계산해 비교
  submit(sessionId, r) { return this.rpc('pk_submit_score', { p_session: sessionId, p_score: r.score, p_log: r.log }); },
  board(mode, period, myScore = null, input = 'camera') {
    return this.rpc('pk_get_leaderboard', { p_mode: mode, p_period: period, p_score: myScore, p_input: input });
  },
};

export function errorText(code) {
  const map = {
    bad_mode: '난이도 정보가 올바르지 않아요',
    server_update: '랭킹 서버 준비가 필요해요 (supabase/schema.sql 실행)',
    rate_limited: '잠시 후 다시 시도해 주세요 (요청이 너무 많아요)',
    banned_name: '이 팀 이름은 온라인 랭킹에 쓸 수 없어요',
    bad_name_length: '팀 이름 길이를 확인해 주세요',
    bad_name_chars: '팀 이름에 쓸 수 없는 글자가 있어요',
    bad_name_digits: '팀 이름에 숫자가 너무 길어요',
    invalid_session: '기록 등록 시간이 지났어요',
    implausible: '기록을 확인할 수 없어 온라인 등록을 건너뛰었어요',
    offline: '온라인 랭킹이 아직 설정되지 않았어요',
  };
  return map[code] || '온라인 연결이 원활하지 않아요';
}
