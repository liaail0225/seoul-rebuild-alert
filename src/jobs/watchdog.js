// daily 워크플로 감시(watchdog) — GitHub Actions의 schedule 트리거가 지연/누락됐을 때
// 스스로 감지해 daily.yml을 강제 재실행한다.
// 배경: 런칭 직후 GitHub Actions 자체 인프라 부하로 schedule 트리거가 2일 연속
// 지연·누락되는 것을 실측(2026-07-20, 2026-07-21). 무료 요금제 예약 실행은 GitHub도
// "정시 보장 안 됨"이라 명시하므로, 짧은 주기(watchdog.yml)로 스스로 확인·복구한다.
import { fileURLToPath } from 'node:url';
import { getRecentRuns } from '../storage/db.js';

const KST_OFFSET_MS = 9 * 3600 * 1000;
const TRIGGER_DELAY_MS = 30 * 60 * 1000; // 09:00 KST 이후 이만큼 더 기다렸다가 없으면 강제 실행

// 오늘 daily를 강제 실행해야 하는지 판단하는 순수 함수 (테스트 대상).
// nowUtcMs: 현재 시각(ms), lastOkDailyStartedAtMs: 가장 최근 성공한 daily 실행 시각(ms)|null
export function shouldTriggerDaily(nowUtcMs, lastOkDailyStartedAtMs) {
  const kstDateStr = new Date(nowUtcMs + KST_OFFSET_MS).toISOString().slice(0, 10);
  const cutoffUtcMs = new Date(`${kstDateStr}T00:00:00Z`).getTime(); // = 오늘 09:00 KST
  const triggerThresholdUtcMs = cutoffUtcMs + TRIGGER_DELAY_MS;

  if (nowUtcMs < triggerThresholdUtcMs) return false; // 아직 여유 있음 (09:30 KST 전)
  if (lastOkDailyStartedAtMs != null && lastOkDailyStartedAtMs >= cutoffUtcMs) return false; // 이미 성공함
  return true;
}

async function triggerDailyWorkflow() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // GitHub Actions가 자동으로 "owner/repo" 형태로 제공
  if (!token || !repo) throw new Error('GITHUB_TOKEN 또는 GITHUB_REPOSITORY 환경변수 누락');

  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/daily.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`workflow_dispatch 실패: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function main() {
  const runs = await getRecentRuns(30);
  const lastOkDaily = runs.find((r) => r.source === 'daily' && r.status === 'ok');
  const lastOkMs = lastOkDaily ? new Date(lastOkDaily.started_at).getTime() : null;

  if (!shouldTriggerDaily(Date.now(), lastOkMs)) {
    console.log('[watchdog] 정상 — 강제 실행 불필요');
    return;
  }

  console.warn('[watchdog] 오늘 09:30 KST가 지나도록 daily 성공 기록이 없음 — daily.yml 강제 실행');
  await triggerDailyWorkflow();
  console.log('[watchdog] daily.yml 강제 실행 요청 완료');
}

// 테스트에서 shouldTriggerDaily만 import할 때는 main()이 실행되지 않도록 가드
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('[watchdog] 오류:', e.message);
    process.exit(1);
  });
}
