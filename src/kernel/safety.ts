import { createHash } from "node:crypto";

import {
  GMOS_EVIDENCE_PAYLOAD_SCHEMAS,
  gmosEvidencePayloadSchemaOf,
  gmosEvidenceReferenceShapeOf,
} from "./evidence-schema.js";
import {
  GMOS_METADATA_REFERENCE_MARKER,
  GMOS_METADATA_REFERENCE_SCHEMAS,
  GMOS_METADATA_REFERENCE_SHAPES,
  hasGmosMetadataReferenceSchema,
} from "./metadata-schema.js";
import type {
  EvidenceEvent,
  MemoryRecord,
  MemoryVersionSnapshot,
  PrivacyMode,
  Sensitivity,
} from "./types.js";

const SECRET_PATTERNS = [
  /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}(?=$|[^A-Za-z0-9])/u,
  /\b(api[\s_.-]?key|token|password|secret)\b\s*["']?\s*[:=]\s*["']?\S{8,}/iu,
  /\b(password|secret)\b\s*(?:is|are|was|were|equals?|called)\s+\S{4,}/iu,
  /\b(api[\s_.-]?key|token)\b\s*(?:is|are|was|were|equals?|called)\s+(?:[A-Za-z0-9._~+/=@!#$%^&*?%-]{16,}|(?=[A-Za-z0-9._~+/=@!#$%^&*?%-]*\d)[A-Za-z0-9._~+/=@!#$%^&*?%-]{8,})/iu,
  /\b(access[\s_.-]?token|refresh[\s_.-]?token|id[\s_.-]?token|client[\s_.-]?secret|auth(?:entication)?(?:[\s_.-]?token)?|authorization|cookies?|credentials?(?:[\s_.-]?id)?|session(?:[\s_.-]?(?:id|token))?)\b\s*["']?\s*[:=]\s*["']?\S{8,}/iu,
  /\b(access[\s_.-]?token|refresh[\s_.-]?token|id[\s_.-]?token|client[\s_.-]?secret|auth(?:entication)?(?:[\s_.-]?token)?|authorization|cookies?|credentials?(?:[\s_.-]?id)?|session(?:[\s_.-]?(?:id|token))?)\b\s*(?:is|are|was|were|equals?|called)\s+(?:[A-Za-z0-9._~+/=@!#$%^&*?%-]{16,}|(?=[A-Za-z0-9._~+/=@!#$%^&*?%-]*\d)[A-Za-z0-9._~+/=@!#$%^&*?%-]{8,})/iu,
  /(?:密码|密钥|秘钥|secret)\s*(?:是|为|叫|等于)\s*\S{4,}/iu,
  /(?:api\s*key|token|令牌)\s*(?:是|为|叫|等于)\s*(?:[A-Za-z0-9._~+/=@!#$%^&*?%-]{16,}|(?=[A-Za-z0-9._~+/=@!#$%^&*?%-]*\d)[A-Za-z0-9._~+/=@!#$%^&*?%-]{8,})/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/iu,
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
];

const SENSITIVE_PATTERNS = [
  /\bssn\b|\bsocial security\b/iu,
  /\b\d{3}-\d{2}-\d{4}\b/u,
  /\b(?:therapy|therapist|counseling|mental health|psychiatry|depression|anxiety|ptsd|support group|lgbtq|transgender|nonbinary|gender identity|sexual orientation)\b/iu,
  /身份证|护照|银行卡|信用卡/u,
  /心理|咨询|治疗|抑郁|焦虑|创伤|支持小组|跨性别|性取向|性别认同/u,
];

const SENSITIVE_METADATA_KEYS =
  /(^|[\s_.-])(api[\s_.-]?key|access[\s_.-]?token|refresh[\s_.-]?token|token|password|secret|authorization|authentication|auth(?:entication)?(?:[\s_.-]?token)?|cookie|credential(?:[\s_.-]?id)?|session(?:[\s_.-]?id)?|ssn|social[\s_.-]?security)($|[\s_.-])/iu;
const IDENTITY_CREDENTIAL_LABEL =
  /(^|[-_.:/\s])(api[-_.\s]*key|access[-_.\s]*token|refresh[-_.\s]*token|token|password|secret|auth(?:entication)?|credential)(?=$|[-_.:/\s])/iu;

const REDACTED_METADATA = "[redacted_sensitive_metadata]";
const GMOS_OWNED_METADATA_KEYS = [
  GMOS_METADATA_REFERENCE_MARKER,
  "actionPolicyKind",
  "annealing",
  "archive",
  "clusterKey",
  "consolidatedInto",
  "consolidationSummary",
  "dossier",
  "dossierFor",
  "dossierInputKey",
  "dossierKind",
  "dossierSource",
  "entityMentions",
  "episodeKey",
  "entityResolution",
  "eventAction",
  "eventRecord",
  "eventRecordKey",
  "eventState",
  "eventType",
  "hostContentHash",
  "hostImportKey",
  "hostImportSourceType",
  "hostMemoryId",
  "hostMemoryKind",
  "hostSnapshotImport",
  "hostSourceUpdatedAt",
  "importKey",
  "importSource",
  "importSourceOriginalId",
  "lowLevelApi",
  "lowLevelUpdatedAt",
  "instanceRecord",
  "instance_id",
  "instance_kind",
  "state",
  "canonical_attributes",
  "aliases",
  "citations",
  "observedAt",
  "occurredAt",
  "procedureDistillation",
  "relatedMemoryIds",
  "restore",
  "sessionDistillation",
  "sessionDistillationEvidenceId",
  "sessionDistillationEvidenceIds",
  "sessionDistillationKey",
  "sessionEvidenceCount",
  "sessionEvidenceIds",
  "sourceBeliefIds",
  "sourceEvidenceId",
  "sourceEvidenceIds",
  "sourceFileHash",
  "sourceIndex",
  "sourceMemoryIds",
  "sourceMetadata",
  "sourceRole",
  "sourceTrajectoryIds",
  "sourceTrust",
  "supersededBy",
  "subjectAliases",
  "turnEvidenceId",
  "turnMemory",
  "turnOrdinal",
  "turnOrdinals",
  "episodeKeys",
  "usedMemoryIds",
  "windowEvidenceIds",
  "worldBeliefObject",
  "worldBeliefPredicate",
  "worldBeliefSubject",
] as const;
const CREDENTIAL_KEY_PATTERN =
  "api[\\s_.-]?key|access[\\s_.-]?token|refresh[\\s_.-]?token|id[\\s_.-]?token|client[\\s_.-]?secret|token|password|secret|auth(?:entication)?(?:[\\s_.-]?token)?|authorization|cookies?|credentials?(?:[\\s_.-]?id)?|session(?:[\\s_.-]?(?:id|token))?";
const DOUBLE_QUOTED_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_KEY_PATTERN})\\b(\\s*["']?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`,
  "giu",
);
const SINGLE_QUOTED_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_KEY_PATTERN})\\b(\\s*["']?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`,
  "giu",
);
const UNQUOTED_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_KEY_PATTERN})\\b(\\s*["']?\\s*[:=]\\s*)(?!["'])(\\S{8,})`,
  "giu",
);

export function classifySensitivity(content: string): Sensitivity {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    return "secret_like";
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    return "sensitive";
  }
  return "normal";
}

export function isSecretLikeMemoryContent(content: string): boolean {
  return classifySensitivity(content) === "secret_like";
}

export function eligibleForLongTermMemory(input: {
  content: string;
  privacyMode?: PrivacyMode | undefined;
}): boolean {
  if (input.privacyMode === "incognito") return false;
  return !isSecretLikeMemoryContent(input.content);
}

export function isPersonRoutedMemory(content: string): boolean {
  return /^\s*PERSON\s*:/iu.test(content);
}

export function shouldHideFromOrdinaryContext(input: {
  sensitivity: Sensitivity;
  includeSensitive?: boolean | undefined;
}): boolean {
  if (input.sensitivity === "secret_like") return true;
  if (input.sensitivity === "sensitive" && !input.includeSensitive) return true;
  return false;
}

export function safePublicLabel(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(value) ? value : "other";
}

export function safePublicInlineField(value: string): string {
  const redacted = redactForReport(value).replace(/\s+/gu, " ").trim();
  if (!redacted || /[\u0000-\u001F\u007F;[\]]/u.test(redacted)) return "other";
  return redacted.length <= 128 ? redacted : `${redacted.slice(0, 125)}...`;
}

export function safePublicSensitivity(value: unknown): Sensitivity {
  return value === "normal" || value === "sensitive" || value === "secret_like" ? value : "sensitive";
}

export function redactForReport(content: string): string {
  const redacted = content
    .replace(/(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}(?=$|[^A-Za-z0-9])/gu, "$1[redacted_secret]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "Bearer [redacted_secret]")
    .replace(
      /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
      "[redacted_secret]",
    )
    .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, "[redacted_sensitive]")
    .replace(DOUBLE_QUOTED_CREDENTIAL_ASSIGNMENT_PATTERN, '$1$2"[redacted_secret]"')
    .replace(SINGLE_QUOTED_CREDENTIAL_ASSIGNMENT_PATTERN, "$1$2'[redacted_secret]'")
    .replace(UNQUOTED_CREDENTIAL_ASSIGNMENT_PATTERN, "$1$2[redacted_secret]");
  if (redacted !== content) return redacted;
  const sensitivity = classifySensitivity(content);
  if (sensitivity === "secret_like") return "[redacted_secret]";
  if (sensitivity === "sensitive") return "[redacted_sensitive]";
  return content;
}

export function sanitizePublicPayload(value: unknown): unknown {
  return sanitizePayloadValue(value, undefined, new WeakSet()).value;
}

export function sanitizePublicPayloadRecord(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizePublicPayload(input);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return {};
  return sanitized as Record<string, unknown>;
}

export function stripGmosOwnedMetadataFields(metadata: Record<string, unknown>): Record<string, unknown> {
  const output = { ...metadata };
  for (const key of GMOS_OWNED_METADATA_KEYS) delete output[key];
  return output;
}

const PUBLIC_SOURCE_METADATA_KEYS = new Set([
  "speaker",
  "speakerKind",
  "speakerId",
  "speakerAliases",
  "participants",
  "sessionId",
  "sessionKey",
  "sourceId",
  "sourceUri",
  "sourceTrust",
]);

const PUBLIC_SOURCE_STRING_METADATA_KEYS = new Set([
  "speaker",
  "speakerKind",
  "speakerId",
  "sessionId",
  "sessionKey",
  "sourceId",
  "sourceUri",
  "sourceTrust",
]);

const PUBLIC_SOURCE_STRING_ARRAY_METADATA_KEYS = new Set([
  "speakerAliases",
  "participants",
]);

export function sanitizePublicSourceMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!PUBLIC_SOURCE_METADATA_KEYS.has(key)) continue;
    if (PUBLIC_SOURCE_STRING_METADATA_KEYS.has(key)) {
      const sanitized = sanitizePublicPayload(value);
      if (typeof sanitized === "string" && sanitized.trim().length > 0) output[key] = sanitized;
      continue;
    }
    if (PUBLIC_SOURCE_STRING_ARRAY_METADATA_KEYS.has(key)) {
      if (!Array.isArray(value)) continue;
      const values = value
        .map((entry) => (typeof entry === "string" ? sanitizePublicPayload(entry) : null))
        .filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
        );
      if (values.length > 0) output[key] = values;
    }
  }
  return output;
}

