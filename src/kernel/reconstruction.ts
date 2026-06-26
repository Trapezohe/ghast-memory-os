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
): ReconstructedEvidencePath {
  return {
    id: association.id,
    step,
    cue: association.cue,
    tag: association.tag,
    targetType: association.targetType,
    targetId: association.targetId,
    targetSummary: association.targetSummary,
    confidence: association.confidence,
    sourceMemoryId: association.sourceMemoryId,
    sourceEvidenceId: association.sourceEvidenceId,
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
    ...input.paths.map(
      (path) =>
        `- [step=${path.step}; cue=${path.cue}; tag=${path.tag}; confidence=${path.confidence.toFixed(2)}] ${path.targetSummary}`,
    ),
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
      ...paths.map(
        (path) =>
          `- [step=${path.step}; cue=${path.cue}; tag=${path.tag}; confidence=${path.confidence.toFixed(2)}] ${path.targetSummary}`,
      ),
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

  const frontier = extractAssociationCues(query, 12).map((cue) => cue.cue);
  if (frontier.length === 0) frontier.push(query);
  const explored = new Set<string>();
  const seenAssociationIds = new Set<string>();
  const seenMemoryIds = new Set<string>();
  const memories: MemoryRecord[] = [];
  const paths: ReconstructedEvidencePath[] = [];
  let associationCount = 0;
  let stopReason: ReconstructedContext["stats"]["stopReason"] = "no_frontier";

  for (let step = 1; step <= maxSteps; step += 1) {
    const cue = frontier.shift();
    if (!cue) break;
    if (explored.has(cue)) {
      step -= 1;
      continue;
    }
    explored.add(cue);
    const associations = await input.store.searchAssociations({
      profileId,
      query: cue,
      includeSensitive: input.request.includeSensitive,
      limit: maxBranch,
    });
    associationCount += associations.length;
    for (const association of associations) {
      if (seenAssociationIds.has(association.id)) continue;
      seenAssociationIds.add(association.id);
      paths.push(pathFromAssociation(association, step));
      const nextCues = extractAssociationCues(
        `${association.tag} ${association.targetSummary}`,
        8,
      );
      for (const nextCue of nextCues) {
        if (explored.has(nextCue.cue)) continue;
        const existingIndex = frontier.indexOf(nextCue.cue);
        if (existingIndex >= 0) frontier.splice(existingIndex, 1);
        if (nextCue.cueKind === "entity") frontier.unshift(nextCue.cue);
        else frontier.push(nextCue.cue);
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
    if (memories.length >= Math.min(3, maxMemories) && paths.length >= memories.length) {
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
