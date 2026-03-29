/**
 * 화자 분리 (Speaker Diarization) 모듈
 *
 * 119 신고 통화에서 신고자(caller)와 상황실 요원(operator)을 자동 분리합니다.
 *
 * 분리 전략:
 * 1. 스테레오 채널 분리 (2채널 녹음: 좌=상황실, 우=신고자)
 * 2. STT 프로바이더 화자 태그 활용 (Google/Clova diarization)
 * 3. 턴테이킹 패턴 분석 (교대 발화 패턴)
 * 4. 상황실 정형 표현 매칭 (규칙 기반 보정)
 */

import type { TranscriptSegment } from "./korean-text-processor.js";
import type { RawAudioInput, SttRawSegment, SttResult } from "./stt-engine.js";

// ── 타입 정의 ──

export interface DiarizationResult {
  /** 최종 화자 분리된 세그먼트 */
  segments: TranscriptSegment[];
  /** 분리 방법 */
  method: DiarizationMethod;
  /** 화자별 통계 */
  speakerStats: {
    caller: SpeakerStats;
    operator: SpeakerStats;
  };
  /** 분리 신뢰도 (0~1) */
  confidence: number;
  /** 분리 이슈/경고 */
  warnings: string[];
}

export type DiarizationMethod =
  | "stereo_channel"      // 스테레오 채널 분리
  | "provider_diarization" // STT 프로바이더 화자 태그
  | "turn_taking"         // 턴테이킹 패턴 분석
  | "rule_based"          // 규칙 기반 (정형 표현 매칭)
  | "hybrid";             // 복합 (여러 방법 결합)

export interface SpeakerStats {
  /** 발화 횟수 */
  turnCount: number;
  /** 총 발화 시간 (초) */
  totalDurationSec: number;
  /** 평균 발화 길이 (글자) */
  avgUtteranceLength: number;
  /** 첫 발화 시각 (초) */
  firstTurnSec: number;
}

export interface DiarizationConfig {
  /** 스테레오 채널 분리 우선 사용 */
  preferStereoChannel: boolean;
  /** 상황실 정형 표현 매칭 가중치 */
  operatorPatternWeight: number;
  /** 최소 세그먼트 간격 (초) — 이보다 가까우면 같은 턴으로 병합 */
  mergeGapSec: number;
  /** 침묵 구간 임계값 (초) — 턴 전환 판단 */
  silenceThresholdSec: number;
}

// ── 상수 ──

const DEFAULT_CONFIG: DiarizationConfig = {
  preferStereoChannel: true,
  operatorPatternWeight: 0.8,
  mergeGapSec: 0.5,
  silenceThresholdSec: 1.5,
};

/** 상황실 요원 정형 표현 패턴 */
const OPERATOR_PATTERNS: RegExp[] = [
  /^119입니다/,
  /^네\s*119/,
  /무엇을\s*도와/,
  /주소[가를]?\s*(어떻게|말씀|알려)/,
  /위치[가를]?\s*(어디|말씀|알려)/,
  /다친\s*(분|사람)[이가]?\s*계/,
  /환자\s*상태/,
  /몇\s*(분|명)[이가]?\s*(타고|계|있)/,
  /다시\s*한\s*번\s*말씀/,
  /심폐소생술.*안내/,
  /안전한\s*곳.*대피/,
  /출동\s*(하겠|시키)/,
  /현재\s*위치/,
  /어디서\s*(불|사고|발생)/,
  /확인\s*(하겠|해\s*드리)/,
];

/** 신고자 특징 표현 패턴 */
const CALLER_PATTERNS: RegExp[] = [
  /빨리\s*(와|좀|요)/,
  /살려/,
  /제발/,
  /도와/,
  /불이야/,
  /사람[이가]?\s*(쓰러|죽|다쳤)/,
  /[이여기여]기[요는서]?\s/,  // "여기요", "여기서"
  /(갇혀|갇혔|끼어|끼였)/,
  /\d+(동|층|호)/,      // 주소 말하는 패턴
  /(아파트|빌라|빌딩|공장|시장)/,
  /네\s*네\s*알겠/,
];

