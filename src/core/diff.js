// 단계 변화 감지: 수집된 최신 목록 vs DB 기준 데이터
// 반환: { newProjects, stageChanges } — DB 갱신은 호출부(job)가 수행
import { normalizeStage } from './stages.js';

// collected: [{ sourceKey, gu, name, bizType, stageRaw, address }]
// existing:  DB projects rows (source_key 기준 맵)
export function diffProjects(collected, existing) {
  const byKey = new Map(existing.map(p => [p.source_key, p]));
  const newProjects = [];
  const stageChanges = [];
  const unknownStages = new Set();

  for (const c of collected) {
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
  return { newProjects, stageChanges, unknownStages: [...unknownStages] };
}
