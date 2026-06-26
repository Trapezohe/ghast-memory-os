import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { redactForReport } from "../kernel/safety.js";

export interface StateBenchLearning {
  id: string;
  domain: string;
  content: string;
  sourceFile: string;
  toolSequence: string[];
  queryHint: string;
}

export interface StateBenchLearningsArtifact {
  schema: "gmos.state_bench_learnings.v1";
  framework: "state-bench-agent-learning-track";
  domain: string;
  source: {
    protocol: "state-bench-agent-learning-track";
    input: "datasets/train_task_trajectories";
    domain: string;
  };
  itemCount: number;
  warnings: string[];
  learnings: StateBenchLearning[];
}

export interface BuildStateBenchLearningsOptions {
  domain: string;
  inputDir: string;
  maxContentChars?: number | undefined;
  maxItems?: number | undefined;
  allowNonTrainInput?: boolean | undefined;
}

export interface PrepareStateBenchAgentLearningRunOptions {
  domain: string;
  checkoutDir: string;
  agentModelName: string;
  agentModelReasoningLevel?: string | undefined;
  numRuns?: number | undefined;
  numWorkers?: number | undefined;
  maxContentChars?: number | undefined;
  maxItems?: number | undefined;
  learningsFile?: string | undefined;
  agentFile?: string | undefined;
  outputDir?: string | undefined;
  manifestFile?: string | undefined;
  force?: boolean | undefined;
}

export interface StateBenchPreparedRunManifest {
  schema: "gmos.state_bench_prepare_run.v1";
  framework: "state-bench-agent-learning-track";
  domain: string;
  source: {
    protocol: "state-bench-agent-learning-track";
    input: "datasets/train_task_trajectories";
    domain: string;
  };
  artifacts: {
    learningsFile: string;
    agentFile: string;
    outputDir: string;
    manifestFile?: string | undefined;
  };
  officialSettings: {
    agentClass: "GmosMemoryAgent";
    retrieveLearningsTopK: 3;
    numRuns: number;
    numWorkers: number;
    agentModelName: string;
    agentModelReasoningLevel?: string | undefined;
  };
  environment: {
    GMOS_STATE_BENCH_LEARNINGS_PATH: string;
  };
  commands: {
    runBatch: string[];
    computeMetrics: string[];
  };
  learnings: {
    itemCount: number;
    warnings: string[];
  };
  notes: string[];
}

export interface SummarizeStateBenchResultsOptions {
  domain: string;
  checkoutDir: string;
  resultsDir?: string | undefined;
  metricsFile?: string | undefined;
  prepareManifestFile?: string | undefined;
}

export interface StateBenchResultsSummary {
  schema: "gmos.state_bench_results_summary.v1";
  framework: "state-bench-agent-learning-track";
  domain: string;
  source: {
    protocol: "state-bench-agent-learning-track";
    metricsFile: string;
    resultsDir: string;
    prepareManifestFile?: string | undefined;
  };
  officialMetrics: {
    benchmarkVersion?: string | undefined;
    evaluationProtocolId?: string | undefined;
    numRuns: number;
    agentModel?: unknown;
    metrics: Record<string, number>;
  };
  preparedRun?: {
    agentClass: string;
    retrieveLearningsTopK: number;
    numRuns: number;
    agentModelName: string;
    learningsFile?: string | undefined;
    agentFile?: string | undefined;
  } | undefined;
  coverage: {
    runDirectoryCount: number;
    trajectoryFileCount: number;
    perRunTrajectoryFileCounts: Array<{ run: string; count: number }>;
    perTaskMetricsCount: number;
  };
  validation: {
    status: "pass" | "warning";
    warnings: string[];
  };
  notes: string[];
}

interface ToolCallSummary {
  name: string;
  marker: string;
}

const DEFAULT_MAX_CONTENT_CHARS = 520;
const DEFAULT_AGENT_FILE = path.join("agents", "gmos_memory_agent.py");
const DEFAULT_LEARNINGS_DIR = path.join("outputs", "gmos-learnings");
const DEFAULT_OUTPUTS_DIR = "outputs";
const STATE_BENCH_TOP_K = 3;

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function publicText(value: string): string {
  return redactForReport(cleanText(value));
}

