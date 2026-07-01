import {
  classifySensitivity,
  redactForReport,
  sanitizeEvidenceForPublicOutput,
  sanitizePublicPayloadRecord,
  sanitizePublicSourceMetadata,
  stripGmosOwnedMetadataFields,
} from "../kernel/safety.js";
import type {
  EvidenceEvent,
  MemoryExtractionCandidateSnapshot,
  MemoryExtractionReport,
  MemorySensitivityClassifier,
  MemorySensitivityClassifierInput,
  Sensitivity,
} from "../kernel/types.js";

export type RuntimeSensitivityClassifier = (
  value: string,
  surface: MemorySensitivityClassifierInput["surface"],
) => Sensitivity;

function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  if (left === "secret_like" || right === "secret_like") return "secret_like";
  if (left === "sensitive" || right === "sensitive") return "sensitive";
  return "normal";
}

function validSensitivity(value: unknown): value is Sensitivity {
  return value === "normal" || value === "sensitive" || value === "secret_like";
}

function runtimePayloadStringSensitivity(
  value: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  surface: MemorySensitivityClassifierInput["surface"],
): Sensitivity {
  const primary = classifyRuntimeSensitivity(value, surface);
  return surface === "metadata"
    ? primary
    : maxSensitivity(primary, classifyRuntimeSensitivity(value, "metadata"));
}

export function runtimeSensitivityClassifier(
  classifier: MemorySensitivityClassifier | undefined,
): RuntimeSensitivityClassifier {
  return (value, surface) => {
    const builtin = classifySensitivity(value);
    if (!classifier) return builtin;
    try {
      const classified =
        typeof classifier === "function"
          ? classifier({ value, surface })
          : classifier.classify({ value, surface });
      return validSensitivity(classified) ? maxSensitivity(builtin, classified) : builtin;
    } catch {
      return builtin;
    }
  };
}

export function runtimeValueSensitivity(
  value: unknown,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  seen = new WeakSet<object>(),
  surface: MemorySensitivityClassifierInput["surface"] = "metadata",
  surfaceForKey: RuntimePayloadSurfaceForKey = runtimeMetadataSurfaceForKey,
): Sensitivity {
  if (typeof value === "string") {
    return runtimePayloadStringSensitivity(value, classifyRuntimeSensitivity, surface);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return "normal";
  if (Array.isArray(value)) {
    return value.reduce<Sensitivity>(
      (current, entry) =>
        maxSensitivity(
          current,
          runtimeValueSensitivity(
            entry,
            classifyRuntimeSensitivity,
            seen,
            surface,
            surfaceForKey,
          ),
        ),
      "normal",
    );
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "sensitive";
    seen.add(value);
    let sensitivity: Sensitivity = "normal";
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      sensitivity = maxSensitivity(sensitivity, classifyRuntimeSensitivity(key, "metadata"));
      const childSurface = surfaceForKey(key, surface);
      sensitivity = maxSensitivity(
        sensitivity,
        runtimeValueSensitivity(
          child,
          classifyRuntimeSensitivity,
          seen,
          childSurface,
          surfaceForKey,
        ),
      );
      if (sensitivity === "secret_like") break;
    }
    seen.delete(value);
    return sensitivity;
  }
  return "sensitive";
}

function redactRuntimeString(
  value: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  surface: MemorySensitivityClassifierInput["surface"] = "metadata",
): string {
  const sensitivity = classifyRuntimeSensitivity(value, surface);
  if (sensitivity === "normal") return value;
  const redacted = redactForReport(value);
  if (redacted !== value) return redacted;
  return sensitivity === "secret_like" ? "[redacted_secret]" : "[redacted_sensitive]";
}

export function redactRuntimePayloadString(
  value: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  surface: MemorySensitivityClassifierInput["surface"],
): string {
  const sensitivity = runtimePayloadStringSensitivity(
    value,
    classifyRuntimeSensitivity,
    surface,
  );
  if (sensitivity === "normal") return value;
  const redacted = redactForReport(value);
  if (redacted !== value) return redacted;
  return sensitivity === "secret_like" ? "[redacted_secret]" : "[redacted_sensitive]";
}

