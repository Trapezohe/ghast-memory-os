import {
  associationCueKey,
  associationCueMatchesQuery,
  extractAssociationCues,
  sourceMetadataEntityCues,
} from "./associations.js";
import type { AssociationCue } from "./associations.js";
import { classifySensitivity, sanitizeEvidenceForPublicOutput } from "./safety.js";
import { observedAtSegment, temporalMetadataSegment } from "./temporal-format.js";
import { temporalCueValuesFromText } from "./temporal-validity.js";
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
  ReconstructionIntentHint,
  ReconstructionRecallPurpose,
  TurnMessage,
} from "./types.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function latestUserText(messages: TurnMessage[] | undefined): string {
  return [...(messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "";
}

type ReconstructMemoryContextRequest = ReconstructContextInput & {
  retrievalQuery?: string | undefined;
};

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
  hideRouteSignals = false,
  privateSignalKeys = new Set<string>(),
): ReconstructedEvidencePath {
  const routeSafePath = hideRouteSignals
    ? {
        ...path,
        cue: "retrieval_hint",
        tag: path.targetKind ?? path.targetType,
        routeReason: publicRouteReason(path.routeReason, privateSignalKeys),
      }
    : path;
  if (includeTemporalMetadata || routeSafePath.createdAt === undefined) return routeSafePath;
  const { createdAt: _createdAt, ...publicPathWithoutTemporalMetadata } = routeSafePath;
  return publicPathWithoutTemporalMetadata;
}

function publicMemory(memory: MemoryRecord, hideRouteSignals: boolean): MemoryRecord {
  if (!hideRouteSignals) return memory;
  return {
    ...memory,
    scope: "global",
    metadata: {},
  };
}

function publicEvidenceEvent(event: EvidenceEvent, hideRouteSignals: boolean): EvidenceEvent {
  if (!hideRouteSignals) return event;
  return {
    ...event,
    payload: {},
  };
}

function publicPlannerBranch(
  branch: ReconstructedPlannerBranch,
  privateSignalKeys: Set<string>,
): ReconstructedPlannerBranch {
  if (privateSignalKeys.size === 0) return branch;
  return {
    ...branch,
    tag: publicRouteSignal(branch.tag, privateSignalKeys),
    reason: publicRouteReason(branch.reason, privateSignalKeys) ?? branch.reason,
    generatedCues: branch.generatedCues.map((cue) => publicRouteSignal(cue, privateSignalKeys)),
  };
}

function publicPlannerStep(
  step: ReconstructedPlannerStep,
  privateSignalKeys: Set<string>,
): ReconstructedPlannerStep {
  if (privateSignalKeys.size === 0) return step;
  return {
    ...step,
    selectedCue: publicRouteSignal(step.selectedCue, privateSignalKeys),
    cueReason: publicRouteReason(step.cueReason, privateSignalKeys) ?? step.cueReason,
    generatedCues: step.generatedCues.map((cue) => publicRouteSignal(cue, privateSignalKeys)),
    branches: step.branches.map((branch) => publicPlannerBranch(branch, privateSignalKeys)),
  };
}

function publicPlannerTrace(
  trace: ReconstructedPlannerTrace,
  privateSignalKeys: Set<string>,
  stopReason: ReconstructedContext["stats"]["stopReason"],
): ReconstructedPlannerTrace {
  if (privateSignalKeys.size === 0) return { ...trace, stopReason };
  return {
    ...trace,
    initialCues: trace.initialCues.map((cue) => publicRouteSignal(cue, privateSignalKeys)),
    steps: trace.steps.map((step) => publicPlannerStep(step, privateSignalKeys)),
    stopReason,
  };
}

interface ReconstructionIntent {
  expectedTags: Set<string>;
  requiredTagGroups: Array<{
    name: string;
    tags: Set<string>;
  }>;
  queryCues: Set<string>;
  explicitQueryCues: Set<string>;
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

const PUBLIC_STRUCTURED_INTENT_TAGS = new Set([
  "fact",
  "preference",
  "boundary",
  "procedure",
  "project",
  "person",
  "task_trajectory",
  "world_belief",
  "project.state",
  "do_not_push",
  "prefer",
]);

function normalizedText(value: string): string {
  return value.toLowerCase();
}

function entityCueMatchesQuery(cue: string, intent: ReconstructionIntent): boolean {
  return associationCueMatchesQuery(cue, intent.queryCues);
}

function queryAssociationCues(query: string, max: number): AssociationCue[] {
  const seen = new Set<string>();
  const result: AssociationCue[] = [];
  const candidates = [
    ...temporalCueValuesFromText(query).map((cue) => ({ cue, cueKind: "temporal" as const })),
    ...extractAssociationCues(query, max),
  ];
  for (const candidate of candidates) {
    const key = associationCueKey(candidate.cue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= max) break;
  }
  return result;
}

function queryCueSet(query: string): Set<string> {
  return new Set(queryAssociationCues(query, 48).map((cue) => cue.cue));
}

function normalizedIntentToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "_")
    .slice(0, 80);
}

