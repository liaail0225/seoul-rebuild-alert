// 단계 변화 감지: 수집된 최신 목록 vs DB 기준 데이터
// 반환: { newProjects, stageChanges } — DB 갱신은 호출부(job)가 수행
import { normalizeStage } from './stages.js';

// collected 배열에서 같은 sourceKey가 두 번 이상 나타나면 마지막 값만 남긴다.
// 페이지네이션 도중 소스 사이트의 목록이 페이지 간에 흔들리면(정렬 불안정 등) 같은
// 사업장이 서로 다른 진행단계 값으로 중복 등장할 수 있음 — 이 경우 stage_history에
// 같은 실행 안에서 두 번 기록되는 오류가 실제로 발생했음(2026-07-19). 충돌이 있으면
// 무음 처리하지 않고 목록으로 반환해 호출부가 로그를 남기게 한다.
function dedupeCollected(collected) {
  const byKey = new Map();
  const conflicts = [];
  for (const c of collected) {
    const prev = byKey.get(c.sourceKey);
    if (prev && prev.stageRaw !== c.stageRaw) {
      conflicts.push({ sourceKey: c.sourceKey, values: [prev.stageRaw, c.stageRaw] });
    }
    byKey.set(c.sourceKey, c);
  }
  return { deduped: [...byKey.values()], conflicts };
}

// collected: [{ sourceKey, gu, name, bizType, stageRaw, address }]
// existing:  DB projects rows (source_key 기준 맵)
export function diffProjects(collected, existing) {
  const { deduped, conflicts } = dedupeCollected(collected);
  const byKey = new Map(existing.map(p => [p.source_key, p]));
  const newProjects = [];
  const stageChanges = [];
  const unknownStages = new Set();

  for (const c of deduped) {
    const { stage, known } = normalizeStage(c.stageRaw);
    if (!known) unknownStages.add(c.stageRaw);
    const prev = byKey.get(c.sourceKey);
    if (!prev) {
      newProjects.push({ ...c, stage });
    } else if (prev.stage !== stage) {
      stageChanges.push({
        projectId: prev.id, gu: prev.gu, name: prev.name, bizType: prev.biz_type,
        prevStage: prev.stage, newStage: stage, stageRaw: c.stageRaw,
      });
    }
  }
  return { newProjects, stageChanges, unknownStages: [...unknownStages], duplicateConflicts: conflicts };
}
