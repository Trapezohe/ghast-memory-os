import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
  GMOS_EVIDENCE_REFERENCE_SHAPES,
  GMOS_EVIDENCE_PAYLOAD_SCHEMAS,
  type GmosEvidenceReferenceShape,
  type GmosEvidencePayloadSchema,
} from "../../kernel/evidence-schema.js";
import {
  GMOS_METADATA_REFERENCE_SCHEMAS,
  GMOS_METADATA_REFERENCE_SHAPES,
  gmosMetadataReferenceSchemas,
  type GmosMetadataReferenceShape,
} from "../../kernel/metadata-schema.js";
import {
  canonicalEvidenceEventKeyForProfile,
  classifyEvidenceSensitivity,
  classifyMemorySensitivity,
  classifySensitivity,
  payloadContainsRestrictedValue,
} from "../../kernel/safety.js";
import {
  LOCAL_TEXT_VECTOR_PROVIDER,
  localTextCandidateFeatures,
  localTextVector,
  vectorContentHash,
} from "../../kernel/local-vector.js";

export type SqliteProfileBackupMode = "safe" | "full";
export type SqliteProfileBackupConflictPolicy = "skip" | "replace" | "fail";
export type SqliteProfileBundleSchema =
  | "gmos.profile_bundle.v2"
  | "gmos.profile_backup.v1";

export type SqliteProfileBundleEncryptionErrorCode =
  | "passphrase_required"
  | "invalid_encrypted_bundle"
  | "decrypt_failed";

export class SqliteProfileBundleEncryptionError extends Error {
  readonly code: SqliteProfileBundleEncryptionErrorCode;

  constructor(code: SqliteProfileBundleEncryptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteProfileBundleEncryptionError";
    this.code = code;
  }
}

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
  schema: SqliteProfileBundleSchema;
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

export type SqliteProfileBundleDocument = SqliteProfileBackupDocument;

export interface SqliteEncryptedProfileBundleDocument {
  schema: "gmos.encrypted_profile_bundle.v1";
  encryptedAt: string;
  plaintextSchema: "gmos.profile_bundle.v2";
  encryption: {
    algorithm: "aes-256-gcm";
    kdf: "scrypt";
    kdfParams: {
      N: number;
      r: number;
      p: number;
      keyLength: number;
    };
    salt: string;
    nonce: string;
    tag: string;
  };
  ciphertext: string;
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
const MEMORY_STATUSES = new Set<MemoryStatus>(["active", "dormant", "archived"]);
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
const PROFILE_BUNDLE_SCHEMA = "gmos.profile_bundle.v2";
const LEGACY_PROFILE_BACKUP_SCHEMA = "gmos.profile_backup.v1";
const ENCRYPTED_PROFILE_BUNDLE_SCHEMA = "gmos.encrypted_profile_bundle.v1";
const PROFILE_BUNDLE_SCHEMAS = new Set<SqliteProfileBundleSchema>([
  PROFILE_BUNDLE_SCHEMA,
  LEGACY_PROFILE_BACKUP_SCHEMA,
]);
const PROFILE_BUNDLE_KDF_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 32,
} as const;

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
    recallCount: Number(row.recall_count ?? 0),
    lastRecalledAt: row.last_recalled_at == null ? null : String(row.last_recalled_at),
    reinforcement: Number(row.reinforcement ?? 0),
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
  const rows: Record<string, unknown>[] = [];
  for (let start = 0; start < ids.length; start += 400) {
    const batch = ids.slice(start, start + 400);
    rows.push(...db
      .prepare(`SELECT * FROM ${table} WHERE id IN (${batch.map(() => "?").join(", ")})`)
      .all(...batch) as Record<string, unknown>[]);
  }
  return rows;
}

function idOwnerRowsByIds(
  db: Database.Database,
  table: string,
  ids: string[],
): Array<{ id: string; profile_id: string }> {
  const rows: Array<{ id: string; profile_id: string }> = [];
  for (let start = 0; start < ids.length; start += 400) {
    const batch = ids.slice(start, start + 400);
    rows.push(...db
      .prepare(
        `SELECT id, profile_id FROM ${table} WHERE id IN (${batch.map(() => "?").join(", ")})`,
      )
      .all(...batch) as Array<{ id: string; profile_id: string }>);
  }
  return rows;
}

function evidenceIdentityRowsByEventKeys(
  db: Database.Database,
  eventKeys: string[],
): Array<Record<string, unknown> & { id: string; event_key: string; profile_id: string }> {
  const rows: Array<Record<string, unknown> & {
    id: string;
    event_key: string;
    profile_id: string;
  }> = [];
  const uniqueKeys = [...new Set(eventKeys)];
  for (let start = 0; start < uniqueKeys.length; start += 400) {
    const batch = uniqueKeys.slice(start, start + 400);
    rows.push(...db
      .prepare(
        `SELECT *
         FROM gmos_evidence_events
         WHERE event_key IN (${batch.map(() => "?").join(", ")})`,
      )
      .all(...batch) as Array<Record<string, unknown> & {
        id: string;
        event_key: string;
        profile_id: string;
      }>);
  }
  return rows;
}

function memoryRowsForBackup(
  db: Database.Database,
  profileId: string,
  options: BackupOptions,
): MemoryRecord[] {
  const clauses = ["profile_id = ?"];
  const params: unknown[] = [profileId];
  if (!options.includeArchived) clauses.push("status != 'archived'");
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
    .map((memory) => withInferredMemorySensitivity(memory, !options.includeSensitive))
    .filter((memory) => options.includeSensitive || memory.sensitivity === "normal");
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
      .map((event) => withInferredEvidenceSensitivity(event, !options.includeSensitive))
      .filter((event) => options.includeSensitive || event.sensitivity === "normal");
  }
  let pendingIds = [...new Set(memories.flatMap(backupMemoryEvidenceReferenceIds))];
  const visitedIds = new Set<string>();
  const events: EvidenceEvent[] = [];
  while (pendingIds.length > 0) {
    const batch = [...new Set(pendingIds.filter((id) => !visitedIds.has(id)))];
    pendingIds = [];
    batch.forEach((id) => visitedIds.add(id));
    for (const event of rowsByIds(db, "gmos_evidence_events", batch)
      .map(normalizeEvidence)
      .map((event) => withInferredEvidenceSensitivity(event, !options.includeSensitive))) {
      if (event.profileId !== profileId || (!options.includeSensitive && event.sensitivity !== "normal")) {
        continue;
      }
      events.push(event);
      pendingIds.push(...evidencePayloadReferenceIds(event));
    }
  }
  return events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
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

function withInferredMemorySensitivity(
  memory: MemoryRecord,
  strictIdentityKeys: boolean,
): MemoryRecord {
  const inferred = classifyMemorySensitivity(memory, { strictIdentityKeys });
  return sensitivityRank(inferred) > sensitivityRank(memory.sensitivity)
    ? { ...memory, sensitivity: inferred }
    : memory;
}

function withInferredEvidenceSensitivity(
  event: EvidenceEvent,
  strictIdentityKeys: boolean,
): EvidenceEvent {
  const inferred = classifyEvidenceSensitivity(event, { strictIdentityKeys });
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
  return options.includeSensitive ||
    classifyMemorySensitivity(memory, { strictIdentityKeys: true }) === "normal";
}

