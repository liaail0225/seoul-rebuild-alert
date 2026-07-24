// 일일 통합 잡 (매일 09:00 KST) — 수집 → 변화 감지 → AI 요약 → 다이제스트 1건 발송
// 각 수집기는 독립 실행: 하나가 실패해도 나머지는 계속, 오류는 텔레그램 통지
import { collectProjects } from '../collectors/seoulOpenData.js';
import { collectNotices } from '../collectors/cleanupNotices.js';
import { collectArticles } from '../collectors/naverNews.js';
import { diffProjects } from '../core/diff.js';
import { buildAliases, matchProjects } from '../core/matcher.js';
import { detectSignals } from '../core/signals.js';
import { isEarlyStage } from '../core/stages.js';
import { buildDigestModel, renderDigest } from '../core/alertRules.js';
import { summarizeArticlesBatch, oneLinerForPriority } from '../ai/openai.js';
import { sendAlert, sendOrUpdateDailyDigest } from '../notify/telegram.js';
import * as db from '../storage/db.js';

const KST_OFFSET = 9 * 60 * 60 * 1000;
const kstNow = () => new Date(Date.now() + KST_OFFSET);
const dateLabel = () => kstNow().toISOString().slice(0, 10);
// 오늘(KST) 00:00을 UTC ISO로 — "오늘 누적" 조회 기준 시각
const kstDayStartUtcIso = () => new Date(new Date(`${dateLabel()}T00:00:00Z`).getTime() - KST_OFFSET).toISOString();

const errors = [];

async function runCollector(source, fn) {
  const run = await db.startRun(source);
  try {
    const result = await fn();
    await db.finishRun(run.id, { status: 'ok', itemsNew: result.itemsNew || 0 });
    console.log(`[${source}] ok — 신규 ${result.itemsNew || 0}건`);
    return result;
  } catch (e) {
    errors.push(`${source}: ${e.message}`);
    await db.finishRun(run.id, { status: 'error', errorMessage: String(e.message).slice(0, 500) });
    console.error(`[${source}] 실패:`, e.message);
    return null;
  }
}

// 1) 사업장 목록 수집 + 단계 변화 감지 (기준 데이터 갱신)
async function stepProjects() {
  return runCollector('seoulOpenData', async () => {
    const collected = await collectProjects();
    const existing = await db.getAllProjects();
    const { newProjects, stageChanges, unknownStages, duplicateConflicts } = diffProjects(collected, existing);

    if (unknownStages.length) console.warn('[stages] 미등록 단계 원문:', unknownStages.join(', '));
    if (duplicateConflicts.length) {
      console.warn(`[seoulOpenData] 같은 실행에서 사업장이 서로 다른 단계 값으로 중복 등장 (${duplicateConflicts.length}건, 소스 사이트 정렬 불안정 의심):`,
        duplicateConflicts.map(c => `${c.sourceKey}: ${c.values.join(' / ')}`).join(' | '));
    }

    for (const np of newProjects) {
      const row = await db.upsertProject({
        source_key: np.sourceKey, gu: np.gu, name: np.name,
        aliases: buildAliases(np.name), biz_type: np.bizType,
        stage: np.stage, stage_raw: np.stageRaw, address: np.address,
      });
      await db.insertStageChange({ project_id: row.id, prev_stage: null, new_stage: np.stage });
    }
    for (const ch of stageChanges) {
      await db.updateProjectStage(ch.projectId, ch.newStage, ch.stageRaw);
      await db.insertStageChange({ project_id: ch.projectId, prev_stage: ch.prevStage, new_stage: ch.newStage });
    }
    return { itemsNew: newProjects.length + stageChanges.length, newProjects, stageChanges };
  });
}

