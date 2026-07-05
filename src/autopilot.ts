import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createMemoryOS } from "./runtime/create-memory-os.js";
import type {
  MaintenancePhase,
  MaintenanceReport,
  MemoryOS,
  MemoryRole,
  MemoryStore,
  ReadAuditSnapshot,
  RepairSearchIndexResult,
} from "./kernel/types.js";

export type TranscriptIngestFormat = "jsonl" | "claude-code" | "openai-thread" | "auto";

export interface TranscriptIngestInput {
  memory: MemoryOS;
  profileId?: string | undefined;
  inputFile?: string | undefined;
  text?: string | undefined;
  format: TranscriptIngestFormat;
  dryRun?: boolean | undefined;
  now?: string | undefined;
  fileName?: string | undefined;
}

export interface TranscriptIngestSkippedRecord {
  index: number;
  reason: string;
}

export interface TranscriptIngestReport {
  schema: "gmos.transcript_ingest_report.v1";
  profileId: string;
  dryRun: boolean;
  format: TranscriptIngestFormat;
  sourceFileHash: string;
  fileName?: string | undefined;
  parsed: number;
  observed: number;
  deduplicated: number;
  skipped: number;
  extractionWindowCount: number;
  extractionCallCount: number;
  extractionEmptyCount: number;
  extractionParseFailureCount: number;
  extractionTransportFailureCount: number;
  extractionFailureCount: number;
  byRole: Partial<Record<MemoryRole, number>>;
  skippedRecords: TranscriptIngestSkippedRecord[];
}

export interface AutopilotIngestDirectoryReport {
  enabled: boolean;
  directoryHash: string;
  fileCount: number;
  parsed: number;
  observed: number;
  deduplicated: number;
  skipped: number;
  extractionWindowCount: number;
  extractionCallCount: number;
  extractionEmptyCount: number;
  extractionParseFailureCount: number;
  extractionTransportFailureCount: number;
  extractionFailureCount: number;
  files: Array<{
    fileName: string;
    sourceFileHash: string;
    format: TranscriptIngestFormat;
    parsed: number;
    observed: number;
    deduplicated: number;
    skipped: number;
    extractionWindowCount: number;
    extractionCallCount: number;
    extractionEmptyCount: number;
    extractionParseFailureCount: number;
    extractionTransportFailureCount: number;
    extractionFailureCount: number;
    fullyKnown: boolean;
  }>;
  errors: Array<{ fileName: string; message: string }>;
}

export interface AutopilotReport {
  schema: "gmos.autopilot_report.v1";
  profileId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  phases: MaintenancePhase[];
  counts: {
    ingested: number;
    skipped: number;
    embedded: number;
    transitions: Partial<Record<MaintenancePhase, number>>;
    errors: number;
  };
  ingest: AutopilotIngestDirectoryReport;
  embeddingBackfill: {
    enabled: boolean;
    batchSize: number;
    candidateCount: number;
    embeddedCount: number;
    fallbackCount: number;
    pendingCount: number;
    staleProviderCount: number;
    skippedCount: number;
  };
  maintenance: {
    evaluated: number;
    transitions: number;
    exempted: number;
    skipped: Array<{ reason: string; count: number }>;
    consolidation: {
      enabled: boolean;
      evaluated: number;
      duplicateClusters: number;
      archivedMembers: number;
      summaryMemories: number;
      rejectedCandidates: number;
    };
    distillation: {
      enabled: boolean;
      evaluated: number;
      clusters: number;
      summaryMemories: number;
      rejectedCandidates: number;
    };
    dossier: {
      enabled: boolean;
      evaluated: number;
      entities: number;
      summaryMemories: number;
      rejectedCandidates: number;
    };
  };
  errors: Array<{ step: string; message: string }>;
}

export interface AutopilotStore extends MemoryStore {
  repairSearchIndex?(input?: {
    dryRun?: boolean | undefined;
    vectorBatchSize?: number | undefined;
    now?: string | undefined;
  }): Promise<RepairSearchIndexResult> | RepairSearchIndexResult;
  recordAutopilotRun?(input: {
    profileId: string;
    startedAt: string;
    durationMs: number;
    dryRun: boolean;
    phases: string[];
    counts: Record<string, unknown>;
    report: Record<string, unknown>;
  }): unknown;
  pruneAutopilotRuns?(retention: number, profileId?: string | undefined): number;
  readAuditSnapshot?(): Promise<ReadAuditSnapshot> | ReadAuditSnapshot;
}