export function sourceMetadataSpeakerIsPerson(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const kind = typeof metadata?.speakerKind === "string" ? metadata.speakerKind.trim().toLowerCase() : "";
  return kind === "person" || kind === "human";
}

export function payloadContainsRestrictedValue(value: unknown): boolean {
  return classifyPayloadSensitivity(value) !== "normal";
}

export function classifyPayloadSensitivity(value: unknown): Sensitivity {
  return classifyPayloadValue(value, undefined, new WeakSet());
}

function classifyEvidenceValues(values: unknown[]): Sensitivity {
  return values.reduce<Sensitivity>(
    (sensitivity, value) =>
      maxSensitivity(sensitivity, classifyPayloadSensitivity(value)),
    "normal",
  );
}

function identityValueSensitivity(value: unknown): Sensitivity {
  if (value === undefined || value === null) return "normal";
  if (typeof value !== "string") return classifyPayloadSensitivity(value);
  if (IDENTITY_CREDENTIAL_LABEL.test(value)) return "secret_like";
  return classifySensitivity(value);
}

function identityFieldSensitivity(
  key: string,
  value: unknown,
  strictIdentityKeys: boolean,
): Sensitivity {
  if (value === undefined) return "normal";
  const valueSensitivity = identityValueSensitivity(value);
  return strictIdentityKeys
    ? maxSensitivity(classifyMetadataKeySensitivity(key), valueSensitivity)
    : valueSensitivity;
}

