import {
  associationCueKey,
  associationCuesForTaskTrajectory,
  associationTagsForTaskTrajectory,
} from "./associations.js";
import { classifySensitivity, isPersonRoutedMemory } from "./safety.js";
import type {
  MemoryProcedureDistillationCandidate,
  MemoryProcedureDistillationCluster,
  MemoryProcedureDistillationConfig,
  ResolvedMemoryProcedureDistillationConfig,
  TaskTrajectoryRecord,
} from "./types.js";

const DEFAULT_MIN_REPEATS = 3;
const DEFAULT_MAX_CLUSTERS_PER_RUN = 10;
const DEFAULT_MAX_TRAJECTORIES_PER_CLUSTER = 8;
const MAX_TRAJECTORY_SNAPSHOT_TEXT_LENGTH = 1000;
export const MAX_PROCEDURE_DISTILLATION_CONTENT_LENGTH = 2000;

export interface ProcedureDistillationCandidateDecision {
  candidate: MemoryProcedureDistillationCandidate;
  normalized: {
    content: string;
    confidence: number;
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : fallback;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function boundedText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_TRAJECTORY_SNAPSHOT_TEXT_LENGTH);
}

export function resolveMemoryProcedureDistillationConfig(
  input: MemoryProcedureDistillationConfig | undefined,
): ResolvedMemoryProcedureDistillationConfig {
  return {
    enabled: input?.enabled ?? true,
    minRepeats: positiveInteger(input?.minRepeats, DEFAULT_MIN_REPEATS),
    maxClustersPerRun: positiveInteger(input?.maxClustersPerRun, DEFAULT_MAX_CLUSTERS_PER_RUN),
    maxTrajectoriesPerCluster: positiveInteger(
      input?.maxTrajectoriesPerCluster,
      DEFAULT_MAX_TRAJECTORIES_PER_CLUSTER,
    ),
  };
}

export function normalizedProcedureObjective(objective: string): string {
  return objective
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function objectiveTokenSet(objective: string): string[] {
  return uniqueSorted(
    normalizedProcedureObjective(objective)
      .split(/[^\p{L}\p{N}]+/gu)
      .filter((token) => token.length > 0),
  );
}

function objectiveSignature(objective: string): string {
  const tokens = objectiveTokenSet(objective);
  return tokens.length > 0 ? `tokens:${tokens.join(" ")}` : `objective:${normalizedProcedureObjective(objective)}`;
}

function trajectoryOrder(left: TaskTrajectoryRecord, right: TaskTrajectoryRecord): number {
  const signature = objectiveSignature(left.objective).localeCompare(
    objectiveSignature(right.objective),
  );
  if (signature !== 0) return signature;
  const objective = normalizedProcedureObjective(left.objective).localeCompare(
    normalizedProcedureObjective(right.objective),
  );
  if (objective !== 0) return objective;
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  return left.id.localeCompare(right.id);
}

function clusterKey(input: {
  signature: string;
  sourceTrajectoryIds: string[];
}): string {
  return [input.signature, ...input.sourceTrajectoryIds].join("\n");
}

function sharedTagsForTrajectories(trajectories: TaskTrajectoryRecord[]): string[] {
  if (trajectories.length === 0) return [];
  const [first, ...rest] = trajectories.map((trajectory) =>
    uniqueSorted([
      ...associationTagsForTaskTrajectory(trajectory),
      ...associationCuesForTaskTrajectory(trajectory)
        .map((cue) => associationCueKey(cue.cue))
        .filter((cue) => cue.length >= 3),
    ])
  );
  let shared = new Set(first);
  for (const tags of rest) {
    const tagSet = new Set(tags);
    shared = new Set([...shared].filter((tag) => tagSet.has(tag)));
  }
  return uniqueSorted([...shared]).slice(0, 16);
}

function safeCompletedTrajectory(trajectory: TaskTrajectoryRecord): boolean {
  if (trajectory.status !== "completed") return false;
  return classifySensitivity(`${trajectory.objective} ${trajectory.summary ?? ""}`) !== "secret_like";
}

export function selectProcedureDistillationClusters(
  trajectories: TaskTrajectoryRecord[],
  config: ResolvedMemoryProcedureDistillationConfig,
  alreadyDistilledClusterKeys: ReadonlySet<string> = new Set(),
): MemoryProcedureDistillationCluster[] {
  if (!config.enabled) return [];
  const groups = new Map<string, TaskTrajectoryRecord[]>();
  for (const trajectory of trajectories.filter(safeCompletedTrajectory).sort(trajectoryOrder)) {
    const signature = objectiveSignature(trajectory.objective);
    const entries = groups.get(signature) ?? [];
    entries.push(trajectory);
    groups.set(signature, entries);
  }
  const clusters: MemoryProcedureDistillationCluster[] = [];
  for (const [signature, group] of [...groups.entries()].sort((left, right) =>
    left[0].localeCompare(right[0])
  )) {
    if (group.length < config.minRepeats) continue;
    const members = group
      .sort((left, right) => {
        const created = left.createdAt.localeCompare(right.createdAt);
        if (created !== 0) return created;
        return left.id.localeCompare(right.id);
      })
      .slice(0, config.maxTrajectoriesPerCluster);
    const key = clusterKey({
      signature,
      sourceTrajectoryIds: members.map((trajectory) => trajectory.id).sort((left, right) =>
        left.localeCompare(right)
      ),
    });
    if (alreadyDistilledClusterKeys.has(key)) continue;
    clusters.push({
      objective: boundedText(members[0]?.objective) ?? normalizedProcedureObjective(signature),
      sharedTags: sharedTagsForTrajectories(members),
      trajectories: members.map((trajectory) => ({
        id: trajectory.id,
        objective: boundedText(trajectory.objective) ?? "",
        status: trajectory.status,
        ...(boundedText(trajectory.summary) ? { summary: boundedText(trajectory.summary) } : {}),
        createdAt: trajectory.createdAt,
      })),
      clusterKey: key,
    });
    if (clusters.length >= config.maxClustersPerRun) break;
  }
  return clusters;
}

function normalizeOptionalField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeProcedureDistillationCandidate(
  candidate: MemoryProcedureDistillationCandidate,
): ProcedureDistillationCandidateDecision | { reason: string } {
  const content = normalizeOptionalField(candidate.content);
  if (!content) return { reason: "empty_content" };
  if (content.length > MAX_PROCEDURE_DISTILLATION_CONTENT_LENGTH) {
    return { reason: "content_too_long" };
  }
  if (classifySensitivity(content) === "secret_like") return { reason: "secret_like" };
  if (isPersonRoutedMemory(content)) return { reason: "person_routed" };
  return {
    candidate,
    normalized: {
      content,
      confidence: clamp(candidate.confidence ?? 0.7, 0, 1),
    },
  };
}
