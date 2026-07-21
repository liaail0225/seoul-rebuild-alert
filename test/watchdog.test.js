// watchdog의 트리거 판단 로직 단위 테스트 (DB·네트워크 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTriggerDaily } from '../src/jobs/watchdog.js';

// 2026-07-21 09:00 KST = 2026-07-21T00:00:00Z
const CUTOFF_UTC = new Date('2026-07-21T00:00:00Z').getTime();

test('shouldTriggerDaily: 09:30 KST 전이면 아직 기다림', () => {
  const now = CUTOFF_UTC + 20 * 60 * 1000; // 09:20 KST
  assert.equal(shouldTriggerDaily(now, null), false);
});

test('shouldTriggerDaily: 09:30 KST 지났고 오늘 성공 기록 없으면 강제 실행', () => {
  const now = CUTOFF_UTC + 31 * 60 * 1000; // 09:31 KST
  assert.equal(shouldTriggerDaily(now, null), true);
});

test('shouldTriggerDaily: 09:30 KST 지났어도 오늘 이미 성공했으면 실행 안 함', () => {
  const now = CUTOFF_UTC + 40 * 60 * 1000; // 09:40 KST
  const lastOk = CUTOFF_UTC + 10 * 60 * 1000; // 오늘 09:10 KST에 성공
  assert.equal(shouldTriggerDaily(now, lastOk), false);
});

test('shouldTriggerDaily: 어제 성공 기록은 오늘 판단에 영향 없음', () => {
  const now = CUTOFF_UTC + 31 * 60 * 1000; // 오늘 09:31 KST
  const lastOk = CUTOFF_UTC - 60 * 60 * 1000; // 어제 실행분(오늘 09:00 컷오프 이전)
  assert.equal(shouldTriggerDaily(now, lastOk), true);
});
