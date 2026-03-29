# 119 신고 음성 처리 Flow

119 상황실 신고 음성을 STT → 분류 → 출동 편성까지 자동 처리하는 acpx Flow 파이프라인.

## 파이프라인

```
음성(STT) → 텍스트 전처리 → 키워드 분류(로컬) → AI 상황 분석 → AI 출동 편성 → 출동 지령
```

### 단계별 설명

| 단계 | 유형 | 설명 |
|------|------|------|
| `preprocess` | compute (로컬) | STT 텍스트 정규화, 키워드 감지, 위치 추출 |
| `local_classify` | compute (로컬) | 가중치 기반 유형 분류 (화재/구급/구조) + 긴급도 산정 |
| `ai_situation_analysis` | acp (AI) | 문맥 기반 정밀 상황 분석 |
| `ai_dispatch_optimization` | acp (AI) | 규칙 기반 추천 + AI 분석 종합하여 최종 출동안 확정 |
| `finalize` | compute (로컬) | 전체 결과 통합 및 출동 지령 생성 |

## 사용법

```bash
# 단일 신고 처리
acpx flow run examples/flows/emergency-119/emergency-119.flow.ts \
  --input '{
    "transcript": [
      {"speaker": "caller", "text": "불이야! 아파트에 불이 났어요!", "confidence": 0.9},
      {"speaker": "caller", "text": "서울시 강남구 테헤란로 삼성아파트 12층", "confidence": 0.85}
    ],
    "callId": "CALL-001"
  }'

# 샘플 데이터 사용 (개별 콜)
acpx flow run examples/flows/emergency-119/emergency-119.flow.ts \
  --file examples/flows/emergency-119/sample-calls.json
```

## 파일 구조

```
emergency-119/
├── emergency-119.flow.ts         # 메인 Flow 파이프라인
├── korean-text-processor.ts      # 한국어 STT 전처리 모듈
├── emergency-classifier.ts       # 상황 분류기 (화재/구급/구조)
├── dispatch-recommendation.ts    # 출동 편성 추천 엔진
├── sample-calls.json             # 샘플 신고 데이터 (6건)
└── README.md
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

## 한국어 키워드 사전

`korean-text-processor.ts`에 119 신고 특화 키워드 사전이 포함되어 있습니다:
- 화재 키워드 22개
- 구급 키워드 30개
- 구조 키워드 26개
- 긴급 표현 12개
- 위치 패턴 (시도/시군구/건물명/층호)
- 시간 표현 패턴

## 확장 포인트

- **실시간 STT 연동**: Whisper, Google STT, Clova Speech 등 STT 엔진 출력을 `TranscriptSegment[]`로 변환
- **센서 퓨전**: IoT 화재감지기, CCTV 영상분석 데이터를 Flow 입력에 추가
- **GIS 연동**: 출동 편성 시 실시간 도로/교통 데이터 반영
- **학습 피드백**: 실제 출동 결과를 키워드 가중치에 피드백하여 분류 정확도 개선
