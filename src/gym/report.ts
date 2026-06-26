import type { MemoryGymResult } from "./types.js";
import type { MemoryScaleBenchmarkResult } from "./scale.js";
import type { HostCompatibilityGymResult } from "./host-compatibility.js";
import type { MemoryReleaseGateResult } from "./types.js";
import type { ExternalMemoryBenchmarkResult } from "./external.js";

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function markdownListCell(values: string[]): string {
  return values.length ? values.map(markdownCell).join(", ") : "-";
}

function markdownNullableNumber(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

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
    `Package: ${report.runManifest.package.name ?? "unknown"}@${report.runManifest.package.version ?? "unknown"}`,
    `Git: ${report.runManifest.git.branch ?? "unknown"} ${report.runManifest.git.sha ?? "unknown"} dirty=${report.runManifest.git.dirty ?? "unknown"}`,
    `SQLite schema: ${report.runManifest.sqliteSchemaVersion ?? "unknown"}`,
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
    "Scope: local SQLite prepareTurn and reconstructContext cost curve; not an external benchmark proof.",
    `Thresholds: prepareTurn p95 <= ${report.thresholds.prepareTurnP95Ms}ms; reconstructContext p95 <= ${report.thresholds.reconstructContextP95Ms}ms`,
    "",
    "| Memories | Seed ms | prepareTurn p50/p95/max ms | reconstructContext p50/p95/max ms | Prompt p95 tokens | Reconstructed p95 tokens | Reconstructed p95 paths |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.results.map(
      (row) =>
        `| ${row.size} | ${row.seedMs.toFixed(3)} | ${row.prepareTurn.p50Ms.toFixed(3)}/${row.prepareTurn.p95Ms.toFixed(3)}/${row.prepareTurn.maxMs.toFixed(3)} | ${row.reconstructContext.p50Ms.toFixed(3)}/${row.reconstructContext.p95Ms.toFixed(3)}/${row.reconstructContext.maxMs.toFixed(3)} | ${row.promptTokenEstimate.p95} | ${row.reconstructedTokenEstimate.p95} | ${row.reconstructedPathCount.p95} |`,
    ),
    "",
    "## Failed Operations",
    "",
    ...(report.failedOperations.length === 0
      ? ["None"]
      : report.failedOperations.map(
          (failure) =>
            `- size=${failure.size} operation=${failure.operation} p95=${failure.p95Ms.toFixed(3)}ms threshold=${failure.thresholdMs}ms`,
        )),
    "",
  ].join("\n");
}

export function renderExternalMemoryBenchmarkMarkdown(
  report: ExternalMemoryBenchmarkResult,
): string {
  return [
    "# gmOS External Long-Memory QA Benchmark",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `DatasetFormat: ${report.datasetFormat}`,
    `Cases: ${report.passedCount}/${report.caseCount}`,
    `Score: ${report.score.toFixed(4)}`,
    "",
    "| Case | Status | Mode | Failure reasons | Warnings | Missing expectedAny | Missing expectedAll | Forbidden matches | Convergence | Uncertainty | Tokens | Paths |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: |",
    ...report.cases.map(
      (entry) =>
        `| ${markdownCell(entry.id)} | ${entry.pass ? "PASS" : "FAIL"} | ${entry.mode}${entry.requireConvergence ? " + convergence" : ""} | ${markdownListCell(entry.failureReasons)} | ${markdownListCell(entry.warnings)} | ${markdownListCell(entry.expectedAnyMissing)} | ${markdownListCell(entry.expectedAllMissing)} | ${markdownListCell(entry.forbiddenMatches)} | ${markdownNullableNumber(entry.diagnostics.evidenceConvergenceScore)}${entry.diagnostics.evidenceConvergenceReached === null ? "" : entry.diagnostics.evidenceConvergenceReached ? " reached" : " not reached"} | ${entry.diagnostics.uncertaintyLevel ?? "-"} | ${entry.promptTokenEstimate} | ${entry.reconstructedPathCount} |`,
    ),
    "",
  ].join("\n");
}