type RuntimePayloadSurfaceForKey = (
  key: string,
  currentSurface: MemorySensitivityClassifierInput["surface"],
) => MemorySensitivityClassifierInput["surface"];

function runtimeMetadataSurfaceForKey(
  key: string,
  currentSurface: MemorySensitivityClassifierInput["surface"],
): MemorySensitivityClassifierInput["surface"] {
  return key === "speaker" ||
    key === "speakerId" ||
    key === "speakerAliases" ||
    key === "entityMentions" ||
    key === "participants"
    ? "speaker"
    : currentSurface;
}

function sanitizeRuntimePayloadValue(
  value: unknown,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  seen = new WeakSet<object>(),
  surface: MemorySensitivityClassifierInput["surface"] = "metadata",
  surfaceForKey?: RuntimePayloadSurfaceForKey | undefined,
): unknown {
  if (typeof value === "string") {
    return redactRuntimePayloadString(value, classifyRuntimeSensitivity, surface);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeRuntimePayloadValue(entry, classifyRuntimeSensitivity, seen, surface, surfaceForKey)
    );
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[redacted_sensitive]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (classifyRuntimeSensitivity(key, "metadata") === "secret_like") continue;
      output[key] = sanitizeRuntimePayloadValue(
        child,
        classifyRuntimeSensitivity,
        seen,
        surfaceForKey ? surfaceForKey(key, surface) : "metadata",
        surfaceForKey,
      );
    }
    seen.delete(value);
    return output;
  }
  return "[redacted_sensitive]";
}

