import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createMemoryStatusReport } from "../diagnostics/index.js";
import { createHostAdapter } from "../host/index.js";
import type { HostActualCompatibilityReport, HostPreset } from "../host/index.js";
import { createMemoryMcpServer } from "../mcp/index.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
import { coverageMatrix, memoryStackCoverage, roadmap } from "./coverage.js";
import {
  EXTERNAL_MEMORY_BENCHMARK_SCORE_SEMANTICS,
  parseExternalMemoryBenchmarkJsonl,
  hashExternalMemoryBenchmarkInput,
  runExternalMemoryBenchmark,
  type ExternalMemoryBenchmarkDatasetFormat,
  type ExternalMemoryBenchmarkDiagnosticsLevel,
  type ExternalMemoryBenchmarkCase,
  type ExternalMemoryBenchmarkCaseResult,
  type ExternalMemoryBenchmarkCaseTiming,
  type ExternalMemoryBenchmarkCounter,
  type ExternalMemoryBenchmarkEvent,
  type ExternalMemoryBenchmarkFailureSample,
  type ExternalMemoryBenchmarkFailureStage,
  type ExternalMemoryBenchmarkFailureTaxonomyEntry,
  type ExternalMemoryBenchmarkGroupTiming,
  type ExternalMemoryBenchmarkMode,
  type ExternalMemoryBenchmarkResult,
  type ExternalMemoryBenchmarkRunManifest,
  type ExternalMemoryBenchmarkScoreAttributionArea,
  type ExternalMemoryBenchmarkScoreSemantics,
  type ExternalMemoryBenchmarkSliceScore,
  type ExternalMemoryBenchmarkSummary,
  type RunExternalMemoryBenchmarkOptions,
} from "./external.js";
import {
  parseExternalMemoryBenchmarkDataset,
  parseLocomoBenchmarkDataset,
  parseLongMemEvalBenchmarkDataset,
  type ExternalMemoryBenchmarkDatasetAdapter,
  type ParsedExternalMemoryBenchmarkDataset,
  type ParseExternalMemoryBenchmarkDatasetOptions,
} from "./external-adapters.js";
import {
  parseExternalMemoryBenchmarkSuite,
  runExternalMemoryBenchmarkSuite,
  type ExternalMemoryBenchmarkSuiteDocument,
  type ExternalMemoryBenchmarkSuiteExecution,
  type ExternalMemoryBenchmarkSuiteResult,
  type ExternalMemoryBenchmarkSuiteRunConfig,
  type ExternalMemoryBenchmarkSuiteRunSummary,
  type RunExternalMemoryBenchmarkSuiteOptions,
} from "./external-suite.js";
import {
  runHostCompatibilityGym,
  type HostCompatibilityGymResult,
  type HostCompatibilityGymHostResult,
  type HostCompatibilityProbeArea,
  type HostCompatibilityProbeResult,
  type HostCompatibilityProbeStatus,
  type RunHostCompatibilityGymOptions,
} from "./host-compatibility.js";
import {
  runMemoryScaleBenchmark,
  type MemoryScaleBenchmarkResult,
} from "./scale.js";
import {
  buildStateBenchLearnings,
  prepareStateBenchAgentLearningRun,
  summarizeStateBenchResults,
  stateBenchAgentPythonTemplate,
  type BuildStateBenchLearningsOptions,
  type PrepareStateBenchAgentLearningRunOptions,
  type StateBenchResultsSummary,
  type StateBenchLearning,
  type StateBenchLearningsArtifact,
  type StateBenchPreparedRunManifest,
  type SummarizeStateBenchResultsOptions,
} from "./state-bench.js";
export {
  renderHostCompatibilityGymMarkdown,
  renderExternalMemoryBenchmarkMarkdown,
  renderExternalMemoryBenchmarkSuiteMarkdown,
  renderMemoryGymMarkdown,
  renderMemoryReleaseGateMarkdown,
  renderMemoryScaleMarkdown,
} from "./report.js";
export {
  parseExternalMemoryBenchmarkJsonl,
  parseExternalMemoryBenchmarkDataset,
  parseExternalMemoryBenchmarkSuite,
  parseLocomoBenchmarkDataset,
  parseLongMemEvalBenchmarkDataset,
  hashExternalMemoryBenchmarkInput,
  EXTERNAL_MEMORY_BENCHMARK_SCORE_SEMANTICS,
  buildStateBenchLearnings,
  prepareStateBenchAgentLearningRun,
  summarizeStateBenchResults,
  stateBenchAgentPythonTemplate,
  runExternalMemoryBenchmark,
  runExternalMemoryBenchmarkSuite,
  runHostCompatibilityGym,
};
export type {
  BuildStateBenchLearningsOptions,
  PrepareStateBenchAgentLearningRunOptions,
  ExternalMemoryBenchmarkDatasetAdapter,
  ExternalMemoryBenchmarkDatasetFormat,
  ExternalMemoryBenchmarkDiagnosticsLevel,
  ExternalMemoryBenchmarkCase,
  ExternalMemoryBenchmarkCaseResult,
  ExternalMemoryBenchmarkCaseTiming,
  ExternalMemoryBenchmarkCounter,
  ExternalMemoryBenchmarkEvent,
  ExternalMemoryBenchmarkFailureSample,
  ExternalMemoryBenchmarkFailureStage,
  ExternalMemoryBenchmarkFailureTaxonomyEntry,
  ExternalMemoryBenchmarkGroupTiming,
  ExternalMemoryBenchmarkMode,
  ExternalMemoryBenchmarkResult,
  ExternalMemoryBenchmarkRunManifest,
  ExternalMemoryBenchmarkScoreAttributionArea,
  ExternalMemoryBenchmarkScoreSemantics,
  ExternalMemoryBenchmarkSliceScore,
  ExternalMemoryBenchmarkSummary,
  ExternalMemoryBenchmarkSuiteDocument,
  ExternalMemoryBenchmarkSuiteExecution,
  ExternalMemoryBenchmarkSuiteResult,
  ExternalMemoryBenchmarkSuiteRunConfig,
  ExternalMemoryBenchmarkSuiteRunSummary,
  HostCompatibilityGymHostResult,
  HostCompatibilityGymResult,
  HostCompatibilityProbeArea,
  HostCompatibilityProbeResult,
  HostCompatibilityProbeStatus,
  ParsedExternalMemoryBenchmarkDataset,
  ParseExternalMemoryBenchmarkDatasetOptions,
  RunHostCompatibilityGymOptions,
  RunExternalMemoryBenchmarkOptions,
  RunExternalMemoryBenchmarkSuiteOptions,
  StateBenchResultsSummary,
  StateBenchLearning,
  StateBenchLearningsArtifact,
  StateBenchPreparedRunManifest,
  SummarizeStateBenchResultsOptions,
};
export { runMemoryScaleBenchmark };
export type { MemoryScaleBenchmarkResult };
export type * from "./types.js";
import type {
  MemoryGymGateResult,
  MemoryGymResult,
  MemoryGymScenarioResult,
  MemoryReleaseGateResult,
} from "./types.js";

