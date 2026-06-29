import type {
  MemoryAssociationRecord,
  MemoryKind,
  MemoryRecord,
  WorldBeliefRecord,
} from "./types.js";
import { stableNamedPersonSubject } from "./extraction.js";
import { normalizeExplicitTemporalInstant } from "./temporal-validity.js";

export type AssociationCueKind = MemoryAssociationRecord["cueKind"];

export interface AssociationCue {
  cue: string;
  cueKind: AssociationCueKind;
}

export interface TaskTrajectoryAssociationSource {
  id: string;
  profileId: string;
  taskId?: string | null | undefined;
  objective: string;
  status: "completed" | "failed";
  summary?: string | null | undefined;
  createdAt: string;
}

const STOP_TERMS = new Set([
  "the",
  "and",
  "for",
  "to",
  "in",
  "of",
  "on",
  "at",
  "from",
  "by",
  "as",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "with",
  "you",
  "your",
  "what",
  "when",
  "where",
  "how",
  "this",
  "that",
  "about",
  "mention",
  "mentioned",
  "现在",
  "什么",
  "怎么",
  "那个",
  "这个",
  "之前",
  "上次",
  "应该",
  "可以",
  "一下",
]);

const PRIORITY_TERMS = new Set([
  "项目",
  "计划",
  "边界",
  "偏好",
  "流程",
  "步骤",
  "下一步",
  "报告",
  "复现",
  "实现",
  "风险",
  "发布",
  "任务",
  "目标",
  "answer",
]);

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 2 || STOP_TERMS.has(normalized) || seen.has(normalized)) continue;
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

export function extractAssociationCues(text: string, max = 32): AssociationCue[] {
  const lexical = [
    ...(text.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_-]{1,}/gu) ?? []),
    ...hanFragments(text),
  ];
  const entities = text.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g) ?? [];
  const cues = [
    ...unique(entities).map((cue) => ({ cue, cueKind: "entity" as const })),
    ...unique(lexical).map((cue) => ({ cue, cueKind: "lexical" as const })),
  ];
  return cues
    .sort((a, b) => {
      const entity = Number(b.cueKind === "entity") - Number(a.cueKind === "entity");
      if (entity !== 0) return entity;
      const priority = Number(PRIORITY_TERMS.has(b.cue)) - Number(PRIORITY_TERMS.has(a.cue));
      if (priority !== 0) return priority;
      return b.cue.length - a.cue.length;
    })
    .slice(0, max);
}

function normalizedMetadataValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function metadataDisplayValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function entityAliases(metadata: Record<string, unknown>): string[] {
  const entity = metadata.entityResolution;
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) return [];
  return metadataStringArray(entity as Record<string, unknown>, "aliases");
}

function entitySubjectCues(metadata: Record<string, unknown>): string[] {
  const predicate = normalizedMetadataValue(metadata, "predicate") ?? "";
  if (!predicate.startsWith("person.")) return [];
  const subject = normalizedMetadataValue(metadata, "subject");
  const subjectValue = subject?.match(/^person\s*[:/]\s*(.+)$/iu)?.[1] ?? subject ?? "";
  return unique([subjectValue, ...metadataStringArray(metadata, "subjectAliases")]);
}

export function sourceContentEntityCues(content: string): string[] {
  const namePattern = String.raw`\p{Lu}[\p{L}0-9_-]{1,30}(?:[ '-]\p{Lu}[\p{L}0-9_-]{1,30}){0,2}`;
  const patterns = [
    new RegExp(String.raw`^\s*(${namePattern})\s+uses\s+.{2,80}?\s+for\s+.{2,80}?\s*\.?\s*$`, "u"),
    new RegExp(
      String.raw`^\s*(${namePattern})[’']s\s+(?:preferred\s+)?(?:[\p{L}\p{N}_ -]{0,60}\s+)?tool\s+(?:is|=)\s+.{1,80}?\s*\.?\s*$`,
      "iu",
    ),
  ];
  for (const pattern of patterns) {
    const name = pattern.exec(content)?.[1]?.trim();
    if (name && stableNamedPersonSubject(name)) return [name];
  }
  return [];
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
  if (!sourceMetadata || typeof sourceMetadata !== "object" || Array.isArray(sourceMetadata)) return subjectCues;
  const record = sourceMetadata as Record<string, unknown>;
  return unique([
    ...subjectCues,
    normalizedMetadataValue(record, "speaker") ?? "",
    ...metadataStringArray(record, "speakerAliases"),
  ]);
}

