/**
 * 119 신고 음성 처리 Flow
 *
 * 파이프라인:
 *   음성입력 → STT전처리 → 키워드분류(로컬) → AI상황분석 → AI출동편성 → 출동지령
 *
 * 사용법:
 *   acpx flow run examples/flows/emergency-119/emergency-119.flow.ts \
 *     --input '{"transcript": [...]}'
 *
 *   또는 샘플 데이터로:
 *   acpx flow run examples/flows/emergency-119/emergency-119.flow.ts \
 *     --file examples/flows/emergency-119/sample-calls.json
 */

import { acp, compute, defineFlow, extractJsonObject } from "../../../src/flows.js";
import { classifyEmergency } from "./emergency-classifier.js";
import type { ClassificationResult } from "./emergency-classifier.js";
import { generateDispatchRecommendation } from "./dispatch-recommendation.js";
import type { DispatchRecommendation } from "./dispatch-recommendation.js";
import {
  processTranscript,
  type ProcessedTranscript,
  type TranscriptSegment,
} from "./korean-text-processor.js";

// ── 입력 타입 ──

type EmergencyCallInput = {
  /** STT 세그먼트 배열 */
  transcript: TranscriptSegment[];
  /** 신고 접수 번호 (선택) */
  callId?: string;
  /** 신고 접수 시각 (선택) */
  receivedAt?: string;
};

// ── Flow 정의 ──

export default defineFlow({
  name: "emergency-119-call-processing",
  run: {
    title: ({ input }) => {
      const callInput = input as EmergencyCallInput;
      return `119 신고 처리${callInput.callId ? ` [${callInput.callId}]` : ""}`;
    },
  },
  startAt: "preprocess",
  nodes: {
    // ─── 1단계: STT 텍스트 전처리 (로컬) ───
    preprocess: compute({
      run: ({ input }): ProcessedTranscript => {
        const callInput = input as EmergencyCallInput;
        if (!callInput.transcript || callInput.transcript.length === 0) {
          throw new Error("transcript 세그먼트가 필요합니다.");
        }
        return processTranscript(callInput.transcript);
      },
    }),

    // ─── 2단계: 키워드 기반 1차 분류 (로컬) ───
    local_classify: compute({
      run: ({ outputs }): ClassificationResult => {
        const transcript = outputs.preprocess as ProcessedTranscript;
        return classifyEmergency(transcript);
      },
    }),

    // ─── 3단계: AI 정밀 상황 분석 ───
    ai_situation_analysis: acp({
      async prompt({ outputs }) {
        const transcript = outputs.preprocess as ProcessedTranscript;
        const localResult = outputs.local_classify as ClassificationResult;

        return [
          "당신은 119 상황실 AI 분석관입니다.",
          "아래 119 신고 내용을 분석하여 정밀 상황 판단을 수행하세요.",
          "",
          "## 신고 내용 (STT 전처리 결과)",
          `신고자 발화: ${transcript.callerText}`,
          `전체 대화: ${transcript.normalizedFullText}`,
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
          '  "questionsForCaller": ["신고자에게 추가 확인할 질문"]',
          "}",
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    // ─── 4단계: AI 출동 편성 최적화 ───
    ai_dispatch_optimization: acp({
      async prompt({ outputs }) {
        const transcript = outputs.preprocess as ProcessedTranscript;
        const localResult = outputs.local_classify as ClassificationResult;
        const aiAnalysis = outputs.ai_situation_analysis as Record<string, unknown>;
        const baseRecommendation = generateDispatchRecommendation(
          localResult,
          transcript,
        );

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
          "규칙 기반 추천안을 AI 분석 결과와 비교하여 최종 출동안을 JSON으로 반환하세요:",
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

    // ─── 5단계: 최종 출동 지령 생성 (로컬) ───
    finalize: compute({
      run: ({ input, outputs }) => {
        const callInput = input as EmergencyCallInput;
        const transcript = outputs.preprocess as ProcessedTranscript;
        const localClassification = outputs.local_classify as ClassificationResult;
        const aiAnalysis = outputs.ai_situation_analysis as Record<string, unknown>;
        const aiDispatch = outputs.ai_dispatch_optimization as Record<string, unknown>;

        return {
          // 메타
          callId: callInput.callId ?? "UNKNOWN",
          receivedAt: callInput.receivedAt ?? new Date().toISOString(),
          processedAt: new Date().toISOString(),

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
      },
    }),
  },
  edges: [
    { from: "preprocess", to: "local_classify" },
    { from: "local_classify", to: "ai_situation_analysis" },
    { from: "ai_situation_analysis", to: "ai_dispatch_optimization" },
    { from: "ai_dispatch_optimization", to: "finalize" },
  ],
});
