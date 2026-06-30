import { randomUUID } from "node:crypto";

import {
  associationCueKey,
  associationCueMatchesQuery,
  extractAssociationCues,
  sourceContentEntityCues,
  sourceMetadataEntityCues,
} from "../kernel/associations.js";
import { composeTurnContext } from "../kernel/context-composer.js";
import { buildEntityMentions } from "../kernel/entities.js";
import { buildEvidencePathExplanation } from "../kernel/evidence-path.js";
import {
  extractMemoryCandidatePlan,
  extractRuleMemoryCandidates,
  isReservedSpeakerIdentity,
  stableNamedPersonSubject,
} from "../kernel/extraction.js";
import { reconstructMemoryContext } from "../kernel/reconstruction.js";
import {
  classifySensitivity,
  eligibleForLongTermMemory,
  isNonSpeakerPrefix,
  isPersonRoutedMemory,
  redactForReport,
  sanitizeEvidenceForPublicOutput,
  sanitizePublicPayloadRecord,
  sanitizePublicSourceMetadata,
  stripGmosOwnedMetadataFields,
} from "../kernel/safety.js";
import type {
  CommitOutcomeInput,
  EvidencePathExplanation,
  EvidenceEvent,
  EvidenceListInput,
  ExplainEvidencePathInput,
  ExplainResult,
  FeedbackInput,
  ForgetInput,
  ForgetResult,
  HostEvent,
  LowLevelAddMemoryInput,
  LowLevelArchiveMemoryInput,
  LowLevelClearMemoriesInput,
  LowLevelGetMemoryInput,
  LowLevelListMemoriesInput,
  LowLevelRestoreArchivedMemoryInput,
  LowLevelSearchInput,
  LowLevelUpdateMemoryInput,
  MemoryExtractionCandidate,
  MemoryKind,
  MemoryRecord,
  MemoryOS,
  MemoryOSOptions,
  ObserveResult,
  PrepareTurnInput,
  ReadAuditSnapshot,
  ReconstructContextInput,
  ReconstructedContext,
  RestoreArchivedResult,
  Sensitivity,
} from "../kernel/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function profileIdFor(defaultProfileId: string, profileId?: string): string {
  return profileId ?? defaultProfileId;
}

function inferSpeakerPrefix(content: string): string | null {
  const match = /^\s*([\p{L}\p{M}' -]{2,48})\s*:\s*(.+)$/u.exec(content);
  if (!match?.[1] || !match[2]) return null;
  const prefix = match[1].trim();
  if (isNonSpeakerPrefix(prefix)) return null;
  if (!hasFirstPersonAnchor(match[2])) return null;
  return prefix;
}

function hasFirstPersonAnchor(content: string): boolean {
  return /\b(I|I'm|I’m|I've|I’ve|I'd|I’d|I'll|I’ll|my|mine|we|we're|we’re|we've|we’ve|our)\b|我|我们|我的|咱们/iu.test(content);
}

function sourcelessPersonalMemory(memory: MemoryRecord): boolean {
  return sourceMetadataEntityCues(memory.metadata).length === 0 && hasFirstPersonAnchor(memory.content);
}

function sourceMetadataForEvent(event: Extract<HostEvent, { type: "conversation.message" }>): Record<string, unknown> {
  const explicit = sanitizePublicSourceMetadata(event.metadata);
  if (typeof explicit.speaker === "string") return explicit;
  const inferredSpeaker = inferSpeakerPrefix(event.content);
  if (!inferredSpeaker) return explicit;
  return { ...explicit, speaker: inferredSpeaker };
}

function sourceMetadataForCandidate(
  eventMetadata: Record<string, unknown>,
  candidate: MemoryExtractionCandidate,
): Record<string, unknown> {
  if (typeof candidate.speaker !== "string" || candidate.speaker.trim().length === 0) {
    return eventMetadata;
  }
  const candidateSpeaker = sanitizePublicSourceMetadata({ speaker: candidate.speaker }).speaker;
  if (typeof candidateSpeaker !== "string" || candidateSpeaker.trim().length === 0) {
    return eventMetadata;
  }
  const {
    speaker: _eventSpeaker,
    speakerId: _eventSpeakerId,
    speakerAliases: _eventSpeakerAliases,
    participants: _eventParticipants,
    ...nonSpeakerEventMetadata
  } = eventMetadata;
  return { ...nonSpeakerEventMetadata, speaker: candidateSpeaker };
}

function sanitizeExternalMemoryMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return stripGmosOwnedMetadataFields(sanitizePublicPayloadRecord(metadata ?? {}));
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

function structuredCandidateSensitivity(candidate: MemoryExtractionCandidate): Sensitivity {
  let sensitivity: Sensitivity = "normal";
  for (const value of [
    candidate.actionPolicyKind,
    candidate.cardinality,
    candidate.eventTime,
    candidate.object,
    candidate.predicate,
    candidate.source,
    candidate.speaker,
    candidate.subject,
    ...(candidate.subjectAliases ?? []),
    candidate.validFrom,
    candidate.validTo,
  ]) {
    if (typeof value !== "string") continue;
    sensitivity = maxSensitivity(sensitivity, classifySensitivity(value));
    if (sensitivity === "secret_like") return sensitivity;
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
  values: string[] | undefined,
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

function memorySensitivityForCandidate(input: {
  eventSensitivity: Sensitivity;
  candidateContentSensitivity: Sensitivity;
  candidateStructuredSensitivity: Sensitivity;
}): Sensitivity {
  return maxSensitivity(
    maxSensitivity(input.eventSensitivity, input.candidateContentSensitivity),
    input.candidateStructuredSensitivity,
  );
}

function publicSpeaker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const speaker = value.trim();
  if (!speaker || speaker.startsWith("[redacted_")) return undefined;
  if (isReservedSpeakerIdentity(speaker)) return undefined;
  return classifySensitivity(speaker) === "normal" && stableNamedPersonSubject(speaker)
    ? speaker
    : undefined;
}

function publicStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const speaker = publicSpeaker(entry);
        return speaker ? [speaker] : [];
      })
    : [];
}

