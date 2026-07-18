// 표준 단계 체계와 소스 원문 → 표준 단계 정규화
// 기준: 정비몽땅 사업진행단계 (Phase 0에서 확인한 14단계 체계)
// 이주와 철거는 기간이 다르므로 별도 단계 (사용자 지시)

export const STAGES = [
  '구역지정전',
  '정비구역지정',
  '추진위원회',
  '조합설립인가',
  '건축심의',
  '사업시행인가',
  '관리처분인가',
  '이주',
  '철거',
  '착공/분양',
  '준공/입주',
  '조합해산/청산',
];

const STAGE_ORDER = new Map(STAGES.map((s, i) => [s, i]));

// 소스 원문 단계 → 표준 단계. 미등록 원문은 그대로 반환하되 unknown 플래그.
const RAW_MAP = new Map(Object.entries({
  // 정비몽땅 진행단계 원문
  '정비계획 수립': '구역지정전',
  '정비계획수립': '구역지정전',
  '안전진단': '구역지정전',
  '기본계획수립': '구역지정전',
  '정비구역지정': '정비구역지정',
  '정비구역 지정': '정비구역지정',
  '추진위원회승인': '추진위원회',
  '추진위원회 승인': '추진위원회',
  '추진위원회구성': '추진위원회',
  '조합설립인가': '조합설립인가',
  '조합설립 인가': '조합설립인가',
  '건축심의': '건축심의',
  '사업시행계획인가': '사업시행인가',
  '사업시행인가': '사업시행인가',
  '관리처분계획인가': '관리처분인가',
  '관리처분인가': '관리처분인가',
  '이주': '이주',
  '이주/철거': '이주',
  '철거': '철거',
  '착공': '착공/분양',
  '착공신고': '착공/분양',
  '일반분양': '착공/분양',
  '준공': '준공/입주',
  '준공인가': '준공/입주',
  '입주': '준공/입주',
  '이전고시': '준공/입주',
  '조합해산': '조합해산/청산',
  '조합청산': '조합해산/청산',
}));

export function normalizeStage(raw) {
  if (!raw) return { stage: '구역지정전', known: false };
  const t = raw.trim();
  if (RAW_MAP.has(t)) return { stage: RAW_MAP.get(t), known: true };
  // 부분 일치 시도 (공백 제거)
  const compact = t.replace(/\s+/g, '');
  for (const [k, v] of RAW_MAP) {
    if (k.replace(/\s+/g, '') === compact) return { stage: v, known: true };
  }
  return { stage: t, known: false }; // 미등록 원문 보존 (로그로 발견)
}

export function stageIndex(stage) {
  return STAGE_ORDER.has(stage) ? STAGE_ORDER.get(stage) : -1;
}

// 초기 단계(선점 관심 구간) 여부 — 알림 최우선 대상
export function isEarlyStage(stage) {
  return stage === '추진위원회' || stage === '조합설립인가' || stage === '정비구역지정';
}
