/**
 * 기상청 API 프록시 서버
 * - CORS 문제 해결: 브라우저 → 이 서버(localhost) → 기상청 API
 * - 인증키 노출 방지: .env에서 관리
 * - 엔드포인트: GET /api/weather?type=...&nx=...&ny=...
 */

import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { config } from 'dotenv';

config(); // .env 로드

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const KMA_KEY = process.env.KMA_SERVICE_KEY;
const KMA_BASE = 'https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0';

// ─────────────────────────────────────────────
// 유효한 엔드포인트 화이트리스트 (보안)
// ─────────────────────────────────────────────
const ALLOWED_ENDPOINTS = new Set([
  'getUltraSrtNcst',   // 초단기실황
  'getUltraSrtFcst',   // 초단기예보
  'getVilageFcst',     // 단기예보
]);

// ─────────────────────────────────────────────
// 미들웨어
// ─────────────────────────────────────────────
app.use(express.json());

// CORS: 개발 중 모두 허용, 운영 시 origin 제한 가능
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 요청 로그
app.use((req, res, next) => {
  const ts = new Date().toLocaleTimeString('ko-KR');
  console.log(`[${ts}] ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────
// 정적 파일 서빙 (index.html → public/index.html)
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// 날짜/시간 계산 헬퍼 (서버에서도 동일 로직 사용)
// ─────────────────────────────────────────────

/** 단기예보 기준 시간 (02, 05, 08, 11, 14, 17, 20, 23시) */
function getBaseDateTime() {
  const now = new Date();
  const hours = [2, 5, 8, 11, 14, 17, 20, 23];
  const h = now.getHours();
  const m = now.getMinutes();
  const safeMinutes = h * 60 + m - 10;
  let baseH = 23;
  let baseDate = new Date(now);
  let found = false;

  for (let i = hours.length - 1; i >= 0; i--) {
    if (safeMinutes >= hours[i] * 60 + 10) {
      baseH = hours[i];
      found = true;
      break;
    }
  }
  if (!found) {
    baseDate.setDate(baseDate.getDate() - 1);
    baseH = 23;
  }

  const y = baseDate.getFullYear();
  const mo = String(baseDate.getMonth() + 1).padStart(2, '0');
  const d = String(baseDate.getDate()).padStart(2, '0');
  return {
    base_date: `${y}${mo}${d}`,
    base_time: `${String(baseH).padStart(2, '0')}00`,
  };
}

/** 초단기실황/예보 기준 시간 (매 시각 :40 이후) */
function getUltraSrtBaseTime() {
  const now = new Date();
  let h = now.getHours();
  const m = now.getMinutes();
  const baseDate = new Date(now);

  if (m < 40) {
    h -= 1;
    if (h < 0) {
      h = 23;
      baseDate.setDate(baseDate.getDate() - 1);
    }
  }

  const y = baseDate.getFullYear();
  const mo = String(baseDate.getMonth() + 1).padStart(2, '0');
  const d = String(baseDate.getDate()).padStart(2, '0');
  return {
    base_date: `${y}${mo}${d}`,
    base_time: `${String(h).padStart(2, '0')}00`,
  };
}

// ─────────────────────────────────────────────
// 핵심 프록시 함수
// ─────────────────────────────────────────────
async function proxyKMA(endpoint, extraParams) {
  if (!KMA_KEY) throw new Error('KMA_SERVICE_KEY가 .env에 설정되지 않았습니다');

  // serviceKey는 URLSearchParams에 넣지 않고 직접 조합 (이중 인코딩 방지)
  const params = new URLSearchParams({
    pageNo: '1',
    numOfRows: '1000',
    dataType: 'JSON',
    ...extraParams,
  });

  const url = `${KMA_BASE}/${endpoint}?authKey=${KMA_KEY}&${params.toString()}`;
  console.log(`  → KMA 요청: ${endpoint} (base_date=${extraParams.base_date}, base_time=${extraParams.base_time})`);

  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 10000,
  });

  if (!resp.ok) {
    throw new Error(`기상청 HTTP 오류: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json();
  const resultCode = json?.response?.header?.resultCode;
  const resultMsg = json?.response?.header?.resultMsg || '알 수 없는 오류';

  if (resultCode && resultCode !== '00') {
    throw new Error(`기상청 API 오류 [${resultCode}]: ${resultMsg}`);
  }

  const items = json?.response?.body?.items?.item;
  return Array.isArray(items) ? items : (items ? [items] : []);
}

// ─────────────────────────────────────────────
// GET /api/weather
// query params:
//   type  = ultraSrtNcst | ultraSrtFcst | vilageFcst
//   nx    = 격자 X (기본 98 = 부산)
//   ny    = 격자 Y (기본 76 = 부산)
// ─────────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
  const { type, nx = '98', ny = '76' } = req.query;

  // 타입 검증
  const typeMap = {
    ultraSrtNcst: 'getUltraSrtNcst',
    ultraSrtFcst: 'getUltraSrtFcst',
    vilageFcst:   'getVilageFcst',
  };

  if (!typeMap[type]) {
    return res.status(400).json({
      ok: false,
      error: `유효하지 않은 type: "${type}". 허용값: ${Object.keys(typeMap).join(', ')}`,
    });
  }

  const endpoint = typeMap[type];

  // 기준 시간 자동 계산
  const isUltra = type === 'ultraSrtNcst' || type === 'ultraSrtFcst';
  const timePart = isUltra ? getUltraSrtBaseTime() : getBaseDateTime();

  try {
    const items = await proxyKMA(endpoint, {
      ...timePart,
      nx,
      ny,
    });

    console.log(`  ← ${endpoint} 응답: ${items.length}건`);

    res.json({
      ok: true,
      type,
      nx,
      ny,
      ...timePart,
      count: items.length,
      items,
    });
  } catch (err) {
    console.error(`  ✗ 오류:`, err.message);
    res.status(502).json({
      ok: false,
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// GET /api/weather/all  — 세 API 동시 호출
// query params:
//   nx, ny (기본 부산 98, 76)
// ─────────────────────────────────────────────
app.get('/api/weather/all', async (req, res) => {
  const { nx = '98', ny = '76' } = req.query;
  const ultraTime = getUltraSrtBaseTime();
  const vilageTime = getBaseDateTime();

  console.log(`  → 전체 기상 데이터 동시 요청 (nx=${nx}, ny=${ny})`);
  console.log(`    초단기 기준: ${ultraTime.base_date} ${ultraTime.base_time}`);
  console.log(`    단기예보 기준: ${vilageTime.base_date} ${vilageTime.base_time}`);

  const [ncstResult, ultraFcstResult, vilageFcstResult] = await Promise.allSettled([
    proxyKMA('getUltraSrtNcst', { ...ultraTime, nx, ny }),
    proxyKMA('getUltraSrtFcst', { ...ultraTime, nx, ny }),
    proxyKMA('getVilageFcst',   { ...vilageTime, nx, ny }),
  ]);

  const pick = (r) =>
    r.status === 'fulfilled'
      ? { ok: true, items: r.value, count: r.value.length }
      : { ok: false, error: r.reason?.message || '오류', items: [] };

  res.json({
    ok: true,
    nx,
    ny,
    ultraSrtTime: ultraTime,
    vilageFcstTime: vilageTime,
    ultraSrtNcst:  pick(ncstResult),
    ultraSrtFcst:  pick(ultraFcstResult),
    vilageFcst:    pick(vilageFcstResult),
  });
});

// ─────────────────────────────────────────────
// AI 응답 후처리 — 한자·영단어 → 한국어 변환
// ─────────────────────────────────────────────
function cleanKorean(text) {
  // 한자(CJK 통합 한자) 제거
  text = text.replace(/[\u4E00-\u9FFF\u3400-\u4DBF]/g, '');

  // 자주 등장하는 영단어 → 한국어 치환
  const replacements = [
    [/\bsudden(ly)?\b/gi, '갑자기'],
    [/\bweather\b/gi, '날씨'],
    [/\btemperature\b/gi, '기온'],
    [/\bhumidity\b/gi, '습도'],
    [/\bwind\b/gi, '바람'],
    [/\brain\b/gi, '비'],
    [/\bcloud(y)?\b/gi, '흐림'],
    [/\bsunny\b/gi, '맑음'],
    [/\bforecast\b/gi, '예보'],
    [/\bcomfortable\b/gi, '쾌적한'],
    [/\bchange(s)?\b/gi, '변화'],
    [/\bactivit(y|ies)\b/gi, '활동'],
    [/\boutdoor\b/gi, '야외'],
    [/\bseason(al)?\b/gi, '계절'],
    [/\bspring\b/gi, '봄'],
    [/\bsummer\b/gi, '여름'],
    [/\bfall|autumn\b/gi, '가을'],
    [/\bwinter\b/gi, '겨울'],
    [/\brecommend(ed)?\b/gi, '추천'],
    [/\bcareful(ly)?\b/gi, '주의'],
    [/\bhealth(y)?\b/gi, '건강'],
    [/\bprepare\b/gi, '준비'],
    // 남은 영문 단어(연속 알파벳 2자 이상) 제거
    [/\b[a-zA-Z]{2,}\b/g, ''],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  // 중복 공백·빈 줄 정리
  text = text.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

// ─────────────────────────────────────────────
// POST /api/ai  — Groq 프록시
// body: { prompt: string }
// ─────────────────────────────────────────────
app.post('/api/ai', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt 필드가 필요합니다.' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) {
    return res.status(500).json({ ok: false, error: 'GROQ_API_KEY가 .env에 설정되지 않았습니다.' });
  }

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: '당신은 한국어 날씨 분석 전문가입니다. 반드시 순수한 한국어로만 답변하세요. 한자, 중국어, 일본어, 영어 단어를 절대 사용하지 마세요.' },
          { role: 'user', content: prompt }
        ],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      if (resp.status === 429) throw new Error('요청 한도 초과 (429) — 잠시 후 다시 시도해 주세요.');
      throw new Error(`Groq API 오류 ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const raw  = data.choices?.[0]?.message?.content || '';
    const text = cleanKorean(raw);  // 후처리 적용
    res.json({ ok: true, text });
  } catch (err) {
    console.error('  ✗ AI 프록시 오류:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// 헬스체크
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    server: 'weather-proxy',
    time: new Date().toISOString(),
    keyConfigured: !!KMA_KEY,
  });
});

// ─────────────────────────────────────────────
// SPA 폴백 (public/index.html)
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('🌤️  기상청 날씨 프록시 서버 시작');
  console.log(`   주소:     http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api/weather?type=ultraSrtNcst`);
  console.log(`   전체:     http://localhost:${PORT}/api/weather/all`);
  console.log(`   헬스체크: http://localhost:${PORT}/api/health`);
  console.log(`   인증키:   ${KMA_KEY ? '✅ 설정됨' : '❌ .env에 KMA_SERVICE_KEY 없음'}`);
  console.log('');
});
