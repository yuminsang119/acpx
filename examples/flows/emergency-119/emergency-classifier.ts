/**
 * 119 신고 상황 분류기
 *
 * 전처리된 텍스트를 기반으로:
 * 1. 신고 유형 분류 (화재/구급/구조)
 * 2. 긴급도 산정 (critical/high/medium/low)
 * 3. 출동 등급 결정
 */

import type {
  EmergencyCategory,
  ProcessedTranscript,
  UrgencyLevel,
} from "./korean-text-processor.js";

// ── 타입 정의 ──

export interface ClassificationResult {
  /** 주요 신고 유형 */
  primaryCategory: EmergencyCategory;
  /** 보조 유형 (복합 상황) */
  secondaryCategories: EmergencyCategory[];
  /** 유형별 점수 (0~1) */
  categoryScores: Record<EmergencyCategory, number>;
  /** 긴급도 */
  urgency: UrgencyLevel;
  /** 긴급도 점수 (0~1) */
  urgencyScore: number;
  /** 출동 등급 (1~4) */
  dispatchLevel: 1 | 2 | 3 | 4;
  /** 분류 근거 키워드 */
  evidenceKeywords: string[];
  /** 복합 재난 여부 */
  isComplex: boolean;
  /** 신뢰도 (0~1) */
  classificationConfidence: number;
}

// ── 가중치 매트릭스 ──

/** 키워드별 가중치 — 핵심 키워드는 더 높은 점수 */
const KEYWORD_WEIGHTS: Record<string, number> = {
  // 화재 핵심
  "화재": 1.0, "불이나": 0.9, "불났": 0.9, "폭발": 1.0, "화염": 0.9,
  "불길": 0.8, "번지고": 0.8, "발화": 0.9, "산불": 1.0,
  // 화재 보조
  "불": 0.5, "연기": 0.6, "그을음": 0.5, "가스냄새": 0.7,
  "스파크": 0.6, "합선": 0.7, "누전": 0.7, "인화": 0.7,

  // 구급 핵심
  "심정지": 1.0, "의식없": 0.9, "호흡곤란": 0.9, "뇌졸중": 1.0,
  "출혈": 0.8, "심장": 0.8, "아나필락시스": 1.0,
  // 구급 보조
  "쓰러": 0.6, "골절": 0.6, "화상": 0.6, "중독": 0.7,
  "경련": 0.7, "발작": 0.7, "흉통": 0.8, "마비": 0.7,
  "어지러": 0.4, "실신": 0.6, "구토": 0.4, "복통": 0.4,
  "분만": 0.8, "출산": 0.8, "진통": 0.6, "교통사고": 0.8, "사고": 0.5,

  // 구조 핵심
  "갇혀": 0.9, "갇혔": 0.9, "매몰": 1.0, "붕괴": 1.0, "익수": 0.9,
  "감전": 0.9,
  // 구조 보조
  "끼어": 0.7, "끼였": 0.7, "추락": 0.8, "전복": 0.8,
  "고립": 0.7, "물에빠": 0.9, "빠졌": 0.6, "엘리베이터": 0.6,
  "침수": 0.7, "조난": 0.8, "함몰": 0.8,
};

/** 긴급도 키워드 가중치 */
const URGENCY_WEIGHTS: Record<string, number> = {
  "살려": 1.0, "죽어": 1.0, "사람살려": 1.0,
  "위험": 0.8, "긴급": 0.8, "빨리": 0.6,
  "급해": 0.7, "빨리와": 0.7, "제발": 0.7,
  "지금당장": 0.9, "도와줘": 0.6, "큰일": 0.6,
};

// ── 분류 함수 ──

/** 유형별 점수 계산 */
function computeCategoryScores(
  transcript: ProcessedTranscript,
): Record<EmergencyCategory, number> {
  const scores: Record<EmergencyCategory, number> = {
    fire: 0,
    medical: 0,
    rescue: 0,
    unknown: 0,
  };

  for (const kw of transcript.detectedKeywords.fire) {
    scores.fire += KEYWORD_WEIGHTS[kw] ?? 0.5;
  }
  for (const kw of transcript.detectedKeywords.medical) {
    scores.medical += KEYWORD_WEIGHTS[kw] ?? 0.5;
  }
  for (const kw of transcript.detectedKeywords.rescue) {
    scores.rescue += KEYWORD_WEIGHTS[kw] ?? 0.5;
  }

  // 정규화 (0~1)
  const maxScore = Math.max(scores.fire, scores.medical, scores.rescue, 0.01);
  scores.fire /= maxScore;
  scores.medical /= maxScore;
  scores.rescue /= maxScore;

  // 키워드가 전혀 없으면 unknown 점수 높임
  if (maxScore < 0.01) {
    scores.unknown = 1.0;
  }

  return scores;
}

