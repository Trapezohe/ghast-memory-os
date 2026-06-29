import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EXTERNAL_MEMORY_BENCHMARK_SCORE_SEMANTICS,
  hashExternalMemoryBenchmarkInput,
  parseExternalMemoryBenchmarkJsonl,
  runExternalMemoryBenchmark,
  type ExternalMemoryBenchmarkCase,
  type ExternalMemoryBenchmarkCounter,
  type ExternalMemoryBenchmarkDatasetFormat,
  type ExternalMemoryBenchmarkDiagnosticsLevel,
  type ExternalMemoryBenchmarkMode,
  type ExternalMemoryBenchmarkResult,
  type ExternalMemoryBenchmarkScoreSemantics,
  type ExternalMemoryBenchmarkSliceScore,
  type ExternalMemoryBenchmarkTemporalMode,
  type RunExternalMemoryBenchmarkOptions,
} from "./external.js";
import {
  parseExternalMemoryBenchmarkDataset,
  type ExternalMemoryBenchmarkDatasetAdapter,
} from "./external-adapters.js";

export interface ExternalMemoryBenchmarkSuiteRunConfig {
  id: string;
  inputFile: string;
  datasetFormat?: ExternalMemoryBenchmarkDatasetAdapter | undefined;
  mode?: ExternalMemoryBenchmarkMode | undefined;
  requireConvergence?: boolean | undefined;
  maxSteps?: number | undefined;
  maxBranch?: number | undefined;
  maxMemories?: number | undefined;
  contextBudgetTokens?: number | undefined;
  temporalMode?: ExternalMemoryBenchmarkTemporalMode | undefined;
  includeSensitive?: boolean | undefined;
  includeTemporalMetadata?: boolean | undefined;
  concurrency?: number | undefined;
  reuseProfiles?: boolean | undefined;
  failureSampleLimit?: number | undefined;
  diagnosticsLevel?: ExternalMemoryBenchmarkDiagnosticsLevel | undefined;
}

export interface ExternalMemoryBenchmarkSuiteDocument {
  schema?: "gmos.external_benchmark_suite.v1" | undefined;
  defaults?: Omit<ExternalMemoryBenchmarkSuiteRunConfig, "id" | "inputFile" | "datasetFormat"> & {
    datasetFormat?: ExternalMemoryBenchmarkDatasetAdapter | undefined;
  } | undefined;
  runs: ExternalMemoryBenchmarkSuiteRunConfig[];
}

export interface ExternalMemoryBenchmarkSuiteRunSummary {
  id: string;
  inputFile: string;
  datasetFormat: ExternalMemoryBenchmarkDatasetFormat;
  pass: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  caseCount: number;
  passedCount: number;
  failedCount: number;
  score: number;
  strictScore: number;
  normalizedEvidenceScore: number;
  normalizedEvidencePassedCount: number;
  caseGroupCount: number;
  reusedProfileCaseCount: number;
  runtime: ExternalMemoryBenchmarkResult["summary"]["runtime"];
  datasetHash: string | null;
  warningCount: number;
  warnings: string[];
  failureReasons: ExternalMemoryBenchmarkCounter[];
  failureStages: ExternalMemoryBenchmarkCounter[];
  sliceScores?: ExternalMemoryBenchmarkSliceScore[] | undefined;
  jsonFile?: string | undefined;
  markdownFile?: string | undefined;
}

export interface ExternalMemoryBenchmarkSuiteResult {
  schema: "gmos.external_benchmark_suite.v1";
  pass: boolean;
  benchmarkPass: boolean;
  runCount: number;
  passedRunCount: number;
  failedRunCount: number;
  scoreMean: number;
  scoreWeighted: number;
  strictScoreMean: number;
  strictScoreWeighted: number;
  normalizedEvidenceScoreMean: number;
  normalizedEvidenceScoreWeighted: number;
  totalCaseCount: number;
  totalPassedCount: number;
  totalNormalizedEvidencePassedCount: number;
  totalFailedCount: number;
  totalWarningCount: number;
  totalFailureReasons: ExternalMemoryBenchmarkCounter[];
  totalFailureStages: ExternalMemoryBenchmarkCounter[];
  runManifest: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    suiteFile: string | null;
    suiteHash: string | null;
    baseDir: string;
    failOnBenchmarkFail: boolean;
    node: string | null;
    platform: string | null;
    package: ExternalMemoryBenchmarkResult["runManifest"]["package"] | null;
    git: ExternalMemoryBenchmarkResult["runManifest"]["git"] | null;
    scoreSemantics: ExternalMemoryBenchmarkScoreSemantics;
    deterministicOnly: true;
  };
  runs: ExternalMemoryBenchmarkSuiteRunSummary[];
}

