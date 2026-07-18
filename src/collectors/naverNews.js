// 네이버 검색 API(뉴스+블로그)로 재건축/정비사업 관련 기사 수집
// 출처: https://openapi.naver.com/v1/search/news.json , /v1/search/blog.json
// 인증: X-Naver-Client-Id / X-Naver-Client-Secret 헤더 (src/config.js env 사용)
import { env } from '../config.js';

const NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';
const BLOG_URL = 'https://openapi.naver.com/v1/search/blog.json';
const QUERY_DELAY_MS = 200; // 쿼리 사이 대기 (rate limit 예방)

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
  });
  if (!res.ok) throw new Error(`네이버 검색 API 요청 실패 (${url}): HTTP ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// queries: 검색어 배열. 각 쿼리당 뉴스 30건 + 블로그 20건 수집, URL 기준 중복 제거
export async function collectArticles(queries) {
  const seen = new Set();
  const out = [];

  for (const query of queries) {
    let newsItems = [];
    let blogItems = [];
    try {
      newsItems = await searchOne(NEWS_URL, query, 30);
    } catch (err) {
      newsItems = [];
    }
    try {
      blogItems = await searchOne(BLOG_URL, query, 20);
    } catch (err) {
      blogItems = [];
    }

    for (const item of newsItems) {
      const norm = normalizeItem(item, 'naver_news');
      if (norm.url && !seen.has(norm.url)) {
        seen.add(norm.url);
        out.push(norm);
      }
    }
    for (const item of blogItems) {
      const norm = normalizeItem(item, 'naver_blog');
      if (norm.url && !seen.has(norm.url)) {
        seen.add(norm.url);
        out.push(norm);
      }
    }

    await sleep(QUERY_DELAY_MS);
  }

  return out;
}
