import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import type {
  ActionPolicy,
  AddMemoryInput,
  AddWorldBeliefInput,
  ArchiveMemoriesInput,
  ArchiveMemoryInput,
  ArchiveStaleHostImportsInput,
  EvidenceEvent,
  FailureEventRecord,
  ForgetInput,
  ForgetResult,
  ListFailuresInput,
  MemoryAssociationRecord,
  MemoryAssociationSearchInput,
  MemoryListInput,
  MemoryKind,
  MemoryRecord,
  MemorySearchInput,
  MemoryStore,
  RecordEvidenceInput,
  RecordFailureInput,
  ReadAuditSnapshot,
  RepairSearchIndexResult,
  RebuildAssociationsInput,
  RebuildAssociationsResult,
  RestoreArchivedMemoryInput,
  SearchIndexStatus,
  Sensitivity,
  TaskTrajectoryInput,
  UpdateMemoryInput,
  WorldBeliefRecord,
} from "../../kernel/types.js";
import {
  associationCuesForBelief,
  associationCuesForMemory,
  associationCuesForTaskTrajectory,
  associationTagsForBelief,
  associationTagsForMemory,
  associationTagsForTaskTrajectory,
  memoryTargetKind,
  type TaskTrajectoryAssociationSource,
} from "../../kernel/associations.js";
import {
  entityResolutionMetadata,
  resolveWorldEntitySubject,
} from "../../kernel/entities.js";
import {
  classifySensitivity,
  sanitizePublicPayloadRecord,
  shouldHideFromOrdinaryContext,
} from "../../kernel/safety.js";
import {
  cosineSimilarity,
  LOCAL_TEXT_VECTOR_DIMENSIONS,
  localTextCandidateFeatures,
  localTextVector,
  vectorContentHash,
} from "../../kernel/local-vector.js";
import {
  exportSqliteProfileBackup,
  restoreSqliteProfileBackup,
  type ExportSqliteProfileBackupInput,
  type RestoreSqliteProfileBackupInput,
  type SqliteProfileBackupDocument,
  type SqliteProfileBackupRestoreResult,
} from "./backup.js";
import { ensureSqliteSchema, sqliteSchemaVersion } from "./schema.js";

export type {
  ExportSqliteProfileBackupInput,
  RestoreSqliteProfileBackupInput,
  SqliteProfileBackupConflictPolicy,
  SqliteProfileBackupDocument,
  SqliteProfileBackupMode,
  SqliteProfileBackupRestoreResult,
  SqliteTaskTrajectoryRecord,
} from "./backup.js";
export { parseSqliteProfileBackup } from "./backup.js";

export interface SqliteMemoryStoreOptions {
  path: string;
  handle?: Database.Database;
  readonly?: boolean | undefined;
  fileMustExist?: boolean | undefined;
}

export interface SqliteMemoryStore extends MemoryStore {
  listFailures(input: ListFailuresInput): FailureEventRecord[];
  schemaVersion(): number;
  searchIndexStatus(): SearchIndexStatus;
  repairSearchIndex(): RepairSearchIndexResult;
  searchAssociations(input: MemoryAssociationSearchInput): MemoryAssociationRecord[];
  rebuildAssociations(input?: RebuildAssociationsInput): RebuildAssociationsResult;
  readAuditSnapshot(): ReadAuditSnapshot;
  exportProfileBackup(input: ExportSqliteProfileBackupInput): SqliteProfileBackupDocument;
  restoreProfileBackup(input: RestoreSqliteProfileBackupInput): SqliteProfileBackupRestoreResult;
}

const READ_AUDIT_REVISION_TABLES = [
  "gmos_evidence_events",
  "gmos_memories",
  "gmos_world_beliefs",
  "gmos_failure_events",
  "gmos_task_trajectories",
  "gmos_associations",
  "gmos_memory_vectors",
  "gmos_memory_vector_terms",
] as const;

const READ_AUDIT_FTS_TABLES = [
  {
    name: "gmos_memories_fts",
    columns: ["id", "profile_id", "kind", "scope", "status", "content"],
  },
  {
    name: "gmos_associations_fts",
    columns: ["id", "profile_id", "status", "target_type", "cue", "tag", "target_summary"],
  },
] as const;

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

