-- ════════════════════════════════════════════════════════════════
--  뻥! 승부차기 온라인 랭킹 스키마 (Supabase)
--  사용법: Supabase 대시보드 → SQL Editor → 이 파일 전체 붙여넣기 → Run
--  여러 번 실행해도 안전합니다(idempotent).
--
--  ✅ 와르르 캐치와 같은 Supabase 프로젝트에 그대로 실행하면 됩니다.
--     승부차기 기록은 따로 저장(private.pk_*)되고, 와르르 캐치 기록은 건드리지 않습니다.
--     공용 부품(금지어·IP 해시·팀 이름 검사)은 와르르 캐치와 같은 내용이라 같이 써요.
--
--  랭킹: 방식(카메라/폰) × 난이도(일반/아기) × 기간(오늘/이번 주/이번 달, 한국시간)
--
--  보안 설계 (와르르 캐치와 같음)
--   · 테이블은 모두 private 스키마 → REST API 로 직접 읽기/쓰기 불가, RLS + 권한 회수
--   · 브라우저는 함수 3개만 호출: pk_start_session / pk_submit_score / pk_get_leaderboard
--   · 점수는 서버가 발급한 1회용 세션으로만 등록, 서버 시계로 플레이 시간 검증
--   · 슛 10개 결과를 받아 서버가 점수를 다시 계산해서 비교 (숫자만 바꿔 보내기 불가)
--   · 팀 이름 규칙·욕설 필터, IP 기준 요청 제한. IP 는 '날짜별 솔트 해시'로만, 2일만 보관
-- ════════════════════════════════════════════════════════════════

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema private from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema private from authenticated'; end if;
end $$;

