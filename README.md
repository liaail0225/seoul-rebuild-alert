# 서울 재건축 알리미

서울 전체 정비사업(재건축 중심)을 공공정보 기반으로 매일 추적하고, 초기 단계(추진위·조합설립) 진입과
설립 직전 신호(창립총회·인가 신청·심의)를 텔레그램으로 알려주는 시스템.

- Repo: https://github.com/liaail0225/seoul-rebuild-alert
- 텔레그램 봇: [@seoul_apt_rebuild_bot](https://t.me/seoul_apt_rebuild_bot)

## 동작 방식
- **매일 09:00 KST** (GitHub Actions): 정비몽땅 사업장 목록(1,100+) + 고시/공고(첨부 PDF/HWPX 판독) + 네이버 뉴스/블로그 수집 → 단계 변화 감지 → AI 요약 → 텔레그램 다이제스트 1건
- **매주 월 09:30**: AI 주간 리포트 (속도 빠른 곳 / 잡음 있는 곳)
- **15분마다**: 텔레그램 봇 명령 처리 (`/검색`, `/단지`, `/관심추가`, `/비용`, `/상태` …)
- **매주 일요일**: 전체 DB JSON 백업을 텔레그램 파일로 전송

## 구조
```
src/collectors/   소스별 수집기 (교체 가능)     src/core/      비즈니스 규칙 (단계·매칭·알림)
src/attachments/  첨부 판독 (PDF/HWPX)          src/storage/   Supabase 저장소 계층
src/ai/           OpenAI 어댑터 + 비용 하드캡    src/notify/    텔레그램 발송
src/bot/          봇 명령어                      src/jobs/      엔트리포인트 (daily/weekly/botpoll/backup)
```
원칙: 추진단계의 기준은 공공데이터(정비몽땅)만. AI는 요약·평가 제안만 하며 판단은 코드 규칙이 한다.
자세한 결정 이유는 [DECISIONS.md](DECISIONS.md).

## 설정 (1회) — 완료 상태 ✅
1. ✅ Supabase SQL Editor에서 `scripts/setupDb.sql` 실행 (스키마 + `allowed_chat_ids` 기본값)
2. ✅ GitHub repo Secrets 등록: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
   `NAVER_LOCAL_CLIENT_ID`, `NAVER_LOCAL_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
3. ✅ 관심단지 시드: `node scripts/importExcel.js` (엑셀 130건 → watchlist)
4. ✅ 봇 허용 사용자 등록 완료

### 봇 사용자를 추가로 등록하려면
1. 해당 사람이 텔레그램에서 [@seoul_apt_rebuild_bot](https://t.me/seoul_apt_rebuild_bot)에게 `/start` 전송
2. `https://api.telegram.org/bot<토큰>/getUpdates` 로 chat_id 확인
3. Supabase Table Editor > `config` 테이블 > `allowed_chat_ids` 값에 그 chat_id를 배열로 추가

## 로컬 실행
상위 폴더의 `.env.local`을 자동으로 읽는다. `DRY_RUN=1`이면 텔레그램 대신 콘솔 출력.
```
DRY_RUN=1 node src/jobs/daily.js
npm test
```

## 복구
```
node scripts/restore.js backup-2026-07-18.json.gz --yes
```