// ── 1. 스테레오 채널 분리 ──

function diarizeByChannel(
  sttResult: SttResult,
): TranscriptSegment[] | null {
  const audio = sttResult.audioInfo;

  // 스테레오가 아니거나 채널맵이 없으면 불가
  if (audio.channels !== 2 || !audio.channelMap) return null;

  const channelToSpeaker: Record<number, "caller" | "operator"> = {
    0: audio.channelMap.left,
    1: audio.channelMap.right,
  };

  return sttResult.segments
    .filter((seg) => seg.channel !== undefined)
    .map((seg) => ({
      speaker: channelToSpeaker[seg.channel!] ?? "caller",
      text: seg.text,
      timestampSec: seg.startSec,
      confidence: seg.confidence,
    }));
}

// ── 2. STT 프로바이더 화자 태그 활용 ──

function diarizeByProviderTags(
  sttResult: SttResult,
): TranscriptSegment[] | null {
  // speakerId가 있는 세그먼트가 충분한지 확인
  const tagged = sttResult.segments.filter((s) => s.speakerId);
  if (tagged.length < sttResult.segments.length * 0.5) return null;

  // 고유 화자 ID 추출
  const speakerIds = [...new Set(tagged.map((s) => s.speakerId!))];
  if (speakerIds.length < 1 || speakerIds.length > 4) return null;

  // 2명이면 직접 매핑, 아니면 규칙 기반 보정 필요
  const speakerMap = assignSpeakerRoles(tagged, speakerIds);

  return tagged.map((seg) => ({
    speaker: speakerMap.get(seg.speakerId!) ?? "caller",
    text: seg.text,
    timestampSec: seg.startSec,
    confidence: seg.confidence,
  }));
}

/** 화자 ID → caller/operator 역할 매핑 */
function assignSpeakerRoles(
  segments: SttRawSegment[],
  speakerIds: string[],
): Map<string, "caller" | "operator"> {
  const map = new Map<string, "caller" | "operator">();

  // 각 화자별 상황실 패턴 매칭 점수 계산
  const scores = new Map<string, number>();
  for (const id of speakerIds) {
    const speakerTexts = segments
      .filter((s) => s.speakerId === id)
      .map((s) => s.text)
      .join(" ");

    let operatorScore = 0;
    for (const pattern of OPERATOR_PATTERNS) {
      if (pattern.test(speakerTexts)) operatorScore++;
    }
    let callerScore = 0;
    for (const pattern of CALLER_PATTERNS) {
      if (pattern.test(speakerTexts)) callerScore++;
    }

    scores.set(id, operatorScore - callerScore);
  }

  // 가장 높은 상황실 점수를 가진 화자 → operator
  const sorted = [...scores.entries()].sort(([, a], [, b]) => b - a);

  if (sorted.length >= 2) {
    map.set(sorted[0][0], "operator");
    for (let i = 1; i < sorted.length; i++) {
      map.set(sorted[i][0], "caller");
    }
  } else if (sorted.length === 1) {
    // 화자 1명만 감지 → 첫 발화 패턴으로 판단
    const firstSeg = segments[0];
    const isOperator = OPERATOR_PATTERNS.some((p) => p.test(firstSeg?.text ?? ""));
    map.set(sorted[0][0], isOperator ? "operator" : "caller");
  }

  return map;
}

// ── 3. 턴테이킹 패턴 분석 ──

