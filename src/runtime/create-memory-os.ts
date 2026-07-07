import { createHash, randomUUID } from "node:crypto";

import {
  associationCueKey,
  associationCueMatchesQuery,
  associationCueTextPattern,
  extractAssociationCues,
  sourceMetadataEntityCues,
} from "../kernel/associations.js";
import { composeTurnContext } from "../kernel/context-composer.js";
import {
  applyPrepareDisposition,
  applyReconstructDisposition,
  resolveRecallDispositionPreset,
} from "../kernel/disposition.js";
import { buildEntityMentions, resolveWorldEntitySubject } from "../kernel/entities.js";
import type { EntityResolver } from "../kernel/entities.js";
import { buildEvidencePathExplanation } from "../kernel/evidence-path.js";
import {
  extractMemoryCandidatePlan,
} from "../kernel/extraction.js";
import {
  openAICompatibleOutcomeForError,
} from "../kernel/openai-compatible-response.js";
import {
  normalizeConsolidationCandidate,
  resolveMemoryConsolidationConfig,
  selectSemanticConsolidationClusters,
  uniqueConsolidationCandidateKey,
} from "../kernel/consolidation.js";
import {
  normalizeProcedureDistillationCandidate,
  resolveMemoryProcedureDistillationConfig,
  selectProcedureDistillationClusters,
} from "../kernel/distillation.js";
import {
  dossierInputKey,
  normalizeDossierCandidate,
  resolveMemoryDossierConfig,
  selectEntityDossierSnapshots,
} from "../kernel/dossier.js";
import {
  curiosityActionPolicy,
  curiosityBudgetForTurn,
  resolveMemoryExplorationConfig,
} from "../kernel/exploration.js";
import {
  embeddingsForMemories,
  embeddingForQuery,
  queryEligibleForEmbeddingProvider,
  resolveEmbeddingProviderConfig,
} from "../kernel/embeddings.js";
import { isReservedSpeakerIdentity } from "../kernel/person-identity.js";
import { reconstructMemoryContext } from "../kernel/reconstruction.js";
import { temporalContextLabel } from "../kernel/temporal-format.js";
import {
  isPersonRoutedMemory,
  redactForReport,
  safePublicLabel,
  safePublicInlineField,
  sanitizePublicPayloadRecord,
  sourceMetadataSpeakerIsPerson,
} from "../kernel/safety.js";
import type {
  AddMemoryInput,
  CommitOutcomeInput,
  ActionPolicy,
  EvidencePathExplanation,
  EvidenceEvent,
  EvidenceListInput,
  ExplainTurnInput,
  ExplainEvidencePathInput,
  ExplainResult,
  FailureEventRecord,
  FeedbackInput,
  ForgetInput,
  ForgetResult,
  HostEvent,
  IngestConversationInput,
  IngestConversationResult,
  LowLevelAddManyResult,
  LowLevelAddManySkipped,
  LowLevelAddMemoryInput,
  LowLevelArchiveMemoryInput,
  LowLevelClearMemoriesInput,
  LowLevelGetMemoryInput,
  LowLevelListMemoriesInput,
  LowLevelRestoreArchivedMemoryInput,
  LowLevelSearchInput,
  LowLevelUpdateMemoryInput,
  MaintenanceInput,
  MaintenanceReport,
  MemoryLifecycleHistory,
  MemoryLifecycleHistoryEntry,
  MemoryConsolidationCandidate,
  MemoryConsolidationCluster,
  MemoryConsolidationResult,
  MemoryExtractionCandidate,
  MemoryExtractionReport,
  MemoryKind,
  MemoryReadRetrievalOptions,
  MemorySearchInput,
  MemorySearchTraceCollector,
  MemorySearchTraceDecision,
  MemoryProcedureDistillationCandidate,
  MemoryProcedureDistillationCluster,
  MemoryProcedureDistillationResult,
  MemoryDossierCandidate,
  MemoryDossierEntitySnapshot,
  MemoryDossierResult,
  QueryVectorEmbedding,
  MemoryVectorEmbedding,
  MemoryRole,
  MemoryGapSuppressionReason,
  MemoryRecord,
  MemoryRollbackInput,
  MemoryRollbackResult,
  MemoryRetrievalConfig,
  MemoryOS,
  MemoryOSOptions,
  MemorySessionDistillationCandidate,
  MemorySessionDistillationResult,
  ObserveResult,
  PrepareTurnInput,
  PreparedTurn,
  ReadAuditSnapshot,
  ReconstructionIntentHint,
  ReconstructContextInput,
  ReconstructedContext,
  ResolvedMemoryLifecycleConfig,
  ResolvedMemoryTrustConfig,
  RestoreArchivedResult,
  Sensitivity,
  SourceTrust,
  TurnExplanationExcludedMemory,
  TurnExplanationIncludedMemory,
  TurnExplanationReport,
} from "../kernel/types.js";
import { resolveMemoryLifecycleConfig } from "../kernel/retention.js";
import {
  runtimeCommitOutcomeForStorage,
  runtimeFeedbackForStorage,
  recordRuntimeFailure,
  recordRuntimeTaskOutcome,
} from "./runtime-outcomes.js";
import {
  redactRuntimePayloadString,
  redactRuntimePayloadRecord,
  redactRuntimeSourceMetadataRecord,
  runtimeSensitivityClassifier,
  runtimeValueSensitivity,
  sanitizeRuntimeEvidenceForPublicOutput,
  sanitizeRuntimeExtractionReport,
  sanitizeRuntimeExternalMemoryMetadata,
} from "./runtime-safety.js";
import type { RuntimeSensitivityClassifier } from "./runtime-safety.js";

function nowIso(): string {
  return new Date().toISOString();
}

function publicMemoryRecord(
  memory: MemoryRecord,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): MemoryRecord {
  return {
    ...memory,
    kind: safePublicLabel(memory.kind) as MemoryRecord["kind"],
    sourceEventId: memory.sourceEventId == null
      ? memory.sourceEventId
      : redactRuntimePayloadString(
          memory.sourceEventId,
          classifyRuntimeSensitivity,
          "metadata",
        ),
    metadata: redactRuntimePayloadRecord(memory.metadata, classifyRuntimeSensitivity),
  };
}

function profileIdFor(defaultProfileId: string, profileId?: string): string {
  return profileId ?? defaultProfileId;
}

function sourceMetadataForEvent(
  event: Extract<HostEvent, { type: "conversation.message" }>,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Record<string, unknown> {
  return redactRuntimeSourceMetadataRecord(
    event.metadata ?? {},
    classifyRuntimeSensitivity,
  );
}

function sourceMetadataForCandidate(
  eventMetadata: Record<string, unknown>,
  candidate: MemoryExtractionCandidate,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Record<string, unknown> {
  if (typeof candidate.speaker !== "string" || candidate.speaker.trim().length === 0) {
    return eventMetadata;
  }
  const candidateSpeaker = redactRuntimeSourceMetadataRecord(
    { speaker: candidate.speaker },
    classifyRuntimeSensitivity,
  ).speaker;
  if (typeof candidateSpeaker !== "string" || candidateSpeaker.trim().length === 0) {
    return eventMetadata;
  }
  const {
    speaker: _eventSpeaker,
    speakerKind: _eventSpeakerKind,
    speakerId: _eventSpeakerId,
    speakerAliases: _eventSpeakerAliases,
    participants: _eventParticipants,
    ...nonSpeakerEventMetadata
  } = eventMetadata;
  return { ...nonSpeakerEventMetadata, speaker: candidateSpeaker, speakerKind: "person" };
}

function structuredCandidateMetadata(candidate: MemoryExtractionCandidate): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of [
    ["actionPolicyKind", candidate.actionPolicyKind],
    ["cardinality", candidate.cardinality],
    ["object", candidate.object],
    ["predicate", candidate.predicate],
    ["source", candidate.source],
    ["subject", candidate.subject],
  ] as const) {
    const sanitized = publicStructuredStringField(key, value);
    if (sanitized) metadata[key] = sanitized;
  }
  const subjectAliases = publicStructuredStringArrayField(
    "subjectAliases",
    candidate.subjectAliases,
  );
  if (subjectAliases) metadata.subjectAliases = subjectAliases;
  return metadata;
}

function structuredCandidateSensitivity(
  candidate: MemoryExtractionCandidate,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Sensitivity {
  let sensitivity: Sensitivity = "normal";
  for (const value of [
    candidate.actionPolicyKind,
    candidate.cardinality,
    candidate.eventTime,
    candidate.object,
    candidate.predicate,
    candidate.source,
    candidate.subject,
    ...(candidate.subjectAliases ?? []),
    candidate.validFrom,
    candidate.validTo,
  ]) {
    if (typeof value !== "string") continue;
    sensitivity = maxSensitivity(
      sensitivity,
      runtimeValueSensitivity(
        value,
        classifyRuntimeSensitivity,
        new WeakSet<object>(),
        "structured_candidate",
      ),
    );
    if (sensitivity === "secret_like") return sensitivity;
  }
  if (typeof candidate.speaker === "string") {
    sensitivity = maxSensitivity(
      sensitivity,
      classifyRuntimeSensitivity(candidate.speaker, "structured_candidate"),
    );
  }
  return sensitivity;
}

function publicStructuredStringField(key: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizePublicPayloadRecord({ [key]: value })[key];
  return typeof sanitized === "string" && sanitized.trim().length > 0 ? sanitized : undefined;
}

function publicStructuredStringArrayField(
  key: string,
  values: readonly string[] | undefined,
): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const sanitized = sanitizePublicPayloadRecord({ [key]: values })[key];
  if (!Array.isArray(sanitized)) return undefined;
  const publicValues = sanitized.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return publicValues.length > 0 ? publicValues : undefined;
}

function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  if (left === "secret_like" || right === "secret_like") return "secret_like";
  if (left === "sensitive" || right === "sensitive") return "sensitive";
  return "normal";
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function resolveMemoryTrustConfig(
  input: MemoryOSOptions["trust"],
): ResolvedMemoryTrustConfig {
  return {
    agentConfidenceCap: clamp01(input?.agentConfidenceCap ?? 0.65, 0.65),
    externalConfidenceCap: clamp01(input?.externalConfidenceCap ?? 0.55, 0.55),
    allowLowerTrustPolicyWrites: input?.allowLowerTrustPolicyWrites ?? false,
  };
}

function normalizeSourceTrust(value: unknown): SourceTrust | undefined {
  return value === "user" || value === "agent" || value === "external" ? value : undefined;
}

function sourceTrustFromMemory(memory: MemoryRecord): SourceTrust {
  const metadataTrust = normalizeSourceTrust(memory.metadata.sourceTrust);
  if (metadataTrust) return metadataTrust;
  const sourceMetadata = memory.metadata.sourceMetadata;
  if (sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata)) {
    const sourceMetadataTrust = normalizeSourceTrust(
      (sourceMetadata as Record<string, unknown>).sourceTrust,
    );
    if (sourceMetadataTrust) return sourceMetadataTrust;
  }
  return "user";
}

function lowerTrust(left: SourceTrust, right: SourceTrust): SourceTrust {
  if (left === "external" || right === "external") return "external";
  if (left === "agent" || right === "agent") return "agent";
  return "user";
}

function sourceTrustForMemoryIds(
  memoryIds: readonly string[],
  memoriesById: ReadonlyMap<string, MemoryRecord>,
): SourceTrust {
  return memoryIds.reduce<SourceTrust>(
    (trust, memoryId) => {
      const memory = memoriesById.get(memoryId);
      return memory ? lowerTrust(trust, sourceTrustFromMemory(memory)) : trust;
    },
    "user",
  );
}

function sourceTrustForEvent(event: Extract<HostEvent, { type: "conversation.message" }>): SourceTrust {
  const declared = normalizeSourceTrust(event.sourceTrust ?? event.metadata?.sourceTrust);
  if (declared) return declared;
  return event.role === "user" ? "user" : "agent";
}

function sourceTrustConfidenceCap(
  sourceTrust: SourceTrust,
  trust: ResolvedMemoryTrustConfig,
): number | undefined {
  if (sourceTrust === "agent") return trust.agentConfidenceCap;
  if (sourceTrust === "external") return trust.externalConfidenceCap;
  return undefined;
}

function lowerTrustPolicyWrite(candidate: MemoryExtractionCandidate): boolean {
  return (
    candidate.kind === "boundary" ||
    candidate.kind === "procedure" ||
    candidate.actionPolicyKind === "do_not_push" ||
    candidate.actionPolicyKind === "procedure"
  );
}

function lowerTrustConsolidationPolicyKind(candidate: MemoryConsolidationCandidate): boolean {
  return candidate.kind === "boundary" || candidate.kind === "procedure";
}

function lowerTrustAnnealingMetadata(input: {
  sourceTrust: SourceTrust;
  confidence: number;
  startedAt: string;
  lifecycle: ResolvedMemoryLifecycleConfig;
}): Record<string, unknown> {
  if (input.sourceTrust === "user" || !input.lifecycle.confidenceAnnealing.enabled) return {};
  return {
    annealing: {
      active: true,
      reason: "lower_trust_source",
      sourceTrust: input.sourceTrust,
      capConfidence: Math.min(input.confidence, input.lifecycle.confidenceAnnealing.confidenceCap),
      retentionCap: input.lifecycle.confidenceAnnealing.retentionCap,
      startedAt: input.startedAt,
    },
  };
}

function memorySensitivityForCandidate(input: {
  eventSensitivity: Sensitivity;
  candidateContentSensitivity: Sensitivity;
  candidateMetadataSensitivity: Sensitivity;
  candidateStructuredSensitivity: Sensitivity;
}): Sensitivity {
  return maxSensitivity(
    maxSensitivity(
      maxSensitivity(input.eventSensitivity, input.candidateContentSensitivity),
      input.candidateMetadataSensitivity,
    ),
    input.candidateStructuredSensitivity,
  );
}

function consolidatorName(
  consolidator: MemoryOSOptions["consolidator"],
): string | undefined {
  if (!consolidator) return undefined;
  if (typeof consolidator === "function") return consolidator.name || undefined;
  return consolidator.name;
}

function procedureDistillerName(
  procedureDistiller: MemoryOSOptions["procedureDistiller"],
): string | undefined {
  if (!procedureDistiller) return undefined;
  if (typeof procedureDistiller === "function") return procedureDistiller.name || undefined;
  return procedureDistiller.name;
}

function dossierSynthesizerName(
  dossierSynthesizer: MemoryOSOptions["dossierSynthesizer"],
): string | undefined {
  if (!dossierSynthesizer) return undefined;
  if (typeof dossierSynthesizer === "function") return dossierSynthesizer.name || undefined;
  return dossierSynthesizer.name;
}

function asConsolidationCandidateArray(
  result: MemoryConsolidationResult,
): MemoryConsolidationCandidate[] | null {
  if (result === null || result === undefined) return null;
  return Array.isArray(result) ? result : [result];
}

function asProcedureDistillationCandidateArray(
  result: MemoryProcedureDistillationResult,
): MemoryProcedureDistillationCandidate[] | null {
  if (result === null || result === undefined) return null;
  return Array.isArray(result) ? result : [result];
}

function asSessionDistillationCandidateArray(
  result: MemorySessionDistillationResult,
): MemorySessionDistillationCandidate[] | null {
  if (result === null || result === undefined) return null;
  return Array.isArray(result) ? result : [result];
}

function asDossierCandidateArray(
  result: MemoryDossierResult,
): MemoryDossierCandidate[] | null {
  if (result === null || result === undefined) return null;
  return Array.isArray(result) ? result : [result];
}

function publicProcedureDistillationCluster(
  cluster: MemoryProcedureDistillationCluster,
): Omit<MemoryProcedureDistillationCluster, "clusterKey"> {
  const { clusterKey: _clusterKey, ...publicCluster } = cluster;
  return publicCluster;
}

function publicSpeaker(
  value: unknown,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const speaker = value.trim();
  if (!speaker || speaker.startsWith("[redacted_")) return undefined;
  if (isReservedSpeakerIdentity(speaker)) return undefined;
  return classifyRuntimeSensitivity(speaker, "speaker") === "normal" ? speaker : undefined;
}

function publicSourceSpeaker(
  metadata: Record<string, unknown>,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string | undefined {
  return sourceMetadataSpeakerIsPerson(metadata)
    ? publicSpeaker(metadata.speaker, classifyRuntimeSensitivity)
    : undefined;
}

function publicStringArray(
  value: unknown,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const speaker = publicSpeaker(entry, classifyRuntimeSensitivity);
        return speaker ? [speaker] : [];
      })
    : [];
}

function shouldRouteBeliefToSpeaker(input: {
  eventMetadata: Record<string, unknown>;
  speaker: string;
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier;
}): boolean {
  return sourceMetadataSpeakerIsPerson(input.eventMetadata) &&
    publicSpeaker(input.speaker, input.classifyRuntimeSensitivity) !== undefined;
}

function worldBeliefSubjectForCandidate(input: {
  candidate: MemoryExtractionCandidate;
  eventMetadata: Record<string, unknown>;
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier;
}): string | null {
  const { candidate, eventMetadata } = input;
  if (candidate.subject) return candidate.subject;
  const predicatePrefix = candidate.predicate?.split(".")[0]?.toLowerCase();
  if (
    !isActionMemoryCandidate(candidate) &&
    predicatePrefix !== "user" &&
    predicatePrefix !== "person"
  ) {
    return null;
  }
  const candidateSpeaker = publicSpeaker(candidate.speaker, input.classifyRuntimeSensitivity);
  if (candidateSpeaker) return `person:${candidateSpeaker}`;
  const speaker = publicSourceSpeaker(eventMetadata, input.classifyRuntimeSensitivity);
  return speaker && shouldRouteBeliefToSpeaker({
    eventMetadata,
    speaker,
    classifyRuntimeSensitivity: input.classifyRuntimeSensitivity,
  })
    ? `person:${speaker}`
    : "user";
}

