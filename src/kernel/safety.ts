import type { EvidenceEvent, PrivacyMode, Sensitivity } from "./types.js";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*\S{8,}/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/iu,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/u,
];

const SENSITIVE_PATTERNS = [
  /\bssn\b|\bsocial security\b/iu,
  /\b\d{3}-\d{2}-\d{4}\b/u,
  /身份证|护照|银行卡|信用卡/u,
];

const SENSITIVE_METADATA_KEYS =
  /(^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|authentication|auth|cookie|credential|session|ssn|social[_-]?security)($|[_-])/iu;

const REDACTED_METADATA = "[redacted_sensitive_metadata]";

export function classifySensitivity(content: string): Sensitivity {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    return "secret_like";
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    return "sensitive";
  }
  return "normal";
}

export function eligibleForLongTermMemory(input: {
  content: string;
  privacyMode?: PrivacyMode | undefined;
}): boolean {
  if (input.privacyMode === "incognito") return false;
  return classifySensitivity(input.content) !== "secret_like";
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

export function redactForReport(content: string): string {
  return content
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[redacted_secret]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "Bearer [redacted_secret]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/gu, "[redacted_sensitive]")
    .replace(
      /\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*\S+/giu,
      "$1=[redacted_secret]",
    );
}

export function sanitizePublicPayload(value: unknown): unknown {
  return sanitizePayloadValue(value, undefined, new WeakSet()).value;
}

export function sanitizePublicPayloadRecord(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizePublicPayload(input);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return {};
  return sanitized as Record<string, unknown>;
}

export function payloadContainsRestrictedValue(value: unknown): boolean {
  return sanitizePayloadValue(value, undefined, new WeakSet()).redacted;
}

export function sanitizeEvidenceForPublicOutput(evidence: EvidenceEvent): EvidenceEvent {
  return {
    ...evidence,
    content:
      evidence.sensitivity === "normal" && classifySensitivity(evidence.content) === "normal"
        ? evidence.content
        : redactForReport(evidence.content),
    payload: sanitizePublicPayloadRecord(evidence.payload),
  };
}

function sanitizePayloadValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): { value: unknown; redacted: boolean; omit?: boolean } {
  if (key !== undefined && SENSITIVE_METADATA_KEYS.test(key)) {
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
