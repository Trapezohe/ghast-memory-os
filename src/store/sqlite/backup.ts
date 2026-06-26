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
import {
  classifyPayloadSensitivity,
  classifySensitivity,
  payloadContainsRestrictedValue,
} from "../../kernel/safety.js";
import {
  localTextCandidateFeatures,
  localTextVector,
  vectorContentHash,
} from "../../kernel/local-vector.js";

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
const MEMORY_STATUSES = new Set<MemoryStatus>(["active", "archived"]);
const WORLD_BELIEF_STATUSES = new Set<WorldBeliefRecord["status"]>([
  "active",
  "candidate",
  "rejected",
  "superseded",
]);
const FAILURE_KINDS = new Set<FailureEventRecord["failureKind"]>([
  "missed_recall",
  "wrong_recall",
  "privacy_leak",
  "forget_failure",
  "controller_route_error",
  "action_policy_missing",
  "task_failure",
]);
const TASK_STATUSES = new Set<SqliteTaskTrajectoryRecord["status"]>([
  "completed",
  "failed",
]);

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
    metadata: parseJsonObject(row.metadata_json),
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
  )
    .map(normalizeMemory)
    .map(withInferredMemorySensitivity)
    .filter((memory) => memoryAllowedBySensitivity(memory, options));
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
    )
      .map(normalizeEvidence)
      .map(withInferredEvidenceSensitivity)
      .filter((event) => evidenceAllowedBySensitivity(event, options));
  }
  const sourceEventIds = [
    ...new Set(memories.map((memory) => memory.sourceEventId).filter((id): id is string => !!id)),
  ];
  return rowsByIds(db, "gmos_evidence_events", sourceEventIds)
    .map(normalizeEvidence)
    .map(withInferredEvidenceSensitivity)
    .filter((event) => event.profileId === profileId && evidenceAllowedBySensitivity(event, options))
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
      (belief) => belief.sourceMemoryId == null || memoryIds.has(belief.sourceMemoryId),
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

function sensitivityRank(sensitivity: Sensitivity): number {
  if (sensitivity === "secret_like") return 2;
  if (sensitivity === "sensitive") return 1;
  return 0;
}

function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  return sensitivityRank(left) >= sensitivityRank(right) ? left : right;
}

function combinedContentSensitivity(values: Array<string | null | undefined>): Sensitivity {
  return values.reduce<Sensitivity>(
    (current, value) =>
      value == null ? current : maxSensitivity(current, classifySensitivity(value)),
    "normal",
  );
}

function memoryInferredSensitivity(memory: MemoryRecord): Sensitivity {
  return maxSensitivity(
    combinedContentSensitivity([
      memory.id,
      memory.profileId,
      memory.scope,
      memory.content,
      memory.sourceEventId,
    ]),
    classifyPayloadSensitivity(memory.metadata),
  );
}

function evidenceInferredSensitivity(event: EvidenceEvent): Sensitivity {
  return maxSensitivity(
    combinedContentSensitivity([
      event.id,
      event.eventKey,
      event.profileId,
      event.sourceType,
      event.sourceUri,
      event.content,
    ]),
    classifyPayloadSensitivity(event.payload),
  );
}

function withInferredMemorySensitivity(memory: MemoryRecord): MemoryRecord {
  const inferred = memoryInferredSensitivity(memory);
  return sensitivityRank(inferred) > sensitivityRank(memory.sensitivity)
    ? { ...memory, sensitivity: inferred }
    : memory;
}

function withInferredEvidenceSensitivity(event: EvidenceEvent): EvidenceEvent {
  const inferred = evidenceInferredSensitivity(event);
  return sensitivityRank(inferred) > sensitivityRank(event.sensitivity)
    ? { ...event, sensitivity: inferred }
    : event;
}

function contentAllowedBySensitivity(
  content: string,
  options: { includeSensitive: boolean },
): boolean {
  return options.includeSensitive || classifySensitivity(content) === "normal";
}