export interface ExternalMemoryBenchmarkSuiteExecution {
  result: ExternalMemoryBenchmarkSuiteResult;
  reports: Record<string, ExternalMemoryBenchmarkResult>;
}

export interface RunExternalMemoryBenchmarkSuiteOptions {
  suite: ExternalMemoryBenchmarkSuiteDocument;
  suiteFile?: string | undefined;
  baseDir?: string | undefined;
  failOnBenchmarkFail?: boolean | undefined;
  onRunResult?: ((summary: ExternalMemoryBenchmarkSuiteRunSummary) => void) | undefined;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function datasetAdapter(value: unknown, label: string): ExternalMemoryBenchmarkDatasetAdapter | undefined {
  if (value === undefined) return undefined;
  if (value === "gmos" || value === "longmemeval" || value === "locomo") return value;
  throw new Error(`${label} must be gmos, longmemeval, or locomo`);
}

function modeValue(value: unknown, label: string): ExternalMemoryBenchmarkMode | undefined {
  if (value === undefined) return undefined;
  if (value === "prepare" || value === "reconstruct") return value;
  throw new Error(`${label} must be prepare or reconstruct`);
}

function temporalModeValue(value: unknown, label: string): ExternalMemoryBenchmarkTemporalMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "current" || value === "history") return value;
  throw new Error(`${label} must be auto, current, or history`);
}

function diagnosticsLevelValue(
  value: unknown,
  label: string,
): ExternalMemoryBenchmarkDiagnosticsLevel | undefined {
  if (value === undefined) return undefined;
  if (value === "off" || value === "basic" || value === "full") return value;
  throw new Error(`${label} must be off, basic, or full`);
}

function runId(value: unknown, label: string): string {
  const id = stringValue(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error(`${label} must use only letters, numbers, dot, underscore, or dash`);
  }
  return id;
}

function parseRunConfig(value: unknown, label: string): ExternalMemoryBenchmarkSuiteRunConfig {
  const record = assertRecord(value, label);
  return {
    id: runId(record.id, `${label}.id`),
    inputFile: stringValue(record.inputFile, `${label}.inputFile`),
    datasetFormat: datasetAdapter(record.datasetFormat, `${label}.datasetFormat`),
    mode: modeValue(record.mode, `${label}.mode`),
    requireConvergence: optionalBoolean(record.requireConvergence, `${label}.requireConvergence`),
    maxSteps: optionalPositiveInteger(record.maxSteps, `${label}.maxSteps`),
    maxBranch: optionalPositiveInteger(record.maxBranch, `${label}.maxBranch`),
    maxMemories: optionalPositiveInteger(record.maxMemories, `${label}.maxMemories`),
    contextBudgetTokens: optionalPositiveInteger(record.contextBudgetTokens, `${label}.contextBudgetTokens`),
    temporalMode: temporalModeValue(record.temporalMode, `${label}.temporalMode`),
    includeSensitive: optionalBoolean(record.includeSensitive, `${label}.includeSensitive`),
    includeTemporalMetadata: optionalBoolean(record.includeTemporalMetadata, `${label}.includeTemporalMetadata`),
    concurrency: optionalPositiveInteger(record.concurrency, `${label}.concurrency`),
    reuseProfiles: optionalBoolean(record.reuseProfiles, `${label}.reuseProfiles`),
    failureSampleLimit: optionalNonNegativeInteger(record.failureSampleLimit, `${label}.failureSampleLimit`),
    diagnosticsLevel: diagnosticsLevelValue(record.diagnosticsLevel, `${label}.diagnosticsLevel`),
  };
}