export function associationTagsForMemory(memory: MemoryRecord): string[] {
  const tags = [
    memory.kind,
    memory.scope !== "global" ? memory.scope : "",
    normalizedMetadataValue(memory.metadata, "actionPolicyKind") ?? "",
    normalizedMetadataValue(memory.metadata, "predicate") ?? "",
    memory.kind === "boundary" ? "do_not_push" : "",
  ];
  return unique(tags);
}

export function associationCuesForMemory(memory: MemoryRecord): AssociationCue[] {
  return [
    ...sourceMetadataEntityCues(memory.metadata).map((cue) => ({ cue, cueKind: "entity" as const })),
    ...sourceContentEntityCues(memory.content).map((cue) => ({ cue, cueKind: "entity" as const })),
    ...metadataTemporalCues(memory.metadata).map((cue) => ({ cue, cueKind: "temporal" as const })),
    { cue: memory.kind, cueKind: "kind" },
    ...(memory.scope !== "global" ? [{ cue: memory.scope, cueKind: "scope" as const }] : []),
    ...extractAssociationCues(memory.content),
  ];
}

export function associationTagsForBelief(belief: WorldBeliefRecord): string[] {
  return unique([belief.predicate, "world_belief"]);
}

export function associationCuesForBelief(belief: WorldBeliefRecord): AssociationCue[] {
  const qualifiers = [
    belief.predicate === "person.relation"
      ? (metadataDisplayValue(belief.metadata, "relationType") ?? "")
      : "",
    metadataDisplayValue(belief.metadata, "toolPurpose") ?? "",
    metadataDisplayValue(belief.metadata, "toolScope") ?? "",
  ];
  return [
    ...sourceMetadataEntityCues(belief.metadata).map((cue) => ({ cue, cueKind: "entity" as const })),
    ...metadataTemporalCues(belief.metadata).map((cue) => ({ cue, cueKind: "temporal" as const })),
    { cue: belief.predicate, cueKind: "predicate" },
    ...extractAssociationCues(
      [belief.subject, ...entityAliases(belief.metadata), belief.object, ...qualifiers].join(" "),
    ),
  ];
}

export function associationSummaryForBelief(belief: WorldBeliefRecord): string {
  return [
    belief.subject,
    belief.predicate,
    belief.object,
    belief.predicate === "person.relation"
      ? (metadataDisplayValue(belief.metadata, "relationType") ?? "")
      : "",
    metadataDisplayValue(belief.metadata, "toolPurpose") ?? "",
    metadataDisplayValue(belief.metadata, "toolScope") ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function associationTagsForTaskTrajectory(
  trajectory: TaskTrajectoryAssociationSource,
): string[] {
  return unique(["task_trajectory", trajectory.status, trajectory.taskId ?? ""]);
}

export function associationCuesForTaskTrajectory(
  trajectory: TaskTrajectoryAssociationSource,
): AssociationCue[] {
  return [
    { cue: trajectory.status, cueKind: "task" },
    ...(trajectory.taskId ? [{ cue: trajectory.taskId, cueKind: "task" as const }] : []),
    ...extractAssociationCues(`${trajectory.objective} ${trajectory.summary ?? ""}`),
  ];
}

export function memoryTargetKind(kind: MemoryKind): string {
  return kind;
}