export interface RunAutopilotInput {
  store: AutopilotStore;
  memory?: MemoryOS | undefined;
  profileId?: string | undefined;
  phases?: MaintenancePhase[] | undefined;
  embedBackfill?: boolean | { batchSize?: number | undefined } | undefined;
  ingest?: { dir?: string | undefined } | undefined;
  dryRun?: boolean | undefined;
  now?: string | undefined;
  historyRetention?: number | undefined;
}

interface ParsedTranscriptRecord {
  role: MemoryRole;
  content: string;
  createdAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^\w .,:;()[\]-]+/gu, " ").slice(0, 240);
}

function normalizeRole(value: unknown): MemoryRole | null {
  return value === "system" || value === "user" || value === "assistant" || value === "tool"
    ? value
    : null;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  return undefined;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (
      type === "tool_use" ||
      type === "tool_result" ||
      type === "function_call" ||
      type === "function_call_output"
    ) {
      continue;
    }
    for (const key of ["text", "content", "value"]) {
      if (typeof record[key] === "string") parts.push(record[key]);
    }
  }
  return parts.join("\n").trim();
}

function parseJsonLine(line: string, index: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error(`record ${index} is not valid JSON`);
  }
  throw new Error(`record ${index} must be a JSON object`);
}

function parseJsonl(text: string): { records: ParsedTranscriptRecord[]; skipped: TranscriptIngestSkippedRecord[] } {
  const records: ParsedTranscriptRecord[] = [];
  const skipped: TranscriptIngestSkippedRecord[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const record = parseJsonLine(line, index);
      const role = normalizeRole(record.role);
      const content = textFromContent(record.content).trim();
      if (!role) {
        skipped.push({ index, reason: "unsupported_role" });
        continue;
      }
      if (!content) {
        skipped.push({ index, reason: "empty_content" });
        continue;
      }
      const metadata = record.metadata &&
        typeof record.metadata === "object" &&
        !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : undefined;
      records.push({
        role,
        content,
        createdAt: isoTimestamp(record.createdAt ?? record.created_at),
        ...(metadata ? { metadata } : {}),
      });
    } catch (error) {
      skipped.push({ index, reason: safeError(error) });
    }
  }
  return { records, skipped };
}

function parseClaudeCode(text: string): {
  records: ParsedTranscriptRecord[];
  skipped: TranscriptIngestSkippedRecord[];
} {
  const records: ParsedTranscriptRecord[] = [];
  const skipped: TranscriptIngestSkippedRecord[] = [];
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const row = parseJsonLine(line, index);
      const message = row.message && typeof row.message === "object" && !Array.isArray(row.message)
        ? row.message as Record<string, unknown>
        : row;
      const role = normalizeRole(message.role ?? row.type);
      if (role !== "user" && role !== "assistant") {
        skipped.push({ index, reason: "non_message_record" });
        continue;
      }
      const content = textFromContent(message.content ?? row.content).trim();
      if (!content) {
        skipped.push({ index, reason: "empty_content" });
        continue;
      }
      records.push({
        role,
        content,
        createdAt: isoTimestamp(row.timestamp ?? row.createdAt ?? row.created_at),
        metadata: { transcriptFormat: "claude-code" },
      });
    } catch (error) {
      skipped.push({ index, reason: safeError(error) });
    }
  }
  return { records, skipped };
}

function openaiMessages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.messages)) return record.messages;
  if (Array.isArray(record.data)) return record.data;
  return [];
}

function parseOpenAiThread(text: string): {
  records: ParsedTranscriptRecord[];
  skipped: TranscriptIngestSkippedRecord[];
} {
  const parsed = JSON.parse(text) as unknown;
  const rows = openaiMessages(parsed);
  const records: ParsedTranscriptRecord[] = [];
  const skipped: TranscriptIngestSkippedRecord[] = [];
  rows.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      skipped.push({ index, reason: "record_not_object" });
      return;
    }
    const row = entry as Record<string, unknown>;
    const role = normalizeRole(row.role);
    const content = textFromContent(row.content).trim();
    if (!role) {
      skipped.push({ index, reason: "unsupported_role" });
      return;
    }
    if (!content) {
      skipped.push({ index, reason: "empty_content" });
      return;
    }
    records.push({
      role,
      content,
      createdAt: isoTimestamp(row.created_at ?? row.createdAt),
      metadata: { transcriptFormat: "openai-thread" },
    });
  });
  return { records, skipped };
}