function evidenceAllowedBySensitivity(
  event: EvidenceEvent,
  options: { includeSensitive: boolean },
): boolean {
  return options.includeSensitive ||
    classifyEvidenceSensitivity(event, { strictIdentityKeys: true }) === "normal";
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
  beliefIds: ReadonlySet<string>,
  trajectoryIds: ReadonlySet<string>,
): MemoryRecord[] {
  const evidenceIds = new Set(evidenceEvents.map((event) => event.id));
  const memoryIds = new Set(memories.map((memory) => memory.id));
  return memories.map((memory) => ({
    ...memory,
    sourceEventId:
      memory.sourceEventId && evidenceIds.has(memory.sourceEventId) ? memory.sourceEventId : null,
    metadata: mapMemoryMetadataReferences({
      metadata: memory.metadata,
      evidence: (id) => evidenceIds.has(id) ? id : null,
      memory: (id) => memoryIds.has(id) ? id : null,
      belief: (id) => beliefIds.has(id) ? id : null,
      trajectory: (id) => trajectoryIds.has(id) ? id : null,
    }),
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const KNOWN_GMOS_EVIDENCE_PAYLOAD_SCHEMAS = new Set<GmosEvidencePayloadSchema>(
  Object.values(GMOS_EVIDENCE_PAYLOAD_SCHEMAS),
);

interface ProvenanceReferenceResolvers {
  memory(id: string): string | null;
  belief(id: string): string | null;
  trajectory(id: string): string | null;
}

function gmosEvidencePayloadSchema(event: EvidenceEvent): GmosEvidencePayloadSchema | null {
  const marker = event.payload._gmosSchema;
  if (typeof marker === "string") {
    return KNOWN_GMOS_EVIDENCE_PAYLOAD_SCHEMAS.has(marker as GmosEvidencePayloadSchema)
      ? marker as GmosEvidencePayloadSchema
      : null;
  }
  return null;
}

function gmosEvidenceReferenceShape(event: EvidenceEvent): GmosEvidenceReferenceShape | null {
  const schema = gmosEvidencePayloadSchema(event);
  return schema ? GMOS_EVIDENCE_REFERENCE_SHAPES[schema] : null;
}

function metadataReferenceShapes(
  metadata: Record<string, unknown>,
): GmosMetadataReferenceShape[] {
  return gmosMetadataReferenceSchemas(metadata)
    .map((schema) => GMOS_METADATA_REFERENCE_SHAPES[schema]);
}

function metadataReferenceKeys(
  shapes: GmosMetadataReferenceShape[],
  select: (shape: GmosMetadataReferenceShape) => readonly string[] | undefined,
): string[] {
  return [...new Set(shapes.flatMap((shape) => select(shape) ?? []))];
}

function metadataReferenceIds(
  metadata: Record<string, unknown>,
  fieldKeys: string[],
  arrayKeys: string[],
): string[] {
  return [...new Set([
    ...fieldKeys.flatMap((key) => typeof metadata[key] === "string" ? [metadata[key]] : []),
    ...arrayKeys.flatMap((key) => stringArray(metadata[key])),
  ])];
}

function mapMetadataIdReferences(
  metadata: Record<string, unknown>,
  fieldKeys: string[],
  arrayKeys: string[],
  resolve: (id: string) => string | null,
): void {
  for (const key of fieldKeys) {
    if (typeof metadata[key] !== "string") continue;
    const mapped = resolve(metadata[key]);
    if (mapped) metadata[key] = mapped;
    else delete metadata[key];
  }
  for (const key of arrayKeys) {
    if (Array.isArray(metadata[key])) metadata[key] = mapIdArray(metadata[key], resolve);
  }
}

function backupMemoryEvidenceReferenceIds(
  memory: Pick<MemoryRecord, "sourceEventId" | "metadata">,
): string[] {
  const ids = typeof memory.sourceEventId === "string" && memory.sourceEventId.length > 0
    ? [memory.sourceEventId]
    : [];
  if (
    !gmosMetadataReferenceSchemas(memory.metadata).includes(
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    return ids;
  }
  const shape = GMOS_METADATA_REFERENCE_SHAPES[GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage];
  ids.push(...metadataReferenceIds(
    memory.metadata,
    [...(shape.evidenceIdFields ?? [])],
    [...(shape.evidenceIdArrays ?? [])],
  ));
  const annealing = shape.annealingSourceEventId ? memory.metadata.annealing : null;
  if (
    isRecord(annealing) &&
    typeof annealing.sourceEventId === "string" &&
    annealing.sourceEventId.length > 0
  ) {
    ids.push(annealing.sourceEventId);
  }
  return [...new Set(ids)];
}

function evidencePayloadReferenceIds(event: EvidenceEvent): string[] {
  const shape = gmosEvidenceReferenceShape(event);
  if (!shape) return [];
  const payload = event.payload;
  const ids: string[] = [];
  for (const key of shape.evidenceIdArrays ?? []) ids.push(...stringArray(payload[key]));
  for (const key of shape.evidenceIdFields ?? []) {
    if (typeof payload[key] === "string") ids.push(payload[key]);
  }
  for (const key of shape.snapshotArrays ?? []) {
    if (!Array.isArray(payload[key])) continue;
    for (const value of payload[key]) {
      if (!isRecord(value)) continue;
      ids.push(...backupMemoryEvidenceReferenceIds({
        sourceEventId: typeof value.sourceEventId === "string" ? value.sourceEventId : null,
        metadata: isRecord(value.metadata) ? value.metadata : {},
      }));
    }
  }
  return [...new Set(ids)];
}

function evidencePayloadMemoryReferenceIds(event: EvidenceEvent): string[] {
  const shape = gmosEvidenceReferenceShape(event);
  if (!shape) return [];
  const payload = event.payload;
  const ids: string[] = [];
  for (const key of shape.memoryIdFields ?? []) {
    if (typeof payload[key] === "string") ids.push(payload[key]);
  }
  for (const key of shape.memoryIdArrays ?? []) ids.push(...stringArray(payload[key]));
  for (const key of [
    ...(shape.actionArrays ?? []),
    ...(shape.snapshotArrays ?? []),
  ]) {
    if (!Array.isArray(payload[key])) continue;
    for (const entry of payload[key]) {
      if (!isRecord(entry)) continue;
      if (typeof entry.memoryId === "string") ids.push(entry.memoryId);
      if (isRecord(entry.metadata)) {
        ids.push(...memoryMetadataMemoryReferenceIds(entry.metadata));
      }
    }
  }
  const provenanceCredit = shape.provenanceCredit ? payload.provenanceCredit : null;
  if (isRecord(provenanceCredit) && Array.isArray(provenanceCredit.creditedMemories)) {
    for (const entry of provenanceCredit.creditedMemories) {
      if (!isRecord(entry)) continue;
      for (const key of ["id", "viaMemoryId", "derivedFromMemoryId"] as const) {
        if (typeof entry[key] === "string") ids.push(entry[key]);
      }
      ids.push(...stringArray(entry.path));
    }
  }
  return [...new Set(ids)];
}

function evidencePayloadBeliefReferenceIds(event: EvidenceEvent): string[] {
  const shape = gmosEvidenceReferenceShape(event);
  if (!shape) return [];
  const ids: string[] = [];
  for (const key of shape.beliefIdArrays ?? []) ids.push(...stringArray(event.payload[key]));
  for (const key of shape.snapshotArrays ?? []) {
    if (!Array.isArray(event.payload[key])) continue;
    for (const entry of event.payload[key]) {
      if (isRecord(entry) && isRecord(entry.metadata)) {
        ids.push(...memoryMetadataBeliefReferenceIds(entry.metadata));
      }
    }
  }
  return [...new Set(ids)];
}

function evidencePayloadTrajectoryReferenceIds(event: EvidenceEvent): string[] {
  const shape = gmosEvidenceReferenceShape(event);
  if (!shape) return [];
  const ids: string[] = [];
  for (const key of shape.trajectoryIdArrays ?? []) ids.push(...stringArray(event.payload[key]));
  for (const key of shape.snapshotArrays ?? []) {
    if (!Array.isArray(event.payload[key])) continue;
    for (const entry of event.payload[key]) {
      if (isRecord(entry) && isRecord(entry.metadata)) {
        ids.push(...memoryMetadataTrajectoryReferenceIds(entry.metadata));
      }
    }
  }
  return [...new Set(ids)];
}

function mapEvidencePayloadMemoryReferences(
  value: Record<string, unknown>,
  shape: GmosEvidenceReferenceShape,
  resolve: (id: string) => string | null,
  targetProfileId?: string,
): Record<string, unknown> {
  const next = { ...value };
  for (const key of shape.memoryIdFields ?? []) {
    if (typeof next[key] !== "string") continue;
    const mapped = resolve(next[key]);
    if (mapped) next[key] = mapped;
    else delete next[key];
  }
  for (const key of shape.memoryIdArrays ?? []) {
    if (!Array.isArray(next[key])) continue;
    next[key] = stringArray(next[key]).flatMap((id) => {
      const mapped = resolve(id);
      return mapped ? [mapped] : [];
    });
  }
  for (const key of shape.actionArrays ?? []) {
    if (!Array.isArray(next[key])) continue;
    next[key] = next[key].flatMap((entry) => {
      if (!isRecord(entry)) return [entry];
      const mapped = typeof entry.memoryId === "string" ? resolve(entry.memoryId) : null;
      if (typeof entry.memoryId === "string" && !mapped) return [];
      return [{ ...entry, ...(mapped ? { memoryId: mapped } : {}) }];
    });
  }
  for (const key of shape.snapshotArrays ?? []) {
    if (!Array.isArray(next[key])) continue;
    next[key] = next[key].flatMap((entry) => {
      if (!isRecord(entry)) return [entry];
      const mapped = typeof entry.memoryId === "string" ? resolve(entry.memoryId) : null;
      if (typeof entry.memoryId === "string" && !mapped) return [];
      return [{
        ...entry,
        ...(mapped ? { memoryId: mapped } : {}),
        ...(targetProfileId && typeof entry.profileId === "string"
          ? { profileId: targetProfileId }
          : {}),
      }];
    });
  }
  if (
    shape.provenanceCredit && isRecord(next.provenanceCredit) &&
    Array.isArray(next.provenanceCredit.creditedMemories)
  ) {
    next.provenanceCredit = {
      ...next.provenanceCredit,
      creditedMemories: next.provenanceCredit.creditedMemories.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string") return [entry];
        const id = resolve(entry.id);
        if (!id) return [];
        const mappedEntry: Record<string, unknown> = { ...entry, id };
        for (const key of ["viaMemoryId", "derivedFromMemoryId"] as const) {
          if (typeof mappedEntry[key] !== "string") continue;
          const mapped = resolve(mappedEntry[key]);
          if (mapped) mappedEntry[key] = mapped;
          else delete mappedEntry[key];
        }
        if (Array.isArray(mappedEntry.path)) {
          mappedEntry.path = stringArray(mappedEntry.path).flatMap((memoryId) => {
            const mapped = resolve(memoryId);
            return mapped ? [mapped] : [];
          });
        }
        return [mappedEntry];
      }),
    };
  }
  return next;
}

function mapEvidencePayloadProvenanceReferences(
  value: Record<string, unknown>,
  shape: GmosEvidenceReferenceShape,
  resolve: ProvenanceReferenceResolvers,
): Record<string, unknown> {
  const next = { ...value };
  for (const [keys, resolver] of [
    [shape.beliefIdArrays ?? [], resolve.belief],
    [shape.trajectoryIdArrays ?? [], resolve.trajectory],
  ] as const) {
    for (const key of keys) {
      if (!Array.isArray(next[key])) continue;
      next[key] = stringArray(next[key]).flatMap((id) => {
        const mapped = resolver(id);
        return mapped ? [mapped] : [];
      });
    }
  }
  if (
    shape.provenanceCredit && isRecord(next.provenanceCredit) &&
    Array.isArray(next.provenanceCredit.creditedProvenance)
  ) {
    next.provenanceCredit = {
      ...next.provenanceCredit,
      creditedProvenance: next.provenanceCredit.creditedProvenance.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string") return [entry];
        const sourceResolver = entry.sourceType === "world_belief"
          ? resolve.belief
          : entry.sourceType === "task_trajectory" ? resolve.trajectory : null;
        if (!sourceResolver) return [entry];
        const id = sourceResolver(entry.id);
        if (!id) return [];
        const mappedEntry: Record<string, unknown> = { ...entry, id };
        for (const key of ["viaMemoryId", "derivedFromMemoryId"] as const) {
          if (typeof mappedEntry[key] !== "string") continue;
          const mapped = resolve.memory(mappedEntry[key]);
          if (mapped) mappedEntry[key] = mapped;
          else delete mappedEntry[key];
        }
        if (Array.isArray(mappedEntry.path)) {
          mappedEntry.path = stringArray(mappedEntry.path).flatMap((sourceId) => {
            const mapped = resolve.memory(sourceId) ?? sourceResolver(sourceId);
            return mapped ? [mapped] : [];
          });
        }
        return [mappedEntry];
      }),
    };
  }
  return next;
}

function mapIdArray(
  value: unknown,
  resolve: (id: string) => string | null,
): string[] {
  return stringArray(value).flatMap((id) => {
    const mapped = resolve(id);
    return mapped ? [mapped] : [];
  });
}

function archiveReason(metadata: Record<string, unknown>): string | null {
  return isRecord(metadata.archive) && typeof metadata.archive.reason === "string"
    ? metadata.archive.reason
    : null;
}

function mapMemoryMetadataReferences(input: {
  metadata: Record<string, unknown>;
  evidence: (id: string) => string | null;
  memory: (id: string) => string | null;
  belief: (id: string) => string | null;
  trajectory: (id: string) => string | null;
}): Record<string, unknown> {
  const shapes = metadataReferenceShapes(input.metadata);
  const keys = (
    select: (shape: GmosMetadataReferenceShape) => readonly string[] | undefined,
  ): string[] => metadataReferenceKeys(shapes, select);
  const next = { ...input.metadata };
  mapMetadataIdReferences(
    next,
    keys((shape) => shape.evidenceIdFields),
    keys((shape) => shape.evidenceIdArrays),
    input.evidence,
  );
  mapMetadataIdReferences(
    next,
    keys((shape) => shape.memoryIdFields),
    keys((shape) => shape.memoryIdArrays),
    input.memory,
  );
  mapMetadataIdReferences(next, [], keys((shape) => shape.beliefIdArrays), input.belief);
  mapMetadataIdReferences(next, [], keys((shape) => shape.trajectoryIdArrays), input.trajectory);

  if (shapes.some((shape) => shape.annealingSourceEventId) && isRecord(input.metadata.annealing)) {
    const annealing = { ...input.metadata.annealing };
    if (typeof annealing.sourceEventId === "string") {
      const mapped = input.evidence(annealing.sourceEventId);
      if (mapped) annealing.sourceEventId = mapped;
      else delete annealing.sourceEventId;
    }
    next.annealing = annealing;
  }
  for (const field of new Set(shapes.flatMap((shape) =>
    shape.sourceIndexEvidenceField ? [shape.sourceIndexEvidenceField] : []
  ))) {
    const id = typeof input.metadata[field] === "string" ? input.metadata[field] : null;
    if (Object.hasOwn(input.metadata, "sourceIndex") && (!id || !input.evidence(id))) {
      delete next.sourceIndex;
    }
  }
  for (const field of new Set(shapes.flatMap((shape) =>
    shape.sessionKeyEvidenceField ? [shape.sessionKeyEvidenceField] : []
  ))) {
    const id = typeof input.metadata[field] === "string" ? input.metadata[field] : null;
    const mapped = id ? input.evidence(id) : null;
    if (id && mapped && typeof input.metadata.sessionDistillationKey === "string" &&
      input.metadata.sessionDistillationKey.startsWith(`${id}:`)) {
      next.sessionDistillationKey = `${mapped}:${input.metadata.sessionDistillationKey.slice(id.length + 1)}`;
    } else if (!mapped) delete next.sessionDistillationKey;
  }
  const reason = archiveReason(input.metadata);
  for (const prefix of keys((shape) => shape.archiveReasonMemoryPrefixes)) {
    if (!reason?.startsWith(prefix) || !isRecord(input.metadata.archive)) continue;
    const mapped = input.memory(reason.slice(prefix.length));
    next.archive = {
      ...input.metadata.archive,
      reason: mapped ? `${prefix}${mapped}` : prefix.replace(/_by:$/u, ""),
    };
    break;
  }
  return next;
}

function mapFailureMetadataReferences(
  metadata: Record<string, unknown>,
  resolveMemory: (id: string) => string | null,
): Record<string, unknown> {
  const next = { ...metadata };
  if (!gmosMetadataReferenceSchemas(metadata).includes(
    GMOS_METADATA_REFERENCE_SCHEMAS.failureMemoryLinks,
  )) return next;
  const shape = GMOS_METADATA_REFERENCE_SHAPES[GMOS_METADATA_REFERENCE_SCHEMAS.failureMemoryLinks];
  mapMetadataIdReferences(
    next,
    [...(shape.memoryIdFields ?? [])],
    [...(shape.memoryIdArrays ?? [])],
    resolveMemory,
  );
  return next;
}

function memoryMetadataMemoryReferenceIds(
  metadata: Record<string, unknown>,
): string[] {
  const shapes = metadataReferenceShapes(metadata);
  const ids = metadataReferenceIds(
    metadata,
    metadataReferenceKeys(shapes, (shape) => shape.memoryIdFields),
    metadataReferenceKeys(shapes, (shape) => shape.memoryIdArrays),
  );
  const reason = archiveReason(metadata);
  for (const prefix of metadataReferenceKeys(shapes, (shape) => shape.archiveReasonMemoryPrefixes)) {
    if (reason?.startsWith(prefix)) ids.push(reason.slice(prefix.length));
  }
  return [...new Set(ids)];
}

function memoryMetadataBeliefReferenceIds(metadata: Record<string, unknown>): string[] {
  const shapes = metadataReferenceShapes(metadata);
  return metadataReferenceIds(
    metadata,
    [],
    metadataReferenceKeys(shapes, (shape) => shape.beliefIdArrays),
  );
}

function memoryMetadataTrajectoryReferenceIds(metadata: Record<string, unknown>): string[] {
  const shapes = metadataReferenceShapes(metadata);
  return metadataReferenceIds(
    metadata,
    [],
    metadataReferenceKeys(shapes, (shape) => shape.trajectoryIdArrays),
  );
}

function failureMetadataMemoryReferenceIds(metadata: Record<string, unknown>): string[] {
  if (!gmosMetadataReferenceSchemas(metadata).includes(
    GMOS_METADATA_REFERENCE_SCHEMAS.failureMemoryLinks,
  )) return [];
  const shape = GMOS_METADATA_REFERENCE_SHAPES[GMOS_METADATA_REFERENCE_SCHEMAS.failureMemoryLinks];
  return metadataReferenceIds(
    metadata,
    [...(shape.memoryIdFields ?? [])],
    [...(shape.memoryIdArrays ?? [])],
  );
}

function evidencePayloadWithClosure(
  event: EvidenceEvent,
  evidenceIds: ReadonlySet<string>,
  memoryIds: ReadonlySet<string>,
  beliefIds: ReadonlySet<string>,
  trajectoryIds: ReadonlySet<string>,
): EvidenceEvent {
  const schema = gmosEvidencePayloadSchema(event);
  if (!schema) return event;
  const shape = GMOS_EVIDENCE_REFERENCE_SHAPES[schema];
  const payload = { ...event.payload };
  for (const key of shape.evidenceIdArrays ?? []) {
    if (Array.isArray(payload[key])) {
      payload[key] = stringArray(payload[key]).filter((id) => evidenceIds.has(id));
    }
  }
  for (const key of shape.evidenceIdFields ?? []) {
    if (typeof payload[key] === "string" && !evidenceIds.has(payload[key])) delete payload[key];
  }
  for (const key of shape.snapshotArrays ?? []) {
    if (!Array.isArray(payload[key])) continue;
    payload[key] = payload[key].flatMap((value) => {
      if (!isRecord(value)) return value;
      return {
        ...value,
        sourceEventId: typeof value.sourceEventId === "string" && evidenceIds.has(value.sourceEventId)
          ? value.sourceEventId
          : null,
        ...(isRecord(value.metadata)
          ? {
              metadata: mapMemoryMetadataReferences({
                metadata: value.metadata,
                evidence: (id) => evidenceIds.has(id) ? id : null,
                memory: (id) => memoryIds.has(id) ? id : null,
                belief: (id) => beliefIds.has(id) ? id : null,
                trajectory: (id) => trajectoryIds.has(id) ? id : null,
              }),
            }
          : {}),
      };
    });
  }
  return {
    ...event,
    payload: {
      ...mapEvidencePayloadProvenanceReferences(
        mapEvidencePayloadMemoryReferences(
          payload,
          shape,
          (id) => memoryIds.has(id) ? id : null,
        ),
        shape,
        {
          memory: (id) => memoryIds.has(id) ? id : null,
          belief: (id) => beliefIds.has(id) ? id : null,
          trajectory: (id) => trajectoryIds.has(id) ? id : null,
        },
      ),
      _gmosSchema: schema,
    },
  };
}

function remapEvidenceIdArray(value: unknown, evidenceIdMap: ReadonlyMap<string, string>): string[] {
  return stringArray(value).flatMap((id) => {
    const mapped = evidenceIdMap.get(id);
    return mapped ? [mapped] : [];
  });
}

function remapEvidencePayload(
  event: EvidenceEvent,
  evidenceIdMap: ReadonlyMap<string, string>,
  memoryIdMap: ReadonlyMap<string, string>,
  beliefIdMap: ReadonlyMap<string, string>,
  trajectoryIdMap: ReadonlyMap<string, string>,
  targetProfileId: string,
): Record<string, unknown> {
  const schema = gmosEvidencePayloadSchema(event);
  if (!schema) return event.payload;
  const shape = GMOS_EVIDENCE_REFERENCE_SHAPES[schema];
  const payload = event.payload;
  const next = { ...payload };
  for (const key of shape.evidenceIdArrays ?? []) {
    if (Array.isArray(next[key])) {
      next[key] = remapEvidenceIdArray(next[key], evidenceIdMap);
    }
  }
  for (const key of shape.evidenceIdFields ?? []) {
    if (typeof next[key] !== "string") continue;
    const mapped = evidenceIdMap.get(next[key]);
    if (mapped) next[key] = mapped;
    else delete next[key];
  }
  const memoryMapped = mapEvidencePayloadMemoryReferences(
    next,
    shape,
    (id) => memoryIdMap.get(id) ?? null,
    targetProfileId,
  );
  for (const key of shape.snapshotArrays ?? []) {
    if (!Array.isArray(memoryMapped[key])) continue;
    memoryMapped[key] = memoryMapped[key].map((value) => {
      if (!isRecord(value)) return value;
      return {
        ...value,
        ...(typeof value.sourceEventId === "string"
          ? { sourceEventId: evidenceIdMap.get(value.sourceEventId) ?? null }
          : {}),
        ...(isRecord(value.metadata)
          ? {
              metadata: mapMemoryMetadataReferences({
                metadata: value.metadata,
                evidence: (id) => evidenceIdMap.get(id) ?? null,
                memory: (id) => memoryIdMap.get(id) ?? null,
                belief: (id) => beliefIdMap.get(id) ?? null,
                trajectory: (id) => trajectoryIdMap.get(id) ?? null,
              }),
            }
          : {}),
      };
    });
  }
  return {
    ...mapEvidencePayloadProvenanceReferences(
      memoryMapped,
      shape,
      {
        memory: (id) => memoryIdMap.get(id) ?? null,
        belief: (id) => beliefIdMap.get(id) ?? null,
        trajectory: (id) => trajectoryIdMap.get(id) ?? null,
      },
    ),
    _gmosSchema: schema,
  };
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
  const evidenceRows = evidenceRowsForBackup(db, profileId, memoryRows, options);
  const evidenceIds = new Set(evidenceRows.map((event) => event.id));
  const memoryIds = new Set(memoryRows.map((memory) => memory.id));
  const rawWorldBeliefs = worldBeliefRowsForBackup(db, profileId, memoryRows, options)
    .filter((belief) => beliefAllowedBySensitivity(belief, options));
  const taskTrajectories = taskRowsForBackup(db, profileId, options)
    .filter((trajectory) => taskAllowedBySensitivity(trajectory, options));
  const beliefIds = new Set(rawWorldBeliefs.map((belief) => belief.id));
  const trajectoryIds = new Set(taskTrajectories.map((trajectory) => trajectory.id));
  const worldBeliefs = rawWorldBeliefs.map((belief) => ({
    ...belief,
    metadata: mapMemoryMetadataReferences({
      metadata: belief.metadata ?? {},
      evidence: (id) => evidenceIds.has(id) ? id : null,
      memory: (id) => memoryIds.has(id) ? id : null,
      belief: (id) => beliefIds.has(id) ? id : null,
      trajectory: (id) => trajectoryIds.has(id) ? id : null,
    }),
  }));
  const evidenceEvents = evidenceRows.map((event) =>
    evidencePayloadWithClosure(event, evidenceIds, memoryIds, beliefIds, trajectoryIds)
  );
  const memories = withExportedEvidenceClosure(
    memoryRows,
    evidenceEvents,
    beliefIds,
    trajectoryIds,
  );
  const failureEvents = failureRowsForBackup(db, profileId, options)
    .filter((failure) => failureAllowedBySensitivity(failure, options))
    .map((failure) => ({
      ...failure,
      metadata: mapFailureMetadataReferences(
        failure.metadata,
        (id) => memoryIds.has(id) ? id : null,
      ),
    }));
  return {
    schema: PROFILE_BUNDLE_SCHEMA,
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
  if (value.recallCount === undefined) {
    (value as { recallCount?: number }).recallCount = 0;
  }
  assertNonNegativeInteger(value.recallCount, `${path}.recallCount`);
  if (value.lastRecalledAt === undefined) {
    (value as { lastRecalledAt?: string | null }).lastRecalledAt = null;
  }
  assertOptionalStringOrNull(value.lastRecalledAt, `${path}.lastRecalledAt`);
  if (value.reinforcement === undefined) {
    (value as { reinforcement?: number }).reinforcement = 0;
  }
  assertFiniteNumber(value.reinforcement, `${path}.reinforcement`, { min: -1, max: 1 });
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

function assertKnownCreditedProvenanceReferences(input: {
  event: EvidenceEvent;
  index: number;
  memoryIds: ReadonlySet<string>;
  beliefIds: ReadonlySet<string>;
  trajectoryIds: ReadonlySet<string>;
}): void {
  const shape = gmosEvidenceReferenceShape(input.event);
  if (!shape?.provenanceCredit) return;
  const provenanceCredit = input.event.payload.provenanceCredit;
  if (!isRecord(provenanceCredit) || !Array.isArray(provenanceCredit.creditedProvenance)) return;
  for (const [creditIndex, entry] of provenanceCredit.creditedProvenance.entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const sourceIds = entry.sourceType === "world_belief"
      ? input.beliefIds
      : entry.sourceType === "task_trajectory" ? input.trajectoryIds : null;
    if (!sourceIds) continue;
    const path = `evidenceEvents[${input.index}].payload.provenanceCredit.creditedProvenance[${creditIndex}]`;
    if (!sourceIds.has(entry.id)) {
      throw backupError(`${path}.id`, `references missing ${String(entry.sourceType)} ${entry.id}`);
    }
    for (const key of ["viaMemoryId", "derivedFromMemoryId"] as const) {
      if (typeof entry[key] === "string" && !input.memoryIds.has(entry[key])) {
        throw backupError(`${path}.${key}`, `references missing memory ${entry[key]}`);
      }
    }
    for (const [pathIndex, id] of stringArray(entry.path).entries()) {
      if (input.memoryIds.has(id) || sourceIds.has(id)) continue;
      throw backupError(`${path}.path[${pathIndex}]`, `references missing provenance node ${id}`);
    }
  }
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
  const memoryIds = new Set(backup.memories.map((memory) => memory.id));
  const beliefIds = new Set(backup.worldBeliefs.map((belief) => belief.id));
  const trajectoryIds = new Set(backup.taskTrajectories.map((trajectory) => trajectory.id));
  for (const [index, memory] of backup.memories.entries()) {
    for (const memoryId of memoryMetadataMemoryReferenceIds(memory.metadata)) {
      if (memoryIds.has(memoryId)) continue;
      throw backupError(
        `memories[${index}].metadata`,
        `references missing memory ${memoryId}`,
      );
    }
    for (const beliefId of memoryMetadataBeliefReferenceIds(memory.metadata)) {
      if (beliefIds.has(beliefId)) continue;
      throw backupError(
        `memories[${index}].metadata.sourceBeliefIds`,
        `references missing world belief ${beliefId}`,
      );
    }
    for (const trajectoryId of memoryMetadataTrajectoryReferenceIds(memory.metadata)) {
      if (trajectoryIds.has(trajectoryId)) continue;
      throw backupError(
        `memories[${index}].metadata.sourceTrajectoryIds`,
        `references missing task trajectory ${trajectoryId}`,
      );
    }
  }
  if (backup.options.includeEvidence) {
    for (const [index, memory] of backup.memories.entries()) {
      for (const evidenceId of backupMemoryEvidenceReferenceIds(memory)) {
        if (evidenceIds.has(evidenceId)) continue;
        throw backupError(
          `memories[${index}].sourceEventId`,
          `references missing evidence event ${evidenceId}`,
        );
      }
    }
    for (const [index, event] of backup.evidenceEvents.entries()) {
      for (const evidenceId of evidencePayloadReferenceIds(event)) {
        if (evidenceIds.has(evidenceId)) continue;
        throw backupError(
          `evidenceEvents[${index}].payload.evidenceIds`,
          `references missing evidence event ${evidenceId}`,
        );
      }
      for (const memoryId of evidencePayloadMemoryReferenceIds(event)) {
        if (memoryIds.has(memoryId)) continue;
        throw backupError(
          `evidenceEvents[${index}].payload`,
          `references missing memory ${memoryId}`,
        );
      }
      for (const beliefId of evidencePayloadBeliefReferenceIds(event)) {
        if (beliefIds.has(beliefId)) continue;
        throw backupError(
          `evidenceEvents[${index}].payload.sourceBeliefIds`,
          `references missing world belief ${beliefId}`,
        );
      }
      for (const trajectoryId of evidencePayloadTrajectoryReferenceIds(event)) {
        if (trajectoryIds.has(trajectoryId)) continue;
        throw backupError(
          `evidenceEvents[${index}].payload.sourceTrajectoryIds`,
          `references missing task trajectory ${trajectoryId}`,
        );
      }
      assertKnownCreditedProvenanceReferences({
        event,
        index,
        memoryIds,
        beliefIds,
        trajectoryIds,
      });
    }
    if (backup.mode === "safe") {
      const byId = new Map(backup.evidenceEvents.map((event) => [event.id, event]));
      const reachable = new Set(backup.memories.flatMap(backupMemoryEvidenceReferenceIds));
      const pending = [...reachable];
      for (let index = 0; index < pending.length; index += 1) {
        const event = byId.get(pending[index]!);
        if (!event) continue;
        for (const evidenceId of evidencePayloadReferenceIds(event)) {
          if (reachable.has(evidenceId)) continue;
          reachable.add(evidenceId);
          pending.push(evidenceId);
        }
      }
      for (const [index, event] of backup.evidenceEvents.entries()) {
        if (!reachable.has(event.id)) {
          throw backupError(
            `evidenceEvents[${index}].id`,
            "is not reachable from any exported memory evidence reference",
          );
        }
      }
    }
  }

  if (backup.options.includeWorldBeliefs) {
    for (const [index, belief] of backup.worldBeliefs.entries()) {
      if (belief.sourceMemoryId && !memoryIds.has(belief.sourceMemoryId)) {
        throw backupError(
          `worldBeliefs[${index}].sourceMemoryId`,
          `references missing memory ${belief.sourceMemoryId}`,
        );
      }
      for (const memoryId of memoryMetadataMemoryReferenceIds(belief.metadata ?? {})) {
        if (memoryIds.has(memoryId)) continue;
        throw backupError(
          `worldBeliefs[${index}].metadata`,
          `references missing memory ${memoryId}`,
        );
      }
      for (const evidenceId of backupMemoryEvidenceReferenceIds({
        sourceEventId: null,
        metadata: belief.metadata ?? {},
      })) {
        if (evidenceIds.has(evidenceId)) continue;
        throw backupError(
          `worldBeliefs[${index}].metadata`,
          `references missing evidence event ${evidenceId}`,
        );
      }
      for (const beliefId of memoryMetadataBeliefReferenceIds(belief.metadata ?? {})) {
        if (beliefIds.has(beliefId)) continue;
        throw backupError(
          `worldBeliefs[${index}].metadata.sourceBeliefIds`,
          `references missing world belief ${beliefId}`,
        );
      }
      for (const trajectoryId of memoryMetadataTrajectoryReferenceIds(belief.metadata ?? {})) {
        if (trajectoryIds.has(trajectoryId)) continue;
        throw backupError(
          `worldBeliefs[${index}].metadata.sourceTrajectoryIds`,
          `references missing task trajectory ${trajectoryId}`,
        );
      }
    }
  }
  for (const [index, failure] of backup.failureEvents.entries()) {
    for (const memoryId of failureMetadataMemoryReferenceIds(failure.metadata)) {
      if (memoryIds.has(memoryId)) continue;
      throw backupError(
        `failureEvents[${index}].metadata`,
        `references missing memory ${memoryId}`,
      );
    }
  }
}

function assertBackupOptionSemantics(backup: SqliteProfileBackupDocument): void {
  for (const [index, memory] of backup.memories.entries()) {
    const inferred = classifyMemorySensitivity(memory, {
      strictIdentityKeys: !backup.options.includeSensitive,
    });
    if (sensitivityRank(inferred) > sensitivityRank(memory.sensitivity)) {
      throw backupError(
        `memories[${index}].sensitivity`,
        `declared ${memory.sensitivity} is lower than inferred ${inferred}`,
      );
    }
  }
  for (const [index, event] of backup.evidenceEvents.entries()) {
    const inferred = classifyEvidenceSensitivity(event, {
      strictIdentityKeys: !backup.options.includeSensitive,
    });
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
      if (backupMemoryEvidenceReferenceIds(memory).length > 0) {
        throw backupError(
          memory.sourceEventId
            ? `memories[${index}].sourceEventId`
            : `memories[${index}].metadata`,
          "must not reference evidence when options.includeEvidence is false",
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
  if (!PROFILE_BUNDLE_SCHEMAS.has(backup.schema as SqliteProfileBundleSchema)) {
    throw new Error(
      "gmOS profile bundle schema must be gmos.profile_bundle.v2 or gmos.profile_backup.v1",
    );
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

function base64(value: Buffer): string {
  return value.toString("base64");
}

function bufferFromBase64(value: unknown, path: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      `gmOS encrypted profile bundle invalid ${path}`,
    );
  }
  try {
    return Buffer.from(value, "base64");
  } catch (error) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      `gmOS encrypted profile bundle invalid ${path}`,
      { cause: error },
    );
  }
}

function assertEncryptedProfileBundle(
  value: unknown,
): asserts value is SqliteEncryptedProfileBundleDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle must be an object",
    );
  }
  const record = value as Partial<SqliteEncryptedProfileBundleDocument>;
  if (record.schema !== ENCRYPTED_PROFILE_BUNDLE_SCHEMA) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle schema must be gmos.encrypted_profile_bundle.v1",
    );
  }
  if (record.plaintextSchema !== PROFILE_BUNDLE_SCHEMA) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle plaintextSchema must be gmos.profile_bundle.v2",
    );
  }
  if (typeof record.encryptedAt !== "string" || !record.encryptedAt) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle requires encryptedAt",
    );
  }
  const encryption = record.encryption;
  if (!encryption || typeof encryption !== "object" || Array.isArray(encryption)) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle requires encryption metadata",
    );
  }
  if (encryption.algorithm !== "aes-256-gcm" || encryption.kdf !== "scrypt") {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle uses unsupported encryption",
    );
  }
  const params = encryption.kdfParams;
  if (
    !params ||
    typeof params !== "object" ||
    params.N !== PROFILE_BUNDLE_KDF_PARAMS.N ||
    params.r !== PROFILE_BUNDLE_KDF_PARAMS.r ||
    params.p !== PROFILE_BUNDLE_KDF_PARAMS.p ||
    params.keyLength !== PROFILE_BUNDLE_KDF_PARAMS.keyLength
  ) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle uses unsupported scrypt parameters",
    );
  }
  bufferFromBase64(encryption.salt, "encryption.salt");
  bufferFromBase64(encryption.nonce, "encryption.nonce");
  bufferFromBase64(encryption.tag, "encryption.tag");
  bufferFromBase64(record.ciphertext, "ciphertext");
}

