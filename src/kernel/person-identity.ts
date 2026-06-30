import { classifySensitivity } from "./safety.js";

export function isReservedSpeakerIdentity(name: string): boolean {
  const normalized = name.trim().replace(/\s+/gu, " ");
  return /^(?:current[-_ ]?user|user|self|me)$/iu.test(normalized);
}

export function stableNamedPersonSubject(name: string): boolean {
  const trimmed = name.trim().replace(/\s+/gu, " ");
  if (!trimmed) return false;
  if (isReservedSpeakerIdentity(trimmed)) return false;
  if (/^\[redacted_[a-z_]+\]$/iu.test(trimmed)) return false;
  if (classifySensitivity(trimmed) !== "normal") return false;
  if (trimmed.length > 120) return false;
  if (/^(?:https?:\/\/|mailto:)/iu.test(trimmed)) return false;
  if (/@/.test(trimmed)) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}
