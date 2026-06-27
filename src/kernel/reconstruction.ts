import { extractAssociationCues } from "./associations.js";
import { sanitizeEvidenceForPublicOutput } from "./safety.js";
import { observedAtSegment } from "./temporal-format.js";
import type {
  EvidenceEvent,
  MemoryAssociationRecord,
  MemoryRecord,
  MemoryStore,
  ReconstructedContext,
  ReconstructedEvidencePath,
  ReconstructedPlannerBranch,
  ReconstructedPlannerStep,
  ReconstructedPlannerTrace,
  ReconstructContextInput,
  TurnMessage,
} from "./types.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function latestUserText(messages: TurnMessage[] | undefined): string {
  return [...(messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "";
}

function boundedInteger(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined) return fallback;
  return Math.max(min, Math.min(Math.trunc(input), max));
}

function boundedNumber(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.max(min, Math.min(input, max));
}

function pathFromAssociation(
  association: MemoryAssociationRecord,
  step: number,
  routeScore?: number | undefined,
  routeReason?: string | undefined,
): ReconstructedEvidencePath {
  return {
    id: association.id,
    step,
    cue: association.cue,
    tag: association.tag,
    targetType: association.targetType,
    targetId: association.targetId,
    targetKind: association.targetKind,
    targetSummary: association.targetSummary,
    confidence: association.confidence,
    routeScore,
    routeReason,
    sourceMemoryId: association.sourceMemoryId,
    sourceEvidenceId: association.sourceEvidenceId,
    createdAt: association.createdAt,
  };
}

function formatPathLine(path: ReconstructedEvidencePath, includeTemporalMetadata: boolean): string {
  const routeScore = path.routeScore !== undefined ? `; routeScore=${path.routeScore.toFixed(2)}` : "";
  const routeReason = path.routeReason ? `; reason=${path.routeReason}` : "";
  const informationGain =
    path.informationGain !== undefined ? `; gain=${path.informationGain.toFixed(2)}` : "";
  const temporalMetadata = includeTemporalMetadata ? observedAtSegment(path.createdAt) : "";
  return `- [step=${path.step}; cue=${path.cue}; tag=${path.tag}; kind=${path.targetKind ?? path.targetType}; confidence=${path.confidence.toFixed(2)}${routeScore}${informationGain}${temporalMetadata}${routeReason}] ${path.targetSummary}`;
}

function publicPath(
  path: ReconstructedEvidencePath,
  includeTemporalMetadata: boolean,
): ReconstructedEvidencePath {
  if (includeTemporalMetadata || path.createdAt === undefined) return path;
  const { createdAt: _createdAt, ...publicPathWithoutTemporalMetadata } = path;
  return publicPathWithoutTemporalMetadata;
}

interface ReconstructionIntent {
  expectedTags: Set<string>;
  requiredTagGroups: Array<{
    name: string;
    tags: Set<string>;
  }>;
  queryCues: Set<string>;
  reason: string;
}

interface FrontierCue {
  cue: string;
  priority: number;
  reason: string;
}

interface RankedAssociation {
  association: MemoryAssociationRecord;
  routeScore: number;
  routeReason: string;
}

interface RankedMemoryCandidate {
  memory: MemoryRecord;
  routeScore: number;
  routeReason: string;
}

function normalizedText(value: string): string {
  return value.toLowerCase();
}

function queryCueSet(query: string): Set<string> {
  return new Set(extractAssociationCues(query, 48).map((cue) => cue.cue));
}

function includesAny(text: string, needles: string[]): boolean {
  const normalized = normalizedText(text);
  return needles.some((needle) => normalized.includes(normalizedText(needle)));
}

type ReconstructionEvidenceCoverage = NonNullable<
  ReconstructedContext["stats"]["evidenceCoverage"]
>;

type ReconstructionUncertainty = NonNullable<ReconstructedContext["stats"]["uncertainty"]>;

type ReconstructionEvidenceConvergence = NonNullable<
  ReconstructedContext["stats"]["evidenceConvergence"]
