import { createHash } from "node:crypto";

import type {
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  Sensitivity,
} from "../kernel/types.js";
import { classifySensitivity, isPersonRoutedMemory } from "../kernel/safety.js";

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
  snapshot: Pick<HostMemorySnapshot, "content" | "sensitivity">,
): Sensitivity {
  const contentSensitivity = classifySensitivity(snapshot.content);
  if (contentSensitivity === "secret_like") return "secret_like";
  const explicit = stringOrEmpty(snapshot.sensitivity).toLowerCase();
  if (SENSITIVITIES.has(explicit as Sensitivity)) return explicit as Sensitivity;
  return contentSensitivity;
}

function sourceUriFor(input: {
  snapshot: HostMemorySnapshot;
  sourceUriPrefix: string;
}): string {
  if (input.snapshot.sourceUri) return input.snapshot.sourceUri;
  return `${input.sourceUriPrefix}/${encodeURIComponent(input.snapshot.id)}`;
}

function eventKeyFor(input: {
  profileId: string;
  sourceType: string;
  snapshot: HostMemorySnapshot;
  sourceUri: string;
  contentHash: string;
}): string {
  return [
    "host-memory",
    input.profileId,
    input.sourceType,
    input.sourceUri,
    input.snapshot.id,
    input.snapshot.updatedAt ?? input.contentHash,
  ].join(":");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function hostImportKey(input: {
  profileId: string;
  sourceType: string;
  sourceUri: string;
  snapshot: HostMemorySnapshot;
  content: string;
}): string {
  return [
    input.profileId,
    input.sourceType,
    input.sourceUri,
    input.snapshot.id,
    input.snapshot.updatedAt ?? contentHash(input.content),
  ].join("|");
}

function importableHostSnapshotKeys(input: HostMemorySnapshotImportInput): string[] {
  const sourceType = input.sourceType ?? "host.memory";
  const sourceUriPrefix = input.sourceUriPrefix ?? "host://memory";
  const skipPerson = input.skipPerson ?? true;
  const skipSecretLike = input.skipSecretLike ?? true;
  const keys: string[] = [];
  for (const snapshot of input.memories) {
    const content = snapshot.content.trim();
    if (!content) continue;
    const kind = normalizeHostMemoryKind(snapshot);
    const sensitivity = normalizeHostMemorySensitivity(snapshot);
    if (skipPerson && kind === "person") continue;
    if (skipSecretLike && sensitivity === "secret_like") continue;
    const sourceUri = sourceUriFor({ snapshot, sourceUriPrefix });
    keys.push(
      hostImportKey({
        profileId: input.profileId,
        sourceType,
        sourceUri,
        snapshot,
        content,
      }),
    );
  }
  return keys;
}

export async function loadHostMemorySnapshotsIntoStore(
  input: HostMemorySnapshotImportInput,
): Promise<HostMemorySnapshotImportReport> {
  await input.store.initialize();
  const sourceType = input.sourceType ?? "host.memory";
  const sourceUriPrefix = input.sourceUriPrefix ?? "host://memory";
  const skipPerson = input.skipPerson ?? true;
  const skipSecretLike = input.skipSecretLike ?? true;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const report: HostMemorySnapshotImportReport = {
    inputCount: input.memories.length,
    loadedCount: 0,
    reusedCount: 0,
    skippedCount: 0,
    loadedMemoryIds: [],
    skipped: [],
  };
  if (!input.store.findActiveMemoryByMetadata) {
    throw new Error("Host memory snapshot import requires MemoryStore.findActiveMemoryByMetadata");
  }

  for (const snapshot of input.memories) {
    const content = snapshot.content.trim();
    if (!content) {
      report.skipped.push({ id: snapshot.id, reason: "empty_content" });
      continue;
    }
    const kind = normalizeHostMemoryKind(snapshot);
    const sensitivity = normalizeHostMemorySensitivity(snapshot);
    if (skipPerson && kind === "person") {
      report.skipped.push({ id: snapshot.id, reason: "person_memory" });
      continue;
    }
    if (skipSecretLike && sensitivity === "secret_like") {
      report.skipped.push({ id: snapshot.id, reason: "secret_like" });
      continue;
    }
    const sourceUri = sourceUriFor({ snapshot, sourceUriPrefix });
    const importKey = hostImportKey({
      profileId: input.profileId,
      sourceType,
      sourceUri,
      snapshot,
      content,
    });
    const existing = await input.store.findActiveMemoryByMetadata(
      input.profileId,
      "hostImportKey",
      importKey,
    );
    if (existing) {
      report.loadedMemoryIds.push(existing.id);
      report.reusedCount += 1;
      continue;
    }
    const evidence = await input.store.recordEvidence({
      profileId: input.profileId,
      eventKey: eventKeyFor({
        profileId: input.profileId,
        sourceType,
        snapshot,
        sourceUri,
        contentHash: contentHash(content),
      }),
      sourceType,
      sourceUri,
      content,
      sensitivity,
      eligibleForLongTermMemory: sensitivity !== "secret_like",
      payload: {
        hostMemoryId: snapshot.id,
        hostMemoryKind: snapshot.kind ?? null,
      },
      createdAt: snapshot.createdAt ?? nowIso,
    });
    const memory = (await input.store.addMemory({
      profileId: input.profileId,
      kind,
      scope: snapshot.scope ?? "global",
      content,
      sensitivity,
      confidence: snapshot.confidence ?? 0.7,
      sourceEventId: evidence.id,
      metadata: {
        hostImportKey: importKey,
        hostImportSourceType: sourceType,
        hostMemoryId: snapshot.id,
        hostMemoryKind: snapshot.kind ?? null,
        hostContentHash: contentHash(content),
        hostSnapshotImport: true,
      },
      createdAt: snapshot.createdAt ?? nowIso,
    })) as MemoryRecord;
    report.loadedMemoryIds.push(memory.id);
  }
  report.loadedCount = report.loadedMemoryIds.length;
  report.skippedCount = report.skipped.length;
  return report;
}

export async function syncHostMemorySnapshotsIntoStore(
  input: HostMemorySnapshotImportInput,
): Promise<HostMemorySnapshotSyncReport> {
  if (!input.store.archiveStaleHostImports) {
    throw new Error(
      "Host memory snapshot sync requires MemoryStore.archiveStaleHostImports",
    );
  }
  const sourceType = input.sourceType ?? "host.memory";
  const nowIso = input.nowIso ?? new Date().toISOString();
  const activeImportKeys = importableHostSnapshotKeys(input);
  const importReport = await loadHostMemorySnapshotsIntoStore({
    ...input,
    sourceType,
    nowIso,
  });
  const archivedMemoryIds = await input.store.archiveStaleHostImports({
    profileId: input.profileId,
    sourceType,
    activeImportKeys,
    archivedAt: nowIso,
  });
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
