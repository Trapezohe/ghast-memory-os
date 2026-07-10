import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";

import { MemoryRollbackError } from "../../kernel/types.js";
import type {
  ActionPolicy,
  AddMemoryInput,
  AddWorldBeliefInput,
  ArchiveMemoriesInput,
  ArchiveMemoryInput,
  ArchiveStaleHostImportsInput,
  CommitOutcomeStoreInput,
  EvidenceEvent,
  EvolutionAction,
  EvolutionApplyStoreInput,
  EvolutionApplyStoreResult,
  EvolutionPreviousMemoryValue,
  EvolutionRevertStoreInput,
  EvolutionRevertStoreResult,
  EvidenceListInput,
  FeedbackSignalStoreInput,
  FailureEventRecord,
  FailureKind,
  ForgetInput,
  ForgetResult,
  EmbeddingProvider,
  EmbeddingProviderConfig,
  ListFailuresInput,
  MaintenanceExemption,
  MaintenanceExplorationCandidate,
  MaintenanceReport,
  MaintenanceSkippedSummary,
  MaintenanceStoreInput,
  MaintenanceTransition,
  MemoryAssociationRecord,
  MemoryAssociationSearchInput,
  MemoryGapCandidate,
  MemoryGapCandidateListInput,
  MemoryGapCandidateSearchResult,
  MemoryGapKind,
  MemoryGapSuppressionReason,
  MemoryLifecycleStatus,
  MemoryListInput,
  MemoryKind,
  MemoryRecord,
  MemoryRollbackInput,
  MemoryRollbackResult,
  MemoryRetrievalConfig,
  MemorySearchScoreComponents,
  MemorySearchInput,
  MemoryStore,
  MemorySearchTraceCollector,
  MemoryVersionSnapshot,
  MemoryVectorEmbedding,
  RecordEvidenceInput,
  RecordConsolidationSummaryInput,
  RecordConsolidationSummaryResult,
  RecordFailureInput,
  RecordProcedureDistillationInput,
  RecordProcedureDistillationResult,
  ReadAuditSnapshot,
  RepairSearchIndexInput,
  RepairSearchIndexResult,
  RebuildAssociationsInput,
  RebuildAssociationsResult,
  RestoreArchivedMemoryInput,
  ResolvedMemoryAnnealingConfig,
  ResolvedProvenanceCreditConfig,
  SearchIndexStatus,
  Sensitivity,
  SourceTrust,
  TaskTrajectoryInput,
  TaskTrajectoryRecord,
  UpdateMemoryInput,
  WorldBeliefListInput,
  WorldBeliefRecord,
} from "../../kernel/types.js";
import {
  selectDuplicateConsolidationClusters,
  type DuplicateConsolidationCluster,
} from "../../kernel/consolidation.js";
import {
  memoryKindCanAutoTransition,
  retentionScore,
} from "../../kernel/retention.js";
import { memoryGapId } from "../../kernel/exploration.js";
import {
  associationCueKey,
  associationCueMatchesQuery,
  associationCuesForBelief,
  associationCuesForMemory,
  associationCuesForTaskTrajectory,
  associationSummaryForBelief,
  associationTagsForBelief,
  associationTagsForMemory,
  associationTagsForTaskTrajectory,
  memoryTargetKind,
  type TaskTrajectoryAssociationSource,
} from "../../kernel/associations.js";
import {
  type EntityResolutionResult,
  type EntityResolver,
  entityResolutionMetadata,
  resolveWorldEntitySubject,
} from "../../kernel/entities.js";
import {
  classifySensitivity,
  isPersonRoutedMemory,
  sanitizePublicPayloadRecord,
  shouldHideFromOrdinaryContext,
} from "../../kernel/safety.js";
import { normalizeExplicitTemporalInstant } from "../../kernel/temporal-validity.js";
import {
  cosineSimilarity,
  LOCAL_TEXT_VECTOR_DIMENSIONS,
  LOCAL_TEXT_VECTOR_PROVIDER,
  localTextCandidateFeatures,
  vectorContentHash,
} from "../../kernel/local-vector.js";
import {
  DEFAULT_VECTOR_BACKFILL_BATCH_SIZE,
  embeddingsForMemories,
  localMemoryEmbedding,
  memoryEligibleForEmbeddingProvider,
  providerDimensionsForHealth,
  providerNameForHealth,
  resolveEmbeddingProviderConfig,
  validateQueryEmbedding,
  validateStoredEmbedding,
  type ResolvedEmbeddingProviderConfig,
} from "../../kernel/embeddings.js";
import {
  exportSqliteProfileBackup,
  restoreSqliteProfileBackup,
  type ExportSqliteProfileBackupInput,
  type RestoreSqliteProfileBackupInput,
  type SqliteEncryptedProfileBundleDocument,
  type SqliteProfileBackupDocument,
  type SqliteProfileBackupRestoreResult,
  type SqliteProfileBundleDocument,
} from "./backup.js";
import { ensureSqliteSchema, sqliteSchemaVersion } from "./schema.js";
import {
  authenticateSqliteServiceApiKey,
  createSqliteServiceApiKey,
  ensureSqliteServiceProfile,
  listSqliteAutopilotRuns,
  listSqliteServiceApiKeys,
  listSqliteServiceAuditRows,
  listSqliteServiceProfiles,
  pruneSqliteAutopilotRuns,
  pruneSqliteServiceAuditRows,
  recordSqliteAutopilotRun,
  recordSqliteServiceAudit,
  revokeSqliteServiceApiKey,
  sqliteServiceApiKeyCount,
  type CreateSqliteServiceApiKeyInput,
  type ListSqliteAutopilotRunsInput,
  type ListSqliteServiceAuditInput,
  type SqliteAutopilotRun,
  type SqliteAutopilotRunInput,
  type SqliteServiceApiKey,
  type SqliteServiceApiKeyWithSecret,
  type SqliteServiceAuditInput,
  type SqliteServiceAuditRow,
  type SqliteServiceProfileSummary,
} from "./service.js";

export type {
  ExportSqliteProfileBackupInput,
  RestoreSqliteProfileBackupInput,
  SqliteEncryptedProfileBundleDocument,
  SqliteProfileBackupConflictPolicy,
  SqliteProfileBackupDocument,
  SqliteProfileBackupMode,
  SqliteProfileBackupRestoreResult,
  SqliteProfileBundleDocument,
  SqliteProfileBundleEncryptionErrorCode,
  SqliteProfileBundleSchema,
  SqliteTaskTrajectoryRecord,
} from "./backup.js";
export {
  decryptSqliteProfileBundle,
  encryptSqliteProfileBundle,
  isSqliteEncryptedProfileBundle,
  parseSqliteProfileBackup,
  parseSqliteProfileBundle,
  serializeSqliteProfileBundle,
  SqliteProfileBundleEncryptionError,
} from "./backup.js";
export type {
  CreateSqliteServiceApiKeyInput,
  ListSqliteAutopilotRunsInput,
  ListSqliteServiceAuditInput,
  SqliteAutopilotRun,
  SqliteAutopilotRunInput,
  SqliteServiceApiKey,
  SqliteServiceApiKeyProfiles,
  SqliteServiceApiKeyScope,
  SqliteServiceApiKeyWithSecret,
  SqliteServiceAuditInput,
  SqliteServiceAuditRow,
  SqliteServiceProfileSummary,
} from "./service.js";

export interface SqliteMemoryStoreOptions {
  path: string;
  handle?: Database.Database;
  readonly?: boolean | undefined;
  fileMustExist?: boolean | undefined;
  encryption?: SqliteMemoryStoreEncryptionOptions | undefined;
  entityResolver?: EntityResolver | undefined;
  embeddingProvider?: EmbeddingProvider | EmbeddingProviderConfig | undefined;
  retrieval?: MemoryRetrievalConfig | undefined;
  forgetTargetParser?: SqliteForgetTargetParser | undefined;
}

export interface SqliteMemoryStoreEncryptionOptions {
  driver: typeof Database;
  key: string;
  pragmas?: string[] | undefined;
}

export interface SqliteMemoryStoreEncryptionStatus {
  encrypted: boolean;
  mode: "plaintext" | "host_driver";
}

export type SqliteMemoryStoreEncryptionErrorCode =
  | "encryption_handle_conflict"
  | "invalid_encryption_key"
  | "encryption_open_failed"
  | "encryption_key_failed"
  | "encryption_verify_failed";

export class SqliteMemoryStoreEncryptionError extends Error {
  readonly code: SqliteMemoryStoreEncryptionErrorCode;

  constructor(code: SqliteMemoryStoreEncryptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteMemoryStoreEncryptionError";
    this.code = code;
  }
}

export interface SqliteForgetTargetParserInput {
  query: string;
  reason?: string | undefined;
}

export type SqliteForgetTargetParser =
  | ((input: SqliteForgetTargetParserInput) => string[] | null | undefined)
  | {
      name?: string | undefined;
      parse(input: SqliteForgetTargetParserInput): string[] | null | undefined;
    };

export interface SqliteMemoryStore extends MemoryStore {
  listFailures(input: ListFailuresInput): FailureEventRecord[];
  encryptionStatus(): SqliteMemoryStoreEncryptionStatus;
  schemaVersion(): number;
  searchIndexStatus(): SearchIndexStatus;
  repairSearchIndex(input?: RepairSearchIndexInput): Promise<RepairSearchIndexResult> | RepairSearchIndexResult;
  searchAssociations(input: MemoryAssociationSearchInput): MemoryAssociationRecord[];
  rebuildAssociations(input?: RebuildAssociationsInput): RebuildAssociationsResult;
  readAuditSnapshot(): ReadAuditSnapshot;
  exportProfileBackup(input: ExportSqliteProfileBackupInput): SqliteProfileBackupDocument;
  restoreProfileBackup(input: RestoreSqliteProfileBackupInput): SqliteProfileBackupRestoreResult;
  exportProfileBundle(input: ExportSqliteProfileBackupInput): SqliteProfileBundleDocument;
  importProfileBundle(input: RestoreSqliteProfileBackupInput): SqliteProfileBackupRestoreResult;
  listTaskTrajectories(input: { profileId: string; limit?: number | undefined }): TaskTrajectoryRecord[];
  listGapCandidates(input: MemoryGapCandidateListInput): MemoryGapCandidateSearchResult[];
  recordProcedureDistillation(
    input: RecordProcedureDistillationInput,
  ): Promise<RecordProcedureDistillationResult> | RecordProcedureDistillationResult;
  applyEvolutionActions(input: EvolutionApplyStoreInput): EvolutionApplyStoreResult;
  revertEvolutionApplication(input: EvolutionRevertStoreInput): EvolutionRevertStoreResult;
  rollbackMemory(input: MemoryRollbackInput & { profileId: string }): MemoryRollbackResult;
  createServiceApiKey(input: CreateSqliteServiceApiKeyInput): SqliteServiceApiKeyWithSecret;
  listServiceApiKeys(): SqliteServiceApiKey[];
  revokeServiceApiKey(keyId: string): SqliteServiceApiKey | null;
  authenticateServiceApiKey(secret: string): SqliteServiceApiKey | null;
  serviceApiKeyCount(): number;
  recordServiceAudit(input: SqliteServiceAuditInput): void;
  listServiceAuditRows(input?: ListSqliteServiceAuditInput): SqliteServiceAuditRow[];
  pruneServiceAuditRows(retentionDays: number): number;
  listServiceProfiles(): SqliteServiceProfileSummary[];
  ensureServiceProfile(profileId: string): SqliteServiceProfileSummary;
  recordAutopilotRun(input: SqliteAutopilotRunInput): SqliteAutopilotRun;
  listAutopilotRuns(input?: ListSqliteAutopilotRunsInput): SqliteAutopilotRun[];
  pruneAutopilotRuns(retention: number, profileId?: string | undefined): number;
}

