import type { EvidenceEvent, Sensitivity } from "./types.js";

export const GMOS_EVIDENCE_PAYLOAD_SCHEMAS = {
  conversationMessage: "gmos.evidence.conversation_message.v1",
  consolidationDuplicate: "gmos.evidence.consolidation_duplicate.v1",
  consolidationSummary: "gmos.evidence.consolidation_summary.v1",
  dossier: "gmos.evidence.dossier.v1",
  evolutionApply: "gmos.evidence.evolution_apply.v1",
  evolutionRevert: "gmos.evidence.evolution_revert.v1",
  feedbackConfidencePenalty: "gmos.evidence.feedback_confidence_penalty.v1",
  feedbackReinforcement: "gmos.evidence.feedback_reinforcement.v1",
  lifecycleTransition: "gmos.evidence.lifecycle_transition.v1",
  memoryReinforcement: "gmos.evidence.memory_reinforcement.v1",
  memoryRollback: "gmos.evidence.memory_rollback.v1",
  memoryUpdate: "gmos.evidence.memory_update.v1",
  memoryUsage: "gmos.evidence.memory_usage.v1",
  mem0Import: "gmos.evidence.mem0_import.v1",
  outcomeReinforcement: "gmos.evidence.outcome_reinforcement.v1",
  profileSnapshotPoint: "gmos.evidence.profile_snapshot_point.v1",
  procedureDistillation: "gmos.evidence.procedure_distillation.v1",
  sdkLowLevelAdd: "gmos.evidence.sdk_low_level_add.v1",
  sdkLowLevelUpdate: "gmos.evidence.sdk_low_level_update.v1",
  sessionDistillation: "gmos.evidence.session_distillation.v1",
  hostSnapshotImport: "gmos.evidence.host_snapshot_import.v1",
} as const;

export type GmosEvidencePayloadSchema =
  (typeof GMOS_EVIDENCE_PAYLOAD_SCHEMAS)[keyof typeof GMOS_EVIDENCE_PAYLOAD_SCHEMAS];

const KNOWN_GMOS_EVIDENCE_PAYLOAD_SCHEMAS: ReadonlySet<string> = new Set(
  Object.values(GMOS_EVIDENCE_PAYLOAD_SCHEMAS),
);

export interface GmosEvidenceReferenceShape {
  evidenceIdFields?: readonly string[] | undefined;
  evidenceIdArrays?: readonly string[] | undefined;
  memoryIdFields?: readonly string[] | undefined;
  memoryIdArrays?: readonly string[] | undefined;
  beliefIdArrays?: readonly string[] | undefined;
  trajectoryIdArrays?: readonly string[] | undefined;
  actionArrays?: readonly string[] | undefined;
  snapshotArrays?: readonly string[] | undefined;
  provenanceCredit?: boolean | undefined;
}

export const GMOS_EVIDENCE_REFERENCE_SHAPES: Readonly<
  Record<GmosEvidencePayloadSchema, GmosEvidenceReferenceShape>
