import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  EvidenceEvent,
  FailureEventRecord,
  MemoryKind,
  MemoryRecord,
  MemoryStatus,
  Sensitivity,
  WorldBeliefRecord,
} from "../../kernel/types.js";
import { readGmosPackageInfo, type GmosPackageInfo } from "../../kernel/package-info.js";

export type SqliteProfileBackupMode = "safe" | "full";
export type SqliteProfileBackupConflictPolicy = "skip" | "replace" | "fail";

export interface SqliteTaskTrajectoryRecord {
  id: string;
  profileId: string;
  taskId?: string | null | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | null | undefined;
  createdAt: string;
}

export interface ExportSqliteProfileBackupInput {
  profileId: string;
  mode?: SqliteProfileBackupMode | undefined;
  includeArchived?: boolean | undefined;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
  includeEvidence?: boolean | undefined;
  includeWorldBeliefs?: boolean | undefined;
  includeFailures?: boolean | undefined;
  includeTaskTrajectories?: boolean | undefined;
}

export interface SqliteProfileBackupDocument {
  schema: "gmos.profile_backup.v1";
  exportedAt: string;
  package: GmosPackageInfo;
  profileId: string;
  mode: SqliteProfileBackupMode;
  options: {
    includeArchived: boolean;
    includeSensitive: boolean;
    includePerson: boolean;
    includeEvidence: boolean;
    includeWorldBeliefs: boolean;
    includeFailures: boolean;
    includeTaskTrajectories: boolean;
  };
  counts: {
    memories: number;
    evidenceEvents: number;
    worldBeliefs: number;
    failureEvents: number;
    taskTrajectories: number;
  };
  memories: MemoryRecord[];
  evidenceEvents: EvidenceEvent[];
  worldBeliefs: WorldBeliefRecord[];
  failureEvents: FailureEventRecord[];
  taskTrajectories: SqliteTaskTrajectoryRecord[];
}

export interface RestoreSqliteProfileBackupInput {
  backup: SqliteProfileBackupDocument;
  profileId?: string | undefined;
  onConflict?: SqliteProfileBackupConflictPolicy | undefined;
}

export interface SqliteProfileBackupRestoreResult {
  schema: "gmos.profile_backup_restore_result.v1";
  restoredAt: string;
  sourceProfileId: string;
  targetProfileId: string;
  onConflict: SqliteProfileBackupConflictPolicy;
  inserted: SqliteProfileBackupDocument["counts"];
  skipped: SqliteProfileBackupDocument["counts"];
}

interface BackupOptions {
  mode: SqliteProfileBackupMode;
  includeArchived: boolean;
  includeSensitive: boolean;
  includePerson: boolean;
  includeEvidence: boolean;
  includeWorldBeliefs: boolean;
  includeFailures: boolean;
  includeTaskTrajectories: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
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

function requireNonEmptyProfile(profileId: string): string {
  const normalized = profileId.trim();
  if (!normalized) throw new Error("gmOS profile backup requires a non-empty profileId");
  return normalized;
}

function backupOptions(input: ExportSqliteProfileBackupInput): BackupOptions {
  const mode = input.mode ?? "safe";
  if (mode !== "safe" && mode !== "full") {
    throw new Error("gmOS profile backup mode must be safe or full");
  }
  return {
    mode,
    includeArchived: input.includeArchived ?? mode === "full",
    includeSensitive: input.includeSensitive ?? mode === "full",
    includePerson: input.includePerson ?? mode === "full",
    includeEvidence: input.includeEvidence ?? true,
    includeWorldBeliefs: input.includeWorldBeliefs ?? mode === "full",
    includeFailures: input.includeFailures ?? mode === "full",
    includeTaskTrajectories: input.includeTaskTrajectories ?? mode === "full",
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

function normalizeMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    kind: String(row.kind) as MemoryKind,
    scope: String(row.scope),
    content: String(row.content),
    sensitivity: String(row.sensitivity) as Sensitivity,
    status: String(row.status) as MemoryStatus,
    confidence: Number(row.confidence),
    sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeWorldBelief(row: Record<string, unknown>): WorldBeliefRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    subject: String(row.subject),
    predicate: String(row.predicate),
    object: String(row.object),
    confidence: Number(row.confidence),
    status: String(row.status) as WorldBeliefRecord["status"],
    sourceMemoryId: row.source_memory_id == null ? null : String(row.source_memory_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeFailure(row: Record<string, unknown>): FailureEventRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    failureKind: String(row.failure_kind) as FailureEventRecord["failureKind"],
    content: String(row.content),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
  };
}

function normalizeTaskTrajectory(row: Record<string, unknown>): SqliteTaskTrajectoryRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    objective: String(row.objective),
    status: String(row.status) as SqliteTaskTrajectoryRecord["status"],
    summary: row.summary == null ? null : String(row.summary),
    createdAt: String(row.created_at),
  };
}