function parseDefaults(value: unknown): ExternalMemoryBenchmarkSuiteDocument["defaults"] {
  if (value === undefined) return undefined;
  const record = assertRecord(value, "External benchmark suite defaults");
  return {
    datasetFormat: datasetAdapter(record.datasetFormat, "External benchmark suite defaults.datasetFormat"),
    mode: modeValue(record.mode, "External benchmark suite defaults.mode"),
    requireConvergence: optionalBoolean(record.requireConvergence, "External benchmark suite defaults.requireConvergence"),
    maxSteps: optionalPositiveInteger(record.maxSteps, "External benchmark suite defaults.maxSteps"),
    maxBranch: optionalPositiveInteger(record.maxBranch, "External benchmark suite defaults.maxBranch"),
    maxMemories: optionalPositiveInteger(record.maxMemories, "External benchmark suite defaults.maxMemories"),
    contextBudgetTokens: optionalPositiveInteger(
      record.contextBudgetTokens,
      "External benchmark suite defaults.contextBudgetTokens",
    ),
    temporalMode: temporalModeValue(record.temporalMode, "External benchmark suite defaults.temporalMode"),
    includeTemporalMetadata: optionalBoolean(
      record.includeTemporalMetadata,
      "External benchmark suite defaults.includeTemporalMetadata",
    ),
    includeSensitive: optionalBoolean(record.includeSensitive, "External benchmark suite defaults.includeSensitive"),
    concurrency: optionalPositiveInteger(record.concurrency, "External benchmark suite defaults.concurrency"),
    reuseProfiles: optionalBoolean(record.reuseProfiles, "External benchmark suite defaults.reuseProfiles"),
    failureSampleLimit: optionalNonNegativeInteger(
      record.failureSampleLimit,
      "External benchmark suite defaults.failureSampleLimit",
    ),
    diagnosticsLevel: diagnosticsLevelValue(
      record.diagnosticsLevel,
      "External benchmark suite defaults.diagnosticsLevel",
    ),
  };
}

export function parseExternalMemoryBenchmarkSuite(input: string): ExternalMemoryBenchmarkSuiteDocument {
  const parsed = JSON.parse(input) as unknown;
  const record = assertRecord(parsed, "External benchmark suite");
  if (record.schema !== undefined && record.schema !== "gmos.external_benchmark_suite.v1") {
    throw new Error("External benchmark suite schema must be gmos.external_benchmark_suite.v1");
  }
  if (!Array.isArray(record.runs) || record.runs.length === 0) {
    throw new Error("External benchmark suite requires at least one run");
  }
  const runs = record.runs.map((entry, index) => parseRunConfig(entry, `External benchmark suite run ${index + 1}`));
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.id)) throw new Error(`External benchmark suite run id is duplicated: ${run.id}`);
    seen.add(run.id);
  }
  return {
    schema: "gmos.external_benchmark_suite.v1",
    defaults: parseDefaults(record.defaults),
    runs,
  };
}

function suiteBaseDir(options: RunExternalMemoryBenchmarkSuiteOptions): string {
  if (options.baseDir) return path.resolve(options.baseDir);
  if (options.suiteFile) return path.dirname(path.resolve(options.suiteFile));
  return process.cwd();
}

function suiteFileHash(suiteFile: string | null): string | null {
  if (!suiteFile) return null;
  return hashExternalMemoryBenchmarkInput(readFileSync(suiteFile, "utf8"));
}

function resolveInputFile(baseDir: string, inputFile: string): string {
  return path.isAbsolute(inputFile) ? inputFile : path.resolve(baseDir, inputFile);
}

function effectiveRun(
  defaults: ExternalMemoryBenchmarkSuiteDocument["defaults"],
  run: ExternalMemoryBenchmarkSuiteRunConfig,
): ExternalMemoryBenchmarkSuiteRunConfig {
  return {
    id: run.id,
    inputFile: run.inputFile,
    datasetFormat: run.datasetFormat ?? defaults?.datasetFormat ?? "gmos",
    mode: run.mode ?? defaults?.mode,
    requireConvergence: run.requireConvergence ?? defaults?.requireConvergence,
    maxSteps: run.maxSteps ?? defaults?.maxSteps,
    maxBranch: run.maxBranch ?? defaults?.maxBranch,
    maxMemories: run.maxMemories ?? defaults?.maxMemories,
    contextBudgetTokens: run.contextBudgetTokens ?? defaults?.contextBudgetTokens,
    temporalMode: run.temporalMode ?? defaults?.temporalMode,
    includeSensitive: run.includeSensitive ?? defaults?.includeSensitive,
    includeTemporalMetadata: run.includeTemporalMetadata ?? defaults?.includeTemporalMetadata,
    concurrency: run.concurrency ?? defaults?.concurrency,
    reuseProfiles: run.reuseProfiles ?? defaults?.reuseProfiles,
    failureSampleLimit: run.failureSampleLimit ?? defaults?.failureSampleLimit,
    diagnosticsLevel: run.diagnosticsLevel ?? defaults?.diagnosticsLevel,
  };
}