export function renderHostCompatibilityGymMarkdown(
  report: HostCompatibilityGymResult,
): string {
  return [
    "# gmOS Host Compatibility Gym",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `Framework: ${report.framework}`,
    `Started: ${report.startedAt}`,
    `Node: ${report.node} ${report.platform}`,
    `Hosts: ${report.hostCount}`,
    `Unmatched actual reports: ${report.unmatchedActualReportHostIds.length ? report.unmatchedActualReportHostIds.join(", ") : "none"}`,
    "",
    "## Host Summary",
    "",
    "| Host | Mode | Level | Preset | Expected | Score | Memory-to-Action | Forget Residue | Agent Memory Use | Gaps |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
    ...report.hosts.map(
      (host) =>
        `| ${host.hostId} | ${host.verificationMode} | ${host.level} | ${host.presetLevel} | ${host.expectedLevel} | ${host.score.toFixed(2)} | ${host.memoryToAction} | ${host.forgetResidue} | ${host.agentMemoryUse} | ${host.gaps.length ? host.gaps.join(", ") : "none"} |`,
    ),
    "",
    "## Probe Results",
    "",
    "| Host | Area | Probe | Status | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...report.hosts.flatMap((host) =>
      host.probes.map(
        (probe) =>
          `| ${host.hostId} | ${probe.area} | ${probe.name} | ${probe.status} | ${probe.detail} |`,
      ),
    ),
    "",
    "## Failures",
    "",
    ...(report.failures.length === 0
      ? ["None"]
      : report.failures.map((failure) => `- ${failure}`)),
    "",
  ].join("\n");
}

export function renderMemoryReleaseGateMarkdown(
  report: MemoryReleaseGateResult,
): string {
  const scaleFailedOperations = report.components.scale.failedOperations ?? [];
  return [
    "# gmOS Release Gate Report",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `ReleaseConfidence: ${report.releaseConfidence}`,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    "",
    "## Inputs",
    "",
    `DB mode: ${report.inputs.dbPathMode}`,
    `Generated seeds: ${report.inputs.generatedSeeds}`,
    `Scale sizes: ${report.inputs.scaleSizes.join(", ")}`,
    `Scale threshold p95 ms: ${report.inputs.scaleThresholdP95Ms}`,
    `Hosts: ${report.inputs.hosts.join(", ")}`,
    `Actual host reports: ${report.inputs.actualHostReports}`,
    "",
    "## Components",
    "",
    "| Component | Status | Evidence |",
    "| --- | --- | --- |",
    `| Memory Gym | ${report.components.memoryGym.pass ? "PASS" : "FAIL"} | score=${report.components.memoryGym.score.toFixed(4)} hardGates=${report.components.memoryGym.hardGateCount} |`,
    `| Host Compatibility | ${report.components.hostCompatibility.pass ? "PASS" : "FAIL"} | hosts=${report.components.hostCompatibility.hostCount} |`,
    `| Scale | ${report.components.scale.pass ? "PASS" : "FAIL"} | sizes=${report.components.scale.sizes.join(", ")} threshold=${report.components.scale.thresholdP95Ms}ms failedOperations=${scaleFailedOperations.length} |`,
    `| Diagnostics | ${report.components.diagnostics.pass ? "PASS" : "FAIL"} | schema=${report.components.diagnostics.schemaVersion ?? "unknown"} plaintext SQLite encrypted=${report.components.diagnostics.encrypted ? "true" : "false"} |`,
    "",
    "## Failures",
    "",
    ...(report.pass
      ? ["None"]
      : [
          ...report.components.memoryGym.failedHardGates.map(
            (gate) => `- memory_gym:${gate}`,
          ),
          ...report.components.hostCompatibility.failedHosts.map(
            (host) => `- host_compatibility:${host}`,
          ),
          ...(scaleFailedOperations.length > 0
            ? scaleFailedOperations.map(
                (failure) =>
                  `- scale:${failure.size}:${failure.operation}:p95=${failure.p95Ms.toFixed(3)}ms threshold=${failure.thresholdMs}ms`,
              )
            : report.components.scale.failedSizes.map((size) => `- scale:${size}`)),
          ...(!report.components.diagnostics.pass ? ["- diagnostics"] : []),
        ]),
    "",
    "## Run Manifest",
    "",
    `Node: ${report.reports.memoryGym.runManifest.node} ${report.reports.memoryGym.runManifest.platform}`,
    `Package: ${report.reports.memoryGym.runManifest.package.name ?? "unknown"}@${report.reports.memoryGym.runManifest.package.version ?? "unknown"}`,
    `Git: ${report.reports.memoryGym.runManifest.git.branch ?? "unknown"} ${report.reports.memoryGym.runManifest.git.sha ?? "unknown"} dirty=${report.reports.memoryGym.runManifest.git.dirty ?? "unknown"}`,
    `SQLite schema: ${report.components.diagnostics.schemaVersion ?? "unknown"}`,
    "",
  ].join("\n");
}
