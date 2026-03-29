/**
 * 119 출동 편성 추천 모듈
 *
 * 분류 결과를 기반으로:
 * 1. 필요 차량/장비 편성
 * 2. 필요 인력 산정
 * 3. 유관기관 통보 대상 결정
 * 4. 구조화된 출동 지령 생성
 */

import type { ClassificationResult } from "./emergency-classifier.js";
import type { ProcessedTranscript } from "./korean-text-processor.js";

// ── 타입 정의 ──

export interface VehicleDispatch {
  type: string;
  count: number;
  reason: string;
}

export interface PersonnelDispatch {
  role: string;
  count: number;
}

export interface AgencyNotification {
  agency: string;
  reason: string;
  priority: "immediate" | "normal";
}

export interface DispatchRecommendation {
  /** 출동 등급 (1~4) */
  dispatchLevel: 1 | 2 | 3 | 4;
  /** 출동 등급 명칭 */
  dispatchLevelName: string;
  /** 차량 편성 */
  vehicles: VehicleDispatch[];
  /** 인력 편성 */
  personnel: PersonnelDispatch[];
  /** 유관기관 통보 */
  notifications: AgencyNotification[];
  /** 현장 주의사항 */
  fieldNotes: string[];
  /** 출동 지령 요약 (상황실 안내용) */
  dispatchSummary: string;
  /** 추가 정보 필요 여부 */
  needsMoreInfo: string[];
}

// ── 등급별 명칭 ──

const DISPATCH_LEVEL_NAMES: Record<number, string> = {
  1: "대응 1단계 (일반)",
  2: "대응 2단계 (보강)",
  3: "대응 3단계 (대응)",
  4: "대응 4단계 (총력)",
};

// ── 차량 편성 규칙 ──

function recommendVehicles(
  classification: ClassificationResult,
): VehicleDispatch[] {
  const vehicles: VehicleDispatch[] = [];
  const { primaryCategory, dispatchLevel, isComplex } = classification;

  if (primaryCategory === "fire" || classification.categoryScores.fire >= 0.5) {
    // 화재 차량 편성
    const pumpCount = Math.min(dispatchLevel, 4);
    vehicles.push({
      type: "펌프차",
      count: pumpCount,
      reason: `화재 대응 ${dispatchLevel}단계`,
    });

    if (dispatchLevel >= 2) {
      vehicles.push({
        type: "물탱크차",
        count: Math.ceil(dispatchLevel / 2),
        reason: "급수 지원",
      });
    }

    if (dispatchLevel >= 3) {
      vehicles.push({
        type: "고가사다리차",
        count: 1,
        reason: "고층부 진입/인명구조",
      });
    }

    // 화재 시 구급차 기본 배치
    vehicles.push({
      type: "구급차",
      count: Math.max(1, dispatchLevel - 1),
      reason: "화재 현장 인명피해 대비",
    });
  }

  if (primaryCategory === "medical" || classification.categoryScores.medical >= 0.5) {
    const ambulanceCount =
      classification.urgency === "critical" ? 2 : 1;
    vehicles.push({
      type: "구급차",
      count: ambulanceCount,
      reason:
        classification.urgency === "critical"
          ? "심정지/중증 환자 (ALS 구급차)"
          : "응급 환자 이송",
    });

    if (classification.urgency === "critical") {
      vehicles.push({
        type: "닥터카",
        count: 1,
        reason: "전문 의료진 현장 투입",
      });
    }
  }

  if (primaryCategory === "rescue" || classification.categoryScores.rescue >= 0.5) {
    vehicles.push({
      type: "구조공작차",
      count: 1,
      reason: "구조 장비 투입",
    });

    if (isComplex || dispatchLevel >= 3) {
      vehicles.push({
        type: "중장비 운반차",
        count: 1,
        reason: "매몰/붕괴 대응",
      });
    }

    vehicles.push({
      type: "구급차",
      count: 1,
      reason: "구조 현장 응급 처치",
    });
  }

  if (primaryCategory === "unknown") {
    vehicles.push({
      type: "펌프차",
      count: 1,
      reason: "미분류 신고 기본 대응",
    });
    vehicles.push({
      type: "구급차",
      count: 1,
      reason: "미분류 신고 기본 대응",
    });
  }

  // 중복 차량 타입 합산
  return mergeVehicles(vehicles);
}

