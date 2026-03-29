# 119 신고 음성 처리 Flow

119 상황실 신고 음성을 STT → 화자분리 → 분류 → 출동 편성 → 데이터 미러링까지 자동 처리하는 acpx Flow 파이프라인.

## 파이프라인

### 기본 Flow (`emergency-119.flow.ts`)
```
텍스트 입력 → 전처리 → 키워드 분류 → AI 상황 분석 → AI 출동 편성 → 출동 지령
```

### 전체 Flow (`emergency-119-full.flow.ts`)
```
음성파일 ──→ STT 자동변환 ──→ 화자분리 ──→ 텍스트 전처리 ──→ 키워드 분류
  (audio)    (Whisper/        (스테레오/     (정규화/         (가중치 기반)
              Clova/Google     턴테이킹/      키워드 감지)
              자동 폴백)       규칙 보정)
                                                                    │
    ┌───────────────────────────────────────────────────────────────┘
    ▼
AI 상황 분석 ──→ AI 출동 편성 ──→ 출동 지령 + 데이터 미러링
  (acp)           (acp)           (로컬/DB/스트리밍/아카이브)
```

### 단계별 설명

| 단계 | 유형 | 설명 |
|------|------|------|
| `route_input` | compute | 입력 경로 분기 (audio/stt/text) |
| `stt_transcribe` | compute | STT 자동 변환 (Whisper→Clova→Google 폴백) |
| `diarize` | compute | 화자 분리 (스테레오/프로바이더/턴테이킹) |
| `preprocess` | compute | STT 텍스트 정규화, 키워드 감지, 위치 추출 |
| `local_classify` | compute | 가중치 기반 유형 분류 + 긴급도 산정 |
| `ai_situation_analysis` | acp | 문맥 기반 정밀 상황 분석 |
| `ai_dispatch_optimization` | acp | 규칙 + AI 종합 최종 출동안 |
| `finalize` | compute | 전체 결과 통합 + 데이터 미러링 |

## 사용법

### 기본 Flow (텍스트 입력)
```bash
acpx flow run examples/flows/emergency-119/emergency-119.flow.ts \
  --input '{
    "transcript": [
      {"speaker": "caller", "text": "불이야! 아파트에 불이 났어요!", "confidence": 0.9},
      {"speaker": "caller", "text": "서울시 강남구 테헤란로 삼성아파트 12층", "confidence": 0.85}
    ],
    "callId": "CALL-001"
  }'
```

### 전체 Flow — 오디오 파일에서 시작
```bash
acpx flow run examples/flows/emergency-119/emergency-119-full.flow.ts \
  --input '{
    "audio": {
      "filePath": "/recordings/call-001.wav",
      "format": "wav",
      "sampleRate": 16000,
      "channels": 2,
      "channelMap": {"left": "operator", "right": "caller"}
    },
    "callId": "CALL-001"
  }'
```

### 전체 Flow — STT 결과에서 시작 (화자분리만)
```bash
acpx flow run examples/flows/emergency-119/emergency-119-full.flow.ts \
  --input '{
    "rawSegments": [
      {"text": "119입니다.", "startSec": 0, "endSec": 1.2, "confidence": 0.95, "speakerId": "spk_0"},
      {"text": "불이 났어요!", "startSec": 2.0, "endSec": 3.5, "confidence": 0.88, "speakerId": "spk_1"}
    ],
    "callId": "CALL-002"
  }'
```

### 미러링 비활성화
```bash
acpx flow run examples/flows/emergency-119/emergency-119-full.flow.ts \
  --input '{"audio": {...}, "enableMirror": false}'
```

## 파일 구조

```
emergency-119/
├── emergency-119.flow.ts           # 기본 Flow (텍스트 입력)
├── emergency-119-full.flow.ts      # 전체 Flow (오디오→미러링)
├── korean-text-processor.ts        # 한국어 STT 전처리 (90+ 키워드)
├── emergency-classifier.ts         # 상황 분류기 (화재/구급/구조)
├── dispatch-recommendation.ts      # 출동 편성 추천 엔진
├── stt-engine.ts                   # STT 자동화 엔진 (다중 프로바이더)
├── speaker-diarization.ts          # 화자 분리 모듈
├── data-mirror.ts                  # 데이터 미러링 모듈
├── sample-calls.json               # 샘플 텍스트 신고 (6건)
├── sample-audio-inputs.json        # 샘플 오디오 입력 메타데이터 (6건)
└── README.md
```

## STT 자동화 엔진

### 지원 프로바이더
| 프로바이더 | 유형 | 우선순위 | 설명 |
|-----------|------|---------|------|
| **Whisper** | 로컬 | 1 (기본) | OpenAI Whisper large-v3, 오프라인 가능 |
| **Clova Speech** | API | 2 | 네이버 Clova, 한국어 최적화 |
| **Google STT** | API | 3 | Google Cloud, diarization 내장 |

