// core 모듈 단위 테스트 (DB·네트워크 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStage, isEarlyStage, stageIndex, STAGES } from '../src/core/stages.js';
import { detectSignals, hasPrioritySignal } from '../src/core/signals.js';
import { buildAliases, matchProjects } from '../src/core/matcher.js';
import { diffProjects } from '../src/core/diff.js';
import { buildDigestModel, renderDigest } from '../src/core/alertRules.js';

test('normalizeStage: 원문 → 표준 단계', () => {
  assert.equal(normalizeStage('조합설립인가').stage, '조합설립인가');
  assert.equal(normalizeStage('추진위원회승인').stage, '추진위원회');
  assert.equal(normalizeStage('관리처분계획인가').stage, '관리처분인가');
  assert.equal(normalizeStage('사업시행계획인가').stage, '사업시행인가');
  assert.equal(normalizeStage('조합해산').stage, '조합해산/청산');
  assert.equal(normalizeStage('이주').stage, '이주');
  assert.equal(normalizeStage('철거').stage, '철거');           // 이주와 철거는 별도 단계
  assert.notEqual(normalizeStage('이주').stage, normalizeStage('철거').stage);
});

test('normalizeStage: 미등록 원문은 보존 + known=false', () => {
  const r = normalizeStage('알수없는단계');
  assert.equal(r.known, false);
  assert.equal(r.stage, '알수없는단계');
});

test('단계 순서: 이주 < 철거 < 착공/분양', () => {
  assert.ok(stageIndex('이주') < stageIndex('철거'));
  assert.ok(stageIndex('철거') < stageIndex('착공/분양'));
  assert.equal(STAGES.length, 12);
});

test('isEarlyStage: 초기 단계 판별', () => {
  assert.ok(isEarlyStage('추진위원회'));
  assert.ok(isEarlyStage('조합설립인가'));
  assert.ok(isEarlyStage('정비구역지정'));
  assert.ok(!isEarlyStage('관리처분인가'));
});

test('detectSignals: 설립 직전 신호', () => {
  const s = detectSignals('OO구역 재건축 창립총회 개최 공고 및 조합설립인가 신청 안내');
  assert.ok(s.includes('창립총회'));
  assert.ok(s.includes('조합설립인가신청'));
  assert.ok(hasPrioritySignal(s));
});

test('detectSignals: 잡음 신호는 최우선 아님', () => {
  const s = detectSignals('조합장 해임 총회를 놓고 소송전');
  assert.ok(s.includes('해임'));
  assert.ok(s.includes('소송'));
  assert.ok(!hasPrioritySignal(s));
});

test('buildAliases: 조합 접미사 제거', () => {
  const a = buildAliases('개포주공6,7단지아파트 재건축정비사업조합');
  assert.ok(a.some(x => x.includes('개포주공6,7단지')));
  const b = buildAliases('신반포21차 주택재건축정비사업 조합설립추진위원회');
  assert.ok(b.some(x => x.replace(/\s/g, '').includes('신반포21차')));
});

test('matchProjects: 텍스트에서 사업장 찾기', () => {
  const projects = [
    { id: 1, name: '개포주공6,7단지아파트 재건축정비사업조합', aliases: ['개포주공6,7단지'] },
    { id: 2, name: '대치미도아파트', aliases: ['대치미도'] },
  ];
  assert.deepEqual(matchProjects('대치미도 재건축 심의 통과', projects), [2]);
  assert.deepEqual(matchProjects('개포주공6,7단지 이주 개시', projects), [1]);
  assert.deepEqual(matchProjects('무관한 기사', projects), []);
});

test('diffProjects: 신규·단계변화 감지', () => {
  const existing = [
    { id: 1, source_key: 'k1', gu: '강남구', name: 'A', biz_type: '재건축', stage: '조합설립인가' },
  ];
  const collected = [
    { sourceKey: 'k1', gu: '강남구', name: 'A', bizType: '재건축', stageRaw: '사업시행계획인가' },
    { sourceKey: 'k2', gu: '서초구', name: 'B', bizType: '재건축', stageRaw: '추진위원회승인' },
  ];
  const { newProjects, stageChanges } = diffProjects(collected, existing);
  assert.equal(newProjects.length, 1);
  assert.equal(newProjects[0].stage, '추진위원회');
  assert.equal(stageChanges.length, 1);
  assert.equal(stageChanges[0].newStage, '사업시행인가');
});

