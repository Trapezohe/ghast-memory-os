import type {
  MemoryAssociationCueKind,
  MemoryAssociationRecord,
  MemoryCue,
  MemoryKind,
  MemoryRecord,
  WorldBeliefRecord,
} from "./types.js";
import { entityMentionCues } from "./entities.js";
import { isReservedSpeakerIdentity } from "./person-identity.js";
import { classifySensitivity, sourceMetadataSpeakerIsPerson } from "./safety.js";
import { normalizeExplicitTemporalInstant } from "./temporal-validity.js";

export type AssociationCueKind = MemoryAssociationCueKind;
export type AssociationCue = MemoryCue;

export interface TaskTrajectoryAssociationSource {
  id: string;
  profileId: string;
  taskId?: string | null | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | null | undefined;
  createdAt: string;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 2 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function associationCueKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/_+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function associationCueMatchesQuery(cue: string, queryCues: Iterable<string>): boolean {
  const key = associationCueKey(cue);
  if (!key) return false;
  const queryKeys = new Set(
    [...queryCues].map((queryCue) => associationCueKey(queryCue)).filter(Boolean),
  );
  if (queryKeys.has(key)) return true;
  const parts = key.split("-").filter(Boolean);
  const queryParts = new Set([...queryKeys].flatMap((queryKey) => queryKey.split("-")));
  return parts.length > 1 && parts.every((part) => queryParts.has(part));
}

function hanFragments(text: string): string[] {
  const fragments: string[] = [];
  for (const match of text.matchAll(/\p{Script=Han}{2,}/gu)) {
    const run = match[0];
    if (run.length <= 8) fragments.push(run);
    for (const size of [2, 3, 4]) {
      for (let index = 0; index + size <= run.length; index += 1) {
        fragments.push(run.slice(index, index + size));
      }
    }
  }
  return fragments;
}

function cueInformationScore(cue: AssociationCue): number {
  const value = cue.cue.trim();
  if (!value) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (cue.cueKind === "entity") score += 20;
  if (cue.cueKind === "temporal") score += 18;
  if (cue.cueKind === "predicate" || cue.cueKind === "kind" || cue.cueKind === "scope") {
    score += 12;
  }
  if (cue.cueKind === "task") score += 10;
  score += Math.min([...value].length, 32) / 4;
  if (/\d/u.test(value)) score += 3;
  if (/[-_:/]/u.test(value)) score += 2;
  if (/[A-Z]/u.test(value) && /[a-z]/u.test(value)) score += 1.5;
  score += Math.min(new Set([...value.toLowerCase()]).size, 16) / 16;
  return score;
}

function uniqueAssociationCues(cues: AssociationCue[]): AssociationCue[] {
  const seen = new Set<string>();
  const result: AssociationCue[] = [];
  for (const cue of cues) {
    const key = associationCueKey(cue.cue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(cue);
  }
  return result;
}

export function extractAssociationCues(text: string, max = 32): AssociationCue[] {
  const lexical = [
    ...(text.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_-]{1,}/gu) ?? []),
    ...hanFragments(text),
  ];
  const entities = [
    ...(text.match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+\b/g) ?? []),
    ...(text.match(/\b[A-Z0-9]{2,}(?:[-_][A-Z0-9]+)*\b/g) ?? []),
    ...(text.match(/\b[A-Za-z0-9]+[-_][A-Za-z0-9_-]+\b/g) ?? []),
    ...(text.match(/\b[A-Za-z]*\d[A-Za-z0-9_-]*\b/g) ?? []),
    ...(text.match(/\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g) ?? []),
  ];
  const cues = [
    ...unique(entities).map((cue) => ({ cue, cueKind: "entity" as const })),
    ...unique(lexical).map((cue) => ({ cue, cueKind: "lexical" as const })),
  ];
  return uniqueAssociationCues(
    cues.sort((a, b) => {
      const information = cueInformationScore(b) - cueInformationScore(a);
      if (information !== 0) return information;
      return b.cue.length - a.cue.length;
    }),
  ).slice(0, max);
}

function normalizedMetadataValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function safeAssociationValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || /^\[redacted_[a-z_]+\]$/iu.test(trimmed)) return "";
  return classifySensitivity(trimmed) === "normal" ? trimmed : "";
}

function safeMetadataDisplayValue(metadata: Record<string, unknown>, key: string): string {
  return safeAssociationValue(metadata[key]);
}

function safeMetadataCueArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value.map(safeAssociationValue).filter(Boolean);
}

function sourceSpeakerCue(metadata: Record<string, unknown>): string {
  if (!sourceMetadataSpeakerIsPerson(metadata)) return "";
  const cue = safeAssociationValue(metadata.speaker);
  return cue && !isReservedSpeakerIdentity(cue) ? cue : "";
}

function sourceSpeakerAliasCues(metadata: Record<string, unknown>): string[] {
  if (!sourceMetadataSpeakerIsPerson(metadata)) return [];
  const value = metadata.speakerAliases;
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => safeAssociationValue(entry))
    .filter((cue) => cue && !isReservedSpeakerIdentity(cue));
}

function entityAliases(metadata: Record<string, unknown>): string[] {
  const entity = metadata.entityResolution;
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) return [];
  return safeMetadataCueArray(entity as Record<string, unknown>, "aliases");
}

function entitySubjectCues(metadata: Record<string, unknown>): string[] {
  const predicate = normalizedMetadataValue(metadata, "predicate") ?? "";
  if (!predicate.startsWith("person.")) return [];
  const subject = normalizedMetadataValue(metadata, "subject");
  const subjectValue = subject?.match(/^person\s*[:/]\s*(.+)$/iu)?.[1] ?? subject ?? "";
  return unique([
    safeAssociationValue(subjectValue),
    ...safeMetadataCueArray(metadata, "subjectAliases").filter((alias) => !isReservedSpeakerIdentity(alias)),
  ]);
}

