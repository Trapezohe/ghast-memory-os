import { randomUUID } from "node:crypto";

import {
  associationCueKey,
  associationCueMatchesQuery,
  associationCueTextPattern,
  extractAssociationCues,
  sourceMetadataEntityCues,
} from "../kernel/associations.js";
import { composeTurnContext } from "../kernel/context-composer.js";
import { buildEntityMentions, resolveWorldEntitySubject } from "../kernel/entities.js";
import type { EntityResolver } from "../kernel/entities.js";
import { buildEvidencePathExplanation } from "../kernel/evidence-path.js";
import {
  extractMemoryCandidatePlan,
} from "../kernel/extraction.js";
import { isReservedSpeakerIdentity } from "../kernel/person-identity.js";
import { reconstructMemoryContext } from "../kernel/reconstruction.js";
import {
  isPersonRoutedMemory,
  safePublicLabel,
  sanitizePublicPayloadRecord,
  sourceMetadataSpeakerIsPerson,
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
  ReconstructionIntentHint,
  ReconstructContextInput,
  ReconstructedContext,
  RestoreArchivedResult,
  Sensitivity,
} from "../kernel/types.js";
import {
  recordRuntimeFailure,
  recordRuntimeTaskOutcome,
} from "./runtime-outcomes.js";
import {
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
  return redactRuntimeSourceMetadataRecord(event.metadata, classifyRuntimeSensitivity);
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
    ...(requiredTagGroups.length > 0 ? { requiredTagGroups } : {}),
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

function lowLevelKind(input: LowLevelAddMemoryInput): MemoryKind {
  return isPersonRoutedMemory(input.content) ? "person" : input.kind;
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

export function createMemoryOS(options: MemoryOSOptions): MemoryOS {
  const defaultProfileId = options.profileId ?? "default";
  const store = options.store;
  const classifyRuntimeSensitivity = runtimeSensitivityClassifier(
    options.safety?.sensitivityClassifier,
  );
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
    const sensitivity = lowLevelSensitivity({ ...input, classifyRuntimeSensitivity });
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
    return publicMemoryRecord(await store.addMemory({
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
    }), classifyRuntimeSensitivity);
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
    return (await store.searchMemories({
      profileId: profileIdFor(defaultProfileId, input.profileId),
      purpose: input.purpose ?? "context",
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.includeSensitive !== undefined ? { includeSensitive: input.includeSensitive } : {}),
      ...(input.includePerson !== undefined ? { includePerson: input.includePerson } : {}),
    })).map((memory) => publicMemoryRecord(memory, classifyRuntimeSensitivity));
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

    const sensitivity = classifyRuntimeSensitivity(event.content, "content");
    const eligible = event.privacyMode !== "incognito" && sensitivity !== "secret_like";
    result.eligibleForLongTermMemory = eligible;

    if (!eligible) return { ...result, skippedReason: "not_eligible_for_long_term_memory" };

    const eventMetadata = sourceMetadataForEvent(event, classifyRuntimeSensitivity);
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
      temporalParser: options.temporal?.parser,
      inferTemporalFromText: options.temporal?.inferFromText,
      extractionInput: {
        profileId,
        event: { ...event, metadata: eventMetadata },
        evidence,
      },
      minConfidence: options.extraction?.minConfidence,
    });
    result.extraction = sanitizeRuntimeExtractionReport(
      extraction.report,
      classifyRuntimeSensitivity,
    );
    for (const candidate of extraction.candidates) {
      const candidateSourceMetadata = sourceMetadataForCandidate(
        eventMetadata,
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
      const memory = await store.addMemory({
        profileId,
        kind: writeCandidate.kind,
        content: writeCandidate.content,
        confidence: writeCandidate.confidence,
        sensitivity: memorySensitivityForCandidate({
          eventSensitivity: sensitivity,
          candidateContentSensitivity: candidateSensitivity,
          candidateMetadataSensitivity,
          candidateStructuredSensitivity,
        }),
        sourceEventId: evidence.id,
        metadata: {
          ...sanitizeRuntimeExternalMemoryMetadata(
            candidate.metadata,
            classifyRuntimeSensitivity,
          ),
          ...structuredMetadata,
          sourceRole: event.role,
          ...(Object.keys(candidateSourceMetadata).length > 0 ? { sourceMetadata: candidateSourceMetadata } : {}),
          ...(memoryEntityMentions.length > 0 ? { entityMentions: memoryEntityMentions } : {}),
        },
        createdAt: event.createdAt,
      });
      result.memoryIds.push(memory.id);
      if (writeCandidate.predicate && subject) {
        const subjectAliases = worldBeliefSubjectAliasesForCandidate({
          candidate: writeCandidate,
          subject,
          eventMetadata: candidateSourceMetadata,
          classifyRuntimeSensitivity,
        });
        const beliefEntityMentions = buildEntityMentions({
          subject,
          predicate: writeCandidate.predicate,
          subjectAliases,
          sourceMetadata: candidateSourceMetadata,
          entityResolver: options.entityResolver,
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
            ...sanitizeRuntimeExternalMemoryMetadata(
              writeCandidate.metadata,
              classifyRuntimeSensitivity,
            ),
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
    return evidence.map((event) =>
      sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity)
    );
  }

  async function prepareTurn(input: PrepareTurnInput) {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, input.profileId);
    const displayQuery = prepareTurnDisplayQuery(input);
    const query = prepareTurnQuery(input, classifyRuntimeSensitivity);
    const privateRouteSignals = privateTaskRouteSignals(
      input,
      displayQuery,
      classifyRuntimeSensitivity,
    );
    const hideTaskRetrievalHints = displayQuery !== query || privateRouteSignals.length > 0;
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
      for (const policy of actionPolicies) {
        if (policy.sourceMemoryId) await appendEvidenceForMemory(policy.sourceMemoryId);
      }
    }
    const prepared = composeTurnContext({
      profileId,
      memories: hideTaskRetrievalHints
        ? memories.map((memory) => hideRouteMemoryMetadata(memory, privateRouteSignals))
        : memories,
      actionPolicies: hideTaskRetrievalHints
        ? actionPolicies.map((policy) => hideRouteActionPolicy(policy, privateRouteSignals))
        : actionPolicies,
      evidence,
      includeEvidence: input.includeEvidence,
      contextBudgetTokens: input.contextBudgetTokens,
    });
    const reconstruction =
      input.reconstruction?.mode === "shadow"
        ? await reconstructMemoryContext({
            store,
            defaultProfileId,
            cueExtractor: options.reconstruction?.cueExtractor,
            inferTemporalCuesFromText: options.reconstruction?.inferTemporalCuesFromText,
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
              stopWhenEvidenceEnough: input.reconstruction.stopWhenEvidenceEnough,
              evidenceConvergenceThreshold: input.reconstruction.evidenceConvergenceThreshold,
              includeTemporalMetadata: input.reconstruction.includeTemporalMetadata,
              temporalMode: input.reconstruction.temporalMode,
              recallPurpose: input.reconstruction.recallPurpose,
              reconstructionIntent: sanitizedReconstructionIntent(
                input.reconstruction.reconstructionIntent,
                classifyRuntimeSensitivity,
              ),
              privateRouteSignals,
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
      cueExtractor: options.reconstruction?.cueExtractor,
      inferTemporalCuesFromText: options.reconstruction?.inferTemporalCuesFromText,
      sanitizeEvidenceForOutput: (event) =>
        sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity),
      request: sanitizedReconstructRequest(input, classifyRuntimeSensitivity),
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
      cueExtractor: options.reconstruction?.cueExtractor,
      inferTemporalCuesFromText: options.reconstruction?.inferTemporalCuesFromText,
      sanitizeEvidenceForOutput: (event) =>
        sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity),
      request: sanitizedReconstructRequest({
        ...input,
        includeEvidence: input.includeEvidence ?? true,
      }, classifyRuntimeSensitivity),
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
      failureKind: input.failureKind,
      createdAt: input.createdAt,
    }, classifyRuntimeSensitivity);
    if (taskOutcomeResult === "recorded" && input.status === "failed") {
      await recordRuntimeFailure(store, {
        profileId,
        failureKind: input.failureKind ?? "task_failure",
        content: input.summary ?? input.objective,
        createdAt: input.createdAt,
        additionalSurfaces: ["task_trajectory"],
      }, classifyRuntimeSensitivity);
    }
  }

  async function recordFeedback(input: FeedbackInput): Promise<void> {
    await initialize();
    await recordRuntimeFailure(store, {
      profileId: profileIdFor(defaultProfileId, input.profileId),
      failureKind: input.failureKind ?? "wrong_recall",
      content: input.content,
      createdAt: input.createdAt,
    }, classifyRuntimeSensitivity);
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

  async function explain(id: string, profileIdInput?: string): Promise<ExplainResult | null> {
    await initialize();
    const profileId = profileIdFor(defaultProfileId, profileIdInput);
    const memory = await store.getMemoryById(profileId, id, {
      includeSensitive: true,
      includePerson: true,
    });
    if (!memory) return null;
    const evidence = (await store.listEvidenceForMemory(memory.id)).map(
      (event) => sanitizeRuntimeEvidenceForPublicOutput(event, classifyRuntimeSensitivity),
    );
    return {
      id: memory.id,
      kind: "memory",
      memoryKind: safePublicLabel(memory.kind) as MemoryRecord["kind"],
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