function stableRestoreHash(parts: string[]): string {
  const hash = createHash("sha256");
  hash.update("gmos-profile-restore-v1");
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex").slice(0, 32);
}

function stableRestoreId(input: {
  fallbackPrefix: string;
  originalId: string;
  sourceProfileId: string;
  targetProfileId: string;
}): string {
  if (input.sourceProfileId === input.targetProfileId) return input.originalId;
  const separator = input.originalId.indexOf("_");
  const sourcePrefix =
    separator > 0 ? input.originalId.slice(0, separator) : input.fallbackPrefix;
  const prefix = /^[a-z][a-z0-9]*$/u.test(sourcePrefix) ? sourcePrefix : input.fallbackPrefix;
  return `${prefix}_${stableRestoreHash([
    input.sourceProfileId,
    input.targetProfileId,
    input.originalId,
  ])}`;
}

function stableRestoreEventKey(input: {
  eventKey: string;
  sourceProfileId: string;
  targetProfileId: string;
}): string {
  if (input.sourceProfileId === input.targetProfileId) return input.eventKey;
  return `gmos.restore:${stableRestoreHash([
    input.sourceProfileId,
    input.targetProfileId,
    input.eventKey,
  ])}`;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function rowsByIds(
  db: Database.Database,
  table: string,
  ids: string[],
): Record<string, unknown>[] {
  if (ids.length === 0) return [];
  return db
    .prepare(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as Record<string, unknown>[];
}

function memoryRowsForBackup(
  db: Database.Database,
  profileId: string,
  options: BackupOptions,
): MemoryRecord[] {
  const clauses = ["profile_id = ?"];
  const params: unknown[] = [profileId];
  if (!options.includeArchived) clauses.push("status = 'active'");
  if (!options.includeSensitive) clauses.push("sensitivity = 'normal'");
  if (!options.includePerson) clauses.push("kind != 'person'");
  return (
    db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(...params) as Record<string, unknown>[]
  ).map(normalizeMemory);
}

function evidenceRowsForBackup(
  db: Database.Database,
  profileId: string,
  memories: MemoryRecord[],
  options: BackupOptions,
): EvidenceEvent[] {
  if (!options.includeEvidence) return [];
  if (options.mode === "full") {
    return (
      db
        .prepare(
          `SELECT * FROM gmos_evidence_events
           WHERE profile_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(profileId) as Record<string, unknown>[]
    ).map(normalizeEvidence);
  }
  const sourceEventIds = [
    ...new Set(memories.map((memory) => memory.sourceEventId).filter((id): id is string => !!id)),
  ];
  return rowsByIds(db, "gmos_evidence_events", sourceEventIds)
    .map(normalizeEvidence)
    .filter((event) => event.profileId === profileId && event.sensitivity === "normal")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function worldBeliefRowsForBackup(
  db: Database.Database,
  profileId: string,
  memories: MemoryRecord[],
  options: BackupOptions,
): WorldBeliefRecord[] {
  if (!options.includeWorldBeliefs) return [];
  const memoryIds = new Set(memories.map((memory) => memory.id));
  return (
    db
      .prepare(
        `SELECT * FROM gmos_world_beliefs
         WHERE profile_id = ?
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(profileId) as Record<string, unknown>[]
  )
    .map(normalizeWorldBelief)
    .filter(
      (belief) =>
        options.mode === "full" ||
        belief.sourceMemoryId == null ||
        memoryIds.has(belief.sourceMemoryId),
    );
}

function failureRowsForBackup(
  db: Database.Database,
  profileId: string,
  options: BackupOptions,
): FailureEventRecord[] {
  if (!options.includeFailures || !tableExists(db, "gmos_failure_events")) return [];
  return (
    db
      .prepare(
        `SELECT * FROM gmos_failure_events
         WHERE profile_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(profileId) as Record<string, unknown>[]
  ).map(normalizeFailure);
}

function taskRowsForBackup(
  db: Database.Database,
  profileId: string,
  options: BackupOptions,
): SqliteTaskTrajectoryRecord[] {
  if (!options.includeTaskTrajectories || !tableExists(db, "gmos_task_trajectories")) return [];
  return (
    db
      .prepare(
        `SELECT * FROM gmos_task_trajectories
         WHERE profile_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(profileId) as Record<string, unknown>[]
  ).map(normalizeTaskTrajectory);
}

export function exportSqliteProfileBackup(
  db: Database.Database,
  input: ExportSqliteProfileBackupInput,
): SqliteProfileBackupDocument {
  const profileId = requireNonEmptyProfile(input.profileId);
  const options = backupOptions(input);
  const memories = memoryRowsForBackup(db, profileId, options);
  const evidenceEvents = evidenceRowsForBackup(db, profileId, memories, options);
  const worldBeliefs = worldBeliefRowsForBackup(db, profileId, memories, options);
  const failureEvents = failureRowsForBackup(db, profileId, options);
  const taskTrajectories = taskRowsForBackup(db, profileId, options);
  return {
    schema: "gmos.profile_backup.v1",
    exportedAt: nowIso(),
    package: readGmosPackageInfo(),
    profileId,
    mode: options.mode,
    options: {
      includeArchived: options.includeArchived,
      includeSensitive: options.includeSensitive,
      includePerson: options.includePerson,
      includeEvidence: options.includeEvidence,
      includeWorldBeliefs: options.includeWorldBeliefs,
      includeFailures: options.includeFailures,
      includeTaskTrajectories: options.includeTaskTrajectories,
    },
    counts: {
      memories: memories.length,
      evidenceEvents: evidenceEvents.length,
      worldBeliefs: worldBeliefs.length,
      failureEvents: failureEvents.length,
      taskTrajectories: taskTrajectories.length,
    },
    memories,
    evidenceEvents,
    worldBeliefs,
    failureEvents,
    taskTrajectories,
  };
}

function countBucket(): SqliteProfileBackupDocument["counts"] {
  return {
    memories: 0,
    evidenceEvents: 0,
    worldBeliefs: 0,
    failureEvents: 0,
    taskTrajectories: 0,
  };
}

function assertBackupDocument(value: unknown): asserts value is SqliteProfileBackupDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gmOS profile backup must be an object");
  }
  const backup = value as Partial<SqliteProfileBackupDocument>;
  if (backup.schema !== "gmos.profile_backup.v1") {
    throw new Error("gmOS profile backup schema must be gmos.profile_backup.v1");
  }
  if (typeof backup.profileId !== "string" || !backup.profileId.trim()) {
    throw new Error("gmOS profile backup requires profileId");
  }
  for (const key of [
    "memories",
    "evidenceEvents",
    "worldBeliefs",
    "failureEvents",
    "taskTrajectories",
  ] as const) {
    if (!Array.isArray(backup[key])) {
      throw new Error(`gmOS profile backup requires array ${key}`);
    }
  }
}

export function parseSqliteProfileBackup(value: unknown): SqliteProfileBackupDocument {
  assertBackupDocument(value);
  return value;
}

function insertVerb(
  onConflict: SqliteProfileBackupConflictPolicy,
): "INSERT" | "INSERT OR IGNORE" | "INSERT OR REPLACE" {
  if (onConflict === "replace") return "INSERT OR REPLACE";
  if (onConflict === "skip") return "INSERT OR IGNORE";
  return "INSERT";
}

function assertConflictPolicy(value: SqliteProfileBackupConflictPolicy): void {
  if (value !== "skip" && value !== "replace" && value !== "fail") {
    throw new Error("gmOS profile backup restore conflict policy must be skip, replace, or fail");
  }
}

function assertNoConflicts(
  db: Database.Database,
  table: string,
  rows: Array<{ id: string }>,
): void {
  const statement = db.prepare(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`);
  for (const row of rows) {
    if (statement.get(row.id)) {
      throw new Error(`gmOS profile backup restore conflict in ${table}: ${row.id}`);
    }
  }
}

function assertNoEvidenceConflicts(
  db: Database.Database,
  rows: Array<{ id: string; eventKey: string }>,
): void {
  const statement = db.prepare(
    "SELECT id FROM gmos_evidence_events WHERE id = ? OR event_key = ? LIMIT 1",
  );
  for (const row of rows) {
    if (statement.get(row.id, row.eventKey)) {
      throw new Error(`gmOS profile backup restore conflict in gmos_evidence_events: ${row.id}`);
    }
  }
}

function syncRestoredMemoryFts(db: Database.Database, memoryId: string): void {
  if (!tableExists(db, "gmos_memories_fts")) return;
  db.prepare("DELETE FROM gmos_memories_fts WHERE id = ?").run(memoryId);
  const row = db
    .prepare(
      `SELECT id, profile_id, kind, scope, status, content
       FROM gmos_memories
       WHERE id = ?`,
    )
    .get(memoryId) as
    | {
        id: string;
        profile_id: string;
        kind: string;
        scope: string;
        status: string;
        content: string;
      }
    | undefined;
  if (!row) return;
  db.prepare(
    `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.profile_id, row.kind, row.scope, row.status, row.content);
}

function applyChangeCount(
  result: Database.RunResult,
  inserted: SqliteProfileBackupDocument["counts"],
  skipped: SqliteProfileBackupDocument["counts"],
  key: keyof SqliteProfileBackupDocument["counts"],
): void {
  if (result.changes > 0) inserted[key] += 1;
  else skipped[key] += 1;
}

export function restoreSqliteProfileBackup(
  db: Database.Database,
  input: RestoreSqliteProfileBackupInput,
): SqliteProfileBackupRestoreResult {
  const backup = parseSqliteProfileBackup(input.backup);
  const targetProfileId = requireNonEmptyProfile(input.profileId ?? backup.profileId);
  const onConflict = input.onConflict ?? "skip";
  assertConflictPolicy(onConflict);
  const inserted = countBucket();
  const skipped = countBucket();
  const verb = insertVerb(onConflict);
  const evidenceIdMap = new Map(
    backup.evidenceEvents.map((event) => [
      event.id,
      stableRestoreId({
        fallbackPrefix: "evidence",
        originalId: event.id,
        sourceProfileId: backup.profileId,
        targetProfileId,
      }),
    ]),
  );
  const memoryIdMap = new Map(
    backup.memories.map((memory) => [
      memory.id,
      stableRestoreId({
        fallbackPrefix: "memory",
        originalId: memory.id,
        sourceProfileId: backup.profileId,
        targetProfileId,
      }),
    ]),
  );
  const evidenceEvents = backup.evidenceEvents.map((event) => ({
    ...event,
    id: evidenceIdMap.get(event.id) ?? event.id,
    eventKey: stableRestoreEventKey({
      eventKey: event.eventKey,
      sourceProfileId: backup.profileId,
      targetProfileId,
    }),
    profileId: targetProfileId,
  }));
  const memories = backup.memories.map((memory) => ({
    ...memory,
    id: memoryIdMap.get(memory.id) ?? memory.id,
    profileId: targetProfileId,
    sourceEventId: memory.sourceEventId ? (evidenceIdMap.get(memory.sourceEventId) ?? null) : null,
  }));
  const worldBeliefs = backup.worldBeliefs.map((belief) => ({
    ...belief,
    id: stableRestoreId({
      fallbackPrefix: "belief",
      originalId: belief.id,
      sourceProfileId: backup.profileId,
      targetProfileId,
    }),
    profileId: targetProfileId,
    sourceMemoryId: belief.sourceMemoryId ? (memoryIdMap.get(belief.sourceMemoryId) ?? null) : null,
  }));
  const failureEvents = backup.failureEvents.map((failure) => ({
    ...failure,
    id: stableRestoreId({
      fallbackPrefix: "failure",
      originalId: failure.id,
      sourceProfileId: backup.profileId,
      targetProfileId,
    }),
    profileId: targetProfileId,
  }));
  const taskTrajectories = backup.taskTrajectories.map((trajectory) => ({
    ...trajectory,
    id: stableRestoreId({
      fallbackPrefix: "trajectory",
      originalId: trajectory.id,
      sourceProfileId: backup.profileId,
      targetProfileId,
    }),
    profileId: targetProfileId,
  }));

  if (onConflict === "fail") {
    assertNoEvidenceConflicts(db, evidenceEvents);
    assertNoConflicts(db, "gmos_memories", memories);
    assertNoConflicts(db, "gmos_world_beliefs", worldBeliefs);
    assertNoConflicts(db, "gmos_failure_events", failureEvents);
    assertNoConflicts(db, "gmos_task_trajectories", taskTrajectories);
  }

  const tx = db.transaction(() => {
    const evidenceStmt = db.prepare(
      `${verb} INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of evidenceEvents) {
      applyChangeCount(
        evidenceStmt.run(
          event.id,
          event.eventKey,
          event.profileId,
          event.sourceType,
          event.sourceUri ?? null,
          event.content,
          event.sensitivity,
          event.eligibleForLongTermMemory ? 1 : 0,
          JSON.stringify(event.payload ?? {}),
          event.createdAt,
        ),
        inserted,
        skipped,
        "evidenceEvents",
      );
    }

    const memoryStmt = db.prepare(
      `${verb} INTO gmos_memories (
        id, profile_id, kind, scope, content, sensitivity, status, confidence,
        source_event_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const memory of memories) {
      const result = memoryStmt.run(
        memory.id,
        memory.profileId,
        memory.kind,
        memory.scope,
        memory.content,
        memory.sensitivity,
        memory.status,
        memory.confidence,
        memory.sourceEventId ?? null,
        JSON.stringify(memory.metadata ?? {}),
        memory.createdAt,
        memory.updatedAt,
      );
      applyChangeCount(result, inserted, skipped, "memories");
      if (result.changes > 0) syncRestoredMemoryFts(db, memory.id);
    }

    const beliefStmt = db.prepare(
      `${verb} INTO gmos_world_beliefs (
        id, profile_id, subject, predicate, object, confidence, status,
        source_memory_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const belief of worldBeliefs) {
      applyChangeCount(
        beliefStmt.run(
          belief.id,
          belief.profileId,
          belief.subject,
          belief.predicate,
          belief.object,
          belief.confidence,
          belief.status,
          belief.sourceMemoryId ?? null,
          belief.createdAt,
          belief.updatedAt,
        ),
        inserted,
        skipped,
        "worldBeliefs",
      );
    }

    const failureStmt = db.prepare(
      `${verb} INTO gmos_failure_events (
        id, profile_id, failure_kind, content, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const failure of failureEvents) {
      applyChangeCount(
        failureStmt.run(
          failure.id,
          failure.profileId,
          failure.failureKind,
          failure.content,
          JSON.stringify(failure.metadata ?? {}),
          failure.createdAt,
        ),
        inserted,
        skipped,
        "failureEvents",
      );
    }

    const trajectoryStmt = db.prepare(
      `${verb} INTO gmos_task_trajectories (
        id, profile_id, task_id, objective, status, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const trajectory of taskTrajectories) {
      applyChangeCount(
        trajectoryStmt.run(
          trajectory.id,
          trajectory.profileId,
          trajectory.taskId ?? null,
          trajectory.objective,
          trajectory.status,
          trajectory.summary ?? null,
          trajectory.createdAt,
        ),
        inserted,
        skipped,
        "taskTrajectories",
      );
    }
  });
  tx();

  return {
    schema: "gmos.profile_backup_restore_result.v1",
    restoredAt: nowIso(),
    sourceProfileId: backup.profileId,
    targetProfileId,
    onConflict,
    inserted,
    skipped,
  };
}