function mergeVehicles(vehicles: VehicleDispatch[]): VehicleDispatch[] {
  const map = new Map<string, VehicleDispatch>();
  for (const v of vehicles) {
    const existing = map.get(v.type);
    if (existing) {
      existing.count = Math.max(existing.count, v.count);
      if (!existing.reason.includes(v.reason)) {
        existing.reason += ` / ${v.reason}`;
      }
    } else {
      map.set(v.type, { ...v });
    }
  }
  return [...map.values()];
}

// ── 인력 편성 ──

function recommendPersonnel(
  classification: ClassificationResult,
): PersonnelDispatch[] {
  const personnel: PersonnelDispatch[] = [];
  const { primaryCategory, dispatchLevel } = classification;

  if (primaryCategory === "fire") {
    personnel.push({ role: "소방관 (진화)", count: dispatchLevel * 4 });
    personnel.push({ role: "소방관 (인명검색)", count: dispatchLevel * 2 });
    if (dispatchLevel >= 3) {
      personnel.push({ role: "현장지휘관", count: 1 });
    }
  }

  if (primaryCategory === "medical") {
    personnel.push({ role: "응급구조사", count: 2 });
    if (classification.urgency === "critical") {
      personnel.push({ role: "전문의 (닥터카)", count: 1 });
    }
  }

  if (primaryCategory === "rescue") {
    personnel.push({ role: "구조대원", count: dispatchLevel * 3 });
    personnel.push({ role: "응급구조사", count: 1 });
  }

  if (primaryCategory === "unknown") {
    personnel.push({ role: "소방관", count: 4 });
    personnel.push({ role: "응급구조사", count: 2 });
  }

  return personnel;
}

// ── 유관기관 통보 ──

function recommendNotifications(
  classification: ClassificationResult,
  transcript: ProcessedTranscript,
): AgencyNotification[] {
  const notifications: AgencyNotification[] = [];
  const { primaryCategory, dispatchLevel, isComplex } = classification;
  const keywords = [
    ...transcript.detectedKeywords.fire,
    ...transcript.detectedKeywords.medical,
    ...transcript.detectedKeywords.rescue,
  ];

  // 대규모 재난 → 경찰 교통통제
  if (dispatchLevel >= 2) {
    notifications.push({
      agency: "경찰 (112)",
      reason: "현장 교통 통제 및 치안 유지",
      priority: dispatchLevel >= 3 ? "immediate" : "normal",
    });
  }

  // 가스 관련
  if (keywords.some((k) => ["가스냄새", "폭발"].includes(k))) {
    notifications.push({
      agency: "가스안전공사",
      reason: "가스 누출/폭발 위험",
      priority: "immediate",
    });
  }

  // 전기 관련
  if (keywords.some((k) => ["합선", "누전", "감전", "스파크"].includes(k))) {
    notifications.push({
      agency: "한국전력",
      reason: "전기 차단 필요",
      priority: "immediate",
    });
  }

  // 구급 중증
  if (
    primaryCategory === "medical" &&
    classification.urgency === "critical"
  ) {
    notifications.push({
      agency: "응급의료센터",
      reason: "중증 환자 수용 준비 요청",
      priority: "immediate",
    });
  }

  // 대규모 재난
  if (dispatchLevel >= 3) {
    notifications.push({
      agency: "지자체 재난안전대책본부",
      reason: `대응 ${dispatchLevel}단계 발령`,
      priority: "immediate",
    });
  }

  // 복합 재난 + 화재
  if (isComplex && primaryCategory === "fire") {
    notifications.push({
      agency: "환경부",
      reason: "유해물질 방출 가능성 모니터링",
      priority: "normal",
    });
  }

  return notifications;
}

// ── 현장 주의사항 ──

