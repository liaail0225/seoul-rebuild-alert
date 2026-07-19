// 텔레그램 웹훅 — 봇 명령어 즉시 응답 (Supabase Edge Function, Deno 런타임)
// src/bot/commands.js(GitHub Actions 15분 폴링 버전)와 같은 명령어 집합·동작을 제공한다.
// Deno 런타임이라 node:fs 기반 .env 로딩 대신 Deno.env를 쓰고, supabase-js 대신
// PostgREST를 fetch로 직접 호출한다(런타임 간 의존성 분리, npm 패키지 버전 드리프트 방지).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;

const H = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };

async function rest(path: string, opts: RequestInit = {}) {
  // opts에 headers가 들어있으면 "...opts"가 뒤에서 headers 키를 통째로 덮어써 apikey가 날아가는
  // 버그가 있었음(restAllPaged가 Range 헤더를 넘길 때마다 발생) — headers를 분리해 opts 스프레드가
  // 병합된 headers를 덮어쓰지 못하게 함.
  const { headers: optHeaders, ...restOpts } = opts;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...restOpts,
    headers: { ...H, ...(optHeaders || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} 실패 HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function restAllPaged(path: string, sep = path.includes('?') ? '&' : '?') {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await rest(path, { headers: { Range: `${from}-${from + 999}` } });
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// ---------- 순수 유틸 (commands.js와 동일 로직) ----------

function escapeHtml(text: unknown) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compact(s: unknown) {
  return String(s ?? '').replace(/\s+/g, '');
}

function parseCommand(text: unknown) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return { cmd: null as string | null, args: '' };
  const sp = trimmed.indexOf(' ');
  let cmd = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const args = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  cmd = cmd.split('@')[0];
  return { cmd, args };
}

function buildAliases(name: string): string[] {
  const aliases = new Set<string>();
  const base = (name || '')
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
    const noApt = base.replace(/아파트$/, '').trim();
    if (noApt.length >= 3) aliases.add(noApt);
  }
  return [...aliases];
}

function findProjectCandidates(query: string, projects: any[]) {
  const q = compact(query);
  if (!q) return [];
  return (projects || []).filter((p) => {
    const candidates = [p.name, ...(p.aliases || []), ...buildAliases(p.name || '')];
    return candidates.some((c) => {
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
function bestMatchScore(query: string, project: any): number {
  const q = compact(query);
  const candidates = [project.name, ...(project.aliases || []), ...buildAliases(project.name || '')];
  let best = Infinity;
  for (const c of candidates) {
    const cc = compact(c);
    if (cc.length < 2) continue;
    if (cc === q) return 0;
    if (cc.includes(q) || q.includes(cc)) best = Math.min(best, Math.abs(cc.length - q.length));
  }
  return best;
}

function pickBestProjectMatch(query: string, projects: any[]) {
  const candidates = findProjectCandidates(query, projects);
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => bestMatchScore(query, a) - bestMatchScore(query, b))[0];
}

// ---------- 텔레그램 발송 ----------

async function reply(chatId: number, text: string) {
  const MAX_LEN = 4000;
  let t = text;
  const parts: string[] = [];
  while (t.length > MAX_LEN) {
    parts.push(t.slice(0, MAX_LEN));
    t = t.slice(MAX_LEN);
  }
  parts.push(t);
  for (const part of parts) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  }
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

// ---------- 개별 명령 핸들러 (commands.js와 동일 동작) ----------

async function cmdHelp(chatId: number) {
  await reply(chatId, HELP_TEXT);
}

async function cmdSearch(chatId: number, args: string) {
  if (!args) return reply(chatId, '사용법: /검색 &lt;키워드&gt;');
  const projects = await restAllPaged('projects?select=*');
  const q = compact(args);
  const hits = projects.filter((p) => compact(p.name).includes(q) || compact(p.gu).includes(q));
  if (!hits.length) return reply(chatId, `검색 결과가 없습니다: ${escapeHtml(args)}`);
  const top = hits.slice(0, 10);
  const lines = top.map((p) => `[${escapeHtml(p.gu)}] ${escapeHtml(p.name)} (${escapeHtml(p.stage)})`);
  await reply(chatId, `<b>검색 결과</b> (${hits.length}건 중 ${top.length}건)\n${lines.join('\n')}`);
}

async function cmdProjectDetail(chatId: number, args: string) {
  if (!args) return reply(chatId, '사용법: /단지 &lt;이름&gt;');
  const projects = await restAllPaged('projects?select=*');
  const project = pickBestProjectMatch(args, projects);
  if (!project) return reply(chatId, `찾을 수 없습니다: ${escapeHtml(args)}`);

  const lines = [`<b>[${escapeHtml(project.gu)}] ${escapeHtml(project.name)}</b>`];
  lines.push(`단계: ${escapeHtml(project.stage)}`);
  lines.push(`주소: ${escapeHtml(project.address || '정보 없음')}`);

  const history = await rest(
    `stage_history?select=prev_stage,new_stage,detected_at&project_id=eq.${project.id}&order=detected_at.desc&limit=3`,
  );
  if (history?.length) {
    lines.push('', '<b>최근 단계 변화</b>');
    for (const h of history) {
      const d = String(h.detected_at || '').slice(0, 10);
      lines.push(`• ${escapeHtml(d)} ${escapeHtml(h.prev_stage || '신규')} → ${escapeHtml(h.new_stage)}`);
    }
  }

  const articles = await rest(
    `articles?select=title,url&matched_project_ids=cs.{${project.id}}&order=published_at.desc&limit=5`,
  );
  if (articles?.length) {
    lines.push('', '<b>최근 매칭 기사</b>');
    for (const a of articles) lines.push(`• <a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdWatchlist(chatId: number) {
  const items = await restAllPaged('watchlist?select=*,projects(id,gu,name,stage,biz_type)');
  if (!items.length) return reply(chatId, '관심목록이 비어 있습니다. /관심추가 &lt;이름&gt; 으로 등록하세요.');

  const groups = new Map<string, string[]>();
  for (const w of items) {
    const gu = w.gu || w.projects?.gu || '미분류';
    if (!groups.has(gu)) groups.set(gu, []);
    const stageLabel = w.projects?.stage || '미매칭';
    groups.get(gu)!.push(`• ${escapeHtml(w.raw_name)} (${escapeHtml(stageLabel)})`);
  }

  const lines = [`<b>관심목록</b> (${items.length}건)`];
  for (const gu of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ko'))) {
    lines.push('', `<b>${escapeHtml(gu)}</b>`, ...groups.get(gu)!);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdWatchAdd(chatId: number, args: string) {
  if (!args) return reply(chatId, '사용법: /관심추가 &lt;이름&gt;');
  const projects = await restAllPaged('projects?select=*');
  const candidates = findProjectCandidates(args, projects);

  if (candidates.length > 1) {
    const lines = candidates.slice(0, 10).map((p) => `[${escapeHtml(p.gu)}] ${escapeHtml(p.name)}`);
    return reply(chatId, `여러 사업장이 매칭됩니다. 정확한 이름으로 다시 입력하세요:\n${lines.join('\n')}`);
  }

  const match = candidates[0] || null;
  await rest('watchlist?on_conflict=raw_name', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ raw_name: args, gu: match?.gu || null, project_id: match?.id || null }),
  });

  if (match) await reply(chatId, `관심목록에 추가했습니다: [${escapeHtml(match.gu)}] ${escapeHtml(match.name)}`);
  else await reply(chatId, `매칭되는 사업장을 찾지 못해 미매칭 상태로 추가했습니다: ${escapeHtml(args)}`);
}

async function cmdWatchDelete(chatId: number, args: string) {
  if (!args) return reply(chatId, '사용법: /관심삭제 &lt;이름&gt;');
  const items = await restAllPaged('watchlist?select=*');
  const q = compact(args);
  const matches = items.filter((w) => {
    const cc = compact(w.raw_name);
    return cc.includes(q) || q.includes(cc);
  });

  if (!matches.length) return reply(chatId, `관심목록에서 찾을 수 없습니다: ${escapeHtml(args)}`);
  if (matches.length > 1) {
    const lines = matches.map((w) => `• ${escapeHtml(w.raw_name)}`);
    return reply(chatId, `여러 건이 매칭됩니다. 정확한 이름으로 다시 입력하세요:\n${lines.join('\n')}`);
  }

  await rest(`watchlist?id=eq.${matches[0].id}`, { method: 'DELETE' });
  await reply(chatId, `관심목록에서 삭제했습니다: ${escapeHtml(matches[0].raw_name)}`);
}

async function cmdStatus(chatId: number) {
  const runs = await rest('collection_runs?select=*&order=started_at.desc&limit=10');
  if (!runs?.length) return reply(chatId, '실행 기록이 없습니다.');

  const bySource = new Map<string, any[]>();
  for (const r of runs) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }

  const lines = ['<b>수집 상태</b>'];
  for (const [source, list] of bySource) {
    const latest = list[0];
    const lastOk = list.find((r) => r.status === 'ok');
    const okAgeH = lastOk ? (Date.now() - new Date(lastOk.started_at).getTime()) / 3600000 : Infinity;
    const warn = okAgeH > 24 ? ' ⚠️' : '';
    const when = String(latest.started_at || '').slice(0, 16).replace('T', ' ');
    lines.push(`• ${escapeHtml(source)}: ${escapeHtml(when)} ${escapeHtml(latest.status)} (신규 ${latest.items_new ?? 0}건)${warn}`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdErrors(chatId: number) {
  const runs = await rest('collection_runs?select=*&order=started_at.desc&limit=20');
  const errs = (runs || []).filter((r: any) => r.status === 'error');
  if (!errs.length) return reply(chatId, '최근 오류가 없습니다.');

  const lines = ['<b>최근 오류</b>'];
  for (const r of errs.slice(0, 10)) {
    const when = String(r.started_at || '').slice(0, 16).replace('T', ' ');
    lines.push(`• [${escapeHtml(r.source)}] ${escapeHtml(when)}\n  ${escapeHtml(r.error_message || '(메시지 없음)')}`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdBudget(chatId: number) {
  const cfg = await rest('config?select=value&key=eq.ai_monthly_budget_usd');
  const budget = Number(cfg?.[0]?.value ?? 5);
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const start = `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-01T00:00:00Z`;
  const rows = await restAllPaged(`ai_analyses?select=purpose,cost_usd&created_at=gte.${start}`);

  const byPurpose: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    total += Number(row.cost_usd);
    byPurpose[row.purpose] = (byPurpose[row.purpose] || 0) + Number(row.cost_usd);
  }

  const lines = ['<b>이번 달 AI 비용</b>', `사용액: $${total.toFixed(4)} / $${budget} (호출 ${rows.length}건)`];
  const purposes = Object.keys(byPurpose);
  if (purposes.length) {
    lines.push('', '<b>기능별</b>');
    for (const p of purposes) lines.push(`• ${escapeHtml(p)}: $${byPurpose[p].toFixed(4)}`);
  }
  await reply(chatId, lines.join('\n'));
}

async function cmdBackup(chatId: number) {
  await reply(
    chatId,
    [
      '다음 자동 백업 시 파일이 전송됩니다.',
      '즉시 백업이 필요하면 관리자가 GitHub Actions에서 backup 워크플로를 수동 실행해야 합니다.',
    ].join('\n'),
  );
}

// ---------- 진입점 ----------

async function handleCommand(msg: { chat: { id: number }; text: string }) {
  const chatId = msg.chat.id;
  const { cmd, args } = parseCommand(msg.text);

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
    console.error('[telegram-webhook] 처리 실패:', cmd, e);
    await reply(chatId, `명령 처리 중 오류가 발생했습니다: ${escapeHtml((e as Error).message)}`);
  }
}

Deno.serve(async (req: Request) => {
  // Telegram이 webhook 등록 시 지정한 비밀 헤더로만 요청을 신뢰한다(제3자가 URL을 알아도 위조 불가).
  const secretHeader = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secretHeader !== WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const msg = update?.message;
  if (msg?.chat?.id != null && msg?.text) {
    try {
      const cfg = await rest('config?select=value&key=eq.allowed_chat_ids');
      const allowed = cfg?.[0]?.value ?? [];
      const isEmpty = !Array.isArray(allowed) || allowed.length === 0;
      const isAllowed = !isEmpty && allowed.some((id: any) => String(id) === String(msg.chat.id));

      if (isEmpty) {
        await reply(msg.chat.id, `이 봇을 사용하려면 chat_id ${msg.chat.id}를 관리자에게 전달하세요.`);
      } else if (isAllowed) {
        await handleCommand(msg);
      }
      // 허용 목록에 없으면 완전 무시(응답 없음)
    } catch (e) {
      console.error('[telegram-webhook] 오류:', e);
    }
  }

  // Telegram은 빠른 200 응답을 기대함 — 처리 실패해도 재시도 폭주 방지를 위해 200 반환
  return new Response('ok', { status: 200 });
});
