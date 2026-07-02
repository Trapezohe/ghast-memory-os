import type {
  MemoryKind,
  MemoryLifecycleConfig,
  MemoryRecord,
  ResolvedMemoryLifecycleConfig,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MEMORY_HALF_LIVES_DAYS: Record<MemoryKind, number> = {
  fact: 180,
  preference: 365,
  project: 90,
  procedure: 365,
  task_trajectory: 45,
  boundary: 365,
  person: 365,
};

export const DEFAULT_AUTO_TRANSITION_KINDS: MemoryKind[] = [
  "fact",
  "preference",
  "project",
  "procedure",
  "task_trajectory",
];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function positiveDays(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function positiveStep(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return clamp(value, 0, 1);
}

function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function ageDays(anchor: string | null | undefined, now: string): number {
  const anchorInstant = parseInstant(anchor);
  const nowInstant = parseInstant(now);
  if (anchorInstant === null || nowInstant === null) return 0;
  return Math.max(0, (nowInstant - anchorInstant) / DAY_MS);
}

export function resolveMemoryLifecycleConfig(
  input: MemoryLifecycleConfig | undefined,
): ResolvedMemoryLifecycleConfig {
  const halfLivesDays: Record<MemoryKind, number> = { ...DEFAULT_MEMORY_HALF_LIVES_DAYS };
  for (const kind of Object.keys(DEFAULT_MEMORY_HALF_LIVES_DAYS) as MemoryKind[]) {
    halfLivesDays[kind] = positiveDays(input?.halfLivesDays?.[kind], halfLivesDays[kind]);
  }
  return {
    enabled: input?.enabled ?? true,
    halfLivesDays,
    dormantBelow: clamp(input?.dormantBelow ?? 0.25, 0, 1),
    archiveAfterDormantDays: positiveDays(input?.archiveAfterDormantDays, 180),
    autoTransitionKinds: input?.autoTransitionKinds?.length
      ? [...new Set(input.autoTransitionKinds)]
      : [...DEFAULT_AUTO_TRANSITION_KINDS],
    outcomeReinforcement: {
      enabled: input?.outcomeReinforcement?.enabled ?? true,
      step: positiveStep(input?.outcomeReinforcement?.step, 0.1),
    },
    feedbackConfidencePenalty: {
      enabled: input?.feedbackConfidencePenalty?.enabled ?? true,
      step: positiveStep(input?.feedbackConfidencePenalty?.step, 0.1),
      floor: clamp(input?.feedbackConfidencePenalty?.floor ?? 0.05, 0, 1),
    },
  };
}

export function memoryKindCanAutoTransition(
  kind: MemoryKind,
  config: ResolvedMemoryLifecycleConfig,
): boolean {
  return config.autoTransitionKinds.includes(kind);
}

export function retentionScore(
  memory: MemoryRecord,
  now: string,
  config: ResolvedMemoryLifecycleConfig,
): number {
  const halfLifeDays = positiveDays(
    config.halfLivesDays[memory.kind],
    DEFAULT_MEMORY_HALF_LIVES_DAYS[memory.kind],
  );
  const anchor = memory.lastRecalledAt ?? memory.updatedAt ?? memory.createdAt;
  const recency = Math.pow(0.5, ageDays(anchor, now) / halfLifeDays);
  const recall = clamp(
    Math.log1p(Math.max(0, memory.recallCount ?? 0)) / Math.log1p(20),
    0,
    1,
  );
  const confidence = clamp(memory.confidence, 0, 1);
  const reinforcement = (clamp(memory.reinforcement ?? 0, -1, 1) + 1) / 2;

  /*
   * Retention is a bounded weighted blend:
   * - recency uses exponential half-life decay from last recall, then updated_at, then created_at;
   * - recall_count is log-scaled so repeated use helps without making memories immortal;
   * - confidence carries extraction/store confidence;
   * - reinforcement maps [-1, 1] feedback into [0, 1].
   */
  return clamp(
    recency * 0.6 +
      confidence * 0.2 +
      recall * 0.1 +
      reinforcement * 0.1,
    0,
    1,
  );
}