function normalizedIntentTokens(values: string[] | undefined, max: number): string[] {
  if (!Array.isArray(values)) return [];
  return uniqueStrings(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => classifySensitivity(value) === "normal")
      .map(normalizedIntentToken)
      .filter(Boolean),
  ).slice(0, max);
}

function normalizedCueHints(values: string[] | undefined, max: number): string[] {
  if (!Array.isArray(values)) return [];
  return uniqueStrings(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => classifySensitivity(value) === "normal")
      .map((value) => value.slice(0, 80))
      .filter(Boolean),
  ).slice(0, max);
}

function routeSignalAppearsInPublicQuery(value: string, publicQuery: string): boolean {
  const signal = value.trim();
  if (!signal) return false;
  const normalizedSignal = normalizedText(signal);
  const normalizedQuery = normalizedText(publicQuery);
  if (normalizedQuery.includes(normalizedSignal)) return true;
  const signalKey = associationCueKey(signal);
  if (!signalKey) return false;
  return queryCueSet(publicQuery).has(signal) || associationCueMatchesQuery(signal, queryCueSet(publicQuery));
}

function privateRouteSignalKeys(intent: ReconstructionIntent, publicQuery: string): Set<string> {
  const keys = new Set<string>();
  const addPrivateKey = (value: string): void => {
    const key = associationCueKey(value);
    if (!key) return;
    keys.add(key);
    for (const part of key.split("-")) {
      if (part.length >= 4 || /^\d{3,}$/u.test(part)) keys.add(part);
    }
  };
  for (const cue of intent.explicitQueryCues) {
    if (routeSignalAppearsInPublicQuery(cue, publicQuery)) continue;
    addPrivateKey(cue);
  }
  for (const tag of intent.expectedTags) {
    if (PUBLIC_STRUCTURED_INTENT_TAGS.has(tag)) continue;
    if (routeSignalAppearsInPublicQuery(tag, publicQuery)) continue;
    addPrivateKey(tag);
  }
  return keys;
}

function publicRouteSignal(value: string, privateSignalKeys: Set<string>): string {
  const key = associationCueKey(value);
  return key && privateSignalKeys.has(key) ? "retrieval_hint" : value;
}

function publicRouteReason(value: string | undefined, privateSignalKeys: Set<string>): string | undefined {
  if (!value || privateSignalKeys.size === 0) return value;
  let output = value;
  for (const key of [...privateSignalKeys].sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(key, "retrieval-hint");
  }
  return output;
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
  return uniqueStrings(queryAssociationCues(query, 16).map((cue) => cue.cue)).slice(0, 8);
}

function pathCoversCue(path: ReconstructedEvidencePath, cue: string): boolean {
  const normalizedCue = normalizedText(cue);
  const pathText = `${path.cue} ${path.tag} ${path.targetKind ?? ""} ${path.targetSummary}`;
  if (normalizedText(pathText).includes(normalizedCue)) return true;
  const cueKey = associationCueKey(cue);
  if (!cueKey) return false;
  const pathKeys = new Set(
    extractAssociationCues(pathText, 64)
      .map((pathCue) => associationCueKey(pathCue.cue))
      .filter(Boolean),
  );
  if (pathKeys.has(cueKey)) return true;
  const parts = cueKey.split("-").filter(Boolean);
  return parts.length > 1 && parts.every((part) => pathKeys.has(part));
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
  evidenceConvergence?: ReconstructionEvidenceConvergence | undefined;
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
  if (input.evidenceConvergence?.reached && level === "high") {
    level = "medium";
  }
  return { level, reasons };
}

