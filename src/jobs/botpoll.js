// 텔레그램 봇 폴링 잡 (GitHub Actions에서 15분마다 실행)
// getUpdates로 새 메시지를 가져와 명령을 처리하고 offset을 config에 저장한다
import { getUpdates } from '../notify/telegram.js';
import { getConfig, setConfig } from '../storage/db.js';
import { handleCommand } from '../bot/commands.js';

async function main() {
  const offset = Number(await getConfig('tg_update_offset', 0)) || 0;
  const updates = (await getUpdates(offset)) || [];

  let processed = 0;
  let lastUpdateId = null;

  for (const update of updates) {
    lastUpdateId = update.update_id; // 처리 성공 여부와 무관하게 진행 (poison message로 멈추지 않도록)
    if (!update.message) continue;
    try {
      await handleCommand(update.message);
      processed++;
    } catch (e) {
      console.error('[botpoll] 명령 처리 실패:', e.message);
    }
  }

  if (lastUpdateId != null) {
    await setConfig('tg_update_offset', lastUpdateId + 1);
  }

  console.log(`[botpoll] 처리 완료: ${processed}/${updates.length}건 (offset → ${lastUpdateId != null ? lastUpdateId + 1 : offset})`);
}

main().then(() => process.exit(0)).catch(e => {
  console.error('[botpoll] 치명적 오류:', e);
  process.exit(1);
});
