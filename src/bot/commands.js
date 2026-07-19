// 텔레그램 봇 명령 처리 — /검색 /단지 /관심목록 등 사용자 명령을 파싱해 응답
// 허용된 chat_id만 처리 (허용 목록 비어있으면 안내, 목록에 없으면 완전 무시)
import * as db from '../storage/db.js';
import { reply } from '../notify/telegram.js';
import { getBudgetStatus } from '../ai/costGuard.js';
import { buildAliases } from '../core/matcher.js';

// ---------- 순수 유틸 (테스트 대상) ----------

// HTML 특수문자 치환 (텔레그램 parse_mode=HTML 대응)
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// "/검색 강남 재건축" → { cmd: '/검색', args: '강남 재건축' }
// 그룹챗 멘션 접미사(/검색@my_bot)와 여분 공백을 제거
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return { cmd: null, args: '' };
  const sp = trimmed.indexOf(' ');
  let cmd = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const args = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  cmd = cmd.split('@')[0];
  return { cmd, args };
}

// chat_id 허용 여부. null=목록이 비어있음(초기설정 전), true/false=포함 여부
export function isChatAllowed(chatId, allowedList) {
  if (!Array.isArray(allowedList) || allowedList.length === 0) return null;
  return allowedList.some(id => String(id) === String(chatId));
}

function compact(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

// 이름/별칭 부분일치로 사업장 후보 찾기 (양방향 포함 관계 — 오매칭보다 미매칭이 낫다는 원칙)
export function findProjectCandidates(query, projects) {
  const q = compact(query);
  if (!q) return [];
  return (projects || []).filter(p => {
    const candidates = [p.name, ...(p.aliases || []), ...buildAliases(p.name || '')];
    return candidates.some(c => {
      const cc = compact(c);
      return cc.length >= 2 && (cc.includes(q) || q.includes(cc));
    });
  });
}

// 사업장의 매칭 후보(이름/별칭) 중 질의어와 가장 가까운 것의 점수(작을수록 좋음).
// 완전 일치(0)를 최우선으로 두고, 부분 포함은 길이 차이로 비교한다.
// 예전엔 project.name 전체 길이로만 비교해서 "월계동신아파트..."(정확 별칭 일치)보다
// "월계동주택재건축..."(부분 일치일 뿐)이 이름 길이가 우연히 더 가깝다는 이유로
// 잘못 선택되는 버그가 실제로 있었음(2026-07-19, 사용자 신고로 발견).
function bestMatchScore(query, project) {
  const q = compact(query);
  const candidates = [project.name, ...(project.aliases || []), ...buildAliases(project.name || '')];
  let best = Infinity;
  for (const c of candidates) {
    const cc = compact(c);
    if (cc.length < 2) continue;
    if (cc === q) return 0; // 완전 일치보다 좋은 점수는 없음
    if (cc.includes(q) || q.includes(cc)) best = Math.min(best, Math.abs(cc.length - q.length));
  }
  return best;
}

// 후보 중 질의어와 가장 정확히 매칭되는 1건 선택
export function pickBestProjectMatch(query, projects) {
  const candidates = findProjectCandidates(query, projects);
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => bestMatchScore(query, a) - bestMatchScore(query, b))[0];
}

// ---------- 안내문 ----------

const HELP_TEXT = [
  '<b>서울 재건축 알리미 명령어</b>',
  '/검색 &lt;키워드&gt; — 이름·자치구로 사업장 검색',
  '/단지 &lt;이름&gt; — 사업장 상세 (단계·주소·이력·기사)',
  '/관심목록 — 관심단지 전체 보기 (자치구별)',
  '/관심추가 &lt;이름&gt; — 관심단지 등록',
  '/관심삭제 &lt;이름&gt; — 관심단지 삭제',
  '/상태 — 최근 수집 실행 현황',
  '/오류 — 최근 수집 오류 내역',
  '/비용 — 이번 달 AI 사용 비용',
  '/백업 — 백업 안내',
].join('\n');

// ---------- 개별 명령 핸들러 ----------

async function cmdHelp(chatId) {
  await reply(chatId, HELP_TEXT);
}

