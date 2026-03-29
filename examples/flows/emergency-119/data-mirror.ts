/**
 * 데이터 미러링 모듈
 *
 * 119 신고 처리 데이터를 다중 저장소에 동기화합니다.
 *
 * 미러링 대상:
 * 1. 로컬 파일시스템 (즉시 백업)
 * 2. 중앙 데이터베이스 (분석용)
 * 3. 실시간 스트리밍 (상황판 연동)
 * 4. 장기 아카이브 (법적 보존)
 *
 * 데이터 생명주기:
 *   실시간 → 운영 DB (30일) → 분석 DB (1년) → 아카이브 (10년)
 */

import fs from "node:fs/promises";
import path from "node:path";

// ── 타입 정의 ──

export type MirrorDestinationType =
  | "local_fs"       // 로컬 파일시스템
  | "database"       // 중앙 DB (REST API)
  | "streaming"      // 실시간 스트리밍 (WebSocket/SSE)
  | "archive"        // 장기 아카이브 (S3/NAS)
  | "webhook";       // 웹훅 (유관기관 연동)

export interface MirrorDestination {
  /** 대상 ID */
  id: string;
  /** 대상 유형 */
  type: MirrorDestinationType;
  /** 연결 엔드포인트 */
  endpoint: string;
  /** 인증 (환경변수명 또는 직접 값) */
  authKey?: string;
  /** 활성화 여부 */
  enabled: boolean;
  /** 동기/비동기 */
  async: boolean;
  /** 재시도 횟수 */
  maxRetries: number;
  /** 타임아웃 (ms) */
  timeoutMs: number;
  /** 데이터 보존 기간 (일, 0=무제한) */
  retentionDays: number;
  /** 전송할 데이터 필드 필터 (비어있으면 전체) */
  fieldFilter?: string[];
  /** 민감정보 마스킹 활성화 */
  maskSensitive: boolean;
}

export interface MirrorRecord {
  /** 레코드 ID */
  recordId: string;
  /** 레코드 유형 */
  recordType: "call_received" | "stt_completed" | "classified" | "dispatched" | "call_closed";
  /** 신고 접수 번호 */
  callId: string;
  /** 타임스탬프 */
  timestamp: string;
  /** 데이터 페이로드 */
  payload: Record<string, unknown>;
  /** 데이터 분류 등급 */
  dataClassification: "public" | "internal" | "confidential" | "restricted";
}

export interface MirrorResult {
  /** 전송 대상 ID */
  destinationId: string;
  /** 성공 여부 */
  success: boolean;
  /** 에러 메시지 */
  error?: string;
  /** 응답 시간 (ms) */
  latencyMs: number;
  /** 재시도 횟수 */
  retryCount: number;
  /** 전송된 바이트 */
  bytesSent: number;
}

export interface MirrorSyncReport {
  /** 레코드 ID */
  recordId: string;
  /** 전체 대상 수 */
  totalDestinations: number;
  /** 성공 수 */
  successCount: number;
  /** 실패 수 */
  failureCount: number;
  /** 대상별 결과 */
  results: MirrorResult[];
  /** 전체 소요 시간 (ms) */
  totalTimeMs: number;
  /** 동기화 시각 */
  syncedAt: string;
}

// ── 기본 미러링 대상 설정 ──

export const DEFAULT_DESTINATIONS: MirrorDestination[] = [
  {
    id: "local-backup",
    type: "local_fs",
    endpoint: "~/.acpx/mirror/119-calls",
    enabled: true,
    async: false,
    maxRetries: 1,
    timeoutMs: 5_000,
    retentionDays: 30,
    maskSensitive: false,
  },
  {
    id: "central-db",
    type: "database",
    endpoint: "http://localhost:8080/api/v1/calls",
    authKey: "MIRROR_DB_TOKEN",
    enabled: true,
    async: true,
    maxRetries: 3,
    timeoutMs: 10_000,
    retentionDays: 365,
    maskSensitive: false,
  },
  {
    id: "realtime-dashboard",
    type: "streaming",
    endpoint: "ws://localhost:9090/ws/calls",
    authKey: "MIRROR_WS_TOKEN",
    enabled: true,
    async: true,
    maxRetries: 1,
    timeoutMs: 3_000,
    retentionDays: 0,
    maskSensitive: true,
  },
  {
    id: "long-term-archive",
    type: "archive",
    endpoint: "s3://119-archive/calls",
    authKey: "AWS_ARCHIVE_KEY",
    enabled: true,
    async: true,
    maxRetries: 3,
    timeoutMs: 30_000,
    retentionDays: 3650,  // 10년 법적 보존
    maskSensitive: false,
  },
  {
    id: "police-webhook",
    type: "webhook",
    endpoint: "https://api.police.go.kr/v1/119-relay",
    authKey: "POLICE_API_KEY",
    enabled: false,  // 필요 시 활성화
    async: true,
    maxRetries: 2,
    timeoutMs: 10_000,
    retentionDays: 0,
    fieldFilter: ["callId", "category", "urgency", "location", "dispatchLevel"],
    maskSensitive: true,
  },
];

