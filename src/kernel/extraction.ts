import type {
  MemoryExtractionCandidate,
  MemoryExtractionCandidateSnapshot,
  MemoryExtractionDecision,
  MemoryExtractionInput,
  MemoryExtractionReport,
  MemoryExtractionResult,
  MemoryExtractionRejectReason,
  MemoryExtractor,
} from "./types.js";
import {
  classifySensitivity,
  isNonSpeakerPrefix,
  isPersonRoutedMemory,
  redactForReport,
  sanitizePublicPayloadRecord,
} from "./safety.js";
import { relativeEventDateMetadata } from "./temporal-format.js";
import {
  explicitEventTimeMetadata,
  mergeExplicitTemporalValidityMetadata,
  normalizeExplicitTemporalInstant,
} from "./temporal-validity.js";

interface MemoryExtractionPlan {
  report: MemoryExtractionReport;
  candidates: MemoryExtractionCandidate[];
}

function normalize(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

const KNOWN_MEMORY_KINDS = new Set([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "person",
  "task_trajectory",
]);

function extractorName(extractor: MemoryExtractor | undefined): string | undefined {
  if (!extractor) return undefined;
  if (typeof extractor === "function") return extractor.name || undefined;
  return extractor.name;
}

function asCandidateArray(result: MemoryExtractionResult): MemoryExtractionCandidate[] | null {
  if (result === null || result === undefined) return null;
  return Array.isArray(result) ? result : [result];
}

function boundedConfidence(input: number, fallback: number): number {
  if (!Number.isFinite(input)) return fallback;
  return Math.max(0, Math.min(1, input));
}

function publicString(value: string): string {
  return redactForReport(normalize(value));
}

function normalizedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter((entry): entry is string => typeof entry === "string")
    .map(normalize)
    .filter(Boolean);
  return output.length > 0 ? output : undefined;
}

function publicStringArray(value: unknown): string[] | undefined {
  const output = normalizedStringArray(value)?.map(publicString);
  return output && output.length > 0 ? output : undefined;
}

function snapshotCandidate(candidate: unknown): MemoryExtractionCandidateSnapshot {
  const record = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : {};
  const content = typeof record.content === "string" ? normalize(record.content) : "";
  const confidence = Number(record.confidence);
  const subjectAliases = publicStringArray(record.subjectAliases);
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? sanitizePublicPayloadRecord(record.metadata as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof record.kind === "string" ? { kind: publicString(record.kind) } : {}),
    content: publicString(content),
    ...(Number.isFinite(confidence) ? { confidence } : {}),
    ...(typeof record.predicate === "string" ? { predicate: publicString(record.predicate) } : {}),
    ...(typeof record.subject === "string" ? { subject: publicString(record.subject) } : {}),
    ...(subjectAliases ? { subjectAliases } : {}),
    ...(typeof record.object === "string" ? { object: publicString(record.object) } : {}),
    ...(typeof record.source === "string" ? { source: publicString(record.source) } : {}),
    ...(typeof record.eventTime === "string" ? { eventTime: publicString(record.eventTime) } : {}),
    ...(typeof record.validFrom === "string" ? { validFrom: publicString(record.validFrom) } : {}),
    ...(typeof record.validTo === "string" ? { validTo: publicString(record.validTo) } : {}),
    ...(typeof record.cardinality === "string" ? { cardinality: publicString(record.cardinality) } : {}),
    ...(typeof record.actionPolicyKind === "string"
      ? { actionPolicyKind: publicString(record.actionPolicyKind) }
      : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function rejectDecision(
  candidate: unknown,
  reason: MemoryExtractionRejectReason,
): MemoryExtractionDecision {
  return {
    decision: "rejected",
    reason,
    candidate: snapshotCandidate(candidate),
  };
}

function allowedActionPolicyKind(
  value: MemoryExtractionCandidate["actionPolicyKind"],
): value is MemoryExtractionCandidate["actionPolicyKind"] {
  return value === undefined || value === "do_not_push" || value === "prefer" || value === "procedure";
}

function allowedCardinality(
  value: MemoryExtractionCandidate["cardinality"],
): value is MemoryExtractionCandidate["cardinality"] {
  return value === undefined || value === "single" || value === "multi";
}

function hasSecretLikeAuxiliaryField(candidate: MemoryExtractionCandidate): boolean {
  return [
    candidate.predicate,
    candidate.subject,
    ...(normalizedStringArray((candidate as { subjectAliases?: unknown }).subjectAliases) ?? []),
    candidate.object,
    candidate.source,
    candidate.eventTime,
    candidate.validFrom,
    candidate.validTo,
    candidate.cardinality,
    candidate.actionPolicyKind,
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => classifySensitivity(value) === "secret_like");
}

function structuredTemporalMetadata(candidate: MemoryExtractionCandidate): Record<string, string> {
  const entries = [
    ["eventTime", candidate.eventTime],
    ["validFrom", candidate.validFrom],
    ["validTo", candidate.validTo],
  ] as const;
  const metadata: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!value) continue;
    const normalized = normalizeExplicitTemporalInstant(value);
    if (normalized) metadata[key] = normalized;
  }
  return metadata;
}

