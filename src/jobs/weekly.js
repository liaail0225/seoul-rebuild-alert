// 주간 리포트 (매주 월 09:30 KST) — 지난 7일 데이터 기반 AI 속도/잡음 평가
import { weeklyAssessment } from '../ai/openai.js';
import { sendAlert } from '../notify/telegram.js';
import * as db from '../storage/db.js';

const weekAgo = () => new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

async function main() {
  const run = await db.startRun('weekly');
  try {
    const since = weekAgo();
    const [changes, articles, notices] = await Promise.all([
      db.getStageChangesSince(since),
      db.getArticlesSince(since),
      db.getNoticesSince(since),
    ]);

    const changeLines = changes.map(c =>
      `[${c.projects?.gu}] ${c.projects?.name}: ${c.prev_stage || '신규'} → ${c.new_stage}`);

    let body = `<b>📊 주간 리포트 — ${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)}</b>\n`;
    body += `\n지난 7일: 단계변화 ${changes.length}건 · 기사 ${articles.length}건 · 고시 ${notices.length}건\n`;

    if (changeLines.length) {
      body += `\n<b>단계 변화</b>\n${changeLines.slice(0, 20).map(l => `• ${l}`).join('\n')}`;
      if (changeLines.length > 20) body += `\n…외 ${changeLines.length - 20}건`;
    }

    const ai = await weeklyAssessment({
      stageChanges: changeLines,
      articles: articles.map(a => ({ t: a.title, d: a.published_at })),
      notices: notices.map(n => ({ t: n.title, s: n.signals })),
    }).catch(e => { console.error('AI 주간 평가 실패:', e.message); return null; });

    if (ai) {
      const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      body += `\n\n${esc(ai)}`;
    }

    await sendAlert('weekly_report', body);
    await db.finishRun(run.id, { status: 'ok', itemsNew: changes.length });
    console.log('weekly 완료');
  } catch (e) {
    await db.finishRun(run.id, { status: 'error', errorMessage: String(e.message).slice(0, 500) });
    throw e;
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