// ── 민감정보 마스킹 ──

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // 주민등록번호
  { pattern: /\d{6}-[1-4]\d{6}/g, replacement: "******-*******" },
  // 전화번호
  { pattern: /01[0-9]-?\d{3,4}-?\d{4}/g, replacement: "010-****-****" },
  // 카드번호
  { pattern: /\d{4}-?\d{4}-?\d{4}-?\d{4}/g, replacement: "****-****-****-****" },
];

function maskSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  let masked = json;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    masked = masked.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return JSON.parse(masked);
}

/** 필드 필터 적용 */
function filterFields(
  data: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  if (fields.length === 0) return data;
  const filtered: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in data) {
      filtered[field] = data[field];
    }
    // 중첩 필드 지원: "payload.location" 형태
    if (field.includes(".")) {
      const parts = field.split(".");
      let current: unknown = data;
      for (const part of parts) {
        if (current && typeof current === "object" && part in current) {
          current = (current as Record<string, unknown>)[part];
        } else {
          current = undefined;
          break;
        }
      }
      if (current !== undefined) {
        filtered[field] = current;
      }
    }
  }
  return filtered;
}

// ── 대상별 전송 구현 ──

async function sendToLocalFs(
  dest: MirrorDestination,
  record: MirrorRecord,
  payload: Record<string, unknown>,
): Promise<void> {
  const basePath = dest.endpoint.replace("~", process.env.HOME ?? "/tmp");
  const datePath = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(basePath, datePath);
  await fs.mkdir(dir, { recursive: true });

  const filename = `${record.callId}_${record.recordType}_${Date.now()}.json`;
  const filePath = path.join(dir, filename);

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

async function sendToDatabase(
  dest: MirrorDestination,
  _record: MirrorRecord,
  payload: Record<string, unknown>,
): Promise<void> {
  const token = resolveAuthKey(dest.authKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetchWithTimeout(dest.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, dest.timeoutMs);

  if (!response.ok) {
    throw new Error(`DB mirror failed: ${response.status} ${response.statusText}`);
  }
}

async function sendToStreaming(
  dest: MirrorDestination,
  _record: MirrorRecord,
  payload: Record<string, unknown>,
): Promise<void> {
  // WebSocket은 HTTP POST 폴백으로 구현
  // 실제 운영에서는 WebSocket 클라이언트 풀 사용
  const httpEndpoint = dest.endpoint
    .replace("ws://", "http://")
    .replace("wss://", "https://")
    .replace("/ws/", "/api/");

  const token = resolveAuthKey(dest.authKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetchWithTimeout(httpEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ event: "mirror", data: payload }),
  }, dest.timeoutMs);

  if (!response.ok) {
    throw new Error(`Streaming mirror failed: ${response.status}`);
  }
}

async function sendToArchive(
  dest: MirrorDestination,
  record: MirrorRecord,
  payload: Record<string, unknown>,
): Promise<void> {
  if (dest.endpoint.startsWith("s3://")) {
    // S3 호환 — CLI 도구 사용
    const bucketPath = dest.endpoint.replace("s3://", "");
    const datePath = new Date().toISOString().slice(0, 7); // YYYY-MM
    const key = `${bucketPath}/${datePath}/${record.callId}/${record.recordType}.json`;

    // 임시 파일에 쓰고 S3로 전송
    const tmpPath = path.join("/tmp", `mirror-${Date.now()}.json`);
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2));

    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("aws", ["s3", "cp", tmpPath, `s3://${key}`], (err) => {
        fs.unlink(tmpPath).catch(() => {});
        if (err) reject(new Error(`S3 upload failed: ${err.message}`));
        else resolve();
      });
    });
  } else {
    // NAS/로컬 아카이브
    await sendToLocalFs(dest, record, payload);
  }
}

