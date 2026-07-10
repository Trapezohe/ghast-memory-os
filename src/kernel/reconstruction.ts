import {
  associationCueKey,
  associationCueMatchesQuery,
  associationCueTextPattern,
  extractAssociationCues,
  sourceMetadataEntityCues,
} from "./associations.js";
import type { AssociationCue } from "./associations.js";
import {
  classifySensitivity,
  safePublicInlineField,
  safePublicLabel,
  sanitizeEvidenceForPublicOutput,
} from "./safety.js";
import {
  observedAtSegment,
  temporalContextLabel,
  temporalContextSegment,
  temporalReferenceDateLabel,
} from "./temporal-format.js";
import { temporalCueValuesFromText } from "./temporal-validity.js";
import type {
  EvidenceEvent,
  MemoryAssociationRecord,
  MemoryCueExtractor,
  ReconstructionLayerCounts,
  ReconstructionLayerPolicy,
  ReconstructionLayerStats,
  ReconstructionMemoryLayer,
  MemoryRecord,
  MemoryStore,
  QueryVectorEmbedding,
  ReconstructedContext,
  ReconstructionAnchorCoverageReport,
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
  privateRouteSignals?: string[] | undefined;
};

function boundedInteger(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined) return fallback;
  return Math.max(min, Math.min(Math.trunc(input), max));
}

function boundedNumber(input: number | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.max(min, Math.min(input, max));
}

function boundedMaxMemories(input: number | undefined): number {
  if (input === undefined) return 8;
  const value = Math.trunc(input);
  if (!Number.isFinite(value) || value < 1 || value > 256) {
    throw new Error("gmOS reconstructContext maxMemories must be between 1 and 256");
  }
  return value;
}

function optionalBoundedInteger(
  input: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isFinite(input)) return min;
  return Math.max(min, Math.min(Math.trunc(input), max));
}

function normalizedLayerPolicy(
  input: ReconstructionLayerPolicy | undefined,
): ReconstructionLayerStats["policy"] | undefined {
  if (input === undefined) return undefined;
  return {
    summaryMinShare: boundedNumber(input.summaryMinShare, 0, 0, 1),
    turnMaxShare: boundedNumber(input.turnMaxShare, 1, 0, 1),
  };
}

function memoryLayer(memory: MemoryRecord): ReconstructionMemoryLayer {
  if (memory.metadata.sessionDistillation === true) return "summary";
  if (memory.metadata.turnMemory === true) return "turn";
  return "atom";
}

function emptyLayerCounts(): ReconstructionLayerCounts {
  return { summary: 0, atom: 0, turn: 0 };
}

function layerCounts(memories: MemoryRecord[]): ReconstructionLayerCounts {
  const counts = emptyLayerCounts();
  for (const memory of memories) counts[memoryLayer(memory)] += 1;
  return counts;
}

function subtractLayerCounts(
  left: ReconstructionLayerCounts,
  right: ReconstructionLayerCounts,
): ReconstructionLayerCounts {
  return {
    summary: Math.max(0, left.summary - right.summary),
    atom: Math.max(0, left.atom - right.atom),
    turn: Math.max(0, left.turn - right.turn),
  };
}

function layerCandidateMemoryLimit(
  maxMemories: number,
  policy: ReconstructionLayerStats["policy"] | undefined,
): number {
  return policy ? Math.min(1024, Math.max(maxMemories, maxMemories * 3)) : maxMemories;
}

function allocateLayeredMemories(input: {
  memories: MemoryRecord[];
  maxMemories: number;
  policy?: ReconstructionLayerStats["policy"] | undefined;
}): MemoryRecord[] {
  if (!input.policy) return input.memories;
  const ranked = input.memories.map((memory, index) => ({
    memory,
    index,
    layer: memoryLayer(memory),
  }));
  const selected = new Set<string>();
  const summaries = ranked.filter((candidate) => candidate.layer === "summary");
  if (summaries.length === 0) {
    return ranked.slice(0, input.maxMemories).map((candidate) => candidate.memory);
  }
  const summaryMin = Math.min(
    summaries.length,
    Math.ceil(input.policy.summaryMinShare * input.maxMemories),
  );
  for (const candidate of summaries.slice(0, summaryMin)) {
    if (selected.size >= input.maxMemories) break;
    selected.add(candidate.memory.id);
  }
  const turnMax = Math.floor(input.policy.turnMaxShare * input.maxMemories);
  let selectedTurns = ranked.filter((candidate) =>
    selected.has(candidate.memory.id) && candidate.layer === "turn"
  ).length;
  for (const candidate of ranked) {
    if (selected.size >= input.maxMemories) break;
    if (selected.has(candidate.memory.id)) continue;
    if (candidate.layer === "turn" && selectedTurns >= turnMax) continue;
    selected.add(candidate.memory.id);
    if (candidate.layer === "turn") selectedTurns += 1;
  }
  return ranked
    .filter((candidate) => selected.has(candidate.memory.id))
    .sort((left, right) => left.index - right.index)
    .map((candidate) => candidate.memory);
}

function uniqueMemoriesById(memories: MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const unique: MemoryRecord[] = [];
  for (const memory of memories) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    unique.push(memory);
  }
  return unique;
}

function uniquePathsById(paths: ReconstructedEvidencePath[]): ReconstructedEvidencePath[] {
  const seen = new Set<string>();
  const unique: ReconstructedEvidencePath[] = [];
  for (const path of paths) {
    if (seen.has(path.id)) continue;
    seen.add(path.id);
    unique.push(path);
  }
  return unique;
}

function truncateMemoryContent(content: string, maxCharsPerMemory: number | undefined): string {
  if (maxCharsPerMemory === undefined) return content;
  const chars = [...content];
  if (chars.length <= maxCharsPerMemory) return content;
  return `${chars.slice(0, maxCharsPerMemory).join("")}...`;
}

function normalizedFullContentMaxChars(input: {
  maxCharsPerMemory: number | undefined;
  fullContentTopRank: number | undefined;
  fullContentMaxChars: number | undefined;
}): number | undefined {
  if (input.fullContentTopRank === undefined || input.maxCharsPerMemory === undefined) return undefined;
  return boundedInteger(input.fullContentMaxChars, 1600, input.maxCharsPerMemory, 8000);
}

function dropLowestRankMemoryByLayer(
  memories: MemoryRecord[],
  layer: ReconstructionMemoryLayer,
): boolean {
  for (let index = memories.length - 1; index >= 0; index -= 1) {
    if (memoryLayer(memories[index]!) !== layer) continue;
    memories.splice(index, 1);
    return true;
  }
  return false;
}

function dropLayerAwareMemory(memories: MemoryRecord[]): void {
  if (
    dropLowestRankMemoryByLayer(memories, "turn") ||
    dropLowestRankMemoryByLayer(memories, "atom") ||
    dropLowestRankMemoryByLayer(memories, "summary")
  ) {
    return;
  }
  memories.pop();
}

function filterPathsForIncludedMemories(
  paths: ReconstructedEvidencePath[],
  memories: MemoryRecord[],
): ReconstructedEvidencePath[] {
  const includedIds = new Set(memories.map((memory) => memory.id));
  return paths.filter((path) =>
    path.targetType !== "memory" ||
    includedIds.has(path.targetId) ||
    (
      path.sourceMemoryId !== undefined &&
      path.sourceMemoryId !== null &&
      includedIds.has(path.sourceMemoryId)
    )
  );
}

function pathFromAssociation(
  association: MemoryAssociationRecord,
  step: number,
  routeScore?: number | undefined,
  routeReason?: string | undefined,
  anchorCue?: string | undefined,
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
    ...(anchorCue ? { anchorCue } : {}),
  };
}

function formatPathLine(
  path: ReconstructedEvidencePath,
  temporalSegment: string,
  maxCharsPerMemory: number | undefined,
  targetReference?: string | undefined,
): string {
  const routeScore = path.routeScore !== undefined ? `; routeScore=${path.routeScore.toFixed(2)}` : "";
  const routeReason = path.routeReason ? `; reason=${path.routeReason}` : "";
  const informationGain =
    path.informationGain !== undefined ? `; gain=${path.informationGain.toFixed(2)}` : "";
  const targetSummary = targetReference ?? truncateMemoryContent(path.targetSummary, maxCharsPerMemory);
  return `- [step=${path.step}; cue=${path.cue}; tag=${path.tag}; kind=${path.targetKind ?? path.targetType}${temporalSegment}; confidence=${path.confidence.toFixed(2)}${routeScore}${informationGain}${routeReason}] ${targetSummary}`;
}

function publicPath(
  path: ReconstructedEvidencePath,
  includeTemporalMetadata: boolean,
  hideRouteSignals = false,
  privateSignalKeys = new Set<string>(),
  privateOutputSignalKeys = new Set<string>(),
): ReconstructedEvidencePath {
  const routeSafePath = hideRouteSignals
    ? {
        ...path,
        id: redactPrivateRouteSignals(path.id, privateOutputSignalKeys),
        cue: "retrieval_hint",
        tag: safePublicLabel(path.targetKind ?? path.targetType),
        targetKind: path.targetKind === undefined ? path.targetKind : safePublicLabel(path.targetKind),
        targetId: redactPrivateRouteSignals(path.targetId, privateOutputSignalKeys),
        targetSummary: redactPrivateRouteSignals(path.targetSummary, privateOutputSignalKeys),
        anchorCue: path.anchorCue
          ? publicRouteSignal(path.anchorCue, privateSignalKeys)
          : path.anchorCue,
        sourceEvidenceId: path.sourceEvidenceId
          ? redactPrivateRouteSignals(path.sourceEvidenceId, privateOutputSignalKeys)
          : path.sourceEvidenceId,
        routeReason: publicRouteReason(path.routeReason, privateSignalKeys),
      }
    : {
        ...path,
        cue: safePublicInlineField(path.cue),
        anchorCue: path.anchorCue === undefined ? path.anchorCue : safePublicInlineField(path.anchorCue),
        tag: safePublicLabel(path.tag),
        targetKind: path.targetKind === undefined ? path.targetKind : safePublicLabel(path.targetKind),
      };
  if (includeTemporalMetadata || routeSafePath.createdAt === undefined) return routeSafePath;
  const { createdAt: _createdAt, ...publicPathWithoutTemporalMetadata } = routeSafePath;
  return publicPathWithoutTemporalMetadata;
}

function publicMemory(
  memory: MemoryRecord,
  hideRouteSignals: boolean,
  privateOutputSignalKeys = new Set<string>(),
): MemoryRecord {
  const publicRecord = {
    ...memory,
    kind: safePublicLabel(memory.kind) as MemoryRecord["kind"],
  };
  if (!hideRouteSignals) return publicRecord;
  return {
    ...publicRecord,
    scope: "global",
    content: redactPrivateRouteSignals(memory.content, privateOutputSignalKeys),
    metadata: {},
  };
}

function publicEvidenceEvent(
  event: EvidenceEvent,
  hideRouteSignals: boolean,
  privateOutputSignalKeys = new Set<string>(),
): EvidenceEvent {
  if (!hideRouteSignals) return event;
  return {
    ...event,
    eventKey: redactPrivateRouteSignals(event.eventKey, privateOutputSignalKeys),
    sourceUri: event.sourceUri
      ? redactPrivateRouteSignals(event.sourceUri, privateOutputSignalKeys)
      : event.sourceUri,
    content: redactPrivateRouteSignals(event.content, privateOutputSignalKeys),
    payload: {},
  };
}

function publicPlannerBranch(
  branch: ReconstructedPlannerBranch,
  privateSignalKeys: Set<string>,
): ReconstructedPlannerBranch {
  return {
    ...branch,
    pathId: redactPrivateRouteSignals(branch.pathId, privateSignalKeys),
    targetId: redactPrivateRouteSignals(branch.targetId, privateSignalKeys),
    targetKind: branch.targetKind === undefined ? branch.targetKind : safePublicLabel(branch.targetKind),
    tag: safePublicLabel(publicRouteSignal(branch.tag, privateSignalKeys)),
    reason: publicRouteReason(branch.reason, privateSignalKeys) ?? branch.reason,
    generatedCues: publicRouteSignals(branch.generatedCues, privateSignalKeys),
  };
}

function publicPlannerBranches(
  branches: ReconstructedPlannerBranch[],
  privateSignalKeys: Set<string>,
): ReconstructedPlannerBranch[] {
  const seen = new Set<string>();
  const output: ReconstructedPlannerBranch[] = [];
  for (const branch of branches.map((item) => publicPlannerBranch(item, privateSignalKeys))) {
    const key = [
      branch.pathId,
      branch.targetType,
      branch.targetId,
      branch.tag,
      branch.decision,
      branch.reason,
    ].join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(branch);
  }
  return output;
}