const READ_AUDIT_REVISION_TABLES = [
  "gmos_evidence_events",
  "gmos_memories",
  "gmos_world_beliefs",
  "gmos_failure_events",
  "gmos_task_trajectories",
  "gmos_associations",
  "gmos_gap_candidates",
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

const DAY_MS = 24 * 60 * 60 * 1000;

interface RawGapCandidate {
  kind: MemoryGapKind;
  subject: string;
  cue?: string | undefined;
  score: number;
  supportingRecordIds: string[];
  payload: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function contextSearchReference(asOf: string | undefined): string {
  return (asOf ? normalizeExplicitTemporalInstant(asOf) : null) ?? nowIso();
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

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

function laterInstantIso(current: string, candidate: string): string {
  const currentInstant = parseInstant(current);
  const candidateInstant = parseInstant(candidate);
  if (currentInstant === null) return candidateInstant === null ? current : candidate;
  if (candidateInstant === null) return current;
  return candidateInstant > currentInstant ? candidate : current;
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
    recallCount: Number(row.recall_count ?? 0),
    lastRecalledAt: row.last_recalled_at == null ? null : String(row.last_recalled_at),
    reinforcement: Number(row.reinforcement ?? 0),
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

function memoryVersionSnapshot(memory: MemoryRecord): MemoryVersionSnapshot {
  return {
    memoryId: memory.id,
    profileId: memory.profileId,
    kind: memory.kind,
    scope: memory.scope,
    content: memory.content,
    sensitivity: memory.sensitivity,
    status: memory.status,
    confidence: memory.confidence,
    recallCount: memory.recallCount ?? 0,
    lastRecalledAt: memory.lastRecalledAt ?? null,
    reinforcement: memory.reinforcement ?? 0,
    sourceEventId: memory.sourceEventId ?? null,
    metadata: memory.metadata,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function memorySnapshotFromRow(row: Record<string, unknown>): MemoryVersionSnapshot {
  return memoryVersionSnapshot(normalizeMemory(row));
}

function memoryVersionSnapshotFromPayload(value: unknown): MemoryVersionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  if (
    typeof record.memoryId !== "string" ||
    typeof record.profileId !== "string" ||
    typeof record.kind !== "string" ||
    typeof record.scope !== "string" ||
    typeof record.content !== "string" ||
    typeof record.sensitivity !== "string" ||
    typeof record.status !== "string" ||
    typeof record.confidence !== "number" ||
    typeof record.recallCount !== "number" ||
    typeof record.reinforcement !== "number" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return null;
  }
  if (
    record.kind !== "fact" &&
    record.kind !== "preference" &&
    record.kind !== "boundary" &&
    record.kind !== "procedure" &&
    record.kind !== "project" &&
    record.kind !== "person" &&
    record.kind !== "task_trajectory"
  ) {
    return null;
  }
  if (
    record.sensitivity !== "normal" &&
    record.sensitivity !== "sensitive" &&
    record.sensitivity !== "secret_like"
  ) {
    return null;
  }
  if (
    record.status !== "active" &&
    record.status !== "dormant" &&
    record.status !== "archived"
  ) {
    return null;
  }
  return {
    memoryId: record.memoryId,
    profileId: record.profileId,
    kind: record.kind,
    scope: record.scope,
    content: record.content,
    sensitivity: record.sensitivity,
    status: record.status,
    confidence: record.confidence,
    recallCount: record.recallCount,
    lastRecalledAt:
      typeof record.lastRecalledAt === "string" || record.lastRecalledAt === null
        ? record.lastRecalledAt
        : null,
    reinforcement: record.reinforcement,
    sourceEventId:
      typeof record.sourceEventId === "string" || record.sourceEventId === null
        ? record.sourceEventId
        : null,
    metadata: metadata as Record<string, unknown>,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function previousValuesFromPayload(payload: Record<string, unknown>): MemoryVersionSnapshot[] {
  const raw = payload.previousValues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const snapshot = memoryVersionSnapshotFromPayload(entry);
    return snapshot ? [snapshot] : [];
  });
}

function isSourceTrust(value: unknown): value is SourceTrust {
  return value === "user" || value === "agent" || value === "external";
}

function sourceTrustRank(value: SourceTrust | undefined): number {
  if (value === "user") return 3;
  if (value === "agent") return 2;
  if (value === "external") return 1;
  return 0;
}

function sourceTrustFromMetadata(metadata: Record<string, unknown>): SourceTrust | undefined {
  if (isSourceTrust(metadata.sourceTrust)) return metadata.sourceTrust;
  const sourceMetadata = metadata.sourceMetadata;
  if (sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata)) {
    const trust = (sourceMetadata as Record<string, unknown>).sourceTrust;
    if (isSourceTrust(trust)) return trust;
  }
  return undefined;
}

function memoryAnnealingRecord(memory: MemoryRecord): Record<string, unknown> | null {
  const annealing = memory.metadata.annealing;
  return annealing && typeof annealing === "object" && !Array.isArray(annealing)
    ? annealing as Record<string, unknown>
    : null;
}

function activeAnnealingRecord(memory: MemoryRecord): Record<string, unknown> | null {
  const annealing = memoryAnnealingRecord(memory);
  return annealing?.active === true ? annealing : null;
}

function effectiveMemoryConfidence(memory: MemoryRecord): number {
  const cap = Number(activeAnnealingRecord(memory)?.capConfidence);
  return Number.isFinite(cap) ? Math.min(memory.confidence, cap) : memory.confidence;
}

function evidenceRedactionStub(content: string, redactedAt: string): Record<string, unknown> {
  return {
    marker: "redacted_evidence_content",
    originalSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    originalLength: content.length,
    redactedAt,
  };
}

function memoryContentRedactionStub(content: string, redactedAt: string): Record<string, unknown> {
  return {
    marker: "redacted_memory_content",
    originalSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    originalLength: content.length,
    redactedAt,
  };
}

function evidenceIsRedacted(event: EvidenceEvent): boolean {
  const redaction = event.payload.redaction;
  return (
    event.content === "[redacted_evidence_content]" ||
    Boolean(
      redaction &&
      typeof redaction === "object" &&
      !Array.isArray(redaction) &&
      (redaction as Record<string, unknown>).marker === "redacted_evidence_content",
    )
  );
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

function normalizeGapCandidate(row: Record<string, unknown>): MemoryGapCandidate {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    kind: String(row.gap_kind) as MemoryGapKind,
    subject: String(row.subject),
    cue: row.cue == null ? undefined : String(row.cue),
    score: Number(row.score),
    supportingRecordIds: stringArrayFromUnknown(parseJsonArray(row.supporting_record_ids_json)),
    computedAt: String(row.computed_at),
    payload: parseJsonObject(row.payload_json),
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

function canonicalSubjectForBelief(
  belief: WorldBeliefRecord,
  resolver?: EntityResolver | undefined,
): string {
  const storedSubject = belief.subject.trim();
  if (storedSubject) return storedSubject;
  const existing = beliefEntityResolutionMetadata(belief).canonicalSubject;
  return typeof existing === "string" && existing.trim()
    ? existing.trim()
    : resolveWorldEntitySubject({
        subject: belief.subject,
        predicate: belief.predicate,
        aliases: beliefSubjectAliases(belief),
      }, resolver).canonicalSubject;
}

function publicEntityResolutionMetadata(
  resolution: EntityResolutionResult,
): Record<string, unknown> {
  const entityResolution = sanitizePublicPayloadRecord({
    entityResolution: entityResolutionMetadata(resolution),
  }).entityResolution;
  return entityResolution && typeof entityResolution === "object" && !Array.isArray(entityResolution)
    ? (entityResolution as Record<string, unknown>)
    : {};
}

function worldBeliefMetadata(input: {
  inputMetadata?: Record<string, unknown> | undefined;
  existingMetadata?: Record<string, unknown> | undefined;
  resolution: EntityResolutionResult;
}): Record<string, unknown> {
  const existing = input.existingMetadata ?? {};
  const sanitizedInput = sanitizePublicPayloadRecord(input.inputMetadata ?? {});
  const previousEntity = existing.entityResolution;
  const previousAliases =
    previousEntity && typeof previousEntity === "object" && !Array.isArray(previousEntity)
      ? stringArrayFromUnknown((previousEntity as Record<string, unknown>).aliases)
      : [];
  const entityResolution = publicEntityResolutionMetadata({
    ...input.resolution,
    aliases: uniqueStrings([...previousAliases, ...input.resolution.aliases]),
  });
  return {
    ...existing,
    ...sanitizedInput,
    entityResolution,
  };
}

function normalizeTaskTrajectory(row: Record<string, unknown>): TaskTrajectoryRecord {
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
  const confidence = effectiveMemoryConfidence(memory);
  const terms = queryTerms(query);
  if (terms.length === 0) return confidence;
  const lower = memory.content.toLowerCase();
  const hits = terms.filter((term) => lower.includes(term)).length;
  return hits + confidence;
}

function matchedMemorySearchCues(memory: MemoryRecord, query: string): string[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const lower = [
    memory.kind,
    memory.scope,
    memory.content,
    JSON.stringify(memory.metadata),
  ].join(" ").toLowerCase();
  return terms.filter((term) => lower.includes(term)).slice(0, 12);
}

function memorySearchTags(memory: MemoryRecord): string[] {
  const tags: string[] = [memory.kind];
  for (const key of [
    "actionPolicyKind",
    "predicate",
    "source",
    "consolidationSource",
    "distillationSource",
    "dossierSource",
    "dossierKind",
  ]) {
    const value = memory.metadata[key];
    if (typeof value === "string" && value.trim().length > 0) tags.push(value.trim());
  }
  const sharedTags = memory.metadata.sharedTags;
  if (Array.isArray(sharedTags)) {
    tags.push(...sharedTags.filter((entry): entry is string => typeof entry === "string"));
  }
  return uniqueStrings(tags).slice(0, 12);
}

function memorySearchAssociations(memory: MemoryRecord): string[] {
  const associations = [];
  const sourceMemoryIds = memory.metadata.sourceMemoryIds;
  if (Array.isArray(sourceMemoryIds) && sourceMemoryIds.length > 0) {
    associations.push("consolidation_sources");
  }
  if (memory.metadata.consolidatedInto) associations.push("consolidated_into");
  if (memory.metadata.supersededBy) associations.push("superseded_by");
  if (memory.sourceEventId) associations.push("source_evidence");
  return associations;
}

function memorySearchScoreComponents(input: {
  memory: MemoryRecord;
  query: string;
  retrievalScore: number;
  ftsScore?: number | undefined;
  vectorScore?: number | undefined;
  associationScore?: number | undefined;
  fusionScore?: number | undefined;
}): MemorySearchScoreComponents {
  const confidence = effectiveMemoryConfidence(input.memory);
  const contentScore = input.query
    ? scoreMemory(input.memory, input.query)
    : confidence;
  const finalScore = input.query
    ? Math.max(contentScore, confidence + input.retrievalScore)
    : confidence;
  const sourceTrust = sourceTrustFromMetadata(input.memory.metadata);
  const annealing = activeAnnealingRecord(input.memory);
  return {
    confidence,
    retrievalScore: input.retrievalScore,
    contentScore,
    ...(input.ftsScore !== undefined ? { ftsScore: input.ftsScore } : {}),
    ...(input.vectorScore !== undefined ? { vectorScore: input.vectorScore } : {}),
    ...(input.associationScore !== undefined ? { associationScore: input.associationScore } : {}),
    ...(input.fusionScore !== undefined ? { fusionScore: input.fusionScore } : {}),
    ...(sourceTrust ? { sourceTrust } : {}),
    ...(annealing
      ? {
          annealing: {
            active: true,
            reason: typeof annealing.reason === "string" ? annealing.reason : "confidence_annealing",
            ...(sourceTrust ? { sourceTrust } : {}),
            ...(typeof annealing.capConfidence === "number" ? { capConfidence: annealing.capConfidence } : {}),
            ...(typeof annealing.retentionCap === "number" ? { retentionCap: annealing.retentionCap } : {}),
            ...(typeof annealing.startedAt === "string" ? { startedAt: annealing.startedAt } : {}),
            ...(typeof annealing.confirmedAt === "string" ? { confirmedAt: annealing.confirmedAt } : {}),
          },
        }
      : {}),
    finalScore,
  };
}

function structuredForgetTargetTerms(targetTerms: string[] | undefined): string[] | null {
  if (targetTerms === undefined) return null;
  return queryTerms(targetTerms.join(" "));
}

function parsedForgetTargetTerms(
  parser: SqliteForgetTargetParser | undefined,
  input: SqliteForgetTargetParserInput,
): string[] | null {
  if (!parser) return null;
  try {
    const parsed = typeof parser === "function" ? parser(input) : parser.parse(input);
    if (parsed === null || parsed === undefined) return null;
    return queryTerms(parsed.join(" "));
  } catch {
    return null;
  }
}

function memoryMatchesForgetQuery(memory: MemoryRecord, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const lower = memory.content.toLowerCase();
  const tokens = new Set(queryTerms(memory.content));
  return terms.every((term) =>
    /\p{Script=Han}/u.test(term) ? lower.includes(term) : tokens.has(term),
  );
}

function scoreAssociation(association: MemoryAssociationRecord, query: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return association.confidence;
  const queryKey = associationCueKey(query);
  const associationKey = associationCueKey(association.cue);
  const termKeys = new Set(terms.map(associationCueKey).filter(Boolean));
  const haystack = [
    association.cue,
    association.tag,
    association.targetKind,
    association.targetSummary,
  ].join(" ").toLowerCase();
  const hits = terms.filter((term) => haystack.includes(term)).length;
  const exactCueScore = queryKey && queryKey === associationKey ? 8 : 0;
  const termCueScore = associationKey && termKeys.has(associationKey) ? 3 : 0;
  return hits + exactCueScore + termCueScore + association.confidence;
}

function limit(input: number | undefined, fallback: number, maximum: number): number {
  if (input === undefined) return fallback;
  return Math.max(1, Math.min(Math.trunc(input), maximum));
}

function reciprocalRank(rank: number): number {
  return 1 / (60 + Math.max(1, rank));
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function attachInternalFusionScore(
  memory: MemoryRecord,
  fusionScore: number | undefined,
): MemoryRecord {
  if (fusionScore === undefined) return memory;
  Object.defineProperty(memory, "__gmosFusionScore", {
    value: fusionScore,
    enumerable: false,
    configurable: true,
  });
  return memory;
}

function visibleMemory(input: {
  memory: MemoryRecord;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}): boolean {
  if (!input.includePerson && input.memory.kind === "person") return false;
  return !shouldHideFromOrdinaryContext({
    sensitivity: effectiveMemorySensitivity(input.memory),
    includeSensitive: input.includeSensitive,
  });
}

function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  if (left === "secret_like" || right === "secret_like") return "secret_like";
  if (left === "sensitive" || right === "sensitive") return "sensitive";
  return "normal";
}

function effectiveMemorySensitivity(memory: MemoryRecord): Sensitivity {
  return maxSensitivity(
    memory.sensitivity,
    classifySensitivity([memory.content, memory.sourceEventId ?? ""].join(" ")),
  );
}

function effectiveEvidenceSensitivity(event: EvidenceEvent): Sensitivity {
  const sourceTypeSensitivity =
    classifySensitivity(event.sourceType) === "secret_like" ? "secret_like" : "normal";
  return maxSensitivity(
    maxSensitivity(event.sensitivity, sourceTypeSensitivity),
    classifySensitivity(
      [
        event.id,
        event.eventKey,
        event.profileId,
        event.sourceUri ?? "",
        event.content,
        event.sensitivity,
        JSON.stringify(event.payload),
        event.createdAt,
      ].join(" "),
    ),
  );
}

function visibleAssociation(input: {
  association: MemoryAssociationRecord;
  includeSensitive?: boolean | undefined;
  includePerson?: boolean | undefined;
}): boolean {
  if (!input.includePerson && input.association.targetKind === "person") return false;
  return !shouldHideFromOrdinaryContext({
    sensitivity: effectiveAssociationSensitivity(input.association),
    includeSensitive: input.includeSensitive,
  });
}

function effectiveAssociationSensitivity(association: MemoryAssociationRecord): Sensitivity {
  return maxSensitivity(
    association.sensitivity,
    classifySensitivity(
      [
        association.id,
        association.profileId,
        association.cue,
        association.cueKind,
        association.tag,
        association.targetType,
        association.targetId,
        association.targetKind,
        association.targetSummary,
        association.sensitivity,
        association.status,
        association.sourceMemoryId ?? "",
        association.sourceBeliefId ?? "",
        association.sourceTaskTrajectoryId ?? "",
        association.sourceEvidenceId ?? "",
        association.createdAt,
        association.updatedAt,
      ].join(" "),
    ),
  );
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

function lifecycleReachableStatusSql(
  purpose: MemorySearchInput["purpose"] | MemoryAssociationSearchInput["purpose"] | undefined,
): string {
  return purpose === "history" || purpose === "delete" || purpose === "manage"
    ? "status IN ('active', 'dormant')"
    : "status = 'active'";
}

function lifecycleReachableAliasStatusSql(
  alias: string,
  purpose: MemorySearchInput["purpose"] | MemoryAssociationSearchInput["purpose"] | undefined,
): string {
  return purpose === "history" || purpose === "delete" || purpose === "manage"
    ? `${alias}.status IN ('active', 'dormant')`
    : `${alias}.status = 'active'`;
}

function incrementSkipped(
  skipped: Map<string, number>,
  reason: string,
  count = 1,
): void {
  skipped.set(reason, (skipped.get(reason) ?? 0) + count);
}

function skippedSummaries(skipped: Map<string, number>): MaintenanceSkippedSummary[] {
  return [...skipped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
}

function daysBetween(start: string, end: string): number | null {
  const startInstant = Date.parse(start);
  const endInstant = Date.parse(end);
  if (!Number.isFinite(startInstant) || !Number.isFinite(endInstant)) return null;
  return Math.max(0, (endInstant - startInstant) / (24 * 60 * 60 * 1000));
}

function databaseFileGroup(pathname: string): string[] {
  return pathname === ":memory:" ? [] : [pathname, `${pathname}-wal`, `${pathname}-shm`];
}

function cleanupCreatedDatabaseFiles(before: Map<string, boolean>): void {
  for (const [file, existed] of before) {
    if (existed || !existsSync(file)) continue;
    try {
      unlinkSync(file);
    } catch {
      // Best effort only. The primary guarantee is that pre-existing files are never removed.
    }
  }
}

function validateEncryptionKey(key: string): void {
  if (key.length === 0 || /['"`\p{Cc}]/u.test(key)) {
    throw new SqliteMemoryStoreEncryptionError(
      "invalid_encryption_key",
      "gmOS SQLite encryption key must be non-empty and must not contain quotes or control characters",
    );
  }
}

function sqliteQuotedString(db: Database.Database, value: string): string {
  const row = db
    .prepare("SELECT quote(?) AS value")
    .get(value) as { value?: string } | undefined;
  if (!row?.value || !/^'.*'$/u.test(row.value)) {
    throw new SqliteMemoryStoreEncryptionError(
      "encryption_key_failed",
      "gmOS SQLite encryption driver could not parameterize PRAGMA key",
    );
  }
  return row.value;
}

function openEncryptedDatabase(
  pathname: string,
  sqliteOptions: Database.Options,
  encryption: SqliteMemoryStoreEncryptionOptions,
): Database.Database {
  validateEncryptionKey(encryption.key);
  const before = new Map(databaseFileGroup(pathname).map((file) => [file, existsSync(file)]));
  let db: Database.Database;
  try {
    db = new encryption.driver(pathname, sqliteOptions);
  } catch (error) {
    cleanupCreatedDatabaseFiles(before);
    throw new SqliteMemoryStoreEncryptionError(
      "encryption_open_failed",
      "gmOS SQLite encryption driver failed to open the database",
      { cause: error },
    );
  }
  try {
    db.exec(`PRAGMA key = ${sqliteQuotedString(db, encryption.key)}`);
    for (const pragma of encryption.pragmas ?? []) {
      db.exec(pragma);
    }
  } catch (error) {
    try {
      db.close();
    } finally {
      cleanupCreatedDatabaseFiles(before);
    }
    throw new SqliteMemoryStoreEncryptionError(
      "encryption_key_failed",
      "gmOS SQLite encryption driver failed while applying key or cipher pragmas",
      { cause: error },
    );
  }
  try {
    db.prepare("SELECT count(*) AS count FROM sqlite_master").get();
  } catch (error) {
    try {
      db.close();
    } finally {
      cleanupCreatedDatabaseFiles(before);
    }
    throw new SqliteMemoryStoreEncryptionError(
      "encryption_verify_failed",
      "gmOS SQLite encryption driver could not read the database with the supplied key",
      { cause: error },
    );
  }
  return db;
}

export function createSqliteMemoryStore(options: SqliteMemoryStoreOptions): SqliteMemoryStore {
  if (options.handle && options.encryption) {
    throw new SqliteMemoryStoreEncryptionError(
      "encryption_handle_conflict",
      "gmOS SQLite encryption opens the database through the supplied driver and cannot be combined with handle",
    );
  }
  const sqliteOptions: Database.Options = {};
  if (options.readonly !== undefined) sqliteOptions.readonly = options.readonly;
  if (options.fileMustExist !== undefined) sqliteOptions.fileMustExist = options.fileMustExist;
  const db =
    options.handle ??
    (options.encryption
      ? openEncryptedDatabase(options.path, sqliteOptions, options.encryption)
      : new Database(options.path, sqliteOptions));
  const encrypted = options.encryption !== undefined;
  const resolveEntity = (input: Parameters<typeof resolveWorldEntitySubject>[0]): EntityResolutionResult =>
    resolveWorldEntitySubject(input, options.entityResolver);
  let embeddingProvider = resolveEmbeddingProviderConfig(options.embeddingProvider);
  const retrievalConfig = options.retrieval;
  let initialized = false;
  let ftsAvailableCache: boolean | null = null;
  let vectorIndexAvailableCache: boolean | null = null;
  const statementCache = new Map<string, Database.Statement>();

  function statement(sql: string): Database.Statement {
    const cached = statementCache.get(sql);
    if (cached) return cached;
    const prepared = db.prepare(sql);
    statementCache.set(sql, prepared);
    return prepared;
  }

  function configureEmbeddingProvider(
    input: EmbeddingProvider | EmbeddingProviderConfig | undefined,
  ): void {
    embeddingProvider = resolveEmbeddingProviderConfig(input);
  }

  function initialize(): void {
    if (initialized) return;
    if (db.readonly) {
      ftsAvailableCache = tableExists("gmos_memories_fts");
      vectorIndexAvailableCache = tableExists("gmos_memory_vectors");
      initialized = true;
      return;
    }
    const previousSchemaVersion = sqliteSchemaVersion(db);
    const shouldRebuildAssociations =
      previousSchemaVersion < 7 || !schemaMigrationApplied(7);
    const shouldRebuildMemoryVectorIndex =
      previousSchemaVersion < 5 || !schemaMigrationApplied(5);
    ensureSqliteSchema(db);
    ftsAvailableCache = tableExists("gmos_memories_fts");
    vectorIndexAvailableCache = tableExists("gmos_memory_vectors");
    initialized = true;
    if (shouldRebuildAssociations) {
      rebuildAssociations();
    }
    if (shouldRebuildMemoryVectorIndex) {
      rebuildMemoryVectorIndex();
    }
  }

  function tableExists(table: string): boolean {
    const row = statement("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    return row?.name === table;
  }

  function schemaMigrationApplied(version: number): boolean {
    if (!tableExists("gmos_schema_migrations")) return false;
    const row = statement("SELECT version FROM gmos_schema_migrations WHERE version = ?")
      .get(version) as { version?: number } | undefined;
    return row?.version === version;
  }

  function ftsAvailable(): boolean {
    return ftsAvailableCache ?? tableExists("gmos_memories_fts");
  }

  function vectorIndexAvailable(): boolean {
    return vectorIndexAvailableCache ?? tableExists("gmos_memory_vectors");
  }

  function syncMemoryVector(memoryId: string, embeddingInput?: MemoryVectorEmbedding | undefined): void {
    if (!vectorIndexAvailable()) return;
    const existing = statement("SELECT * FROM gmos_memory_vectors WHERE id = ?")
      .get(memoryId) as Record<string, unknown> | undefined;
    statement("DELETE FROM gmos_memory_vector_terms WHERE id = ?").run(memoryId);
    const row = statement(
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
    if (!row) {
      statement("DELETE FROM gmos_memory_vectors WHERE id = ?").run(memoryId);
      return;
    }
    const contentHash = vectorContentHash(row.content);
    const embedding =
      embeddingInput ??
      preservedMemoryEmbedding(existing, contentHash) ??
      localMemoryEmbedding(
        row.content,
        memoryEligibleForEmbeddingProvider({
          provider: embeddingProvider,
          kind: memoryKindForVector(row.id),
          sensitivity: memorySensitivityForVector(row.id),
          content: row.content,
        })
          ? "pending"
          : "embedded",
      );
    const storedEmbedding = validateStoredEmbedding(embedding);
    statement(
      `INSERT INTO gmos_memory_vectors(
        id, profile_id, status, provider_name, embedding_status, dimensions,
        vector_json, content_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile_id = excluded.profile_id,
        status = excluded.status,
        provider_name = excluded.provider_name,
        embedding_status = excluded.embedding_status,
        dimensions = excluded.dimensions,
        vector_json = excluded.vector_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at`,
    ).run(
      row.id,
      row.profile_id,
      row.status,
      storedEmbedding.providerName,
      storedEmbedding.status,
      storedEmbedding.dimensions,
      JSON.stringify(storedEmbedding.vector),
      contentHash,
      row.updated_at,
    );
    const termStmt = statement(
      `INSERT OR IGNORE INTO gmos_memory_vector_terms(
        id, profile_id, status, feature_key, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const feature of localTextCandidateFeatures(row.content)) {
      termStmt.run(row.id, row.profile_id, row.status, feature, row.updated_at);
    }
  }

  function preservedMemoryEmbedding(
    row: Record<string, unknown> | undefined,
    contentHash: string,
  ): MemoryVectorEmbedding | null {
    if (!row || row.content_hash !== contentHash) return null;
    const vector = parseJsonArray(row.vector_json);
    const dimensions = Number(row.dimensions ?? 0);
    if (vector.length !== dimensions || dimensions <= 0) return null;
    return {
      providerName: String(row.provider_name ?? LOCAL_TEXT_VECTOR_PROVIDER),
      dimensions,
      vector,
      status: row.embedding_status === "pending" ? "pending" : "embedded",
    };
  }

  function memoryKindForVector(memoryId: string): MemoryKind {
    const row = statement("SELECT kind FROM gmos_memories WHERE id = ?")
      .get(memoryId) as { kind?: string } | undefined;
    return (row?.kind ?? "fact") as MemoryKind;
  }

  function memorySensitivityForVector(memoryId: string): Sensitivity {
    const row = statement("SELECT sensitivity FROM gmos_memories WHERE id = ?")
      .get(memoryId) as { sensitivity?: string } | undefined;
    return (row?.sensitivity ?? "normal") as Sensitivity;
  }

  async function embeddingForWrite(input: {
    kind: MemoryKind;
    sensitivity?: Sensitivity | undefined;
    content: string;
    embedding?: MemoryVectorEmbedding | undefined;
  }): Promise<MemoryVectorEmbedding> {
    return (await embeddingsForWriteBatch([input]))[0]!;
  }

  async function embeddingsForWriteBatch(
    inputs: Array<{
      kind: MemoryKind;
      sensitivity?: Sensitivity | undefined;
      content: string;
      embedding?: MemoryVectorEmbedding | undefined;
    }>,
  ): Promise<MemoryVectorEmbedding[]> {
    const embeddings = new Array<MemoryVectorEmbedding>(inputs.length);
    const pending: Array<{
      index: number;
      kind: MemoryKind;
      sensitivity: Sensitivity;
      content: string;
    }> = [];
    for (const [index, input] of inputs.entries()) {
      if (input.embedding) {
        embeddings[index] = validateStoredEmbedding(input.embedding);
      } else {
        pending.push({
          index,
          kind: input.kind,
          sensitivity: input.sensitivity ?? "normal",
          content: input.content,
        });
      }
    }
    if (pending.length > 0) {
      const embedded = await embeddingsForMemories({
        provider: embeddingProvider,
        memories: pending,
      });
      for (const [offset, pendingInput] of pending.entries()) {
        embeddings[pendingInput.index] = embedded.embeddings[offset]!;
      }
    }
    return embeddings;
  }

  function rebuildMemoryVectorIndex(): void {
    if (!vectorIndexAvailable()) return;
    statement("DELETE FROM gmos_memory_vectors").run();
    statement("DELETE FROM gmos_memory_vector_terms").run();
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

  function deleteAssociationsForMemory(memoryId: string): void {
    if (!tableExists("gmos_associations")) return;
    statement("DELETE FROM gmos_associations WHERE source_memory_id = ? OR target_id = ?").run(
      memoryId,
      memoryId,
    );
  }

  function deleteAssociationsForBelief(beliefId: string): void {
    if (!tableExists("gmos_associations")) return;
    statement("DELETE FROM gmos_associations WHERE source_belief_id = ?").run(beliefId);
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
    statement(
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
  }

  function projectMemoryAssociations(
    memory: MemoryRecord,
    options: { replaceExisting?: boolean | undefined } = {},
  ): void {
    if (options.replaceExisting !== false) deleteAssociationsForMemory(memory.id);
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
    const targetSummary = associationSummaryForBelief(belief);
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

  function projectBeliefsForMemory(memoryId: string): void {
    if (!tableExists("gmos_world_beliefs")) return;
    const rows = db
      .prepare(
        `SELECT * FROM gmos_world_beliefs
         WHERE source_memory_id = ? AND status = 'active'`,
      )
      .all(memoryId) as Record<string, unknown>[];
    for (const row of rows) {
      projectBeliefAssociations(normalizeWorldBelief(row));
    }
  }

  function insertLifecycleEvidence(input: {
    profileId: string;
    sourceType: "maintenance" | "memory.lifecycle";
    memoryId: string;
    from: MemoryRecord["status"];
    to: MemoryRecord["status"];
    createdAt: string;
    retention?: number | undefined;
    reasons: string[];
    previousValues?: MemoryVersionSnapshot[] | undefined;
  }): void {
    db.prepare(
      `INSERT INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'normal', 0, ?, ?)`,
    ).run(
      id("evidence"),
      [
        input.sourceType,
        input.profileId,
        input.memoryId,
        input.from,
        input.to,
        input.createdAt,
        randomUUID(),
      ].join(":"),
      input.profileId,
      input.sourceType,
      null,
      `Memory lifecycle transition ${input.from} -> ${input.to}`,
      JSON.stringify({
        memoryId: input.memoryId,
        from: input.from,
        to: input.to,
        ...(input.retention !== undefined ? { retention: input.retention } : {}),
        reasons: input.reasons,
        ...(input.previousValues?.length ? { previousValues: input.previousValues } : {}),
      }),
      input.createdAt,
    );
  }

  function insertConsolidationEvidence(input: {
    profileId: string;
    survivorId: string;
    memberIds: string[];
    archivedMemberId: string;
    createdAt: string;
    reasons: string[];
    previousValues?: MemoryVersionSnapshot[] | undefined;
  }): void {
    db.prepare(
      `INSERT INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, 'consolidation', ?, ?, 'normal', 0, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        payload_json = excluded.payload_json`,
    ).run(
      id("evidence"),
      [
        "consolidation.duplicate",
        input.profileId,
        input.survivorId,
        input.archivedMemberId,
        input.createdAt,
      ].join(":"),
      input.profileId,
      null,
      "Memory duplicate consolidation",
      JSON.stringify({
        survivorId: input.survivorId,
        memberIds: input.memberIds,
        archivedMemberId: input.archivedMemberId,
        reasons: input.reasons,
        ...(input.previousValues?.length ? { previousValues: input.previousValues } : {}),
      }),
      input.createdAt,
    );
  }

  function memoryRowById(profileId: string, memoryId: string): Record<string, unknown> | null {
    return (
      db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ?")
      .get(profileId, memoryId) as Record<string, unknown> | undefined
    ) ?? null;
  }

  function attachPreviousValuesToEvidence(
    evidenceId: string | null | undefined,
    previousValues: MemoryVersionSnapshot[],
  ): void {
    if (!evidenceId || previousValues.length === 0) return;
    const row = db
      .prepare("SELECT payload_json FROM gmos_evidence_events WHERE id = ?")
      .get(evidenceId) as { payload_json?: string } | undefined;
    if (!row) return;
    const payload = parseJsonObject(row.payload_json);
    const existing = previousValuesFromPayload(payload);
    const byMemoryId = new Map(existing.map((entry) => [entry.memoryId, entry]));
    for (const previous of previousValues) byMemoryId.set(previous.memoryId, previous);
    db.prepare("UPDATE gmos_evidence_events SET payload_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...payload,
        previousValues: [...byMemoryId.values()].sort((left, right) =>
          left.memoryId.localeCompare(right.memoryId)
        ),
      }),
      evidenceId,
    );
  }

  function insertMutationEvidence(input: {
    profileId: string;
    sourceType: string;
    content: string;
    createdAt: string;
    payload: Record<string, unknown>;
    previousValues: MemoryVersionSnapshot[];
  }): string {
    const evidenceId = id("evidence");
    db.prepare(
      `INSERT INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'normal', 0, ?, ?)`,
    ).run(
      evidenceId,
      [
        input.sourceType,
        input.profileId,
        input.createdAt,
        randomUUID(),
      ].join(":"),
      input.profileId,
      input.sourceType,
      null,
      input.content,
      JSON.stringify({
        ...input.payload,
        previousValues: input.previousValues,
      }),
      input.createdAt,
    );
    return evidenceId;
  }

  function applyMemorySnapshot(snapshot: MemoryVersionSnapshot): void {
    db.prepare(
      `UPDATE gmos_memories
       SET kind = ?,
           scope = ?,
           content = ?,
           sensitivity = ?,
           status = ?,
           confidence = ?,
           recall_count = ?,
           last_recalled_at = ?,
           reinforcement = ?,
           source_event_id = ?,
           metadata_json = ?,
           created_at = ?,
           updated_at = ?
       WHERE profile_id = ? AND id = ?`,
    ).run(
      snapshot.kind,
      snapshot.scope,
      snapshot.content,
      snapshot.sensitivity,
      snapshot.status,
      snapshot.confidence,
      snapshot.recallCount,
      snapshot.lastRecalledAt ?? null,
      snapshot.reinforcement,
      snapshot.sourceEventId ?? null,
      JSON.stringify(snapshot.metadata),
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.profileId,
      snapshot.memoryId,
    );
    syncMemoryVector(snapshot.memoryId);
    if (snapshot.status === "active") {
      activateMemoryProjections(snapshot.memoryId, snapshot.profileId);
      const row = memoryRowById(snapshot.profileId, snapshot.memoryId);
      if (row) syncBeliefsForMemory(normalizeMemory(row));
    } else {
      deactivateMemoryProjections(snapshot.memoryId);
      if (snapshot.status === "archived") rejectBeliefsForMemory(snapshot.memoryId, snapshot.updatedAt);
    }
  }

  function payloadStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  function payloadReferencesMemory(payload: Record<string, unknown>, memoryId: string): boolean {
    if (payload.memoryId === memoryId) return true;
    if (payload.archivedMemberId === memoryId) return true;
    if (payload.survivorId === memoryId) return true;
    if (payload.supersededMemoryId === memoryId) return true;
    if (payloadStringArray(payload.memoryIds).includes(memoryId)) return true;
    if (payloadStringArray(payload.propagatedMemoryIds).includes(memoryId)) return true;
    if (payloadStringArray(payload.usedMemoryIds).includes(memoryId)) return true;
    if (payloadStringArray(payload.relatedMemoryIds).includes(memoryId)) return true;
    if (payloadStringArray(payload.sourceMemoryIds).includes(memoryId)) return true;
    if (payloadStringArray(payload.memberIds).includes(memoryId)) return true;
    for (const key of ["actions", "previousValues", "restoredValues"]) {
      const values = payload[key];
      if (!Array.isArray(values)) continue;
      if (
        values.some(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).memoryId === memoryId,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function activateMemoryProjections(memoryId: string, profileId: string): void {
    const row = memoryRowById(profileId, memoryId);
    if (!row) return;
    const memory = normalizeMemory(row);
    projectMemoryAssociations(memory);
    projectBeliefsForMemory(memory.id);
  }

  function deactivateMemoryProjections(memoryId: string): void {
    deleteAssociationsForMemory(memoryId);
  }

  function derivedSourceMemoryIds(metadata: Record<string, unknown>): string[] {
    const sourceMemoryIds = metadata.sourceMemoryIds;
    return Array.isArray(sourceMemoryIds)
      ? sourceMemoryIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  }

  function derivedSummaryIdsForForgottenSources(
    profileId: string,
    sourceMemoryIds: string[],
  ): string[] {
    if (sourceMemoryIds.length === 0) return [];
    const sourceClosure = new Set(sourceMemoryIds);
    const derivedIds = new Set<string>();
    const rows = db
      .prepare(
        `SELECT id, metadata_json
         FROM gmos_memories
         WHERE profile_id = ? AND status IN ('active', 'dormant')`,
      )
      .all(profileId) as Array<{ id: string; metadata_json: string }>;
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (sourceClosure.has(row.id) || derivedIds.has(row.id)) continue;
        const metadata = parseJsonObject(row.metadata_json);
        if (metadata.consolidationSummary !== true && metadata.dossier !== true) continue;
        const summarySourceIds = derivedSourceMemoryIds(metadata);
        if (!summarySourceIds.some((sourceId) => sourceClosure.has(sourceId))) continue;
        derivedIds.add(row.id);
        sourceClosure.add(row.id);
        changed = true;
      }
    }
    return [...derivedIds].sort((left, right) => left.localeCompare(right));
  }

  function archiveForgetMemoryIds(input: {
    profileId: string;
    memoryIds: string[];
    derivedMemoryIds: string[];
    archivedAt: string;
  }): string[] {
    const orderedIds = [
      ...input.memoryIds,
      ...input.derivedMemoryIds.filter((memoryId) => !input.memoryIds.includes(memoryId)),
    ];
    if (orderedIds.length === 0) return [];
    const directIds = new Set(input.memoryIds);
    const rowStmt = db.prepare(
      `SELECT id, status, metadata_json
       FROM gmos_memories
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const updateStmt = db.prepare(
      `UPDATE gmos_memories
       SET status = 'archived', updated_at = ?, metadata_json = ?
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const archivedIds: string[] = [];
    const tx = db.transaction((memoryIds: string[]) => {
      for (const memoryId of memoryIds) {
        const row = rowStmt.get(input.profileId, memoryId) as
          | { id: string; status: MemoryRecord["status"]; metadata_json: string }
          | undefined;
        if (!row) continue;
        const fullRow = memoryRowById(input.profileId, memoryId);
        const previousValues = fullRow ? [memorySnapshotFromRow(fullRow)] : [];
        const reason = directIds.has(memoryId)
          ? "user_forget"
          : "derived_from_forgotten_source";
        const metadata = metadataWithArchiveMarker({
          metadata: parseJsonObject(row.metadata_json),
          archivedAt: input.archivedAt,
          reason,
        });
        const result = updateStmt.run(
          input.archivedAt,
          JSON.stringify(metadata),
          input.profileId,
          memoryId,
        );
        if (result.changes === 0) continue;
        archivedIds.push(memoryId);
        syncMemoryVector(memoryId);
        deleteAssociationsForMemory(memoryId);
        rejectBeliefsForMemory(memoryId, input.archivedAt);
        insertLifecycleEvidence({
          profileId: input.profileId,
          sourceType: "memory.lifecycle",
          memoryId,
          from: row.status,
          to: "archived",
          createdAt: input.archivedAt,
          reasons: [reason],
          previousValues,
        });
      }
    });
    tx(orderedIds);
    return archivedIds;
  }

  function redactEvidenceForForgottenMemories(input: {
    profileId: string;
    archivedMemoryIds: string[];
    redactedAt: string;
  }): number {
    if (input.archivedMemoryIds.length === 0) return 0;
    const evidenceRows = db
      .prepare(
        `SELECT DISTINCT e.*
         FROM gmos_memories m
         JOIN gmos_evidence_events e ON e.id = m.source_event_id
         WHERE m.profile_id = ?
           AND m.id IN (${input.archivedMemoryIds.map(() => "?").join(", ")})`,
      )
      .all(input.profileId, ...input.archivedMemoryIds) as Record<string, unknown>[];
    let redacted = 0;
    for (const row of evidenceRows) {
      const event = normalizeEvidence(row);
      if (evidenceIsRedacted(event)) continue;
      const surviving = db
        .prepare(
          `SELECT id
           FROM gmos_memories
           WHERE profile_id = ?
             AND source_event_id = ?
             AND status IN ('active', 'dormant')
           LIMIT 1`,
        )
        .get(input.profileId, event.id) as { id?: string } | undefined;
      if (surviving) continue;
      db.prepare(
        `UPDATE gmos_evidence_events
         SET content = ?, payload_json = ?
         WHERE id = ?`,
      ).run(
        "[redacted_evidence_content]",
        JSON.stringify({
          ...event.payload,
          redaction: evidenceRedactionStub(event.content, input.redactedAt),
        }),
        event.id,
      );
      redacted += 1;
    }
    const archivedIds = new Set(input.archivedMemoryIds);
    const payloadRows = db
      .prepare(
        `SELECT id, payload_json
         FROM gmos_evidence_events
         WHERE profile_id = ?
           AND (
             payload_json LIKE '%previousValues%' OR
             payload_json LIKE '%restoredValues%'
           )`,
      )
      .all(input.profileId) as Array<{ id: string; payload_json: string }>;
    for (const row of payloadRows) {
      const payload = parseJsonObject(row.payload_json);
      let changed = false;
      const nextPayload = { ...payload };
      for (const key of ["previousValues", "restoredValues"]) {
        const values = payload[key];
        if (!Array.isArray(values)) continue;
        const nextValues = values.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
          const record = entry as Record<string, unknown>;
          if (!archivedIds.has(String(record.memoryId))) return entry;
          if (record.content === "[redacted_memory_content]") return entry;
          const content = typeof record.content === "string" ? record.content : "";
          changed = true;
          const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? record.metadata as Record<string, unknown>
            : {};
          return {
            ...record,
            content: "[redacted_memory_content]",
            metadata: {
              ...metadata,
              redaction: memoryContentRedactionStub(content, input.redactedAt),
            },
          };
        });
        nextPayload[key] = nextValues;
      }
      if (!changed) continue;
      db.prepare(
        `UPDATE gmos_evidence_events
         SET payload_json = ?
         WHERE id = ?`,
      ).run(JSON.stringify(nextPayload), row.id);
    }
    return redacted;
  }

  function recordMemoryUsageSignals(input: {
    profileId: string;
    memoryIds: string[] | undefined;
    usedAt: string;
  }): void {
    const uniqueIds = [...new Set((input.memoryIds ?? []).filter((entry) => entry.trim().length > 0))];
    if (uniqueIds.length === 0) return;
    const rowStmt = db.prepare(
      `SELECT *
       FROM gmos_memories
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const updateStmt = db.prepare(
      `UPDATE gmos_memories
       SET recall_count = recall_count + 1,
           last_recalled_at = ?,
           status = 'active',
           updated_at = ?
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const previousValues: MemoryVersionSnapshot[] = [];
    for (const memoryId of uniqueIds) {
      const row = rowStmt.get(input.profileId, memoryId) as Record<string, unknown> | undefined;
      if (!row) continue;
      const previousValue = memorySnapshotFromRow(row);
      previousValues.push(previousValue);
      updateStmt.run(input.usedAt, input.usedAt, input.profileId, memoryId);
      syncMemoryVector(memoryId);
      if (row.status === "dormant") {
        activateMemoryProjections(memoryId, input.profileId);
        insertLifecycleEvidence({
          profileId: input.profileId,
          sourceType: "memory.lifecycle",
          memoryId,
          from: "dormant",
          to: "active",
          createdAt: input.usedAt,
          reasons: ["used_memory_id"],
          previousValues: [previousValue],
        });
      }
    }
    if (previousValues.length > 0) {
      insertMutationEvidence({
        profileId: input.profileId,
        sourceType: "memory.usage",
        content: "Memory usage signal",
        createdAt: input.usedAt,
        payload: { memoryIds: uniqueIds },
        previousValues,
      });
    }
  }

  function uniqueMemoryIds(memoryIds: string[] | undefined): string[] {
    return [...new Set((memoryIds ?? []).filter((entry) => entry.trim().length > 0))];
  }

  function adjustMemoryReinforcementDelta(input: {
    profileId: string;
    memoryIds: string[] | undefined;
    delta: number;
    updatedAt: string;
    sourceType?: string | undefined;
    reason?: string | undefined;
    confidenceAnnealing?: ResolvedMemoryAnnealingConfig | undefined;
    writeEvidence?: boolean | undefined;
    allowAnnealing?: boolean | undefined;
  }): { evidenceId: string | null; previousValues: MemoryVersionSnapshot[] } {
    const uniqueIds = uniqueMemoryIds(input.memoryIds);
    if (uniqueIds.length === 0 || input.delta === 0) {
      return { evidenceId: null, previousValues: [] };
    }
    const stmt = db.prepare(
      `UPDATE gmos_memories
       SET reinforcement = CASE
             WHEN reinforcement + ? > 1 THEN 1
             WHEN reinforcement + ? < -1 THEN -1
             ELSE reinforcement + ?
           END,
           updated_at = ?
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const rowStmt = db.prepare(
      `SELECT *
       FROM gmos_memories
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const previousValues: MemoryVersionSnapshot[] = [];
    for (const memoryId of uniqueIds) {
      const row = rowStmt.get(input.profileId, memoryId) as Record<string, unknown> | undefined;
      if (!row) continue;
      const result = stmt.run(
        input.delta,
        input.delta,
        input.delta,
        input.updatedAt,
        input.profileId,
        memoryId,
      );
      if (result.changes > 0) {
        previousValues.push(memorySnapshotFromRow(row));
        if (input.delta > 0 && input.allowAnnealing !== false) {
          annealRapidBoostIfNeeded({
            profileId: input.profileId,
            memoryId,
            previousRow: row,
            boostedAt: input.updatedAt,
            config: input.confidenceAnnealing,
          });
        }
        syncMemoryVector(memoryId);
      }
    }
    let evidenceId: string | null = null;
    if (previousValues.length > 0) {
      if (input.writeEvidence !== false) {
        evidenceId = insertMutationEvidence({
          profileId: input.profileId,
          sourceType: input.sourceType ?? "memory.reinforcement",
          content: "Memory reinforcement adjustment",
          createdAt: input.updatedAt,
          payload: {
            memoryIds: uniqueIds,
            delta: input.delta,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          previousValues,
        });
      }
    }
    return { evidenceId, previousValues };
  }

  function annealRapidBoostIfNeeded(input: {
    profileId: string;
    memoryId: string;
    previousRow: Record<string, unknown>;
    boostedAt: string;
    config?: ResolvedMemoryAnnealingConfig | undefined;
  }): void {
    const config = input.config ?? {
      enabled: true,
      windowMs: 60 * 60 * 1000,
      boostThreshold: 2,
      confidenceCap: 0.6,
      retentionCap: 0.45,
    };
    if (!config.enabled) return;
    const boostedAtMs = Date.parse(input.boostedAt);
    if (!Number.isFinite(boostedAtMs)) return;
    const sourceEventId =
      input.previousRow.source_event_id == null ? null : String(input.previousRow.source_event_id);
    if (!sourceEventId) return;
    const cutoff = new Date(boostedAtMs - config.windowMs).toISOString();
    const rows = db
      .prepare(
        `SELECT payload_json
         FROM gmos_evidence_events
         WHERE profile_id = ?
           AND source_type IN ('outcome', 'feedback', 'memory.reinforcement')
           AND created_at >= ?
           AND created_at <= ?`,
      )
      .all(input.profileId, cutoff, input.boostedAt) as Array<{ payload_json: string }>;
    let recentBoosts = 1;
    for (const row of rows) {
      const payload = parseJsonObject(row.payload_json);
      if (Number(payload.delta) <= 0) continue;
      if (!payloadStringArray(payload.memoryIds).includes(input.memoryId)) continue;
      recentBoosts += 1;
    }
    if (recentBoosts < config.boostThreshold) return;
    const metadata = parseJsonObject(input.previousRow.metadata_json);
    const existing = metadata.annealing;
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      (existing as Record<string, unknown>).active === true
    ) {
      return;
    }
    db.prepare(
      `UPDATE gmos_memories
       SET metadata_json = ?
       WHERE profile_id = ? AND id = ?`,
    ).run(
      JSON.stringify({
        ...metadata,
        annealing: {
          active: true,
          reason: "rapid_non_independent_boost",
          sourceEventId,
          capConfidence: Math.min(Number(input.previousRow.confidence ?? 0.5), config.confidenceCap),
          retentionCap: config.retentionCap,
          startedAt: input.boostedAt,
        },
      }),
      input.profileId,
      input.memoryId,
    );
  }

  function adjustMemoryReinforcement(input: {
    profileId: string;
    memoryIds: string[] | undefined;
    signal?: "positive" | "negative" | undefined;
    updatedAt: string;
    confidenceAnnealing?: ResolvedMemoryAnnealingConfig | undefined;
  }): void {
    if (!input.signal) return;
    const delta = input.signal === "positive" ? 0.2 : -0.2;
    adjustMemoryReinforcementDelta({
      profileId: input.profileId,
      memoryIds: input.memoryIds,
      delta,
      updatedAt: input.updatedAt,
      sourceType: "feedback",
      reason: input.signal,
      confidenceAnnealing: input.confidenceAnnealing,
    });
  }

  function adjustOutcomeReinforcement(input: {
    profileId: string;
    memoryIds: string[] | undefined;
    status: "completed" | "failed";
    failureKind?: FailureKind | undefined;
    config: CommitOutcomeStoreInput["outcomeReinforcement"];
    updatedAt: string;
    confidenceAnnealing?: ResolvedMemoryAnnealingConfig | undefined;
  }): { delta: number; evidenceId: string | null; previousValues: MemoryVersionSnapshot[] } {
    const config = input.config ?? { enabled: true, step: 0.1 };
    if (!config.enabled) return { delta: 0, evidenceId: null, previousValues: [] };
    const delta =
      input.status === "completed"
        ? config.step
        : input.failureKind === "wrong_recall" || input.failureKind === "missed_recall"
          ? -config.step
          : 0;
    const result = adjustMemoryReinforcementDelta({
      profileId: input.profileId,
      memoryIds: input.memoryIds,
      delta,
      updatedAt: input.updatedAt,
      sourceType: "outcome",
      reason: input.status,
      confidenceAnnealing: input.confidenceAnnealing,
    });
    return { delta, ...result };
  }

  type ProvenanceNonMemorySourceType = "task_trajectory" | "world_belief";

  interface ProvenanceMemoryCredit {
    id: string;
    hop: number;
    delta: number;
    path: string[];
    viaMemoryId: string;
    derivedFromMemoryId: string;
    nonIndependent: true;
  }

  interface ProvenanceNonMemoryCredit {
    id: string;
    sourceType: ProvenanceNonMemorySourceType;
    hop: number;
    wouldBeDelta: number;
    path: string[];
    viaMemoryId: string;
    derivedFromMemoryId: string;
  }

  function resolvedProvenanceCreditConfig(
    config: CommitOutcomeStoreInput["outcomeReinforcement"],
  ): ResolvedProvenanceCreditConfig {
    return config?.provenanceCredit ?? {
      enabled: true,
      hopDecay: 0.5,
      maxCreditDepth: 2,
      maxCreditFanout: 8,
    };
  }

  function roundedCreditDelta(delta: number, hopDecay: number): number {
    return Number((delta * hopDecay).toFixed(6));
  }

  function evidenceById(evidenceId: string | null | undefined): EvidenceEvent | null {
    if (!evidenceId) return null;
    const row = db
      .prepare("SELECT * FROM gmos_evidence_events WHERE id = ?")
      .get(evidenceId) as Record<string, unknown> | undefined;
    return row ? normalizeEvidence(row) : null;
  }

  function memorySourceEvidence(memory: MemoryRecord): EvidenceEvent | null {
    return evidenceById(memory.sourceEventId ?? null);
  }

  function memorySourceEvidenceIsRedacted(memory: MemoryRecord): boolean {
    const event = memorySourceEvidence(memory);
    return event ? evidenceIsRedacted(event) : false;
  }

  function memoryArchivedByForget(memory: MemoryRecord): boolean {
    if (memory.status !== "archived") return false;
    const archive = memory.metadata.archive;
    if (!archive || typeof archive !== "object" || Array.isArray(archive)) return false;
    const reason = (archive as Record<string, unknown>).reason;
    return reason === "user_forget" || reason === "derived_from_forgotten_source";
  }

  function memoryCanReceivePropagatedCredit(memory: MemoryRecord): boolean {
    if (memory.status !== "active" && memory.status !== "dormant") return false;
    if (memory.kind === "person") return false;
    if (memoryArchivedByForget(memory)) return false;
    return !memorySourceEvidenceIsRedacted(memory);
  }

  function sourceIdsFromMetadataAndEvidence(input: {
    memory: MemoryRecord;
    metadataKey: string;
    payloadKey: string;
  }): string[] {
    const event = memorySourceEvidence(input.memory);
    return uniqueStrings([
      ...stringArrayFromUnknown(input.memory.metadata[input.metadataKey]),
      ...stringArrayFromUnknown(event ? event.payload[input.payloadKey] : undefined),
    ]).sort((left, right) => left.localeCompare(right));
  }

  function derivedProvenance(memory: MemoryRecord): {
    sourceMemoryIds: string[];
    sourceBeliefIds: string[];
    sourceTrajectoryIds: string[];
  } | null {
    const event = memorySourceEvidence(memory);
    if (event && evidenceIsRedacted(event)) return null;
    const derived =
      memory.metadata.consolidationSummary === true ||
      memory.metadata.dossier === true ||
      memory.metadata.procedureDistillation === true ||
      event?.sourceType === "consolidation" ||
      event?.sourceType === "dossier" ||
      event?.sourceType === "distillation";
    if (!derived) return null;
    const provenance = {
      sourceMemoryIds: sourceIdsFromMetadataAndEvidence({
        memory,
        metadataKey: "sourceMemoryIds",
        payloadKey: "sourceMemoryIds",
      }),
      sourceBeliefIds: sourceIdsFromMetadataAndEvidence({
        memory,
        metadataKey: "sourceBeliefIds",
        payloadKey: "sourceBeliefIds",
      }),
      sourceTrajectoryIds: sourceIdsFromMetadataAndEvidence({
        memory,
        metadataKey: "sourceTrajectoryIds",
        payloadKey: "sourceTrajectoryIds",
      }),
    };
    return provenance.sourceMemoryIds.length > 0 ||
      provenance.sourceBeliefIds.length > 0 ||
      provenance.sourceTrajectoryIds.length > 0
      ? provenance
      : null;
  }

  function sourceMemoriesForFanout(
    profileId: string,
    sourceMemoryIds: string[],
    maxCreditFanout: number,
  ): MemoryRecord[] {
    return sourceMemoryIds
      .flatMap((memoryId) => {
        const row = memoryRowById(profileId, memoryId);
        return row ? [normalizeMemory(row)] : [];
      })
      .sort((left, right) => {
        const confidence = right.confidence - left.confidence;
        if (confidence !== 0) return confidence;
        const updatedAt = right.updatedAt.localeCompare(left.updatedAt);
        if (updatedAt !== 0) return updatedAt;
        const createdAt = right.createdAt.localeCompare(left.createdAt);
        if (createdAt !== 0) return createdAt;
        return left.id.localeCompare(right.id);
      })
      .slice(0, maxCreditFanout);
  }

  function nonMemoryCreditsFor(
    input: {
      sourceIds: string[];
      sourceType: ProvenanceNonMemorySourceType;
      hop: number;
      delta: number;
      path: string[];
      viaMemoryId: string;
      derivedFromMemoryId: string;
      maxCreditFanout: number;
    },
  ): ProvenanceNonMemoryCredit[] {
    return input.sourceIds
      .slice(0, input.maxCreditFanout)
      .map((sourceId) => ({
        id: sourceId,
        sourceType: input.sourceType,
        hop: input.hop,
        wouldBeDelta: input.delta,
        path: [...input.path, sourceId],
        viaMemoryId: input.viaMemoryId,
        derivedFromMemoryId: input.derivedFromMemoryId,
      }));
  }

  function collectProvenanceCredit(input: {
    profileId: string;
    rootMemoryIds: string[] | undefined;
    delta: number;
    config: ResolvedProvenanceCreditConfig;
  }): { memoryCredits: ProvenanceMemoryCredit[]; nonMemoryCredits: ProvenanceNonMemoryCredit[] } {
    if (
      !input.config.enabled ||
      input.delta === 0 ||
      input.config.hopDecay === 0 ||
      input.config.maxCreditDepth <= 0
    ) {
      return { memoryCredits: [], nonMemoryCredits: [] };
    }
    const memoryCredits: ProvenanceMemoryCredit[] = [];
    const nonMemoryCredits: ProvenanceNonMemoryCredit[] = [];
    const creditedMemoryIds = new Set<string>();
    const queue = uniqueMemoryIds(input.rootMemoryIds).flatMap((memoryId) => {
      const row = memoryRowById(input.profileId, memoryId);
      if (!row) return [];
      const memory = normalizeMemory(row);
      if (memory.status !== "active" && memory.status !== "dormant") return [];
      return [{
        memory,
        hop: 0,
        delta: input.delta,
        path: [memory.id],
        derivedFromMemoryId: memory.id,
      }];
    });
    for (const item of queue) {
      if (item.hop >= input.config.maxCreditDepth) continue;
      const provenance = derivedProvenance(item.memory);
      if (!provenance) continue;
      const hop = item.hop + 1;
      const delta = roundedCreditDelta(item.delta, input.config.hopDecay);
      if (delta === 0) continue;
      for (const source of sourceMemoriesForFanout(
        input.profileId,
        provenance.sourceMemoryIds,
        input.config.maxCreditFanout,
      )) {
        if (!memoryCanReceivePropagatedCredit(source)) continue;
        if (creditedMemoryIds.has(source.id)) continue;
        creditedMemoryIds.add(source.id);
        const path = [...item.path, source.id];
        memoryCredits.push({
          id: source.id,
          hop,
          delta,
          path,
          viaMemoryId: item.memory.id,
          derivedFromMemoryId: item.derivedFromMemoryId,
          nonIndependent: true,
        });
        if (hop < input.config.maxCreditDepth && derivedProvenance(source)) {
          queue.push({
            memory: source,
            hop,
            delta,
            path,
            derivedFromMemoryId: item.derivedFromMemoryId,
          });
        }
      }
      nonMemoryCredits.push(
        ...nonMemoryCreditsFor({
          sourceIds: provenance.sourceTrajectoryIds,
          sourceType: "task_trajectory",
          hop,
          delta,
          path: item.path,
          viaMemoryId: item.memory.id,
          derivedFromMemoryId: item.derivedFromMemoryId,
          maxCreditFanout: input.config.maxCreditFanout,
        }),
        ...nonMemoryCreditsFor({
          sourceIds: provenance.sourceBeliefIds,
          sourceType: "world_belief",
          hop,
          delta,
          path: item.path,
          viaMemoryId: item.memory.id,
          derivedFromMemoryId: item.derivedFromMemoryId,
          maxCreditFanout: input.config.maxCreditFanout,
        }),
      );
    }
    memoryCredits.sort((left, right) =>
      [
        left.hop.toString().padStart(4, "0"),
        left.derivedFromMemoryId,
        left.viaMemoryId,
        left.id,
      ].join(":").localeCompare([
        right.hop.toString().padStart(4, "0"),
        right.derivedFromMemoryId,
        right.viaMemoryId,
        right.id,
      ].join(":"))
    );
    nonMemoryCredits.sort((left, right) =>
      [
        left.hop.toString().padStart(4, "0"),
        left.sourceType,
        left.derivedFromMemoryId,
        left.viaMemoryId,
        left.id,
      ].join(":").localeCompare([
        right.hop.toString().padStart(4, "0"),
        right.sourceType,
        right.derivedFromMemoryId,
        right.viaMemoryId,
        right.id,
      ].join(":"))
    );
    return { memoryCredits, nonMemoryCredits };
  }

  function applyProvenanceCredit(input: {
    profileId: string;
    rootMemoryIds: string[] | undefined;
    delta: number;
    updatedAt: string;
    config: ResolvedProvenanceCreditConfig;
  }): {
    memoryCredits: ProvenanceMemoryCredit[];
    nonMemoryCredits: ProvenanceNonMemoryCredit[];
    previousValues: MemoryVersionSnapshot[];
  } {
    const { memoryCredits, nonMemoryCredits } = collectProvenanceCredit({
      profileId: input.profileId,
      rootMemoryIds: input.rootMemoryIds,
      delta: input.delta,
      config: input.config,
    });
    const previousValues: MemoryVersionSnapshot[] = [];
    const creditsByDelta = new Map<number, string[]>();
    for (const credit of memoryCredits) {
      const memoryIds = creditsByDelta.get(credit.delta) ?? [];
      memoryIds.push(credit.id);
      creditsByDelta.set(credit.delta, memoryIds);
    }
    for (const [delta, memoryIds] of [...creditsByDelta.entries()].sort((left, right) =>
      left[0] - right[0]
    )) {
      const result = adjustMemoryReinforcementDelta({
        profileId: input.profileId,
        memoryIds,
        delta,
        updatedAt: input.updatedAt,
        writeEvidence: false,
        allowAnnealing: false,
      });
      previousValues.push(...result.previousValues);
    }
    return { memoryCredits, nonMemoryCredits, previousValues };
  }

  function attachProvenanceCreditToOutcomeEvidence(input: {
    evidenceId: string | null;
    config: ResolvedProvenanceCreditConfig;
    memoryCredits: ProvenanceMemoryCredit[];
    nonMemoryCredits: ProvenanceNonMemoryCredit[];
    previousValues: MemoryVersionSnapshot[];
  }): void {
    if (!input.evidenceId) return;
    if (input.memoryCredits.length === 0 && input.nonMemoryCredits.length === 0) return;
    const row = db
      .prepare("SELECT payload_json FROM gmos_evidence_events WHERE id = ?")
      .get(input.evidenceId) as { payload_json?: string } | undefined;
    if (!row) return;
    const payload = parseJsonObject(row.payload_json);
    const previousByMemoryId = new Map(
      previousValuesFromPayload(payload).map((entry) => [entry.memoryId, entry]),
    );
    for (const previous of input.previousValues) previousByMemoryId.set(previous.memoryId, previous);
    db.prepare("UPDATE gmos_evidence_events SET payload_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...payload,
        propagatedMemoryIds: input.memoryCredits.map((credit) => credit.id),
        provenanceCredit: {
          nonIndependent: true,
          hopDecay: input.config.hopDecay,
          maxCreditDepth: input.config.maxCreditDepth,
          maxCreditFanout: input.config.maxCreditFanout,
          creditedMemories: input.memoryCredits,
          creditedProvenance: input.nonMemoryCredits,
        },
        previousValues: [...previousByMemoryId.values()].sort((left, right) =>
          left.memoryId.localeCompare(right.memoryId)
        ),
      }),
      input.evidenceId,
    );
  }

  function adjustMemoryConfidencePenalty(input: {
    profileId: string;
    memoryIds: string[] | undefined;
    step: number;
    floor: number;
    updatedAt: string;
  }): void {
    const uniqueIds = uniqueMemoryIds(input.memoryIds);
    if (uniqueIds.length === 0 || input.step <= 0) return;
    const stmt = db.prepare(
      `UPDATE gmos_memories
       SET confidence = CASE
             WHEN confidence - ? < ? THEN ?
             ELSE confidence - ?
           END,
           updated_at = ?
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const rowStmt = db.prepare(
      `SELECT *
       FROM gmos_memories
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    const previousValues: MemoryVersionSnapshot[] = [];
    for (const memoryId of uniqueIds) {
      const rowBefore = rowStmt.get(input.profileId, memoryId) as Record<string, unknown> | undefined;
      if (!rowBefore) continue;
      const result = stmt.run(
        input.step,
        input.floor,
        input.floor,
        input.step,
        input.updatedAt,
        input.profileId,
        memoryId,
      );
      if (result.changes > 0) {
        previousValues.push(memorySnapshotFromRow(rowBefore));
        syncMemoryVector(memoryId);
        activateMemoryProjections(memoryId, input.profileId);
        const row = memoryRowById(input.profileId, memoryId);
        if (row) syncBeliefsForMemory(normalizeMemory(row));
      }
    }
    if (previousValues.length > 0) {
      insertMutationEvidence({
        profileId: input.profileId,
        sourceType: "feedback",
        content: "Memory confidence penalty",
        createdAt: input.updatedAt,
        payload: {
          memoryIds: uniqueIds,
          step: input.step,
          floor: input.floor,
          reason: "wrong_recall",
        },
        previousValues,
      });
    }
  }

  function latestMaintenanceDormantAt(memoryId: string): string | null {
    const row = db
      .prepare(
        `SELECT created_at
         FROM gmos_evidence_events
         WHERE source_type = 'maintenance'
           AND json_extract(payload_json, '$.memoryId') = ?
           AND json_extract(payload_json, '$.to') = 'dormant'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(memoryId) as { created_at?: string | null } | undefined;
    return row?.created_at ?? null;
  }

  function applyDuplicateConsolidationCluster(
    cluster: DuplicateConsolidationCluster,
    profileId: string,
    now: string,
  ): void {
    const memberIds = cluster.members.map((member) => member.id);
    const updateStmt = db.prepare(
      `UPDATE gmos_memories
       SET status = 'archived', updated_at = ?, metadata_json = ?
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    );
    for (const member of cluster.archivedMembers) {
      const row = memoryRowById(profileId, member.id);
      if (!row || row.status === "archived") continue;
      const previousValues = [memorySnapshotFromRow(row)];
      const metadata = metadataWithArchiveMarker({
        metadata: {
          ...parseJsonObject(row.metadata_json),
          supersededBy: cluster.survivor.id,
        },
        archivedAt: now,
        reason: "consolidation:duplicate",
      });
      const result = updateStmt.run(now, JSON.stringify(metadata), profileId, member.id);
      if (result.changes === 0) continue;
      syncMemoryVector(member.id);
      deactivateMemoryProjections(member.id);
      rejectBeliefsForMemory(member.id, now);
      insertConsolidationEvidence({
        profileId,
        survivorId: cluster.survivor.id,
        memberIds,
        archivedMemberId: member.id,
        createdAt: now,
        reasons: cluster.reasons,
        previousValues,
      });
    }
  }

  function maintenanceTransitionForMemory(
    memory: MemoryRecord,
    input: MaintenanceStoreInput,
    skipped: Map<string, number>,
  ): MaintenanceTransition | null {
    const retention = retentionScore(memory, input.now, input.lifecycle);
    if (memory.status === "active") {
      if (retention >= input.lifecycle.dormantBelow) return null;
      return {
        memoryId: memory.id,
        kind: memory.kind,
        from: "active",
        to: "dormant",
        retention,
        reasons: [
          "retention_below_threshold",
          `retention:${retention.toFixed(4)}`,
          `threshold:${input.lifecycle.dormantBelow.toFixed(4)}`,
        ],
      };
    }
    if (memory.status !== "dormant") return null;
    const dormantAt = latestMaintenanceDormantAt(memory.id);
    if (!dormantAt) {
      incrementSkipped(skipped, "missing_dormant_since_evidence");
      return null;
    }
    const dormantDays = daysBetween(dormantAt, input.now);
    if (dormantDays === null) {
      incrementSkipped(skipped, "invalid_dormant_since_evidence");
      return null;
    }
    if (dormantDays < input.lifecycle.archiveAfterDormantDays) {
      incrementSkipped(skipped, "dormant_archive_window_not_reached");
      return null;
    }
    return {
      memoryId: memory.id,
      kind: memory.kind,
      from: "dormant",
      to: "archived",
      retention,
      reasons: [
        "archive_after_dormant_window",
        `dormant_days:${dormantDays.toFixed(2)}`,
        `archive_after_days:${input.lifecycle.archiveAfterDormantDays.toFixed(2)}`,
      ],
    };
  }

  function applyMaintenanceTransition(
    transition: MaintenanceTransition,
    profileId: string,
    now: string,
  ): void {
    const row = memoryRowById(profileId, transition.memoryId);
    if (!row || row.status !== transition.from) return;
    const previousValues = [memorySnapshotFromRow(row)];
    const existingMetadata = parseJsonObject(row.metadata_json);
    const metadata =
      transition.to === "archived"
        ? metadataWithArchiveMarker({
            metadata: existingMetadata,
            archivedAt: now,
            reason: "maintenance:retention",
          })
        : existingMetadata;
    db.prepare(
      `UPDATE gmos_memories
       SET status = ?, updated_at = ?, metadata_json = ?
       WHERE profile_id = ? AND id = ? AND status = ?`,
    ).run(
      transition.to,
      now,
      JSON.stringify(metadata),
      profileId,
      transition.memoryId,
      transition.from,
    );
    syncMemoryVector(transition.memoryId);
    if (transition.to === "active") {
      activateMemoryProjections(transition.memoryId, profileId);
    } else {
      deactivateMemoryProjections(transition.memoryId);
      if (transition.to === "archived") {
        rejectBeliefsForMemory(transition.memoryId, now);
      }
    }
    insertLifecycleEvidence({
      profileId,
      sourceType: "maintenance",
      memoryId: transition.memoryId,
      from: transition.from,
      to: transition.to,
      createdAt: now,
      retention: transition.retention,
      reasons: transition.reasons,
      previousValues,
    });
  }

  function externalContentFtsIntegrityOk(table: string): boolean {
    if (db.readonly) return true;
    try {
      db.prepare(
        `INSERT INTO ${quotedIdentifier(table)}(${quotedIdentifier(table)}, rank)
         VALUES('integrity-check', 1)`,
      ).run();
      return true;
    } catch {
      return false;
    }
  }

  function rebuildExternalContentFts(table: string): void {
    db.prepare(
      `INSERT INTO ${quotedIdentifier(table)}(${quotedIdentifier(table)})
       VALUES('rebuild')`,
    ).run();
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
    const memoryFtsIntegrityOk = externalContentFtsIntegrityOk("gmos_memories_fts");
    const indexedMemoryCount = memoryFtsIntegrityOk ? totalMemoryCount : 0;
    const missingEntryCount = memoryFtsIntegrityOk ? 0 : totalMemoryCount;
    const orphanEntryCount = 0;
    const staleEntryCount = 0;
    const duplicateEntryCount = 0;
    const vectorIndex = vectorIndexStatus(totalMemoryCount, hasVectorIndex);
    const status =
      memoryFtsIntegrityOk && vectorIndex.status === "ok"
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
        providerName: providerNameForHealth(embeddingProvider),
        providerDimensions: providerDimensionsForHealth(embeddingProvider),
        embeddedEntryCount: 0,
        pendingEntryCount: 0,
        staleProviderEntryCount: 0,
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
        providerName: providerNameForHealth(embeddingProvider),
        providerDimensions: providerDimensionsForHealth(embeddingProvider),
        embeddedEntryCount: 0,
        pendingEntryCount: 0,
        staleProviderEntryCount: 0,
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
    const vectorRows = (
      db
        .prepare(
          `SELECT v.profile_id, v.status, v.updated_at, v.provider_name,
                  v.embedding_status, v.dimensions, v.vector_json, v.content_hash,
                  m.profile_id AS memory_profile_id, m.kind AS memory_kind,
                  m.sensitivity AS memory_sensitivity, m.status AS memory_status,
                  m.updated_at AS memory_updated_at, m.content AS memory_content
           FROM gmos_memory_vectors v
           JOIN gmos_memories m ON m.id = v.id`,
        )
        .all() as Array<{
        profile_id?: string | null;
        status?: string | null;
        updated_at?: string | null;
        provider_name?: string | null;
        embedding_status?: string | null;
        dimensions?: number | null;
        vector_json?: string | null;
        content_hash?: string | null;
        memory_profile_id?: string | null;
        memory_kind?: string | null;
        memory_sensitivity?: string | null;
        memory_status?: string | null;
        memory_updated_at?: string | null;
        memory_content?: string | null;
      }>
    );
    const vectorDiagnostics = vectorRows.reduce(
      (diagnostics, row) => {
        const expected = expectedVectorProviderForMemory({
          kind: (row.memory_kind ?? "fact") as MemoryKind,
          sensitivity: (row.memory_sensitivity ?? "normal") as Sensitivity,
          content: row.memory_content ?? "",
        });
        const rawVector = parseJsonArray(row.vector_json);
        const vectorStale =
          row.profile_id !== row.memory_profile_id ||
          row.status !== row.memory_status ||
          row.updated_at !== row.memory_updated_at ||
          row.dimensions !== rawVector.length ||
          !row.vector_json ||
          rawVector.length === 0 ||
          rawVector.some((value) => !Number.isFinite(value)) ||
          row.content_hash !== vectorContentHash(row.memory_content ?? "");
        const providerStale =
          row.provider_name !== expected.providerName ||
          Number(row.dimensions ?? 0) !== expected.dimensions;
        const pending = row.embedding_status === "pending";
        if (vectorStale) diagnostics.staleVectorEntryCount += 1;
        if (pending) diagnostics.pendingEntryCount += 1;
        if (providerStale && !pending) diagnostics.staleProviderEntryCount += 1;
        if (
          !vectorStale &&
          !providerStale &&
          row.embedding_status !== "pending"
        ) {
          diagnostics.embeddedEntryCount += 1;
        }
        return diagnostics;
      },
      {
        staleVectorEntryCount: 0,
        pendingEntryCount: 0,
        staleProviderEntryCount: 0,
        embeddedEntryCount: 0,
      },
    );
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
      vectorDiagnostics.staleVectorEntryCount === 0 &&
      staleFeatureEntryCount === 0 &&
      vectorDiagnostics.pendingEntryCount === 0 &&
      vectorDiagnostics.staleProviderEntryCount === 0 &&
      orphanEntryCount === 0 &&
      orphanFeatureEntryCount === 0 &&
      duplicateEntryCount === 0
        ? "ok"
        : "stale";
    return {
      status,
      indexedMemoryCount,
      missingEntryCount: missingEntryCount + missingFeatureEntryCount,
      staleEntryCount:
        vectorDiagnostics.staleVectorEntryCount +
        staleFeatureEntryCount +
        vectorDiagnostics.pendingEntryCount +
        vectorDiagnostics.staleProviderEntryCount,
      orphanEntryCount: orphanEntryCount + orphanFeatureEntryCount,
      duplicateEntryCount,
      providerName: providerNameForHealth(embeddingProvider),
      providerDimensions: providerDimensionsForHealth(embeddingProvider),
      embeddedEntryCount: vectorDiagnostics.embeddedEntryCount,
      pendingEntryCount: vectorDiagnostics.pendingEntryCount,
      staleProviderEntryCount: vectorDiagnostics.staleProviderEntryCount,
      dimensions,
    };
  }

  function expectedVectorProviderForMemory(input: {
    kind: MemoryKind;
    sensitivity: Sensitivity;
    content: string;
  }): { providerName: string; dimensions: number } {
    if (
      memoryEligibleForEmbeddingProvider({
        provider: embeddingProvider,
        kind: input.kind,
        sensitivity: input.sensitivity,
        content: input.content,
      })
    ) {
      return {
        providerName: providerNameForHealth(embeddingProvider),
        dimensions: providerDimensionsForHealth(embeddingProvider),
      };
    }
    return {
      providerName: LOCAL_TEXT_VECTOR_PROVIDER,
      dimensions: LOCAL_TEXT_VECTOR_DIMENSIONS,
    };
  }

  async function repairSearchIndex(input: RepairSearchIndexInput = {}): Promise<RepairSearchIndexResult> {
    initialize();
    const before = searchIndexStatus();
    if (db.readonly) throw new Error("gmOS SQLite store is readonly");
    if (!ftsAvailable()) throw new Error("gmOS SQLite search index is missing");
    const repairedAt = input.now ?? nowIso();
    const batchSize = limit(input.vectorBatchSize, DEFAULT_VECTOR_BACKFILL_BATCH_SIZE, 500);
    const vectorCandidates = vectorBackfillCandidates(batchSize);
    const vectorBackfill = {
      batchSize,
      candidateCount: vectorCandidates.length,
      embeddedCount: 0,
      fallbackCount: 0,
      pendingCount: 0,
      staleProviderCount: vectorCandidates.filter((candidate) => candidate.staleProvider).length,
      skippedCount: input.dryRun === true ? vectorCandidates.length : 0,
    };
    if (input.dryRun === true) {
      return {
        repaired: false,
        dryRun: true,
        before,
        after: searchIndexStatus(),
        repairedAt,
        vectorBackfill,
      };
    }
    const repairFts = db.transaction(() => {
      rebuildExternalContentFts("gmos_memories_fts");
    });
    repairFts();
    if (!embeddingProvider) {
      rebuildMemoryVectorIndex();
      vectorBackfill.fallbackCount = vectorCandidates.length;
    } else {
      const embedded = await embeddingsForMemories({
        provider: embeddingProvider,
        memories: vectorCandidates.map((candidate) => ({
          kind: candidate.kind,
          sensitivity: candidate.sensitivity,
          content: candidate.content,
        })),
      });
      for (const [index, candidate] of vectorCandidates.entries()) {
        const embedding = embedded.embeddings[index]!;
        syncMemoryVector(candidate.id, embedding);
        if (embedding.providerName === LOCAL_TEXT_VECTOR_PROVIDER) {
          vectorBackfill.fallbackCount += 1;
        } else {
          vectorBackfill.embeddedCount += 1;
        }
        if (embedding.status === "pending") vectorBackfill.pendingCount += 1;
      }
    }
    const after = searchIndexStatus();
    return {
      repaired: before.status !== "ok" && after.status === "ok",
      dryRun: false,
      before,
      after,
      repairedAt,
      vectorBackfill,
    };
  }

  interface VectorBackfillCandidate {
    id: string;
    kind: MemoryKind;
    sensitivity: Sensitivity;
    content: string;
    staleProvider: boolean;
  }

  function vectorBackfillCandidates(batchSize: number): VectorBackfillCandidate[] {
    if (!vectorIndexAvailable()) return [];
    const rows = db
      .prepare(
        `SELECT m.id, m.kind, m.sensitivity, m.content, m.profile_id, m.status,
                m.updated_at, v.profile_id AS vector_profile_id,
                v.status AS vector_status, v.updated_at AS vector_updated_at,
                v.provider_name, v.embedding_status, v.dimensions, v.vector_json, v.content_hash,
                EXISTS(
                  SELECT 1 FROM gmos_memory_vector_terms t WHERE t.id = m.id
                ) AS has_terms
         FROM gmos_memories m
         LEFT JOIN gmos_memory_vectors v ON v.id = m.id
         ORDER BY m.updated_at ASC, m.id ASC`,
      )
      .all() as Array<{
        id: string;
        kind: string;
        sensitivity: string;
        content: string;
        profile_id: string;
        status: string;
        updated_at: string;
        vector_profile_id?: string | null;
        vector_status?: string | null;
        vector_updated_at?: string | null;
        provider_name?: string | null;
        embedding_status?: string | null;
        dimensions?: number | null;
        vector_json?: string | null;
        content_hash?: string | null;
        has_terms?: number | null;
      }>;
    const candidates: VectorBackfillCandidate[] = [];
    for (const row of rows) {
      const kind = row.kind as MemoryKind;
      const sensitivity = row.sensitivity as Sensitivity;
      const expected = expectedVectorProviderForMemory({
        kind,
        sensitivity,
        content: row.content,
      });
      const rawVector = parseJsonArray(row.vector_json);
      const missingVector = !row.provider_name || !row.vector_json;
      const staleProvider =
        row.provider_name !== expected.providerName ||
        Number(row.dimensions ?? 0) !== expected.dimensions;
      const pending = row.embedding_status === "pending";
      const staleVector =
        missingVector ||
        row.has_terms !== 1 ||
        row.dimensions !== rawVector.length ||
        rawVector.length === 0 ||
        row.vector_profile_id !== row.profile_id ||
        row.vector_status !== row.status ||
        row.vector_updated_at !== row.updated_at ||
        row.content_hash !== vectorContentHash(row.content);
      if (!staleVector && !staleProvider && !pending) continue;
      candidates.push({
        id: row.id,
        kind,
        sensitivity,
        content: row.content,
        staleProvider,
      });
      if (candidates.length >= batchSize) break;
    }
    return candidates;
  }

  function lexicalMemoryRowsForSearch(input: MemorySearchInput): Record<string, unknown>[] {
    const query = input.query?.trim() ?? "";
    const candidateLimit = Math.max(input.limit ?? 12, 100);
    const statusSql = lifecycleReachableStatusSql(input.purpose);
    if (!query) {
      return db
        .prepare(
          `SELECT * FROM gmos_memories
           WHERE profile_id = ? AND ${statusSql}
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(input.profileId, Math.max(candidateLimit, 500)) as Record<string, unknown>[];
    }

    return memoryLexicalRowsForSearch(input, candidateLimit);
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
               AND ${lifecycleReachableAliasStatusSql("m", input.purpose)}
             ORDER BY bm25(gmos_memories_fts), m.updated_at DESC
             LIMIT ?`,
          )
          .all(match, input.profileId, Math.max(candidateLimit, 500)) as Record<string, unknown>[];
        if (rows.length > 0) {
          return rows.map((row, index) => ({
            ...row,
            __gmos_fts_score: reciprocalRank(index + 1),
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
           AND ${lifecycleReachableStatusSql(input.purpose)}
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
      __gmos_fts_score: reciprocalRank(index + 1) * 0.8,
      __gmos_search_score: 80 / (60 + index + 1),
    }));
  }

  function memoryVectorRowsForSearch(
    input: MemorySearchInput,
    candidateLimit: number,
  ): Record<string, unknown>[] {
    const query = input.query?.trim() ?? "";
    if (!query || !vectorIndexAvailable()) return [];
    const queryEmbedding = input.queryEmbedding
      ? validateQueryEmbedding(input.queryEmbedding)
      : null;
    const queryFeatures = localTextCandidateFeatures(query, 128);
    if (!queryEmbedding && (queryFeatures.length === 0 || !tableExists("gmos_memory_vector_terms"))) {
      return [];
    }
    const queryVector = queryEmbedding?.vector ?? localMemoryEmbedding(query, "embedded").vector;
    const candidateRowLimit = Math.min(Math.max(candidateLimit * 20, 100), 1000);
    const vectorStatusSql = lifecycleReachableAliasStatusSql("v", input.purpose);
    const memoryStatusSql = lifecycleReachableAliasStatusSql("m", input.purpose);
    const rows = queryEmbedding
      ? db
          .prepare(
            `SELECT m.*, v.vector_json, 0 AS hit_count
             FROM gmos_memory_vectors v
             JOIN gmos_memories m ON m.id = v.id
             WHERE v.profile_id = ?
               AND ${vectorStatusSql}
               AND v.provider_name = ?
               AND v.dimensions = ?
               AND v.embedding_status = 'embedded'
               AND m.profile_id = ?
               AND ${memoryStatusSql}
             ORDER BY v.updated_at DESC, v.id ASC
             LIMIT ?`,
          )
          .all(
            input.profileId,
            queryEmbedding.providerName,
            queryEmbedding.dimensions,
            input.profileId,
            candidateRowLimit,
          ) as Array<Record<string, unknown>>
      : (() => {
          const featurePlaceholders = queryFeatures.map(() => "?").join(", ");
          const statusSql = lifecycleReachableStatusSql(input.purpose);
          return db
            .prepare(
              `SELECT m.*, v.vector_json, candidates.hit_count
               FROM (
                 SELECT id, COUNT(*) AS hit_count, MAX(updated_at) AS latest_at
                 FROM gmos_memory_vector_terms
                 WHERE profile_id = ?
                   AND ${statusSql}
                   AND feature_key IN (${featurePlaceholders})
                 GROUP BY id
                 ORDER BY hit_count DESC, latest_at DESC
                 LIMIT ?
               ) candidates
               JOIN gmos_memory_vectors v ON v.id = candidates.id
               JOIN gmos_memories m ON m.id = candidates.id
               WHERE v.profile_id = ?
                 AND ${vectorStatusSql}
                 AND v.provider_name = ?
                 AND v.dimensions = ?
                 AND m.profile_id = ?
                 AND ${memoryStatusSql}`,
            )
            .all(
              input.profileId,
              ...queryFeatures,
              candidateRowLimit,
              input.profileId,
              LOCAL_TEXT_VECTOR_PROVIDER,
              LOCAL_TEXT_VECTOR_DIMENSIONS,
              input.profileId,
            ) as Array<Record<string, unknown>>;
        })();
    return rows
      .map((row, index) => {
        const rawVector = parseJsonArray(row.vector_json);
        const similarity =
          rawVector.length === queryVector.length ? cosineSimilarity(queryVector, rawVector) : 0;
        const { vector_json: _vectorJson, hit_count: hitCount, ...memoryRow } = row;
        return {
          ...memoryRow,
          __gmos_vector_similarity: similarity,
          __gmos_feature_hit_count: Number(hitCount ?? 0),
          __gmos_vector_score: similarity > 0 ? similarity + reciprocalRank(index + 1) : 0,
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
    associationRows: Record<string, unknown>[],
    candidateLimit: number,
    retrieval: MemoryRetrievalConfig | undefined,
  ): Record<string, unknown>[] {
    const merged = new Map<string, Record<string, unknown>>();
    const weights = retrievalFusionWeights(retrieval);
    function addRows(rows: Record<string, unknown>[], source: "fts" | "vector" | "association"): void {
      rows.forEach((row, index) => {
        const memoryId = String(row.id);
        const existing = merged.get(memoryId);
        const rankScore = reciprocalRank(index + 1);
        const ftsScore =
          source === "fts"
            ? Math.max(Number(row.__gmos_fts_score ?? 0), rankScore)
            : Number(existing?.__gmos_fts_score ?? 0);
        const vectorScore =
          source === "vector"
            ? Math.max(Number(row.__gmos_vector_score ?? 0), rankScore)
            : Number(existing?.__gmos_vector_score ?? 0);
        const associationScore =
          source === "association"
            ? Math.max(Number(row.__gmos_association_score ?? 0), rankScore)
            : Number(existing?.__gmos_association_score ?? 0);
        const fusionScore =
          ftsScore * weights.fts +
          vectorScore * weights.vector +
          associationScore * weights.association;
        merged.set(memoryId, {
          ...(existing ?? row),
          ...row,
          __gmos_fts_score: ftsScore,
          __gmos_vector_score: vectorScore,
          __gmos_association_score: associationScore,
          __gmos_fusion_score: fusionScore,
          __gmos_search_score: fusionScore,
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
    addRows(lexicalRows, "fts");
    addRows(vectorRows, "vector");
    addRows(associationRows, "association");
    return [...merged.values()]
      .sort((a, b) =>
        Number(b.__gmos_search_score ?? 0) - Number(a.__gmos_search_score ?? 0) ||
        String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) ||
        String(a.id ?? "").localeCompare(String(b.id ?? ""))
      )
      .slice(0, Math.max(candidateLimit, 500));
  }

  function retrievalFusionWeights(
    retrieval: MemoryRetrievalConfig | undefined,
  ): { fts: number; vector: number; association: number } {
    const weights = retrieval?.fusion;
    return {
      fts: boundedWeight(weights?.fts, 1),
      vector: boundedWeight(weights?.vector, 1.2),
      association: boundedWeight(weights?.association, 0.8),
    };
  }

  function boundedWeight(input: number | undefined, fallback: number): number {
    if (input === undefined || !Number.isFinite(input)) return fallback;
    return Math.max(0, Math.min(input, 10));
  }

  function memoryAssociationRowsForSearch(
    input: MemorySearchInput,
    candidateLimit: number,
  ): Record<string, unknown>[] {
    const query = input.query?.trim() ?? "";
    if (!query || !tableExists("gmos_associations")) return [];
    const associations = searchAssociations({
      profileId: input.profileId,
      query,
      purpose: input.purpose === "history" ? "history" : "context",
      ...(input.asOf ? { asOf: input.asOf } : {}),
      includeSensitive: input.includeSensitive,
      includePerson: input.includePerson,
      limit: Math.min(Math.max(candidateLimit * 4, 24), 100),
    });
    const memoryIds = new Map<string, number>();
    associations.forEach((association, index) => {
      const memoryId = association.targetType === "memory"
        ? association.targetId
        : association.sourceMemoryId ?? "";
      if (!memoryId || memoryIds.has(memoryId)) return;
      memoryIds.set(memoryId, index + 1);
    });
    if (memoryIds.size === 0) return [];
    const rows: Record<string, unknown>[] = [];
    const rowStmt = db.prepare(
      `SELECT *
       FROM gmos_memories
       WHERE profile_id = ? AND id = ? AND ${lifecycleReachableStatusSql(input.purpose)}`,
    );
    for (const [memoryId, rank] of memoryIds) {
      const row = rowStmt.get(input.profileId, memoryId) as Record<string, unknown> | undefined;
      if (!row) continue;
      rows.push({
        ...row,
        __gmos_association_score: reciprocalRank(rank),
        __gmos_search_score: reciprocalRank(rank),
      });
    }
    return rows;
  }

  function memoryRowsForSearch(input: MemorySearchInput): Record<string, unknown>[] {
    const candidateLimit = Math.max(input.limit ?? 12, 100);
    const retrieval = input.retrieval ?? retrievalConfig;
    const lexicalRows = lexicalMemoryRowsForSearch(input);
    const purpose = input.purpose ?? "context";
    if (purpose !== "context" && purpose !== "history") return lexicalRows;
    return mergeSearchRows(
      lexicalRows,
      memoryVectorRowsForSearch(input, candidateLimit),
      memoryAssociationRowsForSearch(input, candidateLimit),
      candidateLimit,
      retrieval,
    );
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

  function claimEvidence(input: RecordEvidenceInput): {
    evidence: EvidenceEvent;
    inserted: boolean;
  } {
    initialize();
    const createdAt = input.createdAt ?? nowIso();
    const eventId = id("evidence");
    const inserted = db.prepare(
      `INSERT INTO gmos_evidence_events (
        id, event_key, profile_id, source_type, source_uri, content, sensitivity,
        eligible_for_long_term_memory, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_key) DO NOTHING`,
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
    ).changes > 0;
    const row = db
      .prepare("SELECT * FROM gmos_evidence_events WHERE event_key = ?")
      .get(input.eventKey) as Record<string, unknown>;
    const evidence = normalizeEvidence(row);
    if (evidence.profileId !== input.profileId) {
      throw new Error("evidence event key already belongs to another profile");
    }
    return { evidence, inserted };
  }

  function recordEvidence(input: RecordEvidenceInput): EvidenceEvent {
    return claimEvidence(input).evidence;
  }

  function getEvidenceByEventKey(eventKey: string): EvidenceEvent | null {
    initialize();
    const row = db
      .prepare("SELECT * FROM gmos_evidence_events WHERE event_key = ?")
      .get(eventKey) as Record<string, unknown> | undefined;
    return row ? normalizeEvidence(row) : null;
  }

  async function addMemory(input: AddMemoryInput): Promise<MemoryRecord> {
    return (await addMemories([input]))[0]!;
  }

  async function addMemories(inputs: AddMemoryInput[]): Promise<MemoryRecord[]> {
    initialize();
    if (inputs.length === 0) return [];
    const embeddings = await embeddingsForWriteBatch(inputs.map((input) => ({
      kind: input.kind,
      sensitivity: input.sensitivity,
      content: input.content,
      embedding: input.embedding,
    })));
    const tx = db.transaction((): MemoryRecord[] =>
      inputs.map((input, index) => insertMemory(input, embeddings[index]!))
    );
    return tx();
  }

  function insertMemory(input: AddMemoryInput, embedding: MemoryVectorEmbedding): MemoryRecord {
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
    syncMemoryVector(memoryId, embedding);
    const memory = normalizeMemory(
      db
        .prepare("SELECT * FROM gmos_memories WHERE id = ?")
        .get(memoryId) as Record<string, unknown>,
    );
    projectMemoryAssociations(memory, { replaceExisting: false });
    return memory;
  }

  async function updateMemory(input: UpdateMemoryInput): Promise<MemoryRecord | null> {
    initialize();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'active'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return null;
    const previous = normalizeMemory(existing);
    const previousValues = [memoryVersionSnapshot(previous)];
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
    const embedding =
      input.content !== undefined || input.embedding !== undefined
        ? await embeddingForWrite({
            kind: next.kind,
            sensitivity: next.sensitivity,
            content: next.content,
            embedding: input.embedding,
          })
        : undefined;
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
    if (input.sourceEventId === undefined) {
      const evidenceId = insertMutationEvidence({
        profileId: input.profileId,
        sourceType: "memory.update",
        content: "Memory update",
        createdAt: updatedAt,
        payload: { memoryId: input.id },
        previousValues,
      });
      db.prepare(
        `UPDATE gmos_memories
         SET source_event_id = ?
         WHERE profile_id = ? AND id = ?`,
      ).run(evidenceId, input.profileId, input.id);
    } else {
      attachPreviousValuesToEvidence(input.sourceEventId, previousValues);
    }
    syncMemoryVector(input.id, embedding);
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
      .prepare(
        `SELECT * FROM gmos_memories
         WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
      )
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return false;
    const previousValues = [memorySnapshotFromRow(existing)];
    const metadata = metadataWithArchiveMarker({
      metadata: parseJsonObject(existing.metadata_json),
      archivedAt,
      reason: input.reason,
    });
    const result = db
      .prepare(
        `UPDATE gmos_memories
         SET status = 'archived', updated_at = ?, metadata_json = ?
         WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
      )
      .run(archivedAt, JSON.stringify(metadata), input.profileId, input.id);
    syncMemoryVector(input.id);
    deleteAssociationsForMemory(input.id);
    rejectBeliefsForMemory(input.id, archivedAt);
    insertLifecycleEvidence({
      profileId: input.profileId,
      sourceType: "memory.lifecycle",
      memoryId: input.id,
      from: String(existing.status) as MemoryRecord["status"],
      to: "archived",
      createdAt: archivedAt,
      reasons: [input.reason ?? "manual_archive"],
      previousValues,
    });
    return result.changes > 0;
  }

  function restoreArchivedMemory(input: RestoreArchivedMemoryInput): boolean {
    initialize();
    const restoredAt = input.restoredAt ?? nowIso();
    const existing = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ? AND status = 'archived'")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (!existing) return false;
    const previousValues = [memorySnapshotFromRow(existing)];
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
    syncMemoryVector(input.id);
    const restored = db
      .prepare("SELECT * FROM gmos_memories WHERE profile_id = ? AND id = ?")
      .get(input.profileId, input.id) as Record<string, unknown> | undefined;
    if (restored) projectMemoryAssociations(normalizeMemory(restored));
    insertLifecycleEvidence({
      profileId: input.profileId,
      sourceType: "memory.lifecycle",
      memoryId: input.id,
      from: "archived",
      to: "active",
      createdAt: restoredAt,
      reasons: [input.reason ?? "manual_restore"],
      previousValues,
    });
    return result.changes > 0;
  }

  function archiveMemories(input: ArchiveMemoriesInput): string[] {
    initialize();
    if (!input.all && !input.scope && !input.metadataEquals) {
      throw new Error("archiveMemories requires all, scope, or metadataEquals");
    }
    const clauses = ["profile_id = ?", "status IN ('active', 'dormant')"];
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
      .prepare(`SELECT * FROM gmos_memories WHERE ${where}`)
      .all(...params) as Array<Record<string, unknown>>;
    const ids = rows.map((row) => String(row.id));
    if (ids.length === 0) return [];
    const stmt = db.prepare(
      `UPDATE gmos_memories
       SET status = 'archived', updated_at = ?, metadata_json = ?
       WHERE profile_id = ? AND id = ?`,
    );
    const archivedAt = input.archivedAt ?? nowIso();
    const tx = db.transaction((memoryRows: Array<Record<string, unknown>>) => {
      for (const row of memoryRows) {
        const previousValues = [memorySnapshotFromRow(row)];
        const memoryId = String(row.id);
        const metadata = metadataWithArchiveMarker({
          metadata: parseJsonObject(row.metadata_json),
          archivedAt,
          reason: input.reason,
        });
        stmt.run(archivedAt, JSON.stringify(metadata), input.profileId, memoryId);
        syncMemoryVector(memoryId);
        deleteAssociationsForMemory(memoryId);
        rejectBeliefsForMemory(memoryId, archivedAt);
        insertLifecycleEvidence({
          profileId: input.profileId,
          sourceType: "memory.lifecycle",
          memoryId,
          from: String(row.status) as MemoryRecord["status"],
          to: "archived",
          createdAt: archivedAt,
          reasons: [input.reason ?? "manual_clear"],
          previousValues,
        });
      }
    });
    tx(rows);
    return ids;
  }

  function addWorldBelief(input: AddWorldBeliefInput): WorldBeliefRecord {
    initialize();
    const operationAt = nowIso();
    const createdAt = input.createdAt ?? operationAt;
    const tx = db.transaction((): WorldBeliefRecord => {
      const resolution = resolveEntity({
        subject: input.subject,
        predicate: input.predicate,
        aliases: input.subjectAliases,
      });
      const canonicalSubject = resolution.canonicalSubject;
      const cardinality = input.cardinality ?? "multi";
      const insertBelief = (status: WorldBeliefRecord["status"]): WorldBeliefRecord => {
        const beliefId = id("belief");
        const metadata = worldBeliefMetadata({
          inputMetadata: input.metadata,
          resolution,
        });
        db.prepare(
          `INSERT INTO gmos_world_beliefs (
            id, profile_id, subject, predicate, object, confidence, status,
            source_memory_id, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          beliefId,
          input.profileId,
          canonicalSubject,
          input.predicate,
          input.object,
          input.confidence ?? 0.5,
          status,
          input.sourceMemoryId ?? null,
          JSON.stringify(metadata),
          createdAt,
          operationAt,
        );
        const belief: WorldBeliefRecord = {
          id: beliefId,
          profileId: input.profileId,
          subject: canonicalSubject,
          predicate: input.predicate,
          object: input.object,
          confidence: input.confidence ?? 0.5,
          status,
          sourceMemoryId: input.sourceMemoryId ?? null,
          metadata,
          createdAt,
          updatedAt: operationAt,
        };
        projectBeliefAssociations(belief);
        return belief;
      };
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
          .filter((belief) => canonicalSubjectForBelief(belief, options.entityResolver) === canonicalSubject);
        const sameObjectRows = activeBeliefs.filter((belief) => belief.object === input.object);
        const sameObject = sameObjectRows[0];
        const incomingTrust = sourceTrustFromMetadata(input.metadata ?? {});
        const activeHigherTrust = activeBeliefs.some(
          (belief) =>
            belief.object !== input.object &&
            sourceTrustRank(sourceTrustFromMetadata(belief.metadata) ?? "user") >
              sourceTrustRank(incomingTrust ?? "user"),
        );
        if (activeHigherTrust && !sameObject) {
          return insertBelief("rejected");
        }
        const incomingInstant = parseInstant(createdAt);
        const incomingIsOlderThanActive =
          incomingInstant !== null &&
          activeBeliefs.some((belief) => {
            const activeInstant = parseInstant(belief.createdAt);
            return activeInstant !== null && activeInstant > incomingInstant;
          });
        if (incomingIsOlderThanActive && !sameObject) {
          return insertBelief("superseded");
        }
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
              operationAt,
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
          const sameObjectCreatedAt = sameObjectRows
            .map((belief) => belief.createdAt)
            .concat(createdAt)
            .reduce(laterInstantIso, sameObject.createdAt);
          const refreshedMetadata = hasTemporalValidityMetadata(input.metadata)
            ? metadata
            : withoutTemporalValidityMetadata(metadata);
          db.prepare(
            `UPDATE gmos_world_beliefs
             SET subject = ?,
                 confidence = ?,
                 source_memory_id = ?,
                 metadata_json = ?,
                 created_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          ).run(
            canonicalSubject,
            confidence,
            sourceMemoryId,
            JSON.stringify(refreshedMetadata),
            sameObjectCreatedAt,
            operationAt,
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
            operationAt,
            belief.id,
          );
        }
      }
      return insertBelief("active");
    });
    return tx();
  }

  function listWorldBeliefs(input: WorldBeliefListInput): WorldBeliefRecord[] {
    initialize();
    const limit = Math.max(1, Math.min(input.limit ?? 500, 5000));
    const clauses = ["profile_id = ?"];
    const params: unknown[] = [input.profileId];
    if (input.status && input.status !== "any") {
      clauses.push("status = ?");
      params.push(input.status);
    }
    return (
      db
        .prepare(
          `SELECT *
           FROM gmos_world_beliefs
           WHERE ${clauses.join(" AND ")}
           ORDER BY updated_at DESC, id ASC
           LIMIT ?`,
        )
        .all(...params, limit) as Record<string, unknown>[]
    ).map(normalizeWorldBelief);
  }

  async function recordConsolidationSummary(
    input: RecordConsolidationSummaryInput,
  ): Promise<RecordConsolidationSummaryResult> {
    initialize();
    const sourceMemoryIds = [...new Set(input.sourceMemoryIds)].sort((left, right) =>
      left.localeCompare(right)
    );
    const embedding = await embeddingForWrite({
      kind: input.kind,
      sensitivity: input.sensitivity,
      content: input.content,
      embedding: input.embedding,
    });
    const tx = db.transaction((): RecordConsolidationSummaryResult => {
      const evidenceId = id("evidence");
      const evidenceKey = [
        "consolidation.summary",
        input.profileId,
        sourceMemoryIds.join(","),
        input.createdAt,
      ].join(":");
      db.prepare(
        `INSERT INTO gmos_evidence_events (
          id, event_key, profile_id, source_type, source_uri, content, sensitivity,
          eligible_for_long_term_memory, payload_json, created_at
        ) VALUES (?, ?, ?, 'consolidation', ?, ?, 'normal', 0, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
          payload_json = excluded.payload_json`,
      ).run(
        evidenceId,
        evidenceKey,
        input.profileId,
        null,
        "Memory consolidation summary",
        JSON.stringify({
          sourceMemoryIds,
          sharedTags: input.sharedTags,
          kind: input.kind,
        }),
        input.createdAt,
      );
      const sourceEvidence = normalizeEvidence(
        db
          .prepare("SELECT * FROM gmos_evidence_events WHERE event_key = ?")
          .get(evidenceKey) as Record<string, unknown>,
      );
      const memoryId = id("memory");
      const metadata = {
        ...(input.metadata ?? {}),
        consolidationSummary: true,
        sourceMemoryIds,
        sharedTags: input.sharedTags,
      };
      db.prepare(
        `INSERT INTO gmos_memories (
          id, profile_id, kind, scope, content, sensitivity, status, confidence,
          source_event_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'global', ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).run(
        memoryId,
        input.profileId,
        input.kind,
        input.content,
        input.sensitivity,
        input.confidence,
        sourceEvidence.id,
        JSON.stringify(metadata),
        input.createdAt,
        input.createdAt,
      );
      syncMemoryVector(memoryId, embedding);
      const memory = normalizeMemory(
        db.prepare("SELECT * FROM gmos_memories WHERE id = ?").get(memoryId) as Record<
          string,
          unknown
        >,
      );
      projectMemoryAssociations(memory, { replaceExisting: false });

      const dormantSourceIds: string[] = [];
      const sourceRow = db.prepare(
        `SELECT *
         FROM gmos_memories
         WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
      );
      const sourceUpdate = db.prepare(
        `UPDATE gmos_memories
         SET status = 'dormant', updated_at = ?, metadata_json = ?
         WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
      );
      for (const sourceMemoryId of sourceMemoryIds) {
        const row = sourceRow.get(input.profileId, sourceMemoryId) as
          | Record<string, unknown>
          | undefined;
        if (!row) continue;
        const previousValues = [memorySnapshotFromRow(row)];
        const previousStatus = String(row.status) as MemoryRecord["status"];
        const sourceMetadata = {
          ...parseJsonObject(row.metadata_json),
          consolidatedInto: memory.id,
        };
        const result = sourceUpdate.run(
          input.createdAt,
          JSON.stringify(sourceMetadata),
          input.profileId,
          sourceMemoryId,
        );
        if (result.changes === 0) continue;
        dormantSourceIds.push(sourceMemoryId);
        syncMemoryVector(sourceMemoryId);
        if (previousStatus === "active") {
          deactivateMemoryProjections(sourceMemoryId);
          insertLifecycleEvidence({
            profileId: input.profileId,
            sourceType: "maintenance",
            memoryId: sourceMemoryId,
            from: "active",
            to: "dormant",
            createdAt: input.createdAt,
            reasons: ["consolidated_to_summary", `summary:${memory.id}`],
            previousValues,
          });
        }
      }

      const worldBelief = input.belief
        ? addWorldBelief({
            profileId: input.profileId,
            subject: input.belief.subject,
            predicate: input.belief.predicate,
            object: input.belief.object,
            confidence: input.confidence,
            sourceMemoryId: memory.id,
            cardinality: "single",
            createdAt: input.createdAt,
            metadata,
          })
        : undefined;
      return {
        memory,
        ...(worldBelief ? { worldBelief } : {}),
        dormantSourceIds,
      };
    });
    return tx();
  }

  function distillationEventKey(profileId: string, clusterKey: string): string {
    const signature = createHash("sha256").update(clusterKey).digest("hex");
    return ["distillation.procedure", profileId, signature].join(":");
  }

  async function recordProcedureDistillation(
    input: RecordProcedureDistillationInput,
  ): Promise<RecordProcedureDistillationResult> {
    initialize();
    const sourceTrajectoryIds = [...new Set(input.sourceTrajectoryIds)].sort((left, right) =>
      left.localeCompare(right)
    );
    const eventKey = distillationEventKey(input.profileId, input.clusterKey);
    const embedding = await embeddingForWrite({
      kind: "procedure",
      sensitivity: input.sensitivity,
      content: input.content,
      embedding: input.embedding,
    });
    const tx = db.transaction((): RecordProcedureDistillationResult => {
      const existingEvidenceRow = db
        .prepare("SELECT * FROM gmos_evidence_events WHERE event_key = ?")
        .get(eventKey) as Record<string, unknown> | undefined;
      if (existingEvidenceRow) {
        const existingMemoryRow = db
          .prepare(
            `SELECT *
             FROM gmos_memories
             WHERE profile_id = ? AND source_event_id = ? AND kind = 'procedure'
             ORDER BY created_at ASC, id ASC
             LIMIT 1`,
          )
          .get(input.profileId, String(existingEvidenceRow.id)) as
          | Record<string, unknown>
          | undefined;
        if (existingMemoryRow) {
          return {
            memory: normalizeMemory(existingMemoryRow),
            alreadyExists: true,
          };
        }
      }

      const evidenceId = existingEvidenceRow ? String(existingEvidenceRow.id) : id("evidence");
      if (!existingEvidenceRow) {
        db.prepare(
          `INSERT INTO gmos_evidence_events (
            id, event_key, profile_id, source_type, source_uri, content, sensitivity,
            eligible_for_long_term_memory, payload_json, created_at
          ) VALUES (?, ?, ?, 'distillation', ?, ?, 'normal', 0, ?, ?)`,
        ).run(
          evidenceId,
          eventKey,
          input.profileId,
          null,
          "Procedure distillation",
          JSON.stringify({
            kind: "procedure",
            objective: input.objective,
            sourceTrajectoryIds,
            sharedTags: input.sharedTags,
            clusterKey: input.clusterKey,
          }),
          input.createdAt,
        );
      }

      const memoryId = id("memory");
      const metadata = {
        ...(input.metadata ?? {}),
        procedureDistillation: true,
        objective: input.objective,
        sourceTrajectoryIds,
        sharedTags: input.sharedTags,
        clusterKey: input.clusterKey,
      };
      db.prepare(
        `INSERT INTO gmos_memories (
          id, profile_id, kind, scope, content, sensitivity, status, confidence,
          source_event_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, 'procedure', 'global', ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).run(
        memoryId,
        input.profileId,
        input.content,
        input.sensitivity,
        input.confidence,
        evidenceId,
        JSON.stringify(metadata),
        input.createdAt,
        input.createdAt,
      );
      syncMemoryVector(memoryId, embedding);
      const memory = normalizeMemory(
        db.prepare("SELECT * FROM gmos_memories WHERE id = ?").get(memoryId) as Record<
          string,
          unknown
        >,
      );
      projectMemoryAssociations(memory, { replaceExisting: false });
      return {
        memory,
        alreadyExists: false,
      };
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

  function traceMemorySearchDecision(input: {
    trace: MemorySearchTraceCollector | undefined;
    memory: MemoryRecord;
    query: string;
    retrievalScore: number;
    ftsScore?: number | undefined;
    vectorScore?: number | undefined;
    associationScore?: number | undefined;
    fusionScore?: number | undefined;
    decision: "included" | "excluded";
    reason?: MemorySearchTraceDecisionReason | undefined;
  }): void {
    if (!input.trace) return;
    const scoreComponents = memorySearchScoreComponents({
      memory: input.memory,
      query: input.query,
      retrievalScore: input.retrievalScore,
      ftsScore: input.ftsScore,
      vectorScore: input.vectorScore,
      associationScore: input.associationScore,
      fusionScore: input.fusionScore,
    });
    input.trace.recordMemorySearchDecision({
      memory: input.memory,
      decision: input.decision,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      cues: matchedMemorySearchCues(input.memory, input.query),
      associations: memorySearchAssociations(input.memory),
      tags: memorySearchTags(input.memory),
      scoreComponents,
    });
  }

  type MemorySearchTraceDecisionReason =
    | "dormant"
    | "archived"
    | "superseded"
    | "out_of_window"
    | "sensitivity_gated"
    | "person_gated"
    | "forget_residue"
    | "budget_cut"
    | "below_score_threshold";

  function archivedMemoryExplanationReason(memory: MemoryRecord): MemorySearchTraceDecisionReason {
    if (memory.metadata.supersededBy || memory.metadata.consolidatedInto) return "superseded";
    const archive = memory.metadata.archive;
    if (!archive || typeof archive !== "object" || Array.isArray(archive)) return "forget_residue";
    const reason = (archive as Record<string, unknown>).reason;
    if (
      reason === "user_forget" ||
      reason === "derived_from_forgotten_source"
    ) {
      return "forget_residue";
    }
    return "archived";
  }

  function traceDormantAndArchivedSearchCandidates(input: {
    trace: MemorySearchTraceCollector | undefined;
    profileId: string;
    query: string;
    includeSensitive?: boolean | undefined;
    includeSecretLike?: boolean | undefined;
    includePerson?: boolean | undefined;
    seenMemoryIds: Set<string>;
  }): void {
    if (!input.trace || !input.query.trim()) return;
    for (const row of memoryRowsForList({
      profileId: input.profileId,
      query: input.query,
      status: "any",
      includeSensitive: true,
      includePerson: true,
      limit: 100,
    })) {
      const memory = normalizeMemory(row);
      if (input.seenMemoryIds.has(memory.id)) continue;
      if (memory.status !== "dormant" && memory.status !== "archived") continue;
      input.seenMemoryIds.add(memory.id);
      const sensitivity = effectiveMemorySensitivity(memory);
      const reason =
        !input.includePerson && memory.kind === "person"
          ? "person_gated"
          : !input.includeSecretLike && sensitivity === "secret_like"
            ? "sensitivity_gated"
            : shouldHideFromOrdinaryContext({
                sensitivity,
                includeSensitive: input.includeSensitive,
              })
              ? "sensitivity_gated"
              : memory.status === "dormant"
                ? "dormant"
                : archivedMemoryExplanationReason(memory);
      traceMemorySearchDecision({
        trace: input.trace,
        memory,
        query: input.query,
        retrievalScore: Number(row.__gmos_search_score ?? 0),
        decision: "excluded",
        reason,
      });
    }
  }

  function searchMemories(input: MemorySearchInput): MemoryRecord[] {
    initialize();
    const query = input.query?.trim() ?? "";
    const purpose = input.purpose ?? "context";
    const ordinaryRecallPurpose = purpose === "context" || purpose === "history";
    const asOfIso = purpose === "context" ? contextSearchReference(input.asOf) : "";
    const supersededHiddenMemoryIds =
      purpose === "context" && input.trace ? supersededSourceMemoryIds(input.profileId) : new Set<string>();
    const temporalHiddenMemoryIds =
      purpose === "context" && input.trace ? temporallyInvalidMemoryIds(input.profileId, asOfIso) : new Set<string>();
    const hiddenContextMemoryIds =
      purpose === "context"
        ? input.trace
          ? new Set([...supersededHiddenMemoryIds, ...temporalHiddenMemoryIds])
          : contextHiddenMemoryIds(input.profileId, asOfIso)
        : new Set<string>();
    const accepted: Array<{
      memory: MemoryRecord;
      retrievalScore: number;
      ftsScore?: number | undefined;
      vectorScore?: number | undefined;
      associationScore?: number | undefined;
      fusionScore?: number | undefined;
      score: number;
    }> = [];
    const tracedMemoryIds = new Set<string>();
    for (const row of memoryRowsForSearch(input)) {
      const memory = normalizeMemory(row);
      const retrievalScore = Number(row.__gmos_search_score ?? 0);
      const ftsScore = optionalNumber(row.__gmos_fts_score);
      const vectorScore = optionalNumber(row.__gmos_vector_score);
      const associationScore = optionalNumber(row.__gmos_association_score);
      const fusionScore = optionalNumber(row.__gmos_fusion_score);
      if (input.trace) tracedMemoryIds.add(memory.id);
      const sensitivity = effectiveMemorySensitivity(memory);
      const scoreComponents = memorySearchScoreComponents({
        memory,
        query,
        retrievalScore,
        ftsScore,
        vectorScore,
        associationScore,
        fusionScore,
      });
      let reason: MemorySearchTraceDecisionReason | null = null;
      if (!input.includePerson && memory.kind === "person") {
        reason = "person_gated";
      } else if (supersededHiddenMemoryIds.has(memory.id)) {
        reason = "superseded";
      } else if (temporalHiddenMemoryIds.has(memory.id)) {
        reason = "out_of_window";
      } else if (hiddenContextMemoryIds.has(memory.id)) {
        reason = "superseded";
      } else if (!input.includeSecretLike && sensitivity === "secret_like") {
        reason = "sensitivity_gated";
      } else if (
        ordinaryRecallPurpose &&
        shouldHideFromOrdinaryContext({
          sensitivity,
          includeSensitive: input.includeSensitive,
        })
      ) {
        reason = "sensitivity_gated";
      } else if (
        query &&
        scoreComponents.finalScore <= memory.confidence + (input.scoreThreshold ?? 0)
      ) {
        reason = "below_score_threshold";
      }
      if (reason) {
        traceMemorySearchDecision({
          trace: input.trace,
          memory,
          query,
          retrievalScore,
          ftsScore,
          vectorScore,
          associationScore,
          fusionScore,
          decision: "excluded",
          reason,
        });
        continue;
      }
      accepted.push({
        memory: attachInternalFusionScore(memory, fusionScore),
        retrievalScore,
        ftsScore,
        vectorScore,
        associationScore,
        fusionScore,
        score: scoreComponents.finalScore,
      });
    }
    accepted.sort((a, b) => b.score - a.score);
    const selected = accepted.slice(0, input.limit ?? 12);
    if (input.trace) {
      const selectedIds = new Set(selected.map((item) => item.memory.id));
      for (const item of accepted) {
        traceMemorySearchDecision({
          trace: input.trace,
          memory: item.memory,
          query,
          retrievalScore: item.retrievalScore,
          ftsScore: item.ftsScore,
          vectorScore: item.vectorScore,
          associationScore: item.associationScore,
          fusionScore: item.fusionScore,
          decision: selectedIds.has(item.memory.id) ? "included" : "excluded",
          ...(selectedIds.has(item.memory.id) ? {} : { reason: "budget_cut" }),
        });
      }
      traceDormantAndArchivedSearchCandidates({
        trace: input.trace,
        profileId: input.profileId,
        query,
        includeSensitive: input.includeSensitive,
        includeSecretLike: input.includeSecretLike,
        includePerson: input.includePerson,
        seenMemoryIds: tracedMemoryIds,
      });
    }
    return selected.map((item) => item.memory);
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
         WHERE profile_id = ? AND status IN ('active', 'dormant')
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
        `SELECT * FROM gmos_memories
         WHERE profile_id = ?
           AND status IN ('active', 'dormant')
           AND json_extract(metadata_json, '$.hostSnapshotImport') = 1
           AND json_extract(metadata_json, '$.hostImportSourceType') = ?
           ${activeKeyClause}`,
      )
      .all(input.profileId, input.sourceType, ...activeKeys) as Array<Record<string, unknown>>;
    const ids = candidates.map((row) => String(row.id));
    if (ids.length === 0) return [];
    const stmt = db.prepare(
      "UPDATE gmos_memories SET status = 'archived', updated_at = ? WHERE id = ?",
    );
    const tx = db.transaction((memoryRows: Array<Record<string, unknown>>) => {
      for (const row of memoryRows) {
        const memoryId = String(row.id);
        const previousValues = [memorySnapshotFromRow(row)];
        stmt.run(archivedAt, memoryId);
        syncMemoryVector(memoryId);
        deleteAssociationsForMemory(memoryId);
        rejectBeliefsForMemory(memoryId, archivedAt);
        insertLifecycleEvidence({
          profileId: input.profileId,
          sourceType: "memory.lifecycle",
          memoryId,
          from: String(row.status) as MemoryRecord["status"],
          to: "archived",
          createdAt: archivedAt,
          reasons: ["host_import_stale"],
          previousValues,
        });
      }
    });
    tx(candidates);
    return ids;
  }

  function commitOutcome(input: CommitOutcomeStoreInput): void {
    initialize();
    const occurredAt = input.createdAt ?? nowIso();
    const tx = db.transaction(() => {
      recordTaskTrajectory({
        profileId: input.profileId,
        taskId: input.taskId,
        objective: input.objective,
        status: input.status,
        summary: input.summary,
        createdAt: occurredAt,
      });
      if (input.failure) {
        recordFailure({
          ...input.failure,
          createdAt: input.failure.createdAt ?? occurredAt,
        });
      }
      recordMemoryUsageSignals({
        profileId: input.profileId,
        memoryIds: input.usedMemoryIds,
        usedAt: occurredAt,
      });
      const outcomeReinforcement = adjustOutcomeReinforcement({
        profileId: input.profileId,
        memoryIds: input.usedMemoryIds,
        status: input.status,
        failureKind: input.failure?.failureKind,
        config: input.outcomeReinforcement,
        updatedAt: occurredAt,
        confidenceAnnealing: input.confidenceAnnealing,
      });
      const provenanceCredit = applyProvenanceCredit({
        profileId: input.profileId,
        rootMemoryIds: input.usedMemoryIds,
        delta: outcomeReinforcement.delta,
        updatedAt: occurredAt,
        config: resolvedProvenanceCreditConfig(input.outcomeReinforcement),
      });
      attachProvenanceCreditToOutcomeEvidence({
        evidenceId: outcomeReinforcement.evidenceId,
        config: resolvedProvenanceCreditConfig(input.outcomeReinforcement),
        memoryCredits: provenanceCredit.memoryCredits,
        nonMemoryCredits: provenanceCredit.nonMemoryCredits,
        previousValues: [
          ...outcomeReinforcement.previousValues,
          ...provenanceCredit.previousValues,
        ],
      });
    });
    tx();
  }

  function recordFeedbackSignal(input: FeedbackSignalStoreInput): void {
    initialize();
    const recordedAt = input.createdAt ?? nowIso();
    const tx = db.transaction(() => {
      recordFailure({
        profileId: input.profileId,
        failureKind: input.failureKind,
        content: input.content,
        createdAt: recordedAt,
        metadata: {
          ...(input.metadata ?? {}),
          ...(input.relatedMemoryIds ? { relatedMemoryIds: uniqueMemoryIds(input.relatedMemoryIds) } : {}),
        },
      });
      adjustMemoryReinforcement({
        profileId: input.profileId,
        memoryIds: input.relatedMemoryIds,
        signal: input.signal,
        updatedAt: recordedAt,
        confidenceAnnealing: input.confidenceAnnealing,
      });
      const confidencePenalty = input.confidencePenalty ?? {
        enabled: true,
        step: 0.1,
        floor: 0.05,
      };
      if (input.failureKind === "wrong_recall" && confidencePenalty.enabled) {
        adjustMemoryConfidencePenalty({
          profileId: input.profileId,
          memoryIds: input.relatedMemoryIds,
          step: confidencePenalty.step,
          floor: confidencePenalty.floor,
          updatedAt: recordedAt,
        });
      }
    });
    tx();
  }

  function roundedScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, Number(value.toFixed(6))));
  }

  function explorationCandidate(input: {
    profileId: string;
    computedAt: string;
    raw: RawGapCandidate;
  }): MemoryGapCandidate {
    const subject = input.raw.subject.trim();
    const cue = input.raw.cue?.trim();
    return {
      id: memoryGapId({
        profileId: input.profileId,
        kind: input.raw.kind,
        subject,
        ...(cue ? { cue } : {}),
      }),
      profileId: input.profileId,
      kind: input.raw.kind,
      subject,
      ...(cue ? { cue } : {}),
      score: roundedScore(input.raw.score),
      supportingRecordIds: uniqueStrings(input.raw.supportingRecordIds).sort((left, right) =>
        left.localeCompare(right)
      ),
      computedAt: input.computedAt,
      payload: input.raw.payload,
    };
  }

  function explorationReportCandidate(
    candidate: MemoryGapCandidate,
  ): MaintenanceExplorationCandidate {
    return {
      id: candidate.id,
      kind: candidate.kind,
      subject: candidate.subject,
      ...(candidate.cue ? { cue: candidate.cue } : {}),
      score: candidate.score,
      supportingRecordIds: candidate.supportingRecordIds,
      computedAt: candidate.computedAt,
    };
  }

  function gapCandidateText(candidate: MemoryGapCandidate): string {
    return [
      candidate.subject,
      candidate.cue ?? "",
      candidate.kind,
      typeof candidate.payload.predicate === "string" ? candidate.payload.predicate : "",
      typeof candidate.payload.lastKnown === "string" ? candidate.payload.lastKnown : "",
    ].join(" ");
  }

  function gapPersonMaterial(candidate: MemoryGapCandidate): boolean {
    const predicate = typeof candidate.payload.predicate === "string" ? candidate.payload.predicate : "";
    if (predicate.startsWith("person.")) return true;
    if (isPersonRoutedMemory(candidate.subject) || isPersonRoutedMemory(candidate.cue ?? "")) return true;
    const sourceKinds = stringArrayFromUnknown(candidate.payload.sourceKinds);
    if (sourceKinds.includes("person")) return true;
    if (
      candidate.supportingRecordIds.some((recordId) => {
        const memory = db
          .prepare("SELECT kind, content FROM gmos_memories WHERE profile_id = ? AND id = ?")
          .get(candidate.profileId, recordId) as
          | { kind?: string; content?: string }
          | undefined;
        if (memory?.kind === "person") return true;
        if (memory?.content && isPersonRoutedMemory(memory.content)) return true;
        const belief = db
          .prepare("SELECT predicate, subject FROM gmos_world_beliefs WHERE profile_id = ? AND id = ?")
          .get(candidate.profileId, recordId) as
          | { predicate?: string; subject?: string }
          | undefined;
        return Boolean(
          belief?.predicate?.startsWith("person.") ||
            (belief?.subject && isPersonRoutedMemory(belief.subject)),
        );
      })
    ) {
      return true;
    }
    return false;
  }

  function gapHasRedactedEvidence(candidate: MemoryGapCandidate): boolean {
    for (const recordId of candidate.supportingRecordIds) {
      const direct = db
        .prepare("SELECT * FROM gmos_evidence_events WHERE profile_id = ? AND id = ?")
        .get(candidate.profileId, recordId) as Record<string, unknown> | undefined;
      if (direct && evidenceIsRedacted(normalizeEvidence(direct))) return true;
      const memory = db
        .prepare(
          `SELECT e.*
           FROM gmos_memories m
           JOIN gmos_evidence_events e ON e.id = m.source_event_id
           WHERE m.profile_id = ? AND m.id = ?`,
        )
        .get(candidate.profileId, recordId) as Record<string, unknown> | undefined;
      if (memory && evidenceIsRedacted(normalizeEvidence(memory))) return true;
    }
    return false;
  }

  function gapMatchesForgottenSubject(candidate: MemoryGapCandidate): boolean {
    const text = gapCandidateText(candidate).toLowerCase();
    const rows = db
      .prepare(
        `SELECT content, metadata_json
         FROM gmos_memories
         WHERE profile_id = ? AND status = 'archived'`,
      )
      .all(candidate.profileId) as Array<{ content: string; metadata_json: string }>;
    for (const row of rows) {
      const archive = parseJsonObject(row.metadata_json).archive;
      if (!archive || typeof archive !== "object" || Array.isArray(archive)) continue;
      const reason = (archive as Record<string, unknown>).reason;
      if (reason !== "user_forget" && reason !== "derived_from_forgotten_source") continue;
      if (candidate.supportingRecordIds.some((id) => row.content.includes(id))) return true;
      const terms = queryTerms(row.content).filter((term) => term.length >= 6);
      if (terms.length > 0 && terms.some((term) => text.includes(term))) return true;
    }
    return false;
  }

  function gapMatchesBoundary(candidate: MemoryGapCandidate): boolean {
    const candidateText = gapCandidateText(candidate).toLowerCase();
    const candidateKeys = [
      associationCueKey(candidate.subject),
      associationCueKey(candidate.cue ?? ""),
    ].filter(Boolean);
    const rows = db
      .prepare(
        `SELECT content
         FROM gmos_memories
         WHERE profile_id = ? AND status = 'active' AND kind = 'boundary'`,
      )
      .all(candidate.profileId) as Array<{ content: string }>;
    for (const row of rows) {
      const boundaryText = row.content.toLowerCase();
      if (candidateKeys.some((key) => key.length >= 2 && boundaryText.includes(key))) return true;
      const terms = queryTerms(row.content).filter((term) => term.length >= 6);
      if (terms.length > 0 && terms.some((term) => candidateText.includes(term))) return true;
    }
    return false;
  }

  function gapSuppressionReason(input: {
    candidate: MemoryGapCandidate;
    suppressGapIds?: Set<string> | undefined;
  }): MemoryGapSuppressionReason | null {
    if (input.suppressGapIds?.has(input.candidate.id)) return "host_suppressed";
    if (classifySensitivity(gapCandidateText(input.candidate)) !== "normal") {
      return "sensitive_material";
    }
    if (gapPersonMaterial(input.candidate)) return "person_material";
    if (gapHasRedactedEvidence(input.candidate)) return "redacted_evidence";
    if (gapMatchesForgottenSubject(input.candidate)) return "forgotten_subject";
    if (gapMatchesBoundary(input.candidate)) return "boundary_protected";
    return null;
  }

  function sourceMemoryForBelief(belief: WorldBeliefRecord): MemoryRecord | null {
    if (!belief.sourceMemoryId) return null;
    const row = memoryRowById(belief.profileId, belief.sourceMemoryId);
    return row ? normalizeMemory(row) : null;
  }

  function validFromOrCreatedAt(belief: WorldBeliefRecord): string {
    return metadataString(belief.metadata, ["validFrom", "valid_from"]) ?? belief.createdAt;
  }

  function staleBeliefCandidates(input: MaintenanceStoreInput): RawGapCandidate[] {
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) return [];
    const rows = db
      .prepare(
        `SELECT *
         FROM gmos_world_beliefs
         WHERE profile_id = ? AND status = 'active'
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
      )
      .all(input.profileId, input.exploration.maxCandidatesPerRun * 8) as Record<string, unknown>[];
    const candidates: RawGapCandidate[] = [];
    for (const belief of rows.map(normalizeWorldBelief)) {
      const sourceMemory = sourceMemoryForBelief(belief);
      const kind = sourceMemory?.kind ?? "fact";
      const validTo = parseInstant(metadataString(belief.metadata, ["validTo", "valid_to", "expiresAt"]));
      const validFrom = parseInstant(validFromOrCreatedAt(belief));
      const halfLifeDays = input.lifecycle.halfLivesDays[kind] ?? input.lifecycle.halfLivesDays.fact;
      const halfLifeMs = halfLifeDays * DAY_MS;
      const expired = validTo !== null && validTo <= nowMs;
      const tooOld = validFrom !== null && nowMs - validFrom > halfLifeMs;
      if (!expired && !tooOld) continue;
      const recall = sourceMemory?.recallCount ?? 0;
      const reinforcement = Math.max(0, sourceMemory?.reinforcement ?? 0);
      const demand = Math.min(1, Math.log1p(recall) / Math.log1p(20) + reinforcement / 2);
      const ageScore = expired
        ? 0.55
        : validFrom === null
          ? 0.2
          : Math.min(0.55, (nowMs - validFrom) / Math.max(1, halfLifeMs) * 0.25);
      candidates.push({
        kind: "stale_belief",
        subject: belief.subject,
        cue: belief.predicate,
        score: ageScore + demand * 0.45,
        supportingRecordIds: [belief.id, ...(sourceMemory ? [sourceMemory.id] : [])],
        payload: {
          predicate: belief.predicate,
          lastKnown: belief.object,
          validFrom: metadataString(belief.metadata, ["validFrom", "valid_from"]),
          validTo: metadataString(belief.metadata, ["validTo", "valid_to", "expiresAt"]),
          sourceKinds: sourceMemory ? [sourceMemory.kind] : [],
        },
      });
    }
    return candidates;
  }

  function contradictionHotspotCandidates(input: MaintenanceStoreInput): RawGapCandidate[] {
    const cutoff = new Date(Date.parse(input.now) - input.exploration.recentWindowDays * DAY_MS).toISOString();
    const rows = db
      .prepare(
        `SELECT active.*, COUNT(superseded.id) AS superseded_count
         FROM gmos_world_beliefs active
         JOIN gmos_world_beliefs superseded
           ON superseded.profile_id = active.profile_id
          AND superseded.subject = active.subject
          AND superseded.predicate = active.predicate
          AND superseded.status = 'superseded'
          AND superseded.updated_at >= ?
         WHERE active.profile_id = ?
           AND active.status = 'active'
           AND active.confidence < 0.65
         GROUP BY active.id
         ORDER BY superseded_count DESC, active.confidence ASC, active.updated_at DESC, active.id ASC
         LIMIT ?`,
      )
      .all(cutoff, input.profileId, input.exploration.maxCandidatesPerKind) as Array<
        Record<string, unknown> & { superseded_count?: number }
      >;
    return rows.map((row) => {
      const belief = normalizeWorldBelief(row);
      const sourceMemory = sourceMemoryForBelief(belief);
      const supersededCount = Number(row.superseded_count ?? 0);
      return {
        kind: "contradiction_hotspot" as const,
        subject: belief.subject,
        cue: belief.predicate,
        score: 0.35 + Math.min(0.3, supersededCount * 0.1) + (1 - belief.confidence) * 0.35,
        supportingRecordIds: [belief.id, ...(sourceMemory ? [sourceMemory.id] : [])],
        payload: {
          predicate: belief.predicate,
          lastKnown: belief.object,
          supersededCount,
          sourceKinds: sourceMemory ? [sourceMemory.kind] : [],
        },
      };
    });
  }

  function coverageGapCandidates(input: MaintenanceStoreInput): RawGapCandidate[] {
    const rows = db
      .prepare(
        `SELECT
           a.cue AS cue,
           a.cue_kind AS cue_kind,
           COUNT(DISTINCT m.id) AS memory_count,
           AVG(m.confidence) AS avg_confidence,
           SUM(COALESCE(m.recall_count, 0)) AS recall_count,
           SUM(MAX(COALESCE(m.reinforcement, 0), 0)) AS reinforcement_sum,
           GROUP_CONCAT(DISTINCT a.id) AS association_ids,
           GROUP_CONCAT(DISTINCT m.id) AS memory_ids,
           GROUP_CONCAT(DISTINCT m.kind) AS memory_kinds
         FROM gmos_associations a
         JOIN gmos_memories m ON m.id = a.source_memory_id
         WHERE a.profile_id = ?
           AND a.status = 'active'
           AND a.cue_kind IN ('entity', 'scope', 'predicate', 'task')
           AND m.status = 'active'
         GROUP BY a.cue
         HAVING recall_count >= 2
            AND (memory_count <= 2 OR avg_confidence < 0.6)
         ORDER BY recall_count DESC, avg_confidence ASC, a.cue ASC
         LIMIT ?`,
      )
      .all(input.profileId, input.exploration.maxCandidatesPerKind) as Array<{
        cue: string;
        memory_count: number;
        avg_confidence: number;
        recall_count: number;
        reinforcement_sum: number;
        association_ids?: string | null;
        memory_ids?: string | null;
        memory_kinds?: string | null;
      }>;
    return rows.map((row) => {
      const memoryCount = Number(row.memory_count);
      const avgConfidence = Number(row.avg_confidence);
      const recall = Number(row.recall_count);
      const reinforcement = Number(row.reinforcement_sum);
      const associationIds = String(row.association_ids ?? "").split(",").filter(Boolean);
      const memoryIds = String(row.memory_ids ?? "").split(",").filter(Boolean);
      return {
        kind: "coverage_gap" as const,
        subject: row.cue,
        cue: row.cue,
        score:
          Math.min(0.45, Math.log1p(recall) / Math.log1p(20) * 0.45) +
          Math.min(0.25, reinforcement * 0.1) +
          Math.max(0, 0.6 - avgConfidence) * 0.5 +
          (memoryCount <= 1 ? 0.2 : 0.1),
        supportingRecordIds: [...associationIds, ...memoryIds],
        payload: {
          memoryCount,
          averageConfidence: Number.isFinite(avgConfidence) ? Number(avgConfidence.toFixed(6)) : 0,
          recallCount: recall,
          lastKnown: `${memoryCount} linked memories`,
          sourceKinds: String(row.memory_kinds ?? "").split(",").filter(Boolean),
        },
      };
    });
  }

  function decayingProcedureCandidates(input: MaintenanceStoreInput): RawGapCandidate[] {
    const procedures = db
      .prepare(
        `SELECT *
         FROM gmos_memories
         WHERE profile_id = ? AND status = 'active' AND kind = 'procedure'
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`,
      )
      .all(input.profileId, input.exploration.maxCandidatesPerRun) as Record<string, unknown>[];
    const outcomes = (
      db
        .prepare(
          `SELECT id, payload_json, created_at
           FROM gmos_evidence_events
           WHERE profile_id = ? AND source_type = 'outcome'
           ORDER BY created_at DESC, id DESC
           LIMIT 200`,
        )
        .all(input.profileId) as Array<{ id: string; payload_json: string; created_at: string }>
    ).map((row) => ({
      id: row.id,
      payload: parseJsonObject(row.payload_json),
      createdAt: row.created_at,
    }));
    const candidates: RawGapCandidate[] = [];
    for (const procedure of procedures.map(normalizeMemory)) {
      const related = outcomes.filter((event) =>
        payloadStringArray(event.payload.memoryIds).includes(procedure.id)
      );
      const negative = related.filter((event) => Number(event.payload.delta) < 0);
      const positive = related.filter((event) => Number(event.payload.delta) > 0);
      if (negative.length === 0 || negative.length < positive.length) continue;
      candidates.push({
        kind: "decaying_procedure",
        subject: procedure.content,
        cue: procedure.scope !== "global" ? procedure.scope : "procedure",
        score:
          0.35 +
          Math.min(0.35, negative.length * 0.12) +
          Math.max(0, -(procedure.reinforcement ?? 0)) * 0.3,
        supportingRecordIds: [procedure.id, ...negative.map((event) => event.id)],
        payload: {
          lastKnown: procedure.content,
          negativeOutcomeCount: negative.length,
          positiveOutcomeCount: positive.length,
          sourceKinds: [procedure.kind],
        },
      });
    }
    return candidates;
  }

  function computeGapCandidates(input: MaintenanceStoreInput): MemoryGapCandidate[] {
    const raw = [
      ...staleBeliefCandidates(input),
      ...contradictionHotspotCandidates(input),
      ...coverageGapCandidates(input),
      ...decayingProcedureCandidates(input),
    ];
    const perKind = new Map<MemoryGapKind, number>();
    const byId = new Map<string, MemoryGapCandidate>();
    for (const candidate of raw
      .map((entry) => explorationCandidate({
        profileId: input.profileId,
        computedAt: input.now,
        raw: entry,
      }))
      .filter((entry) => entry.subject.trim().length > 0 && entry.score >= input.exploration.minScore)
      .sort((left, right) => {
        const score = right.score - left.score;
        if (score !== 0) return score;
        const kind = left.kind.localeCompare(right.kind);
        if (kind !== 0) return kind;
        return left.id.localeCompare(right.id);
      })) {
      const count = perKind.get(candidate.kind) ?? 0;
      if (count >= input.exploration.maxCandidatesPerKind) continue;
      perKind.set(candidate.kind, count + 1);
      if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
      if (byId.size >= input.exploration.maxCandidatesPerRun) break;
    }
    return [...byId.values()];
  }

  function replaceGapCandidates(profileId: string, candidates: MemoryGapCandidate[]): void {
    const tx = db.transaction((items: MemoryGapCandidate[]) => {
      db.prepare("DELETE FROM gmos_gap_candidates WHERE profile_id = ?").run(profileId);
      const stmt = db.prepare(
        `INSERT INTO gmos_gap_candidates (
          id, profile_id, gap_kind, subject, cue, score, supporting_record_ids_json,
          payload_json, computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const candidate of items) {
        stmt.run(
          candidate.id,
          candidate.profileId,
          candidate.kind,
          candidate.subject,
          candidate.cue ?? null,
          candidate.score,
          JSON.stringify(candidate.supportingRecordIds),
          JSON.stringify(candidate.payload),
          candidate.computedAt,
        );
      }
    });
    tx(candidates);
  }

  function previousGapIds(profileId: string): Set<string> {
    if (!tableExists("gmos_gap_candidates")) return new Set();
    return new Set(
      (
        db
          .prepare("SELECT id FROM gmos_gap_candidates WHERE profile_id = ?")
          .all(profileId) as Array<{ id: string }>
      ).map((row) => row.id),
    );
  }

  function gapCandidateMatchesQuery(candidate: MemoryGapCandidate, query: string): boolean {
    const terms = queryTerms(query);
    if (terms.length === 0) return true;
    const haystack = gapCandidateText(candidate).toLowerCase();
    if (terms.some((term) => haystack.includes(term))) return true;
    return associationCueMatchesQuery(candidate.subject, terms) ||
      Boolean(candidate.cue && associationCueMatchesQuery(candidate.cue, terms));
  }

  function listGapCandidates(
    input: MemoryGapCandidateListInput,
  ): MemoryGapCandidateSearchResult[] {
    initialize();
    if (!tableExists("gmos_gap_candidates")) return [];
    const suppressGapIds = new Set(input.suppressGapIds ?? []);
    const requestedLimit = limit(input.limit, 8, 100);
    const rows = db
      .prepare(
        `SELECT *
         FROM gmos_gap_candidates
         WHERE profile_id = ?
         ORDER BY score DESC, gap_kind ASC, subject ASC, id ASC
         LIMIT ?`,
      )
      .all(input.profileId, requestedLimit * 8) as Record<string, unknown>[];
    const results: MemoryGapCandidateSearchResult[] = [];
    let visibleCount = 0;
    let suppressedCount = 0;
    for (const candidate of rows.map(normalizeGapCandidate)) {
      if (!gapCandidateMatchesQuery(candidate, input.query ?? "")) continue;
      const suppressedReason = gapSuppressionReason({ candidate, suppressGapIds });
      if (suppressedReason) {
        if (input.includeSuppressed && suppressedCount < requestedLimit) {
          suppressedCount += 1;
          results.push({ candidate, suppressedReason });
        }
      } else if (visibleCount < requestedLimit) {
        visibleCount += 1;
        results.push({ candidate });
      }
      if (
        visibleCount >= requestedLimit &&
        (!input.includeSuppressed || suppressedCount >= requestedLimit)
      ) break;
    }
    return results;
  }

  function maintain(input: MaintenanceStoreInput): MaintenanceReport {
    initialize();
    const skipped = new Map<string, number>();
    const exempted: MaintenanceExemption[] = [];
    const consolidationSkipped = new Map<string, number>();
    const distillationSkipped = new Map<string, number>();
    const dossierSkipped = new Map<string, number>();
    const explorationSkipped = new Map<string, number>();
    const explorationSuppressed = new Map<string, number>();
    const rows = db
      .prepare(
        `SELECT *
         FROM gmos_memories
         WHERE profile_id = ? AND status IN ('active', 'dormant')
         ORDER BY updated_at ASC, id ASC`,
      )
      .all(input.profileId) as Record<string, unknown>[];
    let evaluated = 0;
    const transitions: MaintenanceTransition[] = [];
    const memories = rows.map(normalizeMemory);
    if (input.phases.includes("decay")) {
      if (!input.lifecycle.enabled) {
        incrementSkipped(skipped, "lifecycle_disabled");
      } else {
        for (const memory of memories) {
          if (!memoryKindCanAutoTransition(memory.kind, input.lifecycle)) {
            exempted.push({
              memoryId: memory.id,
              kind: memory.kind,
              status: memory.status,
              reason: "kind_exempt",
            });
            continue;
          }
          evaluated += 1;
          const transition = maintenanceTransitionForMemory(memory, input, skipped);
          if (transition) transitions.push(transition);
        }
      }
    } else {
      incrementSkipped(skipped, "phase_decay_not_requested");
    }

    const transitionByMemoryId = new Map(transitions.map((transition) => [transition.memoryId, transition]));
    const consolidationMemories = memories.flatMap((memory) => {
      const transition = transitionByMemoryId.get(memory.id);
      if (transition?.to === "archived") return [];
      if (transition?.to === "dormant") {
        return [{ ...memory, status: "dormant" as const, updatedAt: input.now }];
      }
      return [memory];
    });
    const duplicateClusters =
      input.phases.includes("consolidate") && input.consolidation.enabled
        ? selectDuplicateConsolidationClusters(consolidationMemories, input.consolidation)
        : [];
    if (!input.phases.includes("consolidate")) {
      incrementSkipped(consolidationSkipped, "phase_consolidate_not_requested");
    } else if (!input.consolidation.enabled) {
      incrementSkipped(consolidationSkipped, "consolidation_disabled");
    }
    if (!input.phases.includes("distill")) {
      incrementSkipped(distillationSkipped, "phase_distill_not_requested");
    } else if (!input.distillation.enabled) {
      incrementSkipped(distillationSkipped, "distillation_disabled");
    }
    if (!input.phases.includes("dossier")) {
      incrementSkipped(dossierSkipped, "phase_dossier_not_requested");
    } else if (!input.dossier.enabled) {
      incrementSkipped(dossierSkipped, "dossier_disabled");
    }
    let explorationGenerated: MemoryGapCandidate[] = [];
    let explorationCandidates: MemoryGapCandidate[] = [];
    let explorationClosedSinceLastRun = 0;
    if (!input.phases.includes("explore")) {
      incrementSkipped(explorationSkipped, "phase_explore_not_requested");
    } else if (!input.exploration.enabled) {
      incrementSkipped(explorationSkipped, "exploration_disabled");
    } else {
      const previousIds = previousGapIds(input.profileId);
      explorationGenerated = computeGapCandidates(input);
      const suppressedIds = new Set<string>();
      for (const candidate of explorationGenerated) {
        const reason = gapSuppressionReason({ candidate });
        if (reason) {
          incrementSkipped(explorationSuppressed, reason);
          suppressedIds.add(candidate.id);
          continue;
        }
        explorationCandidates.push(candidate);
      }
      const currentIds = new Set([
        ...explorationCandidates.map((candidate) => candidate.id),
        ...suppressedIds,
      ]);
      explorationClosedSinceLastRun = [...previousIds].filter((id) => !currentIds.has(id)).length;
    }
    if (!input.dryRun && (transitions.length > 0 || duplicateClusters.length > 0)) {
      const tx = db.transaction((items: MaintenanceTransition[], clusters: DuplicateConsolidationCluster[]) => {
        for (const transition of items) {
          applyMaintenanceTransition(transition, input.profileId, input.now);
        }
        for (const cluster of clusters) {
          applyDuplicateConsolidationCluster(cluster, input.profileId, input.now);
        }
      });
      tx(transitions, duplicateClusters);
    }
    if (!input.dryRun && input.phases.includes("explore") && input.exploration.enabled) {
      replaceGapCandidates(input.profileId, explorationCandidates);
    }
    return {
      schema: "gmos.maintenance_report.v1",
      profileId: input.profileId,
      now: input.now,
      dryRun: input.dryRun,
      evaluated,
      transitions,
      exempted,
      skipped: skippedSummaries(skipped),
      consolidation: {
        enabled: input.consolidation.enabled,
        evaluated: consolidationMemories.length,
        duplicateClusters: duplicateClusters.map((cluster) => ({
          kind: cluster.kind,
          survivorId: cluster.survivor.id,
          memberIds: cluster.members.map((member) => member.id),
          archivedMemberIds: cluster.archivedMembers.map((member) => member.id),
          reasons: cluster.reasons,
        })),
        summaryMemories: [],
        rejectedCandidates: [],
        skipped: skippedSummaries(consolidationSkipped),
      },
      distillation: {
        enabled: input.distillation.enabled,
        evaluated: 0,
        clusters: [],
        summaryMemories: [],
        rejectedCandidates: [],
        skipped: skippedSummaries(distillationSkipped),
      },
      dossier: {
        enabled: input.dossier.enabled,
        evaluated: 0,
        entities: [],
        summaryMemories: [],
        rejectedCandidates: [],
        skipped: skippedSummaries(dossierSkipped),
      },
      exploration: {
        enabled: input.exploration.enabled,
        evaluated: explorationGenerated.length,
        generated: explorationGenerated.length,
        persisted: input.dryRun ? 0 : explorationCandidates.length,
        closedSinceLastRun: explorationClosedSinceLastRun,
        candidates: explorationCandidates.map(explorationReportCandidate),
        suppressed: skippedSummaries(explorationSuppressed),
        skipped: skippedSummaries(explorationSkipped),
      },
    };
  }

  function lifecycleStatus(input: { profileId?: string | undefined } = {}): MemoryLifecycleStatus {
    initialize();
    const clauses = input.profileId ? "WHERE profile_id = ?" : "";
    const params = input.profileId ? [input.profileId] : [];
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM gmos_memories
         ${clauses}
         GROUP BY status`,
      )
      .all(...params) as Array<{ status: MemoryRecord["status"]; count: number }>;
    const counts: MemoryLifecycleStatus["counts"] = {
      active: 0,
      dormant: 0,
      archived: 0,
      total: 0,
    };
    for (const row of rows) {
      if (row.status !== "active" && row.status !== "dormant" && row.status !== "archived") {
        continue;
      }
      counts[row.status] = Number(row.count);
      counts.total += Number(row.count);
    }
    const lastMaintenanceRow = db
      .prepare(
        `SELECT created_at
         FROM gmos_evidence_events
         WHERE source_type = 'maintenance'
           ${input.profileId ? "AND profile_id = ?" : ""}
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(...params) as { created_at?: string | null } | undefined;
    const consolidationCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM gmos_evidence_events
             WHERE source_type = 'consolidation'
               ${input.profileId ? "AND profile_id = ?" : ""}`,
          )
          .get(...params) as { count: number }
      ).count,
    );
    const lastConsolidationRow = db
      .prepare(
        `SELECT created_at
         FROM gmos_evidence_events
         WHERE source_type = 'consolidation'
           ${input.profileId ? "AND profile_id = ?" : ""}
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(...params) as { created_at?: string | null } | undefined;
    return {
      schema: "gmos.lifecycle_status.v1",
      ...(input.profileId ? { profileId: input.profileId } : {}),
      counts,
      ...(lastMaintenanceRow?.created_at ? { lastMaintenanceAt: lastMaintenanceRow.created_at } : {}),
      consolidationEvidenceCount: consolidationCount,
      ...(lastConsolidationRow?.created_at
        ? { lastConsolidationAt: lastConsolidationRow.created_at }
        : {}),
    };
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
            sensitivity: effectiveMemorySensitivity(memory),
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

  function listEvidence(input: EvidenceListInput): EvidenceEvent[] {
    initialize();
    if (!tableExists("gmos_evidence_events")) return [];
    const clauses = ["profile_id = ?"];
    const params: Array<string | number> = [input.profileId];
    clauses.push(
      input.includeSensitive ? "sensitivity != 'secret_like'" : "sensitivity = 'normal'",
    );
    if (input.sourceType) {
      clauses.push("source_type = ?");
      params.push(input.sourceType);
    }
    if (input.eligibleForLongTermMemory !== undefined) {
      clauses.push("eligible_for_long_term_memory = ?");
      params.push(input.eligibleForLongTermMemory ? 1 : 0);
    }
    const rawLimit = input.limit;
    const requestedLimit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50;
    const limit = Math.max(1, Math.min(500, requestedLimit));
    const candidateLimit = 500;
    return (
      db
        .prepare(
          `SELECT *
           FROM gmos_evidence_events
           WHERE ${clauses.join(" AND ")}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(...params, candidateLimit) as Record<string, unknown>[]
    )
      .map(normalizeEvidence)
      .filter(
        (event) =>
          !shouldHideFromOrdinaryContext({
            sensitivity: effectiveEvidenceSensitivity(event),
            includeSensitive: input.includeSensitive,
          }),
      )
      .slice(0, limit);
  }

  function listEvidenceForMemory(memoryId: string): EvidenceEvent[] {
    initialize();
    if (!tableExists("gmos_memories") || !tableExists("gmos_evidence_events")) return [];
    const row = db
      .prepare("SELECT source_event_id, metadata_json FROM gmos_memories WHERE id = ?")
      .get(memoryId) as { source_event_id?: string | null; metadata_json?: string | null } | undefined;
    if (!row?.source_event_id) return [];
    const metadata = parseJsonObject(row.metadata_json);
    const windowEvidenceIds = Array.isArray(metadata.windowEvidenceIds)
      ? metadata.windowEvidenceIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const ids = [...new Set([row.source_event_id, ...windowEvidenceIds])];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM gmos_evidence_events WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    const byId = new Map(rows.map((evidenceRow) => [String(evidenceRow.id), evidenceRow]));
    return ids
      .flatMap((id) => {
        const evidenceRow = byId.get(id);
        return evidenceRow ? [evidenceRow] : [];
      })
      .map(normalizeEvidence)
      .filter((event) => effectiveEvidenceSensitivity(event) !== "secret_like");
  }

  function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  function evolutionActionMemoryId(action: EvolutionAction): string {
    return action.memoryId;
  }

  function memoryEvolutionPreviousValue(memory: MemoryRecord): EvolutionPreviousMemoryValue {
    return {
      memoryId: memory.id,
      confidence: memory.confidence,
      reinforcement: memory.reinforcement ?? 0,
      status: memory.status,
      updatedAt: memory.updatedAt,
    };
  }

  function syncEvolutionMemoryChange(input: {
    profileId: string;
    memoryId: string;
    previousStatus: MemoryRecord["status"];
    nextStatus: MemoryRecord["status"];
  }): void {
    syncMemoryVector(input.memoryId);
    if (input.previousStatus === "active" && input.nextStatus !== "active") {
      deactivateMemoryProjections(input.memoryId);
      return;
    }
    if (input.nextStatus === "active") {
      activateMemoryProjections(input.memoryId, input.profileId);
      const row = memoryRowById(input.profileId, input.memoryId);
      if (row) syncBeliefsForMemory(normalizeMemory(row));
    }
  }

  function updateEvolutionMemoryValue(input: {
    profileId: string;
    memoryId: string;
    confidence: number;
    reinforcement: number;
    status: MemoryRecord["status"];
    updatedAt: string;
    previousStatus: MemoryRecord["status"];
  }): void {
    db.prepare(
      `UPDATE gmos_memories
       SET confidence = ?,
           reinforcement = ?,
           status = ?,
           updated_at = ?
       WHERE profile_id = ? AND id = ? AND status IN ('active', 'dormant')`,
    ).run(
      input.confidence,
      input.reinforcement,
      input.status,
      input.updatedAt,
      input.profileId,
      input.memoryId,
    );
    syncEvolutionMemoryChange({
      profileId: input.profileId,
      memoryId: input.memoryId,
      previousStatus: input.previousStatus,
      nextStatus: input.status,
    });
  }

  function applyEvolutionActions(input: EvolutionApplyStoreInput): EvolutionApplyStoreResult {
    initialize();
    const tx = db.transaction((): EvolutionApplyStoreResult => {
      if (input.actions.length === 0) {
        throw new Error("gmOS evolution apply requires at least one action");
      }
      const memories = new Map<string, MemoryRecord>();
      for (const memoryId of uniqueMemoryIds(input.actions.map(evolutionActionMemoryId))) {
        const row = memoryRowById(input.profileId, memoryId);
        if (!row || row.status === "archived") {
          throw new Error(`gmOS evolution target memory not found or archived: ${memoryId}`);
        }
        memories.set(memoryId, normalizeMemory(row));
      }
      const previousValues = [...memories.values()].map(memoryEvolutionPreviousValue);
      const rollbackPreviousValues = [...memories.values()].map(memoryVersionSnapshot);
      const nextValues = new Map<string, EvolutionPreviousMemoryValue>(
        previousValues.map((value) => [value.memoryId, { ...value }]),
      );
      for (const action of input.actions) {
        const value = nextValues.get(action.memoryId);
        if (!value) throw new Error(`gmOS evolution target memory not found: ${action.memoryId}`);
        if (action.type === "adjust_reinforcement") {
          value.reinforcement = clampNumber(value.reinforcement + action.delta, -1, 1);
        } else if (action.type === "adjust_confidence") {
          value.confidence = clampNumber(value.confidence + action.delta, 0.05, 1);
        } else if (action.type === "demote_to_dormant") {
          value.status = "dormant";
        } else if (action.type === "reactivate") {
          value.status = "active";
        }
      }
      for (const value of nextValues.values()) {
        const previous = previousValues.find((entry) => entry.memoryId === value.memoryId);
        if (!previous) continue;
        updateEvolutionMemoryValue({
          profileId: input.profileId,
          memoryId: value.memoryId,
          confidence: value.confidence,
          reinforcement: value.reinforcement,
          status: value.status,
          updatedAt: input.appliedAt,
          previousStatus: previous.status,
        });
      }
      const applicationEventId = id("evidence");
      db.prepare(
        `INSERT INTO gmos_evidence_events (
          id, event_key, profile_id, source_type, source_uri, content, sensitivity,
          eligible_for_long_term_memory, payload_json, created_at
        ) VALUES (?, ?, ?, 'evolution', ?, ?, 'normal', 0, ?, ?)`,
      ).run(
        applicationEventId,
        [
          "evolution.apply",
          input.profileId,
          input.proposalId,
          input.appliedAt,
          randomUUID(),
        ].join(":"),
        input.profileId,
        null,
        "Evolution proposal application",
        JSON.stringify({
          proposalId: input.proposalId,
          approvedBy: input.approvedBy,
          actions: input.actions,
          previousValues: rollbackPreviousValues,
        }),
        input.appliedAt,
      );
      return {
        applicationEventId,
        proposalId: input.proposalId,
        actions: input.actions,
        previousValues,
        appliedAt: input.appliedAt,
      };
    });
    return tx();
  }

  function previousValuesFromEvolutionPayload(
    payload: Record<string, unknown>,
  ): EvolutionPreviousMemoryValue[] {
    const raw = payload.previousValues;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (
        typeof record.memoryId !== "string" ||
        typeof record.confidence !== "number" ||
        typeof record.reinforcement !== "number" ||
        typeof record.status !== "string" ||
        typeof record.updatedAt !== "string"
      ) {
        return [];
      }
      if (
        record.status !== "active" &&
        record.status !== "dormant" &&
        record.status !== "archived"
      ) {
        return [];
      }
      return [{
        memoryId: record.memoryId,
        confidence: record.confidence,
        reinforcement: record.reinforcement,
        status: record.status,
        updatedAt: record.updatedAt,
      }];
    });
  }

  function revertEvolutionApplication(
    input: EvolutionRevertStoreInput,
  ): EvolutionRevertStoreResult {
    initialize();
    const tx = db.transaction((): EvolutionRevertStoreResult => {
      const applicationRow = db
        .prepare(
          `SELECT *
           FROM gmos_evidence_events
           WHERE id = ? AND source_type = 'evolution'
             ${input.profileId ? "AND profile_id = ?" : ""}
           LIMIT 1`,
        )
        .get(
          input.applicationEventId,
          ...(input.profileId ? [input.profileId] : []),
        ) as Record<string, unknown> | undefined;
      if (!applicationRow) {
        throw new Error("gmOS evolution application evidence not found");
      }
      const alreadyReverted = db
        .prepare(
          `SELECT id
           FROM gmos_evidence_events
           WHERE source_type = 'evolution'
             AND json_extract(payload_json, '$.revertedApplicationEventId') = ?
           LIMIT 1`,
        )
        .get(input.applicationEventId) as { id?: string } | undefined;
      if (alreadyReverted) {
        throw new Error("gmOS evolution application already reverted");
      }
      const application = normalizeEvidence(applicationRow);
      const previousValues = previousValuesFromEvolutionPayload(application.payload);
      if (previousValues.length === 0) {
        throw new Error("gmOS evolution application evidence has no previousValues");
      }
      const rollbackPreviousValues: MemoryVersionSnapshot[] = [];
      for (const previous of previousValues) {
        const row = memoryRowById(application.profileId, previous.memoryId);
        if (!row || row.status === "archived") {
          throw new Error(`gmOS evolution revert target memory not found or archived: ${previous.memoryId}`);
        }
        rollbackPreviousValues.push(memorySnapshotFromRow(row));
        updateEvolutionMemoryValue({
          profileId: application.profileId,
          memoryId: previous.memoryId,
          confidence: previous.confidence,
          reinforcement: previous.reinforcement,
          status: previous.status,
          updatedAt: previous.updatedAt,
          previousStatus: String(row.status) as MemoryRecord["status"],
        });
      }
      const revertEventId = id("evidence");
      db.prepare(
        `INSERT INTO gmos_evidence_events (
          id, event_key, profile_id, source_type, source_uri, content, sensitivity,
          eligible_for_long_term_memory, payload_json, created_at
        ) VALUES (?, ?, ?, 'evolution', ?, ?, 'normal', 0, ?, ?)`,
      ).run(
        revertEventId,
        [
          "evolution.revert",
          application.profileId,
          input.applicationEventId,
          input.revertedAt,
          randomUUID(),
        ].join(":"),
        application.profileId,
        null,
        "Evolution proposal application revert",
        JSON.stringify({
          revertedApplicationEventId: input.applicationEventId,
          proposalId: application.payload.proposalId,
          actions: application.payload.actions,
          previousValues: rollbackPreviousValues,
          restoredValues: previousValues,
        }),
        input.revertedAt,
      );
      return {
        revertEventId,
        applicationEventId: input.applicationEventId,
        restoredValues: previousValues,
        revertedAt: input.revertedAt,
      };
    });
    return tx();
  }

  function rollbackMemory(
    input: MemoryRollbackInput & { profileId: string },
  ): MemoryRollbackResult {
    initialize();
    const approvedBy = input.approvedBy.trim();
    if (!approvedBy) {
      throw new MemoryRollbackError(
        "approved_by_required",
        "gmOS memory rollback requires approvedBy",
      );
    }
    const rolledBackAt = input.rolledBackAt ?? nowIso();
    const tx = db.transaction((): MemoryRollbackResult => {
      const currentRow = memoryRowById(input.profileId, input.memoryId);
      if (!currentRow) {
        throw new MemoryRollbackError(
          "memory_not_found",
          `gmOS rollback target memory not found: ${input.memoryId}`,
        );
      }
      const current = memorySnapshotFromRow(currentRow);
      const targetRow = db
        .prepare(
          `SELECT *
           FROM gmos_evidence_events
           WHERE profile_id = ? AND id = ?
           LIMIT 1`,
        )
        .get(input.profileId, input.toEvidenceEventId) as Record<string, unknown> | undefined;
      if (!targetRow) {
        throw new MemoryRollbackError(
          "target_event_not_found",
          `gmOS rollback target evidence event not found: ${input.toEvidenceEventId}`,
        );
      }
      const target = normalizeEvidence(targetRow);
      const rows = db
        .prepare(
          `SELECT *
           FROM gmos_evidence_events
           WHERE profile_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(input.profileId) as Record<string, unknown>[];
      const historicalSourceEventIds = new Set<string>();
      if (current.sourceEventId) historicalSourceEventIds.add(current.sourceEventId);
      for (const row of rows) {
        const event = normalizeEvidence(row);
        for (const previous of previousValuesFromPayload(event.payload)) {
          if (previous.memoryId === input.memoryId && previous.sourceEventId) {
            historicalSourceEventIds.add(previous.sourceEventId);
          }
        }
      }
      if (
        !historicalSourceEventIds.has(target.id) &&
        !payloadReferencesMemory(target.payload, input.memoryId)
      ) {
        throw new MemoryRollbackError(
          "target_event_not_in_chain",
          "gmOS rollback target evidence event is not in the memory chain",
        );
      }

      let restored = current;
      for (const row of rows) {
        const event = normalizeEvidence(row);
        const afterTarget =
          event.createdAt > target.createdAt ||
          (event.createdAt === target.createdAt && event.id > target.id);
        if (!afterTarget) continue;
        if (!historicalSourceEventIds.has(event.id) && !payloadReferencesMemory(event.payload, input.memoryId)) {
          continue;
        }
        const previous = previousValuesFromPayload(event.payload)
          .find((value) => value.memoryId === input.memoryId);
        if (!previous) {
          throw new MemoryRollbackError(
            "missing_previous_values",
            `gmOS rollback cannot cross pre-M13 evidence without previousValues: ${event.id}`,
          );
        }
        restored = previous;
      }

      applyMemorySnapshot(restored);
      const rollbackEventId = insertMutationEvidence({
        profileId: input.profileId,
        sourceType: "memory.rollback",
        content: "Memory forensic rollback",
        createdAt: rolledBackAt,
        payload: {
          memoryId: input.memoryId,
          toEvidenceEventId: input.toEvidenceEventId,
          approvedBy,
          restoredValues: [restored],
        },
        previousValues: [current],
      });
      return {
        rollbackEventId,
        profileId: input.profileId,
        memoryId: input.memoryId,
        toEvidenceEventId: input.toEvidenceEventId,
        approvedBy,
        restoredValue: restored,
        previousValues: [current],
        rolledBackAt,
      };
    });
    return tx();
  }

  function forget(input: ForgetInput & { profileId: string }): ForgetResult {
    initialize();
    const structuredTerms = structuredForgetTargetTerms(input.targetTerms);
    if (structuredTerms !== null && structuredTerms.length === 0) {
      return { archivedMemoryIds: [] };
    }
    const parsedTerms = structuredTerms ?? parsedForgetTargetTerms(options.forgetTargetParser, {
      query: input.query,
      reason: input.reason,
    });
    if (parsedTerms !== null && parsedTerms.length === 0) {
      return { archivedMemoryIds: [] };
    }
    const terms = parsedTerms ?? queryTerms(input.query);
    if (terms.length === 0) {
      return { archivedMemoryIds: [] };
    }
    const searchQuery = terms.length > 0 ? terms.join(" ") : input.query;
    const matches = searchMemories({
      profileId: input.profileId,
      query: searchQuery,
      purpose: "delete",
      includeSensitive: true,
      includeSecretLike: true,
      includePerson: true,
      limit: 100,
    }).filter((memory) => memoryMatchesForgetQuery(memory, terms));
    const matchedMemoryIds = matches.map((memory) => memory.id);
    const derivedMemoryIds = derivedSummaryIdsForForgottenSources(
      input.profileId,
      matchedMemoryIds,
    );
    const forgottenAt = nowIso();
    const archivedMemoryIds = archiveForgetMemoryIds({
      profileId: input.profileId,
      memoryIds: matchedMemoryIds,
      derivedMemoryIds,
      archivedAt: forgottenAt,
    });
    redactEvidenceForForgottenMemories({
      profileId: input.profileId,
      archivedMemoryIds,
      redactedAt: forgottenAt,
    });
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

  function listTaskTrajectories(input: {
    profileId: string;
    limit?: number | undefined;
  }): TaskTrajectoryRecord[] {
    initialize();
    if (!tableExists("gmos_task_trajectories")) return [];
    return (
      db
        .prepare(
          `SELECT *
           FROM gmos_task_trajectories
           WHERE profile_id = ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
        )
        .all(input.profileId, limit(input.limit, 100, 1000)) as Record<string, unknown>[]
    ).map(normalizeTaskTrajectory);
  }

  function searchAssociations(input: MemoryAssociationSearchInput): MemoryAssociationRecord[] {
    initialize();
    const query = input.query.trim();
    const purpose = input.purpose ?? "context";
    const asOfIso = contextSearchReference(input.asOf);
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
      projectMemoryAssociations(memory, { replaceExisting: false });
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
      "gmos_gap_candidates",
      "gmos_memory_vectors",
      "gmos_memory_vector_terms",
      "gmos_profiles",
      "gmos_api_keys",
      "gmos_http_audit_log",
      "gmos_autopilot_runs",
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

  function sqliteValueForHash(value: unknown): unknown {
    if (Buffer.isBuffer(value)) {
      return { type: "blob", hex: value.toString("hex") };
    }
    return value ?? null;
  }

  function hashReadAuditShadowTable(hash: ReturnType<typeof createHash>, tableName: string): void {
    if (!tableExists(tableName)) return;
    const columns = (
      db.prepare(`PRAGMA table_info(${quotedIdentifier(tableName)})`).all() as Array<{
        name?: string;
      }>
    )
      .map((column) => column.name)
      .filter((column): column is string => typeof column === "string" && column.length > 0);
    if (columns.length === 0) return;
    const columnsSql = columns.map(quotedIdentifier).join(", ");
    const orderSql = columns.map(quotedIdentifier).join(", ");
    hash.update(`shadow:${tableName}\n`);
    for (const row of db
      .prepare(
        `SELECT ${columnsSql}
         FROM ${quotedIdentifier(tableName)}
         ORDER BY ${orderSql}`,
      )
      .iterate() as Iterable<Record<string, unknown>>) {
      hash.update(JSON.stringify(columns.map((column) => sqliteValueForHash(row[column]))));
      hash.update("\n");
    }
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
    for (const suffix of ["_data", "_idx", "_docsize", "_config"]) {
      hashReadAuditShadowTable(hash, `${table.name}${suffix}`);
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

  function encryptionStatus(): SqliteMemoryStoreEncryptionStatus {
    return {
      encrypted,
      mode: encrypted ? "host_driver" : "plaintext",
    };
  }

  function createServiceApiKey(
    input: CreateSqliteServiceApiKeyInput,
  ): SqliteServiceApiKeyWithSecret {
    initialize();
    return createSqliteServiceApiKey(db, input);
  }

  function listServiceApiKeys(): SqliteServiceApiKey[] {
    initialize();
    return listSqliteServiceApiKeys(db);
  }

  function revokeServiceApiKey(keyId: string): SqliteServiceApiKey | null {
    initialize();
    return revokeSqliteServiceApiKey(db, keyId);
  }

  function authenticateServiceApiKey(secret: string): SqliteServiceApiKey | null {
    initialize();
    return authenticateSqliteServiceApiKey(db, secret);
  }

  function serviceApiKeyCount(): number {
    initialize();
    return sqliteServiceApiKeyCount(db);
  }

  function recordServiceAudit(input: SqliteServiceAuditInput): void {
    initialize();
    recordSqliteServiceAudit(db, input);
  }

  function listServiceAuditRows(
    input: ListSqliteServiceAuditInput = {},
  ): SqliteServiceAuditRow[] {
    initialize();
    return listSqliteServiceAuditRows(db, input);
  }

  function pruneServiceAuditRows(retentionDays: number): number {
    initialize();
    return pruneSqliteServiceAuditRows(db, retentionDays);
  }

  function listServiceProfiles(): SqliteServiceProfileSummary[] {
    initialize();
    return listSqliteServiceProfiles(db);
  }

  function ensureServiceProfile(profileId: string): SqliteServiceProfileSummary {
    initialize();
    return ensureSqliteServiceProfile(db, profileId);
  }

  function recordAutopilotRun(input: SqliteAutopilotRunInput): SqliteAutopilotRun {
    initialize();
    return recordSqliteAutopilotRun(db, input);
  }

  function listAutopilotRuns(
    input: ListSqliteAutopilotRunsInput = {},
  ): SqliteAutopilotRun[] {
    initialize();
    return listSqliteAutopilotRuns(db, input);
  }

  function pruneAutopilotRuns(retention: number, profileId?: string | undefined): number {
    initialize();
    return pruneSqliteAutopilotRuns(db, retention, profileId);
  }

  return {
    configureEmbeddingProvider,
    initialize,
    close() {
      statementCache.clear();
      if (!options.handle) db.close();
    },
    claimEvidence,
    recordEvidence,
    getEvidenceByEventKey,
    addMemory,
    addMemories,
    updateMemory,
    archiveMemoryById,
    restoreArchivedMemory,
    archiveMemories,
    addWorldBelief,
    listWorldBeliefs,
    searchMemories,
    listMemories,
    getMemoryById,
    findActiveMemoryByMetadata,
    archiveStaleHostImports,
    commitOutcome,
    recordFeedbackSignal,
    maintain,
    recordConsolidationSummary,
    listTaskTrajectories,
    recordProcedureDistillation,
    applyEvolutionActions,
    revertEvolutionApplication,
    rollbackMemory,
    lifecycleStatus,
    listActionPolicies,
    listGapCandidates,
    listEvidence,
    listEvidenceForMemory,
    searchAssociations,
    rebuildAssociations,
    forget,
    recordFailure,
    listFailures,
    recordTaskTrajectory,
    rowCounts,
    encryptionStatus,
    readAuditSnapshot,
    schemaVersion,
    searchIndexStatus,
    repairSearchIndex,
    createServiceApiKey,
    listServiceApiKeys,
    revokeServiceApiKey,
    authenticateServiceApiKey,
    serviceApiKeyCount,
    recordServiceAudit,
    listServiceAuditRows,
    pruneServiceAuditRows,
    listServiceProfiles,
    ensureServiceProfile,
    recordAutopilotRun,
    listAutopilotRuns,
    pruneAutopilotRuns,
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
    exportProfileBundle(input) {
      initialize();
      return exportSqliteProfileBackup(db, input);
    },
    importProfileBundle(input) {
      initialize();
      const report = restoreSqliteProfileBackup(db, input);
      rebuildAssociations({ profileId: report.targetProfileId });
      return report;
    },
  };
}
