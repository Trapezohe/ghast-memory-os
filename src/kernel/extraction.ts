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
} from "./types.js";
import {
  classifySensitivity,
  isNonSpeakerPrefix,
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
  const content = normalize(durableCandidateContent(candidate.content));
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

function stripCorrectionLeadIn(text: string): string {
  let current = text.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const next = current
      .replace(
        /^(?:actually|correction|corrected|clarification|to\s+correct\s+myself|update)\s*[:,，]\s*/iu,
        "",
      )
      .replace(
        /^(?:actually|correction|corrected|clarification|to\s+correct\s+myself|update)\s+(?=(?:I|I'm|I’m|I've|I’ve|my|we|our|project)\b)/iu,
        "",
      )
      .replace(/^(?:其实|实际(?:上)?|更正|纠正(?:一下)?|修正|澄清|更新)\s*[：:，,]\s*/u, "")
      .trim();
    if (next === current) return current;
    current = next;
  }
  return current;
}

function stripSpeakerPrefix(text: string): string {
  let current = stripCorrectionLeadIn(text);
  for (let depth = 0; depth < 4; depth += 1) {
    const match = speakerPrefixMatch(current);
    const prefix = match?.prefix;
    if (!prefix || !match?.rest) {
      return current;
    }
    if (isNonSpeakerPrefix(prefix)) {
      current = stripCorrectionLeadIn(match.rest);
      continue;
    }
    if (!stableNamedPersonSubject(prefix)) return current;
    return stripCorrectionLeadIn(match.rest);
  }
  return current;
}

function speakerPrefixMatch(text: string): { prefix: string; rest: string } | null {
  const match = /^([\p{L}\p{M}' -]{2,48})\s*:\s*(.+)$/u.exec(text);
  const prefix = match?.[1]?.trim();
  const rest = match?.[2]?.trim();
  return prefix && rest ? { prefix, rest } : null;
}

function durableCandidateContent(text: string): string {
  let current = stripCorrectionLeadIn(text);
  for (let depth = 0; depth < 4; depth += 1) {
    const match = speakerPrefixMatch(current);
    if (!match || !isNonSpeakerPrefix(match.prefix)) return current;
    current = stripCorrectionLeadIn(match.rest);
  }
  return current;
}

function personSubjectFieldsForFirstPerson(
  text: string,
  metadata: Record<string, unknown> | undefined,
): Pick<MemoryExtractionCandidate, "subject" | "subjectAliases"> {
  const prefix = speakerPrefixMatch(text)?.prefix;
  const validPrefix =
    prefix && !isNonSpeakerPrefix(prefix) && stableNamedPersonSubject(prefix) ? prefix : "";
  const metadataSpeaker =
    typeof metadata?.speaker === "string" &&
    !/^(?:current[-_ ]?user|user|self|me)$/iu.test(metadata.speaker.trim()) &&
    stableNamedPersonSubject(metadata.speaker)
      ? metadata.speaker.trim()
      : "";
  const speakerAliases = metadataSpeakerAliases(metadata);
  const speakerKeys = new Set([metadataSpeaker, ...speakerAliases].filter(Boolean).map(entityKey));
  const participantKeys = new Set(
    (Array.isArray(metadata?.participants) ? metadata.participants : [])
      .filter((entry): entry is string => typeof entry === "string" && stableNamedPersonSubject(entry))
      .map(entityKey),
  );
  const speaker =
    metadataSpeaker &&
    ((validPrefix && speakerKeys.has(entityKey(validPrefix))) || participantKeys.size > 1)
      ? metadataSpeaker
      : validPrefix;
  return speaker
    ? {
        subject: `person:${speaker}`,
        subjectAliases: uniqueStrings([
          speaker,
          ...(speaker === metadataSpeaker ? speakerAliases : []),
        ]),
      }
    : {};
}

function metadataNamedSpeaker(metadata: Record<string, unknown> | undefined): string {
  return typeof metadata?.speaker === "string" &&
    !/^(?:current[-_ ]?user|user|self|me)$/iu.test(metadata.speaker.trim()) &&
    stableNamedPersonSubject(metadata.speaker)
    ? metadata.speaker.trim()
    : "";
}

function stableSpeakerPrefix(text: string): string {
  const prefix = speakerPrefixMatch(text)?.prefix;
  return prefix && !isNonSpeakerPrefix(prefix) && stableNamedPersonSubject(prefix) ? prefix : "";
}

function speakerPrefixConflictsWithMetadata(
  text: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const prefix = stableSpeakerPrefix(text);
  const speaker = metadataNamedSpeaker(metadata);
  if (!prefix || !speaker) return false;
  return !new Set([speaker, ...metadataSpeakerAliases(metadata)].map(entityKey)).has(entityKey(prefix));
}

function metadataParticipantsOnlySpeaker(
  metadata: Record<string, unknown> | undefined,
  speaker: string,
): boolean {
  if (!Array.isArray(metadata?.participants)) return false;
  const speakerKeys = new Set([speaker, ...metadataSpeakerAliases(metadata)].map(entityKey));
  const participantKeys = metadata.participants
    .filter((entry): entry is string => typeof entry === "string" && stableNamedPersonSubject(entry))
    .map(entityKey)
    .filter(Boolean);
  return participantKeys.length > 0 && participantKeys.every((key) => speakerKeys.has(key));
}

function personSubjectFieldsForFirstPersonPreference(
  text: string,
  metadata: Record<string, unknown> | undefined,
): Pick<MemoryExtractionCandidate, "subject" | "subjectAliases"> | null {
  if (speakerPrefixConflictsWithMetadata(text, metadata)) return null;
  const subjectFields = personSubjectFieldsForFirstPerson(text, metadata);
  if (subjectFields.subject) return subjectFields;
  const speaker = metadataNamedSpeaker(metadata);
  const participants = publicStringArray(metadata?.participants) ?? [];
  const onlySpeakerParticipant = speaker ? metadataParticipantsOnlySpeaker(metadata, speaker) : false;
  if (
    speaker &&
    (participants.length === 0 || onlySpeakerParticipant) &&
    !stableSpeakerPrefix(text) &&
    hasFirstPersonAnchor(text)
  ) {
    return {
      subject: `person:${speaker}`,
      subjectAliases: uniqueStrings([speaker, ...metadataSpeakerAliases(metadata)]),
    };
  }
  return {};
}

function firstPersonPreferenceObject(utterance: string): string | undefined {
  const direct = /^\s*I\s+(?:prefer|like|love)\s+(.{1,120}?)\s*\.?\s*$/iu.exec(utterance);
  const favorite = /^\s*my\s+favorite(?:\s+[\p{L}\p{N}_ -]{1,60})?\s+(?:is|=)\s+(.{1,120}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  const preference = /^\s*my\s+preference\s+is\s+(.{1,120}?)\s*\.?\s*$/iu.exec(utterance);
  const chinese = /^\s*我(?:最|更)?(?:喜欢|偏好)\s*(.{1,120}?)\s*[。.!]?\s*$/u.exec(utterance);
  return stableToolObject(direct?.[1] ?? favorite?.[1] ?? preference?.[1] ?? chinese?.[1]);
}

function firstPersonPreferenceStatement(utterance: string): boolean {
  return (
    /^\s*I\s+(?:prefer|like|love)\s+.{1,120}?\s*\.?\s*$/iu.test(utterance) ||
    /^\s*my\s+favorite(?:\s+[\p{L}\p{N}_ -]{1,60})?\s+(?:is|=)\s+.{1,120}?\s*\.?\s*$/iu.test(
      utterance,
    ) ||
    /^\s*my\s+preference\s+is\s+.{1,120}?\s*\.?\s*$/iu.test(utterance) ||
    /^\s*我(?:最|更)?(?:喜欢|偏好)\s*.{1,120}?\s*[。.!]?\s*$/u.test(utterance)
  );
}

function chineseCurrentToolMatch(utterance: string): RegExpMatchArray | null {
  return [
    /^\s*我的\s*(?:当前|现在|目前)\s*(?:[\p{Script=Han}\p{L}\p{N}_ -]{0,30}\s*)?(工具|应用|软件|编辑器|浏览器|日历|数据库|IDE|ide)\s*(?:是|为|=)\s*(.{1,80}?)\s*[。.!]?\s*$/u,
    /^\s*我(?:当前|现在|目前)的\s*(工具|应用|软件|编辑器|浏览器|日历|数据库|IDE|ide)\s*(?:是|为|=)\s*(.{1,80}?)\s*[。.!]?\s*$/u,
    /^\s*(?:当前|现在|目前)\s*我的\s*(工具|应用|软件|编辑器|浏览器|日历|数据库|IDE|ide)\s*(?:是|为|=)\s*(.{1,80}?)\s*[。.!]?\s*$/u,
  ].map((pattern) => pattern.exec(utterance)).find((match) => match !== null) ?? null;
}

function chinesePersonAttributeMatch(
  utterance: string,
): { field: string; value: string; rule: string } | null {
  const fieldPattern = String.raw`城市|所在地|位置|居住地|住址|时区|语言|职业|职位|头衔|职称|姓名|名字|全名|专业|大学专业|家乡|故乡|出生地|生日|出生日期`;
  const structured = [
    new RegExp(
      String.raw`^\s*我的\s*(?:当前|现在|目前)?\s*(${fieldPattern})\s*(?:是|为|=)\s*(.{1,80}?)\s*[。.!]?\s*$`,
      "u",
    ),
    new RegExp(
      String.raw`^\s*我(?:当前|现在|目前)的\s*(${fieldPattern})\s*(?:是|为|=)\s*(.{1,80}?)\s*[。.!]?\s*$`,
      "u",
    ),
    new RegExp(
      String.raw`^\s*(?:当前|现在|目前)\s*我的\s*(${fieldPattern})\s*(?:是|为|=)\s*(.{1,80}?)\s*[。.!]?\s*$`,
      "u",
    ),
  ].map((pattern) => pattern.exec(utterance)).find((match) => match !== null);
  if (structured) {
    return { field: structured[1]!, value: structured[2]!, rule: "first_person_chinese_structured_attribute" };
  }
  const location = /^\s*我\s*(?:当前|现在|目前)?\s*(?:住在|居住在)\s*(.{1,80}?)\s*[。.!]?\s*$/u.exec(
    utterance,
  );
  if (location) {
    return { field: "位置", value: location[1]!, rule: "first_person_chinese_live_in" };
  }
  const hometown = /^\s*我\s*(?:当前|现在|目前)?\s*来自\s*(.{1,80}?)\s*[。.!]?\s*$/u.exec(
    utterance,
  );
  if (hometown) {
    return { field: "家乡", value: hometown[1]!, rule: "first_person_chinese_from_place" };
  }
  const birthplace = /^\s*我\s*(?:出生在|出生地是|出生地为)\s*(.{1,80}?)\s*[。.!]?\s*$/u.exec(
    utterance,
  );
  if (birthplace) {
    return { field: "出生地", value: birthplace[1]!, rule: "first_person_chinese_birthplace" };
  }
  return null;
}

function stableSpeakerPrefixedFirstPersonPreference(text: string): boolean {
  return Boolean(stableSpeakerPrefix(text) && firstPersonPreferenceStatement(stripSpeakerPrefix(text)));
}

function metadataSpeakerFirstPersonPreference(
  text: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadataNamedSpeaker(metadata)) return false;
  const subjectFields = personSubjectFieldsForFirstPersonPreference(text, metadata);
  return Boolean(subjectFields?.subject && firstPersonPreferenceStatement(stripSpeakerPrefix(text)));
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
    /\b(?:today|tomorrow|yesterday|last|next|since|before|after|daily|weekly|monthly|weekend|spring|summer|autumn|winter|holiday|vacation|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}|\d{1,2}:\d{2})\b/iu.test(
      text,
    ) ||
    /\d{1,2}\s*(?:分钟|小时|天|周|月|年)/u.test(text) ||
    /(?:今天|明天|昨天|前天|后天|上周|下周|上个月|下个月|去年|今年|明年|前年|周末|春天|夏天|秋天|冬天|\d{4}年|\d{1,2}月\d{1,2}日)/u.test(
      text,
    )
  );
}

