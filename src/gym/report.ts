import type { MemoryGymResult } from "./types.js";
import type { MemoryScaleBenchmarkResult } from "./scale.js";
import type { HostCompatibilityGymResult } from "./host-compatibility.js";
import type { MemoryReleaseGateResult } from "./types.js";
import type { ExternalMemoryBenchmarkResult } from "./external.js";
import type { ExternalMemoryBenchmarkSuiteResult } from "./external-suite.js";

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function markdownListCell(values: string[]): string {
  return values.length ? values.map(markdownCell).join(", ") : "-";
}

function markdownTaxonomyCell(values: Array<{ stage: string; terms?: string[] | undefined }>): string {
  if (values.length === 0) return "-";
  return values
    .map((entry) => {
      const terms = entry.terms?.length ? ` (${entry.terms.join(", ")})` : "";
      return markdownCell(`${entry.stage}${terms}`);
    })
    .join(", ");
}

function markdownNullableNumber(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

function markdownCounters(values: { name: string; count: number }[]): string {
  return values.length
    ? values.map((entry) => `${markdownCell(entry.name)}=${entry.count}`).join(", ")
    : "none";
}

function markdownSliceScores(
  values?: Array<{ name: string; caseCount: number; passedCount: number; score: number }> | undefined,
): string {
  return values?.length
    ? values
        .map((entry) => `${markdownCell(entry.name)}=${entry.passedCount}/${entry.caseCount} score=${entry.score.toFixed(4)}`)
        .join(", ")
    : "none";
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
    "Scope: local SQLite prepareTurn, reconstructContext, and no-hit context search cost curve; not an external benchmark proof.",
    `Thresholds: prepareTurn p95 <= ${report.thresholds.prepareTurnP95Ms}ms; reconstructContext p95 <= ${report.thresholds.reconstructContextP95Ms}ms; contextNoHitSearch p95 <= ${report.thresholds.prepareTurnP95Ms}ms`,
    "",
    "| Memories | Seed ms | prepareTurn p50/p95/max ms | reconstructContext p50/p95/max ms | contextNoHitSearch p50/p95/max ms | Prompt p95 tokens | Reconstructed p95 tokens | Reconstructed p95 paths |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.results.map(
      (row) =>
        `| ${row.size} | ${row.seedMs.toFixed(3)} | ${row.prepareTurn.p50Ms.toFixed(3)}/${row.prepareTurn.p95Ms.toFixed(3)}/${row.prepareTurn.maxMs.toFixed(3)} | ${row.reconstructContext.p50Ms.toFixed(3)}/${row.reconstructContext.p95Ms.toFixed(3)}/${row.reconstructContext.maxMs.toFixed(3)} | ${row.contextNoHitSearch.p50Ms.toFixed(3)}/${row.contextNoHitSearch.p95Ms.toFixed(3)}/${row.contextNoHitSearch.maxMs.toFixed(3)} | ${row.promptTokenEstimate.p95} | ${row.reconstructedTokenEstimate.p95} | ${row.reconstructedPathCount.p95} |`,
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
    "## Run Manifest",
    "",
    `Started: ${report.runManifest.startedAt}`,
    `Finished: ${report.runManifest.finishedAt}`,
    `Node: ${report.runManifest.node} ${report.runManifest.platform}`,
    `Package: ${report.runManifest.package.name ?? "unknown"}@${report.runManifest.package.version ?? "unknown"}`,
    `Git: ${report.runManifest.git.branch ?? "unknown"} ${report.runManifest.git.sha ?? "unknown"} dirty=${report.runManifest.git.dirty ?? "unknown"}`,
    `Dataset: ${report.runManifest.dataset.id ?? "unknown"} format=${report.runManifest.dataset.format} hash=${report.runManifest.dataset.hash ?? "unknown"} cases=${report.runManifest.dataset.caseCount}`,
    `Dataset warnings: ${report.runManifest.dataset.warnings.length ? report.runManifest.dataset.warnings.map(markdownCell).join("; ") : "none"}`,
    `Execution: caseGroups=${report.runManifest.execution.caseGroupCount} reusedProfileCases=${report.runManifest.execution.reusedProfileCaseCount}`,
    `Options: mode=${report.runManifest.options.mode ?? "case/default"} maxSteps=${report.runManifest.options.maxSteps ?? "default"} maxBranch=${report.runManifest.options.maxBranch ?? "default"} maxMemories=${report.runManifest.options.maxMemories ?? "default"} contextBudgetTokens=${report.runManifest.options.contextBudgetTokens ?? "default"} temporalMode=${report.runManifest.options.temporalMode ?? "case/default"} includeSensitive=${report.runManifest.options.includeSensitive} includeTemporalMetadata=${report.runManifest.options.includeTemporalMetadata} requireConvergence=${report.runManifest.options.requireConvergence} concurrency=${report.runManifest.options.concurrency} reuseProfiles=${report.runManifest.options.reuseProfiles}`,
    `Failure sample limit: ${report.runManifest.options.failureSampleLimit}`,
    `Deterministic only: ${report.runManifest.deterministicOnly ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    `Failure reasons: ${markdownCounters(report.summary.failureReasons)}`,
    `Failure stages: ${markdownCounters(report.summary.failureStages ?? [])}`,
    `Slice scores: ${markdownSliceScores(report.summary.sliceScores)}`,
    `Warnings: ${markdownCounters(report.summary.warnings)}`,
    `Uncertainty: low=${report.summary.uncertaintyLevels.low}, medium=${report.summary.uncertaintyLevels.medium}, high=${report.summary.uncertaintyLevels.high}, unknown=${report.summary.uncertaintyLevels.unknown}`,
    `Evidence convergence: reached=${report.summary.evidenceConvergence.reached}, notReached=${report.summary.evidenceConvergence.notReached}, unknown=${report.summary.evidenceConvergence.unknown}`,
    "",
    "## Failure Samples",
    "",
    ...(report.summary.failureSamples.length === 0
      ? ["None"]
      : [
          "| Case | Temporal | Failure reasons | Failure stages | Warnings | Missing expectedAny | Missing expectedAll | Forbidden matches | Missing intent groups | Convergence | Uncertainty | Tokens | Paths |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: |",
          ...report.summary.failureSamples.map(
            (entry) =>
              `| ${markdownCell(entry.id)} | ${entry.temporalMode ?? "-"} | ${markdownListCell(entry.failureReasons)} | ${markdownTaxonomyCell(entry.failureTaxonomy ?? [])} | ${markdownListCell(entry.warnings)} | ${markdownListCell(entry.expectedAnyMissing)} | ${markdownListCell(entry.expectedAllMissing)} | ${markdownListCell(entry.forbiddenMatches)} | ${markdownListCell(entry.missingRequiredIntentGroups)} | ${markdownNullableNumber(entry.evidenceConvergenceScore)}${entry.evidenceConvergenceReached === null ? "" : entry.evidenceConvergenceReached ? " reached" : " not reached"} | ${entry.uncertaintyLevel ?? "-"} | ${entry.promptTokenEstimate} | ${entry.reconstructedPathCount} |`,
          ),
        ]),
    "",
    "## Cases",
    "",
    "| Case | Status | Mode | Temporal | Failure reasons | Failure stages | Warnings | Missing expectedAny | Missing expectedAll | Forbidden matches | Missing intent groups | Convergence | Uncertainty | Tokens | Paths |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: |",
    ...report.cases.map(
      (entry) =>
        `| ${markdownCell(entry.id)} | ${entry.pass ? "PASS" : "FAIL"} | ${entry.mode}${entry.requireConvergence ? " + convergence" : ""} | ${entry.temporalMode ?? "-"} | ${markdownListCell(entry.failureReasons)} | ${markdownTaxonomyCell(entry.failureTaxonomy ?? [])} | ${markdownListCell(entry.warnings)} | ${markdownListCell(entry.expectedAnyMissing)} | ${markdownListCell(entry.expectedAllMissing)} | ${markdownListCell(entry.forbiddenMatches)} | ${markdownListCell(entry.diagnostics.missingRequiredIntentGroups)} | ${markdownNullableNumber(entry.diagnostics.evidenceConvergenceScore)}${entry.diagnostics.evidenceConvergenceReached === null ? "" : entry.diagnostics.evidenceConvergenceReached ? " reached" : " not reached"} | ${entry.diagnostics.uncertaintyLevel ?? "-"} | ${entry.promptTokenEstimate} | ${entry.reconstructedPathCount} |`,
    ),
    "",
  ].join("\n");
}

export function renderExternalMemoryBenchmarkSuiteMarkdown(
  report: ExternalMemoryBenchmarkSuiteResult,
): string {
  return [
    "# gmOS External Benchmark Suite",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `BenchmarkStatus: ${report.benchmarkPass ? "PASS" : "FAIL"}`,
    `Runs: ${report.passedRunCount}/${report.runCount}`,
    `Mean score: ${report.scoreMean.toFixed(4)}`,
    `Weighted score: ${report.scoreWeighted.toFixed(4)}`,
    `Cases: ${report.totalPassedCount}/${report.totalCaseCount}`,
    `Warnings: ${report.totalWarningCount}`,
    `Failure reasons: ${markdownCounters(report.totalFailureReasons)}`,
    `Failure stages: ${markdownCounters(report.totalFailureStages)}`,
    "",
    "## Run Manifest",
    "",
    `Started: ${report.runManifest.startedAt}`,
    `Finished: ${report.runManifest.finishedAt}`,
    `Duration: ${(report.runManifest.durationMs / 1000).toFixed(1)}s`,
    `Suite file: ${report.runManifest.suiteFile ?? "none"}`,
    `Base dir: ${report.runManifest.baseDir}`,
    `SDK package: ${report.runManifest.package?.name ?? "unknown"}@${report.runManifest.package?.version ?? "unknown"}`,
    `Git: ${report.runManifest.git?.sha ?? "unknown"}${report.runManifest.git?.dirty === null ? "" : report.runManifest.git?.dirty ? " dirty" : " clean"}`,
    `Node: ${report.runManifest.node ?? "unknown"} ${report.runManifest.platform ?? ""}`.trim(),
    `Fail on benchmark fail: ${report.runManifest.failOnBenchmarkFail ? "yes" : "no"}`,
    `Deterministic only: ${report.runManifest.deterministicOnly ? "yes" : "no"}`,
    "",
    "## Runs",
    "",
    "| Run | Status | Dataset | Cases | Score | Duration | Groups | Reused | Failure reasons | Failure stages | Slice scores | Hash | JSON | Markdown | Warnings |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |",
    ...report.runs.map(
      (run) =>
        `| ${markdownCell(run.id)} | ${run.pass ? "PASS" : "FAIL"} | ${run.datasetFormat} | ${run.passedCount}/${run.caseCount} | ${run.score.toFixed(4)} | ${(run.durationMs / 1000).toFixed(1)}s | ${run.caseGroupCount} | ${run.reusedProfileCaseCount} | ${markdownCounters(run.failureReasons)} | ${markdownCounters(run.failureStages)} | ${markdownSliceScores(run.sliceScores)} | ${markdownCell(run.datasetHash ?? "-")} | ${markdownCell(run.jsonFile ?? "-")} | ${markdownCell(run.markdownFile ?? "-")} | ${run.warningCount}${run.warnings.length ? `: ${markdownListCell(run.warnings)}` : ""} |`,
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
    `| Diagnostics | ${report.components.diagnostics.pass ? "PASS" : "FAIL"} | schema=${report.components.diagnostics.schemaVersion ?? "unknown"} plaintext SQLite encrypted=${report.components.diagnostics.encrypted ? "true" : "false"} readAudit=${report.components.diagnostics.readAuditStatus} tables=${report.components.diagnostics.readAuditTableCount} readSideEffectsChecked=${report.components.diagnostics.readPathSideEffectsChecked ? "true" : "false"} |`,
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
