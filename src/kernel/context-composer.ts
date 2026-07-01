import type { ActionPolicy, EvidenceEvent, MemoryRecord, PreparedTurn } from "./types.js";
import { safePublicLabel, sanitizeEvidenceForPublicOutput } from "./safety.js";

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
  const memories = input.memories.map((memory) => ({
    ...memory,
    kind: safePublicLabel(memory.kind) as MemoryRecord["kind"],
  }));
  const actionPolicies = input.actionPolicies.map((policy) => ({
    ...policy,
    kind: safePublicLabel(policy.kind) as ActionPolicy["kind"],
  }));
  const publicEvidence = input.includeEvidence
    ? input.evidence.map(sanitizeEvidenceForPublicOutput)
    : [];
  const directives = actionPolicies
    .filter((policy) => policy.kind === "do_not_push")
    .map((policy) => `Respect user boundary: ${policy.text}`);

  const lines = [
    "<gmos-context>",
    "User-world memory:",
    ...memories.map(
      (memory) =>
        `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.content}`,
    ),
    "Action policies:",
    ...actionPolicies.map(
      (policy) => `- [${policy.kind}; priority=${policy.priority}] ${policy.text}`,
    ),
  ];

  if (input.includeEvidence) {
    lines.push("Evidence:");
    lines.push(
      ...publicEvidence.map(
        (event) =>
          `- [${safePublicLabel(event.sourceType)}; ${event.sensitivity}; eligible=${event.eligibleForLongTermMemory}] ${event.content}`,
      ),
    );
  }

  lines.push("</gmos-context>");
  let contextBlock = lines.join("\n");
  const budget = input.contextBudgetTokens ?? 1800;
  while (estimateTokens(contextBlock) > budget && memories.length > 0) {
    memories.pop();
    contextBlock = [
      "<gmos-context>",
      "User-world memory:",
      ...memories.map(
        (memory) =>
          `- [${memory.kind}; confidence=${memory.confidence.toFixed(2)}] ${memory.content}`,
      ),
      "Action policies:",
      ...actionPolicies.map(
        (policy) => `- [${policy.kind}; priority=${policy.priority}] ${policy.text}`,
      ),
      "</gmos-context>",
    ].join("\n");
  }

  return {
    profileId: input.profileId,
    contextBlock,
    memories,
    actionPolicies,
    directives,
    evidence: publicEvidence,
    stats: {
      retrievedMemoryCount: memories.length,
      actionPolicyCount: actionPolicies.length,
      promptTokenEstimate: estimateTokens(contextBlock),
    },
  };
}
