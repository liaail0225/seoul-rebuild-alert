// 설립 직전/중요 신호 키워드 감지 (고시·공시·기사 제목/본문/첨부에서)
// AI가 아닌 명확한 규칙으로 판단 — 알림 여부는 항상 이 규칙이 결정

export const SIGNAL_KEYWORDS = [
  // 설립 직전 신호 (최우선)
  { key: '창립총회', pattern: /창립\s*총회/ },
  { key: '주민총회', pattern: /주민\s*총회/ },
  { key: '조합설립인가신청', pattern: /조합\s*설립\s*인가\s*신청/ },
  { key: '조합설립인가', pattern: /조합\s*설립\s*인가(?!\s*신청)/ },
  { key: '추진위원회승인', pattern: /추진위원회\s*(구성\s*)?승인/ },
  { key: '동의서징구', pattern: /동의서\s*(징구|접수|제출)/ },
  // 인가 전 심의/구역 신호
  { key: '정비구역지정', pattern: /정비구역\s*지정/ },
  { key: '정비계획', pattern: /정비계획\s*(수립|변경|결정)/ },
  { key: '심의상정', pattern: /(도시계획|도시재정비|건축)위원회.{0,20}(상정|심의|통과|가결|수권)/ },
  { key: '안전진단', pattern: /안전진단\s*(통과|결과|실시)/ },
  // 후기 단계 신호
  { key: '사업시행인가', pattern: /사업시행\s*(계획\s*)?인가/ },
  { key: '관리처분인가', pattern: /관리처분\s*(계획\s*)?인가/ },
  { key: '시공사선정', pattern: /시공(사|자)\s*선정/ },
  { key: '이주', pattern: /이주\s*(개시|시작|완료|공고)/ },
  { key: '철거', pattern: /철거\s*(개시|시작|완료)/ },
  { key: '분양', pattern: /(일반|조합원)\s*분양/ },
  // 잡음/리스크 신호
  { key: '소송', pattern: /소송|가처분|무효\s*판결/ },
  { key: '해임', pattern: /(조합장|위원장)\s*해임/ },
  { key: '갈등', pattern: /갈등|비대위|내분|반대\s*위원회/ },
  { key: '공사중단', pattern: /공사\s*(중단|중지)|유치권/ },
];

// 최우선 알림 대상 신호 (설립 직전 + 초기 단계 진입)
const PRIORITY_SIGNALS = new Set([
  '창립총회', '주민총회', '조합설립인가신청', '조합설립인가',
  '추진위원회승인', '정비구역지정', '심의상정', '동의서징구',
]);

export function detectSignals(text) {
  if (!text) return [];
  return SIGNAL_KEYWORDS.filter(s => s.pattern.test(text)).map(s => s.key);
}

export function hasPrioritySignal(signals) {
  return signals.some(s => PRIORITY_SIGNALS.has(s));
}

export function isNoiseSignal(key) {
  return ['소송', '해임', '갈등', '공사중단'].includes(key);
}