function optionalContentAllowedBySensitivity(
  content: string | null | undefined,
  options: { includeSensitive: boolean },
): boolean {
  return content == null || contentAllowedBySensitivity(content, options);
}

function payloadAllowedBySensitivity(
  value: Record<string, unknown>,
  options: { includeSensitive: boolean },
): boolean {
  return options.includeSensitive || !payloadContainsRestrictedValue(value);
}

function memoryAllowedBySensitivity(
  memory: MemoryRecord,
  options: { includeSensitive: boolean },
): boolean {
  return (
    contentAllowedBySensitivity(memory.id, options) &&
    contentAllowedBySensitivity(memory.profileId, options) &&
    contentAllowedBySensitivity(memory.scope, options) &&
    contentAllowedBySensitivity(memory.content, options) &&
    optionalContentAllowedBySensitivity(memory.sourceEventId, options) &&
    payloadAllowedBySensitivity(memory.metadata, options)
  );
}

function evidenceAllowedBySensitivity(
  event: EvidenceEvent,
  options: { includeSensitive: boolean },
): boolean {
  return (
    (options.includeSensitive || event.sensitivity === "normal") &&
    contentAllowedBySensitivity(event.id, options) &&
    contentAllowedBySensitivity(event.eventKey, options) &&
    contentAllowedBySensitivity(event.profileId, options) &&
    contentAllowedBySensitivity(event.sourceType, options) &&
    optionalContentAllowedBySensitivity(event.sourceUri, options) &&
    contentAllowedBySensitivity(event.content, options) &&
    payloadAllowedBySensitivity(event.payload, options)
  );
}

function beliefAllowedBySensitivity(
  belief: WorldBeliefRecord,
  options: { includeSensitive: boolean },
): boolean {
  return (
    contentAllowedBySensitivity(
      `${belief.id}\n${belief.profileId}\n${belief.subject}\n${belief.predicate}\n${belief.object}\n${belief.sourceMemoryId ?? ""}`,
      options,
    ) && payloadAllowedBySensitivity(belief.metadata, options)
  );
}

function failureAllowedBySensitivity(
  failure: FailureEventRecord,
  options: { includeSensitive: boolean },
): boolean {
  return (
    contentAllowedBySensitivity(`${failure.id}\n${failure.profileId}\n${failure.failureKind}\n${failure.content}`, options) &&
    payloadAllowedBySensitivity(failure.metadata, options)
  );
}

function taskAllowedBySensitivity(
  trajectory: SqliteTaskTrajectoryRecord,
  options: { includeSensitive: boolean },
): boolean {
  return contentAllowedBySensitivity(
    `${trajectory.id}\n${trajectory.profileId}\n${trajectory.taskId ?? ""}\n${trajectory.objective}\n${trajectory.summary ?? ""}`,
    options,
  );
}

function withExportedEvidenceClosure(
  memories: MemoryRecord[],
  evidenceEvents: EvidenceEvent[],
): MemoryRecord[] {
  const evidenceIds = new Set(evidenceEvents.map((event) => event.id));
  return memories.map((memory) =>
    memory.sourceEventId && !evidenceIds.has(memory.sourceEventId)
      ? { ...memory, sourceEventId: null }
      : memory,
  );
}