-- ── 비밀 솔트 (IP 해시용, 외부 노출 없음) ──
create table if not exists private.app_secret (
  id   int primary key default 1 check (id = 1),
  salt text not null
);
insert into private.app_secret (id, salt)
values (1, encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (id) do nothing;

-- ── 금지어 (팀 이름) — 소문자·공백/기호 제거 후 부분일치로 검사 ──
create table if not exists private.banned_words (word text primary key);
insert into private.banned_words (word) values
  ('시발'),('씨발'),('씨빨'),('시빨'),('씨바'),('ㅅㅂ'),('ㅆㅂ'),('ㅅ1ㅂ'),('병신'),('븅신'),('빙신'),('ㅂㅅ'),('개새'),('개색'),('개세'),('새끼'),('섀끼'),('ㅅㄲ'),
  ('좆'),('존나'),('졸라'),('ㅈㄴ'),('지랄'),('ㅈㄹ'),('미친'),('ㅁㅊ'),('엠창'),('니애미'),('느금'),('염병'),('썅'),('쌍년'),('창녀'),('걸레'),('보지'),('자지'),('섹스'),('야동'),
  ('일베'),('메갈'),('한남'),('김치녀'),('틀딱'),('장애인새'),('찐따'),('애미'),('애비'),
  ('fuck'),('shit'),('bitch'),('sex'),('porn'),('dick'),('pussy'),('nigger'),('nigga'),('slut'),('whore'),
  ('admin'),('관리자'),('운영자'),('운영진')
on conflict do nothing;

-- ── 경기 세션 (1판 = 1세션, 1회만 점수 등록) ──
create table if not exists private.pk_sessions (
  id           uuid primary key default gen_random_uuid(),
  mode         text not null check (mode in ('normal', 'baby')),
  input        text not null check (input in ('camera', 'touch')),
  team_name    text not null,
  ip_hash      text not null,
  started_at   timestamptz not null default now(),
  submitted_at timestamptz
);
create index if not exists pk_sessions_ip_time_idx on private.pk_sessions (ip_hash, started_at desc);
create index if not exists pk_sessions_time_idx on private.pk_sessions (started_at);

-- ── 점수 ──
--  shots_log: 슛 10개 결과 (G = 골, C = 구석 골, S = 선방, O = 크로스바 넘김)
create table if not exists private.pk_scores (
  id           bigint generated always as identity primary key,
  mode         text not null check (mode in ('normal', 'baby')),
  input        text not null check (input in ('camera', 'touch')),
  team_name    text not null check (char_length(team_name) between 2 and 12),
  score        int not null check (score between 0 and 100000),
  goals        int not null check (goals between 0 and 50),
  shots        int not null check (shots between 1 and 50),
  corners      int not null default 0,
  best_streak  int not null default 0,
  shots_log    text not null,
  created_at   timestamptz not null default now(),
  hidden       boolean not null default false     -- 관리자가 부적절한 기록을 숨길 때
);
create index if not exists pk_scores_mode_input_time_idx  on private.pk_scores (mode, input, created_at desc);
create index if not exists pk_scores_mode_input_score_idx on private.pk_scores (mode, input, score desc);

alter table private.app_secret   enable row level security;
alter table private.banned_words enable row level security;
alter table private.pk_sessions  enable row level security;
alter table private.pk_scores    enable row level security;
revoke all on all tables in schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on all tables in schema private from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on all tables in schema private from authenticated'; end if;
end $$;

-- ════════════════ 공용 내부 함수 (와르르 캐치와 같은 내용) ════════════════

-- 막대그래프 구간 폭 (js/util.js niceStep 과 같은 규칙)
create or replace function private.nice_step(raw numeric)
returns int language plpgsql immutable set search_path = '' as $$
declare p numeric; f numeric; m numeric;
begin
  if raw is null or raw <= 1 then return 1; end if;
  p := power(10::numeric, floor(log(10::numeric, raw)));
  f := raw / p;
  m := case when f <= 1 then 1 when f <= 2 then 2 when f <= 2.5 then 2.5 when f <= 5 then 5 else 10 end;
  return ceil(m * p)::int;
end $$;

-- 요청 IP → 날짜별 솔트 해시 (원본 IP 는 저장하지 않음)
create or replace function private.client_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
declare h json; ip text; s text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  ip := coalesce(
    nullif(h ->> 'cf-connecting-ip', ''),
    nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
    nullif(h ->> 'x-real-ip', ''),
    'unknown');
  select a.salt into s from private.app_secret a where a.id = 1;
  return encode(extensions.digest(ip || '|' || to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD') || '|' || s, 'sha256'), 'hex');
end $$;

-- 팀 이름 검사 (js/nickname.js 와 같은 규칙). 통과하면 정규화된 이름을 돌려줌
create or replace function private.check_team(p text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare n text; k text;
begin
  n := btrim(regexp_replace(normalize(coalesce(p, ''), NFC), '\s+', ' ', 'g'));
  if char_length(n) < 2 or char_length(n) > 12 then raise exception 'bad_name_length' using errcode = '22023'; end if;
  if n !~ '^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _♥★-]+$' then raise exception 'bad_name_chars' using errcode = '22023'; end if;
  k := lower(regexp_replace(n, '[^가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9]', '', 'g'));
  if k ~ '[0-9]{7,}' then raise exception 'bad_name_digits' using errcode = '22023'; end if;
  if exists (select 1 from private.banned_words w where position(w.word in k) > 0) then
    raise exception 'banned_name' using errcode = '22023';
  end if;
  return n;
end $$;

-- 한국시간 기준 기간 시작 (주간은 월요일 시작)
create or replace function private.period_from(p_period text)
returns timestamptz language plpgsql stable set search_path = '' as $$
begin
  if p_period not in ('day', 'week', 'month') then raise exception 'bad_period' using errcode = '22023'; end if;
  return date_trunc(p_period, now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
end $$;

-- ════════════════ 승부차기 공개 함수 (브라우저가 호출) ════════════════

-- 1) 경기 시작: 1회용 세션 발급
create or replace function public.pk_start_session(p_mode text, p_team text, p_input text default 'camera')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_hash text; v_team text; v_id uuid; v_cnt int;
begin
  if p_mode is null or p_mode not in ('normal', 'baby') then raise exception 'bad_mode' using errcode = '22023'; end if;
  if p_input is null or p_input not in ('camera', 'touch') then raise exception 'bad_mode' using errcode = '22023'; end if;
  v_team := private.check_team(p_team);
  v_hash := private.client_ip_hash();

  select count(*) into v_cnt from private.pk_sessions
   where ip_hash = v_hash and started_at > now() - interval '1 minute';
  if v_cnt >= 12 then raise exception 'rate_limited' using errcode = 'P0001'; end if;
  select count(*) into v_cnt from private.pk_sessions
   where ip_hash = v_hash and started_at > now() - interval '1 hour';
  if v_cnt >= 240 then raise exception 'rate_limited' using errcode = 'P0001'; end if;

  insert into private.pk_sessions (mode, input, team_name, ip_hash) values (p_mode, p_input, v_team, v_hash)
  returning id into v_id;

  if random() < 0.05 then
    delete from private.pk_sessions where started_at < now() - interval '2 days';
  end if;
  return v_id;
end $$;

-- 2) 점수 등록: 세션당 1회. 슛 결과로 서버가 점수를 다시 계산 (js/config.js RULES 와 같은 숫자)
--    골 100 + 구석 골 50 + 연속 골(2연속부터) (연속 수 − 1) × 20
--    슛 10번, 한 슛에 최소 약 2.7초(공 날아가기 + 결과 연출) → 10번이면 25초보다 빨리 끝날 수 없음
create or replace function public.pk_submit_score(p_session uuid, p_score int, p_log text)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  s record; v_elapsed_ms bigint; v_pts int := 0; v_goals int := 0; v_corners int := 0; v_streak int := 0; v_best int := 0;
  ch text; v_rank int; v_total int; v_from timestamptz;
begin
  -- 세션 소모 (실패해도 다시 쓸 수 없음 → 숫자 바꿔가며 재시도 불가)
  update private.pk_sessions
     set submitted_at = now()
   where id = p_session and submitted_at is null and started_at > now() - interval '24 hours'
  returning mode, input, team_name, started_at into s;
  if not found then return json_build_object('ok', false, 'reason', 'invalid_session'); end if;

  if p_score is null or p_log is null or p_log !~ '^[GCSO]{10}$'
     or (s.mode = 'baby' and position('O' in p_log) > 0) then                    -- 아기 모드는 크로스바 넘김 없음
    return json_build_object('ok', false, 'reason', 'implausible');
  end if;

  for i in 1..char_length(p_log) loop
    ch := substr(p_log, i, 1);
    if ch in ('G', 'C') then
      v_streak := v_streak + 1; v_goals := v_goals + 1;
      v_pts := v_pts + 100 + (case when ch = 'C' then 50 else 0 end) + (case when v_streak >= 2 then (v_streak - 1) * 20 else 0 end);
      if ch = 'C' then v_corners := v_corners + 1; end if;
      v_best := greatest(v_best, v_streak);
    else
      v_streak := 0;
    end if;
  end loop;

  v_elapsed_ms := floor(extract(epoch from (now() - s.started_at)) * 1000)::bigint;
  if p_score <> v_pts or v_elapsed_ms < 25000 then
    return json_build_object('ok', false, 'reason', 'implausible');
  end if;

  insert into private.pk_scores (mode, input, team_name, score, goals, shots, corners, best_streak, shots_log)
  values (s.mode, s.input, s.team_name, p_score, v_goals, char_length(p_log), v_corners, v_best, p_log);

  v_from := private.period_from('day');
  select count(*) filter (where sc.score > p_score) + 1, count(*)
    into v_rank, v_total
    from private.pk_scores sc
   where sc.mode = s.mode and sc.input = s.input and sc.created_at >= v_from and not sc.hidden;

  return json_build_object('ok', true, 'day_rank', v_rank, 'day_total', v_total);
end $$;

-- 3) 랭킹: 방식 × 난이도 × 기간 → TOP10 + 점수 분포 + 내 순위
create or replace function public.pk_get_leaderboard(p_mode text, p_period text, p_score int default null, p_input text default 'camera')
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz; v_total int; v_max int; v_step int; v_top json; v_bins json; v_rank int;
begin
  if p_mode is null or p_mode not in ('normal', 'baby') then raise exception 'bad_mode' using errcode = '22023'; end if;
  if p_input is null or p_input not in ('camera', 'touch') then raise exception 'bad_mode' using errcode = '22023'; end if;
  v_from := private.period_from(p_period);

  select count(*), coalesce(max(sc.score), 0) into v_total, v_max
    from private.pk_scores sc where sc.mode = p_mode and sc.input = p_input and sc.created_at >= v_from and not sc.hidden;

  v_step := greatest(private.nice_step(greatest(v_max, 1) / 16.0), 10);

  -- 순위 = 나보다 높은 기록 수 + 1 (같은 점수는 공동 순위, '내 순위'와 같은 기준). 같은 순위끼리는 먼저 한 기록이 위
  select coalesce(json_agg(t order by t.rank, t.at), '[]'::json) into v_top from (
    select rank() over (order by sc.score desc) as rank,
           sc.team_name as team, sc.score, sc.goals, sc.shots, sc.created_at as at
      from private.pk_scores sc
     where sc.mode = p_mode and sc.input = p_input and sc.created_at >= v_from and not sc.hidden
     order by sc.score desc, sc.created_at asc
     limit 10) t;

  select coalesce(json_agg(json_build_object('b', x.b, 'c', x.c) order by x.b), '[]'::json) into v_bins from (
    select (sc.score / v_step) as b, count(*) as c
      from private.pk_scores sc
     where sc.mode = p_mode and sc.input = p_input and sc.created_at >= v_from and not sc.hidden
     group by 1) x;

  if p_score is not null then
    select count(*) + 1 into v_rank from private.pk_scores sc
     where sc.mode = p_mode and sc.input = p_input and sc.created_at >= v_from and not sc.hidden and sc.score > p_score;
  end if;

  return json_build_object('total', v_total, 'step', v_step, 'max', v_max, 'top', v_top, 'bins', v_bins, 'my_rank', v_rank);
end $$;

-- ── 실행 권한: 승부차기 공개 함수 3개 ──
revoke all on function public.pk_start_session(text, text, text) from public;
revoke all on function public.pk_submit_score(uuid, int, text) from public;
revoke all on function public.pk_get_leaderboard(text, text, int, text) from public;
revoke all on all functions in schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.pk_start_session(text, text, text) to anon';
    execute 'grant execute on function public.pk_submit_score(uuid, int, text) to anon';
    execute 'grant execute on function public.pk_get_leaderboard(text, text, int, text) to anon';
    execute 'revoke all on all functions in schema private from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.pk_start_session(text, text, text) to authenticated';
    execute 'grant execute on function public.pk_submit_score(uuid, int, text) to authenticated';
    execute 'grant execute on function public.pk_get_leaderboard(text, text, int, text) to authenticated';
    execute 'revoke all on all functions in schema private from authenticated';
  end if;
end $$;

-- ════════════════ 오래된 세션 자동 삭제 (예약 작업) ════════════════
--  화면 안내 '도배 방지용 IP는 2일만 보관'을 지키는 장치. 매시간 2일 지난 세션(IP 해시 포함)을 지웁니다.
--  (방문자가 없어도 실행됨. 세션을 만들 때 가끔 지우는 기존 정리는 보조로 그대로 둠)
--  pg_cron(예약 작업 확장)을 켜고 등록합니다. 같은 이름으로 다시 실행하면 덮어써서 중복되지 않아요.
--  pg_cron 을 켤 수 없으면 알림만 남기고 넘어갑니다(나머지 설치에는 영향 없음).
--  확인:  select jobname, schedule, active from cron.job;
--  실행 기록:  select jobid, status, start_time from cron.job_run_details order by start_time desc limit 10;
do $$ begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron 을 켜지 못했어요: %', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ppeong-session-cleanup', '17 * * * *',
      $job$delete from private.pk_sessions where started_at < now() - interval '2 days'$job$);
  else
    raise notice '세션 자동 삭제를 등록하지 못했어요 — Database → Extensions 에서 pg_cron 을 켠 뒤 이 파일을 다시 실행하세요';
  end if;
end $$;

-- ════════════════ 관리자용 (SQL Editor 에서 직접 실행) ════════════════
-- 최근 기록 보기:
--   select id, mode, input, team_name, score, goals, shots_log, created_at from private.pk_scores order by created_at desc limit 50;
-- 부적절한 팀 이름 숨기기:
--   update private.pk_scores set hidden = true where team_name = '문제되는이름';
-- 금지어 추가 (와르르 캐치와 같이 적용):
--   insert into private.banned_words(word) values ('추가할단어') on conflict do nothing;
