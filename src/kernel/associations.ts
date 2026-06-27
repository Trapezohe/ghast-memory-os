import type {
  MemoryAssociationRecord,
  MemoryKind,
  MemoryRecord,
  WorldBeliefRecord,
} from "./types.js";

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

function sourceMetadataEntityCues(metadata: Record<string, unknown>): string[] {
  const sourceMetadata = metadata.sourceMetadata;
  if (!sourceMetadata || typeof sourceMetadata !== "object" || Array.isArray(sourceMetadata)) {
    return [];
  }
  const record = sourceMetadata as Record<string, unknown>;
  return unique([
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
    { cue: memory.kind, cueKind: "kind" },
    ...(memory.scope !== "global" ? [{ cue: memory.scope, cueKind: "scope" as const }] : []),
    ...extractAssociationCues(memory.content),
  ];
}

export function associationTagsForBelief(belief: WorldBeliefRecord): string[] {
  return unique([belief.predicate, "world_belief"]);
}

export function associationCuesForBelief(belief: WorldBeliefRecord): AssociationCue[] {
  return [
    ...sourceMetadataEntityCues(belief.metadata).map((cue) => ({ cue, cueKind: "entity" as const })),
    { cue: belief.predicate, cueKind: "predicate" },
    ...extractAssociationCues(
      [belief.subject, ...entityAliases(belief.metadata), belief.object].join(" "),
    ),
  ];
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
