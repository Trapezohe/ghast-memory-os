import {
  associationCueKey,
  associationCueMatchesQuery,
  associationCueTextPattern,
  extractAssociationCues,
  sourceMetadataEntityCues,
} from "./associations.js";
import type { AssociationCue } from "./associations.js";
import {
  GMOS_METADATA_REFERENCE_MARKER,
  GMOS_METADATA_REFERENCE_SCHEMAS,
  hasGmosMetadataReferenceSchema,
} from "./metadata-schema.js";
import {
  classifySensitivity,
  safePublicInlineField,
  safePublicLabel,
  sanitizeEvidenceForPublicOutput,
} from "./safety.js";
import {
  collectReaderEvidenceForMemories,
  exactPrimaryEvidenceId,
} from "./reader-evidence.js";
import { queryTerms } from "./query-terms.js";
import {
  observedAtSegment,
  temporalContextLabel,
  temporalContextSegment,
  temporalReferenceDateLabel,
} from "./temporal-format.js";
import {
  normalizeExplicitTemporalInstant,
  temporalCueValuesFromText,
} from "./temporal-validity.js";
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
  if (
    !hasGmosMetadataReferenceSchema(
      memory.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    return "atom";
  }
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
  const selectionCapacity = Math.min(input.maxMemories, ranked.length);
  const summaryMin = Math.min(
    summaries.length,
    Math.ceil(input.policy.summaryMinShare * selectionCapacity),
  );
  for (const candidate of summaries.slice(0, summaryMin)) {
    if (selected.size >= input.maxMemories) break;
    selected.add(candidate.memory.id);
  }
  const turnMax = input.policy.turnMaxShare > 0 && selectionCapacity > 0
    ? Math.max(1, Math.floor(input.policy.turnMaxShare * selectionCapacity))
    : 0;
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
  const {
    [GMOS_METADATA_REFERENCE_MARKER]: _authorityMarker,
    ...publicMetadata
  } = memory.metadata;
  const publicRecord = {
    ...memory,
    kind: safePublicLabel(memory.kind) as MemoryRecord["kind"],
    metadata: publicMetadata,
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
  return evidenceTextCoversCue(
    `${path.cue} ${path.tag} ${path.targetKind ?? ""} ${path.targetSummary}`,
    cue,
    cueExtractor,
  );
}

function evidenceTextCoversCue(
  text: string,
  cue: string,
  cueExtractor?: MemoryCueExtractor | undefined,
): boolean {
  const normalizedCue = normalizedText(cue);
  if (/\p{Script=Han}/u.test(cue) && normalizedText(text).includes(normalizedCue)) return true;
  if (associationCueTextPattern(cue)?.test(text)) return true;
  const cueKey = associationCueKey(cue);
  if (!cueKey) return false;
  const pathKeys = new Set(
    evidenceAssociationCues(text, 64, cueExtractor)
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
  memories: MemoryRecord[] = [],
): ReconstructionEvidenceCoverage {
  const cues = coverageCues(query, cueExtractor, inferTemporalCuesFromText);
  const coveredCues = cues.filter((cue) =>
    paths.some((path) => pathCoversCue(path, cue, cueExtractor)) ||
    memories.some((memory) =>
      evidenceTextCoversCue(
        `${memory.kind} ${memory.scope} ${memory.content} ${JSON.stringify(memory.metadata)}`,
        cue,
        cueExtractor,
      )
    )
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

function evidenceSupportingPaths(input: {
  paths: ReconstructedEvidencePath[];
  coverage: ReconstructionEvidenceCoverage;
  intent: ReconstructionIntent;
}): ReconstructedEvidencePath[] {
  return input.paths.filter((path) =>
    (path.anchorCue !== undefined && pathCoversCue(path, path.anchorCue)) ||
    pathMatchesIntent(path, input.intent) ||
    input.coverage.coveredCues.some((cue) => pathCoversCue(path, cue))
  );
}

function evidenceSupportingMemories(input: {
  memories: MemoryRecord[];
  coverage: ReconstructionEvidenceCoverage;
  intent: ReconstructionIntent;
}): MemoryRecord[] {
  const queryCues = [...input.coverage.coveredCues, ...input.coverage.uncoveredCues];
  return input.memories.filter((memory) =>
    memoryMatchesIntent(memory, input.intent) ||
    queryCues.some((cue) =>
      evidenceTextCoversCue(
        `${memory.kind} ${memory.scope} ${memory.content} ${JSON.stringify(memory.metadata)}`,
        cue,
      )
    )
  );
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
  const supportingPaths = evidenceSupportingPaths(input);
  const supportingMemories = evidenceSupportingMemories(input);
  const supportingEvidenceKeys = new Set<string>(
    supportingMemories.map((memory) => `memory:${memory.id}`),
  );
  for (const path of supportingPaths) {
    const key = path.sourceMemoryId
      ? `memory:${path.sourceMemoryId}`
      : path.targetType === "memory"
        ? `memory:${path.targetId}`
        : `${path.targetType}:${path.targetId}`;
    supportingEvidenceKeys.add(key);
  }
  const supportingEvidenceCount = supportingEvidenceKeys.size;
  const intentMatched =
    hasIntentEvidence(supportingPaths, input.intent) ||
    supportingMemories.some((memory) => memoryMatchesIntent(memory, input.intent));
  const coveredRequiredIntentGroups = input.intent.requiredTagGroups.filter((group) =>
    supportingPaths.some((path) => pathMatchesTagGroup(path, group.tags)) ||
    supportingMemories.some((memory) => memoryMatchesTagGroup(memory, group.tags)),
  );
  const missingRequiredIntentGroups = input.intent.requiredTagGroups
    .filter((group) => !coveredRequiredIntentGroups.includes(group))
    .map((group) => group.name);
  const targetMemoryCount = Math.max(1, input.targetMemoryCount);
  const memoryContentScore =
    supportingEvidenceCount > 0 ? Math.min(1, supportingEvidenceCount / targetMemoryCount) : 0;
  const pathSupportScore = supportingEvidenceCount > 0
    ? Math.min(1, supportingEvidenceCount / 4)
    : 0;
  const intentScore = intentMatched ? 1 : 0;
  const supportEnough = supportingEvidenceCount >= targetMemoryCount && intentMatched;
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
    supportEnough;
  const score = intentGroundedEnough ? Math.max(baseScore, input.threshold) : baseScore;
  return {
    score,
    reached:
      (score >= input.threshold &&
        supportEnough &&
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
  const sweepCues = normalizedSweepCues(hint.sweepCues, 12);
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
  if (temporalMode === "auto") return autoTemporalRecallPurpose(query);
  return "context";
}

function autoTemporalRecallPurpose(query: string): ReconstructionRecallPurpose {
  const normalized = query.normalize("NFC").toLowerCase();
  const decisivelyHistorical = [
    /\b(?:before|earlier|formerly|historical|history|originally|past|previous|previously|prior|since)\b/u,
    /\b(?:what|where|who|when|which|how)\b[^?!.]{0,96}\b(?:did|had|was|were)\b/u,
    /\b(?:last|past)\s+(?:few\s+)?(?:days?|weeks?|months?|years?)\b/u,
    /(?:曾经|之前|以前|过去|历史|原来|最初|以来|之间)/u,
  ];
  if (decisivelyHistorical.some((pattern) => pattern.test(normalized))) return "history";

  const futureQuestionAuxiliary =
    /\b(?:What|Where|Who|When|Which|How|what|where|who|when|which|how)\b[^?!.]{0,64}\b(?:will|shall)\b/u.test(
      query,
    ) || /^\s*(?:Will|Shall)\b/u.test(query);
  const explicitlyProspective =
    /\b(?:am|are|is)\s+going to\b|\b(?:future|upcoming)\b|\bnext\s+(?:day|days|month|months|plan|plans|step|steps|week|weeks|year|years)\b/u.test(
      normalized,
    ) ||
    futureQuestionAuxiliary ||
    /(?:将来|未来|接下来|下次)/u.test(normalized);
  if (explicitlyProspective) return "context";

  const explicitlyCurrent =
    /\b(?:as of now|at present|current|currently|latest|most recent|now|right now|today)\b/u.test(normalized) ||
    /(?:当前|目前|现在|如今|最新)/u.test(normalized);
  if (explicitlyCurrent) return "context";

  const analyticalHistory = [
    /\b(?:across all|all time|altogether|between|combined|cumulative|over time|so far|to date|total)\b/u,
    /\bhow (?:long|many|much|often)\b/u,
    /\b(?:what date|when)\b/u,
    /(?:总共|一共|累计|合计|多少|多久|何时|什么时候)/u,
  ];
  if (analyticalHistory.some((pattern) => pattern.test(normalized))) return "history";

  const boundedCalendarReference =
    /\b(?:after|before|between|by|during|from|in|since|through|until)\s+(?:the\s+)?(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/u.test(
      normalized,
    );
  if (boundedCalendarReference) return "history";
  return /\bused to\b/u.test(normalized) ? "history" : "context";
}

function queryNeedsAggregateRecall(query: string): boolean {
  const normalized = query.normalize("NFC").toLowerCase();
  return (
    /\b(?:across|all time|altogether|combined|cumulative|how many|how much|how often|so far|to date|total)\b/u.test(
      normalized,
    ) ||
    /(?:总共|一共|累计|合计|多少次|多少钱|多少个|多少项)/u.test(normalized)
  );
}

function queryNeedsEntityAliasCandidates(query: string): boolean {
  const normalized = query.normalize("NFC").toLowerCase();
  return (
    /\b(?:how many|number of)\s+(?:different|distinct|unique)\b/u.test(normalized) ||
    /(?:多少个不同|多少位不同|不同的?多少个|不同的?多少位|哪些不同|哪几位不同)/u.test(normalized)
  );
}

interface StructuredEntityMention {
  subject: string;
  subjectKey: string;
  relation: string;
  relationKey: string;
  object: string;
  objectKey: string;
  confidence: number;
  createdAtMs: number;
  sourceEvidenceId: string;
}

const ENTITY_ALIAS_CANDIDATE_MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000;
const ENTITY_ALIAS_CORROBORATION_MAX_GAP_MS = 48 * 60 * 60 * 1000;
const ENTITY_ALIAS_CORROBORATION_MIN_CONFIDENCE = 0.75;
const ENTITY_ALIAS_LOW_INFORMATION_CONTEXT_TERMS = new Set("evidence identified identifies identify mention mentioned mentions name named note noted notes person report reported reports role said same say says someone".split(" "));

function normalizedStructuredEntityText(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedStructuredRelation(value: string): string {
  const auxiliaries = new Set(["am", "are", "been", "being", "did", "does", "had", "has", "have", "is", "was", "were"]);
  const tokens = normalizedStructuredEntityText(value).split(" ").filter(Boolean);
  while (tokens.length > 1 && auxiliaries.has(tokens[0]!)) tokens.shift();
  return tokens.join(" ");
}

function structuredEntityMetadataValue(
  metadata: Record<string, unknown>,
  primaryKey: string,
  fallbackKey: string,
): string | null {
  const raw = metadata[primaryKey] ?? metadata[fallbackKey];
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\s+/gu, " ").trim();
  if (!value || value.length > 128 || classifySensitivity(value) === "secret_like") return null;
  const safe = safePublicInlineField(value);
  if (/^\[redacted_[a-z_]+\]$/iu.test(safe)) return null;
  return safe === "other" && value !== "other" ? null : safe;
}

function structuredEntityMention(memory: MemoryRecord): StructuredEntityMention | null {
  if (
    memory.metadata.sourceTrust !== "user" ||
    !hasGmosMetadataReferenceSchema(
      memory.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    ) ||
    !hasGmosMetadataReferenceSchema(
      memory.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.worldBeliefProjection,
    )
  ) {
    return null;
  }
  const subject = structuredEntityMetadataValue(memory.metadata, "worldBeliefSubject", "subject");
  const predicate = structuredEntityMetadataValue(memory.metadata, "worldBeliefPredicate", "predicate");
  const object = structuredEntityMetadataValue(memory.metadata, "worldBeliefObject", "object");
  if (!subject || !predicate || !object) return null;
  const subjectKey = normalizedStructuredEntityText(subject);
  const relationKey = normalizedStructuredRelation(predicate);
  const objectKey = normalizedStructuredEntityText(object);
  const normalizedEventTime = typeof memory.metadata.eventTime === "string"
    ? normalizeExplicitTemporalInstant(memory.metadata.eventTime)
    : null;
  const createdAtMs = Date.parse(normalizedEventTime ?? memory.createdAt);
  const sourceEvidenceId = typeof memory.metadata.sourceEvidenceId === "string"
    ? memory.metadata.sourceEvidenceId.trim()
    : "";
  const annealing = memory.metadata.annealing;
  const capConfidence =
    annealing && typeof annealing === "object" && !Array.isArray(annealing) &&
      (annealing as Record<string, unknown>).active === true
      ? Number((annealing as Record<string, unknown>).capConfidence)
      : Number.NaN;
  const confidence = Number.isFinite(capConfidence)
    ? Math.min(memory.confidence, capConfidence)
    : memory.confidence;
  if (
    !subjectKey ||
    !relationKey ||
    !objectKey ||
    !Number.isFinite(createdAtMs) ||
    !sourceEvidenceId ||
    sourceEvidenceId.length > 256
  ) {
    return null;
  }
  return {
    subject,
    subjectKey,
    relation: relationKey,
    relationKey,
    object,
    objectKey,
    confidence,
    createdAtMs,
    sourceEvidenceId,
  };
}

interface ExplicitNamedEntity {
  label: string;
  key: string;
}

interface LeadingRoleNamedEntity {
  name: ExplicitNamedEntity;
  roleKey: string;
}

function explicitNamedEntity(value: string): ExplicitNamedEntity | null {
  if (/\b(?:and)\b|&|(?:和|与)/iu.test(value)) return null;
  const segments = value.split(/[,;()]/u);
  const label = segments[0]?.trim() ?? "";
  const suffix = segments.slice(1).join(" ");
  if (/(?:^|[^\p{L}\p{N}])(?:dr|mr|mrs|ms|prof)\.?\s+\p{L}/iu.test(suffix)) return null;
  if (!/^(?:dr|mr|mrs|ms|prof)\.?\s+\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*)?$/iu.test(label)) {
    return null;
  }
  const key = normalizedStructuredEntityText(label);
  return label && key ? { label, key } : null;
}

function normalizedStructuredRoleText(value: string): string {
  const tokens = normalizedStructuredEntityText(value).split(" ").filter(Boolean);
  const articles = new Set(["a", "an", "the"]);
  while (tokens.length > 1 && articles.has(tokens[0]!)) tokens.shift();
  return tokens.join(" ");
}

function leadingRoleNamedEntity(value: string): LeadingRoleNamedEntity | null {
  const match = /^(.+?)\s+((?:dr|mr|mrs|ms|prof)\.?\s+\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*)?)$/iu.exec(
    value.trim(),
  );
  if (!match) return null;
  const role = (match[1] ?? "").replace(/[,;:()\p{Pd}]+$/gu, "").trim();
  const nameLabel = (match[2] ?? "").trim();
  if (
    !role ||
    /(?:^|[^\p{L}\p{N}])(?:dr|mr|mrs|ms|prof)\.?\s+\p{L}/iu.test(role)
  ) {
    return null;
  }
  const name = explicitNamedEntity(nameLabel);
  const roleKey = normalizedStructuredRoleText(role);
  return name && roleKey ? { name, roleKey } : null;
}

function looksLikeExplicitlyNamedEntity(value: string): boolean {
  return explicitNamedEntity(value) !== null || leadingRoleNamedEntity(value) !== null;
}

function sourceSupportsStructuredEntityMention(source: string, objectKey: string): boolean {
  const sourceTokens = new Set(normalizedStructuredEntityText(source).split(" ").filter(Boolean));
  const objectTokens = objectKey.split(" ").filter(Boolean);
  return objectTokens.length >= 2 && objectTokens.every((token) => sourceTokens.has(token));
}

function sourceContainsStructuredEntityPhrase(source: string, objectKey: string): boolean {
  const sourceKey = normalizedStructuredEntityText(source);
  return objectKey.split(" ").filter(Boolean).length >= 2 &&
    ` ${sourceKey} `.includes(` ${objectKey} `);
}

const ENTITY_ALIAS_TOKEN_WINDOW_RADIUS = 12;
const ENTITY_ALIAS_REQUIRED_SPAN_MAX_TOKENS = 12;
const ENTITY_ALIAS_SENTENCE_BOUNDARY = "gmosaliasboundarymarker";
const ENTITY_ALIAS_DISCOURSE_PREFIXES = new Set(["actually", "but", "however", "still", "though", "yet"]);

type SourceAliasWindow = { context: string; anchorSegment: string };

function sourceAliasTokens(source: string): string[] {
  const protectedTitles = source.replace(/\b(dr|mr|mrs|ms|prof)\./giu, "$1");
  const segments = protectedTitles.split(/([\r\n;；.!?。！？]+)/u);
  return segments.flatMap((segment, index) =>
    index % 2 === 1
      ? [ENTITY_ALIAS_SENTENCE_BOUNDARY]
      : normalizedStructuredEntityText(segment).split(" ").filter(Boolean)
  );
}

function sourceAliasWindowsContaining(source: string, requiredKeys: string[]): SourceAliasWindow[] {
  const requiredPhrases = requiredKeys
    .map((key) => normalizedStructuredEntityText(key).split(" ").filter(Boolean))
    .filter((terms) => terms.length > 0);
  if (requiredPhrases.length === 0) return [];
  const tokens = sourceAliasTokens(source);
  const segmentByIndex: number[] = [];
  let segment = 0;
  for (const [index, token] of tokens.entries()) {
    if (token === ENTITY_ALIAS_SENTENCE_BOUNDARY) segment += 1;
    segmentByIndex[index] = segment;
  }
  const windows: SourceAliasWindow[] = [];
  const seen = new Set<string>();
  const phraseStarts = (phrase: string[]): number[] =>
    tokens.flatMap((token, index) => {
      if (token !== phrase[0]) return [];
      const matches = phrase.every((term, offset) =>
        tokens[index + offset] === term &&
        segmentByIndex[index + offset] === segmentByIndex[index]
      );
      return matches ? [index] : [];
    });
  const startsByPhrase = requiredPhrases.map(phraseStarts);
  for (const anchorIndex of startsByPhrase[0] ?? []) {
    const requiredSpans: Array<{ start: number; end: number }> = [{
      start: anchorIndex,
      end: anchorIndex + requiredPhrases[0]!.length - 1,
    }];
    for (const [phraseIndex, phrase] of requiredPhrases.slice(1).entries()) {
      let nearestStart = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const candidateIndex of startsByPhrase[phraseIndex + 1] ?? []) {
        if (
          segmentByIndex[candidateIndex] !== segmentByIndex[anchorIndex]
        ) {
          continue;
        }
        const distance = Math.abs(candidateIndex - anchorIndex);
        if (distance < nearestDistance) {
          nearestStart = candidateIndex;
          nearestDistance = distance;
        }
      }
      if (nearestStart < 0) {
        requiredSpans.length = 0;
        break;
      }
      requiredSpans.push({
        start: nearestStart,
        end: nearestStart + phrase.length - 1,
      });
    }
    if (requiredSpans.length !== requiredPhrases.length) continue;
    const spanStart = Math.min(...requiredSpans.map((span) => span.start));
    const spanEnd = Math.max(...requiredSpans.map((span) => span.end));
    if (spanEnd - spanStart + 1 > ENTITY_ALIAS_REQUIRED_SPAN_MAX_TOKENS) continue;
    const context = tokens
      .slice(
        Math.max(0, spanStart - ENTITY_ALIAS_TOKEN_WINDOW_RADIUS),
        Math.min(tokens.length, spanEnd + ENTITY_ALIAS_TOKEN_WINDOW_RADIUS + 1),
      )
      .join(" ");
    if (!context || seen.has(context)) continue;
    seen.add(context);
    windows.push({
      context,
      anchorSegment: tokens
        .filter((_entry, index) =>
          segmentByIndex[index] === segmentByIndex[anchorIndex] &&
          tokens[index] !== ENTITY_ALIAS_SENTENCE_BOUNDARY
        )
        .join(" "),
    });
  }
  return windows;
}

function highInformationAliasContextSequence(
  source: string,
  excludedKeys: string[],
): Array<string | null> {
  const excluded = new Set(
    excludedKeys.flatMap((key) =>
      queryTerms(key.replace(/[_\p{Pd}]+/gu, " "), 64)
    ),
  );
  return normalizedStructuredEntityText(source).split(" ").filter(Boolean).map((term) => {
    if (
      term === ENTITY_ALIAS_SENTENCE_BOUNDARY ||
      excluded.has(term) ||
      ENTITY_ALIAS_LOW_INFORMATION_CONTEXT_TERMS.has(term) ||
      queryTerms(term, 1).length === 0
    ) {
      return null;
    }
    if (/\p{Script=Han}/u.test(term)) return [...term].length >= 2 ? term : null;
    if (/^\d+$/u.test(term)) return term.length >= 2 ? term : null;
    return term.length >= 4 ? term : null;
  });
}

type EntityAliasCorroboration = { corroborated: boolean; explicitlyDistinct: boolean; gapMs: number };

function sharedAliasContextBigram(
  leftTerms: Array<string | null>,
  rightTerms: Array<string | null>,
): string | null {
  const leftBigrams = new Set<string>();
  for (let index = 0; index + 1 < leftTerms.length; index += 1) {
    const left = leftTerms[index];
    const right = leftTerms[index + 1];
    if (left && right) leftBigrams.add(`${left}\n${right}`);
  }
  for (let index = 0; index + 1 < rightTerms.length; index += 1) {
    const left = rightTerms[index];
    const right = rightTerms[index + 1];
    if (!left || !right) continue;
    const bigram = `${left}\n${right}`;
    if (leftBigrams.has(bigram)) return bigram;
  }
  return null;
}

function sourceSignalsRecentEntityEvent(source: string): boolean {
  return (
    /\b(?:just|recently|same (?:appointment|event|visit))\b/iu.test(source) ||
    /(?:刚刚|刚才|最近|同一次|同一场|同一位)/u.test(source)
  );
}

function sourceAliasNegatesSameRole(terms: string[]): boolean {
  const phrase = terms.slice(-6).join(" ");
  return /(?:^|\s)(?:not(?: exactly)?|never)(?: the)? same$/u.test(phrase) ||
    /(?:^|\s)no longer(?: the)? same$/u.test(phrase) ||
    /(?:^|\s)(?:aren|isn|wasn|weren) t(?: the)? same$/u.test(phrase) ||
    /(?:^|\s)(?:arent|isnt|wasnt|werent)(?: the)? same$/u.test(phrase);
}

function sourceAliasAnchorExplicitlyDistinguishesEntity(
  source: string,
  roleKey: string,
  nameKey?: string,
): boolean {
  const tokens = normalizedStructuredEntityText(source).split(" ").filter(Boolean);
  const roleTerms = normalizedStructuredRoleText(roleKey).split(" ").filter(Boolean);
  if (roleTerms.length === 0) return false;
  const nameTerms = nameKey
    ? normalizedStructuredEntityText(nameKey).split(" ").filter(Boolean)
    : [];
  const phraseStarts = (phrase: string[]): number[] =>
    tokens.flatMap((term, index) =>
      phrase.every((phraseTerm, offset) => tokens[index + offset] === phraseTerm)
        ? [index]
        : []
    );
  const roleStarts = phraseStarts(roleTerms);
  const nameStarts = nameTerms.length > 0 ? phraseStarts(nameTerms) : [];
  const titledStarts = tokens.flatMap((term, index) =>
    /^(?:dr|mr|mrs|ms|prof)$/u.test(term) && index + 1 < tokens.length ? [index] : []
  );
  const directModifiers = new Set([
    "additional",
    "another",
    "different",
    "distinct",
    "new",
    "next",
    "other",
    "second",
    "separate",
  ]);
  const roleBelongsToCandidate = (roleStart: number): boolean => {
    if (nameStarts.length === 0) return nameTerms.length === 0;
    const nearestDistance = Math.min(
      ...titledStarts.map((titleStart) => Math.abs(titleStart - roleStart)),
    );
    const nearestTitles = titledStarts.filter(
      (titleStart) => Math.abs(titleStart - roleStart) === nearestDistance,
    );
    return nearestTitles.length === 1 && nameStarts.includes(nearestTitles[0]!);
  };
  for (const roleStart of roleStarts) {
    if (!roleBelongsToCandidate(roleStart)) continue;
    const preceding = tokens.slice(Math.max(0, roleStart - 6), roleStart);
    if (sourceAliasNegatesSameRole(preceding) || /(?:不是|并非|不再是|绝非)(?:同一(?:位|个)?|相同(?:的)?)$/u.test(preceding.join(" "))) return true;
    if (preceding.slice(-4).includes("same") || /同一(?:位|个)?$/u.test(preceding.join(" "))) continue;
    if (preceding.slice(-4).some((term) => directModifiers.has(term)) || /(?:另一(?:位|个)?|不同(?:的)?|另外(?:一位|一个)?|分别)$/u.test(preceding.join(" "))) return true;
  }
  if (nameStarts.length === 0) return false;
  for (const nameStart of nameStarts) {
    const afterName = tokens.slice(nameStart + nameTerms.length, nameStart + nameTerms.length + 12);
    const modifierIndex = afterName.findIndex((term) => directModifiers.has(term));
    const fromIndex = modifierIndex < 0 ? -1 : afterName.indexOf("from", modifierIndex + 1);
    if (
      fromIndex >= 0 &&
      roleStarts.some((roleStart) =>
        roleStart >= nameStart + nameTerms.length + fromIndex + 1 &&
        roleStart <= nameStart + nameTerms.length + fromIndex + 7
      )
    ) {
      return true;
    }
    const beforeName = tokens.slice(Math.max(0, nameStart - 5), nameStart);
    const namesSeparateEvent = beforeName.includes("separate") &&
      beforeName.some((term) => /^(?:appointment|event|review|visit)$/u.test(term));
    if (
      namesSeparateEvent &&
      roleStarts.some((roleStart) => Math.abs(roleStart - nameStart) <= 12)
    ) {
      return true;
    }
  }
  return false;
}

function sourceAliasContextExplicitlyNegatesSameEntity(
  source: string,
  roleKey: string,
  nameKey: string,
): boolean {
  const roleTerms = normalizedStructuredRoleText(roleKey).split(" ").filter(Boolean);
  const nameTerms = normalizedStructuredEntityText(nameKey).split(" ").filter(Boolean);
  if (roleTerms.length === 0 || nameTerms.length === 0) return false;
  const tokens = normalizedStructuredEntityText(source).split(" ").filter(Boolean);
  for (let index = 0; index + roleTerms.length <= tokens.length; index += 1) {
    if (!roleTerms.every((term, offset) => tokens[index + offset] === term)) continue;
    const preceding = tokens.slice(Math.max(0, index - 6), index);
    if (!sourceAliasNegatesSameRole(preceding) && !/(?:他|她)(?:不是|并非|不再是|绝非)(?:同一(?:位|个)?|相同(?:的)?)$/u.test(preceding.join(""))) continue;
    const segmentStart = tokens.lastIndexOf(ENTITY_ALIAS_SENTENCE_BOUNDARY, index - 1) + 1;
    const nextBoundary = tokens.indexOf(ENTITY_ALIAS_SENTENCE_BOUNDARY, index);
    const segmentEnd = nextBoundary < 0 ? tokens.length : nextBoundary;
    const segmentTokens = tokens.slice(segmentStart, segmentEnd);
    const pronounIndex = ENTITY_ALIAS_DISCOURSE_PREFIXES.has(segmentTokens[0] ?? "") ? 1 : 0;
    const startsWithPronoun = /^(?:he|she|they|他|她|他们|她们)$/u.test(
      segmentTokens[pronounIndex] ?? "",
    );
    const startsWithChinesePronounNegation = /^(?:(?:不过|但是|然而|其实|仍然)?(?:他|她)(?:不是|并非|不再是|绝非)(?:同一(?:位|个)?|相同(?:的)?))/u.test(
      segmentTokens.slice(0, 2).join(""),
    );
    const previousBoundary = tokens.lastIndexOf(ENTITY_ALIAS_SENTENCE_BOUNDARY, segmentStart - 2);
    const previousSegment = tokens.slice(previousBoundary + 1, segmentStart - 1);
    const previousNamesCandidate = previousSegment.some((term, nameIndex) =>
      nameTerms.every((nameTerm, offset) => previousSegment[nameIndex + offset] === nameTerm)
    );
    const namesAnotherTitledEntity = segmentTokens.some((term, tokenIndex) =>
      /^(?:dr|mr|mrs|ms|prof)$/u.test(term) && tokenIndex + 1 < segmentTokens.length
    );
    if (
      (startsWithPronoun || startsWithChinesePronounNegation) &&
      previousNamesCandidate &&
      !namesAnotherTitledEntity
    ) return true;
  }
  return false;
}

function corroborationForEntityAlias(input: {
  generic: StructuredEntityMention;
  specific: NamedEntityAliasCandidate;
  genericSource: string;
  specificSource: string;
}): EntityAliasCorroboration {
  const gapMs = Math.abs(input.specific.createdAtMs - input.generic.createdAtMs);
  const roleKey = normalizedStructuredRoleText(input.generic.object);
  const genericWindows = sourceAliasWindowsContaining(
    input.genericSource,
    [roleKey],
  );
  const specificWindows = sourceAliasWindowsContaining(
    input.specificSource,
    [roleKey, input.specific.key],
  );
  const explicitlyDistinct =
    genericWindows.some((window) =>
      sourceAliasAnchorExplicitlyDistinguishesEntity(
        window.anchorSegment,
        roleKey,
        input.specific.key,
      )
    ) ||
    specificWindows.some((window) =>
      sourceAliasAnchorExplicitlyDistinguishesEntity(
        window.anchorSegment,
        roleKey,
        input.specific.key,
      ) ||
      sourceAliasContextExplicitlyNegatesSameEntity(
        window.context,
        roleKey,
        input.specific.key,
      )
    );
  if (explicitlyDistinct) {
    return { corroborated: false, explicitlyDistinct: true, gapMs };
  }
  if (
    input.generic.confidence < ENTITY_ALIAS_CORROBORATION_MIN_CONFIDENCE ||
    input.specific.confidence < ENTITY_ALIAS_CORROBORATION_MIN_CONFIDENCE ||
    gapMs > ENTITY_ALIAS_CORROBORATION_MAX_GAP_MS
  ) {
    return { corroborated: false, explicitlyDistinct: false, gapMs };
  }
  const excludedKeys = [
    input.generic.subjectKey,
    input.generic.relationKey,
    input.generic.objectKey,
    input.specific.key,
    input.specific.object,
  ];
  const continuitySupported =
    genericWindows.some((window) => sourceSignalsRecentEntityEvent(window.anchorSegment)) &&
    specificWindows.some((window) => sourceSignalsRecentEntityEvent(window.anchorSegment));
  if (!continuitySupported) {
    return { corroborated: false, explicitlyDistinct: false, gapMs };
  }
  for (const genericWindow of genericWindows) {
    const genericTerms = highInformationAliasContextSequence(genericWindow.context, excludedKeys);
    for (const specificWindow of specificWindows) {
      const specificTerms = highInformationAliasContextSequence(specificWindow.context, excludedKeys);
      if (sharedAliasContextBigram(genericTerms, specificTerms)) {
        return { corroborated: true, explicitlyDistinct: false, gapMs };
      }
    }
  }
  return { corroborated: false, explicitlyDistinct: false, gapMs };
}

function roleLikeStructuredRelation(relationKey: string): boolean {
  return new Set([
    "occupation",
    "profession",
    "role",
    "serves as",
    "specialty",
    "works as",
  ]).has(relationKey);
}

interface NamedEntityAliasCandidate {
  key: string;
  object: string;
  confidence: number;
  createdAtMs: number;
  sourceEvidenceId: string;
}

function namedEntityAliasCandidatesFor(
  generic: StructuredEntityMention,
  mentions: StructuredEntityMention[],
  visibleSourceEvidence: ReadonlyMap<string, string>,
): NamedEntityAliasCandidate[] {
  const candidates: NamedEntityAliasCandidate[] = [];
  for (const relation of mentions) {
    if (
      relation === generic ||
      relation.subjectKey !== generic.subjectKey ||
      relation.relationKey !== generic.relationKey ||
      relation.objectKey === generic.objectKey
    ) {
      continue;
    }
    const namedObject = explicitNamedEntity(relation.object);
    if (
      namedObject &&
      ` ${relation.objectKey} `.includes(` ${generic.objectKey} `)
    ) {
      candidates.push({
        key: namedObject.key,
        object: relation.object,
        confidence: relation.confidence,
        createdAtMs: relation.createdAtMs,
        sourceEvidenceId: relation.sourceEvidenceId,
      });
      continue;
    }
    const leadingRole = leadingRoleNamedEntity(relation.object);
    if (
      leadingRole &&
      leadingRole.roleKey === normalizedStructuredRoleText(generic.object) &&
      sourceContainsStructuredEntityPhrase(
        visibleSourceEvidence.get(generic.sourceEvidenceId) ?? "",
        generic.objectKey,
      ) &&
      sourceContainsStructuredEntityPhrase(
        visibleSourceEvidence.get(relation.sourceEvidenceId) ?? "",
        relation.objectKey,
      )
    ) {
      candidates.push({
        key: leadingRole.name.key,
        object: `${leadingRole.name.label}, ${generic.object}`,
        confidence: relation.confidence,
        createdAtMs: relation.createdAtMs,
        sourceEvidenceId: relation.sourceEvidenceId,
      });
      continue;
    }
    if (!namedObject) continue;
    const roles = mentions.filter((role) =>
      role !== generic &&
      role !== relation &&
      role.subjectKey === namedObject.key &&
      roleLikeStructuredRelation(role.relationKey) &&
      role.objectKey === generic.objectKey &&
      role.sourceEvidenceId === relation.sourceEvidenceId &&
      Math.abs(role.createdAtMs - relation.createdAtMs) <= ENTITY_ALIAS_CANDIDATE_MAX_GAP_MS
    );
    if (roles.length > 0) {
      candidates.push({
        key: namedObject.key,
        object: `${namedObject.label}, ${generic.object}`,
        confidence: Math.min(
          relation.confidence,
          Math.max(...roles.map((role) => role.confidence)),
        ),
        createdAtMs: relation.createdAtMs,
        sourceEvidenceId: relation.sourceEvidenceId,
      });
    }
  }
  return candidates;
}

function entityAliasCandidateHints(
  memories: MemoryRecord[],
  visibleSourceEvidence: ReadonlyMap<string, string>,
  maxHints = 2,
): string[] {
  const mentions = uniqueMemoriesById(memories)
    .map(structuredEntityMention)
    .filter((mention): mention is StructuredEntityMention =>
      mention !== null &&
      sourceSupportsStructuredEntityMention(
        visibleSourceEvidence.get(mention.sourceEvidenceId) ?? "",
        mention.objectKey,
      )
    );
  const groups = new Map<string, {
    relation: string;
    genericObject: string;
    specificObjects: Map<string, {
      object: string;
      genericCreatedAtMs: number;
      createdAtMs: number;
      explicitlyDistinct: boolean;
      corroborated: boolean;
      gapMs: number;
    }>;
  }>();
  for (const generic of mentions) {
    if (
      generic.objectKey.split(" ").length < 2 ||
      looksLikeExplicitlyNamedEntity(generic.object)
    ) {
      continue;
    }
    for (const specific of namedEntityAliasCandidatesFor(
      generic,
      mentions,
      visibleSourceEvidence,
    )) {
      const genericSource = visibleSourceEvidence.get(generic.sourceEvidenceId) ?? "";
      const specificSource = visibleSourceEvidence.get(specific.sourceEvidenceId) ?? "";
      const corroboration = corroborationForEntityAlias({
        generic,
        specific,
        genericSource,
        specificSource,
      });
      if (
        corroboration.gapMs > ENTITY_ALIAS_CANDIDATE_MAX_GAP_MS &&
        !corroboration.explicitlyDistinct
      ) {
        continue;
      }
      const key = [generic.subjectKey, generic.relationKey, generic.objectKey].join("\n");
      const group = groups.get(key) ?? {
        relation: generic.relation,
        genericObject: generic.object,
        specificObjects: new Map<string, {
          object: string;
          genericCreatedAtMs: number;
          createdAtMs: number;
          explicitlyDistinct: boolean;
          corroborated: boolean;
          gapMs: number;
        }>(),
      };
      const existingSpecific = group.specificObjects.get(specific.key);
      const explicitlyDistinct =
        existingSpecific?.explicitlyDistinct === true ||
        corroboration.explicitlyDistinct;
      const useSpecific =
        !existingSpecific ||
        (corroboration.corroborated && !existingSpecific.corroborated) ||
        (
          corroboration.corroborated === existingSpecific.corroborated &&
          (
            corroboration.gapMs < existingSpecific.gapMs ||
            (
              corroboration.gapMs === existingSpecific.gapMs &&
              (generic.createdAtMs < existingSpecific.genericCreatedAtMs ||
                (
                  generic.createdAtMs === existingSpecific.genericCreatedAtMs &&
                  specific.createdAtMs < existingSpecific.createdAtMs
                ))
            )
          )
        );
      group.specificObjects.set(
        specific.key,
        useSpecific
          ? {
              object: specific.object,
              genericCreatedAtMs: generic.createdAtMs,
              createdAtMs: specific.createdAtMs,
              explicitlyDistinct,
              corroborated: corroboration.corroborated,
              gapMs: corroboration.gapMs,
            }
          : { ...existingSpecific, explicitlyDistinct },
      );
      groups.set(key, group);
    }
  }
  const hints: string[] = [];
  for (const [, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.specificObjects.size !== 1) continue;
    const specific = [...group.specificObjects.values()][0];
    if (!specific || specific.explicitlyDistinct) continue;
    const genericDate = new Date(specific.genericCreatedAtMs).toISOString().slice(0, 10);
    const specificDate = new Date(specific.createdAtMs).toISOString().slice(0, 10);
    if (specific.corroborated) {
      hints.push(
        `Corroborated entity alias (derived, not an independent fact): role-only ${JSON.stringify(group.genericObject)} (${genericDate}) and named ${JSON.stringify(specific.object)} (${specificDate}) share the same user-sourced subject, relation ${JSON.stringify(group.relation)}, role, and event context within 48 hours. Treat them as one entity when counting this relation unless explicit contradictory evidence is present.`,
      );
    } else {
      hints.push(
        `Potential entity alias (inference, not a fact): role-only ${JSON.stringify(group.genericObject)} (${genericDate}) and named ${JSON.stringify(specific.object)} (${specificDate}) share the same subject and relation ${JSON.stringify(group.relation)}. Status: uncertain; do not infer either sameness or difference without additional corroborating evidence.`,
      );
    }
    if (hints.length >= maxHints) break;
  }
  return hints;
}

function finiteEnumerationTarget(query: string): number | null {
  const normalized = query.normalize("NFC").toLowerCase();
  const asksForEnumeration =
    /\b(?:list|name|order|sequence)\b/u.test(normalized) ||
    /\b(?:what|which)\b[^?!.]{0,48}\b(?:are|were)\b/u.test(normalized);
  if (!asksForEnumeration) return null;
  const match = /\b(?:the\s+)?(both|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z][a-z-]*)\b/u.exec(
    normalized,
  );
  if (!match) return null;
  if (/^(?:day|days|hour|hours|month|months|week|weeks|year|years)$/u.test(match[2] ?? "")) {
    return null;
  }
  const counts: Record<string, number> = {
    both: 2,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return counts[match[1] ?? ""] ?? null;
}

function targetMemoryCountForQuery(
  query: string,
  recallPurpose: ReconstructionRecallPurpose,
  maxMemories: number,
): number {
  const finiteTarget = finiteEnumerationTarget(query);
  const desired = queryNeedsAggregateRecall(query)
    ? 48
    : finiteTarget !== null
      ? Math.max(finiteTarget, recallPurpose === "history" ? 4 : 2)
      : recallPurpose === "history"
        ? 4
        : 2;
  return Math.min(desired, maxMemories);
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

function memoryMatchesTagGroup(memory: MemoryRecord, tags: Set<string>): boolean {
  const actionPolicyKind =
    typeof memory.metadata.actionPolicyKind === "string" ? memory.metadata.actionPolicyKind : "";
  return (
    tags.has(memory.kind) ||
    (actionPolicyKind.length > 0 && tags.has(actionPolicyKind)) ||
    (memory.kind === "boundary" && tags.has("do_not_push"))
  );
}

function memoryMatchesIntent(memory: MemoryRecord, intent: ReconstructionIntent): boolean {
  return memoryMatchesTagGroup(memory, intent.expectedTags);
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
  reciprocalRankSum: number;
  matchedQueryCount: number;
}

interface ReconstructionSweepCandidate {
  cue: string;
  matchedCues: string[];
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

const QUERY_EVIDENCE_SHORTLIST_MAX_ITEMS = 8;
const QUERY_EVIDENCE_SHORTLIST_MAX_TOKENS = 640;

function queryNeedsMonetaryEvidence(query: string): boolean {
  const normalized = query.normalize("NFC").toLowerCase();
  return queryNeedsAggregateRecall(query) && (
    /\b(?:cost|costs|expense|expenses|money|paid|payment|payments|price|prices|purchase|purchases|spend|spending|spent)\b/u.test(
      normalized,
    ) ||
    /(?:一共多少钱|价格|总价|总费用|总支出|支付|支出|花了|花费|费用|金额)/u.test(normalized)
  );
}

function monetaryEvidenceSignatures(text: string): string[] {
  const matches = text.normalize("NFC").match(
    /(?:[$€£¥]\s*\d+(?:[.,]\d+)*|\b\d+(?:[.,]\d+)*\s*(?:cny|dollars?|eur|euros?|gbp|pounds?|rmb|usd|yuan)\b)/giu,
  ) ?? [];
  return [...new Set(matches.map((value) => value.toLowerCase().replace(/[\s,]/gu, "")))];
}

function userGroundedMemory(memory: MemoryRecord): boolean {
  return memory.metadata.sourceTrust === "user" ||
    memory.metadata.sourceRole === "user" ||
    /^\s*user\s*:/iu.test(memory.content);
}

function assistantGroundedMemory(memory: MemoryRecord): boolean {
  return memory.metadata.sourceTrust === "assistant" ||
    memory.metadata.sourceRole === "assistant" ||
    /^\s*assistant\s*:/iu.test(memory.content);
}

function hypotheticalAssistantMemory(memory: MemoryRecord): boolean {
  return assistantGroundedMemory(memory) &&
    /\b(?:could|estimate|estimated|example|hypothetical|hypothetically|might|typically)\b/iu.test(
      memory.content,
    );
}

function userCentricQuery(query: string): boolean {
  return /\b(?:i|me|my|mine|our|ours|we)\b/iu.test(query) || /(?:我|我们|我的|我们的)/u.test(query);
}

function queryEvidenceShortlistCandidates(input: {
  query: string;
  candidates: ReconstructionSweepCandidate[];
  maxItems: number;
}): ReconstructionSweepCandidate[] {
  if (!queryNeedsAggregateRecall(input.query) || input.maxItems <= 0) return [];
  const monetaryQuery = queryNeedsMonetaryEvidence(input.query);
  const queryIsUserCentric = userCentricQuery(input.query);
  const ranked = input.candidates.map((candidate) => {
    const signatures = monetaryEvidenceSignatures(candidate.memory.content);
    const userGrounded = userGroundedMemory(candidate.memory);
    return {
      candidate,
      signatures,
      userGrounded,
      score: candidate.relevance +
        (monetaryQuery && signatures.length > 0 ? 12 : 0) +
        (userGrounded ? 4 : 0) -
        (assistantGroundedMemory(candidate.memory) ? 4 : 0),
    };
  }).filter((entry) =>
    !(queryIsUserCentric && hypotheticalAssistantMemory(entry.candidate.memory))
  ).sort((left, right) =>
    right.score - left.score ||
    right.candidate.memory.updatedAt.localeCompare(left.candidate.memory.updatedAt) ||
    left.candidate.memory.id.localeCompare(right.candidate.memory.id)
  );
  let pool = ranked;
  if (monetaryQuery) {
    pool = ranked.filter((entry) => entry.signatures.length > 0);
  }
  const selected: typeof ranked = [];
  const selectedIds = new Set<string>();
  const selectedContent = new Set<string>();
  const seenSignatures = new Set<string>();
  const add = (entry: (typeof ranked)[number]): void => {
    const contentKey = normalizedText(entry.candidate.memory.content);
    if (
      selectedIds.has(entry.candidate.memory.id) ||
      (contentKey.length > 0 && selectedContent.has(contentKey))
    ) {
      return;
    }
    selected.push(entry);
    selectedIds.add(entry.candidate.memory.id);
    if (contentKey.length > 0) selectedContent.add(contentKey);
    for (const signature of entry.signatures) seenSignatures.add(signature);
  };
  if (monetaryQuery) {
    for (const entry of pool) {
      if (selected.length >= input.maxItems) break;
      if (entry.signatures.some((signature) => !seenSignatures.has(signature))) add(entry);
    }
  }
  for (const entry of pool) {
    if (selected.length >= input.maxItems) break;
    add(entry);
  }
  return selected.map((entry) => entry.candidate);
}

const DEFAULT_SWEEP_PER_CUE_CAP = 40;
const DEFAULT_SWEEP_GLOBAL_CAP = 80;

function compareSweepChronological(
  left: ReconstructionSweepCandidate,
  right: ReconstructionSweepCandidate,
): number {
  return left.memory.createdAt.localeCompare(right.memory.createdAt) ||
    left.memory.id.localeCompare(right.memory.id);
}

function compareSweepReaderPriority(
  left: ReconstructionSweepCandidate,
  right: ReconstructionSweepCandidate,
): number {
  return right.relevance - left.relevance || compareSweepChronological(left, right);
}

function compareSweepCullPriority(
  left: ReconstructionSweepCandidate,
  right: ReconstructionSweepCandidate,
): number {
  return left.relevance - right.relevance ||
    right.memory.createdAt.localeCompare(left.memory.createdAt) ||
    right.memory.id.localeCompare(left.memory.id);
}

function sweepCandidateToCull(
  candidates: ReconstructionSweepCandidate[],
): ReconstructionSweepCandidate | undefined {
  const perCue = new Map<string, number>();
  for (const candidate of candidates) {
    for (const cue of candidate.matchedCues) {
      perCue.set(cue, (perCue.get(cue) ?? 0) + 1);
    }
  }
  const withoutLastCueRepresentatives = candidates.filter(
    (candidate) => candidate.matchedCues.every((cue) => (perCue.get(cue) ?? 0) > 1),
  );
  return [...(withoutLastCueRepresentatives.length > 0 ? withoutLastCueRepresentatives : candidates)]
    .sort(compareSweepCullPriority)[0];
}

function sweepLexicalCoverage(memory: MemoryRecord, cue: string): number {
  const terms = queryTerms(cue, 24);
  if (terms.length === 0) return 0;
  const content = memory.content.normalize("NFC").toLowerCase();
  return terms.filter((term) => content.includes(term)).length / terms.length;
}

function sweepSourceAuthority(memory: MemoryRecord): number {
  if (
    !hasGmosMetadataReferenceSchema(
      memory.metadata,
      GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
    )
  ) {
    return 0.5;
  }
  if (memory.metadata.sourceTrust === "user") return 1;
  if (memory.metadata.sourceTrust === "agent") return 0.25;
  if (memory.metadata.sourceTrust === "external") return 0;
  return 0.5;
}

function sweepCandidateRelevance(input: {
  memory: MemoryRecord;
  maxLexicalCoverage: number;
  reciprocalRankSum: number;
}): number {
  return (
    2 * input.maxLexicalCoverage +
    10 * input.reciprocalRankSum +
    0.75 * sweepSourceAuthority(input.memory) +
    0.5 * input.memory.confidence
  );
}

function sweepStatsFor(
  cueStats: ReconstructionSweepCueDraftStats[],
  candidates: ReconstructionSweepCandidate[],
): NonNullable<ReconstructedContext["stats"]["sweeps"]> {
  const includedByCue = new Map<string, number>();
  for (const candidate of candidates) {
    for (const cue of candidate.matchedCues) {
      includedByCue.set(cue, (includedByCue.get(cue) ?? 0) + 1);
    }
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
  const matched = cues.reduce((sum, cue) => sum + cue.matched, 0);
  const included = candidates.length;
  return {
    matched,
    included,
    truncated: Math.max(0, matched - included),
    cues,
  };
}

async function runReconstructionSweeps(input: {
  store: MemoryStore;
  profileId: string;
  asOf?: string | undefined;
  sweepCues: string[];
  recallPurpose: ReconstructionRecallPurpose;
  includeSensitive?: boolean | undefined;
  queryEmbedding?: QueryVectorEmbedding | undefined;
  perCueCap?: number | undefined;
  globalCap?: number | undefined;
  expandStructuredRoleSiblings?: boolean | undefined;
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
  const candidates: ReconstructionSweepCandidate[] = [];
  const candidateById = new Map<string, ReconstructionSweepCandidate>();
  const cueStats: ReconstructionSweepCueDraftStats[] = [];
  const resultsByCue: Array<{ cue: string; memories: MemoryRecord[] }> = [];
  for (const cue of input.sweepCues) {
    const found = await input.store.searchMemories({
      profileId: input.profileId,
      query: cue,
      purpose: input.recallPurpose,
      ...(input.asOf ? { asOf: input.asOf } : {}),
      includeSensitive: input.includeSensitive,
      limit: perCueCap + 1,
      ...(input.queryEmbedding ? { freshQueryEmbedding: true } : {}),
    });
    cueStats.push({ cue, matched: found.length });
    resultsByCue.push({ cue, memories: found.slice(0, perCueCap) });
  }
  const aggregateById = new Map<string, {
    memory: MemoryRecord;
    cue: string;
    bestCueCoverage: number;
    bestCueRankScore: number;
    maxLexicalCoverage: number;
    reciprocalRankSum: number;
    matchedCues: Set<string>;
  }>();
  for (const result of resultsByCue) {
    for (const [rank, memory] of result.memories.entries()) {
      const lexicalCoverage = sweepLexicalCoverage(memory, result.cue);
      const rankScore = reciprocalRankScore(rank + 1);
      const existing = aggregateById.get(memory.id);
      if (!existing) {
        aggregateById.set(memory.id, {
          memory,
          cue: result.cue,
          bestCueCoverage: lexicalCoverage,
          bestCueRankScore: rankScore,
          maxLexicalCoverage: lexicalCoverage,
          reciprocalRankSum: rankScore,
          matchedCues: new Set([result.cue]),
        });
        continue;
      }
      existing.matchedCues.add(result.cue);
      existing.maxLexicalCoverage = Math.max(existing.maxLexicalCoverage, lexicalCoverage);
      existing.reciprocalRankSum += rankScore;
      if (
        lexicalCoverage > existing.bestCueCoverage ||
        (lexicalCoverage === existing.bestCueCoverage && rankScore > existing.bestCueRankScore) ||
        (
          lexicalCoverage === existing.bestCueCoverage &&
          rankScore === existing.bestCueRankScore &&
          result.cue.localeCompare(existing.cue) < 0
        )
      ) {
        existing.memory = memory;
        existing.cue = result.cue;
        existing.bestCueCoverage = lexicalCoverage;
        existing.bestCueRankScore = rankScore;
      }
    }
  }
  for (const aggregate of aggregateById.values()) {
    const candidate = {
      cue: aggregate.cue,
      matchedCues: [...aggregate.matchedCues].sort((left, right) => left.localeCompare(right)),
      memory: aggregate.memory,
      relevance: sweepCandidateRelevance({
        memory: aggregate.memory,
        maxLexicalCoverage: aggregate.maxLexicalCoverage,
        reciprocalRankSum: aggregate.reciprocalRankSum,
      }),
    };
    candidateById.set(candidate.memory.id, candidate);
    candidates.push(candidate);
  }
  while (candidates.length > globalCap) {
    const drop = sweepCandidateToCull(candidates);
    if (!drop) break;
    candidateById.delete(drop.memory.id);
    candidates.splice(candidates.indexOf(drop), 1);
  }
  if (input.expandStructuredRoleSiblings === true) {
    const structuredRoleSeeds = new Map<string, {
      cue: string;
      name: ExplicitNamedEntity;
      sourceEvidenceId: string;
      relevance: number;
    }>();
    const expandedMatchedByCue = new Map<string, number>();
    for (const candidate of candidates) {
      const mention = structuredEntityMention(candidate.memory);
      const name = mention ? explicitNamedEntity(mention.subject) : null;
      if (!mention || !name || !roleLikeStructuredRelation(mention.relationKey)) continue;
      const key = `${name.key}\n${mention.sourceEvidenceId}`;
      const existing = structuredRoleSeeds.get(key);
      if (!existing || candidate.relevance > existing.relevance) {
        structuredRoleSeeds.set(key, {
          cue: candidate.cue,
          name,
          sourceEvidenceId: mention.sourceEvidenceId,
          relevance: candidate.relevance,
        });
      }
    }
    for (const [, seed] of [...structuredRoleSeeds].sort(([left], [right]) =>
      left.localeCompare(right)
    ).slice(0, 8)) {
      const found = await input.store.searchMemories({
        profileId: input.profileId,
        query: seed.name.label,
        purpose: input.recallPurpose,
        ...(input.asOf ? { asOf: input.asOf } : {}),
        includeSensitive: input.includeSensitive,
        limit: perCueCap,
        ...(input.queryEmbedding ? { freshQueryEmbedding: true } : {}),
      });
      const siblings = found.filter((memory) =>
        structuredEntityMention(memory)?.sourceEvidenceId === seed.sourceEvidenceId
      );
      if (siblings.length === 0) continue;
      expandedMatchedByCue.set(
        seed.name.label,
        Math.max(expandedMatchedByCue.get(seed.name.label) ?? 0, found.length),
      );
      for (const [rank, memory] of siblings.entries()) {
        if (candidateById.has(memory.id)) continue;
        const candidate = {
          cue: seed.name.label,
          matchedCues: [seed.name.label],
          memory,
          relevance: seed.relevance + reciprocalRankScore(rank + 1),
        };
        candidateById.set(memory.id, candidate);
        candidates.push(candidate);
        if (candidates.length > globalCap) {
          const drop = sweepCandidateToCull(candidates);
          if (!drop) break;
          candidateById.delete(drop.memory.id);
          candidates.splice(candidates.indexOf(drop), 1);
        }
      }
    }
    for (const [cue, matched] of expandedMatchedByCue) {
      const existing = cueStats.find((entry) => entry.cue === cue);
      if (existing) existing.matched = Math.max(existing.matched, matched);
      else cueStats.push({ cue, matched });
    }
  }
  return {
    candidates: candidates.sort(compareSweepReaderPriority),
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
  asOf?: string | undefined;
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
  const rootQueryKey = normalizedText(input.query);
  const seenQueryKeys = new Set<string>();
  for (const searchQuery of searchQueries) {
    const searchQueryKey = normalizedText(searchQuery);
    if (seenQueryKeys.has(searchQueryKey)) continue;
    seenQueryKeys.add(searchQueryKey);
    const isRootQuery = searchQueryKey === rootQueryKey;
    const queryWeight = isRootQuery ? 2 : 1;
    const memories = await input.store.searchMemories({
      profileId: input.profileId,
      query: searchQuery,
      purpose: input.recallPurpose,
      ...(input.asOf ? { asOf: input.asOf } : {}),
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
      const reciprocalRank = reciprocalRankScore(memoryIndex + 1) * queryWeight;
      if (existing) {
        existing.reciprocalRankSum += reciprocalRank;
        existing.matchedQueryCount += 1;
        if (isRootQuery) existing.memory = memory;
        else existing.matchedQuery ??= searchQuery;
        continue;
      }
      candidates.set(memory.id, {
        memory,
        ...(!isRootQuery ? { matchedQuery: searchQuery } : {}),
        reciprocalRankSum: reciprocalRank,
        matchedQueryCount: 1,
      });
    }
  }
  return [...candidates.values()].sort((left, right) =>
    right.reciprocalRankSum - left.reciprocalRankSum ||
    right.memory.updatedAt.localeCompare(left.memory.updatedAt) ||
    left.memory.id.localeCompare(right.memory.id)
  );
}

function rankDirectMemory(
  candidate: DirectMemoryCandidate,
  intent: ReconstructionIntent,
): RankedMemoryCandidate {
  const memory = candidate.memory;
  const reasons = [`hybrid_direct_memory_rrf:${candidate.reciprocalRankSum.toFixed(6)}`];
  let routeScore = memory.confidence + candidate.reciprocalRankSum * 100;
  if (candidate.matchedQuery) {
    reasons.push("cue_search");
  }
  if (candidate.matchedQueryCount > 1) {
    reasons.push(`query_corroboration:${candidate.matchedQueryCount}`);
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
    sourceEvidenceId: exactPrimaryEvidenceId(candidate.memory),
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
  asOf?: string | undefined;
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
    ...(input.asOf ? { asOf: input.asOf } : {}),
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
    .map((memory) => rankDirectMemory(memory, input.intent))
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
    if (input.maxNewPaths !== undefined && selectedNewPaths.length >= input.maxNewPaths) break;
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
  asOf?: string | undefined;
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
      ...(input.asOf ? { asOf: input.asOf } : {}),
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
  let stopReason = input.stopReason;
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
    memories,
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
    stopReason,
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
      stopReason,
      evidenceConvergence: outputEvidenceConvergence,
    });
    const exposePlannerTrace = input.displayQuery === undefined || input.displayQuery === input.query;
    const outputPlannerTrace = exposePlannerTrace && input.plannerTrace
      ? publicPlannerTrace(input.plannerTrace, privateSignalKeys, stopReason)
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
      ...[...candidates].sort(compareSweepChronological).map((candidate) => {
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
  const budget = input.contextBudgetTokens ?? 1800;
  let contentSurfaces = { plain: "", temporal: "" };
  let includeEntityAliasCandidates = true;
  let shortlistItemLimit = QUERY_EVIDENCE_SHORTLIST_MAX_ITEMS;
  const render = (includeSweeps: boolean): string => {
    coverage = evidenceCoverageForPaths(
      publicQuery,
      paths,
      input.cueExtractor,
      input.inferTemporalCuesFromText,
      memories,
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
      stopReason,
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
    const publicMemories = memories.map((memory) =>
      publicMemory(memory, hideInternalRouteSignals, privateOutputSignalKeySet)
    );
    const surfaceLine = (content: string, temporalSegment: string): string => {
      const temporal = temporalSegment.replace(/^;\s*/u, "");
      return temporal ? `${temporal} ${content}` : content;
    };
    const memorySurfaceEntries = publicMemories.map((memory) => {
      const content = truncateMemoryContent(memory.content, capForMemoryId(memory.id, fullIds));
      return {
        plain: content,
        temporal: surfaceLine(
          content,
          includeTemporalContext ? temporalContextSegment(memory.createdAt, memory.metadata, asOf) : "",
        ),
      };
    });
    const pathSurfaceEntries = output.paths.flatMap((path, index) => {
      if (targetReferenceForPath(path, paths[index]) !== undefined) return [];
      const content = truncateMemoryContent(path.targetSummary, capForPath(path));
      return [{
        plain: content,
        temporal: surfaceLine(
          content,
          includeTemporalContext ? temporalSegmentForPath(path) : "",
        ),
      }];
    });
    const evidenceSurfaceEntries = evidence.map((event) => ({
      plain: event.content,
      temporal: surfaceLine(
        event.content,
        input.includeTemporalMetadata ? observedAtSegment(event.createdAt) : "",
      ),
    }));
    const sweepSurfaceEntries = includeSweeps
      ? [...sweepCandidates].sort(compareSweepChronological).map((candidate) => {
          const memory = publicMemory(
            candidate.memory,
            hideInternalRouteSignals,
            privateOutputSignalKeySet,
          );
          const content = truncateMemoryContent(memory.content, capForMemoryId(memory.id, fullIds));
          const temporal = includeTemporalContext
            ? temporalContextLabel(memory.createdAt, memory.metadata)
            : "";
          return {
            memoryId: memory.id,
            plain: content,
            temporal: temporal ? `${temporal} ${content}` : content,
          };
        })
      : [];
    const shortlistEntries = (includeSweeps
      ? queryEvidenceShortlistCandidates({
          query: publicQuery,
          candidates: sweepCandidates,
          maxItems: shortlistItemLimit,
        })
      : []).map((candidate) => {
        const memory = publicMemory(
          candidate.memory,
          hideInternalRouteSignals,
          privateOutputSignalKeySet,
        );
        const content = truncateMemoryContent(memory.content, capForMemoryId(memory.id, fullIds));
        const temporal = includeTemporalContext
          ? temporalContextLabel(memory.createdAt, memory.metadata)
          : "";
        return {
          memoryId: memory.id,
          plain: content,
          temporal: temporal ? `${temporal} ${content}` : content,
          contextLine: temporal ? `- [${temporal}] ${content}` : `- ${content}`,
        };
      });
    const shortlistTokenBudget = Math.min(
      QUERY_EVIDENCE_SHORTLIST_MAX_TOKENS,
      Math.max(0, Math.floor(budget * 0.08)),
    );
    const shortlistTitle =
      "Query-relevant evidence shortlist (ranked mentions; verify and deduplicate against the dated appendix):";
    while (
      shortlistEntries.length > 0 &&
      estimateTokens([shortlistTitle, ...shortlistEntries.map((entry) => entry.contextLine)].join("\n")) >
        shortlistTokenBudget
    ) {
      shortlistEntries.pop();
    }
    const shortlistMemoryIds = new Set(shortlistEntries.map((entry) => entry.memoryId));
    const candidateMemories = uniqueMemoriesById([
      ...memories,
      ...(includeSweeps ? sweepCandidates.map((candidate) => candidate.memory) : []),
    ]);
    const visibleSourceEvidence = new Map(evidence.map((event) => [event.id, event.content]));
    for (const memory of candidateMemories) {
      if (
        memory.metadata.turnMemory !== true ||
        memory.metadata.sourceTrust !== "user" ||
        !hasGmosMetadataReferenceSchema(
          memory.metadata,
          GMOS_METADATA_REFERENCE_SCHEMAS.runtimeLineage,
        )
      ) {
        continue;
      }
      const sourceEvidenceId = typeof memory.metadata.sourceEvidenceId === "string"
        ? memory.metadata.sourceEvidenceId.trim()
        : "";
      const publicSourceMemory = publicMemory(
        memory,
        hideInternalRouteSignals,
        privateOutputSignalKeySet,
      );
      const visibleContent = truncateMemoryContent(
        publicSourceMemory.content,
        capForMemoryId(memory.id, fullIds),
      );
      if (sourceEvidenceId && visibleContent === publicSourceMemory.content) {
        visibleSourceEvidence.set(sourceEvidenceId, visibleContent);
      }
    }
    const entityAliasHints =
      includeEntityAliasCandidates &&
        queryNeedsEntityAliasCandidates(publicQuery) &&
        !hideInternalRouteSignals
      ? entityAliasCandidateHints(candidateMemories, visibleSourceEvidence)
      : [];
    const entityAliasSurfaceEntries = entityAliasHints.map((hint) => ({ plain: hint, temporal: hint }));
    const surfaceEntries = [
      ...shortlistEntries,
      ...memorySurfaceEntries,
      ...pathSurfaceEntries,
      ...evidenceSurfaceEntries,
      ...sweepSurfaceEntries.filter((entry) => !shortlistMemoryIds.has(entry.memoryId)),
      ...entityAliasSurfaceEntries,
    ];
    contentSurfaces = {
      plain: surfaceEntries.map((entry) => `- ${entry.plain}`).join("\n"),
      temporal: surfaceEntries.map((entry) => `- ${entry.temporal}`).join("\n"),
      ...(asOf ? { referenceDate: asOf } : {}),
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
      ...(shortlistEntries.length > 0
        ? [shortlistTitle, ...shortlistEntries.map((entry) => entry.contextLine)]
        : []),
      "Memory content:",
      ...publicMemories.map(
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
    if (entityAliasHints.length > 0) {
      lines.push("Potential entity aliases (inferences, not independent facts):");
      lines.push(...entityAliasHints.map((hint) => `- ${hint}`));
    }
    lines.push("</gmos-reconstructed-context>");
    return lines.join("\n");
  };
  let contextBlock = render(false);
  // Alias candidates are optional navigation aids, never source evidence. If
  // they would exceed the budget, remove them before culling any original
  // memory, path, or evidence content.
  if (estimateTokens(contextBlock) > budget && includeEntityAliasCandidates) {
    includeEntityAliasCandidates = false;
    contextBlock = render(false);
  }
  // Path lines carry truncated summaries of the same targets; full memory
  // content and exact source evidence are what downstream readers need. Cull
  // duplicate paths first, then retain the largest ranked evidence prefix that
  // fits instead of dropping the entire evidence lane on the first overflow.
  while (estimateTokens(contextBlock) > budget && paths.length > 0) {
    paths = paths.slice(0, -1);
    contextBlock = render(false);
  }
  if (estimateTokens(contextBlock) > budget && evidence.length > 0) {
    const rankedEvidence = [...evidence];
    let lower = 0;
    let upper = rankedEvidence.length;
    while (lower < upper) {
      const candidateCount = Math.ceil((lower + upper) / 2);
      evidence = rankedEvidence.slice(0, candidateCount);
      const candidateBlock = render(false);
      if (estimateTokens(candidateBlock) <= budget) lower = candidateCount;
      else upper = candidateCount - 1;
    }
    evidence = rankedEvidence.slice(0, lower);
    contextBlock = render(false);
  }
  while (estimateTokens(contextBlock) > budget && memories.length > 0) {
    if (input.layerPolicy) dropLayerAwareMemory(memories);
    else memories = memories.slice(0, -1);
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
      const drop = sweepCandidateToCull(sweepCandidates);
      if (!drop) break;
      sweepCandidates = sweepCandidates.filter((candidate) => candidate.memory.id !== drop.memory.id);
    }
    contextBlock = render(true);
    while (shortlistItemLimit > 0 && estimateTokens(contextBlock) > budget) {
      shortlistItemLimit -= 1;
      contextBlock = render(true);
    }
    if (estimateTokens(contextBlock) > budget && includeEntityAliasCandidates) {
      includeEntityAliasCandidates = false;
      contextBlock = render(true);
    }
    while (sweepCandidates.length > 0 && estimateTokens(contextBlock) > budget) {
      const drop = sweepCandidateToCull(sweepCandidates);
      if (!drop) break;
      sweepCandidates = sweepCandidates.filter((candidate) => candidate.memory.id !== drop.memory.id);
      contextBlock = render(true);
    }
  }

  let output = outputState();
  if (stopReason === "evidence_sufficient" && !output.evidenceConvergence.reached) {
    stopReason = "budget_exhausted";
    const includeSweeps = input.sweepDraft !== undefined;
    contextBlock = render(includeSweeps);
    if (estimateTokens(contextBlock) > budget && includeEntityAliasCandidates) {
      includeEntityAliasCandidates = false;
      contextBlock = render(includeSweeps);
    }
    while (estimateTokens(contextBlock) > budget) {
      if (shortlistItemLimit > 0) {
        shortlistItemLimit -= 1;
      } else if (paths.length > 0) {
        paths = paths.slice(0, -1);
      } else if (evidence.length > 0) {
        evidence = evidence.slice(0, -1);
      } else if (sweepCandidates.length > 0) {
        const drop = sweepCandidateToCull(sweepCandidates);
        if (!drop) break;
        sweepCandidates = sweepCandidates.filter((candidate) => candidate.memory.id !== drop.memory.id);
      } else if (memories.length > 0) {
        if (input.layerPolicy) dropLayerAwareMemory(memories);
        else memories = memories.slice(0, -1);
      } else {
        break;
      }
      contextBlock = render(includeSweeps);
    }
    output = outputState();
  }
  if (!includeEntityAliasCandidates) {
    const includeSweeps = input.sweepDraft !== undefined;
    includeEntityAliasCandidates = true;
    const withOptionalAliases = render(includeSweeps);
    if (estimateTokens(withOptionalAliases) <= budget) {
      contextBlock = withOptionalAliases;
    } else {
      includeEntityAliasCandidates = false;
      contextBlock = render(includeSweeps);
    }
  }
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
    contentSurfaces,
    evidence,
    paths: output.paths,
    plannerTrace: output.plannerTrace,
    stats: {
      stepCount: output.stepCount,
      exploredCueCount: output.exploredCueCount,
      associationCount: output.associationCount,
      retrievedMemoryCount: memories.length,
      promptTokenEstimate: estimateTokens(contextBlock),
      stopReason,
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
  query: string,
): Promise<EvidenceEvent[]> {
  return collectReaderEvidenceForMemories({ store, memories, query });
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
        ...(input.asOf ? { asOf: input.asOf } : {}),
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
      ...(input.asOf ? { asOf: input.asOf } : {}),
      includeSensitive: input.includeSensitive,
      limit: input.candidateMemoryLimit,
      ...(input.queryEmbedding ? { queryEmbedding: input.queryEmbedding } : {}),
    }));
  }
  const memories = [...memoryById.values()];
  const targetMemoryCount = input.targetMemoryCount;
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
    sourceEvidenceId: exactPrimaryEvidenceId(memory),
    createdAt: memory.createdAt,
    ...(memoryAnchors.get(memory.id) ? { anchorCue: memoryAnchors.get(memory.id) } : {}),
  }));
  const candidateCoverage = evidenceCoverageForPaths(
    input.query,
    paths,
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  );
  const safePaths = evidenceSupportingPaths({
    paths,
    coverage: candidateCoverage,
    intent: input.intent,
  });
  const safeMemoryIds = new Set(
    safePaths.flatMap((path) => [path.targetId, path.sourceMemoryId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    )),
  );
  const safeMemories = memories.filter((memory) => safeMemoryIds.has(memory.id));
  const fallbackCoverage = evidenceCoverageForPaths(
    input.query,
    safePaths,
    input.cueExtractor,
    input.inferTemporalCuesFromText,
  );
  const fallbackConvergence = evidenceConvergenceForPaths({
    coverage: fallbackCoverage,
    memories: safeMemories,
    paths: safePaths,
    intent: input.intent,
    threshold: input.evidenceConvergenceThreshold,
    targetMemoryCount,
    stopWhenEvidenceEnough: input.stopWhenEvidenceEnough,
    prunedBranchCount: 0,
    frontierRemaining: 0,
  });
  const stopReason =
    safeMemories.length === 0 && safePaths.length === 0
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
    ...(input.asOf ? { asOf: input.asOf } : {}),
    sweepCues: input.intent.sweepCues,
    recallPurpose: input.recallPurpose,
    includeSensitive: input.includeSensitive,
    queryEmbedding: input.queryEmbedding,
    expandStructuredRoleSiblings: queryNeedsEntityAliasCandidates(input.displayQuery ?? input.query),
  });
  return composeReconstructedContext({
    profileId: input.profileId,
    query: input.query,
    displayQuery: input.displayQuery,
    memories: safeMemories,
    evidence: input.includeEvidence
      ? await evidenceForMemories(input.store, safeMemories, input.displayQuery ?? input.query)
      : [],
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
  const asOf = input.request.asOf
    ? normalizeExplicitTemporalInstant(input.request.asOf) ?? undefined
    : undefined;
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
  const targetMemoryCount = targetMemoryCountForQuery(query, recallPurpose, maxMemories);
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
      ...(asOf ? { asOf } : {}),
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
      ...(asOf ? { asOf } : {}),
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
      ...(asOf ? { asOf } : {}),
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
      if (sourceMemory) path.sourceEvidenceId = exactPrimaryEvidenceId(sourceMemory);
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
      const memory = await sourceMemoryForAssociation(association);
      if (!memory || seenMemoryIds.has(memory.id)) continue;
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
      const resolvedPath: ReconstructedEvidencePath = {
        ...path,
        targetId: memory.id,
        sourceMemoryId: memory.id,
        sourceEvidenceId: exactPrimaryEvidenceId(memory),
      };
      enqueueGeneratedCues();
      paths.push(resolvedPath);
      stepTrace.selectedBranchCount += 1;
      stepTrace.branches.push(
        traceBranchFromPath(
          resolvedPath,
          "selected",
          resolvedPath.routeReason ?? ranked.routeReason,
          generatedCues,
        ),
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
  const convergenceBeforeAnchorTopUp = evidenceConvergenceForPaths({
    coverage: coverageBeforeAnchorTopUp,
    memories,
    paths,
    intent,
    threshold: evidenceConvergenceThreshold,
    targetMemoryCount,
    stopWhenEvidenceEnough,
    prunedBranchCount,
    frontierRemaining: frontier.length,
  });
  const wideSupplyRequested = layerPolicy !== undefined || maxMemories > 24;
  const hybridNeededBeforeAnchorTopUp = shouldRunHybridDirectMemorySearch({
    recallPurpose,
    memories,
    paths,
    maxMemories: candidateMemoryLimit,
    targetMemoryCount,
    intent,
    coverage: coverageBeforeAnchorTopUp,
  }) || (
    wideSupplyRequested &&
    memories.length < candidateMemoryLimit &&
    (!stopWhenEvidenceEnough || !convergenceBeforeAnchorTopUp.reached)
  );

  if (anchorPlan && memories.length < candidateMemoryLimit) {
    const anchorTopUpSteps = await topUpUncoveredAnchors({
      store: input.store,
      profileId,
      ...(asOf ? { asOf } : {}),
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
  const convergenceBeforeHybrid = evidenceConvergenceForPaths({
    coverage: finalCoverageBeforeHybrid,
    memories,
    paths,
    intent,
    threshold: evidenceConvergenceThreshold,
    targetMemoryCount,
    stopWhenEvidenceEnough,
    prunedBranchCount,
    frontierRemaining: frontier.length,
  });
  const hybridNeededAfterAnchorTopUp = shouldRunHybridDirectMemorySearch({
    recallPurpose,
    memories,
    paths,
    maxMemories: candidateMemoryLimit,
    targetMemoryCount,
    intent,
    coverage: finalCoverageBeforeHybrid,
  }) || (
    wideSupplyRequested &&
    memories.length < candidateMemoryLimit &&
    (!stopWhenEvidenceEnough || !convergenceBeforeHybrid.reached)
  );
  const allowReinforcementOnlyHybrid = anchorPlan !== null && hybridNeededBeforeAnchorTopUp;
  if (
    (memories.length < candidateMemoryLimit || allowReinforcementOnlyHybrid) &&
    (hybridNeededBeforeAnchorTopUp || hybridNeededAfterAnchorTopUp)
  ) {
    const hybridTrace = await fuseDirectMemorySearch({
      store: input.store,
      profileId,
      ...(asOf ? { asOf } : {}),
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
      ...(stopWhenEvidenceEnough
        ? { maxNewPaths: Math.max(4, targetMemoryCount - memories.length) }
        : {}),
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
    if (
      wideSupplyRequested &&
      memories.length < candidateMemoryLimit &&
      !stopWhenEvidenceEnough
    ) {
      const saturationTrace = await fuseDirectMemorySearch({
        store: input.store,
        profileId,
        ...(asOf ? { asOf } : {}),
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
        ...(stopWhenEvidenceEnough
          ? { maxNewPaths: Math.max(4, targetMemoryCount - memories.length) }
          : {}),
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
    ...(asOf ? { asOf } : {}),
    sweepCues: intent.sweepCues,
    recallPurpose,
    includeSensitive: input.request.includeSensitive,
    queryEmbedding: input.queryEmbedding,
    expandStructuredRoleSiblings: queryNeedsEntityAliasCandidates(publicQuery),
  });
  return composeReconstructedContext({
    profileId,
    query,
    displayQuery: publicQuery,
    memories,
    evidence: input.request.includeEvidence
      ? await evidenceForMemories(input.store, memories, publicQuery)
      : [],
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
    ...(asOf ? { asOf } : {}),
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
