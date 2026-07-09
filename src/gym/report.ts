import type { MemoryGymResult } from "./types.js";
import type { MemoryScaleBenchmarkResult } from "./scale.js";
import type { HostCompatibilityGymResult } from "./host-compatibility.js";
import type { MemoryReleaseGateResult } from "./types.js";
import type {
  ExternalMemoryBenchmarkResult,
  ExternalMemoryBenchmarkScoreSemantics,
} from "./external.js";
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

function markdownCounterTable(values: { name: string; count: number }[]): string[] {
  return [
    "| Name | Count |",
    "| --- | ---: |",
    ...(values.length
      ? values.map((entry) => `| ${markdownCell(entry.name)} | ${entry.count} |`)
      : ["| none | 0 |"]),
  ];
}

function markdownOfficialAttributionCell(
  value: ExternalMemoryBenchmarkResult["cases"][number]["officialFailureAttribution"],
): string {
  if (!value) return "-";
  return markdownCell(`${value.stage}${value.terms.length ? ` (${value.terms.join(", ")})` : ""}`);
}

function scoreSemanticsLine(semantics: ExternalMemoryBenchmarkScoreSemantics): string {
  return [
    `protocol=${semantics.protocol}`,
    `kind=${semantics.scoreKind}`,
    `primary=${semantics.primaryScore}`,
    `judge=${semantics.judgeProvenance.kind}:${semantics.judgeProvenance.name ?? "none"}`,
    `answerer=${semantics.answererProvenance.kind}:${semantics.answererProvenance.name ?? "none"}`,
    `officialProtocol=${semantics.officialProtocol}`,
    `officialScore=${semantics.officialScore ?? "none"}`,
    `officialComparable=${semantics.comparableToOfficialScore ? "yes" : "no"}`,
    `judgeProfile=${semantics.judgeProfile}`,
    `normalizedEvidence=${semantics.normalizedEvidenceScorePurpose}`,
  ].join(" ");
}

function judgeProfileLabel(profile: string): string {
  return profile === "longmemeval_official"
    ? `${profile} (judge: upstream LongMemEval per-type)`
    : profile;
}

function ceilingMetricLine(
  metrics: ExternalMemoryBenchmarkResult["ceilingMetrics"],
): string {
  return metrics
    ? `${metrics.lexicalCeiling.toFixed(4)} (${metrics.reachableCount}/${metrics.caseCount} reachable, ${metrics.unreachableCount} unreachable)`
    : "not_applicable";
}