function parseTranscript(text: string, format: TranscriptIngestFormat): {
  format: TranscriptIngestFormat;
  records: ParsedTranscriptRecord[];
  skipped: TranscriptIngestSkippedRecord[];
} {
  if (format === "openai-thread") return { format, ...parseOpenAiThread(text) };
  if (format === "claude-code") return { format, ...parseClaudeCode(text) };
  if (format === "jsonl") return { format, ...parseJsonl(text) };
  try {
    const openai = parseOpenAiThread(text);
    if (openai.records.length > 0 || openai.skipped.length > 0) {
      return { format: "openai-thread", ...openai };
    }
  } catch {
  }
  const claude = parseClaudeCode(text);
  const generic = parseJsonl(text);
  return claude.records.length >= generic.records.length
    ? { format: "claude-code", ...claude }
    : { format: "jsonl", ...generic };
}

export async function ingestTranscript(input: TranscriptIngestInput): Promise<TranscriptIngestReport> {
  const text = input.text ?? readFileSync(String(input.inputFile), "utf8");
  const sourceFileHash = sha256(text);
  const profileId = input.profileId ?? "default";
  const parsed = parseTranscript(text, input.format);
  const report: TranscriptIngestReport = {
    schema: "gmos.transcript_ingest_report.v1",
    profileId,
    dryRun: input.dryRun === true,
    format: parsed.format,
    sourceFileHash,
    ...(input.fileName ? { fileName: input.fileName } : {}),
    parsed: parsed.records.length,
    observed: 0,
    deduplicated: 0,
    skipped: parsed.skipped.length,
    extractionWindowCount: 0,
    extractionCallCount: 0,
    extractionEmptyCount: 0,
    extractionParseFailureCount: 0,
    extractionTransportFailureCount: 0,
    extractionFailureCount: 0,
    byRole: {},
    skippedRecords: parsed.skipped,
  };
  parsed.records.forEach((record) => {
    report.byRole[record.role] = (report.byRole[record.role] ?? 0) + 1;
  });
  if (input.dryRun === true) return report;
  const ingested = await input.memory.ingestConversation({
    profileId,
    messages: parsed.records.map((record, index) => ({
      conversationId: `ingest:${sourceFileHash}`,
      messageId: `ingest:${sourceFileHash}:${index}`,
      role: record.role,
      content: record.content,
      ...(record.createdAt !== undefined || input.now !== undefined
        ? { createdAt: record.createdAt ?? input.now }
        : {}),
      metadata: {
        ...record.metadata,
        sourceFileHash,
        recordIndex: index,
      },
    })),
  });
  for (const observed of ingested.results) {
    if (observed.skippedReason === "deduplicated_event") report.deduplicated += 1;
    else if (observed.evidenceId) report.observed += 1;
    else report.skipped += 1;
  }
  report.extractionWindowCount = ingested.extractionWindowCount;
  report.extractionCallCount = ingested.extractionCallCount;
  report.extractionEmptyCount = ingested.extractionEmptyCount;
  report.extractionParseFailureCount = ingested.extractionParseFailureCount;
  report.extractionTransportFailureCount = ingested.extractionTransportFailureCount;
  report.extractionFailureCount = ingested.extractionFailureCount;
  return report;
}

function supportedTranscriptFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".jsonl") || entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
}

async function ingestDirectory(input: {
  memory: MemoryOS;
  profileId: string;
  dir?: string | undefined;
  dryRun: boolean;
  now: string;
}): Promise<AutopilotIngestDirectoryReport> {
  if (!input.dir) {
    return {
      enabled: false,
      directoryHash: "",
      fileCount: 0,
      parsed: 0,
      observed: 0,
      deduplicated: 0,
      skipped: 0,
      extractionWindowCount: 0,
      extractionCallCount: 0,
      extractionEmptyCount: 0,
      extractionParseFailureCount: 0,
      extractionTransportFailureCount: 0,
      extractionFailureCount: 0,
      files: [],
      errors: [],
    };
  }
  const names = supportedTranscriptFiles(input.dir);
  const report: AutopilotIngestDirectoryReport = {
    enabled: true,
    directoryHash: sha256(names.join("\n")),
    fileCount: names.length,
    parsed: 0,
    observed: 0,
    deduplicated: 0,
    skipped: 0,
    extractionWindowCount: 0,
    extractionCallCount: 0,
    extractionEmptyCount: 0,
    extractionParseFailureCount: 0,
    extractionTransportFailureCount: 0,
    extractionFailureCount: 0,
    files: [],
    errors: [],
  };
  for (const name of names) {
    const file = path.join(input.dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const child = await ingestTranscript({
        memory: input.memory,
        profileId: input.profileId,
        inputFile: file,
        format: "auto",
        dryRun: input.dryRun,
        now: input.now,
        fileName: path.basename(name),
      });
      report.parsed += child.parsed;
      report.observed += child.observed;
      report.deduplicated += child.deduplicated;
      report.skipped += child.skipped;
      report.extractionWindowCount += child.extractionWindowCount;
      report.extractionCallCount += child.extractionCallCount;
      report.extractionEmptyCount += child.extractionEmptyCount;
      report.extractionParseFailureCount += child.extractionParseFailureCount;
      report.extractionTransportFailureCount += child.extractionTransportFailureCount;
      report.extractionFailureCount += child.extractionFailureCount;
      report.files.push({
        fileName: path.basename(name),
        sourceFileHash: child.sourceFileHash,
        format: child.format,
        parsed: child.parsed,
        observed: child.observed,
        deduplicated: child.deduplicated,
        skipped: child.skipped,
        extractionWindowCount: child.extractionWindowCount,
        extractionCallCount: child.extractionCallCount,
        extractionEmptyCount: child.extractionEmptyCount,
        extractionParseFailureCount: child.extractionParseFailureCount,
        extractionTransportFailureCount: child.extractionTransportFailureCount,
        extractionFailureCount: child.extractionFailureCount,
        fullyKnown: child.parsed > 0 && child.observed === 0 && child.deduplicated === child.parsed,
      });
    } catch (error) {
      report.errors.push({ fileName: path.basename(name), message: safeError(error) });
    }
  }
  return report;
}