function publicPlannerStep(
  step: ReconstructedPlannerStep,
  privateSignalKeys: Set<string>,
): ReconstructedPlannerStep {
  const branches = publicPlannerBranches(step.branches, privateSignalKeys);
  const selectedBranchCount = branches.filter((branch) => branch.decision !== "pruned").length;
  const prunedBranchCount = branches.filter((branch) => branch.decision === "pruned").length;
  return {
    ...step,
    selectedCue: publicRouteSignal(step.selectedCue, privateSignalKeys),
    cueReason: publicRouteReason(step.cueReason, privateSignalKeys) ?? step.cueReason,
    exploredAssociationCount: branches.length,
    hybridCandidateCount: step.hybridCandidateCount === undefined ? undefined : branches.length,
    selectedBranchCount,
    prunedBranchCount,
    generatedCues: publicRouteSignals(step.generatedCues, privateSignalKeys),
    branches,
  };
}

function publicPlannerTrace(
  trace: ReconstructedPlannerTrace,
  privateSignalKeys: Set<string>,
  stopReason: ReconstructedContext["stats"]["stopReason"],
): ReconstructedPlannerTrace {
  const steps: ReconstructedPlannerStep[] = [];
  const seenSteps = new Set<string>();
  for (const step of trace.steps.map((item) => publicPlannerStep(item, privateSignalKeys))) {
    const key = step.selectedCue;
    const existing = steps.find((candidate) => candidate.selectedCue === key);
    if (existing) {
      existing.generatedCues = publicRouteSignals(
        [...existing.generatedCues, ...step.generatedCues],
        privateSignalKeys,
      );
      existing.branches = publicPlannerBranches(
        [...existing.branches, ...step.branches],
        privateSignalKeys,
      );
      existing.exploredAssociationCount = existing.branches.length;
      existing.selectedBranchCount = existing.branches.filter((branch) => branch.decision !== "pruned").length;
      existing.prunedBranchCount = existing.branches.filter((branch) => branch.decision === "pruned").length;
      if (existing.hybridCandidateCount !== undefined || step.hybridCandidateCount !== undefined) {
        existing.hybridCandidateCount = existing.branches.length;
      }
      continue;
    }
    if (seenSteps.has(key)) continue;
    seenSteps.add(key);
    steps.push({ ...step, step: steps.length + 1 });
  }
  const anchorCoverage = publicAnchorCoverage(trace.anchorCoverage, privateSignalKeys);
  return {
    ...trace,
    initialCues: publicRouteSignals(trace.initialCues, privateSignalKeys),
    ...(anchorCoverage ? { anchorCoverage } : {}),
    steps,
    stopReason,
  };
}

interface ReconstructionIntent {
  expectedTags: Set<string>;
  requiredTagGroups: Array<{
    name: string;
    tags: Set<string>;
  }>;
  requiredAnchors: Array<{
    cue: string;
    key: string;
    hint?: string | undefined;
  }>;
  queryCues: Set<string>;
  explicitQueryCues: Set<string>;
  sweepCues: string[];
  reason: string;
}

interface FrontierCue {
  cue: string;
  priority: number;
  reason: string;
  anchorCue?: string | undefined;
  discovered?: boolean | undefined;
}

interface RankedAssociation {
  association: MemoryAssociationRecord;
  routeScore: number;
  routeReason: string;
}

interface RankedMemoryCandidate {
  memory: MemoryRecord;
  matchedQuery?: string | undefined;
  routeScore: number;
  routeReason: string;
}

interface AnchorCoverageDraft {
  anchorCue: string;
  key: string;
  required: boolean;
  hint?: string | undefined;
  candidateCount: number;
  attemptCount: number;
  includedCount: number;
  exhausted: boolean;
}

interface AnchorCoveragePlan {
  anchors: AnchorCoverageDraft[];
  nextIndex: number;
  quota: number;
  laneCount: number;
}

type EvidenceOutputSanitizer = (event: EvidenceEvent) => EvidenceEvent;

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

const CUE_KINDS = new Set<AssociationCue["cueKind"]>([
  "lexical",
  "kind",
  "scope",
  "predicate",
  "task",
  "entity",
  "temporal",
]);

function safeCueKind(value: unknown): AssociationCue["cueKind"] | null {
  return typeof value === "string" && CUE_KINDS.has(value as AssociationCue["cueKind"])
    ? value as AssociationCue["cueKind"]
    : null;
}

function safeCueValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 80);
  return trimmed && classifySensitivity(trimmed) === "normal" ? trimmed : "";
}

function customCueExtractorCues(input: {
  cueExtractor?: MemoryCueExtractor | undefined;
  text: string;
  phase: "query" | "evidence";
  maxCues: number;
}): AssociationCue[] {
  if (!input.cueExtractor) return [];
  try {
    const raw =
      typeof input.cueExtractor === "function"
        ? input.cueExtractor({
            text: input.text,
            phase: input.phase,
            maxCues: input.maxCues,
          })
        : input.cueExtractor.extract({
            text: input.text,
            phase: input.phase,
            maxCues: input.maxCues,
          });
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        const cue = safeCueValue(entry?.cue);
        const cueKind = safeCueKind(entry?.cueKind);
        return cue && cueKind ? { cue, cueKind } : null;
      })
      .filter((entry): entry is AssociationCue => entry !== null);
  } catch {
    return [];
  }
}

function uniqueCues(cues: AssociationCue[], max: number): AssociationCue[] {
  const seen = new Set<string>();
  const result: AssociationCue[] = [];
  for (const candidate of cues) {
    const key = associationCueKey(candidate.cue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= max) break;
  }
  return result;
}

function queryAssociationCues(
  query: string,
  max: number,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): AssociationCue[] {
  return uniqueCues([
    ...customCueExtractorCues({
      cueExtractor,
      text: query,
      phase: "query",
      maxCues: max,
    }),
    ...(inferTemporalCuesFromText
      ? temporalCueValuesFromText(query).map((cue) => ({ cue, cueKind: "temporal" as const }))
      : []),
    ...extractAssociationCues(query, max),
  ], max);
}

function evidenceAssociationCues(
  text: string,
  max: number,
  cueExtractor?: MemoryCueExtractor | undefined,
): AssociationCue[] {
  return uniqueCues([
    ...customCueExtractorCues({
      cueExtractor,
      text,
      phase: "evidence",
      maxCues: max,
    }),
    ...extractAssociationCues(text, max),
  ], max);
}

function queryCueSet(
  query: string,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): Set<string> {
  return new Set(
    queryAssociationCues(query, 48, cueExtractor, inferTemporalCuesFromText).map((cue) => cue.cue),
  );
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

function normalizedSweepCues(values: string[] | undefined, max: number): string[] {
  return normalizedCueHints(values, max);
}

function normalizedRequiredAnchors(
  values: ReconstructionIntentHint["requiredAnchors"] | undefined,
  max: number,
): ReconstructionIntent["requiredAnchors"] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const output: ReconstructionIntent["requiredAnchors"] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const cue = typeof value.cue === "string" ? value.cue.trim().slice(0, 160) : "";
    if (!cue || classifySensitivity(cue) !== "normal") continue;
    const key = associationCueKey(cue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hint = typeof value.hint === "string" ? value.hint.trim().slice(0, 240) : "";
    output.push({
      cue,
      key,
      ...(hint && classifySensitivity(hint) === "normal" ? { hint } : {}),
    });
    if (output.length >= max) break;
  }
  return output;
}

function routeSignalAppearsInPublicQuery(
  value: string,
  publicQuery: string,
): boolean {
  const signal = value.trim();
  if (!signal) return false;
  const normalizedSignal = normalizedText(signal);
  const normalizedQuery = normalizedText(publicQuery);
  if (normalizedQuery.includes(normalizedSignal)) return true;
  const signalKey = associationCueKey(signal);
  if (!signalKey) return false;
  const publicQueryCues = queryCueSet(publicQuery);
  return publicQueryCues.has(signal) || associationCueMatchesQuery(signal, publicQueryCues);
}

