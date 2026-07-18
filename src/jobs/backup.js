// 주간 백업 잡 — 전체 테이블 덤프 → JSON → gzip 압축 → 텔레그램으로 파일 전송
import { gzipSync, strToU8 } from 'fflate';
import { BACKUP_TABLES, dumpTable } from '../storage/db.js';
import { sendDocument } from '../notify/telegram.js';
import { env } from '../config.js';

const KST_OFFSET = 9 * 60 * 60 * 1000;
const dateLabel = () => new Date(Date.now() + KST_OFFSET).toISOString().slice(0, 10);

async function main() {
  if (!env.telegramChatId) throw new Error('TELEGRAM_CHAT_ID 미설정 — 백업 전송 불가');

  const dump = {};
  for (const table of BACKUP_TABLES) {
    dump[table] = await dumpTable(table);
    console.log(`[backup] ${table}: ${dump[table].length}건`);
  }

  const json = JSON.stringify({ createdAt: new Date().toISOString(), tables: dump });
  const gz = gzipSync(strToU8(json));
  const filename = `backup-${dateLabel()}.json.gz`;

  await sendDocument(env.telegramChatId, filename, gz, '주간 백업');
  console.log(`[backup] 전송 완료: ${filename} (${gz.length} bytes)`);
}

main().then(() => process.exit(0)).catch(e => {
  console.error('[backup] 실패:', e);
  process.exit(1);
});