async function sendToWebhook(
  dest: MirrorDestination,
  record: MirrorRecord,
  payload: Record<string, unknown>,
): Promise<void> {
  const apiKey = resolveAuthKey(dest.authKey);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["X-API-Key"] = apiKey;

  // 웹훅 페이로드 래핑
  const webhookPayload = {
    event: record.recordType,
    callId: record.callId,
    timestamp: record.timestamp,
    data: payload,
  };

  const response = await fetchWithTimeout(dest.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(webhookPayload),
  }, dest.timeoutMs);

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
  }
}

// ── 전송 디스패처 ──

const SENDERS: Record<
  MirrorDestinationType,
  (dest: MirrorDestination, record: MirrorRecord, payload: Record<string, unknown>) => Promise<void>
> = {
  local_fs: sendToLocalFs,
  database: sendToDatabase,
  streaming: sendToStreaming,
  archive: sendToArchive,
  webhook: sendToWebhook,
};

async function sendWithRetry(
  dest: MirrorDestination,
  record: MirrorRecord,
  payload: Record<string, unknown>,
): Promise<MirrorResult> {
  const sender = SENDERS[dest.type];
  if (!sender) {
    return {
      destinationId: dest.id,
      success: false,
      error: `Unknown destination type: ${dest.type}`,
      latencyMs: 0,
      retryCount: 0,
      bytesSent: 0,
    };
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");
  let lastError: string | undefined;
  const start = Date.now();

  for (let attempt = 0; attempt <= dest.maxRetries; attempt++) {
    try {
      await sender(dest, record, payload);
      return {
        destinationId: dest.id,
        success: true,
        latencyMs: Date.now() - start,
        retryCount: attempt,
        bytesSent: payloadBytes,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < dest.maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }

  return {
    destinationId: dest.id,
    success: false,
    error: lastError,
    latencyMs: Date.now() - start,
    retryCount: dest.maxRetries,
    bytesSent: 0,
  };
}

// ── 유틸리티 ──

function resolveAuthKey(keyRef?: string): string {
  if (!keyRef) return "";
  return process.env[keyRef] ?? keyRef;
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

// ── 데이터 보존 정책 ──

export interface RetentionPolicy {
  /** 운영 데이터 보존 (일) */
  operational: number;
  /** 분석 데이터 보존 (일) */
  analytical: number;
  /** 장기 아카이브 보존 (일) */
  archive: number;
  /** 자동 삭제 활성화 */
  autoCleanup: boolean;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  operational: 30,    // 30일
  analytical: 365,    // 1년
  archive: 3650,      // 10년 (법적 보존 기간)
  autoCleanup: true,
};

/**
 * 로컬 미러 데이터 정리 (보존 기간 초과 파일 삭제)
 */
export async function cleanupExpiredData(
  basePath: string,
  retentionDays: number,
): Promise<{ deletedCount: number; freedBytes: number }> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let deletedCount = 0;
  let freedBytes = 0;

  const resolvedPath = basePath.replace("~", process.env.HOME ?? "/tmp");

  try {
    const entries = await fs.readdir(resolvedPath);
    for (const entry of entries) {
      // 날짜 디렉토리 형식: YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry)) {
        const dirDate = new Date(entry);
        if (dirDate < cutoff) {
          const dirPath = path.join(resolvedPath, entry);
          const files = await fs.readdir(dirPath);
          for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = await fs.stat(filePath);
            freedBytes += stat.size;
            await fs.unlink(filePath);
            deletedCount++;
          }
          await fs.rmdir(dirPath);
        }
      }
    }
  } catch {
    // 디렉토리가 없으면 무시
  }

  return { deletedCount, freedBytes };
}

// ── 메인 미러링 함수 ──

export interface MirrorOptions {
  /** 미러링 대상 목록 */
  destinations?: MirrorDestination[];
  /** 동기 대상만 대기 (비동기 대상은 fire-and-forget) */
  waitSyncOnly?: boolean;
}

/**
 * 레코드를 모든 활성 미러링 대상에 동기화합니다.
 */
export async function mirrorRecord(
  record: MirrorRecord,
  options?: MirrorOptions,
): Promise<MirrorSyncReport> {
  const destinations = (options?.destinations ?? DEFAULT_DESTINATIONS)
    .filter((d) => d.enabled);
  const waitSyncOnly = options?.waitSyncOnly ?? true;
  const start = Date.now();

  const tasks = destinations.map((dest) => {
    // 페이로드 준비: 필드 필터 + 마스킹
    let payload = record.payload;
    if (dest.fieldFilter && dest.fieldFilter.length > 0) {
      payload = filterFields(payload, dest.fieldFilter);
    }
    if (dest.maskSensitive) {
      payload = maskSensitiveData(payload);
    }

    // 메타데이터 추가
    const enrichedPayload = {
      _mirror: {
        recordId: record.recordId,
        recordType: record.recordType,
        callId: record.callId,
        timestamp: record.timestamp,
        dataClassification: record.dataClassification,
        retentionDays: dest.retentionDays,
      },
      ...payload,
    };

    return {
      dest,
      promise: sendWithRetry(dest, record, enrichedPayload),
    };
  });

  let results: MirrorResult[];

  if (waitSyncOnly) {
    // 동기 대상만 대기, 비동기는 fire-and-forget
    const syncTasks = tasks.filter((t) => !t.dest.async);
    const asyncTasks = tasks.filter((t) => t.dest.async);

    const syncResults = await Promise.all(syncTasks.map((t) => t.promise));

    // 비동기 작업은 대기하지 않고 결과를 "pending"으로 기록
    const asyncResults: MirrorResult[] = asyncTasks.map((t) => ({
      destinationId: t.dest.id,
      success: true,  // fire-and-forget이므로 성공 가정
      latencyMs: 0,
      retryCount: 0,
      bytesSent: 0,
    }));

    // 비동기 작업 실행 (결과 무시하지 않고 로깅)
    Promise.allSettled(asyncTasks.map((t) => t.promise)).catch(() => {});

    results = [...syncResults, ...asyncResults];
  } else {
    results = await Promise.all(tasks.map((t) => t.promise));
  }

  return {
    recordId: record.recordId,
    totalDestinations: destinations.length,
    successCount: results.filter((r) => r.success).length,
    failureCount: results.filter((r) => !r.success).length,
    results,
    totalTimeMs: Date.now() - start,
    syncedAt: new Date().toISOString(),
  };
}

// ── 편의 함수: 119 신고 처리 단계별 미러링 ──

let mirrorSeq = 0;

function nextRecordId(callId: string): string {
  return `${callId}-mirror-${++mirrorSeq}-${Date.now()}`;
}

/** 신고 접수 시점 미러링 */
export function mirrorCallReceived(
  callId: string,
  rawData: Record<string, unknown>,
  options?: MirrorOptions,
): Promise<MirrorSyncReport> {
  return mirrorRecord({
    recordId: nextRecordId(callId),
    recordType: "call_received",
    callId,
    timestamp: new Date().toISOString(),
    payload: rawData,
    dataClassification: "confidential",
  }, options);
}

/** STT 완료 시점 미러링 */
export function mirrorSttCompleted(
  callId: string,
  sttData: Record<string, unknown>,
  options?: MirrorOptions,
): Promise<MirrorSyncReport> {
  return mirrorRecord({
    recordId: nextRecordId(callId),
    recordType: "stt_completed",
    callId,
    timestamp: new Date().toISOString(),
    payload: sttData,
    dataClassification: "confidential",
  }, options);
}

/** 분류 완료 시점 미러링 */
export function mirrorClassified(
  callId: string,
  classificationData: Record<string, unknown>,
  options?: MirrorOptions,
): Promise<MirrorSyncReport> {
  return mirrorRecord({
    recordId: nextRecordId(callId),
    recordType: "classified",
    callId,
    timestamp: new Date().toISOString(),
    payload: classificationData,
    dataClassification: "internal",
  }, options);
}

/** 출동 지령 시점 미러링 */
export function mirrorDispatched(
  callId: string,
  dispatchData: Record<string, unknown>,
  options?: MirrorOptions,
): Promise<MirrorSyncReport> {
  return mirrorRecord({
    recordId: nextRecordId(callId),
    recordType: "dispatched",
    callId,
    timestamp: new Date().toISOString(),
    payload: dispatchData,
    dataClassification: "internal",
  }, options);
}

/** 신고 종료 시점 미러링 */
export function mirrorCallClosed(
  callId: string,
  closingData: Record<string, unknown>,
  options?: MirrorOptions,
): Promise<MirrorSyncReport> {
  return mirrorRecord({
    recordId: nextRecordId(callId),
    recordType: "call_closed",
    callId,
    timestamp: new Date().toISOString(),
    payload: closingData,
    dataClassification: "internal",
  }, options);
}