function diarizeByTurnTaking(
  segments: SttRawSegment[],
  config: DiarizationConfig,
): TranscriptSegment[] {
  if (segments.length === 0) return [];

  const result: TranscriptSegment[] = [];

  // 119 통화 패턴: 첫 발화는 대부분 상황실 ("119입니다")
  const firstIsOperator = OPERATOR_PATTERNS.some((p) => p.test(segments[0].text));
  let currentSpeaker: "caller" | "operator" = firstIsOperator ? "operator" : "caller";

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prevSeg = i > 0 ? segments[i - 1] : null;

    // 침묵 간격이 임계값 이상이면 화자 전환 가능성
    if (prevSeg) {
      const gap = seg.startSec - prevSeg.endSec;
      if (gap >= config.silenceThresholdSec) {
        currentSpeaker = currentSpeaker === "caller" ? "operator" : "caller";
      }
    }

    // 정형 표현으로 강제 보정
    const operatorMatch = OPERATOR_PATTERNS.some((p) => p.test(seg.text));
    const callerMatch = CALLER_PATTERNS.some((p) => p.test(seg.text));

    if (operatorMatch && !callerMatch) {
      currentSpeaker = "operator";
    } else if (callerMatch && !operatorMatch) {
      currentSpeaker = "caller";
    }

    result.push({
      speaker: currentSpeaker,
      text: seg.text,
      timestampSec: seg.startSec,
      confidence: seg.confidence,
    });
  }

  return result;
}

// ── 4. 인접 세그먼트 병합 ──

function mergeAdjacentSegments(
  segments: TranscriptSegment[],
  gapSec: number,
): TranscriptSegment[] {
  if (segments.length <= 1) return segments;

  const merged: TranscriptSegment[] = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = segments[i];

    // 같은 화자 + 간격이 짧으면 병합
    const gap =
      curr.timestampSec !== undefined && prev.timestampSec !== undefined
        ? curr.timestampSec - prev.timestampSec
        : Infinity;

    if (curr.speaker === prev.speaker && gap < gapSec) {
      prev.text = `${prev.text} ${curr.text}`;
      // 신뢰도는 평균
      if (prev.confidence !== undefined && curr.confidence !== undefined) {
        prev.confidence = (prev.confidence + curr.confidence) / 2;
      }
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

// ── 신뢰도 계산 ──

function calculateDiarizationConfidence(
  segments: TranscriptSegment[],
  method: DiarizationMethod,
): number {
  // 기본 방법별 신뢰도
  const methodBase: Record<DiarizationMethod, number> = {
    stereo_channel: 0.95,
    provider_diarization: 0.80,
    turn_taking: 0.60,
    rule_based: 0.50,
    hybrid: 0.75,
  };

  let confidence = methodBase[method];

  // 화자 전환이 너무 빈번하면 신뢰도 감소
  let switchCount = 0;
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].speaker !== segments[i - 1].speaker) switchCount++;
  }
  const switchRate = segments.length > 1 ? switchCount / (segments.length - 1) : 0;
  if (switchRate > 0.8) confidence *= 0.7;  // 너무 잦은 전환
  if (switchRate < 0.1) confidence *= 0.8;  // 거의 전환 없음 (비정상)

  // 한쪽 화자가 90% 이상이면 신뢰도 감소
  const callerCount = segments.filter((s) => s.speaker === "caller").length;
  const ratio = callerCount / Math.max(segments.length, 1);
  if (ratio > 0.9 || ratio < 0.1) confidence *= 0.7;

  return Math.min(Math.max(confidence, 0), 1);
}

// ── 화자 통계 ──

function computeSpeakerStats(
  segments: TranscriptSegment[],
  speaker: "caller" | "operator",
): SpeakerStats {
  const speakerSegs = segments.filter((s) => s.speaker === speaker);

  if (speakerSegs.length === 0) {
    return { turnCount: 0, totalDurationSec: 0, avgUtteranceLength: 0, firstTurnSec: 0 };
  }

  const totalChars = speakerSegs.reduce((sum, s) => sum + s.text.length, 0);

  // 대략적인 발화 시간 추정 (한국어 평균 분당 300자 기준)
  const estimatedDuration = totalChars / 5; // 초당 ~5자

  return {
    turnCount: speakerSegs.length,
    totalDurationSec: estimatedDuration,
    avgUtteranceLength: totalChars / speakerSegs.length,
    firstTurnSec: speakerSegs[0].timestampSec ?? 0,
  };
}

// ── 메인 화자분리 함수 ──

/**
 * STT 결과에서 화자를 분리합니다.
 *
 * 우선순위:
 * 1. 스테레오 채널 (가장 정확)
 * 2. STT 프로바이더 diarization
 * 3. 턴테이킹 패턴 + 규칙 기반
 */