// 2) 고시/공고 수집 + 신호 감지 + 사업장 매칭
async function stepNotices(projects) {
  return runCollector('cleanupNotices', async () => {
    const notices = await collectNotices({ maxPages: 2 });
    let itemsNew = 0;
    const fresh = [];
    for (const n of notices) {
      if (await db.noticeExists(n.url)) continue;
      const fullText = [n.title, n.bodyText, n.attachmentText].filter(Boolean).join('\n');
      const signals = detectSignals(fullText);
      const matched = matchProjects(fullText, projects);
      const row = await db.insertNotice({
        org: n.org, notice_type: n.noticeType, title: n.title, url: n.url,
        posted_at: n.postedAt, body_text: (n.bodyText || '').slice(0, 5000),
        attachment_url: n.attachmentUrl, attachment_name: n.attachmentName,
        attachment_text: (n.attachmentText || '').slice(0, 10000),
        attachment_status: n.attachmentStatus || '없음',
        matched_project_id: matched[0] || null, signals,
      });
      fresh.push(row);
      itemsNew++;
    }
    return { itemsNew, fresh };
  });
}

// 3) 뉴스/블로그 수집 + 매칭
async function stepNews(projects, watchlist) {
  return runCollector('naverNews', async () => {
    const extra = await db.getConfig('news_extra_keywords', []);
    const watchNames = watchlist.map(w => w.raw_name).filter(n => n && n.length >= 3);
    const queries = [...new Set([
      '서울 재건축', '조합설립인가', '추진위원회 승인 재건축', '창립총회 재건축',
      '도시계획위원회 재건축', ...extra, ...watchNames,
    ])];

    const items = await collectArticles(queries);
    const earlyIds = new Set(projects.filter(p => isEarlyStage(p.stage)).map(p => p.id));
    let itemsNew = 0;
    const fresh = [];
    for (const a of items) {
      if (await db.articleExists(a.url)) continue;
      const text = `${a.title}\n${a.excerpt || ''}`;
      // 사업장 매칭은 제목에서만 판단한다. 요약문(특히 블로그)에는 인근 단지명을
      // 검색노출 목적으로 나열하는 해시태그성 문구가 흔해("#목동6단지 #목동7단지 ..."),
      // 요약문까지 포함하면 실제로는 무관한 글이 매칭되는 오탐이 실측으로 확인됨(2026-07-19).
      const matched = matchProjects(a.title, projects);
      const signals = detectSignals(text);
      const row = await db.insertArticle({
        url: a.url, title: a.title, source: a.source,
        published_at: a.publishedAt, matched_project_ids: matched,
        excerpt: (a.excerpt || '').slice(0, 500),
      });
      fresh.push({ ...row, signals, matchedEarlyStage: matched.some(id => earlyIds.has(id)) });
      itemsNew++;
    }
    return { itemsNew, fresh };
  });
}

// 4) 다이제스트 대상 = 오늘(KST) 누적 전체 — 이번 실행에서 새로 찾은 것만이 아니라.
// 워치독이 실패를 만나 같은 날 여러 번 재시도해도, 최종 다이제스트가 그날 발견한 모든
// 내용을 빠짐없이 반영하도록 하기 위함(2026-07-24, 재시도 시 일부 기사가 누락되던 문제 수정).
async function buildTodayModel(projects, watchlist) {
  const dayStart = kstDayStartUtcIso();
  const [historyRows, noticeRows, articleRows] = await Promise.all([
    db.getStageChangesSince(dayStart),
    db.getNoticesSince(dayStart),
    db.getArticlesSince(dayStart),
  ]);

  const newProjects = historyRows
    .filter(h => h.prev_stage === null)
    .map(h => ({ gu: h.projects?.gu, name: h.projects?.name, stage: h.new_stage }));
  const stageChanges = historyRows
    .filter(h => h.prev_stage !== null)
    .map(h => ({ projectId: h.project_id, gu: h.projects?.gu, name: h.projects?.name, prevStage: h.prev_stage, newStage: h.new_stage }));

  const earlyIds = new Set(projects.filter(p => isEarlyStage(p.stage)).map(p => p.id));
  const articles = articleRows.map(a => ({
    ...a,
    signals: detectSignals(a.title), // articles 테이블엔 signals가 저장 안 되어 제목에서 재계산(순수 함수라 저비용)
    matchedEarlyStage: (a.matched_project_ids || []).some(id => earlyIds.has(id)),
  }));

  const model = buildDigestModel({
    newProjects, stageChanges, notices: noticeRows, articles,
    watchProjectIds: watchlist.map(w => w.project_id).filter(Boolean),
  });
  return {
    model,
    stats: `수집(오늘 누적): 단계변화 ${stageChanges.length} · 신규사업장 ${newProjects.length} · 고시 ${noticeRows.length} · 기사 ${articleRows.length}`,
  };
}

