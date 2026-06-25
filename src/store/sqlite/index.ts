import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import type {
  ActionPolicy,
  AddMemoryInput,
  AddWorldBeliefInput,
  ArchiveStaleHostImportsInput,
  EvidenceEvent,
  ForgetInput,
  ForgetResult,
  MemoryKind,
  MemoryRecord,
  MemorySearchInput,
  MemoryStore,
  RecordEvidenceInput,
  RecordFailureInput,
  Sensitivity,
  TaskTrajectoryInput,
  WorldBeliefRecord,
} from "../../kernel/types.js";
import { shouldHideFromOrdinaryContext } from "../../kernel/safety.js";
import { ensureSqliteSchema, sqliteSchemaVersion } from "./schema.js";

export interface SqliteMemoryStoreOptions {
  path: string;
  handle?: Database.Database;
}

export interface SqliteMemoryStore extends MemoryStore {
  schemaVersion(): number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    kind: String(row.kind) as MemoryKind,
    scope: String(row.scope),
    content: String(row.content),
    sensitivity: String(row.sensitivity) as Sensitivity,
    status: String(row.status) as MemoryRecord["status"],
    confidence: Number(row.confidence),
    sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeEvidence(row: Record<string, unknown>): EvidenceEvent {
  return {
    id: String(row.id),
    eventKey: String(row.event_key),
    profileId: String(row.profile_id),
    sourceType: String(row.source_type),
    sourceUri: row.source_uri == null ? null : String(row.source_uri),
    content: String(row.content),
    sensitivity: String(row.sensitivity) as Sensitivity,
    eligibleForLongTermMemory: Number(row.eligible_for_long_term_memory) === 1,
    payload: parseJsonObject(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function scoreMemory(memory: MemoryRecord, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
  if (terms.length === 0) return memory.confidence;
  const lower = memory.content.toLowerCase();
  const hits = terms.filter((term) => lower.includes(term)).length;
  return hits + memory.confidence;
}

export function createSqliteMemoryStore(options: SqliteMemoryStoreOptions): SqliteMemoryStore {
  const db = options.handle ?? new Database(options.path);
  let initialized = false;

  function initialize(): void {
    if (initialized) return;
    ensureSqliteSchema(db);
    initialized = true;
  }

  function recordEvidence(input: RecordEvidenceInput): EvidenceEvent {
    initialize();
    const createdAt = input.createdAt ?? nowIso();
    const eventId = id("evidence");
    db.prepare(
      `INSERT INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        content = excluded.content,
        sensitivity = excluded.sensitivity,
        eligible_for_long_term_memory = excluded.eligible_for_long_term_memory,
        payload_json = excluded.payload_json`,
    ).run(
      eventId,
      input.eventKey,
      input.profileId,
      input.sourceType,
      input.sourceUri ?? null,
      input.content,
      input.sensitivity,
      input.eligibleForLongTermMemory ? 1 : 0,
      JSON.stringify(input.payload ?? {}),
      createdAt,
    );
    const row = db
      .prepare("SELECT * FROM gmos_evidence_events WHERE event_key = ?")
      .get(input.eventKey) as Record<string, unknown>;
    return normalizeEvidence(row);
  }

  function addMemory(input: AddMemoryInput): MemoryRecord {
    initialize();
    const createdAt = input.createdAt ?? nowIso();
    const memoryId = id("memory");
    db.prepare(
      `INSERT INTO gmos_memories (
        id, profile_id, kind, scope, content, sensitivity, status, confidence,
        source_event_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    ).run(
      memoryId,
      input.profileId,
      input.kind,
      input.scope ?? "global",
      input.content,
      input.sensitivity ?? "normal",
      input.confidence ?? 0.5,
      input.sourceEventId ?? null,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
      createdAt,
    );
    return normalizeMemory(
      db
        .prepare("SELECT * FROM gmos_memories WHERE id = ?")
        .get(memoryId) as Record<string, unknown>,
    );
  }

  function addWorldBelief(input: AddWorldBeliefInput): WorldBeliefRecord {
    initialize();
    const createdAt = nowIso();
    const beliefId = id("belief");
    db.prepare(
      `INSERT INTO gmos_world_beliefs (
        id, profile_id, subject, predicate, object, confidence, status,
        source_memory_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      beliefId,
      input.profileId,
      input.subject,
      input.predicate,
      input.object,
      input.confidence ?? 0.5,
      input.sourceMemoryId ?? null,
      createdAt,
      createdAt,
    );
    return {
      id: beliefId,
      profileId: input.profileId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      confidence: input.confidence ?? 0.5,
      status: "active",
      sourceMemoryId: input.sourceMemoryId ?? null,
      createdAt,
      updatedAt: createdAt,
    };
  }

  function searchMemories(input: MemorySearchInput): MemoryRecord[] {
    initialize();
    const rows = db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT 500`,
      )
      .all(input.profileId) as Record<string, unknown>[];
    const query = input.query?.trim() ?? "";
    return rows
      .map(normalizeMemory)
      .filter((memory) => input.includePerson || memory.kind !== "person")
      .filter(
        (memory) =>
          input.purpose !== "context" ||
          !shouldHideFromOrdinaryContext({
            sensitivity: memory.sensitivity,
            includeSensitive: input.includeSensitive,
          }),
      )
      .map((memory) => ({ memory, score: query ? scoreMemory(memory, query) : memory.confidence }))
      .filter((item) => !query || item.score > item.memory.confidence)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 12)
      .map((item) => item.memory);
  }

  function getMemoryById(
    profileId: string,
    memoryId: string,
    options: {
      includeSensitive?: boolean | undefined;
      includePerson?: boolean | undefined;
    } = {},
  ): MemoryRecord | null {
    initialize();
    const row = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ?")
      .get(profileId, memoryId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const memory = normalizeMemory(row);
    if (!options.includePerson && memory.kind === "person") return null;
    if (
      shouldHideFromOrdinaryContext({
        sensitivity: memory.sensitivity,
        includeSensitive: options.includeSensitive,
      })
    ) {
      return null;
    }
    return memory;
  }

  function findActiveMemoryByMetadata(
    profileId: string,
    key: string,
    value: string,
  ): MemoryRecord | null {
    initialize();
    const row = db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND status = 'active'
           AND json_extract(metadata_json, ?) = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(profileId, `$.${key}`, value) as Record<string, unknown> | undefined;
    return row ? normalizeMemory(row) : null;
  }

  function archiveStaleHostImports(input: ArchiveStaleHostImportsInput): string[] {
    initialize();
    const archivedAt = input.archivedAt ?? nowIso();
    const activeKeys = [...new Set(input.activeImportKeys)];
    const activeKeyClause =
      activeKeys.length > 0
        ? `AND json_extract(metadata_json, '$.hostImportKey') NOT IN (${activeKeys.map(() => "?").join(", ")})`
        : "";
    const candidates = db
      .prepare(
        `SELECT id FROM gmos_memories
         WHERE profile_id = ?
           AND status = 'active'
           AND json_extract(metadata_json, '$.hostSnapshotImport') = 1
           AND json_extract(metadata_json, '$.hostImportSourceType') = ?
           ${activeKeyClause}`,
      )
      .all(input.profileId, input.sourceType, ...activeKeys) as Array<{ id: string }>;
    const ids = candidates.map((row) => row.id);
    if (ids.length === 0) return [];
    const stmt = db.prepare(
      "UPDATE gmos_memories SET status = 'archived', updated_at = ? WHERE id = ?",
    );
    const tx = db.transaction((memoryIds: string[]) => {
      for (const memoryId of memoryIds) stmt.run(archivedAt, memoryId);
    });
    tx(ids);
    return ids;
  }

  function listActionPolicies(
    profileId: string,
    options: { includeSensitive?: boolean | undefined } = {},
  ): ActionPolicy[] {
    initialize();
    const rows = db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND status = 'active' AND kind IN ('boundary', 'preference', 'procedure')
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all(profileId) as Record<string, unknown>[];
    return rows
      .map(normalizeMemory)
      .filter(
        (memory) =>
          !shouldHideFromOrdinaryContext({
            sensitivity: memory.sensitivity,
            includeSensitive: options.includeSensitive,
          }),
      )
      .map((memory) => {
        const kind =
          memory.kind === "boundary"
            ? "do_not_push"
            : memory.kind === "procedure"
              ? "procedure"
              : "prefer";
        return {
          id: `policy_${memory.id}`,
          kind,
          text: memory.content,
          priority: kind === "do_not_push" ? 100 : 50,
          sourceMemoryId: memory.id,
        };
      });
  }

  function listEvidenceForMemory(memoryId: string): EvidenceEvent[] {
    initialize();
    const row = db
      .prepare("SELECT source_event_id FROM gmos_memories WHERE id = ?")
      .get(memoryId) as { source_event_id?: string | null } | undefined;
    if (!row?.source_event_id) return [];
    return (
      db
        .prepare("SELECT * FROM gmos_evidence_events WHERE id = ?")
        .all(row.source_event_id) as Record<string, unknown>[]
    ).map(normalizeEvidence);
  }

  function forget(input: ForgetInput & { profileId: string }): ForgetResult {
    initialize();
    const matches = searchMemories({
      profileId: input.profileId,
      query: input.query,
      purpose: "delete",
      includeSensitive: true,
      includePerson: true,
      limit: 100,
    });
    const archivedMemoryIds = matches.map((memory) => memory.id);
    if (archivedMemoryIds.length > 0) {
      const stmt = db.prepare(
        "UPDATE gmos_memories SET status = 'archived', updated_at = ? WHERE id = ?",
      );
      const archivedAt = nowIso();
      const tx = db.transaction((ids: string[]) => {
        for (const memoryId of ids) stmt.run(archivedAt, memoryId);
      });
      tx(archivedMemoryIds);
    }
    return { archivedMemoryIds };
  }

  function recordFailure(input: RecordFailureInput): void {
    initialize();
    db.prepare(
      `INSERT INTO gmos_failure_events (
        id, profile_id, failure_kind, content, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id("failure"),
      input.profileId,
      input.failureKind,
      input.content,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt ?? nowIso(),
    );
  }

  function recordTaskTrajectory(input: TaskTrajectoryInput): void {
    initialize();
    db.prepare(
      `INSERT INTO gmos_task_trajectories (
        id, profile_id, task_id, objective, status, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id("trajectory"),
      input.profileId,
      input.taskId ?? null,
      input.objective,
      input.status,
      input.summary ?? null,
      input.createdAt ?? nowIso(),
    );
  }

  function rowCounts(): Record<string, number> {
    initialize();
    const tables = [
      "gmos_evidence_events",
      "gmos_memories",
      "gmos_world_beliefs",
      "gmos_failure_events",
      "gmos_task_trajectories",
    ];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count),
      ]),
    );
  }

  function schemaVersion(): number {
    initialize();
    return sqliteSchemaVersion(db);
  }

  return {
    initialize,
    close() {
      if (!options.handle) db.close();
    },
    recordEvidence,
    addMemory,
    addWorldBelief,
    searchMemories,
    getMemoryById,
    findActiveMemoryByMetadata,
    archiveStaleHostImports,
    listActionPolicies,
    listEvidenceForMemory,
    forget,
    recordFailure,
    recordTaskTrajectory,
    rowCounts,
    schemaVersion,
  };
}
