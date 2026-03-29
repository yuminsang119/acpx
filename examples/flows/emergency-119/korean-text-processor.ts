/**
 * 119 신고 음성 → 텍스트 전처리 모듈
 *
 * STT(Speech-to-Text) 출력을 정규화하고,
 * 119 신고에 특화된 한국어 텍스트 처리를 수행합니다.
 */

// ── 한국어 119 신고 키워드 사전 ──

/** 화재 관련 키워드 */
export const FIRE_KEYWORDS = [
  "불", "화재", "연기", "불이나", "불났", "타고있", "폭발", "가스냄새",
  "그을음", "화염", "번지고", "스파크", "합선", "누전", "인화",
  "불꽃", "불길", "연소", "발화", "잔불", "산불", "들불",
] as const;

/** 구급 관련 키워드 */
export const MEDICAL_KEYWORDS = [
  "쓰러", "의식없", "심정지", "호흡곤란", "출혈", "골절", "화상",
  "중독", "경련", "발작", "흉통", "두통", "복통", "구토",
  "어지러", "실신", "숨못", "숨을못", "심장", "뇌졸중", "마비",
  "알레르기", "아나필락시스", "과호흡", "저혈당", "고혈압",
  "분만", "출산", "진통", "교통사고", "사고",
] as const;

/** 구조 관련 키워드 */
export const RESCUE_KEYWORDS = [
  "갇혀", "갇혔", "끼어", "끼였", "매몰", "붕괴", "추락", "전복",
  "고립", "표류", "익수", "물에빠", "빠졌", "엘리베이터", "승강기",
  "잠겨", "낙하", "침수", "고층", "절벽", "산악", "조난",
  "실종", "수색", "함몰", "감전",
] as const;

/** 위치 표현 패턴 */
export const LOCATION_PATTERNS = [
  /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|도|특별자치도)?/g,
  /(?:\S+(?:시|군|구))\s*(?:\S+(?:동|읍|면|리|가|로|길))/g,
  /(?:\S+(?:아파트|빌라|오피스텔|빌딩|상가|공장|학교|병원|마트|시장))/g,
  /(?:\d+층|\d+호|\d+동)/g,
  /지하\s*\d+층/g,
] as const;

/** 시간 표현 패턴 */
export const TIME_PATTERNS = [
  /(?:방금|지금|조금\s*전|아까|\d+분\s*전|\d+시간\s*전)/g,
  /(?:오전|오후|새벽|저녁|밤)\s*\d{1,2}시/g,
] as const;

/** 긴급도 표현 (높음) */
export const URGENCY_HIGH_MARKERS = [
  "빨리", "급해", "살려", "죽어", "위험", "긴급", "빨리와",
  "제발", "지금당장", "사람살려", "도와줘", "큰일",
] as const;

// ── 타입 정의 ──

export type EmergencyCategory = "fire" | "medical" | "rescue" | "unknown";

export type UrgencyLevel = "critical" | "high" | "medium" | "low";

export interface TranscriptSegment {
  /** 발화자: caller(신고자) | operator(상황실) */
  speaker: "caller" | "operator";
  /** 발화 텍스트 */
  text: string;
  /** 타임스탬프 (초) */
  timestampSec?: number;
  /** STT 신뢰도 (0~1) */
  confidence?: number;
}

export interface ProcessedTranscript {
  /** 원본 세그먼트 */
  segments: TranscriptSegment[];
  /** 전체 텍스트 (정규화됨) */
  normalizedFullText: string;
  /** 감지된 키워드 */
  detectedKeywords: {
    fire: string[];
    medical: string[];
    rescue: string[];
    urgency: string[];
  };
  /** 추출된 위치 정보 */
  extractedLocations: string[];
  /** 추출된 시간 정보 */
  extractedTimeRefs: string[];
  /** 신고자 발화만 추출 */
  callerText: string;
  /** 평균 STT 신뢰도 */
  avgConfidence: number;
}

// ── 텍스트 정규화 ──

/** STT 출력 정규화: 반복, 공백, 특수문자 정리 */
export function normalizeKoreanText(raw: string): string {
  let text = raw;

  // 연속 공백 → 단일 공백
  text = text.replace(/\s+/g, " ");

  // 말더듬/반복 패턴 정리: "불 불 불이야" → "불이야"
  text = text.replace(/(\S+)\s+\1(?:\s+\1)*/g, "$1");

  // 무의미한 간투사 제거
  text = text.replace(/(?:어|음|그|저|아니)\s*(?:어|음|그|저|아니)\s*/g, "");

  // 문장부호 정규화
  text = text.replace(/[!！]{2,}/g, "!");
  text = text.replace(/[?？]{2,}/g, "?");

  // 앞뒤 공백
  text = text.trim();

  return text;
}

/** 저신뢰도 세그먼트 필터링 */
export function filterLowConfidence(
  segments: TranscriptSegment[],
  threshold = 0.3,
): TranscriptSegment[] {
  return segments.filter((s) => (s.confidence ?? 1.0) >= threshold);
}

// ── 키워드 감지 ──

function findKeywords(text: string, keywords: readonly string[]): string[] {
  const found: string[] = [];
  for (const kw of keywords) {
    if (text.includes(kw)) {
      found.push(kw);
    }
  }
  return found;
}

// ── 패턴 추출 ──

function extractPatterns(text: string, patterns: readonly RegExp[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    // RegExp는 글로벌 플래그로 재사용 시 lastIndex 리셋 필요
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      results.push(match[0]);
    }
  }
  return [...new Set(results)];
}

// ── 메인 프로세서 ──

/** 119 신고 음성 STT 결과를 분석용으로 전처리 */
export function processTranscript(
  segments: TranscriptSegment[],
): ProcessedTranscript {
  const filtered = filterLowConfidence(segments);

  const normalizedSegments = filtered.map((s) => ({
    ...s,
    text: normalizeKoreanText(s.text),
  }));

  const fullText = normalizedSegments.map((s) => s.text).join(" ");
  const callerText = normalizedSegments
    .filter((s) => s.speaker === "caller")
    .map((s) => s.text)
    .join(" ");

  const detectedKeywords = {
    fire: findKeywords(fullText, FIRE_KEYWORDS),
    medical: findKeywords(fullText, MEDICAL_KEYWORDS),
    rescue: findKeywords(fullText, RESCUE_KEYWORDS),
    urgency: findKeywords(fullText, URGENCY_HIGH_MARKERS),
  };

  const extractedLocations = extractPatterns(fullText, LOCATION_PATTERNS);
  const extractedTimeRefs = extractPatterns(fullText, TIME_PATTERNS);

  const confidences = filtered
    .map((s) => s.confidence)
    .filter((c): c is number => c !== undefined);
  const avgConfidence =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 1.0;

  return {
    segments: normalizedSegments,
    normalizedFullText: fullText,
    detectedKeywords,
    extractedLocations,
    extractedTimeRefs,
    callerText,
    avgConfidence,
  };
}
