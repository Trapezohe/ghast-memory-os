import type {
  LowLevelListMemoriesInput,
  MemoryOS,
  MemoryRecord,
} from "../kernel/types.js";
import type { HostMemorySnapshot } from "./snapshot-import.js";

export interface MemorySnapshotExportInput {
  memory: Pick<MemoryOS, "list">;
  profileId?: string | undefined;
  query?: string | undefined;
  status?: LowLevelListMemoriesInput["status"] | undefined;
  kind?: LowLevelListMemoriesInput["kind"] | undefined;
  scope?: string | undefined;
  limit?: number | undefined;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
  sourceUriPrefix?: string | undefined;
  nowIso?: string | undefined;
}

export interface MemorySnapshotExport {
  schema: "gmos.memory_snapshot_export.v1";
  exportedAt: string;
  profileId: string;
  sourceUriPrefix: string;
  filters: {
    status: LowLevelListMemoriesInput["status"];
    kind?: LowLevelListMemoriesInput["kind"] | undefined;
    scope?: string | undefined;
    query?: string | undefined;
    includeSensitive: boolean;
    includePerson: boolean;
    limit: number;
  };
  memoryCount: number;
  memories: HostMemorySnapshot[];
}

export function parseMemorySnapshotExport(value: unknown): MemorySnapshotExport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gmOS memory snapshot export must be a JSON object");
  }
  const record = value as Partial<MemorySnapshotExport>;
  if (record.schema !== "gmos.memory_snapshot_export.v1") {
    throw new Error("Unsupported gmOS memory snapshot export schema");
  }
  if (typeof record.profileId !== "string" || !record.profileId) {
    throw new Error("gmOS memory snapshot export requires profileId");
  }
  if (typeof record.exportedAt !== "string" || !record.exportedAt) {
    throw new Error("gmOS memory snapshot export requires exportedAt");
  }
  if (typeof record.sourceUriPrefix !== "string" || !record.sourceUriPrefix) {
    throw new Error("gmOS memory snapshot export requires sourceUriPrefix");
  }
  if (!record.filters || typeof record.filters !== "object" || Array.isArray(record.filters)) {
    throw new Error("gmOS memory snapshot export requires filters object");
  }
  if (!Array.isArray(record.memories)) {
    throw new Error("gmOS memory snapshot export requires memories array");
  }
  if (
    typeof record.memoryCount !== "number" ||
    !Number.isInteger(record.memoryCount) ||
    record.memoryCount !== record.memories.length
  ) {
    throw new Error("gmOS memory snapshot export memoryCount does not match memories");
  }
  return {
    schema: "gmos.memory_snapshot_export.v1",
    exportedAt: record.exportedAt,
    profileId: record.profileId,
    sourceUriPrefix: record.sourceUriPrefix,
    filters: normalizeFilters(record.filters),
    memoryCount: record.memories.length,
    memories: record.memories.map(normalizeSnapshot),
  };
}

export async function exportMemorySnapshots(
  input: MemorySnapshotExportInput,
): Promise<MemorySnapshotExport> {
  const profileId = input.profileId ?? "default";
  const exportedAt = input.nowIso ?? new Date().toISOString();
  const sourceUriPrefix = input.sourceUriPrefix ?? "gmos://memory";
  const limit = boundedLimit(input.limit);
  const memories = await input.memory.list({
    profileId,
    ...(input.query !== undefined ? { query: input.query } : {}),
    limit,
    status: input.status ?? "active",
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    includeSensitive: input.includeSensitive,
    includePerson: input.includePerson,
  });
  const snapshots = memories.map((memory) =>
    memoryToSnapshot({
      memory,
      exportedAt,
      sourceUriPrefix,
    }),
  );
  return {
    schema: "gmos.memory_snapshot_export.v1",
    exportedAt,
    profileId,
    sourceUriPrefix,
    filters: {
      status: input.status ?? "active",
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      includeSensitive: input.includeSensitive === true,
      includePerson: input.includePerson === true,
      limit,
    },
    memoryCount: snapshots.length,
    memories: snapshots,
  };
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 500;
  return Math.max(1, Math.min(Math.trunc(value), 500));
}

function memoryToSnapshot(input: {
  memory: MemoryRecord;
  exportedAt: string;
  sourceUriPrefix: string;
}): HostMemorySnapshot {
  const { memory } = input;
  return {
    id: memory.id,
    content: memory.content,
    kind: memory.kind,
    scope: memory.scope,
    sensitivity: memory.sensitivity,
    confidence: memory.confidence,
    sourceUri: `${input.sourceUriPrefix}/${encodeURIComponent(memory.id)}`,
    metadata: {
      ...memory.metadata,
      gmosSnapshotExport: {
        schema: "gmos.memory_snapshot_export.v1",
        exportedAt: input.exportedAt,
        originalMemoryId: memory.id,
        originalStatus: memory.status,
        originalSourceEventId: memory.sourceEventId ?? null,
      },
    },
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function normalizeFilters(value: unknown): MemorySnapshotExport["filters"] {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const status = record.status;
  return {
    status: status === "active" || status === "archived" || status === "any" ? status : "active",
    ...(typeof record.kind === "string"
      ? { kind: record.kind as MemorySnapshotExport["filters"]["kind"] }
      : {}),
    ...(typeof record.scope === "string" ? { scope: record.scope } : {}),
    ...(typeof record.query === "string" ? { query: record.query } : {}),
    includeSensitive: record.includeSensitive === true,
    includePerson: record.includePerson === true,
    limit: typeof record.limit === "number" ? boundedLimit(record.limit) : 500,
  };
}

function normalizeSnapshot(value: unknown): HostMemorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gmOS memory snapshot entry must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) {
    throw new Error("gmOS memory snapshot entry requires id");
  }
  if (typeof record.content !== "string" || !record.content.trim()) {
    throw new Error(`gmOS memory snapshot ${record.id} requires non-empty content`);
  }
  return {
    id: record.id,
    content: record.content,
    ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
    ...(typeof record.scope === "string" ? { scope: record.scope } : {}),
    ...(typeof record.sensitivity === "string" ? { sensitivity: record.sensitivity } : {}),
    ...(typeof record.confidence === "number" ? { confidence: record.confidence } : {}),
    ...(typeof record.sourceUri === "string" || record.sourceUri === null
      ? { sourceUri: record.sourceUri }
      : {}),
    ...(record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
    ...(typeof record.createdAt === "string" || record.createdAt === null
      ? { createdAt: record.createdAt }
      : {}),
    ...(typeof record.updatedAt === "string" || record.updatedAt === null
      ? { updatedAt: record.updatedAt }
      : {}),
  };
}
