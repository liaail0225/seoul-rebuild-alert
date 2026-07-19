// 다이제스트 구성 규칙 — 무엇이 어느 섹션에 들어가는지 결정 (AI 아닌 규칙)
// 섹션: ① 최우선(초기 단계 진입·설립 직전 신호) ② 단계 변화 전체 ③ 뉴스
import { isEarlyStage } from './stages.js';
import { hasPrioritySignal } from './signals.js';

export function buildDigestModel({ newProjects, stageChanges, notices, articles, watchProjectIds }) {
  const watch = new Set(watchProjectIds || []);
  const priority = [];
  const otherChanges = [];
  const newsForAlert = [];

  // 단계 변화 분류
  for (const ch of stageChanges) {
    const entry = {
      kind: 'stage', gu: ch.gu, name: ch.name,
      text: `${ch.prevStage} → ${ch.newStage}`,
      projectId: ch.projectId,
    };
    if (isEarlyStage(ch.newStage)) priority.push(entry);
    else otherChanges.push(entry);
  }

  // 신규 발견 사업장 (목록에 처음 등장 = 새 추진 주체)
  for (const np of newProjects) {
    const entry = { kind: 'new', gu: np.gu, name: np.name, text: `신규 등재 (${np.stage})` };
    if (isEarlyStage(np.stage)) priority.push(entry);
    else otherChanges.push(entry);
  }

  // 고시/공시: 최우선 신호 포함 건은 priority
  for (const n of notices) {
    const entry = {
      kind: 'notice', title: n.title, url: n.url,
      signals: n.signals || [], attachmentNote: n.attachment_status === '추출실패' ? ' (첨부 직접 확인 필요)' : '',
    };
    if (hasPrioritySignal(n.signals || [])) priority.push(entry);
    else if ((n.signals || []).length) otherChanges.push(entry);
    // 신호 없는 고시는 다이제스트 생략 (DB 보관, /단지 명령으로 조회 가능)
  }

  // 뉴스: 우리가 추적하는 사업장(재건축, 서울)에 실제로 매칭된 기사만 다이제스트에 포함.
  // 예전에는 본문에 "정비구역지정" 같은 신호 키워드만 있으면 매칭 여부와 무관하게 포함시켰는데,
  // 이 때문에 서울/재건축과 무관한 기사(예: 인천 재개발)가 신호 키워드만 맞아 새어 들어오는
  // 버그가 실제로 발생했다(2026-07-19). 신호는 "포함 여부"가 아니라 "우선순위"에만 쓴다.
  let skippedUnmatchedSignals = 0;
  for (const a of articles) {
    const ids = a.matched_project_ids || [];
    if (ids.length === 0) {
      if (hasPrioritySignal(a.signals || [])) skippedUnmatchedSignals++;
      continue; // 우리 사업장에 매칭 안 된 기사는 다이제스트에서 제외(수집 데이터는 보존됨)
    }
    const isWatch = ids.some(id => watch.has(id));
    const isEarly = a.matchedEarlyStage; // 수집 시 플래그
    newsForAlert.push({ ...a, rank: (isWatch ? 2 : 0) + (isEarly ? 1 : 0) });
  }
  newsForAlert.sort((x, y) => y.rank - x.rank);

  return { priority, otherChanges, newsForAlert, skippedUnmatchedSignals };
}

// 텔레그램 HTML 다이제스트 렌더링
export function renderDigest(model, { dateLabel, aiNewsSummary, aiOneLiners, stats }) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [];
  lines.push(`<b>🏗 서울 재건축 브리핑 — ${dateLabel}</b>`);

  if (model.priority.length) {
    lines.push('', '<b>🚨 최우선 (초기 단계·설립 신호)</b>');
    model.priority.forEach((e, i) => {
      if (e.kind === 'notice') {
        lines.push(`• [${esc((e.signals || []).join(','))}] <a href="${esc(e.url)}">${esc(e.title)}</a>${e.attachmentNote || ''}`);
      } else {
        lines.push(`• [${esc(e.gu)}] ${esc(e.name)} — ${esc(e.text)}`);
      }
      if (aiOneLiners?.[i]) lines.push(`  💬 ${esc(aiOneLiners[i])}`);
    });
  }

  if (model.otherChanges.length) {
    lines.push('', '<b>📋 단계 변화·고시</b>');
    for (const e of model.otherChanges.slice(0, 25)) {
      if (e.kind === 'notice') lines.push(`• <a href="${esc(e.url)}">${esc(e.title)}</a>${e.attachmentNote || ''}`);
      else lines.push(`• [${esc(e.gu)}] ${esc(e.name)} — ${esc(e.text)}`);
    }
    if (model.otherChanges.length > 25) lines.push(`  …외 ${model.otherChanges.length - 25}건`);
  }

  if (aiNewsSummary) {
    lines.push('', '<b>📰 뉴스 요약</b>', esc(aiNewsSummary));
  } else if (model.newsForAlert.length) {
    lines.push('', '<b>📰 관심·초기단계 뉴스</b>');
    for (const a of model.newsForAlert.slice(0, 12)) {
      lines.push(`• <a href="${esc(a.url)}">${esc(a.title)}</a>`);
    }
  }

  if (!model.priority.length && !model.otherChanges.length && !model.newsForAlert.length) {
    lines.push('', '오늘은 새로운 변화가 없습니다.');
  }

  if (stats) lines.push('', `<i>${esc(stats)}</i>`);
  return lines.join('\n');
}