function metadataWithArchiveMarker(input: {
  metadata: Record<string, unknown>;
  archivedAt: string;
  reason?: string | undefined;
}): Record<string, unknown> {
  return {
    ...input.metadata,
    archive: {
      ...(typeof input.metadata.archive === "object" &&
      input.metadata.archive !== null &&
      !Array.isArray(input.metadata.archive)
        ? input.metadata.archive
        : {}),
      archivedAt: input.archivedAt,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

function metadataWithRestoreMarker(input: {
  metadata: Record<string, unknown>;
  restoredAt: string;
  reason?: string | undefined;
}): Record<string, unknown> {
  const { archive: _archive, ...metadata } = input.metadata;
  return {
    ...metadata,
    restore: {
      ...(typeof metadata.restore === "object" &&
      metadata.restore !== null &&
      !Array.isArray(metadata.restore)
        ? metadata.restore
        : {}),
      restoredAt: input.restoredAt,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

function metadataString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseInstant(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function memoryMetadataIsValidAt(metadata: Record<string, unknown>, asOfIso: string): boolean {
  const asOf = Date.parse(asOfIso);
  if (!Number.isFinite(asOf)) return true;
  const validFrom = parseInstant(metadataString(metadata, ["validFrom", "valid_from"]));
  if (validFrom !== null && validFrom > asOf) return false;
  const validTo = parseInstant(metadataString(metadata, ["validTo", "valid_to", "expiresAt"]));
  if (validTo !== null && validTo <= asOf) return false;
  return true;
}

const TEMPORAL_VALIDITY_METADATA_KEYS = [
  "validFrom",
  "valid_from",
  "validTo",
  "valid_to",
  "expiresAt",
] as const;

function hasTemporalValidityMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return TEMPORAL_VALIDITY_METADATA_KEYS.some(
    (key) => typeof metadata[key] === "string" && String(metadata[key]).trim().length > 0,
  );
}

function withoutTemporalValidityMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const next = { ...metadata };
  for (const key of TEMPORAL_VALIDITY_METADATA_KEYS) {
    delete next[key];
  }
  if (next.temporalValiditySource === "explicit_text") {
    delete next.temporalValiditySource;
  }
  return next;
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

function normalizeAssociation(row: Record<string, unknown>): MemoryAssociationRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    cue: String(row.cue),
    cueKind: String(row.cue_kind) as MemoryAssociationRecord["cueKind"],
    tag: String(row.tag),
    targetType: String(row.target_type) as MemoryAssociationRecord["targetType"],
    targetId: String(row.target_id),
    targetKind: String(row.target_kind),
    targetSummary: String(row.target_summary),
    sensitivity: String(row.sensitivity) as Sensitivity,
    status: String(row.status) as MemoryAssociationRecord["status"],
    confidence: Number(row.confidence),
    sourceMemoryId: row.source_memory_id == null ? null : String(row.source_memory_id),
    sourceBeliefId: row.source_belief_id == null ? null : String(row.source_belief_id),
    sourceTaskTrajectoryId:
      row.source_task_trajectory_id == null ? null : String(row.source_task_trajectory_id),
    sourceEvidenceId: row.source_evidence_id == null ? null : String(row.source_evidence_id),
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
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function beliefEntityResolutionMetadata(belief: WorldBeliefRecord): Record<string, unknown> {
  const value = belief.metadata.entityResolution;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function beliefSubjectAliases(belief: WorldBeliefRecord): string[] {
  return stringArrayFromUnknown(beliefEntityResolutionMetadata(belief).aliases);
}

function canonicalSubjectForBelief(belief: WorldBeliefRecord): string {
  const existing = beliefEntityResolutionMetadata(belief).canonicalSubject;
  return typeof existing === "string" && existing.trim()
    ? existing.trim()
    : resolveWorldEntitySubject({
        subject: belief.subject,
        predicate: belief.predicate,
        aliases: beliefSubjectAliases(belief),
      }).canonicalSubject;
}

function worldBeliefMetadata(input: {
  inputMetadata?: Record<string, unknown> | undefined;
  existingMetadata?: Record<string, unknown> | undefined;
  resolution: ReturnType<typeof resolveWorldEntitySubject>;
}): Record<string, unknown> {
  const existing = input.existingMetadata ?? {};
  const sanitizedInput = sanitizePublicPayloadRecord(input.inputMetadata ?? {});
  const previousEntity = existing.entityResolution;
  const previousAliases =
    previousEntity && typeof previousEntity === "object" && !Array.isArray(previousEntity)
      ? stringArrayFromUnknown((previousEntity as Record<string, unknown>).aliases)
      : [];
  const entityResolution = entityResolutionMetadata({
    ...input.resolution,
    aliases: uniqueStrings([...previousAliases, ...input.resolution.aliases]),
  });
  return {
    ...existing,
    ...sanitizedInput,
    entityResolution,
  };
}

function normalizeTaskTrajectory(row: Record<string, unknown>): TaskTrajectoryAssociationSource {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    objective: String(row.objective),
    status: String(row.status) as TaskTrajectoryAssociationSource["status"],
    summary: row.summary == null ? null : String(row.summary),
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

function scoreAssociation(association: MemoryAssociationRecord, query: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return association.confidence;
  const haystack = [
    association.cue,
    association.tag,
    association.targetKind,
    association.targetSummary,
  ].join(" ").toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits + association.confidence;
}

function limit(input: number | undefined, fallback: number, maximum: number): number {
  if (input === undefined) return fallback;
  return Math.max(1, Math.min(Math.trunc(input), maximum));
}

function visibleMemory(input: {
  memory: MemoryRecord;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}): boolean {
  if (!input.includePerson && input.memory.kind === "person") return false;
  return !shouldHideFromOrdinaryContext({
    sensitivity: input.memory.sensitivity,
    includeSensitive: input.includeSensitive,
  });
}

function visibleAssociation(input: {
  association: MemoryAssociationRecord;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}): boolean {
  if (!input.includePerson && input.association.targetKind === "person") return false;
  return !shouldHideFromOrdinaryContext({
    sensitivity: input.association.sensitivity,
    includeSensitive: input.includeSensitive,
  });
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function ftsQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function likePattern(term: string): string {
  return `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function createSqliteMemoryStore(options: SqliteMemoryStoreOptions): SqliteMemoryStore {
  const sqliteOptions: Database.Options = {};
  if (options.readonly !== undefined) sqliteOptions.readonly = options.readonly;
  if (options.fileMustExist !== undefined) sqliteOptions.fileMustExist = options.fileMustExist;
  const db =
    options.handle ??
    new Database(options.path, sqliteOptions);
  let initialized = false;
  let ftsAvailableCache: boolean | null = null;
  let vectorIndexAvailableCache: boolean | null = null;

  function initialize(): void {
    if (initialized) return;
    if (db.readonly) {
      ftsAvailableCache = tableExists("gmos_memories_fts");
      vectorIndexAvailableCache = tableExists("gmos_memory_vectors");
      initialized = true;
      return;
    }
    const previousSchemaVersion = sqliteSchemaVersion(db);
    ensureSqliteSchema(db);
    ftsAvailableCache = tableExists("gmos_memories_fts");
    vectorIndexAvailableCache = tableExists("gmos_memory_vectors");
    initialized = true;
    if (previousSchemaVersion < 3) {
      rebuildAssociations();
    }
    if (previousSchemaVersion < 5) {
      rebuildMemoryVectorIndex();
    }
  }

  function tableExists(table: string): boolean {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    return row?.name === table;
  }

  function ftsAvailable(): boolean {
    return ftsAvailableCache ?? tableExists("gmos_memories_fts");
  }

  function vectorIndexAvailable(): boolean {
    return vectorIndexAvailableCache ?? tableExists("gmos_memory_vectors");
  }

  function syncMemoryFts(memoryId: string): void {
    if (!ftsAvailable()) return;
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

  function syncMemoryVector(memoryId: string): void {
    if (!vectorIndexAvailable()) return;
    db.prepare("DELETE FROM gmos_memory_vectors WHERE id = ?").run(memoryId);
    db.prepare("DELETE FROM gmos_memory_vector_terms WHERE id = ?").run(memoryId);
    const row = db
      .prepare(
        `SELECT id, profile_id, status, content, updated_at
         FROM gmos_memories
         WHERE id = ?`,
      )
      .get(memoryId) as
      | {
          id: string;
          profile_id: string;
          status: string;
          content: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return;
    const vector = localTextVector(row.content);
    db.prepare(
      `INSERT INTO gmos_memory_vectors(
        id, profile_id, status, dimensions, vector_json, content_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.profile_id,
      row.status,
      vector.length,
      JSON.stringify(vector),
      vectorContentHash(row.content),
      row.updated_at,
    );
    const termStmt = db.prepare(
      `INSERT OR IGNORE INTO gmos_memory_vector_terms(
        id, profile_id, status, feature_key, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const feature of localTextCandidateFeatures(row.content)) {
      termStmt.run(row.id, row.profile_id, row.status, feature, row.updated_at);
    }
  }

  function rebuildMemoryVectorIndex(): void {
    if (!vectorIndexAvailable()) return;
    db.prepare("DELETE FROM gmos_memory_vectors").run();
    db.prepare("DELETE FROM gmos_memory_vector_terms").run();
    const rows = db
      .prepare("SELECT id FROM gmos_memories")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      syncMemoryVector(row.id);
    }
  }

  function associationsFtsAvailable(): boolean {
    return tableExists("gmos_associations_fts");
  }

  function syncAssociationFts(associationId: string): void {
    if (!associationsFtsAvailable()) return;
    db.prepare("DELETE FROM gmos_associations_fts WHERE id = ?").run(associationId);
    const row = db
      .prepare(
        `SELECT id, profile_id, status, target_type, cue, tag, target_summary
         FROM gmos_associations
         WHERE id = ?`,
      )
      .get(associationId) as
      | {
          id: string;
          profile_id: string;
          status: string;
          target_type: string;
          cue: string;
          tag: string;
          target_summary: string;
        }
      | undefined;
    if (!row) return;
    db.prepare(
      `INSERT INTO gmos_associations_fts(
        id, profile_id, status, target_type, cue, tag, target_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.profile_id,
      row.status,
      row.target_type,
      row.cue,
      row.tag,
      row.target_summary,
    );
  }

  function deleteAssociationsForMemory(memoryId: string): void {
    if (!tableExists("gmos_associations")) return;
    const ids = db
      .prepare("SELECT id FROM gmos_associations WHERE source_memory_id = ? OR target_id = ?")
      .all(memoryId, memoryId) as Array<{ id: string }>;
    if (ids.length === 0) return;
    if (associationsFtsAvailable()) {
      for (const row of ids) {
        db.prepare("DELETE FROM gmos_associations_fts WHERE id = ?").run(row.id);
      }
    }
    db.prepare("DELETE FROM gmos_associations WHERE source_memory_id = ? OR target_id = ?").run(
      memoryId,
      memoryId,
    );
  }

  function deleteAssociationsForBelief(beliefId: string): void {
    if (!tableExists("gmos_associations")) return;
    const ids = db
      .prepare("SELECT id FROM gmos_associations WHERE source_belief_id = ?")
      .all(beliefId) as Array<{ id: string }>;
    if (associationsFtsAvailable()) {
      for (const row of ids) {
        db.prepare("DELETE FROM gmos_associations_fts WHERE id = ?").run(row.id);
      }
    }
    db.prepare("DELETE FROM gmos_associations WHERE source_belief_id = ?").run(beliefId);
  }

  function upsertAssociation(input: {
    profileId: string;
    cue: string;
    cueKind: MemoryAssociationRecord["cueKind"];
    tag: string;
    targetType: MemoryAssociationRecord["targetType"];
    targetId: string;
    targetKind: string;
    targetSummary: string;
    sensitivity: Sensitivity;
    status: MemoryAssociationRecord["status"];
    confidence: number;
    sourceMemoryId?: string | null | undefined;
    sourceBeliefId?: string | null | undefined;
    sourceTaskTrajectoryId?: string | null | undefined;
    sourceEvidenceId?: string | null | undefined;
    createdAt?: string | undefined;
    updatedAt?: string | undefined;
  }): void {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const associationId = id("assoc");
    db.prepare(
      `INSERT INTO gmos_associations (
        id, profile_id, cue, cue_kind, tag, target_type, target_id, target_kind,
        target_summary, sensitivity, status, confidence, source_memory_id,
        source_belief_id, source_task_trajectory_id, source_evidence_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, cue, tag, target_type, target_id) DO UPDATE SET
        target_kind = excluded.target_kind,
        target_summary = excluded.target_summary,
        sensitivity = excluded.sensitivity,
        status = excluded.status,
        confidence = excluded.confidence,
        source_memory_id = excluded.source_memory_id,
        source_belief_id = excluded.source_belief_id,
        source_task_trajectory_id = excluded.source_task_trajectory_id,
        source_evidence_id = excluded.source_evidence_id,
        updated_at = excluded.updated_at`,
    ).run(
      associationId,
      input.profileId,
      input.cue,
      input.cueKind,
      input.tag,
      input.targetType,
      input.targetId,
      input.targetKind,
      input.targetSummary,
      input.sensitivity,
      input.status,
      input.confidence,
      input.sourceMemoryId ?? null,
      input.sourceBeliefId ?? null,
      input.sourceTaskTrajectoryId ?? null,
      input.sourceEvidenceId ?? null,
      createdAt,
      updatedAt,
    );
    const row = db
      .prepare(
        `SELECT id FROM gmos_associations
         WHERE profile_id = ? AND cue = ? AND tag = ? AND target_type = ? AND target_id = ?`,
      )
      .get(input.profileId, input.cue, input.tag, input.targetType, input.targetId) as
      | { id: string }
      | undefined;
    if (row) syncAssociationFts(row.id);
  }

  function projectMemoryAssociations(memory: MemoryRecord): void {
    deleteAssociationsForMemory(memory.id);
    if (memory.status !== "active") return;
    const contentSensitivity = classifySensitivity(memory.content);
    if (memory.sensitivity === "secret_like" || contentSensitivity === "secret_like") return;
    const sensitivity = memory.sensitivity === "sensitive" ? "sensitive" : contentSensitivity;
    for (const cue of associationCuesForMemory(memory)) {
      for (const tag of associationTagsForMemory(memory)) {
        upsertAssociation({
          profileId: memory.profileId,
          cue: cue.cue,
          cueKind: cue.cueKind,
          tag,
          targetType: "memory",
          targetId: memory.id,
          targetKind: memoryTargetKind(memory.kind),
          targetSummary: memory.content,
          sensitivity,
          status: memory.status,
          confidence: memory.confidence,
          sourceMemoryId: memory.id,
          sourceEvidenceId: memory.sourceEventId,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
        });
      }
    }
  }

  function rejectBeliefsForMemory(memoryId: string, updatedAt: string): void {
    if (!tableExists("gmos_world_beliefs")) return;
    const beliefRows = db
      .prepare(
        `SELECT id FROM gmos_world_beliefs
         WHERE source_memory_id = ? AND status = 'active'`,
      )
      .all(memoryId) as Array<{ id: string }>;
    for (const row of beliefRows) {
      deleteAssociationsForBelief(row.id);
    }
    db.prepare(
      `UPDATE gmos_world_beliefs
       SET status = 'rejected', updated_at = ?
       WHERE source_memory_id = ? AND status = 'active'`,
    ).run(updatedAt, memoryId);
  }

  function syncBeliefsForMemory(memory: MemoryRecord): void {
    if (!tableExists("gmos_world_beliefs")) return;
    const rows = db
      .prepare(
        `SELECT * FROM gmos_world_beliefs
         WHERE source_memory_id = ? AND status = 'active'`,
      )
      .all(memory.id) as Record<string, unknown>[];
    if (rows.length === 0) return;
    for (const row of rows) {
      db.prepare(
        `UPDATE gmos_world_beliefs
         SET object = ?, confidence = ?, updated_at = ?
         WHERE id = ?`,
      ).run(memory.content, memory.confidence, memory.updatedAt, String(row.id));
      deleteAssociationsForBelief(String(row.id));
      const updatedBelief = db
        .prepare("SELECT * FROM gmos_world_beliefs WHERE id = ?")
        .get(String(row.id)) as Record<string, unknown>;
      projectBeliefAssociations(normalizeWorldBelief(updatedBelief));
    }
  }

  function projectBeliefAssociations(belief: WorldBeliefRecord): void {
    if (belief.status !== "active") return;
    let sourceMemory:
      | { status?: string; kind?: string; sensitivity?: string; content?: string }
      | undefined;
    if (belief.sourceMemoryId) {
      sourceMemory = db
        .prepare("SELECT status, kind, sensitivity, content FROM gmos_memories WHERE id = ? AND profile_id = ?")
        .get(belief.sourceMemoryId, belief.profileId) as
        | { status?: string; kind?: string; sensitivity?: string; content?: string }
        | undefined;
      if (sourceMemory?.status !== "active") return;
      const sourceContentSensitivity = classifySensitivity(sourceMemory.content ?? "");
      if (
        sourceMemory.kind === "person" ||
        sourceMemory.sensitivity === "secret_like" ||
        sourceContentSensitivity === "secret_like"
      ) {
        return;
      }
    }
    const targetSummary = `${belief.subject} ${belief.predicate} ${belief.object}`;
    const aliasSummary = beliefSubjectAliases(belief).join(" ");
    const detectedSensitivity = classifySensitivity(`${targetSummary} ${aliasSummary}`);
    if (detectedSensitivity === "secret_like") return;
    const sensitivity =
      sourceMemory?.sensitivity === "sensitive" || detectedSensitivity === "sensitive"
        ? "sensitive"
        : detectedSensitivity;
    for (const cue of associationCuesForBelief(belief)) {
      for (const tag of associationTagsForBelief(belief)) {
        upsertAssociation({
          profileId: belief.profileId,
          cue: cue.cue,
          cueKind: cue.cueKind,
          tag,
          targetType: "world_belief",
          targetId: belief.id,
          targetKind: "world_belief",
          targetSummary,
          sensitivity,
          status: "active",
          confidence: belief.confidence,
          sourceMemoryId: belief.sourceMemoryId,
          sourceBeliefId: belief.id,
          createdAt: belief.createdAt,
          updatedAt: belief.updatedAt,
        });
      }
    }
  }

  function projectTaskTrajectoryAssociations(trajectory: TaskTrajectoryAssociationSource): void {
    const targetSummary = [trajectory.objective, trajectory.summary ?? ""].join(" ").trim();
    const sensitivity = classifySensitivity(targetSummary);
    if (sensitivity === "secret_like") return;
    for (const cue of associationCuesForTaskTrajectory(trajectory)) {
      for (const tag of associationTagsForTaskTrajectory(trajectory)) {
        upsertAssociation({
          profileId: trajectory.profileId,
          cue: cue.cue,
          cueKind: cue.cueKind,
          tag,
          targetType: "task_trajectory",
          targetId: trajectory.id,
          targetKind: "task_trajectory",
          targetSummary,
          sensitivity,
          status: "active",
          confidence: trajectory.status === "completed" ? 0.75 : 0.6,
          sourceTaskTrajectoryId: trajectory.id,
          createdAt: trajectory.createdAt,
          updatedAt: trajectory.createdAt,
        });
      }
    }
  }

  function searchIndexStatus(): SearchIndexStatus {
    initialize();
    const totalMemoryCount = tableExists("gmos_memories")
      ? Number(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM gmos_memories")
              .get() as { count: number }
          ).count,
        )
      : 0;
    const activeMemoryCount = tableExists("gmos_memories")
      ? Number(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM gmos_memories WHERE status = 'active'")
              .get() as { count: number }
          ).count,
        )
      : 0;
    const hasFts = tableExists("gmos_memories_fts");
    const hasVectorIndex = tableExists("gmos_memory_vectors");
    ftsAvailableCache = hasFts;
    vectorIndexAvailableCache = hasVectorIndex;
    if (!hasFts) {
      return {
        status: "missing",
        totalMemoryCount,
        indexedMemoryCount: 0,
        activeMemoryCount,
        missingEntryCount: totalMemoryCount,
        staleEntryCount: 0,
        orphanEntryCount: 0,
        duplicateEntryCount: 0,
        vectorIndex: vectorIndexStatus(totalMemoryCount, hasVectorIndex),
      };
    }
    const indexedMemoryCount = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM gmos_memories_fts")
          .get() as { count: number }
      ).count,
    );
    const missingEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories m
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memories_fts f WHERE f.id = m.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const orphanEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories_fts f
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memories m WHERE m.id = f.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const staleEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories_fts f
             JOIN gmos_memories m ON m.id = f.id
             WHERE f.profile_id IS NOT m.profile_id
                OR f.kind IS NOT m.kind
                OR f.scope IS NOT m.scope
                OR f.status IS NOT m.status
                OR f.content IS NOT m.content`,
          )
          .get() as { count: number }
      ).count,
    );
    const duplicateEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(entry_count - 1), 0) AS count
             FROM (
               SELECT id, COUNT(*) AS entry_count
               FROM gmos_memories_fts
               GROUP BY id
               HAVING COUNT(*) > 1
             )`,
          )
          .get() as { count: number | null }
      ).count ?? 0,
    );
    const vectorIndex = vectorIndexStatus(totalMemoryCount, hasVectorIndex);
    const status =
      missingEntryCount === 0 &&
      staleEntryCount === 0 &&
      orphanEntryCount === 0 &&
      duplicateEntryCount === 0 &&
      vectorIndex.status === "ok"
        ? "ok"
        : "stale";
    return {
      status,
      totalMemoryCount,
      indexedMemoryCount,
      activeMemoryCount,
      missingEntryCount,
      staleEntryCount,
      orphanEntryCount,
      duplicateEntryCount,
      vectorIndex,
    };
  }

  function vectorIndexStatus(
    totalMemoryCount: number,
    hasVectorIndex = tableExists("gmos_memory_vectors"),
  ): NonNullable<SearchIndexStatus["vectorIndex"]> {
    const hasVectorTerms = tableExists("gmos_memory_vector_terms");
    if (!hasVectorIndex) {
      return {
        status: "missing",
        indexedMemoryCount: 0,
        missingEntryCount: totalMemoryCount,
        staleEntryCount: 0,
        orphanEntryCount: 0,
        duplicateEntryCount: 0,
        dimensions: 0,
      };
    }
    if (!hasVectorTerms) {
      return {
        status: "stale",
        indexedMemoryCount: Number(
          (
            db
              .prepare("SELECT COUNT(*) AS count FROM gmos_memory_vectors")
              .get() as { count: number }
          ).count,
        ),
        missingEntryCount: totalMemoryCount,
        staleEntryCount: 0,
        orphanEntryCount: 0,
        duplicateEntryCount: 0,
        dimensions: 0,
      };
    }
    const indexedMemoryCount = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM gmos_memory_vectors")
          .get() as { count: number }
      ).count,
    );
    const missingEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories m
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memory_vectors v WHERE v.id = m.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const orphanEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memory_vectors v
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memories m WHERE m.id = v.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const missingFeatureEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_memories m
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memory_vector_terms t WHERE t.id = m.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const orphanFeatureEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(DISTINCT t.id) AS count
             FROM gmos_memory_vector_terms t
             WHERE NOT EXISTS (
               SELECT 1 FROM gmos_memories m WHERE m.id = t.id
             )`,
          )
          .get() as { count: number }
      ).count,
    );
    const staleFeatureEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(DISTINCT t.id) AS count
             FROM gmos_memory_vector_terms t
             JOIN gmos_memories m ON m.id = t.id
             WHERE t.profile_id IS NOT m.profile_id
                OR t.status IS NOT m.status
                OR t.updated_at IS NOT m.updated_at`,
          )
          .get() as { count: number }
      ).count,
    );
    const staleVectorEntryCount = (
      db
        .prepare(
          `SELECT v.profile_id, v.status, v.updated_at, v.dimensions, v.vector_json, v.content_hash,
                  m.profile_id AS memory_profile_id, m.status AS memory_status,
                  m.updated_at AS memory_updated_at, m.content AS memory_content
           FROM gmos_memory_vectors v
           JOIN gmos_memories m ON m.id = v.id`,
        )
        .all() as Array<{
        profile_id?: string | null;
        status?: string | null;
        updated_at?: string | null;
        dimensions?: number | null;
        vector_json?: string | null;
        content_hash?: string | null;
        memory_profile_id?: string | null;
        memory_status?: string | null;
        memory_updated_at?: string | null;
        memory_content?: string | null;
      }>
    ).filter(
      (row) =>
        row.profile_id !== row.memory_profile_id ||
        row.status !== row.memory_status ||
        row.updated_at !== row.memory_updated_at ||
        row.dimensions !== LOCAL_TEXT_VECTOR_DIMENSIONS ||
        !row.vector_json ||
        parseJsonArray(row.vector_json).length !== LOCAL_TEXT_VECTOR_DIMENSIONS ||
        row.content_hash !== vectorContentHash(row.memory_content ?? ""),
    ).length;
    const duplicateEntryCount = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(entry_count - 1), 0) AS count
             FROM (
               SELECT id, COUNT(*) AS entry_count
               FROM gmos_memory_vectors
               GROUP BY id
               HAVING COUNT(*) > 1
             )`,
          )
          .get() as { count: number | null }
      ).count ?? 0,
    );
    const dimensions = Number(
      (
        db
          .prepare("SELECT COALESCE(MAX(dimensions), 0) AS dimensions FROM gmos_memory_vectors")
          .get() as { dimensions: number | null }
      ).dimensions ?? 0,
    );
    const status =
      missingEntryCount === 0 &&
      missingFeatureEntryCount === 0 &&
      staleVectorEntryCount === 0 &&
      staleFeatureEntryCount === 0 &&
      orphanEntryCount === 0 &&
      orphanFeatureEntryCount === 0 &&
      duplicateEntryCount === 0
        ? "ok"
        : "stale";
    return {
      status,
      indexedMemoryCount,
      missingEntryCount: missingEntryCount + missingFeatureEntryCount,
      staleEntryCount: staleVectorEntryCount + staleFeatureEntryCount,
      orphanEntryCount: orphanEntryCount + orphanFeatureEntryCount,
      duplicateEntryCount,
      dimensions,
    };
  }

  function repairSearchIndex(): RepairSearchIndexResult {
    initialize();
    const before = searchIndexStatus();
    if (db.readonly) throw new Error("gmOS SQLite store is readonly");
    if (!ftsAvailable()) throw new Error("gmOS SQLite search index is missing");
    const repairedAt = nowIso();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM gmos_memories_fts").run();
      db.prepare(
        `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
         SELECT id, profile_id, kind, scope, status, content
         FROM gmos_memories`,
      ).run();
      rebuildMemoryVectorIndex();
    });
    tx();
    const after = searchIndexStatus();
    return {
      repaired: before.status !== "ok" && after.status === "ok",
      before,
      after,
      repairedAt,
    };
  }

  function memoryRowsForSearch(input: MemorySearchInput): Record<string, unknown>[] {
    const query = input.query?.trim() ?? "";
    const candidateLimit = Math.max(input.limit ?? 12, 100);
    if (!query) {
      return db
        .prepare(
          `SELECT * FROM gmos_memories
           WHERE profile_id = ? AND status = 'active'
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(input.profileId, Math.max(candidateLimit, 500)) as Record<string, unknown>[];
    }

    const lexicalRows = memoryLexicalRowsForSearch(input, candidateLimit);
    if ((input.purpose ?? "context") !== "context") return lexicalRows;
    const vectorRows = memoryVectorRowsForSearch(input, candidateLimit);
    if (vectorRows.length === 0) return lexicalRows;
    return mergeSearchRows(lexicalRows, vectorRows, candidateLimit);
  }

  function memoryLexicalRowsForSearch(
    input: MemorySearchInput,
    candidateLimit: number,
  ): Record<string, unknown>[] {
    const query = input.query?.trim() ?? "";
    const match = ftsQuery(query);
    if (match && ftsAvailable()) {
      try {
        const rows = db
          .prepare(
            `SELECT m.*
             FROM gmos_memories_fts
             JOIN gmos_memories m ON m.id = gmos_memories_fts.id
             WHERE gmos_memories_fts MATCH ?
               AND m.profile_id = ?
               AND m.status = 'active'
             ORDER BY bm25(gmos_memories_fts), m.updated_at DESC
             LIMIT ?`,
          )
          .all(match, input.profileId, Math.max(candidateLimit, 500)) as Record<string, unknown>[];
        if (rows.length > 0) {
          return rows.map((row, index) => ({
            ...row,
            __gmos_search_score: 100 / (60 + index + 1),
          }));
        }
      } catch {
        // Fall back to LIKE search for tokenizer or parser edge cases.
      }
    }

    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const clauses = terms.map(() => "content LIKE ? ESCAPE '\\'");
    return (
      db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ?
           AND status = 'active'
           AND (${clauses.join(" OR ")})
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        input.profileId,
        ...terms.map(likePattern),
        Math.max(candidateLimit, 500),
      ) as Record<string, unknown>[]
    ).map((row, index) => ({
      ...row,
      __gmos_search_score: 80 / (60 + index + 1),
    }));
  }

  function memoryVectorRowsForSearch(
    input: MemorySearchInput,
    candidateLimit: number,
  ): Record<string, unknown>[] {
    const query = input.query?.trim() ?? "";
    if (!query || !vectorIndexAvailable()) return [];
    const queryFeatures = localTextCandidateFeatures(query, 128);
    if (queryFeatures.length === 0 || !tableExists("gmos_memory_vector_terms")) return [];
    const queryVector = localTextVector(query);
    const candidateRowLimit = Math.min(Math.max(candidateLimit * 20, 100), 1000);
    const featurePlaceholders = queryFeatures.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT m.*, v.vector_json, candidates.hit_count
         FROM (
           SELECT id, COUNT(*) AS hit_count, MAX(updated_at) AS latest_at
           FROM gmos_memory_vector_terms
           WHERE profile_id = ?
             AND status = 'active'
             AND feature_key IN (${featurePlaceholders})
           GROUP BY id
           ORDER BY hit_count DESC, latest_at DESC
           LIMIT ?
         ) candidates
         JOIN gmos_memory_vectors v ON v.id = candidates.id
         JOIN gmos_memories m ON m.id = candidates.id
         WHERE v.profile_id = ?
           AND v.status = 'active'
           AND m.profile_id = ?
           AND m.status = 'active'`,
      )
      .all(input.profileId, ...queryFeatures, candidateRowLimit, input.profileId, input.profileId) as Array<
      Record<string, unknown>
    >;
    return rows
      .map((row) => {
        const rawVector = parseJsonArray(row.vector_json);
        const similarity =
          rawVector.length === queryVector.length ? cosineSimilarity(queryVector, rawVector) : 0;
        const { vector_json: _vectorJson, hit_count: hitCount, ...memoryRow } = row;
        return {
          ...memoryRow,
          __gmos_vector_similarity: similarity,
          __gmos_feature_hit_count: Number(hitCount ?? 0),
          __gmos_search_score: similarity > 0 ? similarity * 3 : 0,
        };
      })
      .filter((row) => Number(row.__gmos_vector_similarity ?? 0) >= 0.45)
      .sort((a, b) => Number(b.__gmos_search_score ?? 0) - Number(a.__gmos_search_score ?? 0))
      .slice(0, candidateLimit);
  }

  function mergeSearchRows(
    lexicalRows: Record<string, unknown>[],
    vectorRows: Record<string, unknown>[],
    candidateLimit: number,
  ): Record<string, unknown>[] {
    const merged = new Map<string, Record<string, unknown>>();
    function addRows(rows: Record<string, unknown>[], source: "lexical" | "vector"): void {
      rows.forEach((row, index) => {
        const memoryId = String(row.id);
        const existing = merged.get(memoryId);
        const sourceScore =
          Number(row.__gmos_search_score ?? 0) + 1 / (60 + index + 1);
        merged.set(memoryId, {
          ...(existing ?? row),
          ...row,
          __gmos_search_score:
            Number(existing?.__gmos_search_score ?? 0) + sourceScore,
          __gmos_search_reason: [
            typeof existing?.__gmos_search_reason === "string"
              ? existing.__gmos_search_reason
              : "",
            source,
          ]
            .filter(Boolean)
            .join("+"),
        });
      });
    }
    addRows(lexicalRows, "lexical");
    addRows(vectorRows, "vector");
    return [...merged.values()]
      .sort((a, b) => Number(b.__gmos_search_score ?? 0) - Number(a.__gmos_search_score ?? 0))
      .slice(0, Math.max(candidateLimit, 500));
  }

  function parseJsonArray(value: unknown): number[] {
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is number => typeof entry === "number")
        : [];
    } catch {
      return [];
    }
  }

  function memoryRowsForList(input: MemoryListInput): Record<string, unknown>[] {
    const clauses = ["profile_id = ?"];
    const params: unknown[] = [input.profileId];
    if (input.status && input.status !== "any") {
      clauses.push("status = ?");
      params.push(input.status);
    } else if (!input.status) {
      clauses.push("status = 'active'");
    }
    if (input.kind) {
      clauses.push("kind = ?");
      params.push(input.kind);
    }
    if (input.scope) {
      clauses.push("scope = ?");
      params.push(input.scope);
    }
    const query = input.query?.trim() ?? "";
    if (!query) {
      return db
        .prepare(
          `SELECT * FROM gmos_memories
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(...params, limit(input.limit, 100, 500)) as Record<string, unknown>[];
    }

    const match = ftsQuery(query);
    if (match && ftsAvailable()) {
      try {
        const rows = db
          .prepare(
            `SELECT m.*
             FROM gmos_memories_fts
             JOIN gmos_memories m ON m.id = gmos_memories_fts.id
             WHERE gmos_memories_fts MATCH ?
               AND ${clauses.map((clause) => `m.${clause}`).join(" AND ")}
             ORDER BY bm25(gmos_memories_fts), m.updated_at DESC
             LIMIT ?`,
          )
          .all(match, ...params, Math.max(limit(input.limit, 100, 500), 500)) as Record<
          string,
          unknown
        >[];
        if (rows.length > 0) return rows;
      } catch {
        // Fall back to LIKE search for tokenizer or parser edge cases.
      }
    }

    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const likeClauses = terms.map(() => "content LIKE ? ESCAPE '\\'");
    return db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE ${clauses.join(" AND ")}
           AND (${likeClauses.join(" OR ")})
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        ...params,
        ...terms.map(likePattern),
        Math.max(limit(input.limit, 100, 500), 500),
      ) as Record<string, unknown>[];
  }

  function associationRowsForSearch(input: MemoryAssociationSearchInput): Record<string, unknown>[] {
    if (!tableExists("gmos_associations")) return [];
    const query = input.query.trim();
    const candidateLimit = Math.max(input.limit ?? 12, 100);
    if (!query) {
      return db
        .prepare(
          `SELECT * FROM gmos_associations
           WHERE profile_id = ? AND status = 'active'
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(input.profileId, candidateLimit) as Record<string, unknown>[];
    }

    const match = ftsQuery(query);
    if (match && associationsFtsAvailable()) {
      try {
        const rows = db
          .prepare(
            `SELECT a.*
             FROM gmos_associations_fts
             JOIN gmos_associations a ON a.id = gmos_associations_fts.id
             WHERE gmos_associations_fts MATCH ?
               AND a.profile_id = ?
               AND a.status = 'active'
             ORDER BY bm25(gmos_associations_fts), a.updated_at DESC
             LIMIT ?`,
          )
          .all(match, input.profileId, candidateLimit) as Record<string, unknown>[];
        if (rows.length > 0) return rows;
      } catch {
        // Fall back to LIKE search for tokenizer or parser edge cases.
      }
    }

    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const clauses = terms.map(() => "(cue LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\' OR target_summary LIKE ? ESCAPE '\\')");
    const params = terms.flatMap((term) => {
      const pattern = likePattern(term);
      return [pattern, pattern, pattern];
    });
    return db
      .prepare(
        `SELECT * FROM gmos_associations
         WHERE profile_id = ?
           AND status = 'active'
           AND (${clauses.join(" OR ")})
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(input.profileId, ...params, candidateLimit) as Record<string, unknown>[];
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
    const tx = db.transaction((): MemoryRecord => {
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
      syncMemoryFts(memoryId);
      syncMemoryVector(memoryId);
      const memory = normalizeMemory(
        db
          .prepare("SELECT * FROM gmos_memories WHERE id = ?")
          .get(memoryId) as Record<string, unknown>,
      );
      projectMemoryAssociations(memory);
      return memory;
    });
    return tx();
  }

  function updateMemory(input: UpdateMemoryInput): MemoryRecord | null {
    initialize();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'active'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return null;
    const previous = normalizeMemory(existing);
    const updatedAt = input.updatedAt ?? nowIso();
    const next = {
      kind: input.kind ?? previous.kind,
      scope: input.scope ?? previous.scope,
      content: input.content ?? previous.content,
      sensitivity: input.sensitivity ?? previous.sensitivity,
      confidence: input.confidence ?? previous.confidence,
      sourceEventId:
        input.sourceEventId === undefined ? previous.sourceEventId : input.sourceEventId,
      metadata: input.metadata ?? previous.metadata,
    };
    db.prepare(
      `UPDATE gmos_memories
       SET kind = ?,
           scope = ?,
           content = ?,
           sensitivity = ?,
           confidence = ?,
           source_event_id = ?,
           metadata_json = ?,
           updated_at = ?
       WHERE profile_id = ? AND id = ? AND status = 'active'`,
    ).run(
      next.kind,
      next.scope,
      next.content,
      next.sensitivity,
      next.confidence,
      next.sourceEventId ?? null,
      JSON.stringify(next.metadata),
      updatedAt,
      input.profileId,
      input.id,
    );
    syncMemoryFts(input.id);
    syncMemoryVector(input.id);
    const memory = normalizeMemory(
      db
        .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ?")
        .get(input.profileId, input.id) as Record<string, unknown>,
    );
    projectMemoryAssociations(memory);
    syncBeliefsForMemory(memory);
    return memory;
  }

  function archiveMemoryById(input: ArchiveMemoryInput): boolean {
    initialize();
    const archivedAt = input.archivedAt ?? nowIso();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'active'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return false;
    const metadata = metadataWithArchiveMarker({
      metadata: parseJsonObject(existing.metadata_json),
      archivedAt,
      reason: input.reason,
    });
    const result = db
      .prepare(
        `UPDATE gmos_memories
         SET status = 'archived', updated_at = ?, metadata_json = ?
         WHERE profile_id = ? AND id = ? AND status = 'active'`,
      )
      .run(archivedAt, JSON.stringify(metadata), input.profileId, input.id);
    syncMemoryFts(input.id);
    syncMemoryVector(input.id);
    deleteAssociationsForMemory(input.id);
    rejectBeliefsForMemory(input.id, archivedAt);
    return result.changes > 0;
  }

  function restoreArchivedMemory(input: RestoreArchivedMemoryInput): boolean {
    initialize();
    const restoredAt = input.restoredAt ?? nowIso();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'archived'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return false;
    const metadata = metadataWithRestoreMarker({
      metadata: parseJsonObject(existing.metadata_json),
      restoredAt,
      reason: input.reason,
    });
    const result = db
      .prepare(
        `UPDATE gmos_memories
         SET status = 'active', updated_at = ?, metadata_json = ?
         WHERE profile_id = ? AND id = ? AND status = 'archived'`,
      )
      .run(restoredAt, JSON.stringify(metadata), input.profileId, input.id);
    syncMemoryFts(input.id);
    syncMemoryVector(input.id);
    const restored = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ?")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (restored) projectMemoryAssociations(normalizeMemory(restored));
    return result.changes > 0;
  }

  function archiveMemories(input: ArchiveMemoriesInput): string[] {
    initialize();
    if (!input.all && !input.scope && !input.metadataEquals) {
      throw new Error("archiveMemories requires all, scope, or metadataEquals");
    }
    const clauses = ["profile_id = ?", "status = 'active'"];
    const params: unknown[] = [input.profileId];
    if (!input.all && input.scope) {
      clauses.push("scope = ?");
      params.push(input.scope);
    }
    if (!input.all && input.metadataEquals) {
      clauses.push("json_extract(metadata_json, ?) = ?");
      params.push(`$.${input.metadataEquals.key}`, input.metadataEquals.value);
    }
    const where = clauses.join(" AND ");
    const rows = db
      .prepare(`SELECT id, metadata_json FROM gmos_memories WHERE ${where}`)
      .all(...params) as Array<{ id: string; metadata_json: string }>;
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];
    const stmt = db.prepare(
      `UPDATE gmos_memories
       SET status = 'archived', updated_at = ?, metadata_json = ?
       WHERE profile_id = ? AND id = ?`,
    );
    const archivedAt = input.archivedAt ?? nowIso();
    const tx = db.transaction((memoryRows: Array<{ id: string; metadata_json: string }>) => {
      for (const row of memoryRows) {
        const metadata = metadataWithArchiveMarker({
          metadata: parseJsonObject(row.metadata_json),
          archivedAt,
          reason: input.reason,
        });
        stmt.run(archivedAt, JSON.stringify(metadata), input.profileId, row.id);
        syncMemoryFts(row.id);
        syncMemoryVector(row.id);
        deleteAssociationsForMemory(row.id);
        rejectBeliefsForMemory(row.id, archivedAt);
      }
    });
    tx(rows);
    return ids;
  }

  function addWorldBelief(input: AddWorldBeliefInput): WorldBeliefRecord {
    initialize();
    const createdAt = nowIso();
    const tx = db.transaction((): WorldBeliefRecord => {
      const resolution = resolveWorldEntitySubject({
        subject: input.subject,
        predicate: input.predicate,
        aliases: input.subjectAliases,
      });
      const canonicalSubject = resolution.canonicalSubject;
      const cardinality = input.cardinality ?? "multi";
      if (cardinality === "single") {
        const activeRows = db
          .prepare(
            `SELECT * FROM gmos_world_beliefs
             WHERE profile_id = ?
               AND predicate = ?
               AND status = 'active'
             ORDER BY updated_at DESC`,
          )
          .all(input.profileId, input.predicate) as Record<string, unknown>[];
        const activeBeliefs = activeRows
          .map(normalizeWorldBelief)
          .filter((belief) => canonicalSubjectForBelief(belief) === canonicalSubject);
        const sameObjectRows = activeBeliefs.filter((belief) => belief.object === input.object);
        const sameObject = sameObjectRows[0];
        if (sameObject) {
          for (const belief of activeBeliefs) {
            if (belief.id === sameObject.id) continue;
            deleteAssociationsForBelief(belief.id);
            db.prepare(
              `UPDATE gmos_world_beliefs
               SET subject = ?,
                   metadata_json = ?,
                   status = 'superseded',
                   updated_at = ?
               WHERE id = ? AND status = 'active'`,
            ).run(
              canonicalSubject,
              JSON.stringify(
                worldBeliefMetadata({
                  existingMetadata: belief.metadata,
                  resolution,
                }),
              ),
              createdAt,
              belief.id,
            );
          }
          const confidence = Math.max(
            sameObject.confidence,
            input.confidence ?? sameObject.confidence,
            ...sameObjectRows.map((belief) => belief.confidence),
          );
          const sourceMemoryId =
            sameObject.sourceMemoryId ??
            input.sourceMemoryId ??
            sameObjectRows.find((belief) => belief.sourceMemoryId)?.sourceMemoryId ??
            null;
          const metadata = worldBeliefMetadata({
            inputMetadata: input.metadata,
            existingMetadata: sameObject.metadata,
            resolution,
          });
          const refreshedMetadata = hasTemporalValidityMetadata(input.metadata)
            ? metadata
            : withoutTemporalValidityMetadata(metadata);
          db.prepare(
            `UPDATE gmos_world_beliefs
             SET subject = ?,
                 confidence = ?,
                 source_memory_id = ?,
                 metadata_json = ?,
                 updated_at = ?
             WHERE id = ?`,
          ).run(
            canonicalSubject,
            confidence,
            sourceMemoryId,
            JSON.stringify(refreshedMetadata),
            createdAt,
            sameObject.id,
          );
          deleteAssociationsForBelief(sameObject.id);
          const updated = normalizeWorldBelief(
            db
              .prepare("SELECT * FROM gmos_world_beliefs WHERE id = ?")
              .get(sameObject.id) as Record<string, unknown>,
          );
          projectBeliefAssociations(updated);
          return updated;
        }
        for (const belief of activeBeliefs) {
          deleteAssociationsForBelief(belief.id);
          db.prepare(
            `UPDATE gmos_world_beliefs
             SET subject = ?,
                 metadata_json = ?,
                 status = 'superseded',
                 updated_at = ?
             WHERE id = ? AND status = 'active'`,
          ).run(
            canonicalSubject,
            JSON.stringify(
              worldBeliefMetadata({
                existingMetadata: belief.metadata,
                resolution,
              }),
            ),
            createdAt,
            belief.id,
          );
        }
      }
      const beliefId = id("belief");
      const metadata = worldBeliefMetadata({
        inputMetadata: input.metadata,
        resolution,
      });
      db.prepare(
        `INSERT INTO gmos_world_beliefs (
          id, profile_id, subject, predicate, object, confidence, status,
          source_memory_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(
        beliefId,
        input.profileId,
        canonicalSubject,
        input.predicate,
        input.object,
        input.confidence ?? 0.5,
        input.sourceMemoryId ?? null,
        JSON.stringify(metadata),
        createdAt,
        createdAt,
      );
      const belief: WorldBeliefRecord = {
        id: beliefId,
        profileId: input.profileId,
        subject: canonicalSubject,
        predicate: input.predicate,
        object: input.object,
        confidence: input.confidence ?? 0.5,
        status: "active",
        sourceMemoryId: input.sourceMemoryId ?? null,
        metadata,
        createdAt,
        updatedAt: createdAt,
      };
      projectBeliefAssociations(belief);
      return belief;
    });
    return tx();
  }

  function supersededSourceMemoryIds(profileId: string): Set<string> {
    if (!tableExists("gmos_world_beliefs")) return new Set();
    const rows = db
      .prepare(
        `SELECT DISTINCT superseded.source_memory_id AS memoryId
         FROM gmos_world_beliefs superseded
         WHERE superseded.profile_id = ?
           AND superseded.status = 'superseded'
           AND superseded.source_memory_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM gmos_world_beliefs active
             WHERE active.profile_id = superseded.profile_id
               AND active.status = 'active'
               AND active.source_memory_id = superseded.source_memory_id
           )
         UNION
         SELECT DISTINCT memory.id AS memoryId
         FROM gmos_world_beliefs superseded
         JOIN gmos_memories memory ON memory.profile_id = superseded.profile_id
         WHERE superseded.profile_id = ?
           AND superseded.status = 'superseded'
           AND memory.status = 'active'
           AND memory.content = superseded.object
           AND json_extract(memory.metadata_json, '$.predicate') = superseded.predicate
           AND NOT EXISTS (
             SELECT 1
             FROM gmos_world_beliefs active_source
             WHERE active_source.profile_id = memory.profile_id
               AND active_source.status = 'active'
               AND active_source.source_memory_id = memory.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM gmos_world_beliefs active
             WHERE active.profile_id = superseded.profile_id
               AND active.status = 'active'
               AND active.subject = superseded.subject
               AND active.predicate = superseded.predicate
               AND active.object = superseded.object
           )`,
      )
      .all(profileId, profileId) as Array<{ memoryId?: string | null }>;
    return new Set(
      rows
        .map((row) => row.memoryId)
        .filter((memoryId): memoryId is string => Boolean(memoryId)),
    );
  }

  function temporallyInvalidMemoryIds(profileId: string, asOfIso: string): Set<string> {
    if (!tableExists("gmos_memories")) return new Set();
    const rows = db
      .prepare(
        `SELECT id, metadata_json
         FROM gmos_memories
         WHERE profile_id = ?
           AND status = 'active'
           AND (
             json_type(metadata_json, '$.validFrom') IS NOT NULL
             OR json_type(metadata_json, '$.valid_from') IS NOT NULL
             OR json_type(metadata_json, '$.validTo') IS NOT NULL
             OR json_type(metadata_json, '$.valid_to') IS NOT NULL
             OR json_type(metadata_json, '$.expiresAt') IS NOT NULL
           )`,
      )
      .all(profileId) as Array<{ id?: string | null; metadata_json?: string | null }>;
    return new Set(
      rows
        .filter((row) => !memoryMetadataIsValidAt(parseJsonObject(row.metadata_json), asOfIso))
        .map((row) => row.id)
        .filter((memoryId): memoryId is string => Boolean(memoryId)),
    );
  }

  function temporallyInvalidWorldBeliefIds(profileId: string, asOfIso: string): Set<string> {
    if (!tableExists("gmos_world_beliefs")) return new Set();
    const rows = db
      .prepare(
        `SELECT id, metadata_json
         FROM gmos_world_beliefs
         WHERE profile_id = ?
           AND status = 'active'
           AND (
             json_type(metadata_json, '$.validFrom') IS NOT NULL
             OR json_type(metadata_json, '$.valid_from') IS NOT NULL
             OR json_type(metadata_json, '$.validTo') IS NOT NULL
             OR json_type(metadata_json, '$.valid_to') IS NOT NULL
             OR json_type(metadata_json, '$.expiresAt') IS NOT NULL
           )`,
      )
      .all(profileId) as Array<{ id?: string | null; metadata_json?: string | null }>;
    return new Set(
      rows
        .filter((row) => !memoryMetadataIsValidAt(parseJsonObject(row.metadata_json), asOfIso))
        .map((row) => row.id)
        .filter((beliefId): beliefId is string => Boolean(beliefId)),
    );
  }

  function contextHiddenMemoryIds(profileId: string, asOfIso: string): Set<string> {
    const hidden = supersededSourceMemoryIds(profileId);
    for (const memoryId of temporallyInvalidMemoryIds(profileId, asOfIso)) {
      hidden.add(memoryId);
    }
    return hidden;
  }

  function searchMemories(input: MemorySearchInput): MemoryRecord[] {
    initialize();
    const query = input.query?.trim() ?? "";
    const purpose = input.purpose ?? "context";
    const ordinaryRecallPurpose = purpose === "context" || purpose === "history";
    const hiddenContextMemoryIds =
      purpose === "context" ? contextHiddenMemoryIds(input.profileId, nowIso()) : new Set<string>();
    return memoryRowsForSearch(input)
      .map((row) => ({
        memory: normalizeMemory(row),
        retrievalScore: Number(row.__gmos_search_score ?? 0),
      }))
      .filter((item) => input.includePerson || item.memory.kind !== "person")
      .filter((item) => !hiddenContextMemoryIds.has(item.memory.id))
      .filter(
        (item) =>
          !ordinaryRecallPurpose ||
          !shouldHideFromOrdinaryContext({
            sensitivity: item.memory.sensitivity,
            includeSensitive: input.includeSensitive,
          }),
      )
      .map((item) => ({
        memory: item.memory,
        score: query
          ? Math.max(scoreMemory(item.memory, query), item.memory.confidence + item.retrievalScore)
          : item.memory.confidence,
      }))
      .filter((item) => !query || item.score > item.memory.confidence)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? 12)
      .map((item) => item.memory);
  }

  function listMemories(input: MemoryListInput): MemoryRecord[] {
    initialize();
    const query = input.query?.trim() ?? "";
    return memoryRowsForList(input)
      .map(normalizeMemory)
      .filter((memory) =>
        visibleMemory({
          memory,
          includeSensitive: input.includeSensitive,
          includePerson: input.includePerson,
        }),
      )
      .map((memory) => ({ memory, score: query ? scoreMemory(memory, query) : memory.confidence }))
      .filter((item) => !query || item.score > item.memory.confidence)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit(input.limit, 100, 500))
      .map((item) => item.memory);
  }

  function getMemoryById(
    profileId: string,
    memoryId: string,
    options: {
      includeSensitive?: boolean | undefined;
      includePerson?: boolean | undefined;
      includeArchived?: boolean | undefined;
    } = {},
  ): MemoryRecord | null {
    initialize();
    const row = db
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND id = ?
           ${options.includeArchived ? "" : "AND status = 'active'"}`,
      )
      .get(profileId, memoryId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const memory = normalizeMemory(row);
    return visibleMemory({
      memory,
      includeSensitive: options.includeSensitive,
      includePerson: options.includePerson,
    })
      ? memory
      : null;
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
      for (const memoryId of memoryIds) {
        stmt.run(archivedAt, memoryId);
        syncMemoryFts(memoryId);
        syncMemoryVector(memoryId);
        deleteAssociationsForMemory(memoryId);
        rejectBeliefsForMemory(memoryId, archivedAt);
      }
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
        for (const memoryId of ids) {
          stmt.run(archivedAt, memoryId);
          syncMemoryFts(memoryId);
          syncMemoryVector(memoryId);
          deleteAssociationsForMemory(memoryId);
          rejectBeliefsForMemory(memoryId, archivedAt);
        }
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

  function listFailures(input: ListFailuresInput): FailureEventRecord[] {
    if (!tableExists("gmos_failure_events")) return [];
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const where = input.failureKind
      ? "WHERE profile_id = ? AND failure_kind = ?"
      : "WHERE profile_id = ?";
    const params = input.failureKind
      ? [input.profileId, input.failureKind, limit]
      : [input.profileId, limit];
    return (
      db
        .prepare(
          `SELECT * FROM gmos_failure_events
           ${where}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(...params) as Record<string, unknown>[]
    ).map(normalizeFailure);
  }

  function recordTaskTrajectory(input: TaskTrajectoryInput): void {
    initialize();
    const trajectoryId = id("trajectory");
    const createdAt = input.createdAt ?? nowIso();
    db.prepare(
      `INSERT INTO gmos_task_trajectories (
        id, profile_id, task_id, objective, status, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      trajectoryId,
      input.profileId,
      input.taskId ?? null,
      input.objective,
      input.status,
      input.summary ?? null,
      createdAt,
    );
    projectTaskTrajectoryAssociations({
      id: trajectoryId,
      profileId: input.profileId,
      taskId: input.taskId ?? null,
      objective: input.objective,
      status: input.status,
      summary: input.summary ?? null,
      createdAt,
    });
  }

  function searchAssociations(input: MemoryAssociationSearchInput): MemoryAssociationRecord[] {
    initialize();
    const query = input.query.trim();
    const purpose = input.purpose ?? "context";
    const asOfIso = nowIso();
    const hiddenContextMemoryIds =
      purpose === "context" ? contextHiddenMemoryIds(input.profileId, asOfIso) : new Set<string>();
    const hiddenContextBeliefIds =
      purpose === "context"
        ? temporallyInvalidWorldBeliefIds(input.profileId, asOfIso)
        : new Set<string>();
    const ranked = associationRowsForSearch(input)
      .map(normalizeAssociation)
      .filter(
        (association) =>
          (association.targetType !== "memory" ||
            !hiddenContextMemoryIds.has(association.targetId)) &&
          (association.targetType !== "world_belief" ||
            !hiddenContextBeliefIds.has(association.targetId)) &&
          (association.sourceMemoryId == null ||
            !hiddenContextMemoryIds.has(association.sourceMemoryId)) &&
          (association.sourceBeliefId == null ||
            !hiddenContextBeliefIds.has(association.sourceBeliefId)),
      )
      .filter((association) =>
        visibleAssociation({
          association,
          includeSensitive: input.includeSensitive,
          includePerson: input.includePerson,
        }),
      )
      .map((association) => ({
        association,
        score: query ? scoreAssociation(association, query) : association.confidence,
      }))
      .filter((item) => !query || item.score > item.association.confidence)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.association);
    const diversified: MemoryAssociationRecord[] = [];
    const seenTargets = new Set<string>();
    for (const association of ranked) {
      const targetKey = `${association.targetType}:${association.targetId}`;
      if (seenTargets.has(targetKey)) continue;
      seenTargets.add(targetKey);
      diversified.push(association);
      if (diversified.length >= limit(input.limit, 12, 100)) break;
    }
    return diversified;
  }

  function rebuildAssociations(input: RebuildAssociationsInput = {}): RebuildAssociationsResult {
    initialize();
    if (db.readonly) throw new Error("gmOS SQLite store is readonly");
    const profileParams = input.profileId ? [input.profileId] : [];
    if (associationsFtsAvailable()) {
      db.prepare(
        input.profileId
          ? "DELETE FROM gmos_associations_fts WHERE profile_id = ?"
          : "DELETE FROM gmos_associations_fts",
      ).run(...profileParams);
    }
    db.prepare(
      input.profileId
        ? "DELETE FROM gmos_associations WHERE profile_id = ?"
        : "DELETE FROM gmos_associations",
    ).run(...profileParams);

    const memoryRows = db
      .prepare(
        `SELECT * FROM gmos_memories
         ${input.profileId ? "WHERE profile_id = ? AND status = 'active'" : "WHERE status = 'active'"}`,
      )
      .all(...profileParams) as Record<string, unknown>[];
    for (const memory of memoryRows.map(normalizeMemory)) {
      projectMemoryAssociations(memory);
    }

    const beliefRows = db
      .prepare(
        `SELECT * FROM gmos_world_beliefs
         ${input.profileId ? "WHERE profile_id = ? AND status = 'active'" : "WHERE status = 'active'"}`,
      )
      .all(...profileParams) as Record<string, unknown>[];
    for (const belief of beliefRows.map(normalizeWorldBelief)) {
      projectBeliefAssociations(belief);
    }

    const trajectoryRows = db
      .prepare(
        `SELECT * FROM gmos_task_trajectories
         ${input.profileId ? "WHERE profile_id = ?" : ""}`,
      )
      .all(...profileParams) as Record<string, unknown>[];
    for (const trajectory of trajectoryRows.map(normalizeTaskTrajectory)) {
      projectTaskTrajectoryAssociations(trajectory);
    }

    const count = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM gmos_associations
             ${input.profileId ? "WHERE profile_id = ?" : ""}`,
          )
          .get(...profileParams) as { count: number }
      ).count,
    );
    return { rebuiltAssociationCount: count };
  }

  function rowCounts(): Record<string, number> {
    const tables = [
      "gmos_evidence_events",
      "gmos_memories",
      "gmos_world_beliefs",
      "gmos_failure_events",
      "gmos_task_trajectories",
      "gmos_associations",
      "gmos_memory_vectors",
      "gmos_memory_vector_terms",
    ];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        tableExists(table)
          ? Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
          : 0,
      ]),
    );
  }

  function quotedIdentifier(input: string): string {
    return `"${input.replaceAll('"', '""')}"`;
  }

  function readAuditFtsTableSnapshot(
    table: (typeof READ_AUDIT_FTS_TABLES)[number],
  ): ReadAuditSnapshot["tables"][string] {
    if (!tableExists(table.name)) return { rowCount: 0, stateHash: "missing" };
    const columnsSql = table.columns.map(quotedIdentifier).join(", ");
    const hash = createHash("sha256");
    let rowCount = 0;
    for (const row of db
      .prepare(
        `SELECT rowid AS __rowid, ${columnsSql}
         FROM ${quotedIdentifier(table.name)}
         ORDER BY id, rowid`,
      )
      .iterate() as Iterable<Record<string, unknown>>) {
      rowCount += 1;
      hash.update(JSON.stringify([row.__rowid ?? null, ...table.columns.map((column) => row[column] ?? null)]));
      hash.update("\n");
    }
    return {
      rowCount,
      stateHash: hash.digest("hex"),
    };
  }

  function readAuditSnapshot(): ReadAuditSnapshot {
    initialize();
    const tables: ReadAuditSnapshot["tables"] = {};
    const revisions = new Map<string, number>();
    if (tableExists("gmos_read_audit_revisions")) {
      for (const row of db
        .prepare("SELECT table_name, revision FROM gmos_read_audit_revisions")
        .all() as Array<{ table_name: string; revision: number }>) {
        revisions.set(row.table_name, Number(row.revision));
      }
    }
    for (const table of READ_AUDIT_REVISION_TABLES) {
      if (!tableExists(table)) {
        tables[table] = { rowCount: 0, stateHash: "missing" };
        continue;
      }
      const rowCount = Number(
        (
          db
            .prepare(`SELECT COUNT(*) AS count FROM ${quotedIdentifier(table)}`)
            .get() as { count: number }
        ).count,
      );
      const hash = createHash("sha256");
      hash.update(
        JSON.stringify({
          table,
          rowCount,
          revision: revisions.get(table) ?? 0,
        }),
      );
      tables[table] = {
        rowCount,
        stateHash: hash.digest("hex"),
      };
    }
    for (const table of READ_AUDIT_FTS_TABLES) {
      tables[table.name] = readAuditFtsTableSnapshot(table);
    }
    return {
      schema: "gmos.read_audit_snapshot.v1",
      tables,
    };
  }

  function schemaVersion(): number {
    return sqliteSchemaVersion(db);
  }

  return {
    initialize,
    close() {
      if (!options.handle) db.close();
    },
    recordEvidence,
    addMemory,
    updateMemory,
    archiveMemoryById,
    restoreArchivedMemory,
    archiveMemories,
    addWorldBelief,
    searchMemories,
    listMemories,
    getMemoryById,
    findActiveMemoryByMetadata,
    archiveStaleHostImports,
    listActionPolicies,
    listEvidenceForMemory,
    searchAssociations,
    rebuildAssociations,
    forget,
    recordFailure,
    listFailures,
    recordTaskTrajectory,
    rowCounts,
    readAuditSnapshot,
    schemaVersion,
    searchIndexStatus,
    repairSearchIndex,
    exportProfileBackup(input) {
      initialize();
      return exportSqliteProfileBackup(db, input);
    },
    restoreProfileBackup(input) {
      initialize();
      const report = restoreSqliteProfileBackup(db, input);
      rebuildAssociations({ profileId: report.targetProfileId });
      return report;
    },
  };
}
