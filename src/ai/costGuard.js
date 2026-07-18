// AI 비용 하드 캡 — 호출 전 예산 확인, 호출 후 기록
// AI가 아닌 일반 로직으로 통제 (중요 판단은 규칙 기반 원칙)
import { getAiCostForMonth, getConfig, insertAiAnalysis } from '../storage/db.js';

// 모델별 단가 (USD / 1M tokens) — 모델 추가 시 여기만 수정
export const PRICES = {
  'gpt-5.4-mini': { input: 0.25, output: 2.0 },
  'gpt-5.4-nano': { input: 0.05, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

export function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICES[model] || PRICES['gpt-4o-mini'];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

let cachedBudgetState = null;

// 이번 달 예산 잔여 확인. 초과 시 false → 호출 금지
export async function budgetAllows() {
  if (cachedBudgetState && Date.now() - cachedBudgetState.at < 60_000) {
    return cachedBudgetState.allowed;
  }
  const budget = Number(await getConfig('ai_monthly_budget_usd', 5));
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const { total } = await getAiCostForMonth(yyyymm);
  const allowed = total < budget;
  cachedBudgetState = { at: Date.now(), allowed, total, budget };
  if (!allowed) console.warn(`[costGuard] 월 예산 초과: $${total.toFixed(4)} / $${budget} — AI 호출 중단`);
  return allowed;
}

export async function getBudgetStatus() {
  const budget = Number(await getConfig('ai_monthly_budget_usd', 5));
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const usage = await getAiCostForMonth(yyyymm);
  return { budget, ...usage };
}

// 호출 결과 기록 (기능별 추적)
export async function recordUsage({ targetType, targetId, purpose, model, result, inputTokens, outputTokens }) {
  const cost = estimateCost(model, inputTokens, outputTokens);
  await insertAiAnalysis({
    target_type: targetType, target_id: targetId ?? null, purpose, model,
    result, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost,
  });
  cachedBudgetState = null; // 다음 확인 시 재계산
  return cost;
}
