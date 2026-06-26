import { extractAssociationCues } from "./associations.js";
import { sanitizeEvidenceForPublicOutput } from "./safety.js";
import type {
  EvidenceEvent,
  MemoryAssociationRecord,
  MemoryRecord,
  MemoryStore,
  ReconstructedContext,
  ReconstructedEvidencePath,
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
  };
}

function formatPathLine(path: ReconstructedEvidencePath): string {
  const routeScore = path.routeScore !== undefined ? `; routeScore=${path.routeScore.toFixed(2)}` : "";
  const routeReason = path.routeReason ? `; reason=${path.routeReason}` : "";
  return `- [step=${path.step}; cue=${path.cue}; tag=${path.tag}; kind=${path.targetKind ?? path.targetType}; confidence=${path.confidence.toFixed(2)}${routeScore}${routeReason}] ${path.targetSummary}`;
}

interface ReconstructionIntent {
  expectedTags: Set<string>;
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

function inferReconstructionIntent(query: string): ReconstructionIntent {
  const expectedTags = new Set<string>();
  const reasons: string[] = [];
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
    for (const tag of ["procedure", "task_trajectory", "project.state", "world_belief"]) {
      expectedTags.add(tag);
    }
    reasons.push("procedure_or_next_step");
  }
  if (includesAny(query, ["当前", "现在", "状态", "current", "state", "status"])) {
    for (const tag of ["project.state", "world_belief", "project", "task_trajectory"]) {
      expectedTags.add(tag);
    }
    reasons.push("current_state");
  }
  if (includesAny(query, ["不要", "不能", "边界", "boundary", "avoid", "do not", "don't"])) {
    for (const tag of ["boundary", "do_not_push"]) {
      expectedTags.add(tag);
    }
    reasons.push("boundary");
  }
  if (includesAny(query, ["偏好", "喜欢", "习惯", "preference", "prefer"])) {
    expectedTags.add("preference");
    reasons.push("preference");
  }
  return {
    expectedTags,
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

function pathMatchesIntent(path: ReconstructedEvidencePath, intent: ReconstructionIntent): boolean {
  return (
    intent.expectedTags.has(path.tag) ||
    (path.targetKind !== undefined && intent.expectedTags.has(path.targetKind)) ||
    (path.targetKind !== undefined && intent.expectedTags.has(`${path.targetKind}.${path.tag}`))
  );
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

function composeReconstructedContext(input: {
  profileId: string;
  query: string;
  memories: MemoryRecord[];
  evidence: EvidenceEvent[];
  paths: ReconstructedEvidencePath[];
  includeEvidence?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  stepCount: number;
  exploredCueCount: number;
  associationCount: number;
  stopReason: ReconstructedContext["stats"]["stopReason"];
}): ReconstructedContext {
  const publicEvidence = input.includeEvidence
    ? input.evidence.map(sanitizeEvidenceForPublicOutput)
    : [];
  const lines = [
    "<gmos-reconstructed-context>",
    `Query: ${input.query}`,
    "Reconstructed evidence paths:",
    ...input.paths.map(formatPathLine),
    "Memory content:",
    ...input.memories.map(
      (memory) =>
        `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.content}`,
    ),
  ];
  if (input.includeEvidence) {
    lines.push("Evidence:");
    lines.push(
      ...publicEvidence.map(
        (event) =>
          `- [${event.sourceType}; ${event.sensitivity}; eligible=${event.eligibleForLongTermMemory}] ${event.content}`,
      ),
    );
  }
  lines.push("</gmos-reconstructed-context>");

  let memories = [...input.memories];
  let paths = [...input.paths];
  let evidence = [...publicEvidence];
  let contextBlock = lines.join("\n");
  const budget = input.contextBudgetTokens ?? 1800;
  while (estimateTokens(contextBlock) > budget && (memories.length > 0 || paths.length > 0)) {
    if (memories.length > 0) memories = memories.slice(0, -1);
    else paths = paths.slice(0, -1);
    const budgetedLines = [
      "<gmos-reconstructed-context>",
      `Query: ${input.query}`,
      "Reconstructed evidence paths:",
      ...paths.map(formatPathLine),
      "Memory content:",
      ...memories.map(
        (memory) =>
          `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.content}`,
      ),
      "</gmos-reconstructed-context>",
    ];
    contextBlock = budgetedLines.join("\n");
    evidence = [];
  }

  return {
    profileId: input.profileId,
    query: input.query,
    contextBlock,
    memories,
    evidence,
    paths,
    stats: {
      stepCount: input.stepCount,
      exploredCueCount: input.exploredCueCount,
      associationCount: input.associationCount,
      retrievedMemoryCount: memories.length,
      promptTokenEstimate: estimateTokens(contextBlock),
      stopReason: input.stopReason,
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
    cue: input.query,
    tag: memory.kind,
    targetType: "memory" as const,
    targetId: memory.id,
    targetKind: memory.kind,
    targetSummary: memory.content,
    confidence: memory.confidence,
    sourceMemoryId: memory.id,
    sourceEvidenceId: memory.sourceEventId,
  }));
  return composeReconstructedContext({
    profileId: input.profileId,
    query: input.query,
    memories,
    evidence: input.includeEvidence ? await evidenceForMemories(input.store, memories) : [],
    paths,
    includeEvidence: input.includeEvidence,
    contextBudgetTokens: input.contextBudgetTokens,
    stepCount: memories.length > 0 ? 1 : 0,
    exploredCueCount: 1,
    associationCount: paths.length,
    stopReason: memories.length > 0 ? "evidence_sufficient" : "no_frontier",
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
  if (!input.store.searchAssociations) {
    return fallbackReconstruction({
      store: input.store,
      profileId,
      query,
      includeEvidence: input.request.includeEvidence,
      includeSensitive: input.request.includeSensitive,
      contextBudgetTokens: input.request.contextBudgetTokens,
      maxMemories,
    });
  }

  const intent = inferReconstructionIntent(query);
  const frontier = seedFrontier(query, intent);
  const explored = new Set<string>();
  const seenAssociationIds = new Set<string>();
  const seenMemoryIds = new Set<string>();
  const memories: MemoryRecord[] = [];
  const paths: ReconstructedEvidencePath[] = [];
  let associationCount = 0;
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
    const rankedAssociations = associations
      .filter((association) => !seenAssociationIds.has(association.id))
      .map((association) => rankAssociation(association, cue, intent))
      .sort((a, b) => b.routeScore - a.routeScore)
      .slice(0, maxBranch);
    for (const ranked of rankedAssociations) {
      const { association } = ranked;
      if (seenAssociationIds.has(association.id)) continue;
      seenAssociationIds.add(association.id);
      paths.push(pathFromAssociation(association, step, ranked.routeScore, ranked.routeReason));
      const nextCues = extractAssociationCues(
        `${association.tag} ${association.targetSummary}`,
        8,
      );
      for (const nextCue of nextCues) {
        if (explored.has(nextCue.cue)) continue;
        enqueueFrontierCue(frontier, {
          cue: nextCue.cue,
          priority: ranked.routeScore * 0.7 + (nextCue.cueKind === "entity" ? 4 : 0),
          reason: `from:${association.tag}`,
        });
      }
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
    if (stopReason === "evidence_sufficient") break;
    const hasIntentEvidence =
      intent.expectedTags.size === 0 || paths.some((path) => pathMatchesIntent(path, intent));
    if (
      memories.length >= Math.min(3, maxMemories) &&
      paths.length >= memories.length &&
      hasIntentEvidence
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

  return composeReconstructedContext({
    profileId,
    query,
    memories,
    evidence: input.request.includeEvidence ? await evidenceForMemories(input.store, memories) : [],
    paths,
    includeEvidence: input.request.includeEvidence,
    contextBudgetTokens: input.request.contextBudgetTokens,
    stepCount: paths.length === 0 ? 0 : Math.max(...paths.map((path) => path.step)),
    exploredCueCount: explored.size,
    associationCount,
    stopReason,
  });
}
