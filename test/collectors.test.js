// 수집기(collectors)·첨부 판독기(attachments)의 순수 파싱 함수 단위 테스트
// 실제 HTML 구조를 본뜬 최소 fixture로 검증. 네트워크 호출은 하지 않음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

import { parseProjectListHtml } from '../src/collectors/seoulOpenData.js';
import { parseNoticeListHtml, parseNoticeBodyHtml, parseAttachmentInfo } from '../src/collectors/cleanupNotices.js';
import { stripTags, normalizeItem } from '../src/collectors/naverNews.js';
import { extractText, extractHwpxTextFromXml } from '../src/attachments/index.js';

// ---------- seoulOpenData ----------

test('parseProjectListHtml: 3개 행을 파싱하고 필드를 올바르게 매핑한다', () => {
  const html = `
    <table class="board-list-tbl tc pad_sm">
      <thead><tr><th>번호</th><th>자치구</th><th>사업구분</th><th>사업장명</th><th>대표지번</th>
        <th>진행단계</th><th>공개자료수</th><th>적시성</th><th>충실도</th><th>이동</th></tr></thead>
      <tbody>
        <tr>
          <td>1134</td><td>강남구</td><td>재건축</td>
          <td class="wordBreakAll">개포주공3단지아파트 재건축정비사업 조합</td>
          <td>개포동 138</td><td>조합해산</td><td>1878건</td><td>100.0%</td><td>100.0%</td>
          <td class="last"><a href="#">사업장</a></td>
        </tr>
        <tr>
          <td>1133</td><td>강남구</td><td>재건축</td>
          <td class="wordBreakAll">개포주공2단지 주택재건축정비사업조합</td>
          <td>개포동 140</td><td>조합해산</td><td>151건</td><td>1.52%</td><td>68.72%</td>
          <td class="last"><a href="#">사업장</a></td>
        </tr>
        <tr>
          <td>1132</td><td>강남구</td><td>재건축</td>
          <td class="wordBreakAll">개포주공6,7단지아파트 재건축정비사업조합</td>
          <td>개포동 185</td><td>사업시행인가</td><td>4056건</td><td>100.0%</td><td>100.0%</td>
          <td class="last"><a href="#">사업장</a></td>
        </tr>
      </tbody>
    </table>`;

  const rows = parseProjectListHtml(html);
  assert.equal(rows.length, 3);

  assert.deepEqual(rows[0], {
    sourceKey: '강남구|개포주공3단지아파트 재건축정비사업 조합|개포동 138',
    gu: '강남구',
    name: '개포주공3단지아파트 재건축정비사업 조합',
    bizType: '재건축',
    stageRaw: '조합해산',
    address: '개포동 138',
  });

  assert.equal(rows[2].name, '개포주공6,7단지아파트 재건축정비사업조합');
  assert.equal(rows[2].stageRaw, '사업시행인가');
});

test('parseProjectListHtml: 열 수가 부족한 행은 건너뛴다', () => {
  const html = `
    <table class="board-list-tbl">
      <tbody>
        <tr><td colspan="9">데이터가 없습니다</td></tr>
      </tbody>
    </table>`;
  const rows = parseProjectListHtml(html);
  assert.equal(rows.length, 0);
});

// ---------- cleanupNotices ----------

test('parseNoticeListHtml: 제목/링크/등록일을 파싱한다', () => {
  const html = `
    <div class="board-list-box">
      <ul class="board-list-ul">
        <li>
          <a href="/cleanup/bbs/vscr.do?cpage=1&amp;bbsClCode=100&amp;ctgryClCode=100&amp;bbs.bbsSn=12187">
            <h3 class="b-tit">정비사업전문관리업자 행정처분(업무정지) 재개 공고</h3>
            <div class="s-txtBox">
              <div class="left-box">
                <span>번호 : 441</span>
                <span>등록일 : 2026-07-14</span>
                <span>등록기관 : 서울특별시</span>
              </div>
            </div>
          </a>
        </li>
        <li>
          <a href="/cleanup/bbs/vscr.do?cpage=1&amp;bbsClCode=100&amp;ctgryClCode=100&amp;bbs.bbsSn=12095">
            <h3 class="b-tit">신림4재정비촉진구역 주민설명회 개최 공고(변경)</h3>
            <div class="s-txtBox">
              <div class="left-box">
                <span>번호 : 440</span>
                <span>등록일 : 2026-07-03</span>
              </div>
            </div>
          </a>
        </li>
      </ul>
    </div>`;

  const rows = parseNoticeListHtml(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '정비사업전문관리업자 행정처분(업무정지) 재개 공고');
  assert.equal(rows[0].url, 'https://cleanup.seoul.go.kr/cleanup/bbs/vscr.do?cpage=1&bbsClCode=100&ctgryClCode=100&bbs.bbsSn=12187');
  assert.equal(rows[0].postedAt, '2026-07-14');
  assert.equal(rows[1].postedAt, '2026-07-03');
});