test('diffProjects: 같은 실행 내 중복 sourceKey는 마지막 값만 반영하고 충돌로 보고', () => {
  const existing = [];
  const collected = [
    { sourceKey: 'k1', gu: '강서구', name: '서울빌라', bizType: '가로주택정비사업', stageRaw: '조합설립인가' },
    { sourceKey: 'k1', gu: '강서구', name: '서울빌라', bizType: '가로주택정비사업', stageRaw: '사업시행계획인가' },
  ];
  const { newProjects, stageChanges, duplicateConflicts } = diffProjects(collected, existing);
  assert.equal(newProjects.length, 1); // 두 번이 아니라 한 번만 신규로 잡혀야 함
  assert.equal(newProjects[0].stage, '사업시행인가'); // 마지막 값 채택
  assert.equal(stageChanges.length, 0);
  assert.equal(duplicateConflicts.length, 1);
  assert.deepEqual(duplicateConflicts[0].values, ['조합설립인가', '사업시행계획인가']);
});

test('buildDigestModel: 초기 단계는 최우선, 나머지는 일반', () => {
  const model = buildDigestModel({
    newProjects: [{ gu: '노원구', name: 'C', stage: '추진위원회' }],
    stageChanges: [
      { projectId: 1, gu: '강남구', name: 'A', prevStage: '이주', newStage: '철거' },
      { projectId: 2, gu: '서초구', name: 'B', prevStage: '정비구역지정', newStage: '조합설립인가' },
    ],
    notices: [
      { title: '창립총회 개최 공고', url: 'https://x/1', signals: ['창립총회'] },
      { title: '일반 공고', url: 'https://x/2', signals: [] },
    ],
    articles: [],
    watchProjectIds: [],
  });
  assert.equal(model.priority.length, 3); // 조합설립인가 변화 + 신규 추진위 + 창립총회 공고
  assert.equal(model.otherChanges.length, 1); // 이주→철거
});

test('buildDigestModel: 뉴스는 우리 사업장에 실제 매칭된 것만 포함 (신호 키워드만으론 포함 안 함)', () => {
  const model = buildDigestModel({
    newProjects: [],
    stageChanges: [],
    notices: [],
    articles: [
      // 우리 사업장과 무관하지만 신호 키워드가 있는 기사 — 예전엔 새어 들어왔던 케이스
      { url: 'a1', title: '인천 신현동 정비구역 지정', matched_project_ids: [], signals: ['정비구역지정'] },
      // 실제 매칭된 기사 — 신호가 없어도 포함되어야 함
      { url: 'a2', title: '방배13구역 근황', matched_project_ids: [5], signals: [] },
      // 관심단지 매칭 기사 — 우선순위 상위
      { url: 'a3', title: '관심단지 소식', matched_project_ids: [7], signals: [] },
    ],
    watchProjectIds: [7],
  });
  assert.deepEqual(model.newsForAlert.map(a => a.url), ['a3', 'a2']); // 관심단지 매칭이 먼저
  assert.equal(model.skippedUnmatchedSignals, 1);
});

test('renderDigest: HTML 이스케이프 + 빈 날 처리', () => {
  const empty = renderDigest(
    { priority: [], otherChanges: [], newsForAlert: [] },
    { dateLabel: '2026-07-18', stats: null });
  assert.ok(empty.includes('새로운 변화가 없습니다'));

  const withData = renderDigest(
    { priority: [{ kind: 'stage', gu: '강남구', name: 'A<b>', text: 'x → y' }], otherChanges: [], newsForAlert: [] },
    { dateLabel: '2026-07-18', stats: '수집 1건' });
  assert.ok(withData.includes('A&lt;b&gt;'));
});
