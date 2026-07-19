// 봇 명령 파싱, HTML 이스케이프, 엑셀 행 분류 — 순수 함수 단위 테스트 (DB·네트워크 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand, escapeHtml, isChatAllowed, findProjectCandidates, pickBestProjectMatch,
} from '../src/bot/commands.js';
import {
  isSeoulGu, findHeaderColumns, classifyRow, buildMemo, parseWatchSheet, matchWatchItemToProject,
} from '../scripts/importExcel.js';
import { parseArgs } from '../scripts/restore.js';

// ---------- commands.js ----------

test('parseCommand: 명령어와 인자 분리', () => {
  assert.deepEqual(parseCommand('/검색 강남 재건축'), { cmd: '/검색', args: '강남 재건축' });
  assert.deepEqual(parseCommand('/관심목록'), { cmd: '/관심목록', args: '' });
  assert.deepEqual(parseCommand('/검색@my_bot 강남'), { cmd: '/검색', args: '강남' });
  assert.deepEqual(parseCommand('그냥 텍스트'), { cmd: null, args: '' });
  assert.deepEqual(parseCommand('  /단지   개포주공6단지  '), { cmd: '/단지', args: '개포주공6단지' });
  assert.deepEqual(parseCommand(''), { cmd: null, args: '' });
});

test('escapeHtml: & < > 치환, null/undefined 안전', () => {
  assert.equal(escapeHtml('A&B <script> "x"'), 'A&amp;B &lt;script&gt; "x"');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('평범한 텍스트'), '평범한 텍스트');
});

test('isChatAllowed: 빈 목록(null)/미포함(false)/포함(true)', () => {
  assert.equal(isChatAllowed(123, []), null);
  assert.equal(isChatAllowed(123, undefined), null);
  assert.equal(isChatAllowed(123, [456]), false);
  assert.equal(isChatAllowed(123, [123, 456]), true);
  assert.equal(isChatAllowed(123, ['123']), true); // 문자열/숫자 혼용 허용
});

test('findProjectCandidates / pickBestProjectMatch: 이름·별칭 부분일치', () => {
  const projects = [
    { id: 1, name: '개포주공6,7단지아파트 재건축정비사업조합', gu: '강남구', aliases: [] },
    { id: 2, name: '대치미도아파트', gu: '강남구', aliases: ['대치미도'] },
  ];
  assert.deepEqual(findProjectCandidates('대치미도', projects).map(p => p.id), [2]);
  assert.equal(pickBestProjectMatch('개포주공6,7단지', projects)?.id, 1);
  assert.equal(pickBestProjectMatch('존재하지않는단지', projects), null);
});

test('pickBestProjectMatch: 완전 일치 별칭이 이름 길이만 우연히 가까운 다른 사업장보다 우선한다', () => {
  // 실제 사고 사례(2026-07-19): "월계동신" 검색 시 정확히 일치하는 "월계동신아파트"가 아니라
  // 부분 일치일 뿐인 "월계동주택재건축"이 선택됨 — project.name 전체 길이로만 비교했기 때문.
  const projects = [
    { id: 319, name: '월계동신아파트주택재건축정비사업조합', gu: '노원구', aliases: ['월계동신아파트', '월계동신'] },
    { id: 320, name: '월계동주택재건축정비사업조합', gu: '노원구', aliases: ['월계동'] },
  ];
  assert.equal(pickBestProjectMatch('월계동신', projects)?.id, 319);
  assert.equal(pickBestProjectMatch('월계동', projects)?.id, 320);
});

// ---------- importExcel.js ----------

test('isSeoulGu: 서울 25개 자치구 판별', () => {
  assert.ok(isSeoulGu('강남구'));
  assert.ok(isSeoulGu(' 중랑구 '));
  assert.ok(!isSeoulGu('안녕하세요'));
  assert.ok(!isSeoulGu(''));
});

test('findHeaderColumns: 자치구/구역명 열 위치 탐색', () => {
  const rows = [
    ['', '기본 정보', ''],
    ['', '자치구', '구역명', '사업 종류'],
    [1, '강남구', '역삼동', '아파트지구 재건축'],
  ];
  assert.deepEqual(findHeaderColumns(rows), { headerRow: 1, guCol: 1, nameCol: 2 });
  assert.equal(findHeaderColumns([['a', 'b']]), null);
});