function internalReferenceSensitivity(value: unknown): Sensitivity {
  if (value === undefined || value === null) return "normal";
  if (typeof value !== "string") return classifyPayloadSensitivity(value);
  const redacted = redactForReport(value);
  if (redacted !== value) return classifySensitivity(value);
  return IDENTITY_CREDENTIAL_LABEL.test(value) ? "secret_like" : "normal";
}

function evidenceIdentityHash(kind: string, values: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["gmos.evidence_identity.v2", kind, ...values]), "utf8")
    .digest("hex");
}

export function conversationMessageEvidenceEventKey(input: {
  profileId: string;
  conversationId?: string | null | undefined;
  messageId: string;
  createdAt: string;
}): string {
  return `conversation.message:v2:${evidenceIdentityHash("conversation.message", [
    input.profileId,
    input.conversationId ?? null,
    input.messageId,
    input.createdAt,
  ])}`;
}

export function sessionDistillationEvidenceEventKey(input: {
  profileId: string;
  eventTime: string;
  evidenceIds: readonly string[];
  sessionId?: string | null | undefined;
  conversationId?: string | null | undefined;
}): string {
  return `conversation.session_distillation:v3:${evidenceIdentityHash(
    "conversation.session_distillation",
    [
      input.profileId,
      input.sessionId ?? null,
      input.conversationId ?? null,
      input.eventTime,
      input.evidenceIds,
    ],
  )}`;
}

interface CanonicalEvidenceIdentity {
  kind: "conversation.message" | "conversation.session_distillation";
  sensitivity: Sensitivity;
}