function normalizeCandidate(
  candidate: MemoryExtractionCandidate,
  options: { minConfidence: number; createdAt?: string | undefined },
):
  | { candidate: MemoryExtractionCandidate }
  | { reason: MemoryExtractionRejectReason } {
  const content = normalize(candidate.content);
  if (!KNOWN_MEMORY_KINDS.has(String(candidate.kind))) return { reason: "invalid_kind" };
  if (!content) return { reason: "empty_content" };
  if (candidate.kind === "person") return { reason: "person_kind" };
  if (isPersonRoutedMemory(content)) return { reason: "person_routed" };
  if (classifySensitivity(content) === "secret_like") return { reason: "secret_like" };
  if (hasSecretLikeAuxiliaryField(candidate)) return { reason: "secret_like" };
  if (!allowedActionPolicyKind(candidate.actionPolicyKind)) return { reason: "invalid_kind" };
  if (!allowedCardinality(candidate.cardinality)) return { reason: "invalid_kind" };
  const confidence = boundedConfidence(candidate.confidence, 0);
  if (confidence < options.minConfidence) return { reason: "low_confidence" };
  const object = typeof candidate.object === "string" ? normalize(candidate.object) : undefined;
  const source = typeof candidate.source === "string" ? normalize(candidate.source) : undefined;
  const subjectAliases = normalizedStringArray(
    (candidate as { subjectAliases?: unknown }).subjectAliases,
  );
  const candidateWithoutAliases = { ...candidate };
  delete (candidateWithoutAliases as { subjectAliases?: unknown }).subjectAliases;
  delete (candidateWithoutAliases as { object?: unknown }).object;
  delete (candidateWithoutAliases as { source?: unknown }).source;
  return {
    candidate: {
      ...candidateWithoutAliases,
      content,
      confidence,
      ...(object ? { object } : {}),
      ...(source ? { source } : {}),
      ...(subjectAliases ? { subjectAliases } : {}),
      metadata: mergeExplicitTemporalValidityMetadata(
        content,
        {
          ...relativeEventDateMetadata(content, options.createdAt),
          ...explicitEventTimeMetadata(content),
          ...sanitizePublicPayloadRecord({
            ...(candidate.metadata ?? {}),
            ...(source ? { source } : {}),
          }),
          ...structuredTemporalMetadata(candidate),
        },
      ),
    },
  };
}

function candidateKey(candidate: MemoryExtractionCandidate): string {
  return [
    candidate.kind,
    candidate.predicate ?? "",
    candidate.content.toLowerCase(),
  ].join("\n");
}