export function exportSqliteProfileBackup(
  db: Database.Database,
  input: ExportSqliteProfileBackupInput,
): SqliteProfileBackupDocument {
  const profileId = requireNonEmptyProfile(input.profileId);
  const options = backupOptions(input);
  if (!contentAllowedBySensitivity(profileId, options)) {
    throw new Error("gmOS profile backup profileId requires includeSensitive=true");
  }
  const memoryRows = memoryRowsForBackup(db, profileId, options);
  const evidenceEvents = evidenceRowsForBackup(db, profileId, memoryRows, options);
  const memories = withExportedEvidenceClosure(memoryRows, evidenceEvents);
  const worldBeliefs = worldBeliefRowsForBackup(db, profileId, memories, options).filter((belief) =>
    beliefAllowedBySensitivity(belief, options),
  );
  const failureEvents = failureRowsForBackup(db, profileId, options).filter((failure) =>
    failureAllowedBySensitivity(failure, options),
  );
  const taskTrajectories = taskRowsForBackup(db, profileId, options).filter((trajectory) =>
    taskAllowedBySensitivity(trajectory, options),
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function backupError(path: string, message: string): Error {
  return new Error(`gmOS profile backup invalid ${path}: ${message}`);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw backupError(path, "must be an object");
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw backupError(path, "must be a non-empty string");
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw backupError(path, "must be a string");
}

function assertOptionalStringOrNull(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  assertString(value, path);
}

function assertOptionalNonEmptyStringOrNull(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  assertNonEmptyString(value, path);
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") throw backupError(path, "must be a boolean");
}

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw backupError(path, "must be a plain object");
}

function assertFiniteNumber(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw backupError(path, "must be a finite number");
  }
  if (options.min !== undefined && value < options.min) {
    throw backupError(path, `must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw backupError(path, `must be <= ${options.max}`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw backupError(path, "must be a non-negative integer");
  }
}

function assertEnum(value: unknown, allowed: ReadonlySet<string>, path: string): asserts value is string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw backupError(path, `must be one of ${[...allowed].join(", ")}`);
  }
}

function assertProfileId(value: unknown, sourceProfileId: string, path: string): void {
  assertNonEmptyString(value, path);
  if (value !== sourceProfileId) {
    throw backupError(path, `must match backup profileId ${sourceProfileId}`);
  }
}

function assertCountMatches(
  counts: Record<string, unknown>,
  key: keyof SqliteProfileBackupDocument["counts"],
  actual: number,
): void {
  assertNonNegativeInteger(counts[key], `counts.${key}`);
  if (counts[key] !== actual) {
    throw backupError(`counts.${key}`, `must match ${key}.length`);
  }
}

function assertUnique(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw backupError(path, `duplicate value ${value}`);
    seen.add(value);
  }
}

function assertPackageInfo(value: unknown): void {
  assertRecord(value, "package");
  assertNonEmptyString(value.name, "package.name");
  assertNonEmptyString(value.version, "package.version");
}

function assertBackupOptions(value: unknown): asserts value is SqliteProfileBackupDocument["options"] {
  assertRecord(value, "options");
  for (const key of [
    "includeArchived",
    "includeSensitive",
    "includePerson",
    "includeEvidence",
    "includeWorldBeliefs",
    "includeFailures",
    "includeTaskTrajectories",
  ] as const) {
    assertBoolean(value[key], `options.${key}`);
  }
}

function assertEvidenceEvent(value: unknown, sourceProfileId: string, index: number): asserts value is EvidenceEvent {
  const path = `evidenceEvents[${index}]`;
  assertRecord(value, path);
  assertNonEmptyString(value.id, `${path}.id`);
  assertNonEmptyString(value.eventKey, `${path}.eventKey`);
  assertProfileId(value.profileId, sourceProfileId, `${path}.profileId`);
  assertString(value.sourceType, `${path}.sourceType`);
  assertOptionalStringOrNull(value.sourceUri, `${path}.sourceUri`);
  assertString(value.content, `${path}.content`);
  assertEnum(value.sensitivity, SENSITIVITIES, `${path}.sensitivity`);
  assertBoolean(value.eligibleForLongTermMemory, `${path}.eligibleForLongTermMemory`);
  assertPlainObject(value.payload, `${path}.payload`);
  assertString(value.createdAt, `${path}.createdAt`);
}

function assertMemoryRecord(value: unknown, sourceProfileId: string, index: number): asserts value is MemoryRecord {
  const path = `memories[${index}]`;
  assertRecord(value, path);
  assertNonEmptyString(value.id, `${path}.id`);
  assertProfileId(value.profileId, sourceProfileId, `${path}.profileId`);
  assertEnum(value.kind, MEMORY_KINDS, `${path}.kind`);
  assertString(value.scope, `${path}.scope`);
  assertString(value.content, `${path}.content`);
  assertEnum(value.sensitivity, SENSITIVITIES, `${path}.sensitivity`);
  assertEnum(value.status, MEMORY_STATUSES, `${path}.status`);
  assertFiniteNumber(value.confidence, `${path}.confidence`, { min: 0, max: 1 });
  assertOptionalNonEmptyStringOrNull(value.sourceEventId, `${path}.sourceEventId`);
  assertPlainObject(value.metadata, `${path}.metadata`);
  assertString(value.createdAt, `${path}.createdAt`);
  assertString(value.updatedAt, `${path}.updatedAt`);
}

function assertWorldBeliefRecord(
  value: unknown,
  sourceProfileId: string,
  index: number,
): asserts value is WorldBeliefRecord {
  const path = `worldBeliefs[${index}]`;
  assertRecord(value, path);
  assertNonEmptyString(value.id, `${path}.id`);
  assertProfileId(value.profileId, sourceProfileId, `${path}.profileId`);
  assertString(value.subject, `${path}.subject`);
  assertString(value.predicate, `${path}.predicate`);
  assertString(value.object, `${path}.object`);
  assertFiniteNumber(value.confidence, `${path}.confidence`, { min: 0, max: 1 });
  assertEnum(value.status, WORLD_BELIEF_STATUSES, `${path}.status`);
  assertOptionalNonEmptyStringOrNull(value.sourceMemoryId, `${path}.sourceMemoryId`);
  if (value.metadata === undefined) {
    (value as { metadata?: Record<string, unknown> }).metadata = {};
  }
  assertPlainObject(value.metadata, `${path}.metadata`);
  assertString(value.createdAt, `${path}.createdAt`);
  assertString(value.updatedAt, `${path}.updatedAt`);
}

function assertFailureEventRecord(
  value: unknown,
  sourceProfileId: string,
  index: number,
): asserts value is FailureEventRecord {
  const path = `failureEvents[${index}]`;
  assertRecord(value, path);
  assertNonEmptyString(value.id, `${path}.id`);
  assertProfileId(value.profileId, sourceProfileId, `${path}.profileId`);
  assertEnum(value.failureKind, FAILURE_KINDS, `${path}.failureKind`);
  assertString(value.content, `${path}.content`);
  assertPlainObject(value.metadata, `${path}.metadata`);
  assertString(value.createdAt, `${path}.createdAt`);
}

function assertTaskTrajectoryRecord(
  value: unknown,
  sourceProfileId: string,
  index: number,
): asserts value is SqliteTaskTrajectoryRecord {
  const path = `taskTrajectories[${index}]`;
  assertRecord(value, path);
  assertNonEmptyString(value.id, `${path}.id`);
  assertProfileId(value.profileId, sourceProfileId, `${path}.profileId`);
  assertOptionalStringOrNull(value.taskId, `${path}.taskId`);
  assertString(value.objective, `${path}.objective`);
  assertEnum(value.status, TASK_STATUSES, `${path}.status`);
  assertOptionalStringOrNull(value.summary, `${path}.summary`);
  assertString(value.createdAt, `${path}.createdAt`);
}

function assertBackupRows(backup: SqliteProfileBackupDocument): void {
  backup.evidenceEvents.forEach((event, index) =>
    assertEvidenceEvent(event, backup.profileId, index),
  );
  backup.memories.forEach((memory, index) =>
    assertMemoryRecord(memory, backup.profileId, index),
  );
  backup.worldBeliefs.forEach((belief, index) =>
    assertWorldBeliefRecord(belief, backup.profileId, index),
  );
  backup.failureEvents.forEach((failure, index) =>
    assertFailureEventRecord(failure, backup.profileId, index),
  );
  backup.taskTrajectories.forEach((trajectory, index) =>
    assertTaskTrajectoryRecord(trajectory, backup.profileId, index),
  );

  assertUnique(
    backup.evidenceEvents.map((event) => event.id),
    "evidenceEvents.id",
  );
  assertUnique(
    backup.evidenceEvents.map((event) => event.eventKey),
    "evidenceEvents.eventKey",
  );
  assertUnique(
    backup.memories.map((memory) => memory.id),
    "memories.id",
  );
  assertUnique(
    backup.worldBeliefs.map((belief) => belief.id),
    "worldBeliefs.id",
  );
  assertUnique(
    backup.failureEvents.map((failure) => failure.id),
    "failureEvents.id",
  );
  assertUnique(
    backup.taskTrajectories.map((trajectory) => trajectory.id),
    "taskTrajectories.id",
  );

  const evidenceIds = new Set(backup.evidenceEvents.map((event) => event.id));
  if (backup.options.includeEvidence) {
    const referencedEvidenceIds = new Set(
      backup.memories.map((memory) => memory.sourceEventId).filter((id): id is string => !!id),
    );
    for (const [index, memory] of backup.memories.entries()) {
      if (memory.sourceEventId && !evidenceIds.has(memory.sourceEventId)) {
        throw backupError(
          `memories[${index}].sourceEventId`,
          `references missing evidence event ${memory.sourceEventId}`,
        );
      }
    }
    if (backup.mode === "safe") {
      for (const [index, event] of backup.evidenceEvents.entries()) {
        if (!referencedEvidenceIds.has(event.id)) {
          throw backupError(
            `evidenceEvents[${index}].id`,
            "is not referenced by any exported memory sourceEventId",
          );
        }
      }
    }
  }

  const memoryIds = new Set(backup.memories.map((memory) => memory.id));
  if (backup.options.includeWorldBeliefs) {
    for (const [index, belief] of backup.worldBeliefs.entries()) {
      if (belief.sourceMemoryId && !memoryIds.has(belief.sourceMemoryId)) {
        throw backupError(
          `worldBeliefs[${index}].sourceMemoryId`,
          `references missing memory ${belief.sourceMemoryId}`,
        );
      }
    }
  }
}

function assertBackupOptionSemantics(backup: SqliteProfileBackupDocument): void {
  for (const [index, memory] of backup.memories.entries()) {
    const inferred = memoryInferredSensitivity(memory);
    if (sensitivityRank(inferred) > sensitivityRank(memory.sensitivity)) {
      throw backupError(
        `memories[${index}].sensitivity`,
        `declared ${memory.sensitivity} is lower than inferred ${inferred}`,
      );
    }
  }
  for (const [index, event] of backup.evidenceEvents.entries()) {
    const inferred = evidenceInferredSensitivity(event);
    if (sensitivityRank(inferred) > sensitivityRank(event.sensitivity)) {
      throw backupError(
        `evidenceEvents[${index}].sensitivity`,
        `declared ${event.sensitivity} is lower than inferred ${inferred}`,
      );
    }
  }

  if (!backup.options.includeEvidence && backup.evidenceEvents.length > 0) {
    throw backupError("options.includeEvidence", "is false but evidenceEvents is non-empty");
  }
  if (!backup.options.includeEvidence) {
    for (const [index, memory] of backup.memories.entries()) {
      if (memory.sourceEventId) {
        throw backupError(
          `memories[${index}].sourceEventId`,
          "must be null when options.includeEvidence is false",
        );
      }
    }
  }
  if (!backup.options.includeWorldBeliefs && backup.worldBeliefs.length > 0) {
    throw backupError("options.includeWorldBeliefs", "is false but worldBeliefs is non-empty");
  }
  if (!backup.options.includeFailures && backup.failureEvents.length > 0) {
    throw backupError("options.includeFailures", "is false but failureEvents is non-empty");
  }
  if (!backup.options.includeTaskTrajectories && backup.taskTrajectories.length > 0) {
    throw backupError(
      "options.includeTaskTrajectories",
      "is false but taskTrajectories is non-empty",
    );
  }

  if (!backup.options.includeArchived) {
    for (const [index, memory] of backup.memories.entries()) {
      if (memory.status === "archived") {
        throw backupError(
          `memories[${index}].status`,
          "archived memory requires options.includeArchived=true",
        );
      }
    }
  }

  if (!backup.options.includeSensitive) {
    if (!contentAllowedBySensitivity(backup.profileId, backup.options)) {
      throw backupError("profileId", "sensitive profileId requires options.includeSensitive=true");
    }
    for (const [index, memory] of backup.memories.entries()) {
      if (memory.sensitivity !== "normal" || !memoryAllowedBySensitivity(memory, backup.options)) {
        throw backupError(
          `memories[${index}].sensitivity`,
          "sensitive memory requires options.includeSensitive=true",
        );
      }
    }
    for (const [index, event] of backup.evidenceEvents.entries()) {
      if (!evidenceAllowedBySensitivity(event, backup.options)) {
        throw backupError(
          `evidenceEvents[${index}].sensitivity`,
          "sensitive evidence requires options.includeSensitive=true",
        );
      }
    }
    for (const [index, belief] of backup.worldBeliefs.entries()) {
      if (!beliefAllowedBySensitivity(belief, backup.options)) {
        throw backupError(
          `worldBeliefs[${index}]`,
          "sensitive belief content requires options.includeSensitive=true",
        );
      }
    }
    for (const [index, failure] of backup.failureEvents.entries()) {
      if (!failureAllowedBySensitivity(failure, backup.options)) {
        throw backupError(
          `failureEvents[${index}].content`,
          "sensitive failure content requires options.includeSensitive=true",
        );
      }
    }
    for (const [index, trajectory] of backup.taskTrajectories.entries()) {
      if (!taskAllowedBySensitivity(trajectory, backup.options)) {
        throw backupError(
          `taskTrajectories[${index}]`,
          "sensitive task trajectory content requires options.includeSensitive=true",
        );
      }
    }
  }

  if (!backup.options.includePerson) {
    for (const [index, memory] of backup.memories.entries()) {
      if (memory.kind === "person") {
        throw backupError(
          `memories[${index}].kind`,
          "person memory requires options.includePerson=true",
        );
      }
    }
  }
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
  assertNonEmptyString(backup.exportedAt, "exportedAt");
  assertPackageInfo(backup.package);
  assertEnum(backup.mode, new Set<SqliteProfileBackupMode>(["safe", "full"]), "mode");
  assertBackupOptions(backup.options);
  assertRecord(backup.counts, "counts");
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
  const document = backup as SqliteProfileBackupDocument;
  assertCountMatches(document.counts, "memories", document.memories.length);
  assertCountMatches(document.counts, "evidenceEvents", document.evidenceEvents.length);
  assertCountMatches(document.counts, "worldBeliefs", document.worldBeliefs.length);
  assertCountMatches(document.counts, "failureEvents", document.failureEvents.length);
  assertCountMatches(document.counts, "taskTrajectories", document.taskTrajectories.length);
  assertBackupRows(document);
  assertBackupOptionSemantics(document);
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

function syncRestoredMemoryVector(db: Database.Database, memoryId: string): void {
  if (!tableExists(db, "gmos_memory_vectors")) return;
  db.prepare("DELETE FROM gmos_memory_vectors WHERE id = ?").run(memoryId);
  if (tableExists(db, "gmos_memory_vector_terms")) {
    db.prepare("DELETE FROM gmos_memory_vector_terms WHERE id = ?").run(memoryId);
  }
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
  if (tableExists(db, "gmos_memory_vector_terms")) {
    const termStmt = db.prepare(
      `INSERT OR IGNORE INTO gmos_memory_vector_terms(
        id, profile_id, status, feature_key, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const feature of localTextCandidateFeatures(row.content)) {
      termStmt.run(row.id, row.profile_id, row.status, feature, row.updated_at);
    }
  }
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
    metadata: belief.metadata ?? {},
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
      if (result.changes > 0) {
        syncRestoredMemoryFts(db, memory.id);
        syncRestoredMemoryVector(db, memory.id);
      }
    }

    const beliefStmt = db.prepare(
      `${verb} INTO gmos_world_beliefs (
        id, profile_id, subject, predicate, object, confidence, status,
        source_memory_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(belief.metadata ?? {}),
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
