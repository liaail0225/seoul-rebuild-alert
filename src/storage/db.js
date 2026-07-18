// Supabase 저장소 계층 (repository 패턴)
// 다른 모듈은 이 파일의 함수만 사용 — DB 교체 시 이 파일만 수정
import { createClient } from '@supabase/supabase-js';
import { env } from '../config.js';

export const supabase = createClient(env.supabaseUrl, env.supabaseKey, {
  auth: { persistSession: false },
});

function ok({ data, error }) {
  if (error) throw new Error(`DB 오류: ${error.message}`);
  return data;
}

// ---------- projects ----------
export async function getAllProjects() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = ok(await supabase.from('projects').select('*').range(from, from + 999));
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

export async function upsertProject(p) {
  return ok(await supabase.from('projects')
    .upsert(p, { onConflict: 'source_key' })
    .select().single());
}

export async function updateProjectStage(id, stage, stageRaw) {
  return ok(await supabase.from('projects')
    .update({ stage, stage_raw: stageRaw, updated_at: new Date().toISOString() })
    .eq('id', id).select().single());
}

// ---------- stage_history ----------
export async function insertStageChange(change) {
  return ok(await supabase.from('stage_history').insert(change).select().single());
}

export async function getStageChangesSince(isoDate) {
  return ok(await supabase.from('stage_history')
    .select('*, projects(gu, name, biz_type, stage)')
    .gte('detected_at', isoDate)
    .order('detected_at', { ascending: false }));
}

// ---------- notices ----------
export async function noticeExists(url) {
  const d = ok(await supabase.from('notices').select('id').eq('url', url).limit(1));
  return d.length > 0;
}

export async function insertNotice(n) {
  return ok(await supabase.from('notices').insert(n).select().single());
}

export async function getNoticesSince(isoDate) {
  return ok(await supabase.from('notices')
    .select('*').gte('created_at', isoDate).order('posted_at', { ascending: false }));
}

// ---------- articles ----------
export async function articleExists(url) {
  const d = ok(await supabase.from('articles').select('id').eq('url', url).limit(1));
  return d.length > 0;
}

export async function insertArticle(a) {
  return ok(await supabase.from('articles').insert(a).select().single());
}

export async function getArticlesSince(isoDate) {
  return ok(await supabase.from('articles')
    .select('*').gte('created_at', isoDate).order('published_at', { ascending: false }));
}

export async function getRecentArticlesForProject(projectId, limit = 5) {
  return ok(await supabase.from('articles')
    .select('*').contains('matched_project_ids', [projectId])
    .order('published_at', { ascending: false }).limit(limit));
}

// ---------- watchlist ----------
export async function getWatchlist() {
  return ok(await supabase.from('watchlist').select('*, projects(id, gu, name, stage, biz_type)'));
}

export async function upsertWatchItem(item) {
  return ok(await supabase.from('watchlist')
    .upsert(item, { onConflict: 'raw_name' }).select().single());
}

export async function deleteWatchItem(id) {
  return ok(await supabase.from('watchlist').delete().eq('id', id).select());
}

// ---------- ai_analyses ----------
export async function insertAiAnalysis(a) {
  return ok(await supabase.from('ai_analyses').insert(a).select().single());
}

export async function getAiCostForMonth(yyyymm) {
  const start = `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-01T00:00:00Z`;
  const d = ok(await supabase.from('ai_analyses')
    .select('purpose, cost_usd, input_tokens, output_tokens')
    .gte('created_at', start));
  const byPurpose = {};
  let total = 0;
  for (const row of d) {
    total += Number(row.cost_usd);
    byPurpose[row.purpose] = (byPurpose[row.purpose] || 0) + Number(row.cost_usd);
  }
  return { total, byPurpose, calls: d.length };
}

// ---------- alerts ----------
export async function alertAlreadySent(alertType, contentHash) {
  const d = ok(await supabase.from('alerts')
    .select('id, status').eq('alert_type', alertType).eq('content_hash', contentHash).limit(1));
  return d.length > 0 && d[0].status === 'sent';
}

export async function recordAlert(a) {
  return ok(await supabase.from('alerts')
    .upsert(a, { onConflict: 'alert_type,content_hash' }).select().single());
}

export async function getFailedAlerts() {
  return ok(await supabase.from('alerts').select('*').eq('status', 'failed').limit(10));
}

// ---------- collection_runs ----------
export async function startRun(source) {
  return ok(await supabase.from('collection_runs').insert({ source }).select().single());
}

export async function finishRun(id, { status, itemsNew = 0, errorMessage = null }) {
  return ok(await supabase.from('collection_runs')
    .update({
      finished_at: new Date().toISOString(),
      status, items_new: itemsNew, error_message: errorMessage,
    }).eq('id', id).select().single());
}

export async function getRecentRuns(limit = 20) {
  return ok(await supabase.from('collection_runs')
    .select('*').order('started_at', { ascending: false }).limit(limit));
}

// ---------- config ----------
export async function getConfig(key, fallback = null) {
  const d = ok(await supabase.from('config').select('value').eq('key', key).limit(1));
  return d.length ? d[0].value : fallback;
}

export async function setConfig(key, value) {
  return ok(await supabase.from('config')
    .upsert({ key, value, updated_at: new Date().toISOString() }).select().single());
}

// ---------- backup ----------
export const BACKUP_TABLES = [
  'projects', 'stage_history', 'notices', 'articles',
  'ai_analyses', 'watchlist', 'alerts', 'config',
];

export async function dumpTable(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = ok(await supabase.from(table).select('*').range(from, from + 999));
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
