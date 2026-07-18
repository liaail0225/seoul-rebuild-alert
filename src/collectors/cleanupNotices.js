// 정비몽땅(cleanup.seoul.go.kr) 고시/공고 게시판 수집
// 목록: https://cleanup.seoul.go.kr/cleanup/bbs/lscr.do?bbsClCode=100&ctgryClCode=100
// 상세: https://cleanup.seoul.go.kr/cleanup/bbs/vscr.do?...&bbs.bbsSn={번호}
// 첨부: POST https://cleanup.seoul.go.kr/cleanup/cmmn/cmmn-atchmnfl/dwldWithCsrf.do
//       (dwldFileNm 한글 파일명은 EUC-KR로 인코딩해야 서버가 인식함)
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { extractText } from '../attachments/index.js';

const ORIGIN = 'https://cleanup.seoul.go.kr';
const LIST_URL = `${ORIGIN}/cleanup/bbs/lscr.do`;
const DOWNLOAD_URL = `${ORIGIN}/cleanup/cmmn/cmmn-atchmnfl/dwldWithCsrf.do`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

// 목록 페이지 HTML 파싱 (순수 함수, 테스트 대상)
// 반환: [{ title, url(절대경로), postedAt(YYYY-MM-DD|null) }]
export function parseNoticeListHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.board-list-ul > li').each((_, li) => {
    const a = $(li).find('a').first();
    const href = a.attr('href');
    if (!href) return;
    const title = a.find('h3.b-tit').text().trim() || a.text().trim();
    const bodyText = $(li).text();
    const dateMatch = /등록일\s*:\s*(\d{4}-\d{2}-\d{2})/.exec(bodyText);
    out.push({
      title,
      url: href.startsWith('http') ? href : `${ORIGIN}${href}`,
      postedAt: dateMatch ? dateMatch[1] : null,
    });
  });
  return out;
}

async function fetchNoticeListPage(cpage) {
  const url = `${LIST_URL}?bbsClCode=100&ctgryClCode=100&cpage=${cpage}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`정비몽땅 고시/공고 목록 요청 실패 (cpage=${cpage}): HTTP ${res.status}`);
  return res.text();
}

// 상세 페이지에서 본문 텍스트 추출 (순수 함수, DOM 파싱)
export function parseNoticeBodyHtml(html) {
  const $ = cheerio.load(html);
  return $('.board-view-contants').text().trim().replace(/\s+/g, ' ');
}

// 상세 페이지 HTML에서 첫 번째 첨부 정보 추출
// previewAjax('URL','파일명') onclick 패턴에서 flfldr/atchmnflFileName/dwldFileNm 파싱
export function parseAttachmentInfo(html) {
  const m = /previewAjax\('([^']+)'\s*,\s*'([^']*)'\)/.exec(html);
  if (!m) return null;
  const rawUrl = m[1];
  const displayName = m[2] || null;
  const qIdx = rawUrl.indexOf('?');
  if (qIdx < 0) return null;
  const qs = new URLSearchParams(rawUrl.slice(qIdx + 1));
  const flfldr = qs.get('flfldr');
  const atchmnflFileName = qs.get('atchmnflFileName');
  const dwldFileNm = qs.get('dwldFileNm') || displayName;
  if (!flfldr || !atchmnflFileName || !dwldFileNm) return null;
  return { flfldr, atchmnflFileName, dwldFileNm };
}

// EUC-KR percent-encoding (dwldFileNm 전용 — 한글 파일명이 아니면 UTF-8도 통과하지만 안전하게 항상 EUC-KR 사용)
function eucKrPercentEncode(str) {
  const bytes = iconv.encode(str, 'euc-kr');
  let out = '';
  for (const b of bytes) out += `%${b.toString(16).padStart(2, '0').toUpperCase()}`;
  return out;
}

async function downloadAttachment({ flfldr, atchmnflFileName, dwldFileNm }) {
  const body = [
    `flfldr=${encodeURIComponent(flfldr)}`,
    `atchmnflFileName=${encodeURIComponent(atchmnflFileName)}`,
    `dwldFileNm=${eucKrPercentEncode(dwldFileNm)}`,
  ].join('&');
  const res = await fetch(DOWNLOAD_URL, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`첨부파일 다운로드 실패: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('첨부파일 다운로드 결과가 비어있음');
  return buf;
}

// 상세 URL(bbs.bbsSn 링크) 하나를 처리 — 실패해도 throw하지 않고 부분 결과 반환
async function fetchNoticeDetail({ title, url, postedAt }) {
  const base = {
    org: 'cleanup',
    noticeType: '고시공고',
    title,
    url,
    postedAt,
    bodyText: null,
    attachmentUrl: null,
    attachmentName: null,
    attachmentText: null,
    attachmentStatus: null,
  };
  let html;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    return base; // 상세 페이지 접근 실패 — 목록 정보만 반환
  }

  try {
    base.bodyText = parseNoticeBodyHtml(html);
  } catch (err) {
    base.bodyText = null;
  }

  const attInfo = parseAttachmentInfo(html);
  if (!attInfo) return base;

  base.attachmentUrl = DOWNLOAD_URL;
  base.attachmentName = attInfo.dwldFileNm;

  try {
    const buf = await downloadAttachment(attInfo);
    const { text, status } = await extractText(buf, attInfo.dwldFileNm);
    base.attachmentText = text;
    base.attachmentStatus = status;
  } catch (err) {
    base.attachmentText = null;
    base.attachmentStatus = '추출실패';
  }

  return base;
}

// 고시/공고 최신 목록(maxPages 페이지)을 수집하고 각 상세·첨부까지 처리
export async function collectNotices({ maxPages = 2 } = {}) {
  const listItems = [];
  for (let cpage = 1; cpage <= maxPages; cpage += 1) {
    let html;
    try {
      html = await fetchNoticeListPage(cpage);
    } catch (err) {
      break; // 이후 페이지 접근 실패 시 지금까지 수집한 것만 반환
    }
    const rows = parseNoticeListHtml(html);
    if (rows.length === 0) break;
    listItems.push(...rows);
  }

  const out = [];
  for (const item of listItems) {
    const detail = await fetchNoticeDetail(item);
    out.push(detail);
  }
  return out;
}
