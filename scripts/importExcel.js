// 관심단지 엑셀 1회 임포트 — "관심단지" 시트를 파싱해 watchlist에 저장한다
// 실행: node scripts/importExcel.js [엑셀경로] [--dry]
//   경로 생략 시 기본 파일 사용, --dry면 DB 저장 없이 파싱 결과만 출력
import { fileURLToPath } from 'node:url';
import * as XLSXmod from 'xlsx';
import { getAllProjects, upsertWatchItem } from '../src/storage/db.js';
import { buildAliases } from '../src/core/matcher.js';

const XLSX = XLSXmod.default || XLSXmod;

const DEFAULT_PATH = 'C:\\Users\\유현\\Desktop\\seoul\\와이즈버그 가문 넥스트 스텝.xlsx';
const SHEET_NAME = '관심단지';

export const SEOUL_GU_LIST = [
  '종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구',
  '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구', '동작구',
  '관악구', '서초구', '강남구', '송파구', '강동구',
];

// ---------- 순수 함수 (테스트 대상) ----------

export function isSeoulGu(text) {
  return SEOUL_GU_LIST.includes(String(text ?? '').trim());
}

function compact(s) {
  return String(s ?? '').replace(/\s+/g, '');
}

// 헤더 행을 찾아 '자치구'·'구역명' 열 위치를 반환 (엑셀 열 순서가 바뀌어도 안전)
export function findHeaderColumns(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const guCol = row.findIndex(c => String(c ?? '').trim() === '자치구');
    const nameCol = row.findIndex(c => String(c ?? '').trim() === '구역명');
    if (guCol >= 0 && nameCol >= 0) return { headerRow: i, guCol, nameCol };
  }
  return null;
}

// 한 행을 분류: 구 이름이 있는 행(구분행 또는 구가 표기된 단지행) / 단지명이 있는 행
// 두 시트 패턴 모두 지원: ① 구분행+병합셀로 자치구가 비어있는 단지행들, ② 매 행마다 자치구가 채워진 형태
export function classifyRow(row, guCol, nameCol) {
  const guCell = String(row?.[guCol] ?? '').trim();
  const nameCell = String(row?.[nameCol] ?? '').trim();
  const validGu = isSeoulGu(guCell);
  return {
    isGuRow: validGu,
    isProjectRow: nameCell.length > 0,
    gu: validGu ? guCell : null,
    name: nameCell || null,
  };
}

// 자치구·구역명 열을 제외한 나머지 셀 중 텍스트가 있는 것만 " | "로 연결 (200자 제한)
export function buildMemo(row, excludeCols, maxLen = 200) {
  const parts = [];
  (row || []).forEach((cell, idx) => {
    if (excludeCols.includes(idx)) return;
    const text = String(cell ?? '').trim();
    if (text) parts.push(text);
  });
  const joined = parts.join(' | ');
  return joined.length > maxLen ? joined.slice(0, maxLen) : joined;
}

// 시트 전체(header:1 배열)를 파싱해 관심단지 목록 생성 — I/O 없는 순수 함수
export function parseWatchSheet(rows) {
  const header = findHeaderColumns(rows);
  if (!header) throw new Error('헤더 행(자치구/구역명 열)을 찾을 수 없습니다');
  const { headerRow, guCol, nameCol } = header;

  const items = [];
  let currentGu = null;
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => String(c ?? '').trim() === '')) continue; // 빈 행

    const { isGuRow, isProjectRow, gu, name } = classifyRow(row, guCol, nameCol);
    if (isGuRow) currentGu = gu; // 구분행 또는 자치구가 표기된 데이터행 — 현재 구 갱신
    if (!isProjectRow) continue; // 구역명 없으면 단지 행이 아님 (구분행 단독 또는 메모 구간)

    items.push({
      raw_name: name,
      gu: currentGu,
      memo: buildMemo(row, [guCol, nameCol]),
    });
  }
  return items;
}

// projects에서 이름/별칭 부분일치로 project_id 매칭 시도. 같은 자치구를 우선 탐색.
// 매칭 안 되면 null 반환 — 오매칭보다 미매칭이 낫다는 프로젝트 전반의 원칙을 따른다.
export function matchWatchItemToProject(item, projects) {
  const q = compact(item.raw_name);
  if (!q || !projects?.length) return null;

  const sameGu = item.gu ? projects.filter(p => p.gu === item.gu) : [];
  const pool = sameGu.length ? sameGu : projects;

  for (const p of pool) {
    const candidates = [p.name, ...(p.aliases || []), ...buildAliases(p.name || '')];
    const hit = candidates.some(c => {
      const cc = compact(c);
      return cc.length >= 2 && (cc.includes(q) || q.includes(cc));
    });
    if (hit) return p;
  }
  return null;
}

// ---------- I/O ----------

function readSheetRows(path) {
  const wb = XLSX.readFile(path);
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) {
    throw new Error(`시트를 찾을 수 없습니다: "${SHEET_NAME}" (있는 시트: ${wb.SheetNames.join(', ')})`);
  }
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const path = argv.find(a => !a.startsWith('--')) || DEFAULT_PATH;

  console.log(`[importExcel] 파일: ${path}`);
  const rows = readSheetRows(path);
  const items = parseWatchSheet(rows);
  console.log(`[importExcel] 파싱된 단지: ${items.length}건`);

  if (dry) {
    console.log('[importExcel] --dry 모드 — DB 저장 없이 파싱 결과만 출력합니다.\n');
    for (const it of items) {
      const memoPreview = it.memo.length > 60 ? `${it.memo.slice(0, 60)}…` : it.memo;
      console.log(`  [${it.gu ?? '미상'}] ${it.raw_name}  memo="${memoPreview}"`);
    }
    return;
  }

  const projects = await getAllProjects();
  let matched = 0;
  const unmatched = [];
  for (const item of items) {
    const project = matchWatchItemToProject(item, projects);
    if (project) matched++; else unmatched.push(item.raw_name);
    await upsertWatchItem({
      raw_name: item.raw_name,
      gu: item.gu,
      project_id: project?.id ?? null,
      memo: item.memo || null,
    });
  }

  console.log(`\n[importExcel] 완료 — 총 ${items.length}건, 매칭 ${matched}건, 미매칭 ${unmatched.length}건`);
  if (unmatched.length) {
    console.log('[importExcel] 미매칭 목록:');
    unmatched.forEach(n => console.log(`  - ${n}`));
  }
}

// 테스트에서 import할 때는 실행되지 않고, 직접 실행할 때만 main() 호출
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().then(() => process.exit(0)).catch(e => {
    console.error('[importExcel] 실패:', e);
    process.exit(1);
  });
}