function emptyBackfillReport(input: { enabled: boolean; batchSize: number }): AutopilotReport["embeddingBackfill"] {
  return {
    enabled: input.enabled,
    batchSize: input.batchSize,
    candidateCount: 0,
    embeddedCount: 0,
    fallbackCount: 0,
    pendingCount: 0,
    staleProviderCount: 0,
    skippedCount: 0,
  };
}

function contentFreeMaintenance(report: MaintenanceReport): AutopilotReport["maintenance"] {
  return {
    evaluated: report.evaluated,
    transitions: report.transitions.length,
    exempted: report.exempted.length,
    skipped: report.skipped.map((entry) => ({ reason: entry.reason, count: entry.count })),
    consolidation: {
      enabled: report.consolidation.enabled,
      evaluated: report.consolidation.evaluated,
      duplicateClusters: report.consolidation.duplicateClusters.length,
      archivedMembers: report.consolidation.duplicateClusters.reduce(
        (sum, cluster) => sum + cluster.archivedMemberIds.length,
        0,
      ),
      summaryMemories: report.consolidation.summaryMemories.length,
      rejectedCandidates: report.consolidation.rejectedCandidates.length,
    },
    distillation: {
      enabled: report.distillation.enabled,
      evaluated: report.distillation.evaluated,
      clusters: report.distillation.clusters.length,
      summaryMemories: report.distillation.summaryMemories.length,
      rejectedCandidates: report.distillation.rejectedCandidates.length,
    },
    dossier: {
      enabled: report.dossier.enabled,
      evaluated: report.dossier.evaluated,
      entities: report.dossier.entities.length,
      summaryMemories: report.dossier.summaryMemories.length,
      rejectedCandidates: report.dossier.rejectedCandidates.length,
    },
  };
}

function emptyMaintenance(): AutopilotReport["maintenance"] {
  return {
    evaluated: 0,
    transitions: 0,
    exempted: 0,
    skipped: [],
    consolidation: {
      enabled: false,
      evaluated: 0,
      duplicateClusters: 0,
      archivedMembers: 0,
      summaryMemories: 0,
      rejectedCandidates: 0,
    },
    distillation: {
      enabled: false,
      evaluated: 0,
      clusters: 0,
      summaryMemories: 0,
      rejectedCandidates: 0,
    },
    dossier: {
      enabled: false,
      evaluated: 0,
      entities: 0,
      summaryMemories: 0,
      rejectedCandidates: 0,
    },
  };
}

function readAuditHash(snapshot: ReadAuditSnapshot): string {
  return sha256(JSON.stringify(snapshot));
}

function assertDryRunNoWrites(input: {
  before: ReadAuditSnapshot | null;
  after: ReadAuditSnapshot | null;
}): void {
  if (!input.before || !input.after) return;
  if (readAuditHash(input.before) !== readAuditHash(input.after)) {
    throw new Error("gmOS autopilot dry-run changed store state");
  }
}

function assertReportContentFree(value: unknown, pathParts: string[] = []): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReportContentFree(entry, [...pathParts, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (lower === "content" || lower === "text" || lower === "contextblock") {
      throw new Error(`gmOS autopilot report is not content-free at ${[...pathParts, key].join(".")}`);
    }
    assertReportContentFree(child, [...pathParts, key]);
  }
}

