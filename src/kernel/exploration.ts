import { createHash } from "node:crypto";

import type {
  ActionPolicy,
  MemoryExplorationConfig,
  MemoryGapCandidate,
  MemoryGapKind,
  ResolvedMemoryExplorationConfig,
} from "./types.js";
import { safePublicInlineField } from "./safety.js";
import type { RecallDispositionPresetName } from "./disposition.js";

const DEFAULT_CURIOSITY_BUDGET = 1;
const DEFAULT_MAX_CANDIDATES_PER_RUN = 32;
const DEFAULT_MAX_CANDIDATES_PER_KIND = 8;
const DEFAULT_MIN_SCORE = 0.1;
const DEFAULT_RECENT_WINDOW_DAYS = 30;

function nonNegativeInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.trunc(value), maximum);
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function resolveMemoryExplorationConfig(
  input: MemoryExplorationConfig | undefined,
): ResolvedMemoryExplorationConfig {
  return {
    enabled: input?.enabled ?? true,
    curiosityBudget: nonNegativeInteger(input?.curiosityBudget, DEFAULT_CURIOSITY_BUDGET, 8),
    maxCandidatesPerRun: positiveInteger(
      input?.maxCandidatesPerRun,
      DEFAULT_MAX_CANDIDATES_PER_RUN,
      500,
    ),
    maxCandidatesPerKind: positiveInteger(
      input?.maxCandidatesPerKind,
      DEFAULT_MAX_CANDIDATES_PER_KIND,
      100,
    ),
    minScore: boundedNumber(input?.minScore, DEFAULT_MIN_SCORE, 0, 1),
    recentWindowDays: positiveInteger(input?.recentWindowDays, DEFAULT_RECENT_WINDOW_DAYS, 3650),
  };
}

export function memoryGapId(input: {
  profileId: string;
  kind: MemoryGapKind;
  subject: string;
  cue?: string | undefined;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      profileId: input.profileId,
      kind: input.kind,
      subject: input.subject.trim().toLowerCase(),
      cue: input.cue?.trim().toLowerCase() ?? "",
    }))
    .digest("hex")
    .slice(0, 24);
  return `gap_${digest}`;
}

export function curiosityBudgetForTurn(input: {
  configuredMax: number;
  requested?: number | undefined;
  dispositionPreset: RecallDispositionPresetName;
}): number {
  const presetBudget = input.dispositionPreset === "focused" ? 0 : 1;
  const requested =
    input.requested === undefined
      ? presetBudget
      : nonNegativeInteger(input.requested, presetBudget, input.configuredMax);
  return Math.min(input.configuredMax, requested);
}

function gapKindLabel(kind: MemoryGapKind): string {
  if (kind === "stale_belief") return "stale belief";
  if (kind === "contradiction_hotspot") return "contradiction hotspot";
  if (kind === "coverage_gap") return "coverage gap";
  return "decaying procedure";
}

export function curiosityPolicyText(candidate: MemoryGapCandidate): string {
  const lastKnown =
    typeof candidate.payload.lastKnown === "string"
      ? safePublicInlineField(candidate.payload.lastKnown)
      : "";
  const subject = safePublicInlineField(candidate.subject);
  const cue = candidate.cue ? ` cue=${safePublicInlineField(candidate.cue)}` : "";
  const known = lastKnown ? ` last_known=${lastKnown}` : "";
  return `Curiosity: subject=${subject}; gap=${gapKindLabel(candidate.kind)}${cue}${known}.`;
}

export function curiosityActionPolicy(candidate: MemoryGapCandidate): ActionPolicy {
  return {
    id: `policy_${candidate.id}`,
    kind: "curiosity",
    text: curiosityPolicyText(candidate),
    priority: 10,
    gapId: candidate.id,
    gapKind: candidate.kind,
    score: candidate.score,
    sourceIds: candidate.supportingRecordIds,
  };
}