function reachableScoreLine(
  metrics: ExternalMemoryBenchmarkResult["ceilingMetrics"],
): string {
  return metrics
    ? `${metrics.reachableScore.toFixed(4)} (${metrics.reachablePassedCount}/${metrics.reachableCount})`
    : "not_applicable";
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

function weakestSuiteSlices(report: ExternalMemoryBenchmarkSuiteResult, limit = 8): string[] {
  return report.runs
    .flatMap((run) =>
      (run.sliceScores ?? [])
        .filter((slice) => slice.caseCount > 0)
        .map((slice) => ({
          runId: run.id,
          name: slice.name,
          caseCount: slice.caseCount,
          passedCount: slice.passedCount,
          score: slice.score,
        })),
    )
    .sort(
      (a, b) =>
        a.score - b.score ||
        b.caseCount - a.caseCount ||
        a.runId.localeCompare(b.runId) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(
      (slice) =>
        `- ${markdownCell(slice.runId)} ${markdownCell(slice.name)}: ${slice.passedCount}/${slice.caseCount} score=${slice.score.toFixed(4)}`,
    );
}

function slowestSuiteRuns(report: ExternalMemoryBenchmarkSuiteResult, limit = 5): string[] {
  return [...report.runs]
    .sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(
      (run) =>
        `- ${markdownCell(run.id)}: ${(run.durationMs / 1000).toFixed(1)}s, score=${run.score.toFixed(4)}, cases=${run.passedCount}/${run.caseCount}`,
    );
}

function markdownSlowExternalCases(
  values: ExternalMemoryBenchmarkResult["summary"]["slowestCases"],
): string {
  return values.length
    ? values
        .map(
          (entry) =>
            `${markdownCell(entry.id)}=${entry.durationMs}ms ${entry.pass ? "PASS" : "FAIL"} tokens=${entry.promptTokenEstimate} paths=${entry.reconstructedPathCount}`,
        )
        .join(", ")
    : "none";
}

function markdownSlowExternalGroups(
  values: ExternalMemoryBenchmarkResult["summary"]["slowestCaseGroups"],
): string {
  return values.length
    ? values
        .map(
          (entry) =>
            `${markdownCell(entry.groupKey)}=${entry.durationMs}ms setup=${entry.setupRuntimeMs}ms scoring=${entry.scoringRuntimeMs}ms taxonomy=${entry.taxonomyRuntimeMs}ms wide=${entry.wideBudgetDiagnosticRuntimeMs}ms cases=${entry.passedCount}/${entry.caseCount} events=${entry.eventCount} memories=${entry.extractedMemoryCount} windows=${entry.extractionWindowCount} calls=${entry.extractionCallCount} retries=${entry.extractionRetryCount} extractionEmpty=${entry.extractionEmptyCount} okChars=${entry.extractionOkWithCandidatesCharCount} emptyChars=${entry.extractionEmptyCharCount} parseFailureChars=${entry.extractionParseFailureCharCount} transportFailureChars=${entry.extractionTransportFailureCharCount} extractionParseFailures=${entry.extractionParseFailureCount} extractionTransportFailures=${entry.extractionTransportFailureCount} extractionFailures=${entry.extractionFailureCount}`,
        )
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
    "## Recall Quality",
    "",
    "| Group | Fallback | Provider | Total | Fallback hit-rate | Provider hit-rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.recallQuality.fixtureGroups.map(
      (row) =>
        `| ${markdownCell(row.group)} | ${row.fallbackHits} | ${row.providerHits} | ${row.total} | ${row.fallbackHitRate.toFixed(2)} | ${row.providerHitRate.toFixed(2)} |`,
    ),
    ...(report.recallQuality.fixtureGroups.length === 0 ? ["| none | 0 | 0 | 0 | 0.00 | 0.00 |"] : []),
    "",
    "## Experience Horizon",
    "",
    `Status: ${report.experienceHorizon.pass ? "PASS" : "FAIL"}`,
    `Deterministic replay: ${report.experienceHorizon.deterministicReplayPass ? "PASS" : "FAIL"}`,
    `Counters: ${markdownCounters(Object.entries(report.experienceHorizon.counters).map(([name, count]) => ({ name, count })))}`,
    "",
    "| Scenario | Status | Assertions | Counters |",
    "| --- | --- | --- | --- |",
    ...report.experienceHorizon.scenarios.map(
      (scenario) =>
        `| ${markdownCell(scenario.name)} | ${scenario.pass ? "PASS" : "FAIL"} | ${markdownListCell(scenario.assertions.map((assertion) => `${assertion.name}:${assertion.passed ? "pass" : "fail"}`))} | ${markdownCounters(Object.entries(scenario.counters).map(([name, count]) => ({ name, count })))} |`,
    ),
    ...(report.experienceHorizon.scenarios.length === 0 ? ["| none | FAIL | - | none |"] : []),
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
    "Scope: local SQLite ingest, prepareTurn, reconstructContext, and no-hit context search cost curve; not an external benchmark proof.",
    `Thresholds: ingest p95 <= ${report.thresholds.ingestP95Ms}ms; ingest last/first quintile <= ${report.thresholds.ingestLastToFirstFactor}x; prepareTurn p95 <= ${report.thresholds.prepareTurnP95Ms}ms; reconstructContext p95 <= ${report.thresholds.reconstructContextP95Ms}ms; contextNoHitSearch p95 <= ${report.thresholds.contextNoHitSearchP95Ms}ms`,
    "",
    "| Memories | Seed ms | ingest p50/p95/max ms | ingest last/first | prepareTurn p50/p95/max ms | reconstructContext p50/p95/max ms | contextNoHitSearch p50/p95/max ms | Prompt p95 tokens | Reconstructed p95 tokens | Reconstructed p95 paths |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.results.map(
      (row) =>
        `| ${row.size} | ${row.seedMs.toFixed(3)} | ${row.ingest.latency.p50Ms.toFixed(3)}/${row.ingest.latency.p95Ms.toFixed(3)}/${row.ingest.latency.maxMs.toFixed(3)} | ${row.ingest.lastToFirstRatio.toFixed(3)}x | ${row.prepareTurn.p50Ms.toFixed(3)}/${row.prepareTurn.p95Ms.toFixed(3)}/${row.prepareTurn.maxMs.toFixed(3)} | ${row.reconstructContext.p50Ms.toFixed(3)}/${row.reconstructContext.p95Ms.toFixed(3)}/${row.reconstructContext.maxMs.toFixed(3)} | ${row.contextNoHitSearch.p50Ms.toFixed(3)}/${row.contextNoHitSearch.p95Ms.toFixed(3)}/${row.contextNoHitSearch.maxMs.toFixed(3)} | ${row.promptTokenEstimate.p95} | ${row.reconstructedTokenEstimate.p95} | ${row.reconstructedPathCount.p95} |`,
    ),
    "",
    "## Failed Operations",
    "",
    ...(report.failedOperations.length === 0
      ? ["None"]
      : report.failedOperations.map(
          (failure) =>
            `- size=${failure.size} operation=${failure.operation} metric=${failure.metric} value=${failure.value.toFixed(3)} threshold=${failure.threshold}`,
        )),
    "",
  ].join("\n");
}

