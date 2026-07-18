// 네이버 검색 API(뉴스+블로그)로 재건축/정비사업 관련 기사 수집
// 출처: https://openapi.naver.com/v1/search/news.json , /v1/search/blog.json
// 인증: X-Naver-Client-Id / X-Naver-Client-Secret 헤더 (src/config.js env 사용)
import { env } from '../config.js';

const NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';
const BLOG_URL = 'https://openapi.naver.com/v1/search/blog.json';
const QUERY_DELAY_MS = 200; // 배치 사이 대기 (rate limit 예방)
const REQUEST_TIMEOUT_MS = 10000; // 개별 요청 제한시간
const BATCH_SIZE = 4; // 동시 처리 쿼리 수 — 순수 순차 처리 시 쿼리가 많으면(관심단지 100+) 전체가 지나치게 오래 걸림
const TOTAL_BUDGET_MS = 6 * 60 * 1000; // 전체 수집 시간 예산. 초과 시 남은 쿼리는 건너뛰고 경고 로그(무음 누락 금지)
const MAX_QUERY_LEN = 20; // 이보다 긴 문자열은 검색어가 아닌 메모 텍스트로 간주해 제외 (예: 엑셀 비고란 텍스트가 섞여 들어온 경우)

// 제목/설명에 섞인 <b> 등 HTML 태그와 개체를 제거하는 순수 함수 (테스트 대상)
export function stripTags(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// 네이버 API item 하나를 표준 형태로 변환하는 순수 함수 (테스트 대상)
// source: 'naver_news' | 'naver_blog'
export function normalizeItem(item, source) {
  const url = item.originallink && item.originallink.trim() ? item.originallink : item.link;
  const pubDate = item.pubDate ? new Date(item.pubDate) : null;
  return {
    url,
    title: stripTags(item.title),
    source,
    publishedAt: pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate.toISOString() : null,
    excerpt: stripTags(item.description),
  };
}

async function searchOne(url, query, display) {
  const q = encodeURIComponent(query);
  const res = await fetch(`${url}?query=${q}&display=${display}&sort=date`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'X-Naver-Client-Id': env.naverClientId,
      'X-Naver-Client-Secret': env.naverClientSecret,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // 요청이 응답 없이 걸려 전체 작업이 멈추는 것 방지
  });
  if (!res.ok) throw new Error(`네이버 검색 API 요청 실패 (${url}): HTTP ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 검색어로 부적합한 항목 제외 (순수 함수, 테스트 대상)
// 너무 짧거나(1자) 너무 긴(메모 텍스트가 섞여 들어온 경우) 문자열은 검색어로 쓰지 않음
export function isValidQuery(q) {
  const t = String(q ?? '').trim();
  return t.length >= 2 && t.length <= MAX_QUERY_LEN;
}

async function searchQuery(query) {
  const [newsItems, blogItems] = await Promise.all([
    searchOne(NEWS_URL, query, 30).catch(() => []),
    searchOne(BLOG_URL, query, 20).catch(() => []),
  ]);
  return [
    ...newsItems.map(item => normalizeItem(item, 'naver_news')),
    ...blogItems.map(item => normalizeItem(item, 'naver_blog')),
  ];
}

// queries: 검색어 배열. 각 쿼리당 뉴스 30건 + 블로그 20건 수집, URL 기준 중복 제거.
// BATCH_SIZE개씩 동시 처리하고, 전체 소요 시간이 TOTAL_BUDGET_MS를 넘으면 남은 쿼리는
// 건너뛰고 경고를 남긴다(무음 누락 금지 — 다음 실행에서 다시 시도됨).
export async function collectArticles(queries) {
  const validQueries = [...new Set(queries)].filter(isValidQuery);
  const skippedAsInvalid = queries.length - validQueries.length;
  if (skippedAsInvalid > 0) {
    console.warn(`[naverNews] 검색어로 부적합해 제외: ${skippedAsInvalid}건 (너무 짧거나 ${MAX_QUERY_LEN}자 초과)`);
  }

  const seen = new Set();
  const out = [];
  const startedAt = Date.now();
  let processed = 0;

  for (let i = 0; i < validQueries.length; i += BATCH_SIZE) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
      const remaining = validQueries.length - i;
      console.warn(`[naverNews] 시간 예산(${TOTAL_BUDGET_MS / 1000}초) 초과 — 남은 쿼리 ${remaining}건은 건너뜀 (다음 실행에서 처리)`);
      break;
    }
    const batch = validQueries.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(q => searchQuery(q).catch(() => [])));

    for (const items of results) {
      for (const norm of items) {
        if (norm.url && !seen.has(norm.url)) {
          seen.add(norm.url);
          out.push(norm);
        }
      }
    }
    processed += batch.length;
    if (processed % 20 < BATCH_SIZE) {
      console.log(`[naverNews] 진행: ${processed}/${validQueries.length}건 쿼리 처리, 기사 ${out.length}건 수집`);
    }

    await sleep(QUERY_DELAY_MS);
  }

  return out;
}