function uniqueCandidatesWithDecisions(
  candidates: MemoryExtractionCandidate[],
): MemoryExtractionCandidate[] {
  const seen = new Set<string>();
  const result: MemoryExtractionCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function stripSpeakerPrefix(text: string): string {
  const match = speakerPrefixMatch(text);
  const prefix = match?.prefix;
  if (!prefix || !match?.rest || isNonSpeakerPrefix(prefix) || !stableNamedPersonSubject(prefix)) {
    return text;
  }
  return match.rest;
}

function speakerPrefixMatch(text: string): { prefix: string; rest: string } | null {
  const match = /^([\p{L}\p{M}' -]{2,48})\s*:\s*(.+)$/u.exec(text);
  const prefix = match?.[1]?.trim();
  const rest = match?.[2]?.trim();
  return prefix && rest ? { prefix, rest } : null;
}

function hasFirstPersonAnchor(text: string): boolean {
  return (
    /\b(I|I'm|I’m|I've|I’ve|I'd|I’d|I'll|I’ll|my|mine|we|we're|we’re|we've|we’ve|our)\b/iu.test(
      text,
    ) || /我|我们|我的|咱们/u.test(text)
  );
}

function isQuestionLike(text: string): boolean {
  const utterance = text.trim();
  return (
    /[?？]\s*$/u.test(utterance) ||
    /^(?:who|what|when|where|why|how|which|did|do|does|is|are|am|can|could|would|should|will|were|was|have|has|had)\b/iu.test(
      utterance,
    ) ||
    /(?:吗|么|是不是|是否|有没有)\s*$/u.test(utterance)
  );
}

function hasDurableTemporalSignal(text: string): boolean {
  return (
    /\b(?:today|tomorrow|yesterday|last|next|since|before|after|daily|weekly|monthly|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}|\d{1,2}:\d{2})\b/iu.test(
      text,
    ) || /\d{1,2}\s*(?:分钟|小时|天|周|月|年)/u.test(text)
  );
}

function hasPersonalWorldEventSignal(text: string): boolean {
  return (
    /\b(?:went|ran|painted|planning|planned|researching|chose|started|finished|graduated|studying|working|commute|relationship|single|married|identity|transgender|counseling|therapy|mental health|adoption|career|family|kids|children|job|work|school|education|birthday|appointment|meeting|trip|travel|camping|race|support group)\b/iu.test(
      text,
    ) || /上学|工作|通勤|家庭|孩子|关系|单身|结婚|身份|心理|咨询|收养|旅行|露营|比赛|支持小组/u.test(text)
  );
}

function hasNamedPersonEventSignal(text: string): boolean {
  return /\b(?:went|ran|painted|chose|started|finished|graduated|studying|commute|appointment|meeting|trip|travel|camping|race)\b/iu.test(
    text,
  );
}

function likelyDurableObservationFact(text: string): boolean {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return false;
  if (!hasFirstPersonAnchor(utterance)) return false;
  return hasDurableTemporalSignal(utterance) || hasPersonalWorldEventSignal(utterance);
}

function firstPersonAttributeCandidate(text: string): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  if (/^\s*I\s+use\s+.{2,80}?\s+for\s+.{2,80}/iu.test(utterance) || /^我用\s*.+\s*(?:做|处理|管理|进行)\s*.+/u.test(utterance)) {
    return {
      kind: "fact",
      content: text,
      confidence: 0.64,
      predicate: "user.tool",
      metadata: { rule: "first_person_attribute" },
    };
  }
  if (firstPersonNamedRelation(utterance)) {
    return {
      kind: "fact",
      content: text,
      confidence: 0.66,
      predicate: "user.attribute",
      metadata: { rule: "first_person_named_relation" },
    };
  }
  const liveIn = /^\s*I\s+live\s+in\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (liveIn) {
    const object = projectBeliefObject(liveIn[1]);
    if (object && !/^(?:not|unknown|none|n\/a)\b/iu.test(object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.location",
        object,
        cardinality: "single",
        metadata: { rule: "first_person_live_in" },
      };
    }
    return null;
  }
  const workAs = /^\s*I\s+work\s+as\s+(?:(?:an?|the)\s+)?(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (workAs) {
    const object = projectBeliefObject(workAs[1]);
    if (object && !/^(?:not|unknown|none|n\/a)\b/iu.test(object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.role",
        object,
        cardinality: "single",
        metadata: { rule: "first_person_work_as" },
      };
    }
    return null;
  }
  const birthplace = /^\s*I\s+was\s+born\s+in\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (birthplace) {
    const object = projectBeliefObject(birthplace[1]);
    if (object && !/^(?:not|unknown|none|n\/a)\b/iu.test(object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.birthplace",
        object,
        cardinality: "single",
        metadata: { rule: "first_person_birthplace" },
      };
    }
    return null;
  }
  const currentAttribute = /^\s*my\s+current\s+(city|location|time\s+zone|timezone|role|job|profession|title|language)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (currentAttribute) {
    const predicate = personCurrentAttributePredicate(currentAttribute[1]);
    const object = personAttributeObject(currentAttribute[1], currentAttribute[2]);
    if (predicate && object && !/^(?:not|unknown|none|n\/a)\b/iu.test(object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate,
        object,
        cardinality: "single",
        metadata: { rule: "first_person_current_attribute" },
      };
    }
    return null;
  }
  const stableAttribute = /^\s*my\s+(full\s+name|name|college\s+major|major|home\s+town|hometown|role|job|profession|title)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (stableAttribute) {
    const predicate = personCurrentAttributePredicate(stableAttribute[1]);
    const object = personAttributeObject(stableAttribute[1], stableAttribute[2]);
    if (predicate && object && !/^(?:not|unknown|none|n\/a)\b/iu.test(object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate,
        object,
        cardinality: "single",
        metadata: { rule: "first_person_structured_attribute" },
      };
    }
    return null;
  }
  const englishAttribute = /^\s*my\s+([\p{L}\p{N} _-]{2,80}?)\s+(?:is|are)\s+.{1,80}/iu.exec(
    utterance,
  );
  const chineseAttribute = /^我的\s*(.+?)\s*(?:是|为)\s*.+/u.exec(utterance);
  if (
    (englishAttribute && stableFirstPersonAttributeLabel(englishAttribute[1] ?? "")) ||
    (chineseAttribute && stableFirstPersonAttributeLabel(chineseAttribute[1] ?? ""))
  ) {
    return {
      kind: "fact",
      content: text,
      confidence: 0.64,
      predicate: "user.attribute",
      metadata: { rule: "first_person_attribute" },
    };
  }
  return null;
}

const NON_PERSON_SINGLE_NAMES = new Set([
  "amazon",
  "anthropic",
  "apple",
  "assistant",
  "azure",
  "bot",
  "chatbot",
  "chrome",
  "docker",
  "facebook",
  "figma",
  "github",
  "google",
  "jira",
  "kubernetes",
  "linear",
  "linux",
  "meta",
  "microsoft",
  "notion",
  "openai",
  "postgres",
  "redis",
  "robot",
  "slack",
  "sqlite",
  "windows",
]);

const NON_PERSON_SUBJECT_PATTERN =
  /\b(?:project|team|company|org|organization|group|support|repo|repository|service|system|app|tool|product|model|agent|inc|corp|llc|ltd|labs|research|foundation|university|school|department|committee|platform|cloud)\b/iu;

function explicitNonPersonSubject(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (NON_PERSON_SINGLE_NAMES.has(normalized)) return true;
  if (
    /^(?:project|team|company|org|organization|group|support|note|fact|example|preference|task|ticket|repo|repository|service|system|app|tool|product|model|agent|inc|corp|llc|ltd|labs|research|foundation|university|school|department|committee|platform|cloud)$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  return NON_PERSON_SUBJECT_PATTERN.test(normalized);
}

export function stableNamedPersonSubject(name: string): boolean {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return false;
  if (NON_PERSON_SINGLE_NAMES.has(normalized)) return false;
  if (!/\s/u.test(trimmed) && /\p{Ll}\p{Lu}/u.test(trimmed)) return false;
  return !explicitNonPersonSubject(normalized);
}

function entityKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/_+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function metadataPersonNames(metadata: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  if (!metadata) return names;
  for (const value of [
    metadata.speaker,
    ...(Array.isArray(metadata.participants) ? metadata.participants : []),
    ...(Array.isArray(metadata.speakerAliases) ? metadata.speakerAliases : []),
  ]) {
    if (typeof value !== "string") continue;
    if (!stableNamedPersonSubject(value)) continue;
    const key = entityKey(value);
    if (key) names.add(key);
  }
  return names;
}

function metadataSpeakerIsNonPerson(
  metadata: Record<string, unknown> | undefined,
  content: string,
): boolean {
  if (typeof metadata?.speaker !== "string") return false;
  const speaker = metadata.speaker.trim();
  if (/^(?:current[-_ ]?user|user|self|me)$/iu.test(speaker)) return false;
  if (stableNamedPersonSubject(speaker)) return false;
  if (explicitNonPersonSubject(speaker)) return true;
  const prefix = speakerPrefixMatch(content)?.prefix;
  if (prefix && entityKey(prefix) === entityKey(speaker)) return true;
  const participantKeys = Array.isArray(metadata.participants)
    ? metadata.participants
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entityKey(entry))
        .filter((entry) => entry.length > 0)
    : [];
  const speakerKey = entityKey(speaker);
  if (participantKeys.length > 0 && participantKeys.every((entry) => entry === speakerKey)) {
    return false;
  }
  return participantKeys.length > 0;
}

function contentHasExplicitNonPersonSpeaker(content: string): boolean {
  const prefix = speakerPrefixMatch(content)?.prefix;
  const normalized = prefix?.trim().toLowerCase();
  return Boolean(
    prefix &&
      explicitNonPersonSubject(prefix) &&
      (!isNonSpeakerPrefix(prefix) || (normalized ? NON_PERSON_SINGLE_NAMES.has(normalized) : false)),
  );
}

function nonPersonSpeakerCandidate(
  metadata: Record<string, unknown> | undefined,
  content: string,
): boolean {
  return metadataSpeakerIsNonPerson(metadata, content) || contentHasExplicitNonPersonSpeaker(content);
}

function metadataConfirmsNamedPerson(
  name: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadataPersonNames(metadata).has(entityKey(name));
}

function metadataConfirmsNamedEventSubject(
  name: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  const names = new Set<string>();
  for (const value of [
    ...(Array.isArray(metadata.participants) ? metadata.participants : []),
    ...(Array.isArray(metadata.speakerAliases) ? metadata.speakerAliases : []),
  ]) {
    if (typeof value !== "string" || !stableNamedPersonSubject(value)) continue;
    const key = entityKey(value);
    if (key) names.add(key);
  }
  return names.has(entityKey(name));
}

function stableToolObject(value: string | undefined): string | undefined {
  const object = projectBeliefObject(value);
  if (!object) return undefined;
  if (
    /^(?:not\s+|currently\s+)?(?:broken|unavailable|offline|down|missing|disabled|deprecated|obsolete|unsupported)\b/iu.test(
      object,
    ) ||
    /^(?:not|currently\s+not)\s+\S+/iu.test(object)
  ) {
    return undefined;
  }
  return object;
}

function namedPersonToolCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const usesMatch = new RegExp(
    String.raw`^\s*(${namePattern})\s+uses\s+(.{2,80}?)\s+for\s+.{2,80}?\s*\.?\s*$`,
    "u",
  ).exec(utterance);
  const possessiveMatch = new RegExp(
    String.raw`^\s*(${namePattern})[’']s\s+(?:preferred\s+)?(?:[\p{L}\p{N}_ -]{0,60}\s+)?tool\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$`,
    "iu",
  ).exec(utterance);
  const name = (usesMatch?.[1] ?? possessiveMatch?.[1])?.trim();
  if (!name || !stableNamedPersonSubject(name)) return null;
  if (!metadataConfirmsNamedPerson(name, metadata)) return null;
  const object = stableToolObject(usesMatch?.[2] ?? possessiveMatch?.[2]);
  if (!object) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.64,
    predicate: "person.tool",
    subject: `person:${name}`,
    subjectAliases: [name],
    ...(object ? { object } : {}),
    cardinality: "single",
    metadata: { rule: "named_person_tool" },
  };
}

function namedPersonPreferenceCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const directMatch = new RegExp(
    String.raw`^\s*(${namePattern})\s+(?:prefers?|likes?)\s+(.{1,120}?)\s*\.?\s*$`,
    "iu",
  ).exec(utterance);
  const favoriteMatch = new RegExp(
    String.raw`^\s*(${namePattern})[’']s\s+(?:favorite|preferred)\s+[\p{L}\p{N}_ -]{1,60}\s+(?:is|=)\s+(.{1,120}?)\s*\.?\s*$`,
    "iu",
  ).exec(utterance);
  const name = (directMatch?.[1] ?? favoriteMatch?.[1])?.trim();
  if (!name || !stableNamedPersonSubject(name) || !metadataConfirmsNamedPerson(name, metadata)) {
    return null;
  }
  const object = stableToolObject(directMatch?.[2] ?? favoriteMatch?.[2]);
  if (!object) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.62,
    predicate: "person.preference",
    subject: `person:${name}`,
    subjectAliases: [name],
    object,
    cardinality: "multi",
    metadata: { rule: "named_person_preference" },
  };
}

function personCurrentAttributePredicate(field: string | undefined): string | null {
  const normalized = field?.trim().toLowerCase().replace(/[-_]+/gu, " ").replace(/\s+/gu, " ");
  return normalized === "city"
    ? "person.city"
    : normalized === "location"
      ? "person.location"
      : normalized === "timezone" || normalized === "time zone"
        ? "person.timezone"
        : normalized === "role" || normalized === "job" || normalized === "profession"
          ? "person.role"
          : normalized === "title"
            ? "person.title"
            : normalized === "language"
              ? "person.language"
              : normalized === "major" || normalized === "college major"
                ? "person.major"
                : normalized === "name" || normalized === "full name"
                  ? "person.name"
                : normalized === "hometown" || normalized === "home town"
                  ? "person.hometown"
                  : null;
}

function personAttributeObject(field: string | undefined, value: string | undefined): string | undefined {
  const object = projectBeliefObject(value);
  if (!object) return undefined;
  const normalized = field?.trim().toLowerCase().replace(/[-_]+/gu, " ").replace(/\s+/gu, " ");
  return normalized === "role" || normalized === "job" || normalized === "profession" || normalized === "title"
    ? object.replace(/^(?:an?|the)\s+/iu, "").trim() || undefined
    : object;
}

function namedPersonCurrentAttributeCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const fieldPattern = String.raw`city|location|time\s+zone|timezone|role|job|profession|title|language`;
  const match = [
    new RegExp(
      String.raw`^\s*(${namePattern})\s+current\s+(${fieldPattern})\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$`,
      "iu",
    ),
    new RegExp(
      String.raw`^\s*(${namePattern})[’']s\s+current\s+(${fieldPattern})\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$`,
      "iu",
    ),
  ].map((pattern) => pattern.exec(utterance)).find((entry) => entry !== null);
  const name = match?.[1]?.trim();
  if (!name || !stableNamedPersonSubject(name) || !metadataConfirmsNamedPerson(name, metadata)) {
    return null;
  }
  const predicate = personCurrentAttributePredicate(match?.[2]);
  const object = personAttributeObject(match?.[2], match?.[3]);
  if (!predicate || !object || /^(?:not|unknown|none|n\/a)\b/iu.test(object)) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.66,
    predicate,
    subject: `person:${name}`,
    subjectAliases: [name],
    object,
    cardinality: "single",
    metadata: { rule: "named_person_current_attribute" },
  };
}

function namedPersonEventCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const match = new RegExp(String.raw`^\s*(${namePattern})\s+(.{2,180}?)\s*\.?\s*$`, "u").exec(
    utterance,
  );
  const name = match?.[1]?.trim();
  const event = projectBeliefObject(match?.[2]);
  if (!name || !event || !stableNamedPersonSubject(name) || !metadataConfirmsNamedEventSubject(name, metadata)) {
    return null;
  }
  if (/\b(?:I|I'm|I’m|I've|I’ve|my|mine|we|our)\b/iu.test(event)) return null;
  if (!hasDurableTemporalSignal(event) || !hasNamedPersonEventSignal(event)) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.54,
    predicate: "person.event",
    subject: `person:${name}`,
    subjectAliases: [name],
    object: event,
    cardinality: "multi",
    metadata: { rule: "named_person_event" },
  };
}