function hasPersonalWorldEventSignal(text: string): boolean {
  return (
    /\b(?:went|visited|attended|traveled|travelled|flew|moved\s+to|relocated|booked|reserved|ran|painted|planning|planned|researching|chose|started|finished|graduated|studying|working|commute|relationship|single|married|identity|transgender|counseling|therapy|mental health|adoption|adopted|career|family|kids|children|job|work|school|education|class|course|workshop|conference|birthday|appointment|meeting|trip|travel|flight|hotel|reservation|camping|race|support group)\b/iu.test(
      text,
    ) ||
    durableStayEvent(text) ||
    /\b(?:bought|sold|rented|leased)\s+(?:an?\s+|the\s+|my\s+)?(?:house|home|apartment|flat|condo|car|bike)\b/iu.test(
      text,
    ) ||
    /上学|工作|通勤|家庭|孩子|关系|单身|结婚|身份|心理|咨询|收养|参加|访问|搬家|预订|预约|课程|研讨会|会议|旅行|航班|酒店|露营|比赛|支持小组/u.test(text)
  );
}

function hasNamedPersonEventSignal(text: string): boolean {
  return (
    /\b(?:went|visited|attended|traveled|travelled|flew|moved\s+to|relocated|booked|reserved|ran|painted|chose|started|finished|graduated|studying|commute|appointment|meeting|class|course|workshop|conference|trip|travel|flight|hotel|reservation|camping|race)\b/iu.test(
      text,
    ) ||
    durableStayEvent(text) ||
    /\b(?:bought|sold|rented|leased)\s+(?:an?\s+|the\s+|my\s+)?(?:house|home|apartment|flat|condo|car|bike)\b/iu.test(
      text,
    ) ||
    /(?:去了|去过|访问|参加|旅行|搬到|搬家|预订|预约|跑了|画了|开始|完成|毕业|上课|课程|研讨会|会议|露营|比赛|航班|酒店)/u.test(
      text,
    )
  );
}

function durableStayEvent(text: string): boolean {
  const stayPrefix = String.raw`(?:had|has|have)\s+stayed|stayed`;
  return (
    new RegExp(
      String.raw`\b(?:${stayPrefix})\s+(?:at|in)\s+(?:(?:the|a|an)\s+)?(?:hotel|hostel|inn|resort|motel|airbnb|ryokan|campground)\b`,
      "iu",
    ).test(
      text,
    ) ||
    new RegExp(
      String.raw`\b(?:${stayPrefix})\s+at\s+[\p{Lu}][\p{L}\p{M}'-]*(?:\s+[\p{Lu}][\p{L}\p{M}'-]*){0,3}\s+(?:Hotel|Hostel|Inn|Resort|Motel|Ryokan)\b`,
      "u",
    ).test(
      text,
    ) ||
    new RegExp(
      String.raw`\b(?:${stayPrefix})\s+in\s+[\p{Lu}][\p{L}\p{M}'-]{1,40}(?:\s+[\p{Lu}][\p{L}\p{M}'-]{1,40}){0,2}\b`,
      "u",
    ).test(
      text,
    )
  );
}