### 폴백 동작
```
Whisper 시도 → 실패 시 Clova → 실패 시 Google → 전체 실패 시 에러
       (재시도 2회)    (재시도 2회)     (재시도 2회)
```

### 배치 처리
```typescript
import { batchTranscribe } from "./stt-engine.js";
const result = await batchTranscribe(audioFiles, { concurrency: 3 });
```

## 화자 분리 (Speaker Diarization)

### 분리 전략 (우선순위)
| 전략 | 신뢰도 | 조건 |
|------|--------|------|
| **스테레오 채널** | 95% | 2채널 녹음 + channelMap 지정 |
| **프로바이더 태그** | 80% | STT에서 speakerId 제공 시 |
| **턴테이킹 패턴** | 60% | 침묵 간격 + 교대 발화 분석 |
| **규칙 기반 보정** | — | 모든 결과에 적용 (상황실 정형 표현) |

### 상황실 정형 표현 인식
- "119입니다", "주소가 어떻게 되시나요"
- "환자 상태를 말씀해주세요"
- "심폐소생술을 안내해드리겠습니다"
- 등 15개 패턴

### 신고자 특징 표현 인식
- "빨리 와주세요", "살려주세요", "제발"
- "불이야", "갇혀있어요"
- 주소/위치 발화 패턴
- 등 11개 패턴

## 데이터 미러링

### 미러링 대상
| 대상 | 유형 | 동기/비동기 | 보존 기간 |
|------|------|------------|----------|
| **로컬 백업** | local_fs | 동기 | 30일 |
| **중앙 DB** | REST API | 비동기 | 1년 |
| **실시간 대시보드** | WebSocket | 비동기 | 즉시 소비 |
| **장기 아카이브** | S3/NAS | 비동기 | 10년 (법적) |
| **경찰 웹훅** | webhook | 비동기 | — |

### 단계별 미러링 이벤트
```
call_received → stt_completed → classified → dispatched → call_closed
```

### 보안
- 민감정보 자동 마스킹 (주민번호, 전화번호, 카드번호)
- 대상별 필드 필터링 (웹훅에는 최소 정보만 전송)
- 데이터 분류 등급: public / internal / confidential / restricted

### 데이터 생명주기
```
실시간(즉시) → 운영 DB(30일) → 분석 DB(1년) → 아카이브(10년)
```

### 자동 정리
```typescript
import { cleanupExpiredData } from "./data-mirror.js";
await cleanupExpiredData("~/.acpx/mirror/119-calls", 30);
```

## 분류 체계

### 신고 유형
- **fire** (화재): 화재, 폭발, 가스 누출
- **medical** (구급): 심정지, 외상, 중독, 분만
- **rescue** (구조): 매몰, 갇힘, 익수, 추락
- **complex** (복합): 2개 이상 유형 동시

### 긴급도
- **critical**: 생명 위협 즉각 (심정지, 폭발, 매몰)
- **high**: 긴급 대응 필요
- **medium**: 일반 출동
- **low**: 비긴급

### 출동 등급
- **1단계**: 일반 (차량 1~2대)
- **2단계**: 보강 (차량 3~4대 + 유관기관)
- **3단계**: 대응 (다수 차량 + 현장지휘 + 다기관)
- **4단계**: 총력 (최대 동원 + 재난안전대책본부)

## 샘플 시나리오

| ID | 유형 | 시나리오 | 예상 등급 |
|----|------|----------|-----------|
| CALL-001 | 화재 | 아파트 화재, 독거노인 연락불가 | 2~3단계 |
| CALL-002 | 구급 | 공원 심정지 환자 | critical |
| CALL-003 | 구조 | 엘리베이터 갇힘 | 1단계 |
| CALL-004 | 복합 | 화학공장 폭발+화재+매몰+부상 | 4단계 |
| CALL-005 | 구급+구조 | 교통사고 전복, 끼임+골절 | 2단계 |
| CALL-006 | 화재 | 저품질 STT, 시장 화재 | 1~2단계 |

## 확장 포인트

- **실시간 스트리밍 STT**: WebSocket으로 실시간 음성 스트리밍 → 점진적 화자분리
- **센서 퓨전**: IoT 화재감지기, CCTV 영상분석 데이터를 Flow 입력에 추가
- **GIS 연동**: 출동 편성 시 실시간 도로/교통 데이터 반영
- **학습 피드백**: 실제 출동 결과를 키워드 가중치에 피드백하여 분류 정확도 개선
- **다국어 STT**: 외국인 신고자 대응 (영어, 중국어 등)
- **감정 분석**: 신고자 음성 톤/속도 기반 긴급도 보정
