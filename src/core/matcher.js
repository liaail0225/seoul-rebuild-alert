// 기사/고시 텍스트 ↔ 사업장 매칭 (이름·별칭 기반 규칙 매칭)
// AI가 아닌 결정적 규칙 — 오매칭보다 미매칭이 낫다는 보수적 원칙

// 사업장명에서 매칭용 토큰 생성: "개포주공6,7단지아파트 재건축정비사업조합"
// → ["개포주공6,7단지", "개포주공6·7단지" ...]
export function buildAliases(name) {
  const aliases = new Set();
  let base = name
    .replace(/(주택)?재건축\s*정비사업\s*조합(설립추진위원회)?/g, '')
    .replace(/(주택|도시정비형)?\s*재개발\s*정비사업\s*조합(설립추진위원회)?/g, '')
    .replace(/리모델링\s*주택\s*조합/g, '')
    .replace(/(소규모|가로주택)\s*정비사업\s*조합/g, '')
    .replace(/조합설립추진위원회|추진위원회|추진준비위원회/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (base.length >= 3) {
    aliases.add(base);
    aliases.add(base.replace(/\s/g, ''));
    // "아파트" 접미 제거 변형
    const noApt = base.replace(/아파트$/, '').trim();
    if (noApt.length >= 3) aliases.add(noApt);
  }
  return [...aliases];
}

// 텍스트에서 사업장 찾기. projects: [{id, name, gu, aliases}]
// 반환: 매칭된 project id 배열 (중복 제거)
export function matchProjects(text, projects) {
  if (!text) return [];
  const compact = text.replace(/\s+/g, '');
  const matched = [];
  for (const p of projects) {
    const candidates = [p.name, ...(p.aliases || [])];
    const hit = candidates.some(a => {
      if (!a || a.length < 3) return false;
      return compact.includes(a.replace(/\s+/g, ''));
    });
    if (hit) matched.push(p.id);
  }
  return [...new Set(matched)];
}
