import type {
  MemoryExtractionAcceptanceClass,
  MemoryExtractionCandidate,
  MemoryExtractionCandidateSnapshot,
  MemoryExtractionDecision,
  MemoryExtractionFallbackReason,
  MemoryExtractionInput,
  MemoryExtractionReport,
  MemoryExtractionRejectClass,
  MemoryExtractionRejectReason,
  MemoryExtractionResult,
  MemoryExtractor,
  RuleExtractionMode,
} from "./types.js";
import { isReservedSpeakerIdentity, stableNamedPersonSubject } from "./person-identity.js";
import {
  classifySensitivity,
  isPersonRoutedMemory,
  redactForReport,
  sanitizePublicPayloadRecord,
  stripGmosOwnedMetadataFields,
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

export interface RuleMemoryExtractionOptions {
  mode?: RuleExtractionMode | undefined;
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

function normalize(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

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

function sanitizeCandidateReportMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return stripGmosOwnedMetadataFields(sanitizePublicPayloadRecord(metadata));
}

function subjectKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/_+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function explicitPersonSubject(input: string | undefined): boolean {
  return typeof input === "string" && /^person\s*[:/]\s*.+$/iu.test(input.trim());
}

function explicitUserSubject(input: string | undefined): boolean {
  return typeof input === "string" && subjectKey(input) === "user";
}

function normalizedSubjectAliases(candidate: MemoryExtractionCandidate): string[] | undefined {
  const rawAliases = normalizedStringArray(
    (candidate as { subjectAliases?: unknown }).subjectAliases,
  )?.filter((alias) => !isReservedSpeakerIdentity(alias));
  if (!rawAliases || rawAliases.length === 0) return undefined;
  const subject = typeof candidate.subject === "string" ? normalize(candidate.subject) : undefined;
  if (explicitUserSubject(subject)) return undefined;
  const predicate = typeof candidate.predicate === "string" ? candidate.predicate.trim().toLowerCase() : "";
  const aliasesNamePerson =
    explicitPersonSubject(subject) || (Boolean(subject) && predicate.startsWith("person."));
  const aliases = aliasesNamePerson
    ? rawAliases.filter((alias) => stableNamedPersonSubject(alias))
    : rawAliases;
  return uniqueStrings(aliases);
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
      ? sanitizeCandidateReportMetadata(record.metadata as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof record.kind === "string" ? { kind: publicString(record.kind) } : {}),
    content: publicString(content),
    ...(Number.isFinite(confidence) ? { confidence } : {}),
    ...(typeof record.predicate === "string" ? { predicate: publicString(record.predicate) } : {}),
    ...(typeof record.subject === "string" ? { subject: publicString(record.subject) } : {}),
    ...(subjectAliases ? { subjectAliases } : {}),
    ...(typeof record.speaker === "string" ? { speaker: publicString(record.speaker) } : {}),
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
    rejectClass: rejectClassForReason(reason),
    reason,
    candidate: snapshotCandidate(candidate),
  };
}

function acceptDecision(
  candidate: MemoryExtractionCandidate,
  acceptanceClass: MemoryExtractionAcceptanceClass,
): MemoryExtractionDecision {
  return {
    decision: "accepted",
    acceptanceClass,
    candidate: snapshotCandidate(candidate),
  };
}

function rejectClassForReason(reason: MemoryExtractionRejectReason): MemoryExtractionRejectClass {
  return reason === "secret_like" ||
    reason === "person_kind" ||
    reason === "person_routed" ||
    reason === "non_person_speaker"
    ? "hardReject"
    : "softReject";
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
    candidate.speaker,
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
  const speaker = typeof candidate.speaker === "string" ? normalize(candidate.speaker) : undefined;
  const subjectAliases = normalizedSubjectAliases(candidate);
  const candidateWithoutAliases = { ...candidate };
  delete (candidateWithoutAliases as { subjectAliases?: unknown }).subjectAliases;
  delete (candidateWithoutAliases as { object?: unknown }).object;
  delete (candidateWithoutAliases as { source?: unknown }).source;
  delete (candidateWithoutAliases as { speaker?: unknown }).speaker;
  return {
    candidate: {
      ...candidateWithoutAliases,
      content,
      confidence,
      ...(object ? { object } : {}),
      ...(source ? { source } : {}),
      ...(speaker ? { speaker } : {}),
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
    candidate.subject ?? "",
    candidate.speaker ?? "",
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

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function extractSafeRuleMemoryCandidates(
  _content: string,
  _metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate[] {
  return [];
}

export function extractRuleMemoryCandidates(
  content: string,
  metadata?: Record<string, unknown> | undefined,
  options?: RuleMemoryExtractionOptions | undefined,
): MemoryExtractionCandidate[] {
  const mode = options?.mode ?? "none";
  if (mode === "none") return [];
  return extractSafeRuleMemoryCandidates(content, metadata);
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

  const fallbackToRules = input.fallbackToRules ?? false;
  const useRules = selected === null && fallbackToRules;
  let fallbackUsed = Boolean(input.extractor && useRules);
  let fallbackReason: MemoryExtractionFallbackReason | undefined =
    fallbackUsed && extractorFailed ? "extractor_failed" : undefined;
  let extractionSource: MemoryExtractionReport["extractionSource"] =
    useRules ? "rules" : selected === null ? "none" : "custom";
  const extractor = extractorName(input.extractor);
  let rawCandidateCount = 0;
  const rejected: MemoryExtractionDecision[] = [];

  function normalizeSourceCandidates(
    source: MemoryExtractionCandidate[],
    sourceKind: MemoryExtractionReport["extractionSource"],
    acceptanceClass: MemoryExtractionAcceptanceClass,
  ): Array<{
    raw: MemoryExtractionCandidate;
    candidate: MemoryExtractionCandidate;
    acceptanceClass: MemoryExtractionAcceptanceClass;
  }> {
    const normalized: Array<{
      raw: MemoryExtractionCandidate;
      candidate: MemoryExtractionCandidate;
      acceptanceClass: MemoryExtractionAcceptanceClass;
    }> = [];
    rawCandidateCount += source.length;
    for (const rawCandidate of source) {
      const result = normalizeCandidate(rawCandidate, {
        minConfidence,
        createdAt: input.extractionInput.event.createdAt,
      });
      if ("reason" in result) {
        rejected.push(rejectDecision(rawCandidate, result.reason));
        continue;
      }
      const candidate: MemoryExtractionCandidate = {
        ...result.candidate,
        metadata: {
          ...(result.candidate.metadata ?? {}),
          extractionSource: sourceKind,
          ...(acceptanceClass === "fallbackDurableCandidate" && input.extractor
            ? { extractorFallback: true, extractorName: extractor }
            : input.extractor && sourceKind === "custom"
              ? { extractorName: extractor }
              : {}),
        },
      };
      normalized.push({ raw: rawCandidate, candidate, acceptanceClass });
    }
    return normalized;
  }

  let normalized =
    useRules
      ? normalizeSourceCandidates(ruleCandidates, "rules", fallbackUsed ? "fallbackDurableCandidate" : "structured")
      : selected === null
        ? []
        : normalizeSourceCandidates(selected, "custom", "structured");

  const shouldFallbackAfterRejectedCustomCandidates =
    Boolean(input.extractor) &&
    !useRules &&
    fallbackToRules &&
    selected !== null &&
    selected.length > 0 &&
    normalized.length === 0 &&
    ruleCandidates.length > 0 &&
    rejected.every(
      (decision) => decision.decision === "rejected" && decision.rejectClass === "softReject",
    );
  if (shouldFallbackAfterRejectedCustomCandidates) {
    fallbackUsed = true;
    fallbackReason = "custom_candidates_rejected";
    extractionSource = "rules";
    normalized = [
      ...normalized,
      ...normalizeSourceCandidates(ruleCandidates, "rules", "fallbackDurableCandidate"),
    ];
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
    decisions.push(acceptDecision(entry.candidate, entry.acceptanceClass));
  }
  decisions.push(...rejected);
  const hardRejectCount = decisions.filter(
    (decision) => decision.decision === "rejected" && decision.rejectClass === "hardReject",
  ).length;
  const softRejectCount = decisions.filter(
    (decision) => decision.decision === "rejected" && decision.rejectClass === "softReject",
  ).length;
  const fallbackDurableCandidateCount = decisions.filter(
    (decision) =>
      decision.decision === "accepted" &&
      decision.acceptanceClass === "fallbackDurableCandidate",
  ).length;

  return {
    candidates,
    report: {
      ...(extractor ? { extractorName: extractor } : {}),
      extractionSource,
      fallbackUsed,
      extractorFailed,
      ruleCandidateCount: ruleCandidates.length,
      rawCandidateCount,
      acceptedCandidateCount: candidates.length,
      rejectedCandidateCount: decisions.filter((decision) => decision.decision === "rejected").length,
      hardRejectCount,
      softRejectCount,
      fallbackDurableCandidateCount,
      ...(fallbackReason ? { fallbackReason } : {}),
      decisions,
    },
  };
}
