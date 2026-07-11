import type { ActionPolicy, EvidenceEvent, MemoryRecord, PreparedTurn } from "./types.js";
import { safePublicLabel } from "./safety.js";
import {
  bindReaderMemorySources,
  carryReaderMemorySource,
  createReaderSourceBindings,
  readerEvidenceSurfaceText,
  readerMemorySurfaceText,
  sanitizeReaderEvidenceForPublicOutput,
} from "./reader-evidence.js";
import { temporalContextSegment } from "./temporal-format.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function composeTurnContext(input: {
  profileId: string;
  memories: MemoryRecord[];
  actionPolicies: ActionPolicy[];
  evidence: EvidenceEvent[];
  includeEvidence?: boolean | undefined;
  includeTemporalContext?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
}): PreparedTurn {
  if (input.evidence.length > 0) bindReaderMemorySources(input.memories, input.evidence);
  const memories = input.memories.map((memory) =>
    carryReaderMemorySource(memory, {
      ...memory,
      kind: safePublicLabel(memory.kind) as MemoryRecord["kind"],
    })
  );
  const actionPolicies = input.actionPolicies.map((policy) => ({
    ...policy,
    kind: safePublicLabel(policy.kind) as ActionPolicy["kind"],
  }));
  const publicEvidence = input.includeEvidence
    ? input.evidence.map((event) => sanitizeReaderEvidenceForPublicOutput(event))
    : [];
  let evidence = [...publicEvidence];
  const directives = actionPolicies
    .filter((policy) => policy.kind === "do_not_push")
    .map((policy) => `Respect user boundary: ${policy.text}`);
  const includeTemporalContext = input.includeTemporalContext !== false;

  const render = (): string => {
    const sourceBindings = createReaderSourceBindings(memories);
    const lines = [
      "<gmos-context>",
      "User-world memory:",
      ...memories.map((memory) =>
        `- [${memory.kind}${includeTemporalContext ? temporalContextSegment(memory.createdAt, memory.metadata) : ""}; confidence=${memory.confidence.toFixed(2)}] ${readerMemorySurfaceText(memory, { bindings: sourceBindings })}`
      ),
      "Action policies:",
      ...actionPolicies.map(
        (policy) => `- [${policy.kind}; priority=${policy.priority}] ${policy.text}`,
      ),
    ];
    if (input.includeEvidence) {
      lines.push("Evidence:");
      lines.push(
        ...evidence.map(
          (event) =>
            `- [${safePublicLabel(event.sourceType)}; ${event.sensitivity}; eligible=${event.eligibleForLongTermMemory}] ${readerEvidenceSurfaceText(event, sourceBindings)}`,
        ),
      );
    }
    lines.push("</gmos-context>");
    return lines.join("\n");
  };
  let contextBlock = render();
  const budget = input.contextBudgetTokens ?? 1800;
  if (estimateTokens(contextBlock) > budget && evidence.length > 0) {
    const rankedEvidence = [...evidence];
    let lower = 0;
    let upper = rankedEvidence.length;
    while (lower < upper) {
      const candidateCount = Math.ceil((lower + upper) / 2);
      evidence = rankedEvidence.slice(0, candidateCount);
      if (estimateTokens(render()) <= budget) lower = candidateCount;
      else upper = candidateCount - 1;
    }
    evidence = rankedEvidence.slice(0, lower);
    contextBlock = render();
  }
  while (estimateTokens(contextBlock) > budget && memories.length > 0) {
    memories.pop();
    contextBlock = render();
  }

  return {
    profileId: input.profileId,
    contextBlock,
    memories,
    actionPolicies,
    directives,
    evidence,
    stats: {
      retrievedMemoryCount: memories.length,
      actionPolicyCount: actionPolicies.length,
      promptTokenEstimate: estimateTokens(contextBlock),
    },
  };
}