function calendarDateCue(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? match[0]
    : null;
}

function temporalInstantCue(value: string): string | null {
  const trimmed = value.trim();
  return normalizeExplicitTemporalInstant(trimmed);
}

function clockTimeCue(value: string): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:\s*UTC)?$/iu.exec(value.trim());
  if (!match) return null;
  return match[3] ? `${match[1]}:${match[2]}:${match[3]}` : `${match[1]}:${match[2]}`;
}

function temporalMetadataCue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (key === "eventDate") return calendarDateCue(value);
  if (key === "eventTime" || key === "validFrom" || key === "validTo") {
    return temporalInstantCue(value) ?? (key === "eventTime" ? clockTimeCue(value) : null);
  }
  return null;
}

function metadataTemporalCues(metadata: Record<string, unknown>): string[] {
  return unique([
    temporalMetadataCue(metadata, "eventDate") ?? "",
    temporalMetadataCue(metadata, "eventTime") ?? "",
    temporalMetadataCue(metadata, "validFrom") ?? "",
    temporalMetadataCue(metadata, "validTo") ?? "",
  ]);
}

export function sourceMetadataEntityCues(metadata: Record<string, unknown>): string[] {
  const sourceMetadata = metadata.sourceMetadata;
  const subjectCues = entitySubjectCues(metadata);
  const mentionCues = entityMentionCues(metadata);
  const directSpeakerCues = [
    sourceSpeakerCue(metadata).toLowerCase(),
    ...sourceSpeakerAliasCues(metadata),
  ];
  if (!sourceMetadata || typeof sourceMetadata !== "object" || Array.isArray(sourceMetadata)) {
    return unique([...subjectCues, ...mentionCues, ...directSpeakerCues]);
  }
  const record = sourceMetadata as Record<string, unknown>;
  return unique([
    ...subjectCues,
    ...mentionCues,
    ...directSpeakerCues,
    sourceSpeakerCue(record).toLowerCase(),
    ...sourceSpeakerAliasCues(record),
  ]);
}

export function associationTagsForMemory(memory: MemoryRecord): string[] {
  const tags = [
    memory.kind,
    memory.scope !== "global" ? safeAssociationValue(memory.scope) : "",
    safeMetadataDisplayValue(memory.metadata, "actionPolicyKind"),
    safeMetadataDisplayValue(memory.metadata, "predicate"),
    memory.kind === "boundary" ? "do_not_push" : "",
  ];
  return unique(tags);
}

export function associationCuesForMemory(memory: MemoryRecord): AssociationCue[] {
  const scopeCue = memory.scope !== "global" ? safeAssociationValue(memory.scope) : "";
  return [
    ...sourceMetadataEntityCues(memory.metadata).map((cue) => ({ cue, cueKind: "entity" as const })),
    ...metadataTemporalCues(memory.metadata).map((cue) => ({ cue, cueKind: "temporal" as const })),
    { cue: memory.kind, cueKind: "kind" },
    ...(scopeCue ? [{ cue: scopeCue, cueKind: "scope" as const }] : []),
    ...extractAssociationCues(memory.content),
  ];
}

export function associationTagsForBelief(belief: WorldBeliefRecord): string[] {
  return unique([safeAssociationValue(belief.predicate), "world_belief"]);
}

export function associationCuesForBelief(belief: WorldBeliefRecord): AssociationCue[] {
  const predicateCue = safeAssociationValue(belief.predicate);
  const qualifiers = [
    belief.predicate === "person.relation"
      ? safeMetadataDisplayValue(belief.metadata, "relationType")
      : "",
    safeMetadataDisplayValue(belief.metadata, "toolPurpose"),
    safeMetadataDisplayValue(belief.metadata, "toolScope"),
  ];
  return [
    ...sourceMetadataEntityCues(belief.metadata).map((cue) => ({ cue, cueKind: "entity" as const })),
    ...metadataTemporalCues(belief.metadata).map((cue) => ({ cue, cueKind: "temporal" as const })),
    ...(predicateCue ? [{ cue: predicateCue, cueKind: "predicate" as const }] : []),
    ...extractAssociationCues(
      [
        safeAssociationValue(belief.subject),
        ...entityAliases(belief.metadata),
        safeAssociationValue(belief.object),
        ...qualifiers,
      ].join(" "),
    ),
  ];
}

export function associationSummaryForBelief(belief: WorldBeliefRecord): string {
  return [
    safeAssociationValue(belief.subject),
    safeAssociationValue(belief.predicate),
    safeAssociationValue(belief.object),
    belief.predicate === "person.relation"
      ? safeMetadataDisplayValue(belief.metadata, "relationType")
      : "",
    safeMetadataDisplayValue(belief.metadata, "toolPurpose"),
    safeMetadataDisplayValue(belief.metadata, "toolScope"),
  ]
    .filter(Boolean)
    .join(" ");
}

export function associationTagsForTaskTrajectory(
  trajectory: TaskTrajectoryAssociationSource,
): string[] {
  return unique(["task_trajectory", trajectory.status, safeAssociationValue(trajectory.taskId)]);
}

export function associationCuesForTaskTrajectory(
  trajectory: TaskTrajectoryAssociationSource,
): AssociationCue[] {
  const taskIdCue = safeAssociationValue(trajectory.taskId);
  return [
    { cue: trajectory.status, cueKind: "task" },
    ...(taskIdCue ? [{ cue: taskIdCue, cueKind: "task" as const }] : []),
    ...extractAssociationCues(`${trajectory.objective} ${trajectory.summary ?? ""}`),
  ];
}

export function memoryTargetKind(kind: MemoryKind): string {
  return kind;
}
