#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMemoryOS } from "../runtime/create-memory-os.js";
import {
  createEvolutionControlPlane,
  renderEvolutionFailureReviewMarkdown,
  type FailureReviewStore,
} from "../evolution/index.js";
import {
  createMemoryStatusReport,
  renderMemoryStatusMarkdown,
  type DiagnosticsStore,
} from "../diagnostics/index.js";
import {
  renderHostCompatibilityGymMarkdown,
  renderExternalMemoryBenchmarkMarkdown,
  renderExternalMemoryBenchmarkSuiteMarkdown,
  renderMemoryGymMarkdown,
  renderMemoryReleaseGateMarkdown,
  renderMemoryScaleMarkdown,
  runHostCompatibilityGym,
  hashExternalMemoryBenchmarkInput,
  buildStateBenchLearnings,
  prepareStateBenchAgentLearningRun,
  summarizeStateBenchResults,
  parseExternalMemoryBenchmarkDataset,
  parseExternalMemoryBenchmarkJsonl,
  parseExternalMemoryBenchmarkSuite,
  runExternalMemoryBenchmark,
  runExternalMemoryBenchmarkSuite,
  runMemoryGym,
  runMemoryReleaseGate,
  runMemoryScaleBenchmark,
  stateBenchAgentPythonTemplate,
} from "../gym/index.js";
import {
  createPresetHostAdapter,
  exportMemorySnapshots,
  type HostActualCompatibilityReport,
  type HostPreset,
  loadHostMemorySnapshotsIntoStore,
  parseHostActualCompatibilityReports,
  parseMemorySnapshotExport,
} from "../host/index.js";
import { serveMemoryHttp } from "../http/index.js";
import {
  createMemoryMcpServer,
  listMemoryMcpTools,
  serveMemoryMcpStdio,
} from "../mcp/index.js";
import {
  createSqliteMemoryStore,
  parseSqliteProfileBackup,
  type SqliteProfileBackupConflictPolicy,
  type SqliteProfileBackupMode,
} from "../store/sqlite/index.js";
import type {
  FailureKind,
  LowLevelListMemoriesInput,
  LowLevelSearchInput,
  MemoryKind,
  ReadAuditSnapshot,
} from "../kernel/types.js";

function value(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function strictOptionValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  console.log(`gmOS CLI

Usage:
  gmos init --db ./gmos.db
  gmos doctor --db ./gmos.db --host ghast
  gmos repair --db ./gmos.db --search-index
  gmos repair --db ./gmos.db --associations
  gmos status --db ./gmos.db --profile local --host ghast --format markdown
  gmos add --db ./gmos.db --profile local --kind preference --text "我喜欢简洁回答"
  gmos update --db ./gmos.db --profile local --id memory_xxx --text "我喜欢先讲风险"
  gmos delete --db ./gmos.db --profile local --id memory_xxx --reason "manual cleanup"
  gmos clear --db ./gmos.db --profile local --scope global --reason "manual cleanup"
  gmos search --db ./gmos.db --profile local --query "简洁"
  gmos list --db ./gmos.db --profile local --query "简洁" --status active
  gmos get --db ./gmos.db --profile local --id memory_xxx
  gmos export --db ./gmos.db --profile local --output-file ./gmos-memory-export.json
  gmos import --db ./gmos.db --profile local --input-file ./gmos-memory-export.json
  gmos backup --db ./gmos.db --profile local --mode safe --output-file ./gmos-profile-backup.json
  gmos restore --db ./gmos.db --input-file ./gmos-profile-backup.json --on-conflict skip
  gmos observe --db ./gmos.db --profile local --text "我喜欢简洁回答"
  gmos prepare --db ./gmos.db --profile local --text "你知道我什么偏好吗？"
  gmos reconstruct --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？"
  gmos explain-path --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？"
  gmos forget --db ./gmos.db --profile local --query "Moonbase"
  gmos explain --db ./gmos.db --profile local --id memory_xxx
  gmos mcp tools
  gmos mcp call --db ./gmos.db --tool memory.prepare_context --input '{"text":"你知道我什么偏好吗？"}'
  gmos mcp serve --db ./gmos.db --profile local
  gmos http serve --db ./gmos.db --profile local --port 4787 --host ghast --auth-token local-dev-token
  gmos evolution report --db ./gmos.db --profile local --format markdown
  gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
  gmos gym run --db :memory: --generated-seeds 3 --format markdown --report-file ./memory-gym.md
  gmos gym scale --sizes 100,1000 --threshold-p95-ms 250
  gmos gym external --input-file ./long-memory-qa.jsonl --dataset-format gmos --format markdown --require-convergence --include-sensitive --temporal-metadata
  gmos gym external --input-file ./longmemeval_s_cleaned.json --dataset-format longmemeval --format json --json-file ./longmemeval.json --markdown-file ./longmemeval.md --concurrency 4 --progress
  gmos gym external --input-file ./locomo10.json --dataset-format locomo --format json --json-file ./locomo.json --markdown-file ./locomo.md --failure-sample-limit 20 --concurrency 2 --progress
  gmos gym external-suite --suite-file ./external-suite.json --output-dir ./external-runs --format markdown
  gmos gym statebench build-learnings --domain travel --input-dir ./STATE-Bench/datasets/train_task_trajectories/travel --output-file ./outputs/gmos-learnings/travel.json
  gmos gym statebench write-agent --output-file ./STATE-Bench/agents/gmos_memory_agent.py
  gmos gym statebench prepare --checkout-dir ./STATE-Bench --domain travel --agent-model-name gpt-5.1 --num-workers 2 --manifest-file outputs/gmos-learnings/travel.prepare.json
  gmos gym statebench summarize --checkout-dir ./STATE-Bench --domain travel --metrics-file outputs/travel/metrics.json
  gmos gym gate --generated-seeds 3 --scale-sizes 100,1000 --format json
  gmos gym host --hosts ghast,mcp,mock_l3,search_only --actual-report ./host-status.json --format markdown
`);
  process.exit(1);
}

