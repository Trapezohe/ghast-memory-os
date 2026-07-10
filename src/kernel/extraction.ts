import type {
  MemoryExtractionCandidate,
  MemoryExtractionCandidateSnapshot,
  MemoryExtractionDecision,
  MemoryExtractionInput,
  MemoryExtractionOutcome,
  MemoryExtractionReport,
  MemoryExtractionRejectClass,
  MemoryExtractionRejectReason,
  MemoryExtractionResult,
  MemoryExtractor,
  MemoryTemporalMetadata,
  MemoryTemporalParser,
} from "./types.js";
import {
  openAICompatibleOutcomeForError,
  openAICompatibleRetryCount,
} from "./openai-compatible-response.js";
import { isReservedSpeakerIdentity, stableNamedPersonSubject } from "./person-identity.js";
import {
  classifySensitivity,
  isPersonRoutedMemory,
  redactForReport,
  sanitizePublicPayloadRecord,
  stripGmosOwnedMetadataFields,
} from "./safety.js";
import {
  explicitEventTimeMetadata,
  mergeExplicitTemporalValidityMetadata,
  normalizeExplicitTemporalInstant,
} from "./temporal-validity.js";

interface MemoryExtractionPlan {
  report: MemoryExtractionReport;
  candidates: MemoryExtractionCandidate[];
}

const MAX_STRUCTURED_TABLE_CANDIDATES = 64;

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

function markdownTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index]!;
    if (character === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(normalize(cell.replace(/[*_`]+/gu, "")));
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(normalize(cell.replace(/[*_`]+/gu, "")));
  return cells;
}

function markdownTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function tableTitleBefore(lines: string[], tableStart: number): string {
  for (let index = tableStart - 1; index >= Math.max(0, tableStart - 6); index -= 1) {
    const title = normalize(lines[index] ?? "").replace(/:$/u, "");
    if (title && !title.startsWith("|")) return title;
  }
  return "Structured table";
}

function sentence(content: string): string {
  return /[.!?。！？]$/u.test(content) ? content : `${content}.`;
}

/**
 * Preserves exact row/column relationships that lossy LLM extraction commonly
 * drops from schedules, matrices, comparison grids, and other Markdown tables.
 */