/** 긴급도 점수 계산 */
function computeUrgencyScore(transcript: ProcessedTranscript): number {
  let score = 0;

  // 긴급 키워드 가중치 합산
  for (const kw of transcript.detectedKeywords.urgency) {
    score += URGENCY_WEIGHTS[kw] ?? 0.5;
  }

  // 핵심 의료 키워드 보정 (심정지, 의식없음 등은 자체로 긴급)
  const criticalMedical = ["심정지", "의식없", "뇌졸중", "아나필락시스"];
  for (const kw of transcript.detectedKeywords.medical) {
    if (criticalMedical.includes(kw)) {
      score += 0.5;
    }
  }

  // 폭발/붕괴/매몰 보정
  const criticalDisaster = ["폭발", "붕괴", "매몰"];
  for (const kw of [
    ...transcript.detectedKeywords.fire,
    ...transcript.detectedKeywords.rescue,
  ]) {
    if (criticalDisaster.includes(kw)) {
      score += 0.5;
    }
  }

  // STT 신뢰도가 낮으면 긴급도 약간 보정 (불명확 → 안전 쪽으로)
  if (transcript.avgConfidence < 0.5) {
    score *= 0.8;
  }

  // 0~1 범위로 클램프
  return Math.min(score / 3.0, 1.0);
}

/** 긴급도 점수 → 레벨 변환 */
function urgencyScoreToLevel(score: number): UrgencyLevel {
  if (score >= 0.8) return "critical";
  if (score >= 0.5) return "high";
  if (score >= 0.25) return "medium";
  return "low";
}

/** 출동 등급 결정 */
function determineDispatchLevel(
  primaryCategory: EmergencyCategory,
  urgency: UrgencyLevel,
  isComplex: boolean,
): 1 | 2 | 3 | 4 {
  // 복합 재난은 최소 2등급
  const baseLevel = isComplex ? 2 : 1;

  const urgencyMap: Record<UrgencyLevel, number> = {
    critical: 3,
    high: 2,
    medium: 1,
    low: 0,
  };

  const categoryBoost: Record<EmergencyCategory, number> = {
    fire: 1,      // 화재는 기본 1등급 가산
    rescue: 0,
    medical: 0,
    unknown: 0,
  };

  const level = baseLevel + urgencyMap[urgency] + categoryBoost[primaryCategory];
  return Math.min(Math.max(level, 1), 4) as 1 | 2 | 3 | 4;
}

// ── 메인 분류기 ──

/** 전처리된 신고 텍스트를 분류 */
export function classifyEmergency(
  transcript: ProcessedTranscript,
): ClassificationResult {
  const categoryScores = computeCategoryScores(transcript);

  // 주요 유형 결정
  const categories: EmergencyCategory[] = ["fire", "medical", "rescue"];
  const sorted = categories.sort(
    (a, b) => categoryScores[b] - categoryScores[a],
  );
  const primaryCategory =
    categoryScores[sorted[0]] > 0 ? sorted[0] : "unknown";

  // 보조 유형: 주요 유형 대비 50% 이상 점수인 항목
  const secondaryCategories = sorted
    .slice(1)
    .filter(
      (c) =>
        categoryScores[c] >= 0.5 && c !== primaryCategory,
    );

  // 복합 재난 여부
  const isComplex = secondaryCategories.length > 0;

  // 긴급도
  const urgencyScore = computeUrgencyScore(transcript);
  const urgency = urgencyScoreToLevel(urgencyScore);

  // 출동 등급
  const dispatchLevel = determineDispatchLevel(
    primaryCategory,
    urgency,
    isComplex,
  );

  // 증거 키워드 수집
  const evidenceKeywords = [
    ...transcript.detectedKeywords.fire,
    ...transcript.detectedKeywords.medical,
    ...transcript.detectedKeywords.rescue,
    ...transcript.detectedKeywords.urgency,
  ];

  // 분류 신뢰도: 카테고리 점수 차이 + STT 신뢰도 반영
  const topScore = categoryScores[primaryCategory];
  const secondScore =
    secondaryCategories.length > 0
      ? categoryScores[secondaryCategories[0]]
      : 0;
  const scoreSeparation = topScore - secondScore;
  const classificationConfidence =
    primaryCategory === "unknown"
      ? 0
      : Math.min(
          (scoreSeparation * 0.5 + topScore * 0.3 + transcript.avgConfidence * 0.2),
          1.0,
        );

  return {
    primaryCategory,
    secondaryCategories,
    categoryScores,
    urgency,
    urgencyScore,
    dispatchLevel,
    evidenceKeywords,
    isComplex,
    classificationConfidence,
  };
}
