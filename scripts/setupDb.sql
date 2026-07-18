-- =============================================================
-- 서울 재건축 알리미 DB 스키마
-- 실행 방법: Supabase 대시보드 > SQL Editor 에 전체 붙여넣기 > Run
-- 여러 번 실행해도 안전 (IF NOT EXISTS)
-- =============================================================

-- 사업장 마스터 (기준 데이터, source of truth)
-- 갱신 주체: collectors/seoulOpenData.js (정비몽땅 목록) 만
create table if not exists projects (
  id            bigint generated always as identity primary key,
  source_key    text unique not null,          -- 정비몽땅 사업장명+지번 기반 자연키
  gu            text not null,                 -- 자치구
  name          text not null,                 -- 사업장명 (조합/추진위 명칭)
  aliases       text[] default '{}',           -- 매칭용 별칭 (단지명 등)
  biz_type      text not null,                 -- 재건축|재개발|리모델링|가로주택 등
  stage         text not null,                 -- 표준 단계 (stages.js 정규화 값)
  stage_raw     text,                          -- 소스 원문 단계
  address       text,                          -- 대표지번
  first_seen_at timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists idx_projects_gu on projects (gu);
create index if not exists idx_projects_stage on projects (stage);

-- 단계 변화 이력 (diff 감지 시 기록)
create table if not exists stage_history (
  id           bigint generated always as identity primary key,
  project_id   bigint not null references projects (id),
  prev_stage   text,                           -- null = 신규 발견
  new_stage    text not null,
  detected_at  timestamptz default now(),
  evidence_url text                            -- 근거 (고시 URL 등)
);
create index if not exists idx_stage_history_detected on stage_history (detected_at);

-- 고시/공고/심의/공시
create table if not exists notices (
  id                bigint generated always as identity primary key,
  org               text not null,             -- cleanup|opengov|기타
  notice_type       text not null,             -- 고시공고|심의|총회공시|기타
  title             text not null,
  url               text unique not null,
  posted_at         date,
  matched_project_id bigint references projects (id),
  body_text         text,                      -- 본문 추출
  attachment_url    text,
  attachment_name   text,
  attachment_text   text,                      -- 첨부 판독 결과
  attachment_status text default '없음',        -- 추출성공|추출실패|없음
  signals           text[] default '{}',       -- 감지된 키워드: 창립총회, 조합설립인가 등
  created_at        timestamptz default now()
);
create index if not exists idx_notices_posted on notices (posted_at);

-- 뉴스/블로그 기사
create table if not exists articles (
  id                 bigint generated always as identity primary key,
  url                text unique not null,
  title              text not null,
  source             text not null,            -- naver_news|naver_blog
  published_at       timestamptz,
  matched_project_ids bigint[] default '{}',
  excerpt            text,
  created_at         timestamptz default now()
);
create index if not exists idx_articles_published on articles (published_at);

-- AI 분석 결과 (AI는 이 테이블에만 쓴다 — 제안 역할)
create table if not exists ai_analyses (
  id            bigint generated always as identity primary key,
  target_type   text not null,                 -- article|project|digest|weekly
  target_id     bigint,
  purpose       text not null,                 -- summary|momentum|noise|weekly_report
  model         text not null,
  result        jsonb not null,
  input_tokens  int default 0,
  output_tokens int default 0,
  cost_usd      numeric(10,6) default 0,
  created_at    timestamptz default now()
);
create index if not exists idx_ai_created on ai_analyses (created_at);

-- 관심단지 (사람이 봇 명령으로만 수정)
create table if not exists watchlist (
  id         bigint generated always as identity primary key,
  project_id bigint references projects (id),
  raw_name   text not null,                    -- 엑셀 원문 이름 (미매칭 시에도 보존)
  gu         text,
  memo       text,
  created_at timestamptz default now(),
  unique (raw_name)
);

-- 발송 이력 (중복 방지)
create table if not exists alerts (
  id            bigint generated always as identity primary key,
  alert_type    text not null,                 -- daily_digest|weekly_report|error|backup
  content_hash  text not null,                 -- 같은 내용 재발송 방지
  body          text,
  status        text default 'pending',        -- pending|sent|failed
  telegram_msg_id bigint,
  sent_at       timestamptz,
  created_at    timestamptz default now(),
  unique (alert_type, content_hash)
);

-- 수집 실행 로그
create table if not exists collection_runs (
  id          bigint generated always as identity primary key,
  source      text not null,                   -- seoulOpenData|cleanupNotices|naverNews|...
  started_at  timestamptz default now(),
  finished_at timestamptz,
  status      text default 'running',          -- running|ok|error
  items_new   int default 0,
  error_message text
);
create index if not exists idx_runs_started on collection_runs (started_at);

-- 설정 (key-value)
create table if not exists config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);

-- 기본 설정값
insert into config (key, value) values
  ('ai_monthly_budget_usd', '5'),
  ('allowed_chat_ids', '[948715186]'),
  ('news_extra_keywords', '["재건축", "조합설립", "추진위원회"]'),
  ('digest_hour_kst', '9')
on conflict (key) do nothing;

-- RLS: 서비스 롤 키로만 접근 (익명 접근 전면 차단)
alter table projects enable row level security;
alter table stage_history enable row level security;
alter table notices enable row level security;
alter table articles enable row level security;
alter table ai_analyses enable row level security;
alter table watchlist enable row level security;
alter table alerts enable row level security;
alter table collection_runs enable row level security;
alter table config enable row level security;
-- (정책을 만들지 않음 = anon/authenticated 접근 불가, service_role은 RLS 우회)
