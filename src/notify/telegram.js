// 텔레그램 발송 어댑터 — 발송/재시도/중복 방지
// DRY_RUN=1 이면 콘솔 출력만
import { createHash } from 'node:crypto';
import { env } from '../config.js';
import { alertAlreadySent, recordAlert, getConfig, getAlertRecord } from '../storage/db.js';

const API = () => `https://api.telegram.org/bot${env.telegramToken}`;
const MAX_LEN = 4000; // 텔레그램 한도 4096, 여유

export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

async function tgCall(method, payload, retries = 3) {
  for (let i = 0; i < retries; i++) {
    let res, data;
    try {
      res = await fetch(`${API()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      data = await res.json();
    } catch (e) {
      // 네트워크/타임아웃 등 요청 자체가 실패한 경우만 재시도
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      continue;
    }
    if (data.ok) return data.result;
    if (data.error_code === 429) {
      await new Promise(r => setTimeout(r, (data.parameters?.retry_after || 5) * 1000));
      continue;
    }
    // 그 외 API 레벨 거부(400 등)는 재시도해도 결과가 같으므로 즉시 던짐
    throw new Error(`Telegram ${method} 실패: ${data.description}`);
  }
}

// 긴 메시지를 문단 경계에서 분할
function splitMessage(text) {
  if (text.length <= MAX_LEN) return [text];
  const parts = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    if ((cur + '\n\n' + para).length > MAX_LEN) {
      if (cur) parts.push(cur);
      cur = para.length > MAX_LEN ? para.slice(0, MAX_LEN) : para;
    } else {
      cur = cur ? cur + '\n\n' + para : para;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// 다이제스트/리포트 수신자 목록. config의 allowed_chat_ids(봇 사용 허용 목록)를 그대로 재사용
// — "봇을 쓸 수 있는 사람 = 매일 알림도 받는 사람"으로 통일해 목록을 하나만 관리한다.
// 비어 있으면(초기 설정 전) 기본 TELEGRAM_CHAT_ID 하나로 폴백.
async function getBroadcastTargets() {
  const allowed = await getConfig('allowed_chat_ids', []);
  if (Array.isArray(allowed) && allowed.length) return allowed;
  return env.telegramChatId ? [env.telegramChatId] : [];
}

// 중복 방지 포함 발송. alertType + 내용 해시가 이미 발송됐으면 건너뜀.
// chatId를 지정하지 않으면 allowed_chat_ids 전원에게 같은 내용을 보낸다(1인 이상 성공하면 sent 처리).
export async function sendAlert(alertType, text, { chatId = null, dedupe = true } = {}) {
  const hash = contentHash(text);
  if (dedupe && await alertAlreadySent(alertType, hash)) {
    console.log(`[telegram] 중복 건너뜀: ${alertType} ${hash}`);
    return { skipped: true };
  }
  if (env.dryRun) {
    console.log(`\n===== DRY_RUN [${alertType}] =====\n${text}\n=====`);
    await recordAlert({ alert_type: alertType, content_hash: hash, body: text, status: 'sent', sent_at: new Date().toISOString() });
    return { dryRun: true };
  }
  const targets = chatId ? [chatId] : await getBroadcastTargets();
  if (!targets.length) throw new Error('발송 대상 chat_id 없음 (TELEGRAM_CHAT_ID 또는 allowed_chat_ids 설정 필요)');

  let firstMsgId = null;
  const failures = [];
  for (const target of targets) {
    try {
      for (const part of splitMessage(text)) {
        const r = await tgCall('sendMessage', {
          chat_id: target, text: part, parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        firstMsgId = firstMsgId || r.message_id;
      }
    } catch (e) {
      failures.push(`${target}: ${e.message}`);
    }
  }

  const allFailed = failures.length === targets.length;
  await recordAlert({
    alert_type: alertType, content_hash: hash, body: text,
    status: allFailed ? 'failed' : 'sent', telegram_msg_id: firstMsgId,
    sent_at: allFailed ? null : new Date().toISOString(),
  });
  if (failures.length) console.error('[telegram] 일부 수신자 발송 실패:', failures.join(' | '));
  if (allFailed) throw new Error(failures.join(' | '));
  return { sent: true, failedTargets: failures.length };
}

// 하루 다이제스트 전용: 그날 첫 발송은 새 메시지, 이후 같은 날 재시도(워치독 재실행 등)가
// 있으면 새 메시지를 또 보내는 대신 기존 메시지를 수정(editMessageText)해 최신 누적 내용으로
// 갱신한다 — 스팸 없이("하루 1건") 그날 발견한 내용을 전부 반영하기 위함(2026-07-24 도입).
// dateKey: 'YYYY-MM-DD'(KST). 수신자별 message_id를 alerts.telegram_msg_ids에 저장/조회한다.
export async function sendOrUpdateDailyDigest(text, dateKey) {
  const hash = contentHash(`daily_digest:${dateKey}`); // 날짜 고정 키 — 내용이 바뀌어도 같은 레코드를 가리킴
  const alertType = 'daily_digest';

  if (env.dryRun) {
    console.log(`\n===== DRY_RUN [${alertType} ${dateKey}] =====\n${text}\n=====`);
    await recordAlert({ alert_type: alertType, content_hash: hash, body: text, status: 'sent', sent_at: new Date().toISOString() });
    return { dryRun: true };
  }

  const targets = await getBroadcastTargets();
  if (!targets.length) throw new Error('발송 대상 chat_id 없음 (TELEGRAM_CHAT_ID 또는 allowed_chat_ids 설정 필요)');

  const existing = await getAlertRecord(alertType, hash);
  const existingIds = existing?.telegram_msg_ids || {};
  const parts = splitMessage(text);
  const msgIds = { ...existingIds };
  const failures = [];

  for (const target of targets) {
    const existingMsgId = existingIds[String(target)];
    try {
      if (existingMsgId && parts.length === 1) {
        // 기존 메시지 수정 (여러 파트로 나뉘는 긴 다이제스트는 수정 대상에서 제외 — 아래 fallback)
        try {
          await tgCall('editMessageText', {
            chat_id: target, message_id: existingMsgId, text: parts[0],
            parse_mode: 'HTML', disable_web_page_preview: true,
          });
        } catch (e) {
          if (!String(e.message).includes('message is not modified')) throw e; // 내용 동일하면 정상
        }
      } else {
        // 최초 발송이거나, 메시지가 여러 파트로 나뉘어 수정이 불가능한 경우 새로 발송
        let firstMsgId = null;
        for (const part of parts) {
          const r = await tgCall('sendMessage', { chat_id: target, text: part, parse_mode: 'HTML', disable_web_page_preview: true });
          firstMsgId = firstMsgId || r.message_id;
        }
        msgIds[String(target)] = firstMsgId;
      }
    } catch (e) {
      failures.push(`${target}: ${e.message}`);
    }
  }

  const allFailed = failures.length === targets.length;
  await recordAlert({
    alert_type: alertType, content_hash: hash, body: text,
    status: allFailed ? 'failed' : 'sent', telegram_msg_ids: msgIds,
    sent_at: allFailed ? null : new Date().toISOString(),
  });
  if (failures.length) console.error('[telegram] 일부 수신자 발송/수정 실패:', failures.join(' | '));
  if (allFailed) throw new Error(failures.join(' | '));
  return { sent: true, edited: Object.keys(existingIds).length > 0, failedTargets: failures.length };
}

// 봇 명령 응답용 (중복 방지 없음, 기록 없음)
export async function reply(chatId, text) {
  if (env.dryRun) { console.log(`[reply→${chatId}] ${text}`); return; }
  for (const part of splitMessage(text)) {
    await tgCall('sendMessage', {
      chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true,
    });
  }
}

export async function sendDocument(chatId, filename, buffer, caption = '') {
  if (env.dryRun) { console.log(`[document→${chatId}] ${filename} (${buffer.length}B)`); return; }
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('document', new Blob([buffer]), filename);
  const res = await fetch(`${API()}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendDocument 실패: ${data.description}`);
  return data.result;
}

export async function getUpdates(offset) {
  return await tgCall('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
}