function speakerKey(value: string): string {
  return value.trim().toLowerCase();
}

function speakerIdentityKeys(input: { speaker: string; aliases?: unknown }): Set<string> {
  return new Set([input.speaker, ...publicStringArray(input.aliases)].map(speakerKey));
}

function shouldRouteBeliefToSpeaker(input: {
  eventContent: string;
  eventMetadata: Record<string, unknown>;
  speaker: string;
}): boolean {
  const prefix = inferSpeakerPrefix(input.eventContent);
  const speakerKeys = speakerIdentityKeys({
    speaker: input.speaker,
    aliases: input.eventMetadata.speakerAliases,
  });
  if (prefix) return speakerKeys.has(speakerKey(prefix));
  const participants = publicStringArray(input.eventMetadata.participants);
  if (new Set(participants.map(speakerKey)).size > 1) return true;
  return participants.length === 0 && hasFirstPersonAnchor(input.eventContent);
}

function worldBeliefSubjectForCandidate(input: {
  candidate: MemoryExtractionCandidate;
  eventContent: string;
  eventMetadata: Record<string, unknown>;
}): string {
  const { candidate, eventContent, eventMetadata } = input;
  if (candidate.subject) return candidate.subject;
  const predicatePrefix = candidate.predicate?.split(".")[0]?.toLowerCase();
  if (
    !isActionMemoryCandidate(candidate) &&
    predicatePrefix !== "user" &&
    predicatePrefix !== "person"
  ) {
    return "user";
  }
  const candidateSpeaker = publicSpeaker(candidate.speaker);
  if (candidateSpeaker) return `person:${candidateSpeaker}`;
  const speaker = publicSpeaker(eventMetadata.speaker);
  return speaker && shouldRouteBeliefToSpeaker({ eventContent, eventMetadata, speaker })
    ? `person:${speaker}`
    : "user";
}

function worldBeliefSubjectAliasesForCandidate(input: {
  candidate: MemoryExtractionCandidate;
  subject: string;
  eventMetadata: Record<string, unknown>;
}): string[] | undefined {
  const { candidate, subject, eventMetadata } = input;
  const aliases = [...(candidate.subjectAliases ?? [])];
  if (!candidate.subject && subject !== "user") {
    aliases.push(...publicStringArray(eventMetadata.speakerAliases));
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
}): MemoryExtractionCandidate {
  const { candidate, subject } = input;
  if (subject === "user" || !isActionMemoryCandidate(candidate)) return candidate;

  const { actionPolicyKind: _actionPolicyKind, ...candidateWithoutActionPolicy } = candidate;
  return {
    ...candidateWithoutActionPolicy,
    kind:
      candidate.kind === "preference" ||
      candidate.kind === "boundary" ||
      candidate.kind === "procedure"
        ? "fact"
        : candidate.kind,
    predicate: subjectScopedActionPredicate({ candidate, subject }),
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
    if (sourceCues.length === 0) return !sourcelessPersonalMemory(memory);
    return sourceCues.some((cue) => selectedSourceCues.has(associationCueKey(cue)));
  });
}

