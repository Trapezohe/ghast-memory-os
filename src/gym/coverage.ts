import type {
  MemoryGymCoverageRow,
  MemoryGymResult,
  MemoryGymRoadmapResult,
  MemoryGymStatus,
} from "./types.js";

export function roadmap(result: MemoryGymResult): MemoryGymRoadmapResult {
  const suggestions = result.gateResults
    .filter((entry) => !entry.passed)
    .map((entry) => `Fix ${entry.layer}: ${entry.name}`);
  return {
    status: suggestions.length === 0 ? "clear" : "action_required",
    suggestions,
  };
}

function statusFor(passed: boolean): MemoryGymStatus {
  return passed ? "pass" : "fail";
}

function layerPass(result: MemoryGymResult, layer: string): boolean {
  const entries = result.gateResults.filter((entry) => entry.layer === layer);
  return entries.length > 0 && entries.every((entry) => entry.passed);
}

export function coverageMatrix(result: MemoryGymResult): MemoryGymCoverageRow[] {
  return [
    {
      layer: "Integrity Governance",
      status: statusFor(result.scenarios.every((entry) => entry.pass)),
      evidence: `scenarioCount=${result.scenarios.length}; failedScenarios=${result.scenarios.filter((entry) => !entry.pass).length}`,
    },
    {
      layer: "Layer 0: P0 Policy Gates",
      status: statusFor(result.pass),
      evidence: `hardGateCount=${Object.keys(result.hardGates).length}; score=${result.score.toFixed(4)}`,
    },
    {
      layer: "Layer 1: SDK Runtime Probe",
      status: statusFor(layerPass(result, "runtime")),
      evidence: "preference recall uses MemoryOS.observe and MemoryOS.prepareTurn",
    },
    {
      layer: "Layer 2: MCP / Host Boundary",
      status: statusFor(layerPass(result, "mcp_host")),
      evidence: "public MCP prepare_context rejects includeSensitive; host compatibility is explicit",
    },
    {
      layer: "Layer 3: Architecture Conformance",
      status: statusFor(layerPass(result, "architecture")),
      evidence: "read path side effects and evidence idempotency are deterministic hard gates",
    },
    {
      layer: "Layer 4: Context / Action",
      status: statusFor(layerPass(result, "context_action")),
      evidence: "do_not_push boundary becomes action directive",
    },
    {
      layer: "Layer 4R: Active Reconstruction",
      status: statusFor(layerPass(result, "reconstruction")),
      evidence: "bounded cue-tag-content reconstruction is exercised in shadow mode",
    },
    {
      layer: "Layer 5: Generalization",
      status: result.generalizationResult.status,
      evidence: `holdout=${result.generalizationResult.holdoutScore.toFixed(2)}; generatedMean=${result.generalizationResult.generatedMean.toFixed(2)}; gap=${result.generalizationResult.generalizationGap.toFixed(2)}`,
    },
    {
      layer: "Layer 6: Safety",
      status: statusFor(layerPass(result, "safety")),
      evidence: "secret-like, sensitive, incognito, and forget gates passed",
    },
    {
      layer: "Layer 7: Feedback Loop",
      status: statusFor(layerPass(result, "feedback")),
      evidence: "recordFeedback writes failure log",
    },
  ];
}

export function memoryStackCoverage(result: MemoryGymResult): MemoryGymCoverageRow[] {
  return [
    {
      layer: "Storage",
      status: statusFor(
        Boolean(result.hardGates.evidence_idempotency && result.hardGates.read_path_side_effects),
      ),
      evidence: "SQLite evidence, memory, failure, and trajectory tables are exercised by the gym",
    },
    {
      layer: "Extraction / Update",
      status: statusFor(
        Boolean(
          result.hardGates.preference_recall &&
            result.hardGates.holdout_preference_recall &&
            result.hardGates.world_belief_single_cardinality_supersession,
        ),
      ),
      evidence:
        "preference extraction, generated preference recall, and single-cardinality world belief supersession are exercised",
    },
    {
      layer: "Controller / Context",
      status: statusFor(Boolean(result.hardGates.do_not_push_policy)),
      evidence: "prepareTurn materializes action directives from boundary memory",
    },
    {
      layer: "Reconstructive Recall",
      status: statusFor(
        Boolean(
          result.hardGates.active_reconstruction_multihop &&
            result.hardGates.active_reconstruction_intent_rerank &&
            result.hardGates.reconstruction_read_path_side_effects &&
            result.hardGates.prepare_turn_reconstruction_shadow &&
            result.hardGates.world_belief_single_cardinality_supersession &&
            result.hardGates.temporal_validity_window_context_filter,
        ),
      ),
      evidence:
        "reconstructContext follows association paths, reranks noisy branches by intent, respects current world belief and temporal validity state, and does not replace main context",
    },
    {
      layer: "MCP / Host",
      status: statusFor(
        Boolean(result.hardGates.mcp_public_sensitive_rejection && result.hardGates.host_adapter_contract),
      ),
      evidence: "public MCP sensitive override is rejected; compatibility level is bounded",
    },
    {
      layer: "Safety / Privacy",
      status: statusFor(
        Boolean(
          result.hardGates.secret_like_persistence &&
            result.hardGates.sensitive_action_policy_exposure &&
            result.hardGates.incognito_leakage &&
            result.hardGates.forget_compliance,
        ),
      ),
      evidence: "secret-like, sensitive, incognito, and forget behavior are hard gates",
    },
    {
      layer: "Feedback / Evolution",
      status: statusFor(Boolean(result.hardGates.feedback_failure_log)),
      evidence: "feedback enters failure log; self-evolution remains outside SDK alpha scope",
    },
  ];
}
