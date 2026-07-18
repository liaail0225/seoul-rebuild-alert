// OpenAI 어댑터 — 모든 AI 호출은 이 파일을 통해서만 (교체 가능 지점)
// AI는 요약·평가 "제안"만 한다. 알림 여부·단계 판정은 core 규칙이 결정.
import { env } from '../config.js';
import { budgetAllows, recordUsage } from './costGuard.js';

const DEFAULT_MODEL = 'gpt-5.4-mini';

async function chat(messages, { model = DEFAULT_MODEL, maxTokens = 700 } = {}) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model, messages, max_completion_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    text: data.choices[0].message.content,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    model: data.model || model,
  };
}

// 예산 확인 → 호출 → 기록. 예산 초과/키 없음이면 null (호출부는 null 허용 필수)
async function guardedChat({ purpose, targetType, targetId, messages, model, maxTokens }) {
  if (!env.openaiKey) return null;
  if (!(await budgetAllows())) return null;
  const r = await chat(messages, { model, maxTokens });
  await recordUsage({
    targetType, targetId, purpose, model: r.model,
    result: { text: r.text }, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
  });
  return r.text;
}

// 기사 묶음 요약 (다이제스트용) — 여러 기사를 한 번에 배치 처리
export async function summarizeArticlesBatch(articles) {
  if (!articles.length) return null;
  const list = articles.map((a, i) =>
    `${i + 1}. [${a.gu || ''} ${a.projectName || '일반'}] ${a.title}\n${(a.excerpt || '').slice(0, 200)}`
  ).join('\n\n');
  return guardedChat({
    purpose: 'summary', targetType: 'digest', targetId: null,
    maxTokens: 900,
    messages: [
      { role: 'system', content: '너는 서울 재건축·정비사업 전문 애널리스트다. 투자자(재건축 초기 단계 선점 목적) 관점에서 간결한 한국어로 답한다.' },
      { role: 'user', content: `아래 오늘 수집된 재건축 관련 기사들을 단지/구역별로 묶어 핵심만 요약해줘. 형식: "• [자치구 단지명] 핵심 내용 (진행 신호인지 잡음인지 표시)". 중요한 것(설립·인가·총회·심의)을 먼저. 중복 내용은 합쳐. 10줄 이내.\n\n${list}` },
    ],
  });
}

// 주간 리포트: 속도·잡음 평가
export async function weeklyAssessment({ stageChanges, articles, notices }) {
  const ctx = JSON.stringify({ stageChanges, articles: articles.slice(0, 60), notices: notices.slice(0, 40) }).slice(0, 24000);
  return guardedChat({
    purpose: 'weekly_report', targetType: 'weekly', targetId: null,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: '너는 서울 재건축·정비사업 전문 애널리스트다. 공공데이터와 기사에 근거해서만 판단하고, 근거 없는 예측은 하지 않는다. 한국어로 답한다.' },
      { role: 'user', content: `지난 주 수집 데이터(단계변화, 기사, 고시)이다. 다음 형식의 주간 리포트를 작성해줘:\n\n📈 속도 빠른 곳 (최근 진행 신호가 잦은 단지 3~5곳, 각 근거 1줄)\n⚠️ 잡음 있는 곳 (소송·갈등·해임 등 리스크 신호 단지, 각 근거 1줄)\n👀 주목할 초기 단계 (추진위·조합설립 전후 움직임)\n\n데이터에 없는 내용은 쓰지 마라.\n\n${ctx}` },
    ],
  });
}

// 최우선 알림 항목 한줄평
export async function oneLinerForPriority(items) {
  if (!items.length) return null;
  const list = items.map((x, i) => `${i + 1}. ${x}`).join('\n');
  return guardedChat({
    purpose: 'momentum', targetType: 'digest', targetId: null,
    model: 'gpt-5.4-mini', maxTokens: 500,
    messages: [
      { role: 'system', content: '서울 재건축 투자 관점의 짧은 코멘트. 한국어. 각 항목당 한 줄. 과장 금지, 사실 기반.' },
      { role: 'user', content: `다음 재건축 진행 이벤트 각각에 투자자 관점 한줄평을 달아줘. "N. 코멘트" 형식으로만:\n${list}` },
    ],
  });
}