function canonicalConversationEvidenceKind(
  event: EvidenceEvent,
): CanonicalEvidenceIdentity["kind"] | null {
  const payload = event.payload;
  const conversationMetadata = payload.metadata;
  const isConversationMessage =
    event.sourceType === "conversation.message" &&
    ["system", "user", "assistant", "tool"].includes(String(payload.role)) &&
    (payload.privacyMode === "normal" || payload.privacyMode === "incognito") &&
    ["user", "agent", "external"].includes(String(payload.sourceTrust)) &&
    (conversationMetadata === undefined ||
      (!!conversationMetadata && typeof conversationMetadata === "object" &&
        !Array.isArray(conversationMetadata)));
  if (isConversationMessage && typeof payload.messageId === "string") {
    return "conversation.message";
  }
  const isSessionDistillation =
    event.sourceType === "conversation.session_distillation" &&
    payload.purpose === "session_distillation" &&
    payload.eventTime === event.createdAt &&
    Array.isArray(payload.evidenceIds) && payload.evidenceIds.every((id) => typeof id === "string") &&
    (payload.sessionId === undefined || typeof payload.sessionId === "string") &&
    (payload.conversationId === undefined || typeof payload.conversationId === "string");
  return isSessionDistillation ? "conversation.session_distillation" : null;
}

function publicConversationEvidenceKind(
  event: EvidenceEvent,
): CanonicalEvidenceIdentity["kind"] | null {
  if (
    event.sourceType.startsWith("conversation.session_distillation") ||
    event.eventKey.startsWith("conversation.session_distillation:")
  ) {
    return "conversation.session_distillation";
  }
  if (
    event.sourceType.startsWith("conversation.") ||
    event.eventKey.startsWith("conversation.message:") ||
    event.sourceUri?.startsWith("conversation:")
  ) {
    return "conversation.message";
  }
  return null;
}

function conversationIdForEvidence(event: EvidenceEvent): string | null {
  return event.sourceUri?.startsWith("conversation:")
    ? event.sourceUri.slice("conversation:".length)
    : null;
}

export function canonicalEvidenceEventKeyForProfile(
  event: EvidenceEvent,
  profileId: string,
): string | null {
  const kind = canonicalConversationEvidenceKind(event);
  if (kind === "conversation.message") {
    return conversationMessageEvidenceEventKey({
      profileId,
      conversationId: conversationIdForEvidence(event),
      messageId: String(event.payload.messageId),
      createdAt: event.createdAt,
    });
  }
  if (kind === "conversation.session_distillation") {
    return sessionDistillationEvidenceEventKey({
      profileId,
      eventTime: String(event.payload.eventTime),
      evidenceIds: event.payload.evidenceIds as string[],
      sessionId: typeof event.payload.sessionId === "string" ? event.payload.sessionId : null,
      conversationId: typeof event.payload.conversationId === "string"
        ? event.payload.conversationId
        : null,
    });
  }
  return null;
}

function legacyCanonicalEvidenceEventKey(event: EvidenceEvent): string | null {
  const kind = canonicalConversationEvidenceKind(event);
  if (kind === "conversation.message") {
    return [
      "conversation.message",
      event.profileId,
      conversationIdForEvidence(event) ?? "conversation",
      event.payload.messageId,
      event.createdAt,
    ].join(":");
  }
  if (kind !== "conversation.session_distillation") return null;
  const payload = event.payload;
  const sessionIdentity = typeof payload.sessionId === "string" && payload.sessionId.length > 0
    ? payload.sessionId
    : typeof payload.conversationId === "string" && payload.conversationId.length > 0
      ? payload.conversationId
      : "conversation";
  const prefix = `conversation.session_distillation:${event.profileId}:${sessionIdentity}:`;
  const suffix = event.eventKey.startsWith(prefix) ? event.eventKey.slice(prefix.length) : "";
  return /^[a-f0-9]{24}$/u.test(suffix) ? `${prefix}${suffix}` : null;
}

function canonicalEvidenceIdentity(
  event: EvidenceEvent,
  strictIdentityKeys: boolean,
): CanonicalEvidenceIdentity | null {
  const kind = canonicalConversationEvidenceKind(event);
  if (!kind) return null;
  const canonicalKey = canonicalEvidenceEventKeyForProfile(event, event.profileId);
  const legacyKey = legacyCanonicalEvidenceEventKey(event);
  const legacyDefaultProfileKey = kind === "conversation.message"
    ? [
        "conversation.message",
        "default",
        conversationIdForEvidence(event) ?? "conversation",
        event.payload.messageId,
        event.createdAt,
      ].join(":")
    : null;
  if (
    event.eventKey !== canonicalKey && event.eventKey !== legacyKey &&
    event.eventKey !== legacyDefaultProfileKey
  ) {
    return null;
  }
  const identityFields = kind === "conversation.message"
    ? [
        ["profileId", event.profileId],
        ["conversationId", conversationIdForEvidence(event)],
        ["messageId", event.payload.messageId],
      ]
    : [
        ["profileId", event.profileId],
        ["sourceUri", event.sourceUri],
        ["sessionId", event.payload.sessionId],
        ["conversationId", event.payload.conversationId],
        ["evidenceIds", event.payload.evidenceIds],
      ];
  return {
    kind,
    sensitivity: identityFields.reduce<Sensitivity>(
      (sensitivity, [key, value]) =>
        maxSensitivity(
          sensitivity,
          identityFieldSensitivity(String(key), value, strictIdentityKeys),
        ),
      "normal",
    ),
  };
}

