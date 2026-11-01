// 팀 이름 규칙 (서버 supabase/schema.sql 의 private.check_team 과 같은 규칙)
// - 2~12자, 한글/영문/숫자/공백/_ - ♥ ★ 만
// - 숫자 7자리 이상 연속 금지 (전화번호 등 개인정보 방지)
// - 욕설·비하 표현 금지 (서버에도 같은 목록)
const ALLOWED = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _\-♥★]+$/u;

export const BANNED = [
  '시발', '씨발', '씨빨', '시빨', '씨바', 'ㅅㅂ', 'ㅆㅂ', 'ㅅ1ㅂ', '병신', '븅신', '빙신', 'ㅂㅅ', '개새', '개색', '개세', '새끼', '섀끼', 'ㅅㄲ',
  '좆', '존나', '졸라', 'ㅈㄴ', '지랄', 'ㅈㄹ', '미친', 'ㅁㅊ', '엠창', '니애미', '느금', '염병', '썅', '쌍년', '창녀', '걸레', '보지', '자지', '섹스', '야동',
  '일베', '메갈', '한남', '김치녀', '틀딱', '장애인새', '찐따', '애미', '애비',
  'fuck', 'shit', 'bitch', 'sex', 'porn', 'dick', 'pussy', 'nigger', 'nigga', 'slut', 'whore',
  'admin', '관리자', '운영자', '운영진',
];

export function normalizeName(raw) {
  return String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function compact(name) {
  return name.toLowerCase().replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-z0-9]/g, '');
}

export function validateName(raw) {
  const name = normalizeName(raw);
  const len = [...name].length;
  if (len < 2) return { ok: false, name, reason: '팀 이름은 2글자 이상이에요' };
  if (len > 12) return { ok: false, name, reason: '팀 이름은 12글자까지예요' };
  if (!ALLOWED.test(name)) return { ok: false, name, reason: '한글·영문·숫자만 쓸 수 있어요' };
  const k = compact(name);
  if (/[0-9]{7,}/.test(k)) return { ok: false, name, reason: '숫자는 6자리까지만 (전화번호 보호)' };
  if (BANNED.some((w) => k.includes(w))) return { ok: false, name, reason: '다른 이름을 써 주세요' };
  return { ok: true, name };
}
