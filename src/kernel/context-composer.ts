import type { ActionPolicy, EvidenceEvent, MemoryRecord, PreparedTurn } from "./types.js";
import { sanitizeEvidenceForPublicOutput } from "./safety.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function composeTurnContext(input: {
  profileId: string;
  memories: MemoryRecord[];
  actionPolicies: ActionPolicy[];
  evidence: EvidenceEvent[];
  includeEvidence?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
}): PreparedTurn {
  const publicEvidence = input.includeEvidence
    ? input.evidence.map(sanitizeEvidenceForPublicOutput)
    : [];
  const directives = input.actionPolicies
    .filter((policy) => policy.kind === "do_not_push")
    .map((policy) => `Respect user boundary: ${policy.text}`);

  const lines = [
    "<gmos-context>",
    "User-world memory:",
    ...input.memories.map(
      (memory) =>
        `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.content}`,
    ),
    "Action policies:",
    ...input.actionPolicies.map(
      (policy) => `- [${policy.kind}; priority=${policy.priority}] ${policy.text}`,
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

  lines.push("</gmos-context>");
  let contextBlock = lines.join("\n");
  const budget = input.contextBudgetTokens ?? 1800;
  while (estimateTokens(contextBlock) > budget && input.memories.length > 0) {
    input.memories.pop();
    contextBlock = [
      "<gmos-context>",
      "User-world memory:",
      ...input.memories.map(
        (memory) =>
          `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.content}`,
      ),
      "Action policies:",
      ...input.actionPolicies.map(
        (policy) => `- [${policy.kind}; priority=${policy.priority}] ${policy.text}`,
      ),
      "</gmos-context>",
    ].join("\n");
  }

  return {
    profileId: input.profileId,
    contextBlock,
    memories: input.memories,
    actionPolicies: input.actionPolicies,
    directives,
    evidence: publicEvidence,
    stats: {
      retrievedMemoryCount: input.memories.length,
      actionPolicyCount: input.actionPolicies.length,
      promptTokenEstimate: estimateTokens(contextBlock),
    },
  };
}
