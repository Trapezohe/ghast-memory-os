import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createMemoryStatusReport } from "../diagnostics/index.js";
import {
  createEvolutionControlPlane,
  EvolutionApplicationError,
} from "../evolution/index.js";
import { createHostAdapter } from "../host/index.js";
import { ingestTranscript, runAutopilot } from "../autopilot.js";
import type { HostActualCompatibilityReport, HostPreset } from "../host/index.js";
import type { EntityResolver } from "../kernel/entities.js";
import { createMemoryMcpServer } from "../mcp/index.js";
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
import { coverageMatrix, memoryStackCoverage, roadmap } from "./coverage.js";
import {
  EXTERNAL_MEMORY_BENCHMARK_SCORE_SEMANTICS,
  parseExternalMemoryBenchmarkJsonl,
  parseExternalMemoryBenchmarkCheckpoint,
  parseExternalMemoryBenchmarkCheckpointJsonl,
  hashExternalMemoryBenchmarkInput,
  runExternalMemoryBenchmark,
  writeExternalMemoryBenchmarkReproductionBundle,
  createOpenAICompatibleExternalBenchmarkAnswerer,
  createOpenAICompatibleExternalBenchmarkJudge,
  createExternalMemoryBenchmarkCheckpointEntry,
  ExternalMemoryBenchmarkProviderError,
  type ExternalMemoryBenchmarkAnswerer,
  type ExternalMemoryBenchmarkAnswererProvenance,
  type ExternalMemoryBenchmarkDatasetFormat,
  type ExternalMemoryBenchmarkDiagnosticsLevel,
  type ExternalMemoryBenchmarkCase,
  type ExternalMemoryBenchmarkCheckpointContract,
  type ExternalMemoryBenchmarkCheckpointEntry,
  type ExternalMemoryBenchmarkCheckpointManifest,
  type ExternalMemoryBenchmarkCheckpointOptions,
  type ExternalMemoryBenchmarkCaseGroupProgress,
  type ExternalMemoryBenchmarkCaseMatched,
  type ExternalMemoryBenchmarkCaseResult,
  type ExternalMemoryBenchmarkCaseTiming,
  type ExternalMemoryBenchmarkCeilingMetrics,
  type ExternalMemoryBenchmarkCounter,
  type ExternalMemoryBenchmarkEvent,
  type ExternalMemoryBenchmarkFailureSample,
  type ExternalMemoryBenchmarkFailureStage,
  type ExternalMemoryBenchmarkFailureTaxonomyEntry,
  type ExternalMemoryBenchmarkGroupTiming,
  type ExternalMemoryBenchmarkIngestMode,
  type ExternalMemoryBenchmarkIngestProgress,
  type ExternalMemoryBenchmarkIntelligence,
  type ExternalMemoryBenchmarkIntelligenceConfig,
  type ExternalMemoryBenchmarkJudge,
  type ExternalMemoryBenchmarkJudgeProfile,
  type ExternalMemoryBenchmarkJudgeProvenance,
  type ExternalMemoryBenchmarkJudgeResult,
  type ExternalMemoryBenchmarkMode,
  type ExternalMemoryBenchmarkProtocol,
  type ExternalMemoryBenchmarkProviderStage,
  type ExternalMemoryBenchmarkResult,
  type ExternalMemoryBenchmarkRunManifest,
  type ExternalMemoryBenchmarkRuntimeAnswererManifest,
  type ExternalMemoryBenchmarkRuntimeIngestGroupManifest,
  type ExternalMemoryBenchmarkRuntimeIntelligenceManifest,
  type ExternalMemoryBenchmarkRuntimeQueryPlannerManifest,
  type ExternalMemoryBenchmarkRuntimeSessionDistillationManifest,
  type ExternalMemoryBenchmarkOpenAICompatibleHookOptions,
  type ExternalMemoryBenchmarkOpenAICompatibleJudgeOptions,
  type ExternalMemoryBenchmarkOfficialFailureAttribution,
  type ExternalMemoryBenchmarkOfficialFailureAttributionStage,
  type ExternalMemoryBenchmarkReproductionBundleOptions,
  type ExternalMemoryBenchmarkReproductionBundleResult,
  type ExternalMemoryBenchmarkScoreAttributionArea,
  type ExternalMemoryBenchmarkScoreSemantics,
  type ExternalMemoryBenchmarkStopReason,
  type ExternalMemoryBenchmarkSliceSpec,
  type ExternalMemoryBenchmarkSliceScore,
  type ExternalMemoryBenchmarkSummary,
  type RunExternalMemoryBenchmarkOptions,
  type ParsedExternalMemoryBenchmarkCheckpointJsonl,
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
  runExperienceHorizonGym,
  type MemoryGymExperienceHorizonReport,
} from "./experience-horizon.js";
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
  parseExternalMemoryBenchmarkCheckpoint,
  parseExternalMemoryBenchmarkCheckpointJsonl,
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
  writeExternalMemoryBenchmarkReproductionBundle,
  createOpenAICompatibleExternalBenchmarkAnswerer,
  createOpenAICompatibleExternalBenchmarkJudge,
  createExternalMemoryBenchmarkCheckpointEntry,
  ExternalMemoryBenchmarkProviderError,
  runExternalMemoryBenchmarkSuite,
  runExperienceHorizonGym,
  runHostCompatibilityGym,
};
export type {
  BuildStateBenchLearningsOptions,
  PrepareStateBenchAgentLearningRunOptions,
  ExternalMemoryBenchmarkAnswerer,
  ExternalMemoryBenchmarkAnswererProvenance,
  ExternalMemoryBenchmarkDatasetAdapter,
  ExternalMemoryBenchmarkDatasetFormat,
  ExternalMemoryBenchmarkDiagnosticsLevel,
  ExternalMemoryBenchmarkCase,
  ExternalMemoryBenchmarkCheckpointContract,
  ExternalMemoryBenchmarkCheckpointEntry,
  ExternalMemoryBenchmarkCheckpointManifest,
  ExternalMemoryBenchmarkCheckpointOptions,
  ExternalMemoryBenchmarkCaseGroupProgress,
  ExternalMemoryBenchmarkCaseMatched,
  ExternalMemoryBenchmarkCaseResult,
  ExternalMemoryBenchmarkCaseTiming,
  ExternalMemoryBenchmarkCeilingMetrics,
  ExternalMemoryBenchmarkCounter,
  ExternalMemoryBenchmarkEvent,
  ExternalMemoryBenchmarkFailureSample,
  ExternalMemoryBenchmarkFailureStage,
  ExternalMemoryBenchmarkFailureTaxonomyEntry,
  ExternalMemoryBenchmarkGroupTiming,
  ExternalMemoryBenchmarkIngestMode,
  ExternalMemoryBenchmarkIngestProgress,
  ExternalMemoryBenchmarkIntelligence,
  ExternalMemoryBenchmarkIntelligenceConfig,
  ExternalMemoryBenchmarkJudge,
  ExternalMemoryBenchmarkJudgeProfile,
  ExternalMemoryBenchmarkJudgeProvenance,
  ExternalMemoryBenchmarkJudgeResult,
  ExternalMemoryBenchmarkMode,
  ExternalMemoryBenchmarkProtocol,
  ExternalMemoryBenchmarkProviderStage,
  ExternalMemoryBenchmarkResult,
  ExternalMemoryBenchmarkRunManifest,
  ExternalMemoryBenchmarkRuntimeAnswererManifest,
  ExternalMemoryBenchmarkRuntimeIngestGroupManifest,
  ExternalMemoryBenchmarkRuntimeIntelligenceManifest,
  ExternalMemoryBenchmarkRuntimeQueryPlannerManifest,
  ExternalMemoryBenchmarkRuntimeSessionDistillationManifest,
  ExternalMemoryBenchmarkOpenAICompatibleHookOptions,
  ExternalMemoryBenchmarkOpenAICompatibleJudgeOptions,
  ExternalMemoryBenchmarkOfficialFailureAttribution,
  ExternalMemoryBenchmarkOfficialFailureAttributionStage,
  ExternalMemoryBenchmarkReproductionBundleOptions,
  ExternalMemoryBenchmarkReproductionBundleResult,
  ExternalMemoryBenchmarkScoreAttributionArea,
  ExternalMemoryBenchmarkScoreSemantics,
  ExternalMemoryBenchmarkStopReason,
  ExternalMemoryBenchmarkSliceSpec,
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
  MemoryGymExperienceHorizonReport,
  ParsedExternalMemoryBenchmarkDataset,
  ParsedExternalMemoryBenchmarkCheckpointJsonl,
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
    recallQuality: {
      schema: "gmos.recall_quality.v1",
      fixtureGroups: [],
    },
    experienceHorizon: {
      schema: "gmos.experience_horizon.v1",
      pass: false,
      deterministicReplayPass: false,
      scenarios: [],
      counters: {},
    },
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

interface GymEmbeddingProvider {
  name: string;
  dimensions: number;
  calls: string[][];
  failNext: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

function createGymEmbeddingProvider(name = "gym-semantic-stub-v1"): GymEmbeddingProvider {
  const provider: GymEmbeddingProvider = {
    name,
    dimensions: 4,
    calls: [],
    failNext: false,
    async embed(texts: string[]): Promise<number[][]> {
      provider.calls.push([...texts]);
      if (provider.failNext) {
        provider.failNext = false;
        throw new Error("deterministic gym embedding failure");
      }
      return texts.map(gymEmbeddingVector);
    },
  };
  return provider;
}

function gymEmbeddingVector(text: string): number[] {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("zephyr shuttle") ||
    normalized.includes("launch transport") ||
    normalized.includes("semantic recall target")
  ) {
    return [1, 0, 0, 0];
  }
  if (normalized.includes("reranker alpha")) return [0, 1, 0, 0];
  if (normalized.includes("reranker beta")) return [0, 0.9, 0.1, 0];
  if (normalized.includes("gate vector")) return [0, 0, 1, 0];
  return [0, 0, 0, 1];
}

function hitRate(hits: number, total: number): number {
  return total === 0 ? 0 : hits / total;
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
  const gymEntityResolver: EntityResolver = (input) => {
    const subject = input.subject.trim();
    const match =
      /^Workspace\s+(.+)$/iu.exec(subject) ??
      /^workspace\s*[:/]\s*(.+)$/iu.exec(subject);
    const rawKey = match?.[1]?.trim();
    if (!rawKey) return undefined;
    const entityKey = rawKey
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    if (!entityKey) return undefined;
    return {
      canonicalSubject: `workspace:${entityKey}`,
      originalSubject: subject,
      entityKind: "workspace",
      entityKey,
      aliases: [subject, rawKey, `workspace:${entityKey}`, ...(input.aliases ?? [])],
    };
  };
  const store = createSqliteMemoryStore({
    path: normalized.dbPath,
    entityResolver: gymEntityResolver,
  });
  const memory = createMemoryOS({ profileId: "gym", store, entityResolver: gymEntityResolver });
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

  await memory.add({
    profileId: "gym",
    kind: "boundary",
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

  const gymTranscript = `${JSON.stringify({
    role: "user",
    content: "Gym autopilot marker uses the silver checklist.",
    createdAt: "2026-06-25T00:03:30.000Z",
  })}\n`;
  const gymIngestFirst = await ingestTranscript({
    memory,
    profileId: "gym",
    text: gymTranscript,
    format: "jsonl",
  });
  const gymIngestSecond = await ingestTranscript({
    memory,
    profileId: "gym",
    text: gymTranscript,
    format: "jsonl",
  });
  gate(
    result,
    "ingestion_idempotence",
    gymIngestFirst.observed === 1 &&
      gymIngestSecond.observed === 0 &&
      gymIngestSecond.deduplicated === 1,
    "transcript ingestion should re-run without new evidence writes",
    "autopilot",
  );

  const autopilotDryRunBefore = await store.readAuditSnapshot();
  const autopilotA = await runAutopilot({
    memory,
    store,
    profileId: "gym",
    embedBackfill: false,
    dryRun: true,
    now: "2026-06-25T00:04:00.000Z",
  });
  const autopilotB = await runAutopilot({
    memory,
    store,
    profileId: "gym",
    embedBackfill: false,
    dryRun: true,
    now: "2026-06-25T00:04:00.000Z",
  });
  gate(
    result,
    "autopilot_determinism",
    JSON.stringify(autopilotA) === JSON.stringify(autopilotB),
    "same autopilot inputs and fixed clock should produce the same report",
    "autopilot",
  );
  gate(
    result,
    "autopilot_dry_run_purity",
    JSON.stringify(autopilotDryRunBefore) === JSON.stringify(await store.readAuditSnapshot()),
    "autopilot dry-run should leave store read-audit unchanged",
    "autopilot",
  );
  await runAutopilot({
    memory,
    store,
    profileId: "gym",
    embedBackfill: false,
    now: "2026-06-25T00:04:30.000Z",
  });
  const autopilotEvolutionEvidence = (await memory.listEvidence({
    profileId: "gym",
    limit: 100,
  })).some((event) => event.sourceType.includes("evolution"));
  gate(
    result,
    "autopilot_never_evolves",
    !autopilotEvolutionEvidence,
    "autopilot should not create evolution evidence",
    "autopilot",
  );

  const gymArchivedPresetMemory = await memory.add({
    profileId: "gym",
    kind: "fact",
    content: "GymPresetArchivedMarker should stay hidden.",
  });
  await memory.archive({
    profileId: "gym",
    id: gymArchivedPresetMemory.id,
    reason: "gym preset gate",
  });
  const focusedPreset = await memory.explainTurn({
    profileId: "gym",
    dispositionPreset: "focused",
    messages: [{ role: "user", content: "silver checklist marker?" }],
    reconstruction: { mode: "shadow" },
  });
  const balancedPreset = await memory.explainTurn({
    profileId: "gym",
    dispositionPreset: "balanced",
    messages: [{ role: "user", content: "silver checklist marker?" }],
    reconstruction: { mode: "shadow" },
  });
  const expansivePreset = await memory.explainTurn({
    profileId: "gym",
    dispositionPreset: "expansive",
    messages: [{ role: "user", content: "silver checklist marker?" }],
    reconstruction: { mode: "shadow" },
  });
  const presetGateContexts = await Promise.all(
    (["focused", "balanced", "expansive"] as const).map((preset) =>
      memory.prepareTurn({
        profileId: "gym",
        dispositionPreset: preset,
        messages: [{ role: "user", content: "GymPresetArchivedMarker sk-test1234567890abcdefg" }],
        includeSensitive: true,
      })
    ),
  );
  gate(
    result,
    "disposition_budget_monotonicity",
    focusedPreset.budgets.contextBudgetTokens <= balancedPreset.budgets.contextBudgetTokens &&
      balancedPreset.budgets.contextBudgetTokens <= expansivePreset.budgets.contextBudgetTokens &&
      focusedPreset.budgets.memorySearchLimit <= balancedPreset.budgets.memorySearchLimit &&
      balancedPreset.budgets.memorySearchLimit <= expansivePreset.budgets.memorySearchLimit &&
      (focusedPreset.budgets.planner?.maxMemories ?? 0) <=
        (balancedPreset.budgets.planner?.maxMemories ?? 0) &&
      (balancedPreset.budgets.planner?.maxMemories ?? 0) <=
        (expansivePreset.budgets.planner?.maxMemories ?? 0),
    "focused <= balanced <= expansive budgets",
    "recall",
  );
  gate(
    result,
    "disposition_gates_hold",
    presetGateContexts.every(
      (prepared) =>
        !prepared.contextBlock.includes("GymPresetArchivedMarker") &&
        !prepared.contextBlock.includes("sk-test"),
    ),
    "disposition presets must not loosen archived or secret-like gates",
    "recall",
  );
  scenario(result, "autopilot_and_disposition", "dev", [
    "ingestion_idempotence",
    "autopilot_determinism",
    "autopilot_dry_run_purity",
    "autopilot_never_evolves",
    "disposition_budget_monotonicity",
    "disposition_gates_hold",
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

  const lifecycleProfile = "gym_lifecycle";
  const lifecycleNow = "2026-07-02T00:00:00.000Z";
  const staleMemory = await memory.add({
    profileId: lifecycleProfile,
    kind: "fact",
    content: "LifecycleDormantSignal stale fact should decay.",
    confidence: 0.4,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  await memory.add({
    profileId: lifecycleProfile,
    kind: "boundary",
    content: "LifecycleBoundarySignal should never auto-transition.",
    confidence: 0.4,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  await memory.add({
    profileId: lifecycleProfile,
    kind: "person",
    content: "PERSON: LifecyclePersonSignal should never auto-transition.",
    confidence: 0.4,
    createdAt: "2020-01-01T00:00:00.000Z",
    allowPerson: true,
  });
  const dryRunBefore = await store.readAuditSnapshot();
  const dryRunMaintenance = await memory.maintain({
    profileId: lifecycleProfile,
    dryRun: true,
    now: lifecycleNow,
  });
  const dryRunAfter = await store.readAuditSnapshot();
  gate(
    result,
    "maintenance_dry_run_read_audit_pure",
    dryRunMaintenance.transitions.some(
      (transition) => transition.memoryId === staleMemory.id && transition.to === "dormant",
    ) && JSON.stringify(dryRunBefore) === JSON.stringify(dryRunAfter),
    "dry-run maintain should compute transitions without writes",
    "lifecycle",
  );
  const maintenance = await memory.maintain({
    profileId: lifecycleProfile,
    now: lifecycleNow,
  });
  const secondMaintenance = await memory.maintain({
    profileId: lifecycleProfile,
    now: lifecycleNow,
  });
  const dormantMemories = await memory.list({
    profileId: lifecycleProfile,
    status: "dormant",
    query: "LifecycleDormantSignal",
    limit: 10,
  });
  const lifecyclePrepared = await memory.prepareTurn({
    profileId: lifecycleProfile,
    messages: [{ role: "user", content: "LifecycleDormantSignal" }],
  });
  const lifecycleHistory = await memory.search({
    profileId: lifecycleProfile,
    query: "LifecycleDormantSignal",
    purpose: "history",
    limit: 10,
  });
  const protectedLifecycleMemories = await memory.list({
    profileId: lifecycleProfile,
    status: "active",
    includePerson: true,
    query: "LifecycleBoundarySignal LifecyclePersonSignal",
    limit: 10,
  });
  gate(
    result,
    "lifecycle_decay_to_dormant",
    maintenance.transitions.some(
      (transition) => transition.memoryId === staleMemory.id && transition.to === "dormant",
    ) && dormantMemories.some((entry) => entry.id === staleMemory.id),
    "maintain should transition stale unused memory to dormant",
    "lifecycle",
  );
  gate(
    result,
    "lifecycle_exempts_boundary_and_person",
    protectedLifecycleMemories.some((entry) => entry.kind === "boundary") &&
      protectedLifecycleMemories.some((entry) => entry.kind === "person"),
    "boundary and person memories should not auto-transition by default",
    "lifecycle",
  );
  gate(
    result,
    "dormant_excluded_from_prepare_context",
    !lifecyclePrepared.contextBlock.includes("LifecycleDormantSignal"),
    "dormant memories should be excluded from ordinary prepareTurn context",
    "lifecycle",
  );
  gate(
    result,
    "history_reaches_dormant_memory",
    lifecycleHistory.some((entry) => entry.id === staleMemory.id),
    "history-purpose recall should reach dormant memories",
    "lifecycle",
  );
  gate(
    result,
    "maintenance_idempotent_same_now",
    secondMaintenance.transitions.length === 0,
    "running maintain twice with the same now should not create new transitions",
    "lifecycle",
  );
  const dormantTurnExplanation = await memory.explainTurn({
    profileId: lifecycleProfile,
    messages: [{ role: "user", content: "LifecycleDormantSignal" }],
    maxExcluded: 10,
  });
  gate(
    result,
    "explain_turn_reports_dormant_exclusion",
    dormantTurnExplanation.excluded.some(
      (entry) => entry.id === staleMemory.id && entry.reason === "dormant",
    ),
    "explainTurn should report dormant candidates that ordinary context excludes",
    "explainability",
  );
  const forgottenDormant = await memory.forget({
    profileId: lifecycleProfile,
    query: "LifecycleDormantSignal",
  });
  const dormantAfterForgetContext = await memory.prepareTurn({
    profileId: lifecycleProfile,
    messages: [{ role: "user", content: "LifecycleDormantSignal" }],
  });
  const forgottenDormantExplanation = await memory.explainTurn({
    profileId: lifecycleProfile,
    messages: [{ role: "user", content: "LifecycleDormantSignal" }],
    maxExcluded: 10,
  });
  const archivedDormant = await memory.list({
    profileId: lifecycleProfile,
    status: "archived",
    query: "LifecycleDormantSignal",
    limit: 10,
  });
  gate(
    result,
    "forget_archives_dormant_memory",
    forgottenDormant.archivedMemoryIds.includes(staleMemory.id) &&
      archivedDormant.some((entry) => entry.id === staleMemory.id) &&
      !dormantAfterForgetContext.contextBlock.includes("LifecycleDormantSignal"),
    "forget should archive dormant matches and keep ordinary context clean",
    "lifecycle",
  );
  gate(
    result,
    "explain_turn_forget_residue_redacts_content",
    forgottenDormantExplanation.excluded.some(
      (entry) => entry.id === staleMemory.id && entry.reason === "forget_residue",
    ) &&
      !JSON.stringify(forgottenDormantExplanation).includes("stale fact should decay"),
    "explainTurn should name forget residue without resurfacing forgotten content",
    "explainability",
  );
  const usedDormant = await memory.add({
    profileId: lifecycleProfile,
    kind: "fact",
    content: "LifecycleUsedDormantSignal should reactivate on outcome.",
    confidence: 0.4,
    createdAt: "2020-01-01T00:10:00.000Z",
  });
  await memory.recordFeedback({
    profileId: lifecycleProfile,
    content: "LifecycleUsedDormantSignal was useful feedback.",
    relatedMemoryIds: [usedDormant.id],
    signal: "positive",
    createdAt: "2020-01-02T00:10:00.000Z",
  });
  await memory.maintain({
    profileId: lifecycleProfile,
    now: "2026-07-02T00:10:00.000Z",
  });
  await memory.commitOutcome({
    profileId: lifecycleProfile,
    taskId: "lifecycle-usage",
    objective: "Use dormant lifecycle memory",
    status: "completed",
    createdAt: "2026-07-02T00:11:00.000Z",
    usedMemoryIds: [usedDormant.id, "unknown_memory"],
  });
  const reactivated = await memory.get({
    profileId: lifecycleProfile,
    id: usedDormant.id,
  });
  const reactivationEvidence = await memory.listEvidence({
    profileId: lifecycleProfile,
    sourceType: "memory.lifecycle",
    limit: 20,
  });
  gate(
    result,
    "commit_outcome_reactivates_dormant_usage",
    reactivated?.status === "active" &&
      reactivated.recallCount === 1 &&
      reactivated.lastRecalledAt === "2026-07-02T00:11:00.000Z" &&
      reactivationEvidence.some((event) => event.payload.memoryId === usedDormant.id),
    "commitOutcome usedMemoryIds should reactivate dormant memories and bump recall counters",
    "lifecycle",
  );
  const lifecycleExplainBefore = await store.readAuditSnapshot();
  const usedDormantExplanation = await memory.explain(usedDormant.id, lifecycleProfile);
  const lifecycleExplainAfter = await store.readAuditSnapshot();
  const lifecycleKinds = usedDormantExplanation?.lifecycle.entries.map((entry) => entry.eventKind) ?? [];
  gate(
    result,
    "lifecycle_history_lists_reinforce_dormant_reactivate",
    JSON.stringify(lifecycleExplainBefore) === JSON.stringify(lifecycleExplainAfter) &&
      ["created", "reinforced", "decayed_to_dormant", "reactivated"].every((kind, index) =>
        lifecycleKinds.indexOf(kind as never) >= index,
      ) &&
      lifecycleKinds.indexOf("created") < lifecycleKinds.indexOf("reinforced") &&
      lifecycleKinds.indexOf("reinforced") < lifecycleKinds.indexOf("decayed_to_dormant") &&
      lifecycleKinds.indexOf("decayed_to_dormant") < lifecycleKinds.indexOf("reactivated"),
    "explain lifecycle history should be read-pure and ordered from creation through reactivation",
    "explainability",
  );

  const explainProfile = "gym_explain_turn";
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await memory.add({
      profileId: explainProfile,
      kind: "fact",
      content: `ExplainTurnBudgetSignal ${suffix} keeps the public decision trace deterministic and concise.`,
      confidence: 0.8,
    });
  }
  const explainInput = {
    profileId: explainProfile,
    messages: [{ role: "user" as const, content: "ExplainTurnBudgetSignal decision trace" }],
  };
  const explainPrepared = await memory.prepareTurn(explainInput);
  const explainReport = await memory.explainTurn(explainInput);
  const explainReportAgain = await memory.explainTurn(explainInput);
  const tightBudgetExplanation = await memory.explainTurn({
    ...explainInput,
    contextBudgetTokens: 60,
    maxExcluded: 10,
  });
  const relaxedBudgetExplanation = await memory.explainTurn({
    ...explainInput,
    contextBudgetTokens: 1800,
    maxExcluded: 10,
  });
  const explainAuditBefore = await store.readAuditSnapshot();
  await memory.explainTurn({ ...explainInput, maxExcluded: 10 });
  const explainAuditAfter = await store.readAuditSnapshot();
  gate(
    result,
    "explain_turn_included_matches_prepare_turn",
    JSON.stringify(explainPrepared.memories.map((entry) => entry.id)) ===
      JSON.stringify(explainReport.included.map((entry) => entry.id)),
    "explainTurn included set should exactly match prepareTurn memories for the same input",
    "explainability",
  );
  gate(
    result,
    "explain_turn_deterministic_and_read_pure",
    JSON.stringify(explainReport) === JSON.stringify(explainReportAgain) &&
      JSON.stringify(explainAuditBefore) === JSON.stringify(explainAuditAfter),
    "explainTurn should be deterministic and read-pure",
    "explainability",
  );
  gate(
    result,
    "explain_turn_budget_cut_tracks_token_budget",
    tightBudgetExplanation.excluded.some((entry) => entry.reason === "budget_cut") &&
      !relaxedBudgetExplanation.excluded.some((entry) => entry.reason === "budget_cut"),
    "explainTurn should report token budget cuts only when the context budget is tightened",
    "explainability",
  );
  scenario(result, "memory_lifecycle", "dev", [
    "maintenance_dry_run_read_audit_pure",
    "lifecycle_decay_to_dormant",
    "lifecycle_exempts_boundary_and_person",
    "dormant_excluded_from_prepare_context",
    "history_reaches_dormant_memory",
    "maintenance_idempotent_same_now",
    "forget_archives_dormant_memory",
    "commit_outcome_reactivates_dormant_usage",
    "explain_turn_reports_dormant_exclusion",
    "explain_turn_forget_residue_redacts_content",
    "lifecycle_history_lists_reinforce_dormant_reactivate",
    "explain_turn_included_matches_prepare_turn",
    "explain_turn_deterministic_and_read_pure",
    "explain_turn_budget_cut_tracks_token_budget",
  ]);

  const duplicateProfile = "gym_consolidation_duplicate";
  const duplicateOlder = await memory.add({
    profileId: duplicateProfile,
    kind: "fact",
    content: "DuplicateConsolidationSignal canonical content stays byte-for-byte.",
    confidence: 0.4,
    createdAt: "2026-07-02T01:00:00.000Z",
  });
  const duplicateSurvivor = await memory.add({
    profileId: duplicateProfile,
    kind: "fact",
    content: "DuplicateConsolidationSignal canonical content stays byte-for-byte.",
    confidence: 0.9,
    createdAt: "2026-07-02T01:01:00.000Z",
  });
  const duplicateReport = await memory.maintain({
    profileId: duplicateProfile,
    now: "2026-07-02T02:00:00.000Z",
    phases: ["consolidate"],
  });
  const duplicateCluster = duplicateReport.consolidation.duplicateClusters[0];
  const duplicateActive = await memory.get({
    profileId: duplicateProfile,
    id: duplicateSurvivor.id,
  });
  const duplicateArchived = await memory.get({
    profileId: duplicateProfile,
    id: duplicateOlder.id,
    includeArchived: true,
  });
  const duplicateEvidence = await memory.listEvidence({
    profileId: duplicateProfile,
    sourceType: "consolidation",
    limit: 10,
  });
  gate(
    result,
    "consolidation_duplicate_archives_members",
    duplicateCluster?.survivorId === duplicateSurvivor.id &&
      duplicateActive?.status === "active" &&
      duplicateActive.content === duplicateSurvivor.content &&
      duplicateArchived?.status === "archived" &&
      duplicateArchived.metadata.supersededBy === duplicateSurvivor.id &&
      duplicateEvidence.some(
        (event) =>
          event.payload.survivorId === duplicateSurvivor.id &&
          Array.isArray(event.payload.memberIds) &&
          event.payload.memberIds.includes(duplicateOlder.id),
      ),
    "duplicate consolidation should keep canonical content and archive superseded members with evidence",
    "consolidation",
  );

  const protectedProfile = "gym_consolidation_protected";
  await memory.add({
    profileId: protectedProfile,
    kind: "boundary",
    content: "ProtectedConsolidationSignal never consolidate this duplicate.",
    confidence: 0.9,
  });
  await memory.add({
    profileId: protectedProfile,
    kind: "boundary",
    content: "ProtectedConsolidationSignal never consolidate this duplicate.",
    confidence: 0.8,
  });
  await memory.add({
    profileId: protectedProfile,
    kind: "person",
    content: "PERSON: ProtectedConsolidationPerson duplicate never consolidates.",
    confidence: 0.9,
    allowPerson: true,
  });
  await memory.add({
    profileId: protectedProfile,
    kind: "person",
    content: "PERSON: ProtectedConsolidationPerson duplicate never consolidates.",
    confidence: 0.8,
    allowPerson: true,
  });
  await memory.add({
    profileId: protectedProfile,
    kind: "fact",
    content: "ProtectedConsolidationSensitive therapy duplicate never consolidates.",
    confidence: 0.9,
  });
  await memory.add({
    profileId: protectedProfile,
    kind: "fact",
    content: "ProtectedConsolidationSensitive therapy duplicate never consolidates.",
    confidence: 0.8,
  });
  const protectedReport = await memory.maintain({
    profileId: protectedProfile,
    now: "2026-07-02T02:05:00.000Z",
    phases: ["consolidate"],
  });
  const protectedArchived = await memory.list({
    profileId: protectedProfile,
    status: "archived",
    includePerson: true,
    includeSensitive: true,
    query: "ProtectedConsolidationSignal ProtectedConsolidationPerson ProtectedConsolidationSensitive",
    limit: 20,
  });
  gate(
    result,
    "consolidation_excludes_boundary_person_sensitive",
    protectedReport.consolidation.duplicateClusters.length === 0 &&
      protectedArchived.length === 0,
    "boundary, person, and sensitive memories should never enter consolidation clusters",
    "consolidation",
  );

  const hookProfile = "gym_consolidation_hook";
  const hookMemory = createMemoryOS({
    profileId: hookProfile,
    store,
    entityResolver: gymEntityResolver,
    consolidation: { tagOverlapThreshold: 0.3 },
    consolidator(cluster) {
      if (!cluster.memories.some((entry) => entry.content.includes("ConsolidationHookSource"))) {
        return null;
      }
      return [{
        kind: "project",
        content: "SemanticSummarySignal Orion rollout is ready after three source notes.",
        confidence: 0.82,
        subject: "project:orion",
        predicate: "project.state",
        object: "ready_after_three_notes",
      }];
    },
  });
  const hookSources = await Promise.all([
    hookMemory.add({
      kind: "project",
      content: "ConsolidationHookSource Orion rollout source note alpha ready.",
    }),
    hookMemory.add({
      kind: "project",
      content: "ConsolidationHookSource Orion rollout source note beta ready.",
    }),
    hookMemory.add({
      kind: "project",
      content: "ConsolidationHookSource Orion rollout source note gamma ready.",
    }),
  ]);
  const hookReport = await hookMemory.maintain({
    now: "2026-07-02T03:00:00.000Z",
    phases: ["consolidate"],
  });
  const hookSummaryId = hookReport.consolidation.summaryMemories[0]?.memoryId;
  const hookSummary = hookSummaryId ? await hookMemory.get({ id: hookSummaryId }) : null;
  const hookDormant = await hookMemory.list({
    status: "dormant",
    query: "ConsolidationHookSource",
    limit: 10,
  });
  const hookExplanation = hookSummaryId ? await hookMemory.explain(hookSummaryId) : null;
  gate(
    result,
    "consolidator_hook_writes_summary_and_dormant_sources",
    Boolean(hookSummaryId) &&
      hookSummary?.content.includes("SemanticSummarySignal Orion rollout") === true &&
      hookDormant.length === hookSources.length &&
      hookExplanation?.evidence.some(
        (event) => {
          const sourceMemoryIds = event.payload.sourceMemoryIds;
          return event.sourceType === "consolidation" &&
            Array.isArray(sourceMemoryIds) &&
            hookSources.every((source) => sourceMemoryIds.includes(source.id));
        },
      ) === true &&
      Boolean(hookReport.consolidation.summaryMemories[0]?.worldBeliefId),
    "host consolidator should persist a summary, cite source memories, demote sources, and write structured belief",
    "consolidation",
  );
  const secondHookReport = await hookMemory.maintain({
    now: "2026-07-02T03:00:00.000Z",
    phases: ["consolidate"],
  });
  gate(
    result,
    "consolidation_idempotent_same_now",
    secondHookReport.consolidation.duplicateClusters.length === 0 &&
      secondHookReport.consolidation.summaryMemories.length === 0,
    "running consolidate twice with the same now should not create new consolidation actions",
    "consolidation",
  );
  const forgottenSummary = hookSummaryId
    ? await hookMemory.forget({ query: "SemanticSummarySignal Orion rollout" })
    : { archivedMemoryIds: [] };
  const summaryAfterForget = hookSummaryId
    ? await hookMemory.get({ id: hookSummaryId, includeArchived: true })
    : null;
  const afterForgetPrepared = await hookMemory.prepareTurn({
    messages: [{ role: "user", content: "SemanticSummarySignal Orion rollout" }],
  });
  gate(
    result,
    "forget_consolidated_summary_cleans_residue",
    Boolean(hookSummaryId) &&
      forgottenSummary.archivedMemoryIds.includes(hookSummaryId!) &&
      summaryAfterForget?.status === "archived" &&
      !afterForgetPrepared.contextBlock.includes("SemanticSummarySignal"),
    "forget should archive a consolidated summary and keep derived context residue out",
    "consolidation",
  );

  const secretHookMemory = createMemoryOS({
    profileId: "gym_consolidation_secret_hook",
    store,
    consolidation: { tagOverlapThreshold: 0.3 },
    consolidator() {
      return {
        kind: "fact",
        content: "SecretSummarySignal api key is sk-secretconsolidation1234567890",
        confidence: 0.9,
      };
    },
  });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await secretHookMemory.add({
      kind: "fact",
      content: `SecretHookSource Pegasus cluster ${suffix} public note.`,
    });
  }
  const secretHookReport = await secretHookMemory.maintain({
    now: "2026-07-02T03:10:00.000Z",
    phases: ["consolidate"],
  });
  const secretSummaries = await secretHookMemory.list({
    query: "SecretSummarySignal",
    limit: 10,
  });
  gate(
    result,
    "consolidator_rejects_secret_like_summary",
    secretHookReport.consolidation.summaryMemories.length === 0 &&
      secretHookReport.consolidation.rejectedCandidates.some(
        (entry) => entry.reason === "secret_like",
      ) &&
      secretSummaries.length === 0,
    "secret-like summary candidates should be rejected without persistence",
    "consolidation",
  );

  const nullHookMemory = createMemoryOS({
    profileId: "gym_consolidation_null_hook",
    store,
    consolidation: { tagOverlapThreshold: 0.3 },
    consolidator() {
      return null;
    },
  });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await nullHookMemory.add({
      kind: "project",
      content: `NullHookSource Vega cluster ${suffix} public note.`,
    });
  }
  const nullHookBefore = await store.readAuditSnapshot();
  const nullHookReport = await nullHookMemory.maintain({
    now: "2026-07-02T03:20:00.000Z",
    phases: ["consolidate"],
  });
  const nullHookAfter = await store.readAuditSnapshot();
  const throwingHookMemory = createMemoryOS({
    profileId: "gym_consolidation_throw_hook",
    store,
    consolidation: { tagOverlapThreshold: 0.3 },
    consolidator() {
      throw new Error("synthetic hook failure");
    },
  });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await throwingHookMemory.add({
      kind: "project",
      content: `ThrowHookSource Vega cluster ${suffix} public note.`,
    });
  }
  const throwingBefore = await store.readAuditSnapshot();
  const throwingReport = await throwingHookMemory.maintain({
    now: "2026-07-02T03:30:00.000Z",
    phases: ["consolidate"],
  });
  const throwingAfter = await store.readAuditSnapshot();
  gate(
    result,
    "consolidator_null_and_throw_write_nothing",
    nullHookReport.consolidation.summaryMemories.length === 0 &&
      throwingReport.consolidation.summaryMemories.length === 0 &&
      JSON.stringify(nullHookBefore) === JSON.stringify(nullHookAfter) &&
      JSON.stringify(throwingBefore) === JSON.stringify(throwingAfter),
    "null or throwing consolidator hooks should produce zero consolidation writes",
    "consolidation",
  );

  const dryRunHookMemory = createMemoryOS({
    profileId: "gym_consolidation_dry_run",
    store,
    consolidation: { tagOverlapThreshold: 0.3 },
    consolidator() {
      return {
        kind: "project",
        content: "DryRunSummarySignal should only appear in a dry-run report.",
        confidence: 0.8,
      };
    },
  });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await dryRunHookMemory.add({
      kind: "project",
      content: `DryRunHookSource Lyra cluster ${suffix} public note.`,
    });
  }
  const dryRunConsolidateBefore = await store.readAuditSnapshot();
  const dryRunConsolidate = await dryRunHookMemory.maintain({
    dryRun: true,
    now: "2026-07-02T03:40:00.000Z",
    phases: ["consolidate"],
  });
  const dryRunConsolidateAfter = await store.readAuditSnapshot();
  gate(
    result,
    "consolidation_dry_run_read_audit_pure",
    dryRunConsolidate.consolidation.summaryMemories.some(
      (entry) => entry.content.includes("DryRunSummarySignal") && entry.memoryId === undefined,
    ) &&
      JSON.stringify(dryRunConsolidateBefore) === JSON.stringify(dryRunConsolidateAfter),
    "dry-run consolidate should compute hook summaries without writes",
    "consolidation",
  );
  scenario(result, "memory_consolidation", "dev", [
    "consolidation_duplicate_archives_members",
    "consolidation_excludes_boundary_person_sensitive",
    "consolidator_hook_writes_summary_and_dormant_sources",
    "consolidation_idempotent_same_now",
    "forget_consolidated_summary_cleans_residue",
    "consolidator_rejects_secret_like_summary",
    "consolidator_null_and_throw_write_nothing",
    "consolidation_dry_run_read_audit_pure",
  ]);

  const distillProfile = "gym_distillation_success";
  const distillMemory = createMemoryOS({
    profileId: distillProfile,
    store,
    procedureDistiller(cluster) {
      if (!cluster.objective.toLowerCase().includes("vega release checklist")) return null;
      return {
        content: "DistilledProcedureSignal for Vega release checklist: verify evidence chain, then ship.",
        confidence: 0.83,
      };
    },
  });
  for (const [index, objective] of [
    "Vega release checklist",
    "  vega   RELEASE checklist  ",
    "checklist release vega",
  ].entries()) {
    await distillMemory.commitOutcome({
      taskId: `distill-vega-${index + 1}`,
      objective,
      status: "completed",
      summary: "Verified evidence chain before shipping.",
      createdAt: `2026-07-02T04:0${index}:00.000Z`,
    });
  }
  const distillReport = await distillMemory.maintain({
    now: "2026-07-02T04:10:00.000Z",
    phases: ["distill"],
  });
  const distilledProcedureId = distillReport.distillation.summaryMemories[0]?.memoryId;
  const distilledProcedure = distilledProcedureId
    ? await distillMemory.get({ id: distilledProcedureId })
    : null;
  const distilledExplanation = distilledProcedureId
    ? await distillMemory.explain(distilledProcedureId)
    : null;
  const distilledPrepared = await distillMemory.prepareTurn({
    messages: [{ role: "user", content: "How should I run the Vega release checklist?" }],
  });
  gate(
    result,
    "distillation_writes_procedure_with_trajectory_evidence",
    distilledProcedure?.kind === "procedure" &&
      distilledProcedure.content.includes("DistilledProcedureSignal") &&
      distilledExplanation?.evidence.some(
        (event) =>
          event.sourceType === "distillation" &&
          Array.isArray(event.payload.sourceTrajectoryIds) &&
          distillReport.distillation.summaryMemories[0]?.sourceTrajectoryIds.every((id) =>
            (event.payload.sourceTrajectoryIds as string[]).includes(id)
          ),
      ) === true &&
      distilledPrepared.actionPolicies.some(
        (policy) =>
          policy.kind === "procedure" &&
          policy.sourceMemoryId === distilledProcedureId &&
          policy.text.includes("DistilledProcedureSignal"),
      ),
    "distilled procedures should persist as procedure memories, cite source trajectories, and surface as action policies",
    "distillation",
  );
  const distillSecondReport = await distillMemory.maintain({
    now: "2026-07-02T04:10:00.000Z",
    phases: ["distill"],
  });
  gate(
    result,
    "distillation_idempotent_same_now",
    distillSecondReport.distillation.summaryMemories.length === 0 &&
      distillSecondReport.distillation.clusters.length === 0,
    "running distill twice with the same now should derive already-distilled clusters from evidence",
    "distillation",
  );

  const insufficientDistillMemory = createMemoryOS({
    profileId: "gym_distillation_insufficient",
    store,
    procedureDistiller() {
      return {
        content: "InsufficientDistillSignal should never be written.",
        confidence: 0.8,
      };
    },
  });
  for (const suffix of ["alpha", "beta"]) {
    await insufficientDistillMemory.commitOutcome({
      objective: "Insufficient repeat procedure",
      status: "completed",
      summary: suffix,
    });
  }
  const insufficientBefore = await store.readAuditSnapshot();
  const insufficientReport = await insufficientDistillMemory.maintain({
    now: "2026-07-02T04:20:00.000Z",
    phases: ["distill"],
  });
  const insufficientAfter = await store.readAuditSnapshot();
  const failedOnlyDistillMemory = createMemoryOS({
    profileId: "gym_distillation_failed_only",
    store,
    procedureDistiller() {
      return {
        content: "FailedOnlyDistillSignal should never be written.",
        confidence: 0.8,
      };
    },
  });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await failedOnlyDistillMemory.commitOutcome({
      objective: "Failed only procedure",
      status: "failed",
      failureKind: "task_failure",
      summary: suffix,
    });
  }
  const failedOnlyBefore = await store.readAuditSnapshot();
  const failedOnlyReport = await failedOnlyDistillMemory.maintain({
    now: "2026-07-02T04:30:00.000Z",
    phases: ["distill"],
  });
  const failedOnlyAfter = await store.readAuditSnapshot();
  const noHookDistillMemory = createMemoryOS({ profileId: "gym_distillation_no_hook", store });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await noHookDistillMemory.commitOutcome({
      objective: "No hook procedure",
      status: "completed",
      summary: suffix,
    });
  }
  const noHookBefore = await store.readAuditSnapshot();
  const noHookReport = await noHookDistillMemory.maintain({
    now: "2026-07-02T04:40:00.000Z",
    phases: ["distill"],
  });
  const noHookAfter = await store.readAuditSnapshot();
  gate(
    result,
    "distillation_min_repeats_failed_only_no_hook_write_nothing",
    insufficientReport.distillation.summaryMemories.length === 0 &&
      failedOnlyReport.distillation.summaryMemories.length === 0 &&
      noHookReport.distillation.summaryMemories.length === 0 &&
      JSON.stringify(insufficientBefore) === JSON.stringify(insufficientAfter) &&
      JSON.stringify(failedOnlyBefore) === JSON.stringify(failedOnlyAfter) &&
      JSON.stringify(noHookBefore) === JSON.stringify(noHookAfter),
    "fewer than minRepeats, failed-only trajectories, and no-hook distill runs should write nothing",
    "distillation",
  );

  const secretDistillMemory = createMemoryOS({
    profileId: "gym_distillation_secret",
    store,
    procedureDistiller() {
      return {
        content: "SecretDistillSignal api key is sk-distillationsecret1234567890",
        confidence: 0.9,
      };
    },
  });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await secretDistillMemory.commitOutcome({
      objective: "Secret candidate procedure",
      status: "completed",
      summary: suffix,
    });
  }
  const secretDistillReport = await secretDistillMemory.maintain({
    now: "2026-07-02T04:50:00.000Z",
    phases: ["distill"],
  });
  const secretDistillMemories = await secretDistillMemory.list({
    query: "SecretDistillSignal",
    limit: 10,
  });
  gate(
    result,
    "distillation_rejects_secret_like_candidate",
    secretDistillReport.distillation.summaryMemories.length === 0 &&
      secretDistillReport.distillation.rejectedCandidates.some(
        (entry) => entry.reason === "secret_like",
      ) &&
      secretDistillMemories.length === 0,
    "secret-like procedure distillation candidates should be rejected without persistence",
    "distillation",
  );

  const dryRunDistillMemory = createMemoryOS({
    profileId: "gym_distillation_dry_run",
    store,
    procedureDistiller() {
      return {
        content: "DryRunDistillSignal should only appear in a dry-run report.",
        confidence: 0.8,
      };
    },
  });
  for (const suffix of ["alpha", "beta", "gamma"]) {
    await dryRunDistillMemory.commitOutcome({
      objective: "Dry run distillation procedure",
      status: "completed",
      summary: suffix,
    });
  }
  const dryRunDistillBefore = await store.readAuditSnapshot();
  const dryRunDistillReport = await dryRunDistillMemory.maintain({
    dryRun: true,
    now: "2026-07-02T05:00:00.000Z",
    phases: ["distill"],
  });
  const dryRunDistillAfter = await store.readAuditSnapshot();
  gate(
    result,
    "distillation_dry_run_read_audit_pure",
    dryRunDistillReport.distillation.summaryMemories.some(
      (entry) => entry.content.includes("DryRunDistillSignal") && entry.memoryId === undefined,
    ) &&
      JSON.stringify(dryRunDistillBefore) === JSON.stringify(dryRunDistillAfter),
    "dry-run distill should compute hook summaries without writes",
    "distillation",
  );

  const { createDefaultIntelligence } = await import("../intelligence/index.js");
  let gymDossierVersion = "first";
  const gymIntelligenceFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      input?: string[];
      messages?: Array<{ content: string }>;
    };
    if (request.input) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          data: request.input?.map((_text, index) => ({
            index,
            embedding: index % 2 === 0 ? [1, 0, 0] : [0, 1, 0],
          })),
        }),
      };
    }
    const system = request.messages?.[0]?.content ?? "";
    const user = request.messages?.[1]?.content ?? "";
    const content = system.includes("structured memory extractor")
      ? JSON.stringify({
          memories: [{
            kind: "project",
            subject: "project:gym-intelligence",
            predicate: user.includes("beta") ? "project.note.beta" : "project.note.alpha",
            object: user.includes("beta") ? "beta" : "alpha",
            content: user.includes("beta")
              ? "GymIntelligenceSignal beta durable note."
              : "GymIntelligenceSignal alpha durable note.",
            confidence: 0.9,
          }],
        })
      : system.includes("memory consolidation hook")
        ? JSON.stringify({
            summaries: [{
              kind: "project",
              content: "GymIntelligenceSummarySignal summarizes cited project notes.",
              confidence: 0.82,
            }],
          })
        : system.includes("entity dossier synthesis hook")
          ? JSON.stringify({
              dossiers: [{
                content: `GymIntelligenceDossierSignal ${gymDossierVersion} dossier.`,
                confidence: 0.84,
              }],
            })
          : JSON.stringify({ procedures: [{ content: "GymIntelligenceProcedureSignal distilled.", confidence: 0.8 }] });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
  const intelligence = createDefaultIntelligence({
    model: "gym-chat",
    embedModel: "gym-embed",
    dimensions: 3,
    fetchImpl: gymIntelligenceFetch,
    reranker: false,
  });
  const noIntelligence = createMemoryOS({
    profileId: "gym_intelligence_none",
    store,
  });
  const noIntelligenceObserve = await noIntelligence.observeWithReport({
    type: "conversation.message",
    role: "user",
    content: "GymIntelligenceSignal alpha durable note.",
  });
  const intelligenceMemory = createMemoryOS({
    profileId: "gym_intelligence_default",
    store,
    extractor: intelligence.extractor,
    consolidator: intelligence.consolidator,
    procedureDistiller: intelligence.procedureDistiller,
    dossierSynthesizer: intelligence.dossierSynthesizer,
    embeddingProvider: intelligence.embeddingProvider,
    consolidation: { tagOverlapThreshold: 0.1, hookMinClusterSize: 2 },
    dossier: { minLinkedMemories: 2 },
  });
  await intelligenceMemory.observe({
    type: "conversation.message",
    role: "user",
    content: "GymIntelligenceSignal alpha durable note.",
  });
  await intelligenceMemory.observe({
    type: "conversation.message",
    role: "user",
    content: "GymIntelligenceSignal beta durable note.",
  });
  const intelligenceMatches = await intelligenceMemory.search({
    query: "durable note",
    retrieval: { embedQuery: true },
  });
  const intelligenceConsolidation = await intelligenceMemory.maintain({
    now: "2026-07-02T05:02:00.000Z",
    phases: ["consolidate"],
  });
  const intelligenceDossierDryRunBefore = await store.readAuditSnapshot();
  const intelligenceDossierDryRun = await intelligenceMemory.maintain({
    dryRun: true,
    now: "2026-07-02T05:03:00.000Z",
    phases: ["dossier"],
  });
  const intelligenceDossierDryRunAfter = await store.readAuditSnapshot();
  const intelligenceDossier = await intelligenceMemory.maintain({
    now: "2026-07-02T05:04:00.000Z",
    phases: ["dossier"],
  });
  const firstGymDossierId = intelligenceDossier.dossier.summaryMemories[0]?.memoryId;
  gymDossierVersion = "second";
  await intelligenceMemory.observe({
    type: "conversation.message",
    role: "user",
    content: "GymIntelligenceSignal beta durable note.",
  });
  const intelligenceDossierSecond = await intelligenceMemory.maintain({
    now: "2026-07-02T05:05:00.000Z",
    phases: ["dossier"],
  });
  const firstGymDossier = firstGymDossierId
    ? await intelligenceMemory.get({ id: firstGymDossierId, includeArchived: true })
    : null;
  gate(
    result,
    "default_intelligence_extraction_and_embedding",
    noIntelligenceObserve.memoryIds.length === 0 &&
      intelligenceMatches.some((entry) => entry.content.includes("GymIntelligenceSignal")),
    "opt-in intelligence should extract durable memories and use the embedding provider path",
    "intelligence",
  );
  gate(
    result,
    "default_intelligence_consolidation_and_dossier",
    intelligenceConsolidation.consolidation.summaryMemories.length >= 1 &&
      intelligenceDossierDryRun.dossier.summaryMemories.length === 1 &&
      JSON.stringify(intelligenceDossierDryRunBefore) === JSON.stringify(intelligenceDossierDryRunAfter) &&
      Boolean(firstGymDossierId) &&
      intelligenceDossierSecond.dossier.summaryMemories[0]?.supersededMemoryId === firstGymDossierId &&
      firstGymDossier?.status === "archived",
    "default intelligence should consolidate, dry-run dossiers without writes, and supersede entity dossiers",
    "intelligence",
  );
  scenario(result, "batteries_included_intelligence", "dev", [
    "default_intelligence_extraction_and_embedding",
    "default_intelligence_consolidation_and_dossier",
  ]);

  const reinforcementMemory = await memory.add({
    profileId: "gym_outcome_reinforcement",
    kind: "procedure",
    content: "OutcomeReinforcementSignal memory.",
    confidence: 0.8,
  });
  const reinforcementRuntime = createMemoryOS({
    profileId: "gym_outcome_reinforcement",
    store,
    lifecycle: { outcomeReinforcement: { step: 0.75 } },
  });
  await reinforcementRuntime.commitOutcome({
    objective: "Successful use of reinforcement memory",
    status: "completed",
    usedMemoryIds: [reinforcementMemory.id],
    createdAt: "2026-07-02T05:10:00.000Z",
  });
  await reinforcementRuntime.commitOutcome({
    objective: "Successful use of reinforcement memory again",
    status: "completed",
    usedMemoryIds: [reinforcementMemory.id],
    createdAt: "2026-07-02T05:11:00.000Z",
  });
  const reinforcedHigh = await reinforcementRuntime.get({ id: reinforcementMemory.id });
  for (const index of [0, 1, 2]) {
    await reinforcementRuntime.commitOutcome({
      objective: "Wrong recall should lower reinforcement",
      status: "failed",
      failureKind: "wrong_recall",
      usedMemoryIds: [reinforcementMemory.id],
      createdAt: `2026-07-02T05:1${index + 2}:00.000Z`,
    });
  }
  const reinforcedLow = await reinforcementRuntime.get({ id: reinforcementMemory.id });
  gate(
    result,
    "outcome_reinforcement_adjusts_and_bounds",
    reinforcedHigh?.reinforcement === 1 &&
      reinforcedLow?.reinforcement === -1 &&
      (reinforcedLow?.recallCount ?? 0) >= 5,
    "completed outcomes should raise reinforcement, wrong_recall failures should lower it, and bounds should hold",
    "reinforcement",
  );

  const confidenceMemory = await memory.add({
    profileId: "gym_feedback_confidence",
    kind: "fact",
    content: "FeedbackConfidenceSignal stale recall candidate.",
    confidence: 0.12,
  });
  await memory.recordFeedback({
    profileId: "gym_feedback_confidence",
    content: "FeedbackConfidenceSignal was a wrong recall.",
    failureKind: "wrong_recall",
    relatedMemoryIds: [confidenceMemory.id],
    signal: "negative",
    createdAt: "2026-07-02T05:20:00.000Z",
  });
  const confidenceAfterFeedback = await memory.get({
    profileId: "gym_feedback_confidence",
    id: confidenceMemory.id,
  });
  gate(
    result,
    "wrong_recall_feedback_lowers_confidence_floor",
    confidenceAfterFeedback?.confidence === 0.05 &&
      (confidenceAfterFeedback?.reinforcement ?? 0) < 0,
    "wrong_recall feedback should lower confidence to the configured floor while feedback reinforcement remains separate",
    "reinforcement",
  );

  const evolutionTarget = await memory.add({
    profileId: "gym_evolution",
    kind: "fact",
    content: "EvolutionApplySignal candidate memory.",
    confidence: 0.7,
  });
  await memory.recordFeedback({
    profileId: "gym_evolution",
    content: "EvolutionApplySignal caused a wrong recall.",
    failureKind: "wrong_recall",
    relatedMemoryIds: [evolutionTarget.id],
    signal: "negative",
    createdAt: "2026-07-02T05:30:00.000Z",
  });
  const evolution = createEvolutionControlPlane({
    store,
    profileId: "gym_evolution",
    now: () => "2026-07-02T05:31:00.000Z",
  });
  const evolutionBefore = await store.readAuditSnapshot();
  const evolutionReport = await evolution.reviewFailures();
  const evolutionAfter = await store.readAuditSnapshot();
  const proposal = evolutionReport.patchProposals.find((entry) =>
    entry.suggestedActions.some((action) => action.memoryId === evolutionTarget.id),
  );
  let approvedByRejected = false;
  try {
    await evolution.applyEvolutionProposal({
      proposalId: proposal?.id ?? "missing",
      approvedBy: "",
    });
  } catch (error) {
    approvedByRejected =
      error instanceof EvolutionApplicationError && error.code === "approved_by_required";
  }
  const beforeEvolutionApply = await memory.get({
    profileId: "gym_evolution",
    id: evolutionTarget.id,
  });
  const applied = proposal
    ? await evolution.applyEvolutionProposal({
        proposalId: proposal.id,
        approvedBy: "Memory Gym",
      })
    : null;
  const afterEvolutionApply = await memory.get({
    profileId: "gym_evolution",
    id: evolutionTarget.id,
  });
  const evolutionEvidence = await memory.listEvidence({
    profileId: "gym_evolution",
    sourceType: "evolution",
    limit: 10,
  });
  const reverted = applied
    ? await evolution.revertEvolutionApplication({
        applicationEventId: applied.applicationEventId,
      })
    : null;
  const afterEvolutionRevert = await memory.get({
    profileId: "gym_evolution",
    id: evolutionTarget.id,
  });
  let doubleRevertRejected = false;
  if (applied) {
    try {
      await evolution.revertEvolutionApplication({
        applicationEventId: applied.applicationEventId,
      });
    } catch (error) {
      doubleRevertRejected =
        error instanceof EvolutionApplicationError &&
        error.code === "application_already_reverted";
    }
  }
  gate(
    result,
    "evolution_review_apply_revert_approval_gated",
    JSON.stringify(evolutionBefore) === JSON.stringify(evolutionAfter) &&
      evolutionReport.mode === "propose_with_approval" &&
      Boolean(proposal) &&
      approvedByRejected &&
      Boolean(applied) &&
      afterEvolutionApply !== null &&
      beforeEvolutionApply !== null &&
      afterEvolutionApply.confidence < beforeEvolutionApply.confidence &&
      (afterEvolutionApply.reinforcement ?? 0) < (beforeEvolutionApply.reinforcement ?? 0) &&
      evolutionEvidence.some(
        (event) =>
          event.id === applied?.applicationEventId &&
          event.sourceType === "evolution" &&
          event.payload.proposalId === proposal?.id &&
          Array.isArray(event.payload.previousValues),
      ) &&
      Boolean(reverted) &&
      afterEvolutionRevert?.confidence === beforeEvolutionApply?.confidence &&
      afterEvolutionRevert?.reinforcement === beforeEvolutionApply?.reinforcement &&
      doubleRevertRejected,
    "evolution review should be read-only; apply should require approval, mutate only safe targets with evidence, and revert exactly once",
    "evolution",
  );

  scenario(result, "experience_learning", "dev", [
    "distillation_writes_procedure_with_trajectory_evidence",
    "distillation_idempotent_same_now",
    "distillation_min_repeats_failed_only_no_hook_write_nothing",
    "distillation_rejects_secret_like_candidate",
    "distillation_dry_run_read_audit_pure",
    "outcome_reinforcement_adjusts_and_bounds",
    "wrong_recall_feedback_lowers_confidence_floor",
    "evolution_review_apply_revert_approval_gated",
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
    reconstructionIntent: {
      queryCues: ["Helio"],
      requiredTagGroups: [
        {
          name: "procedure_or_next_step",
          tags: ["procedure", "task_trajectory", "project.state", "world_belief"],
        },
      ],
    },
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
      reconstructed.paths.some((path) => path.cue === "retrieval_hint") &&
      reconstructed.paths.some((path) => path.targetSummary.includes("Helio 项目推进时先写复现报告")),
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
      plannerTrace.intentReason === "structured:procedure_or_next_step" &&
      plannerTrace.stopReason === reconstructed.stats.stopReason &&
      plannerTrace.initialCues.length > 0 &&
      plannerTrace.steps.length >= 2 &&
      plannerTrace.steps.some((step) => step.generatedCues.includes("retrieval_hint")) &&
      plannerTrace.steps.some(
        (step) => step.selectedCue === "procedure" || step.selectedCue === "retrieval_hint",
      ) &&
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
    query: "我之前说的那个计划，先做什么，最重要的一项边界是什么？",
    reconstructionIntent: {
      queryCues: ["Helio"],
      requiredTagGroups: [
        {
          name: "procedure_or_next_step",
          tags: ["procedure", "task_trajectory", "project.state", "world_belief"],
        },
        { name: "boundary", tags: ["boundary", "do_not_push"] },
      ],
    },
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
    "reconstructContext should require every structured intent group to converge, not just any matching tag",
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
    reconstructionIntent: {
      queryCues: ["Vega"],
      requiredTagGroups: [
        {
          name: "procedure_or_next_step",
          tags: ["procedure", "task_trajectory", "project.state", "world_belief"],
        },
      ],
    },
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
    "reconstructContext should rerank noisy association branches by explicit intent, not raw confidence",
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
    reconstruction: {
      mode: "shadow",
      reconstructionIntent: {
        queryCues: ["Helio"],
        requiredTagGroups: [
          {
            name: "procedure_or_next_step",
            tags: ["procedure", "task_trajectory", "project.state", "world_belief"],
          },
        ],
      },
      maxSteps: 4,
      maxBranch: 6,
      maxMemories: 6,
    },
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
    subject: "Workspace Orion",
    predicate: "workspace.state",
    object: "OrionOwnerAlpha",
    confidence: 0.82,
    cardinality: "single",
  });
  await store.addWorldBelief({
    profileId: "gym_reconstruct",
    subject: "workspace:orion",
    predicate: "workspace.state",
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
    query: "Orion workspace current state",
    reconstructionIntent: {
      queryCues: ["workspace:orion"],
      requiredTagGroups: [{ name: "current_state", tags: ["workspace.state", "world_belief"] }],
    },
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
    temporalMode: "history",
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
  const supersededTurnExplanation = await memory.explainTurn({
    profileId: "gym_reconstruct",
    messages: [{ role: "user", content: "atlas source current state" }],
    maxExcluded: 20,
  });
  const temporalTurnExplanation = await memory.explainTurn({
    profileId: "gym_reconstruct",
    messages: [{ role: "user", content: "atlas temporal validity owner" }],
    maxExcluded: 20,
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
    "explain_turn_reports_superseded_exclusion",
    supersededTurnExplanation.excluded.some(
      (entry) => entry.id === staleCurrentStateSourceMemory.id && entry.reason === "superseded",
    ),
    "explainTurn should report source memories hidden by current-state supersession",
    "explainability",
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
    "explain_turn_reports_out_of_window_exclusion",
    temporalTurnExplanation.excluded.some((entry) => entry.reason === "out_of_window"),
    "explainTurn should report temporally invalid candidates as out_of_window",
    "explainability",
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
    "explain_turn_reports_superseded_exclusion",
    "historical_recall_includes_superseded_source_memory",
    "current_temporal_mode_overrides_history_cues",
    "temporal_validity_window_context_filter",
    "explain_turn_reports_out_of_window_exclusion",
    "temporal_validity_history_recall",
    "historical_recall_keeps_sensitive_person_filters",
  ]);

  const feedbackCountsBefore = await store.rowCounts();
  await memory.recordFeedback({
    profileId: "gym",
    content: "刚才召回了错误记忆。",
    failureKind: "wrong_recall",
  });
  const counts = await store.rowCounts();
  gate(
    result,
    "feedback_failure_log",
    (counts.gmos_failure_events ?? 0) === (feedbackCountsBefore.gmos_failure_events ?? 0) + 1,
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

  const fallbackRecallStore = createSqliteMemoryStore({ path: ":memory:" });
  const fallbackRecallMemory = createMemoryOS({ profileId: "gym_m5_fallback", store: fallbackRecallStore });
  const providerRecallStore = createSqliteMemoryStore({ path: ":memory:" });
  const providerRecall = createGymEmbeddingProvider();
  const providerRecallMemory = createMemoryOS({
    profileId: "gym_m5_provider",
    store: providerRecallStore,
    embeddingProvider: providerRecall,
  });
  try {
    await fallbackRecallMemory.add({
      profileId: "gym_m5_fallback",
      kind: "fact",
      content: "The preferred deployment vehicle is Zephyr Shuttle.",
    });
    await providerRecallMemory.add({
      profileId: "gym_m5_provider",
      kind: "fact",
      content: "The preferred deployment vehicle is Zephyr Shuttle.",
    });
    const fallbackSemantic = await fallbackRecallMemory.search({
      profileId: "gym_m5_fallback",
      query: "Which launch transport should we use?",
    });
    const providerSemantic = await providerRecallMemory.search({
      profileId: "gym_m5_provider",
      query: "Which launch transport should we use?",
      retrieval: { embedQuery: true },
    });
    const fallbackHits = fallbackSemantic.some((entry) => entry.content.includes("Zephyr Shuttle")) ? 1 : 0;
    const providerHits = providerSemantic.some((entry) => entry.content.includes("Zephyr Shuttle")) ? 1 : 0;
    result.recallQuality.fixtureGroups.push({
      group: "semantic_paraphrase",
      fallbackHits,
      providerHits,
      total: 1,
      fallbackHitRate: hitRate(fallbackHits, 1),
      providerHitRate: hitRate(providerHits, 1),
    });
    gate(
      result,
      "semantic_provider_paraphrase_recall",
      fallbackHits === 0 && providerHits === 1,
      "provider-backed query embedding should recall a paraphrase that fallback lexical search misses",
      "semantic_recall",
    );
    gate(
      result,
      "semantic_recall_quality_not_worse",
      providerHits >= fallbackHits,
      "provider recall-quality report should not regress deterministic fixtures",
      "semantic_recall",
    );
  } finally {
    await fallbackRecallMemory.close();
    await providerRecallMemory.close();
  }

  const failureProvider = createGymEmbeddingProvider("gym-failure-stub-v1");
  const failureStore = createSqliteMemoryStore({ path: ":memory:" });
  const failureMemory = createMemoryOS({
    profileId: "gym_m5_failure",
    store: failureStore,
    embeddingProvider: failureProvider,
    extractor: () => ({
      kind: "fact",
      content: "Semantic recall target survives provider failure.",
      confidence: 0.9,
    }),
  });
  try {
    failureProvider.failNext = true;
    await failureMemory.observe({
      type: "conversation.message",
      profileId: "gym_m5_failure",
      role: "user",
      content: "Please remember the semantic recall target.",
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    const pendingHealth = failureStore.searchIndexStatus();
    const repaired = await failureStore.repairSearchIndex({ vectorBatchSize: 8 });
    const secondRepair = await failureStore.repairSearchIndex({ vectorBatchSize: 8 });
    gate(
      result,
      "embedding_failure_pending_repair",
      pendingHealth.vectorIndex?.pendingEntryCount === 1 &&
        repaired.after.vectorIndex?.pendingEntryCount === 0 &&
        secondRepair.vectorBackfill.candidateCount === 0,
      "provider failure during observe should not block the write; repair backfills once and then no-ops",
      "semantic_recall",
    );
  } finally {
    await failureMemory.close();
  }

  const changeProviderA = createGymEmbeddingProvider("gym-provider-a");
  const changeProviderB = createGymEmbeddingProvider("gym-provider-b");
  const changeStore = createSqliteMemoryStore({ path: ":memory:" });
  const changeMemory = createMemoryOS({
    profileId: "gym_m5_provider_change",
    store: changeStore,
    embeddingProvider: changeProviderA,
  });
  try {
    await changeMemory.add({
      profileId: "gym_m5_provider_change",
      kind: "fact",
      content: "The provider change fixture uses Zephyr Shuttle.",
    });
    changeStore.configureEmbeddingProvider?.(changeProviderB);
    const staleHealth = changeStore.searchIndexStatus();
    const dryRunBefore = changeStore.readAuditSnapshot();
    const dryRunRepair = await changeStore.repairSearchIndex({ dryRun: true, vectorBatchSize: 8 });
    const dryRunAfter = changeStore.readAuditSnapshot();
    const providerRepair = await changeStore.repairSearchIndex({ vectorBatchSize: 8 });
    gate(
      result,
      "embedding_provider_change_repair",
      staleHealth.vectorIndex?.staleProviderEntryCount === 1 &&
        dryRunRepair.after.vectorIndex?.staleProviderEntryCount === 1 &&
        JSON.stringify(dryRunBefore) === JSON.stringify(dryRunAfter) &&
        providerRepair.after.vectorIndex?.staleProviderEntryCount === 0,
      "provider name/dimension changes should mark vectors stale; dry-run writes nothing; repair rebuilds",
      "semantic_recall",
    );
  } finally {
    await changeMemory.close();
  }

  const privacyProvider = createGymEmbeddingProvider("gym-privacy-stub-v1");
  const privacyStore = createSqliteMemoryStore({ path: ":memory:" });
  const privacyMemory = createMemoryOS({
    profileId: "gym_m5_privacy",
    store: privacyStore,
    embeddingProvider: privacyProvider,
  });
  try {
    await privacyMemory.add({
      profileId: "gym_m5_privacy",
      kind: "fact",
      content: "Mental health support plan should stay local fallback.",
      sensitivity: "sensitive",
    });
    await privacyMemory.add({
      profileId: "gym_m5_privacy",
      kind: "person",
      content: "PERSON: Privacy Fixture should stay local fallback.",
      allowPerson: true,
    });
    await privacyMemory.observe({
      type: "conversation.message",
      profileId: "gym_m5_privacy",
      role: "user",
      content: "api key: sk-gymprivacysecret1234567890",
    });
    privacyProvider.calls.length = 0;
    await privacyMemory.search({
      profileId: "gym_m5_privacy",
      query: "api key sk-gymprivacysecret1234567890",
      retrieval: { embedQuery: true },
    });
    const sentTexts = privacyProvider.calls.flat();
    gate(
      result,
      "embedding_privacy_defaults",
      sentTexts.length === 0,
      "sensitive, person, secret-like content and secret-like queries should not be sent to the provider by default",
      "safety",
    );
  } finally {
    await privacyMemory.close();
  }

  const gateProvider = createGymEmbeddingProvider("gym-gate-stub-v1");
  const gateStore = createSqliteMemoryStore({ path: ":memory:" });
  const gateMemory = createMemoryOS({
    profileId: "gym_m5_gates",
    store: gateStore,
    embeddingProvider: gateProvider,
  });
  try {
    await gateMemory.add({
      profileId: "gym_m5_gates",
      kind: "fact",
      content: "gate vector active memory",
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    await gateMemory.add({
      profileId: "gym_m5_gates",
      kind: "fact",
      content: "gate vector dormant memory",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const archived = await gateMemory.add({
      profileId: "gym_m5_gates",
      kind: "fact",
      content: "gate vector archived memory",
    });
    await gateMemory.add({
      profileId: "gym_m5_gates",
      kind: "fact",
      content: "gate vector forgotten memory",
    });
    await gateMemory.add({
      profileId: "gym_m5_gates",
      kind: "person",
      content: "PERSON: gate vector person memory",
      allowPerson: true,
    });
    await gateMemory.maintain({
      profileId: "gym_m5_gates",
      now: "2026-07-02T00:00:00.000Z",
      phases: ["decay"],
    });
    await gateMemory.archive({
      profileId: "gym_m5_gates",
      id: archived.id,
      reason: "gym gate archive",
    });
    await gateMemory.forget({
      profileId: "gym_m5_gates",
      query: "forgotten memory",
    });
    const gated = await gateMemory.search({
      profileId: "gym_m5_gates",
      query: "gate vector retrieval",
      retrieval: { embedQuery: true },
      limit: 12,
    });
    const gatedText = gated.map((entry) => entry.content).join("\n");
    gate(
      result,
      "semantic_fusion_respects_visibility_gates",
      gatedText.includes("gate vector active memory") &&
        !gatedText.includes("dormant memory") &&
        !gatedText.includes("archived memory") &&
        !gatedText.includes("forgotten memory") &&
        !gatedText.includes("person memory"),
      "vector similarity should not resurface dormant, archived, forgotten, or person memories",
      "safety",
    );
  } finally {
    await gateMemory.close();
  }

  let rerankerKeepId = "";
  const rerankerStore = createSqliteMemoryStore({ path: ":memory:" });
  const rerankerMemory = createMemoryOS({
    profileId: "gym_m5_reranker",
    store: rerankerStore,
    retrieval: {
      reranker: () => [rerankerKeepId, "unknown_memory_id"],
    },
  });
  const throwingRerankerStore = createSqliteMemoryStore({ path: ":memory:" });
  const throwingRerankerMemory = createMemoryOS({
    profileId: "gym_m5_reranker_throw",
    store: throwingRerankerStore,
    retrieval: {
      reranker: () => {
        throw new Error("deterministic reranker failure");
      },
    },
  });
  try {
    const alpha = await rerankerMemory.add({
      profileId: "gym_m5_reranker",
      kind: "fact",
      content: "reranker alpha memory",
    });
    const beta = await rerankerMemory.add({
      profileId: "gym_m5_reranker",
      kind: "fact",
      content: "reranker beta memory",
    });
    rerankerKeepId = alpha.id;
    const reranked = await rerankerMemory.search({
      profileId: "gym_m5_reranker",
      query: "reranker memory",
      limit: 10,
    });
    await throwingRerankerMemory.add({
      profileId: "gym_m5_reranker_throw",
      kind: "fact",
      content: "reranker alpha memory",
    });
    const thrownFallback = await throwingRerankerMemory.search({
      profileId: "gym_m5_reranker_throw",
      query: "reranker memory",
      limit: 10,
    });
    gate(
      result,
      "retrieval_reranker_contract",
      reranked.length === 2 &&
        reranked[0]?.id === alpha.id &&
        reranked[1]?.id === beta.id &&
        thrownFallback.length > 0,
      "reranker reorders without dropping, unknown ids are ignored, and failures fall back to fusion",
      "semantic_recall",
    );
  } finally {
    await rerankerMemory.close();
    await throwingRerankerMemory.close();
  }

  const purityProvider = createGymEmbeddingProvider("gym-read-purity-stub-v1");
  const purityStore = createSqliteMemoryStore({ path: ":memory:" });
  const purityMemory = createMemoryOS({
    profileId: "gym_m5_purity",
    store: purityStore,
    embeddingProvider: purityProvider,
  });
  try {
    await purityMemory.add({
      profileId: "gym_m5_purity",
      kind: "fact",
      content: "The read purity fixture uses Zephyr Shuttle.",
    });
    purityProvider.calls.length = 0;
    await purityMemory.prepareTurn({
      profileId: "gym_m5_purity",
      messages: [{ role: "user", content: "read purity fixture" }],
    });
    await purityMemory.reconstructContext({
      profileId: "gym_m5_purity",
      query: "read purity fixture",
    });
    await purityMemory.search({
      profileId: "gym_m5_purity",
      query: "read purity fixture",
    });
    gate(
      result,
      "embedding_read_path_purity_default",
      purityProvider.calls.length === 0,
      "prepareTurn, reconstructContext, and search should not invoke the provider without explicit query embedding",
      "read_purity",
    );
  } finally {
    await purityMemory.close();
  }

  scenario(result, "semantic_recall_upgrade", "dev", [
    "semantic_provider_paraphrase_recall",
    "semantic_recall_quality_not_worse",
    "embedding_failure_pending_repair",
    "embedding_provider_change_repair",
    "embedding_privacy_defaults",
    "semantic_fusion_respects_visibility_gates",
    "retrieval_reranker_contract",
    "embedding_read_path_purity_default",
  ]);

  const experienceHorizon = await runExperienceHorizonGym();
  result.experienceHorizon = experienceHorizon;
  const experienceHorizonGates = experienceHorizon.scenarios.map((entry) => {
    const gateName = `experience_horizon_${entry.name}`;
    const failedAssertions = entry.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => assertion.name);
    gate(
      result,
      gateName,
      entry.pass,
      failedAssertions.length === 0
        ? `${entry.name} passed with counters ${JSON.stringify(entry.counters)}`
        : `${entry.name} failed assertions: ${failedAssertions.join(", ")}`,
      "experience_horizon",
    );
    return gateName;
  });
  gate(
    result,
    "experience_horizon_deterministic_replay",
    experienceHorizon.deterministicReplayPass,
    "experience_horizon scenarios should deep-equal across two fixed-clock in-memory runs",
    "experience_horizon",
  );
  scenario(result, "experience_horizon", "dev", [
    ...experienceHorizonGates,
    "experience_horizon_deterministic_replay",
  ]);

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
  scaleIngestP95Ms?: number | undefined;
  scaleIngestLastToFirstFactor?: number | undefined;
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
  const scaleIngestP95Ms = options.scaleIngestP95Ms ?? 25;
  const scaleIngestLastToFirstFactor = options.scaleIngestLastToFirstFactor ?? 3;
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
        ingestP95Ms: scaleIngestP95Ms,
        ingestLastToFirstFactor: scaleIngestLastToFirstFactor,
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
        scaleIngestP95Ms,
        scaleIngestLastToFirstFactor,
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
          ingestP95Ms: scale.thresholds.ingestP95Ms,
          ingestLastToFirstFactor: scale.thresholds.ingestLastToFirstFactor,
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