export function renderExternalMemoryBenchmarkMarkdown(
  report: ExternalMemoryBenchmarkResult,
): string {
  const runtimeIntelligence = report.runManifest.runtimeIntelligence ?? {
    enabled: false,
    baseUrlHost: null,
    apiKeyEnv: null,
    model: null,
    embedModel: null,
    ingestMode: "memory",
    turnRetention: false,
    maintainPhases: [],
    concurrency: null,
    timeoutMs: null,
    retries: null,
    backoffMs: null,
    embedQuery: false,
    queryEmbeddingFailureCount: 0,
    queryEmbeddingRetryCount: 0,
    queryEmbeddingRecoveredCount: 0,
    queryEmbeddingTimeoutFailureCount: 0,
    queryEmbeddingHttpStatusFailureCount: 0,
    queryEmbeddingTransportFailureCount: 0,
    queryEmbeddingParseFailureCount: 0,
    answererRetryCount: 0,
    answererRecoveredCount: 0,
    judgeRetryCount: 0,
    judgeRecoveredCount: 0,
    hookNames: {
      extractor: null,
      consolidator: null,
      procedureDistiller: null,
      dossierSynthesizer: null,
      embeddingProvider: null,
      reranker: null,
      queryPlanner: null,
    },
    extractionEmptyCount: 0,
    extractionParseFailureCount: 0,
    extractionTransportFailureCount: 0,
    extractionFailureCount: 0,
    extractionWindowCount: 0,
    extractionCallCount: 0,
    extractionRetryCount: 0,
    extractionOkWithCandidatesCharCount: 0,
    extractionEmptyCharCount: 0,
    extractionParseFailureCharCount: 0,
    extractionTransportFailureCharCount: 0,
    replayedWindowCount: 0,
    replayRecoveredCount: 0,
    ingestCaseGroups: [],
    answerer: {
      enabled: false,
      name: null,
      baseUrlHost: null,
      apiKeyEnv: null,
      model: null,
      timeoutMs: null,
      maxTokens: null,
    },
    judge: {
      enabled: false,
      name: null,
      baseUrlHost: null,
      apiKeyEnv: null,
      model: null,
      timeoutMs: null,
      maxTokens: null,
    },
    queryPlanner: {
      enabled: false,
      name: null,
      baseUrlHost: null,
      apiKeyEnv: null,
      model: null,
      maxAnchors: null,
      failureCount: 0,
    },
    sweepCues: {
      enabled: false,
      name: null,
      baseUrlHost: null,
      apiKeyEnv: null,
      model: null,
      maxCues: 3,
      failureCount: 0,
    },
  };
  const runtimeAnswerer = runtimeIntelligence.answerer ?? {
    enabled: false,
    name: null,
    baseUrlHost: null,
    apiKeyEnv: null,
    model: null,
    timeoutMs: null,
    maxTokens: null,
  };
  const runtimeQueryPlanner = runtimeIntelligence.queryPlanner ?? {
    enabled: false,
    name: null,
    baseUrlHost: null,
    apiKeyEnv: null,
    model: null,
    maxAnchors: null,
    failureCount: 0,
  };
  const runtimeSweepCues = runtimeIntelligence.sweepCues ?? {
    enabled: false,
    name: null,
    baseUrlHost: null,
    apiKeyEnv: null,
    model: null,
    maxCues: 3,
    failureCount: 0,
  };
  const totalDatasetCases = report.runManifest.dataset.totalDatasetCases ?? report.runManifest.dataset.caseCount;
  const executedCases = report.runManifest.dataset.executedCases ?? report.caseCount;
  const scopeLabel = report.partial ? `SLICE ${executedCases}/${totalDatasetCases}` : `FULL ${executedCases}/${totalDatasetCases}`;
  const slice = report.runManifest.slice ?? {
    sliceSpec: { maxCases: null, caseOffset: 0, caseIds: [] },
    totalDatasetCases,
    selectedCases: executedCases,
    executedCases,
    sliced: false,
    partial: report.partial ?? false,
  };
  return [
    `# gmOS External Long-Memory QA Benchmark (${scopeLabel})`,
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `Run scope: ${report.partial ? "PARTIAL" : "FULL"} ${executedCases}/${totalDatasetCases}`,
    `DatasetFormat: ${report.datasetFormat}`,
    `Protocol: ${report.runManifest.protocol}`,
    `Judge: ${report.runManifest.judgeProvenance.kind}:${report.runManifest.judgeProvenance.name ?? "none"}`,
    `Judge profile: ${judgeProfileLabel(report.runManifest.judgeProfile)}`,
    `Cases: ${report.passedCount}/${report.caseCount}`,
    `Score: ${report.score.toFixed(4)}`,
    `Strict score: ${report.strictScore.toFixed(4)}`,
    `Normalized evidence score: ${report.normalizedEvidenceScore.toFixed(4)} (${report.normalizedEvidencePassedCount}/${report.caseCount})`,
    `Official score: ${report.officialScore === null ? "not_run" : report.officialScore.toFixed(4)}${report.officialPassedCount === null ? "" : ` (${report.officialPassedCount}/${report.caseCount})`}`,
    `Lexical ceiling: ${ceilingMetricLine(report.ceilingMetrics)}`,
    `Reachable score: ${reachableScoreLine(report.ceilingMetrics)}`,
    report.ceilingMetrics
      ? "Interpretation: raw score includes every case; reachable score excludes deterministic answer_not_in_input cases."
      : "Interpretation: ceiling metrics apply only to deterministic_local reports.",
    "",
    "## Run Manifest",
    "",
    `Started: ${report.runManifest.startedAt}`,
    `Finished: ${report.runManifest.finishedAt}`,
    `Node: ${report.runManifest.node} ${report.runManifest.platform}`,
    `Package: ${report.runManifest.package.name ?? "unknown"}@${report.runManifest.package.version ?? "unknown"}`,
    `Git: ${report.runManifest.git.branch ?? "unknown"} ${report.runManifest.git.sha ?? "unknown"} dirty=${report.runManifest.git.dirty ?? "unknown"}`,
    `Dataset: ${report.runManifest.dataset.id ?? "unknown"} format=${report.runManifest.dataset.format} hash=${report.runManifest.dataset.hash ?? "unknown"} cases=${report.runManifest.dataset.caseCount} executed=${executedCases}`,
    `Dataset warnings: ${report.runManifest.dataset.warnings.length ? report.runManifest.dataset.warnings.map(markdownCell).join("; ") : "none"}`,
    `Execution: caseGroups=${report.runManifest.execution.caseGroupCount} plannedCaseGroups=${report.runManifest.execution.plannedCaseGroupCount ?? report.runManifest.execution.caseGroupCount} reusedProfileCases=${report.runManifest.execution.reusedProfileCaseCount} executedCases=${report.runManifest.execution.executedCases ?? executedCases} partial=${report.runManifest.execution.partial ?? report.partial ?? false} interrupted=${report.runManifest.execution.interrupted ?? false}`,
    `Slice: ${slice.partial ? "partial" : "full"} selected=${slice.selectedCases}/${slice.totalDatasetCases} executed=${slice.executedCases} maxCases=${slice.sliceSpec.maxCases ?? "none"} caseOffset=${slice.sliceSpec.caseOffset} caseIds=${slice.sliceSpec.caseIds.join(",") || "none"}`,
    `Options: mode=${report.runManifest.options.mode ?? "case/default"} protocol=${report.runManifest.options.protocol} judgeProfile=${report.runManifest.options.judgeProfile} readerProfile=${report.runManifest.options.readerProfile ?? "default"} maxSteps=${report.runManifest.options.maxSteps ?? "default"} maxBranch=${report.runManifest.options.maxBranch ?? "default"} maxMemories=${report.runManifest.options.maxMemories ?? "default"} contextBudgetTokens=${report.runManifest.options.contextBudgetTokens ?? "default"} maxCharsPerMemory=${report.runManifest.options.maxCharsPerMemory ?? "default"} fullContentTopRank=${report.runManifest.options.fullContentTopRank ?? "default"} fullContentMaxChars=${report.runManifest.options.fullContentMaxChars ?? "default"} layerPolicy=${report.runManifest.options.layerPolicy ? JSON.stringify(report.runManifest.options.layerPolicy) : "none"} temporalMode=${report.runManifest.options.temporalMode ?? "case/default"} includeSensitive=${report.runManifest.options.includeSensitive} includeTemporalMetadata=${report.runManifest.options.includeTemporalMetadata} includeTemporalContext=${report.runManifest.options.includeTemporalContext ?? true} requireConvergence=${report.runManifest.options.requireConvergence} concurrency=${report.runManifest.options.concurrency} extractionWindow=${report.runManifest.options.extractionWindow ?? "default"} ingestReplayAttempts=${report.runManifest.options.ingestReplayAttempts ?? "default"} turnRetention=${report.runManifest.options.turnRetention} sessionDistillation=${report.runManifest.options.sessionDistillation ?? false} consolidateEntities=${report.runManifest.options.consolidateEntities ?? false} queryPlanner=${report.runManifest.options.queryPlanner} sweepCues=${report.runManifest.options.sweepCues} reuseProfiles=${report.runManifest.options.reuseProfiles} diagnosticsLevel=${report.runManifest.options.diagnosticsLevel}`,
    `Failure sample limit: ${report.runManifest.options.failureSampleLimit}`,
    `Score semantics: ${scoreSemanticsLine(report.runManifest.scoreSemantics)}`,
    `Runtime intelligence: enabled=${runtimeIntelligence.enabled} ingestMode=${runtimeIntelligence.ingestMode} turnRetention=${runtimeIntelligence.turnRetention ?? false} model=${runtimeIntelligence.model ?? "none"} embedModel=${runtimeIntelligence.embedModel ?? "none"} embedQuery=${runtimeIntelligence.embedQuery ?? false} queryEmbeddingFailures=${runtimeIntelligence.queryEmbeddingFailureCount ?? 0} queryEmbeddingRetries=${runtimeIntelligence.queryEmbeddingRetryCount ?? 0} queryEmbeddingRecovered=${runtimeIntelligence.queryEmbeddingRecoveredCount ?? 0} queryEmbeddingTimeoutFailures=${runtimeIntelligence.queryEmbeddingTimeoutFailureCount ?? 0} queryEmbeddingHttpStatusFailures=${runtimeIntelligence.queryEmbeddingHttpStatusFailureCount ?? 0} queryEmbeddingTransportFailures=${runtimeIntelligence.queryEmbeddingTransportFailureCount ?? 0} queryEmbeddingParseFailures=${runtimeIntelligence.queryEmbeddingParseFailureCount ?? 0} host=${runtimeIntelligence.baseUrlHost ?? "none"} maintainPhases=${runtimeIntelligence.maintainPhases.join(",") || "none"} concurrency=${runtimeIntelligence.concurrency ?? "none"} timeoutMs=${runtimeIntelligence.timeoutMs ?? "none"} retries=${runtimeIntelligence.retries ?? "none"} backoffMs=${runtimeIntelligence.backoffMs ?? "none"} extractionWindows=${runtimeIntelligence.extractionWindowCount ?? 0} extractionCalls=${runtimeIntelligence.extractionCallCount ?? 0} extractionRetries=${runtimeIntelligence.extractionRetryCount ?? 0} extractionEmpty=${runtimeIntelligence.extractionEmptyCount ?? 0} replayedWindows=${runtimeIntelligence.replayedWindowCount ?? 0} replayRecovered=${runtimeIntelligence.replayRecoveredCount ?? 0} okChars=${runtimeIntelligence.extractionOkWithCandidatesCharCount ?? 0} emptyChars=${runtimeIntelligence.extractionEmptyCharCount ?? 0} parseFailureChars=${runtimeIntelligence.extractionParseFailureCharCount ?? 0} transportFailureChars=${runtimeIntelligence.extractionTransportFailureCharCount ?? 0} extractionParseFailures=${runtimeIntelligence.extractionParseFailureCount ?? 0} extractionTransportFailures=${runtimeIntelligence.extractionTransportFailureCount ?? 0} extractionFailures=${runtimeIntelligence.extractionFailureCount}`,
    `Runtime session distillation: enabled=${runtimeIntelligence.sessionDistillation?.enabled ?? false} name=${runtimeIntelligence.sessionDistillation?.name ?? "none"} model=${runtimeIntelligence.sessionDistillation?.model ?? "none"} host=${runtimeIntelligence.sessionDistillation?.baseUrlHost ?? "none"} calls=${runtimeIntelligence.sessionDistillation?.callCount ?? 0} distilledMemories=${runtimeIntelligence.sessionDistillation?.distilledMemoryCount ?? 0} ok=${runtimeIntelligence.sessionDistillation?.okWithCandidatesCount ?? 0} empty=${runtimeIntelligence.sessionDistillation?.emptyCount ?? 0} parseFailures=${runtimeIntelligence.sessionDistillation?.parseFailureCount ?? 0} transportFailures=${runtimeIntelligence.sessionDistillation?.transportFailureCount ?? 0} failures=${runtimeIntelligence.sessionDistillation?.failureCount ?? 0}`,
    `Runtime answerer: enabled=${runtimeAnswerer.enabled} name=${runtimeAnswerer.name ?? "none"} model=${runtimeAnswerer.model ?? "none"} host=${runtimeAnswerer.baseUrlHost ?? "none"} apiKeyEnv=${runtimeAnswerer.apiKeyEnv ?? "none"} timeoutMs=${runtimeAnswerer.timeoutMs ?? "none"} retries=${runtimeIntelligence.answererRetryCount ?? 0} recovered=${runtimeIntelligence.answererRecoveredCount ?? 0}`,
    `Runtime judge: enabled=${runtimeIntelligence.judge?.enabled ?? false} name=${runtimeIntelligence.judge?.name ?? "none"} model=${runtimeIntelligence.judge?.model ?? "none"} host=${runtimeIntelligence.judge?.baseUrlHost ?? "none"} apiKeyEnv=${runtimeIntelligence.judge?.apiKeyEnv ?? "none"} timeoutMs=${runtimeIntelligence.judge?.timeoutMs ?? "none"} retries=${runtimeIntelligence.judgeRetryCount ?? 0} recovered=${runtimeIntelligence.judgeRecoveredCount ?? 0}`,
    `Runtime query planner: enabled=${runtimeQueryPlanner.enabled} name=${runtimeQueryPlanner.name ?? "none"} model=${runtimeQueryPlanner.model ?? "none"} host=${runtimeQueryPlanner.baseUrlHost ?? "none"} apiKeyEnv=${runtimeQueryPlanner.apiKeyEnv ?? "none"} maxAnchors=${runtimeQueryPlanner.maxAnchors ?? "none"} failures=${runtimeQueryPlanner.failureCount ?? 0}`,
    `Runtime sweep cues: enabled=${runtimeSweepCues.enabled} name=${runtimeSweepCues.name ?? "none"} model=${runtimeSweepCues.model ?? "none"} host=${runtimeSweepCues.baseUrlHost ?? "none"} apiKeyEnv=${runtimeSweepCues.apiKeyEnv ?? "none"} maxCues=${runtimeSweepCues.maxCues} failures=${runtimeSweepCues.failureCount ?? 0}`,
    `Manifest lexical ceiling: ${ceilingMetricLine(report.runManifest.ceilingMetrics)}`,
    `Manifest reachable score: ${reachableScoreLine(report.runManifest.ceilingMetrics)}`,
    `Deterministic only: ${report.runManifest.deterministicOnly ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    `Failure reasons: ${markdownCounters(report.summary.failureReasons)}`,
    `Failure stages: ${markdownCounters(report.summary.failureStages ?? [])}`,
    `Score attribution: ${markdownCounters(report.summary.scoreAttribution ?? [])}`,
    `Official failure attribution: ${markdownCounters(report.summary.officialFailureAttribution ?? [])}`,
    `Ceiling metrics: lexicalCeiling=${ceilingMetricLine(report.summary.ceilingMetrics)} reachableScore=${reachableScoreLine(report.summary.ceilingMetrics)}`,
    `Slice scores: ${markdownSliceScores(report.summary.sliceScores)}`,
    `Warnings: ${markdownCounters(report.summary.warnings)}`,
    `Retrieval empty cases: ${report.retrievalEmptyCount ?? report.summary.retrievalEmptyCount ?? 0}`,
    `Uncertainty: low=${report.summary.uncertaintyLevels.low}, medium=${report.summary.uncertaintyLevels.medium}, high=${report.summary.uncertaintyLevels.high}, unknown=${report.summary.uncertaintyLevels.unknown}`,
    `Evidence convergence: reached=${report.summary.evidenceConvergence.reached}, notReached=${report.summary.evidenceConvergence.notReached}, unknown=${report.summary.evidenceConvergence.unknown}`,
    `Runtime: total=${report.summary.runtime.totalRuntimeMs}ms setup=${report.summary.runtime.setupRuntimeMs}ms scoring=${report.summary.runtime.scoringRuntimeMs}ms taxonomy=${report.summary.runtime.taxonomyRuntimeMs}ms wideBudget=${report.summary.runtime.wideBudgetDiagnosticRuntimeMs}ms diagnostics=${report.summary.runtime.diagnosticRuntimeMs}ms`,
    `Slowest cases: ${markdownSlowExternalCases(report.summary.slowestCases)}`,
    `Slowest case groups: ${markdownSlowExternalGroups(report.summary.slowestCaseGroups)}`,
    "",
    "Official failure attribution:",
    ...markdownCounterTable(report.summary.officialFailureAttribution ?? []),
    "",
    "## Failure Samples",
    "",
    ...(report.summary.failureSamples.length === 0
      ? ["None"]
      : [
          "| Case | Temporal | Failure reasons | Failure stages | Official attribution | Warnings | Generated answer | Matched expectedAny | Matched expectedAll | Missing expectedAny | Missing expectedAll | Forbidden matches | Missing intent groups | Required anchor unmet | Convergence | Uncertainty | Tokens | Retrieved | Extracted | Windows | Calls | Retries | Empty | Ok chars | Empty chars | Parse chars | Transport chars | Parse failures | Transport failures | Extraction failures | Paths | Duration ms | Scoring ms | Taxonomy ms | Wide ms |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...report.summary.failureSamples.map(
            (entry) =>
              `| ${markdownCell(entry.id)} | ${entry.temporalMode ?? "-"} | ${markdownListCell(entry.failureReasons)} | ${markdownTaxonomyCell(entry.failureTaxonomy ?? [])} | ${markdownOfficialAttributionCell(entry.officialFailureAttribution)} | ${markdownListCell(entry.warnings)} | ${markdownCell(entry.generatedAnswer ?? entry.answererError ?? entry.judgeError ?? "-")} | ${markdownListCell(entry.matched.expectedAny)} | ${markdownListCell(entry.matched.expectedAll)} | ${markdownListCell(entry.expectedAnyMissing)} | ${markdownListCell(entry.expectedAllMissing)} | ${markdownListCell(entry.matched.forbidden)} | ${markdownListCell(entry.missingRequiredIntentGroups)} | ${markdownListCell(entry.requiredAnchorUnmet)} | ${markdownNullableNumber(entry.evidenceConvergenceScore)}${entry.evidenceConvergenceReached === null ? "" : entry.evidenceConvergenceReached ? " reached" : " not reached"} | ${entry.uncertaintyLevel ?? "-"} | ${entry.promptTokenEstimate} | ${entry.retrievedMemoryCount} | ${entry.extractedMemoryCount} | ${entry.extractionWindowCount} | ${entry.extractionCallCount} | ${entry.extractionRetryCount} | ${entry.extractionEmptyCount} | ${entry.extractionOkWithCandidatesCharCount} | ${entry.extractionEmptyCharCount} | ${entry.extractionParseFailureCharCount} | ${entry.extractionTransportFailureCharCount} | ${entry.extractionParseFailureCount} | ${entry.extractionTransportFailureCount} | ${entry.extractionFailureCount} | ${entry.reconstructedPathCount} | ${entry.durationMs} | ${entry.scoringRuntimeMs} | ${entry.taxonomyRuntimeMs} | ${entry.wideBudgetDiagnosticRuntimeMs} |`,
          ),
        ]),
    "",
    "## Cases",
    "",
    "| Case | Status | Mode | Temporal | Failure reasons | Failure stages | Official attribution | Warnings | Generated answer | Lexically reachable | Matched expectedAny | Matched expectedAll | Missing expectedAny | Missing expectedAll | Forbidden matches | Missing intent groups | Required anchor unmet | Convergence | Uncertainty | Tokens | Retrieved | Extracted | Windows | Calls | Retries | Empty | Ok chars | Empty chars | Parse chars | Transport chars | Parse failures | Transport failures | Extraction failures | Paths | Duration ms | Scoring ms | Taxonomy ms | Wide ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.cases.map(
      (entry) =>
        `| ${markdownCell(entry.id)} | ${entry.pass ? "PASS" : "FAIL"} | ${entry.mode}${entry.requireConvergence ? " + convergence" : ""} | ${entry.temporalMode ?? "-"} | ${markdownListCell(entry.failureReasons)} | ${markdownTaxonomyCell(entry.failureTaxonomy ?? [])} | ${markdownOfficialAttributionCell(entry.officialFailureAttribution)} | ${markdownListCell(entry.warnings)} | ${markdownCell(entry.generatedAnswer ?? entry.answererError ?? entry.judgeError ?? "-")} | ${entry.lexicallyReachable ? "yes" : "no"} | ${markdownListCell(entry.matched.expectedAny)} | ${markdownListCell(entry.matched.expectedAll)} | ${markdownListCell(entry.expectedAnyMissing)} | ${markdownListCell(entry.expectedAllMissing)} | ${markdownListCell(entry.matched.forbidden)} | ${markdownListCell(entry.diagnostics.missingRequiredIntentGroups)} | ${markdownListCell(entry.diagnostics.requiredAnchorUnmet)} | ${markdownNullableNumber(entry.diagnostics.evidenceConvergenceScore)}${entry.diagnostics.evidenceConvergenceReached === null ? "" : entry.diagnostics.evidenceConvergenceReached ? " reached" : " not reached"} | ${entry.diagnostics.uncertaintyLevel ?? "-"} | ${entry.promptTokenEstimate} | ${entry.retrievedMemoryCount} | ${entry.extractedMemoryCount} | ${entry.extractionWindowCount} | ${entry.extractionCallCount} | ${entry.extractionRetryCount} | ${entry.extractionEmptyCount} | ${entry.extractionOkWithCandidatesCharCount} | ${entry.extractionEmptyCharCount} | ${entry.extractionParseFailureCharCount} | ${entry.extractionTransportFailureCharCount} | ${entry.extractionParseFailureCount} | ${entry.extractionTransportFailureCount} | ${entry.extractionFailureCount} | ${entry.reconstructedPathCount} | ${entry.durationMs} | ${entry.scoringRuntimeMs} | ${entry.taxonomyRuntimeMs} | ${entry.wideBudgetDiagnosticRuntimeMs} |`,
    ),
    "",
  ].join("\n");
}

export function renderExternalMemoryBenchmarkSuiteMarkdown(
  report: ExternalMemoryBenchmarkSuiteResult,
): string {
  const slowRuns = slowestSuiteRuns(report);
  const weakSlices = weakestSuiteSlices(report);
  return [
    "# gmOS External Benchmark Suite",
    "",
    `Status: ${report.pass ? "PASS" : "FAIL"}`,
    `BenchmarkStatus: ${report.benchmarkPass ? "PASS" : "FAIL"}`,
    `Run scope: ${report.partial ? "PARTIAL" : "FULL"} executed=${report.totalExecutedCases ?? report.totalCaseCount}/${report.totalDatasetCases ?? report.totalCaseCount}`,
    `Runs: ${report.passedRunCount}/${report.runCount}`,
    `Mean score: ${report.scoreMean.toFixed(4)}`,
    `Weighted score: ${report.scoreWeighted.toFixed(4)}`,
    `Reachable weighted score: ${report.reachableScoreWeighted === null ? "not_applicable" : report.reachableScoreWeighted.toFixed(4)}`,
    `Lexical ceiling weighted: ${report.lexicalCeilingWeighted === null ? "not_applicable" : report.lexicalCeilingWeighted.toFixed(4)}`,
    `Strict mean score: ${report.strictScoreMean.toFixed(4)}`,
    `Strict weighted score: ${report.strictScoreWeighted.toFixed(4)}`,
    `Normalized evidence mean score: ${report.normalizedEvidenceScoreMean.toFixed(4)}`,
    `Normalized evidence weighted score: ${report.normalizedEvidenceScoreWeighted.toFixed(4)}`,
    `Cases: ${report.totalPassedCount}/${report.totalCaseCount}`,
    `Dataset cases: executed=${report.totalExecutedCases ?? report.totalCaseCount}/${report.totalDatasetCases ?? report.totalCaseCount}`,
    `Reachable cases: ${report.totalReachablePassedCount}/${report.totalReachableCount} passed; unreachable=${report.totalUnreachableCount}`,
    `Normalized evidence cases: ${report.totalNormalizedEvidencePassedCount}/${report.totalCaseCount}`,
    report.runManifest.ceilingMetrics
      ? "Interpretation: weighted score is raw deterministic score; reachable weighted score excludes answer_not_in_input cases."
      : "Interpretation: ceiling metrics apply only when every run is deterministic_local.",
    `Warnings: ${report.totalWarningCount}`,
    `Failure reasons: ${markdownCounters(report.totalFailureReasons)}`,
    `Failure stages: ${markdownCounters(report.totalFailureStages)}`,
    `Score attribution: ${markdownCounters(report.totalScoreAttribution ?? [])}`,
    `Official failure attribution: ${markdownCounters(report.totalOfficialFailureAttribution ?? [])}`,
    "",
    "## Diagnostic Summary",
    "",
    "This section is derived from existing run statistics. It does not change scoring, adapter behavior, or runtime behavior.",
    "",
    "Slowest runs:",
    ...(slowRuns.length ? slowRuns : ["- none"]),
    "",
    "Weakest slices:",
    ...(weakSlices.length ? weakSlices : ["- none"]),
    "",
    `Top failure stages: ${markdownCounters(report.totalFailureStages.slice(0, 5))}`,
    `Top failure reasons: ${markdownCounters(report.totalFailureReasons.slice(0, 5))}`,
    `Top score attribution: ${markdownCounters((report.totalScoreAttribution ?? []).slice(0, 5))}`,
    "",
    "## Run Manifest",
    "",
    `Started: ${report.runManifest.startedAt}`,
    `Finished: ${report.runManifest.finishedAt}`,
    `Duration: ${(report.runManifest.durationMs / 1000).toFixed(1)}s`,
    `Suite file: ${report.runManifest.suiteFile ?? "none"}`,
    `Suite hash: ${report.runManifest.suiteHash ?? "none"}`,
    `Base dir: ${report.runManifest.baseDir}`,
    `SDK package: ${report.runManifest.package?.name ?? "unknown"}@${report.runManifest.package?.version ?? "unknown"}`,
    `Git: ${report.runManifest.git?.sha ?? "unknown"}${report.runManifest.git?.dirty === null ? "" : report.runManifest.git?.dirty ? " dirty" : " clean"}`,
    `Node: ${report.runManifest.node ?? "unknown"} ${report.runManifest.platform ?? ""}`.trim(),
    `Fail on benchmark fail: ${report.runManifest.failOnBenchmarkFail ? "yes" : "no"}`,
    `Protocols: ${report.runManifest.protocols.join(", ") || "none"}`,
    `Score semantics: ${scoreSemanticsLine(report.runManifest.scoreSemantics)}`,
    `Suite lexical ceiling: ${ceilingMetricLine(report.runManifest.ceilingMetrics)}`,
    `Suite reachable score: ${reachableScoreLine(report.runManifest.ceilingMetrics)}`,
    `Deterministic only: ${report.runManifest.deterministicOnly ? "yes" : "no"}`,
    `Partial: ${report.runManifest.partial ? "yes" : "no"}`,
    "",
    "## Runs",
    "",
    "| Run | Status | Scope | Protocol | Judge | Dataset | Cases | Score | Lexical ceiling | Reachable score | Official | Normalized evidence | Duration | Setup | Scoring | Taxonomy | Wide | Groups | Reused | Failure reasons | Failure stages | Score attribution | Official attribution | Slice scores | Hash | JSON | Markdown | Warnings |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.runs.map(
      (run) =>
        `| ${markdownCell(run.id)} | ${run.pass ? "PASS" : "FAIL"} | ${run.partial ? `SLICE ${run.executedCases}/${run.totalDatasetCases}` : `FULL ${run.executedCases}/${run.totalDatasetCases}`} | ${run.protocol} | ${markdownCell(run.judgeName ?? "-")} | ${run.datasetFormat} | ${run.passedCount}/${run.caseCount} | ${run.score.toFixed(4)} | ${run.ceilingMetrics ? run.ceilingMetrics.lexicalCeiling.toFixed(4) : "-"} | ${run.ceilingMetrics ? run.ceilingMetrics.reachableScore.toFixed(4) : "-"} | ${run.officialScore === null ? "-" : run.officialScore.toFixed(4)} | ${run.normalizedEvidenceScore.toFixed(4)} | ${(run.durationMs / 1000).toFixed(1)}s | ${(run.runtime.setupRuntimeMs / 1000).toFixed(1)}s | ${(run.runtime.scoringRuntimeMs / 1000).toFixed(1)}s | ${(run.runtime.taxonomyRuntimeMs / 1000).toFixed(1)}s | ${(run.runtime.wideBudgetDiagnosticRuntimeMs / 1000).toFixed(1)}s | ${run.caseGroupCount} | ${run.reusedProfileCaseCount} | ${markdownCounters(run.failureReasons)} | ${markdownCounters(run.failureStages)} | ${markdownCounters(run.scoreAttribution ?? [])} | ${markdownCounters(run.officialFailureAttribution ?? [])} | ${markdownSliceScores(run.sliceScores)} | ${markdownCell(run.datasetHash ?? "-")} | ${markdownCell(run.jsonFile ?? "-")} | ${markdownCell(run.markdownFile ?? "-")} | ${run.warningCount}${run.warnings.length ? `: ${markdownListCell(run.warnings)}` : ""} |`,
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
    `Scale ingest p95 ms: ${report.inputs.scaleIngestP95Ms}`,
    `Scale ingest last/first factor: ${report.inputs.scaleIngestLastToFirstFactor}`,
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
                  `- scale:${failure.size}:${failure.operation}:${failure.metric}=${failure.value.toFixed(3)} threshold=${failure.threshold}`,
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