export interface CanonicalReaderConversationSource {
  role: "user" | "assistant";
  sourceTrust: "user" | "agent";
}

/**
 * Resolve reader authority from the raw event identity. Callers must do this
 * before public sanitization redacts the canonical conversation key.
 */
export function canonicalReaderConversationSource(
  event: EvidenceEvent,
): CanonicalReaderConversationSource | null {
  if (
    canonicalEvidenceIdentity(event, false)?.kind !== "conversation.message" ||
    gmosEvidencePayloadSchemaOf(event.payload) !==
      GMOS_EVIDENCE_PAYLOAD_SCHEMAS.conversationMessage ||
    !event.eligibleForLongTermMemory ||
    event.payload.privacyMode !== "normal"
  ) {
    return null;
  }
  if (event.payload.role === "user" && event.payload.sourceTrust === "user") {
    return { role: "user", sourceTrust: "user" };
  }
  if (event.payload.role === "assistant" && event.payload.sourceTrust === "agent") {
    return { role: "assistant", sourceTrust: "agent" };
  }
  return null;
}

const MEMORY_VERSION_SNAPSHOT_KINDS: ReadonlySet<string> = new Set([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "person",
  "task_trajectory",
]);
const MEMORY_VERSION_SNAPSHOT_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "dormant",
  "archived",
]);

function isMemoryVersionSnapshot(value: unknown): value is MemoryVersionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.memoryId === "string" &&
    typeof snapshot.profileId === "string" &&
    typeof snapshot.kind === "string" && MEMORY_VERSION_SNAPSHOT_KINDS.has(snapshot.kind) &&
    typeof snapshot.scope === "string" &&
    typeof snapshot.content === "string" &&
    (snapshot.sensitivity === "normal" || snapshot.sensitivity === "sensitive" ||
      snapshot.sensitivity === "secret_like") &&
    typeof snapshot.status === "string" && MEMORY_VERSION_SNAPSHOT_STATUSES.has(snapshot.status) &&
    typeof snapshot.confidence === "number" && Number.isFinite(snapshot.confidence) &&
    typeof snapshot.recallCount === "number" && Number.isFinite(snapshot.recallCount) &&
    (snapshot.lastRecalledAt === undefined || snapshot.lastRecalledAt === null ||
      typeof snapshot.lastRecalledAt === "string") &&
    typeof snapshot.reinforcement === "number" && Number.isFinite(snapshot.reinforcement) &&
    (snapshot.sourceEventId === undefined || snapshot.sourceEventId === null ||
      typeof snapshot.sourceEventId === "string") &&
    !!snapshot.metadata && typeof snapshot.metadata === "object" && !Array.isArray(snapshot.metadata) &&
    typeof snapshot.createdAt === "string" &&
    typeof snapshot.updatedAt === "string"
  );
}

function memoryVersionSnapshotSensitivity(
  value: unknown,
  strictIdentityKeys: boolean,
): Sensitivity | null {
  if (!isMemoryVersionSnapshot(value)) return null;
  const snapshot = value as MemoryVersionSnapshot & Record<string, unknown>;
  const knownSensitivity = classifyMemoryLikeSensitivity({
    id: snapshot.memoryId,
    profileId: snapshot.profileId,
    kind: snapshot.kind,
    scope: snapshot.scope,
    content: snapshot.content,
    sensitivity: snapshot.sensitivity,
    sourceEventId: snapshot.sourceEventId,
    metadata: snapshot.metadata,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }, strictIdentityKeys);
  const {
    memoryId: _memoryId,
    profileId: _profileId,
    kind: _kind,
    scope: _scope,
    content: _content,
    sensitivity: _sensitivity,
    status,
    confidence,
    recallCount,
    lastRecalledAt,
    reinforcement,
    sourceEventId: _sourceEventId,
    metadata: _metadata,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...unclassifiedFields
  } = snapshot;
  return maxSensitivity(
    maxSensitivity(
      knownSensitivity,
      classifyEvidenceValues([status, confidence, recallCount, lastRecalledAt, reinforcement]),
    ),
    classifyPayloadSensitivity(unclassifiedFields),
  );
}

