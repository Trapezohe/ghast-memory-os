import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  AddMemoryInput,
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  Sensitivity,
} from "../kernel/types.js";
import {
  classifySensitivity,
  isPersonRoutedMemory,
  sanitizePublicPayloadRecord,
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

function parseMem0Record(entry: unknown, index: number): ParsedMem0Record | null {
  if (!isRecord(entry)) return null;
  const content = stringField(entry, "memory") ?? stringField(entry, "text") ?? "";
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  const id = stringField(entry, "id") ?? String(index);
  const kind = isPersonRoutedMemory(content) ? "person" : kindFromMetadata(metadata);
  const scope = typeof metadata.scope === "string" && metadata.scope.trim()
    ? metadata.scope.trim()
    : "global";
  return {
    id,
    content,
    kind,
    scope,
    sensitivity: classifySensitivity(`${scope}\n${content}`),
    metadata,
    ...(optionalIso(entry.created_at ?? entry.createdAt ?? entry.updated_at ?? entry.updatedAt)
      ? { createdAt: optionalIso(entry.created_at ?? entry.createdAt ?? entry.updated_at ?? entry.updatedAt) }
      : {}),
  };
}

function importKey(input: { profileId: string; sourceFileHash: string; index: number }): string {
  return [input.profileId, "mem0", input.sourceFileHash, String(input.index)].join("|");
}

function eventKey(input: { profileId: string; sourceFileHash: string; index: number }): string {
  return ["mem0.import", input.profileId, input.sourceFileHash, String(input.index)].join(":");
}

export async function loadMem0ExportIntoStore(input: Mem0ImportInput): Promise<Mem0ImportReport> {
  await input.store.initialize();
  if (!input.store.findActiveMemoryByMetadata) {
    throw new Error("mem0 import requires MemoryStore.findActiveMemoryByMetadata");
  }
  const text = input.text ?? readFileSync(String(input.inputFile), "utf8");
  const sourceFileHash = sha256(text);
  const rows = parseMem0Export(text);
  const profileId = input.profileId;
  const report: Mem0ImportReport = {
    schema: "gmos.mem0_import_report.v1",
    profileId,
    sourceFileHash,
    ...((input.fileName ?? input.inputFile)
      ? { fileName: path.basename(input.fileName ?? input.inputFile!) }
      : {}),
    inputCount: rows.length,
    loadedCount: 0,
    reusedCount: 0,
    skippedCount: 0,
    loadedMemoryIds: [],
    skipped: [],
  };
  const loadedMemoryIdsByIndex = new Map<number, string>();
  const pendingAdds: Array<{ index: number; input: AddMemoryInput }> = [];

  for (let index = 0; index < rows.length; index += 1) {
    const parsed = parseMem0Record(rows[index], index);
    if (!parsed) {
      report.skipped.push({ index, id: String(index), reason: "invalid_record" });
      continue;
    }
    const content = parsed.content.trim();
    if (!content) {
      report.skipped.push({ index, id: parsed.id, reason: "empty_content" });
      continue;
    }
    if (parsed.kind === "person" && input.allowPerson !== true) {
      report.skipped.push({ index, id: parsed.id, reason: "person_memory" });
      continue;
    }
    if (parsed.sensitivity === "secret_like") {
      report.skipped.push({ index, id: parsed.id, reason: "secret_like" });
      continue;
    }
    const key = importKey({ profileId, sourceFileHash, index });
    const existing = await input.store.findActiveMemoryByMetadata(profileId, "importKey", key);
    const existingEvidence = input.store.getEvidenceByEventKey
      ? await input.store.getEvidenceByEventKey(eventKey({ profileId, sourceFileHash, index }))
      : null;
    if (existing || existingEvidence) {
      if (existing) loadedMemoryIdsByIndex.set(index, existing.id);
      report.reusedCount += 1;
      continue;
    }
    const createdAt = parsed.createdAt ?? input.nowIso ?? nowIso();
    const evidence = await input.store.recordEvidence({
      profileId,
      eventKey: eventKey({ profileId, sourceFileHash, index }),
      sourceType: "mem0.import",
      sourceUri: `mem0://${sourceFileHash}/${index}`,
      content,
      sensitivity: parsed.sensitivity,
      eligibleForLongTermMemory: true,
      payload: {
        importSource: "mem0",
        importSourceOriginalId: parsed.id,
        sourceFileHash,
        recordIndex: index,
        provenance: "low_level_import",
        sourceTrust: "external",
      },
      createdAt,
    });
    pendingAdds.push({
      index,
      input: {
        profileId,
        kind: parsed.kind,
        scope: parsed.scope,
        content,
        sensitivity: parsed.sensitivity,
        confidence: 0.7,
        sourceEventId: evidence.id,
        metadata: {
          ...sanitizePublicPayloadRecord(parsed.metadata),
          importSource: "mem0",
          importSourceOriginalId: parsed.id,
          importKey: key,
          sourceFileHash,
          recordIndex: index,
          provenance: "low_level_import",
          sourceTrust: "external",
        },
        createdAt,
      },
    });
  }
  const memories = input.store.addMemories
    ? await input.store.addMemories(pendingAdds.map((pending) => pending.input))
    : [];
  if (!input.store.addMemories) {
    for (const pending of pendingAdds) {
      memories.push(await input.store.addMemory(pending.input) as MemoryRecord);
    }
  }
  for (const [offset, memory] of memories.entries()) {
    const pending = pendingAdds[offset];
    if (!pending) continue;
    loadedMemoryIdsByIndex.set(pending.index, (memory as MemoryRecord).id);
    report.loadedCount += 1;
  }
  report.loadedMemoryIds = [...loadedMemoryIdsByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
  report.skippedCount = report.skipped.length;
  return report;
}