function firstPersonNamedRelation(text: string): boolean {
  const englishNameCore = String.raw`\p{Lu}[\p{L}0-9_-]{0,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{0,30}){0,2}`;
  const englishName = String.raw`(?:${englishNameCore}|"${englishNameCore}"|'${englishNameCore}')`;
  const chineseExplicitName = String.raw`(?:[\p{Script=Han}]{1,6}|[A-Z][A-Za-z0-9_-]{0,30})`;
  const latinName = String.raw`[A-Z][A-Za-z0-9_-]{0,30}`;
  return (
    new RegExp(
      String.raw`^\s*[Mm]y\s+(?:dog|cat|pet|daughter|son|child|kid|partner|spouse|wife|husband)(?:'s)?\s+(?:[Nn]ame\s+[Ii]s|[Ii]s\s+[Nn]amed|[Ii]s\s+[Cc]alled)\s+${englishName}\s*[.!?]?\s*$`,
      "u",
    ).test(text) ||
    new RegExp(
      String.raw`^\s*我的\s*(?:狗|猫|宠物|女儿|儿子|孩子|伴侣|配偶|妻子|丈夫)\s*(?:名叫|名字是|姓名是)\s*${chineseExplicitName}\s*[。.!?]?\s*$`,
      "u",
    ).test(text) ||
    new RegExp(
      String.raw`^\s*我的\s*(?:狗|猫|宠物|女儿|儿子|孩子|伴侣|配偶|妻子|丈夫)\s*叫\s*${latinName}\s*[。.!?]?\s*$`,
      "u",
    ).test(
      text,
    )
  );
}

function nonNameCalledRelation(text: string): boolean {
  if (firstPersonNamedRelation(text)) return false;
  return (
    /^\s*my\s+(?:dog|cat|pet|daughter|son|child|kid|partner|spouse|wife|husband)(?:'s)?\s+is\s+called\b/iu.test(
      text,
    ) ||
    /^\s*我的\s*(?:狗|猫|宠物|女儿|儿子|孩子|伴侣|配偶|妻子|丈夫)\s*叫/u.test(text)
  );
}

function stableFirstPersonAttributeLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:^|\b)(?:tool|app|application|editor|ide|browser|calendar|notebook|database|crm|field|role|job|profession|title|timezone|location|city|country|language|stack|workflow|process|major|degree|hometown|birthplace|birth place|college|university)$/iu.test(
    normalized,
  ) || /(?:工具|应用|编辑器|浏览器|日历|数据库|领域|职业|职位|时区|城市|国家|语言|技术栈|流程)$/u.test(label.trim());
}

function projectFieldPredicate(field: string | undefined): string | null {
  const normalized = field?.toLowerCase();
  return normalized === "owner" || field === "负责人"
    ? "project.owner"
    : normalized === "status" || field === "状态"
      ? "project.status"
      : normalized === "deadline" || field === "截止日期"
        ? "project.deadline"
        : normalized === "contact" || field === "联系人"
          ? "project.contact"
          : normalized === "plan" || field === "计划"
            ? "project.plan"
        : null;
}

function projectBeliefObject(value: string | undefined): string | undefined {
  const object = normalize(value ?? "").replace(/[。.!?]+$/u, "").trim();
  return object || undefined;
}