function classifyStructuredMemorySnapshots(
  input: Record<string, unknown>,
  strictIdentityKeys: boolean,
): {
  payload: Record<string, unknown>;
  sensitivity: Sensitivity;
} {
  const payload = { ...input };
  let sensitivity: Sensitivity = "normal";
  const snapshotArrays = gmosEvidenceReferenceShapeOf(input)?.snapshotArrays ?? [];
  for (const key of snapshotArrays) {
    if (!Array.isArray(input[key])) continue;
    const unstructured: unknown[] = [];
    for (const value of input[key]) {
      const snapshotSensitivity = memoryVersionSnapshotSensitivity(value, strictIdentityKeys);
      if (snapshotSensitivity === null) unstructured.push(value);
      else sensitivity = maxSensitivity(sensitivity, snapshotSensitivity);
    }
    if (unstructured.length > 0) payload[key] = unstructured;
    else delete payload[key];
  }
  return { payload, sensitivity };
}

export function classifyEvidenceSensitivity(
  event: EvidenceEvent,
  options: { strictIdentityKeys?: boolean | undefined } = {},
): Sensitivity {
  const strictIdentityKeys = options.strictIdentityKeys === true;
  const canonicalIdentity = canonicalEvidenceIdentity(event, strictIdentityKeys);
  let identitySensitivity = canonicalIdentity?.sensitivity ?? classifySensitivity(event.eventKey);
  let classifiedPayload = event.payload;
  if (canonicalIdentity?.kind === "conversation.message") {
    const metadata = event.payload.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const { sessionId, sessionKey, ...remainingMetadata } = metadata as Record<string, unknown>;
      const { messageId: _messageId, ...remainingPayload } = event.payload;
      classifiedPayload = { ...remainingPayload, metadata: remainingMetadata };
      identitySensitivity = [["sessionId", sessionId], ["sessionKey", sessionKey]].reduce<Sensitivity>(
        (sensitivity, [key, value]) => value === undefined
          ? sensitivity
          : maxSensitivity(
              sensitivity,
              identityFieldSensitivity(String(key), value, strictIdentityKeys),
            ),
        identitySensitivity,
      );
    }
  } else if (canonicalIdentity?.kind === "conversation.session_distillation") {
    const {
      sessionId: _sessionId,
      conversationId: _conversationId,
      evidenceIds: _evidenceIds,
      ...remainingPayload
    } = event.payload;
    classifiedPayload = remainingPayload;
  }
  const structuredSnapshots = classifyStructuredMemorySnapshots(
    classifiedPayload,
    strictIdentityKeys,
  );
  classifiedPayload = structuredSnapshots.payload;
  const declaredSensitivity = event.sensitivity === "normal" || event.sensitivity === "sensitive" ||
      event.sensitivity === "secret_like"
    ? event.sensitivity
    : "secret_like";
  const fieldSensitivity = classifyEvidenceValues(
    canonicalIdentity
      ? [event.sensitivity, event.id, event.content, event.createdAt]
      : [
          event.sensitivity, event.id, event.profileId, event.eventKey,
          event.sourceUri, event.content, event.createdAt,
        ],
  );
  const sensitivities: Sensitivity[] = [
    declaredSensitivity,
    event.payload.privacyMode === "incognito" ? "secret_like" : "normal",
    fieldSensitivity,
    classifySensitivity(event.sourceType),
    identitySensitivity,
    structuredSnapshots.sensitivity,
    classifyPayloadSensitivity(classifiedPayload),
  ];
  return sensitivities.reduce(maxSensitivity, "normal");
}