async function cmdSearch(chatId, args) {
  if (!args) return reply(chatId, '사용법: /검색 &lt;키워드&gt;');
  const projects = await db.getAllProjects();
  const q = compact(args);
  const hits = projects.filter(p => compact(p.name).includes(q) || compact(p.gu).includes(q));
  if (!hits.length) return reply(chatId, `검색 결과가 없습니다: ${escapeHtml(args)}`);
  const top = hits.slice(0, 10);
  const lines = top.map(p => `[${escapeHtml(p.gu)}] ${escapeHtml(p.name)} (${escapeHtml(p.stage)})`);
  await reply(chatId, `<b>검색 결과</b> (${hits.length}건 중 ${top.length}건)\n${lines.join('\n')}`);
}

async function cmdProjectDetail(chatId, args) {
  if (!args) return reply(chatId, '사용법: /단지 &lt;이름&gt;');
  const projects = await db.getAllProjects();
  const project = pickBestProjectMatch(args, projects);
  if (!project) return reply(chatId, `찾을 수 없습니다: ${escapeHtml(args)}`);

  const lines = [`<b>[${escapeHtml(project.gu)}] ${escapeHtml(project.name)}</b>`];
  lines.push(`단계: ${escapeHtml(project.stage)}`);
  lines.push(`주소: ${escapeHtml(project.address || '정보 없음')}`);

  // 사업장 전용 이력 조회 함수가 없어 넓은 범위로 조회 후 이 사업장만 필터링
  const allHistory = await db.getStageChangesSince('2000-01-01T00:00:00Z');
  const history = allHistory.filter(h => h.project_id === project.id).slice(0, 3);
  if (history.length) {
    lines.push('', '<b>최근 단계 변화</b>');
    for (const h of history) {
      const d = String(h.detected_at || '').slice(0, 10);
      lines.push(`• ${escapeHtml(d)} ${escapeHtml(h.prev_stage || '신규')} → ${escapeHtml(h.new_stage)}`);
    }
  }

  const articles = await db.getRecentArticlesForProject(project.id, 5);
  if (articles.length) {
    lines.push('', '<b>최근 매칭 기사</b>');
    for (const a of articles) {
      lines.push(`• <a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>`);
    }
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdWatchlist(chatId) {
  const items = await db.getWatchlist();
  if (!items.length) return reply(chatId, '관심목록이 비어 있습니다. /관심추가 &lt;이름&gt; 으로 등록하세요.');

  const groups = new Map();
  for (const w of items) {
    const gu = w.gu || w.projects?.gu || '미분류';
    if (!groups.has(gu)) groups.set(gu, []);
    const stageLabel = w.projects?.stage || '미매칭';
    groups.get(gu).push(`• ${escapeHtml(w.raw_name)} (${escapeHtml(stageLabel)})`);
  }

  const lines = [`<b>관심목록</b> (${items.length}건)`];
  for (const gu of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ko'))) {
    lines.push('', `<b>${escapeHtml(gu)}</b>`, ...groups.get(gu));
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdWatchAdd(chatId, args) {
  if (!args) return reply(chatId, '사용법: /관심추가 &lt;이름&gt;');
  const projects = await db.getAllProjects();
  const candidates = findProjectCandidates(args, projects);

  if (candidates.length > 1) {
    const lines = candidates.slice(0, 10).map(p => `[${escapeHtml(p.gu)}] ${escapeHtml(p.name)}`);
    return reply(chatId, `여러 사업장이 매칭됩니다. 정확한 이름으로 다시 입력하세요:\n${lines.join('\n')}`);
  }

  const match = candidates[0] || null;
  await db.upsertWatchItem({
    raw_name: args,
    gu: match?.gu || null,
    project_id: match?.id || null,
  });

  if (match) {
    await reply(chatId, `관심목록에 추가했습니다: [${escapeHtml(match.gu)}] ${escapeHtml(match.name)}`);
  } else {
    await reply(chatId, `매칭되는 사업장을 찾지 못해 미매칭 상태로 추가했습니다: ${escapeHtml(args)}`);
  }
}

async function cmdWatchDelete(chatId, args) {
  if (!args) return reply(chatId, '사용법: /관심삭제 &lt;이름&gt;');
  const items = await db.getWatchlist();
  const q = compact(args);
  const matches = items.filter(w => {
    const cc = compact(w.raw_name);
    return cc.includes(q) || q.includes(cc);
  });

  if (!matches.length) return reply(chatId, `관심목록에서 찾을 수 없습니다: ${escapeHtml(args)}`);
  if (matches.length > 1) {
    const lines = matches.map(w => `• ${escapeHtml(w.raw_name)}`);
    return reply(chatId, `여러 건이 매칭됩니다. 정확한 이름으로 다시 입력하세요:\n${lines.join('\n')}`);
  }

  await db.deleteWatchItem(matches[0].id);
  await reply(chatId, `관심목록에서 삭제했습니다: ${escapeHtml(matches[0].raw_name)}`);
}

async function cmdStatus(chatId) {
  const runs = await db.getRecentRuns(10);
  if (!runs.length) return reply(chatId, '실행 기록이 없습니다.');

  const bySource = new Map();
  for (const r of runs) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r);
  }

  const lines = ['<b>수집 상태</b>'];
  for (const [source, list] of bySource) {
    const latest = list[0]; // getRecentRuns는 최신순 정렬
    const lastOk = list.find(r => r.status === 'ok');
    const okAgeH = lastOk ? (Date.now() - new Date(lastOk.started_at).getTime()) / 3600000 : Infinity;
    const warn = okAgeH > 24 ? ' ⚠️' : '';
    const when = String(latest.started_at || '').slice(0, 16).replace('T', ' ');
    lines.push(`• ${escapeHtml(source)}: ${escapeHtml(when)} ${escapeHtml(latest.status)} (신규 ${latest.items_new ?? 0}건)${warn}`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdErrors(chatId) {
  const runs = await db.getRecentRuns(20);
  const errs = runs.filter(r => r.status === 'error');
  if (!errs.length) return reply(chatId, '최근 오류가 없습니다.');

  const lines = ['<b>최근 오류</b>'];
  for (const r of errs.slice(0, 10)) {
    const when = String(r.started_at || '').slice(0, 16).replace('T', ' ');
    lines.push(`• [${escapeHtml(r.source)}] ${escapeHtml(when)}\n  ${escapeHtml(r.error_message || '(메시지 없음)')}`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdBudget(chatId) {
  const { budget, total, byPurpose, calls } = await getBudgetStatus();
  const lines = ['<b>이번 달 AI 비용</b>', `사용액: $${total.toFixed(4)} / $${budget} (호출 ${calls}건)`];
  const purposes = Object.keys(byPurpose);
  if (purposes.length) {
    lines.push('', '<b>기능별</b>');
    for (const p of purposes) lines.push(`• ${escapeHtml(p)}: $${byPurpose[p].toFixed(4)}`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdBackup(chatId) {
  await reply(chatId, [
    '다음 자동 백업 시 파일이 전송됩니다.',
    '즉시 백업이 필요하면 관리자가 GitHub Actions에서 backup 워크플로를 수동 실행해야 합니다.',
    '(봇은 조회 전용입니다 — 15분 폴링 작업에서 무거운 백업을 돌리지 않기 위한 설계)',
  ].join('\n'));
}

// ---------- 진입점 ----------

// msg = 텔레그램 message 객체 { chat: { id }, text, from }
export async function handleCommand(msg) {
  const chatId = msg?.chat?.id;
  const text = msg?.text;
  if (chatId == null || !text) return; // 텍스트 없는 메시지(사진 등)는 처리 대상 아님

  const allowed = await db.getConfig('allowed_chat_ids', []);
  const status = isChatAllowed(chatId, allowed);
  if (status === null) {
    await reply(chatId, `이 봇을 사용하려면 chat_id ${chatId}를 관리자에게 전달하세요.`);
    return;
  }
  if (status === false) return; // 허용 목록에 없음 — 완전 무시 (응답도 없음)

  const { cmd, args } = parseCommand(text);

  try {
    switch (cmd) {
      case '/start':
      case '/help':
        return await cmdHelp(chatId);
      case '/검색':
        return await cmdSearch(chatId, args);
      case '/단지':
        return await cmdProjectDetail(chatId, args);
      case '/관심목록':
        return await cmdWatchlist(chatId);
      case '/관심추가':
        return await cmdWatchAdd(chatId, args);
      case '/관심삭제':
        return await cmdWatchDelete(chatId, args);
      case '/상태':
        return await cmdStatus(chatId);
      case '/오류':
        return await cmdErrors(chatId);
      case '/비용':
        return await cmdBudget(chatId);
      case '/백업':
        return await cmdBackup(chatId);
      default:
        return await cmdHelp(chatId);
    }
  } catch (e) {
    console.error('[commands] 처리 실패:', cmd, e.message);
    await reply(chatId, `명령 처리 중 오류가 발생했습니다: ${escapeHtml(e.message)}`);
  }
}