function projectCurrentStateCandidate(text: string): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  // Keep the built-in rule narrow: suffix forms like "X project current ..."
  // are too ambiguous to distinguish names from generic descriptions.
  const english = [
    /^\s*project\s+([\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?)\s+current\s+(owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+(.{1,120}?)\s*\.?\s*$/iu,
    /^\s*project\s+([\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?)\s+(owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+(.{1,120}?)\s*\.?\s*$/iu,
  ].map((pattern) => pattern.exec(utterance)).find((match) => match !== null);
  const chinese = [
    /^\s*项目\s*([\p{Script=Han}\p{L}\p{N}_ -]{1,60}?)(?:当前|现在)(负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*(.{1,120}?)\s*。?\s*$/u,
    /^\s*项目\s*([\p{Script=Han}\p{L}\p{N}_ -]{1,60}?)(负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*(.{1,120}?)\s*。?\s*$/u,
  ].map((pattern) => pattern.exec(utterance)).find((match) => match !== null);
  const project = english?.[1] ?? chinese?.[1];
  const field = english?.[2]?.toLowerCase() ?? chinese?.[2];
  const object = projectBeliefObject(english?.[3] ?? chinese?.[3]);
  if (!project || isGenericProjectReference(project)) return null;
  const predicate = projectFieldPredicate(field);
  if (!predicate) return null;
  return {
    kind: "project",
    content: text,
    confidence: 0.78,
    predicate,
    subject: `project:${project.trim()}`,
    ...(object ? { object } : {}),
    cardinality: "single",
    metadata: { rule: "project_current_state" },
  };
}

function projectStateChangeCandidate(text: string): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const english = [
    /^\s*(?:on\s+[^,]{4,40},\s*)?(?:(?:i|we|[A-Z][\p{L}\p{N}_-]{0,30})\s+)?(?:moved|changed|updated|set)\s+(?:the\s+)?project\s+([\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?)\s+(?:current\s+)?(owner|status|deadline|contact|plan)\s+(?:to|as|=)\s+(.{1,120}?)\s*\.?\s*$/iu,
    /^\s*project\s+([\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?)\s+(?:current\s+)?(owner|status|deadline|contact|plan)\s+(?:changed|moved|updated|set)\s+(?:to|as|=)\s+(.{1,120}?)\s*\.?\s*$/iu,
  ].map((pattern) => pattern.exec(utterance)).find((match) => match !== null);
  const chinese = [
    /^\s*(?:(?:我|我们)\s*)?(?:把|将)\s*项目\s*([\p{Script=Han}\p{L}\p{N}_ -]{1,60}?)(?:当前|现在)?(负责人|状态|截止日期|联系人|计划)(?:改为|改成|更新为|设为|设置为|=)\s*(.{1,120}?)\s*。?\s*$/u,
    /^\s*项目\s*([\p{Script=Han}\p{L}\p{N}_ -]{1,60}?)(?:当前|现在)?(负责人|状态|截止日期|联系人|计划)(?:改为|改成|更新为|设为|设置为|=)\s*(.{1,120}?)\s*。?\s*$/u,
  ].map((pattern) => pattern.exec(utterance)).find((match) => match !== null);
  const project = english?.[1] ?? chinese?.[1];
  const predicate = projectFieldPredicate(english?.[2] ?? chinese?.[2]);
  const object = projectBeliefObject(english?.[3] ?? chinese?.[3]);
  if (!project || !predicate || isGenericProjectReference(project)) return null;
  return {
    kind: "project",
    content: text,
    confidence: 0.78,
    predicate,
    subject: `project:${project.trim()}`,
    ...(object ? { object } : {}),
    cardinality: "single",
    metadata: { rule: "project_state_change" },
  };
}

function projectHistoricalStateCandidate(text: string): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const previousPlan = /^\s*project\s+([\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?)\s+(?:(?:previously|formerly)\s+used|used\s+to\s+use)\s+(?:the\s+)?(.{1,80}?)\s+plan\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (previousPlan?.[1] && previousPlan[2] && !isGenericProjectReference(previousPlan[1])) {
    return {
      kind: "project",
      content: text,
      confidence: 0.72,
      predicate: "project.plan",
      subject: `project:${previousPlan[1].trim()}`,
      object: projectBeliefObject(previousPlan[2]),
      cardinality: "single",
      metadata: { rule: "project_historical_plan" },
    };
  }
  const english = /^\s*project\s+([\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?)\s+(?:(?:previous|previously|prior|old|former)\s+)?(owner|status|deadline|contact|plan)\s+was\s+(.{1,120}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  const chinese = /^\s*项目\s*([\p{Script=Han}\p{L}\p{N}_ -]{1,60}?)(负责人|状态|截止日期|联系人|计划)曾经是\s*(.{1,120}?)\s*。?\s*$/u.exec(
    utterance,
  );
  const project = english?.[1] ?? chinese?.[1];
  const predicate = projectFieldPredicate(english?.[2] ?? chinese?.[2]);
  const object = projectBeliefObject(english?.[3] ?? chinese?.[3]);
  if (!project || !predicate || !object || isGenericProjectReference(project)) return null;
  return {
    kind: "project",
    content: text,
    confidence: 0.72,
    predicate,
    subject: `project:${project.trim()}`,
    object,
    cardinality: "single",
    metadata: { rule: "project_historical_state" },
  };
}

function isGenericProjectReference(project: string): boolean {
  const trimmed = project.trim();
  const normalized = trimmed.toLowerCase();
  return (
    /^(?:the|this|that|our|my|your|his|her|its|their|we|us|it|a|an|some|another|any|each|every|one|new|current|existing|other|old|next|previous|prior|same)$/iu.test(
      normalized,
    ) ||
    /^(?:a|an|some|another|any|each|every|one)(?:\s+(?:new|current|existing|other|old|next|previous|prior|same))*$/iu.test(
      normalized,
    ) ||
    /^(?:这个|那个|我|我的|我们|我们的|你|你的|你们|你们的|您|您的|他|他的|他们|他们的|她|她的|她们|她们的|它|它的|它们|它们的|其|该|此|一个|某个|某|某些|一些|任一|任何|新|当前|已有|其他|旧|下个|上个|同一个)$/u.test(
      trimmed,
    ) ||
    /^(?:一个|某个|某|某些|一些|任一|任何)(?:新|当前|已有|其他|旧|下个|上个|同一个)?$/u.test(
      trimmed,
    )
  );
}

function unnamedProjectCurrentState(text: string): boolean {
  const utterance = stripSpeakerPrefix(text);
  return (
    /^\s*(?:moved|changed|updated|set)\s+(?:the\s+)?project\s+(?:(?:the|this|that|our|my|your|his|her|its|their|a|an|some|another|any|each|every|one|new|current|existing|other|old|next|previous|prior|same)\s+)?(?:current\s+)?(?:owner|status|deadline|contact|plan)\s+(?:to|as|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*(?:(?:the|this|that|our|my|your|his|her|its|their|a|an|some|another|any|each|every|one)(?:\s+(?:new|current|existing|other|old|next|previous|prior|same))*|new|current|existing|other|old|next|previous|prior|same)\s+project\s+(?:current\s+)?(?:owner|status|deadline|contact|plan)\s+(?:changed|moved|updated|set)\s+(?:to|as|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?\s+project\s+(?:current\s+)?(?:owner|status|deadline|contact|plan)\s+(?:changed|moved|updated|set)\s+(?:to|as|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*project\s+(?:current\s+)?(?:owner|status|deadline|contact|plan)\s+(?:changed|moved|updated|set)\s+(?:to|as|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*project\s+(?:the|this|that|our|my|your|his|her|its|their|a|an|some|another|any|each|every|one|new|current|existing|other|old|next|previous|prior|same)\s+(?:current\s+)?(?:owner|status|deadline|contact|plan)\s+(?:changed|moved|updated|set)\s+(?:to|as|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*(?:(?:the|this|that|our|my|your|his|her|its|their|a|an|some|another|any|each|every|one)(?:\s+(?:new|current|existing|other|old|next|previous|prior|same))*|new|current|existing|other|old|next|previous|prior|same)\s+project\s+current\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?\s+project\s+current\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*project\s+current\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*project\s+[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?\s+current\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*project\s+[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*(?:(?:the|this|that|our|my|your|his|her|its|their|a|an|some|another|any|each|every|one)(?:\s+(?:new|current|existing|other|old|next|previous|prior|same))*|new|current|existing|other|old|next|previous|prior|same)\s+project\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^(?!\s*(?:my|our|mine|ours)\s)\s*[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?\s+project\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*project\s+(?:owner|status|deadline|contact|plan)\s+(?:is|are|=)\s+.{1,120}/iu.test(
      utterance,
    ) ||
    /^\s*(?:这个|那个|我|我的|我们|我们的|你|你的|你们|你们的|您|您的|他|他的|他们|他们的|她|她的|她们|她们的|它|它的|它们|它们的|其|该|此|一个|某个|某|某些|一些|任一|任何|新|当前|已有|其他|旧|下个|上个|同一个)(?:新|当前|已有|其他|旧|下个|上个|同一个)?\s*项目(?:当前|现在)(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?\s*项目(?:当前|现在)(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*项目(?:当前|现在)(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*项目\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?(?:当前|现在)(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*项目\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*(?:这个|那个|我|我的|我们|我们的|你|你的|你们|你们的|您|您的|他|他的|他们|他们的|她|她的|她们|她们的|它|它的|它们|它们的|其|该|此|一个|某个|某|某些|一些|任一|任何|新|当前|已有|其他|旧|下个|上个|同一个)(?:新|当前|已有|其他|旧|下个|上个|同一个)?\s*项目(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^(?!\s*(?:我的|我们|我们的|咱们)\s*)\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?\s*项目(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*项目(?:负责人|状态|截止日期|联系人|计划)(?:是|为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*(?:这个|那个|我|我的|我们|我们的|你|你的|你们|你们的|您|您的|他|他的|他们|他们的|她|她的|她们|她们的|它|它的|它们|它们的|其|该|此|一个|某个|某|某些|一些|任一|任何|新|当前|已有|其他|旧|下个|上个|同一个)(?:新|当前|已有|其他|旧|下个|上个|同一个)?\s*项目(?:当前|现在)?(?:负责人|状态|截止日期|联系人|计划)(?:改为|改成|更新为|设为|设置为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?\s*项目(?:当前|现在)?(?:负责人|状态|截止日期|联系人|计划)(?:改为|改成|更新为|设为|设置为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*项目(?:当前|现在)?(?:负责人|状态|截止日期|联系人|计划)(?:改为|改成|更新为|设为|设置为|=)\s*.{1,120}/u.test(
      utterance,
    ) ||
    /^\s*项目\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?(?:当前|现在)?(?:负责人|状态|截止日期|联系人|计划)(?:改为|改成|更新为|设为|设置为|=)\s*.{1,120}/u.test(
      utterance,
    )
  );
}

function incompleteProjectFieldFragment(text: string): boolean {
  const utterance = stripSpeakerPrefix(text);
  return (
    /^\s*project\s+[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?\s+(?:owner|status|deadline|contact|plan)\s+(?:changed|moved|updated|set)\s*\.?\s*$/iu.test(
      utterance,
    ) ||
    /^\s*project(?:\s+[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?)?\s+(?:owner|status|deadline|contact|plan)(?:\s+(?:until|before|after|since))?\s*\.?\s*$/iu.test(
      utterance,
    ) ||
    /^\s*[\p{L}\p{N}_-][\p{L}\p{N}_ -]{0,80}?\s+project\s+(?:owner|status|deadline|contact|plan)(?:\s+(?:until|before|after|since))?\s*\.?\s*$/iu.test(
      utterance,
    ) ||
    /^\s*项目(?:\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?)?(?:负责人|状态|截止日期|联系人|计划)\s*。?\s*$/u.test(
      utterance,
    ) ||
    /^\s*[\p{Script=Han}\p{L}\p{N}_ -]{1,60}?\s*项目(?:负责人|状态|截止日期|联系人|计划)\s*。?\s*$/u.test(
      utterance,
    )
  );
}

export function extractRuleMemoryCandidates(
  content: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate[] {
  const text = normalize(content);
  if (!text || isPersonRoutedMemory(text)) return [];
  const nonPersonSpeaker =
    metadataSpeakerIsNonPerson(metadata, text) || contentHasExplicitNonPersonSpeaker(text);
  if (nonPersonSpeaker) return [];

  if (
    /不要再提醒|别再提醒|不要主动提|不要再推|do not remind|don't remind|do not push|don't push/iu.test(
      text,
    )
  ) {
    return [
      {
        kind: "boundary",
        content: text,
        confidence: 0.95,
        predicate: "boundary.do_not_push",
        actionPolicyKind: "do_not_push",
      },
    ];
  }

  if (isQuestionLike(stripSpeakerPrefix(text))) return [];

  const preferenceUtterance = stripSpeakerPrefix(text);
  if (
    /我喜欢|我最喜欢|我偏好|我更喜欢/u.test(preferenceUtterance) ||
    /\b(?:I prefer|I like|my favorite|my preference is)\b/iu.test(preferenceUtterance)
  ) {
    return [
      {
        kind: "preference",
        content: text,
        confidence: 0.82,
        predicate: "user.preference",
        actionPolicyKind: "prefer",
      },
    ];
  }

  const attributeCandidate = firstPersonAttributeCandidate(text);
  if (attributeCandidate) return [attributeCandidate];
  if (/^\s*my\s+(?:current\s+)?(?:role|job|profession|title)\s+(?:is|=)\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*I\s+work\s+as\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*I\s+live\s+in\s+(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*my\s+(?:full\s+)?name\s+(?:is|=)\s+(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*I\s+was\s+born\s+in\s+(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (nonNameCalledRelation(stripSpeakerPrefix(text))) return [];
  const personToolCandidate = namedPersonToolCandidate(text, metadata);
  if (personToolCandidate) return [personToolCandidate];
  const personPreferenceCandidate = namedPersonPreferenceCandidate(text, metadata);
  if (personPreferenceCandidate) return [personPreferenceCandidate];
  const personCurrentAttributeCandidate = namedPersonCurrentAttributeCandidate(text, metadata);
  if (personCurrentAttributeCandidate) return [personCurrentAttributeCandidate];
  const personEventCandidate = namedPersonEventCandidate(text, metadata);
  if (personEventCandidate) return [personEventCandidate];

  if (/步骤|流程|procedure|workflow|when .* do|每次.*先/u.test(text)) {
    return [
      {
        kind: "procedure",
        content: text,
        confidence: 0.74,
        predicate: "user.procedure",
        actionPolicyKind: "procedure",
      },
    ];
  }

  const projectStateCandidate = projectCurrentStateCandidate(text);
  if (projectStateCandidate) return [projectStateCandidate];
  const projectChangeCandidate = projectStateChangeCandidate(text);
  if (projectChangeCandidate) return [projectChangeCandidate];
  const projectHistoricalState = projectHistoricalStateCandidate(text);
  if (projectHistoricalState) return [projectHistoricalState];
  if (unnamedProjectCurrentState(text)) return [];
  if (incompleteProjectFieldFragment(text)) return [];

  if (/项目|project|repo|仓库|deadline|里程碑/iu.test(text)) {
    return [
      {
        kind: "project",
        content: text,
        confidence: 0.68,
        predicate: "project.state",
      },
    ];
  }

  if (/^我(是|在|有)|我的|my name is|I am|I work|I live|I was born/iu.test(text)) {
    return [
      {
        kind: "fact",
        content: text,
        confidence: 0.7,
        predicate: "user.fact",
      },
    ];
  }

  if (likelyDurableObservationFact(text)) {
    return [
      {
        kind: "fact",
        content: text,
        confidence: 0.52,
        predicate: "user.fact",
        metadata: {
          rule: "durable_observation_fact",
        },
      },
    ];
  }

  return [];
}

export function extractMemoryCandidate(content: string): MemoryExtractionCandidate | null {
  return extractRuleMemoryCandidates(content)[0] ?? null;
}

export async function extractMemoryCandidates(input: {
  extractor?: MemoryExtractor | undefined;
  extractionInput: MemoryExtractionInput;
  fallbackToRules?: boolean | undefined;
  minConfidence?: number | undefined;
}): Promise<MemoryExtractionCandidate[]> {
  return (await extractMemoryCandidatePlan(input)).candidates;
}

export async function extractMemoryCandidateReport(input: {
  extractor?: MemoryExtractor | undefined;
  extractionInput: MemoryExtractionInput;
  fallbackToRules?: boolean | undefined;
  minConfidence?: number | undefined;
}): Promise<MemoryExtractionReport> {
  return (await extractMemoryCandidatePlan(input)).report;
}

export async function extractMemoryCandidatePlan(input: {
  extractor?: MemoryExtractor | undefined;
  extractionInput: MemoryExtractionInput;
  fallbackToRules?: boolean | undefined;
  minConfidence?: number | undefined;
}): Promise<MemoryExtractionPlan> {
  const minConfidence = input.minConfidence ?? 0.01;
  const ruleCandidates = input.extractionInput.ruleCandidates;
  let selected: MemoryExtractionCandidate[] | null = null;
  let extractorFailed = false;

  if (input.extractor) {
    try {
      const raw =
        typeof input.extractor === "function"
          ? await input.extractor(input.extractionInput)
          : await input.extractor.extract(input.extractionInput);
      selected = asCandidateArray(raw);
    } catch {
      extractorFailed = true;
      selected = null;
    }
  }

  const fallbackToRules = input.fallbackToRules ?? true;
  const useRules = selected === null && fallbackToRules;
  const fallbackUsed = Boolean(input.extractor && useRules);
  const extractionSource: MemoryExtractionReport["extractionSource"] =
    useRules ? "rules" : selected === null ? "none" : "custom";
  const source = useRules ? ruleCandidates : (selected ?? []);
  const extractor = extractorName(input.extractor);
  const normalized: Array<{
    raw: MemoryExtractionCandidate;
    candidate: MemoryExtractionCandidate;
  }> = [];
  const rejected: MemoryExtractionDecision[] = [];
  for (const rawCandidate of source) {
    const result = normalizeCandidate(rawCandidate, {
      minConfidence,
      createdAt: input.extractionInput.event.createdAt,
    });
    if ("reason" in result) {
      rejected.push(rejectDecision(rawCandidate, result.reason));
      continue;
    }
    if (
      nonPersonSpeakerCandidate(
        input.extractionInput.event.metadata,
        input.extractionInput.event.content,
      )
    ) {
      rejected.push(rejectDecision(rawCandidate, "non_person_speaker"));
      continue;
    }
    const candidate: MemoryExtractionCandidate = {
      ...result.candidate,
      metadata: {
        ...(result.candidate.metadata ?? {}),
        extractionSource,
        ...(fallbackUsed && input.extractor
          ? { extractorFallback: true, extractorName: extractor }
          : input.extractor && selected !== null
            ? { extractorName: extractor }
            : {}),
      },
    };
    normalized.push({ raw: rawCandidate, candidate });
  }

  const deduped = uniqueCandidatesWithDecisions(normalized.map((entry) => entry.candidate));
  const acceptedKeys = new Set(deduped.map(candidateKey));
  const decisions: MemoryExtractionDecision[] = [];
  const candidates: MemoryExtractionCandidate[] = [];
  for (const entry of normalized) {
    const key = candidateKey(entry.candidate);
    if (!acceptedKeys.has(key)) {
      decisions.push(rejectDecision(entry.raw, "duplicate"));
      continue;
    }
    acceptedKeys.delete(key);
    candidates.push(entry.candidate);
    decisions.push({
      decision: "accepted",
      candidate: snapshotCandidate(entry.candidate),
    });
  }
  decisions.push(...rejected);

  return {
    candidates,
    report: {
      ...(extractor ? { extractorName: extractor } : {}),
      extractionSource,
      fallbackUsed,
      extractorFailed,
      ruleCandidateCount: ruleCandidates.length,
      rawCandidateCount: source.length,
      acceptedCandidateCount: candidates.length,
      rejectedCandidateCount: decisions.filter((decision) => decision.decision === "rejected").length,
      decisions,
    },
  };
}
