/**
 * 119 신고 전체 파이프라인 Flow (확장판)
 *
 * 파이프라인:
 *   음성파일 → STT자동변환 → 화자분리 → 텍스트전처리 → 키워드분류
 *   → AI상황분석 → AI출동편성 → 출동지령 → 데이터미러링
 *
 * 기본 Flow(emergency-119.flow.ts)와 차이:
 *   - STT 자동화 (Whisper/Clova/Google 폴백)
 *   - 화자분리 (스테레오/프로바이더/턴테이킹)
 *   - 단계별 데이터 미러링 (로컬/DB/스트리밍/아카이브)
 *
 * 사용법:
 *   # 오디오 파일에서 시작
 *   acpx flow run examples/flows/emergency-119/emergency-119-full.flow.ts \
 *     --input '{
 *       "audio": {
 *         "filePath": "/recordings/call-001.wav",
 *         "format": "wav",
 *         "sampleRate": 16000,
 *         "channels": 2,
 *         "channelMap": {"left": "operator", "right": "caller"}
 *       },
 *       "callId": "CALL-2026-03-29-001"
 *     }'
 *
 *   # 이미 STT된 텍스트에서 시작 (화자분리만)
 *   acpx flow run examples/flows/emergency-119/emergency-119-full.flow.ts \
 *     --input '{
 *       "rawSegments": [...],
 *       "callId": "CALL-2026-03-29-002"
 *     }'
 */

import { acp, compute, defineFlow, extractJsonObject } from "../../../src/flows.js";
import { classifyEmergency } from "./emergency-classifier.js";
import type { ClassificationResult } from "./emergency-classifier.js";
import { generateDispatchRecommendation } from "./dispatch-recommendation.js";
import {
  processTranscript,
  type ProcessedTranscript,
  type TranscriptSegment,
} from "./korean-text-processor.js";
import { transcribeAudio, type RawAudioInput, type SttResult } from "./stt-engine.js";
import { diarizeSpeakers, type DiarizationResult } from "./speaker-diarization.js";
import {
  mirrorCallReceived,
  mirrorSttCompleted,
  mirrorClassified,
  mirrorDispatched,
} from "./data-mirror.js";

// ── 입력 타입 ──

type FullPipelineInput = {
  /** 오디오 파일 정보 (STT부터 시작) */
  audio?: RawAudioInput;
  /** 이미 STT된 세그먼트 (화자분리부터 시작) */
  rawSegments?: Array<{
    text: string;
    startSec: number;
    endSec: number;
    confidence: number;
    speakerId?: string;
    channel?: number;
  }>;
  /** 이미 화자분리된 세그먼트 (전처리부터 시작) */
  transcript?: TranscriptSegment[];
  /** 신고 접수 번호 */
  callId?: string;
  /** 신고 접수 시각 */
  receivedAt?: string;
  /** 데이터 미러링 활성화 (기본: true) */
  enableMirror?: boolean;
};

// ── Flow 정의 ──

