// 환경 설정 로더
// - GitHub Actions: process.env (Secrets)
// - 로컬: 프로젝트 상위 폴더의 .env.local (커밋 금지)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const candidates = [
    join(__dirname, '..', '.env'),
    join(__dirname, '..', '..', '.env.local'), // Desktop/seoul/.env.local
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}
loadEnvFile();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 누락: ${name}`);
  return v;
}

export const env = {
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  openaiKey: process.env.OPENAI_API_KEY || '',
  naverClientId: process.env.NAVER_LOCAL_CLIENT_ID || '',
  naverClientSecret: process.env.NAVER_LOCAL_CLIENT_SECRET || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '', // 기본 수신자(엄마)
  dataGoKrKey: process.env.DATA_GO_KR_SERVICE_KEY || '',
  dryRun: process.env.DRY_RUN === '1',
};
