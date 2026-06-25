export type HostCompatibilityLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type HostPreset = "ghast" | "mcp" | "search_only" | "mock_l3";
export {
  loadHostMemorySnapshotsIntoStore,
  normalizeHostMemoryKind,
  normalizeHostMemorySensitivity,
  syncHostMemorySnapshotsIntoStore,
} from "./snapshot-import.js";
export type {
  HostMemorySnapshot,
  HostMemorySnapshotImportInput,
  HostMemorySnapshotImportReport,
  HostMemorySnapshotSkip,
  HostMemorySnapshotSyncReport,
} from "./snapshot-import.js";

export interface HostCapabilities {
  canObserveConversation: boolean;
  canObserveToolCalls: boolean;
  canInjectSystemContext: boolean;
  canEnforceHardDirectives: boolean;
  canCommitTaskOutcomes: boolean;
  canRecordUserFeedback: boolean;
  canForget: boolean;
  supportsPrivateMode: boolean;
  supportsActionPolicies: boolean;
  supportsEvidenceInContext: boolean;
}

export interface HostAdapter {
  hostId: string;
  displayName?: string | undefined;
  capabilities: HostCapabilities;
  compatibility: HostCompatibilityReport;
}

export interface HostCompatibilityReport {
  hostId: string;
  level: HostCompatibilityLevel;
  capabilityRetention: string;
  score: number;
  gaps: string[];
  hardGateCoverage: Record<string, boolean>;
}

export interface HostActualCompatibilityReport {
  hostId: string;
  level: HostCompatibilityLevel;
  targetLevel?: HostCompatibilityLevel | undefined;
  canClaimTargetLevel?: boolean | undefined;
  blockingGaps?: string[] | undefined;
  contextOwnership?: string | undefined;
  candidateRetrievalOwnership?: string | undefined;
  storageOwnership?: string | undefined;
  mutationOwnership?: string | undefined;
}

export function classifyHostCompatibility(input: {
  hostId: string;
  capabilities?: Partial<HostCapabilities> | undefined;
  canObserve?: boolean;
  canInjectContext?: boolean;
  canCommitOutcome?: boolean;
  canRecordFeedback?: boolean;
  canEnforceDirectives?: boolean;
}): HostCompatibilityReport {
  const capabilities = normalizeCapabilities(input);
  const score = capabilityScore(capabilities);
  const level = compatibilityLevel(capabilities, score);
  const capabilityRetention =
    level === "L4"
      ? "95%+"
      : level === "L3"
        ? "85%-95%"
        : level === "L2"
          ? "55%-85%"
          : level === "L1"
            ? "20%-55%"
            : "0%-20%";
  return {
    hostId: input.hostId,
    level,
    capabilityRetention,
    score,
    gaps: capabilityGaps(capabilities),
    hardGateCoverage: hardGateCoverage(capabilities),
  };
}

export function createHostAdapter(input: {
  hostId: string;
  displayName?: string | undefined;
  capabilities: Partial<HostCapabilities>;
}): HostAdapter {
  const capabilities = normalizeCapabilities({
    capabilities: input.capabilities,
  });
  return {
    hostId: input.hostId,
    displayName: input.displayName,
    capabilities,
    compatibility: classifyHostCompatibility({
      hostId: input.hostId,
      capabilities,
    }),
  };
}

export function createPresetHostAdapter(
  preset: HostPreset,
): HostAdapter {
  if (preset === "ghast") {
    return createHostAdapter({
      hostId: "ghast",
      displayName: "Ghast Desktop",
      capabilities: {
        canObserveConversation: true,
        canObserveToolCalls: true,
        canInjectSystemContext: true,
        canEnforceHardDirectives: true,
        canCommitTaskOutcomes: true,
        canRecordUserFeedback: true,
        canForget: true,
        supportsPrivateMode: true,
        supportsActionPolicies: true,
        supportsEvidenceInContext: true,
      },
    });
  }
  if (preset === "mock_l3") {
    return createHostAdapter({
      hostId: "mock_l3",
      displayName: "Mock L3 Host",
      capabilities: {
        canObserveConversation: true,
        canInjectSystemContext: true,
        canEnforceHardDirectives: true,
        canCommitTaskOutcomes: true,
        canRecordUserFeedback: true,
        canForget: true,
        supportsPrivateMode: true,
      },
    });
  }
  if (preset === "mcp") {
    return createHostAdapter({
      hostId: "mcp",
      displayName: "MCP Host",
      capabilities: {
        canObserveConversation: true,
        canInjectSystemContext: true,
        canRecordUserFeedback: true,
        canForget: true,
      },
    });
  }
  return createHostAdapter({
    hostId: "search_only",
    displayName: "Search-only Host",
    capabilities: {
      canInjectSystemContext: true,
    },
  });
}

