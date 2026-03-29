/**
 * STT 자동화 엔진
 *
 * 119 신고 음성 파일을 자동으로 STT 변환합니다.
 * 다중 STT 프로바이더 지원 (Whisper, Clova Speech, Google STT)
 * 프로바이더 장애 시 자동 폴백 처리
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// ── 타입 정의 ──

export type SttProvider = "whisper" | "clova" | "google" | "custom";

export interface SttProviderConfig {
  /** 프로바이더 이름 */
  provider: SttProvider;
  /** 실행 명령어 또는 API 엔드포인트 */
  endpoint: string;
  /** 인증 키 (환경변수명 또는 직접 값) */
  authKey?: string;
  /** 언어 코드 */
  language: string;
  /** 모델명 */
  model?: string;
  /** 최대 재시도 횟수 */
  maxRetries: number;
  /** 타임아웃 (ms) */
  timeoutMs: number;
  /** 우선순위 (낮을수록 먼저) */
  priority: number;
}

export interface RawAudioInput {
  /** 오디오 파일 경로 */
  filePath: string;
  /** 오디오 포맷 (wav, mp3, ogg, flac) */
  format: "wav" | "mp3" | "ogg" | "flac" | "pcm";
  /** 샘플레이트 (Hz) */
  sampleRate: number;
  /** 채널 수 (1: 모노, 2: 스테레오) */
  channels: 1 | 2;
  /** 녹음 시작 시각 */
  recordedAt?: string;
  /** 신고 접수 번호 */
  callId?: string;
  /** 스테레오 채널 매핑 (2채널일 때) */
  channelMap?: {
    left: "caller" | "operator";
    right: "caller" | "operator";
  };
}

export interface SttRawSegment {
  /** 발화 텍스트 */
  text: string;
  /** 시작 시간 (초) */
  startSec: number;
  /** 종료 시간 (초) */
  endSec: number;
  /** 신뢰도 (0~1) */
  confidence: number;
  /** 채널 (스테레오일 때) */
  channel?: number;
  /** 화자 ID (diarization 전 임시) */
  speakerId?: string;
}

export interface SttResult {
  /** STT 프로바이더 */
  provider: SttProvider;
  /** 원본 오디오 정보 */
  audioInfo: RawAudioInput;
  /** 세그먼트 목록 */
  segments: SttRawSegment[];
  /** 전체 오디오 길이 (초) */
  durationSec: number;
  /** 처리 소요 시간 (ms) */
  processingTimeMs: number;
  /** 프로바이더별 메타데이터 */
  providerMeta?: Record<string, unknown>;
  /** 폴백 발생 여부 */
  usedFallback: boolean;
  /** 폴백 이력 */
  fallbackHistory: FallbackEvent[];
}

export interface FallbackEvent {
  provider: SttProvider;
  error: string;
  timestamp: string;
}

// ── 기본 프로바이더 설정 ──

export const DEFAULT_PROVIDERS: SttProviderConfig[] = [
  {
    provider: "whisper",
    endpoint: "whisper",
    language: "ko",
    model: "large-v3",
    maxRetries: 2,
    timeoutMs: 120_000,
    priority: 1,
  },
  {
    provider: "clova",
    endpoint: "https://clovaspeech-gw.ncloud.com/recog/v1/stt",
    authKey: "CLOVA_STT_SECRET",
    language: "ko",
    model: "general",
    maxRetries: 2,
    timeoutMs: 60_000,
    priority: 2,
  },
  {
    provider: "google",
    endpoint: "https://speech.googleapis.com/v1/speech:recognize",
    authKey: "GOOGLE_STT_KEY",
    language: "ko-KR",
    model: "latest_long",
    maxRetries: 2,
    timeoutMs: 60_000,
    priority: 3,
  },
];

// ── Whisper 로컬 STT ──

async function runWhisper(
  audio: RawAudioInput,
  config: SttProviderConfig,
): Promise<SttRawSegment[]> {
  const args = [
    audio.filePath,
    "--model", config.model ?? "large-v3",
    "--language", config.language,
    "--output_format", "json",
    "--output_dir", path.dirname(audio.filePath),
    "--word_timestamps", "True",
  ];

  const output = await execCommand(config.endpoint, args, config.timeoutMs);
  const jsonPath = audio.filePath.replace(/\.[^.]+$/, ".json");

  try {
    const raw = await fs.readFile(jsonPath, "utf-8");
    const whisperResult = JSON.parse(raw) as WhisperOutput;
    return whisperResult.segments.map((seg) => ({
      text: seg.text.trim(),
      startSec: seg.start,
      endSec: seg.end,
      confidence: seg.avg_logprob ? Math.exp(seg.avg_logprob) : 0.8,
    }));
  } finally {
    // Whisper 임시 JSON 정리
    await fs.unlink(jsonPath).catch(() => {});
  }
}