function privateRouteSignalKeys(
  intent: ReconstructionIntent,
  publicQuery: string,
  cueExtractor?: MemoryCueExtractor | undefined,
  privateRouteSignals: string[] = [],
): Set<string> {
  const keys = new Set<string>();
  const addPrivateKey = (value: string, includeParts = true): void => {
    const key = associationCueKey(value);
    if (!key) return;
    keys.add(key);
    if (!includeParts) return;
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
  for (const cue of customCueExtractorCues({
    cueExtractor,
    text: publicQuery,
    phase: "query",
    maxCues: 48,
  })) {
    if (routeSignalAppearsInPublicQuery(cue.cue, publicQuery)) continue;
    addPrivateKey(cue.cue);
  }
  for (const signal of privateRouteSignals) {
    if (routeSignalAppearsInPublicQuery(signal, publicQuery)) continue;
    addPrivateKey(signal, false);
  }
  return keys;
}

function publicRouteSignal(value: string, privateSignalKeys: Set<string>): string {
  const key = associationCueKey(value);
  const publicValue = key && privateSignalKeys.has(key) ? "retrieval_hint" : value;
  return safePublicInlineField(publicValue);
}

function uniqueDisplayValues(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizedText(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function publicRouteSignals(values: string[], privateSignalKeys: Set<string>): string[] {
  return uniqueDisplayValues(values.map((value) => publicRouteSignal(value, privateSignalKeys)));
}

function publicRouteReason(value: string | undefined, privateSignalKeys: Set<string>): string | undefined {
  if (!value) return value;
  return safePublicInlineField(redactPrivateRouteSignals(value, privateSignalKeys, "retrieval-hint"));
}

function privateOutputSignalKeys(input: {
  intent: ReconstructionIntent;
  privateRouteSignals?: string[] | undefined;
  publicQuery: string;
  cueExtractor?: MemoryCueExtractor | undefined;
}): Set<string> {
  const keys = new Set<string>();
  const addSignal = (value: string): void => {
    if (classifySensitivity(value) !== "normal") return;
    if (routeSignalAppearsInPublicQuery(value, input.publicQuery)) return;
    const trimmed = value.trim();
    if (trimmed) keys.add(trimmed);
  };
  const addOpaqueSignal = (value: string): void => {
    if (!opaqueRouteSignal(value)) return;
    addSignal(value);
  };
  for (const cue of input.intent.explicitQueryCues) {
    addOpaqueSignal(cue);
  }
  for (const tag of input.intent.expectedTags) {
    if (PUBLIC_STRUCTURED_INTENT_TAGS.has(tag)) continue;
    addOpaqueSignal(tag);
  }
  for (const value of input.privateRouteSignals ?? []) {
    addSignal(value);
  }
  for (const cue of customCueExtractorCues({
    cueExtractor: input.cueExtractor,
    text: input.publicQuery,
    phase: "query",
    maxCues: 48,
  })) {
    if (routeSignalAppearsInPublicQuery(cue.cue, input.publicQuery)) continue;
    addSignal(cue.cue);
  }
  return keys;
}

function opaqueRouteSignal(value: string): boolean {
  const key = associationCueKey(value);
  if (!key) return false;
  const parts = key.split("-").filter(Boolean);
  const hasSeparator = /[\s_.:/-]/u.test(value);
  const hasDigit = /\d/u.test(key);
  return key.length >= 20 && hasSeparator && (hasDigit || parts.length >= 4);
}

function privateSignalPattern(value: string): RegExp | null {
  return associationCueTextPattern(value);
}

function redactPrivateRouteSignals(
  value: string,
  privateSignalKeys: Set<string>,
  replacement = "retrieval_hint",
): string {
  if (privateSignalKeys.size === 0) return value;
  let output = value;
  for (const key of [...privateSignalKeys].sort((left, right) => right.length - left.length)) {
    const pattern = privateSignalPattern(key);
    if (!pattern) continue;
    output = output.replace(pattern, replacement);
  }
  return output;
}

function publicEvidenceCoverage(
  coverage: ReconstructionEvidenceCoverage,
  privateSignalKeys: Set<string>,
): ReconstructionEvidenceCoverage {
  const coveredCues = publicRouteSignals(coverage.coveredCues, privateSignalKeys);
  const coveredCueKeys = new Set(coveredCues.map(normalizedText));
  const uncoveredCues = publicRouteSignals(coverage.uncoveredCues, privateSignalKeys)
    .filter((cue) => !coveredCueKeys.has(normalizedText(cue)));
  const queryCueCount = uniqueDisplayValues([...coveredCues, ...uncoveredCues]).length;
  const coveredCueCount = coveredCues.length;
  const coverageRate =
    queryCueCount === 0 ? (coveredCueCount > 0 ? 1 : 0) : coveredCueCount / queryCueCount;
  return {
    ...coverage,
    queryCueCount,
    coveredCueCount,
    coverageRate,
    coveredCues,
    uncoveredCues,
  };
}

function boundedPublicScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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

function timestampMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRankedAssociations(left: RankedAssociation, right: RankedAssociation): number {
  const score = right.routeScore - left.routeScore;
  if (score !== 0) return score;
  const recency = timestampMs(right.association.updatedAt) - timestampMs(left.association.updatedAt);
  if (recency !== 0) return recency;
  return left.association.id.localeCompare(right.association.id);
}

function compareRankedMemoryCandidates(
  left: RankedMemoryCandidate,
  right: RankedMemoryCandidate,
): number {
  const score = right.routeScore - left.routeScore;
  if (score !== 0) return score;
  const recency = timestampMs(right.memory.updatedAt) - timestampMs(left.memory.updatedAt);
  if (recency !== 0) return recency;
  return left.memory.id.localeCompare(right.memory.id);
}

function compareFrontierCue(left: FrontierCue, right: FrontierCue): number {
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;
  return left.cue.localeCompare(right.cue);
}

function anchorCuesForQuery(
  query: string,
  intent: ReconstructionIntent,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): Array<{ cue: string; required: boolean; hint?: string | undefined }> {
  // Host-declared intent cues outrank derived lexical cues so tiny budgets
  // never starve an anchor the host explicitly asked for.
  const anchors = [
    ...intent.requiredAnchors.map((anchor) => ({
      cue: anchor.cue,
      required: true,
      ...(anchor.hint ? { hint: anchor.hint } : {}),
    })),
    ...[...intent.explicitQueryCues].map((cue) => ({ cue, required: false })),
    ...queryAssociationCues(query, 12, cueExtractor, inferTemporalCuesFromText)
      .map((cue) => ({ cue: cue.cue, required: false })),
  ];
  const seen = new Set<string>();
  const output: Array<{ cue: string; required: boolean; hint?: string | undefined }> = [];
  for (const anchor of anchors) {
    const key = associationCueKey(anchor.cue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(anchor);
  }
  return output.length > 0 ? output : [{ cue: query, required: false }];
}

function createAnchorCoveragePlan(input: {
  query: string;
  intent: ReconstructionIntent;
  maxSteps: number;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
}): AnchorCoveragePlan {
  const anchors = anchorCuesForQuery(
    input.query,
    input.intent,
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  ).map((anchorCue) => ({
    anchorCue: anchorCue.cue,
    key: associationCueKey(anchorCue.cue),
    required: anchorCue.required,
    ...(anchorCue.hint ? { hint: anchorCue.hint } : {}),
    candidateCount: 0,
    attemptCount: 0,
    includedCount: 0,
    exhausted: false,
  }));
  // Reserve roughly a quarter of the step budget for evidence-driven chain
  // expansion; the remaining steps become seed lanes. Lanes beyond the cap
  // still report coverage but do not reserve exploration turns.
  const laneCount = Math.min(
    anchors.length,
    Math.max(2, input.maxSteps - Math.max(1, Math.ceil(input.maxSteps / 4))),
  );
  return {
    anchors,
    nextIndex: 0,
    quota: Math.max(1, Math.floor(input.maxSteps / Math.max(1, laneCount))),
    laneCount,
  };
}

function assignFrontierAnchors(frontier: FrontierCue[], plan: AnchorCoveragePlan | null): void {
  if (!plan || plan.anchors.length === 0) return;
  const primaryAnchor = plan.anchors[0]?.anchorCue;
  const anchorByKey = new Map(plan.anchors.map((anchor) => [anchor.key, anchor.anchorCue]));
  for (const cue of frontier) {
    const key = associationCueKey(cue.cue);
    cue.anchorCue = anchorByKey.get(key) ?? primaryAnchor ?? cue.cue;
  }
}

function anchorForCue(plan: AnchorCoveragePlan | null, cue: FrontierCue): AnchorCoverageDraft | null {
  if (!plan) return null;
  const key = associationCueKey(cue.anchorCue ?? cue.cue);
  return plan.anchors.find((anchor) => anchor.key === key) ?? null;
}

function frontierIndexForAnchor(
  frontier: FrontierCue[],
  explored: Set<string>,
  anchorKey?: string | undefined,
  options: { includeDiscovered?: boolean | undefined } = {},
): number {
  return frontier.findIndex((cue) => {
    if (explored.has(cue.cue)) return false;
    if (options.includeDiscovered === false && cue.discovered) return false;
    if (!anchorKey) return true;
    return associationCueKey(cue.anchorCue ?? cue.cue) === anchorKey;
  });
}

function seedLaneCount(plan: AnchorCoveragePlan): number {
  return Math.min(plan.laneCount, plan.anchors.length);
}

function seedAnchorIndex(plan: AnchorCoveragePlan, anchor: AnchorCoverageDraft): number {
  return plan.anchors.findIndex((entry) => entry.key === anchor.key);
}

function isSeedAnchor(plan: AnchorCoveragePlan, anchor: AnchorCoverageDraft): boolean {
  const index = seedAnchorIndex(plan, anchor);
  return index >= 0 && index < seedLaneCount(plan);
}

function reservableUncoveredSeedLaneCount(
  plan: AnchorCoveragePlan | null,
  frontier: FrontierCue[],
  explored: Set<string>,
  excludeAnchorKey?: string | undefined,
): number {
  if (!plan) return 0;
  let count = 0;
  for (const anchor of plan.anchors.slice(0, seedLaneCount(plan))) {
    if (anchor.key === excludeAnchorKey) continue;
    if (anchor.includedCount > 0 || anchor.exhausted || anchor.attemptCount >= plan.quota) continue;
    if (frontierIndexForAnchor(frontier, explored, anchor.key, { includeDiscovered: false }) < 0) {
      continue;
    }
    count += 1;
  }
  return count;
}

function reservableRequiredAnchorCount(
  plan: AnchorCoveragePlan | null,
  excludeAnchorKey?: string | undefined,
): number {
  if (!plan) return 0;
  return plan.anchors.filter((anchor) =>
    anchor.required &&
    anchor.key !== excludeAnchorKey &&
    anchor.includedCount === 0 &&
    !anchor.exhausted
  ).length;
}

function canIncludeMemoryForAnchor(input: {
  plan: AnchorCoveragePlan | null;
  cue: FrontierCue;
  frontier: FrontierCue[];
  explored: Set<string>;
  memoryCount: number;
  maxMemories: number;
}): boolean {
  if (input.memoryCount >= input.maxMemories) return false;
  const anchor = anchorForCue(input.plan, input.cue);
  if (!input.plan || !anchor) return true;
  if (isSeedAnchor(input.plan, anchor) && anchor.includedCount === 0 && !anchor.exhausted) {
    return true;
  }
  if (anchor.required && anchor.includedCount === 0 && !anchor.exhausted) return true;
  // Covered lanes can keep expanding, but not by spending the last slot that
  // an uncovered seed lane could still use for its first included memory.
  const reserved =
    reservableRequiredAnchorCount(input.plan, anchor.key) +
    reservableUncoveredSeedLaneCount(input.plan, input.frontier, input.explored);
  return input.memoryCount + 1 <= input.maxMemories - reserved;
}

function noteAnchorIncludedMemory(
  plan: AnchorCoveragePlan | null,
  anchorCue: string | undefined,
): void {
  if (!plan) return;
  const key = associationCueKey(anchorCue ?? "");
  const anchor = plan.anchors.find((entry) => entry.key === key);
  if (anchor) anchor.includedCount += 1;
}

function noteAnchorExhausted(
  plan: AnchorCoveragePlan | null,
  anchorCue: string | undefined,
): void {
  if (!plan) return;
  const key = associationCueKey(anchorCue ?? "");
  const anchor = plan.anchors.find((entry) => entry.key === key);
  if (anchor && anchor.includedCount === 0) anchor.exhausted = true;
}

function selectFrontierCue(
  frontier: FrontierCue[],
  explored: Set<string>,
  plan: AnchorCoveragePlan | null,
): FrontierCue | undefined {
  frontier.sort(compareFrontierCue);
  const laneCount = plan ? seedLaneCount(plan) : 0;
  if (plan && laneCount > 0) {
    for (let offset = 0; offset < laneCount; offset += 1) {
      const index = (plan.nextIndex + offset) % laneCount;
      const anchor = plan.anchors[index];
      if (
        !anchor ||
        anchor.includedCount > 0 ||
        anchor.exhausted ||
        anchor.attemptCount >= plan.quota
      ) {
        continue;
      }
      const frontierIndex = frontierIndexForAnchor(
        frontier,
        explored,
        anchor.key,
        { includeDiscovered: false },
      );
      if (frontierIndex < 0) continue;
      plan.nextIndex = (index + 1) % laneCount;
      anchor.attemptCount += 1;
      return frontier.splice(frontierIndex, 1)[0];
    }
  }
  const frontierIndex = frontierIndexForAnchor(frontier, explored);
  if (frontierIndex < 0) return undefined;
  const cue = frontier.splice(frontierIndex, 1)[0];
  const anchor = cue ? anchorForCue(plan, cue) : null;
  if (anchor) anchor.attemptCount += 1;
  return cue;
}

function addAnchorCandidateCount(
  plan: AnchorCoveragePlan | null,
  anchorCue: string | undefined,
  count: number,
): void {
  if (!plan || count <= 0) return;
  const key = associationCueKey(anchorCue ?? "");
  const anchor = plan.anchors.find((entry) => entry.key === key);
  if (anchor) anchor.candidateCount += count;
}

function anchorCoverageReport(
  plan: AnchorCoveragePlan | null,
  paths: ReconstructedEvidencePath[],
): ReconstructionAnchorCoverageReport | undefined {
  if (!plan) return undefined;
  const anchors = plan.anchors.map((anchor) => {
    const includedCount = paths.filter((path) =>
      path.targetType === "memory" && associationCueKey(path.anchorCue ?? "") === anchor.key
    ).length;
    return {
      anchorCue: anchor.anchorCue,
      ...(anchor.required ? { required: true } : {}),
      ...(anchor.hint ? { hint: anchor.hint } : {}),
      candidateCount: anchor.candidateCount,
      includedCount,
      uncovered: includedCount === 0,
    };
  });
  const requiredAnchors = anchors.filter((anchor) => anchor.required === true);
  return {
    anchorCount: anchors.length,
    coveredAnchorCount: anchors.filter((anchor) => !anchor.uncovered).length,
    uncoveredAnchors: anchors.filter((anchor) => anchor.uncovered).map((anchor) => anchor.anchorCue),
    requiredAnchorCount: requiredAnchors.length,
    coveredRequiredAnchorCount: requiredAnchors.filter((anchor) => !anchor.uncovered).length,
    requiredAnchorUnmet: requiredAnchors
      .filter((anchor) => anchor.uncovered)
      .map((anchor) => anchor.anchorCue),
    anchors,
  };
}

function publicAnchorCoverage(
  report: ReconstructionAnchorCoverageReport | undefined,
  privateSignalKeys: Set<string>,
): ReconstructionAnchorCoverageReport | undefined {
  if (!report) return undefined;
  const merged = new Map<string, ReconstructionAnchorCoverageReport["anchors"][number]>();
  for (const anchor of report.anchors) {
    const anchorCue = anchor.required === true
      ? safePublicInlineField(anchor.anchorCue)
      : publicRouteSignal(anchor.anchorCue, privateSignalKeys);
    const hint = anchor.hint ? safePublicInlineField(anchor.hint) : undefined;
    const key = `${anchor.required === true ? "required" : "ordinary"}:${normalizedText(anchorCue)}`;
    const existing = merged.get(key);
    if (existing) {
      existing.candidateCount += anchor.candidateCount;
      existing.includedCount += anchor.includedCount;
      existing.uncovered = existing.includedCount === 0;
      if (anchor.required === true) existing.required = true;
      existing.hint = existing.hint ?? hint;
    } else {
      merged.set(key, {
        ...anchor,
        anchorCue,
        ...(hint ? { hint } : {}),
      });
    }
  }
  const anchors = [...merged.values()].map((anchor) => ({
    ...anchor,
    uncovered: anchor.includedCount === 0,
  }));
  return {
    anchorCount: anchors.length,
    coveredAnchorCount: anchors.filter((anchor) => !anchor.uncovered).length,
    uncoveredAnchors: anchors.filter((anchor) => anchor.uncovered).map((anchor) => anchor.anchorCue),
    requiredAnchorCount: anchors.filter((anchor) => anchor.required === true).length,
    coveredRequiredAnchorCount: anchors.filter((anchor) =>
      anchor.required === true && !anchor.uncovered
    ).length,
    requiredAnchorUnmet: anchors
      .filter((anchor) => anchor.required === true && anchor.uncovered)
      .map((anchor) => anchor.anchorCue),
    anchors,
  };
}

function anchorCoverageWithIncludedCounts(
  report: ReconstructionAnchorCoverageReport | undefined,
  paths: ReconstructedEvidencePath[],
): ReconstructionAnchorCoverageReport | undefined {
  if (!report) return undefined;
  const anchors = report.anchors.map((anchor) => {
    const key = associationCueKey(anchor.anchorCue);
    const includedCount = paths.filter((path) =>
      path.targetType === "memory" && associationCueKey(path.anchorCue ?? "") === key
    ).length;
    return {
      ...anchor,
      includedCount,
      uncovered: includedCount === 0,
    };
  });
  const requiredAnchors = anchors.filter((anchor) => anchor.required === true);
  return {
    anchorCount: anchors.length,
    coveredAnchorCount: anchors.filter((anchor) => !anchor.uncovered).length,
    uncoveredAnchors: anchors.filter((anchor) => anchor.uncovered).map((anchor) => anchor.anchorCue),
    requiredAnchorCount: requiredAnchors.length,
    coveredRequiredAnchorCount: requiredAnchors.filter((anchor) => !anchor.uncovered).length,
    requiredAnchorUnmet: requiredAnchors
      .filter((anchor) => anchor.uncovered)
      .map((anchor) => anchor.anchorCue),
    anchors,
  };
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

function coverageCues(
  query: string,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): string[] {
  return uniqueStrings(
    queryAssociationCues(query, 16, cueExtractor, inferTemporalCuesFromText).map((cue) => cue.cue),
  ).slice(0, 8);
}

function pathCoversCue(
  path: ReconstructedEvidencePath,
  cue: string,
  cueExtractor?: MemoryCueExtractor | undefined,
): boolean {
  const normalizedCue = normalizedText(cue);
  const pathText = `${path.cue} ${path.tag} ${path.targetKind ?? ""} ${path.targetSummary}`;
  if (normalizedText(pathText).includes(normalizedCue)) return true;
  const cueKey = associationCueKey(cue);
  if (!cueKey) return false;
  const pathKeys = new Set(
    evidenceAssociationCues(pathText, 64, cueExtractor)
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
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): ReconstructionEvidenceCoverage {
  const cues = coverageCues(query, cueExtractor, inferTemporalCuesFromText);
  const coveredCues = cues.filter((cue) =>
    paths.some((path) => pathCoversCue(path, cue, cueExtractor))
  );
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

function shouldRunHybridDirectMemorySearch(input: {
  recallPurpose: ReconstructionRecallPurpose;
  memories: MemoryRecord[];
  paths: ReconstructedEvidencePath[];
  maxMemories: number;
  targetMemoryCount: number;
  intent: ReconstructionIntent;
  coverage: ReconstructionEvidenceCoverage;
}): boolean {
  return (
    (input.recallPurpose === "history" && input.memories.length < input.targetMemoryCount) ||
    input.paths.length === 0 ||
    input.memories.length < Math.min(2, input.maxMemories) ||
    !hasIntentEvidence(input.paths, input.intent) ||
    !coverageIsSufficient(input.coverage)
  );
}

function publicEvidenceConvergence(input: {
  convergence: ReconstructionEvidenceConvergence;
  coverage: ReconstructionEvidenceCoverage;
  paths: ReconstructedEvidencePath[];
  privateSignalKeys: Set<string>;
}): ReconstructionEvidenceConvergence {
  const selectedTags = uniqueDisplayValues(input.paths.map((path) => safePublicLabel(path.tag))).slice(0, 12);
  if (input.privateSignalKeys.size === 0) {
    return {
      ...input.convergence,
      selectedTags,
    };
  }
  const fallbackScore = input.convergence.reached
    ? Math.max(input.convergence.threshold, input.coverage.coverageRate)
    : Math.min(input.convergence.threshold - 0.01, input.coverage.coverageRate);
  return {
    ...input.convergence,
    score: boundedPublicScore(fallbackScore),
    prunedBranchCount: 0,
    frontierRemaining: 0,
    selectedPathCount: input.paths.length,
    selectedTags,
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
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
  options: { includeRequiredAnchors?: boolean | undefined } = {},
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
  const sweepCues = normalizedSweepCues(hint.sweepCues, 8);
  const requiredAnchors = options.includeRequiredAnchors === false
    ? []
    : normalizedRequiredAnchors(hint.requiredAnchors, 12);
  if (
    expectedTags.size === 0 &&
    requiredTagGroups.length === 0 &&
    explicitQueryCues.length === 0 &&
    requiredAnchors.length === 0 &&
    sweepCues.length === 0
  ) {
    return null;
  }
  return {
    expectedTags,
    requiredTagGroups,
    queryCues: new Set([
      ...queryCueSet(query, cueExtractor, inferTemporalCuesFromText),
      ...explicitQueryCues,
      ...requiredAnchors.map((anchor) => anchor.cue),
    ]),
    explicitQueryCues: new Set([...explicitQueryCues, ...requiredAnchors.map((anchor) => anchor.cue)]),
    requiredAnchors,
    sweepCues,
    reason:
      requiredAnchors.length > 0
        ? "structured:required_anchors"
        : requiredTagGroups.length > 0
        ? `structured:${requiredTagGroups.map((group) => group.name).join("+")}`
        : expectedTags.size > 0
          ? "structured:expected_tags"
          : explicitQueryCues.length > 0
            ? "structured:query_cues"
            : "structured:sweep_cues",
  };
}

function inferReconstructionIntent(
  query: string,
  hint?: ReconstructionIntentHint | undefined,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
  options: { includeRequiredAnchors?: boolean | undefined } = {},
): ReconstructionIntent {
  const explicit = explicitReconstructionIntent(
    query,
    hint,
    cueExtractor,
    inferTemporalCuesFromText,
    options,
  );
  if (explicit) return explicit;
  return {
    expectedTags: new Set<string>(),
    requiredTagGroups: [],
    requiredAnchors: [],
    queryCues: queryCueSet(query, cueExtractor, inferTemporalCuesFromText),
    explicitQueryCues: new Set<string>(),
    sweepCues: [],
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

function seedFrontier(
  query: string,
  intent: ReconstructionIntent,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): FrontierCue[] {
  const cues = queryAssociationCues(query, 12, cueExtractor, inferTemporalCuesFromText);
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
    if (contentHasNonSourceQueryEntity(memory.content, intent, sourceCueKeys)) return null;
    if (contentMentionsStructuredQueryParticipant(memory.content, memory, intent, sourceCueKeys)) {
      return null;
    }
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
  if (contentMentionsStructuredQueryParticipant(memory.content, memory, intent, sourceCueKeys)) {
    return null;
  }
  return selectedSourceCues.size > 0 &&
    !sourceCues.some((cue) => selectedSourceCues.has(associationCueKey(cue)))
    ? `source_scope_mismatch:${[...selectedSourceCues].join("|")}`
    : null;
}

function sourceScopedFallbackMemories(
  memories: MemoryRecord[],
  intent: ReconstructionIntent,
): MemoryRecord[] {
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
  associationCue: string,
  sourceCues: string[],
  sourceMemory: MemoryRecord | null,
  targetSummary: string,
  intent: ReconstructionIntent,
  selectedSourceCues: Set<string>,
): string | null {
  const sourceCueKeys = new Set<string>();
  for (const sourceCue of sourceCues) {
    const sourceCueKey = associationCueKey(sourceCue);
    if (!sourceCueKey) continue;
    sourceCueKeys.add(sourceCueKey);
    if (entityCueMatchesQuery(sourceCue, intent)) {
      selectedSourceCues.add(sourceCueKey);
      return null;
    }
  }
  if (sourceCues.length === 0) {
    if (contentHasNonSourceQueryEntity(targetSummary, intent, sourceCueKeys)) return null;
    if (
      sourceMemory &&
      contentMentionsStructuredQueryParticipant(targetSummary, sourceMemory, intent, sourceCueKeys)
    ) {
      return null;
    }
    return selectedSourceCues.size > 0
      ? `source_scope_mismatch:${[...selectedSourceCues].join("|")}`
      : null;
  }
  if (contentHasNonSourceQueryEntity(targetSummary, intent, sourceCueKeys)) {
    return null;
  }
  if (
    sourceMemory &&
    contentMentionsStructuredQueryParticipant(targetSummary, sourceMemory, intent, sourceCueKeys)
  ) {
    return null;
  }
  const associationCueKeyValue = associationCueKey(associationCue);
  if (associationCueKeyValue && selectedSourceCues.has(associationCueKeyValue)) {
    return null;
  }
  return selectedSourceCues.size > 0 &&
      ![...sourceCueKeys].some((sourceCueKey) => selectedSourceCues.has(sourceCueKey))
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

function publicMetadataCue(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || /^\[redacted_[a-z_]+\]$/iu.test(trimmed)) return "";
  return classifySensitivity(trimmed) === "normal" ? trimmed : "";
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.map(publicMetadataCue).filter(Boolean) : [];
}

function structuredParticipantCuesForMemory(memory: MemoryRecord): string[] {
  const metadata = memory.metadata;
  const sourceMetadata = metadataRecord(metadata.sourceMetadata);
  const mentionCues = Array.isArray(metadata.entityMentions)
    ? metadata.entityMentions.flatMap((entry) => {
        const record = metadataRecord(entry);
        if (!record || record.role !== "participant") return [];
        return [publicMetadataCue(record.value)];
      })
    : [];
  return uniqueDisplayValues([
    ...metadataStringArray(metadata, "participants"),
    ...(sourceMetadata ? metadataStringArray(sourceMetadata, "participants") : []),
    ...mentionCues,
  ]);
}

function contentMentionsStructuredQueryParticipant(
  content: string,
  memory: MemoryRecord,
  intent: ReconstructionIntent,
  sourceCueKeys: Set<string>,
): boolean {
  for (const participantCue of structuredParticipantCuesForMemory(memory)) {
    const participantKey = associationCueKey(participantCue);
    if (!participantKey || sourceCueKeys.has(participantKey)) continue;
    if (!entityCueMatchesQuery(participantCue, intent)) continue;
    const pattern = associationCueTextPattern(participantCue);
    if (pattern?.test(content)) return true;
  }
  return false;
}

function sourceEntityCuesForMemory(memory: MemoryRecord): string[] {
  return sourceMetadataEntityCues(memory.metadata);
}

function structuredSubjectCuesForAssociation(association: MemoryAssociationRecord): string[] {
  if (association.targetType !== "world_belief") return [];
  const summary = association.targetSummary.trim();
  const match =
    /^(user|person:.+?)\s+[a-z][a-z0-9_-]*\./iu.exec(summary) ??
    /^(user|person:[^\s]+)/iu.exec(summary);
  const subject = match?.[1];
  if (!subject) return [];
  const barePerson = /^person:(.+)$/iu.exec(subject)?.[1]?.trim();
  return barePerson ? [subject, barePerson] : [subject];
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

interface DirectMemoryCandidate {
  memory: MemoryRecord;
  matchedQuery?: string | undefined;
  searchRank: number;
}

interface ReconstructionSweepCandidate {
  cue: string;
  memory: MemoryRecord;
  relevance: number;
}

interface ReconstructionSweepCueDraftStats {
  cue: string;
  matched: number;
}

interface ReconstructionSweepDraft {
  candidates: ReconstructionSweepCandidate[];
  cueStats: ReconstructionSweepCueDraftStats[];
}

const DEFAULT_SWEEP_PER_CUE_CAP = 40;
const DEFAULT_SWEEP_GLOBAL_CAP = 80;

function internalFusionScore(memory: MemoryRecord): number {
  const value = Number((memory as MemoryRecord & { __gmosFusionScore?: unknown }).__gmosFusionScore);
  return Number.isFinite(value) ? value : memory.confidence;
}

function compareSweepChronological(
  left: ReconstructionSweepCandidate,
  right: ReconstructionSweepCandidate,
): number {
  return left.memory.createdAt.localeCompare(right.memory.createdAt) ||
    left.memory.id.localeCompare(right.memory.id);
}

function compareSweepCullPriority(
  left: ReconstructionSweepCandidate,
  right: ReconstructionSweepCandidate,
): number {
  return left.relevance - right.relevance ||
    right.memory.createdAt.localeCompare(left.memory.createdAt) ||
    right.memory.id.localeCompare(left.memory.id);
}

function sweepStatsFor(
  cueStats: ReconstructionSweepCueDraftStats[],
  candidates: ReconstructionSweepCandidate[],
): NonNullable<ReconstructedContext["stats"]["sweeps"]> {
  const includedByCue = new Map<string, number>();
  for (const candidate of candidates) {
    includedByCue.set(candidate.cue, (includedByCue.get(candidate.cue) ?? 0) + 1);
  }
  const cues = cueStats.map((cue) => {
    const included = includedByCue.get(cue.cue) ?? 0;
    return {
      cue: cue.cue,
      matched: cue.matched,
      included,
      truncated: Math.max(0, cue.matched - included),
    };
  });
  return {
    matched: cues.reduce((sum, cue) => sum + cue.matched, 0),
    included: cues.reduce((sum, cue) => sum + cue.included, 0),
    truncated: cues.reduce((sum, cue) => sum + cue.truncated, 0),
    cues,
  };
}

async function runReconstructionSweeps(input: {
  store: MemoryStore;
  profileId: string;
  sweepCues: string[];
  recallPurpose: ReconstructionRecallPurpose;
  includeSensitive?: boolean | undefined;
  queryEmbedding?: QueryVectorEmbedding | undefined;
  perCueCap?: number | undefined;
  globalCap?: number | undefined;
}): Promise<ReconstructionSweepDraft | undefined> {
  if (input.sweepCues.length === 0) return undefined;
  const perCueCap = boundedInteger(
    input.perCueCap,
    DEFAULT_SWEEP_PER_CUE_CAP,
    1,
    DEFAULT_SWEEP_PER_CUE_CAP,
  );
  const globalCap = boundedInteger(
    input.globalCap,
    DEFAULT_SWEEP_GLOBAL_CAP,
    1,
    DEFAULT_SWEEP_GLOBAL_CAP,
  );
  const seen = new Set<string>();
  const candidates: ReconstructionSweepCandidate[] = [];
  const cueStats: ReconstructionSweepCueDraftStats[] = [];
  for (const cue of input.sweepCues) {
    const found = await input.store.searchMemories({
      profileId: input.profileId,
      query: cue,
      purpose: input.recallPurpose,
      includeSensitive: input.includeSensitive,
      limit: perCueCap + 1,
      ...(input.queryEmbedding ? { freshQueryEmbedding: true } : {}),
    });
    cueStats.push({ cue, matched: found.length });
    for (const memory of found.slice(0, perCueCap)) {
      if (seen.has(memory.id) || candidates.length >= globalCap) continue;
      seen.add(memory.id);
      candidates.push({
        cue,
        memory,
        relevance: internalFusionScore(memory),
      });
    }
  }
  return {
    candidates: candidates.sort(compareSweepChronological),
    cueStats,
  };
}

function directMemorySearchQueries(
  query: string,
  intent: ReconstructionIntent,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): string[] {
  const cues = queryAssociationCues(query, 12, cueExtractor, inferTemporalCuesFromText)
    .filter((cue) =>
      cue.cueKind === "entity" ||
      cue.cueKind === "temporal" ||
      [...cue.cue].length >= 8
    )
    .map((cue) => cue.cue);
  return uniqueDisplayValues([query, ...intent.explicitQueryCues, ...cues]).slice(0, 10);
}

async function searchDirectMemoryCandidates(input: {
  store: MemoryStore;
  profileId: string;
  query: string;
  queryEmbedding?: QueryVectorEmbedding | null | undefined;
  intent: ReconstructionIntent;
  recallPurpose: ReconstructionRecallPurpose;
  includeSensitive?: boolean | undefined;
  maxMemories: number;
  searchQueries?: string[] | undefined;
  freshQueryEmbedding?: boolean | undefined;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
}): Promise<DirectMemoryCandidate[]> {
  const candidates = new Map<string, DirectMemoryCandidate>();
  const limit = input.maxMemories <= 24
    ? Math.min(input.maxMemories * 4, 48)
    : Math.min(input.maxMemories * 4, 1024);
  const searchQueries = input.searchQueries ?? directMemorySearchQueries(
    input.query,
    input.intent,
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  );
  for (const [queryIndex, searchQuery] of searchQueries.entries()) {
    const memories = await input.store.searchMemories({
      profileId: input.profileId,
      query: searchQuery,
      purpose: input.recallPurpose,
      includeSensitive: input.includeSensitive,
      limit,
      ...(input.freshQueryEmbedding
        ? { freshQueryEmbedding: true }
        : input.queryEmbedding === null
          ? { queryEmbedding: null }
          : input.queryEmbedding
            ? { queryEmbedding: input.queryEmbedding }
            : {}),
    });
    for (const [memoryIndex, memory] of memories.entries()) {
      const existing = candidates.get(memory.id);
      const searchRank = queryIndex * limit + memoryIndex + 1;
      if (existing && existing.searchRank <= searchRank) continue;
      candidates.set(memory.id, {
        memory,
        matchedQuery: searchQuery === input.query ? undefined : searchQuery,
        searchRank,
      });
    }
  }
  return [...candidates.values()].sort((a, b) => a.searchRank - b.searchRank);
}

function rankDirectMemory(
  candidate: DirectMemoryCandidate,
  rank: number,
  intent: ReconstructionIntent,
): RankedMemoryCandidate {
  const memory = candidate.memory;
  const reasons = [`hybrid_direct_memory_rrf:${rank}`];
  let routeScore = memory.confidence + reciprocalRankScore(rank) * 100;
  if (candidate.matchedQuery) {
    routeScore += 5;
    reasons.push("cue_search");
  }
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
  return { memory, matchedQuery: candidate.matchedQuery, routeScore, routeReason: reasons.join(",") };
}

function pathFromDirectMemory(
  candidate: RankedMemoryCandidate,
  step: number,
  query: string,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
  anchorCue?: string | undefined,
): ReconstructedEvidencePath {
  return {
    id: `hybrid:${candidate.memory.id}`,
    step,
    cue: directMemoryCue(candidate.memory, query, cueExtractor, inferTemporalCuesFromText),
    tag: "hybrid_memory",
    targetType: "memory",
    targetId: candidate.memory.id,
    targetKind: candidate.memory.kind,
    targetSummary: candidate.memory.content,
    confidence: candidate.memory.confidence,
    routeScore: candidate.routeScore,
    routeReason: candidate.routeReason,
    routeSources: ["hybrid_direct_memory"],
    informationGain: Math.max(0.1, candidate.memory.confidence),
    sourceMemoryId: candidate.memory.id,
    sourceEvidenceId: candidate.memory.sourceEventId,
    createdAt: candidate.memory.createdAt,
    ...(anchorCue ? { anchorCue } : {}),
  };
}

function directMemoryCue(
  memory: MemoryRecord,
  query: string,
  cueExtractor?: MemoryCueExtractor | undefined,
  inferTemporalCuesFromText = false,
): string {
  const searchable = normalizedText(`${memory.kind} ${memory.scope} ${memory.content}`);
  for (const cue of coverageCues(query, cueExtractor, inferTemporalCuesFromText)) {
    if (searchable.includes(normalizedText(cue))) return cue;
  }
  return memory.kind;
}

function addRouteSignal(path: ReconstructedEvidencePath, score: number, reason: string): void {
  path.routeScore = (path.routeScore ?? path.confidence) + score;
  path.routeReason = path.routeReason ? `${path.routeReason},${reason}` : reason;
  path.routeSources = [...new Set([...(path.routeSources ?? []), "hybrid_direct_memory"])];
}

function informationGainForPath(input: {
  query: string;
  paths: ReconstructedEvidencePath[];
  path: ReconstructedEvidencePath;
  intent: ReconstructionIntent;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
}): { gain: number; reasons: string[] } {
  const before = evidenceCoverageForPaths(
    input.query,
    input.paths,
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  );
  const after = evidenceCoverageForPaths(
    input.query,
    [...input.paths, input.path],
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  );
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
  queryEmbedding?: QueryVectorEmbedding | null | undefined;
  intent: ReconstructionIntent;
  recallPurpose: ReconstructionRecallPurpose;
  includeSensitive?: boolean | undefined;
  maxMemories: number;
  memories: MemoryRecord[];
  paths: ReconstructedEvidencePath[];
  seenMemoryIds: Set<string>;
  selectedSourceCues: Set<string>;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
  searchQueries?: string[] | undefined;
  anchorCue?: string | undefined;
  freshQueryEmbedding?: boolean | undefined;
  maxNewPaths?: number | undefined;
  reinforceExisting?: boolean | undefined;
  supplyFill?: boolean | undefined;
}): Promise<{
  candidateCount: number;
  reinforcedPaths: ReconstructedEvidencePath[];
  selectedNewPaths: ReconstructedEvidencePath[];
}> {
  const directMemoryCandidates = await searchDirectMemoryCandidates({
    store: input.store,
    profileId: input.profileId,
    query: input.query,
    queryEmbedding: input.queryEmbedding,
    intent: input.intent,
    recallPurpose: input.recallPurpose,
    includeSensitive: input.includeSensitive,
    maxMemories: input.maxMemories,
    ...(input.searchQueries ? { searchQueries: input.searchQueries } : {}),
    ...(input.freshQueryEmbedding ? { freshQueryEmbedding: true } : {}),
    cueExtractor: input.cueExtractor,
    inferTemporalCuesFromText: input.inferTemporalCuesFromText,
  });
  const rankedCandidates = directMemoryCandidates
    .map((memory, index) => rankDirectMemory(memory, index + 1, input.intent))
    .sort(compareRankedMemoryCandidates);
  const temporalConstraints = [...input.intent.queryCues].filter(exactTemporalCue);
  const reinforcedPaths: ReconstructedEvidencePath[] = [];
  const selectedNewPaths: ReconstructedEvidencePath[] = [];
  if (input.reinforceExisting !== false) {
    for (const candidate of rankedCandidates) {
      const existingPath = input.paths.find(
        (path) => path.targetType === "memory" && path.targetId === candidate.memory.id,
      );
      if (!existingPath) continue;
      if (!existingPath.routeSources?.includes("hybrid_direct_memory")) {
        addRouteSignal(existingPath, candidate.routeScore, candidate.routeReason);
        reinforcedPaths.push({ ...existingPath });
      }
    }
  }
  const directStep = Math.max(
    1,
    input.paths.length === 0 ? 1 : Math.max(...input.paths.map((path) => path.step)) + 1,
  );
  for (const candidate of rankedCandidates) {
    if (input.memories.length >= input.maxMemories) break;
    if (input.supplyFill !== true && input.maxNewPaths !== undefined && selectedNewPaths.length >= input.maxNewPaths) break;
    if (input.seenMemoryIds.has(candidate.memory.id)) continue;
    if (!memoryMatchesTemporalConstraint(candidate.memory, temporalConstraints)) continue;
    if (input.supplyFill !== true) {
      const sourceRejectReason = sourceScopeRejectReason(
        candidate.memory,
        input.intent,
        input.selectedSourceCues,
      );
      if (sourceRejectReason) continue;
    }
    input.seenMemoryIds.add(candidate.memory.id);
    input.memories.push(candidate.memory);
    const path = pathFromDirectMemory(
      candidate,
      directStep,
      input.query,
      input.cueExtractor,
      input.inferTemporalCuesFromText,
      input.anchorCue,
    );
    input.paths.push(path);
    selectedNewPaths.push({ ...path });
  }
  return { candidateCount: rankedCandidates.length, reinforcedPaths, selectedNewPaths };
}

async function topUpUncoveredAnchors(input: {
  store: MemoryStore;
  profileId: string;
  plan: AnchorCoveragePlan | null;
  intent: ReconstructionIntent;
  queryEmbedding?: QueryVectorEmbedding | undefined;
  recallPurpose: ReconstructionRecallPurpose;
  includeSensitive?: boolean | undefined;
  maxMemories: number;
  memories: MemoryRecord[];
  paths: ReconstructedEvidencePath[];
  seenMemoryIds: Set<string>;
  selectedSourceCues: Set<string>;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
  requiredOnly?: boolean | undefined;
  cueReason?: string | undefined;
}): Promise<ReconstructedPlannerStep[]> {
  const report = anchorCoverageReport(input.plan, input.paths);
  if (!input.plan || !report || input.memories.length >= input.maxMemories) return [];
  const steps: ReconstructedPlannerStep[] = [];
  for (const anchor of report.anchors.filter((entry) =>
    entry.uncovered &&
    (input.requiredOnly === true ? entry.required === true : entry.required !== true)
  )) {
    if (input.memories.length >= input.maxMemories) break;
    const trace = await fuseDirectMemorySearch({
      store: input.store,
      profileId: input.profileId,
      query: anchor.anchorCue,
      queryEmbedding: input.queryEmbedding,
      intent: input.intent,
      recallPurpose: input.recallPurpose,
      includeSensitive: input.includeSensitive,
      maxMemories: input.maxMemories,
      memories: input.memories,
      paths: input.paths,
      seenMemoryIds: input.seenMemoryIds,
      selectedSourceCues: input.selectedSourceCues,
      searchQueries: [anchor.anchorCue],
      anchorCue: anchor.anchorCue,
      ...(anchor.required === true ? { freshQueryEmbedding: true } : {}),
      maxNewPaths: 1,
      reinforceExisting: false,
      cueExtractor: input.cueExtractor,
      inferTemporalCuesFromText: input.inferTemporalCuesFromText,
    });
    addAnchorCandidateCount(input.plan, anchor.anchorCue, trace.candidateCount);
    if (trace.selectedNewPaths.length === 0) noteAnchorExhausted(input.plan, anchor.anchorCue);
    for (const path of trace.selectedNewPaths) {
      noteAnchorIncludedMemory(input.plan, path.anchorCue);
    }
    if (trace.candidateCount === 0) continue;
    const paths = [...trace.reinforcedPaths, ...trace.selectedNewPaths];
    steps.push({
      step: paths.length > 0 ? Math.max(...paths.map((path) => path.step)) : stepCountForTrace(input.paths),
      selectedCue: anchor.anchorCue,
      cueReason: input.cueReason ?? "anchor_fallback_memory_search",
      exploredAssociationCount: 0,
      hybridCandidateCount: trace.candidateCount,
      selectedBranchCount: paths.length,
      prunedBranchCount: 0,
      generatedCues: [],
      branches: [
        ...trace.reinforcedPaths.map((path) =>
          traceBranchFromPath(path, "reinforced", path.routeReason ?? "anchor_fallback_memory_search")
        ),
        ...trace.selectedNewPaths.map((path) =>
          traceBranchFromPath(path, "selected_new_path", path.routeReason ?? "anchor_fallback_memory_search")
        ),
      ],
    });
  }
  return steps;
}

function directMemoryTraceStep(input: {
  trace: {
    candidateCount: number;
    reinforcedPaths: ReconstructedEvidencePath[];
    selectedNewPaths: ReconstructedEvidencePath[];
  };
  selectedCue: string;
  selectedReason: string;
  reinforcedReason: string;
  noNewPathReason: string;
  fallbackStep: number;
}): ReconstructedPlannerStep | null {
  if (input.trace.candidateCount === 0) return null;
  const paths = [
    ...input.trace.reinforcedPaths,
    ...input.trace.selectedNewPaths,
  ];
  const step = paths.length > 0 ? Math.max(...paths.map((path) => path.step)) : input.fallbackStep;
  return {
    step,
    selectedCue: input.selectedCue,
    cueReason:
      input.trace.selectedNewPaths.length > 0
        ? input.selectedReason
        : input.trace.reinforcedPaths.length > 0
          ? input.reinforcedReason
          : input.noNewPathReason,
    exploredAssociationCount: 0,
    hybridCandidateCount: input.trace.candidateCount,
    selectedBranchCount: paths.length,
    prunedBranchCount: 0,
    generatedCues: [],
    branches: [
      ...input.trace.reinforcedPaths.map((path) =>
        traceBranchFromPath(
          path,
          "reinforced",
          path.routeReason ?? input.reinforcedReason,
        )
      ),
      ...input.trace.selectedNewPaths.map((path) =>
        traceBranchFromPath(
          path,
          "selected_new_path",
          path.routeReason ?? input.selectedReason,
        )
      ),
    ],
  };
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
  includeTemporalContext?: boolean | undefined;
  asOf?: string | undefined;
  maxMemories: number;
  maxCharsPerMemory?: number | undefined;
  fullContentTopRank?: number | undefined;
  fullContentMaxChars?: number | undefined;
  layerPolicy?: ReconstructionLayerStats["policy"] | undefined;
  displayQuery?: string | undefined;
  plannerTrace?: ReconstructedPlannerTrace | undefined;
  anchorCoverage?: ReconstructionAnchorCoverageReport | undefined;
  sweepDraft?: ReconstructionSweepDraft | undefined;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
  privateRouteSignals?: string[] | undefined;
  sanitizeEvidenceForOutput?: EvidenceOutputSanitizer | undefined;
}): ReconstructedContext {
  const orderedMemories = uniqueMemoriesById(input.memories);
  const layerCandidates = input.layerPolicy ? [...orderedMemories] : [];
  let memories = allocateLayeredMemories({
    memories: orderedMemories,
    maxMemories: input.maxMemories,
    policy: input.layerPolicy,
  });
  let paths = input.layerPolicy
    ? filterPathsForIncludedMemories(uniquePathsById(input.paths), memories)
    : uniquePathsById(input.paths);
  let sweepCandidates = [...(input.sweepDraft?.candidates ?? [])];
  const includeTemporalContext = input.includeTemporalContext !== false;
  const publicQuery = input.displayQuery ?? input.query;
  const privateSignalKeys = privateRouteSignalKeys(
    input.intent,
    publicQuery,
    input.cueExtractor,
    input.privateRouteSignals,
  );
  const privateOutputSignalKeySet = privateOutputSignalKeys({
    intent: input.intent,
    privateRouteSignals: input.privateRouteSignals,
    publicQuery,
    cueExtractor: input.cueExtractor,
  });
  const hideInternalRouteSignals =
    (input.displayQuery !== undefined && input.displayQuery !== input.query) ||
    privateSignalKeys.size > 0;
  const publicEvidence = input.includeEvidence
    ? input.evidence
        .map(input.sanitizeEvidenceForOutput ?? sanitizeEvidenceForPublicOutput)
        .map((event) => publicEvidenceEvent(
          event,
          hideInternalRouteSignals,
          privateOutputSignalKeySet,
        ))
    : [];
  let evidence = [...publicEvidence];
  let coverage = evidenceCoverageForPaths(
    publicQuery,
    paths,
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  );
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
  const outputState = (): {
    paths: ReconstructedEvidencePath[];
    coverage: ReconstructionEvidenceCoverage;
    evidenceConvergence: ReconstructionEvidenceConvergence;
    uncertainty: ReconstructionUncertainty;
    anchorCoverage?: ReconstructionAnchorCoverageReport | undefined;
    plannerTrace?: ReconstructedPlannerTrace | undefined;
    stepCount: number;
    exploredCueCount: number;
    associationCount: number;
  } => {
    const outputPaths = paths.map((path) =>
      publicPath(
        path,
        input.includeTemporalMetadata,
        hideInternalRouteSignals,
        privateSignalKeys,
        privateOutputSignalKeySet,
      ),
    );
    const outputCoverage = publicEvidenceCoverage(coverage, privateSignalKeys);
    const outputEvidenceConvergence = publicEvidenceConvergence({
      convergence: evidenceConvergence,
      coverage: outputCoverage,
      paths: outputPaths,
      privateSignalKeys,
    });
    const outputAnchorCoverage = publicAnchorCoverage(
      anchorCoverageWithIncludedCounts(input.anchorCoverage, paths),
      privateSignalKeys,
    );
    const outputUncertainty = uncertaintyForReconstruction({
      coverage: outputCoverage,
      memories,
      paths: outputPaths,
      stopReason: input.stopReason,
      evidenceConvergence: outputEvidenceConvergence,
    });
    const exposePlannerTrace = input.displayQuery === undefined || input.displayQuery === input.query;
    const outputPlannerTrace = exposePlannerTrace && input.plannerTrace
      ? publicPlannerTrace(input.plannerTrace, privateSignalKeys, input.stopReason)
      : undefined;
    const outputAssociationCount = outputPlannerTrace
      ? outputPlannerTrace.steps.reduce((sum, step) => sum + step.exploredAssociationCount, 0)
      : outputPaths.length;
    return {
      paths: outputPaths,
      coverage: outputCoverage,
      evidenceConvergence: outputEvidenceConvergence,
      uncertainty: outputUncertainty,
      ...(outputAnchorCoverage ? { anchorCoverage: outputAnchorCoverage } : {}),
      ...(outputPlannerTrace ? { plannerTrace: outputPlannerTrace } : {}),
      stepCount: hideInternalRouteSignals
        ? outputPlannerTrace?.steps.length ?? (outputPaths.length > 0 ? 1 : 0)
        : input.stepCount,
      exploredCueCount: hideInternalRouteSignals
        ? outputPlannerTrace?.steps.length ?? (outputPaths.length > 0 ? 1 : 0)
        : input.exploredCueCount,
      associationCount: hideInternalRouteSignals ? outputAssociationCount : input.associationCount,
    };
  };
  const publicSweepStats = (): ReconstructedContext["stats"]["sweeps"] | undefined => {
    if (!input.sweepDraft) return undefined;
    const rawStats = sweepStatsFor(input.sweepDraft.cueStats, sweepCandidates);
    return {
      ...rawStats,
      cues: rawStats.cues.map((cue) => ({
        ...cue,
        cue: publicRouteSignal(cue.cue, privateSignalKeys),
      })),
    };
  };
  const fullContentMemoryIds = (): Set<string> =>
    input.fullContentTopRank === undefined
      ? new Set()
      : new Set(memories.slice(0, input.fullContentTopRank).map((memory) => memory.id));
  const capForMemoryId = (memoryId: string | null | undefined, fullIds: Set<string>): number | undefined =>
    memoryId && fullIds.has(memoryId) ? input.fullContentMaxChars : input.maxCharsPerMemory;
  const renderSweepSection = (candidates: ReconstructionSweepCandidate[]): string => {
    if (candidates.length === 0) return "";
    const fullIds = fullContentMemoryIds();
    const lines = [
      "Additional dated mentions:",
      ...candidates.sort(compareSweepChronological).map((candidate) => {
        const memory = publicMemory(
          candidate.memory,
          hideInternalRouteSignals,
          privateOutputSignalKeySet,
        );
        const temporal = includeTemporalContext
          ? temporalContextLabel(memory.createdAt, memory.metadata)
          : "";
        const content = truncateMemoryContent(memory.content, capForMemoryId(memory.id, fullIds));
        return temporal ? `- [${temporal}] ${content}` : `- ${content}`;
      }),
    ];
    return lines.join("\n");
  };
  const render = (includeSweeps: boolean): string => {
    coverage = evidenceCoverageForPaths(
      publicQuery,
      paths,
      input.cueExtractor,
      input.inferTemporalCuesFromText,
    );
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
    const output = outputState();
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
    const printedMemoryIndexes = new Map(memories.map((memory, index) => [memory.id, index + 1]));
    const fullIds = fullContentMemoryIds();
    const asOf = temporalReferenceDateLabel(input.asOf);
    const temporalSegmentForPath = (path: ReconstructedEvidencePath): string => {
      const memory = memoryById.get(path.targetId) ?? memoryById.get(path.sourceMemoryId ?? "");
      return memory
        ? temporalContextSegment(memory.createdAt, memory.metadata, asOf)
        : temporalContextSegment(path.createdAt, {}, asOf);
    };
    const capForPath = (path: ReconstructedEvidencePath): number | undefined => {
      if (memoryById.has(path.targetId)) return capForMemoryId(path.targetId, fullIds);
      return capForMemoryId(path.sourceMemoryId, fullIds);
    };
    const printedMemoryIndexForPath = (
      path: ReconstructedEvidencePath,
      rawPath: ReconstructedEvidencePath | undefined,
    ): number | undefined => {
      if ((rawPath?.targetType ?? path.targetType) !== "memory") return undefined;
      return printedMemoryIndexes.get(rawPath?.targetId ?? "") ??
        printedMemoryIndexes.get(path.targetId) ??
        printedMemoryIndexes.get(rawPath?.sourceMemoryId ?? "") ??
        printedMemoryIndexes.get(path.sourceMemoryId ?? "");
    };
    const targetReferenceForPath = (
      path: ReconstructedEvidencePath,
      rawPath: ReconstructedEvidencePath | undefined,
    ): string | undefined => {
      const printedIndex = printedMemoryIndexForPath(path, rawPath);
      return printedIndex === undefined ? undefined : `see Memory content item ${printedIndex}`;
    };
    const lines = [
      "<gmos-reconstructed-context>",
      `Query: ${publicQuery}`,
      ...(asOf ? [`As of: ${asOf}`] : []),
      `Evidence coverage: ${output.coverage.coveredCueCount}/${output.coverage.queryCueCount} cues (${output.coverage.coverageRate.toFixed(2)}); uncovered=${output.coverage.uncoveredCues.join(", ") || "none"}`,
      ...(output.anchorCoverage
        ? [
            `Anchor coverage: ${output.anchorCoverage.coveredAnchorCount}/${output.anchorCoverage.anchorCount} anchors; uncovered=${output.anchorCoverage.uncoveredAnchors.join(", ") || "none"}`,
          ]
        : []),
      `Evidence convergence: score=${output.evidenceConvergence.score.toFixed(2)}; reached=${output.evidenceConvergence.reached}; threshold=${output.evidenceConvergence.threshold.toFixed(2)}; pruned=${output.evidenceConvergence.prunedBranchCount}; frontier=${output.evidenceConvergence.frontierRemaining}; stopWhenEvidenceEnough=${output.evidenceConvergence.stopWhenEvidenceEnough}`,
      `Reconstruction uncertainty: ${output.uncertainty.level}${output.uncertainty.reasons.length ? ` (${output.uncertainty.reasons.join(", ")})` : ""}`,
      "Memory content:",
      ...memories.map((memory) =>
        publicMemory(memory, hideInternalRouteSignals, privateOutputSignalKeySet)
      ).map(
        (memory) =>
          `- [${safePublicLabel(memory.kind)}${includeTemporalContext ? temporalContextSegment(memory.createdAt, memory.metadata, asOf) : ""}; confidence=${memory.confidence.toFixed(2)}] ${truncateMemoryContent(memory.content, capForMemoryId(memory.id, fullIds))}`,
      ),
      "Reconstructed evidence paths:",
      ...output.paths.map((path, index) =>
        formatPathLine(
          path,
          includeTemporalContext ? temporalSegmentForPath(path) : "",
          capForPath(path),
          targetReferenceForPath(path, paths[index]),
        )
      ),
    ];
    if (input.includeEvidence) {
      lines.push("Evidence:");
      lines.push(
        ...evidence.map(
          (event) =>
            `- [${safePublicLabel(event.sourceType)}; ${event.sensitivity}; eligible=${event.eligibleForLongTermMemory}${input.includeTemporalMetadata ? observedAtSegment(event.createdAt) : ""}] ${event.content}`,
        ),
      );
    }
    if (includeSweeps && sweepCandidates.length > 0) {
      lines.push(...renderSweepSection(sweepCandidates).split("\n"));
    }
    lines.push("</gmos-reconstructed-context>");
    return lines.join("\n");
  };
  let contextBlock = render(false);
  const budget = input.contextBudgetTokens ?? 1800;
  // Path lines carry truncated summaries of the same targets; full memory
  // content is what downstream readers need, so cull paths before memories.
  while (estimateTokens(contextBlock) > budget && (memories.length > 0 || paths.length > 0)) {
    if (paths.length > 0) paths = paths.slice(0, -1);
    else if (input.layerPolicy) dropLayerAwareMemory(memories);
    else memories = memories.slice(0, -1);
    evidence = [];
    contextBlock = render(false);
  }
  if (input.sweepDraft) {
    const ordinaryMemoryIds = new Set(memories.map((memory) => memory.id));
    sweepCandidates = sweepCandidates.filter((candidate) => !ordinaryMemoryIds.has(candidate.memory.id));
    const sweepBudget = Math.ceil(budget * 0.35);
    while (
      sweepCandidates.length > 0 &&
      estimateTokens(renderSweepSection(sweepCandidates)) > sweepBudget
    ) {
      const drop = [...sweepCandidates].sort(compareSweepCullPriority)[0];
      if (!drop) break;
      sweepCandidates = sweepCandidates.filter((candidate) => candidate.memory.id !== drop.memory.id);
    }
    contextBlock = render(true);
  }

  const output = outputState();
  const outputMemories = memories.map((memory) =>
    publicMemory(memory, hideInternalRouteSignals, privateOutputSignalKeySet),
  );
  const sweeps = publicSweepStats();
  const layers = input.layerPolicy
    ? {
        policy: input.layerPolicy,
        candidates: layerCounts(layerCandidates),
        included: layerCounts(memories),
        culled: subtractLayerCounts(layerCounts(layerCandidates), layerCounts(memories)),
      }
    : undefined;
  const fullContentMemoryCount = input.fullContentTopRank === undefined
    ? undefined
    : Math.min(input.fullContentTopRank, memories.length);

  return {
    profileId: input.profileId,
    query: input.displayQuery ?? input.query,
    contextBlock,
    memories: outputMemories,
    evidence,
    paths: output.paths,
    plannerTrace: output.plannerTrace,
    stats: {
      stepCount: output.stepCount,
      exploredCueCount: output.exploredCueCount,
      associationCount: output.associationCount,
      retrievedMemoryCount: memories.length,
      promptTokenEstimate: estimateTokens(contextBlock),
      stopReason: input.stopReason,
      evidenceCoverage: output.coverage,
      uncertainty: output.uncertainty,
      evidenceConvergence: output.evidenceConvergence,
      ...(output.anchorCoverage ? { anchorCoverage: output.anchorCoverage } : {}),
      ...(output.anchorCoverage?.requiredAnchorUnmet.length
        ? { requiredAnchorUnmet: output.anchorCoverage.requiredAnchorUnmet }
        : {}),
      ...(sweeps ? { sweeps } : {}),
      ...(layers ? { layers } : {}),
      ...(fullContentMemoryCount !== undefined ? { fullContentMemoryCount } : {}),
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
  candidateMemoryLimit: number;
  maxCharsPerMemory?: number | undefined;
  fullContentTopRank?: number | undefined;
  fullContentMaxChars?: number | undefined;
  layerPolicy?: ReconstructionLayerStats["policy"] | undefined;
  intent: ReconstructionIntent;
  queryEmbedding?: QueryVectorEmbedding | undefined;
  displayQuery?: string | undefined;
  stopWhenEvidenceEnough: boolean;
  evidenceConvergenceThreshold: number;
  targetMemoryCount: number;
  includeTemporalMetadata?: boolean | undefined;
  includeTemporalContext?: boolean | undefined;
  asOf?: string | undefined;
  anchorCoverage?: boolean | undefined;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
  privateRouteSignals?: string[] | undefined;
  sanitizeEvidenceForOutput?: EvidenceOutputSanitizer | undefined;
}): Promise<ReconstructedContext> {
  const anchorPlan = input.anchorCoverage !== false
    ? createAnchorCoveragePlan({
        query: input.query,
        intent: input.intent,
        maxSteps: 1,
        cueExtractor: input.cueExtractor,
        inferTemporalCuesFromText: input.inferTemporalCuesFromText,
      })
    : null;
  const memoryAnchors = new Map<string, string>();
  const memoryById = new Map<string, MemoryRecord>();
  const addMemories = (items: MemoryRecord[], anchorCue?: string | undefined): void => {
    for (const memory of sourceScopedFallbackMemories(items, input.intent)) {
      if (memoryById.has(memory.id) || memoryById.size >= input.candidateMemoryLimit) continue;
      memoryById.set(memory.id, memory);
      if (anchorCue) memoryAnchors.set(memory.id, anchorCue);
    }
  };
  if (anchorPlan && (anchorPlan.anchors.length > 1 || anchorPlan.anchors.some((anchor) => anchor.required))) {
    for (const anchor of anchorPlan.anchors) {
      if (memoryById.size >= input.candidateMemoryLimit) break;
      const found = await input.store.searchMemories({
        profileId: input.profileId,
        query: anchor.anchorCue,
        purpose: input.recallPurpose,
        includeSensitive: input.includeSensitive,
        limit: anchor.required
          ? 1
          : Math.max(1, Math.ceil(input.maxMemories / anchorPlan.anchors.length)),
        ...(anchor.required
          ? { freshQueryEmbedding: true }
          : input.queryEmbedding
            ? { queryEmbedding: input.queryEmbedding }
            : {}),
      });
      anchor.candidateCount += found.length;
      if (anchor.required && found.length === 0) anchor.exhausted = true;
      addMemories(found, anchor.anchorCue);
    }
  }
  if (memoryById.size < input.candidateMemoryLimit) {
    addMemories(await input.store.searchMemories({
      profileId: input.profileId,
      query: input.query,
      purpose: input.recallPurpose,
      includeSensitive: input.includeSensitive,
      limit: input.candidateMemoryLimit,
      ...(input.queryEmbedding ? { queryEmbedding: input.queryEmbedding } : {}),
    }));
  }
  const memories = [...memoryById.values()];
  const targetMemoryCount = Math.min(input.targetMemoryCount, Math.max(1, memories.length));
  const paths = memories.map((memory, index) => ({
    id: `fallback:${memory.id}`,
    step: 1,
    cue: directMemoryCue(
      memory,
      input.query,
      input.cueExtractor,
      input.inferTemporalCuesFromText,
    ),
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
    ...(memoryAnchors.get(memory.id) ? { anchorCue: memoryAnchors.get(memory.id) } : {}),
  }));
  const fallbackCoverage = evidenceCoverageForPaths(
    input.query,
    paths,
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  );
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
    ...(anchorPlan ? { anchorCoverage: anchorCoverageReport(anchorPlan, safePaths) } : {}),
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
  const fallbackAnchorCoverage = anchorCoverageReport(anchorPlan, safePaths);
  const sweepDraft = await runReconstructionSweeps({
    store: input.store,
    profileId: input.profileId,
    sweepCues: input.intent.sweepCues,
    recallPurpose: input.recallPurpose,
    includeSensitive: input.includeSensitive,
    queryEmbedding: input.queryEmbedding,
  });
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
    includeTemporalContext: input.includeTemporalContext,
    asOf: input.asOf,
    maxMemories: input.maxMemories,
    maxCharsPerMemory: input.maxCharsPerMemory,
    fullContentTopRank: input.fullContentTopRank,
    fullContentMaxChars: input.fullContentMaxChars,
    layerPolicy: input.layerPolicy,
    plannerTrace,
    ...(fallbackAnchorCoverage ? { anchorCoverage: fallbackAnchorCoverage } : {}),
    ...(sweepDraft ? { sweepDraft } : {}),
    cueExtractor: input.cueExtractor,
    inferTemporalCuesFromText: input.inferTemporalCuesFromText,
    privateRouteSignals: input.privateRouteSignals,
    sanitizeEvidenceForOutput: input.sanitizeEvidenceForOutput,
  });
}

export async function reconstructMemoryContext(input: {
  store: MemoryStore;
  defaultProfileId: string;
  request: ReconstructMemoryContextRequest;
  cueExtractor?: MemoryCueExtractor | undefined;
  inferTemporalCuesFromText?: boolean | undefined;
  queryEmbedding?: QueryVectorEmbedding | undefined;
  sanitizeEvidenceForOutput?: EvidenceOutputSanitizer | undefined;
}): Promise<ReconstructedContext> {
  const profileId = input.request.profileId ?? input.defaultProfileId;
  const displayQuery = (input.request.query ?? latestUserText(input.request.messages)).trim();
  const query = (input.request.retrievalQuery ?? displayQuery).trim();
  if (!query) throw new Error("gmOS reconstructContext requires query or messages");
  const publicQuery = displayQuery || "task context";

  const maxSteps = boundedInteger(input.request.maxSteps, 3, 1, 8);
  const maxBranch = boundedInteger(input.request.maxBranch, 4, 1, 12);
  const maxMemories = boundedMaxMemories(input.request.maxMemories);
  const maxCharsPerMemory = optionalBoundedInteger(input.request.maxCharsPerMemory, 80, 4000);
  const fullContentTopRank = optionalBoundedInteger(input.request.fullContentTopRank, 0, 64);
  const fullContentMaxChars = normalizedFullContentMaxChars({
    maxCharsPerMemory,
    fullContentTopRank,
    fullContentMaxChars: input.request.fullContentMaxChars,
  });
  const layerPolicy = normalizedLayerPolicy(input.request.layerPolicy);
  const candidateMemoryLimit = layerCandidateMemoryLimit(maxMemories, layerPolicy);
  const anchorCoverageEnabled = input.request.anchorCoverage !== false;
  const stopWhenEvidenceEnough = input.request.stopWhenEvidenceEnough !== false;
  const includeTemporalMetadata = input.request.includeTemporalMetadata === true;
  const includeTemporalContext = input.request.includeTemporalContext !== false;
  const evidenceConvergenceThreshold = boundedNumber(
    input.request.evidenceConvergenceThreshold,
    0.72,
    0.35,
    0.95,
  );
  const inferTemporalCuesFromText = input.inferTemporalCuesFromText === true;
  const intent = inferReconstructionIntent(
    query,
    input.request.reconstructionIntent,
    input.cueExtractor,
    inferTemporalCuesFromText,
    { includeRequiredAnchors: anchorCoverageEnabled },
  );
  const recallPurpose = inferTemporalRecallPurpose(
    query,
    input.request.temporalMode,
    input.request.recallPurpose,
  );
  const targetMemoryCount = layerPolicy
    ? candidateMemoryLimit
    : recallPurpose === "history"
      ? Math.min(4, maxMemories)
      : Math.min(2, maxMemories);
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
      candidateMemoryLimit,
      maxCharsPerMemory,
      fullContentTopRank,
      fullContentMaxChars,
      layerPolicy,
      intent,
      queryEmbedding: input.queryEmbedding,
      stopWhenEvidenceEnough,
      evidenceConvergenceThreshold,
      targetMemoryCount,
      includeTemporalMetadata,
      includeTemporalContext,
      asOf: input.request.asOf,
      ...(input.request.anchorCoverage !== undefined ? { anchorCoverage: input.request.anchorCoverage } : {}),
      cueExtractor: input.cueExtractor,
      inferTemporalCuesFromText,
      privateRouteSignals: input.request.privateRouteSignals,
      sanitizeEvidenceForOutput: input.sanitizeEvidenceForOutput,
    });
  }

  const frontier = seedFrontier(query, intent, input.cueExtractor, inferTemporalCuesFromText);
  const anchorPlan = anchorCoverageEnabled
    ? createAnchorCoveragePlan({
        query,
        intent,
        maxSteps,
        cueExtractor: input.cueExtractor,
        inferTemporalCuesFromText,
      })
    : null;
  assignFrontierAnchors(frontier, anchorPlan);
  const initialCues = frontier.map((cue) => cue.cue);
  const explored = new Set<string>();
  const seenAssociationIds = new Set<string>();
  const seenMemoryIds = new Set<string>();
  const selectedSourceCues = new Set<string>();
  const memories: MemoryRecord[] = [];
  const paths: ReconstructedEvidencePath[] = [];
  const plannerSteps: ReconstructedPlannerStep[] = [];
  const sourceMemoryCache = new Map<string, MemoryRecord | null>();
  let associationCount = 0;
  let prunedBranchCount = 0;
  let stopReason: ReconstructedContext["stats"]["stopReason"] = "no_frontier";

  if (anchorPlan?.anchors.some((anchor) => anchor.required)) {
    plannerSteps.push(...await topUpUncoveredAnchors({
      store: input.store,
      profileId,
      plan: anchorPlan,
      intent,
      recallPurpose,
      includeSensitive: input.request.includeSensitive,
      maxMemories: candidateMemoryLimit,
      memories,
      paths,
      seenMemoryIds,
      selectedSourceCues,
      cueExtractor: input.cueExtractor,
      inferTemporalCuesFromText,
      requiredOnly: true,
      cueReason: "required_anchor_memory_search",
    }));
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    const cue = selectFrontierCue(frontier, explored, anchorPlan);
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
    addAnchorCandidateCount(anchorPlan, cue.anchorCue, associations.length);
    if (associations.length === 0) noteAnchorExhausted(anchorPlan, cue.anchorCue);
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
      .sort(compareRankedAssociations)
      .slice(0, maxBranch);
    async function sourceMemoryForAssociation(
      association: MemoryAssociationRecord,
    ): Promise<MemoryRecord | null> {
      const memoryId = association.targetType === "memory"
        ? association.targetId
        : association.sourceMemoryId ?? "";
      if (!memoryId) return null;
      if (sourceMemoryCache.has(memoryId)) return sourceMemoryCache.get(memoryId) ?? null;
      const memory = await input.store.getMemoryById(profileId, memoryId, {
        includeSensitive: input.request.includeSensitive,
      });
      sourceMemoryCache.set(memoryId, memory);
      return memory;
    }
    for (const ranked of rankedAssociations) {
      const sourceMemory = await sourceMemoryForAssociation(ranked.association);
      const sourceCues = [
        ...(sourceMemory ? sourceEntityCuesForMemory(sourceMemory) : []),
        ...structuredSubjectCuesForAssociation(ranked.association),
      ];
      for (const sourceCue of sourceCues) {
        if (entityCueMatchesQuery(sourceCue, intent)) {
          selectedSourceCues.add(associationCueKey(sourceCue));
        }
      }
    }
    for (const ranked of rankedAssociations) {
      const { association } = ranked;
      if (seenAssociationIds.has(association.id)) continue;
      seenAssociationIds.add(association.id);
      const path = pathFromAssociation(
        association,
        step,
        ranked.routeScore,
        ranked.routeReason,
        cue.anchorCue,
      );
      const sourceMemory = await sourceMemoryForAssociation(association);
      const associationRejectReason = associationSourceRejectReason(
        association.cue,
        [
          ...(sourceMemory ? sourceEntityCuesForMemory(sourceMemory) : []),
          ...structuredSubjectCuesForAssociation(association),
        ],
        sourceMemory,
        association.targetSummary,
        intent,
        selectedSourceCues,
      );
      if (associationRejectReason) {
        prunedBranchCount += 1;
        stepTrace.prunedBranchCount += 1;
        stepTrace.branches.push(traceBranchFromPath(path, "pruned", associationRejectReason));
        continue;
      }
      const gain = informationGainForPath({
        query,
        paths,
        path,
        intent,
        cueExtractor: input.cueExtractor,
        inferTemporalCuesFromText,
      });
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
        const associationTagForGeneratedCues = safePublicLabel(association.tag);
        const nextCues = evidenceAssociationCues(
          `${associationTagForGeneratedCues} ${association.targetSummary}`,
          8,
          input.cueExtractor,
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
            reason: `from:${associationTagForGeneratedCues}`,
            anchorCue: cue.anchorCue,
            discovered: true,
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
      const memory = await sourceMemoryForAssociation(association);
      if (!memory) continue;
      const sourceRejectReason = sourceScopeRejectReason(memory, intent, selectedSourceCues);
      if (sourceRejectReason) {
        prunedBranchCount += 1;
        stepTrace.prunedBranchCount += 1;
        stepTrace.branches.push(traceBranchFromPath(path, "pruned", sourceRejectReason));
        continue;
      }
      if (
        !canIncludeMemoryForAnchor({
          plan: anchorPlan,
          cue,
          frontier,
          explored,
          memoryCount: memories.length,
          maxMemories: candidateMemoryLimit,
        })
      ) {
        prunedBranchCount += 1;
        stepTrace.prunedBranchCount += 1;
        stepTrace.branches.push(traceBranchFromPath(path, "pruned", "anchor_lane_reserved_memory_slot"));
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
      noteAnchorIncludedMemory(anchorPlan, cue.anchorCue);
      if (memories.length >= candidateMemoryLimit) {
        stopReason = "evidence_sufficient";
        break;
      }
    }
    if (stepTrace.selectedBranchCount === 0) noteAnchorExhausted(anchorPlan, cue.anchorCue);
    stepTrace.generatedCues = [...stepGeneratedCues];
    plannerSteps.push(stepTrace);
    if (stopReason === "evidence_sufficient") break;
    const convergence = evidenceConvergenceForPaths({
      coverage: evidenceCoverageForPaths(query, paths, input.cueExtractor, inferTemporalCuesFromText),
      memories,
      paths,
      intent,
      threshold: evidenceConvergenceThreshold,
      targetMemoryCount,
      stopWhenEvidenceEnough,
      prunedBranchCount,
      frontierRemaining: frontier.length,
    });
    if (
      stopWhenEvidenceEnough &&
      convergence.reached &&
      reservableRequiredAnchorCount(anchorPlan) === 0 &&
      reservableUncoveredSeedLaneCount(anchorPlan, frontier, explored) === 0
    ) {
      stopReason = "evidence_sufficient";
      break;
    }
    if (frontier.length === 0) {
      stopReason = "no_frontier";
      break;
    }
    stopReason = "budget_exhausted";
  }

  const coverageBeforeAnchorTopUp = evidenceCoverageForPaths(
    query,
    paths,
    input.cueExtractor,
    inferTemporalCuesFromText,
  );
  const hybridNeededBeforeAnchorTopUp = shouldRunHybridDirectMemorySearch({
    recallPurpose,
    memories,
    paths,
    maxMemories: candidateMemoryLimit,
    targetMemoryCount,
    intent,
    coverage: coverageBeforeAnchorTopUp,
  }) || ((layerPolicy !== undefined || maxMemories > 24) && memories.length < candidateMemoryLimit);

  if (anchorPlan && memories.length < candidateMemoryLimit) {
    const anchorTopUpSteps = await topUpUncoveredAnchors({
      store: input.store,
      profileId,
      plan: anchorPlan,
      intent,
      queryEmbedding: input.queryEmbedding,
      recallPurpose,
      includeSensitive: input.request.includeSensitive,
      maxMemories: candidateMemoryLimit,
      memories,
      paths,
      seenMemoryIds,
      selectedSourceCues,
      cueExtractor: input.cueExtractor,
      inferTemporalCuesFromText,
    });
    plannerSteps.push(...anchorTopUpSteps);
    const convergence = evidenceConvergenceForPaths({
      coverage: evidenceCoverageForPaths(query, paths, input.cueExtractor, inferTemporalCuesFromText),
      memories,
      paths,
      intent,
      threshold: evidenceConvergenceThreshold,
      targetMemoryCount,
      stopWhenEvidenceEnough,
      prunedBranchCount,
      frontierRemaining: frontier.length,
    });
    if (memories.length >= candidateMemoryLimit || (stopWhenEvidenceEnough && convergence.reached)) {
      stopReason = "evidence_sufficient";
    }
  }

  const finalCoverageBeforeHybrid = evidenceCoverageForPaths(
    query,
    paths,
    input.cueExtractor,
    inferTemporalCuesFromText,
  );
  const hybridNeededAfterAnchorTopUp = shouldRunHybridDirectMemorySearch({
    recallPurpose,
    memories,
    paths,
    maxMemories: candidateMemoryLimit,
    targetMemoryCount,
    intent,
    coverage: finalCoverageBeforeHybrid,
  }) || ((layerPolicy !== undefined || maxMemories > 24) && memories.length < candidateMemoryLimit);
  const allowReinforcementOnlyHybrid = anchorPlan !== null && hybridNeededBeforeAnchorTopUp;
  if (
    (memories.length < candidateMemoryLimit || allowReinforcementOnlyHybrid) &&
    (hybridNeededBeforeAnchorTopUp || hybridNeededAfterAnchorTopUp)
  ) {
    const hybridTrace = await fuseDirectMemorySearch({
      store: input.store,
      profileId,
      query,
      queryEmbedding: input.queryEmbedding,
      intent,
      recallPurpose,
      includeSensitive: input.request.includeSensitive,
      maxMemories: candidateMemoryLimit,
      memories,
      paths,
      seenMemoryIds,
      selectedSourceCues,
      cueExtractor: input.cueExtractor,
      inferTemporalCuesFromText,
    });
    const hybridStep = directMemoryTraceStep({
      trace: hybridTrace,
      selectedCue: query,
      selectedReason: "hybrid_direct_memory_search",
      reinforcedReason: "hybrid_direct_memory_search_reinforced",
      noNewPathReason: "hybrid_direct_memory_search_no_new_path",
      fallbackStep: stepCountForTrace(paths),
    });
    if (hybridStep) plannerSteps.push(hybridStep);
    const wideSupplyRequested = layerPolicy !== undefined || maxMemories > 24;
    if (wideSupplyRequested && memories.length < candidateMemoryLimit) {
      const saturationTrace = await fuseDirectMemorySearch({
        store: input.store,
        profileId,
        query,
        // Saturation is supply fill, not semantic retrieval; null blocks runtime query embedding injection.
        queryEmbedding: null,
        intent,
        recallPurpose,
        includeSensitive: input.request.includeSensitive,
        maxMemories: candidateMemoryLimit,
        memories,
        paths,
        seenMemoryIds,
        selectedSourceCues,
        searchQueries: [""],
        reinforceExisting: false,
        // Saturation is supply fill, not exploration: candidateMemoryLimit and
        // the output token budget bound it, so branch/source narrowing should not.
        supplyFill: true,
        cueExtractor: input.cueExtractor,
        inferTemporalCuesFromText,
      });
      const saturationStep = directMemoryTraceStep({
        trace: saturationTrace,
        selectedCue: query,
        selectedReason: "wide_supply_saturation",
        reinforcedReason: "wide_supply_saturation_reinforced",
        noNewPathReason: "wide_supply_saturation_no_new_path",
        fallbackStep: stepCountForTrace(paths),
      });
      if (saturationStep) plannerSteps.push(saturationStep);
    }
    const convergence = evidenceConvergenceForPaths({
      coverage: evidenceCoverageForPaths(query, paths, input.cueExtractor, inferTemporalCuesFromText),
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

  const finalAnchorCoverage = anchorCoverageReport(anchorPlan, paths);
  const sweepDraft = await runReconstructionSweeps({
    store: input.store,
    profileId,
    sweepCues: intent.sweepCues,
    recallPurpose,
    includeSensitive: input.request.includeSensitive,
    queryEmbedding: input.queryEmbedding,
  });
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
    includeTemporalContext,
    asOf: input.request.asOf,
    maxMemories,
    maxCharsPerMemory,
    fullContentTopRank,
    fullContentMaxChars,
    layerPolicy,
    cueExtractor: input.cueExtractor,
    inferTemporalCuesFromText,
    privateRouteSignals: input.request.privateRouteSignals,
    sanitizeEvidenceForOutput: input.sanitizeEvidenceForOutput,
    plannerTrace: {
      mode: "associative",
      intentReason: intent.reason,
      initialCues,
      maxSteps,
      maxBranch,
      maxMemories,
      ...(finalAnchorCoverage ? { anchorCoverage: finalAnchorCoverage } : {}),
      steps: plannerSteps,
      stopReason,
    },
    ...(finalAnchorCoverage ? { anchorCoverage: finalAnchorCoverage } : {}),
    ...(sweepDraft ? { sweepDraft } : {}),
  });
}