function clip(text: string, limit: number): string {
  const normalized = publicText(text);
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}...`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonFiles(inputDir: string): string[] {
  return readdirSync(inputDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(inputDir, entry));
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const parsed = Math.trunc(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function ensureInsideCheckout(input: {
  checkoutDir: string;
  filePath: string;
  label: string;
}): { absolute: string; relative: string } {
  const absolute = path.resolve(input.checkoutDir, input.filePath);
  const relative = path.relative(input.checkoutDir, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${input.label} must stay inside the STATE-Bench checkout`);
  }
  return { absolute, relative };
}

function assertRealPathInsideCheckout(input: {
  checkoutDir: string;
  absolute: string;
  label: string;
}): void {
  const checkoutRealPath = realpathSync(input.checkoutDir);
  const realPath = realpathSync(input.absolute);
  const relative = path.relative(checkoutRealPath, realPath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${input.label} must stay inside the STATE-Bench checkout`);
  }
}

function assertExistingFileInsideCheckout(input: {
  checkoutDir: string;
  absolute: string;
  label: string;
}): void {
  if (!existsSync(input.absolute) || !statSync(input.absolute).isFile()) {
    throw new Error(`${input.label} file does not exist`);
  }
  assertRealPathInsideCheckout(input);
}

function assertExistingDirectoryInsideCheckout(input: {
  checkoutDir: string;
  absolute: string;
  label: string;
}): void {
  if (!existsSync(input.absolute)) return;
  if (!statSync(input.absolute).isDirectory()) {
    throw new Error(`${input.label} directory does not exist`);
  }
  assertRealPathInsideCheckout(input);
}

function writeJsonFile(filePath: string, payload: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJsonFile(filePath: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return assertRecord(parsed, label);
}

function assertDistinctFiles(files: Array<{ label: string; absolute: string }>): void {
  const seen = new Map<string, string>();
  for (const file of files) {
    const previous = seen.get(file.absolute);
    if (previous) {
      throw new Error(`STATE-Bench ${file.label} must not reuse ${previous}`);
    }
    seen.set(file.absolute, file.label);
  }
}

function assertDirectoryExists(input: { absolute: string; label: string }): void {
  if (!existsSync(input.absolute) || !statSync(input.absolute).isDirectory()) {
    throw new Error(`${input.label} directory does not exist`);
  }
}

function numericMetrics(value: unknown): Record<string, number> {
  const record = assertRecord(value, "STATE-Bench metrics.metrics");
  const output: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "number" && Number.isFinite(entry)) output[key] = entry;
  }
  return output;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? redactForReport(value.trim()) : undefined;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function publicJsonScalar(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactForReport(value);
  return undefined;
}

function publicJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const safeValue = publicJsonScalar(entry);
    if (safeValue !== undefined) output[redactForReport(key)] = safeValue;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function publicAgentModel(value: unknown): unknown {
  const scalar = publicJsonScalar(value);
  if (scalar !== undefined) return scalar;
  return publicJsonObject(value);
}

function safePreparedArtifactPath(input: {
  checkoutDir: string;
  filePath: unknown;
  label: "learnings_file" | "agent_file";
  warnings: string[];
}): string | undefined {
  if (typeof input.filePath !== "string" || !input.filePath.trim()) {
    input.warnings.push(`prepare_manifest_${input.label}_missing`);
    return undefined;
  }
  try {
    const safePath = ensureInsideCheckout({
      checkoutDir: input.checkoutDir,
      filePath: input.filePath,
      label: `STATE-Bench prepare manifest ${input.label}`,
    });
    return redactForReport(safePath.relative);
  } catch {
    input.warnings.push(`prepare_manifest_${input.label}_unsafe`);
    return undefined;
  }
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function runDirectories(resultsDir: string): string[] {
  if (!existsSync(resultsDir) || !statSync(resultsDir).isDirectory()) return [];
  return readdirSync(resultsDir)
    .filter((entry) => /^run\d+$/u.test(entry))
    .filter((entry) => statSync(path.join(resultsDir, entry)).isDirectory())
    .sort((left, right) => Number(left.slice(3)) - Number(right.slice(3)));
}

function jsonFileCount(dir: string): number {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
  return readdirSync(dir).filter((entry) => entry.endsWith(".json")).length;
}

function parsePreparedManifest(value: Record<string, unknown>): StateBenchPreparedRunManifest | null {
  if (value.schema !== "gmos.state_bench_prepare_run.v1") return null;
  const officialSettings = assertRecord(value.officialSettings, "STATE-Bench prepare officialSettings");
  const artifacts = assertRecord(value.artifacts, "STATE-Bench prepare artifacts");
  return {
    schema: "gmos.state_bench_prepare_run.v1",
    framework: "state-bench-agent-learning-track",
    domain: String(value.domain ?? ""),
    source: assertRecord(value.source, "STATE-Bench prepare source") as StateBenchPreparedRunManifest["source"],
    artifacts: artifacts as StateBenchPreparedRunManifest["artifacts"],
    officialSettings: officialSettings as StateBenchPreparedRunManifest["officialSettings"],
    environment: assertRecord(value.environment, "STATE-Bench prepare environment") as StateBenchPreparedRunManifest["environment"],
    commands: assertRecord(value.commands, "STATE-Bench prepare commands") as StateBenchPreparedRunManifest["commands"],
    learnings: assertRecord(value.learnings, "STATE-Bench prepare learnings") as StateBenchPreparedRunManifest["learnings"],
    notes: Array.isArray(value.notes) ? value.notes.map(String) : [],
  };
}

function conversationFromFile(filePath: string): Record<string, unknown>[] | null {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const record = assertRecord(parsed, "STATE-Bench trajectory");
  return Array.isArray(record.conversation)
    ? record.conversation
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : null;
}

function assertTrainTrajectoryInput(inputDir: string, domain: string, allowNonTrainInput: boolean): void {
  if (allowNonTrainInput) return;
  const normalized = inputDir.split(path.sep).join("/");
  const suffix = `datasets/train_task_trajectories/${domain}`;
  if (!normalized.endsWith(suffix)) {
    throw new Error(
      "STATE-Bench learnings must be built from datasets/train_task_trajectories/<domain>; pass allowNonTrainInput only for isolated fixtures",
    );
  }
}

function queryHintForTrajectory(id: string): string {
  const tokens = id
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(tokens)).slice(0, 10).join(" ");
}

function invalidTrajectoryCode(error: unknown): string {
  return error instanceof SyntaxError ? "parse_error" : "invalid_trajectory";
}

function toolCalls(conversation: Record<string, unknown>[]): ToolCallSummary[] {
  const calls: ToolCallSummary[] = [];
  for (const message of conversation) {
    const rawCalls = message.tool_calls;
    if (!Array.isArray(rawCalls)) continue;
    for (const call of rawCalls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) continue;
      const record = call as Record<string, unknown>;
      const name = stringValue(record.name);
      if (!name) continue;
      const args =
        record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
          ? (record.arguments as Record<string, unknown>)
          : {};
      let marker = "";
      if (args.confirm === false) marker = "preview";
      if (args.confirm === true) marker = "confirmed";
      calls.push({ name, marker });
    }
  }
  return calls;
}

function toolSequenceSummary(calls: ToolCallSummary[]): string {
  return calls
    .map((call) => (call.marker ? `${call.name}(${call.marker})` : call.name))
    .join(" -> ");
}

function learningFromTrajectory(input: {
  domain: string;
  filePath: string;
  inputDir: string;
  conversation: Record<string, unknown>[];
  maxContentChars: number;
}): StateBenchLearning | null {
  const calls = toolCalls(input.conversation);
  if (calls.length === 0) return null;
  const toolSequence = toolSequenceSummary(calls);
  const id = path.basename(input.filePath, ".json");
  const queryHint = queryHintForTrajectory(id);
  const content = clip(
    [
      `Domain: ${input.domain}.`,
      queryHint ? `Task cue: ${queryHint}.` : "",
      `Useful procedure from prior successful train trajectory: ${toolSequence}.`,
      "Use domain lookup tools before acting, preview fees or irreversible changes when available, ask for missing choices, and get explicit confirmation before mutating bookings, orders, carts, refunds, or account state.",
    ]
      .filter(Boolean)
      .join(" "),
    input.maxContentChars,
  );
  return {
    id,
    domain: input.domain,
    content,
    sourceFile: path.relative(input.inputDir, input.filePath),
    toolSequence: calls.map((call) => (call.marker ? `${call.name}(${call.marker})` : call.name)),
    queryHint,
  };
}

export function buildStateBenchLearnings(
  options: BuildStateBenchLearningsOptions,
): StateBenchLearningsArtifact {
  const domain = cleanText(options.domain);
  if (!domain) throw new Error("STATE-Bench learnings require a domain");
  const inputDir = path.resolve(options.inputDir);
  assertTrainTrajectoryInput(inputDir, domain, options.allowNonTrainInput === true);
  assertDirectoryExists({
    absolute: inputDir,
    label: "STATE-Bench train trajectory",
  });
  const maxContentChars = Math.max(120, Math.trunc(options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS));
  const maxItems =
    options.maxItems === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.trunc(options.maxItems));
  const warnings: string[] = [];
  const learnings: StateBenchLearning[] = [];
  for (const filePath of jsonFiles(inputDir)) {
    if (learnings.length >= maxItems) break;
    try {
      const conversation = conversationFromFile(filePath);
      if (!conversation) {
        warnings.push(`skipped_no_conversation:${path.basename(filePath)}`);
        continue;
      }
      const learning = learningFromTrajectory({
        domain,
        filePath,
        inputDir,
        conversation,
        maxContentChars,
      });
      if (!learning) {
        warnings.push(`skipped_no_tool_calls:${path.basename(filePath)}`);
        continue;
      }
      learnings.push(learning);
    } catch (error) {
      warnings.push(`skipped_invalid_json:${path.basename(filePath)}:${invalidTrajectoryCode(error)}`);
    }
  }
  if (learnings.length === 0) {
    throw new Error("STATE-Bench learnings builder found no train trajectories with tool calls");
  }
  return {
    schema: "gmos.state_bench_learnings.v1",
    framework: "state-bench-agent-learning-track",
    domain,
    source: {
      protocol: "state-bench-agent-learning-track",
      input: "datasets/train_task_trajectories",
      domain,
    },
    itemCount: learnings.length,
    warnings,
    learnings,
  };
}

export function prepareStateBenchAgentLearningRun(
  options: PrepareStateBenchAgentLearningRunOptions,
): StateBenchPreparedRunManifest {
  const domain = cleanText(options.domain);
  if (!domain) throw new Error("STATE-Bench prepare requires a domain");
  const agentModelName = cleanText(options.agentModelName);
  if (!agentModelName) throw new Error("STATE-Bench prepare requires an agentModelName");
  const checkoutDir = path.resolve(options.checkoutDir);
  const inputDir = path.join(checkoutDir, "datasets", "train_task_trajectories", domain);
  const learningsPath = ensureInsideCheckout({
    checkoutDir,
    filePath: options.learningsFile ?? path.join(DEFAULT_LEARNINGS_DIR, `${domain}.json`),
    label: "STATE-Bench learningsFile",
  });
  const agentPath = ensureInsideCheckout({
    checkoutDir,
    filePath: options.agentFile ?? DEFAULT_AGENT_FILE,
    label: "STATE-Bench agentFile",
  });
  const outputPath = ensureInsideCheckout({
    checkoutDir,
    filePath: options.outputDir ?? path.join(DEFAULT_OUTPUTS_DIR, domain),
    label: "STATE-Bench outputDir",
  });
  const manifestPath = options.manifestFile
    ? ensureInsideCheckout({
        checkoutDir,
        filePath: options.manifestFile,
        label: "STATE-Bench manifestFile",
      })
    : null;
  assertDistinctFiles(
    [
      { label: "learningsFile", absolute: learningsPath.absolute },
      { label: "agentFile", absolute: agentPath.absolute },
      manifestPath ? { label: "manifestFile", absolute: manifestPath.absolute } : null,
    ].filter((file): file is { label: string; absolute: string } => file !== null),
  );
  const numRuns = positiveInteger(options.numRuns, 5, "STATE-Bench numRuns");
  const numWorkers = positiveInteger(options.numWorkers, 1, "STATE-Bench numWorkers");
  const artifact = buildStateBenchLearnings({
    domain,
    inputDir,
    maxContentChars: options.maxContentChars,
    maxItems: options.maxItems,
  });
  const agentPython = stateBenchAgentPythonTemplate();
  const agentExists = existsSync(agentPath.absolute);
  if (agentExists && !options.force) {
    const existing = readFileSync(agentPath.absolute, "utf8");
    if (existing !== agentPython) {
      throw new Error("STATE-Bench agent file exists; pass force to replace it");
    }
  }

  writeJsonFile(learningsPath.absolute, artifact);

  if (!agentExists || options.force) {
    mkdirSync(path.dirname(agentPath.absolute), { recursive: true });
    writeFileSync(agentPath.absolute, agentPython);
  }

  const runBatch = [
    "uv",
    "run",
    "python",
    "-m",
    "state_bench.scripts.run_batch",
    "--domain",
    domain,
    "--agent-class",
    "GmosMemoryAgent",
    "--agent-model-name",
    agentModelName,
    "--num-runs",
    String(numRuns),
    "--retrieve-learnings-top-k",
    String(STATE_BENCH_TOP_K),
    "--num-workers",
    String(numWorkers),
    "--output-dir",
    outputPath.relative,
  ];
  const agentModelReasoningLevel =
    options.agentModelReasoningLevel === undefined
      ? undefined
      : cleanText(options.agentModelReasoningLevel);
  if (agentModelReasoningLevel) {
    runBatch.push("--agent-model-reasoning-level", agentModelReasoningLevel);
  }
  const computeMetrics = [
    "uv",
    "run",
    "python",
    "-m",
    "state_bench.scripts.compute_metrics",
    "--domain",
    domain,
    "--results-dir",
    outputPath.relative,
    "--num-runs",
    String(numRuns),
    "--output-dir",
    outputPath.relative,
  ];
  const manifest: StateBenchPreparedRunManifest = {
    schema: "gmos.state_bench_prepare_run.v1",
    framework: "state-bench-agent-learning-track",
    domain,
    source: {
      protocol: "state-bench-agent-learning-track",
      input: "datasets/train_task_trajectories",
      domain,
    },
    artifacts: {
      learningsFile: learningsPath.relative,
      agentFile: agentPath.relative,
      outputDir: outputPath.relative,
      ...(manifestPath ? { manifestFile: manifestPath.relative } : {}),
    },
    officialSettings: {
      agentClass: "GmosMemoryAgent",
      retrieveLearningsTopK: STATE_BENCH_TOP_K,
      numRuns,
      numWorkers,
      agentModelName,
      ...(agentModelReasoningLevel ? { agentModelReasoningLevel } : {}),
    },
    environment: {
      GMOS_STATE_BENCH_LEARNINGS_PATH: learningsPath.relative,
    },
    commands: {
      runBatch,
      computeMetrics,
    },
    learnings: {
      itemCount: artifact.itemCount,
      warnings: artifact.warnings,
    },
    notes: [
      "Run these commands from the STATE-Bench checkout root.",
      "This prepares the Agent Learning Track hook; official scores still come only from STATE-Bench run_batch and compute_metrics.",
      "The learnings artifact is built only from datasets/train_task_trajectories/<domain>.",
    ],
  };
  if (manifestPath) writeJsonFile(manifestPath.absolute, manifest);
  return manifest;
}

export function summarizeStateBenchResults(
  options: SummarizeStateBenchResultsOptions,
): StateBenchResultsSummary {
  const domain = cleanText(options.domain);
  if (!domain) throw new Error("STATE-Bench summarize requires a domain");
  const checkoutDir = path.resolve(options.checkoutDir);
  const resultsPath = ensureInsideCheckout({
    checkoutDir,
    filePath: options.resultsDir ?? path.join(DEFAULT_OUTPUTS_DIR, domain),
    label: "STATE-Bench resultsDir",
  });
  assertExistingDirectoryInsideCheckout({
    checkoutDir,
    absolute: resultsPath.absolute,
    label: "STATE-Bench resultsDir",
  });
  const metricsPath = ensureInsideCheckout({
    checkoutDir,
    filePath: options.metricsFile ?? path.join(resultsPath.relative, "metrics.json"),
    label: "STATE-Bench metricsFile",
  });
  assertExistingFileInsideCheckout({
    checkoutDir,
    absolute: metricsPath.absolute,
    label: "STATE-Bench metrics",
  });
  const defaultPrepareManifest = path.join(DEFAULT_LEARNINGS_DIR, `${domain}.prepare.json`);
  const prepareManifestPath =
    options.prepareManifestFile !== undefined
      ? ensureInsideCheckout({
          checkoutDir,
          filePath: options.prepareManifestFile,
          label: "STATE-Bench prepareManifestFile",
        })
      : ensureInsideCheckout({
          checkoutDir,
          filePath: defaultPrepareManifest,
          label: "STATE-Bench prepareManifestFile",
        });
  const metrics = readJsonFile(metricsPath.absolute, "STATE-Bench metrics");
  const officialMetrics = numericMetrics(metrics.metrics);
  const numRuns = requiredNumber(metrics.num_runs, "STATE-Bench metrics.num_runs");
  const warnings: string[] = [];
  let preparedRun: StateBenchResultsSummary["preparedRun"];
  let prepareManifestRelative: string | undefined;
  if (existsSync(prepareManifestPath.absolute)) {
    assertExistingFileInsideCheckout({
      checkoutDir,
      absolute: prepareManifestPath.absolute,
      label: "STATE-Bench prepare manifest",
    });
    const prepareManifest = parsePreparedManifest(
      readJsonFile(prepareManifestPath.absolute, "STATE-Bench prepare manifest"),
    );
    if (prepareManifest) {
      prepareManifestRelative = prepareManifestPath.relative;
      if (prepareManifest.domain !== domain) {
        warnings.push("prepare_manifest_domain_mismatch");
      }
      const preparedNumRuns = optionalPositiveNumber(prepareManifest.officialSettings.numRuns);
      const preparedTopK = optionalPositiveNumber(
        prepareManifest.officialSettings.retrieveLearningsTopK,
      );
      if (preparedNumRuns === undefined) {
        warnings.push("prepare_manifest_num_runs_invalid");
      } else if (preparedNumRuns !== numRuns) {
        warnings.push("prepare_manifest_num_runs_mismatch");
      }
      if (preparedTopK === undefined) {
        warnings.push("prepare_manifest_top_k_invalid");
      } else if (preparedTopK !== STATE_BENCH_TOP_K) {
        warnings.push("prepare_manifest_top_k_not_official");
      }
      const agentClass = optionalString(prepareManifest.officialSettings.agentClass);
      const agentModelName = optionalString(prepareManifest.officialSettings.agentModelName);
      const learningsFile = safePreparedArtifactPath({
        checkoutDir,
        filePath: prepareManifest.artifacts.learningsFile,
        label: "learnings_file",
        warnings,
      });
      const agentFile = safePreparedArtifactPath({
        checkoutDir,
        filePath: prepareManifest.artifacts.agentFile,
        label: "agent_file",
        warnings,
      });
      if (agentClass && agentModelName && preparedTopK !== undefined && preparedNumRuns !== undefined) {
        preparedRun = {
          agentClass,
          retrieveLearningsTopK: preparedTopK,
          numRuns: preparedNumRuns,
          agentModelName,
          ...(learningsFile ? { learningsFile } : {}),
          ...(agentFile ? { agentFile } : {}),
        };
      } else {
        warnings.push("prepare_manifest_summary_incomplete");
      }
    } else if (options.prepareManifestFile !== undefined) {
      warnings.push("prepare_manifest_schema_unrecognized");
    }
  } else if (options.prepareManifestFile !== undefined) {
    warnings.push("prepare_manifest_missing");
  }

  const runDirs = runDirectories(resultsPath.absolute);
  const perRunTrajectoryFileCounts = runDirs.map((runDir) => ({
    run: runDir,
    count: jsonFileCount(path.join(resultsPath.absolute, runDir)),
  }));
  if (runDirs.length > 0 && runDirs.length !== numRuns) {
    warnings.push("run_directory_count_mismatch");
  }
  if (Number(officialMetrics[`task_completion_pass^${numRuns}`] ?? Number.NaN) < 0) {
    warnings.push("official_metrics_pass_n_invalid");
  }
  const perTaskMetricsDir = path.join(resultsPath.absolute, "per_task_metrics");
  return {
    schema: "gmos.state_bench_results_summary.v1",
    framework: "state-bench-agent-learning-track",
    domain,
    source: {
      protocol: "state-bench-agent-learning-track",
      metricsFile: metricsPath.relative,
      resultsDir: resultsPath.relative,
      ...(prepareManifestRelative ? { prepareManifestFile: prepareManifestRelative } : {}),
    },
	    officialMetrics: {
	      benchmarkVersion: optionalString(metrics.benchmark_version),
	      evaluationProtocolId: optionalString(metrics.evaluation_protocol_id),
	      numRuns,
	      agentModel: publicAgentModel(metrics.agent_model),
	      metrics: officialMetrics,
	    },
    ...(preparedRun ? { preparedRun } : {}),
    coverage: {
      runDirectoryCount: runDirs.length,
      trajectoryFileCount: perRunTrajectoryFileCounts.reduce((sum, row) => sum + row.count, 0),
      perRunTrajectoryFileCounts,
      perTaskMetricsCount: jsonFileCount(perTaskMetricsDir),
    },
    validation: {
      status: warnings.length === 0 ? "pass" : "warning",
      warnings,
    },
    notes: [
      "This summary reads official STATE-Bench metrics artifacts; it does not recompute official scores.",
      "Run official STATE-Bench compute_metrics before publishing this summary.",
      "Paths are relative to the STATE-Bench checkout root.",
    ],
  };
}

export function stateBenchAgentPythonTemplate(): string {
  return `"""gmOS memory hook for STATE-Bench Agent Learning Track.

Copy this file into a STATE-Bench checkout's agents/ directory and run with:
  --agent-class GmosMemoryAgent --retrieve-learnings-top-k 3

The default mode is offline and reads a gmOS-generated learnings artifact.
Set GMOS_STATE_BENCH_USE_HTTP=1 to query a running gmOS/Ghast memory endpoint
that returns objects with content/text/learning fields.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib import error, request

from state_bench.agents.state_bench import StateBenchAgent

DEFAULT_TOP_K = 3
TOKEN_RE = re.compile(r"[\\w.-]+", re.UNICODE)


def _tokens(text: str) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(text or "")}


def _learning_text(item: object) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        value = item.get("content") or item.get("text") or item.get("learning")
        if isinstance(value, str):
            return value
    return ""


def _learning_items(payload: object) -> list[object]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        value = (
            payload.get("learnings")
            or payload.get("items")
            or payload.get("results")
            or payload.get("memories")
        )
        if isinstance(value, list):
            return value
    return []


class GmosMemoryAgent(StateBenchAgent):
    """StateBenchAgent with a read-only gmOS learning retrieval hook."""

    def _artifact_path(self) -> Path:
        explicit = os.environ.get("GMOS_STATE_BENCH_LEARNINGS_PATH")
        if explicit:
            return Path(explicit)
        domain = self.runtime_context.domain if self.runtime_context else "travel"
        return Path("outputs/gmos-learnings") / f"{domain}.json"

    def _artifact_learnings(self, query: str, top_k: int) -> list[str]:
        path = self._artifact_path()
        if not path.exists():
            return []
        payload = json.loads(path.read_text())
        query_tokens = _tokens(query)
        domain = self.runtime_context.domain if self.runtime_context else ""
        ranked: list[tuple[int, str]] = []
        for item in _learning_items(payload):
            text = _learning_text(item)
            if not text:
                continue
            score = len(query_tokens & _tokens(text))
            if isinstance(item, dict) and item.get("domain") == domain:
                score += 2
            ranked.append((score, text))
        ranked.sort(key=lambda row: row[0], reverse=True)
        return [text for score, text in ranked[:top_k] if score > 0] or [
            text for _, text in ranked[:top_k]
        ]

    def _http_learnings(self, query: str, top_k: int) -> list[str]:
        base_url = os.environ.get("GMOS_STATE_BENCH_HTTP_URL", "http://localhost:4787").rstrip("/")
        body = json.dumps({"query": query, "limit": top_k}).encode("utf-8")
        req = request.Request(
            f"{base_url}/search",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return [_learning_text(item) for item in _learning_items(payload) if _learning_text(item)][:top_k]

    def retrieve_learnings(self, query: str, top_k: int = DEFAULT_TOP_K) -> list[str]:
        top_k = max(1, int(top_k or DEFAULT_TOP_K))
        if os.environ.get("GMOS_STATE_BENCH_USE_HTTP") == "1":
            try:
                return self._http_learnings(query, top_k)
            except (OSError, error.URLError, json.JSONDecodeError):
                if os.environ.get("GMOS_STATE_BENCH_REQUIRE_HTTP") == "1":
                    raise
        return self._artifact_learnings(query, top_k)
`;
}