function normalizeCapabilities(input: {
  capabilities?: Partial<HostCapabilities> | undefined;
  canObserve?: boolean | undefined;
  canInjectContext?: boolean | undefined;
  canCommitOutcome?: boolean | undefined;
  canRecordFeedback?: boolean | undefined;
  canEnforceDirectives?: boolean | undefined;
}): HostCapabilities {
  const capabilities = input.capabilities ?? {};
  return {
    canObserveConversation:
      capabilities.canObserveConversation ?? Boolean(input.canObserve),
    canObserveToolCalls: capabilities.canObserveToolCalls ?? false,
    canInjectSystemContext:
      capabilities.canInjectSystemContext ?? Boolean(input.canInjectContext),
    canEnforceHardDirectives:
      capabilities.canEnforceHardDirectives ??
      Boolean(input.canEnforceDirectives),
    canCommitTaskOutcomes:
      capabilities.canCommitTaskOutcomes ?? Boolean(input.canCommitOutcome),
    canRecordUserFeedback:
      capabilities.canRecordUserFeedback ?? Boolean(input.canRecordFeedback),
    canForget: capabilities.canForget ?? false,
    supportsPrivateMode: capabilities.supportsPrivateMode ?? false,
    supportsActionPolicies: capabilities.supportsActionPolicies ?? false,
    supportsEvidenceInContext: capabilities.supportsEvidenceInContext ?? false,
  };
}

function capabilityScore(capabilities: HostCapabilities): number {
  const values = Object.values(capabilities);
  return values.filter(Boolean).length / values.length;
}

function compatibilityLevel(
  capabilities: HostCapabilities,
  score: number,
): HostCompatibilityLevel {
  if (
    score === 1 &&
    capabilities.canInjectSystemContext &&
    capabilities.canEnforceHardDirectives &&
    capabilities.supportsPrivateMode &&
    capabilities.canForget
  ) {
    return "L4";
  }
  if (
    capabilities.canObserveConversation &&
    capabilities.canInjectSystemContext &&
    capabilities.canEnforceHardDirectives &&
    score >= 0.7
  ) {
    return "L3";
  }
  if (
    capabilities.canObserveConversation &&
    capabilities.canInjectSystemContext &&
    score >= 0.4
  ) {
    return "L2";
  }
  if (score > 0) return "L1";
  return "L0";
}

function capabilityGaps(capabilities: HostCapabilities): string[] {
  const labels: Array<[keyof HostCapabilities, string]> = [
    ["canObserveConversation", "conversation observation"],
    ["canObserveToolCalls", "tool observation"],
    ["canInjectSystemContext", "system context injection"],
    ["canEnforceHardDirectives", "hard directive enforcement"],
    ["canCommitTaskOutcomes", "task outcome commit"],
    ["canRecordUserFeedback", "user feedback"],
    ["canForget", "forget/delete"],
    ["supportsPrivateMode", "private/incognito mode"],
    ["supportsActionPolicies", "action policies"],
    ["supportsEvidenceInContext", "evidence-aware context"],
  ];
  return labels
    .filter(([key]) => !capabilities[key])
    .map(([, label]) => label);
}

function hardGateCoverage(
  capabilities: HostCapabilities,
): Record<string, boolean> {
  return {
    personIsolation: capabilities.canObserveConversation,
    secretLikePersistence: capabilities.canObserveConversation,
    incognitoLeakage: capabilities.supportsPrivateMode,
    forgetCompliance: capabilities.canForget,
    doNotPushPriority:
      capabilities.supportsActionPolicies &&
      capabilities.canEnforceHardDirectives,
    sensitiveEvidenceExposure:
      capabilities.supportsEvidenceInContext &&
      capabilities.canInjectSystemContext,
    readPathSideEffects: true,
    taskOutcomeFeedback:
      capabilities.canCommitTaskOutcomes && capabilities.canRecordUserFeedback,
  };
}