> = {
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.conversationMessage]: {},
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.sessionDistillation]: {
    evidenceIdArrays: ["evidenceIds"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.consolidationDuplicate]: {
    memoryIdFields: ["survivorId", "archivedMemberId"],
    memoryIdArrays: ["memberIds"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.consolidationSummary]: {
    memoryIdArrays: ["sourceMemoryIds"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.dossier]: {
    memoryIdFields: ["supersededMemoryId"],
    memoryIdArrays: ["sourceMemoryIds"],
    beliefIdArrays: ["sourceBeliefIds"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.evolutionApply]: {
    actionArrays: ["actions"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.evolutionRevert]: {
    evidenceIdFields: ["revertedApplicationEventId"],
    actionArrays: ["actions"],
    snapshotArrays: ["previousValues", "restoredValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.feedbackConfidencePenalty]: {
    memoryIdArrays: ["memoryIds"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.feedbackReinforcement]: {
    memoryIdArrays: ["memoryIds"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.lifecycleTransition]: {
    memoryIdFields: ["memoryId"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.memoryReinforcement]: {
    memoryIdArrays: ["memoryIds"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.memoryRollback]: {
    evidenceIdFields: ["toEvidenceEventId"],
    memoryIdFields: ["memoryId"],
    snapshotArrays: ["previousValues", "restoredValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.memoryUpdate]: {
    memoryIdFields: ["memoryId"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.memoryUsage]: {
    memoryIdArrays: ["memoryIds"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.mem0Import]: {},
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.outcomeReinforcement]: {
    memoryIdArrays: ["memoryIds", "propagatedMemoryIds"],
    snapshotArrays: ["previousValues"],
    provenanceCredit: true,
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.profileSnapshotPoint]: {},
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.procedureDistillation]: {
    trajectoryIdArrays: ["sourceTrajectoryIds"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.sdkLowLevelAdd]: {},
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.sdkLowLevelUpdate]: {
    memoryIdFields: ["memoryId"],
    snapshotArrays: ["previousValues"],
  },
  [GMOS_EVIDENCE_PAYLOAD_SCHEMAS.hostSnapshotImport]: {},
};

function isGmosEvidencePayloadSchema(value: unknown): value is GmosEvidencePayloadSchema {
  return typeof value === "string" && KNOWN_GMOS_EVIDENCE_PAYLOAD_SCHEMAS.has(value);
}

export function gmosEvidencePayloadSchemaOf(
  payload: Readonly<Record<string, unknown>>,
): GmosEvidencePayloadSchema | null {
  return isGmosEvidencePayloadSchema(payload._gmosSchema) ? payload._gmosSchema : null;
}

export function gmosEvidenceReferenceShapeOf(
  payload: Readonly<Record<string, unknown>>,
): GmosEvidenceReferenceShape | null {
  const schema = gmosEvidencePayloadSchemaOf(payload);
  return schema ? GMOS_EVIDENCE_REFERENCE_SHAPES[schema] : null;
}

export function markedGmosEvidencePayload(
  schema: GmosEvidencePayloadSchema,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...payload, _gmosSchema: schema };
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const expected = [...keys].sort();
  return Object.keys(record).sort().every((key, index) => key === expected[index]) &&
    Object.keys(record).length === expected.length;
}

export function isLegacyMem0ImportEvidence(
  event: EvidenceEvent,
  expected: {
    profileId: string;
    eventKey: string;
    sourceUri: string;
    content: string;
    sensitivity: Sensitivity;
    originalId: string;
    sourceFileHash: string;
    recordIndex: number;
  },
): boolean {
  const payload = event.payload;
  return (
    payload._gmosSchema === undefined &&
    hasExactKeys(payload, [
      "importSource",
      "importSourceOriginalId",
      "provenance",
      "recordIndex",
      "sourceFileHash",
      "sourceTrust",
    ]) &&
    event.profileId === expected.profileId &&
    event.eventKey === expected.eventKey &&
    event.sourceType === "mem0.import" &&
    event.sourceUri === expected.sourceUri &&
    event.content === expected.content &&
    event.sensitivity === expected.sensitivity &&
    event.eligibleForLongTermMemory === (expected.sensitivity !== "secret_like") &&
    payload.importSource === "mem0" &&
    payload.importSourceOriginalId === expected.originalId &&
    payload.sourceFileHash === expected.sourceFileHash &&
    payload.recordIndex === expected.recordIndex &&
    payload.provenance === "low_level_import" &&
    payload.sourceTrust === "external"
  );
}

export function isCurrentMem0ImportEvidence(
  event: EvidenceEvent,
  expected: {
    profileId: string;
    eventKey: string;
    sourceUri: string;
    content: string;
    sensitivity: Sensitivity;
    originalId: string;
    sourceFileHash: string;
    recordIndex: number;
  },
): boolean {
  const payload = event.payload;
  return (
    gmosEvidencePayloadSchemaOf(payload) === GMOS_EVIDENCE_PAYLOAD_SCHEMAS.mem0Import &&
    event.profileId === expected.profileId &&
    event.eventKey === expected.eventKey &&
    event.sourceType === "mem0.import" &&
    event.sourceUri === expected.sourceUri &&
    event.content === expected.content &&
    event.sensitivity === expected.sensitivity &&
    event.eligibleForLongTermMemory === true &&
    payload.importSource === "mem0" &&
    payload.importSourceOriginalId === expected.originalId &&
    payload.sourceFileHash === expected.sourceFileHash &&
    payload.recordIndex === expected.recordIndex &&
    payload.provenance === "low_level_import" &&
    payload.sourceTrust === "external"
  );
}

export function isLegacyHostSnapshotImportEvidence(
  event: EvidenceEvent,
  expected: {
    profileId: string;
    eventKey: string;
    sourceType: string;
    sourceUri: string;
    content: string;
    sensitivity: Sensitivity;
    hostMemoryId: string;
    hostMemoryKind: string;
  },
): boolean {
  const payload = event.payload;
  return (
    payload._gmosSchema === undefined &&
    hasExactKeys(payload, ["hostMemoryId", "hostMemoryKind", "sourceTrust"]) &&
    event.profileId === expected.profileId &&
    event.eventKey === expected.eventKey &&
    event.sourceType === expected.sourceType &&
    event.sourceUri === expected.sourceUri &&
    event.content === expected.content &&
    event.sensitivity === expected.sensitivity &&
    event.eligibleForLongTermMemory === (expected.sensitivity !== "secret_like") &&
    payload.hostMemoryId === expected.hostMemoryId &&
    payload.hostMemoryKind === expected.hostMemoryKind &&
    payload.sourceTrust === "external"
  );
}

export function isCurrentHostSnapshotImportEvidence(
  event: EvidenceEvent,
  expected: {
    profileId: string;
    eventKey: string;
    sourceType: string;
    sourceUri: string;
    content: string;
    sensitivity: Sensitivity;
    hostMemoryId: string;
    hostMemoryKind: string;
  },
): boolean {
  const payload = event.payload;
  return (
    gmosEvidencePayloadSchemaOf(payload) ===
      GMOS_EVIDENCE_PAYLOAD_SCHEMAS.hostSnapshotImport &&
    event.profileId === expected.profileId &&
    event.eventKey === expected.eventKey &&
    event.sourceType === expected.sourceType &&
    event.sourceUri === expected.sourceUri &&
    event.content === expected.content &&
    event.sensitivity === expected.sensitivity &&
    event.eligibleForLongTermMemory === (expected.sensitivity !== "secret_like") &&
    payload.hostMemoryId === expected.hostMemoryId &&
    payload.hostMemoryKind === expected.hostMemoryKind &&
    payload.sourceTrust === "external"
  );
}

export function isLegacyProfileSnapshotPointEvidence(event: EvidenceEvent): boolean {
  const payload = event.payload;
  const name = typeof payload.name === "string" ? payload.name : "";
  const expectedFileName = `${event.createdAt.replace(/[:.]/gu, "-")}-${name}.gmos-profile-bundle.json`;
  return (
    payload._gmosSchema === undefined &&
    hasExactKeys(payload, [
      "bundleSchema",
      "bytes",
      "createdAt",
      "fileName",
      "mode",
      "name",
      "schema",
      "sha256",
    ]) &&
    event.sourceType === "snapshot" &&
    event.eventKey === ["snapshot", event.profileId, event.createdAt, name].join(":") &&
    event.sourceUri === null &&
    event.content === "Profile snapshot point" &&
    event.sensitivity === "normal" &&
    event.eligibleForLongTermMemory === false &&
    payload.schema === "gmos.profile_snapshot_point.v1" &&
    /^[A-Za-z0-9_.-]{1,80}$/u.test(name) &&
    typeof payload.fileName === "string" &&
    payload.fileName === expectedFileName &&
    typeof payload.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(payload.sha256) &&
    typeof payload.bytes === "number" &&
    Number.isSafeInteger(payload.bytes) &&
    payload.bytes > 0 &&
    payload.createdAt === event.createdAt &&
    (payload.bundleSchema === "gmos.profile_bundle.v2" ||
      payload.bundleSchema === "gmos.encrypted_profile_bundle.v1") &&
    payload.mode === "full"
  );
}