export function extractStructuredTableMemoryCandidates(
  messages: ReadonlyArray<{ role: string; content: string }>,
): MemoryExtractionCandidate[] {
  const candidates: MemoryExtractionCandidate[] = [];
  for (const [sourceIndex, message] of messages.entries()) {
    const lines = message.content.split(/\r?\n/u);
    for (let index = 0; index + 2 < lines.length; index += 1) {
      const header = markdownTableCells(lines[index] ?? "");
      const separator = markdownTableCells(lines[index + 1] ?? "");
      if (
        !header || !separator || header.length < 2 ||
        separator.length !== header.length || !markdownTableSeparator(separator)
      ) {
        continue;
      }
      const title = tableTitleBefore(lines, index);
      const firstHeaderIsRowLabel = header[0] === "";
      let rowIndex = index + 2;
      for (; rowIndex < lines.length; rowIndex += 1) {
        const row = markdownTableCells(lines[rowIndex] ?? "");
        if (!row || row.length !== header.length) break;
        if (firstHeaderIsRowLabel) {
          const rowLabel = row[0] ?? "";
          if (!rowLabel) continue;
          for (let columnIndex = 1; columnIndex < header.length; columnIndex += 1) {
            const column = header[columnIndex] ?? "";
            const value = row[columnIndex] ?? "";
            if (!column || !value) continue;
            candidates.push({
              kind: "fact",
              content: sentence(`${title}: ${rowLabel} — ${column}: ${value}`),
              confidence: 0.9,
              sourceIndex,
              metadata: {
                structuredArtifact: "markdown_table",
                tableTitle: title,
                tableRow: rowLabel,
                tableColumn: column,
              },
            });
            if (candidates.length >= MAX_STRUCTURED_TABLE_CANDIDATES) return candidates;
          }
        } else {
          const fields = header.flatMap((column, columnIndex) => {
            const value = row[columnIndex] ?? "";
            return column && value ? [`${column} = ${value}`] : [];
          });
          if (fields.length === 0) continue;
          candidates.push({
            kind: "fact",
            content: sentence(`${title}: ${fields.join("; ")}`),
            confidence: 0.9,
            sourceIndex,
            metadata: {
              structuredArtifact: "markdown_table",
              tableTitle: title,
            },
          });
          if (candidates.length >= MAX_STRUCTURED_TABLE_CANDIDATES) return candidates;
        }
      }
      index = Math.max(index + 1, rowIndex - 1);
    }
  }
  return candidates;
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
    ...(Number.isInteger(record.sourceIndex) && Number(record.sourceIndex) >= 0
      ? { sourceIndex: Number(record.sourceIndex) }
      : {}),
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
): MemoryExtractionDecision {
  return {
    decision: "accepted",
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

function normalizedTemporalMetadata(metadata: MemoryTemporalMetadata | null | undefined): Record<string, string> {
  const entries = [
    ["eventTime", metadata?.eventTime],
    ["validFrom", metadata?.validFrom],
    ["validTo", metadata?.validTo],
  ] as const;
  const normalizedMetadata: Record<string, string> = {};
  if (typeof metadata?.eventDate === "string" && classifySensitivity(metadata.eventDate) !== "secret_like") {
    const normalizedEventDate = normalizeExplicitTemporalInstant(metadata.eventDate);
    if (normalizedEventDate) normalizedMetadata.eventDate = normalizedEventDate.slice(0, 10);
  }
  for (const [key, value] of entries) {
    if (typeof value !== "string" || classifySensitivity(value) === "secret_like") continue;
    const normalized = normalizeExplicitTemporalInstant(value);
    if (normalized) normalizedMetadata[key] = normalized;
  }
  return normalizedMetadata;
}

async function parsedTemporalMetadata(input: {
  parser?: MemoryTemporalParser | undefined;
  content: string;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}): Promise<Record<string, string>> {
  if (!input.parser) return {};
  try {
    const parsed =
      typeof input.parser === "function"
        ? await input.parser({
            content: input.content,
            metadata: input.metadata,
            createdAt: input.createdAt,
          })
        : await input.parser.parse({
            content: input.content,
            metadata: input.metadata,
            createdAt: input.createdAt,
          });
    return normalizedTemporalMetadata(parsed);
  } catch {
    return {};
  }
}

function temporalParserInputForCandidate(
  candidate: MemoryExtractionCandidate,
  options: { content: string; minConfidence: number },
): { content: string; metadata: Record<string, unknown> } | null {
  if (!KNOWN_MEMORY_KINDS.has(String(candidate.kind))) return null;
  if (!options.content) return null;
  if (candidate.kind === "person") return null;
  if (isPersonRoutedMemory(options.content)) return null;
  if (classifySensitivity(options.content) === "secret_like") return null;
  if (hasSecretLikeAuxiliaryField(candidate)) return null;
  if (!allowedActionPolicyKind(candidate.actionPolicyKind)) return null;
  if (!allowedCardinality(candidate.cardinality)) return null;
  if (boundedConfidence(candidate.confidence, 0) < options.minConfidence) return null;
  return {
    content: options.content,
    metadata: sanitizePublicPayloadRecord(candidate.metadata ?? {}),
  };
}

function normalizeCandidate(
  candidate: MemoryExtractionCandidate,
  options: {
    minConfidence: number;
    createdAt?: string | undefined;
    parserTemporalMetadata?: Record<string, string> | undefined;
    inferTemporalFromText: boolean;
  },
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
  const metadata: Record<string, unknown> = {
    ...(options.inferTemporalFromText
      ? {
          ...explicitEventTimeMetadata(content),
        }
      : {}),
    ...sanitizePublicPayloadRecord({
      ...(candidate.metadata ?? {}),
      ...(source ? { source } : {}),
    }),
    ...(options.parserTemporalMetadata ?? {}),
    ...structuredTemporalMetadata(candidate),
  };
  return {
    candidate: {
      ...candidateWithoutAliases,
      content,
      confidence,
      ...(object ? { object } : {}),
      ...(source ? { source } : {}),
      ...(speaker ? { speaker } : {}),
      ...(subjectAliases ? { subjectAliases } : {}),
      metadata: options.inferTemporalFromText
        ? mergeExplicitTemporalValidityMetadata(content, metadata)
        : metadata,
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

export async function extractMemoryCandidates(input: {
  extractor?: MemoryExtractor | undefined;
  extractionInput: MemoryExtractionInput;
  minConfidence?: number | undefined;
  temporalParser?: MemoryTemporalParser | undefined;
  inferTemporalFromText?: boolean | undefined;
}): Promise<MemoryExtractionCandidate[]> {
  return (await extractMemoryCandidatePlan(input)).candidates;
}

export async function extractMemoryCandidateReport(input: {
  extractor?: MemoryExtractor | undefined;
  extractionInput: MemoryExtractionInput;
  minConfidence?: number | undefined;
  temporalParser?: MemoryTemporalParser | undefined;
  inferTemporalFromText?: boolean | undefined;
}): Promise<MemoryExtractionReport> {
  return (await extractMemoryCandidatePlan(input)).report;
}

export async function extractMemoryCandidatePlan(input: {
  extractor?: MemoryExtractor | undefined;
  extractionInput: MemoryExtractionInput;
  supplementalCandidates?: MemoryExtractionCandidate[] | undefined;
  minConfidence?: number | undefined;
  temporalParser?: MemoryTemporalParser | undefined;
  inferTemporalFromText?: boolean | undefined;
}): Promise<MemoryExtractionPlan> {
  const minConfidence = input.minConfidence ?? 0.01;
  const inferTemporalFromText = input.inferTemporalFromText ?? false;
  let selected: MemoryExtractionCandidate[] | null = null;
  let extractorFailed = false;
  let retryCount = 0;
  let outcome: MemoryExtractionOutcome = input.extractor ? "ok_empty" : "not_configured";

  if (input.extractor) {
    try {
      const raw =
        typeof input.extractor === "function"
          ? await input.extractor(input.extractionInput)
          : await input.extractor.extract(input.extractionInput);
      retryCount = openAICompatibleRetryCount(raw);
      selected = asCandidateArray(raw) ?? [];
      outcome = selected.length > 0 ? "ok_with_candidates" : "ok_empty";
    } catch (error) {
      extractorFailed = true;
      retryCount = openAICompatibleRetryCount(error);
      selected = null;
      outcome = openAICompatibleOutcomeForError(error);
    }
  }

  const supplementalCandidates = input.supplementalCandidates ?? [];
  if (supplementalCandidates.length > 0 && outcome === "not_configured") {
    outcome = "ok_with_candidates";
  } else if (supplementalCandidates.length > 0 && outcome === "ok_empty") {
    outcome = "ok_with_candidates";
  }
  const extractionSource: MemoryExtractionReport["extractionSource"] =
    selected === null && supplementalCandidates.length === 0 ? "none" : "custom";
  const extractor = extractorName(input.extractor);
  let rawCandidateCount = 0;
  const rejected: MemoryExtractionDecision[] = [];

  async function normalizeSourceCandidates(
    source: MemoryExtractionCandidate[],
    sourceName: "custom" | "structured_table",
  ): Promise<Array<{
    raw: MemoryExtractionCandidate;
    candidate: MemoryExtractionCandidate;
  }>> {
    const normalized: Array<{
      raw: MemoryExtractionCandidate;
      candidate: MemoryExtractionCandidate;
    }> = [];
    rawCandidateCount += source.length;
    for (const rawCandidate of source) {
      const content = normalize(rawCandidate.content);
      const temporalParserInput = temporalParserInputForCandidate(rawCandidate, {
        content,
        minConfidence,
      });
      const parserTemporalMetadata = temporalParserInput
        ? await parsedTemporalMetadata({
            parser: input.temporalParser,
            content: temporalParserInput.content,
            metadata: temporalParserInput.metadata,
            createdAt: input.extractionInput.event.createdAt,
          })
        : {};
      const result = normalizeCandidate(rawCandidate, {
        minConfidence,
        createdAt: input.extractionInput.event.createdAt,
        parserTemporalMetadata,
        inferTemporalFromText,
      });
      if ("reason" in result) {
        rejected.push(rejectDecision(rawCandidate, result.reason));
        continue;
      }
      const candidate: MemoryExtractionCandidate = {
        ...result.candidate,
        metadata: {
          ...(result.candidate.metadata ?? {}),
          extractionSource: sourceName,
          ...(sourceName === "custom" && input.extractor ? { extractorName: extractor } : {}),
        },
      };
      normalized.push({ raw: rawCandidate, candidate });
    }
    return normalized;
  }

  const normalized = [
    ...(selected === null ? [] : await normalizeSourceCandidates(selected, "custom")),
    ...await normalizeSourceCandidates(supplementalCandidates, "structured_table"),
  ];

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
    decisions.push(acceptDecision(entry.candidate));
  }
  decisions.push(...rejected);
  const hardRejectCount = decisions.filter(
    (decision) => decision.decision === "rejected" && decision.rejectClass === "hardReject",
  ).length;
  const softRejectCount = decisions.filter(
    (decision) => decision.decision === "rejected" && decision.rejectClass === "softReject",
  ).length;
  return {
    candidates,
    report: {
      ...(extractor ? { extractorName: extractor } : {}),
      minConfidence,
      retryCount,
      extractionSource,
      extractorFailed,
      outcome,
      rawCandidateCount,
      acceptedCandidateCount: candidates.length,
      rejectedCandidateCount: decisions.filter((decision) => decision.decision === "rejected").length,
      hardRejectCount,
      softRejectCount,
      decisions,
    },
  };
}