>;

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizedText(value.trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function traceBranchFromPath(
  path: ReconstructedEvidencePath,
  decision: ReconstructedPlannerBranch["decision"],
  reason: string,
  generatedCues: string[] = [],
): ReconstructedPlannerBranch {
  return {
    pathId: path.id,
    targetType: path.targetType,
    targetId: path.targetId,
    targetKind: path.targetKind,
    tag: path.tag,
    routeScore: path.routeScore,
    informationGain: path.informationGain,
    decision,
    reason,
    generatedCues,
  };
}

function stepCountForTrace(paths: ReconstructedEvidencePath[]): number {
  if (paths.length === 0) return 1;
  return Math.max(...paths.map((path) => path.step)) + 1;
}

function coverageCues(query: string): string[] {
  return uniqueStrings(extractAssociationCues(query, 16).map((cue) => cue.cue)).slice(0, 8);
}

function pathCoversCue(path: ReconstructedEvidencePath, cue: string): boolean {
  const normalizedCue = normalizedText(cue);
  return normalizedText(
    `${path.cue} ${path.tag} ${path.targetKind ?? ""} ${path.targetSummary}`,
  ).includes(normalizedCue);
}

function evidenceCoverageForPaths(
  query: string,
  paths: ReconstructedEvidencePath[],
): ReconstructionEvidenceCoverage {
  const cues = coverageCues(query);
  const coveredCues = cues.filter((cue) => paths.some((path) => pathCoversCue(path, cue)));
  const uncoveredCues = cues.filter((cue) => !coveredCues.includes(cue));
  const coverageRate =
    cues.length === 0 ? (paths.length > 0 ? 1 : 0) : coveredCues.length / cues.length;
  return {
    queryCueCount: cues.length,
    coveredCueCount: coveredCues.length,
    coverageRate,
    coveredCues,
    uncoveredCues,
  };
}

function uncertaintyForReconstruction(input: {
  coverage: ReconstructionEvidenceCoverage;
  memories: MemoryRecord[];
  paths: ReconstructedEvidencePath[];
  stopReason: ReconstructedContext["stats"]["stopReason"];
}): ReconstructionUncertainty {
  const reasons: string[] = [];
  if (input.paths.length === 0) reasons.push("no_evidence_path");
  if (input.memories.length === 0) reasons.push("no_memory_content");
  if (input.coverage.queryCueCount > 0 && input.coverage.coverageRate < 0.5) {
    reasons.push("low_query_cue_coverage");
  }
  if (input.stopReason === "budget_exhausted") reasons.push("budget_exhausted");
  if (input.stopReason === "no_frontier") reasons.push("frontier_exhausted");
  let level: ReconstructionUncertainty["level"] = "low";
  if (
    input.paths.length === 0 ||
    input.memories.length === 0 ||
    input.coverage.coverageRate < 0.25
  ) {
    level = "high";
  } else if (
    input.stopReason === "budget_exhausted" ||
    input.stopReason === "no_frontier" ||
    input.coverage.coverageRate < 0.75
  ) {
    level = "medium";
  }
  return { level, reasons };
}

function coverageIsSufficient(coverage: ReconstructionEvidenceCoverage): boolean {
  if (coverage.queryCueCount === 0) return coverage.coveredCueCount > 0;
  return (
    coverage.coverageRate >= 0.45 ||
    coverage.coveredCueCount >= Math.min(2, coverage.queryCueCount)
  );
}

function hasIntentEvidence(
  paths: ReconstructedEvidencePath[],
  intent: ReconstructionIntent,
): boolean {
  if (intent.requiredTagGroups.length > 0) {
    return intent.requiredTagGroups.every((group) =>
      paths.some((path) => pathMatchesTagGroup(path, group.tags)),
    );
  }
  return intent.expectedTags.size === 0 || paths.some((path) => pathMatchesIntent(path, intent));
}

function evidenceConvergenceForPaths(input: {
  coverage: ReconstructionEvidenceCoverage;
  memories: MemoryRecord[];
  paths: ReconstructedEvidencePath[];
  intent: ReconstructionIntent;
  threshold: number;
  targetMemoryCount: number;
  stopWhenEvidenceEnough: boolean;
  prunedBranchCount: number;
  frontierRemaining: number;
}): ReconstructionEvidenceConvergence {
  const intentMatched = hasIntentEvidence(input.paths, input.intent);
  const coveredRequiredIntentGroups = input.intent.requiredTagGroups.filter((group) =>
    input.paths.some((path) => pathMatchesTagGroup(path, group.tags)),
  );
  const missingRequiredIntentGroups = input.intent.requiredTagGroups
    .filter((group) => !coveredRequiredIntentGroups.includes(group))
    .map((group) => group.name);
  const targetMemoryCount = Math.max(1, input.targetMemoryCount);
  const memoryContentScore =
    input.memories.length > 0 ? Math.min(1, input.memories.length / targetMemoryCount) : 0;
  const pathSupportScore = input.paths.length > 0 ? Math.min(1, input.paths.length / 4) : 0;
  const intentScore = intentMatched ? 1 : 0;
  const memorySupportEnough =
    input.memories.length >= targetMemoryCount &&
    (input.intent.expectedTags.size === 0 ||
      input.memories.some((memory) => memoryMatchesIntent(memory, input.intent)));
  const pathOnlySupportEnough =
    input.memories.length === 0 && input.paths.length >= targetMemoryCount && intentMatched;
  const score = Math.min(
    1,
    input.coverage.coverageRate * 0.45 +
      intentScore * 0.3 +
      memoryContentScore * 0.2 +
      pathSupportScore * 0.05,
  );
  return {
    score,
    reached:
      score >= input.threshold &&
      (memorySupportEnough || pathOnlySupportEnough) &&
      intentMatched &&
      coverageIsSufficient(input.coverage),
    threshold: input.threshold,
    stopWhenEvidenceEnough: input.stopWhenEvidenceEnough,
    intentMatched,
    requiredIntentGroupCount: input.intent.requiredTagGroups.length,
    coveredIntentGroupCount: coveredRequiredIntentGroups.length,
    missingRequiredIntentGroups,
    prunedBranchCount: input.prunedBranchCount,
    frontierRemaining: input.frontierRemaining,
    selectedPathCount: input.paths.length,
    selectedTags: uniqueStrings(input.paths.map((path) => path.tag)).slice(0, 12),
  };
}

function inferReconstructionIntent(query: string): ReconstructionIntent {
  const expectedTags = new Set<string>();
  const requiredTagGroups: ReconstructionIntent["requiredTagGroups"] = [];
  const reasons: string[] = [];
  function addGroup(name: string, tags: string[]): void {
    const tagSet = new Set(tags);
    requiredTagGroups.push({ name, tags: tagSet });
    for (const tag of tagSet) expectedTags.add(tag);
  }
  if (
    includesAny(query, [
      "下一步",
      "先做",
      "怎么做",
      "步骤",
      "流程",
      "procedure",
      "next",
      "step",
      "should",
    ])
  ) {
    addGroup("procedure_or_next_step", [
      "procedure",
      "task_trajectory",
      "project.state",
      "world_belief",
    ]);
    reasons.push("procedure_or_next_step");
  }
  if (includesAny(query, ["当前", "现在", "状态", "current", "state", "status"])) {
    addGroup("current_state", ["project.state", "world_belief", "project", "task_trajectory"]);
    reasons.push("current_state");
  }
  if (includesAny(query, ["不要", "不能", "边界", "boundary", "avoid", "do not", "don't"])) {
    addGroup("boundary", ["boundary", "do_not_push"]);
    reasons.push("boundary");
  }
  if (includesAny(query, ["偏好", "喜欢", "习惯", "preference", "prefer"])) {
    addGroup("preference", ["preference"]);
    reasons.push("preference");
  }
  return {
    expectedTags,
    requiredTagGroups,
    queryCues: queryCueSet(query),
    reason: reasons.length > 0 ? reasons.join("+") : "associative",
  };
}

function seedFrontier(query: string, intent: ReconstructionIntent): FrontierCue[] {
  const cues = extractAssociationCues(query, 12);
  if (cues.length === 0) return [{ cue: query, priority: 1, reason: "raw_query" }];
  return cues.map((cue, index) => {
    let priority = 10 - index * 0.1;
    if (cue.cueKind === "entity") priority += 4;
    if (intent.expectedTags.has(cue.cue)) priority += 2;
    return {
      cue: cue.cue,
      priority,
      reason: cue.cueKind === "entity" ? "initial_entity_cue" : "initial_query_cue",
    };
  });
}

function enqueueFrontierCue(frontier: FrontierCue[], next: FrontierCue): void {
  const existing = frontier.find((item) => item.cue === next.cue);
  if (!existing) {
    frontier.push(next);
    if (frontier.length > 64) {
      frontier.sort((a, b) => b.priority - a.priority);
      frontier.length = 64;
    }
    return;
  }
  if (next.priority > existing.priority) {
    existing.priority = next.priority;
    existing.reason = next.reason;
  }
}

function associationMatchesIntent(
  association: MemoryAssociationRecord,
  intent: ReconstructionIntent,
): boolean {
  return (
    intent.expectedTags.has(association.tag) ||
    intent.expectedTags.has(association.targetKind) ||
    intent.expectedTags.has(`${association.targetKind}.${association.tag}`)
  );
}

function memoryMatchesIntent(memory: MemoryRecord, intent: ReconstructionIntent): boolean {
  const actionPolicyKind =
    typeof memory.metadata.actionPolicyKind === "string" ? memory.metadata.actionPolicyKind : "";
  return (
    intent.expectedTags.has(memory.kind) ||
    (actionPolicyKind.length > 0 && intent.expectedTags.has(actionPolicyKind)) ||
    (memory.kind === "boundary" && intent.expectedTags.has("do_not_push"))
  );
}

function pathMatchesIntent(path: ReconstructedEvidencePath, intent: ReconstructionIntent): boolean {
  return (
    intent.expectedTags.has(path.tag) ||
    (path.targetKind !== undefined && intent.expectedTags.has(path.targetKind)) ||
    (path.targetKind !== undefined && intent.expectedTags.has(`${path.targetKind}.${path.tag}`))
  );
}

function pathMatchesTagGroup(path: ReconstructedEvidencePath, tags: Set<string>): boolean {
  return (
    tags.has(path.tag) ||
    (path.targetKind !== undefined && tags.has(path.targetKind)) ||
    (path.targetKind !== undefined && tags.has(`${path.targetKind}.${path.tag}`))
  );
}

function reciprocalRankScore(rank: number): number {
  return 1 / (60 + rank);
}

function rankAssociation(
  association: MemoryAssociationRecord,
  cue: FrontierCue,
  intent: ReconstructionIntent,
): RankedAssociation {
  const reasons: string[] = [];
  let routeScore = cue.priority + association.confidence;
  if (associationMatchesIntent(association, intent)) {
    routeScore += 8;
    reasons.push(`intent:${intent.reason}`);
  }
  const searchable = normalizedText(
    `${association.cue} ${association.tag} ${association.targetKind} ${association.targetSummary}`,
  );
  let overlapCount = 0;
  for (const queryCue of intent.queryCues) {
    if (searchable.includes(normalizedText(queryCue))) overlapCount += 1;
  }
  if (overlapCount > 0) {
    routeScore += overlapCount * 0.75;
    reasons.push(`query_overlap:${overlapCount}`);
  }
  if (association.cue === cue.cue) {
    routeScore += 1.25;
    reasons.push("cue_exact");
  }
  if (association.targetType === "world_belief") {
    routeScore += 0.5;
    reasons.push("world_belief");
  }
  if (association.targetType === "task_trajectory") {
    routeScore += 0.5;
    reasons.push("task_trajectory");
  }
  if (association.targetKind === "fact" && intent.expectedTags.size > 0) {
    routeScore -= 0.25;
  }
  return {
    association,
    routeScore,
    routeReason: reasons.length > 0 ? reasons.join(",") : cue.reason,
  };
}

function rankDirectMemory(
  memory: MemoryRecord,
  rank: number,
  query: string,
  intent: ReconstructionIntent,
): RankedMemoryCandidate {
  const reasons = [`hybrid_direct_memory_rrf:${rank}`];
  let routeScore = memory.confidence + reciprocalRankScore(rank) * 100;
  if (memoryMatchesIntent(memory, intent)) {
    routeScore += 6;
    reasons.push(`intent:${intent.reason}`);
  }
  const searchable = normalizedText(`${memory.kind} ${memory.scope} ${memory.content}`);
  let overlapCount = 0;
  for (const queryCue of intent.queryCues) {
    if (searchable.includes(normalizedText(queryCue))) overlapCount += 1;
  }
  if (overlapCount > 0) {
    routeScore += overlapCount * 0.75;
    reasons.push(`query_overlap:${overlapCount}`);
  }
  if (includesAny(query, ["最近", "刚才", "上次", "latest", "recent", "last"])) {
    routeScore += 0.5;
    reasons.push("temporal_recent_hint");
  }
  return { memory, routeScore, routeReason: reasons.join(",") };
}

function pathFromDirectMemory(
  candidate: RankedMemoryCandidate,
  step: number,
  query: string,
): ReconstructedEvidencePath {
  return {
    id: `hybrid:${candidate.memory.id}`,
    step,
    cue: directMemoryCue(candidate.memory, query),
    tag: "hybrid_memory",
    targetType: "memory",
    targetId: candidate.memory.id,
    targetKind: candidate.memory.kind,
    targetSummary: candidate.memory.content,
    confidence: candidate.memory.confidence,
    routeScore: candidate.routeScore,
    routeReason: candidate.routeReason,
    informationGain: Math.max(0.1, candidate.memory.confidence),
    sourceMemoryId: candidate.memory.id,
    sourceEvidenceId: candidate.memory.sourceEventId,
    createdAt: candidate.memory.createdAt,
  };
}

function directMemoryCue(memory: MemoryRecord, query: string): string {
  const searchable = normalizedText(`${memory.kind} ${memory.scope} ${memory.content}`);
  for (const cue of coverageCues(query)) {
    if (searchable.includes(normalizedText(cue))) return cue;
  }
  return memory.kind;
}

function addRouteSignal(path: ReconstructedEvidencePath, score: number, reason: string): void {
  path.routeScore = (path.routeScore ?? path.confidence) + score;
  path.routeReason = path.routeReason ? `${path.routeReason},${reason}` : reason;
}

function informationGainForPath(input: {
  query: string;
  paths: ReconstructedEvidencePath[];
  path: ReconstructedEvidencePath;
  intent: ReconstructionIntent;
}): { gain: number; reasons: string[] } {
  const before = evidenceCoverageForPaths(input.query, input.paths);
  const after = evidenceCoverageForPaths(input.query, [...input.paths, input.path]);
  const coverageGain = Math.max(0, after.coverageRate - before.coverageRate);
  const coveredCueGain = Math.max(0, after.coveredCueCount - before.coveredCueCount);
  const newTarget = !input.paths.some(
    (path) =>
      path.targetType === input.path.targetType && path.targetId === input.path.targetId,
  );
  const newTag = !input.paths.some((path) => path.tag === input.path.tag);
  const intentMatched = pathMatchesIntent(input.path, input.intent);
  const reasons: string[] = [];
  let gain = input.path.confidence * 0.35;
  if (coverageGain > 0) {
    gain += coverageGain * 4;
    reasons.push(`coverage:${coverageGain.toFixed(2)}`);
  }
  if (coveredCueGain > 0) {
    gain += coveredCueGain * 1.2;
    reasons.push(`cue:${coveredCueGain}`);
  }
  if (intentMatched) {
    gain += 1.8;
    reasons.push("intent");
  }
  if (newTarget) {
    gain += 0.4;
    reasons.push("new_target");
  }
  if (newTag) {
    gain += 0.25;
    reasons.push("new_tag");
  }
  if (input.path.sourceEvidenceId) {
    gain += 0.1;
    reasons.push("evidence_backed");
  }
  return { gain, reasons: reasons.length > 0 ? reasons : ["low_new_information"] };
}

async function fuseDirectMemorySearch(input: {
  store: MemoryStore;
  profileId: string;
  query: string;
  intent: ReconstructionIntent;
  includeSensitive?: boolean | undefined;
  maxMemories: number;
  memories: MemoryRecord[];
  paths: ReconstructedEvidencePath[];
  seenMemoryIds: Set<string>;
}): Promise<{
  candidateCount: number;
  reinforcedPaths: ReconstructedEvidencePath[];
  selectedNewPaths: ReconstructedEvidencePath[];
}> {
  const directMemoryCandidates = await input.store.searchMemories({
    profileId: input.profileId,
    query: input.query,
    purpose: "context",
    includeSensitive: input.includeSensitive,
    limit: Math.min(input.maxMemories * 4, 48),
  });
  const rankedCandidates = directMemoryCandidates
    .map((memory, index) => rankDirectMemory(memory, index + 1, input.query, input.intent))
    .sort((a, b) => b.routeScore - a.routeScore);
  const reinforcedPaths: ReconstructedEvidencePath[] = [];
  const selectedNewPaths: ReconstructedEvidencePath[] = [];
  for (const candidate of rankedCandidates) {
    const existingPath = input.paths.find(
      (path) => path.targetType === "memory" && path.targetId === candidate.memory.id,
    );
    if (!existingPath) continue;
    if (!existingPath.routeReason?.includes("hybrid_direct_memory_rrf")) {
      addRouteSignal(existingPath, candidate.routeScore, candidate.routeReason);
      reinforcedPaths.push({ ...existingPath });
    }
  }
  const directStep = Math.max(
    1,
    input.paths.length === 0 ? 1 : Math.max(...input.paths.map((path) => path.step)) + 1,
  );
  for (const candidate of rankedCandidates) {
    if (input.memories.length >= input.maxMemories) break;
    if (input.seenMemoryIds.has(candidate.memory.id)) continue;
    input.seenMemoryIds.add(candidate.memory.id);
    input.memories.push(candidate.memory);
    const path = pathFromDirectMemory(candidate, directStep, input.query);
    input.paths.push(path);
    selectedNewPaths.push({ ...path });
  }
  return { candidateCount: rankedCandidates.length, reinforcedPaths, selectedNewPaths };
}

function composeReconstructedContext(input: {
  profileId: string;
  query: string;
  memories: MemoryRecord[];
  evidence: EvidenceEvent[];
  paths: ReconstructedEvidencePath[];
  intent: ReconstructionIntent;
  includeEvidence?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  stepCount: number;
  exploredCueCount: number;
  associationCount: number;
  prunedBranchCount: number;
  frontierRemaining: number;
  stopWhenEvidenceEnough: boolean;
  evidenceConvergenceThreshold: number;
  targetMemoryCount: number;
  stopReason: ReconstructedContext["stats"]["stopReason"];
  includeTemporalMetadata: boolean;
  plannerTrace?: ReconstructedPlannerTrace | undefined;
}): ReconstructedContext {
  const publicEvidence = input.includeEvidence
    ? input.evidence.map(sanitizeEvidenceForPublicOutput)
    : [];
  let memories = [...input.memories];
  let paths = [...input.paths];
  let evidence = [...publicEvidence];
  let coverage = evidenceCoverageForPaths(input.query, paths);
  let uncertainty = uncertaintyForReconstruction({
    coverage,
    memories,
    paths,
    stopReason: input.stopReason,
  });
  let evidenceConvergence = evidenceConvergenceForPaths({
    coverage,
    memories,
    paths,
    intent: input.intent,
    threshold: input.evidenceConvergenceThreshold,
    targetMemoryCount: input.targetMemoryCount,
    stopWhenEvidenceEnough: input.stopWhenEvidenceEnough,
    prunedBranchCount: input.prunedBranchCount,
    frontierRemaining: input.frontierRemaining,
  });
  const render = (): string => {
    coverage = evidenceCoverageForPaths(input.query, paths);
    uncertainty = uncertaintyForReconstruction({
      coverage,
      memories,
      paths,
      stopReason: input.stopReason,
    });
    evidenceConvergence = evidenceConvergenceForPaths({
      coverage,
      memories,
      paths,
      intent: input.intent,
      threshold: input.evidenceConvergenceThreshold,
      targetMemoryCount: input.targetMemoryCount,
      stopWhenEvidenceEnough: input.stopWhenEvidenceEnough,
      prunedBranchCount: input.prunedBranchCount,
      frontierRemaining: input.frontierRemaining,
    });
    const lines = [
      "<gmos-reconstructed-context>",
      `Query: ${input.query}`,
      `Evidence coverage: ${coverage.coveredCueCount}/${coverage.queryCueCount} cues (${coverage.coverageRate.toFixed(2)}); uncovered=${coverage.uncoveredCues.join(", ") || "none"}`,
      `Evidence convergence: score=${evidenceConvergence.score.toFixed(2)}; reached=${evidenceConvergence.reached}; threshold=${evidenceConvergence.threshold.toFixed(2)}; pruned=${evidenceConvergence.prunedBranchCount}; frontier=${evidenceConvergence.frontierRemaining}; stopWhenEvidenceEnough=${evidenceConvergence.stopWhenEvidenceEnough}`,
      `Reconstruction uncertainty: ${uncertainty.level}${uncertainty.reasons.length ? ` (${uncertainty.reasons.join(", ")})` : ""}`,
      "Reconstructed evidence paths:",
      ...paths.map((path) => formatPathLine(path, input.includeTemporalMetadata)),
      "Memory content:",
      ...memories.map(
        (memory) =>
          `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}${input.includeTemporalMetadata ? observedAtSegment(memory.createdAt) : ""}] ${memory.content}`,
      ),
    ];
    if (input.includeEvidence) {
      lines.push("Evidence:");
      lines.push(
        ...evidence.map(
          (event) =>
            `- [${event.sourceType}; ${event.sensitivity}; eligible=${event.eligibleForLongTermMemory}${input.includeTemporalMetadata ? observedAtSegment(event.createdAt) : ""}] ${event.content}`,
        ),
      );
    }
    lines.push("</gmos-reconstructed-context>");
    return lines.join("\n");
  };
  let contextBlock = render();
  const budget = input.contextBudgetTokens ?? 1800;
  while (estimateTokens(contextBlock) > budget && (memories.length > 0 || paths.length > 0)) {
    if (memories.length > 0) memories = memories.slice(0, -1);
    else paths = paths.slice(0, -1);
    evidence = [];
    contextBlock = render();
  }

  const outputPaths = paths.map((path) => publicPath(path, input.includeTemporalMetadata));

  return {
    profileId: input.profileId,
    query: input.query,
    contextBlock,
    memories,
    evidence,
    paths: outputPaths,
    plannerTrace: input.plannerTrace
      ? { ...input.plannerTrace, stopReason: input.stopReason }
      : undefined,
    stats: {
      stepCount: input.stepCount,
      exploredCueCount: input.exploredCueCount,
      associationCount: input.associationCount,
      retrievedMemoryCount: memories.length,
      promptTokenEstimate: estimateTokens(contextBlock),
      stopReason: input.stopReason,
      evidenceCoverage: coverage,
      uncertainty,
      evidenceConvergence,
    },
  };
}

async function evidenceForMemories(
  store: MemoryStore,
  memories: MemoryRecord[],
): Promise<EvidenceEvent[]> {
  const evidence: EvidenceEvent[] = [];
  const seen = new Set<string>();
  for (const memory of memories) {
    for (const event of await store.listEvidenceForMemory(memory.id)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      evidence.push(event);
    }
  }
  return evidence;
}

async function fallbackReconstruction(input: {
  store: MemoryStore;
  profileId: string;
  query: string;
  includeEvidence?: boolean | undefined;
  includeSensitive?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  maxMemories: number;
  intent: ReconstructionIntent;
  stopWhenEvidenceEnough: boolean;
  evidenceConvergenceThreshold: number;
  targetMemoryCount: number;
  includeTemporalMetadata?: boolean | undefined;
}): Promise<ReconstructedContext> {
  const memories = await input.store.searchMemories({
    profileId: input.profileId,
    query: input.query,
    purpose: "context",
    includeSensitive: input.includeSensitive,
    limit: input.maxMemories,
  });
  const paths = memories.map((memory, index) => ({
    id: `fallback:${memory.id}`,
    step: 1,
    cue: directMemoryCue(memory, input.query),
    tag: memory.kind,
    targetType: "memory" as const,
    targetId: memory.id,
    targetKind: memory.kind,
    targetSummary: memory.content,
    confidence: memory.confidence,
    informationGain: Math.max(0.1, memory.confidence),
    sourceMemoryId: memory.id,
    sourceEvidenceId: memory.sourceEventId,
    createdAt: memory.createdAt,
  }));
  const fallbackCoverage = evidenceCoverageForPaths(input.query, paths);
  const fallbackConvergence = evidenceConvergenceForPaths({
    coverage: fallbackCoverage,
    memories,
    paths,
    intent: input.intent,
    threshold: input.evidenceConvergenceThreshold,
    targetMemoryCount: input.targetMemoryCount,
    stopWhenEvidenceEnough: input.stopWhenEvidenceEnough,
    prunedBranchCount: 0,
    frontierRemaining: 0,
  });
  const safeMemories = fallbackConvergence.reached ? memories : [];
  const safePaths = fallbackConvergence.reached ? paths : [];
  const stopReason =
    memories.length === 0
      ? "no_frontier"
      : fallbackConvergence.reached
        ? "evidence_sufficient"
        : "no_frontier";
  const plannerTrace: ReconstructedPlannerTrace = {
    mode: "fallback",
    intentReason: input.intent.reason,
    initialCues: [input.query],
    maxSteps: 1,
    maxBranch: input.maxMemories,
    maxMemories: input.maxMemories,
    steps:
      paths.length === 0
        ? []
        : [
            {
              step: 1,
              selectedCue: input.query,
              cueReason: "fallback_memory_search",
              exploredAssociationCount: 0,
              selectedBranchCount: safePaths.length,
              prunedBranchCount: 0,
              generatedCues: [],
              branches: safePaths.map((path) =>
                traceBranchFromPath(path, "selected", "fallback_memory_search"),
              ),
            },
          ],
    stopReason,
  };
  return composeReconstructedContext({
    profileId: input.profileId,
    query: input.query,
    memories: safeMemories,
    evidence: input.includeEvidence ? await evidenceForMemories(input.store, safeMemories) : [],
    paths: safePaths,
    intent: input.intent,
    includeEvidence: input.includeEvidence,
    contextBudgetTokens: input.contextBudgetTokens,
    stepCount: safePaths.length > 0 ? 1 : 0,
    exploredCueCount: 1,
    associationCount: paths.length,
    prunedBranchCount: paths.length - safePaths.length,
    frontierRemaining: 0,
    stopWhenEvidenceEnough: input.stopWhenEvidenceEnough,
    evidenceConvergenceThreshold: input.evidenceConvergenceThreshold,
    targetMemoryCount: input.targetMemoryCount,
    stopReason,
    includeTemporalMetadata: input.includeTemporalMetadata === true,
    plannerTrace,
  });
}

export async function reconstructMemoryContext(input: {
  store: MemoryStore;
  defaultProfileId: string;
  request: ReconstructContextInput;
}): Promise<ReconstructedContext> {
  const profileId = input.request.profileId ?? input.defaultProfileId;
  const query = (input.request.query ?? latestUserText(input.request.messages)).trim();
  if (!query) throw new Error("gmOS reconstructContext requires query or messages");

  const maxSteps = boundedInteger(input.request.maxSteps, 3, 1, 8);
  const maxBranch = boundedInteger(input.request.maxBranch, 4, 1, 12);
  const maxMemories = boundedInteger(input.request.maxMemories, 8, 1, 24);
  const stopWhenEvidenceEnough = input.request.stopWhenEvidenceEnough !== false;
  const includeTemporalMetadata = input.request.includeTemporalMetadata === true;
  const evidenceConvergenceThreshold = boundedNumber(
    input.request.evidenceConvergenceThreshold,
    0.72,
    0.35,
    0.95,
  );
  const targetMemoryCount = Math.min(2, maxMemories);
  const intent = inferReconstructionIntent(query);
  if (!input.store.searchAssociations) {
    return fallbackReconstruction({
      store: input.store,
      profileId,
      query,
      includeEvidence: input.request.includeEvidence,
      includeSensitive: input.request.includeSensitive,
      contextBudgetTokens: input.request.contextBudgetTokens,
      maxMemories,
      intent,
      stopWhenEvidenceEnough,
      evidenceConvergenceThreshold,
      targetMemoryCount,
      includeTemporalMetadata,
    });
  }

  const frontier = seedFrontier(query, intent);
  const initialCues = frontier.map((cue) => cue.cue);
  const explored = new Set<string>();
  const seenAssociationIds = new Set<string>();
  const seenMemoryIds = new Set<string>();
  const memories: MemoryRecord[] = [];
  const paths: ReconstructedEvidencePath[] = [];
  const plannerSteps: ReconstructedPlannerStep[] = [];
  let associationCount = 0;
  let prunedBranchCount = 0;
  let stopReason: ReconstructedContext["stats"]["stopReason"] = "no_frontier";

  for (let step = 1; step <= maxSteps; step += 1) {
    frontier.sort((a, b) => b.priority - a.priority);
    const cue = frontier.shift();
    if (!cue) break;
    if (explored.has(cue.cue)) {
      step -= 1;
      continue;
    }
    explored.add(cue.cue);
    const associations = await input.store.searchAssociations({
      profileId,
      query: cue.cue,
      includeSensitive: input.request.includeSensitive,
      limit: Math.min(maxBranch * 4, 48),
    });
    associationCount += associations.length;
    const stepGeneratedCues = new Set<string>();
    const stepTrace: ReconstructedPlannerStep = {
      step,
      selectedCue: cue.cue,
      cueReason: cue.reason,
      exploredAssociationCount: associations.length,
      selectedBranchCount: 0,
      prunedBranchCount: 0,
      generatedCues: [],
      branches: [],
    };
    const rankedAssociations = associations
      .filter((association) => !seenAssociationIds.has(association.id))
      .map((association) => rankAssociation(association, cue, intent))
      .sort((a, b) => b.routeScore - a.routeScore)
      .slice(0, maxBranch);
    for (const ranked of rankedAssociations) {
      const { association } = ranked;
      if (seenAssociationIds.has(association.id)) continue;
      seenAssociationIds.add(association.id);
      const path = pathFromAssociation(association, step, ranked.routeScore, ranked.routeReason);
      const gain = informationGainForPath({ query, paths, path, intent });
      path.informationGain = gain.gain;
      path.routeReason = path.routeReason
        ? `${path.routeReason},gain:${gain.reasons.join("+")}`
        : `gain:${gain.reasons.join("+")}`;
      if (gain.gain < 0.35 && paths.length >= 2 && !pathMatchesIntent(path, intent)) {
        prunedBranchCount += 1;
        stepTrace.prunedBranchCount += 1;
        stepTrace.branches.push(
          traceBranchFromPath(path, "pruned", `low_information_gain:${gain.reasons.join("+")}`),
        );
        continue;
      }
      paths.push(path);
      const nextCues = extractAssociationCues(
        `${association.tag} ${association.targetSummary}`,
        8,
      );
      const generatedCues: string[] = [];
      for (const nextCue of nextCues) {
        if (explored.has(nextCue.cue)) continue;
        enqueueFrontierCue(frontier, {
          cue: nextCue.cue,
          priority: ranked.routeScore * 0.7 + (nextCue.cueKind === "entity" ? 4 : 0),
          reason: `from:${association.tag}`,
        });
        stepGeneratedCues.add(nextCue.cue);
        generatedCues.push(nextCue.cue);
      }
      stepTrace.selectedBranchCount += 1;
      stepTrace.branches.push(
        traceBranchFromPath(path, "selected", path.routeReason ?? ranked.routeReason, generatedCues),
      );
      if (association.targetType !== "memory" || seenMemoryIds.has(association.targetId)) continue;
      const memory = await input.store.getMemoryById(profileId, association.targetId, {
        includeSensitive: input.request.includeSensitive,
      });
      if (!memory) continue;
      seenMemoryIds.add(memory.id);
      memories.push(memory);
      if (memories.length >= maxMemories) {
        stopReason = "evidence_sufficient";
        break;
      }
    }
    stepTrace.generatedCues = [...stepGeneratedCues];
    plannerSteps.push(stepTrace);
    if (stopReason === "evidence_sufficient") break;
    const convergence = evidenceConvergenceForPaths({
      coverage: evidenceCoverageForPaths(query, paths),
      memories,
      paths,
      intent,
      threshold: evidenceConvergenceThreshold,
      targetMemoryCount,
      stopWhenEvidenceEnough,
      prunedBranchCount,
      frontierRemaining: frontier.length,
    });
    if (stopWhenEvidenceEnough && convergence.reached) {
      stopReason = "evidence_sufficient";
      break;
    }
    if (frontier.length === 0) {
      stopReason = "no_frontier";
      break;
    }
    stopReason = "budget_exhausted";
  }

  const finalCoverageBeforeHybrid = evidenceCoverageForPaths(query, paths);
  if (
    memories.length < maxMemories &&
    (paths.length === 0 ||
      memories.length < Math.min(2, maxMemories) ||
      !hasIntentEvidence(paths, intent) ||
      !coverageIsSufficient(finalCoverageBeforeHybrid))
  ) {
    const hybridTrace = await fuseDirectMemorySearch({
      store: input.store,
      profileId,
      query,
      intent,
      includeSensitive: input.request.includeSensitive,
      maxMemories,
      memories,
      paths,
      seenMemoryIds,
    });
    if (hybridTrace.candidateCount > 0) {
      const hybridPaths = [
        ...hybridTrace.reinforcedPaths,
        ...hybridTrace.selectedNewPaths,
      ];
      const hybridStep =
        hybridPaths.length > 0 ? Math.max(...hybridPaths.map((path) => path.step)) : stepCountForTrace(paths);
      plannerSteps.push({
        step: hybridStep,
        selectedCue: query,
        cueReason:
          hybridTrace.selectedNewPaths.length > 0
            ? "hybrid_direct_memory_search"
            : hybridTrace.reinforcedPaths.length > 0
              ? "hybrid_direct_memory_search_reinforced"
              : "hybrid_direct_memory_search_no_new_path",
        exploredAssociationCount: 0,
        hybridCandidateCount: hybridTrace.candidateCount,
        selectedBranchCount: hybridPaths.length,
        prunedBranchCount: 0,
        generatedCues: [],
        branches: [
          ...hybridTrace.reinforcedPaths.map((path) =>
            traceBranchFromPath(
              path,
              "reinforced",
              path.routeReason ?? "hybrid_direct_memory_search_reinforced",
            ),
          ),
          ...hybridTrace.selectedNewPaths.map((path) =>
            traceBranchFromPath(
              path,
              "selected_new_path",
              path.routeReason ?? "hybrid_direct_memory_search",
            ),
          ),
        ],
      });
    }
    const convergence = evidenceConvergenceForPaths({
      coverage: evidenceCoverageForPaths(query, paths),
      memories,
      paths,
      intent,
      threshold: evidenceConvergenceThreshold,
      targetMemoryCount,
      stopWhenEvidenceEnough,
      prunedBranchCount,
      frontierRemaining: frontier.length,
    });
    if (stopWhenEvidenceEnough && convergence.reached) {
      stopReason = "evidence_sufficient";
    }
  }

  return composeReconstructedContext({
    profileId,
    query,
    memories,
    evidence: input.request.includeEvidence ? await evidenceForMemories(input.store, memories) : [],
    paths,
    intent,
    includeEvidence: input.request.includeEvidence,
    contextBudgetTokens: input.request.contextBudgetTokens,
    stepCount: paths.length === 0 ? 0 : Math.max(...paths.map((path) => path.step)),
    exploredCueCount: explored.size,
    associationCount,
    prunedBranchCount,
    frontierRemaining: frontier.length,
    stopWhenEvidenceEnough,
    evidenceConvergenceThreshold,
    targetMemoryCount,
    stopReason,
    includeTemporalMetadata,
    plannerTrace: {
      mode: "associative",
      intentReason: intent.reason,
      initialCues,
      maxSteps,
      maxBranch,
      maxMemories,
      steps: plannerSteps,
      stopReason,
    },
  });
}