// 5) 크론 누락 감지: 직전 성공 daily run과 26시간 이상 벌어졌으면 경고
async function detectGap() {
  const runs = await db.getRecentRuns(50);
  const prevOk = runs.find(r => r.source === 'daily' && r.status === 'ok');
  if (!prevOk) return null;
  const gapH = (Date.now() - new Date(prevOk.started_at).getTime()) / 3600000;
  return gapH > 26 ? `⚠️ 직전 수집이 ${Math.round(gapH)}시간 전입니다 (크론 누락 가능)` : null;
}

async function main() {
  const dailyRun = await db.startRun('daily');
  const gapWarning = await detectGap().catch(() => null);

  const projResult = await stepProjects();
  const projects = await db.getAllProjects();
  const watchlist = await db.getWatchlist().catch(() => []);
  const noticeResult = await stepNotices(projects);
  const newsResult = await stepNews(projects, watchlist);

  // 다이제스트 조립 (규칙 기반, 오늘 누적 전체 대상)
  const { model, stats } = await buildTodayModel(projects, watchlist);

  // AI 제안 (실패해도 다이제스트는 발송)
  let aiNewsSummary = null, aiOneLiners = null;
  try {
    if (model.newsForAlert.length) {
      const projById = new Map(projects.map(p => [p.id, p]));
      aiNewsSummary = await summarizeArticlesBatch(model.newsForAlert.map(a => ({
        title: a.title, excerpt: a.excerpt,
        gu: projById.get((a.matched_project_ids || [])[0])?.gu,
        projectName: projById.get((a.matched_project_ids || [])[0])?.name,
      })));
    }
    if (model.priority.length) {
      const txt = await oneLinerForPriority(model.priority.map(e =>
        e.kind === 'notice' ? e.title : `[${e.gu}] ${e.name} ${e.text}`));
      if (txt) aiOneLiners = txt.split('\n').map(l => l.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
    }
  } catch (e) {
    errors.push(`AI: ${e.message}`);
  }

  let digest = renderDigest(model, { dateLabel: dateLabel(), aiNewsSummary, aiOneLiners, stats });
  if (gapWarning) digest = `${gapWarning}\n\n${digest}`;

  // 하루 1건만 유지 — 재시도가 있어도 새 메시지를 또 보내지 않고 기존 메시지를 최신 누적
  // 내용으로 수정한다(스팸 방지 + 재시도로 찾은 내용 누락 방지, 2026-07-24 도입).
  await sendOrUpdateDailyDigest(digest, dateLabel());

  // 이전 발송 실패분 재시도
  try {
    for (const failed of await db.getFailedAlerts()) {
      await sendAlert(failed.alert_type, failed.body, { dedupe: false });
    }
  } catch (e) { errors.push(`재발송: ${e.message}`); }

  // 오류 통지
  if (errors.length) {
    await sendAlert('error', `🔧 수집 중 오류 (${dateLabel()})\n${errors.map(e => `• ${e}`).join('\n')}`)
      .catch(e => console.error('오류 알림 발송 실패:', e.message));
  }
  await db.finishRun(dailyRun.id, {
    status: errors.length ? 'error' : 'ok',
    itemsNew: (projResult?.itemsNew || 0) + (noticeResult?.itemsNew || 0) + (newsResult?.itemsNew || 0),
    errorMessage: errors.length ? errors.join(' | ').slice(0, 500) : null,
  });
  console.log('daily 완료.', errors.length ? `오류 ${errors.length}건` : '정상');
}

main().then(() => process.exit(0)).catch(e => {
  console.error('daily 치명적 오류:', e);
  process.exit(1);
});
