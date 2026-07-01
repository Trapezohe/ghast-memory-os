import type { EvidenceEvent, PrivacyMode, Sensitivity } from "./types.js";

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

const REDACTED_METADATA = "[redacted_sensitive_metadata]";
const GMOS_OWNED_METADATA_KEYS = [
  "actionPolicyKind",
  "entityMentions",
  "entityResolution",
  "sourceMetadata",
  "subjectAliases",
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
]);

const PUBLIC_SOURCE_STRING_METADATA_KEYS = new Set([
  "speaker",
  "speakerKind",
  "speakerId",
  "sessionId",
  "sessionKey",
  "sourceId",
  "sourceUri",
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

export function sanitizeEvidenceForPublicOutput(evidence: EvidenceEvent): EvidenceEvent {
  return {
    ...evidence,
    id: redactForReport(evidence.id),
    eventKey: redactForReport(evidence.eventKey),
    profileId: redactForReport(evidence.profileId),
    sourceType: safePublicLabel(evidence.sourceType),
    sensitivity: safePublicSensitivity(evidence.sensitivity),
    sourceUri: evidence.sourceUri == null ? evidence.sourceUri : redactForReport(evidence.sourceUri),
    content: redactForReport(evidence.content),
    payload: sanitizePublicPayloadRecord(evidence.payload),
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