function generateFieldNotes(
  classification: ClassificationResult,
  transcript: ProcessedTranscript,
): string[] {
  const notes: string[] = [];
  const keywords = [
    ...transcript.detectedKeywords.fire,
    ...transcript.detectedKeywords.rescue,
  ];

  if (keywords.includes("폭발")) {
    notes.push("2차 폭발 위험 — 안전거리 확보 후 진입");
  }
  if (keywords.includes("가스냄새")) {
    notes.push("가스 누출 — 점화원 제거, 환기 우선");
  }
  if (keywords.includes("붕괴") || keywords.includes("매몰")) {
    notes.push("2차 붕괴 위험 — 구조물 안전 확인 후 진입");
  }
  if (keywords.includes("감전")) {
    notes.push("감전 위험 — 전원 차단 확인 후 접근");
  }
  if (keywords.includes("침수")) {
    notes.push("침수 지역 — 수심 확인, 감전 주의");
  }
  if (classification.urgency === "critical") {
    notes.push("긴급 — 골든타임 확보 최우선");
  }
  if (transcript.avgConfidence < 0.5) {
    notes.push("STT 신뢰도 낮음 — 현장 도착 후 상황 재확인 필요");
  }

  return notes;
}

// ── 추가 정보 필요 여부 ──

function checkMissingInfo(
  transcript: ProcessedTranscript,
  classification: ClassificationResult,
): string[] {
  const missing: string[] = [];

  if (transcript.extractedLocations.length === 0) {
    missing.push("정확한 주소/위치 확인 필요");
  }

  if (classification.primaryCategory === "unknown") {
    missing.push("신고 유형 불명 — 신고자에게 상황 재확인 필요");
  }

  if (transcript.avgConfidence < 0.4) {
    missing.push("음성 인식 불량 — 핵심 내용 재질문 필요");
  }

  if (
    classification.primaryCategory === "medical" &&
    !transcript.detectedKeywords.medical.some((k) =>
      ["의식없", "심정지", "호흡곤란"].includes(k),
    )
  ) {
    missing.push("환자 의식/호흡 상태 확인 필요");
  }

  return missing;
}

// ── 출동 지령 요약 생성 ──

function generateSummary(
  classification: ClassificationResult,
  transcript: ProcessedTranscript,
  vehicles: VehicleDispatch[],
): string {
  const categoryNames: Record<string, string> = {
    fire: "화재",
    medical: "구급",
    rescue: "구조",
    unknown: "미분류",
  };

  const location =
    transcript.extractedLocations.length > 0
      ? transcript.extractedLocations.join(" ")
      : "(위치 미확인)";

  const typeName = categoryNames[classification.primaryCategory] ?? "미분류";
  const vehicleList = vehicles.map((v) => `${v.type} ${v.count}대`).join(", ");

  return [
    `[${DISPATCH_LEVEL_NAMES[classification.dispatchLevel]}]`,
    `${typeName} 신고 — ${location}`,
    `출동 편성: ${vehicleList}`,
    `긴급도: ${classification.urgency.toUpperCase()}`,
    classification.isComplex
      ? `(복합 상황: ${classification.secondaryCategories.map((c) => categoryNames[c]).join("+")})`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── 메인 추천 함수 ──

/** 분류 결과 + 전처리 텍스트로 출동 추천 생성 */
export function generateDispatchRecommendation(
  classification: ClassificationResult,
  transcript: ProcessedTranscript,
): DispatchRecommendation {
  const vehicles = recommendVehicles(classification);
  const personnel = recommendPersonnel(classification);
  const notifications = recommendNotifications(classification, transcript);
  const fieldNotes = generateFieldNotes(classification, transcript);
  const needsMoreInfo = checkMissingInfo(transcript, classification);
  const dispatchSummary = generateSummary(classification, transcript, vehicles);

  return {
    dispatchLevel: classification.dispatchLevel,
    dispatchLevelName: DISPATCH_LEVEL_NAMES[classification.dispatchLevel],
    vehicles,
    personnel,
    notifications,
    fieldNotes,
    dispatchSummary,
    needsMoreInfo,
  };
}