function writeReportIfRequested(content: string): void {
  const reportFile = strictOptionValue("--report-file");
  if (!reportFile) return;
  const resolved = path.resolve(process.cwd(), reportFile);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
}

function writeOutputFileIfRequested(optionName: string, content: string): void {
  const outputFile = strictOptionValue(optionName);
  if (!outputFile) return;
  const resolved = path.resolve(process.cwd(), outputFile);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
}

function printReport(json: unknown, markdown: string): void {
  const format = value("--format", "json");
  const jsonOutput = JSON.stringify(json, null, 2);
  const output = format === "markdown" ? markdown : jsonOutput;
  writeReportIfRequested(output);
  writeOutputFileIfRequested("--json-file", jsonOutput);
  writeOutputFileIfRequested("--markdown-file", markdown);
  console.log(output);
}

function writeExternalSuiteOutputs(input: {
  outputDir: string;
  result: Awaited<ReturnType<typeof runExternalMemoryBenchmarkSuite>>["result"];
  reports: Awaited<ReturnType<typeof runExternalMemoryBenchmarkSuite>>["reports"];
}): void {
  const outputDir = path.resolve(process.cwd(), input.outputDir);
  mkdirSync(outputDir, { recursive: true });
  for (const run of input.result.runs) {
    const report = input.reports[run.id];
    if (!report) throw new Error(`External benchmark suite run ${run.id} did not produce a report`);
    const jsonFile = `${run.id}.json`;
    const markdownFile = `${run.id}.md`;
    const jsonPath = path.join(outputDir, jsonFile);
    const markdownPath = path.join(outputDir, markdownFile);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(markdownPath, renderExternalMemoryBenchmarkMarkdown(report));
    run.jsonFile = path.relative(process.cwd(), jsonPath);
    run.markdownFile = path.relative(process.cwd(), markdownPath);
  }
}

function parsePositiveIntegerList(raw: string, label: string): number[] {
  const tokens = raw.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error(`${label} requires comma-separated positive integers`);
  }
  const values = tokens.map((token) => Number(token));
  if (values.some((entry) => !Number.isInteger(entry) || entry <= 0)) {
    throw new Error(`${label} requires comma-separated positive integers`);
  }
  return values;
}

