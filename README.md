# 🌤️ 기상청 날씨 앱 — Express 프록시 서버

브라우저 → Express 프록시 → 기상청 API 구조로 CORS 문제를 해결하고, 인증키를 서버 `.env`에서만 관리합니다.

## 📁 프로젝트 구조

```
weather-server/
├── server.js           # Express 프록시 서버 (메인)
├── package.json
├── .env                # 인증키 보관 (git에 올리지 말 것!)
├── .env.example        # .env 샘플
└── public/
    └── index.html      # 날씨 앱 프론트엔드
```

## 🚀 실행 방법

### 1. 의존성 설치
```bash
cd weather-server
npm install
```

### 2. 환경 변수 설정
`.env` 파일을 열어 인증키를 확인/수정:
```
KMA_SERVICE_KEY
PORT=3000
```

### 3. 서버 실행
```bash
# 일반 실행
npm start

# 개발 모드 (파일 변경 시 자동 재시작, Node.js 18+)
npm run dev
```

### 4. 브라우저 열기
```
http://localhost:3000
```

---

## 🔌 API 엔드포인트

### `GET /api/weather/all` ← 메인 (3개 API 동시)
```
GET /api/weather/all?nx=98&ny=76
```
초단기실황 + 초단기예보 + 단기예보를 한 번에 반환합니다.

**응답 예시:**
```json
{
  "ok": true,
  "nx": "98", "ny": "76",
  "ultraSrtNcst":  { "ok": true, "items": [...], "count": 8 },
  "ultraSrtFcst":  { "ok": true, "items": [...], "count": 60 },
  "vilageFcst":    { "ok": true, "items": [...], "count": 800 }
}
```

### `GET /api/weather` ← 개별 호출
| 파라미터 | 값 | 설명 |
|---|---|---|
| `type` | `ultraSrtNcst` | 초단기실황 |
| `type` | `ultraSrtFcst` | 초단기예보 (향후 6시간) |
| `type` | `vilageFcst`   | 단기예보 (3일) |
| `nx`   | 숫자 (기본 98)  | 격자 X 좌표 |
| `ny`   | 숫자 (기본 76)  | 격자 Y 좌표 |

```bash
# 부산 초단기실황
curl "http://localhost:3000/api/weather?type=ultraSrtNcst"

# 서울 단기예보 (nx=60, ny=127)
curl "http://localhost:3000/api/weather?type=vilageFcst&nx=60&ny=127"
```

### `GET /api/health` ← 헬스체크
```json
{ "ok": true, "server": "weather-proxy", "keyConfigured": true }
```

---

## 🗺️ 주요 도시 격자 좌표

| 도시 | nx | ny |
|------|----|----|
| 서울 | 60 | 127 |
| 부산 | 98 | 76  |
| 대구 | 89 | 90  |
| 인천 | 55 | 124 |
| 광주 | 58 | 74  |
| 대전 | 67 | 100 |
| 제주 | 52 | 38  |

---

## ⚙️ 아키텍처

```
브라우저 (index.html)
    │  GET /api/weather/all
    ▼
Express 서버 (server.js :3000)
    │  인증키(.env) 첨부
    │  기준시간 자동 계산
    ▼
기상청 공공데이터 API
(apis.data.go.kr)
```

- **CORS 해결**: 브라우저는 같은 origin(`localhost:3000`)에만 요청 → 서버가 기상청에 서버-서버 호출
- **인증키 보안**: `.env`에서만 관리, 브라우저에 노출되지 않음
- **자동 기준시간**: 서버에서 현재 시각 기준으로 최적 `base_date`, `base_time` 자동 계산
- **부분 장애 허용**: 3개 API 중 하나 실패해도 나머지는 정상 반환 (`Promise.allSettled`)
