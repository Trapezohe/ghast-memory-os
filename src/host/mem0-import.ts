import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  MemoryKind,
  MemoryStore,
  Sensitivity,
} from "../kernel/types.js";
import {
  classifyPayloadSensitivity,
  isPersonRoutedMemory,
  redactForReport,
  sanitizePublicPayloadRecord,
  stripGmosOwnedMetadataFields,
} from "../kernel/safety.js";

export interface Mem0ImportInput {
  store: MemoryStore;
  profileId: string;
  inputFile?: string | undefined;
  text?: string | undefined;
  fileName?: string | undefined;
  nowIso?: string | undefined;
  allowPerson?: boolean | undefined;
}

export interface Mem0ImportSkippedRecord {
  index: number;
  id: string;
  reason: "empty_content" | "person_memory" | "secret_like" | "invalid_record";
}

export interface Mem0ImportReport {
  schema: "gmos.mem0_import_report.v1";
  profileId: string;
  sourceFileHash: string;
  fileName?: string | undefined;
  inputCount: number;
  loadedCount: number;
  reusedCount: number;
  skippedCount: number;
  loadedMemoryIds: string[];
  skipped: Mem0ImportSkippedRecord[];
}

interface ParsedMem0Record {
  id: string;
  content: string;
  kind: MemoryKind;
  scope: string;
  sensitivity: Sensitivity;
  metadata: Record<string, unknown>;
  createdAt?: string | undefined;
}

const MEMORY_KINDS = new Set<MemoryKind>([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "person",
  "task_trajectory",
]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordsFromMem0Export(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.results)) return value.results;
  throw new Error("gmOS mem0 import expects an array or { results: [...] }");
}

export function parseMem0Export(text: string): unknown[] {
  return recordsFromMem0Export(JSON.parse(text) as unknown);
}

function optionalIso(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const timestamp = typeof value === "number"
    ? value < 10_000_000_000
      ? value * 1000
      : value
    : Date.parse(value);
  if (!Number.isFinite(timestamp) || Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function kindFromMetadata(metadata: Record<string, unknown>): MemoryKind {
  for (const key of ["kind", "memoryKind", "memory_kind", "gmosKind", "gmos_kind"]) {
    const value = metadata[key];
    if (typeof value === "string" && MEMORY_KINDS.has(value as MemoryKind)) {
      return value as MemoryKind;
    }
  }
  return "fact";
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMem0Record(entry: unknown): ParsedMem0Record | null {
  if (!isRecord(entry)) return null;
  const content = stringField(entry, "memory") ?? stringField(entry, "text") ?? "";
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  const id = stringField(entry, "id");
  if (!id) return null;
  const kind = isPersonRoutedMemory(content) ? "person" : kindFromMetadata(metadata);
  const scope = typeof metadata.scope === "string" && metadata.scope.trim()
    ? metadata.scope.trim()
    : "global";
  return {
    id,
    content,
    kind,
    scope,
    sensitivity: classifyPayloadSensitivity(entry),
    metadata,
    ...(optionalIso(entry.created_at ?? entry.createdAt ?? entry.updated_at ?? entry.updatedAt)
      ? { createdAt: optionalIso(entry.created_at ?? entry.createdAt ?? entry.updated_at ?? entry.updatedAt) }
      : {}),
  };
}

export async function loadMem0ExportIntoStore(input: Mem0ImportInput): Promise<Mem0ImportReport> {
  if (!input.store.importMem0RecordsAtomically) {
    throw new Error(
      "mem0 import requires MemoryStore.importMem0RecordsAtomically",
    );
  }
  await input.store.initialize();
  const text = input.text ?? readFileSync(String(input.inputFile), "utf8");
  const sourceFileHash = sha256(text);
  const rows = parseMem0Export(text);
  const profileId = input.profileId;
  const report: Mem0ImportReport = {
    schema: "gmos.mem0_import_report.v1",
    profileId,
    sourceFileHash,
    ...((input.fileName ?? input.inputFile)
      ? { fileName: redactForReport(path.basename(input.fileName ?? input.inputFile!)) }
      : {}),
    inputCount: rows.length,
    loadedCount: 0,
    reusedCount: 0,
    skippedCount: 0,
    loadedMemoryIds: [],
    skipped: [],
  };
  const records = [];

  for (let index = 0; index < rows.length; index += 1) {
    const parsed = parseMem0Record(rows[index]);
    if (!parsed) {
      report.skipped.push({ index, id: redactForReport(String(index)), reason: "invalid_record" });
      continue;
    }
    const content = parsed.content.trim();
    if (!content) {
      report.skipped.push({ index, id: redactForReport(parsed.id), reason: "empty_content" });
      continue;
    }
    if (parsed.kind === "person" && input.allowPerson !== true) {
      report.skipped.push({ index, id: redactForReport(parsed.id), reason: "person_memory" });
      continue;
    }
    if (parsed.sensitivity === "secret_like") {
      report.skipped.push({ index, id: redactForReport(parsed.id), reason: "secret_like" });
      continue;
    }
    records.push({
      sourceIndex: index,
      originalId: parsed.id,
      content,
      kind: parsed.kind,
      scope: parsed.scope,
      sensitivity: parsed.sensitivity,
      metadata: stripGmosOwnedMetadataFields(
        sanitizePublicPayloadRecord(parsed.metadata),
      ),
      ...(parsed.createdAt ? { createdAt: parsed.createdAt } : {}),
    });
  }
  const results = await input.store.importMem0RecordsAtomically({
    profileId,
    sourceFileHash,
    records,
    occurredAt: input.nowIso ?? nowIso(),
  });
  report.loadedCount = results.filter((result) => result.disposition === "inserted").length;
  report.reusedCount = results.length - report.loadedCount;
  report.loadedMemoryIds = [...results]
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map((result) => result.memory.id);
  report.skippedCount = report.skipped.length;
  return report;
}
