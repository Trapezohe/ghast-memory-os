export interface HostCompatibilityReport {
  hostId: string;
  level: "L0" | "L1" | "L2" | "L3" | "L4";
  capabilityRetention: string;
  gaps: string[];
}

export function classifyHostCompatibility(input: {
  hostId: string;
  canObserve?: boolean;
  canInjectContext?: boolean;
  canCommitOutcome?: boolean;
  canRecordFeedback?: boolean;
  canEnforceDirectives?: boolean;
}): HostCompatibilityReport {
  const score = [
    input.canObserve,
    input.canInjectContext,
    input.canCommitOutcome,
    input.canRecordFeedback,
    input.canEnforceDirectives,
  ].filter(Boolean).length;
  const level = score >= 5 ? "L4" : score >= 4 ? "L3" : score >= 3 ? "L2" : score >= 1 ? "L1" : "L0";
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
  const gaps = [
    !input.canObserve && "observe",
    !input.canInjectContext && "context injection",
    !input.canCommitOutcome && "outcome commit",
    !input.canRecordFeedback && "feedback",
    !input.canEnforceDirectives && "directive enforcement",
  ].filter((gap): gap is string => Boolean(gap));
  return { hostId: input.hostId, level, capabilityRetention, gaps };
}