function sourceEntityCuesForMemory(memory: MemoryRecord): string[] {
  return [
    ...sourceMetadataEntityCues(memory.metadata),
    ...sourceContentEntityCues(memory.content),
  ];
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

function prepareTurnDisplayQuery(input: PrepareTurnInput): string {
  return [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function prepareTurnQuery(input: PrepareTurnInput): string {
  return [
    prepareTurnDisplayQuery(input),
    input.task?.intent,
    input.task?.projectId,
    input.task?.topic,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n");
}

function hideRouteMemoryMetadata(memory: MemoryRecord): MemoryRecord {
  return {
    ...memory,
    scope: "global",
    metadata: {},
  };
}

function hideEvidencePayload(event: EvidenceEvent): EvidenceEvent {
  return {
    ...event,
    payload: {},
  };
}

function lowLevelKind(input: LowLevelAddMemoryInput): MemoryKind {
  return isPersonRoutedMemory(input.content) ? "person" : input.kind;
}

function lowLevelSensitivity(input: {
  content: string;
  scope?: string | undefined;
  sensitivity?: Sensitivity | undefined;
}): Sensitivity {
  const detected = classifySensitivity(input.content);
  const scopeSensitivity =
    typeof input.scope === "string" ? classifySensitivity(input.scope) : "normal";
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

function sensitivityForParts(parts: Array<string | undefined>): Sensitivity {
  let result: Sensitivity = "normal";
  for (const part of parts) {
    if (!part) continue;
    const sensitivity = classifySensitivity(part);
    if (sensitivity === "secret_like") return "secret_like";
    if (sensitivity === "sensitive") result = "sensitive";
  }
  return result;
}

function failureContentForStorage(content: string): string {
  return classifySensitivity(content) === "secret_like" ? redactForReport(content) : content;
}

async function recordRuntimeFailure(
  store: MemoryOSOptions["store"],
  input: {
    profileId: string;
    failureKind: NonNullable<FeedbackInput["failureKind"]>;
    content: string;
    createdAt?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await store.recordFailure({
    profileId: input.profileId,
    failureKind: input.failureKind,
    content: failureContentForStorage(input.content),
    createdAt: input.createdAt,
    metadata: input.metadata,
  });
}

async function recordRuntimeTaskOutcome(
  store: MemoryOSOptions["store"],
  input: {
    profileId: string;
    taskId?: string | undefined;
    objective: string;
    status: "completed" | "failed";
    summary?: string | undefined;
    createdAt?: string | undefined;
  },
): Promise<"recorded" | "skipped_secret_like"> {
  const sensitivity = sensitivityForParts([input.taskId, input.objective, input.summary]);
  if (sensitivity !== "secret_like") {
    await store.recordTaskTrajectory(input);
    return "recorded";
  }
  if (input.status === "failed") {
    await recordRuntimeFailure(store, {
      profileId: input.profileId,
      failureKind: "task_failure",
      content: input.summary ?? input.objective,
      createdAt: input.createdAt,
      metadata: { taskTrajectorySkippedReason: "secret_like" },
    });
  }
  return "skipped_secret_like";
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

export function createMemoryOS(options: MemoryOSOptions): MemoryOS {
  const defaultProfileId = options.profileId ?? "default";
  const store = options.store;
  let initialized = false;

  async function initialize(): Promise<void> {
    if (initialized) return;
    await store.initialize();
    initialized = true;
  }

  async function add(input: LowLevelAddMemoryInput): Promise<MemoryRecord> {
    await initialize();
    const content = input.content.trim();
    if (!content) throw new Error("gmOS low-level add requires non-empty content");
    assertLowLevelPersonAllowed(input);
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const kind = lowLevelKind(input);
    const sensitivity = lowLevelSensitivity(input);
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
        kind,
        scope: input.scope ?? "global",
        metadata: sanitizePublicSourceMetadata(input.metadata),
      },
      createdAt,
    });
    return store.addMemory({
      profileId,
      kind,
      content,
      sensitivity,
      sourceEventId: evidence.id,
      metadata: {
        ...sanitizeExternalMemoryMetadata(input.metadata),
        lowLevelApi: true,
      },
      createdAt,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    });
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
    const kind = isPersonRoutedMemory(content) ? "person" : input.kind ?? existing.kind;
    assertLowLevelPersonAllowed({
      kind,
      content,
      allowPerson: input.allowPerson,
    });
    const sensitivity = lowLevelSensitivity({
      content,
      scope: input.scope ?? existing.scope,
      sensitivity: input.sensitivity ?? existing.sensitivity,
    });
    const updatedAt = input.updatedAt ?? nowIso();
    const inputMetadata = sanitizeExternalMemoryMetadata(input.metadata);
    const metadata = input.replaceMetadata
      ? inputMetadata
      : {
          ...existing.metadata,
          ...inputMetadata,
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
        previousKind: existing.kind,
        kind,
        scope: input.scope ?? existing.scope,
        metadata: sanitizePublicSourceMetadata(input.metadata),
      },
      createdAt: updatedAt,
    });
    return updateMemory({
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
    });
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
    return store.searchMemories({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      purpose: input.purpose ?? "context",
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.includeSensitive !== undefined ? { includeSensitive: input.includeSensitive } : {}),
      ...(input.includePerson !== undefined ? { includePerson: input.includePerson } : {}),
    });
  }

  async function list(input: LowLevelListMemoriesInput = {}): Promise<MemoryRecord[]> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    if (store.listMemories) {
      return store.listMemories({
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
      });
    }
    if (input.status && input.status !== "active") {
      throw new Error("gmOS store does not support archived memory listing");
    }
    if (input.kind || input.scope) {
      throw new Error("gmOS store does not support filtered memory listing");
    }
    return store.searchMemories({
      profileId,
      purpose: "context",
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.includeSensitive !== undefined ? { includeSensitive: input.includeSensitive } : {}),
      ...(input.includePerson !== undefined ? { includePerson: input.includePerson } : {}),
    });
  }

  async function get(input: LowLevelGetMemoryInput): Promise<MemoryRecord | null> {
    await initialize();
    return store.getMemoryById(profileIdFor(defaultProfileId, input.profileId), input.id, {
      includeSensitive: input.includeSensitive,
      includePerson: input.includePerson,
      includeArchived: input.includeArchived,
    });
  }

  async function observe(event: HostEvent): Promise<void> {
    await observeWithReport(event);
  }

  async function observeWithReport(event: HostEvent): Promise<ObserveResult> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, event.profileId);
    const result: ObserveResult = {
      profileId,
      eventType: event.type,
      observedAt: event.createdAt ?? nowIso(),
      memoryIds: [],
      worldBeliefIds: [],
    };

    if (event.type === "user.forget_request") {
      await store.forget({ profileId, query: event.query, reason: event.reason });
      return { ...result, skippedReason: "forget_request" };
    }

    if (event.type === "user.feedback" || event.type === "user.correction") {
      await recordRuntimeFailure(store, {
        profileId,
        failureKind: event.failureKind ?? "wrong_recall",
        content: event.content,
        createdAt: event.createdAt,
      });
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
      });
      if (taskOutcomeResult === "recorded" && event.type === "task.failed") {
        await recordRuntimeFailure(store, {
          profileId,
          failureKind: "task_failure",
          content: event.summary ?? event.objective,
          createdAt: event.createdAt,
        });
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

    const sensitivity = classifySensitivity(event.content);
    const eligible = eligibleForLongTermMemory({
      content: event.content,
      privacyMode: event.privacyMode,
    });
    result.eligibleForLongTermMemory = eligible;

    if (!eligible) return { ...result, skippedReason: "not_eligible_for_long_term_memory" };

    const eventMetadata = sourceMetadataForEvent(event);
    const evidence = await store.recordEvidence({
      profileId,
      eventKey: eventKey(event),
      sourceType: event.type,
      sourceUri: event.conversationId ? `conversation:${event.conversationId}` : null,
      content: event.content,
      sensitivity,
      eligibleForLongTermMemory: eligible,
      payload: {
        role: event.role,
        messageId: event.messageId,
        privacyMode: event.privacyMode ?? "normal",
        metadata: eventMetadata,
      },
      createdAt: event.createdAt,
    });
    result.evidenceId = evidence.id;

    const extractFromRoles = options.extraction?.extractFromRoles ?? ["user"];
    if (!extractFromRoles.includes(event.role)) {
      return { ...result, skippedReason: "non_user_message" };
    }
    if (isPersonRoutedMemory(event.content)) return { ...result, skippedReason: "person_routed" };
    const extraction = await extractMemoryCandidatePlan({
      extractor: options.extractor,
      extractionInput: {
        profileId,
        event: { ...event, metadata: eventMetadata },
        evidence,
        ruleCandidates: extractRuleMemoryCandidates(event.content, eventMetadata),
      },
      fallbackToRules: options.extraction?.fallbackToRules,
      minConfidence: options.extraction?.minConfidence,
    });
    result.extraction = extraction.report;
    for (const candidate of extraction.candidates) {
      const candidateSourceMetadata = sourceMetadataForCandidate(eventMetadata, candidate);
      const subject = worldBeliefSubjectForCandidate({
        candidate,
        eventContent: event.content,
        eventMetadata: candidateSourceMetadata,
      });
      const writeCandidate = memoryWriteCandidateForSubject({ candidate, subject });
      const candidateSensitivity = classifySensitivity(writeCandidate.content);
      const candidateStructuredSensitivity = structuredCandidateSensitivity(writeCandidate);
      const structuredMetadata = structuredCandidateMetadata(writeCandidate);
      if (
        writeCandidate.kind === "person" ||
        candidateSensitivity === "secret_like" ||
        candidateStructuredSensitivity === "secret_like" ||
        isPersonRoutedMemory(writeCandidate.content)
      ) {
        continue;
      }
      const memoryEntityMentions = buildEntityMentions({
        subject: writeCandidate.subject ?? (subject !== "user" ? subject : undefined),
        predicate: writeCandidate.predicate,
        subjectAliases: writeCandidate.subjectAliases,
        sourceMetadata: candidateSourceMetadata,
      });
      const memory = await store.addMemory({
        profileId,
        kind: writeCandidate.kind,
        content: writeCandidate.content,
        confidence: writeCandidate.confidence,
        sensitivity: memorySensitivityForCandidate({
          eventSensitivity: sensitivity,
          candidateContentSensitivity: candidateSensitivity,
          candidateStructuredSensitivity,
        }),
        sourceEventId: evidence.id,
        metadata: {
          ...sanitizeExternalMemoryMetadata(candidate.metadata),
          ...structuredMetadata,
          sourceRole: event.role,
          ...(Object.keys(candidateSourceMetadata).length > 0 ? { sourceMetadata: candidateSourceMetadata } : {}),
          ...(memoryEntityMentions.length > 0 ? { entityMentions: memoryEntityMentions } : {}),
        },
        createdAt: event.createdAt,
      });
      result.memoryIds.push(memory.id);
      if (writeCandidate.predicate) {
        const subjectAliases = worldBeliefSubjectAliasesForCandidate({
          candidate: writeCandidate,
          subject,
          eventMetadata: candidateSourceMetadata,
        });
        const beliefEntityMentions = buildEntityMentions({
          subject,
          predicate: writeCandidate.predicate,
          subjectAliases,
          sourceMetadata: candidateSourceMetadata,
        });
        const belief = await store.addWorldBelief({
          profileId,
          subject,
          subjectAliases,
          predicate: writeCandidate.predicate,
          object: writeCandidate.object ?? writeCandidate.content,
          confidence: writeCandidate.confidence,
          sourceMemoryId: memory.id,
          cardinality: writeCandidate.cardinality,
          createdAt: event.createdAt ?? memory.createdAt,
          metadata: {
            ...sanitizeExternalMemoryMetadata(writeCandidate.metadata),
            ...structuredMetadata,
            sourceRole: event.role,
            ...(Object.keys(candidateSourceMetadata).length > 0 ? { sourceMetadata: candidateSourceMetadata } : {}),
            ...(beliefEntityMentions.length > 0 ? { entityMentions: beliefEntityMentions } : {}),
          },
        });
        result.worldBeliefIds.push(belief.id);
      }
    }
    return result;
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
    return evidence.map(sanitizeEvidenceForPublicOutput);
  }

  async function prepareTurn(input: PrepareTurnInput) {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const displayQuery = prepareTurnDisplayQuery(input);
    const query = prepareTurnQuery(input);
    const hideTaskRetrievalHints = displayQuery !== query;
    const before = await readAuditSnapshot(store);
    const memories = sourceScopedMemories(await store.searchMemories({
      profileId,
      query,
      limit: 12,
      purpose: "context",
      includeSensitive: input.includeSensitive,
    }), query);
    const actionPolicies = await store.listActionPolicies(profileId, {
      includeSensitive: input.includeSensitive,
    });
    const evidence: EvidenceEvent[] = [];
    const seenEvidenceIds = new Set<string>();
    async function appendEvidenceForMemory(memoryId: string): Promise<void> {
      for (const event of await store.listEvidenceForMemory(memoryId)) {
        if (seenEvidenceIds.has(event.id)) continue;
        seenEvidenceIds.add(event.id);
        const publicEvidence = sanitizeEvidenceForPublicOutput(event);
        evidence.push(hideTaskRetrievalHints ? hideEvidencePayload(publicEvidence) : publicEvidence);
      }
    }
    if (input.includeEvidence) {
      for (const memory of memories) {
        await appendEvidenceForMemory(memory.id);
      }
      for (const policy of actionPolicies) {
        if (policy.sourceMemoryId) await appendEvidenceForMemory(policy.sourceMemoryId);
      }
    }
    const prepared = composeTurnContext({
      profileId,
      memories: hideTaskRetrievalHints ? memories.map(hideRouteMemoryMetadata) : memories,
      actionPolicies,
      evidence,
      includeEvidence: input.includeEvidence,
      contextBudgetTokens: input.contextBudgetTokens,
    });
    const reconstruction =
      input.reconstruction?.mode === "shadow"
        ? await reconstructMemoryContext({
            store,
            defaultProfileId,
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
              stopWhenEvidenceEnough: input.reconstruction.stopWhenEvidenceEnough,
              evidenceConvergenceThreshold: input.reconstruction.evidenceConvergenceThreshold,
              includeTemporalMetadata: input.reconstruction.includeTemporalMetadata,
              temporalMode: input.reconstruction.temporalMode,
            },
          })
        : undefined;
    assertNoReadSideEffects({
      operation: "prepareTurn",
      before,
      after: await readAuditSnapshot(store),
    });
    return reconstruction ? { ...prepared, reconstruction } : prepared;
  }

  async function reconstructContext(input: ReconstructContextInput): Promise<ReconstructedContext> {
    await initialize();
    const before = await readAuditSnapshot(store);
    const reconstructed = await reconstructMemoryContext({
      store,
      defaultProfileId,
      request: input,
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
    const reconstructed = await reconstructMemoryContext({
      store,
      defaultProfileId,
      request: {
        ...input,
        includeEvidence: input.includeEvidence ?? true,
      },
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
    const taskOutcomeResult = await recordRuntimeTaskOutcome(store, {
      profileId,
      taskId: input.taskId,
      objective: input.objective,
      status: input.status,
      summary: input.summary,
      createdAt: input.createdAt,
    });
    if (taskOutcomeResult === "recorded" && input.status === "failed") {
      await recordRuntimeFailure(store, {
        profileId,
        failureKind: "task_failure",
        content: input.summary ?? input.objective,
        createdAt: input.createdAt,
      });
    }
  }

  async function recordFeedback(input: FeedbackInput): Promise<void> {
    await initialize();
    await recordRuntimeFailure(store, {
      profileId: profileIdFor(defaultProfileId, input.profileId),
      failureKind: input.failureKind ?? "wrong_recall",
      content: input.content,
      createdAt: input.createdAt,
    });
  }

  async function forget(input: ForgetInput): Promise<ForgetResult> {
    await initialize();
    return store.forget({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      query: input.query,
      reason: input.reason,
    });
  }

  async function explain(id: string, profileIdInput?: string): Promise<ExplainResult | null> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, profileIdInput);
    const memory = await store.getMemoryById(profileId, id, {
      includeSensitive: true,
      includePerson: true,
    });
    if (!memory) return null;
    const evidence = (await store.listEvidenceForMemory(memory.id)).map(
      sanitizeEvidenceForPublicOutput,
    );
    return {
      id: memory.id,
      kind: "memory",
      memoryKind: memory.kind,
      sensitivity: memory.sensitivity,
      text: memory.content,
      evidence,
    };
  }

  return {
    add,
    update,
    archive,
    restoreArchived,
    clear,
    search,
    list,
    get,
    observe,
    observeWithReport,
    listEvidence,
    prepareTurn,
    reconstructContext,
    explainEvidencePath,
    commitOutcome,
    recordFeedback,
    forget,
    explain,
    async close() {
      await store.close();
    },
  };
}