interface MemorySensitivityFields {
  id: string;
  profileId: string;
  kind: string;
  scope: string;
  content: string;
  sensitivity: unknown;
  sourceEventId?: string | null | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function classifyMemoryLikeSensitivity(
  memory: MemorySensitivityFields,
  strictIdentityKeys = false,
): Sensitivity {
  const declaredSensitivity = memory.sensitivity === "normal" || memory.sensitivity === "sensitive" ||
      memory.sensitivity === "secret_like"
    ? memory.sensitivity
    : "secret_like";
  let sessionSensitivity: Sensitivity = "normal";
  let metadata = memory.metadata;
  const referenceValues: unknown[] = [memory.id, memory.sourceEventId];
  let referenceFieldSensitivity: Sensitivity = "normal";
  const addReferenceValue = (
    key: string,
    value: unknown,
    includeKeySensitivity = true,
  ): void => {
    referenceValues.push(value);
    if (strictIdentityKeys && includeKeySensitivity && value !== undefined) {
      referenceFieldSensitivity = maxSensitivity(
        referenceFieldSensitivity,
        classifyMetadataKeySensitivity(key),
      );
    }
  };
  if (
    hasGmosMetadataReferenceSchema(
      metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    const sourceMetadata = metadata.sourceMetadata;
    if (sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata)) {
      const { sessionId, sessionKey, ...remainingSourceMetadata } =
        sourceMetadata as Record<string, unknown>;
      for (const [key, value] of [["sessionId", sessionId], ["sessionKey", sessionKey]] as const) {
        if (value === undefined) continue;
        sessionSensitivity = maxSensitivity(
          sessionSensitivity,
          identityFieldSensitivity(key, value, strictIdentityKeys),
        );
      }
      metadata = { ...metadata, sourceMetadata: remainingSourceMetadata };
    }
    const sessionDistillationIsScalar = typeof metadata.sessionDistillation === "boolean";
    const sessionEvidenceCountIsValid =
      typeof metadata.sessionEvidenceCount === "number" &&
      Number.isInteger(metadata.sessionEvidenceCount) &&
      metadata.sessionEvidenceCount >= 0;
    addReferenceValue("sessionDistillation", metadata.sessionDistillation, false);
    addReferenceValue("sessionEvidenceCount", metadata.sessionEvidenceCount, false);
    if (sessionDistillationIsScalar || sessionEvidenceCountIsValid) {
      const scalarSessionMetadata = { ...metadata };
      if (sessionDistillationIsScalar) delete scalarSessionMetadata.sessionDistillation;
      if (sessionEvidenceCountIsValid) delete scalarSessionMetadata.sessionEvidenceCount;
      metadata = scalarSessionMetadata;
    }
    const {
      sourceEvidenceId,
      turnEvidenceId,
      windowEvidenceIds,
      sessionDistillationKey,
      sessionDistillationEvidenceId,
      sessionDistillationEvidenceIds,
      sessionEvidenceIds,
      sourceEvidenceIds,
      ...metadataWithoutEvidenceReferences
    } = metadata;
    addReferenceValue("sourceEvidenceId", sourceEvidenceId);
    addReferenceValue("turnEvidenceId", turnEvidenceId);
    addReferenceValue("windowEvidenceIds", windowEvidenceIds);
    addReferenceValue("sessionDistillationKey", sessionDistillationKey);
    addReferenceValue("sessionDistillationEvidenceId", sessionDistillationEvidenceId);
    addReferenceValue("sessionDistillationEvidenceIds", sessionDistillationEvidenceIds);
    addReferenceValue("sessionEvidenceIds", sessionEvidenceIds);
    addReferenceValue("sourceEvidenceIds", sourceEvidenceIds);
    metadata = metadataWithoutEvidenceReferences;
    if (
      metadata.annealing && typeof metadata.annealing === "object" &&
      !Array.isArray(metadata.annealing)
    ) {
      const { sourceEventId, ...annealing } = metadata.annealing as Record<string, unknown>;
      addReferenceValue("sourceEventId", sourceEventId);
      metadata = { ...metadata, annealing };
    }
  }
  const referenceSensitivity = referenceValues.reduce<Sensitivity>(
    (sensitivity, value) => maxSensitivity(sensitivity, internalReferenceSensitivity(value)),
    referenceFieldSensitivity,
  );
  const sensitivities: Sensitivity[] = [
    declaredSensitivity,
    classifyEvidenceValues([
      memory.sensitivity, memory.profileId, memory.kind, memory.scope,
      memory.content, memory.createdAt, memory.updatedAt,
    ]),
    classifyPayloadSensitivity(metadata),
    sessionSensitivity,
    referenceSensitivity,
  ];
  return sensitivities.reduce(maxSensitivity, "normal");
}

export function classifyMemorySensitivity(
  memory: MemoryRecord,
  options: { strictIdentityKeys?: boolean | undefined } = {},
): Sensitivity {
  return classifyMemoryLikeSensitivity(memory, options.strictIdentityKeys === true);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function memoryEvidenceReferenceIds(
  memory: Pick<MemoryRecord, "sourceEventId" | "metadata">,
): string[] {
  const metadata = memory.metadata;
  const ids = memory.sourceEventId ? [memory.sourceEventId] : [];
  if (
    !hasGmosMetadataReferenceSchema(
      metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    return ids;
  }
  const shape = GMOS_METADATA_REFERENCE_SHAPES[GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage];
  for (const key of shape.evidenceIdFields ?? []) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) ids.push(value);
  }
  for (const key of shape.evidenceIdArrays ?? []) {
    for (const id of stringArray(metadata[key])) ids.push(id);
  }
  return [...new Set(ids)];
}

function publicEvidenceEventKey(
  event: EvidenceEvent,
  kind: CanonicalEvidenceIdentity["kind"],
): string {
  const suffix = evidenceIdentityHash("public", [event.id, event.eventKey]).slice(0, 24);
  return `${kind}:[redacted_identity]:${suffix}`;
}

export function sanitizeEvidenceForPublicOutput(evidence: EvidenceEvent): EvidenceEvent {
  const conversationKind = publicConversationEvidenceKind(evidence);
  const payload = sanitizePublicPayloadRecord(evidence.payload);
  const sensitivity = classifyEvidenceSensitivity(evidence);
  const validDeclaredSensitivity = evidence.sensitivity === "normal" ||
    evidence.sensitivity === "sensitive" || evidence.sensitivity === "secret_like";
  if (!validDeclaredSensitivity) {
    return {
      ...evidence,
      id: "[redacted_secret]",
      eventKey: "[redacted_secret]",
      profileId: "[redacted_secret]",
      sourceType: "other",
      sourceUri: null,
      content: "[redacted_secret]",
      sensitivity: "secret_like",
      eligibleForLongTermMemory: false,
      payload: {},
      createdAt: redactForReport(evidence.createdAt),
    };
  }
  const redactedContent = redactForReport(evidence.content);
  if (conversationKind === "conversation.message") delete payload.messageId;
  if (conversationKind === "conversation.session_distillation") {
    delete payload.conversationId;
    delete payload.sessionId;
    const evidenceCount = Array.isArray(payload.evidenceIds)
      ? payload.evidenceIds.length
      : typeof payload.evidenceCount === "number"
        ? payload.evidenceCount
        : undefined;
    delete payload.evidenceIds;
    if (evidenceCount !== undefined) payload.evidenceCount = evidenceCount;
  }
  return {
    ...evidence,
    id: redactForReport(evidence.id),
    eventKey: conversationKind
      ? publicEvidenceEventKey(evidence, conversationKind)
      : redactForReport(evidence.eventKey),
    profileId: redactForReport(evidence.profileId),
    sourceType: safePublicLabel(evidence.sourceType),
    sensitivity,
    sourceUri: conversationKind
      ? "conversation:[redacted_identity]"
      : evidence.sourceUri == null ? evidence.sourceUri : redactForReport(evidence.sourceUri),
    content: evidence.payload.privacyMode === "incognito"
      ? "[redacted_secret]"
      : redactedContent !== evidence.content
        ? redactedContent
        : evidence.sensitivity === "secret_like" ? "[redacted_secret]" : evidence.content,
    payload: evidence.payload.privacyMode === "incognito" ? {} : payload,
  };
}

function sanitizePayloadValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): { value: unknown; redacted: boolean; omit?: boolean } {
  if (key !== undefined && classifyMetadataKeySensitivity(key) !== "normal") {
    return { value: REDACTED_METADATA, redacted: true, omit: true };
  }
  if (typeof value === "string") {
    const redacted = redactForReport(value);
    if (redacted !== value) return { value: redacted, redacted: true };
    if (classifySensitivity(value) !== "normal") {
      return { value: REDACTED_METADATA, redacted: true };
    }
    return { value, redacted: false };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { value, redacted: false };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const output = value.map((entry) => {
      const result = sanitizePayloadValue(entry, undefined, seen);
      redacted ||= result.redacted;
      return result.omit ? REDACTED_METADATA : result.value;
    });
    return { value: output, redacted };
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return { value: "[redacted_circular]", redacted: true };
    seen.add(value);
    let redacted = false;
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const result = sanitizePayloadValue(entryValue, entryKey, seen);
      redacted ||= result.redacted;
      if (result.omit) continue;
      output[entryKey] = result.value;
    }
    seen.delete(value);
    return { value: output, redacted };
  }
  return { value: REDACTED_METADATA, redacted: true };
}