function parsedDataset(inputText: string, datasetFormat: ExternalMemoryBenchmarkDatasetAdapter): {
  datasetFormat: ExternalMemoryBenchmarkDatasetFormat;
  cases: ExternalMemoryBenchmarkCase[];
  warnings: string[];
} {
  return datasetFormat === "gmos"
    ? {
        datasetFormat: "gmos.external_long_memory_qa.jsonl" as const,
        cases: parseExternalMemoryBenchmarkJsonl(inputText),
        warnings: [] as string[],
      }
    : parseExternalMemoryBenchmarkDataset(inputText, { adapter: datasetFormat });
}

function reportOptions(input: {
  run: ExternalMemoryBenchmarkSuiteRunConfig;
  inputText: string;
  parsed: ReturnType<typeof parsedDataset>;
  inputPath: string;
}): RunExternalMemoryBenchmarkOptions {
  const requireConvergence = input.run.requireConvergence === true;
  const cases = requireConvergence
    ? input.parsed.cases.map((benchmarkCase) => ({ ...benchmarkCase, requireConvergence: true }))
    : input.parsed.cases;
  if (
    requireConvergence &&
    (input.run.mode === "prepare" ||
      cases.some((benchmarkCase) => (benchmarkCase.mode ?? input.run.mode ?? "reconstruct") === "prepare"))
  ) {
    throw new Error(`External benchmark suite run ${input.run.id} cannot require convergence in prepare mode`);
  }
  return {
    cases,
    datasetHash: hashExternalMemoryBenchmarkInput(input.inputText),
    datasetId: path.basename(input.inputPath),
    datasetFormat: input.parsed.datasetFormat,
    datasetWarnings: "warnings" in input.parsed ? input.parsed.warnings : [],
    ...(input.run.mode !== undefined ? { mode: input.run.mode } : {}),
    ...(input.run.maxSteps !== undefined ? { maxSteps: input.run.maxSteps } : {}),
    ...(input.run.maxBranch !== undefined ? { maxBranch: input.run.maxBranch } : {}),
    ...(input.run.maxMemories !== undefined ? { maxMemories: input.run.maxMemories } : {}),
    ...(input.run.contextBudgetTokens !== undefined ? { contextBudgetTokens: input.run.contextBudgetTokens } : {}),
    ...(input.run.temporalMode !== undefined ? { temporalMode: input.run.temporalMode } : {}),
    ...(input.run.includeSensitive !== undefined ? { includeSensitive: input.run.includeSensitive } : {}),
    ...(input.run.includeTemporalMetadata !== undefined ? { includeTemporalMetadata: input.run.includeTemporalMetadata } : {}),
    ...(input.run.concurrency !== undefined ? { concurrency: input.run.concurrency } : {}),
    ...(input.run.reuseProfiles !== undefined ? { reuseProfiles: input.run.reuseProfiles } : {}),
    ...(input.run.failureSampleLimit !== undefined ? { failureSampleLimit: input.run.failureSampleLimit } : {}),
    ...(input.run.diagnosticsLevel !== undefined ? { diagnosticsLevel: input.run.diagnosticsLevel } : {}),
    ...(requireConvergence ? { requireConvergence: true } : {}),
  };
}