function transientStayEvent(text: string): boolean {
  return /^\s*(?:(?:had|has|have)\s+)?stayed\b/iu.test(text) && !durableStayEvent(text);
}

function likelyDurableObservationFact(text: string): boolean {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return false;
  if (!hasFirstPersonAnchor(utterance)) return false;
  return hasDurableTemporalSignal(utterance) || hasPersonalWorldEventSignal(utterance);
}

function firstPersonAttributeCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const personSubject = personSubjectFieldsForFirstPerson(text, metadata);
  const chineseCurrentTool = chineseCurrentToolMatch(utterance);
  if (chineseCurrentTool) {
    const object = stableToolObject(chineseCurrentTool[2]);
    if (object) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.tool",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_current_tool" },
      };
    }
    return null;
  }
  const currentTool = /^\s*my\s+current\s+(?:[\p{L}\p{N}_ -]{0,60}\s+)?(?:tool|app|application|editor|ide|browser|calendar|database)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (currentTool) {
    const object = stableToolObject(currentTool[1]);
    if (object) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.tool",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_current_tool" },
      };
    }
    return null;
  }
  const stableTool = /^\s*my\s+(?!current\b)(?:[\p{L}\p{N}_-]+\s+){1,8}(?:tool|app|application|editor|ide|browser|calendar|database)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (stableTool) {
    const object = stableToolObject(stableTool[1]);
    if (object) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.tool",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_tool" },
      };
    }
    return null;
  }
  const useTool = /^\s*I\s+use\s+(.{2,80}?)\s+for\s+(.{2,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (useTool) {
    const object = stableToolObject(useTool[1]);
    const toolPurpose = toolPurposeObject(useTool[2]);
    if (object) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.64,
        predicate: "person.tool",
        object,
        ...personSubject,
        metadata: { rule: "first_person_tool_use", ...(toolPurpose ? { toolPurpose } : {}) },
      };
    }
    return null;
  }
  if (/^我用\s*.+\s*(?:做|处理|管理|进行)\s*.+/u.test(utterance)) {
    return {
      kind: "fact",
      content: text,
      confidence: 0.64,
      predicate: "user.tool",
      metadata: { rule: "first_person_attribute" },
    };
  }
  const namedRelation = firstPersonNamedRelationCandidate(text, metadata);
  if (namedRelation) return namedRelation;
  const chineseStructuredAttribute = chinesePersonAttributeMatch(utterance);
  if (chineseStructuredAttribute) {
    const predicate = personCurrentAttributePredicate(chineseStructuredAttribute.field);
    const object = personAttributeObject(chineseStructuredAttribute.field, chineseStructuredAttribute.value);
    if (predicate && object && !unsafePersonAttributeObject(chineseStructuredAttribute.field, object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate,
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: chineseStructuredAttribute.rule },
      };
    }
    return null;
  }
  const currentlyLiveIn = /^\s*I\s+(?:currently\s+)?live\s+in\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (currentlyLiveIn) {
    const object = projectBeliefObject(currentlyLiveIn[1]);
    if (object && !unsafePersonAttributeObject("location", object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.location",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_live_in" },
      };
    }
    return null;
  }
  const fromPlace = /^\s*I(?:'m|’m| am)\s+from\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (fromPlace) {
    const object = projectBeliefObject(fromPlace[1]);
    if (object && !unsafePersonAttributeObject("hometown", object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.64,
        predicate: "person.hometown",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_from_place" },
      };
    }
    return null;
  }
  const workAs = /^\s*I\s+work\s+as\s+(?:(?:an?|the)\s+)?(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (workAs) {
    const object = projectBeliefObject(workAs[1]);
    if (object && !unsafePersonAttributeObject("role", object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.role",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_work_as" },
      };
    }
    return null;
  }
  const birthplace = /^\s*I\s+was\s+born\s+in\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (birthplace) {
    const object = projectBeliefObject(birthplace[1]);
    if (object && !unsafePersonAttributeObject("birthplace", object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.birthplace",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_birthplace" },
      };
    }
    return null;
  }
  const birthdate = /^\s*I\s+was\s+born\s+on\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance);
  if (birthdate) {
    const object = projectBeliefObject(birthdate[1]);
    if (object && !unsafePersonAttributeObject("birthdate", object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate: "person.birthdate",
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_birthdate" },
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
    if (predicate && object && !unsafePersonAttributeObject(currentAttribute[1], object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate,
        object,
        cardinality: "single",
        ...personSubject,
        metadata: { rule: "first_person_current_attribute" },
      };
    }
    return null;
  }
  const stableAttribute = /^\s*my\s+(full\s+name|name|college\s+major|major|home\s+town|hometown|birth\s+date|birthdate|birthday|date\s+of\s+birth|role|job|profession|title)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (stableAttribute) {
    const predicate = personCurrentAttributePredicate(stableAttribute[1]);
    const object = personAttributeObject(stableAttribute[1], stableAttribute[2]);
    if (predicate && object && !unsafePersonAttributeObject(stableAttribute[1], object)) {
      return {
        kind: "fact",
        content: text,
        confidence: 0.66,
        predicate,
        object,
        cardinality: "single",
        ...personSubject,
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

function firstPersonPreferenceCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const subjectFields = personSubjectFieldsForFirstPersonPreference(text, metadata);
  if (!subjectFields?.subject) return null;
  const object = firstPersonPreferenceObject(utterance);
  if (!object) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.64,
    predicate: "person.preference",
    ...subjectFields,
    object,
    cardinality: "multi",
    metadata: { rule: "first_person_preference" },
  };
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

const OBVIOUS_TECH_NON_PERSON_NAME_PATTERN =
  /^(?:chatgpt|gpt(?:[-_ ]?\d[\w.-]*)?|llm(?:[-_ ]?\d[\w.-]*)?|(?:llama|qwen|mistral|gemini|deepseek|grok|glm)(?:[-_ ]?\d[\w.-]*)?|claude[-_ ]?\d[\w.-]*|(?:sonnet|opus|haiku)[-_ ]?\d[\w.-]*|(?:slack|discord|telegram|github|gitlab|linear|jira|notion)?bot)$/iu;

const CHINESE_NON_PERSON_SINGLE_NAMES = new Set([
  "项目",
  "工具",
  "应用",
  "产品",
  "模型",
  "系统",
  "服务",
  "团队",
  "公司",
  "组织",
  "群",
  "群聊",
  "仓库",
  "代码库",
  "平台",
  "插件",
  "机器人",
  "助手",
  "客户端",
  "浏览器",
  "编辑器",
  "数据库",
  "文档",
  "笔记",
  "微信",
  "飞书",
  "小红书",
  "豆包",
  "钉钉",
  "通义",
  "文心",
  "智谱",
]);

const CHINESE_NON_PERSON_SUBJECT_PATTERN =
  /(?:项目|工具|应用|产品|模型|系统|服务|团队|公司|组织|群聊|仓库|代码库|平台|插件|机器人|助手|客户端|浏览器|编辑器|数据库|文档|笔记|小程序)$/u;

function explicitChineseNonPersonSubject(name: string): boolean {
  const compact = name.trim().replace(/\s+/gu, "");
  if (!compact) return false;
  if (CHINESE_NON_PERSON_SINGLE_NAMES.has(compact)) return true;
  return CHINESE_NON_PERSON_SUBJECT_PATTERN.test(compact);
}

function explicitNonPersonSubject(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (NON_PERSON_SINGLE_NAMES.has(normalized)) return true;
  if (explicitChineseNonPersonSubject(name)) return true;
  if (OBVIOUS_TECH_NON_PERSON_NAME_PATTERN.test(normalized)) return true;
  if (
    /^(?:project|team|company|org|organization|group|support|note|reminder|fact|example|preference|task|ticket|repo|repository|service|system|app|tool|product|model|agent|inc|corp|llc|ltd|labs|research|foundation|university|school|department|committee|platform|cloud)$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  return NON_PERSON_SUBJECT_PATTERN.test(normalized);
}

export function isReservedSpeakerIdentity(name: string): boolean {
  const normalized = name.trim().replace(/\s+/gu, " ");
  return /^(?:current[-_ ]?user|user|self|me)$/iu.test(normalized);
}

export function stableNamedPersonSubject(name: string): boolean {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return false;
  if (isReservedSpeakerIdentity(trimmed)) return false;
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

function metadataSpeakerAliases(metadata: Record<string, unknown> | undefined): string[] {
  return (Array.isArray(metadata?.speakerAliases) ? metadata.speakerAliases : []).filter(
    (entry): entry is string => typeof entry === "string" && stableNamedPersonSubject(entry),
  );
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
  if (!prefix || isNonSpeakerPrefix(prefix)) return false;
  return explicitNonPersonSubject(prefix);
}

function nonPersonSpeakerCandidate(
  metadata: Record<string, unknown> | undefined,
  content: string,
): boolean {
  return metadataSpeakerIsNonPerson(metadata, content) || contentHasExplicitNonPersonSpeaker(content);
}

function candidateSpeakerIsNonPerson(candidate: MemoryExtractionCandidate): boolean {
  if (typeof candidate.speaker !== "string") return false;
  const speaker = candidate.speaker.trim();
  if (!speaker || isReservedSpeakerIdentity(speaker)) return false;
  if (classifySensitivity(speaker) !== "normal") return false;
  return explicitNonPersonSubject(speaker);
}

function metadataConfirmsNamedPerson(
  name: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadataPersonNames(metadata).has(entityKey(name));
}

function metadataParticipantsConfirmNamedPerson(
  name: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata || !Array.isArray(metadata.participants)) return false;
  const key = entityKey(name);
  return metadata.participants.some(
    (value) => typeof value === "string" && stableNamedPersonSubject(value) && entityKey(value) === key,
  );
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

function safeNamedPersonEventPrefixBoundary(name: string, event: string): boolean {
  if (!/[\p{Script=Han}]/u.test(name)) return true;
  return /^(?:[:：,，\s]+|(?:今天|明天|昨天|前天|后天|上周|下周|上个月|下个月|去年|今年|明年|前年|周末|春天|夏天|秋天|冬天|\d{4}年|\d{1,2}月\d{1,2}日)|(?:去|去了|去过|访问|参加|旅行|搬到|搬家|预订|预约|跑了|画了|开始|完成|毕业|上课|露营)|(?:在|到|从)[\p{Script=Han}\p{L}\p{N}_ -]{1,40}(?:参加|访问|旅行|上课|开会|露营|比赛))/u.test(
    event,
  );
}

function unsafeNamedPersonEventRemainder(event: string): boolean {
  const compact = event.trim().replace(/^[的\s]+/u, "");
  if (!compact) return true;
  if (/^(?:和|跟|与)[\p{Script=Han}\p{L}]/u.test(compact)) return true;
  if (/^(?:微信|飞书|小红书|豆包|钉钉|通义|文心|智谱|项目|工具|应用|产品|模型|系统|服务|平台|插件|机器人|助手)/u.test(compact)) {
    return true;
  }
  return false;
}

function metadataNamedPersonPrefix(
  utterance: string,
  metadata: Record<string, unknown> | undefined,
): { name: string; event: string } | null {
  if (!metadata) return null;
  const names = [
    ...(Array.isArray(metadata.participants) ? metadata.participants : []),
    ...(Array.isArray(metadata.speakerAliases) ? metadata.speakerAliases : []),
  ]
    .filter((value): value is string => typeof value === "string" && stableNamedPersonSubject(value))
    .sort((a, b) => b.trim().length - a.trim().length);
  for (const name of names) {
    const normalizedName = name.trim();
    if (!normalizedName || !utterance.startsWith(normalizedName)) continue;
    let event = utterance.slice(normalizedName.length);
    if (/^[A-Za-z][A-Za-z0-9_ '-]*$/u.test(normalizedName) && /^[\p{L}\p{N}_-]/u.test(event)) {
      continue;
    }
    if (!safeNamedPersonEventPrefixBoundary(normalizedName, event)) continue;
    event = event.replace(/^[\s:：,，]+/u, "").trim();
    if (unsafeNamedPersonEventRemainder(event)) continue;
    if (event) return { name: normalizedName, event };
  }
  return null;
}

function rejectedNamedPersonEventPrefixUtterance(
  text: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  const utterance = stripSpeakerPrefix(text);
  const names = [
    ...(Array.isArray(metadata.participants) ? metadata.participants : []),
    ...(Array.isArray(metadata.speakerAliases) ? metadata.speakerAliases : []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  for (const name of names) {
    const normalizedName = name.trim();
    if (!utterance.startsWith(normalizedName)) continue;
    const event = utterance.slice(normalizedName.length).trim();
    if (!event) continue;
    if (hasFirstPersonAnchor(event)) continue;
    if (explicitChineseNonPersonSubject(normalizedName)) return true;
    if (!/[\p{Script=Han}]/u.test(normalizedName)) continue;
    if (unsafeNamedPersonEventRemainder(event)) return true;
    if (!safeNamedPersonEventPrefixBoundary(normalizedName, event) && hasDurableTemporalSignal(event)) {
      return true;
    }
  }
  return false;
}

function stableToolObject(value: string | undefined): string | undefined {
  const object = projectBeliefObject(value);
  if (!object) return undefined;
  if (invalidPersonAttributeObject(object)) return undefined;
  if (unsafeDirectAttributeObject("tool", object)) return undefined;
  if (
    /^(?:not\s+|currently\s+)?(?:broken|unavailable|offline|down|missing|disabled|deprecated|obsolete|unsupported)\b/iu.test(
      object,
    ) ||
    /^(?:slow|full|buggy|busy|empty)\b/iu.test(object) ||
    /^(?:not|currently\s+not)\s+\S+/iu.test(object)
  ) {
    return undefined;
  }
  return object;
}

function toolPurposeObject(value: string | undefined): string | undefined {
  const object = projectBeliefObject(value);
  if (!object) return undefined;
  if (invalidPersonAttributeObject(object)) return undefined;
  if (unsafeDirectAttributeObject("toolPurpose", object)) return undefined;
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
    String.raw`^\s*(${namePattern})\s+uses\s+(.{2,80}?)\s+for\s+(.{2,80}?)\s*\.?\s*$`,
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
  const toolPurpose = usesMatch ? toolPurposeObject(usesMatch[3]) : undefined;
  return {
    kind: "fact",
    content: text,
    confidence: 0.64,
    predicate: "person.tool",
    subject: `person:${name}`,
    subjectAliases: [name],
    ...(object ? { object } : {}),
    ...(possessiveMatch ? { cardinality: "single" as const } : {}),
    metadata: { rule: "named_person_tool", ...(toolPurpose ? { toolPurpose } : {}) },
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
  if (normalized === "city" || normalized === "城市") return "person.city";
  if (
    normalized === "location" ||
    normalized === "所在地" ||
    normalized === "位置" ||
    normalized === "居住地" ||
    normalized === "住址"
  ) {
    return "person.location";
  }
  if (normalized === "timezone" || normalized === "time zone" || normalized === "时区") {
    return "person.timezone";
  }
  if (normalized === "role" || normalized === "job" || normalized === "profession" || normalized === "职业") {
    return "person.role";
  }
  if (normalized === "title" || normalized === "职位" || normalized === "头衔" || normalized === "职称") {
    return "person.title";
  }
  if (normalized === "language" || normalized === "语言") return "person.language";
  if (normalized === "birthplace" || normalized === "birth place" || normalized === "出生地") {
    return "person.birthplace";
  }
  if (
    normalized === "birthdate" ||
    normalized === "birth date" ||
    normalized === "birthday" ||
    normalized === "date of birth" ||
    normalized === "生日" ||
    normalized === "出生日期"
  ) {
    return "person.birthdate";
  }
  if (normalized === "major" || normalized === "college major" || normalized === "专业" || normalized === "大学专业") {
    return "person.major";
  }
  if (normalized === "name" || normalized === "full name" || normalized === "姓名" || normalized === "名字" || normalized === "全名") {
    return "person.name";
  }
  if (normalized === "hometown" || normalized === "home town" || normalized === "家乡" || normalized === "故乡") {
    return "person.hometown";
  }
  return null;
}

function personAttributeObject(field: string | undefined, value: string | undefined): string | undefined {
  const object = projectBeliefObject(value);
  if (!object) return undefined;
  const normalized = field?.trim().toLowerCase().replace(/[-_]+/gu, " ").replace(/\s+/gu, " ");
  return normalized === "role" || normalized === "job" || normalized === "profession" || normalized === "title" || normalized === "职业" || normalized === "职位" || normalized === "头衔" || normalized === "职称"
    ? object.replace(/^(?:(?:an?|the)\s+|一名|一个|一位)/iu, "").trim() || undefined
    : object;
}

function directPersonRoleObject(value: string | undefined): string | undefined {
  const object = personAttributeObject("role", value);
  if (!object) return undefined;
  return /\b(?:accountant|analyst|architect|artist|attorney|consultant|designer|developer|doctor|editor|engineer|founder|lawyer|manager|musician|nurse|physician|professor|programmer|researcher|scientist|teacher|technician|writer)\b$/iu.test(object)
    ? object
    : undefined;
}

function invalidPersonAttributeObject(object: string): boolean {
  return (
    /^(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(object) ||
    /^(?:一个|一款|一种|某个)?(?:不可用|未知|没有|暂无|未设置|未指定|不确定|不清楚|不知道|无|空|无效)$/u.test(
      object.trim(),
    )
  );
}

function unsafePersonAttributeObject(field: string | undefined, object: string): boolean {
  return invalidPersonAttributeObject(object) || unsafeDirectAttributeObject(field ?? "", object);
}

function malformedFirstPersonStructuredAttribute(text: string): boolean {
  const utterance = stripSpeakerPrefix(text);
  const chineseCurrentTool = chineseCurrentToolMatch(utterance);
  if (chineseCurrentTool && !stableToolObject(chineseCurrentTool[2])) return true;
  const chineseAttribute = chinesePersonAttributeMatch(utterance);
  if (
    chineseAttribute &&
    unsafePersonAttributeObject(
      chineseAttribute.field,
      personAttributeObject(chineseAttribute.field, chineseAttribute.value) ?? "",
    )
  ) {
    return true;
  }
  const currentTool = /^\s*my\s+current\s+(?:[\p{L}\p{N}_ -]{0,60}\s+)?(?:tool|app|application|editor|ide|browser|calendar|database)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (currentTool && !stableToolObject(currentTool[1])) return true;
  const stableTool = /^\s*my\s+(?!current\b)(?:[\p{L}\p{N}_-]+\s+){1,8}(?:tool|app|application|editor|ide|browser|calendar|database)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (stableTool && !stableToolObject(stableTool[1])) return true;
  const useTool = /^\s*I\s+use\s+(.{2,80}?)\s+for\s+.{2,80}?\s*\.?\s*$/iu.exec(utterance);
  if (useTool && !stableToolObject(useTool[1])) return true;
  const currentAttribute = /^\s*my\s+current\s+(city|location|time\s+zone|timezone|role|job|profession|title|language)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (
    currentAttribute &&
    unsafePersonAttributeObject(currentAttribute[1], projectBeliefObject(currentAttribute[2]) ?? "")
  ) {
    return true;
  }
  const stableAttribute = /^\s*my\s+(full\s+name|name|college\s+major|major|home\s+town|hometown|birth\s+date|birthdate|birthday|date\s+of\s+birth|birth\s+place|birthplace|role|job|profession|title)\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$/iu.exec(
    utterance,
  );
  if (
    stableAttribute &&
    unsafePersonAttributeObject(stableAttribute[1], projectBeliefObject(stableAttribute[2]) ?? "")
  ) {
    return true;
  }
  const entries: Array<{ field: string; match: RegExpMatchArray | null }> = [
    { field: "location", match: /^\s*I\s+(?:currently\s+)?live\s+in\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance) },
    { field: "hometown", match: /^\s*I(?:'m|’m| am)\s+from\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance) },
    { field: "role", match: /^\s*I\s+work\s+as\s+(?:(?:an?|the)\s+)?(.{1,80}?)\s*\.?\s*$/iu.exec(utterance) },
    { field: "birthplace", match: /^\s*I\s+was\s+born\s+in\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance) },
    { field: "birthdate", match: /^\s*I\s+was\s+born\s+on\s+(.{1,80}?)\s*\.?\s*$/iu.exec(utterance) },
  ];
  for (const entry of entries) {
    const object = projectBeliefObject(entry.match?.[1]);
    if (object && unsafePersonAttributeObject(entry.field, object)) return true;
  }
  return false;
}

function nonSpeakerPrefixedFirstPersonToolUse(text: string): boolean {
  const prefixMatch = speakerPrefixMatch(text);
  if (!prefixMatch || !isNonSpeakerPrefix(prefixMatch.prefix)) return false;
  return /^\s*I\s+use\s+.{2,80}?\s+for\s+.{2,80}?\s*\.?\s*$/iu.test(prefixMatch.rest);
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
  if (!predicate || !object || unsafePersonAttributeObject(match?.[2], object)) return null;
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

function namedPersonStableAttributeCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const fieldPattern = String.raw`full\s+name|name|college\s+major|major|home\s+town|hometown|birth\s+date|birthdate|birthday|date\s+of\s+birth|birth\s+place|birthplace|role|job|profession|title`;
  const englishMatch = new RegExp(
    String.raw`^\s*(${namePattern})[’']s\s+(${fieldPattern})\s+(?:is|=)\s+(.{1,80}?)\s*\.?\s*$`,
    "iu",
  ).exec(utterance);
  const chineseNamePattern = String.raw`[\p{Script=Han}]{2,6}|[A-Z][A-Za-z0-9_-]{1,30}`;
  const chineseFieldPattern = String.raw`城市|所在地|位置|居住地|住址|时区|语言|职业|职位|头衔|职称|姓名|名字|全名|专业|大学专业|家乡|故乡|出生地|生日|出生日期`;
  const chineseMatch = new RegExp(
    String.raw`^\s*(${chineseNamePattern})\s*的\s*(?:当前|现在|目前)?\s*(${chineseFieldPattern})\s*(?:是|为|=)\s*(.{1,80}?)\s*[。.!]?\s*$`,
    "u",
  ).exec(utterance);
  const match = englishMatch ?? chineseMatch;
  const name = match?.[1]?.trim();
  if (!name || !stableNamedPersonSubject(name) || !metadataParticipantsConfirmNamedPerson(name, metadata)) {
    return null;
  }
  const predicate = personCurrentAttributePredicate(match?.[2]);
  const object = personAttributeObject(match?.[2], match?.[3]);
  if (!predicate || !object || unsafePersonAttributeObject(match?.[2], object)) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.66,
    predicate,
    subject: `person:${name}`,
    subjectAliases: [name],
    object,
    cardinality: "single",
    metadata: { rule: "named_person_stable_attribute" },
  };
}

function namedPersonDirectAttributeCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const chineseNamePattern = String.raw`[\p{Script=Han}]{2,6}|[A-Z][A-Za-z0-9_-]{1,30}`;
  const entry = [
    {
      field: "location",
      match: new RegExp(String.raw`^\s*(${namePattern})\s+(?:currently\s+)?lives\s+in\s+(.{1,80}?)\s*\.?\s*$`, "u").exec(utterance),
    },
    {
      field: "hometown",
      match: new RegExp(String.raw`^\s*(${namePattern})\s+(?:is|comes)\s+from\s+(.{1,80}?)\s*\.?\s*$`, "u").exec(utterance),
    },
    {
      field: "birthplace",
      match: new RegExp(String.raw`^\s*(${namePattern})\s+was\s+born\s+in\s+(.{1,80}?)\s*\.?\s*$`, "u").exec(utterance),
    },
    {
      field: "birthdate",
      match: new RegExp(String.raw`^\s*(${namePattern})\s+was\s+born\s+on\s+(.{1,80}?)\s*\.?\s*$`, "u").exec(utterance),
    },
    {
      field: "role",
      match: new RegExp(String.raw`^\s*(${namePattern})\s+works\s+as\s+(?:(?:an?|the)\s+)?(.{1,80}?)\s*\.?\s*$`, "u").exec(utterance),
    },
    {
      field: "role",
      match: new RegExp(String.raw`^\s*(${namePattern})\s+is\s+(?:(?:an?|the)\s+)(.{1,80}?)\s*\.?\s*$`, "u").exec(utterance),
      directRole: true,
    },
    {
      field: "location",
      match: new RegExp(
        String.raw`^\s*(${chineseNamePattern})\s*(?:当前|现在|目前)?\s*(?:住在|居住在)\s*(.{1,80}?)\s*[。.!]?\s*$`,
        "u",
      ).exec(utterance),
    },
    {
      field: "hometown",
      match: new RegExp(
        String.raw`^\s*(${chineseNamePattern})\s*(?:当前|现在|目前)?\s*来自\s*(.{1,80}?)\s*[。.!]?\s*$`,
        "u",
      ).exec(utterance),
    },
    {
      field: "birthplace",
      match: new RegExp(
        String.raw`^\s*(${chineseNamePattern})\s*(?:出生在|出生地是|出生地为)\s*(.{1,80}?)\s*[。.!]?\s*$`,
        "u",
      ).exec(utterance),
    },
  ].find((entry) => entry.match !== null);
  if (!entry?.match) return null;
  const name = entry.match[1]?.trim();
  if (!name || !stableNamedPersonSubject(name) || !metadataParticipantsConfirmNamedPerson(name, metadata)) {
    return null;
  }
  const predicate = personCurrentAttributePredicate(entry.field);
  const object = entry.directRole ? directPersonRoleObject(entry.match[2]) : personAttributeObject(entry.field, entry.match[2]);
  if (!predicate || !object || unsafePersonAttributeObject(entry.field, object)) {
    return null;
  }
  return {
    kind: "fact",
    content: text,
    confidence: 0.66,
    predicate,
    subject: `person:${name}`,
    subjectAliases: [name],
    object,
    cardinality: "single",
    metadata: { rule: "named_person_direct_attribute" },
  };
}

function unsafeDirectAttributeObject(field: string, object: string): boolean {
  if (/[;；]/u.test(object)) return true;
  const namedPersonVerb = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}\s+(?:currently\s+)?(?:lives|works|was|is|comes)\b`;
  const namedPersonPossessive = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}[’']s\s+[\p{L}\p{N}_ -]{1,60}\s+(?:is|=)\b`;
  const firstPersonContinuation = String.raw`[Ii]\s+(?:(?:currently\s+)?live|work\s+as|was\s+born|use)\b|[Ii](?:'m|’m| am)\s+from\b`;
  const myToolContinuation = String.raw`[Mm]y\s+(?:current\s+)?(?:[\p{L}\p{N}_-]+\s+){0,8}(?:tool|app|application|editor|ide|browser|calendar|database)\s+(?:is|=)\b`;
  const myAttributeContinuation = String.raw`(?:${myToolContinuation}|[Mm]y\s+(?:current\s+)?(?:city|location|time\s+zone|timezone|role|job|profession|title|language|full\s+name|name|college\s+major|major|home\s+town|hometown|birth\s+date|birthdate|birthday|date\s+of\s+birth|birth\s+place|birthplace)\s+(?:is|=)\b)`;
  const chineseFirstPersonContinuation = String.raw`我\s*(?:当前|现在|目前)?\s*(?:住在|居住在|来自|出生在)`;
  const chineseMyAttributeContinuation = String.raw`我的\s*(?:当前|现在|目前)?\s*(?:城市|所在地|位置|居住地|住址|时区|语言|职业|职位|头衔|职称|姓名|名字|全名|专业|大学专业|家乡|故乡|出生地|生日|出生日期)\s*(?:是|为|=)`;
  const continuation = String.raw`(?:${namedPersonVerb}|${namedPersonPossessive}|${firstPersonContinuation}|${myAttributeContinuation}|${chineseFirstPersonContinuation}|${chineseMyAttributeContinuation})`;
  if (new RegExp(String.raw`[.,。；，]\s*${continuation}`, "u").test(object)) return true;
  if (new RegExp(String.raw`\b(?:and|but)\s+${continuation}`, "u").test(object)) return true;
  if (new RegExp(String.raw`(?:而且|但是)\s*${continuation}`, "u").test(object)) return true;
  if (/\bnot\s+(?:an?|the)?\b/iu.test(object)) return true;
  return field === "birthplace" && /\bin\s+\d{3,4}\b/iu.test(object);
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
  const metadataPrefix = metadataNamedPersonPrefix(utterance, metadata);
  const name = match?.[1]?.trim() ?? metadataPrefix?.name;
  const event = projectBeliefObject(match?.[2] ?? metadataPrefix?.event);
  if (!name || !event || !stableNamedPersonSubject(name) || !metadataConfirmsNamedEventSubject(name, metadata)) {
    return null;
  }
  if (hasFirstPersonAnchor(event)) return null;
  if (transientStayEvent(event)) return null;
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

function firstPersonEventCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  if (classifySensitivity(utterance) !== "normal") return null;
  const subjectFields = personSubjectFieldsForFirstPerson(text, metadata);
  if (!subjectFields.subject) return null;
  const eventMatch = /^\s*I(?:'ve|’ve|\s+have)?\s+(.{2,180}?)\s*\.?\s*$/iu.exec(utterance);
  const event = projectBeliefObject(eventMatch?.[1]);
  if (event && transientStayEvent(event)) return null;
  if (!event || !hasDurableTemporalSignal(event) || !hasPersonalWorldEventSignal(event)) {
    return null;
  }
  const coordinatedNamedPerson = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  if (new RegExp(String.raw`^\s*and\s+${coordinatedNamedPerson}\b`, "u").test(event)) {
    return null;
  }
  return {
    kind: "fact",
    content: text,
    confidence: 0.56,
    predicate: "person.event",
    ...subjectFields,
    object: event,
    cardinality: "multi",
    metadata: { rule: "first_person_event" },
  };
}

const ENGLISH_PET_RELATION_PATTERN = String.raw`[Dd]og|[Cc]at|[Pp]et`;
const ENGLISH_HUMAN_RELATION_PATTERN =
  String.raw`[Dd]aughter|[Ss]on|[Cc]hild|[Kk]id|[Pp]artner|[Ss]pouse|[Ww]ife|[Hh]usband|[Mm]other|[Mm]om|[Mm]um|[Ff]ather|[Dd]ad|[Pp]arent|[Bb]rother|[Ss]ister|[Ss]ibling|[Ff]riend|[Bb]est\s+[Ff]riend|[Rr]oommate|[Hh]ousemate|[Cc]olleague|[Cc]oworker|[Cc]o-worker|[Tt]eammate|[Mm]anager|[Bb]oss|[Bb]oyfriend|[Gg]irlfriend`;
const ENGLISH_RELATION_PATTERN = String.raw`(?:${ENGLISH_PET_RELATION_PATTERN}|${ENGLISH_HUMAN_RELATION_PATTERN})`;
const CHINESE_PET_RELATION_PATTERN = String.raw`狗|猫|宠物`;
const CHINESE_HUMAN_RELATION_PATTERN =
  String.raw`女儿|儿子|孩子|小孩|伴侣|配偶|妻子|丈夫|妈妈|母亲|爸爸|父亲|父母|家长|哥哥|弟弟|姐姐|妹妹|兄弟|姐妹|朋友|好友|室友|同事|队友|老板|经理|男友|女友|男朋友|女朋友`;
const CHINESE_RELATION_PATTERN = String.raw`(?:${CHINESE_PET_RELATION_PATTERN}|${CHINESE_HUMAN_RELATION_PATTERN})`;

const HUMAN_RELATION_TYPE_PATTERN = new RegExp(
  String.raw`^(?:${ENGLISH_HUMAN_RELATION_PATTERN}|${CHINESE_HUMAN_RELATION_PATTERN})$`,
  "iu",
);

function humanRelationType(relationType: string): boolean {
  return HUMAN_RELATION_TYPE_PATTERN.test(relationType.trim());
}

function appositiveRelationTailContradicts(tail: string | undefined, relationType: string): boolean {
  if (!tail) return false;
  const relation = relationType.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    String.raw`\b(?:(?:(?:is|was|are|were)\s+)?(?:not|never)|(?:isn't|wasn't|aren't|weren't|isnt|wasnt))\s+(?:actually\s+)?(?:(?:his|her|their|my|our)\s+)?${relation}\b`,
    "iu",
  ).test(tail);
}

function namedPersonRelationCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const englishNameCore = String.raw`\p{Lu}[\p{L}0-9_-]{0,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{0,30}){0,2}`;
  const englishName = String.raw`(?:${englishNameCore}|"${englishNameCore}"|'${englishNameCore}')`;
  const chineseNamedPerson = String.raw`[\p{Script=Han}]{2,6}`;
  const chineseExplicitName = String.raw`(?:[\p{Script=Han}]{1,6}|[A-Z][A-Za-z0-9_-]{0,30})`;
  const possessiveMatch = new RegExp(
    String.raw`^\s*(${namePattern})[’']s\s+(${ENGLISH_RELATION_PATTERN})(?:'s)?\s+(?:[Nn]ame\s+[Ii]s|[Ii]s\s+[Nn]amed|[Ii]s\s+[Cc]alled)\s+(${englishName})\s*[.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const hasMatch = new RegExp(
    String.raw`^\s*(${namePattern})\s+has\s+(?:an?\s+)?(${ENGLISH_RELATION_PATTERN})\s+(?:named|called)\s+(${englishName})\s*[.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const inversePossessiveMatch = new RegExp(
    String.raw`^\s*(${englishName})\s+(?:is|was)\s+(${namePattern})[’']s\s+(${ENGLISH_RELATION_PATTERN})\s*[.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const appositivePossessiveMatch = new RegExp(
    String.raw`^\s*(${namePattern})[’']s\s+(${ENGLISH_RELATION_PATTERN})\s*,?\s+(${englishName})(?:\s*,?\s+(.{1,120}?))?\s*[.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const chinesePossessiveMatch = new RegExp(
    String.raw`^\s*(${chineseNamedPerson})\s*的\s*(${CHINESE_RELATION_PATTERN})\s*(?:名叫|名字是|姓名是|叫)\s*(${chineseExplicitName})\s*[。.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const chineseHasMatch = new RegExp(
    String.raw`^\s*(${chineseNamedPerson})\s*有\s*(?:一个|一位|一名|个|位|名)?\s*(${CHINESE_RELATION_PATTERN})\s*(?:名叫|名字是|姓名是|叫)\s*(${chineseExplicitName})\s*[。.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const chineseInversePossessiveMatch = new RegExp(
    String.raw`^\s*(${chineseExplicitName})\s*是\s*(${chineseNamedPerson})\s*的\s*(${CHINESE_RELATION_PATTERN})\s*[。.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const name = (
    possessiveMatch?.[1] ??
    hasMatch?.[1] ??
    inversePossessiveMatch?.[2] ??
    appositivePossessiveMatch?.[1] ??
    chinesePossessiveMatch?.[1] ??
    chineseHasMatch?.[1] ??
    chineseInversePossessiveMatch?.[2]
  )
    ?.trim();
  const relationType = (
    possessiveMatch?.[2] ??
    hasMatch?.[2] ??
    inversePossessiveMatch?.[3] ??
    appositivePossessiveMatch?.[2] ??
    chinesePossessiveMatch?.[2] ??
    chineseHasMatch?.[2] ??
    chineseInversePossessiveMatch?.[3]
  )
    ?.trim()
    .toLowerCase();
  const rawObject = (
    possessiveMatch?.[3] ??
    hasMatch?.[3] ??
    inversePossessiveMatch?.[1] ??
    appositivePossessiveMatch?.[3] ??
    chinesePossessiveMatch?.[3] ??
    chineseHasMatch?.[3] ??
    chineseInversePossessiveMatch?.[1]
  )
    ?.replace(/^["']|["']$/gu, "");
  const object = projectBeliefObject(rawObject);
  if (!name || !relationType || !object || !stableNamedPersonSubject(name)) return null;
  if (appositiveRelationTailContradicts(appositivePossessiveMatch?.[4], relationType)) return null;
  if ((inversePossessiveMatch || humanRelationType(relationType)) && !stableNamedPersonSubject(object)) {
    return null;
  }
  if (!metadataParticipantsConfirmNamedPerson(name, metadata)) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.66,
    predicate: "person.relation",
    subject: `person:${name}`,
    subjectAliases: [name],
    object,
    cardinality: "multi",
    metadata: { rule: "named_person_relation", relationType },
  };
}

function looksLikeNamedPersonRelationUtterance(text: string): boolean {
  const utterance = stripSpeakerPrefix(text);
  const chineseSubject = String.raw`[\p{Script=Han}]{1,12}`;
  const chineseObject = String.raw`(?:[\p{Script=Han}]{1,8}|[A-Z][A-Za-z0-9_-]{0,30})`;
  return [
    new RegExp(
      String.raw`^\s*${chineseSubject}\s*的\s*${CHINESE_RELATION_PATTERN}\s*(?:名叫|名字是|姓名是|叫)\s*${chineseObject}\s*[。.!?]?\s*$`,
      "u",
    ),
    new RegExp(
      String.raw`^\s*${chineseSubject}\s*有\s*(?:一个|一位|一名|个|位|名)?\s*${CHINESE_RELATION_PATTERN}\s*(?:名叫|名字是|姓名是|叫)\s*${chineseObject}\s*[。.!?]?\s*$`,
      "u",
    ),
    new RegExp(
      String.raw`^\s*${chineseObject}\s*是\s*${chineseSubject}\s*的\s*${CHINESE_RELATION_PATTERN}\s*[。.!?]?\s*$`,
      "u",
    ),
  ].some((pattern) => pattern.test(utterance));
}

function firstPersonNamedRelationCandidate(
  text: string,
  metadata?: Record<string, unknown> | undefined,
): MemoryExtractionCandidate | null {
  const utterance = stripSpeakerPrefix(text);
  if (isQuestionLike(utterance)) return null;
  const englishNameCore = String.raw`\p{Lu}[\p{L}0-9_-]{0,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{0,30}){0,2}`;
  const englishName = String.raw`(?:${englishNameCore}|"${englishNameCore}"|'${englishNameCore}')`;
  const chineseExplicitName = String.raw`(?:[\p{Script=Han}]{1,6}|[A-Z][A-Za-z0-9_-]{0,30})`;
  const latinName = String.raw`[A-Z][A-Za-z0-9_-]{0,30}`;
  const english = new RegExp(
    String.raw`^\s*[Mm]y\s+(${ENGLISH_RELATION_PATTERN})(?:'s)?\s+(?:[Nn]ame\s+[Ii]s|[Ii]s\s+[Nn]amed|[Ii]s\s+[Cc]alled)\s+(${englishName})\s*[.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const englishHave = new RegExp(
    String.raw`^\s*I\s+have\s+(?:an?\s+)?(${ENGLISH_RELATION_PATTERN})\s+(?:named|called)\s+(${englishName})\s*[.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const englishInverse = new RegExp(
    String.raw`^\s*(${englishName})\s+(?:is|was)\s+my\s+(${ENGLISH_RELATION_PATTERN})\s*[.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const chineseExplicit = new RegExp(
    String.raw`^\s*我的\s*(${CHINESE_RELATION_PATTERN})\s*(?:名叫|名字是|姓名是)\s*(${chineseExplicitName})\s*[。.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const chineseInverse = new RegExp(
    String.raw`^\s*(${chineseExplicitName})\s*是我的\s*(${CHINESE_RELATION_PATTERN})\s*[。.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const chineseCalled = new RegExp(
    String.raw`^\s*我的\s*(${CHINESE_RELATION_PATTERN})\s*叫\s*(${latinName})\s*[。.!?]?\s*$`,
    "u",
  ).exec(utterance);
  const relationType = (
    english?.[1] ??
    englishHave?.[1] ??
    englishInverse?.[2] ??
    chineseExplicit?.[1] ??
    chineseInverse?.[2] ??
    chineseCalled?.[1]
  )
    ?.trim()
    .toLowerCase();
  const rawName =
    english?.[2] ??
    englishHave?.[2] ??
    englishInverse?.[1] ??
    chineseExplicit?.[2] ??
    chineseInverse?.[1] ??
    chineseCalled?.[2];
  const object = projectBeliefObject(rawName?.replace(/^["']|["']$/gu, ""));
  if (!relationType || !object) return null;
  if (humanRelationType(relationType) && !stableNamedPersonSubject(object)) return null;
  return {
    kind: "fact",
    content: text,
    confidence: 0.66,
    predicate: "person.relation",
    object,
    cardinality: "multi",
    ...personSubjectFieldsForFirstPerson(text, metadata),
    metadata: { rule: "first_person_named_relation", relationType },
  };
}

function firstPersonNamedRelation(text: string): boolean {
  return firstPersonNamedRelationCandidate(text) !== null;
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
    /^(?:这个|那个|的|我|我的|我们|我们的|你|你的|你们|你们的|您|您的|他|他的|他们|他们的|她|她的|她们|她们的|它|它的|它们|它们的|其|该|此|一个|某个|某|某些|一些|任一|任何|新|当前|已有|其他|旧|下个|上个|同一个)$/u.test(
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

  const personPreference = firstPersonPreferenceCandidate(text, metadata);
  if (personPreference) return [personPreference];

  const preferenceUtterance = stripSpeakerPrefix(text);
  if (
    /我喜欢|我最喜欢|我偏好|我更喜欢/u.test(preferenceUtterance) ||
    /\b(?:I prefer|I like|my favorite|my preference is)\b/iu.test(preferenceUtterance)
  ) {
    if (stableSpeakerPrefixedFirstPersonPreference(text) || metadataSpeakerFirstPersonPreference(text, metadata)) {
      return [];
    }
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

  const attributeCandidate = firstPersonAttributeCandidate(text, metadata);
  if (attributeCandidate) return [attributeCandidate];
  const firstPersonEvent = firstPersonEventCandidate(text, metadata);
  if (firstPersonEvent) return [firstPersonEvent];
  if (malformedFirstPersonStructuredAttribute(text)) return [];
  if (nonSpeakerPrefixedFirstPersonToolUse(text)) return [];
  if (/^\s*my\s+(?:current\s+)?(?:role|job|profession|title)\s+(?:is|=)\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*I\s+work\s+as\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*I\s+(?:currently\s+)?live\s+in\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*I(?:'m|’m| am)\s+from\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*my\s+(?:birth\s+date|birthdate|birthday|date\s+of\s+birth)\s+(?:is|=)\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*my\s+(?:full\s+)?name\s+(?:is|=)\s+(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (/^\s*I\s+was\s+born\s+in\s+(?:(?:an?|the)\s+)?(?:not|unknown|none|n\/a)\b/iu.test(stripSpeakerPrefix(text))) return [];
  if (nonNameCalledRelation(stripSpeakerPrefix(text))) return [];
  const personToolCandidate = namedPersonToolCandidate(text, metadata);
  if (personToolCandidate) return [personToolCandidate];
  const personPreferenceCandidate = namedPersonPreferenceCandidate(text, metadata);
  if (personPreferenceCandidate) return [personPreferenceCandidate];
  const personCurrentAttributeCandidate = namedPersonCurrentAttributeCandidate(text, metadata);
  if (personCurrentAttributeCandidate) return [personCurrentAttributeCandidate];
  const personStableAttributeCandidate = namedPersonStableAttributeCandidate(text, metadata);
  if (personStableAttributeCandidate) return [personStableAttributeCandidate];
  const personDirectAttributeCandidate = namedPersonDirectAttributeCandidate(text, metadata);
  if (personDirectAttributeCandidate) return [personDirectAttributeCandidate];
  const personRelationCandidate = namedPersonRelationCandidate(text, metadata);
  if (personRelationCandidate) return [personRelationCandidate];
  if (looksLikeNamedPersonRelationUtterance(text)) return [];
  const personEventCandidate = namedPersonEventCandidate(text, metadata);
  if (personEventCandidate) return [personEventCandidate];
  if (rejectedNamedPersonEventPrefixUtterance(text, metadata)) return [];

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

  if (/^\s*(?:我(?:是|在|有)|我的|my\s+name\s+is\b|I\s+am\b|I\s+work\b|I\s+live\b|I\s+was\s+born\b)/iu.test(stripSpeakerPrefix(text))) {
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
      if (
        nonPersonSpeakerCandidate(
          input.extractionInput.event.metadata,
          input.extractionInput.event.content,
        ) ||
        candidateSpeakerIsNonPerson(result.candidate)
      ) {
        rejected.push(rejectDecision(rawCandidate, "non_person_speaker"));
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