function coverageIsSufficient(coverage: ReconstructionEvidenceCoverage): boolean {
  if (coverage.queryCueCount === 0) return coverage.coveredCueCount > 0;
  if (coverage.queryCueCount <= 3) {
    return (
      coverage.coverageRate >= 0.45 ||
      coverage.coveredCueCount >= Math.min(2, coverage.queryCueCount)
    );
  }
  return coverage.coverageRate >= 0.45;
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
  const pathSupportEnough = input.paths.length >= targetMemoryCount && intentMatched;
  const baseScore = Math.min(
    1,
    input.coverage.coverageRate * 0.45 +
      intentScore * 0.3 +
      memoryContentScore * 0.2 +
      pathSupportScore * 0.05,
  );
  const requiredIntentCovered =
    input.intent.requiredTagGroups.length === 0 ||
    coveredRequiredIntentGroups.length === input.intent.requiredTagGroups.length;
  const hasUncoveredTemporalCue = input.coverage.uncoveredCues.some((cue) =>
    /\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}:\d{2}\.\d{3}z)?\b|^(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)$/iu.test(
      cue,
    ),
  );
  const intentGroundedEnough =
    intentMatched &&
    requiredIntentCovered &&
    !hasUncoveredTemporalCue &&
    (input.coverage.coveredCueCount > 0 || input.intent.requiredTagGroups.length > 0) &&
    (memorySupportEnough || pathOnlySupportEnough || pathSupportEnough);
  const score = intentGroundedEnough ? Math.max(baseScore, input.threshold) : baseScore;
  return {
    score,
    reached:
      (score >= input.threshold &&
        (memorySupportEnough || pathOnlySupportEnough) &&
        intentMatched &&
        coverageIsSufficient(input.coverage)) ||
      intentGroundedEnough,
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

function addIntentGroup(
  requiredTagGroups: ReconstructionIntent["requiredTagGroups"],
  expectedTags: Set<string>,
  name: string,
  tags: string[],
): void {
  const tagSet = new Set(normalizedIntentTokens(tags, 24));
  if (tagSet.size === 0) return;
  requiredTagGroups.push({ name, tags: tagSet });
  for (const tag of tagSet) expectedTags.add(tag);
}

function publicIntentGroupName(name: string | undefined, index: number): string {
  const normalized = normalizedIntentToken(name ?? "");
  if (
    normalized === "procedure_or_next_step" ||
    normalized === "current_state" ||
    normalized === "boundary" ||
    normalized === "preference"
  ) {
    return normalized;
  }
  return `structured_intent_${index + 1}`;
}

function explicitReconstructionIntent(
  query: string,
  hint: ReconstructionIntentHint | undefined,
): ReconstructionIntent | null {
  if (!hint) return null;
  const expectedTags = new Set(normalizedIntentTokens(hint.expectedTags, 32));
  const requiredTagGroups: ReconstructionIntent["requiredTagGroups"] = [];
  for (const [index, group] of (hint.requiredTagGroups ?? []).slice(0, 12).entries()) {
    if (!group || !Array.isArray(group.tags)) continue;
    addIntentGroup(
      requiredTagGroups,
      expectedTags,
      publicIntentGroupName(group.name, index),
      group.tags,
    );
  }
  const explicitQueryCues = normalizedCueHints(hint.queryCues, 32);
  if (
    expectedTags.size === 0 &&
    requiredTagGroups.length === 0 &&
    explicitQueryCues.length === 0
  ) {
    return null;
  }
  return {
    expectedTags,
    requiredTagGroups,
    queryCues: new Set([...queryCueSet(query), ...explicitQueryCues]),
    explicitQueryCues: new Set(explicitQueryCues),
    reason:
      requiredTagGroups.length > 0
        ? `structured:${requiredTagGroups.map((group) => group.name).join("+")}`
        : expectedTags.size > 0
          ? "structured:expected_tags"
          : "structured:query_cues",
  };
}

function inferReconstructionIntent(
  query: string,
  hint?: ReconstructionIntentHint | undefined,
): ReconstructionIntent {
  const explicit = explicitReconstructionIntent(query, hint);
  if (explicit) return explicit;
  return {
    expectedTags: new Set<string>(),
    requiredTagGroups: [],
    queryCues: queryCueSet(query),
    explicitQueryCues: new Set<string>(),
    reason: "associative",
  };
}

function inferTemporalRecallPurpose(
  query: string,
  temporalMode: ReconstructContextInput["temporalMode"],
  recallPurpose?: ReconstructContextInput["recallPurpose"],
): ReconstructionRecallPurpose {
  if (recallPurpose === "history" || recallPurpose === "context") return recallPurpose;
  if (temporalMode === "history") return "history";
  if (temporalMode === "current") return "context";
  return "context";
}

function seedFrontier(query: string, intent: ReconstructionIntent): FrontierCue[] {
  const cues = queryAssociationCues(query, 12);
  const queryCues = cues.length === 0
    ? [{ cue: query, cueKind: "lexical" as const }]
    : cues;
  const frontier = queryCues.map((cue, index) => {
    let priority = 10 - index * 0.1;
    if (cue.cueKind === "entity") priority += 4;
    if (cue.cueKind === "temporal") priority += 8;
    if (intent.expectedTags.has(cue.cue)) priority += 2;
    return {
      cue: cue.cue,
      priority,
      reason:
        cue.cueKind === "entity"
          ? "initial_entity_cue"
          : cue.cueKind === "temporal"
            ? "initial_temporal_cue"
            : "initial_query_cue",
    };
  });
  const existing = new Set(frontier.map((cue) => associationCueKey(cue.cue)));
  for (const queryCue of intent.queryCues) {
    const key = associationCueKey(queryCue);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    frontier.push({
      cue: queryCue,
      priority: 9,
      reason: "initial_structured_query_cue",
    });
  }
  for (const tag of intent.expectedTags) {
    const key = associationCueKey(tag);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    frontier.push({
      cue: tag,
      priority: 11,
      reason: "initial_intent_tag_cue",
    });
  }
  return frontier;
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

function sourceScopeRejectReason(
  memory: MemoryRecord,
  intent: ReconstructionIntent,
  selectedSourceCues: Set<string>,
): string | null {
  const sourceCues = sourceEntityCuesForMemory(memory);
  const sourceCueKeys = new Set(sourceCues.map(associationCueKey).filter(Boolean));
  if (sourceCues.length === 0) {
    return selectedSourceCues.size > 0
      ? `source_scope_mismatch:${[...selectedSourceCues].join("|")}`
      : null;
  }
  const matchingQueryCues = sourceCues.filter((cue) => entityCueMatchesQuery(cue, intent));
  if (matchingQueryCues.length > 0) {
    for (const cue of matchingQueryCues) selectedSourceCues.add(associationCueKey(cue));
    return null;
  }
  if (contentHasNonSourceQueryEntity(memory.content, intent, sourceCueKeys)) return null;
  return selectedSourceCues.size > 0 &&
    !sourceCues.some((cue) => selectedSourceCues.has(associationCueKey(cue)))
    ? `source_scope_mismatch:${[...selectedSourceCues].join("|")}`
    : null;
}

function sourceScopedFallbackMemories(memories: MemoryRecord[], intent: ReconstructionIntent): MemoryRecord[] {
  const selectedSourceCues = new Set<string>();
  for (const memory of memories) {
    for (const cue of sourceEntityCuesForMemory(memory)) {
      if (entityCueMatchesQuery(cue, intent)) selectedSourceCues.add(associationCueKey(cue));
    }
  }
  if (selectedSourceCues.size === 0) return memories;
  return memories.filter(
    (memory) => sourceScopeRejectReason(memory, intent, selectedSourceCues) === null,
  );
}

function associationSourceRejectReason(
  association: MemoryAssociationRecord,
  intent: ReconstructionIntent,
  selectedSourceCues: Set<string>,
): string | null {
  const personCue = associationPersonCue(association);
  if (!personCue) return null;
  const personCueKey = associationCueKey(personCue);
  if (entityCueMatchesQuery(personCue, intent)) {
    selectedSourceCues.add(personCueKey);
    return null;
  }
  if (contentHasNonSourceQueryEntity(association.targetSummary, intent, new Set([personCueKey]))) {
    return null;
  }
  return selectedSourceCues.size > 0 && !selectedSourceCues.has(personCueKey)
    ? `source_scope_mismatch:${[...selectedSourceCues].join("|")}`
    : null;
}

function contentHasNonSourceQueryEntity(
  content: string,
  intent: ReconstructionIntent,
  sourceCueKeys: Set<string>,
): boolean {
  for (const queryCue of intent.explicitQueryCues) {
    const key = associationCueKey(queryCue);
    if (
      key.length > 0 &&
      !sourceCueKeys.has(key) &&
      normalizedText(content).includes(normalizedText(queryCue))
    ) {
      return true;
    }
  }
  return extractAssociationCues(content, 64).some((cue) => {
    if (cue.cueKind !== "entity") return false;
    const key = associationCueKey(cue.cue);
    return key.length > 0 && !sourceCueKeys.has(key) && entityCueMatchesQuery(cue.cue, intent);
  });
}

function associationPersonCue(association: MemoryAssociationRecord): string | null {
  const personMatch = /^person:([^\s]+)/iu.exec(association.targetSummary);
  const userMatch = /^user\b/iu.exec(association.targetSummary);
  return (
    personMatch?.[1]?.trim().toLowerCase() ??
    userMatch?.[0]?.trim().toLowerCase() ??
    null
  );
}

function sourceEntityCuesForMemory(memory: MemoryRecord): string[] {
  return sourceMetadataEntityCues(memory.metadata);
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

function exactTemporalCue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}:\d{2}\.\d{3}z)?$/iu.test(value.trim());
}