function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  if (left === "secret_like" || right === "secret_like") return "secret_like";
  if (left === "sensitive" || right === "sensitive") return "sensitive";
  return "normal";
}

function normalizeMetadataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .toLowerCase();
}

function classifyMetadataKeySensitivity(key: string): Sensitivity {
  if (SENSITIVE_METADATA_KEYS.test(key)) return /ssn|social/iu.test(key) ? "sensitive" : "secret_like";
  const normalized = normalizeMetadataKey(key);
  if (!normalized) return "normal";
  if (/(^|\s)(ssn|social\s+security)($|\s)/iu.test(normalized)) return "sensitive";
  if (
    /(^|\s)(api\s*key|access\s*token|refresh\s*token|id\s*token|auth(?:entication)?(?:\s*token)?|authorization|cookies?|credentials?(?:\s*id)?|session(?:\s*(?:id|token))?|client\s*secret|password|secret|token)($|\s)/iu.test(
      normalized,
    )
  ) {
    return "secret_like";
  }
  return "normal";
}

function classifyPayloadValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): Sensitivity {
  let sensitivity = key === undefined ? "normal" : classifyMetadataKeySensitivity(key);
  if (sensitivity === "secret_like") return sensitivity;
  if (typeof value === "string") return maxSensitivity(sensitivity, classifySensitivity(value));
  if (value === null || typeof value === "number" || typeof value === "boolean") return sensitivity;
  if (Array.isArray(value)) {
    for (const entry of value) {
      sensitivity = maxSensitivity(sensitivity, classifyPayloadValue(entry, undefined, seen));
      if (sensitivity === "secret_like") return sensitivity;
    }
    return sensitivity;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return maxSensitivity(sensitivity, "sensitive");
    seen.add(value);
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      sensitivity = maxSensitivity(sensitivity, classifyPayloadValue(entryValue, entryKey, seen));
      if (sensitivity === "secret_like") break;
    }
    seen.delete(value);
    return sensitivity;
  }
  return "sensitive";
}
