import { createHash } from "node:crypto";

import type {
  AtomicHostSnapshotRecord,
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

export interface HostMemorySnapshot {
  id: string;
  content: string;
  kind?: string | undefined;
  scope?: string | undefined;
  sensitivity?: string | undefined;
  confidence?: number | undefined;
  sourceUri?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
}

export interface HostMemorySnapshotImportInput {
  store: MemoryStore;
  profileId: string;
  memories: HostMemorySnapshot[];
  sourceType?: string | undefined;
  sourceUriPrefix?: string | undefined;
  nowIso?: string | undefined;
  skipPerson?: boolean | undefined;
  skipSecretLike?: boolean | undefined;
}

export interface HostMemorySnapshotSkip {
  id: string;
  reason: "empty_content" | "person_memory" | "secret_like";
}

export interface HostMemorySnapshotImportReport {
  inputCount: number;
  loadedCount: number;
  reusedCount: number;
  skippedCount: number;
  loadedMemoryIds: string[];
  skipped: HostMemorySnapshotSkip[];
}

export interface HostMemorySnapshotSyncReport {
  inputCount: number;
  loadedCount: number;
  reusedCount: number;
  skippedCount: number;
  archivedCount: number;
  loadedMemoryIds: string[];
  archivedMemoryIds: string[];
  skipped: HostMemorySnapshotSkip[];
  importReport: HostMemorySnapshotImportReport;
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

const SENSITIVITIES = new Set<Sensitivity>(["normal", "sensitive", "secret_like"]);

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeHostMemoryKind(snapshot: Pick<HostMemorySnapshot, "content" | "kind">): MemoryKind {
  if (isPersonRoutedMemory(snapshot.content)) return "person";
  const explicit = stringOrEmpty(snapshot.kind).toLowerCase();
  if (MEMORY_KINDS.has(explicit as MemoryKind)) return explicit as MemoryKind;
  return "fact";
}

export function normalizeHostMemorySensitivity(
  snapshot: Pick<HostMemorySnapshot, "content" | "scope" | "sensitivity"> &
    Partial<Pick<
      HostMemorySnapshot,
      "id" | "sourceUri" | "metadata" | "createdAt" | "updatedAt"
    >>,
): Sensitivity {
  const detected = classifyPayloadSensitivity(snapshot);
  const explicit = stringOrEmpty(snapshot.sensitivity).toLowerCase();
  const declared = SENSITIVITIES.has(explicit as Sensitivity)
    ? explicit as Sensitivity
    : "normal";
  if (detected === "secret_like" || declared === "secret_like") return "secret_like";
  if (detected === "sensitive" || declared === "sensitive") return "sensitive";
  return "normal";
}

function sourceUriFor(input: {
  snapshot: HostMemorySnapshot;
  sourceUriPrefix: string;
}): string {
  if (input.snapshot.sourceUri) return input.snapshot.sourceUri;
  return `${input.sourceUriPrefix}/${encodeURIComponent(input.snapshot.id)}`;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function importHostMemorySnapshotsIntoStore(
  input: HostMemorySnapshotImportInput,
  sync: boolean,
): Promise<{
  importReport: HostMemorySnapshotImportReport;
  archivedMemoryIds: string[];
}> {
  if (!input.store.importHostSnapshotsAtomically) {
    throw new Error(
      "Host memory snapshot import requires MemoryStore.importHostSnapshotsAtomically",
    );
  }
  await input.store.initialize();
  const sourceType = input.sourceType ?? "host.memory";
  const sourceUriPrefix = input.sourceUriPrefix ?? "host://memory";
  const skipPerson = input.skipPerson ?? true;
  const skipSecretLike = input.skipSecretLike ?? true;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const importReport: HostMemorySnapshotImportReport = {
    inputCount: input.memories.length,
    loadedCount: 0,
    reusedCount: 0,
    skippedCount: 0,
    loadedMemoryIds: [],
    skipped: [],
  };
  const records: AtomicHostSnapshotRecord[] = [];

  for (const [index, snapshot] of input.memories.entries()) {
    const content = snapshot.content.trim();
    if (!content) {
      importReport.skipped.push({ id: redactForReport(snapshot.id), reason: "empty_content" });
      continue;
    }
    const kind = normalizeHostMemoryKind(snapshot);
    const sourceUri = sourceUriFor({ snapshot, sourceUriPrefix });
    const snapshotSensitivity = normalizeHostMemorySensitivity(snapshot);
    const envelopeSensitivity = classifyPayloadSensitivity({
      sourceType,
      sourceUri,
      snapshot,
    });
    const sensitivity = envelopeSensitivity === "secret_like" ||
        snapshotSensitivity === "secret_like"
      ? "secret_like"
      : envelopeSensitivity === "sensitive" || snapshotSensitivity === "sensitive"
        ? "sensitive"
        : "normal";
    if (skipPerson && kind === "person") {
      importReport.skipped.push({ id: redactForReport(snapshot.id), reason: "person_memory" });
      continue;
    }
    if (skipSecretLike && sensitivity === "secret_like") {
      importReport.skipped.push({ id: redactForReport(snapshot.id), reason: "secret_like" });
      continue;
    }
    records.push({
      sourceIndex: index,
      hostMemoryId: snapshot.id,
      content,
      kind,
      scope: snapshot.scope ?? "global",
      sensitivity,
      confidence: snapshot.confidence ?? 0.7,
      sourceUri,
      metadata: stripGmosOwnedMetadataFields(
        sanitizePublicPayloadRecord(snapshot.metadata ?? {}),
      ),
      ...(snapshot.createdAt ? { createdAt: snapshot.createdAt } : {}),
      ...(snapshot.updatedAt !== undefined ? { updatedAt: snapshot.updatedAt } : {}),
    });
  }
  const result = await input.store.importHostSnapshotsAtomically({
    profileId: input.profileId,
    sourceType,
    records,
    sync,
    allowSecretLike: skipSecretLike === false,
    occurredAt: nowIso,
  });
  importReport.loadedMemoryIds = [...result.memories]
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map((entry) => entry.memory.id);
  importReport.loadedCount = importReport.loadedMemoryIds.length;
  importReport.reusedCount = result.memories.filter(
    (entry) => entry.disposition !== "inserted",
  ).length;
  importReport.skippedCount = importReport.skipped.length;
  return { importReport, archivedMemoryIds: result.archivedMemoryIds };
}

export async function loadHostMemorySnapshotsIntoStore(
  input: HostMemorySnapshotImportInput,
): Promise<HostMemorySnapshotImportReport> {
  return (await importHostMemorySnapshotsIntoStore(input, false)).importReport;
}

export async function syncHostMemorySnapshotsIntoStore(
  input: HostMemorySnapshotImportInput,
): Promise<HostMemorySnapshotSyncReport> {
  const { importReport, archivedMemoryIds } = await importHostMemorySnapshotsIntoStore(
    input,
    true,
  );
  return {
    inputCount: importReport.inputCount,
    loadedCount: importReport.loadedCount,
    reusedCount: importReport.reusedCount,
    skippedCount: importReport.skippedCount,
    archivedCount: archivedMemoryIds.length,
    loadedMemoryIds: importReport.loadedMemoryIds,
    archivedMemoryIds,
    skipped: importReport.skipped,
    importReport,
  };
}
