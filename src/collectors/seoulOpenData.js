// 정비몽땅(cleanup.seoul.go.kr) 사업장 전체 목록 수집 — 기준 데이터(source of truth)
// 출처: https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do (사업장 목록 게시판)
// 실측: 총 1134건, pageSize=200 기준 페이지당 최대 200행. 마지막 페이지는 200건 미만.
import * as cheerio from 'cheerio';

const LIST_URL = 'https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do';
const PAGE_SIZE = 200;
const MIN_EXPECTED = 500; // 이보다 적게 파싱되면 사이트 개편으로 간주하고 throw

// 목록 HTML 한 페이지를 파싱하는 순수 함수 (테스트 대상)
// 열 순서: 번호, 자치구, 사업구분, 사업장명(td.wordBreakAll), 대표지번, 진행단계, 공개자료수, 적시성, 충실도, 이동
export function parseProjectListHtml(html) {
  const $ = cheerio.load(html);
  const rows = $('table.board-list-tbl tbody tr');
  const out = [];
  rows.each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 9) return; // 구조가 다른 행(공지 등)은 건너뜀
    const gu = $(tds[1]).text().trim();
    const bizType = $(tds[2]).text().trim();
    const name = $(tds[3]).text().trim();
    const address = $(tds[4]).text().trim();
    const stageRaw = $(tds[5]).text().trim();
    if (!gu || !name) return;
    out.push({
      sourceKey: `${gu}|${name}|${address}`,
      gu,
      name,
      bizType,
      stageRaw,
      address,
    });
  });
  return out;
}

async function fetchListPage(cpage) {
  const url = `${LIST_URL}?cpage=${cpage}&pageSize=${PAGE_SIZE}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`정비몽땅 사업장 목록 요청 실패 (cpage=${cpage}): HTTP ${res.status}`);
  return res.text();
}

// 전체 사업장 목록 수집. 행 수가 pageSize 미만이면 마지막 페이지로 판단.
export async function collectProjects() {
  const all = [];
  for (let cpage = 1; ; cpage += 1) {
    const html = await fetchListPage(cpage);
    const rows = parseProjectListHtml(html);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  if (all.length < MIN_EXPECTED) {
    throw new Error(
      `정비몽땅 사업장 목록 파싱 결과가 비정상적으로 적음 (${all.length}건 < ${MIN_EXPECTED}건) — 사이트 구조 변경 의심`
    );
  }
  return all;
}
