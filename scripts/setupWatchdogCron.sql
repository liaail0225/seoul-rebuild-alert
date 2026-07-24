-- =============================================================
-- Supabase pg_cron 워치독 설정 (D24, D25 참고)
-- 실행 방법: Supabase Management API의 database/query 엔드포인트로 실행
-- (SQL Editor에서도 실행 가능하나 vault.create_secret에 GitHub PAT을
--  평문으로 넣게 되므로, 실행 후 SQL Editor 히스토리에서 지우는 것을 권장)
--
-- 목적: GitHub Actions의 daily.yml `schedule` 트리거가 지연/누락되는 경우
-- (실측: 2026-07-20~21, GitHub 인프라 부하로 최대 2시간+ 지연 또는 완전 누락)
-- 를 감지해 강제로 재실행한다. pg_cron은 GitHub Actions 큐와 무관한
-- Postgres 자체 스케줄러라 이 문제에 영향받지 않는다.
--
-- 하루 최대 3회 시도(원 스케줄 1회 + 강제 재시도 최대 2회)로 상한을 둔다.
-- 실패가 반복돼도 무한정 재시도하지 않음(2026-07-24 스팸 사고 이후 추가된 안전장치).
-- =============================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- GitHub PAT(workflow scope 필요)을 Vault에 저장. __GITHUB_TOKEN__을 실제 토큰으로 치환 후 실행.
-- 이미 등록되어 있으면 아래 줄은 건너뛰거나 vault.update_secret 사용.
select vault.create_secret('__GITHUB_TOKEN__', 'github_pat', 'daily.yml 강제 실행용 GitHub PAT (workflow scope)');

select cron.schedule(
  'watchdog-trigger-daily',
  '*/15 0-3 * * *',  -- UTC 00:00~03:59 = KST 09:00~12:59, 15분마다
  $cron$
  select
    case when
      not exists (
        select 1 from collection_runs
        where source = 'daily' and status = 'ok'
          and (started_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
          and (started_at at time zone 'Asia/Seoul')::time >= time '09:00:00'
      )
      and (
        select count(*) from collection_runs
        where source = 'daily'
          and (started_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
          and (started_at at time zone 'Asia/Seoul')::time >= time '09:00:00'
      ) < 3
      and (now() at time zone 'Asia/Seoul')::time >= time '09:15:00'
    then
      net.http_post(
        url := 'https://api.github.com/repos/liaail0225/seoul-rebuild-alert/actions/workflows/daily.yml/dispatches',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_pat'),
          'Accept', 'application/vnd.github+json',
          'Content-Type', 'application/json',
          'User-Agent', 'supabase-pg-cron-watchdog'
        ),
        body := jsonb_build_object('ref', 'main')
      )
    end;
  $cron$
);

-- 점검용 조회
-- select jobid, schedule, jobname, active from cron.job;
-- select * from cron.job_run_details order by start_time desc limit 20;
-- 중단하려면: select cron.unschedule('watchdog-trigger-daily');