export default defineFlow({
  name: "emergency-119-full-pipeline",
  run: {
    title: ({ input }) => {
      const inp = input as FullPipelineInput;
      const mode = inp.audio ? "audio" : inp.rawSegments ? "stt" : "text";
      return `119 전체 파이프라인 [${mode}] ${inp.callId ?? ""}`;
    },
  },
  startAt: "route_input",
  nodes: {
    // ─── 0단계: 입력 경로 분기 ───
    route_input: compute({
      run: ({ input }) => {
        const inp = input as FullPipelineInput;
        if (inp.audio) return { route: "from_audio", callId: inp.callId ?? `CALL-${Date.now()}` };
        if (inp.rawSegments) return { route: "from_stt", callId: inp.callId ?? `CALL-${Date.now()}` };
        if (inp.transcript) return { route: "from_transcript", callId: inp.callId ?? `CALL-${Date.now()}` };
        throw new Error("audio, rawSegments, 또는 transcript 중 하나가 필요합니다.");
      },
    }),

    // ─── 1단계: STT 자동 변환 ───
    stt_transcribe: compute({
      run: async ({ input }): Promise<SttResult> => {
        const inp = input as FullPipelineInput;
        if (!inp.audio) throw new Error("audio 입력이 필요합니다.");

        const result = await transcribeAudio(inp.audio);

        // 미러링: STT 완료
        if (inp.enableMirror !== false) {
          await mirrorSttCompleted(inp.callId ?? "UNKNOWN", {
            provider: result.provider,
            segmentCount: result.segments.length,
            durationSec: result.durationSec,
            processingTimeMs: result.processingTimeMs,
            usedFallback: result.usedFallback,
          }).catch(() => {}); // 미러링 실패는 무시
        }

        return result;
      },
    }),

    // ─── 2단계: 화자 분리 ───
    diarize: compute({
      run: ({ input, outputs }): DiarizationResult => {
        const inp = input as FullPipelineInput;
        const routeInfo = outputs.route_input as { route: string };

        if (routeInfo.route === "from_audio") {
          // STT 결과에서 화자 분리
          const sttResult = outputs.stt_transcribe as SttResult;
          return diarizeSpeakers(sttResult);
        }

        if (routeInfo.route === "from_stt" && inp.rawSegments) {
          // 외부 STT 세그먼트로 화자 분리
          const fakeSttResult: SttResult = {
            provider: "custom",
            audioInfo: inp.audio ?? {
              filePath: "",
              format: "wav",
              sampleRate: 16000,
              channels: 1,
            },
            segments: inp.rawSegments,
            durationSec: inp.rawSegments.length > 0
              ? Math.max(...inp.rawSegments.map((s) => s.endSec))
              : 0,
            processingTimeMs: 0,
            usedFallback: false,
            fallbackHistory: [],
          };
          return diarizeSpeakers(fakeSttResult);
        }

        // from_transcript: 이미 화자분리됨
        return {
          segments: inp.transcript ?? [],
          method: "stereo_channel",
          speakerStats: {
            caller: { turnCount: 0, totalDurationSec: 0, avgUtteranceLength: 0, firstTurnSec: 0 },
            operator: { turnCount: 0, totalDurationSec: 0, avgUtteranceLength: 0, firstTurnSec: 0 },
          },
          confidence: 1.0,
          warnings: [],
        };
      },
    }),

    // ─── 3단계: 텍스트 전처리 ───
    preprocess: compute({
      run: ({ outputs }): ProcessedTranscript => {
        const diarization = outputs.diarize as DiarizationResult;
        if (diarization.segments.length === 0) {
          throw new Error("화자분리 후 세그먼트가 비어있습니다.");
        }
        return processTranscript(diarization.segments);
      },
    }),

    // ─── 4단계: 키워드 기반 1차 분류 ───
    local_classify: compute({
      run: ({ input, outputs }) => {
        const inp = input as FullPipelineInput;
        const transcript = outputs.preprocess as ProcessedTranscript;
        const result = classifyEmergency(transcript);

        // 미러링: 분류 완료
        if (inp.enableMirror !== false) {
          mirrorClassified(inp.callId ?? "UNKNOWN", {
            primaryCategory: result.primaryCategory,
            urgency: result.urgency,
            dispatchLevel: result.dispatchLevel,
            confidence: result.classificationConfidence,
          }).catch(() => {});
        }

        return result;
      },
    }),

    // ─── 5단계: AI 정밀 상황 분석 ───
    ai_situation_analysis: acp({
      async prompt({ outputs }) {
        const transcript = outputs.preprocess as ProcessedTranscript;
        const localResult = outputs.local_classify as ClassificationResult;
        const diarization = outputs.diarize as DiarizationResult;

        return [
          "당신은 119 상황실 AI 분석관입니다.",
          "아래 119 신고 내용을 분석하여 정밀 상황 판단을 수행하세요.",
          "",
          "## 신고 내용 (STT + 화자분리 결과)",
          `화자분리 방법: ${diarization.method} (신뢰도: ${(diarization.confidence * 100).toFixed(0)}%)`,
          `신고자 발화 횟수: ${diarization.speakerStats.caller.turnCount}회`,
          `상황실 발화 횟수: ${diarization.speakerStats.operator.turnCount}회`,
          "",
          "### 대화 내용",
          ...diarization.segments.map(
            (s) => `[${s.speaker === "caller" ? "신고자" : "상황실"}] ${s.text}`,
          ),
          "",
          "## 감지된 키워드",
          `화재: ${transcript.detectedKeywords.fire.join(", ") || "없음"}`,
          `구급: ${transcript.detectedKeywords.medical.join(", ") || "없음"}`,
          `구조: ${transcript.detectedKeywords.rescue.join(", ") || "없음"}`,
          `긴급 표현: ${transcript.detectedKeywords.urgency.join(", ") || "없음"}`,
          "",
          "## 추출된 위치",
          transcript.extractedLocations.join(", ") || "위치 미확인",
          "",
          "## 1차 자동 분류 결과",
          `유형: ${localResult.primaryCategory}`,
          `긴급도: ${localResult.urgency}`,
          `출동등급: ${localResult.dispatchLevel}단계`,
          `신뢰도: ${(localResult.classificationConfidence * 100).toFixed(0)}%`,
          diarization.warnings.length > 0
            ? `\n## 경고\n${diarization.warnings.join("\n")}`
            : "",
          "",
          "## 요청사항",
          "다음을 JSON으로 반환하세요:",
          "{",
          '  "situationSummary": "상황 요약 (1~2문장)",',
          '  "refinedCategory": "fire | medical | rescue | complex",',
          '  "refinedUrgency": "critical | high | medium | low",',
          '  "patientCount": 예상 환자수 (숫자),',
          '  "hazards": ["위험 요소 목록"],',
          '  "recommendedActions": ["즉시 조치 사항"],',
          '  "questionsForCaller": ["신고자에게 추가 확인할 질문"],',
          '  "diarizationFeedback": "화자분리 품질에 대한 의견"',
          "}",
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    // ─── 6단계: AI 출동 편성 최적화 ───
    ai_dispatch_optimization: acp({
      async prompt({ outputs }) {
        const transcript = outputs.preprocess as ProcessedTranscript;
        const localResult = outputs.local_classify as ClassificationResult;
        const aiAnalysis = outputs.ai_situation_analysis as Record<string, unknown>;
        const baseRecommendation = generateDispatchRecommendation(localResult, transcript);

        return [
          "당신은 119 상황실 출동 편성 AI입니다.",
          "아래 분석 결과를 종합하여 최적 출동 편성안을 확정하세요.",
          "",
          "## AI 상황 분석",
          JSON.stringify(aiAnalysis, null, 2),
          "",
          "## 시스템 추천 출동안 (규칙 기반)",
          JSON.stringify(baseRecommendation, null, 2),
          "",
          "## 추출된 위치",
          transcript.extractedLocations.join(", ") || "위치 미확인",
          "",
          "## 요청사항",
          "최종 출동안을 JSON으로 반환하세요:",
          "{",
          '  "finalDispatchLevel": 1~4,',
          '  "finalVehicles": [{"type": "차량명", "count": 대수, "reason": "사유"}],',
          '  "finalPersonnel": [{"role": "역할", "count": 인원수}],',
          '  "notifications": [{"agency": "기관명", "reason": "사유", "priority": "immediate|normal"}],',
          '  "fieldInstructions": ["현장 지시사항"],',
          '  "dispatchOrderText": "출동 지령문 (상황실 낭독용, 한국어 2~3문장)",',
          '  "estimatedResponseMinutes": 예상 소요 시간(분),',
          '  "adjustments": ["규칙 기반 대비 변경 사항과 근거"]',
          "}",
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    // ─── 7단계: 최종 결과 + 미러링 ───
    finalize: compute({
      run: async ({ input, outputs }) => {
        const inp = input as FullPipelineInput;
        const callId = inp.callId ?? "UNKNOWN";
        const diarization = outputs.diarize as DiarizationResult;
        const transcript = outputs.preprocess as ProcessedTranscript;
        const localClassification = outputs.local_classify as ClassificationResult;
        const aiAnalysis = outputs.ai_situation_analysis as Record<string, unknown>;
        const aiDispatch = outputs.ai_dispatch_optimization as Record<string, unknown>;
        const sttResult = outputs.stt_transcribe as SttResult | undefined;

        const finalResult = {
          // 메타
          callId,
          receivedAt: inp.receivedAt ?? new Date().toISOString(),
          processedAt: new Date().toISOString(),
          pipelineMode: inp.audio ? "full_audio" : inp.rawSegments ? "from_stt" : "from_text",

          // STT 결과
          stt: sttResult
            ? {
                provider: sttResult.provider,
                durationSec: sttResult.durationSec,
                processingTimeMs: sttResult.processingTimeMs,
                usedFallback: sttResult.usedFallback,
                fallbackHistory: sttResult.fallbackHistory,
              }
            : null,

          // 화자분리 결과
          diarization: {
            method: diarization.method,
            confidence: diarization.confidence,
            speakerStats: diarization.speakerStats,
            warnings: diarization.warnings,
            conversation: diarization.segments.map((s) => ({
              speaker: s.speaker,
              text: s.text,
              timestampSec: s.timestampSec,
            })),
          },

          // 분석 결과
          transcript: {
            callerText: transcript.callerText,
            locations: transcript.extractedLocations,
            avgSttConfidence: transcript.avgConfidence,
          },
          classification: {
            local: {
              category: localClassification.primaryCategory,
              urgency: localClassification.urgency,
              dispatchLevel: localClassification.dispatchLevel,
              confidence: localClassification.classificationConfidence,
            },
            ai: aiAnalysis,
          },

          // 최종 출동 지령
          dispatch: aiDispatch,
        };

        // 미러링: 출동 지령
        if (inp.enableMirror !== false) {
          await mirrorDispatched(callId, finalResult as unknown as Record<string, unknown>)
            .catch(() => {});
        }

        return finalResult;
      },
    }),
  },
  edges: [
    // 입력 라우팅
    {
      from: "route_input",
      switch: {
        on: "$.route",
        cases: {
          from_audio: "stt_transcribe",
          from_stt: "diarize",
          from_transcript: "diarize",
        },
      },
    },
    // STT → 화자분리
    { from: "stt_transcribe", to: "diarize" },
    // 화자분리 → 전처리 → 분류 → AI 분석 → 출동 편성 → 최종
    { from: "diarize", to: "preprocess" },
    { from: "preprocess", to: "local_classify" },
    { from: "local_classify", to: "ai_situation_analysis" },
    { from: "ai_situation_analysis", to: "ai_dispatch_optimization" },
    { from: "ai_dispatch_optimization", to: "finalize" },
  ],
});