interface MutableGymResult extends MemoryGymResult {
  hardGates: Record<string, boolean>;
  gateResults: MemoryGymGateResult[];
  details: string[];
  scenarios: MemoryGymScenarioResult[];
}

interface NormalizedRunMemoryGymOptions {
  dbPath: string;
  generatedSeeds: string[];
}

const SDK_PACKAGE_NAME = "@ghast/memory";

function packageJsonInTree(startDir: string): MemoryGymResult["runManifest"]["package"] | null {
  let current = startDir;
  for (;;) {
    const candidate = path.join(current, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name !== SDK_PACKAGE_NAME) return null;
        return {
          name: parsed.name,
          version: typeof parsed.version === "string" ? parsed.version : null,
        };
      } catch {
        return { name: null, version: null };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageInfo(): MemoryGymResult["runManifest"]["package"] {
  return packageJsonInTree(path.dirname(fileURLToPath(import.meta.url))) ?? {
    name: null,
    version: null,
  };
}

function gitText(args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitInfo(): MemoryGymResult["runManifest"]["git"] {
  const status = gitText(["status", "--porcelain"]);
  return {
    branch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    sha: gitText(["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
  };
}

function createEmptyResult(options: NormalizedRunMemoryGymOptions): MutableGymResult {
  return {
    pass: false,
    score: 0,
    framework: "complete memory system benchmark framework",
    deterministicArchitectureResult: {
      status: "not_run",
      score: null,
      gate: "ci_pr",
    },
    agentMemoryUseResult: {
      status: "not_run",
      score: null,
      gate: "nightly_release_signal",
    },
    generalizationResult: {
      status: "not_run",
      devScore: 0,
      holdoutScore: 0,
      generatedMean: 0,
      generatedStd: 0,
      generatedSeedCount: options.generatedSeeds.length,
      adversarialScore: 0,
      generalizationGap: 0,
    },
    roadmapResult: {
      status: "clear",
      suggestions: [],
    },
    stage5ReadinessView: 0,
    releaseConfidence: "action_required",
    hardGates: {},
    gateResults: [],
    details: [],
    scenarios: [],
    coverageMatrix: [],
    memoryStackCoverage: [],
    runManifest: {
      framework: "gmos-memory-gym",
      startedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      package: packageInfo(),
      git: gitInfo(),
      sqliteSchemaVersion: null,
      dbPathMode: options.dbPath === ":memory:" ? "memory" : "file",
      generatedSeeds: options.generatedSeeds,
      deterministicOnly: true,
    },
  };
}

function scoreBooleans(values: boolean[]): number {
  if (values.length === 0) return 0;
  return values.filter(Boolean).length / values.length;
}

function scoreScenarios(
  scenarios: MemoryGymScenarioResult[],
  group: MemoryGymScenarioResult["group"],
): number {
  return scoreBooleans(scenarios.filter((scenario) => scenario.group === group).map((scenario) => scenario.pass));
}

function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function gate(
  result: MutableGymResult,
  name: string,
  passed: boolean,
  detail: string,
  layer: string,
): void {
  result.hardGates[name] = passed;
  result.gateResults.push({ name, passed, detail, layer });
  result.details.push(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function scenario(
  result: MutableGymResult,
  name: string,
  group: MemoryGymScenarioResult["group"],
  gates: string[],
): void {
  result.scenarios.push({
    name,
    group,
    gates,
    pass: gates.every((gateName) => result.hardGates[gateName] === true),
  });
}

function generatedSeedNames(raw: number | string[] | undefined): string[] {
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.some((seed) => seed.trim().length === 0)) {
      throw new Error("generatedSeeds must be a positive integer or non-empty string array");
    }
    return raw;
  }
  const count = raw ?? 3;
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("generatedSeeds must be a positive integer or non-empty string array");
  }
  return Array.from({ length: count }, (_, index) => `generated-${index + 1}`);
}

export interface RunMemoryGymOptions {
  dbPath?: string | undefined;
  generatedSeeds?: number | string[] | undefined;
}

export async function runMemoryGym(options: RunMemoryGymOptions = {}): Promise<MemoryGymResult> {
  const normalized: NormalizedRunMemoryGymOptions = {
    dbPath: options.dbPath ?? ":memory:",
    generatedSeeds: generatedSeedNames(options.generatedSeeds),
  };
  const store = createSqliteMemoryStore({ path: normalized.dbPath });
  const memory = createMemoryOS({ profileId: "gym", store });
  const result = createEmptyResult(normalized);

  try {
  await store.initialize();
  result.runManifest.sqliteSchemaVersion = await store.schemaVersion();
  await memory.add({
    profileId: "gym",
    kind: "preference",
    content: "我喜欢简洁的中文回答。",
    createdAt: "2026-06-25T00:00:00.000Z",
  });
  const preference = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "你之后怎么回答我？" }],
  });
  gate(
    result,
    "preference_recall",
    preference.contextBlock.includes("简洁的中文回答"),
    "preference memory should enter ordinary context",
    "runtime",
  );
  scenario(result, "preference_recall", "dev", ["preference_recall"]);

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "以后不要再提醒我 Alpha 项目延期了。",
    createdAt: "2026-06-25T00:01:00.000Z",
  });
  const boundary = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "Alpha 项目怎么样？" }],
  });
  gate(
    result,
    "do_not_push_policy",
    boundary.directives.some((directive) => directive.includes("Alpha 项目延期")),
    "boundary should become an action directive",
    "context_action",
  );
  scenario(result, "do_not_push_policy", "dev", ["do_not_push_policy"]);

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我的 API key 是 sk-test1234567890abcdefg，请记住。",
    createdAt: "2026-06-25T00:02:00.000Z",
  });
  const secret = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "API key 是什么？" }],
    includeSensitive: true,
    includeEvidence: true,
  });
  gate(
    result,
    "secret_like_persistence",
    !secret.contextBlock.includes("sk-test"),
    "secret-like content must not be persisted or injected",
    "safety",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我的 SSN 是 123-45-6789，不要再提醒我。",
    createdAt: "2026-06-25T00:02:30.000Z",
  });
  const sensitivePolicy = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "SSN 提醒策略是什么？" }],
  });
  gate(
    result,
    "sensitive_action_policy_exposure",
    !sensitivePolicy.contextBlock.includes("123-45-6789"),
    "sensitive boundary/action policy should not enter ordinary context",
    "safety",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我住在一个临时地址，不要长期记。",
    privacyMode: "incognito",
    createdAt: "2026-06-25T00:03:00.000Z",
  });
  const incognito = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "临时地址是什么？" }],
  });
  gate(
    result,
    "incognito_leakage",
    !incognito.contextBlock.includes("临时地址"),
    "incognito events should not become long-term memory",
    "safety",
  );
  scenario(result, "privacy_safety", "adversarial", [
    "secret_like_persistence",
    "sensitive_action_policy_exposure",
    "incognito_leakage",
  ]);

  const mcp = createMemoryMcpServer(memory);
  const mcpTool = mcp.listTools().find((tool) => tool.name === "memory.prepare_context");
  const mcpSensitive = await mcp.callTool("memory.prepare_context", {
    profileId: "gym",
    text: "SSN 提醒策略",
    includeSensitive: true,
  });
  gate(
    result,
    "mcp_public_sensitive_rejection",
    !Object.hasOwn(mcpTool?.inputSchema.properties ?? {}, "includeSensitive") &&
      mcpSensitive.isError === true &&
      !JSON.stringify(mcpSensitive.structuredContent).includes("123-45-6789"),
    "public MCP prepare_context must not expose sensitive override",
    "mcp_host",
  );
  scenario(result, "mcp_public_boundary", "adversarial", ["mcp_public_sensitive_rejection"]);

  await memory.add({
    profileId: "gym",
    kind: "project",
    content: "我在 Moonbase 项目做发布管理。",
    createdAt: "2026-06-25T00:04:00.000Z",
  });
  const forgot = await memory.forget({ profileId: "gym", query: "Moonbase" });
  const afterForget = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "Moonbase 项目我做什么？" }],
  });
  gate(
    result,
    "forget_compliance",
    forgot.archivedMemoryIds.length > 0 && !afterForget.contextBlock.includes("Moonbase"),
    "forget should archive matching memory and remove it from context",
    "safety",
  );
  scenario(result, "forget_compliance", "dev", ["forget_compliance"]);

  await store.recordEvidence({
    profileId: "gym",
    eventKey: "idempotent:evidence",
    sourceType: "test",
    content: "idempotent evidence event",
    sensitivity: "normal",
    eligibleForLongTermMemory: true,
  });
  const beforeEvidenceReplay = await store.rowCounts();
  await store.recordEvidence({
    profileId: "gym",
    eventKey: "idempotent:evidence",
    sourceType: "test",
    content: "idempotent evidence event replay",
    sensitivity: "normal",
    eligibleForLongTermMemory: true,
  });
  const afterEvidenceReplay = await store.rowCounts();
  gate(
    result,
    "evidence_idempotency",
    beforeEvidenceReplay.gmos_evidence_events === afterEvidenceReplay.gmos_evidence_events,
    "replaying the same evidence event key must not duplicate evidence rows",
    "architecture",
  );

  const before = await store.rowCounts();
  await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "只读检查" }],
  });
  const after = await store.rowCounts();
  gate(
    result,
    "read_path_side_effects",
    JSON.stringify(before) === JSON.stringify(after),
    "prepareTurn must not write",
    "architecture",
  );
  scenario(result, "architecture_invariants", "dev", [
    "evidence_idempotency",
    "read_path_side_effects",
  ]);

  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "代号 Helio 的项目是用户之前说的那个计划。",
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "procedure",
    content: "Helio 项目推进时先写复现报告，再做实现。",
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "boundary",
    content: "Helio 项目不要主动催促用户。",
  });
  const beforeReconstruction = await store.rowCounts();
  const reconstructed = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "我之前说的那个计划，先做什么？",
    includeEvidence: true,
    maxSteps: 4,
    maxBranch: 6,
    maxMemories: 6,
  });
  const afterReconstruction = await store.rowCounts();
  gate(
    result,
    "active_reconstruction_multihop",
    reconstructed.contextBlock.includes("Helio 项目推进时先写复现报告") &&
      reconstructed.paths.length >= 2 &&
      reconstructed.paths.some((path) => path.cue.toLowerCase() === "helio"),
    "reconstructContext should follow cue-tag-content associations instead of one-shot top-k recall",
    "reconstruction",
  );
  gate(
    result,
    "active_reconstruction_coverage_signal",
    /Evidence coverage:/.test(reconstructed.contextBlock) &&
      /Reconstruction uncertainty:/.test(reconstructed.contextBlock) &&
      (reconstructed.stats.evidenceCoverage?.coveredCueCount ?? 0) > 0 &&
      reconstructed.stats.uncertainty?.level !== "high",
    "reconstructContext should report whether explored evidence covers query cues",
    "reconstruction",
  );
  gate(
    result,
    "active_reconstruction_evidence_convergence",
    /Evidence convergence:/.test(reconstructed.contextBlock) &&
      reconstructed.stats.evidenceConvergence?.reached === true &&
      (reconstructed.stats.evidenceConvergence?.score ?? 0) >=
        (reconstructed.stats.evidenceConvergence?.threshold ?? 1) &&
      reconstructed.paths.some((path) => (path.informationGain ?? 0) > 0),
    "reconstructContext should expose evidence convergence and path information gain, not only top-k recall",
    "reconstruction",
  );
  const plannerTrace = reconstructed.plannerTrace;
  gate(
    result,
    "active_reconstruction_planner_trace",
    plannerTrace?.mode === "associative" &&
      plannerTrace.intentReason === "procedure_or_next_step" &&
      plannerTrace.stopReason === reconstructed.stats.stopReason &&
      plannerTrace.initialCues.length > 0 &&
      plannerTrace.steps.length >= 2 &&
      plannerTrace.steps.some((step) => step.generatedCues.includes("helio")) &&
      plannerTrace.steps.some((step) => step.selectedCue === "helio") &&
      plannerTrace.steps.some((step) =>
        step.branches.some(
          (branch) => branch.decision === "selected" && branch.generatedCues.length > 0,
        ),
      ),
    "reconstructContext should expose a structured cue exploration trace, including evidence-driven new cue activation",
    "reconstruction",
  );
  await memory.add({
    profileId: "gym_reconstruct_reinforced",
    kind: "procedure",
    content: "Mira rollback checklist says verify audit trail before deploy.",
    confidence: 0.9,
  });
  const reinforcedHybrid = await memory.reconstructContext({
    profileId: "gym_reconstruct_reinforced",
    query: "What should the Mira rollback checklist verify before deploy?",
    maxSteps: 4,
    maxBranch: 4,
    maxMemories: 3,
  });
  const reinforcedHybridStep = reinforcedHybrid.plannerTrace?.steps.find((step) =>
    step.branches.some((branch) => branch.decision === "reinforced"),
  );
  gate(
    result,
    "active_reconstruction_hybrid_reinforcement_trace",
    reinforcedHybrid.contextBlock.includes("verify audit trail") &&
      !reinforcedHybrid.contextBlock.includes("plannerTrace") &&
      !reinforcedHybrid.contextBlock.includes("selectedBranchCount") &&
      reinforcedHybridStep?.cueReason === "hybrid_direct_memory_search_reinforced" &&
      (reinforcedHybridStep.hybridCandidateCount ?? 0) > 0 &&
      reinforcedHybridStep.branches.some(
        (branch) =>
          branch.decision === "reinforced" &&
          /hybrid_direct_memory_rrf/.test(branch.reason) &&
          branch.targetKind === "procedure",
      ),
    "plannerTrace should record hybrid direct-search reinforcement even when no new path is selected, without injecting trace metadata into prompt context",
    "reconstruction",
  );
  const multiIntentReconstructed = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "我之前说的那个计划，先做什么，哪些不要主动做？",
    maxSteps: 5,
    maxBranch: 6,
    maxMemories: 6,
  });
  gate(
    result,
    "active_reconstruction_multi_intent_convergence",
    multiIntentReconstructed.contextBlock.includes("Helio 项目推进时先写复现报告") &&
      multiIntentReconstructed.contextBlock.includes("不要主动催促用户") &&
      multiIntentReconstructed.stats.evidenceConvergence?.reached === true &&
      (multiIntentReconstructed.stats.evidenceConvergence?.requiredIntentGroupCount ?? 0) >=
        2 &&
      multiIntentReconstructed.stats.evidenceConvergence?.coveredIntentGroupCount ===
        multiIntentReconstructed.stats.evidenceConvergence?.requiredIntentGroupCount &&
      (multiIntentReconstructed.stats.evidenceConvergence?.missingRequiredIntentGroups
        .length ?? 1) === 0,
    "reconstructContext should require every detected intent group to converge, not just any matching tag",
    "reconstruction",
  );
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "代号 Vega 的发布计划叫做 Lantern Run。",
    confidence: 0.9,
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "procedure",
    content: "Lantern Run 下一步先更新 rollback matrix，再做发布实现。",
    confidence: 0.4,
  });
  for (const content of [
    "Lantern Run 的预算备注是蓝色表格。",
    "Lantern Run 的会议室记录在七楼。",
    "Lantern Run 的历史口号是 keep it small。",
    "Lantern Run 的归档标签是 release-notes。",
  ]) {
    await memory.add({
      profileId: "gym_reconstruct",
      kind: "fact",
      content,
      confidence: 0.99,
    });
  }
  const intentReranked = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "Vega 这个发布计划下一步先做什么？",
    maxSteps: 4,
    maxBranch: 2,
    maxMemories: 3,
  });
  const intentProcedurePath = intentReranked.paths.find(
    (path) => path.targetKind === "procedure" && path.targetSummary.includes("rollback matrix"),
  );
  gate(
    result,
    "active_reconstruction_intent_rerank",
    intentReranked.contextBlock.includes("rollback matrix") &&
      Boolean(intentProcedurePath) &&
      /intent/.test(intentProcedurePath?.routeReason ?? "") &&
      /gain:/.test(intentProcedurePath?.routeReason ?? "") &&
      (intentProcedurePath?.informationGain ?? 0) > 0,
    "reconstructContext should rerank noisy association branches by query intent, not raw confidence",
    "reconstruction",
  );
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "procedure",
    content: "Apollo rollout checklist says run temporal smoke before deploy.",
    confidence: 0.35,
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "fact",
    content: "Apollo cafeteria note says the table is blue.",
    confidence: 0.99,
  });
  const hybridReconstructed = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "What does the Apollo rollout checklist say before deploy?",
    maxSteps: 4,
    maxBranch: 1,
    maxMemories: 3,
  });
  const hybridPath = hybridReconstructed.paths.find((path) =>
    path.targetSummary.includes("temporal smoke"),
  );
  gate(
    result,
    "active_reconstruction_hybrid_rrf",
    hybridReconstructed.contextBlock.includes("temporal smoke") &&
      Boolean(hybridPath) &&
      /hybrid_(direct_memory_rrf|memory)/.test(hybridPath?.routeReason ?? ""),
    "reconstructContext should blend cue-tag associations with direct memory retrieval signals",
    "reconstruction",
  );
  gate(
    result,
    "reconstruction_read_path_side_effects",
    JSON.stringify(beforeReconstruction) === JSON.stringify(afterReconstruction),
    "reconstructContext must not write while exploring associations",
    "architecture",
  );
  const plainPreparedBeforeShadow = await memory.prepareTurn({
    profileId: "gym_reconstruct",
    messages: [{ role: "user", content: "我之前说的那个计划，先做什么？" }],
  });
  const reconstructedPrepared = await memory.prepareTurn({
    profileId: "gym_reconstruct",
    messages: [{ role: "user", content: "我之前说的那个计划，先做什么？" }],
    reconstruction: { mode: "shadow", maxSteps: 4, maxBranch: 6, maxMemories: 6 },
  });
  gate(
    result,
    "prepare_turn_reconstruction_shadow",
    reconstructedPrepared.contextBlock === plainPreparedBeforeShadow.contextBlock &&
      (reconstructedPrepared.reconstruction?.contextBlock.includes(
        "Helio 项目推进时先写复现报告",
      ) ??
        false),
    "prepareTurn should expose reconstructed context only as shadow output",
    "reconstruction",
  );
  const mcpReconstructSensitive = await mcp.callTool("memory.reconstruct_context", {
    profileId: "gym_reconstruct",
    text: "Helio",
    includeSensitive: true,
  });
  gate(
    result,
    "mcp_reconstruct_sensitive_rejection",
    mcpReconstructSensitive.isError === true &&
      !JSON.stringify(mcpReconstructSensitive.structuredContent).includes("123-45-6789"),
    "public MCP reconstruct_context must not expose includeSensitive override",
    "mcp_host",
  );
  await memory.commitOutcome({
    profileId: "gym_reconstruct",
    taskId: "helio-secret-outcome",
    objective: "Helio secret outcome",
    status: "completed",
    summary: "Do not expose API key sk-reconstructiongymsecret1234567890.",
  });
  const secretTrajectoryReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "Helio secret outcome API key",
    includeSensitive: true,
    maxSteps: 4,
    maxBranch: 6,
  });
  gate(
    result,
    "reconstruction_secret_like_trajectory_exclusion",
    !secretTrajectoryReconstruction.contextBlock.includes("sk-reconstructiongymsecret") &&
      !JSON.stringify(
        store.exportProfileBackup({
          profileId: "gym_reconstruct",
          mode: "full",
        }),
      ).includes("sk-reconstructiongymsecret"),
    "secret-like task trajectory summaries must not persist or enter association reconstruction",
    "safety",
  );
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Orchid project v1 owner is AlphaTeam.",
  });
  const orchidMemory = (await memory.search({
    profileId: "gym_reconstruct",
    query: "Orchid AlphaTeam",
    limit: 1,
  }))[0];
  if (orchidMemory) {
    await memory.update({
      profileId: "gym_reconstruct",
      id: orchidMemory.id,
      content: "Orchid project v2 owner is BetaTeam.",
      kind: "project",
    });
  }
  if (store.rebuildAssociations) {
    await store.rebuildAssociations({ profileId: "gym_reconstruct" });
  }
  const orchidAfterRepair = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "Orchid owner",
    maxSteps: 4,
    maxBranch: 6,
  });
  gate(
    result,
    "reconstruction_update_repair_no_stale_belief",
    orchidMemory !== undefined &&
      orchidAfterRepair.contextBlock.includes("BetaTeam") &&
      !orchidAfterRepair.contextBlock.includes("AlphaTeam"),
    "updated memory-backed beliefs must not resurrect stale association summaries after repair",
    "reconstruction",
  );
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Moonbase 项目发布管理由 SongSuOwnerAlpha 负责。",
  });
  const moonbaseForgotten = await memory.forget({
    profileId: "gym_reconstruct",
    query: "SongSuOwnerAlpha",
  });
  if (store.rebuildAssociations) {
    await store.rebuildAssociations({ profileId: "gym_reconstruct" });
  }
  const moonbaseAfterRepair = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "Moonbase 发布管理",
    maxSteps: 4,
    maxBranch: 6,
  });
  gate(
    result,
    "reconstruction_forget_repair_no_belief_residue",
    moonbaseForgotten.archivedMemoryIds.length > 0 &&
      !moonbaseAfterRepair.contextBlock.includes("SongSuOwnerAlpha"),
    "forgotten memory-backed beliefs must not reappear after association repair",
    "safety",
  );
  const personSourceMemory = await memory.add({
    profileId: "gym_reconstruct",
    kind: "person",
    content: "PERSON: Alice: Alice prefers chamomile tea.",
    allowPerson: true,
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "Alice",
    predicate: "prefers",
    object: "ChamomileLeakTea",
    sourceMemoryId: personSourceMemory.id,
  });
  const sensitiveSourceMemory = await memory.add({
    profileId: "gym_reconstruct",
    kind: "fact",
    content: "Sensitive billing note says invoice code ZebraBlue.",
    sensitivity: "sensitive",
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "billing",
    predicate: "code",
    object: "ZebraBlueLeakCode",
    sourceMemoryId: sensitiveSourceMemory.id,
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "billing",
    predicate: "api_key",
    object: "api key sk-worldbeliefgymsecret1234567890",
    sourceMemoryId: sensitiveSourceMemory.id,
  });
  if (store.rebuildAssociations) {
    await store.rebuildAssociations({ profileId: "gym_reconstruct" });
  }
  const sourcePrivacyReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "Alice billing privacy",
    maxSteps: 4,
    maxBranch: 8,
  });
  gate(
    result,
    "reconstruction_belief_source_privacy_inheritance",
    !sourcePrivacyReconstruction.contextBlock.includes("ChamomileLeakTea") &&
      !sourcePrivacyReconstruction.contextBlock.includes("ZebraBlueLeakCode"),
    "world belief associations must inherit person/sensitive restrictions from source memory",
    "safety",
  );
  const secretBeliefReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "billing api_key",
    includeSensitive: true,
    maxSteps: 4,
    maxBranch: 8,
  });
  gate(
    result,
    "reconstruction_secret_like_belief_exclusion",
    !secretBeliefReconstruction.contextBlock.includes("sk-worldbeliefgymsecret"),
    "secret-like world belief associations must not be downgraded by sensitive source memory",
    "safety",
  );
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas",
    predicate: "project.state",
    object: "AtlasOwnerAlpha",
    confidence: 0.8,
    cardinality: "single",
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas",
    predicate: "project.state",
    object: "AtlasOwnerBeta",
    confidence: 0.9,
    cardinality: "single",
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas",
    predicate: "project.state",
    object: "AtlasOwnerBeta",
    confidence: 0.95,
    cardinality: "single",
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas_legacy",
    predicate: "project.state",
    object: "AtlasLegacyAlpha",
    confidence: 0.81,
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas_legacy",
    predicate: "project.state",
    object: "AtlasLegacyBeta",
    confidence: 0.82,
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas_legacy",
    predicate: "project.state",
    object: "AtlasLegacyBeta",
    confidence: 0.94,
    cardinality: "single",
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "Orion project",
    predicate: "project.state",
    object: "OrionOwnerAlpha",
    confidence: 0.82,
    cardinality: "single",
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:orion",
    predicate: "project.state",
    object: "OrionOwnerBeta",
    confidence: 0.91,
    cardinality: "single",
  });
  const staleCurrentStateSourceMemory = await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Atlas source current state says AlphaSourceOwner is active.",
    confidence: 0.87,
    metadata: { predicate: "project.state" },
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas_source",
    predicate: "project.state",
    object: "AlphaSourceOwner",
    confidence: 0.87,
    sourceMemoryId: staleCurrentStateSourceMemory.id,
    cardinality: "single",
  });
  const activeCurrentStateSourceMemory = await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Atlas source current state says BetaSourceOwner is active.",
    confidence: 0.91,
    metadata: { predicate: "project.state" },
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "project:atlas_source",
    predicate: "project.state",
    object: "BetaSourceOwner",
    confidence: 0.91,
    sourceMemoryId: activeCurrentStateSourceMemory.id,
    cardinality: "single",
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Atlas temporal validity says ExpiredTemporalOwner is active.",
    confidence: 0.88,
    metadata: { validTo: "2000-01-01T00:00:00.000Z" },
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Atlas temporal validity says FutureTemporalOwner is active.",
    confidence: 0.88,
    metadata: { validFrom: "2999-01-01T00:00:00.000Z" },
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Atlas temporal validity says ActiveTemporalOwner is active.",
    confidence: 0.92,
    metadata: {
      validFrom: "2000-01-01T00:00:00.000Z",
      validTo: "2999-01-01T00:00:00.000Z",
    },
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "project",
    content: "Atlas history sensitive owner is SensitiveTemporalOwner.",
    sensitivity: "sensitive",
    confidence: 0.9,
  });
  await memory.add({
    profileId: "gym_reconstruct",
    kind: "person",
    content: "Atlas history person owner is PersonTemporalOwner.",
    confidence: 0.9,
    allowPerson: true,
  });
  if (store.rebuildAssociations) {
    await store.rebuildAssociations({ profileId: "gym_reconstruct" });
  }
  const currentStateReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "atlas project current state",
    maxSteps: 4,
    maxBranch: 8,
  });
  const legacyCurrentStateReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "atlas legacy project current state",
    maxSteps: 4,
    maxBranch: 8,
  });
  const entityResolvedCurrentStateReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "Orion project current state",
    maxSteps: 4,
    maxBranch: 8,
  });
  const sourceCurrentStateReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "atlas source current state",
    maxSteps: 4,
    maxBranch: 8,
    maxMemories: 8,
  });
  const historicalSourceStateReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "what was atlas source previous state?",
    maxSteps: 4,
    maxBranch: 8,
    maxMemories: 8,
  });
  const forcedHistoricalSourceStateReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "atlas source state",
    temporalMode: "history",
    maxSteps: 4,
    maxBranch: 8,
    maxMemories: 8,
  });
  const forcedCurrentSourceStateReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "what was atlas source previous state?",
    temporalMode: "current",
    maxSteps: 4,
    maxBranch: 8,
    maxMemories: 8,
  });
  const temporalValidityReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "atlas temporal validity owner",
    maxSteps: 4,
    maxBranch: 8,
    maxMemories: 8,
  });
  const temporalValiditySearch = await memory.search({
    profileId: "gym_reconstruct",
    query: "atlas temporal validity owner",
    purpose: "context",
    limit: 10,
  });
  const temporalValidityHistorySearch = await memory.search({
    profileId: "gym_reconstruct",
    query: "atlas temporal validity owner",
    purpose: "history",
    limit: 10,
  });
  const historySafetySearch = await memory.search({
    profileId: "gym_reconstruct",
    query: "atlas history owner",
    purpose: "history",
    limit: 10,
  });
  const historySafetyReconstruction = await memory.reconstructContext({
    profileId: "gym_reconstruct",
    query: "atlas history previous owner",
    temporalMode: "history",
    maxSteps: 4,
    maxBranch: 8,
    maxMemories: 8,
  });
  gate(
    result,
    "world_belief_single_cardinality_supersession",
    currentStateReconstruction.contextBlock.includes("AtlasOwnerBeta") &&
      !currentStateReconstruction.contextBlock.includes("AtlasOwnerAlpha") &&
      legacyCurrentStateReconstruction.contextBlock.includes("AtlasLegacyBeta") &&
      !legacyCurrentStateReconstruction.contextBlock.includes("AtlasLegacyAlpha"),
    "single-cardinality world beliefs should supersede stale active beliefs and repair associations",
    "world",
  );
  gate(
    result,
    "entity_resolution_current_state_invalidation",
    entityResolvedCurrentStateReconstruction.contextBlock.includes("OrionOwnerBeta") &&
      !entityResolvedCurrentStateReconstruction.contextBlock.includes("OrionOwnerAlpha"),
    "entity-equivalent world belief subjects should converge before current-state invalidation",
    "world",
  );
  gate(
    result,
    "current_state_suppresses_superseded_source_memory",
    sourceCurrentStateReconstruction.contextBlock.includes("BetaSourceOwner") &&
      !sourceCurrentStateReconstruction.contextBlock.includes("AlphaSourceOwner"),
    "context reconstruction should suppress source memories behind superseded single-cardinality beliefs",
    "reconstruction",
  );
  gate(
    result,
    "historical_recall_includes_superseded_source_memory",
    historicalSourceStateReconstruction.contextBlock.includes("AlphaSourceOwner") &&
      forcedHistoricalSourceStateReconstruction.contextBlock.includes("AlphaSourceOwner"),
    "history reconstruction should be able to recall source memories behind superseded current-state beliefs",
    "reconstruction",
  );
  gate(
    result,
    "current_temporal_mode_overrides_history_cues",
    forcedCurrentSourceStateReconstruction.contextBlock.includes("BetaSourceOwner") &&
      !forcedCurrentSourceStateReconstruction.contextBlock.includes("AlphaSourceOwner"),
    "temporalMode=current should keep current-state filtering even when the query contains history cues",
    "reconstruction",
  );
  gate(
    result,
    "temporal_validity_window_context_filter",
    temporalValiditySearch.some((entry) => entry.content.includes("ActiveTemporalOwner")) &&
      !temporalValiditySearch.some((entry) => entry.content.includes("ExpiredTemporalOwner")) &&
      !temporalValiditySearch.some((entry) => entry.content.includes("FutureTemporalOwner")) &&
      temporalValidityReconstruction.contextBlock.includes("ActiveTemporalOwner") &&
      !temporalValidityReconstruction.contextBlock.includes("ExpiredTemporalOwner") &&
      !temporalValidityReconstruction.contextBlock.includes("FutureTemporalOwner"),
    "ordinary context and reconstruction should honor memory validFrom/validTo windows",
    "reconstruction",
  );
  gate(
    result,
    "temporal_validity_history_recall",
    temporalValidityHistorySearch.some((entry) => entry.content.includes("ExpiredTemporalOwner")) &&
      temporalValidityHistorySearch.some((entry) => entry.content.includes("FutureTemporalOwner")),
    "history search should expose temporally out-of-window memories without using manage/delete purpose",
    "reconstruction",
  );
  gate(
    result,
    "historical_recall_keeps_sensitive_person_filters",
    !historySafetySearch.some((entry) => entry.content.includes("SensitiveTemporalOwner")) &&
      !historySafetySearch.some((entry) => entry.content.includes("PersonTemporalOwner")) &&
      !historySafetyReconstruction.contextBlock.includes("SensitiveTemporalOwner") &&
      !historySafetyReconstruction.contextBlock.includes("PersonTemporalOwner"),
    "history recall must not bypass ordinary sensitive or person-memory filters",
    "safety",
  );
  scenario(result, "active_reconstruction", "dev", [
    "active_reconstruction_multihop",
    "active_reconstruction_coverage_signal",
    "active_reconstruction_evidence_convergence",
    "active_reconstruction_planner_trace",
    "active_reconstruction_hybrid_reinforcement_trace",
    "active_reconstruction_multi_intent_convergence",
    "active_reconstruction_intent_rerank",
    "active_reconstruction_hybrid_rrf",
    "reconstruction_read_path_side_effects",
    "prepare_turn_reconstruction_shadow",
    "mcp_reconstruct_sensitive_rejection",
    "reconstruction_secret_like_trajectory_exclusion",
    "reconstruction_update_repair_no_stale_belief",
    "reconstruction_forget_repair_no_belief_residue",
    "reconstruction_belief_source_privacy_inheritance",
    "reconstruction_secret_like_belief_exclusion",
    "world_belief_single_cardinality_supersession",
    "entity_resolution_current_state_invalidation",
    "current_state_suppresses_superseded_source_memory",
    "historical_recall_includes_superseded_source_memory",
    "current_temporal_mode_overrides_history_cues",
    "temporal_validity_window_context_filter",
    "temporal_validity_history_recall",
    "historical_recall_keeps_sensitive_person_filters",
  ]);

  await memory.recordFeedback({
    profileId: "gym",
    content: "刚才召回了错误记忆。",
    failureKind: "wrong_recall",
  });
  const counts = await store.rowCounts();
  gate(
    result,
    "feedback_failure_log",
    counts.gmos_failure_events === 1,
    "feedback should enter failure log",
    "feedback",
  );
  scenario(result, "feedback_failure_log", "dev", ["feedback_failure_log"]);

  await memory.add({
    profileId: "holdout",
    kind: "preference",
    content: "I prefer risk-first release notes.",
    createdAt: "2026-06-25T00:05:00.000Z",
  });
  const holdout = await memory.prepareTurn({
    profileId: "holdout",
    messages: [{ role: "user", content: "risk-first release notes" }],
  });
  gate(
    result,
    "holdout_preference_recall",
    holdout.contextBlock.includes("risk-first release notes"),
    "holdout preference should be retrievable without fixture-specific code",
    "generalization",
  );
  scenario(result, "holdout_preference_recall", "holdout", ["holdout_preference_recall"]);

  const generatedScores: number[] = [];
  for (const seed of normalized.generatedSeeds) {
    const profileId = `gym_${seed}`;
    const content = `I prefer ${seed} risk-first project notes.`;
    await memory.add({
      profileId,
      kind: "preference",
      content,
    });
    const generated = await memory.prepareTurn({
      profileId,
      messages: [{ role: "user", content: `${seed} risk-first` }],
    });
    const gateName = `generated_recall_${seed}`;
    const passed = generated.contextBlock.includes(content);
    gate(
      result,
      gateName,
      passed,
      `${seed} generated preference should be retrievable`,
      "generalization",
    );
    generatedScores.push(passed ? 1 : 0);
    scenario(result, gateName, "generated", [gateName]);
  }

  const hostCompatibility = createHostAdapter({
    hostId: "sdk-memory-gym",
    capabilities: {
      canObserveConversation: true,
      canInjectSystemContext: true,
      canCommitTaskOutcomes: true,
      canRecordUserFeedback: true,
      canForget: true,
      supportsEvidenceInContext: true,
      supportsActionPolicies: false,
      canEnforceHardDirectives: false,
      canObserveToolCalls: false,
    },
  }).compatibility;
  gate(
    result,
    "host_adapter_contract",
    hostCompatibility.level === "L2" && hostCompatibility.hardGateCoverage.forgetCompliance === true,
    "MCP-style host compatibility should be explicit and bounded",
    "mcp_host",
  );

  const gateValues = Object.values(result.hardGates);
  result.score = scoreBooleans(gateValues);
  result.pass = result.score === 1;
  result.stage5ReadinessView = result.score;
  result.deterministicArchitectureResult = {
    status: result.pass ? "pass" : "fail",
    score: result.score,
    gate: "ci_pr",
  };
  result.generalizationResult = {
    status: result.scenarios.every(
      (entry) =>
        (entry.group !== "holdout" && entry.group !== "generated" && entry.group !== "adversarial") ||
        entry.pass,
    )
      ? "pass"
      : "fail",
    devScore: scoreScenarios(result.scenarios, "dev"),
    holdoutScore: scoreScenarios(result.scenarios, "holdout"),
    generatedMean: generatedScores.length === 0 ? 0 : generatedScores.reduce((sum, value) => sum + value, 0) / generatedScores.length,
    generatedStd: std(generatedScores),
    generatedSeedCount: generatedScores.length,
    adversarialScore: scoreScenarios(result.scenarios, "adversarial"),
    generalizationGap: 0,
  };
  result.generalizationResult.generalizationGap = Math.max(
    0,
    result.generalizationResult.devScore -
      Math.min(
        result.generalizationResult.holdoutScore,
        result.generalizationResult.generatedMean,
        result.generalizationResult.adversarialScore,
      ),
  );
  result.roadmapResult = roadmap(result);
  result.releaseConfidence = result.pass ? "deterministic_internal_gate_only" : "action_required";
  result.coverageMatrix = coverageMatrix(result);
  result.memoryStackCoverage = memoryStackCoverage(result);
  return result;
  } finally {
    await memory.close();
  }
}