function memoryRouteSearchableText(memory: MemoryRecord): string {
  return normalizedText(
    `${memory.kind} ${memory.scope} ${memory.content} ${JSON.stringify(memory.metadata)}`,
  );
}

function memoryMatchesTemporalConstraint(memory: MemoryRecord, temporalCues: string[]): boolean {
  if (temporalCues.length === 0) return true;
  const searchable = memoryRouteSearchableText(memory);
  return temporalCues.some((cue) => searchable.includes(normalizedText(cue)));
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
  intent: ReconstructionIntent,
): RankedMemoryCandidate {
  const reasons = [`hybrid_direct_memory_rrf:${rank}`];
  let routeScore = memory.confidence + reciprocalRankScore(rank) * 100;
  if (memoryMatchesIntent(memory, intent)) {
    routeScore += 6;
    reasons.push(`intent:${intent.reason}`);
  }
  const searchable = memoryRouteSearchableText(memory);
  let overlapCount = 0;
  for (const queryCue of intent.queryCues) {
    if (searchable.includes(normalizedText(queryCue))) overlapCount += 1;
  }
  if (overlapCount > 0) {
    routeScore += overlapCount * 0.75;
    reasons.push(`query_overlap:${overlapCount}`);
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
  recallPurpose: ReconstructionRecallPurpose;
  includeSensitive?: boolean | undefined;
  maxMemories: number;
  memories: MemoryRecord[];
  paths: ReconstructedEvidencePath[];
  seenMemoryIds: Set<string>;
  selectedSourceCues: Set<string>;
}): Promise<{
  candidateCount: number;
  reinforcedPaths: ReconstructedEvidencePath[];
  selectedNewPaths: ReconstructedEvidencePath[];
}> {
  const directMemoryCandidates = await input.store.searchMemories({
    profileId: input.profileId,
    query: input.query,
    purpose: input.recallPurpose,
    includeSensitive: input.includeSensitive,
    limit: Math.min(input.maxMemories * 4, 48),
  });
  const rankedCandidates = directMemoryCandidates
    .map((memory, index) => rankDirectMemory(memory, index + 1, input.intent))
    .sort((a, b) => b.routeScore - a.routeScore);
  const temporalConstraints = [...input.intent.queryCues].filter(exactTemporalCue);
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
    if (!memoryMatchesTemporalConstraint(candidate.memory, temporalConstraints)) continue;
    const sourceRejectReason = sourceScopeRejectReason(
      candidate.memory,
      input.intent,
      input.selectedSourceCues,
    );
    if (sourceRejectReason) continue;
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
  displayQuery?: string | undefined;
  plannerTrace?: ReconstructedPlannerTrace | undefined;
}): ReconstructedContext {
  let memories = [...input.memories];
  let paths = [...input.paths];
  const publicQuery = input.displayQuery ?? input.query;
  const privateSignalKeys = privateRouteSignalKeys(input.intent, publicQuery);
  const hideInternalRouteSignals =
    (input.displayQuery !== undefined && input.displayQuery !== input.query) ||
    privateSignalKeys.size > 0;
  const publicEvidence = input.includeEvidence
    ? input.evidence
        .map(sanitizeEvidenceForPublicOutput)
        .map((event) => publicEvidenceEvent(event, hideInternalRouteSignals))
    : [];
  let evidence = [...publicEvidence];
  let coverage = evidenceCoverageForPaths(publicQuery, paths);
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
  let uncertainty = uncertaintyForReconstruction({
    coverage,
    memories,
    paths,
    stopReason: input.stopReason,
    evidenceConvergence,
  });
  const render = (): string => {
    coverage = evidenceCoverageForPaths(publicQuery, paths);
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
    uncertainty = uncertaintyForReconstruction({
      coverage,
      memories,
      paths,
      stopReason: input.stopReason,
      evidenceConvergence,
    });
    const lines = [
      "<gmos-reconstructed-context>",
      `Query: ${publicQuery}`,
      `Evidence coverage: ${coverage.coveredCueCount}/${coverage.queryCueCount} cues (${coverage.coverageRate.toFixed(2)}); uncovered=${coverage.uncoveredCues.join(", ") || "none"}`,
      `Evidence convergence: score=${evidenceConvergence.score.toFixed(2)}; reached=${evidenceConvergence.reached}; threshold=${evidenceConvergence.threshold.toFixed(2)}; pruned=${evidenceConvergence.prunedBranchCount}; frontier=${evidenceConvergence.frontierRemaining}; stopWhenEvidenceEnough=${evidenceConvergence.stopWhenEvidenceEnough}`,
      `Reconstruction uncertainty: ${uncertainty.level}${uncertainty.reasons.length ? ` (${uncertainty.reasons.join(", ")})` : ""}`,
      "Reconstructed evidence paths:",
      ...paths
        .map((path) =>
          publicPath(path, input.includeTemporalMetadata, hideInternalRouteSignals, privateSignalKeys)
        )
        .map((path) => formatPathLine(path, input.includeTemporalMetadata)),
      "Memory content:",
      ...memories.map(
        (memory) =>
          `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}${input.includeTemporalMetadata ? temporalMetadataSegment(memory.createdAt, memory.metadata) : ""}] ${memory.content}`,
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

  const outputPaths = paths.map((path) =>
    publicPath(path, input.includeTemporalMetadata, hideInternalRouteSignals, privateSignalKeys),
  );
  const outputMemories = memories.map((memory) =>
    publicMemory(memory, hideInternalRouteSignals),
  );
  const outputEvidenceConvergence = hideInternalRouteSignals
    ? {
        ...evidenceConvergence,
        selectedTags: uniqueStrings(outputPaths.map((path) => path.tag)).slice(0, 12),
      }
    : evidenceConvergence;
  const exposePlannerTrace = input.displayQuery === undefined || input.displayQuery === input.query;

  return {
    profileId: input.profileId,
    query: input.displayQuery ?? input.query,
    contextBlock,
    memories: outputMemories,
    evidence,
    paths: outputPaths,
    plannerTrace: exposePlannerTrace && input.plannerTrace
      ? publicPlannerTrace(input.plannerTrace, privateSignalKeys, input.stopReason)
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
      evidenceConvergence: outputEvidenceConvergence,
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
  recallPurpose: ReconstructionRecallPurpose;
  includeEvidence?: boolean | undefined;
  includeSensitive?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  maxMemories: number;
  intent: ReconstructionIntent;
  displayQuery?: string | undefined;
  stopWhenEvidenceEnough: boolean;
  evidenceConvergenceThreshold: number;
  targetMemoryCount: number;
  includeTemporalMetadata?: boolean | undefined;
}): Promise<ReconstructedContext> {
  const memories = sourceScopedFallbackMemories(await input.store.searchMemories({
    profileId: input.profileId,
    query: input.query,
    purpose: input.recallPurpose,
    includeSensitive: input.includeSensitive,
    limit: input.maxMemories,
  }), input.intent);
  const targetMemoryCount = Math.min(input.targetMemoryCount, Math.max(1, memories.length));
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
    targetMemoryCount,
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
    displayQuery: input.displayQuery,
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
    targetMemoryCount,
    stopReason,
    includeTemporalMetadata: input.includeTemporalMetadata === true,
    plannerTrace,
  });
}

export async function reconstructMemoryContext(input: {
  store: MemoryStore;
  defaultProfileId: string;
  request: ReconstructMemoryContextRequest;
}): Promise<ReconstructedContext> {
  const profileId = input.request.profileId ?? input.defaultProfileId;
  const displayQuery = (input.request.query ?? latestUserText(input.request.messages)).trim();
  const query = (input.request.retrievalQuery ?? displayQuery).trim();
  if (!query) throw new Error("gmOS reconstructContext requires query or messages");
  const publicQuery = displayQuery || "task context";

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
  const intent = inferReconstructionIntent(query, input.request.reconstructionIntent);
  const recallPurpose = inferTemporalRecallPurpose(
    query,
    input.request.temporalMode,
    input.request.recallPurpose,
  );
  const targetMemoryCount = recallPurpose === "history" ? Math.min(4, maxMemories) : Math.min(2, maxMemories);
  if (!input.store.searchAssociations) {
    return fallbackReconstruction({
      store: input.store,
      profileId,
      query,
      displayQuery: publicQuery,
      recallPurpose,
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
  const selectedSourceCues = new Set<string>();
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
      purpose: recallPurpose,
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
      const personCue = associationPersonCue(ranked.association);
      if (personCue && entityCueMatchesQuery(personCue, intent)) {
        selectedSourceCues.add(associationCueKey(personCue));
      }
    }
    for (const ranked of rankedAssociations) {
      const { association } = ranked;
      if (seenAssociationIds.has(association.id)) continue;
      seenAssociationIds.add(association.id);
      const path = pathFromAssociation(association, step, ranked.routeScore, ranked.routeReason);
      const associationRejectReason = associationSourceRejectReason(
        association,
        intent,
        selectedSourceCues,
      );
      if (associationRejectReason) {
        prunedBranchCount += 1;
        stepTrace.prunedBranchCount += 1;
        stepTrace.branches.push(traceBranchFromPath(path, "pruned", associationRejectReason));
        continue;
      }
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
      const generatedCues: string[] = [];
      const enqueueGeneratedCues = (): void => {
        const nextCues = extractAssociationCues(
          `${association.tag} ${association.targetSummary}`,
          8,
        ).filter((nextCue) =>
          nextCue.cueKind === "entity" ||
          nextCue.cueKind === "temporal" ||
          [...nextCue.cue].length >= 4
        );
        for (const nextCue of nextCues) {
          if (explored.has(nextCue.cue)) continue;
          const structuralCueBoost =
            (nextCue.cueKind === "entity" || nextCue.cueKind === "temporal" ? 4 : 0) +
            Math.min([...nextCue.cue].length, 16) / 8;
          enqueueFrontierCue(frontier, {
            cue: nextCue.cue,
            priority: ranked.routeScore * 0.9 + structuralCueBoost,
            reason: `from:${association.tag}`,
          });
          stepGeneratedCues.add(nextCue.cue);
          generatedCues.push(nextCue.cue);
        }
      };
      if (association.targetType !== "memory") {
        enqueueGeneratedCues();
        paths.push(path);
        stepTrace.selectedBranchCount += 1;
        stepTrace.branches.push(
          traceBranchFromPath(path, "selected", path.routeReason ?? ranked.routeReason, generatedCues),
        );
        continue;
      }
      if (seenMemoryIds.has(association.targetId)) continue;
      const memory = await input.store.getMemoryById(profileId, association.targetId, {
        includeSensitive: input.request.includeSensitive,
      });
      if (!memory) continue;
      const sourceRejectReason =
        sourceScopeRejectReason(memory, intent, selectedSourceCues);
      if (sourceRejectReason) {
        prunedBranchCount += 1;
        stepTrace.prunedBranchCount += 1;
        stepTrace.branches.push(traceBranchFromPath(path, "pruned", sourceRejectReason));
        continue;
      }
      enqueueGeneratedCues();
      paths.push(path);
      stepTrace.selectedBranchCount += 1;
      stepTrace.branches.push(
        traceBranchFromPath(path, "selected", path.routeReason ?? ranked.routeReason, generatedCues),
      );
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
    ((recallPurpose === "history" && memories.length < targetMemoryCount) ||
      paths.length === 0 ||
      memories.length < Math.min(2, maxMemories) ||
      !hasIntentEvidence(paths, intent) ||
      !coverageIsSufficient(finalCoverageBeforeHybrid))
  ) {
    const hybridTrace = await fuseDirectMemorySearch({
      store: input.store,
      profileId,
      query,
      intent,
      recallPurpose,
      includeSensitive: input.request.includeSensitive,
      maxMemories,
      memories,
      paths,
      seenMemoryIds,
      selectedSourceCues,
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
    displayQuery: publicQuery,
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