export function diarizeSpeakers(
  sttResult: SttResult,
  config?: Partial<DiarizationConfig>,
): DiarizationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const warnings: string[] = [];
  let segments: TranscriptSegment[];
  let method: DiarizationMethod;

  // 전략 1: 스테레오 채널 분리
  if (cfg.preferStereoChannel) {
    const channelResult = diarizeByChannel(sttResult);
    if (channelResult && channelResult.length > 0) {
      segments = mergeAdjacentSegments(channelResult, cfg.mergeGapSec);
      method = "stereo_channel";

      return buildResult(segments, method, warnings);
    }
  }

  // 전략 2: STT 프로바이더 화자 태그
  const providerResult = diarizeByProviderTags(sttResult);
  if (providerResult && providerResult.length > 0) {
    segments = mergeAdjacentSegments(providerResult, cfg.mergeGapSec);
    method = "provider_diarization";

    // 규칙 기반 보정 적용
    segments = applyRuleBasedCorrection(segments);
    if (segments !== providerResult) method = "hybrid";

    return buildResult(segments, method, warnings);
  }

  // 전략 3: 턴테이킹 + 규칙 기반
  if (sttResult.segments.length === 0) {
    warnings.push("세그먼트가 비어있어 화자 분리 불가");
    return buildResult([], "rule_based", warnings);
  }

  warnings.push("스테레오/프로바이더 분리 불가 — 턴테이킹 패턴 기반 분리");
  segments = diarizeByTurnTaking(sttResult.segments, cfg);
  segments = mergeAdjacentSegments(segments, cfg.mergeGapSec);
  segments = applyRuleBasedCorrection(segments);
  method = "turn_taking";

  return buildResult(segments, method, warnings);
}

/** 규칙 기반 보정: 정형 표현이 명확한 경우 화자 강제 교정 */
function applyRuleBasedCorrection(
  segments: TranscriptSegment[],
): TranscriptSegment[] {
  return segments.map((seg) => {
    const operatorMatch = OPERATOR_PATTERNS.some((p) => p.test(seg.text));
    const callerMatch = CALLER_PATTERNS.some((p) => p.test(seg.text));

    // 양쪽 모두 매칭되면 변경하지 않음
    if (operatorMatch && !callerMatch && seg.speaker !== "operator") {
      return { ...seg, speaker: "operator" as const };
    }
    if (callerMatch && !operatorMatch && seg.speaker !== "caller") {
      return { ...seg, speaker: "caller" as const };
    }
    return seg;
  });
}

function buildResult(
  segments: TranscriptSegment[],
  method: DiarizationMethod,
  warnings: string[],
): DiarizationResult {
  return {
    segments,
    method,
    speakerStats: {
      caller: computeSpeakerStats(segments, "caller"),
      operator: computeSpeakerStats(segments, "operator"),
    },
    confidence: calculateDiarizationConfidence(segments, method),
    warnings,
  };
}

// ── 수동 세그먼트를 위한 간편 분리 함수 ──

/**
 * 화자 태그가 없는 텍스트 세그먼트에 화자를 자동 할당합니다.
 * (STT 엔진 없이 텍스트만으로 화자 분리할 때 사용)
 */
export function diarizeTextOnly(
  texts: Array<{ text: string; timestampSec?: number; confidence?: number }>,
): TranscriptSegment[] {
  // SttResult 포맷으로 변환하여 턴테이킹 분석 적용
  const fakeSttResult: SttResult = {
    provider: "custom",
    audioInfo: {
      filePath: "",
      format: "wav",
      sampleRate: 16000,
      channels: 1,
    },
    segments: texts.map((t, i) => ({
      text: t.text,
      startSec: t.timestampSec ?? i * 5,
      endSec: (t.timestampSec ?? i * 5) + 3,
      confidence: t.confidence ?? 0.8,
    })),
    durationSec: 0,
    processingTimeMs: 0,
    usedFallback: false,
    fallbackHistory: [],
  };

  const result = diarizeSpeakers(fakeSttResult);
  return result.segments;
}