function positiveIntegerOption(name: string, fallback: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeNumberOption(name: string, fallback: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function nonNegativeIntegerOption(name: string, fallback: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function hostPreset(): HostPreset | undefined {
  const host = value("--host");
  if (!host) return undefined;
  if (
    host !== "ghast" &&
    host !== "mcp" &&
    host !== "search_only" &&
    host !== "mock_l3"
  ) {
    throw new Error("--host must be one of: ghast, mcp, search_only, mock_l3");
  }
  return host;
}

function hostPresetList(raw: string | undefined): HostPreset[] {
  const value = raw ?? "ghast,mock_l3,mcp,search_only";
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error("--hosts requires comma-separated host presets");
  }
  return tokens.map((token) => {
    if (
      token !== "ghast" &&
      token !== "mcp" &&
      token !== "search_only" &&
      token !== "mock_l3"
    ) {
      throw new Error(
        "--hosts must contain only: ghast, mcp, search_only, mock_l3",
      );
    }
    return token;
  });
}

function hostReport(preset: HostPreset | undefined) {
  if (!preset) return undefined;
  return createPresetHostAdapter(preset).compatibility;
}

function doctorReadAudit(snapshot: ReadAuditSnapshot | null) {
  if (!snapshot) {
    return {
      status: "unsupported",
      schema: null,
      tableCount: 0,
      rowCountTotal: 0,
      missingTables: [],
      hashesAvailable: false,
    };
  }
  const entries = Object.entries(snapshot.tables);
  return {
    status: "ok",
    schema: snapshot.schema,
    tableCount: entries.length,
    rowCountTotal: entries.reduce((sum, [, table]) => sum + table.rowCount, 0),
    missingTables: entries
      .filter(([, table]) => table.stateHash === "missing")
      .map(([table]) => table)
      .sort(),
    hashesAvailable: entries.every(([, table]) => typeof table.stateHash === "string"),
  };
}

function actualHostReportsFromOption(): HostActualCompatibilityReport[] | undefined {
  const reportFile = value("--actual-report");
  if (!reportFile) return undefined;
  const resolved = path.resolve(process.cwd(), reportFile);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  const reports = parseHostActualCompatibilityReports(parsed);
  if (reports.length === 0) {
    throw new Error("--actual-report did not contain a host compatibility report");
  }
  return reports;
}

function memoryKindOption(): MemoryKind {
  const raw = value("--kind");
  if (
    raw !== "fact" &&
    raw !== "preference" &&
    raw !== "boundary" &&
    raw !== "procedure" &&
    raw !== "project" &&
    raw !== "person" &&
    raw !== "task_trajectory"
  ) {
    throw new Error(
      "--kind must be one of: fact, preference, boundary, procedure, project, person, task_trajectory",
    );
  }
  return raw;
}

function optionalMemoryKindOption(): MemoryKind | undefined {
  const raw = value("--kind");
  if (!raw) return undefined;
  return memoryKindOption();
}

function searchPurposeOption(): LowLevelSearchInput["purpose"] {
  const raw = value("--purpose", "context");
  if (raw !== "context" && raw !== "history" && raw !== "delete" && raw !== "manage") {
    throw new Error("--purpose must be one of: context, history, delete, manage");
  }
  return raw;
}

function temporalModeOption(): "auto" | "current" | "history" | undefined {
  const raw = value("--temporal-mode");
  if (!raw) return undefined;
  if (raw !== "auto" && raw !== "current" && raw !== "history") {
    throw new Error("--temporal-mode must be one of: auto, current, history");
  }
  return raw;
}

function listStatusOption(): LowLevelListMemoriesInput["status"] {
  const raw = value("--status");
  if (!raw) return undefined;
  if (raw !== "active" && raw !== "archived" && raw !== "any") {
    throw new Error("--status must be one of: active, archived, any");
  }
  return raw;
}

function failureKindOption(): FailureKind | undefined {
  const raw = value("--failure-kind");
  if (!raw) return undefined;
  if (
    raw !== "missed_recall" &&
    raw !== "wrong_recall" &&
    raw !== "privacy_leak" &&
    raw !== "forget_failure" &&
    raw !== "controller_route_error" &&
    raw !== "action_policy_missing" &&
    raw !== "task_failure"
  ) {
    throw new Error(
      "--failure-kind must be one of: missed_recall, wrong_recall, privacy_leak, forget_failure, controller_route_error, action_policy_missing, task_failure",
    );
  }
  return raw;
}

function profileBackupModeOption(): SqliteProfileBackupMode {
  const raw = value("--mode", "safe");
  if (raw !== "safe" && raw !== "full") {
    throw new Error("--mode must be safe or full");
  }
  return raw;
}

function profileBackupConflictOption(): SqliteProfileBackupConflictPolicy {
  const raw = value("--on-conflict", "skip");
  if (raw !== "skip" && raw !== "replace" && raw !== "fail") {
    throw new Error("--on-conflict must be one of: skip, replace, fail");
  }
  return raw;
}

function parseJsonInput(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `--input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readJsonFileOption(name: string): unknown {
  const file = value(name);
  if (!file) usage();
  return JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8")) as unknown;
}

function publicOutputPath(resolved: string): string {
  const relative = path.relative(process.cwd(), resolved).split(path.sep).join("/");
  if (relative && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative)) {
    return relative;
  }
  return path.basename(resolved);
}

function writeJsonOutput(payload: unknown): void {
  const output = JSON.stringify(payload, null, 2);
  const outputFile = value("--output-file");
  if (outputFile) {
    const resolved = path.resolve(process.cwd(), outputFile);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, output);
    console.log(JSON.stringify({ ok: true, outputFile: publicOutputPath(resolved) }, null, 2));
    return;
  }
  console.log(output);
}

async function createRuntime() {
  const dbPath = value("--db", "./gmos.db")!;
  const profileId = value("--profile", "default")!;
  const store = createSqliteMemoryStore({ path: dbPath });
  const memory = createMemoryOS({ profileId, store });
  return { memory, store, profileId, dbPath };
}

async function runEvolutionReport(): Promise<void> {
  const dbPath = value("--db", "./gmos.db")!;
  const profileId = value("--profile", "default")!;
  const resolvedDbPath = dbPath === ":memory:" ? null : path.resolve(process.cwd(), dbPath);
  let close: (() => Promise<void> | void) | undefined;
  const store: FailureReviewStore =
    resolvedDbPath && existsSync(resolvedDbPath)
      ? (() => {
          const sqlite = createSqliteMemoryStore({
            path: resolvedDbPath,
            readonly: true,
            fileMustExist: true,
          });
          close = () => sqlite.close();
          return sqlite;
        })()
      : {
          listFailures: () => [],
        };
  try {
    const controlPlane = createEvolutionControlPlane({ store, profileId });
    const report = await controlPlane.reviewFailures({
      failureKind: failureKindOption(),
      limit: positiveIntegerOption("--limit", 100),
    });
    printReport(report, renderEvolutionFailureReviewMarkdown(report));
  } finally {
    await close?.();
  }
}

async function runStatusReport(): Promise<void> {
  const dbPath = value("--db", "./gmos.db")!;
  const profileId = value("--profile", "default")!;
  const resolvedDbPath = dbPath === ":memory:" ? null : path.resolve(process.cwd(), dbPath);
  let close: (() => Promise<void> | void) | undefined;
  const store: DiagnosticsStore =
    resolvedDbPath && existsSync(resolvedDbPath)
      ? (() => {
          const sqlite = createSqliteMemoryStore({
            path: resolvedDbPath,
            readonly: true,
            fileMustExist: true,
          });
          close = () => sqlite.close();
          return sqlite;
        })()
      : {
          rowCounts: () => {
            throw new Error("diagnostics store unavailable");
          },
        };
  try {
    const report = await createMemoryStatusReport({
      store,
      profileId,
      host: hostPreset(),
    });
    printReport(report, renderMemoryStatusMarkdown(report));
  } finally {
    await close?.();
  }
}

function waitForServerShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      process.stdin.off("end", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    process.stdin.once("end", done);
  });
}

async function main(): Promise<void> {
  const [command, subcommand] = process.argv.slice(2);
  if (!command || has("--help") || has("-h")) usage();

  if (command === "gate" || (command === "gym" && subcommand === "gate")) {
    const report = await runMemoryReleaseGate({
      generatedSeeds: positiveIntegerOption("--generated-seeds", 3),
      scaleSizes: parsePositiveIntegerList(
        value("--scale-sizes", "100,1000") ?? "100,1000",
        "--scale-sizes",
      ),
      scaleThresholdP95Ms: nonNegativeNumberOption("--threshold-p95-ms", 250),
      hosts: hostPresetList(value("--hosts")),
      actualReports: actualHostReportsFromOption(),
    });
    printReport(report, renderMemoryReleaseGateMarkdown(report));
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "gym" && subcommand === "run") {
    const report = await runMemoryGym({
      dbPath: value("--db", ":memory:"),
      generatedSeeds: positiveIntegerOption("--generated-seeds", 3),
    });
    printReport(report, renderMemoryGymMarkdown(report));
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "gym" && subcommand === "scale") {
    const sizes = parsePositiveIntegerList(value("--sizes", "100,1000") ?? "100,1000", "--sizes");
    const report = await runMemoryScaleBenchmark({
      sizes,
      thresholdP95Ms: nonNegativeNumberOption("--threshold-p95-ms", 250),
    });
    printReport(report, renderMemoryScaleMarkdown(report));
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "gym" && subcommand === "statebench") {
    const action = process.argv[4];
    if (action === "build-learnings") {
      const domain = strictOptionValue("--domain");
      if (!domain) throw new Error("gmos gym statebench build-learnings requires --domain");
      const inputDir = value(
        "--input-dir",
        path.join("datasets", "train_task_trajectories", domain),
      )!;
      writeJsonOutput(
        buildStateBenchLearnings({
          domain,
          inputDir,
          maxContentChars: positiveIntegerOption("--max-content-chars", 520),
          maxItems: positiveIntegerOption("--max-items", 1000000),
          allowNonTrainInput: has("--allow-non-train-input"),
        }),
      );
      return;
    }
    if (action === "write-agent") {
      const outputFile = strictOptionValue("--output-file");
      if (!outputFile) throw new Error("gmos gym statebench write-agent requires --output-file");
      const resolved = path.resolve(process.cwd(), outputFile);
      if (existsSync(resolved) && !has("--force")) {
        throw new Error("gmos gym statebench write-agent refuses to overwrite; pass --force to replace");
      }
      mkdirSync(path.dirname(resolved), { recursive: true });
      writeFileSync(resolved, stateBenchAgentPythonTemplate());
      console.log(JSON.stringify({ ok: true, outputFile: publicOutputPath(resolved) }, null, 2));
      return;
    }
    if (action === "prepare") {
      const domain = strictOptionValue("--domain");
      if (!domain) throw new Error("gmos gym statebench prepare requires --domain");
      const agentModelName = strictOptionValue("--agent-model-name");
      if (!agentModelName) {
        throw new Error("gmos gym statebench prepare requires --agent-model-name");
      }
      const checkoutDir = strictOptionValue("--checkout-dir", ".") ?? ".";
      writeJsonOutput(
        prepareStateBenchAgentLearningRun({
          domain,
          checkoutDir,
          agentModelName,
          agentModelReasoningLevel: value("--agent-model-reasoning-level"),
          numRuns: positiveIntegerOption("--num-runs", 5),
          numWorkers: positiveIntegerOption("--num-workers", 1),
          maxContentChars: positiveIntegerOption("--max-content-chars", 520),
          maxItems: positiveIntegerOption("--max-items", 1000000),
          learningsFile: value("--learnings-file"),
          agentFile: value("--agent-file"),
          outputDir: value("--statebench-output-dir"),
          manifestFile: value("--manifest-file"),
          force: has("--force"),
        }),
      );
      return;
    }
    if (action === "summarize") {
      const domain = strictOptionValue("--domain");
      if (!domain) throw new Error("gmos gym statebench summarize requires --domain");
      const checkoutDir = strictOptionValue("--checkout-dir", ".") ?? ".";
      writeJsonOutput(
        summarizeStateBenchResults({
          domain,
          checkoutDir,
          resultsDir: value("--results-dir"),
          metricsFile: value("--metrics-file"),
          prepareManifestFile: value("--prepare-manifest"),
        }),
      );
      return;
    }
    throw new Error("gmos gym statebench action must be build-learnings, write-agent, prepare, or summarize");
  }

  if (command === "gym" && subcommand === "external") {
    const inputFile = strictOptionValue("--input-file");
    if (!inputFile) throw new Error("gmos gym external requires --input-file");
    const inputPath = path.resolve(process.cwd(), inputFile);
    const inputText = readFileSync(inputPath, "utf8");
    const datasetFormat = value("--dataset-format", "gmos");
    if (
      datasetFormat !== "gmos" &&
      datasetFormat !== "longmemeval" &&
      datasetFormat !== "locomo"
    ) {
      throw new Error("--dataset-format must be gmos, longmemeval, or locomo");
    }
    const parsedDataset =
      datasetFormat === "gmos"
        ? {
            datasetFormat: "gmos.external_long_memory_qa.jsonl" as const,
            cases: parseExternalMemoryBenchmarkJsonl(inputText),
          }
        : parseExternalMemoryBenchmarkDataset(inputText, { adapter: datasetFormat });
    const cases = parsedDataset.cases;
    const mode = value("--mode");
    if (mode !== undefined && mode !== "prepare" && mode !== "reconstruct") {
      throw new Error("--mode must be prepare or reconstruct");
    }
    const requireConvergence = has("--require-convergence");
    if (
      requireConvergence &&
      (mode === "prepare" ||
        cases.some((benchmarkCase) => (benchmarkCase.mode ?? mode ?? "reconstruct") === "prepare"))
    ) {
      throw new Error("--require-convergence requires reconstruct mode for every external benchmark case");
    }
    const report = await runExternalMemoryBenchmark({
      cases: requireConvergence
        ? cases.map((benchmarkCase) => ({ ...benchmarkCase, requireConvergence: true }))
        : cases,
      datasetHash: hashExternalMemoryBenchmarkInput(inputText),
      datasetId: path.basename(inputPath),
      datasetFormat: parsedDataset.datasetFormat,
      datasetWarnings: "warnings" in parsedDataset ? parsedDataset.warnings : [],
      ...(mode !== undefined ? { mode } : {}),
      maxSteps: positiveIntegerOption("--max-steps", 4),
      maxBranch: positiveIntegerOption("--max-branch", 6),
      maxMemories: positiveIntegerOption("--max-memories", 6),
      contextBudgetTokens: positiveIntegerOption("--context-budget-tokens", 1600),
      ...(has("--temporal-metadata") ? { includeTemporalMetadata: true } : {}),
      ...(has("--include-sensitive") ? { includeSensitive: true } : {}),
      concurrency: positiveIntegerOption("--concurrency", 4),
      reuseProfiles: !has("--no-reuse-profiles"),
      failureSampleLimit: nonNegativeIntegerOption("--failure-sample-limit", 20),
      ...(has("--progress")
        ? {
            onCaseResult: (progress) => {
              const status = progress.pass ? "pass" : "fail";
              console.error(
                `[gmos external] ${progress.completedCount}/${progress.totalCount} ${status} case=${progress.caseId} passed=${progress.passedCount} failed=${progress.failedCount}`,
              );
            },
          }
        : {}),
      ...(requireConvergence ? { requireConvergence: true } : {}),
    });
    printReport(report, renderExternalMemoryBenchmarkMarkdown(report));
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "gym" && subcommand === "external-suite") {
    const suiteFile = strictOptionValue("--suite-file");
    if (!suiteFile) throw new Error("gmos gym external-suite requires --suite-file");
    const suitePath = path.resolve(process.cwd(), suiteFile);
    const suite = parseExternalMemoryBenchmarkSuite(readFileSync(suitePath, "utf8"));
    const execution = await runExternalMemoryBenchmarkSuite({
      suite,
      suiteFile: suitePath,
      failOnBenchmarkFail: has("--fail-on-benchmark-fail"),
      ...(has("--progress")
        ? {
            onRunResult: (summary) => {
              const status = summary.pass ? "pass" : "fail";
              console.error(
                `[gmos external-suite] ${status} run=${summary.id} cases=${summary.passedCount}/${summary.caseCount} score=${summary.score.toFixed(4)}`,
              );
            },
          }
        : {}),
    });
    const outputDir = strictOptionValue("--output-dir");
    if (outputDir) {
      writeExternalSuiteOutputs({
        outputDir,
        result: execution.result,
        reports: execution.reports,
      });
    }
    printReport(execution.result, renderExternalMemoryBenchmarkSuiteMarkdown(execution.result));
    if (!execution.result.pass) process.exitCode = 1;
    return;
  }

  if (command === "gym" && subcommand === "host") {
    const report = await runHostCompatibilityGym({
      hosts: hostPresetList(value("--hosts")),
      actualReports: actualHostReportsFromOption(),
    });
    printReport(report, renderHostCompatibilityGymMarkdown(report));
    if (!report.pass) process.exitCode = 1;
    return;
  }

  if (command === "mcp" && subcommand === "tools") {
    console.log(JSON.stringify({ tools: listMemoryMcpTools() }, null, 2));
    return;
  }

  if (command === "evolution" && subcommand === "report") {
    await runEvolutionReport();
    return;
  }

  if (command === "status") {
    await runStatusReport();
    return;
  }

  const requestedHost = command === "doctor" ? hostPreset() : undefined;
  const { memory, store, profileId, dbPath } = await createRuntime();
  try {
    if (command === "init") {
      await store.initialize();
      console.log(JSON.stringify({ ok: true, dbPath, encrypted: false }, null, 2));
      return;
    }

    if (command === "doctor") {
      await store.initialize();
      console.log(
        JSON.stringify(
          {
            ok: true,
            dbPath,
            encrypted: false,
            schema: {
              dialect: "sqlite",
              version: store.schemaVersion ? await store.schemaVersion() : null,
            },
            rowCounts: await store.rowCounts(),
            readAudit: doctorReadAudit(
              store.readAuditSnapshot ? await store.readAuditSnapshot() : null,
            ),
            searchIndex: store.searchIndexStatus ? await store.searchIndexStatus() : null,
            hostCompatibility: hostReport(requestedHost),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (command === "repair") {
      if (has("--associations")) {
        if (!store.rebuildAssociations) {
          throw new Error("gmOS store does not support association repair");
        }
        console.log(
          JSON.stringify(
            {
              ok: true,
              associations: await store.rebuildAssociations({
                profileId: value("--profile"),
              }),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (has("--search-index")) {
        if (!store.repairSearchIndex) {
          throw new Error("gmOS store does not support search index repair");
        }
        console.log(
          JSON.stringify(
            {
              ok: true,
              searchIndex: await store.repairSearchIndex(),
            },
            null,
            2,
          ),
        );
        return;
      }
      usage();
    }

    if (command === "add") {
      const text = value("--text");
      if (!text) usage();
      const memoryRecord = await memory.add({
        profileId,
        kind: memoryKindOption(),
        content: text,
        allowPerson: has("--allow-person"),
      });
      console.log(JSON.stringify(memoryRecord, null, 2));
      return;
    }

    if (command === "update") {
      const id = value("--id");
      if (!id) usage();
      const updated = await memory.update({
        profileId,
        id,
        content: value("--text"),
        kind: optionalMemoryKindOption(),
        allowPerson: has("--allow-person"),
      });
      if (!updated) {
        console.error(`Memory not found: ${id}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    if (command === "delete") {
      const id = value("--id");
      if (!id) usage();
      console.log(
        JSON.stringify(
          await memory.archive({
            profileId,
            id,
            reason: value("--reason"),
          }),
          null,
          2,
        ),
      );
      return;
    }

    if (command === "clear") {
      const metadataKey = value("--metadata-key");
      const metadataValue = value("--metadata-value");
      const metadataEquals =
        metadataKey && metadataValue
          ? { key: metadataKey, value: metadataValue }
          : undefined;
      console.log(
        JSON.stringify(
          await memory.clear({
            profileId,
            all: has("--all"),
            scope: value("--scope"),
            metadataEquals,
            reason: value("--reason"),
          }),
          null,
          2,
        ),
      );
      return;
    }

    if (command === "search") {
      const query = value("--query");
      if (!query) usage();
      const memories = await memory.search({
        profileId,
        query,
        purpose: searchPurposeOption(),
        limit: positiveIntegerOption("--limit", 12),
        includeSensitive: has("--include-sensitive"),
        includePerson: has("--include-person"),
      });
      console.log(JSON.stringify({ memories }, null, 2));
      return;
    }

    if (command === "list") {
      const memories = await memory.list({
        profileId,
        query: value("--query"),
        limit: positiveIntegerOption("--limit", 50),
        status: listStatusOption(),
        kind: optionalMemoryKindOption(),
        scope: value("--scope"),
        includeSensitive: has("--include-sensitive"),
        includePerson: has("--include-person"),
      });
      console.log(JSON.stringify({ memories }, null, 2));
      return;
    }

    if (command === "get") {
      const id = value("--id");
      if (!id) usage();
      const memoryRecord = await memory.get({
        profileId,
        id,
        includeSensitive: has("--include-sensitive"),
        includePerson: has("--include-person"),
        includeArchived: has("--include-archived"),
      });
      if (!memoryRecord) {
        console.error(`Memory not found: ${id}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(memoryRecord, null, 2));
      return;
    }

    if (command === "export") {
      const requestedStatus = listStatusOption();
      if (
        !has("--include-archived") &&
        (requestedStatus === "archived" || requestedStatus === "any")
      ) {
        throw new Error("--status archived|any requires --include-archived");
      }
      const status = has("--include-archived")
        ? (requestedStatus ?? "any")
        : (requestedStatus ?? "active");
      const exported = await exportMemorySnapshots({
        memory,
        profileId,
        query: value("--query"),
        limit: positiveIntegerOption("--limit", 500),
        status,
        kind: optionalMemoryKindOption(),
        scope: value("--scope"),
        includeSensitive: has("--include-sensitive"),
        includePerson: has("--include-person"),
      });
      writeJsonOutput(exported);
      return;
    }

    if (command === "import") {
      const parsed = parseMemorySnapshotExport(readJsonFileOption("--input-file"));
      const report = await loadHostMemorySnapshotsIntoStore({
        store,
        profileId,
        memories: parsed.memories,
        sourceType: "gmos.snapshot_export",
        sourceUriPrefix: parsed.sourceUriPrefix,
        skipPerson: !has("--include-person"),
        skipSecretLike: true,
      });
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
      return;
    }

    if (command === "backup") {
      const backup = store.exportProfileBackup({
        profileId,
        mode: profileBackupModeOption(),
        includeArchived: has("--include-archived") ? true : undefined,
        includeSensitive: has("--include-sensitive") ? true : undefined,
        includePerson: has("--include-person") ? true : undefined,
        includeEvidence: has("--no-evidence") ? false : undefined,
        includeWorldBeliefs: has("--include-world-beliefs") ? true : undefined,
        includeFailures: has("--include-failures") ? true : undefined,
        includeTaskTrajectories: has("--include-task-trajectories") ? true : undefined,
      });
      writeJsonOutput(backup);
      return;
    }

    if (command === "restore") {
      const parsed = parseSqliteProfileBackup(readJsonFileOption("--input-file"));
      const report = store.restoreProfileBackup({
        backup: parsed,
        profileId: value("--profile"),
        onConflict: profileBackupConflictOption(),
      });
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
      return;
    }

    if (command === "observe") {
      const text = value("--text");
      if (!text) usage();
      await memory.observe({
        type: "conversation.message",
        profileId,
        role: "user",
        content: text,
        privacyMode: has("--incognito") ? "incognito" : "normal",
        createdAt: new Date().toISOString(),
      });
      console.log(JSON.stringify({ ok: true }, null, 2));
      return;
    }

    if (command === "prepare") {
      const text = value("--text");
      if (!text) usage();
      const prepared = await memory.prepareTurn({
        profileId,
        messages: [{ role: "user", content: text }],
        includeEvidence: has("--evidence"),
        includeSensitive: has("--include-sensitive"),
        ...(has("--reconstruct-shadow")
          ? {
              reconstruction: {
                mode: "shadow",
                maxSteps: positiveIntegerOption("--max-steps", 3),
                maxBranch: positiveIntegerOption("--max-branch", 4),
                maxMemories: positiveIntegerOption("--max-memories", 8),
                includeTemporalMetadata: has("--temporal-metadata"),
                temporalMode: temporalModeOption(),
              },
            }
          : {}),
      });
      console.log(JSON.stringify(prepared, null, 2));
      return;
    }

    if (command === "reconstruct") {
      const text = value("--text");
      if (!text) usage();
      const reconstructed = await memory.reconstructContext({
        profileId,
        query: text,
        includeEvidence: has("--evidence"),
        includeSensitive: has("--include-sensitive"),
        contextBudgetTokens: positiveIntegerOption("--context-budget-tokens", 1800),
        maxSteps: positiveIntegerOption("--max-steps", 3),
        maxBranch: positiveIntegerOption("--max-branch", 4),
        maxMemories: positiveIntegerOption("--max-memories", 8),
        includeTemporalMetadata: has("--temporal-metadata"),
        temporalMode: temporalModeOption(),
      });
      console.log(JSON.stringify(reconstructed, null, 2));
      return;
    }

    if (command === "explain-path") {
      const text = value("--text");
      if (!text) usage();
      const explanation = await memory.explainEvidencePath({
        profileId,
        query: text,
        includeEvidence: !has("--no-evidence"),
        includeSensitive: has("--include-sensitive"),
        includePlannerTrace: has("--include-trace"),
        contextBudgetTokens: positiveIntegerOption("--context-budget-tokens", 1800),
        maxSteps: positiveIntegerOption("--max-steps", 3),
        maxBranch: positiveIntegerOption("--max-branch", 4),
        maxMemories: positiveIntegerOption("--max-memories", 8),
        includeTemporalMetadata: has("--temporal-metadata"),
        temporalMode: temporalModeOption(),
      });
      console.log(JSON.stringify(explanation, null, 2));
      return;
    }

    if (command === "forget") {
      const query = value("--query");
      if (!query) usage();
      console.log(JSON.stringify(await memory.forget({ profileId, query }), null, 2));
      return;
    }

    if (command === "explain") {
      const id = value("--id");
      if (!id) usage();
      console.log(JSON.stringify(await memory.explain(id, profileId), null, 2));
      return;
    }

    if (command === "mcp" && subcommand === "call") {
      const tool = value("--tool");
      if (!tool) usage();
      const server = createMemoryMcpServer(memory);
      const result = await server.callTool(tool, parseJsonInput(value("--input")));
      console.log(JSON.stringify(result, null, 2));
      if (result.isError) process.exitCode = 1;
      return;
    }

    if (command === "mcp" && subcommand === "serve") {
      const server = await serveMemoryMcpStdio(memory);
      try {
        await waitForServerShutdown();
      } finally {
        await server.close();
      }
      return;
    }

    if (command === "http" && subcommand === "serve") {
      const authToken = strictOptionValue("--auth-token", process.env.GMOS_HTTP_AUTH_TOKEN);
      const server = await serveMemoryHttp({
        memory,
        store,
        profileId,
        host: hostPreset(),
        port: nonNegativeIntegerOption("--port", 4787),
        hostname: value("--listen-host", "127.0.0.1"),
        authToken,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            url: server.address.url,
            authRequired: authToken !== undefined,
            encrypted: false,
          },
          null,
          2,
        ),
      );
      try {
        await waitForServerShutdown();
      } finally {
        await server.close();
      }
      return;
    }

    usage();
  } finally {
    await memory.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
