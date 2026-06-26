import type {
  EvidencePathExplanation,
  ReconstructedContext,
  ReconstructedPlannerTrace,
} from "./types.js";

export function buildEvidencePathExplanation(input: {
  reconstructed: ReconstructedContext;
  includePlannerTrace?: boolean | undefined;
}): EvidencePathExplanation {
  const { reconstructed } = input;
  const convergence = reconstructed.stats.evidenceConvergence;
  const uncertainty = reconstructed.stats.uncertainty;
  const plannerTrace: ReconstructedPlannerTrace | undefined = input.includePlannerTrace
    ? reconstructed.plannerTrace
    : undefined;
  return {
    schema: "gmos.evidence_path_explanation.v1",
    profileId: reconstructed.profileId,
    query: reconstructed.query,
    summary: {
      pathCount: reconstructed.paths.length,
      evidenceCount: reconstructed.evidence.length,
      memoryCount: reconstructed.memories.length,
      stopReason: reconstructed.stats.stopReason,
      convergenceReached: convergence?.reached ?? false,
      uncertaintyLevel: uncertainty?.level ?? null,
    },
    paths: reconstructed.paths,
    evidence: reconstructed.evidence,
    stats: {
      evidenceCoverage: reconstructed.stats.evidenceCoverage,
      evidenceConvergence: convergence,
      uncertainty,
      promptTokenEstimate: reconstructed.stats.promptTokenEstimate,
      stepCount: reconstructed.stats.stepCount,
      exploredCueCount: reconstructed.stats.exploredCueCount,
      associationCount: reconstructed.stats.associationCount,
    },
    ...(plannerTrace ? { plannerTrace } : {}),
  };
}