function sanitizeRuntimePayloadRecord(
  metadata: Record<string, unknown> | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Record<string, unknown> {
  const sanitized = sanitizePublicPayloadRecord(metadata ?? {});
  return redactRuntimePayloadRecord(sanitized, classifyRuntimeSensitivity);
}

export function redactRuntimePayloadRecord(
  metadata: Record<string, unknown> | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Record<string, unknown> {
  const output = sanitizeRuntimePayloadValue(
    metadata ?? {},
    classifyRuntimeSensitivity,
    new WeakSet<object>(),
    "metadata",
    runtimeMetadataSurfaceForKey,
  );
  return output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {};
}

export function redactRuntimeSourceMetadataRecord(
  metadata: Record<string, unknown> | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Record<string, unknown> {
  const output = sanitizeRuntimePayloadValue(
    sanitizePublicSourceMetadata(metadata),
    classifyRuntimeSensitivity,
    new WeakSet<object>(),
    "metadata",
    runtimeMetadataSurfaceForKey,
  );
  return output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {};
}

export function sanitizeRuntimeEvidenceForPublicOutput(
  evidence: EvidenceEvent,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): EvidenceEvent {
  const publicEvidence = sanitizeEvidenceForPublicOutput(evidence);
  const contentSensitivity = classifyRuntimeSensitivity(evidence.content, "content");
  return {
    ...publicEvidence,
    id: redactRuntimePayloadString(publicEvidence.id, classifyRuntimeSensitivity, "metadata"),
    eventKey: redactRuntimePayloadString(
      publicEvidence.eventKey,
      classifyRuntimeSensitivity,
      "metadata",
    ),
    profileId: redactRuntimePayloadString(
      publicEvidence.profileId,
      classifyRuntimeSensitivity,
      "metadata",
    ),
    sourceType: redactRuntimePayloadString(
      publicEvidence.sourceType,
      classifyRuntimeSensitivity,
      "metadata",
    ),
    sourceUri: publicEvidence.sourceUri == null
      ? publicEvidence.sourceUri
      : redactRuntimePayloadString(
          publicEvidence.sourceUri,
          classifyRuntimeSensitivity,
          "metadata",
        ),
    content: redactRuntimeString(evidence.content, classifyRuntimeSensitivity, "content"),
    sensitivity: maxSensitivity(publicEvidence.sensitivity, contentSensitivity),
    payload: redactRuntimePayloadRecord(publicEvidence.payload, classifyRuntimeSensitivity),
  };
}

function redactRuntimeExtractionMetadataRecord(
  metadata: Record<string, unknown> | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Record<string, unknown> {
  const output = sanitizeRuntimePayloadValue(
    metadata ?? {},
    classifyRuntimeSensitivity,
    new WeakSet<object>(),
    "metadata",
    runtimeMetadataSurfaceForKey,
  );
  return output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {};
}

function redactRuntimeExtractionString(
  value: string | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  surface: MemorySensitivityClassifierInput["surface"],
): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = surface === "content"
    ? redactRuntimeString(value, classifyRuntimeSensitivity, surface)
    : redactRuntimePayloadString(value, classifyRuntimeSensitivity, surface);
  return redacted.trim().length > 0 ? redacted : undefined;
}

function redactRuntimeExtractionStringArray(
  values: readonly string[] | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  surface: MemorySensitivityClassifierInput["surface"],
): string[] | undefined {
  const output = (values ?? []).flatMap((value) => {
    const redacted = redactRuntimeExtractionString(value, classifyRuntimeSensitivity, surface);
    return redacted ? [redacted] : [];
  });
  return output.length > 0 ? output : undefined;
}

function sanitizeRuntimeExtractionCandidateSnapshot(
  candidate: MemoryExtractionCandidateSnapshot,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): MemoryExtractionCandidateSnapshot {
  const kind = redactRuntimeExtractionString(
    candidate.kind,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const predicate = redactRuntimeExtractionString(
    candidate.predicate,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const subject = redactRuntimeExtractionString(
    candidate.subject,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const subjectAliases = redactRuntimeExtractionStringArray(
    candidate.subjectAliases,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const speaker = redactRuntimeExtractionString(
    candidate.speaker,
    classifyRuntimeSensitivity,
    "speaker",
  );
  const object = redactRuntimeExtractionString(
    candidate.object,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const source = redactRuntimeExtractionString(
    candidate.source,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const eventTime = redactRuntimeExtractionString(
    candidate.eventTime,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const validFrom = redactRuntimeExtractionString(
    candidate.validFrom,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const validTo = redactRuntimeExtractionString(
    candidate.validTo,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const cardinality = redactRuntimeExtractionString(
    candidate.cardinality,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const actionPolicyKind = redactRuntimeExtractionString(
    candidate.actionPolicyKind,
    classifyRuntimeSensitivity,
    "structured_candidate",
  );
  const metadata = redactRuntimeExtractionMetadataRecord(
    candidate.metadata,
    classifyRuntimeSensitivity,
  );
  return {
    ...(kind ? { kind } : {}),
    content: redactRuntimeString(candidate.content, classifyRuntimeSensitivity, "content"),
    ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
    ...(predicate ? { predicate } : {}),
    ...(subject ? { subject } : {}),
    ...(subjectAliases ? { subjectAliases } : {}),
    ...(speaker ? { speaker } : {}),
    ...(object ? { object } : {}),
    ...(source ? { source } : {}),
    ...(eventTime ? { eventTime } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    ...(cardinality ? { cardinality } : {}),
    ...(actionPolicyKind ? { actionPolicyKind } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function sanitizeRuntimeExtractionReport(
  report: MemoryExtractionReport,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): MemoryExtractionReport {
  return {
    ...report,
    decisions: report.decisions.map((decision) => ({
      ...decision,
      candidate: sanitizeRuntimeExtractionCandidateSnapshot(
        decision.candidate,
        classifyRuntimeSensitivity,
      ),
    })),
  };
}

export function sanitizeRuntimeExternalMemoryMetadata(
  metadata: Record<string, unknown> | undefined,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Record<string, unknown> {
  return stripGmosOwnedMetadataFields(
    sanitizeRuntimePayloadRecord(metadata, classifyRuntimeSensitivity),
  );
}