export function isSqliteEncryptedProfileBundle(
  value: unknown,
): value is SqliteEncryptedProfileBundleDocument {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { schema?: unknown }).schema === ENCRYPTED_PROFILE_BUNDLE_SCHEMA,
  );
}

function requirePassphrase(passphrase: string | undefined): string {
  if (!passphrase) {
    throw new SqliteProfileBundleEncryptionError(
      "passphrase_required",
      "gmOS encrypted profile bundle requires a passphrase",
    );
  }
  return passphrase;
}

function profileBundleKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, PROFILE_BUNDLE_KDF_PARAMS.keyLength, {
    N: PROFILE_BUNDLE_KDF_PARAMS.N,
    r: PROFILE_BUNDLE_KDF_PARAMS.r,
    p: PROFILE_BUNDLE_KDF_PARAMS.p,
  });
}

function profileBundleAad(schema: string): Buffer {
  return Buffer.from(`gmos-profile-bundle:${schema}`, "utf8");
}

export function encryptSqliteProfileBundle(
  bundle: SqliteProfileBundleDocument,
  passphrase: string,
): SqliteEncryptedProfileBundleDocument {
  const parsed = parseSqliteProfileBackup(bundle);
  if (parsed.schema !== PROFILE_BUNDLE_SCHEMA) {
    throw new SqliteProfileBundleEncryptionError(
      "invalid_encrypted_bundle",
      "gmOS encrypted profile bundle plaintext must be gmos.profile_bundle.v2",
    );
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = profileBundleKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(profileBundleAad(parsed.schema));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(parsed), "utf8"),
    cipher.final(),
  ]);
  return {
    schema: ENCRYPTED_PROFILE_BUNDLE_SCHEMA,
    encryptedAt: nowIso(),
    plaintextSchema: PROFILE_BUNDLE_SCHEMA,
    encryption: {
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      kdfParams: { ...PROFILE_BUNDLE_KDF_PARAMS },
      salt: base64(salt),
      nonce: base64(nonce),
      tag: base64(cipher.getAuthTag()),
    },
    ciphertext: base64(ciphertext),
  };
}