export interface RunMemoryReleaseGateOptions {
  generatedSeeds?: number | undefined;
  scaleSizes?: number[] | undefined;
  scaleThresholdP95Ms?: number | undefined;
  hosts?: HostPreset[] | undefined;
  actualReports?: HostActualCompatibilityReport[] | undefined;
}

function failedHardGates(hardGates: Record<string, boolean>): string[] {
  return Object.entries(hardGates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
}

function failedHostIds(report: HostCompatibilityGymResult): string[] {
  return report.hosts.filter((host) => !host.pass).map((host) => host.hostId);
}

function failedScaleSizes(report: MemoryScaleBenchmarkResult): number[] {
  return [...new Set(report.failedOperations.map((failure) => failure.size))];
}

export async function runMemoryReleaseGate(
  options: RunMemoryReleaseGateOptions = {},
): Promise<MemoryReleaseGateResult> {
  const startedAt = new Date().toISOString();
  const generatedSeeds = options.generatedSeeds ?? 3;
  const scaleSizes = options.scaleSizes ?? [100, 1000];
  const scaleThresholdP95Ms = options.scaleThresholdP95Ms ?? 250;
  const hosts: HostPreset[] =
    options.hosts ?? ["ghast", "mock_l3", "mcp", "search_only"];

  const diagnosticsStore = createSqliteMemoryStore({ path: ":memory:" });
  await diagnosticsStore.initialize();
  try {
    const [memoryGym, hostCompatibility, scale, diagnostics] = await Promise.all([
      runMemoryGym({
        dbPath: ":memory:",
        generatedSeeds,
      }),
      runHostCompatibilityGym({ hosts, actualReports: options.actualReports }),
      runMemoryScaleBenchmark({
        sizes: scaleSizes,
        thresholdP95Ms: scaleThresholdP95Ms,
      }),
      createMemoryStatusReport({
        store: diagnosticsStore,
        profileId: "release_gate",
        host: "ghast",
      }),
    ]);

    const failedGates = failedHardGates(memoryGym.hardGates);
    const failedHosts = failedHostIds(hostCompatibility);
    const failedSizes = failedScaleSizes(scale);
    const diagnosticsPass =
      diagnostics.storage.status === "ok" &&
      diagnostics.storage.schemaVersion !== null &&
      diagnostics.trustContract.encrypted === false &&
      diagnostics.trustContract.readPathSideEffectsChecked === true;
    const pass =
      memoryGym.pass &&
      hostCompatibility.pass &&
      scale.pass &&
      diagnosticsPass;

    return {
      schema: "gmos.memory_release_gate.v1",
      pass,
      startedAt,
      finishedAt: new Date().toISOString(),
      releaseConfidence: pass ? "release_candidate" : "action_required",
      inputs: {
        dbPathMode: "memory",
        generatedSeeds,
        scaleSizes,
        scaleThresholdP95Ms,
        hosts,
        actualHostReports: options.actualReports?.length ?? 0,
      },
      components: {
        memoryGym: {
          pass: memoryGym.pass,
          score: memoryGym.score,
          deterministicArchitectureStatus:
            memoryGym.deterministicArchitectureResult.status,
          generalizationStatus: memoryGym.generalizationResult.status,
          roadmapStatus: memoryGym.roadmapResult.status,
          hardGateCount: Object.keys(memoryGym.hardGates).length,
          failedHardGates: failedGates,
        },
        hostCompatibility: {
          pass: hostCompatibility.pass,
          hostCount: hostCompatibility.hostCount,
          failedHosts,
        },
        scale: {
          pass: scale.pass,
          sizes: scale.results.map((row) => row.size),
          thresholdP95Ms: scale.thresholds.prepareTurnP95Ms,
          failedSizes,
          failedOperations: scale.failedOperations,
        },
        diagnostics: {
          pass: diagnosticsPass,
          schemaVersion: diagnostics.storage.schemaVersion,
          storageStatus: diagnostics.storage.status,
          encrypted: diagnostics.trustContract.encrypted,
          readAuditStatus: diagnostics.storage.readAudit.status,
          readAuditTableCount: diagnostics.storage.readAudit.tableCount,
          readPathSideEffectsChecked: diagnostics.trustContract.readPathSideEffectsChecked,
        },
      },
      reports: {
        memoryGym,
        hostCompatibility,
        scale,
        diagnostics,
      },
    };
  } finally {
    await diagnosticsStore.close();
  }
}