function durationMs(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function aggregateCounters(
  inputs: ExternalMemoryBenchmarkCounter[][],
): ExternalMemoryBenchmarkCounter[] {
  const counts = new Map<string, number>();
  for (const counters of inputs) {
    for (const counter of counters) {
      counts.set(counter.name, (counts.get(counter.name) ?? 0) + counter.count);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function runExternalMemoryBenchmarkSuite(
  options: RunExternalMemoryBenchmarkSuiteOptions,
): Promise<ExternalMemoryBenchmarkSuiteExecution> {
  const startedAt = new Date().toISOString();
  const baseDir = suiteBaseDir(options);
  const suiteFile = options.suiteFile ? path.resolve(options.suiteFile) : null;
  const suiteHash = suiteFileHash(suiteFile);
  const reports: Record<string, ExternalMemoryBenchmarkResult> = {};
  const runs: ExternalMemoryBenchmarkSuiteRunSummary[] = [];
  for (const runConfig of options.suite.runs) {
    const run = effectiveRun(options.suite.defaults, runConfig);
    const inputPath = resolveInputFile(baseDir, run.inputFile);
    const inputText = readFileSync(inputPath, "utf8");
    const parsed = parsedDataset(inputText, run.datasetFormat ?? "gmos");
    const report = await runExternalMemoryBenchmark(
      reportOptions({
        run,
        inputText,
        parsed,
        inputPath,
      }),
    );
    reports[run.id] = report;
    const summary: ExternalMemoryBenchmarkSuiteRunSummary = {
      id: run.id,
      inputFile: run.inputFile,
      datasetFormat: report.datasetFormat,
      pass: report.pass,
      startedAt: report.runManifest.startedAt,
      finishedAt: report.runManifest.finishedAt,
      durationMs: durationMs(report.runManifest.startedAt, report.runManifest.finishedAt),
      caseCount: report.caseCount,
      passedCount: report.passedCount,
      failedCount: report.failedCount,
      score: report.score,
      strictScore: report.strictScore,
      normalizedEvidenceScore: report.normalizedEvidenceScore,
      normalizedEvidencePassedCount: report.normalizedEvidencePassedCount,
      caseGroupCount: report.runManifest.execution.caseGroupCount,
      reusedProfileCaseCount: report.runManifest.execution.reusedProfileCaseCount,
      runtime: report.summary.runtime,
      datasetHash: report.runManifest.dataset.hash,
      warningCount: report.runManifest.dataset.warnings.length,
      warnings: report.runManifest.dataset.warnings,
      failureReasons: report.summary.failureReasons,
      failureStages: report.summary.failureStages ?? [],
      sliceScores: report.summary.sliceScores,
    };
    runs.push(summary);
    options.onRunResult?.(summary);
  }
  const benchmarkPass = runs.every((run) => run.pass);
  const scoreMean = runs.length ? runs.reduce((sum, run) => sum + run.score, 0) / runs.length : 0;
  const strictScoreMean = runs.length
    ? runs.reduce((sum, run) => sum + run.strictScore, 0) / runs.length
    : 0;
  const normalizedEvidenceScoreMean = runs.length
    ? runs.reduce((sum, run) => sum + run.normalizedEvidenceScore, 0) / runs.length
    : 0;
  const totalCaseCount = runs.reduce((sum, run) => sum + run.caseCount, 0);
  const totalPassedCount = runs.reduce((sum, run) => sum + run.passedCount, 0);
  const totalNormalizedEvidencePassedCount = runs.reduce(
    (sum, run) => sum + run.normalizedEvidencePassedCount,
    0,
  );
  const totalFailedCount = runs.reduce((sum, run) => sum + run.failedCount, 0);
  const totalWarningCount = runs.reduce((sum, run) => sum + run.warningCount, 0);
  const totalFailureReasons = aggregateCounters(runs.map((run) => run.failureReasons));
  const totalFailureStages = aggregateCounters(runs.map((run) => run.failureStages));
  const firstRunManifest = Object.values(reports)[0]?.runManifest;
  const failOnBenchmarkFail = options.failOnBenchmarkFail === true;
  const finishedAt = new Date().toISOString();
  return {
    result: {
      schema: "gmos.external_benchmark_suite.v1",
      pass: !failOnBenchmarkFail || benchmarkPass,
      benchmarkPass,
      runCount: runs.length,
      passedRunCount: runs.filter((run) => run.pass).length,
      failedRunCount: runs.filter((run) => !run.pass).length,
      scoreMean,
      scoreWeighted: totalCaseCount ? totalPassedCount / totalCaseCount : 0,
      strictScoreMean,
      strictScoreWeighted: totalCaseCount ? totalPassedCount / totalCaseCount : 0,
      normalizedEvidenceScoreMean,
      normalizedEvidenceScoreWeighted: totalCaseCount
        ? totalNormalizedEvidencePassedCount / totalCaseCount
        : 0,
      totalCaseCount,
      totalPassedCount,
      totalNormalizedEvidencePassedCount,
      totalFailedCount,
      totalWarningCount,
      totalFailureReasons,
      totalFailureStages,
      runManifest: {
        startedAt,
        finishedAt,
        durationMs: durationMs(startedAt, finishedAt),
        suiteFile,
        suiteHash,
        baseDir,
        failOnBenchmarkFail,
        node: firstRunManifest?.node ?? null,
        platform: firstRunManifest?.platform ?? null,
        package: firstRunManifest?.package ?? null,
        git: firstRunManifest?.git ?? null,
        scoreSemantics: { ...EXTERNAL_MEMORY_BENCHMARK_SCORE_SEMANTICS },
        deterministicOnly: true,
      },
      runs,
    },
    reports,
  };
}