export async function runAutopilot(input: RunAutopilotInput): Promise<AutopilotReport> {
  const profileId = input.profileId ?? "default";
  const phases = input.phases ?? ["decay"];
  const startedAt = input.now ?? nowIso();
  const startedMs = Date.now();
  const dryRun = input.dryRun === true;
  const memory = input.memory ?? createMemoryOS({ profileId, store: input.store });
  const closeMemory = input.memory ? null : memory;
  try {
    const before = dryRun && input.store.readAuditSnapshot
      ? await input.store.readAuditSnapshot()
      : null;
    const errors: AutopilotReport["errors"] = [];
    let ingest: AutopilotIngestDirectoryReport;
    try {
      ingest = await ingestDirectory({
        memory,
        profileId,
        dir: input.ingest?.dir,
        dryRun,
        now: startedAt,
      });
    } catch (error) {
      ingest = {
        enabled: Boolean(input.ingest?.dir),
        directoryHash: input.ingest?.dir ? sha256(path.basename(input.ingest.dir)) : "",
        fileCount: 0,
        parsed: 0,
        observed: 0,
        deduplicated: 0,
        skipped: 0,
        extractionWindowCount: 0,
        extractionCallCount: 0,
        extractionEmptyCount: 0,
        extractionParseFailureCount: 0,
        extractionTransportFailureCount: 0,
        extractionFailureCount: 0,
        files: [],
        errors: [{ fileName: "directory", message: safeError(error) }],
      };
    }

  const backfillBatch =
    typeof input.embedBackfill === "object" ? input.embedBackfill.batchSize ?? 32 : 32;
  let embeddingBackfill = emptyBackfillReport({
    enabled: input.embedBackfill !== false,
    batchSize: backfillBatch,
  });
  if (input.embedBackfill !== false) {
    try {
      if (!input.store.repairSearchIndex) throw new Error("store does not support search repair");
      const repaired = await input.store.repairSearchIndex({
        dryRun,
        vectorBatchSize: backfillBatch,
        now: startedAt,
      });
      embeddingBackfill = {
        enabled: true,
        batchSize: repaired.vectorBackfill.batchSize,
        candidateCount: repaired.vectorBackfill.candidateCount,
        embeddedCount: repaired.vectorBackfill.embeddedCount,
        fallbackCount: repaired.vectorBackfill.fallbackCount,
        pendingCount: repaired.vectorBackfill.pendingCount,
        staleProviderCount: repaired.vectorBackfill.staleProviderCount,
        skippedCount: repaired.vectorBackfill.skippedCount,
      };
    } catch (error) {
      errors.push({ step: "embedding_backfill", message: safeError(error) });
    }
  }

  let maintenance = emptyMaintenance();
  try {
    maintenance = contentFreeMaintenance(await memory.maintain({
      profileId,
      dryRun,
      phases,
      now: startedAt,
    }));
  } catch (error) {
    errors.push({ step: "maintenance", message: safeError(error) });
  }

  errors.push(...ingest.errors.map((error) => ({
    step: `ingest:${error.fileName}`,
    message: error.message,
  })));
  const finishedAt = input.now ?? nowIso();
  const report: AutopilotReport = {
    schema: "gmos.autopilot_report.v1",
    profileId,
    startedAt,
    finishedAt,
    durationMs: input.now ? 0 : Math.max(0, Date.now() - startedMs),
    dryRun,
    phases,
    counts: {
      ingested: ingest.observed,
      skipped: ingest.skipped + ingest.deduplicated + embeddingBackfill.skippedCount,
      embedded: embeddingBackfill.embeddedCount + embeddingBackfill.fallbackCount,
      transitions: { decay: maintenance.transitions },
      errors: errors.length,
    },
    ingest,
    embeddingBackfill,
    maintenance,
    errors,
  };
  assertReportContentFree(report);
  if (dryRun) {
    assertDryRunNoWrites({
      before,
      after: input.store.readAuditSnapshot ? await input.store.readAuditSnapshot() : null,
    });
  } else if (input.store.recordAutopilotRun) {
    input.store.recordAutopilotRun({
      profileId,
      startedAt,
      durationMs: report.durationMs,
      dryRun,
      phases,
      counts: report.counts,
      report: report as unknown as Record<string, unknown>,
    });
    if (input.store.pruneAutopilotRuns) {
      input.store.pruneAutopilotRuns(input.historyRetention ?? 100, profileId);
    }
  }
    return report;
  } finally {
    if (closeMemory) await closeMemory.close();
  }
}
