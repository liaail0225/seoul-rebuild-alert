// 텔레그램 발송 어댑터 — 발송/재시도/중복 방지
// DRY_RUN=1 이면 콘솔 출력만
import { createHash } from 'node:crypto';
import { env } from '../config.js';
import { alertAlreadySent, recordAlert } from '../storage/db.js';

const API = () => `https://api.telegram.org/bot${env.telegramToken}`;
const MAX_LEN = 4000; // 텔레그램 한도 4096, 여유

export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

async function tgCall(method, payload, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${API()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) return data.result;
      if (data.error_code === 429) {
        await new Promise(r => setTimeout(r, (data.parameters?.retry_after || 5) * 1000));
        continue;
      }
      throw new Error(`Telegram ${method} 실패: ${data.description}`);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
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

// 중복 방지 포함 발송. alertType + 내용 해시가 이미 발송됐으면 건너뜀.
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
  const target = chatId || env.telegramChatId;
  if (!target) throw new Error('TELEGRAM_CHAT_ID 미설정');
  try {
    let firstMsgId = null;
    for (const part of splitMessage(text)) {
      const r = await tgCall('sendMessage', {
        chat_id: target, text: part, parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      firstMsgId = firstMsgId || r.message_id;
    }
    await recordAlert({
      alert_type: alertType, content_hash: hash, body: text,
      status: 'sent', telegram_msg_id: firstMsgId, sent_at: new Date().toISOString(),
    });
    return { sent: true };
  } catch (e) {
    await recordAlert({ alert_type: alertType, content_hash: hash, body: text, status: 'failed' });
    throw e;
  }
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