test('parseNoticeBodyHtml: 본문 텍스트 영역만 추출한다', () => {
  const html = `
    <div class="board-view-contants">
      <p><br />행정소송 종결에 따라 붙임과 같이 공고합니다.</p>
    </div>`;
  const text = parseNoticeBodyHtml(html);
  assert.match(text, /행정소송 종결에 따라 붙임과 같이 공고합니다\./);
});

test('parseAttachmentInfo: previewAjax onclick에서 다운로드 파라미터를 추출한다', () => {
  const html = `
    <a href="javascript:void(0);" class="direct-btn view"
      onclick="previewAjax('https://cleanup.seoul.go.kr/cleanup/cmmn/cmmn-atchmnfl/dwldWithCsrf.do?flfldr=/atchmn/editor/2026/07/&atchmnflFileName=54DC9B08-A969-5FD8-E49D-F2198E9C209A.pdf&dwldFileNm=공고문_서울특별시 공고 제2026-2125.pdf','공고문_서울특별시 공고 제2026-2125.pdf')"
      title="바로보기 새 창 열림">바로보기</a>`;
  const info = parseAttachmentInfo(html);
  assert.deepEqual(info, {
    flfldr: '/atchmn/editor/2026/07/',
    atchmnflFileName: '54DC9B08-A969-5FD8-E49D-F2198E9C209A.pdf',
    dwldFileNm: '공고문_서울특별시 공고 제2026-2125.pdf',
  });
});

test('parseAttachmentInfo: 첨부가 없으면 null을 반환한다', () => {
  assert.equal(parseAttachmentInfo('<div>첨부 없음</div>'), null);
});

// ---------- naverNews ----------

test('stripTags: <b> 태그와 HTML 개체를 제거한다', () => {
  assert.equal(stripTags('<b>개포주공</b> 재건축 &amp; 재개발'), '개포주공 재건축 & 재개발');
  assert.equal(stripTags(''), '');
  assert.equal(stripTags(null), '');
});

test('normalizeItem: 네이버 API item을 표준 형태로 변환한다', () => {
  const item = {
    title: '<b>개포주공</b> 재건축 속도',
    originallink: 'https://example.com/a?x=1',
    link: 'https://n.news.naver.com/mnews/article/1',
    description: '설명 <b>텍스트</b>',
    pubDate: 'Sat, 18 Jul 2026 11:00:00 +0900',
  };
  const norm = normalizeItem(item, 'naver_news');
  assert.equal(norm.url, 'https://example.com/a?x=1');
  assert.equal(norm.title, '개포주공 재건축 속도');
  assert.equal(norm.source, 'naver_news');
  assert.equal(norm.excerpt, '설명 텍스트');
  assert.equal(norm.publishedAt, new Date('Sat, 18 Jul 2026 11:00:00 +0900').toISOString());
});

test('normalizeItem: originallink가 없으면 link를 사용한다', () => {
  const item = { title: 't', originallink: '', link: 'https://blog.naver.com/x', description: 'd', pubDate: '' };
  const norm = normalizeItem(item, 'naver_blog');
  assert.equal(norm.url, 'https://blog.naver.com/x');
  assert.equal(norm.publishedAt, null);
});

// ---------- attachments ----------

test('extractHwpxTextFromXml: hp:t 태그 텍스트를 추출한다', () => {
  const xml = `<hp:p><hp:run><hp:t>안녕하세요 </hp:t></hp:run><hp:run><hp:t>재건축 정비사업 안내</hp:t></hp:run></hp:p>`;
  const text = extractHwpxTextFromXml(xml);
  assert.equal(text, '안녕하세요  재건축 정비사업 안내');
});

test('extractText: hwpx(zip) 파일에서 텍스트를 추출한다', async () => {
  const sectionXml = `<?xml version="1.0"?><hp:sec xmlns:hp="http://x"><hp:p><hp:run><hp:t>테스트 공고문입니다</hp:t></hp:run></hp:p></hp:sec>`;
  const zipped = zipSync({
    mimetype: strToU8('application/hwp+zip'),
    'Contents/section0.xml': strToU8(sectionXml),
  });
  const result = await extractText(Buffer.from(zipped), 'sample.hwpx');
  assert.equal(result.status, '추출성공');
  assert.match(result.text, /테스트 공고문입니다/);
});

test('extractText: hwp(구형 바이너리)는 실패 처리한다', async () => {
  const result = await extractText(Buffer.from([0x01, 0x02, 0x03]), 'sample.hwp');
  assert.equal(result.status, '추출실패');
  assert.equal(result.text, null);
});

test('extractText: 미지원 확장자는 실패 처리한다', async () => {
  const result = await extractText(Buffer.from('data'), 'sample.txt');
  assert.equal(result.status, '추출실패');
  assert.equal(result.text, null);
});

test('extractText: 손상된 pdf는 예외를 던지지 않고 실패 처리한다', async () => {
  const result = await extractText(Buffer.from('not a real pdf'), 'sample.pdf');
  assert.equal(result.status, '추출실패');
  assert.equal(result.text, null);
});
