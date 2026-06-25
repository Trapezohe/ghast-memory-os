import type { MemoryGymResult } from "./types.js";
import type { MemoryScaleBenchmarkResult } from "./scale.js";

export function renderMemoryGymMarkdown(report: MemoryGymResult): string {
  return [
    "# gmOS Memory Gym Report",
    "",
    `Framework: ${report.framework}`,
    `DeterministicArchitectureResult: ${report.deterministicArchitectureResult.status} score=${report.deterministicArchitectureResult.score?.toFixed(4) ?? "not_run"} gate=${report.deterministicArchitectureResult.gate}`,
    `AgentMemoryUseResult: ${report.agentMemoryUseResult.status} score=${report.agentMemoryUseResult.score?.toFixed(4) ?? "not_run"} gate=${report.agentMemoryUseResult.gate}`,
    `GeneralizationResult: ${report.generalizationResult.status} gap=${report.generalizationResult.generalizationGap.toFixed(4)}`,
    `RoadmapResult: ${report.roadmapResult.status} suggestions=${report.roadmapResult.suggestions.length}`,
    `Stage5ReadinessView: ${report.stage5ReadinessView.toFixed(4)} (Maturity lens only; not proof of mature digital-twin capability.)`,
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `Score: ${report.score.toFixed(4)}`,
    `ReleaseConfidence: ${report.releaseConfidence}`,
    "",
    "## Hard Gates",
    ...report.gateResults.map((entry) => `- ${entry.name}: ${entry.passed ? "PASS" : "FAIL"} (${entry.layer})`),
    "",
    "## Generalization",
    "",
    `Dev score: ${report.generalizationResult.devScore.toFixed(2)}`,
    `Holdout score: ${report.generalizationResult.holdoutScore.toFixed(2)}`,
    `Generated mean: ${report.generalizationResult.generatedMean.toFixed(2)}`,
    `Generated std: ${report.generalizationResult.generatedStd.toFixed(2)}`,
    `Generated seeds: ${report.generalizationResult.generatedSeedCount}`,
    `Adversarial score: ${report.generalizationResult.adversarialScore.toFixed(2)}`,
    `Generalization gap: ${report.generalizationResult.generalizationGap.toFixed(2)}`,
    "",
    "## Coverage Matrix",
    "",
    "| Layer | Status | Evidence |",
    "| --- | --- | --- |",
    ...report.coverageMatrix.map((row) => `| ${row.layer} | ${row.status} | ${row.evidence} |`),
    "",
    "## Memory Stack Coverage",
    "",
    "| Memory Stack Layer | Status | Evidence |",
    "| --- | --- | --- |",
    ...report.memoryStackCoverage.map((row) => `| ${row.layer} | ${row.status} | ${row.evidence} |`),
    "",
    "## Run Manifest",
    "",
    `Started: ${report.runManifest.startedAt}`,
    `Node: ${report.runManifest.node} ${report.runManifest.platform}`,
    `DB: ${report.runManifest.dbPathMode}`,
    `Generated seeds: ${report.runManifest.generatedSeeds.join(", ") || "none"}`,
    `Deterministic only: ${report.runManifest.deterministicOnly ? "yes" : "no"}`,
    "",
    "## Roadmap Suggestions",
    "",
    ...(report.roadmapResult.suggestions.length === 0
      ? ["None"]
      : report.roadmapResult.suggestions.map((suggestion) => `- ${suggestion}`)),
    "",
    "## Details",
    ...report.details.map((detail) => `- ${detail}`),
    "",
  ].join("\n");
}

export function renderMemoryScaleMarkdown(report: MemoryScaleBenchmarkResult): string {
  return [
    "# gmOS Memory Scale Benchmark",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    "Scope: local SQLite prepareTurn cost curve; not an external benchmark proof.",
    "",
    "| Memories | Seed ms | prepareTurn p50/p95/max ms | Prompt p95 tokens |",
    "| ---: | ---: | ---: | ---: |",
    ...report.results.map(
      (row) =>
        `| ${row.size} | ${row.seedMs.toFixed(3)} | ${row.prepareTurn.p50Ms.toFixed(3)}/${row.prepareTurn.p95Ms.toFixed(3)}/${row.prepareTurn.maxMs.toFixed(3)} | ${row.promptTokenEstimate.p95} |`,
    ),
    "",
  ].join("\n");
}