export function decryptSqliteProfileBundle(
  encrypted: unknown,
  passphrase: string,
): SqliteProfileBundleDocument {
  assertEncryptedProfileBundle(encrypted);
  const salt = bufferFromBase64(encrypted.encryption.salt, "encryption.salt");
  const nonce = bufferFromBase64(encrypted.encryption.nonce, "encryption.nonce");
  const tag = bufferFromBase64(encrypted.encryption.tag, "encryption.tag");
  const ciphertext = bufferFromBase64(encrypted.ciphertext, "ciphertext");
  const key = profileBundleKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(profileBundleAad(encrypted.plaintextSchema));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return parseSqliteProfileBackup(JSON.parse(plaintext) as unknown);
  } catch (error) {
    throw new SqliteProfileBundleEncryptionError(
      "decrypt_failed",
      "gmOS encrypted profile bundle could not be decrypted",
      { cause: error },
    );
  }
}

export function parseSqliteProfileBundle(
  value: unknown,
  input: { passphrase?: string | undefined } = {},
): SqliteProfileBundleDocument {
  if (isSqliteEncryptedProfileBundle(value)) {
    return decryptSqliteProfileBundle(value, requirePassphrase(input.passphrase));
  }
  return parseSqliteProfileBackup(value);
}

export function serializeSqliteProfileBundle(input: {
  bundle: SqliteProfileBundleDocument;
  passphrase?: string | undefined;
}): SqliteProfileBundleDocument | SqliteEncryptedProfileBundleDocument {
  if (!input.passphrase) return input.bundle;
  return encryptSqliteProfileBundle(input.bundle, input.passphrase);
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
  const existing = idOwnerRowsByIds(db, table, rows.map((row) => row.id));
  if (existing[0]) {
    throw new Error(`gmOS profile backup restore conflict in ${table}: ${String(existing[0].id)}`);
  }
}

