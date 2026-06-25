import type { PrivacyMode, Sensitivity } from "./types.js";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*\S{8,}/iu,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/u,
];

const SENSITIVE_PATTERNS = [
  /\bssn\b|\bsocial security\b/iu,
  /身份证|护照|银行卡|信用卡/u,
];

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
    .replace(
      /\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*\S+/giu,
      "$1=[redacted_secret]",
    );
}