interface WhisperOutput {
  segments: Array<{
    text: string;
    start: number;
    end: number;
    avg_logprob?: number;
  }>;
}

// ── Clova Speech API ──

async function runClova(
  audio: RawAudioInput,
  config: SttProviderConfig,
): Promise<SttRawSegment[]> {
  const secret = resolveAuthKey(config.authKey);
  const audioData = await fs.readFile(audio.filePath);

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-CLOVASPEECH-API-KEY": secret,
    },
    body: audioData,
  }, config.timeoutMs);

  const result = (await response.json()) as ClovaResponse;

  return (result.segments ?? []).map((seg) => ({
    text: seg.text,
    startSec: seg.start / 1000,
    endSec: seg.end / 1000,
    confidence: seg.confidence,
    speakerId: seg.speaker?.label,
  }));
}

interface ClovaResponse {
  segments: Array<{
    text: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: { label: string };
  }>;
}

// ── Google Speech-to-Text API ──

async function runGoogle(
  audio: RawAudioInput,
  config: SttProviderConfig,
): Promise<SttRawSegment[]> {
  const apiKey = resolveAuthKey(config.authKey);
  const audioData = await fs.readFile(audio.filePath);
  const audioContent = audioData.toString("base64");

  const encodingMap: Record<string, string> = {
    wav: "LINEAR16",
    mp3: "MP3",
    ogg: "OGG_OPUS",
    flac: "FLAC",
    pcm: "LINEAR16",
  };

  const body = {
    config: {
      encoding: encodingMap[audio.format] ?? "LINEAR16",
      sampleRateHertz: audio.sampleRate,
      languageCode: config.language,
      model: config.model ?? "latest_long",
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      diarizationConfig: {
        enableSpeakerDiarization: true,
        minSpeakerCount: 2,
        maxSpeakerCount: 2,
      },
    },
    audio: { content: audioContent },
  };

  const url = `${config.endpoint}?key=${apiKey}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, config.timeoutMs);

  const result = (await response.json()) as GoogleSttResponse;
  const segments: SttRawSegment[] = [];

  for (const res of result.results ?? []) {
    const alt = res.alternatives?.[0];
    if (!alt) continue;

    // 단어 단위 → 문장 단위 세그먼트로 집계
    const words = alt.words ?? [];
    if (words.length === 0) {
      segments.push({
        text: alt.transcript,
        startSec: 0,
        endSec: 0,
        confidence: alt.confidence ?? 0.8,
      });
      continue;
    }

    let currentSpeaker = words[0].speakerTag;
    let sentenceWords: GoogleWord[] = [words[0]];

    for (let i = 1; i < words.length; i++) {
      if (words[i].speakerTag !== currentSpeaker) {
        segments.push(buildGoogleSegment(sentenceWords, currentSpeaker, alt.confidence));
        currentSpeaker = words[i].speakerTag;
        sentenceWords = [words[i]];
      } else {
        sentenceWords.push(words[i]);
      }
    }
    if (sentenceWords.length > 0) {
      segments.push(buildGoogleSegment(sentenceWords, currentSpeaker, alt.confidence));
    }
  }

  return segments;
}

function buildGoogleSegment(
  words: GoogleWord[],
  speakerTag: number,
  confidence?: number,
): SttRawSegment {
  return {
    text: words.map((w) => w.word).join(" "),
    startSec: parseGoogleDuration(words[0].startTime),
    endSec: parseGoogleDuration(words[words.length - 1].endTime),
    confidence: confidence ?? 0.8,
    speakerId: `speaker_${speakerTag}`,
  };
}

function parseGoogleDuration(d?: string): number {
  if (!d) return 0;
  return parseFloat(d.replace("s", ""));
}

interface GoogleWord {
  word: string;
  startTime: string;
  endTime: string;
  speakerTag: number;
}

interface GoogleSttResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript: string;
      confidence?: number;
      words?: GoogleWord[];
    }>;
  }>;
}

// ── 유틸리티 ──

function resolveAuthKey(keyRef?: string): string {
  if (!keyRef) return "";
  // 환경변수 참조
  const envVal = process.env[keyRef];
  if (envVal) return envVal;
  // 직접 값
  return keyRef;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function execCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`STT command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`STT command failed (code ${code}): ${stderr}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── 프로바이더 디스패치 ──

const PROVIDER_RUNNERS: Record<
  SttProvider,
  (audio: RawAudioInput, config: SttProviderConfig) => Promise<SttRawSegment[]>
> = {
  whisper: runWhisper,
  clova: runClova,
  google: runGoogle,
  custom: async () => { throw new Error("Custom provider requires external implementation"); },
};

async function runProviderWithRetry(
  audio: RawAudioInput,
  config: SttProviderConfig,
): Promise<SttRawSegment[]> {
  const runner = PROVIDER_RUNNERS[config.provider];
  if (!runner) throw new Error(`Unknown STT provider: ${config.provider}`);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await runner(audio, config);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < config.maxRetries) {
        // 지수 백오프: 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

// ── 메인 STT 엔진 ──

export interface SttEngineOptions {
  /** 프로바이더 설정 (우선순위 순) */
  providers?: SttProviderConfig[];
  /** 폴백 활성화 (기본: true) */
  enableFallback?: boolean;
}

/**
 * 오디오 파일을 STT 변환합니다.
 * 프로바이더 장애 시 자동으로 다음 프로바이더로 폴백합니다.
 */
export async function transcribeAudio(
  audio: RawAudioInput,
  options?: SttEngineOptions,
): Promise<SttResult> {
  const providers = (options?.providers ?? DEFAULT_PROVIDERS)
    .slice()
    .sort((a, b) => a.priority - b.priority);
  const enableFallback = options?.enableFallback ?? true;

  const fallbackHistory: FallbackEvent[] = [];
  let usedFallback = false;
  const startTime = Date.now();

  for (let i = 0; i < providers.length; i++) {
    const config = providers[i];
    try {
      const segments = await runProviderWithRetry(audio, config);
      const processingTimeMs = Date.now() - startTime;

      return {
        provider: config.provider,
        audioInfo: audio,
        segments,
        durationSec: estimateDuration(segments),
        processingTimeMs,
        usedFallback,
        fallbackHistory,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      fallbackHistory.push({
        provider: config.provider,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });

      if (!enableFallback || i === providers.length - 1) {
        throw new Error(
          `All STT providers failed. Last error (${config.provider}): ${errorMsg}`,
        );
      }
      usedFallback = true;
    }
  }

  throw new Error("No STT providers configured");
}

function estimateDuration(segments: SttRawSegment[]): number {
  if (segments.length === 0) return 0;
  return Math.max(...segments.map((s) => s.endSec));
}

// ── 배치 처리 ──

export interface BatchSttResult {
  results: Array<{
    callId: string;
    result?: SttResult;
    error?: string;
  }>;
  totalProcessed: number;
  totalFailed: number;
  totalTimeMs: number;
}

/**
 * 여러 오디오 파일을 배치로 STT 변환합니다.
 * 동시 처리 수를 제한하여 리소스를 관리합니다.
 */
export async function batchTranscribe(
  audioFiles: RawAudioInput[],
  options?: SttEngineOptions & { concurrency?: number },
): Promise<BatchSttResult> {
  const concurrency = options?.concurrency ?? 3;
  const startTime = Date.now();
  const results: BatchSttResult["results"] = [];

  // 동시성 제한 실행
  const queue = [...audioFiles];
  const running = new Set<Promise<void>>();

  for (const audio of queue) {
    const task = (async () => {
      try {
        const result = await transcribeAudio(audio, options);
        results.push({ callId: audio.callId ?? audio.filePath, result });
      } catch (err) {
        results.push({
          callId: audio.callId ?? audio.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    running.add(task);
    task.finally(() => running.delete(task));

    if (running.size >= concurrency) {
      await Promise.race(running);
    }
  }

  await Promise.all(running);

  return {
    results,
    totalProcessed: results.filter((r) => r.result).length,
    totalFailed: results.filter((r) => r.error).length,
    totalTimeMs: Date.now() - startTime,
  };
}