test('classifyRow: 구분행 vs 단지행 vs 메모행 분류', () => {
  // 구분행: 구 이름만 있고 단지명 없음 (병합 셀 패턴)
  const guOnly = classifyRow(['', '강남구', ''], 1, 2);
  assert.equal(guOnly.isGuRow, true);
  assert.equal(guOnly.isProjectRow, false);

  // 단지행: 구·단지명 모두 있음 (실제 엑셀 파일 패턴)
  const project = classifyRow([1, '강남구', '역삼동'], 1, 2);
  assert.equal(project.isGuRow, true);
  assert.equal(project.isProjectRow, true);
  assert.equal(project.gu, '강남구');
  assert.equal(project.name, '역삼동');

  // 구 셀이 비어있고 단지명만 있는 행 — 상위 구분행의 구를 이어받아야 함 (parseWatchSheet에서 처리)
  const nameOnly = classifyRow(['', '', '개포주공5단지'], 1, 2);
  assert.equal(nameOnly.isGuRow, false);
  assert.equal(nameOnly.isProjectRow, true);
  assert.equal(nameOnly.gu, null);

  // 메모행: 구 셀에 자치구가 아닌 자유 텍스트, 단지명 없음
  const memoRow = classifyRow(['', '분담금 신경 쓰지마라!', ''], 1, 2);
  assert.equal(memoRow.isGuRow, false);
  assert.equal(memoRow.isProjectRow, false);
});

test('buildMemo: 지정 열 제외 후 텍스트 있는 셀만 파이프로 연결, 200자 제한', () => {
  const row = [1, '강남구', '역삼동', '재건축', '착공', '', 'x'.repeat(250)];
  const memo = buildMemo(row, [1, 2]);
  assert.ok(memo.startsWith('1 | 재건축 | 착공'));
  assert.equal(memo.length, 200);
});

test('parseWatchSheet: 구분행(병합 셀) 패턴 — 구 값을 하위 단지행이 이어받음', () => {
  const rows = [
    ['', '기본 정보'],
    ['', '자치구', '구역명', '사업 종류', '현재 단계'],
    ['', '강남구', '', '', ''],          // 구분행
    [1, '', '역삼동', '재건축', '착공'],   // 구 셀 비어있는 단지행
    [2, '', '도곡삼호', '재건축', '착공'],
    ['', '강동구', '', '', ''],          // 다음 구분행
    [3, '', '천호3', '재건축', '착공'],
  ];
  const items = parseWatchSheet(rows);
  assert.equal(items.length, 3);
  assert.equal(items[0].gu, '강남구');
  assert.equal(items[0].raw_name, '역삼동');
  assert.equal(items[1].gu, '강남구');
  assert.equal(items[2].gu, '강동구');
  assert.equal(items[2].raw_name, '천호3');
});

test('parseWatchSheet: 자치구 인라인 패턴(실제 파일 형태) — 빈 행·메모 구간은 제외', () => {
  const rows = [
    ['', '자치구', '구역명', '사업 종류', '현재 단계'],
    [1, '강남구', '역삼동', '재건축', '착공'],
    [2, '강남구', '도곡삼호', '재건축', '착공'],
    ['', '', '', '', ''],                          // 빈 행
    ['', '분담금 신경 쓰지마라!', '', '', ''],        // 메모 구간 (구 이름 아님)
    ['', '총알을 허투루 쓰지말자!!', '', '', ''],
  ];
  const items = parseWatchSheet(rows);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.raw_name), ['역삼동', '도곡삼호']);
});

test('parseWatchSheet: 헤더 없으면 예외', () => {
  assert.throws(() => parseWatchSheet([['a', 'b', 'c']]));
});

test('matchWatchItemToProject: 이름 부분일치 + 같은 자치구 우선 탐색', () => {
  const projects = [
    { id: 1, gu: '강남구', name: '도곡삼호아파트 재건축정비사업조합', aliases: [] },
    { id: 2, gu: '서초구', name: '도곡삼호빌라', aliases: [] },
  ];
  assert.equal(matchWatchItemToProject({ raw_name: '도곡삼호', gu: '강남구' }, projects)?.id, 1);
  assert.equal(matchWatchItemToProject({ raw_name: '도곡삼호', gu: null }, projects)?.id, 1);
  assert.equal(matchWatchItemToProject({ raw_name: '존재하지않는단지', gu: '강남구' }, projects), null);
});

// ---------- restore.js ----------

test('parseArgs: 백업 경로/--table/--yes 파싱', () => {
  assert.deepEqual(parseArgs(['backup.json.gz']), { filePath: 'backup.json.gz', table: null, yes: false });
  assert.deepEqual(
    parseArgs(['backup.json.gz', '--table', 'projects', '--yes']),
    { filePath: 'backup.json.gz', table: 'projects', yes: true },
  );
  assert.deepEqual(parseArgs([]), { filePath: null, table: null, yes: false });
});