function assertIdsOwnedByProfile(
  db: Database.Database,
  table: string,
  rows: Array<{ id: string }>,
  targetProfileId: string,
): void {
  const foreign = idOwnerRowsByIds(db, table, rows.map((row) => row.id))
    .find((row) => String(row.profile_id) !== targetProfileId);
  if (foreign) {
    throw new Error(
      `gmOS profile backup restore ${table} id belongs to another profile: ${String(foreign.id)}`,
    );
  }
}

function assertNoEvidenceConflicts(
  db: Database.Database,
  rows: Array<{ id: string; eventKey: string }>,
): void {
  const existingById = idOwnerRowsByIds(
    db,
    "gmos_evidence_events",
    rows.map((row) => row.id),
  );
  const existingByEventKey = evidenceIdentityRowsByEventKeys(
    db,
    rows.map((row) => row.eventKey),
  );
  const existing = existingById[0] ?? existingByEventKey[0];
  if (existing) {
    throw new Error(
      `gmOS profile backup restore conflict in gmos_evidence_events: ${String(existing.id)}`,
    );
  }
}

function restoredEvidenceEvent(input: {
  event: EvidenceEvent;
  evidenceIdMap: ReadonlyMap<string, string>;
  memoryIdMap: ReadonlyMap<string, string>;
  beliefIdMap: ReadonlyMap<string, string>;
  trajectoryIdMap: ReadonlyMap<string, string>;
  sourceProfileId: string;
  targetProfileId: string;
}): EvidenceEvent {
  const payloadSchema = gmosEvidencePayloadSchema(input.event);
  const remapped: EvidenceEvent = {
    ...input.event,
    id: input.evidenceIdMap.get(input.event.id) ?? input.event.id,
    profileId: input.targetProfileId,
    payload: remapEvidencePayload(
      input.event,
      input.evidenceIdMap,
      input.memoryIdMap,
      input.beliefIdMap,
      input.trajectoryIdMap,
      input.targetProfileId,
    ),
  };
  const canonicalEventKey =
    payloadSchema === GMOS_EVIDENCE_PAYLOAD_SCHEMAS.conversationMessage ||
      payloadSchema === GMOS_EVIDENCE_PAYLOAD_SCHEMAS.sessionDistillation
      ? canonicalEvidenceEventKeyForProfile(remapped, input.targetProfileId)
      : null;
  return {
    ...remapped,
    eventKey: canonicalEventKey ??
      stableRestoreEventKey({
        eventKey: input.event.eventKey,
        sourceProfileId: input.sourceProfileId,
        targetProfileId: input.targetProfileId,
      }),
  };
}