function worldBeliefSubjectAliasesForCandidate(input: {
  candidate: MemoryExtractionCandidate;
  subject: string;
  eventMetadata: Record<string, unknown>;
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier;
}): string[] | undefined {
  const { candidate, subject, eventMetadata } = input;
  const aliases = [...(candidate.subjectAliases ?? [])];
  if (!candidate.subject && subject !== "user") {
    aliases.push(...publicStringArray(eventMetadata.speakerAliases, input.classifyRuntimeSensitivity));
  }
  const seen = new Set<string>();
  const uniqueAliases = aliases.filter((alias) => {
    const key = alias.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return uniqueAliases.length > 0 ? uniqueAliases : undefined;
}

function isActionMemoryCandidate(candidate: MemoryExtractionCandidate): boolean {
  return (
    candidate.kind === "preference" ||
    candidate.kind === "boundary" ||
    candidate.kind === "procedure" ||
    Boolean(candidate.actionPolicyKind)
  );
}

function actionCategoryForCandidate(candidate: MemoryExtractionCandidate): "preference" | "boundary" | "procedure" | undefined {
  if (candidate.kind === "preference" || candidate.actionPolicyKind === "prefer") return "preference";
  if (candidate.kind === "boundary" || candidate.actionPolicyKind === "do_not_push") return "boundary";
  if (candidate.kind === "procedure" || candidate.actionPolicyKind === "procedure") return "procedure";
  return undefined;
}

function subjectPredicateNamespace(subject: string): string | undefined {
  const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:/u.exec(subject);
  return match?.[1]?.toLowerCase();
}

function explicitUserSubject(subject: string): boolean {
  return subject.trim().toLowerCase() === "user";
}

function actionPredicateSubject(input: {
  candidate: MemoryExtractionCandidate;
  subject: string;
  entityResolver?: EntityResolver | undefined;
}): string {
  const { candidate, subject } = input;
  const resolution = resolveWorldEntitySubject({
    subject,
    predicate: candidate.predicate,
    aliases: candidate.subjectAliases,
  }, input.entityResolver);
  if (resolution.entityKind && resolution.canonicalSubject !== "user") {
    return resolution.canonicalSubject;
  }
  if (explicitUserSubject(subject)) return "user";
  return subject;
}

function personScopedActionPredicate(candidate: MemoryExtractionCandidate): string {
  const predicate = candidate.predicate?.trim();
  if (predicate) {
    const normalized = predicate.toLowerCase();
    if (normalized.startsWith("person.")) return predicate;
    if (normalized.startsWith("user.")) return `person.${predicate.slice("user.".length)}`;
    if (normalized === "preference" || normalized === "boundary" || normalized === "procedure") {
      return `person.${normalized}`;
    }
    const actionCategory = actionCategoryForCandidate(candidate);
    if (actionCategory) return `person.${actionCategory}`;
    return predicate;
  }

  const actionCategory = actionCategoryForCandidate(candidate);
  if (actionCategory) return `person.${actionCategory}`;
  return "person.fact";
}

function subjectScopedActionPredicate(input: {
  candidate: MemoryExtractionCandidate;
  subject: string;
}): string {
  const { candidate, subject } = input;
  const namespace = subjectPredicateNamespace(subject);
  if (namespace === "person") {
    return candidate.kind === "preference"
      ? personScopedPreferencePredicate(candidate.predicate)
      : personScopedActionPredicate(candidate);
  }

  const actionCategory = actionCategoryForCandidate(candidate);
  const predicate = candidate.predicate?.trim();
  if (predicate) {
    const normalized = predicate.toLowerCase();
    if (normalized.startsWith("user.") && namespace) {
      return `${namespace}.${predicate.slice("user.".length)}`;
    }
    if (
      actionCategory &&
      namespace &&
      (normalized === actionCategory ||
        normalized.startsWith(`${actionCategory}.`) ||
        normalized === candidate.actionPolicyKind)
    ) {
      return `${namespace}.${actionCategory}`;
    }
    return predicate;
  }

  if (actionCategory && namespace) return `${namespace}.${actionCategory}`;
  if (actionCategory) return actionCategory;
  return namespace ? `${namespace}.fact` : "fact";
}

function personScopedPreferencePredicate(predicate: string | undefined): string {
  const normalized = predicate?.trim();
  if (!normalized || normalized.toLowerCase() === "preference") return "person.preference";
  if (normalized.toLowerCase().startsWith("user.")) {
    return `person.${normalized.slice("user.".length)}`;
  }
  return normalized;
}

function memoryWriteCandidateForSubject(input: {
  candidate: MemoryExtractionCandidate;
  subject: string;
  entityResolver?: EntityResolver | undefined;
}): MemoryExtractionCandidate {
  const { candidate, subject } = input;
  if (!isActionMemoryCandidate(candidate)) return candidate;
  const predicateSubject = actionPredicateSubject({
    candidate,
    subject,
    entityResolver: input.entityResolver,
  });
  if (predicateSubject === "user") return candidate;

  const { actionPolicyKind: _actionPolicyKind, ...candidateWithoutActionPolicy } = candidate;
  return {
    ...candidateWithoutActionPolicy,
    kind:
      candidate.kind === "preference" ||
      candidate.kind === "boundary" ||
      candidate.kind === "procedure"
        ? "fact"
        : candidate.kind,
    predicate: subjectScopedActionPredicate({ candidate, subject: predicateSubject }),
  };
}

function sourceScopedMemories(memories: MemoryRecord[], query: string): MemoryRecord[] {
  const queryCues = new Set(extractAssociationCues(query, 48).map((cue) => cue.cue));
  const selectedSourceCues = new Set<string>();
  for (const memory of memories) {
    for (const cue of sourceEntityCuesForMemory(memory)) {
      if (associationCueMatchesQuery(cue, queryCues)) selectedSourceCues.add(associationCueKey(cue));
    }
  }
  if (selectedSourceCues.size === 0) return memories;
  return memories.filter((memory) => {
    const sourceCues = sourceEntityCuesForMemory(memory);
    if (sourceCues.length === 0) return false;
    return sourceCues.some((cue) => selectedSourceCues.has(associationCueKey(cue)));
  });
}

function sourceEntityCuesForMemory(memory: MemoryRecord): string[] {
  return sourceMetadataEntityCues(memory.metadata);
}

function internalFusionScore(memory: MemoryRecord, fallback: number): number {
  const value = (memory as MemoryRecord & { __gmosFusionScore?: unknown }).__gmosFusionScore;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function callRetrievalReranker(input: {
  retrieval: MemoryRetrievalConfig | undefined;
  memories: MemoryRecord[];
}): Promise<MemoryRecord[] | null> {
  const reranker = input.retrieval?.reranker;
  if (!reranker || input.memories.length === 0) return null;
  try {
    const candidates = input.memories.slice(0, 50).map((memory, index) => ({
      id: memory.id,
      kind: memory.kind,
      snippet: redactForReport(memory.content).slice(0, 240),
      fusedScore: internalFusionScore(memory, Math.max(0, input.memories.length - index)),
    }));
    const order = typeof reranker === "function"
      ? await reranker(candidates)
      : await reranker.rerank(candidates);
    const allowed = new Map(input.memories.map((memory) => [memory.id, memory]));
    const reranked: MemoryRecord[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      const memory = allowed.get(id);
      if (!memory || seen.has(id)) continue;
      seen.add(id);
      reranked.push(memory);
    }
    return reranked;
  } catch {
    return null;
  }
}

function eventKey(event: HostEvent): string {
  if (event.type === "conversation.message") {
    return [
      event.type,
      event.profileId ?? "default",
      event.conversationId ?? "conversation",
      event.messageId ?? randomUUID(),
      event.createdAt ?? nowIso(),
    ].join(":");
  }
  return [event.type, event.profileId ?? "default", event.createdAt ?? nowIso(), randomUUID()].join(":");
}

function stableSessionDistillationHash(
  events: readonly Extract<HostEvent, { type: "conversation.message" }>[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        events.map((event) => ({
          role: event.role,
          content: event.content,
          conversationId: event.conversationId ?? null,
          messageId: event.messageId ?? null,
          createdAt: event.createdAt ?? null,
          sessionKey: windowSessionKey(event),
        })),
      ),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
}

function sessionDistillationEventKey(input: {
  profileId: string;
  sessionKey: string | null;
  events: readonly Extract<HostEvent, { type: "conversation.message" }>[];
}): string {
  const first = input.events[0];
  const sessionKey = input.sessionKey ?? first?.conversationId ?? "conversation";
  return [
    "conversation.session_distillation",
    input.profileId,
    sessionKey,
    stableSessionDistillationHash(input.events),
  ].join(":");
}

function candidateDedupeKey(candidate: MemoryExtractionCandidate): string {
  return [
    candidate.kind,
    candidate.predicate ?? "",
    candidate.subject ?? "",
    candidate.speaker ?? "",
    candidate.content.toLowerCase(),
  ].join("\n");
}

function windowSessionKey(event: Extract<HostEvent, { type: "conversation.message" }>): string | null {
  const value = event.metadata?.sessionId ?? event.metadata?.sessionKey ?? event.metadata?.windowId;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const DEFAULT_SESSION_DISTILLATION_MAX_CHARS = 24_000;

function prepareTurnDisplayQuery(input: PrepareTurnInput): string {
  return [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function reconstructQueryForEmbedding(input: ReconstructContextInput): string | undefined {
  return input.query ?? [...(input.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
}

interface TaskRouteSignal {
  value: string;
  privateByDefault: boolean;
}

function taskRouteSignalEntries(input: PrepareTurnInput): TaskRouteSignal[] {
  return [
    { value: input.task?.intent, privateByDefault: true },
    { value: input.task?.projectId, privateByDefault: true },
    { value: input.task?.topic, privateByDefault: false },
  ].flatMap((entry) =>
    typeof entry.value === "string" && entry.value.trim().length > 0
      ? [{ value: entry.value.trim(), privateByDefault: entry.privateByDefault }]
      : []
  );
}

function taskRouteSignals(input: PrepareTurnInput): string[] {
  return taskRouteSignalEntries(input).map((entry) => entry.value);
}

function publicRouteSignal(
  value: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string | undefined {
  return classifyRuntimeSensitivity(value, "route_signal") === "normal" ? value : undefined;
}

function prepareTurnQuery(
  input: PrepareTurnInput,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string {
  return [
    prepareTurnDisplayQuery(input),
    ...taskRouteSignals(input).flatMap((entry) => {
      const publicSignal = publicRouteSignal(entry, classifyRuntimeSensitivity);
      return publicSignal ? [publicSignal] : [];
    }),
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n");
}

function routeSignalAppearsInText(value: string, text: string): boolean {
  const signal = value.trim();
  if (!signal) return false;
  if (text.toLowerCase().includes(signal.toLowerCase())) return true;
  const publicCues = new Set(extractAssociationCues(text, 48).map((cue) => cue.cue));
  return associationCueMatchesQuery(signal, publicCues);
}

function privateTaskRouteSignals(
  input: PrepareTurnInput,
  displayQuery: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string[] {
  return taskRouteSignalEntries(input).flatMap((entry) => {
    const sensitivity = classifyRuntimeSensitivity(entry.value, "route_signal");
    if (sensitivity !== "normal") return [entry.value];
    return entry.privateByDefault && !routeSignalAppearsInText(entry.value, displayQuery)
      ? [entry.value]
      : [];
  });
}

function sanitizedRouteSignalList(
  values: string[] | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string[] | undefined {
  const output = (values ?? [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .filter((entry) => classifyRuntimeSensitivity(entry, "route_signal") === "normal");
  return output.length > 0 ? output : undefined;
}

function sanitizedReconstructionIntent(
  intent: ReconstructionIntentHint | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): ReconstructionIntentHint | undefined {
  if (!intent) return undefined;
  const expectedTags = sanitizedRouteSignalList(intent.expectedTags, classifyRuntimeSensitivity);
  const queryCues = sanitizedRouteSignalList(intent.queryCues, classifyRuntimeSensitivity);
  const sweepCues = sanitizedRouteSignalList(intent.sweepCues, classifyRuntimeSensitivity);
  const requiredAnchors: NonNullable<ReconstructionIntentHint["requiredAnchors"]> = [];
  for (const anchor of intent.requiredAnchors ?? []) {
    const cue = sanitizedRouteSignalList([anchor.cue], classifyRuntimeSensitivity)?.[0];
    if (!cue) continue;
    const hint = sanitizedRouteSignalList(
      typeof anchor.hint === "string" ? [anchor.hint] : undefined,
      classifyRuntimeSensitivity,
    )?.[0];
    requiredAnchors.push(hint ? { cue, hint } : { cue });
  }
  const requiredTagGroups: NonNullable<ReconstructionIntentHint["requiredTagGroups"]> = [];
  for (const group of intent.requiredTagGroups ?? []) {
    const tags = sanitizedRouteSignalList(group.tags, classifyRuntimeSensitivity);
    if (!tags) continue;
    const name = typeof group.name === "string" &&
      classifyRuntimeSensitivity(group.name, "route_signal") === "normal"
      ? group.name
      : undefined;
    requiredTagGroups.push(name ? { name, tags } : { tags });
  }
  const sanitized: ReconstructionIntentHint = {
    ...(expectedTags ? { expectedTags } : {}),
    ...(queryCues ? { queryCues } : {}),
    ...(requiredAnchors.length > 0 ? { requiredAnchors } : {}),
    ...(requiredTagGroups.length > 0 ? { requiredTagGroups } : {}),
    ...(sweepCues ? { sweepCues } : {}),
  };
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizedReconstructRequest<T extends ReconstructContextInput>(
  input: T,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): T {
  const reconstructionIntent = sanitizedReconstructionIntent(
    input.reconstructionIntent,
    classifyRuntimeSensitivity,
  );
  const request = { ...input };
  if (reconstructionIntent) {
    request.reconstructionIntent = reconstructionIntent;
  } else {
    delete request.reconstructionIntent;
  }
  return request;
}

class TurnExplanationSearchCollector implements MemorySearchTraceCollector {
  readonly decisions: MemorySearchTraceDecision[] = [];

  recordMemorySearchDecision(decision: MemorySearchTraceDecision): void {
    this.decisions.push(decision);
  }
}

function boundedPositiveInteger(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.max(min, Math.min(Math.trunc(input), max));
}

function publicTraceValues(values: string[], mode: "label" | "inline"): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const publicValue = mode === "label" ? safePublicLabel(value) : safePublicInlineField(value);
    const key = publicValue.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(publicValue);
  }
  return output;
}

function memoryRetention(memory: MemoryRecord): TurnExplanationIncludedMemory["retention"] {
  return {
    ...(memory.recallCount !== undefined ? { recallCount: memory.recallCount } : {}),
    ...(memory.reinforcement !== undefined ? { reinforcement: memory.reinforcement } : {}),
    confidence: memory.confidence,
  };
}

function fallbackSearchDecision(memory: MemoryRecord): MemorySearchTraceDecision {
  return {
    memory,
    decision: "included",
    cues: [],
    associations: memory.sourceEventId ? ["source_evidence"] : [],
    tags: [memory.kind],
    scoreComponents: {
      confidence: memory.confidence,
      retrievalScore: 0,
      contentScore: memory.confidence,
      finalScore: memory.confidence,
    },
  };
}

function publicSearchDecision(input: {
  memory: MemoryRecord;
  decision: MemorySearchTraceDecision | undefined;
}): MemorySearchTraceDecision {
  return input.decision ?? fallbackSearchDecision(input.memory);
}

function traceDecisionByMemoryId(
  decisions: MemorySearchTraceDecision[],
): Map<string, MemorySearchTraceDecision> {
  const output = new Map<string, MemorySearchTraceDecision>();
  for (const decision of decisions) {
    const existing = output.get(decision.memory.id);
    if (!existing || decision.decision === "included") output.set(decision.memory.id, decision);
  }
  return output;
}

function explanationMemoryKind(memory: MemoryRecord): MemoryKind {
  return safePublicLabel(memory.kind) as MemoryKind;
}

function explanationEventId(
  value: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): string {
  return redactRuntimePayloadString(value, classifyRuntimeSensitivity, "metadata");
}

function includedTurnExplanationMemory(input: {
  memory: MemoryRecord;
  decision: MemorySearchTraceDecision | undefined;
  evidenceEventIds: string[];
}): TurnExplanationIncludedMemory {
  const decision = publicSearchDecision(input);
  const temporalLabel = temporalContextLabel(input.memory.createdAt, input.memory.metadata);
  return {
    id: input.memory.id,
    kind: explanationMemoryKind(input.memory),
    status: input.memory.status,
    content: input.memory.content,
    ...(temporalLabel ? { temporalLabel } : {}),
    retention: memoryRetention(input.memory),
    cues: publicTraceValues(decision.cues, "inline"),
    associations: publicTraceValues(decision.associations, "label"),
    tags: publicTraceValues(decision.tags, "label"),
    scoreComponents: decision.scoreComponents,
    evidenceEventIds: input.evidenceEventIds,
  };
}

function excludedTurnExplanationMemory(
  decision: MemorySearchTraceDecision,
): TurnExplanationExcludedMemory | null {
  if (!decision.reason) return null;
  if (decision.reason === "forget_residue") {
    return {
      id: decision.memory.id,
      kind: explanationMemoryKind(decision.memory),
      status: decision.memory.status,
      reason: decision.reason,
      retention: memoryRetention(decision.memory),
      cues: [],
      associations: [],
      tags: [],
      scoreComponents: {
        confidence: decision.memory.confidence,
        retrievalScore: 0,
        contentScore: 0,
        finalScore: 0,
      },
    };
  }
  return {
    id: decision.memory.id,
    kind: explanationMemoryKind(decision.memory),
    status: decision.memory.status,
    reason: decision.reason,
    retention: memoryRetention(decision.memory),
    cues: publicTraceValues(decision.cues, "inline"),
    associations: publicTraceValues(decision.associations, "label"),
    tags: publicTraceValues(decision.tags, "label"),
    scoreComponents: decision.scoreComponents,
  };
}

function redactRouteSignals(value: string, privateSignals: string[]): string {
  let output = value;
  const keys = [...new Set(privateSignals.map(associationCueKey).filter(Boolean))];
  for (const key of keys.sort((left, right) => right.length - left.length)) {
    const pattern = associationCueTextPattern(key);
    if (!pattern) continue;
    output = output.replace(pattern, "retrieval_hint");
  }
  return output;
}

function hideRouteMemoryMetadata(memory: MemoryRecord, privateSignals: string[] = []): MemoryRecord {
  return {
    ...memory,
    scope: "global",
    content: redactRouteSignals(memory.content, privateSignals),
    metadata: {},
  };
}

function hideEvidencePayload(event: EvidenceEvent, privateSignals: string[] = []): EvidenceEvent {
  return {
    ...event,
    eventKey: redactRouteSignals(event.eventKey, privateSignals),
    sourceUri: event.sourceUri ? redactRouteSignals(event.sourceUri, privateSignals) : event.sourceUri,
    content: redactRouteSignals(event.content, privateSignals),
    payload: {},
  };
}

function hideRouteActionPolicy<T extends { text: string }>(
  policy: T,
  privateSignals: string[],
): T {
  return {
    ...policy,
    text: redactRouteSignals(policy.text, privateSignals),
  };
}

const LOW_LEVEL_MEMORY_KINDS = new Set<MemoryKind>([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "person",
  "task_trajectory",
]);

function isLowLevelMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && LOW_LEVEL_MEMORY_KINDS.has(value as MemoryKind);
}

function lowLevelKind(input: LowLevelAddMemoryInput): MemoryKind {
  if (isPersonRoutedMemory(input.content)) return "person";
  return isLowLevelMemoryKind(input.kind) ? input.kind : "fact";
}

function lowLevelSensitivity(input: {
  content: string;
  scope?: string | undefined;
  sensitivity?: Sensitivity | undefined;
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier;
}): Sensitivity {
  const detected = input.classifyRuntimeSensitivity(input.content, "content");
  const scopeSensitivity =
    typeof input.scope === "string"
      ? input.classifyRuntimeSensitivity(input.scope, "scope")
      : "normal";
  if (
    detected === "secret_like" ||
    scopeSensitivity === "secret_like" ||
    input.sensitivity === "secret_like"
  ) {
    throw new Error("gmOS low-level mutation rejects secret-like content or scope");
  }
  if (detected === "sensitive" || scopeSensitivity === "sensitive") return "sensitive";
  return input.sensitivity ?? detected;
}

function assertLowLevelPersonAllowed(input: {
  kind?: MemoryKind | undefined;
  content: string;
  allowPerson?: boolean | undefined;
}): void {
  const routesToPerson = input.kind === "person" || isPersonRoutedMemory(input.content);
  if (routesToPerson && !input.allowPerson) {
    throw new Error("gmOS low-level add rejects person memory unless allowPerson is true");
  }
}

function requireUpdateMemory(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["updateMemory"]> {
  if (!store.updateMemory) throw new Error("gmOS store does not support low-level update");
  return store.updateMemory.bind(store);
}

function requireArchiveMemoryById(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["archiveMemoryById"]> {
  if (!store.archiveMemoryById) {
    throw new Error("gmOS store does not support low-level archive");
  }
  return store.archiveMemoryById.bind(store);
}

function requireRestoreArchivedMemory(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["restoreArchivedMemory"]> {
  if (!store.restoreArchivedMemory) {
    throw new Error("gmOS store does not support low-level restore archived memory");
  }
  return store.restoreArchivedMemory.bind(store);
}

function requireArchiveMemories(
  store: MemoryOSOptions["store"],
): NonNullable<MemoryOSOptions["store"]["archiveMemories"]> {
  if (!store.archiveMemories) throw new Error("gmOS store does not support low-level clear");
  return store.archiveMemories.bind(store);
}

async function readAuditSnapshot(store: MemoryOSOptions["store"]): Promise<ReadAuditSnapshot> {
  if (store.readAuditSnapshot) return store.readAuditSnapshot();
  const rowCounts = await store.rowCounts();
  return {
    schema: "gmos.read_audit_snapshot.v1",
    tables: {
      rowCounts: {
        rowCount: Object.keys(rowCounts).length,
        stateHash: JSON.stringify(rowCounts),
      },
    },
  };
}

function assertNoReadSideEffects(input: {
  operation: string;
  before: ReadAuditSnapshot;
  after: ReadAuditSnapshot;
}): void {
  if (JSON.stringify(input.before) !== JSON.stringify(input.after)) {
    throw new Error(`gmOS invariant failed: ${input.operation} produced write side effects`);
  }
}

function assertValidIsoInstant(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
}

export function createMemoryOS(options: MemoryOSOptions): MemoryOS {
  const defaultProfileId = options.profileId ?? "default";
  const store = options.store;
  const classifyRuntimeSensitivity = runtimeSensitivityClassifier(
    options.safety?.sensitivityClassifier,
  );
  const lifecycle = resolveMemoryLifecycleConfig(options.lifecycle);
  const trust = resolveMemoryTrustConfig(options.trust);
  const consolidation = resolveMemoryConsolidationConfig(options.consolidation);
  const distillation = resolveMemoryProcedureDistillationConfig(options.distillation);
  const dossier = resolveMemoryDossierConfig(options.dossier);
  const exploration = resolveMemoryExplorationConfig(options.exploration);
  const embeddingProvider = resolveEmbeddingProviderConfig(options.embeddingProvider);
  const retrieval = options.retrieval;
  const defaultDisposition = resolveRecallDispositionPreset({
    defaultPreset: options.disposition,
  }).name;
  let initialized = false;

  async function initialize(): Promise<void> {
    if (initialized) return;
    if (options.embeddingProvider && store.configureEmbeddingProvider) {
      store.configureEmbeddingProvider(options.embeddingProvider);
    }
    await store.initialize();
    initialized = true;
  }

  async function embeddingForRuntimeWrite(input: {
    kind: MemoryKind;
    sensitivity: Sensitivity;
    content: string;
  }): Promise<MemoryVectorEmbedding | undefined> {
    const embedded = await embeddingsForRuntimeWrites([input]);
    return embedded.embeddings[0];
  }

  interface RuntimeEmbeddingStats {
    embeddingCallCount: number;
    embeddedMemoryCount: number;
    embeddingFailureCount: number;
  }

  function emptyRuntimeEmbeddingStats(): RuntimeEmbeddingStats {
    return {
      embeddingCallCount: 0,
      embeddedMemoryCount: 0,
      embeddingFailureCount: 0,
    };
  }

  function addRuntimeEmbeddingStats(
    total: RuntimeEmbeddingStats,
    next: RuntimeEmbeddingStats,
  ): void {
    total.embeddingCallCount += next.embeddingCallCount;
    total.embeddedMemoryCount += next.embeddedMemoryCount;
    total.embeddingFailureCount += next.embeddingFailureCount;
  }

  async function embeddingsForRuntimeWrites(
    memories: Array<{ kind: MemoryKind; sensitivity: Sensitivity; content: string }>,
  ): Promise<{ embeddings: MemoryVectorEmbedding[]; stats: RuntimeEmbeddingStats }> {
    if (!embeddingProvider || memories.length === 0) {
      return {
        embeddings: [],
        stats: emptyRuntimeEmbeddingStats(),
      };
    }
    const result = await embeddingsForMemories({
      provider: embeddingProvider,
      memories,
    });
    return {
      embeddings: result.embeddings,
      stats: {
        embeddingCallCount: result.providerCallCount,
        embeddedMemoryCount: result.embeddedMemoryCount,
        embeddingFailureCount: result.providerFailureCount,
      },
    };
  }

  interface PreparedLowLevelAdd {
    embeddingInput: {
      kind: MemoryKind;
      sensitivity: Sensitivity;
      content: string;
    };
    storeInput: AddMemoryInput;
  }

  function skippedLowLevelAdd(
    input: LowLevelAddMemoryInput,
    index: number,
  ): LowLevelAddManySkipped | null {
    const content = input.content.trim();
    if (!content) {
      return {
        index,
        reason: "empty_content",
        message: "gmOS low-level add requires non-empty content",
      };
    }
    const kind = lowLevelKind({ ...input, content });
    if ((kind === "person" || isPersonRoutedMemory(content)) && !input.allowPerson) {
      return {
        index,
        reason: "person_routed",
        message: "gmOS low-level add rejects person memory unless allowPerson is true",
      };
    }
    try {
      lowLevelSensitivity({
        content,
        scope: input.scope,
        sensitivity: input.sensitivity,
        classifyRuntimeSensitivity,
      });
    } catch {
      return {
        index,
        reason: "secret_like",
        message: "gmOS low-level mutation rejects secret-like content or scope",
      };
    }
    return null;
  }

  async function prepareLowLevelAdd(input: LowLevelAddMemoryInput): Promise<PreparedLowLevelAdd> {
    const content = input.content.trim();
    if (!content) throw new Error("gmOS low-level add requires non-empty content");
    const kind = lowLevelKind({ ...input, content });
    assertLowLevelPersonAllowed({ ...input, kind, content });
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const sensitivity = lowLevelSensitivity({ ...input, content, classifyRuntimeSensitivity });
    const createdAt = input.createdAt ?? nowIso();
    const evidence = await store.recordEvidence({
      profileId,
      eventKey: ["sdk.low_level_add", profileId, createdAt, randomUUID()].join(":"),
      sourceType: "sdk.low_level_add",
      sourceUri: null,
      content,
      sensitivity,
      eligibleForLongTermMemory: true,
      payload: {
        kind: safePublicLabel(kind),
        scope: input.scope ?? "global",
        metadata: redactRuntimeSourceMetadataRecord(input.metadata, classifyRuntimeSensitivity),
      },
      createdAt,
    });
    return {
      embeddingInput: {
        kind,
        sensitivity,
        content,
      },
      storeInput: {
        profileId,
        kind,
        content,
        sensitivity,
        sourceEventId: evidence.id,
        metadata: {
          ...sanitizeRuntimeExternalMemoryMetadata(input.metadata, classifyRuntimeSensitivity),
          lowLevelApi: true,
        },
        createdAt,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      },
    };
  }

  async function queryEmbeddingForSearch(
    query: string | undefined,
    options: MemoryReadRetrievalOptions | undefined,
  ) {
    const readRetrieval = readRetrievalOptions(options);
    if (!query || readRetrieval?.embedQuery !== true || !embeddingProvider) return undefined;
    if (!queryEligibleForEmbeddingProvider(query)) return undefined;
    const embedding = await embeddingForQuery({
      provider: embeddingProvider,
      query,
      timeoutMs: readRetrieval.queryEmbeddingTimeoutMs,
    });
    if (!embedding) readRetrieval.onQueryEmbeddingFailure?.();
    return embedding ?? undefined;
  }

  function readRetrievalOptions(
    options: MemoryReadRetrievalOptions | undefined,
  ): MemoryReadRetrievalOptions | undefined {
    const embedQuery = options?.embedQuery ?? retrieval?.embedQuery;
    const queryEmbeddingTimeoutMs =
      options?.queryEmbeddingTimeoutMs ?? retrieval?.queryEmbeddingTimeoutMs;
    const onQueryEmbeddingFailure =
      options?.onQueryEmbeddingFailure ?? retrieval?.onQueryEmbeddingFailure;
    if (
      embedQuery === undefined &&
      queryEmbeddingTimeoutMs === undefined &&
      onQueryEmbeddingFailure === undefined
    ) {
      return undefined;
    }
    return {
      ...(embedQuery !== undefined ? { embedQuery } : {}),
      ...(queryEmbeddingTimeoutMs !== undefined ? { queryEmbeddingTimeoutMs } : {}),
      ...(onQueryEmbeddingFailure !== undefined ? { onQueryEmbeddingFailure } : {}),
    };
  }

  async function searchMemoriesWithRetrieval(
    input: MemorySearchInput,
    readRetrieval?: MemoryReadRetrievalOptions | undefined,
    queryEmbedding?: QueryVectorEmbedding | null | undefined,
  ): Promise<MemoryRecord[]> {
    const resolvedQueryEmbedding =
      input.queryEmbedding ??
      (input.freshQueryEmbedding
        ? await queryEmbeddingForSearch(input.query, readRetrieval)
        : queryEmbedding === undefined
        ? await queryEmbeddingForSearch(input.query, readRetrieval)
        : queryEmbedding ?? undefined);
    const memories = await store.searchMemories({
      ...input,
      retrieval,
      ...(resolvedQueryEmbedding ? { queryEmbedding: resolvedQueryEmbedding } : {}),
    });
    const reranked = await callRetrievalReranker({ retrieval, memories });
    return reranked ?? memories;
  }

  function storeWithRetrieval(
    readRetrieval?: MemoryReadRetrievalOptions | undefined,
    queryEmbedding?: QueryVectorEmbedding | null | undefined,
  ) {
    return {
      ...store,
      searchMemories(input: MemorySearchInput) {
        return searchMemoriesWithRetrieval(input, readRetrieval, queryEmbedding);
      },
    };
  }

  async function add(input: LowLevelAddMemoryInput): Promise<MemoryRecord> {
    await initialize();
    const prepared = await prepareLowLevelAdd(input);
    const embedding = await embeddingForRuntimeWrite(prepared.embeddingInput);
    return publicMemoryRecord(await store.addMemory({
      ...prepared.storeInput,
      ...(embedding ? { embedding } : {}),
    }), classifyRuntimeSensitivity);
  }

  async function addMany(inputs: LowLevelAddMemoryInput[]): Promise<LowLevelAddManyResult> {
    await initialize();
    if (inputs.length === 0) return { memories: [], skipped: [] };
    const prepared: PreparedLowLevelAdd[] = [];
    const skipped: LowLevelAddManySkipped[] = [];
    for (const [index, input] of inputs.entries()) {
      const skip = skippedLowLevelAdd(input, index);
      if (skip) {
        skipped.push(skip);
      } else {
        prepared.push(await prepareLowLevelAdd(input));
      }
    }
    if (prepared.length === 0) return { memories: [], skipped };
    const embedded = await embeddingsForRuntimeWrites(
      prepared.map((entry) => entry.embeddingInput),
    );
    const storeInputs = prepared.map((entry, index) => ({
      ...entry.storeInput,
      ...(embedded.embeddings[index] ? { embedding: embedded.embeddings[index] } : {}),
    }));
    const stored = store.addMemories ? await store.addMemories(storeInputs) : [];
    if (!store.addMemories) {
      for (const entry of storeInputs) {
        stored.push(await store.addMemory(entry));
      }
    }
    return {
      memories: stored.map((memory) => publicMemoryRecord(memory, classifyRuntimeSensitivity)),
      skipped,
    };
  }

  async function update(input: LowLevelUpdateMemoryInput): Promise<MemoryRecord | null> {
    await initialize();
    const updateMemory = requireUpdateMemory(store);
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const existing = await store.getMemoryById(profileId, input.id, {
      includeSensitive: true,
      includePerson: true,
    });
    if (!existing) return null;
    const content = (input.content ?? existing.content).trim();
    if (!content) throw new Error("gmOS low-level update requires non-empty content");
    const kind = isPersonRoutedMemory(content)
      ? "person"
      : isLowLevelMemoryKind(input.kind)
        ? input.kind
        : existing.kind;
    assertLowLevelPersonAllowed({
      kind,
      content,
      allowPerson: input.allowPerson,
    });
    const sensitivity = lowLevelSensitivity({
      content,
      scope: input.scope ?? existing.scope,
      sensitivity: input.sensitivity ?? existing.sensitivity,
      classifyRuntimeSensitivity,
    });
    const updatedAt = input.updatedAt ?? nowIso();
    const runtimeInputMetadata = sanitizeRuntimeExternalMemoryMetadata(
      input.metadata,
      classifyRuntimeSensitivity,
    );
    const existingMetadata = redactRuntimePayloadRecord(
      existing.metadata,
      classifyRuntimeSensitivity,
    );
    const metadata = input.replaceMetadata
      ? runtimeInputMetadata
      : {
          ...existingMetadata,
          ...runtimeInputMetadata,
        };
    const evidence = await store.recordEvidence({
      profileId,
      eventKey: ["sdk.low_level_update", profileId, input.id, updatedAt, randomUUID()].join(":"),
      sourceType: "sdk.low_level_update",
      sourceUri: null,
      content,
      sensitivity,
      eligibleForLongTermMemory: true,
      payload: {
        memoryId: input.id,
        previousKind: safePublicLabel(existing.kind),
        kind: safePublicLabel(kind),
        scope: input.scope ?? existing.scope,
        metadata: redactRuntimeSourceMetadataRecord(input.metadata, classifyRuntimeSensitivity),
      },
      createdAt: updatedAt,
    });
    const embedding =
      input.content !== undefined
        ? await embeddingForRuntimeWrite({
            kind,
            sensitivity,
            content,
          })
        : undefined;
    const updated = await updateMemory({
      profileId,
      id: input.id,
      kind,
      scope: input.scope ?? existing.scope,
      content,
      sensitivity,
      confidence: input.confidence ?? existing.confidence,
      sourceEventId: evidence.id,
      metadata: {
        ...metadata,
        lowLevelApi: true,
        lowLevelUpdatedAt: updatedAt,
      },
      updatedAt,
      ...(embedding ? { embedding } : {}),
    });
    return updated ? publicMemoryRecord(updated, classifyRuntimeSensitivity) : updated;
  }

  async function archive(input: LowLevelArchiveMemoryInput): Promise<ForgetResult> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const archived = await requireArchiveMemoryById(store)({
      profileId,
      id: input.id,
      reason: input.reason,
      archivedAt: input.archivedAt,
    });
    return { archivedMemoryIds: archived ? [input.id] : [] };
  }

  async function restoreArchived(
    input: LowLevelRestoreArchivedMemoryInput,
  ): Promise<RestoreArchivedResult> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const restored = await requireRestoreArchivedMemory(store)({
      profileId,
      id: input.id,
      reason: input.reason,
      restoredAt: input.restoredAt,
    });
    return { restoredMemoryIds: restored ? [input.id] : [] };
  }

  async function clear(input: LowLevelClearMemoriesInput): Promise<ForgetResult> {
    await initialize();
    if (!input.all && !input.scope && !input.metadataEquals) {
      throw new Error("gmOS low-level clear requires all, scope, or metadataEquals");
    }
    const archivedMemoryIds = await requireArchiveMemories(store)({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      all: input.all,
      scope: input.scope,
      metadataEquals: input.metadataEquals,
      reason: input.reason,
      archivedAt: input.archivedAt,
    });
    return { archivedMemoryIds };
  }

  async function search(input: LowLevelSearchInput = {}): Promise<MemoryRecord[]> {
    await initialize();
    return (await searchMemoriesWithRetrieval({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      purpose: input.purpose ?? "context",
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.includeSensitive !== undefined ? { includeSensitive: input.includeSensitive } : {}),
      ...(input.includePerson !== undefined ? { includePerson: input.includePerson } : {}),
    }, input.retrieval)).map((memory) => publicMemoryRecord(memory, classifyRuntimeSensitivity));
  }

  async function list(input: LowLevelListMemoriesInput = {}): Promise<MemoryRecord[]> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    if (store.listMemories) {
      return (await store.listMemories({
        profileId,
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.includeSensitive !== undefined
          ? { includeSensitive: input.includeSensitive }
          : {}),
        ...(input.includePerson !== undefined ? { includePerson: input.includePerson } : {}),
      })).map((memory) => publicMemoryRecord(memory, classifyRuntimeSensitivity));
    }
    if (input.status && input.status !== "active") {
      throw new Error("gmOS store does not support archived memory listing");
    }
    if (input.kind || input.scope) {
      throw new Error("gmOS store does not support filtered memory listing");
    }
    return (await store.searchMemories({
      profileId,
      purpose: "context",
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.includeSensitive !== undefined ? { includeSensitive: input.includeSensitive } : {}),
      ...(input.includePerson !== undefined ? { includePerson: input.includePerson } : {}),
    })).map((memory) => publicMemoryRecord(memory, classifyRuntimeSensitivity));
  }

  async function get(input: LowLevelGetMemoryInput): Promise<MemoryRecord | null> {
    await initialize();
    const memory = await store.getMemoryById(profileIdFor(defaultProfileId, input.profileId), input.id, {
      includeSensitive: input.includeSensitive,
      includePerson: input.includePerson,
      includeArchived: input.includeArchived,
    });
    return memory ? publicMemoryRecord(memory, classifyRuntimeSensitivity) : memory;
  }

  type ConversationEvent = Extract<HostEvent, { type: "conversation.message" }>;
  interface ConversationEvidenceWrite {
    event: ConversationEvent;
    evidence: EvidenceEvent;
    eventMetadata: Record<string, unknown>;
    sensitivity: Sensitivity;
    sourceTrust: SourceTrust;
    allowLowerTrustPolicyWrites: boolean;
  }

  function observeResultFor(profileId: string, event: HostEvent): ObserveResult {
    return {
      profileId,
      eventType: event.type,
      observedAt: event.createdAt ?? nowIso(),
      memoryIds: [],
      worldBeliefIds: [],
    };
  }

  function resolvedExtractFromRoles(
    extraction: IngestConversationInput["extraction"] | undefined,
  ): MemoryRole[] {
    return extraction?.extractFromRoles ?? options.extraction?.extractFromRoles ?? ["user"];
  }

  function resolvedTurnRetention(
    turnRetention: IngestConversationInput["turnRetention"] | undefined,
  ): { kind: MemoryKind; confidence: number } | null {
    if (turnRetention?.enabled !== true) return null;
    return {
      kind: isLowLevelMemoryKind(turnRetention.kind) ? turnRetention.kind : "fact",
      confidence: clamp01(turnRetention.confidence ?? 0.35, 0.35),
    };
  }

  function resolvedSessionDistillation(
    sessionDistillation: IngestConversationInput["sessionDistillation"] | undefined,
  ): boolean {
    return sessionDistillation === true && options.sessionDistiller !== undefined;
  }

  function turnMemoryContent(
    event: ConversationEvent,
    eventMetadata: Record<string, unknown>,
  ): string {
    const speaker = publicSpeaker(eventMetadata.speaker, classifyRuntimeSensitivity);
    const label = speaker ? `${speaker} (${event.role})` : event.role;
    return `${label}: ${event.content}`;
  }

  interface TurnMemoryWrite {
    result: ObserveResult;
    profileId: string;
    kind: MemoryKind;
    content: string;
    confidence: number;
    sensitivity: Sensitivity;
    sourceEventId: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }

  async function prepareTurnMemoryWrite(input: {
    result: ObserveResult;
    profileId: string;
    event: ConversationEvent;
    evidence: EvidenceEvent;
    eventMetadata: Record<string, unknown>;
    sensitivity: Sensitivity;
    sourceTrust: SourceTrust;
    allowLowerTrustPolicyWrites: boolean;
    kind: MemoryKind;
    confidence: number;
  }): Promise<TurnMemoryWrite | null> {
    if (input.kind === "person" || isPersonRoutedMemory(input.event.content)) return null;
    if (
      input.sourceTrust !== "user" &&
      lowerTrustPolicyWrite({
        kind: input.kind,
        content: input.event.content,
        confidence: input.confidence,
      }) &&
      !input.allowLowerTrustPolicyWrites
    ) {
      return null;
    }
    const existing = store.findActiveMemoryByMetadata
      ? await store.findActiveMemoryByMetadata(
          input.profileId,
          "turnEvidenceId",
          input.evidence.id,
        )
      : null;
    if (existing) {
      input.result.memoryIds.push(existing.id);
      return null;
    }
    const content = turnMemoryContent(input.event, input.eventMetadata);
    const contentSensitivity = classifyRuntimeSensitivity(content, "content");
    const metadataSensitivity = runtimeValueSensitivity(
      input.eventMetadata,
      classifyRuntimeSensitivity,
    );
    if (
      contentSensitivity === "secret_like" ||
      metadataSensitivity === "secret_like" ||
      isPersonRoutedMemory(content)
    ) {
      return null;
    }
    const confidenceCap = sourceTrustConfidenceCap(input.sourceTrust, trust);
    const confidence = confidenceCap === undefined
      ? input.confidence
      : Math.min(input.confidence, confidenceCap);
    const eventTime = input.event.createdAt ?? input.evidence.createdAt;
    const annealingMetadata = lowerTrustAnnealingMetadata({
      sourceTrust: input.sourceTrust,
      confidence,
      startedAt: eventTime,
      lifecycle,
    });
    const entityMentions = buildEntityMentions({
      sourceMetadata: input.eventMetadata,
      entityResolver: options.entityResolver,
    });
    const memorySensitivity = maxSensitivity(
      maxSensitivity(input.sensitivity, contentSensitivity),
      metadataSensitivity,
    );
    return {
      result: input.result,
      profileId: input.profileId,
      kind: input.kind,
      content,
      confidence,
      sensitivity: memorySensitivity,
      sourceEventId: input.evidence.id,
      metadata: {
        turnMemory: true,
        turnEvidenceId: input.evidence.id,
        sourceEvidenceId: input.evidence.id,
        sourceTrust: input.sourceTrust,
        ...annealingMetadata,
        sourceRole: input.event.role,
        eventTime,
        ...(Object.keys(input.eventMetadata).length > 0 ? { sourceMetadata: input.eventMetadata } : {}),
        ...(entityMentions.length > 0 ? { entityMentions } : {}),
      },
      createdAt: eventTime,
    };
  }

  async function applyTurnMemoryWrites(
    writes: TurnMemoryWrite[],
    stats?: RuntimeEmbeddingStats | undefined,
  ): Promise<number> {
    if (writes.length === 0) return 0;
    const embedded = await embeddingsForRuntimeWrites(writes.map((write) => ({
      kind: write.kind,
      sensitivity: write.sensitivity,
      content: write.content,
    })));
    if (stats) addRuntimeEmbeddingStats(stats, embedded.stats);
    let count = 0;
    for (const [index, write] of writes.entries()) {
      const embedding = embedded.embeddings[index];
      const memory = await store.addMemory({
        profileId: write.profileId,
        kind: write.kind,
        content: write.content,
        confidence: write.confidence,
        sensitivity: write.sensitivity,
        sourceEventId: write.sourceEventId,
        metadata: write.metadata,
        createdAt: write.createdAt,
        ...(embedding ? { embedding } : {}),
      });
      write.result.memoryIds.push(memory.id);
      count += 1;
    }
    return count;
  }

  async function recordConversationEvidence(
    event: ConversationEvent,
    result: ObserveResult,
  ): Promise<{ result: ObserveResult; write?: ConversationEvidenceWrite | undefined }> {
    const sensitivity = classifyRuntimeSensitivity(event.content, "content");
    const eligible = event.privacyMode !== "incognito" && sensitivity !== "secret_like";
    result.eligibleForLongTermMemory = eligible;

    if (!eligible) {
      return {
        result: { ...result, skippedReason: "not_eligible_for_long_term_memory" },
      };
    }

    const sourceTrust = sourceTrustForEvent(event);
    const allowLowerTrustPolicyWrites =
      event.allowLowerTrustPolicyWrites === true || trust.allowLowerTrustPolicyWrites;
    const eventMetadata = sourceMetadataForEvent(event, classifyRuntimeSensitivity);
    const dedupeEventKey = eventKey(event);
    const existingEvidence = store.getEvidenceByEventKey
      ? await store.getEvidenceByEventKey(dedupeEventKey)
      : null;
    if (existingEvidence) {
      return {
        result: {
          ...result,
          evidenceId: existingEvidence.id,
          eligibleForLongTermMemory: existingEvidence.eligibleForLongTermMemory,
          skippedReason: "deduplicated_event",
        },
      };
    }
    const evidence = await store.recordEvidence({
      profileId: result.profileId,
      eventKey: dedupeEventKey,
      sourceType: event.type,
      sourceUri: event.conversationId ? `conversation:${event.conversationId}` : null,
      content: event.content,
      sensitivity,
      eligibleForLongTermMemory: eligible,
      payload: {
        role: event.role,
        messageId: event.messageId,
        privacyMode: event.privacyMode ?? "normal",
        sourceTrust,
        ...(allowLowerTrustPolicyWrites && sourceTrust !== "user"
          ? { trustOverride: { allowPolicyWrites: true } }
          : {}),
        metadata: eventMetadata,
      },
      createdAt: event.createdAt,
    });
    result.evidenceId = evidence.id;
    return {
      result,
      write: {
        event,
        evidence,
        eventMetadata,
        sensitivity,
        sourceTrust,
        allowLowerTrustPolicyWrites,
      },
    };
  }

  interface ExtractionCandidateContext {
    result: ObserveResult;
    event: ConversationEvent;
    evidence: EvidenceEvent;
    eventMetadata: Record<string, unknown>;
    sensitivity: Sensitivity;
    sourceTrust: SourceTrust;
    allowLowerTrustPolicyWrites: boolean;
    sourceEventId: string;
    metadata?: Record<string, unknown> | undefined;
  }

  async function applyExtractionCandidates(input: {
    result: ObserveResult;
    profileId: string;
    candidates: MemoryExtractionCandidate[];
    event: ConversationEvent;
    evidence: EvidenceEvent;
    eventMetadata: Record<string, unknown>;
    sensitivity: Sensitivity;
    sourceTrust: SourceTrust;
    allowLowerTrustPolicyWrites: boolean;
    sourceEventId: string;
    metadata?: Record<string, unknown> | undefined;
    dedupeKeys?: Set<string> | undefined;
    contextForCandidate?: (
      candidate: MemoryExtractionCandidate,
      index: number,
    ) => ExtractionCandidateContext;
    embeddingStats?: RuntimeEmbeddingStats | undefined;
  }): Promise<void> {
    const writes: Array<{
      result: ObserveResult;
      context: ExtractionCandidateContext;
      candidate: MemoryExtractionCandidate;
      writeCandidate: MemoryExtractionCandidate;
      subject: string | null;
      candidateSourceMetadata: Record<string, unknown>;
      structuredMetadata: Record<string, unknown>;
      memoryEntityMentions: ReturnType<typeof buildEntityMentions>;
      memorySensitivity: Sensitivity;
      confidence: number;
      annealingMetadata: Record<string, unknown>;
    }> = [];
    for (const [candidateIndex, candidate] of input.candidates.entries()) {
      const context = input.contextForCandidate?.(candidate, candidateIndex) ?? {
        result: input.result,
        event: input.event,
        evidence: input.evidence,
        eventMetadata: input.eventMetadata,
        sensitivity: input.sensitivity,
        sourceTrust: input.sourceTrust,
        allowLowerTrustPolicyWrites: input.allowLowerTrustPolicyWrites,
        sourceEventId: input.sourceEventId,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      const dedupeKey = candidateDedupeKey(candidate);
      if (input.dedupeKeys?.has(dedupeKey)) continue;
      const candidateSourceMetadata = sourceMetadataForCandidate(
        context.eventMetadata,
        candidate,
        classifyRuntimeSensitivity,
      );
      const subject = worldBeliefSubjectForCandidate({
        candidate,
        eventMetadata: candidateSourceMetadata,
        classifyRuntimeSensitivity,
      });
      const writeCandidate = memoryWriteCandidateForSubject({
        candidate,
        subject: subject ?? "user",
        entityResolver: options.entityResolver,
      });
      if (
        context.sourceTrust !== "user" &&
        lowerTrustPolicyWrite(writeCandidate) &&
        !context.allowLowerTrustPolicyWrites
      ) {
        continue;
      }
      const candidateSensitivity = classifyRuntimeSensitivity(writeCandidate.content, "content");
      const candidateStructuredSensitivity = structuredCandidateSensitivity(
        writeCandidate,
        classifyRuntimeSensitivity,
      );
      const candidateMetadataSensitivity = runtimeValueSensitivity(
        writeCandidate.metadata,
        classifyRuntimeSensitivity,
      );
      const structuredMetadata = structuredCandidateMetadata(writeCandidate);
      if (
        writeCandidate.kind === "person" ||
        candidateSensitivity === "secret_like" ||
        candidateMetadataSensitivity === "secret_like" ||
        candidateStructuredSensitivity === "secret_like" ||
        isPersonRoutedMemory(writeCandidate.content)
      ) {
        continue;
      }
      const memoryEntityMentions = buildEntityMentions({
        subject: writeCandidate.subject ?? (subject && subject !== "user" ? subject : undefined),
        predicate: writeCandidate.predicate,
        subjectAliases: writeCandidate.subjectAliases,
        sourceMetadata: candidateSourceMetadata,
        entityResolver: options.entityResolver,
      });
      input.dedupeKeys?.add(dedupeKey);
      const memorySensitivity = memorySensitivityForCandidate({
        eventSensitivity: context.sensitivity,
        candidateContentSensitivity: candidateSensitivity,
        candidateMetadataSensitivity,
        candidateStructuredSensitivity,
      });
      const confidenceCap = sourceTrustConfidenceCap(context.sourceTrust, trust);
      const confidence = confidenceCap === undefined
        ? writeCandidate.confidence
        : Math.min(writeCandidate.confidence, confidenceCap);
      const annealingMetadata = lowerTrustAnnealingMetadata({
        sourceTrust: context.sourceTrust,
        confidence,
        startedAt: context.event.createdAt ?? context.evidence.createdAt,
        lifecycle,
      });
      writes.push({
        result: context.result,
        context,
        candidate,
        writeCandidate,
        subject,
        candidateSourceMetadata,
        structuredMetadata,
        memoryEntityMentions,
        memorySensitivity,
        confidence,
        annealingMetadata,
      });
    }
    const embedded = await embeddingsForRuntimeWrites(writes.map((write) => ({
      kind: write.writeCandidate.kind,
      sensitivity: write.memorySensitivity,
      content: write.writeCandidate.content,
    })));
    if (input.embeddingStats) addRuntimeEmbeddingStats(input.embeddingStats, embedded.stats);
    for (const [index, write] of writes.entries()) {
      const embedding = embedded.embeddings[index];
      const memory = await store.addMemory({
        profileId: input.profileId,
        kind: write.writeCandidate.kind,
        content: write.writeCandidate.content,
        confidence: write.confidence,
        sensitivity: write.memorySensitivity,
        sourceEventId: write.context.sourceEventId,
        metadata: {
          ...sanitizeRuntimeExternalMemoryMetadata(
            write.candidate.metadata,
            classifyRuntimeSensitivity,
          ),
          ...write.structuredMetadata,
          ...(write.context.metadata ?? {}),
          sourceTrust: write.context.sourceTrust,
          ...write.annealingMetadata,
          sourceRole: write.context.event.role,
          ...(Object.keys(write.candidateSourceMetadata).length > 0
            ? { sourceMetadata: write.candidateSourceMetadata }
            : {}),
          ...(write.memoryEntityMentions.length > 0
            ? { entityMentions: write.memoryEntityMentions }
            : {}),
        },
        createdAt: write.context.event.createdAt,
        ...(embedding ? { embedding } : {}),
      });
      write.result.memoryIds.push(memory.id);
      if (write.writeCandidate.predicate && write.subject) {
        const subjectAliases = worldBeliefSubjectAliasesForCandidate({
          candidate: write.writeCandidate,
          subject: write.subject,
          eventMetadata: write.candidateSourceMetadata,
          classifyRuntimeSensitivity,
        });
        const beliefEntityMentions = buildEntityMentions({
          subject: write.subject,
          predicate: write.writeCandidate.predicate,
          subjectAliases,
          sourceMetadata: write.candidateSourceMetadata,
          entityResolver: options.entityResolver,
        });
        const belief = await store.addWorldBelief({
          profileId: input.profileId,
          subject: write.subject,
          subjectAliases,
          predicate: write.writeCandidate.predicate,
          object: write.writeCandidate.object ?? write.writeCandidate.content,
          confidence: write.confidence,
          sourceMemoryId: memory.id,
          cardinality: write.writeCandidate.cardinality,
          createdAt: write.context.event.createdAt ?? memory.createdAt,
          metadata: {
            ...sanitizeRuntimeExternalMemoryMetadata(
              write.writeCandidate.metadata,
              classifyRuntimeSensitivity,
            ),
            ...write.structuredMetadata,
            ...(write.context.metadata ?? {}),
            sourceTrust: write.context.sourceTrust,
            ...write.annealingMetadata,
            sourceRole: write.context.event.role,
            ...(Object.keys(write.candidateSourceMetadata).length > 0
              ? { sourceMetadata: write.candidateSourceMetadata }
              : {}),
            ...(beliefEntityMentions.length > 0 ? { entityMentions: beliefEntityMentions } : {}),
          },
        });
        write.result.worldBeliefIds.push(belief.id);
      }
    }
  }

  async function observe(event: HostEvent): Promise<void> {
    await observeWithReport(event);
  }

  async function observeWithReport(event: HostEvent): Promise<ObserveResult> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, event.profileId);
    const result = observeResultFor(profileId, event);

    if (event.type === "user.forget_request") {
      await store.forget({
        profileId,
        query: event.query,
        targetTerms: event.targetTerms,
        reason: event.reason,
      });
      return { ...result, skippedReason: "forget_request" };
    }

    if (event.type === "user.feedback" || event.type === "user.correction") {
      await recordRuntimeFailure(store, {
        profileId,
        failureKind: event.failureKind ?? "wrong_recall",
        content: event.content,
        createdAt: event.createdAt,
      }, classifyRuntimeSensitivity);
      return { ...result, skippedReason: "feedback_recorded" };
    }

    if (event.type === "task.completed" || event.type === "task.failed") {
      const taskOutcomeResult = await recordRuntimeTaskOutcome(store, {
        profileId,
        taskId: event.taskId,
        objective: event.objective,
        status: event.type === "task.completed" ? "completed" : "failed",
        summary: event.summary,
        createdAt: event.createdAt,
      }, classifyRuntimeSensitivity);
      if (taskOutcomeResult === "recorded" && event.type === "task.failed") {
        await recordRuntimeFailure(store, {
          profileId,
          failureKind: "task_failure",
          content: event.summary ?? event.objective,
          createdAt: event.createdAt,
          additionalSurfaces: ["task_trajectory"],
        }, classifyRuntimeSensitivity);
      }
      return {
        ...result,
        skippedReason:
          taskOutcomeResult === "recorded"
            ? "task_trajectory_recorded"
            : "not_eligible_for_long_term_memory",
      };
    }

    if (event.type !== "conversation.message") return { ...result, skippedReason: "unsupported_event" };

    const recorded = await recordConversationEvidence(event, result);
    if (!recorded.write) return recorded.result;
    const { evidence, eventMetadata, sensitivity, sourceTrust, allowLowerTrustPolicyWrites } =
      recorded.write;
    const extractFromRoles = resolvedExtractFromRoles(undefined);
    if (!extractFromRoles.includes(event.role)) {
      return { ...recorded.result, skippedReason: "non_user_message" };
    }
    if (isPersonRoutedMemory(event.content)) return { ...recorded.result, skippedReason: "person_routed" };
    const extraction = await extractMemoryCandidatePlan({
      extractor: options.extractor,
      temporalParser: options.temporal?.parser,
      inferTemporalFromText: options.temporal?.inferFromText,
      extractionInput: {
        profileId,
        event: { ...event, metadata: eventMetadata },
        evidence,
      },
      minConfidence: options.extraction?.minConfidence,
    });
    recorded.result.extraction = sanitizeRuntimeExtractionReport(
      extraction.report,
      classifyRuntimeSensitivity,
    );
    await applyExtractionCandidates({
      result: recorded.result,
      profileId,
      candidates: extraction.candidates,
      event,
      evidence,
      eventMetadata,
      sensitivity,
      sourceTrust,
      allowLowerTrustPolicyWrites,
      sourceEventId: evidence.id,
    });
    return recorded.result;
  }

  async function ingestConversation(
    input: IngestConversationInput,
  ): Promise<IngestConversationResult> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const observedAt = nowIso();
    const extractFromRoles = resolvedExtractFromRoles(input.extraction);
    const turnRetention = resolvedTurnRetention(input.turnRetention);
    const sessionDistillation = resolvedSessionDistillation(input.sessionDistillation);
    const maxMessages = boundedPositiveInteger(input.window?.maxMessages, 12, 1, 1000);
    const maxChars = boundedPositiveInteger(input.window?.maxChars, 7000, 256, 200000);
    const windowConcurrency = boundedPositiveInteger(input.window?.concurrency, 1, 1, 32);
    const progressEveryWindows = boundedPositiveInteger(input.progress?.everyWindows, 10, 1, 100000);
    const replayAttempts = boundedPositiveInteger(input.extraction?.replayAttempts, 1, 0, 5);
    const extractionStartedMs = Date.now();
    const overlapMessages = boundedPositiveInteger(
      input.window?.overlapMessages,
      Math.min(3, Math.max(0, maxMessages - 1)),
      0,
      Math.max(0, maxMessages - 1),
    );
    const results: ObserveResult[] = [];
    const extractionReports: MemoryExtractionReport[] = [];
    const dedupeKeys = new Set<string>();
    const extractionMinConfidence = options.extraction?.minConfidence ?? 0.01;
    let extractionWindowCount = 0;
    let extractionCallCount = 0;
    let extractionRetryCount = 0;
    let extractionOkWithCandidatesCount = 0;
    let extractionEmptyCount = 0;
    let extractionParseFailureCount = 0;
    let extractionTransportFailureCount = 0;
    let extractionOkWithCandidatesCharCount = 0;
    let extractionEmptyCharCount = 0;
    let extractionParseFailureCharCount = 0;
    let extractionTransportFailureCharCount = 0;
    let extractedMemoryCountForProgress = 0;
    let turnMemoryCount = 0;
    let distilledMemoryCount = 0;
    const embeddingStats = emptyRuntimeEmbeddingStats();
    let distillationCallCount = 0;
    let distillationOkWithCandidatesCount = 0;
    let distillationEmptyCount = 0;
    let distillationParseFailureCount = 0;
    let distillationTransportFailureCount = 0;
    let distillationTruncatedMessageCount = 0;
    let replayedWindowCount = 0;
    let replayRecoveredCount = 0;
    const extractionFailedWindowIndexes = new Set<number>();

    interface WindowMember extends ConversationEvidenceWrite {
      result: ObserveResult;
    }

    interface ExtractionWindowTask {
      windowIndex: number;
      transcriptCharCount: number;
      members: WindowMember[];
      last: WindowMember;
      windowEvidenceIds: string[];
    }

    interface ExtractionWindowResult {
      task: ExtractionWindowTask;
      extraction: Awaited<ReturnType<typeof extractMemoryCandidatePlan>>;
      safeReport: MemoryExtractionReport;
    }

    interface SessionDistillationGroup {
      sessionKey: string | null;
      members: WindowMember[];
      firstIndex: number;
    }

    function sessionEventTime(members: WindowMember[]): string {
      let latestMs = Number.NEGATIVE_INFINITY;
      let latestIso: string | null = null;
      for (const member of members) {
        const value = member.event.createdAt ?? member.evidence.createdAt;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed) && parsed >= latestMs) {
          latestMs = parsed;
          latestIso = value;
        }
      }
      return latestIso ?? members[members.length - 1]?.evidence.createdAt ?? observedAt;
    }

    function commonSessionString(
      members: WindowMember[],
      value: (member: WindowMember) => string | undefined,
    ): string | undefined {
      const values = [...new Set(members.flatMap((member) => {
        const item = value(member);
        return item && item.trim().length > 0 ? [item.trim()] : [];
      }))];
      return values.length === 1 ? values[0] : undefined;
    }

    function sessionDistillationEvidenceContent(members: WindowMember[]): string {
      return members
        .map((member) => {
          const createdAt = member.event.createdAt ?? member.evidence.createdAt;
          return `[${createdAt}] ${turnMemoryContent(member.event, member.eventMetadata)}`;
        })
        .join("\n");
    }

    function normalizeSessionDistillationCandidate(
      candidate: MemorySessionDistillationCandidate,
    ): MemoryExtractionCandidate | null {
      const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
      if (!content) return null;
      const kind = isLowLevelMemoryKind(candidate.kind) ? candidate.kind : "fact";
      return {
        kind,
        content,
        confidence: clamp01(candidate.confidence ?? 0.6, 0.6),
        metadata: {},
      };
    }

    function sessionDistillationGroups(members: WindowMember[]): SessionDistillationGroup[] {
      const groups = new Map<string, SessionDistillationGroup>();
      for (const [firstIndex, member] of members.entries()) {
        const sessionKey = windowSessionKey(member.event);
        const groupKey = sessionKey === null ? "whole-call" : `session:${sessionKey}`;
        let group = groups.get(groupKey);
        if (!group) {
          group = { sessionKey, members: [], firstIndex };
          groups.set(groupKey, group);
        }
        group.members.push(member);
      }
      return [...groups.values()].sort((left, right) => {
        const leftMs = Date.parse(sessionEventTime(left.members));
        const rightMs = Date.parse(sessionEventTime(right.members));
        if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
          return leftMs - rightMs;
        }
        return left.firstIndex - right.firstIndex;
      });
    }

    function sessionDistillationMessages(members: WindowMember[]): {
      messages: Array<{
        role: MemoryRole;
        content: string;
        createdAt?: string | undefined;
        evidenceId: string;
        metadata?: Record<string, unknown> | undefined;
      }>;
      truncatedMessageCount: number;
    } {
      let remainingChars = DEFAULT_SESSION_DISTILLATION_MAX_CHARS;
      let truncatedMessageCount = 0;
      const messages = [];
      for (const member of members) {
        if (remainingChars <= 0) {
          truncatedMessageCount += 1;
          continue;
        }
        const content = member.event.content.length > remainingChars
          ? member.event.content.slice(0, remainingChars)
          : member.event.content;
        if (content.length < member.event.content.length) truncatedMessageCount += 1;
        remainingChars -= content.length;
        messages.push({
          role: member.event.role,
          content,
          ...(member.event.createdAt ? { createdAt: member.event.createdAt } : {}),
          evidenceId: member.evidence.id,
          ...(Object.keys(member.eventMetadata).length > 0
            ? { metadata: member.eventMetadata }
            : {}),
        });
      }
      return { messages, truncatedMessageCount };
    }

    async function applySessionDistillationGroup(group: SessionDistillationGroup): Promise<void> {
      const distiller = options.sessionDistiller;
      const members = group.members;
      if (!distiller || members.length === 0) return;
      const events = members.map((member) => member.event);
      const distillationEventKey = sessionDistillationEventKey({
        profileId,
        sessionKey: group.sessionKey,
        events,
      });
      const existingSessionEvidence = store.getEvidenceByEventKey
        ? await store.getEvidenceByEventKey(distillationEventKey)
        : null;
      if (existingSessionEvidence) return;
      const eventTime = sessionEventTime(members);
      const conversationId = commonSessionString(members, (member) => member.event.conversationId);
      const sessionId = commonSessionString(members, (member) => windowSessionKey(member.event) ?? undefined);
      const sourceUri = commonSessionString(members, (member) =>
        member.event.conversationId ? `conversation:${member.event.conversationId}` : undefined
      ) ?? null;
      const sessionEvidenceIds = members.map((member) => member.evidence.id);
      const { messages, truncatedMessageCount } = sessionDistillationMessages(members);
      distillationTruncatedMessageCount += truncatedMessageCount;
      const distillerInput = {
        profileId,
        eventTime,
        context: {
          eventKey: distillationEventKey,
          ...(conversationId ? { conversationId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(sourceUri ? { sourceUri } : {}),
          evidenceIds: sessionEvidenceIds,
        },
        messages,
      };
      distillationCallCount += 1;
      let rawCandidates: MemorySessionDistillationCandidate[] | null;
      try {
        const result = typeof distiller === "function"
          ? await distiller(distillerInput)
          : await distiller.distill(distillerInput);
        rawCandidates = asSessionDistillationCandidateArray(result);
      } catch (error) {
        const outcome = openAICompatibleOutcomeForError(error);
        if (outcome === "parse_failure") distillationParseFailureCount += 1;
        else distillationTransportFailureCount += 1;
        return;
      }
      const candidates = (rawCandidates ?? [])
        .map(normalizeSessionDistillationCandidate)
        .filter((candidate): candidate is MemoryExtractionCandidate => candidate !== null);
      if (candidates.length === 0) {
        distillationEmptyCount += 1;
        return;
      }
      distillationOkWithCandidatesCount += 1;
      const sessionSourceTrust = members.reduce<SourceTrust>(
        (sourceTrust, member) => lowerTrust(sourceTrust, member.sourceTrust),
        "user",
      );
      const sessionSensitivity = members.reduce<Sensitivity>(
        (sensitivity, member) => maxSensitivity(sensitivity, member.sensitivity),
        "normal",
      );
      const sessionAllowLowerTrustPolicyWrites = members.some(
        (member) => member.allowLowerTrustPolicyWrites,
      );
      const sessionEvidence = await store.recordEvidence({
        profileId,
        eventKey: distillationEventKey,
        sourceType: "conversation.session_distillation",
        sourceUri,
        content: sessionDistillationEvidenceContent(members),
        sensitivity: sessionSensitivity,
        eligibleForLongTermMemory: true,
        payload: {
          purpose: "session_distillation",
          eventTime,
          evidenceIds: sessionEvidenceIds,
          conversationId,
          sessionId,
        },
        createdAt: eventTime,
      });
      const sessionResult = members[members.length - 1]!.result;
      const sessionEvent: ConversationEvent = {
        type: "conversation.message",
        profileId,
        role: "user",
        content: sessionEvidence.content,
        createdAt: eventTime,
      };
      const freshCandidates: MemoryExtractionCandidate[] = [];
      const metadataByDedupeKey = new Map<string, Record<string, unknown>>();
      for (const candidate of candidates) {
        const dedupeKey = candidateDedupeKey(candidate);
        const key = `${sessionEvidence.id}:${dedupeKey}`;
        const existing = store.findActiveMemoryByMetadata
          ? await store.findActiveMemoryByMetadata(profileId, "sessionDistillationKey", key)
          : null;
        if (existing) {
          sessionResult.memoryIds.push(existing.id);
          continue;
        }
        freshCandidates.push(candidate);
        metadataByDedupeKey.set(dedupeKey, {
          sessionDistillation: true,
          sessionDistillationKey: key,
          sessionDistillationEvidenceId: sessionEvidence.id,
          sourceEvidenceId: sessionEvidence.id,
          sessionEvidenceIds,
          eventTime,
        });
      }
      const before = sessionResult.memoryIds.length;
      await applyExtractionCandidates({
        result: sessionResult,
        profileId,
        candidates: freshCandidates,
        event: sessionEvent,
        evidence: sessionEvidence,
        eventMetadata: {},
        sensitivity: sessionSensitivity,
        sourceTrust: sessionSourceTrust,
        allowLowerTrustPolicyWrites: sessionAllowLowerTrustPolicyWrites,
        sourceEventId: sessionEvidence.id,
        dedupeKeys,
        embeddingStats,
        contextForCandidate: (candidate) => ({
          result: sessionResult,
          event: sessionEvent,
          evidence: sessionEvidence,
          eventMetadata: {},
          sensitivity: sessionSensitivity,
          sourceTrust: sessionSourceTrust,
          allowLowerTrustPolicyWrites: sessionAllowLowerTrustPolicyWrites,
          sourceEventId: sessionEvidence.id,
          metadata: metadataByDedupeKey.get(candidateDedupeKey(candidate)) ?? {},
        }),
      });
      distilledMemoryCount += Math.max(0, sessionResult.memoryIds.length - before);
    }

    async function applySessionDistillation(members: WindowMember[]): Promise<void> {
      if (!sessionDistillation || members.length === 0) return;
      if (input.messages.some((message) => message.privacyMode === "incognito")) return;
      for (const group of sessionDistillationGroups(members)) {
        await applySessionDistillationGroup(group);
      }
    }

    let pendingWindow: WindowMember[] = [];
    let pendingSessionKey: string | null = null;
    let pendingWindowChars = 0;
    const extractionTasks: ExtractionWindowTask[] = [];
    const sessionMembers: WindowMember[] = [];
    const turnMemoryWrites: TurnMemoryWrite[] = [];

    function windowChars(members: WindowMember[]): number {
      return members.reduce((sum, member) => sum + member.event.content.length, 0);
    }

    function flushWindow(flushOptions: { preserveOverlap?: boolean | undefined } = {}): void {
      if (pendingWindow.length === 0) return;
      const members = pendingWindow;
      const preserved =
        flushOptions.preserveOverlap === true && overlapMessages > 0
          ? members.slice(-overlapMessages)
          : [];
      pendingWindow = preserved;
      pendingSessionKey =
        preserved.length > 0 ? windowSessionKey(preserved[preserved.length - 1]!.event) : null;
      pendingWindowChars = windowChars(preserved);
      const last = members[members.length - 1]!;
      const windowEvidenceIds = members.map((member) => member.evidence.id);
      extractionTasks.push({
        windowIndex: extractionTasks.length,
        transcriptCharCount: windowChars(members),
        members,
        last,
        windowEvidenceIds,
      });
      extractionWindowCount += 1;
      if (options.extractor) extractionCallCount += 1;
    }

    function recordExtractionOutcome(report: MemoryExtractionReport): void {
      const transcriptCharCount = report.transcriptCharCount ?? 0;
      extractionRetryCount += report.retryCount;
      if (report.outcome === "ok_with_candidates") extractionOkWithCandidatesCount += 1;
      else if (report.outcome === "ok_empty") extractionEmptyCount += 1;
      else if (report.outcome === "parse_failure") extractionParseFailureCount += 1;
      else if (report.outcome === "transport_failure") extractionTransportFailureCount += 1;
      if (report.outcome === "ok_with_candidates") {
        extractionOkWithCandidatesCharCount += transcriptCharCount;
      } else if (report.outcome === "ok_empty") {
        extractionEmptyCharCount += transcriptCharCount;
      } else if (report.outcome === "parse_failure") {
        extractionParseFailureCharCount += transcriptCharCount;
      } else if (report.outcome === "transport_failure") {
        extractionTransportFailureCharCount += transcriptCharCount;
      }
      if (
        (report.outcome === "parse_failure" || report.outcome === "transport_failure") &&
        report.windowIndex !== undefined
      ) {
        extractionFailedWindowIndexes.add(report.windowIndex);
      }
      extractedMemoryCountForProgress += report.acceptedCandidateCount;
    }

    function emitExtractionProgress(done: number, total: number): void {
      if (!input.progress?.onWindow) return;
      if (done < total && done % progressEveryWindows !== 0) return;
      const elapsedMs = Math.max(0, Date.now() - extractionStartedMs);
      const etaMs =
        done > 0 && done < total
          ? Math.max(0, Math.round((elapsedMs / done) * (total - done)))
          : null;
      input.progress.onWindow({
        profileId,
        windowsDone: done,
        windowsTotal: total,
        extractionWindowCount,
        extractionCallCount,
        extractionRetryCount,
        extractionOkWithCandidatesCount,
        extractionEmptyCount,
        extractionParseFailureCount,
        extractionTransportFailureCount,
        extractionFailureCount: extractionParseFailureCount + extractionTransportFailureCount,
        extractionOkWithCandidatesCharCount,
        extractionEmptyCharCount,
        extractionParseFailureCharCount,
        extractionTransportFailureCharCount,
        replayedWindowCount,
        replayRecoveredCount,
        extractedMemoryCount: extractedMemoryCountForProgress,
        turnMemoryCount,
        distilledMemoryCount,
        elapsedMs,
        etaMs,
      });
    }

    async function extractWindow(task: ExtractionWindowTask): Promise<ExtractionWindowResult> {
      const { members, last, windowEvidenceIds } = task;
      const extraction = await extractMemoryCandidatePlan({
        extractor: options.extractor,
        temporalParser: options.temporal?.parser,
        inferTemporalFromText: options.temporal?.inferFromText,
        extractionInput: {
          profileId,
          event: { ...last.event, metadata: last.eventMetadata },
          evidence: last.evidence,
          window: {
            messages: members.map((member) => ({
              role: member.event.role,
              content: member.event.content,
              ...(member.event.createdAt ? { createdAt: member.event.createdAt } : {}),
              ...(Object.keys(member.eventMetadata).length > 0
                ? { metadata: member.eventMetadata }
                : {}),
            })),
            evidenceIds: windowEvidenceIds,
          },
        },
        minConfidence: options.extraction?.minConfidence,
      });
      const safeReport = sanitizeRuntimeExtractionReport(
        {
          ...extraction.report,
          windowIndex: task.windowIndex,
          transcriptCharCount: task.transcriptCharCount,
        },
        classifyRuntimeSensitivity,
      );
      return { task, extraction, safeReport };
    }

    async function extractQueuedWindows(): Promise<ExtractionWindowResult[]> {
      const outputs: Array<ExtractionWindowResult | undefined> = new Array(extractionTasks.length);
      let next = 0;
      let done = 0;
      const workerCount = Math.min(windowConcurrency, extractionTasks.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (next < extractionTasks.length) {
            const index = next;
            next += 1;
            const task = extractionTasks[index]!;
            const output = await extractWindow(task);
            outputs[index] = output;
            recordExtractionOutcome(output.safeReport);
            done += 1;
            emitExtractionProgress(done, extractionTasks.length);
          }
        }),
      );
      return outputs.filter((output): output is ExtractionWindowResult => output !== undefined);
    }

    async function replayFailedWindows(): Promise<void> {
      for (let attempt = 0; attempt < replayAttempts; attempt += 1) {
        const indexes = [...extractionFailedWindowIndexes].sort((left, right) => left - right);
        if (indexes.length === 0) return;
        for (const index of indexes) {
          const task = extractionTasks[index];
          if (!task || !extractionFailedWindowIndexes.has(index)) continue;
          replayedWindowCount += 1;
          if (options.extractor) extractionCallCount += 1;
          const output = await extractWindow(task);
          recordExtractionOutcome(output.safeReport);
          if (
            output.safeReport.outcome !== "parse_failure" &&
            output.safeReport.outcome !== "transport_failure"
          ) {
            extractionFailedWindowIndexes.delete(index);
            replayRecoveredCount += 1;
            await applyWindowExtraction(output);
          } else {
            extractionReports.push(output.safeReport);
            task.last.result.extraction = output.safeReport;
          }
          emitExtractionProgress(extractionTasks.length, extractionTasks.length);
        }
      }
    }

    async function applyWindowExtraction(output: ExtractionWindowResult): Promise<void> {
      const { members, last, windowEvidenceIds } = output.task;
      const { extraction, safeReport } = output;
      last.result.extraction = safeReport;
      extractionReports.push(safeReport);
      const windowSensitivity = members.reduce<Sensitivity>(
        (sensitivity, member) => maxSensitivity(sensitivity, member.sensitivity),
        "normal",
      );
      const windowSourceTrust = members.reduce<SourceTrust>(
        (sourceTrust, member) => lowerTrust(sourceTrust, member.sourceTrust),
        "user",
      );
      await applyExtractionCandidates({
        result: last.result,
        profileId,
        candidates: extraction.candidates,
        event: last.event,
        evidence: last.evidence,
        eventMetadata: last.eventMetadata,
        sensitivity: windowSensitivity,
        sourceTrust: windowSourceTrust,
        allowLowerTrustPolicyWrites: last.allowLowerTrustPolicyWrites,
        sourceEventId: last.evidence.id,
        dedupeKeys,
        embeddingStats,
        contextForCandidate: (candidate) => {
          const sourceIndex = Number.isInteger(candidate.sourceIndex)
            ? candidate.sourceIndex
            : undefined;
          const sourceMember = sourceIndex !== undefined ? members[sourceIndex] : undefined;
          const source = sourceMember ?? last;
          const validSourceIndex = sourceMember !== undefined ? sourceIndex : undefined;
          return {
            result: last.result,
            event: source.event,
            evidence: last.evidence,
            eventMetadata: source.eventMetadata,
            sensitivity: sourceMember ? source.sensitivity : windowSensitivity,
            sourceTrust: sourceMember ? source.sourceTrust : windowSourceTrust,
            allowLowerTrustPolicyWrites: source.allowLowerTrustPolicyWrites,
            sourceEventId: last.evidence.id,
            metadata: {
              windowEvidenceIds,
              ...(validSourceIndex !== undefined
                ? {
                    sourceIndex: validSourceIndex,
                    sourceEvidenceId: source.evidence.id,
                  }
                : {}),
            },
          };
        },
      });
    }

    for (const [index, message] of input.messages.entries()) {
      const eventProfileId = profileIdFor(profileId, message.profileId);
      const event: ConversationEvent = {
        type: "conversation.message",
        profileId: eventProfileId,
        role: message.role,
        content: message.content,
        ...(message.conversationId !== undefined ? { conversationId: message.conversationId } : {}),
        ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
        ...(message.sourceTrust !== undefined ? { sourceTrust: message.sourceTrust } : {}),
        ...(message.allowLowerTrustPolicyWrites !== undefined
          ? { allowLowerTrustPolicyWrites: message.allowLowerTrustPolicyWrites }
          : {}),
        ...(message.privacyMode !== undefined ? { privacyMode: message.privacyMode } : {}),
        ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
        ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
      };
      const result = observeResultFor(eventProfileId, event);
      const recorded = await recordConversationEvidence(event, result);
      results.push(recorded.result);
      if (!recorded.write) continue;
      const member: WindowMember = { ...recorded.write, result: recorded.result };
      sessionMembers.push(member);
      if (turnRetention && !isPersonRoutedMemory(event.content)) {
        const turnMemory = await prepareTurnMemoryWrite({
          result: recorded.result,
          profileId: eventProfileId,
          event,
          evidence: recorded.write.evidence,
          eventMetadata: recorded.write.eventMetadata,
          sensitivity: recorded.write.sensitivity,
          sourceTrust: recorded.write.sourceTrust,
          allowLowerTrustPolicyWrites: recorded.write.allowLowerTrustPolicyWrites,
          kind: turnRetention.kind,
          confidence: turnRetention.confidence,
        });
        if (turnMemory) turnMemoryWrites.push(turnMemory);
      }
      if (!extractFromRoles.includes(event.role)) {
        recorded.result.skippedReason = "non_user_message";
        continue;
      }
      if (isPersonRoutedMemory(event.content)) {
        recorded.result.skippedReason = "person_routed";
        continue;
      }
      const sessionKey = windowSessionKey(event);
      const eventChars = event.content.length;
      const sessionChanged = sessionKey !== null && pendingSessionKey !== sessionKey;
      const maxMessagesReached = pendingWindow.length >= maxMessages;
      const charLimitReached = pendingWindowChars + eventChars > maxChars;
      if (
        pendingWindow.length > 0 &&
        (maxMessagesReached || sessionChanged || charLimitReached)
      ) {
        const preserveOverlap =
          charLimitReached &&
          !maxMessagesReached &&
          !sessionChanged &&
          overlapMessages > 0 &&
          windowChars(pendingWindow.slice(-overlapMessages)) + eventChars <= maxChars;
        flushWindow({ preserveOverlap });
        if (pendingWindow.length > 0 && pendingWindowChars + eventChars > maxChars) {
          flushWindow();
        }
      }
      pendingSessionKey = sessionKey;
      pendingWindow.push(member);
      pendingWindowChars += eventChars;
    }
    flushWindow();
    turnMemoryCount += await applyTurnMemoryWrites(turnMemoryWrites, embeddingStats);
    const windowExtractions = await extractQueuedWindows();
    for (const output of windowExtractions) {
      await applyWindowExtraction(output);
    }
    await replayFailedWindows();
    await applySessionDistillation(sessionMembers);

    return {
      profileId,
      observedAt,
      results,
      evidenceIds: results.flatMap((result) => result.evidenceId ? [result.evidenceId] : []),
      memoryIds: results.flatMap((result) => result.memoryIds),
      worldBeliefIds: results.flatMap((result) => result.worldBeliefIds),
      extractionWindowCount,
      extractionCallCount,
      extractionRetryCount,
      extractionOkWithCandidatesCount,
      extractionEmptyCount,
      extractionParseFailureCount,
      extractionTransportFailureCount,
      extractionFailureCount: extractionParseFailureCount + extractionTransportFailureCount,
      extractionOkWithCandidatesCharCount,
      extractionEmptyCharCount,
      extractionParseFailureCharCount,
      extractionTransportFailureCharCount,
      extractionFailedWindowIndexes: [...extractionFailedWindowIndexes].sort((left, right) => left - right),
      replayedWindowCount,
      replayRecoveredCount,
      turnMemoryCount,
      distilledMemoryCount,
      embeddingCallCount: embeddingStats.embeddingCallCount,
      embeddedMemoryCount: embeddingStats.embeddedMemoryCount,
      embeddingFailureCount: embeddingStats.embeddingFailureCount,
      distillationCallCount,
      distillationOkWithCandidatesCount,
      distillationEmptyCount,
      distillationParseFailureCount,
      distillationTransportFailureCount,
      distillationFailureCount: distillationParseFailureCount + distillationTransportFailureCount,
      distillationTruncatedMessageCount,
      extractionMinConfidence,
      extractionReports,
    };
  }

  async function listEvidence(
    input: Omit<EvidenceListInput, "profileId"> & { profileId?: string | undefined } = {},
  ): Promise<EvidenceEvent[]> {
    await initialize();
    if (!store.listEvidence) {
      throw new Error("gmOS store does not support evidence listing");
    }
    const evidence = await store.listEvidence({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
      ...(input.includeSensitive !== undefined ? { includeSensitive: input.includeSensitive } : {}),
      ...(input.eligibleForLongTermMemory !== undefined
        ? { eligibleForLongTermMemory: input.eligibleForLongTermMemory }
        : {}),
    });
    return evidence.map((event) =>
      sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity)
    );
  }

  async function evidenceEventIdsForMemory(memory: MemoryRecord): Promise<string[]> {
    return [...new Set(
      (await store.listEvidenceForMemory(memory.id))
        .map((event) => sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity))
        .map((event) => explanationEventId(event.id, classifyRuntimeSensitivity)),
    )].sort((left, right) => left.localeCompare(right));
  }

  async function prepareTurnCore(input: PrepareTurnInput, trace?: MemorySearchTraceCollector): Promise<{
    prepared: PreparedTurn;
    displayQuery: string;
    retrievalQuery: string;
    candidateMemories: MemoryRecord[];
    curiosityPolicies: ActionPolicy[];
    suppressedCuriosity: Array<{
      policy: ActionPolicy;
      reason: MemoryGapSuppressionReason;
    }>;
    dispositionPreset: string;
    memorySearchLimit: number;
    contextBudgetTokens: number;
    plannerBudget?: { maxSteps: number; maxBranch: number; maxMemories: number } | undefined;
  }> {
    const disposition = applyPrepareDisposition({ request: input, defaultPreset: defaultDisposition });
    input = disposition.request;
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const displayQuery = prepareTurnDisplayQuery(input);
    const query = prepareTurnQuery(input, classifyRuntimeSensitivity);
    const privateRouteSignals = privateTaskRouteSignals(
      input,
      displayQuery,
      classifyRuntimeSensitivity,
    );
    const hideTaskRetrievalHints = displayQuery !== query || privateRouteSignals.length > 0;
    const queryEmbedding = await queryEmbeddingForSearch(query, input.retrieval) ?? null;
    const memories = sourceScopedMemories(await searchMemoriesWithRetrieval({
      profileId,
      query,
      limit: disposition.preset.memorySearchLimit,
      scoreThreshold: disposition.preset.scoreThreshold,
      purpose: "context",
      includeSensitive: input.includeSensitive,
      ...(trace ? { trace } : {}),
    }, input.retrieval, queryEmbedding), query);
    const actionPolicies = await store.listActionPolicies(profileId, {
      includeSensitive: input.includeSensitive,
    });
    const curiosityBudget = store.listGapCandidates
      ? curiosityBudgetForTurn({
          configuredMax: exploration.enabled ? exploration.curiosityBudget : 0,
          requested: input.curiosityBudget,
          dispositionPreset: disposition.preset.name,
        })
      : 0;
    const gapResults = curiosityBudget > 0 && store.listGapCandidates
      ? await store.listGapCandidates({
          profileId,
          query,
          limit: trace ? Math.max(curiosityBudget, 10) : Math.max(curiosityBudget, 1),
          suppressGapIds: input.suppressGapIds,
          includeSuppressed: trace !== undefined,
        })
      : [];
    const curiosityPolicies = gapResults
      .filter((result) => !result.suppressedReason)
      .slice(0, curiosityBudget)
      .map((result) => curiosityActionPolicy(result.candidate));
    const suppressedCuriosity = gapResults
      .filter((result) => result.suppressedReason)
      .slice(0, 10)
      .map((result) => ({
        policy: curiosityActionPolicy(result.candidate),
        reason: result.suppressedReason!,
      }));
    const allActionPolicies = [...actionPolicies, ...curiosityPolicies];
    const evidence: EvidenceEvent[] = [];
    const seenEvidenceIds = new Set<string>();
    async function appendEvidenceForMemory(memoryId: string): Promise<void> {
      for (const event of await store.listEvidenceForMemory(memoryId)) {
        if (seenEvidenceIds.has(event.id)) continue;
        seenEvidenceIds.add(event.id);
        const publicEvidence = sanitizeRuntimeEvidenceForPublicOutput(
          event,
          classifyRuntimeSensitivity,
        );
        evidence.push(
          hideTaskRetrievalHints
            ? hideEvidencePayload(publicEvidence, privateRouteSignals)
            : publicEvidence,
        );
      }
    }
    if (input.includeEvidence) {
      for (const memory of memories) {
        await appendEvidenceForMemory(memory.id);
      }
      for (const policy of allActionPolicies) {
        if (policy.sourceMemoryId) await appendEvidenceForMemory(policy.sourceMemoryId);
      }
    }
    const prepared = composeTurnContext({
      profileId,
      memories: hideTaskRetrievalHints
        ? memories.map((memory) => hideRouteMemoryMetadata(memory, privateRouteSignals))
        : memories,
      actionPolicies: hideTaskRetrievalHints
        ? allActionPolicies.map((policy) => hideRouteActionPolicy(policy, privateRouteSignals))
        : allActionPolicies,
      evidence,
      includeEvidence: input.includeEvidence,
      includeTemporalContext: input.includeTemporalContext,
      contextBudgetTokens: input.contextBudgetTokens,
    });
    const reconstruction =
      input.reconstruction?.mode === "shadow"
        ? await reconstructMemoryContext({
            store: storeWithRetrieval(input.retrieval, queryEmbedding),
            defaultProfileId,
            cueExtractor: options.reconstruction?.cueExtractor,
            inferTemporalCuesFromText: options.reconstruction?.inferTemporalCuesFromText,
            queryEmbedding: queryEmbedding ?? undefined,
            sanitizeEvidenceForOutput: (event) =>
              sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity),
            request: {
              profileId,
              query: displayQuery,
              retrievalQuery: query,
              includeEvidence: input.includeEvidence,
              includeSensitive: input.includeSensitive,
              contextBudgetTokens: input.contextBudgetTokens,
              maxSteps: input.reconstruction.maxSteps,
              maxBranch: input.reconstruction.maxBranch,
              maxMemories: input.reconstruction.maxMemories,
              ...(input.reconstruction.anchorCoverage !== undefined
                ? { anchorCoverage: input.reconstruction.anchorCoverage }
                : {}),
              stopWhenEvidenceEnough: input.reconstruction.stopWhenEvidenceEnough,
              evidenceConvergenceThreshold: input.reconstruction.evidenceConvergenceThreshold,
              includeTemporalMetadata: input.reconstruction.includeTemporalMetadata,
              includeTemporalContext:
                input.reconstruction.includeTemporalContext ?? input.includeTemporalContext,
              temporalMode: input.reconstruction.temporalMode,
              recallPurpose: input.reconstruction.recallPurpose,
              reconstructionIntent: sanitizedReconstructionIntent(
                input.reconstruction.reconstructionIntent,
                classifyRuntimeSensitivity,
              ),
              maxCharsPerMemory: input.reconstruction.maxCharsPerMemory,
              layerPolicy: input.reconstruction.layerPolicy,
              privateRouteSignals,
            },
          })
        : undefined;
    return {
      prepared: reconstruction ? { ...prepared, reconstruction } : prepared,
      displayQuery,
      retrievalQuery: query,
      candidateMemories: memories,
      curiosityPolicies,
      suppressedCuriosity,
      dispositionPreset: disposition.preset.name,
      memorySearchLimit: disposition.preset.memorySearchLimit,
      contextBudgetTokens: input.contextBudgetTokens ?? disposition.preset.contextBudgetTokens,
      ...(input.reconstruction
        ? {
            plannerBudget: {
              maxSteps: input.reconstruction.maxSteps ?? disposition.preset.reconstruction.maxSteps,
              maxBranch: input.reconstruction.maxBranch ?? disposition.preset.reconstruction.maxBranch,
              maxMemories:
                input.reconstruction.maxMemories ?? disposition.preset.reconstruction.maxMemories,
            },
          }
        : {}),
    };
  }

  async function prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
    await initialize();
    const before = await readAuditSnapshot(store);
    const execution = await prepareTurnCore(input);
    assertNoReadSideEffects({
      operation: "prepareTurn",
      before,
      after: await readAuditSnapshot(store),
    });
    return execution.prepared;
  }

  async function explainTurn(input: ExplainTurnInput): Promise<TurnExplanationReport> {
    await initialize();
    const before = await readAuditSnapshot(store);
    const trace = new TurnExplanationSearchCollector();
    const execution = await prepareTurnCore(input, trace);
    const prepared = execution.prepared;
    const includedIds = new Set(prepared.memories.map((memory) => memory.id));
    const decisionsById = traceDecisionByMemoryId(trace.decisions);
    const included: TurnExplanationIncludedMemory[] = [];
    for (const memory of prepared.memories) {
      included.push(includedTurnExplanationMemory({
        memory,
        decision: decisionsById.get(memory.id),
        evidenceEventIds: await evidenceEventIdsForMemory(memory),
      }));
    }

    const excludedById = new Map<string, TurnExplanationExcludedMemory>();
    for (const decision of trace.decisions) {
      if (includedIds.has(decision.memory.id) || decision.decision !== "excluded") continue;
      const excluded = excludedTurnExplanationMemory(decision);
      if (excluded && !excludedById.has(excluded.id)) excludedById.set(excluded.id, excluded);
    }
    for (const memory of execution.candidateMemories) {
      if (includedIds.has(memory.id)) continue;
      const baseDecision = decisionsById.get(memory.id) ?? fallbackSearchDecision(memory);
      const excluded = excludedTurnExplanationMemory({
        ...baseDecision,
        memory,
        decision: "excluded",
        reason: "budget_cut",
      });
      if (excluded) excludedById.set(excluded.id, excluded);
    }

    const maxExcluded = boundedPositiveInteger(input.maxExcluded, 20, 0, 100);
    const planner = prepared.reconstruction
      ? {
          maxSteps: execution.plannerBudget?.maxSteps ?? 3,
          maxBranch: execution.plannerBudget?.maxBranch ?? 4,
          maxMemories: execution.plannerBudget?.maxMemories ?? 8,
          stopReason: prepared.reconstruction.stats.stopReason,
          ...(prepared.reconstruction.stats.anchorCoverage
            ? { anchorCoverage: prepared.reconstruction.stats.anchorCoverage }
            : {}),
          ...(prepared.reconstruction.stats.sweeps
            ? { sweeps: prepared.reconstruction.stats.sweeps }
            : {}),
          ...(prepared.reconstruction.stats.layers
            ? { layers: prepared.reconstruction.stats.layers }
            : {}),
        }
      : undefined;
    const report: TurnExplanationReport = {
      schema: "gmos.turn_explanation.v1",
      profileId: prepared.profileId,
      query: execution.displayQuery,
      included,
      excluded: [...excludedById.values()].slice(0, maxExcluded),
      curiosity: {
        emitted: prepared.actionPolicies
          .filter((policy) => policy.kind === "curiosity" && policy.gapId && policy.gapKind)
          .map((policy) => ({
            gapId: policy.gapId!,
            kind: policy.gapKind!,
            score: policy.score ?? 0,
            sourceIds: policy.sourceIds ?? [],
            text: policy.text,
        })),
        suppressed: execution.suppressedCuriosity.map(({ policy, reason }) => ({
          gapId: policy.gapId!,
          kind: policy.gapKind!,
          score: policy.score ?? 0,
          reason,
          sourceIds: policy.sourceIds ?? [],
        })),
      },
      budgets: {
        dispositionPreset: execution.dispositionPreset,
        memorySearchLimit: execution.memorySearchLimit,
        contextBudgetTokens: execution.contextBudgetTokens,
        promptTokenEstimate: prepared.stats.promptTokenEstimate,
        actionPolicyCount: prepared.stats.actionPolicyCount,
        ...(planner ? { planner } : {}),
        stoppedAt:
          execution.candidateMemories.length > prepared.memories.length
            ? "token_budget"
            : planner && planner.stopReason !== "evidence_sufficient"
              ? "planner"
              : "complete",
      },
      stats: prepared.stats,
    };
    assertNoReadSideEffects({
      operation: "explainTurn",
      before,
      after: await readAuditSnapshot(store),
    });
    return report;
  }

  async function reconstructContext(input: ReconstructContextInput): Promise<ReconstructedContext> {
    await initialize();
    const before = await readAuditSnapshot(store);
    const disposition = applyReconstructDisposition({
      request: sanitizedReconstructRequest(input, classifyRuntimeSensitivity),
      defaultPreset: defaultDisposition,
    });
    const queryEmbedding = await queryEmbeddingForSearch(
      reconstructQueryForEmbedding(disposition.request),
      input.retrieval,
    ) ?? null;
    const reconstructed = await reconstructMemoryContext({
      store: storeWithRetrieval(input.retrieval, queryEmbedding),
      defaultProfileId,
      cueExtractor: options.reconstruction?.cueExtractor,
      inferTemporalCuesFromText: options.reconstruction?.inferTemporalCuesFromText,
      queryEmbedding: queryEmbedding ?? undefined,
      sanitizeEvidenceForOutput: (event) =>
        sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity),
      request: disposition.request,
    });
    assertNoReadSideEffects({
      operation: "reconstructContext",
      before,
      after: await readAuditSnapshot(store),
    });
    return reconstructed;
  }

  async function explainEvidencePath(
    input: ExplainEvidencePathInput,
  ): Promise<EvidencePathExplanation> {
    await initialize();
    const before = await readAuditSnapshot(store);
    const disposition = applyReconstructDisposition({
      request: sanitizedReconstructRequest({
        ...input,
        includeEvidence: input.includeEvidence ?? true,
      }, classifyRuntimeSensitivity),
      defaultPreset: defaultDisposition,
    });
    const queryEmbedding = await queryEmbeddingForSearch(
      reconstructQueryForEmbedding(disposition.request),
      input.retrieval,
    ) ?? null;
    const reconstructed = await reconstructMemoryContext({
      store: storeWithRetrieval(input.retrieval, queryEmbedding),
      defaultProfileId,
      cueExtractor: options.reconstruction?.cueExtractor,
      inferTemporalCuesFromText: options.reconstruction?.inferTemporalCuesFromText,
      queryEmbedding: queryEmbedding ?? undefined,
      sanitizeEvidenceForOutput: (event) =>
        sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity),
      request: disposition.request,
    });
    assertNoReadSideEffects({
      operation: "explainEvidencePath",
      before,
      after: await readAuditSnapshot(store),
    });
    return buildEvidencePathExplanation({
      reconstructed,
      includePlannerTrace: input.includePlannerTrace,
    });
  }

  async function commitOutcome(input: CommitOutcomeInput): Promise<void> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const createdAt = input.createdAt ?? nowIso();
    if (store.commitOutcome) {
      const outcome = runtimeCommitOutcomeForStorage({
        profileId,
        taskId: input.taskId,
        objective: input.objective,
        status: input.status,
        summary: input.summary,
        failureKind: input.failureKind,
        createdAt,
        usedMemoryIds: input.usedMemoryIds,
      }, classifyRuntimeSensitivity);
      if (outcome) {
        await store.commitOutcome({
          ...outcome,
          outcomeReinforcement: lifecycle.outcomeReinforcement,
          confidenceAnnealing: lifecycle.confidenceAnnealing,
        });
        return;
      }
      if (input.status === "failed") {
        await recordRuntimeFailure(store, {
          profileId,
          failureKind: input.failureKind ?? "task_failure",
          content: input.summary ?? input.objective,
          createdAt,
          metadata: { taskTrajectorySkippedReason: "secret_like" },
          additionalSurfaces: ["task_trajectory"],
        }, classifyRuntimeSensitivity);
      }
      return;
    }
    if (input.usedMemoryIds && input.usedMemoryIds.length > 0) {
      throw new Error("gmOS store does not support commitOutcome usedMemoryIds");
    }
    const taskOutcomeResult = await recordRuntimeTaskOutcome(store, {
      profileId,
      taskId: input.taskId,
      objective: input.objective,
      status: input.status,
      summary: input.summary,
      failureKind: input.failureKind,
      createdAt,
    }, classifyRuntimeSensitivity);
    if (taskOutcomeResult === "recorded" && input.status === "failed") {
      await recordRuntimeFailure(store, {
        profileId,
        failureKind: input.failureKind ?? "task_failure",
        content: input.summary ?? input.objective,
        createdAt,
        additionalSurfaces: ["task_trajectory"],
      }, classifyRuntimeSensitivity);
    }
  }

  async function recordFeedback(input: FeedbackInput): Promise<void> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const createdAt = input.createdAt ?? nowIso();
    if (store.recordFeedbackSignal) {
      const feedback = runtimeFeedbackForStorage({
        profileId,
        failureKind: input.failureKind,
        content: input.content,
        createdAt,
        relatedMemoryIds: input.relatedMemoryIds,
        signal: input.signal,
      }, classifyRuntimeSensitivity);
      await store.recordFeedbackSignal({
        ...feedback,
        confidencePenalty: lifecycle.feedbackConfidencePenalty,
        confidenceAnnealing: lifecycle.confidenceAnnealing,
      });
      return;
    }
    if (
      (input.relatedMemoryIds && input.relatedMemoryIds.length > 0) ||
      input.signal !== undefined
    ) {
      throw new Error("gmOS store does not support feedback memory signals");
    }
    await recordRuntimeFailure(store, {
      profileId,
      failureKind: input.failureKind ?? "wrong_recall",
      content: input.content,
      createdAt,
    }, classifyRuntimeSensitivity);
  }

  function addConsolidationSkipped(
    report: MaintenanceReport,
    reason: string,
    count = 1,
  ): void {
    const existing = report.consolidation.skipped.find((entry) => entry.reason === reason);
    if (existing) {
      existing.count += count;
    } else {
      report.consolidation.skipped.push({ reason, count });
    }
    report.consolidation.skipped.sort((left, right) => left.reason.localeCompare(right.reason));
  }

  async function callConsolidator(
    cluster: MemoryConsolidationCluster,
  ): Promise<MemoryConsolidationCandidate[] | null> {
    if (!options.consolidator) return null;
    try {
      const raw =
        typeof options.consolidator === "function"
          ? await options.consolidator(cluster)
          : await options.consolidator.consolidate(cluster);
      return asConsolidationCandidateArray(raw);
    } catch {
      return null;
    }
  }

  async function applySemanticConsolidation(input: {
    profileId: string;
    now: string;
    dryRun: boolean;
    report: MaintenanceReport;
  }): Promise<void> {
    if (!input.report.consolidation.enabled) return;
    if (!options.consolidator) {
      addConsolidationSkipped(input.report, "consolidator_not_configured");
      return;
    }
    if (!store.listMemories || !store.recordConsolidationSummary) {
      addConsolidationSkipped(input.report, "store_consolidation_summary_unsupported");
      return;
    }
    const plannedArchived = new Set(
      input.report.consolidation.duplicateClusters.flatMap((cluster) => cluster.archivedMemberIds),
    );
    const memories = (await store.listMemories({
      profileId: input.profileId,
      status: "any",
      includeSensitive: true,
      includePerson: true,
      limit: consolidation.maxClustersPerRun * consolidation.maxMembersPerCluster * 4,
    })).filter((memory) => !plannedArchived.has(memory.id));
    const clusters = selectSemanticConsolidationClusters(memories, consolidation);
    input.report.consolidation.evaluated = Math.max(
      input.report.consolidation.evaluated,
      memories.length,
    );
    if (clusters.length === 0) {
      addConsolidationSkipped(input.report, "no_semantic_clusters");
      return;
    }
    const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
    const seenCandidates = new Set<string>();
    const name = consolidatorName(options.consolidator);
    for (const cluster of clusters) {
      const sourceMemoryIds = cluster.memories.map((memory) => memory.id);
      const clusterSourceTrust = sourceTrustForMemoryIds(sourceMemoryIds, memoriesById);
      const rawCandidates = await callConsolidator(cluster);
      if (rawCandidates === null) {
        addConsolidationSkipped(input.report, "consolidator_returned_null_or_failed");
        continue;
      }
      if (rawCandidates.length === 0) {
        addConsolidationSkipped(input.report, "consolidator_returned_empty");
        continue;
      }
      for (const candidate of rawCandidates) {
        const normalized = normalizeConsolidationCandidate(candidate, cluster);
        if ("reason" in normalized) {
          input.report.consolidation.rejectedCandidates.push({
            kind: cluster.kind,
            sourceMemoryIds,
            reason: normalized.reason,
          });
          continue;
        }
        if (
          clusterSourceTrust !== "user" &&
          lowerTrustConsolidationPolicyKind(normalized.normalized)
        ) {
          input.report.consolidation.rejectedCandidates.push({
            kind: cluster.kind,
            sourceMemoryIds,
            reason: "lower_trust_policy_write",
          });
          continue;
        }
        const contentSensitivity = classifyRuntimeSensitivity(
          normalized.normalized.content,
          "content",
        );
        const structuredSensitivity = runtimeValueSensitivity(
          {
            subject: normalized.normalized.subject,
            predicate: normalized.normalized.predicate,
            object: normalized.normalized.object,
          },
          classifyRuntimeSensitivity,
          new WeakSet<object>(),
          "structured_candidate",
        );
        if (contentSensitivity === "secret_like" || structuredSensitivity === "secret_like") {
          input.report.consolidation.rejectedCandidates.push({
            kind: cluster.kind,
            sourceMemoryIds,
            reason: "secret_like",
          });
          continue;
        }
        const key = uniqueConsolidationCandidateKey(normalized.normalized);
        if (seenCandidates.has(key)) {
          input.report.consolidation.rejectedCandidates.push({
            kind: cluster.kind,
            sourceMemoryIds,
            reason: "duplicate",
          });
          continue;
        }
        seenCandidates.add(key);
        const confidenceCap = sourceTrustConfidenceCap(clusterSourceTrust, trust);
        const confidence = confidenceCap === undefined
          ? normalized.normalized.confidence
          : Math.min(normalized.normalized.confidence, confidenceCap);
        const trustMetadata = {
          sourceTrust: clusterSourceTrust,
          ...lowerTrustAnnealingMetadata({
            sourceTrust: clusterSourceTrust,
            confidence,
            startedAt: input.now,
            lifecycle,
          }),
        };
        const summary = {
          kind: normalized.normalized.kind,
          sourceMemoryIds,
          sharedTags: cluster.sharedTags,
          content: normalized.normalized.content,
          confidence,
          reasons: ["host_consolidator_summary"],
        };
        if (input.dryRun) {
          input.report.consolidation.summaryMemories.push(summary);
          continue;
        }
        const embedding = await embeddingForRuntimeWrite({
          kind: normalized.normalized.kind,
          sensitivity: contentSensitivity,
          content: normalized.normalized.content,
        });
        const result = await store.recordConsolidationSummary({
          profileId: input.profileId,
          kind: normalized.normalized.kind,
          content: normalized.normalized.content,
          sensitivity: contentSensitivity,
          confidence,
          sourceMemoryIds,
          sharedTags: cluster.sharedTags,
          createdAt: input.now,
          metadata: {
            consolidationSource: "host_consolidator",
            ...trustMetadata,
            ...(name ? { consolidatorName: name } : {}),
          },
          ...(embedding ? { embedding } : {}),
          ...(normalized.normalized.subject &&
          normalized.normalized.predicate &&
          normalized.normalized.object
            ? {
                belief: {
                  subject: normalized.normalized.subject,
                  predicate: normalized.normalized.predicate,
                  object: normalized.normalized.object,
                },
              }
            : {}),
        });
        input.report.consolidation.summaryMemories.push({
          ...summary,
          memoryId: result.memory.id,
          ...(result.worldBelief ? { worldBeliefId: result.worldBelief.id } : {}),
        });
      }
    }
  }

  function addDistillationSkipped(
    report: MaintenanceReport,
    reason: string,
    count = 1,
  ): void {
    const existing = report.distillation.skipped.find((entry) => entry.reason === reason);
    if (existing) {
      existing.count += count;
    } else {
      report.distillation.skipped.push({ reason, count });
    }
    report.distillation.skipped.sort((left, right) => left.reason.localeCompare(right.reason));
  }

  async function callProcedureDistiller(
    cluster: MemoryProcedureDistillationCluster,
  ): Promise<MemoryProcedureDistillationCandidate[] | null> {
    if (!options.procedureDistiller) return null;
    try {
      const publicCluster = publicProcedureDistillationCluster(cluster);
      const raw =
        typeof options.procedureDistiller === "function"
          ? await options.procedureDistiller(publicCluster)
          : await options.procedureDistiller.distill(publicCluster);
      return asProcedureDistillationCandidateArray(raw);
    } catch {
      return null;
    }
  }

  function alreadyDistilledClusterKeys(events: EvidenceEvent[]): Set<string> {
    const keys = new Set<string>();
    for (const event of events) {
      const key = event.payload.clusterKey;
      if (typeof key === "string" && key.trim().length > 0) keys.add(key);
    }
    return keys;
  }

  async function applyProcedureDistillation(input: {
    profileId: string;
    now: string;
    dryRun: boolean;
    report: MaintenanceReport;
  }): Promise<void> {
    if (!input.report.distillation.enabled) return;
    if (!options.procedureDistiller) {
      addDistillationSkipped(input.report, "procedure_distiller_not_configured");
      return;
    }
    if (!store.listTaskTrajectories || !store.recordProcedureDistillation || !store.listEvidence) {
      addDistillationSkipped(input.report, "store_distillation_unsupported");
      return;
    }
    const trajectories = await store.listTaskTrajectories({
      profileId: input.profileId,
      limit: distillation.maxClustersPerRun * distillation.maxTrajectoriesPerCluster * 4,
    });
    const existingEvidence = await store.listEvidence({
      profileId: input.profileId,
      sourceType: "distillation",
      eligibleForLongTermMemory: false,
      includeSensitive: true,
      limit: 500,
    });
    const clusters = selectProcedureDistillationClusters(
      trajectories,
      distillation,
      alreadyDistilledClusterKeys(existingEvidence),
    );
    input.report.distillation.evaluated = trajectories.length;
    input.report.distillation.clusters = clusters.map((cluster) => ({
      objective: cluster.objective,
      sourceTrajectoryIds: cluster.trajectories.map((trajectory) => trajectory.id),
      sharedTags: cluster.sharedTags,
      clusterKey: cluster.clusterKey,
    }));
    if (clusters.length === 0) {
      addDistillationSkipped(input.report, "no_distillation_clusters");
      return;
    }
    const seenCandidates = new Set<string>();
    const name = procedureDistillerName(options.procedureDistiller);
    for (const cluster of clusters) {
      const rawCandidates = await callProcedureDistiller(cluster);
      const sourceTrajectoryIds = cluster.trajectories.map((trajectory) => trajectory.id);
      if (rawCandidates === null) {
        addDistillationSkipped(input.report, "procedure_distiller_returned_null_or_failed");
        continue;
      }
      if (rawCandidates.length === 0) {
        addDistillationSkipped(input.report, "procedure_distiller_returned_empty");
        continue;
      }
      for (const candidate of rawCandidates) {
        const normalized = normalizeProcedureDistillationCandidate(candidate);
        if ("reason" in normalized) {
          input.report.distillation.rejectedCandidates.push({
            sourceTrajectoryIds,
            reason: normalized.reason,
          });
          continue;
        }
        const contentSensitivity = classifyRuntimeSensitivity(
          normalized.normalized.content,
          "content",
        );
        if (contentSensitivity === "secret_like") {
          input.report.distillation.rejectedCandidates.push({
            sourceTrajectoryIds,
            reason: "secret_like",
          });
          continue;
        }
        const key = normalized.normalized.content.toLowerCase();
        if (seenCandidates.has(key)) {
          input.report.distillation.rejectedCandidates.push({
            sourceTrajectoryIds,
            reason: "duplicate",
          });
          continue;
        }
        seenCandidates.add(key);
        const summary = {
          sourceTrajectoryIds,
          objective: cluster.objective,
          sharedTags: cluster.sharedTags,
          content: normalized.normalized.content,
          confidence: normalized.normalized.confidence,
          reasons: ["host_procedure_distiller"],
        };
        if (input.dryRun) {
          input.report.distillation.summaryMemories.push(summary);
          continue;
        }
        const embedding = await embeddingForRuntimeWrite({
          kind: "procedure",
          sensitivity: contentSensitivity,
          content: normalized.normalized.content,
        });
        const result = await store.recordProcedureDistillation({
          profileId: input.profileId,
          objective: cluster.objective,
          content: normalized.normalized.content,
          sensitivity: contentSensitivity,
          confidence: normalized.normalized.confidence,
          sourceTrajectoryIds,
          sharedTags: cluster.sharedTags,
          clusterKey: cluster.clusterKey,
          createdAt: input.now,
          metadata: {
            distillationSource: "host_procedure_distiller",
            ...(name ? { procedureDistillerName: name } : {}),
          },
          ...(embedding ? { embedding } : {}),
        });
        if (result.alreadyExists) {
          addDistillationSkipped(input.report, "already_distilled");
          continue;
        }
        input.report.distillation.summaryMemories.push({
          ...summary,
          memoryId: result.memory.id,
        });
      }
    }
  }

  function addDossierSkipped(
    report: MaintenanceReport,
    reason: string,
    count = 1,
  ): void {
    const existing = report.dossier.skipped.find((entry) => entry.reason === reason);
    if (existing) {
      existing.count += count;
    } else {
      report.dossier.skipped.push({ reason, count });
    }
    report.dossier.skipped.sort((left, right) => left.reason.localeCompare(right.reason));
  }

  async function callDossierSynthesizer(
    snapshot: MemoryDossierEntitySnapshot,
  ): Promise<MemoryDossierCandidate[] | null> {
    if (!options.dossierSynthesizer) return null;
    try {
      const raw =
        typeof options.dossierSynthesizer === "function"
          ? await options.dossierSynthesizer(snapshot)
          : await options.dossierSynthesizer.synthesize(snapshot);
      return asDossierCandidateArray(raw);
    } catch {
      return null;
    }
  }

  function dossierSourceBeliefIds(snapshot: MemoryDossierEntitySnapshot): string[] {
    return snapshot.beliefs.map((belief) => belief.id);
  }

  function dossierSourceMemoryIds(snapshot: MemoryDossierEntitySnapshot): string[] {
    return snapshot.memories.map((memory) => memory.id);
  }

  function dossierReportEntity(snapshot: MemoryDossierEntitySnapshot) {
    return {
      entityKey: snapshot.entityKey,
      kind: snapshot.entityKind,
      sourceBeliefIds: dossierSourceBeliefIds(snapshot),
      sourceMemoryIds: dossierSourceMemoryIds(snapshot),
    };
  }

  function dossierInputFingerprint(snapshot: MemoryDossierEntitySnapshot, content: string): string {
    return createHash("sha256")
      .update(dossierInputKey({ snapshot, content }))
      .digest("hex");
  }

  async function activeDossierForEntity(
    profileId: string,
    entityKey: string,
  ): Promise<MemoryRecord | null> {
    if (store.findActiveMemoryByMetadata) {
      return store.findActiveMemoryByMetadata(profileId, "dossierFor", entityKey);
    }
    if (!store.listMemories) return null;
    const existing = await store.listMemories({
      profileId,
      status: "any",
      includeSensitive: true,
      includePerson: true,
      limit: 100,
    });
    return existing.find(
      (memory) =>
        memory.status === "active" &&
        memory.metadata.dossier === true &&
        memory.metadata.dossierFor === entityKey,
    ) ?? null;
  }

  async function applyDossierSynthesis(input: {
    profileId: string;
    now: string;
    dryRun: boolean;
    report: MaintenanceReport;
  }): Promise<void> {
    if (!input.report.dossier.enabled) return;
    if (!options.dossierSynthesizer) {
      addDossierSkipped(input.report, "dossier_synthesizer_not_configured");
      return;
    }
    if (!store.listWorldBeliefs || !store.listMemories || !store.archiveMemoryById) {
      addDossierSkipped(input.report, "store_dossier_unsupported");
      return;
    }
    const beliefs = await store.listWorldBeliefs({
      profileId: input.profileId,
      status: "active",
      limit: dossier.maxEntitiesPerRun * dossier.maxBeliefsPerEntity * 4,
    });
    const memories = await store.listMemories({
      profileId: input.profileId,
      status: "any",
      includeSensitive: true,
      includePerson: true,
      limit: dossier.maxEntitiesPerRun * dossier.maxMemoriesPerEntity * 8,
    });
    const snapshots = selectEntityDossierSnapshots({ beliefs, memories, config: dossier });
    input.report.dossier.evaluated = beliefs.length;
    input.report.dossier.entities = snapshots.map(dossierReportEntity);
    if (snapshots.length === 0) {
      addDossierSkipped(input.report, "no_dossier_entities");
      return;
    }
    const name = dossierSynthesizerName(options.dossierSynthesizer);
    for (const snapshot of snapshots) {
      const entity = dossierReportEntity(snapshot);
      const rawCandidates = await callDossierSynthesizer(snapshot);
      if (rawCandidates === null) {
        addDossierSkipped(input.report, "dossier_synthesizer_returned_null_or_failed");
        continue;
      }
      if (rawCandidates.length === 0) {
        addDossierSkipped(input.report, "dossier_synthesizer_returned_empty");
        continue;
      }
      const candidate = rawCandidates[0];
      if (!candidate) continue;
      const normalized = normalizeDossierCandidate(candidate, snapshot);
      if ("reason" in normalized) {
        input.report.dossier.rejectedCandidates.push({ ...entity, reason: normalized.reason });
        continue;
      }
      const contentSensitivity = classifyRuntimeSensitivity(
        normalized.normalized.content,
        "content",
      );
      const entitySensitivity = runtimeValueSensitivity(
        {
          entityKey: snapshot.entityKey,
          aliases: snapshot.aliases,
        },
        classifyRuntimeSensitivity,
        new WeakSet<object>(),
        "structured_candidate",
      );
      if (contentSensitivity === "secret_like" || entitySensitivity === "secret_like") {
        input.report.dossier.rejectedCandidates.push({ ...entity, reason: "secret_like" });
        continue;
      }
      if (snapshot.entityKind !== "person" && isPersonRoutedMemory(normalized.normalized.content)) {
        input.report.dossier.rejectedCandidates.push({ ...entity, reason: "person_routed" });
        continue;
      }
      const inputKey = dossierInputFingerprint(snapshot, normalized.normalized.content);
      const existing = await activeDossierForEntity(input.profileId, snapshot.entityKey);
      if (
        existing?.metadata.dossierInputKey === inputKey &&
        existing.content === normalized.normalized.content
      ) {
        addDossierSkipped(input.report, "dossier_already_current");
        continue;
      }
      const summary = {
        ...entity,
        content: normalized.normalized.content,
        confidence: normalized.normalized.confidence,
        ...(existing ? { supersededMemoryId: existing.id } : {}),
        reasons: ["host_dossier_synthesizer"],
      };
      if (input.dryRun) {
        input.report.dossier.summaryMemories.push(summary);
        continue;
      }
      const evidence = await store.recordEvidence({
        profileId: input.profileId,
        eventKey: ["dossier", input.profileId, snapshot.entityKey, inputKey].join(":"),
        sourceType: "dossier",
        content: "Entity dossier synthesis",
        sensitivity: "normal",
        eligibleForLongTermMemory: false,
        payload: {
          entityKey: snapshot.entityKey,
          kind: snapshot.entityKind,
          sourceBeliefIds: entity.sourceBeliefIds,
          sourceMemoryIds: entity.sourceMemoryIds,
          ...(existing ? { supersededMemoryId: existing.id } : {}),
        },
        createdAt: input.now,
      });
      const embedding = await embeddingForRuntimeWrite({
        kind: snapshot.entityKind,
        sensitivity: contentSensitivity,
        content: normalized.normalized.content,
      });
      const memory = await store.addMemory({
        profileId: input.profileId,
        kind: snapshot.entityKind,
        content: normalized.normalized.content,
        sensitivity: contentSensitivity,
        confidence: normalized.normalized.confidence,
        sourceEventId: evidence.id,
        metadata: {
          dossier: true,
          dossierFor: snapshot.entityKey,
          dossierKind: snapshot.entityKind,
          dossierInputKey: inputKey,
          dossierSource: "host_dossier_synthesizer",
          sourceBeliefIds: entity.sourceBeliefIds,
          sourceMemoryIds: entity.sourceMemoryIds,
          aliases: snapshot.aliases,
          ...(name ? { dossierSynthesizerName: name } : {}),
        },
        createdAt: input.now,
        ...(embedding ? { embedding } : {}),
      });
      if (existing) {
        await store.archiveMemoryById({
          profileId: input.profileId,
          id: existing.id,
          reason: `dossier_superseded_by:${memory.id}`,
          archivedAt: input.now,
        });
      }
      input.report.dossier.summaryMemories.push({
        ...summary,
        memoryId: memory.id,
      });
    }
  }

  async function maintain(input: MaintenanceInput = {}) {
    await initialize();
    if (!store.maintain) throw new Error("gmOS store does not support maintenance");
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const now = input.now ?? nowIso();
    assertValidIsoInstant(now, "maintain.now");
    const phases = input.phases ?? ["decay"];
    const unsupportedPhase = phases.find(
      (phase) =>
        phase !== "decay" &&
        phase !== "consolidate" &&
        phase !== "distill" &&
        phase !== "dossier" &&
        phase !== "explore",
    );
    if (unsupportedPhase) throw new Error(`Unsupported gmOS maintenance phase: ${unsupportedPhase}`);
    const dryRun = input.dryRun === true;
    const before = dryRun ? await readAuditSnapshot(store) : null;
    const report = await store.maintain({
      profileId,
      now,
      dryRun,
      phases,
      lifecycle,
      consolidation,
      distillation,
      dossier,
      exploration,
    });
    if (phases.includes("consolidate") && consolidation.enabled) {
      await applySemanticConsolidation({
        profileId,
        now,
        dryRun,
        report,
      });
    }
    if (phases.includes("distill") && distillation.enabled) {
      await applyProcedureDistillation({
        profileId,
        now,
        dryRun,
        report,
      });
    }
    if (phases.includes("dossier") && dossier.enabled) {
      await applyDossierSynthesis({
        profileId,
        now,
        dryRun,
        report,
      });
    }
    if (before) {
      assertNoReadSideEffects({
        operation: "maintain(dryRun)",
        before,
        after: await readAuditSnapshot(store),
      });
    }
    return report;
  }

  async function memoryRollback(input: MemoryRollbackInput): Promise<MemoryRollbackResult> {
    await initialize();
    if (!store.rollbackMemory) throw new Error("gmOS store does not support memory rollback");
    return store.rollbackMemory({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      memoryId: input.memoryId,
      toEvidenceEventId: input.toEvidenceEventId,
      approvedBy: input.approvedBy,
      rolledBackAt: input.rolledBackAt,
    });
  }

  async function forget(input: ForgetInput): Promise<ForgetResult> {
    await initialize();
    return store.forget({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      query: input.query,
      targetTerms: input.targetTerms,
      reason: input.reason,
    });
  }

  function payloadRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  function payloadStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  function payloadStatus(value: unknown): MemoryRecord["status"] | undefined {
    return value === "active" || value === "dormant" || value === "archived"
      ? value
      : undefined;
  }

  function payloadReferencesMemory(payload: Record<string, unknown>, memoryId: string): boolean {
    if (payload.memoryId === memoryId) return true;
    if (payload.archivedMemberId === memoryId) return true;
    if (payload.survivorId === memoryId) return true;
    if (payload.supersededMemoryId === memoryId) return true;
    if (payloadStringArray(payload.sourceMemoryIds).includes(memoryId)) return true;
    if (payloadStringArray(payload.memberIds).includes(memoryId)) return true;
    for (const key of ["actions", "previousValues", "restoredValues"]) {
      const values = payload[key];
      if (!Array.isArray(values)) continue;
      if (values.some((entry) => payloadRecord(entry).memoryId === memoryId)) return true;
    }
    return false;
  }

  function lifecycleReasonSummary(parts: string[]): string {
    const summary = parts
      .filter((part) => part.trim().length > 0)
      .map((part) => redactForReport(part))
      .join("; ");
    return summary || "no_public_reason";
  }

  function lifecycleTransitionKind(input: {
    fromStatus?: MemoryRecord["status"] | undefined;
    toStatus?: MemoryRecord["status"] | undefined;
    reasons?: string[] | undefined;
  }): MemoryLifecycleHistoryEntry["eventKind"] {
    if (input.toStatus === "dormant") return "decayed_to_dormant";
    if (
      input.toStatus === "archived" &&
      input.reasons?.some((reason) => /derived_from_forgotten_source/iu.test(reason))
    ) {
      return "derived_forget_archived";
    }
    if (
      input.toStatus === "archived" &&
      input.reasons?.some((reason) => /forget|delete|deletion/iu.test(reason))
    ) {
      return "forgotten";
    }
    if (input.toStatus === "archived") return "archived";
    if (input.fromStatus === "dormant" && input.toStatus === "active") return "reactivated";
    if (input.fromStatus === "archived" && input.toStatus === "active") return "restored";
    return "updated";
  }

  function lifecycleEntriesFromEvidence(
    memory: MemoryRecord,
    event: EvidenceEvent,
  ): MemoryLifecycleHistoryEntry[] {
    const payload = payloadRecord(event.payload);
    const sourceType = safePublicLabel(event.sourceType);
    const eventId = explanationEventId(event.id, classifyRuntimeSensitivity);
    if (event.id === memory.sourceEventId) {
      if (sourceType === "consolidation" && memory.metadata.consolidationSummary === true) {
        return [{
          createdAt: event.createdAt,
          eventKind: "consolidated_summary",
          eventId,
          sourceType,
          reasonSummary: lifecycleReasonSummary([
            "created consolidation summary",
            `sources:${payloadStringArray(payload.sourceMemoryIds).length}`,
          ]),
        }];
      }
      if (sourceType === "distillation" && memory.metadata.procedureDistillation === true) {
        return [{
          createdAt: event.createdAt,
          eventKind: "distilled_procedure",
          eventId,
          sourceType,
          reasonSummary: lifecycleReasonSummary([
            "created distilled procedure",
            `trajectories:${payloadStringArray(payload.sourceTrajectoryIds).length}`,
          ]),
        }];
      }
      if (sourceType === "dossier" && memory.metadata.dossier === true) {
        return [{
          createdAt: event.createdAt,
          eventKind: "dossier_created",
          eventId,
          sourceType,
          reasonSummary: lifecycleReasonSummary([
            "created entity dossier",
            `sources:${payloadStringArray(payload.sourceMemoryIds).length}`,
          ]),
        }];
      }
      const imported = sourceType.includes("import") || sourceType.includes("restore");
      return [{
        createdAt: event.createdAt,
        eventKind: imported ? "imported" : sourceType === "sdk.low_level_update" ? "updated" : "created",
        eventId,
        sourceType,
        reasonSummary: lifecycleReasonSummary([`source:${sourceType}`]),
      }];
    }
    if (!payloadReferencesMemory(payload, memory.id)) return [];
    if (sourceType === "maintenance" || sourceType === "memory.lifecycle") {
      const fromStatus = payloadStatus(payload.from);
      const toStatus = payloadStatus(payload.to);
      const reasons = payloadStringArray(payload.reasons);
      return [{
        createdAt: event.createdAt,
        eventKind: lifecycleTransitionKind({ fromStatus, toStatus, reasons }),
        eventId,
        sourceType,
        ...(fromStatus !== undefined ? { fromStatus } : {}),
        ...(toStatus !== undefined ? { toStatus } : {}),
        reasonSummary: lifecycleReasonSummary(reasons.length > 0 ? reasons : [`source:${sourceType}`]),
      }];
    }
    if (sourceType === "consolidation") {
      const kind: MemoryLifecycleHistoryEntry["eventKind"] =
        payload.archivedMemberId === memory.id ||
        payloadStringArray(payload.sourceMemoryIds).includes(memory.id) ||
        payloadStringArray(payload.memberIds).includes(memory.id)
          ? "consolidated_source"
          : payload.survivorId === memory.id
            ? "consolidated_survivor"
            : "consolidated_summary";
      const reasons = payloadStringArray(payload.reasons);
      return [{
        createdAt: event.createdAt,
        eventKind: kind,
        eventId,
        sourceType,
        reasonSummary: lifecycleReasonSummary(reasons.length > 0 ? reasons : ["consolidation"]),
      }];
    }
    if (sourceType === "distillation") {
      return [{
        createdAt: event.createdAt,
        eventKind: event.id === memory.sourceEventId ? "distilled_procedure" : "distilled_source_trajectory",
        eventId,
        sourceType,
        reasonSummary: lifecycleReasonSummary(["procedure distillation"]),
      }];
    }
    if (sourceType === "dossier") {
      return [{
        createdAt: event.createdAt,
        eventKind: payload.supersededMemoryId === memory.id ? "archived" : "dossier_created",
        eventId,
        sourceType,
        reasonSummary: lifecycleReasonSummary(["dossier"]),
      }];
    }
    if (sourceType === "outcome" || sourceType === "feedback" || sourceType === "memory.reinforcement") {
      const entries: MemoryLifecycleHistoryEntry[] = [];
      if (payloadStringArray(payload.memoryIds).includes(memory.id)) {
        entries.push({
          createdAt: event.createdAt,
          eventKind: "reinforced",
          eventId,
          sourceType,
          reasonSummary: lifecycleReasonSummary([
            `source:${sourceType}`,
            typeof payload.reason === "string" ? `reason:${payload.reason}` : "",
            Number.isFinite(Number(payload.delta)) ? `delta:${Number(payload.delta)}` : "",
          ]),
        });
      }
      if (payloadStringArray(payload.propagatedMemoryIds).includes(memory.id)) {
        const provenanceCredit = payloadRecord(payload.provenanceCredit);
        const creditedMemories = Array.isArray(provenanceCredit.creditedMemories)
          ? provenanceCredit.creditedMemories
          : [];
        const credit = creditedMemories.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).id === memory.id,
        ) as Record<string, unknown> | undefined;
        entries.push({
          createdAt: event.createdAt,
          eventKind: "propagated_reinforced",
          eventId,
          sourceType,
          reasonSummary: lifecycleReasonSummary([
            "provenance_credit",
            Number.isFinite(Number(credit?.hop)) ? `hop:${Number(credit?.hop)}` : "",
            Number.isFinite(Number(credit?.delta)) ? `delta:${Number(credit?.delta)}` : "",
            typeof credit?.viaMemoryId === "string" ? `via:${credit.viaMemoryId}` : "",
          ]),
        });
      }
      return entries;
    }
    if (sourceType === "evolution") {
      const reverted = typeof payload.revertedApplicationEventId === "string";
      return [{
        createdAt: event.createdAt,
        eventKind: reverted ? "evolution_reverted" : "evolution_applied",
        eventId,
        sourceType,
        reasonSummary: lifecycleReasonSummary([
          reverted ? "evolution reverted" : "evolution applied",
          typeof payload.proposalId === "string" ? `proposal:${payload.proposalId}` : "",
        ]),
      }];
    }
    if (sourceType === "memory.rollback") {
      return [{
        createdAt: event.createdAt,
        eventKind: "rolled_back",
        eventId,
        sourceType,
        reasonSummary: lifecycleReasonSummary([
          "forensic rollback",
          typeof payload.toEvidenceEventId === "string" ? `to:${payload.toEvidenceEventId}` : "",
        ]),
      }];
    }
    return [];
  }

  function failureReferencesMemory(failure: FailureEventRecord, memoryId: string): boolean {
    return (
      payloadStringArray(failure.metadata.relatedMemoryIds).includes(memoryId) ||
      payloadStringArray(failure.metadata.usedMemoryIds).includes(memoryId)
    );
  }

  async function memoryLifecycleHistory(memory: MemoryRecord): Promise<MemoryLifecycleHistory> {
    const eventById = new Map<string, EvidenceEvent>();
    for (const event of await store.listEvidenceForMemory(memory.id)) {
      eventById.set(event.id, event);
    }
    if (store.listEvidence) {
      for (const event of await store.listEvidence({
        profileId: memory.profileId,
        includeSensitive: true,
        limit: 500,
      })) {
        if (event.id === memory.sourceEventId || payloadReferencesMemory(event.payload, memory.id)) {
          eventById.set(event.id, event);
        }
      }
    }
    const entries: MemoryLifecycleHistoryEntry[] = [];
    for (const event of eventById.values()) {
      const safeEvent = sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity);
      entries.push(...lifecycleEntriesFromEvidence(memory, safeEvent));
    }
    if (store.listFailures) {
      for (const failure of await store.listFailures({ profileId: memory.profileId, limit: 500 })) {
        if (!failureReferencesMemory(failure, memory.id)) continue;
        entries.push({
          createdAt: failure.createdAt,
          eventKind: "reinforced",
          eventId: explanationEventId(failure.id, classifyRuntimeSensitivity),
          sourceType: "feedback",
          reasonSummary: lifecycleReasonSummary([`failure:${failure.failureKind}`]),
        });
      }
    }
    const annealing = payloadRecord(memory.metadata.annealing);
    if (annealing.active === true) {
      entries.push({
        createdAt:
          typeof annealing.startedAt === "string" ? annealing.startedAt : memory.updatedAt,
        eventKind: "annealed",
        sourceType: "memory.annealing",
        reasonSummary: lifecycleReasonSummary([
          typeof annealing.reason === "string" ? annealing.reason : "confidence_annealing",
          typeof annealing.sourceTrust === "string" ? `sourceTrust:${annealing.sourceTrust}` : "",
        ]),
      });
    }
    if (entries.length === 0) {
      entries.push({
        createdAt: memory.createdAt,
        eventKind: "created",
        reasonSummary: "source_evidence_unavailable",
      });
    }
    const seen = new Set<string>();
    const ordered = entries
      .sort((left, right) => {
        const at = left.createdAt.localeCompare(right.createdAt);
        if (at !== 0) return at;
        return [
          left.eventKind,
          left.eventId ?? "",
          left.fromStatus ?? "",
          left.toStatus ?? "",
        ].join(":").localeCompare([
          right.eventKind,
          right.eventId ?? "",
          right.fromStatus ?? "",
          right.toStatus ?? "",
        ].join(":"));
      })
      .filter((entry) => {
        const key = [
          entry.createdAt,
          entry.eventKind,
          entry.eventId ?? "",
          entry.fromStatus ?? "",
          entry.toStatus ?? "",
        ].join("\n");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      schema: "gmos.memory_lifecycle_history.v1",
      entries: ordered,
    };
  }

  async function explain(id: string, profileIdInput?: string): Promise<ExplainResult | null> {
    await initialize();
    const before = await readAuditSnapshot(store);
    const profileId = profileIdFor(defaultProfileId, profileIdInput);
    const memory = await store.getMemoryById(profileId, id, {
      includeSensitive: true,
      includePerson: true,
    });
    if (!memory) {
      assertNoReadSideEffects({
        operation: "explain",
        before,
        after: await readAuditSnapshot(store),
      });
      return null;
    }
    const evidence = (await store.listEvidenceForMemory(memory.id)).map(
      (event) => sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity),
    );
    const result: ExplainResult = {
      id: memory.id,
      kind: "memory",
      memoryKind: safePublicLabel(memory.kind) as MemoryRecord["kind"],
      sensitivity: memory.sensitivity,
      text: memory.content,
      evidence,
      lifecycle: await memoryLifecycleHistory(memory),
    };
    assertNoReadSideEffects({
      operation: "explain",
      before,
      after: await readAuditSnapshot(store),
    });
    return result;
  }

  return {
    add,
    addMany,
    update,
    archive,
    restoreArchived,
    clear,
    search,
    list,
    get,
    observe,
    observeWithReport,
    ingestConversation,
    listEvidence,
    prepareTurn,
    explainTurn,
    reconstructContext,
    explainEvidencePath,
    commitOutcome,
    recordFeedback,
    maintain,
    memoryRollback,
    forget,
    explain,
    async close() {
      await store.close();
    },
  };
}
