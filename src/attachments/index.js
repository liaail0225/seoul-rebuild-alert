// 첨부파일 텍스트 추출기
// 정비몽땅 고시/공고 첨부는 주로 PDF·HWPX(신형 한글, zip 기반)·HWP(구형 바이너리) 형식.
// - PDF: pdf-parse 사용
// - HWPX: zip(fflate)로 풀어 Contents/section*.xml 안의 <hp:t> 텍스트 노드를 정규식으로 추출
// - HWP(구형 바이너리, OLE 압축 포맷)는 파싱 시도하지 않고 실패 처리
// 이 모듈은 절대 예외를 밖으로 던지지 않는다 — 호출부는 status만 보고 계속 진행.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { unzipSync, strFromU8 } from 'fflate';

const STATUS_OK = '추출성공';
const STATUS_FAIL = '추출실패';

function extExt(filename = '') {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename.trim());
  return m ? m[1].toLowerCase() : '';
}

// HWPX(zip) 내부 XML에서 <hp:t> 텍스트 노드만 뽑아 이어붙임.
// 네임스페이스 접두어가 다를 수 있어 접두어 무관하게 태그명이 t인 요소를 매칭.
export function extractHwpxTextFromXml(xml) {
  const texts = [];
  const re = /<[a-zA-Z0-9]*:?t\b[^>]*>([\s\S]*?)<\/[a-zA-Z0-9]*:?t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const decoded = raw
      .replace(/<[^>]*>/g, '') // 내부에 다른 태그가 섞인 경우 제거
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    if (decoded.trim()) texts.push(decoded);
  }
  return texts.join(' ');
}

function extractHwpx(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const sectionPaths = Object.keys(files)
    .filter((p) => /^Contents\/section\d*\.xml$/i.test(p))
    .sort();
  if (sectionPaths.length === 0) {
    throw new Error('HWPX 내 section XML을 찾을 수 없음');
  }
  const parts = [];
  for (const p of sectionPaths) {
    const xml = strFromU8(files[p]);
    const t = extractHwpxTextFromXml(xml);
    if (t) parts.push(t);
  }
  const text = parts.join('\n').trim();
  if (!text) throw new Error('HWPX에서 텍스트를 추출하지 못함');
  return text;
}

async function extractPdf(buffer) {
  const data = await pdfParse(buffer);
  const text = (data.text || '').trim();
  if (!text) throw new Error('PDF에서 텍스트를 추출하지 못함');
  return text;
}

// buffer: Buffer|Uint8Array, filename: 원본 파일명(확장자 판단용)
// 반환: { text: string|null, status: '추출성공'|'추출실패' } — 예외를 던지지 않음
export async function extractText(buffer, filename) {
  const ext = extExt(filename);
  try {
    if (!buffer || buffer.length === 0) throw new Error('빈 파일');
    if (ext === 'pdf') {
      const text = await extractPdf(buffer);
      return { text, status: STATUS_OK };
    }
    if (ext === 'hwpx') {
      const text = extractHwpx(buffer);
      return { text, status: STATUS_OK };
    }
    if (ext === 'hwp') {
      // 구형 바이너리(OLE 압축) 포맷 — 파싱 시도하지 않음
      throw new Error('구형 HWP 바이너리 포맷은 미지원');
    }
    throw new Error(`미지원 확장자: ${ext || '(없음)'}`);
  } catch (err) {
    return { text: null, status: STATUS_FAIL };
  }
}