function resolveExistingEvidenceIds(input: {
  db: Database.Database;
  events: EvidenceEvent[];
  evidenceIdMap: Map<string, string>;
  memoryIdMap: ReadonlyMap<string, string>;
  beliefIdMap: ReadonlyMap<string, string>;
  trajectoryIdMap: ReadonlyMap<string, string>;
  sourceProfileId: string;
  targetProfileId: string;
  reuseExisting: boolean;
  requireExistingBodyMatch: boolean;
}): void {
  const incomingByEventKey = new Map<string, {
    event: EvidenceEvent;
    targetId: string;
  }>();
  const reuseExisting = input.reuseExisting && input.db
    .prepare("SELECT 1 FROM gmos_evidence_events LIMIT 1")
    .get() !== undefined;

  function processGroup(sourceEvents: EvidenceEvent[]): void {
    if (sourceEvents.length === 0) return;
    const restored = sourceEvents.map((sourceEvent) => ({
      sourceEvent,
      event: restoredEvidenceEvent({
        event: sourceEvent,
        evidenceIdMap: input.evidenceIdMap,
        memoryIdMap: input.memoryIdMap,
        beliefIdMap: input.beliefIdMap,
        trajectoryIdMap: input.trajectoryIdMap,
        sourceProfileId: input.sourceProfileId,
        targetProfileId: input.targetProfileId,
      }),
    }));
    const existingByEventKey = new Map(
      reuseExisting
        ? evidenceIdentityRowsByEventKeys(
            input.db,
            restored.map(({ event }) => event.eventKey),
          ).map((row) => [row.event_key, row] as const)
        : [],
    );
    for (const { sourceEvent, event } of restored) {
      const incoming = incomingByEventKey.get(event.eventKey);
      if (incoming) {
        const { id: _leftId, eventKey: _leftKey, ...left } = incoming.event;
        const { id: _rightId, eventKey: _rightKey, ...right } = event;
        if (!isDeepStrictEqual(left, right)) {
          throw new Error(
            "gmOS profile backup contains conflicting evidence for a canonical event key",
          );
        }
        input.evidenceIdMap.set(sourceEvent.id, incoming.targetId);
        continue;
      }
      let targetId = event.id;
      const existing = existingByEventKey.get(event.eventKey);
      if (existing) {
        if (existing.profile_id !== input.targetProfileId) {
          throw new Error(
            "gmOS profile backup restore event key belongs to another profile",
          );
        }
        const existingEvent = normalizeEvidence(existing);
        const { id: _incomingId, ...incomingBody } = event;
        const { id: _existingId, ...existingBody } = existingEvent;
        if (
          input.requireExistingBodyMatch &&
          !isDeepStrictEqual(existingBody, incomingBody)
        ) {
          throw new Error(
            "gmOS profile backup restore event key has incompatible existing evidence",
          );
        }
        targetId = existing.id;
        input.evidenceIdMap.set(sourceEvent.id, existing.id);
      }
      incomingByEventKey.set(event.eventKey, { event, targetId });
    }
  }

  const sessionEvents = input.events.filter(
    (event) =>
      gmosEvidencePayloadSchema(event) === GMOS_EVIDENCE_PAYLOAD_SCHEMAS.sessionDistillation,
  );
  const sessionEventIds = new Set(sessionEvents.map((event) => event.id));
  const sessionById = new Map(sessionEvents.map((event) => [event.id, event]));
  const dependents = new Map<string, EvidenceEvent[]>();
  const indegree = new Map<string, number>();
  for (const event of sessionEvents) {
    const dependencies = [...new Set(stringArray(event.payload.evidenceIds))]
      .filter((id) => sessionById.has(id));
    indegree.set(event.id, dependencies.length);
    for (const dependencyId of dependencies) {
      const current = dependents.get(dependencyId) ?? [];
      current.push(event);
      dependents.set(dependencyId, current);
    }
  }

  processGroup(input.events.filter((event) => !sessionEventIds.has(event.id)));
  let ready = sessionEvents.filter((event) => indegree.get(event.id) === 0);
  let processed = 0;
  while (ready.length > 0) {
    processGroup(ready);
    processed += ready.length;
    const next: EvidenceEvent[] = [];
    for (const event of ready) {
      for (const dependent of dependents.get(event.id) ?? []) {
        const remaining = (indegree.get(dependent.id) ?? 0) - 1;
        indegree.set(dependent.id, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    ready = next;
  }
  if (processed !== sessionEvents.length) {
    throw new Error("gmOS profile backup contains cyclic session evidence identity dependencies");
  }
}

function uniqueRestoredEvidenceEvents(events: EvidenceEvent[]): EvidenceEvent[] {
  const byId = new Map<string, EvidenceEvent>();
  const byEventKey = new Map<string, EvidenceEvent>();
  for (const event of events) {
    const existing = byId.get(event.id) ?? byEventKey.get(event.eventKey);
    if (existing) {
      if (!isDeepStrictEqual(existing, event)) {
        throw new Error(
          "gmOS profile backup restore evidence identity collision",
        );
      }
      continue;
    }
    byId.set(event.id, event);
    byEventKey.set(event.eventKey, event);
  }
  return [...byId.values()];
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
      id, profile_id, status, provider_name, embedding_status, dimensions,
      vector_json, content_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.profile_id,
    row.status,
    LOCAL_TEXT_VECTOR_PROVIDER,
    "embedded",
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
  afterWrite?: ((targetProfileId: string) => void) | undefined,
  beforeWrite?: ((targetProfileId: string) => void) | undefined,
): SqliteProfileBackupRestoreResult {
  if (db.inTransaction) {
    throw new Error("gmOS profile backup restore cannot run inside an existing SQLite transaction");
  }
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
  const beliefIdMap = new Map(
    backup.worldBeliefs.map((belief) => [
      belief.id,
      stableRestoreId({
        fallbackPrefix: "belief",
        originalId: belief.id,
        sourceProfileId: backup.profileId,
        targetProfileId,
      }),
    ]),
  );
  const trajectoryIdMap = new Map(
    backup.taskTrajectories.map((trajectory) => [
      trajectory.id,
      stableRestoreId({
        fallbackPrefix: "trajectory",
        originalId: trajectory.id,
        sourceProfileId: backup.profileId,
        targetProfileId,
      }),
    ]),
  );
  const tx = db.transaction(() => {
    beforeWrite?.(targetProfileId);
    resolveExistingEvidenceIds({
      db,
      events: backup.evidenceEvents,
      evidenceIdMap,
      memoryIdMap,
      beliefIdMap,
      trajectoryIdMap,
      sourceProfileId: backup.profileId,
      targetProfileId,
      reuseExisting: onConflict !== "fail",
      requireExistingBodyMatch: onConflict === "skip",
    });
    const evidenceEvents = uniqueRestoredEvidenceEvents(
      backup.evidenceEvents.map((event) => restoredEvidenceEvent({
        event,
        evidenceIdMap,
        memoryIdMap,
        beliefIdMap,
        trajectoryIdMap,
        sourceProfileId: backup.profileId,
        targetProfileId,
      })),
    );
    const memories = backup.memories.map((memory) => ({
      ...memory,
      id: memoryIdMap.get(memory.id) ?? memory.id,
      profileId: targetProfileId,
      sourceEventId: memory.sourceEventId ? (evidenceIdMap.get(memory.sourceEventId) ?? null) : null,
      metadata: mapMemoryMetadataReferences({
        metadata: memory.metadata ?? {},
        evidence: (id) => evidenceIdMap.get(id) ?? null,
        memory: (id) => memoryIdMap.get(id) ?? null,
        belief: (id) => beliefIdMap.get(id) ?? null,
        trajectory: (id) => trajectoryIdMap.get(id) ?? null,
      }),
    }));
    const worldBeliefs = backup.worldBeliefs.map((belief) => ({
      ...belief,
      id: beliefIdMap.get(belief.id) ?? belief.id,
      profileId: targetProfileId,
      metadata: mapMemoryMetadataReferences({
        metadata: belief.metadata ?? {},
        evidence: (id) => evidenceIdMap.get(id) ?? null,
        memory: (id) => memoryIdMap.get(id) ?? null,
        belief: (id) => beliefIdMap.get(id) ?? null,
        trajectory: (id) => trajectoryIdMap.get(id) ?? null,
      }),
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
      metadata: mapFailureMetadataReferences(
        failure.metadata ?? {},
        (id) => memoryIdMap.get(id) ?? null,
      ),
    }));
    const taskTrajectories = backup.taskTrajectories.map((trajectory) => ({
      ...trajectory,
      id: trajectoryIdMap.get(trajectory.id) ?? trajectory.id,
      profileId: targetProfileId,
    }));

    assertIdsOwnedByProfile(db, "gmos_evidence_events", evidenceEvents, targetProfileId);
    assertIdsOwnedByProfile(db, "gmos_memories", memories, targetProfileId);
    assertIdsOwnedByProfile(db, "gmos_world_beliefs", worldBeliefs, targetProfileId);
    assertIdsOwnedByProfile(db, "gmos_failure_events", failureEvents, targetProfileId);
    assertIdsOwnedByProfile(db, "gmos_task_trajectories", taskTrajectories, targetProfileId);

    if (onConflict === "fail") {
      assertNoEvidenceConflicts(db, evidenceEvents);
      assertNoConflicts(db, "gmos_memories", memories);
      assertNoConflicts(db, "gmos_world_beliefs", worldBeliefs);
      assertNoConflicts(db, "gmos_failure_events", failureEvents);
      assertNoConflicts(db, "gmos_task_trajectories", taskTrajectories);
    }

    const evidenceVerb = onConflict === "skip" ? "INSERT OR IGNORE" : "INSERT";
    const evidenceConflict = onConflict === "replace"
      ? ` ON CONFLICT(id) DO UPDATE SET
          event_key = excluded.event_key,
          profile_id = excluded.profile_id,
          source_type = excluded.source_type,
          source_uri = excluded.source_uri,
          content = excluded.content,
          sensitivity = excluded.sensitivity,
          eligible_for_long_term_memory = excluded.eligible_for_long_term_memory,
          payload_json = excluded.payload_json,
          created_at = excluded.created_at`
      : "";
    const evidenceStmt = db.prepare(
      `${evidenceVerb} INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${evidenceConflict}`,
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
        recall_count, last_recalled_at, reinforcement, source_event_id,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        memory.recallCount ?? 0,
        memory.lastRecalledAt ?? null,
        memory.reinforcement ?? 0,
        memory.sourceEventId ?? null,
        JSON.stringify(memory.metadata ?? {}),
        memory.createdAt,
        memory.updatedAt,
      );
      applyChangeCount(result, inserted, skipped, "memories");
      if (result.changes > 0) {
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
    afterWrite?.(targetProfileId);
  });
  tx.immediate();

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
