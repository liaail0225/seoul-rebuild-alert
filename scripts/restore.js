// 백업 파일로부터 복구 — backup.js가 만든 .json.gz(또는 .json)를 읽어 테이블별로 upsert
// 실행: node scripts/restore.js <백업파일> [--table 이름] [--yes]
//   --yes 없이 실행하면 복구 대상만 미리보기하고 실제 쓰기는 하지 않는다 (실수 방지)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, strFromU8 } from 'fflate';
// 저장소 계층에 임의 테이블 upsert 함수가 없어(복구는 일반적인 CRUD 흐름과 다름)
// db.js가 공개하는 supabase 클라이언트를 직접 사용한다.
import { supabase, BACKUP_TABLES } from '../src/storage/db.js';

// argv(스크립트 인자 이후) 파싱 — 순수 함수
export function parseArgs(argv) {
  const args = argv || [];
  const yes = args.includes('--yes');
  const tableIdx = args.indexOf('--table');
  const table = tableIdx >= 0 ? args[tableIdx + 1] || null : null;
  const filePath = args.find((a, i) => {
    if (a.startsWith('--')) return false;
    if (tableIdx >= 0 && i === tableIdx + 1) return false; // --table 다음 값은 경로가 아님
    return true;
  }) || null;
  return { filePath, table, yes };
}

function loadBackupFile(path) {
  const buf = readFileSync(path);
  const isGzip = path.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b);
  const json = isGzip ? strFromU8(gunzipSync(buf)) : buf.toString('utf8');
  const data = JSON.parse(json);
  return data.tables || data; // { tables: {...} } 형태 또는 구버전 평탄 구조 모두 지원
}

async function restoreTable(table, rows) {
  const onConflict = table === 'config' ? 'key' : 'id';
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`복구 오류(${table}): ${error.message}`);
  }
}

async function main() {
  const { filePath, table: onlyTable, yes } = parseArgs(process.argv.slice(2));
  if (!filePath) {
    console.error('사용법: node scripts/restore.js <백업파일> [--table 이름] [--yes]');
    process.exit(1);
    return;
  }

  const tables = loadBackupFile(filePath);
  const targetTables = onlyTable
    ? [onlyTable]
    : Object.keys(tables).filter(t => BACKUP_TABLES.includes(t));

  console.log(`[restore] 파일: ${filePath}`);
  console.log('[restore] 복구 대상:');
  for (const t of targetTables) {
    console.log(`  ${t}: ${(tables[t] || []).length}건`);
  }

  if (!yes) {
    console.log('\n[restore] --yes 플래그 없이 실행되어 실제 쓰기는 수행하지 않았습니다. (미리보기만)');
    return;
  }

  for (const t of targetTables) {
    const rows = tables[t] || [];
    if (!rows.length) { console.log(`[restore] ${t}: 데이터 없음, 건너뜀`); continue; }
    await restoreTable(t, rows);
    console.log(`[restore] ${t}: ${rows.length}건 복구 완료`);
  }
  console.log('[restore] 전체 복구 완료');
}

// 테스트에서 parseArgs만 import할 때는 실행되지 않고, 직접 실행할 때만 main() 호출
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().then(() => process.exit(0)).catch(e => {
    console.error('[restore] 실패:', e);
    process.exit(1);
  });
}
