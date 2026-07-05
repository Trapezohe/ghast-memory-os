#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { createMemoryOS } from "../runtime/create-memory-os.js";
import {
  ingestTranscript,
  runAutopilot,
  type AutopilotReport,
  type TranscriptIngestFormat,
  type TranscriptIngestReport,
} from "../autopilot.js";
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
  createOpenAICompatibleExternalBenchmarkAnswerer,
  createOpenAICompatibleExternalBenchmarkJudge,
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
  writeExternalMemoryBenchmarkReproductionBundle,
} from "../gym/index.js";
import {
  createPresetHostAdapter,
  type HostCompatibilityReport,
  type HostActualCompatibilityReport,
  type HostPreset,
  loadHostMemorySnapshotsIntoStore,
  loadMem0ExportIntoStore,
  parseHostActualCompatibilityReports,
  parseMemorySnapshotExport,
} from "../host/index.js";
import { createMemoryHttpOpenApiDocument, serveMemoryHttp } from "../http/index.js";
import { readGmosPackageInfo } from "../kernel/package-info.js";
import {
  createMemoryMcpServer,
  listMemoryMcpTools,
  serveMemoryMcpStdio,
} from "../mcp/index.js";
import {
  createSqliteMemoryStore,
  parseSqliteProfileBundle,
  serializeSqliteProfileBundle,
  type SqliteProfileBackupConflictPolicy,
  type SqliteProfileBackupMode,
} from "../store/sqlite/index.js";
import type {
  FailureKind,
  LowLevelListMemoriesInput,
  LowLevelSearchInput,
  MaintenancePhase,
  MaintenanceReport,
  MemoryKind,
  ReadAuditSnapshot,
  ReconstructionIntentHint,
  SearchIndexStatus,
  SourceTrust,
} from "../kernel/types.js";
import { getGmosRuntimeInfo, type GmosRuntimeInfo } from "../runtime-info.js";

function value(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function values(name: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const next = process.argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    output.push(next);
  }
  return output;
}

function strictOptionValue(name: string, fallback?: string): string | undefined {
  return value(name, fallback);
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  console.log(`gmOS CLI

Usage:
  gmos version --format json
  gmos init --db ./gmos.db
  gmos doctor --db ./gmos.db --host ghast --format markdown
  gmos repair --db ./gmos.db --search-index --dry-run --vector-batch-size 32
  gmos repair --db ./gmos.db --associations
  gmos status --db ./gmos.db --profile local --host ghast --format markdown
  gmos maintain --db ./gmos.db --profile local --dry-run --phases decay,consolidate,distill,dossier,explore --now 2026-07-02T00:00:00.000Z --format markdown
  gmos ingest --db ./gmos.db --profile local --input-file ./thread.jsonl --input-format jsonl --dry-run --format markdown
  gmos autopilot run --db ./gmos.db --profile local --phases decay,consolidate --embed-backfill-batch 32 --ingest-dir ./transcripts --dry-run --format json
  gmos autopilot history --db ./gmos.db --profile local --limit 20
  gmos add --db ./gmos.db --profile local --kind preference --text "回答风格：简洁，先给结论"
  gmos update --db ./gmos.db --profile local --id memory_xxx --text "回答风格：先给结论，再列方案"
  gmos delete --db ./gmos.db --profile local --id memory_xxx --reason "manual cleanup"
  gmos clear --db ./gmos.db --profile local --scope global --reason "manual cleanup"
  gmos search --db ./gmos.db --profile local --query "简洁"
  gmos history --db ./gmos.db --profile local --query "之前的状态"
  gmos list --db ./gmos.db --profile local --query "简洁" --status active
  gmos get --db ./gmos.db --profile local --id memory_xxx
  gmos export --db ./gmos.db --profile local --mode safe --output-file ./gmos-profile-bundle.json
  gmos import --db ./gmos.db --profile local --input-file ./gmos-profile-bundle.json
  gmos backup --db ./gmos.db --profile local --mode full --passphrase-env GMOS_BUNDLE_PASSPHRASE --output-file ./gmos-profile-bundle.encrypted.json
  gmos restore --db ./gmos.db --input-file ./gmos-profile-bundle.encrypted.json --passphrase-env GMOS_BUNDLE_PASSPHRASE --on-conflict skip
  gmos snapshot create --db ./gmos.db --profile local --name before-migration --snapshots-dir ./snapshots
  gmos snapshot list --db ./gmos.db --profile local
  gmos import --from mem0 --db ./gmos.db --profile local --input-file ./mem0-export.json
  gmos import --from conversation --db ./gmos.db --profile local --input-file ./thread.jsonl --input-format jsonl
  gmos add --db ./gmos.db --profile local --kind boundary --text "不要再提醒我这个项目延期了。"
  gmos observe --db ./gmos.db --profile local --text "记录一条普通会话事件。" --source-trust user --report
  gmos prepare --db ./gmos.db --profile local --text "你知道我什么偏好吗？"
  gmos reconstruct --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？" --reconstruction-intent-json '{"queryCues":["project:<project-id>"],"requiredTagGroups":[{"name":"procedure_or_next_step","tags":["procedure","task_trajectory","project.state","world_belief"]}]}'
  gmos explain-path --db ./gmos.db --profile local --text "我之前说的项目下一步是什么？" --reconstruction-intent-json '{"queryCues":["project:<project-id>"],"requiredTagGroups":[{"name":"procedure_or_next_step","tags":["procedure","task_trajectory","project.state","world_belief"]}]}'
  gmos forget --db ./gmos.db --profile local --query "delete request" --target-term "Moonbase"
  gmos rollback --db ./gmos.db --profile local --memory memory_xxx --to evidence_xxx --approved-by "Song Su" --yes
  gmos explain --db ./gmos.db --profile local --id memory_xxx
  gmos mcp tools
  gmos mcp call --db ./gmos.db --tool memory.prepare_context --input '{"text":"你知道我什么偏好吗？"}'
  gmos mcp serve --db ./gmos.db --profile local
  gmos keys create --db ./gmos.db --label claude-code --scope readwrite --profiles local --no-history-access
  gmos keys list --db ./gmos.db
  gmos keys revoke --db ./gmos.db --key-id key_xxx
  gmos audit list --db ./gmos.db --key-id key_xxx --since 2026-07-01T00:00:00.000Z
  gmos serve --db ./gmos.db --profile local --port 4787 --keys --console
  gmos http serve --db ./gmos.db --profile local --port 4787 --host ghast --auth-token local-dev-token
  gmos http openapi
  gmos evolution report --db ./gmos.db --profile local --format markdown
  gmos evolution apply --db ./gmos.db --profile local --proposal proposal_xxx --approved-by "Song Su" --yes
  gmos evolution revert --db ./gmos.db --application evidence_xxx --yes
  gmos gate --generated-seeds 3 --scale-sizes 100,1000 --format markdown
  gmos gym run --db :memory: --generated-seeds 3 --format markdown --report-file ./memory-gym.md
  gmos gym scale --sizes 100,1000 --threshold-p95-ms 250 --ingest-threshold-p95-ms 25 --ingest-last-to-first-factor 3
  gmos gym external --input-file ./long-memory-qa.jsonl --dataset-format gmos --format markdown --protocol deterministic-local --require-convergence --include-sensitive --temporal-metadata
  gmos gym external --input-file ./long-memory-cleaned.json --dataset-format longmemeval --format json --json-file ./longmemeval.json --markdown-file ./longmemeval.md --concurrency 4 --diagnostics-level full --progress
  gmos gym external --input-file ./multi-session-memory.json --dataset-format locomo --format json --json-file ./locomo.json --markdown-file ./locomo.md --failure-sample-limit 20 --concurrency 2 --diagnostics-level basic --progress
  gmos gym external --input-file ./long-memory-cleaned.json --dataset-format longmemeval --max-cases 5 --results-jsonl ./paid-smoke.results.jsonl
  gmos gym external --input-file ./long-memory-cleaned.json --dataset-format longmemeval --ingest-mode message --extraction-window 12 --intelligence-base-url http://127.0.0.1:11434/v1 --intelligence-model llama3.1 --intelligence-embed-model nomic-embed-text --intelligence-embed-dimensions 768 --intelligence-api-key-env GMOS_BENCH_API_KEY --intelligence-disable-thinking
  gmos gym external --input-file ./long-memory-cleaned.json --dataset-format longmemeval --protocol official-protocol --answerer-base-url http://127.0.0.1:11434/v1 --answerer-model llama3.1 --answerer-timeout-ms 90000 --answerer-disable-thinking
  gmos gym external gains --input-file ./long-memory-cleaned.json --dataset-format longmemeval --reproduction-bundle ./release-evidence/bench-run
  gmos gym external-suite --suite-file ./path/to/external-suite.json --output-dir ./external-runs --format markdown
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

function appendJsonLine(filePath: string, value: unknown): void {
  const resolved = path.resolve(process.cwd(), filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const fd = openSync(resolved, "a");
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function printReport(json: unknown, markdown: string): void {
  const format = value("--format", "json");
  if (format !== "json" && format !== "markdown") {
    throw new Error("--format must be json or markdown");
  }
  const jsonOutput = JSON.stringify(json, null, 2);
  const output = format === "markdown" ? markdown : jsonOutput;
  writeReportIfRequested(output);
  writeOutputFileIfRequested("--json-file", jsonOutput);
  writeOutputFileIfRequested("--markdown-file", markdown);
  console.log(output);
}

const REDACTED_PLAINTEXT_SQLITE_PATH = "[plaintext sqlite path redacted]";

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

function positiveNumberOption(name: string, fallback: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
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
  const auditedTables = entries.map(([table]) => table).sort();
  return {
    status: "ok",
    schema: snapshot.schema,
    tableCount: entries.length,
    rowCountTotal: entries.reduce((sum, [, table]) => sum + table.rowCount, 0),
    auditedTables,
    missingTables: entries
      .filter(([, table]) => table.stateHash === "missing")
      .map(([table]) => table)
      .sort(),
    hashesAvailable: entries.every(([, table]) => typeof table.stateHash === "string"),
  };
}

interface CliDoctorReport {
  ok: true;
  dbPath: string;
  encrypted: boolean;
  runtimeInfo: GmosRuntimeInfo;
  schema: {
    dialect: "sqlite";
    version: number | null;
  };
  rowCounts: Record<string, number>;
  readAudit: ReturnType<typeof doctorReadAudit>;
  searchIndex: SearchIndexStatus | null;
  hostCompatibility: HostCompatibilityReport | undefined;
}

function renderDoctorMarkdown(report: CliDoctorReport): string {
  const vectorIndex = report.searchIndex?.vectorIndex;
  const rowCounts = Object.entries(report.rowCounts).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return [
    "# gmOS Doctor Report",
    "",
    `Database: ${report.dbPath}`,
    `Encrypted: ${report.encrypted ? "yes" : "no"}`,
    "",
    "## Runtime",
    "",
    `Package: ${report.runtimeInfo.package.name}@${report.runtimeInfo.package.version}`,
    `CLI binaries: ${report.runtimeInfo.cli.binaries.join(", ")}`,
    `Package exports: ${report.runtimeInfo.packageExports.length ? report.runtimeInfo.packageExports.join(", ") : "unknown"}`,
    `MCP tools: ${report.runtimeInfo.publicSurface.mcpTools.join(", ")}`,
    `HTTP routes: ${report.runtimeInfo.publicSurface.httpRoutes.join(", ")}`,
    `Local-first: ${report.runtimeInfo.trustContract.localFirst ? "yes" : "no"}`,
    `Default storage: ${report.runtimeInfo.trustContract.defaultStorage}`,
    `Encrypted by default: ${report.runtimeInfo.trustContract.encryptedByDefault ? "yes" : "no"}`,
    `Encryption supported: ${report.runtimeInfo.trustContract.encryptionSupported}`,
    `Cloud required: ${report.runtimeInfo.trustContract.cloudRequired ? "yes" : "no"}`,
    "",
    "## SQLite",
    "",
    `Schema dialect: ${report.schema.dialect}`,
    `Schema version: ${report.schema.version ?? "unknown"}`,
    `Read audit: ${report.readAudit.status} (${report.readAudit.tableCount} tables; rows=${report.readAudit.rowCountTotal}; missing=${report.readAudit.missingTables.length}; hashes=${report.readAudit.hashesAvailable ? "available" : "unavailable"})`,
    report.searchIndex
      ? `Search index: ${report.searchIndex.status} (${report.searchIndex.indexedMemoryCount}/${report.searchIndex.totalMemoryCount} indexed; missing=${report.searchIndex.missingEntryCount}; stale=${report.searchIndex.staleEntryCount}; orphan=${report.searchIndex.orphanEntryCount}; duplicate=${report.searchIndex.duplicateEntryCount})`
      : "Search index: unsupported",
    vectorIndex
      ? `Vector index: ${vectorIndex.status} (${vectorIndex.indexedMemoryCount} indexed; provider=${vectorIndex.providerName}/${vectorIndex.providerDimensions}; embedded=${vectorIndex.embeddedEntryCount}; pending=${vectorIndex.pendingEntryCount}; staleProvider=${vectorIndex.staleProviderEntryCount}; missing=${vectorIndex.missingEntryCount}; stale=${vectorIndex.staleEntryCount}; orphan=${vectorIndex.orphanEntryCount}; duplicate=${vectorIndex.duplicateEntryCount}; dimensions=${vectorIndex.dimensions})`
      : "",
    "",
    "### Row Counts",
    "",
    rowCounts.length === 0
      ? "No row counts available."
      : "| Table | Rows |\n| --- | ---: |\n" +
          rowCounts.map(([table, count]) => `| ${table} | ${count} |`).join("\n"),
    "",
    report.hostCompatibility
      ? [
          "## Host Compatibility",
          "",
          `Host: ${report.hostCompatibility.hostId}`,
          `Level: ${report.hostCompatibility.level}`,
          `Score: ${report.hostCompatibility.score.toFixed(2)}`,
          `Capability retention: ${report.hostCompatibility.capabilityRetention}`,
          report.hostCompatibility.gaps.length === 0
            ? "Gaps: none"
            : `Gaps: ${report.hostCompatibility.gaps.join(", ")}`,
          "",
        ].join("\n")
      : "",
  ].join("\n");
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

function maintenancePhaseList(raw: string, label: string): MaintenancePhase[] {
  const phases = raw.split(",").map((phase) => phase.trim());
  if (phases.some((phase) => phase.length === 0)) {
    throw new Error(`${label} must be a comma-separated list of decay,consolidate,distill,dossier,explore`);
  }
  const allowed = new Set<MaintenancePhase>(["decay", "consolidate", "distill", "dossier", "explore"]);
  const invalid = phases.find((phase): phase is string => !allowed.has(phase as MaintenancePhase));
  if (invalid) {
    throw new Error(`${label} must contain only decay, consolidate, distill, dossier, or explore`);
  }
  return [...new Set(phases as MaintenancePhase[])];
}

function maintenancePhasesOption(): MaintenancePhase[] | undefined {
  const raw = value("--phases");
  if (!raw) return undefined;
  return maintenancePhaseList(raw, "--phases");
}

function transcriptIngestFormat(raw: string | undefined, label: string): TranscriptIngestFormat | undefined {
  if (raw === undefined) return undefined;
  if (raw === "jsonl" || raw === "claude-code" || raw === "openai-thread") return raw;
  throw new Error(`${label} must be jsonl, claude-code, or openai-thread`);
}

function transcriptIngestFormatOption(): TranscriptIngestFormat {
  const explicit = transcriptIngestFormat(value("--input-format"), "--input-format");
  if (explicit) return explicit;
  const raw = values("--format").find((entry) =>
    entry === "jsonl" || entry === "claude-code" || entry === "openai-thread"
  );
  const parsed = transcriptIngestFormat(raw, "--format");
  if (!parsed) throw new Error("gmos ingest requires --input-format jsonl|claude-code|openai-thread");
  return parsed;
}

function outputFormatOption(defaultFormat = "json"): "json" | "markdown" {
  const explicit = value("--output-format");
  if (explicit !== undefined) {
    if (explicit === "json" || explicit === "markdown") return explicit;
    throw new Error("--output-format must be json or markdown");
  }
  const raw = [...values("--format")].reverse().find((entry) =>
    entry === "json" || entry === "markdown"
  ) ?? defaultFormat;
  if (raw !== "json" && raw !== "markdown") throw new Error("--format must be json or markdown");
  return raw;
}

function externalMaintainPhasesOption(): MaintenancePhase[] | undefined {
  const raw = value("--maintain-phases");
  if (!raw) return undefined;
  return maintenancePhaseList(raw, "--maintain-phases");
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

function diagnosticsLevelOption(): "off" | "basic" | "full" | undefined {
  const raw = value("--diagnostics-level");
  if (!raw) return undefined;
  if (raw !== "off" && raw !== "basic" && raw !== "full") {
    throw new Error("--diagnostics-level must be one of: off, basic, full");
  }
  return raw;
}

function externalProtocolOption(): "deterministic_local" | "official_protocol" {
  const raw = value("--protocol", "deterministic-local");
  if (raw === "deterministic-local" || raw === "deterministic_local") {
    return "deterministic_local";
  }
  if (raw === "official-protocol" || raw === "official_protocol") {
    return "official_protocol";
  }
  throw new Error("--protocol must be deterministic-local or official-protocol");
}

function externalIngestModeOption(): "memory" | "message" {
  const raw = value("--ingest-mode", "memory");
  if (raw === "memory" || raw === "message") return raw;
  throw new Error("--ingest-mode must be memory or message");
}

function positiveIntegerOptionValue(name: string): number | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeIntegerOptionValue(name: string): number | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function commaSeparatedStringOption(name: string): string[] | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new Error(`${name} must be a comma-separated list`);
  }
  return entries;
}

function externalIntelligenceOption(): {
  baseUrl: string;
  apiKeyEnv?: string | undefined;
  model: string;
  embedModel?: string | undefined;
  dimensions?: number | undefined;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  backoffMs?: number | undefined;
  concurrency?: number | undefined;
  disableThinking?: boolean | undefined;
  debugDir?: string | undefined;
} | undefined {
  const hasIntelligenceFlag = process.argv.some((arg) => arg.startsWith("--intelligence-"));
  if (!hasIntelligenceFlag) return undefined;
  const baseUrl = value("--intelligence-base-url");
  if (!baseUrl) {
    throw new Error("gmos gym external intelligence flags require --intelligence-base-url");
  }
  const model = value("--intelligence-model");
  if (!model) {
    throw new Error("gmos gym external --intelligence-base-url requires --intelligence-model");
  }
  const apiKeyEnv = value("--intelligence-api-key-env");
  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new Error("--intelligence-api-key-env must be an environment variable name");
  }
  const embedModel = value("--intelligence-embed-model");
  const dimensions = positiveIntegerOptionValue("--intelligence-embed-dimensions");
  const timeoutMs = positiveIntegerOptionValue("--intelligence-timeout-ms");
  const retries = nonNegativeIntegerOptionValue("--intelligence-retries");
  const backoffMs = nonNegativeIntegerOptionValue("--intelligence-backoff-ms");
  const concurrency = positiveIntegerOptionValue("--intelligence-concurrency");
  const debugDir = value("--intelligence-debug-dir");
  const disableThinking = has("--intelligence-disable-thinking");
  return {
    baseUrl,
    model,
    ...(embedModel ? { embedModel } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(backoffMs !== undefined ? { backoffMs } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
    ...(debugDir ? { debugDir: path.resolve(process.cwd(), debugDir) } : {}),
    ...(disableThinking ? { disableThinking: true } : {}),
  };
}

interface CliOpenAICompatibleHookConfig {
  baseUrl: string;
  apiKeyEnv?: string | undefined;
  apiKey?: string | undefined;
  model: string;
  timeoutMs?: number | undefined;
  disableThinking?: boolean | undefined;
}

function apiKeyFromEnv(apiKeyEnv: string | undefined, label: string): string | undefined {
  if (apiKeyEnv === undefined) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new Error(`${label} must be an environment variable name`);
  }
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`${label} is not set: ${apiKeyEnv}`);
  return apiKey;
}

function externalAnswererConfigOption(
  intelligence: ReturnType<typeof externalIntelligenceOption>,
): CliOpenAICompatibleHookConfig | undefined {
  const hasAnswererFlag = process.argv.some((arg) => arg.startsWith("--answerer-"));
  if (!hasAnswererFlag) return undefined;
  const model = value("--answerer-model");
  if (!model) {
    throw new Error("gmos gym external answerer flags require --answerer-model");
  }
  const answererBaseUrl = value("--answerer-base-url");
  const baseUrl = answererBaseUrl ?? intelligence?.baseUrl;
  if (!baseUrl) {
    throw new Error("gmos gym external answerer flags require --answerer-base-url or --intelligence-base-url");
  }
  const answererApiKeyEnv = value("--answerer-api-key-env");
  if (answererApiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(answererApiKeyEnv)) {
    throw new Error("--answerer-api-key-env must be an environment variable name");
  }
  const answererTimeoutMs = positiveIntegerOptionValue("--answerer-timeout-ms");
  const answererDisableThinking = has("--answerer-disable-thinking");
  const apiKeyEnv = answererApiKeyEnv ?? (answererBaseUrl === undefined ? intelligence?.apiKeyEnv : undefined);
  return {
    baseUrl,
    model,
    ...(apiKeyEnv ? { apiKeyEnv, apiKey: apiKeyFromEnv(apiKeyEnv, "External benchmark answerer API key environment variable") } : {}),
    ...(answererTimeoutMs !== undefined || intelligence?.timeoutMs !== undefined
      ? { timeoutMs: answererTimeoutMs ?? intelligence?.timeoutMs }
      : {}),
    ...(answererDisableThinking || intelligence?.disableThinking ? { disableThinking: true } : {}),
  };
}

function externalJudgeConfigOption(
  intelligence: ReturnType<typeof externalIntelligenceOption>,
): CliOpenAICompatibleHookConfig | undefined {
  const hasJudgeFlag = process.argv.some((arg) => arg.startsWith("--judge-"));
  if (!hasJudgeFlag) return undefined;
  const model = value("--judge-model");
  if (!model) {
    throw new Error("gmos gym external judge flags require --judge-model");
  }
  const judgeBaseUrl = value("--judge-base-url");
  const baseUrl = judgeBaseUrl ?? intelligence?.baseUrl;
  if (!baseUrl) {
    throw new Error("gmos gym external judge flags require --judge-base-url or --intelligence-base-url");
  }
  const judgeApiKeyEnv = value("--judge-api-key-env");
  if (judgeApiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(judgeApiKeyEnv)) {
    throw new Error("--judge-api-key-env must be an environment variable name");
  }
  const judgeTimeoutMs = positiveIntegerOptionValue("--judge-timeout-ms");
  const judgeDisableThinking = has("--judge-disable-thinking");
  const apiKeyEnv = judgeApiKeyEnv ?? (judgeBaseUrl === undefined ? intelligence?.apiKeyEnv : undefined);
  return {
    baseUrl,
    model,
    ...(apiKeyEnv ? { apiKeyEnv, apiKey: apiKeyFromEnv(apiKeyEnv, "External benchmark judge API key environment variable") } : {}),
    ...(judgeTimeoutMs !== undefined || intelligence?.timeoutMs !== undefined
      ? { timeoutMs: judgeTimeoutMs ?? intelligence?.timeoutMs }
      : {}),
    ...(judgeDisableThinking || intelligence?.disableThinking ? { disableThinking: true } : {}),
  };
}

function externalOfficialJudgeOption(
  protocol: "deterministic_local" | "official_protocol",
  intelligence: ReturnType<typeof externalIntelligenceOption>,
  answererConfig: CliOpenAICompatibleHookConfig | undefined,
  judgeConfig: CliOpenAICompatibleHookConfig | undefined,
) {
  if (protocol !== "official_protocol") return undefined;
  const config = judgeConfig ?? (intelligence
    ? {
        baseUrl: intelligence.baseUrl,
        model: intelligence.model,
        ...(intelligence.apiKeyEnv
          ? {
              apiKeyEnv: intelligence.apiKeyEnv,
              apiKey: apiKeyFromEnv(
                intelligence.apiKeyEnv,
                "External benchmark official judge API key environment variable",
              ),
            }
          : {}),
        ...(intelligence.timeoutMs !== undefined ? { timeoutMs: intelligence.timeoutMs } : {}),
        ...(intelligence.disableThinking ? { disableThinking: true } : {}),
      }
    : answererConfig);
  if (!config) {
    throw new Error("gmos gym external --protocol official-protocol requires an OpenAI-compatible judge endpoint via --intelligence-base-url/--intelligence-model or --answerer-base-url/--answerer-model");
  }
  return createOpenAICompatibleExternalBenchmarkJudge(config);
}

function listStatusOption(): LowLevelListMemoriesInput["status"] {
  const raw = value("--status");
  if (!raw) return undefined;
  if (raw !== "active" && raw !== "dormant" && raw !== "archived" && raw !== "any") {
    throw new Error("--status must be one of: active, dormant, archived, any");
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

function parseJsonOption(name: string): unknown {
  const raw = value(name);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function reconstructionIntentOption(): ReconstructionIntentHint | undefined {
  const parsed = parseJsonOption("--reconstruction-intent-json");
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--reconstruction-intent-json must be a JSON object");
  }
  return parsed as ReconstructionIntentHint;
}

function readJsonFileOption(name: string): unknown {
  const file = value(name);
  if (!file) usage();
  return JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8")) as unknown;
}

function passphraseFromEnvOption(): string | undefined {
  const envName = value("--passphrase-env");
  if (envName === undefined) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envName)) {
    throw new Error("--passphrase-env must be an environment variable name");
  }
  const passphrase = process.env[envName];
  if (!passphrase) {
    throw new Error(`--passphrase-env ${envName} is not set`);
  }
  return passphrase;
}

function readProfileBundleFileOption(name: string) {
  return parseSqliteProfileBundle(readJsonFileOption(name), {
    passphrase: passphraseFromEnvOption(),
  });
}

function profileImportSourceOption(): "gmos" | "mem0" | "conversation" {
  const raw = value("--from", "gmos");
  if (raw === "gmos" || raw === "mem0" || raw === "conversation") return raw;
  throw new Error("--from must be one of: gmos, mem0, conversation");
}

function transcriptImportFormatOption(): TranscriptIngestFormat {
  return transcriptIngestFormat(value("--input-format"), "--input-format") ?? "auto";
}

function publicOutputPath(resolved: string): string {
  const relative = path.relative(process.cwd(), resolved).split(path.sep).join("/");
  if (relative && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative)) {
    return relative;
  }
  return path.basename(resolved);
}

interface CliVersionReport {
  schema: "gmos.cli_version.v1";
  package: {
    name: string;
    version: string;
  };
  cli: {
    binaries: string[];
    commands: string[];
  };
  runtime: {
    node: string;
    platform: string;
  };
  packageExports: string[];
  publicSurface: {
    mcpTools: string[];
    httpRoutes: string[];
  };
  trustContract: {
    localFirst: true;
    defaultStorage: "sqlite";
    encryptedByDefault: false;
    encryptionSupported: "host_driver";
    cloudRequired: false;
  };
}

const PUBLIC_CLI_COMMANDS = [
  "version",
  "init",
  "doctor",
  "repair",
  "status",
  "maintain",
  "ingest",
  "autopilot",
  "add",
  "update",
  "delete",
  "clear",
  "search",
  "history",
  "list",
  "get",
  "export",
  "import",
  "backup",
  "restore",
  "snapshot",
  "observe",
  "prepare",
  "reconstruct",
  "explain-path",
  "forget",
  "rollback",
  "explain",
  "mcp",
  "keys",
  "audit",
  "serve",
  "http",
  "evolution",
  "gate",
  "gym",
];

function createCliVersionReport(): CliVersionReport {
  const runtimeInfo = getGmosRuntimeInfo();
  return {
    schema: "gmos.cli_version.v1",
    package: runtimeInfo.package,
    cli: {
      binaries: runtimeInfo.cli.binaries,
      commands: [...PUBLIC_CLI_COMMANDS],
    },
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
    },
    packageExports: runtimeInfo.packageExports,
    publicSurface: runtimeInfo.publicSurface,
    trustContract: runtimeInfo.trustContract,
  };
}

function renderCliVersionMarkdown(report: CliVersionReport): string {
  return [
    "# gmOS CLI Version",
    "",
    `Package: ${report.package.name}@${report.package.version}`,
    `Node: ${report.runtime.node} ${report.runtime.platform}`,
    `Binaries: ${report.cli.binaries.join(", ")}`,
    `Commands: ${report.cli.commands.join(", ")}`,
    `Package exports: ${report.packageExports.length ? report.packageExports.join(", ") : "unknown"}`,
    `MCP tools: ${report.publicSurface.mcpTools.join(", ")}`,
    `HTTP routes: ${report.publicSurface.httpRoutes.join(", ")}`,
    `Local-first: ${report.trustContract.localFirst ? "yes" : "no"}`,
    `Default storage: ${report.trustContract.defaultStorage}`,
    `Encrypted by default: ${report.trustContract.encryptedByDefault ? "yes" : "no"}`,
    `Encryption supported: ${report.trustContract.encryptionSupported}`,
    `Cloud required: ${report.trustContract.cloudRequired ? "yes" : "no"}`,
    "",
  ].join("\n");
}

function renderMaintenanceMarkdown(report: MaintenanceReport): string {
  const transitionRows = report.transitions.map((transition) =>
    `| ${transition.memoryId} | ${transition.kind} | ${transition.from} | ${transition.to} | ${transition.retention.toFixed(4)} | ${transition.reasons.join(", ")} |`
  );
  const exemptRows = report.exempted.map((exemption) =>
    `| ${exemption.memoryId} | ${exemption.kind} | ${exemption.status} | ${exemption.reason} |`
  );
  const skippedRows = report.skipped.map((entry) => `| ${entry.reason} | ${entry.count} |`);
  const duplicateRows = report.consolidation.duplicateClusters.map((cluster) =>
    `| ${cluster.kind} | ${cluster.survivorId} | ${cluster.memberIds.join(", ")} | ${cluster.archivedMemberIds.join(", ")} | ${cluster.reasons.join(", ")} |`
  );
  const summaryRows = report.consolidation.summaryMemories.map((summary) =>
    `| ${summary.kind} | ${summary.memoryId ?? "dry-run"} | ${summary.sourceMemoryIds.join(", ")} | ${summary.confidence.toFixed(4)} | ${summary.sharedTags.join(", ")} |`
  );
  const rejectionRows = report.consolidation.rejectedCandidates.map((rejection) =>
    `| ${rejection.kind} | ${rejection.sourceMemoryIds.join(", ")} | ${rejection.reason} |`
  );
  const consolidationSkippedRows = report.consolidation.skipped.map((entry) =>
    `| ${entry.reason} | ${entry.count} |`
  );
  const distillationClusterRows = report.distillation.clusters.map((cluster) =>
    `| ${cluster.objective} | ${cluster.sourceTrajectoryIds.join(", ")} | ${cluster.sharedTags.join(", ")} |`
  );
  const distillationSummaryRows = report.distillation.summaryMemories.map((summary) =>
    `| ${summary.memoryId ?? "dry-run"} | ${summary.sourceTrajectoryIds.join(", ")} | ${summary.confidence.toFixed(4)} | ${summary.sharedTags.join(", ")} |`
  );
  const distillationRejectionRows = report.distillation.rejectedCandidates.map((rejection) =>
    `| ${rejection.sourceTrajectoryIds.join(", ")} | ${rejection.reason} |`
  );
  const distillationSkippedRows = report.distillation.skipped.map((entry) =>
    `| ${entry.reason} | ${entry.count} |`
  );
  const dossierEntityRows = report.dossier.entities.map((entity) =>
    `| ${entity.entityKey} | ${entity.kind} | ${entity.sourceBeliefIds.join(", ")} | ${entity.sourceMemoryIds.join(", ")} |`
  );
  const dossierSummaryRows = report.dossier.summaryMemories.map((summary) =>
    `| ${summary.entityKey} | ${summary.kind} | ${summary.memoryId ?? "dry-run"} | ${summary.supersededMemoryId ?? ""} | ${summary.confidence.toFixed(4)} |`
  );
  const dossierRejectionRows = report.dossier.rejectedCandidates.map((rejection) =>
    `| ${rejection.entityKey} | ${rejection.kind} | ${rejection.reason} |`
  );
  const dossierSkippedRows = report.dossier.skipped.map((entry) =>
    `| ${entry.reason} | ${entry.count} |`
  );
  const explorationCandidateRows = report.exploration.candidates.map((candidate) =>
    `| ${candidate.id} | ${candidate.kind} | ${candidate.subject} | ${candidate.cue ?? ""} | ${candidate.score.toFixed(4)} | ${candidate.supportingRecordIds.join(", ")} |`
  );
  const explorationSuppressedRows = report.exploration.suppressed.map((entry) =>
    `| ${entry.reason} | ${entry.count} |`
  );
  const explorationSkippedRows = report.exploration.skipped.map((entry) =>
    `| ${entry.reason} | ${entry.count} |`
  );
  return [
    "# gmOS Maintenance Report",
    "",
    `Profile: ${report.profileId}`,
    `Now: ${report.now}`,
    `Dry run: ${report.dryRun ? "yes" : "no"}`,
    `Evaluated: ${report.evaluated}`,
    `Transitions: ${report.transitions.length}`,
    "",
    "## Transitions",
    "",
    transitionRows.length === 0
      ? "No transitions."
      : "| Memory | Kind | From | To | Retention | Reasons |\n| --- | --- | --- | --- | ---: | --- |\n" +
          transitionRows.join("\n"),
    "",
    "## Exempted",
    "",
    exemptRows.length === 0
      ? "No exemptions."
      : "| Memory | Kind | Status | Reason |\n| --- | --- | --- | --- |\n" + exemptRows.join("\n"),
    "",
    "## Skipped",
    "",
    skippedRows.length === 0
      ? "No skipped items."
      : "| Reason | Count |\n| --- | ---: |\n" + skippedRows.join("\n"),
    "",
    "## Consolidation",
    "",
    `Enabled: ${report.consolidation.enabled ? "yes" : "no"}`,
    `Evaluated: ${report.consolidation.evaluated}`,
    `Duplicate clusters: ${report.consolidation.duplicateClusters.length}`,
    `Summary memories: ${report.consolidation.summaryMemories.length}`,
    "",
    "### Duplicate Clusters",
    "",
    duplicateRows.length === 0
      ? "No duplicate clusters."
      : "| Kind | Survivor | Members | Archived | Reasons |\n| --- | --- | --- | --- | --- |\n" +
          duplicateRows.join("\n"),
    "",
    "### Summary Memories",
    "",
    summaryRows.length === 0
      ? "No summary memories."
      : "| Kind | Memory | Sources | Confidence | Shared Tags |\n| --- | --- | --- | ---: | --- |\n" +
          summaryRows.join("\n"),
    "",
    "### Rejected Candidates",
    "",
    rejectionRows.length === 0
      ? "No rejected candidates."
      : "| Kind | Sources | Reason |\n| --- | --- | --- |\n" + rejectionRows.join("\n"),
    "",
    "### Consolidation Skipped",
    "",
    consolidationSkippedRows.length === 0
      ? "No skipped consolidation items."
      : "| Reason | Count |\n| --- | ---: |\n" + consolidationSkippedRows.join("\n"),
    "",
    "## Distillation",
    "",
    `Enabled: ${report.distillation.enabled ? "yes" : "no"}`,
    `Evaluated: ${report.distillation.evaluated}`,
    `Clusters: ${report.distillation.clusters.length}`,
    `Summary memories: ${report.distillation.summaryMemories.length}`,
    "",
    "### Procedure Clusters",
    "",
    distillationClusterRows.length === 0
      ? "No procedure clusters."
      : "| Objective | Trajectories | Shared Tags |\n| --- | --- | --- |\n" +
          distillationClusterRows.join("\n"),
    "",
    "### Procedure Memories",
    "",
    distillationSummaryRows.length === 0
      ? "No procedure memories."
      : "| Memory | Trajectories | Confidence | Shared Tags |\n| --- | --- | ---: | --- |\n" +
          distillationSummaryRows.join("\n"),
    "",
    "### Rejected Distillation Candidates",
    "",
    distillationRejectionRows.length === 0
      ? "No rejected distillation candidates."
      : "| Trajectories | Reason |\n| --- | --- |\n" + distillationRejectionRows.join("\n"),
    "",
    "### Distillation Skipped",
    "",
    distillationSkippedRows.length === 0
      ? "No skipped distillation items."
      : "| Reason | Count |\n| --- | ---: |\n" + distillationSkippedRows.join("\n"),
    "",
    "## Dossiers",
    "",
    `Enabled: ${report.dossier.enabled ? "yes" : "no"}`,
    `Evaluated: ${report.dossier.evaluated}`,
    `Entities: ${report.dossier.entities.length}`,
    `Summary memories: ${report.dossier.summaryMemories.length}`,
    "",
    "### Dossier Entities",
    "",
    dossierEntityRows.length === 0
      ? "No dossier entities."
      : "| Entity | Kind | Beliefs | Memories |\n| --- | --- | --- | --- |\n" +
          dossierEntityRows.join("\n"),
    "",
    "### Dossier Memories",
    "",
    dossierSummaryRows.length === 0
      ? "No dossier memories."
      : "| Entity | Kind | Memory | Superseded | Confidence |\n| --- | --- | --- | --- | ---: |\n" +
          dossierSummaryRows.join("\n"),
    "",
    "### Rejected Dossier Candidates",
    "",
    dossierRejectionRows.length === 0
      ? "No rejected dossier candidates."
      : "| Entity | Kind | Reason |\n| --- | --- | --- |\n" + dossierRejectionRows.join("\n"),
    "",
    "### Dossier Skipped",
    "",
    dossierSkippedRows.length === 0
      ? "No skipped dossier items."
      : "| Reason | Count |\n| --- | ---: |\n" + dossierSkippedRows.join("\n"),
    "",
    "## Exploration",
    "",
    `Enabled: ${report.exploration.enabled ? "yes" : "no"}`,
    `Evaluated: ${report.exploration.evaluated}`,
    `Generated: ${report.exploration.generated}`,
    `Persisted: ${report.exploration.persisted}`,
    `Closed since last run: ${report.exploration.closedSinceLastRun}`,
    "",
    "### Gap Candidates",
    "",
    explorationCandidateRows.length === 0
      ? "No gap candidates."
      : "| Gap | Kind | Subject | Cue | Score | Sources |\n| --- | --- | --- | --- | ---: | --- |\n" +
          explorationCandidateRows.join("\n"),
    "",
    "### Suppressed Gap Candidates",
    "",
    explorationSuppressedRows.length === 0
      ? "No suppressed gap candidates."
      : "| Reason | Count |\n| --- | ---: |\n" + explorationSuppressedRows.join("\n"),
    "",
    "### Exploration Skipped",
    "",
    explorationSkippedRows.length === 0
      ? "No skipped exploration items."
      : "| Reason | Count |\n| --- | ---: |\n" + explorationSkippedRows.join("\n"),
    "",
  ].join("\n");
}

function renderIngestMarkdown(report: TranscriptIngestReport): string {
  return [
    "# gmOS Transcript Ingest",
    "",
    `Profile: ${report.profileId}`,
    `Dry run: ${report.dryRun ? "yes" : "no"}`,
    `Format: ${report.format}`,
    `Source hash: ${report.sourceFileHash}`,
    `Parsed: ${report.parsed}`,
    `Observed: ${report.observed}`,
    `Deduplicated: ${report.deduplicated}`,
    `Skipped: ${report.skipped}`,
    `Roles: ${Object.entries(report.byRole).map(([role, count]) => `${role}=${count}`).join(", ") || "none"}`,
    "",
  ].join("\n");
}

function renderAutopilotMarkdown(report: AutopilotReport): string {
  return [
    "# gmOS Autopilot",
    "",
    `Profile: ${report.profileId}`,
    `Dry run: ${report.dryRun ? "yes" : "no"}`,
    `Started: ${report.startedAt}`,
    `Duration: ${report.durationMs}ms`,
    `Phases: ${report.phases.join(", ")}`,
    `Ingested: ${report.counts.ingested}`,
    `Embedded/backfilled: ${report.counts.embedded}`,
    `Maintenance transitions: ${report.maintenance.transitions}`,
    `Errors: ${report.counts.errors}`,
    "",
  ].join("\n");
}

function printCustomReport(json: unknown, markdown: string): void {
  const output = outputFormatOption();
  console.log(output === "markdown" ? markdown : JSON.stringify(json, null, 2));
}

function writeJsonOutput(payload: unknown): void {
  const output = JSON.stringify(payload, null, 2);
  const outputFile = strictOptionValue("--output-file");
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

type CliServiceKeyScope = "read" | "readwrite" | "admin";

function serviceKeyScopeOption(): CliServiceKeyScope {
  const raw = value("--scope");
  if (raw !== "read" && raw !== "readwrite" && raw !== "admin") {
    throw new Error("--scope must be one of: read, readwrite, admin");
  }
  return raw;
}

function serviceKeyProfilesOption(): string[] | "*" {
  const raw = value("--profiles");
  if (!raw) return "*";
  const profiles = [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (profiles.length === 0) throw new Error("--profiles must be '*' or comma-separated profile ids");
  if (profiles.includes("*")) return "*";
  return profiles.sort();
}

function sourceTrustOption(): SourceTrust | undefined {
  const raw = value("--source-trust");
  if (raw === undefined) return undefined;
  if (raw === "user" || raw === "agent" || raw === "external") return raw;
  throw new Error("--source-trust must be one of: user, agent, external");
}

function auditSinceOption(): string | undefined {
  const raw = value("--since");
  if (!raw) return undefined;
  if (Number.isNaN(Date.parse(raw))) throw new Error("--since must be an ISO timestamp");
  return raw;
}

function loopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function serveHostnameOption(): string {
  return value("--host-iface", value("--listen-host", "127.0.0.1"))!;
}

function assertServeHostAllowed(hostname: string): void {
  if (loopbackHost(hostname)) return;
  if (!has("--allow-non-loopback")) {
    throw new Error("gmos serve refuses non-loopback host interfaces without --allow-non-loopback");
  }
  console.error(
    JSON.stringify({
      level: "warn",
      service: "gmos",
      warning: "non_loopback_bind",
      host: hostname,
    }),
  );
}

function autopilotIntervalMinutesOption(): number | undefined {
  const raw = value("--autopilot-interval-minutes");
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--autopilot-interval-minutes must be a positive number");
  }
  return parsed;
}

function deterministicJitterMs(profileId: string, intervalMs: number): number {
  const seed = [...profileId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const maxJitter = Math.max(1, Math.min(30_000, Math.floor(intervalMs * 0.1)));
  return seed % maxJitter;
}

function startAutopilotScheduler(input: {
  memory: Awaited<ReturnType<typeof createRuntime>>["memory"];
  store: Awaited<ReturnType<typeof createRuntime>>["store"];
  profileId: string;
  intervalMinutes: number | undefined;
}): {
  status: () => { enabled: boolean; running: boolean; lastRunAt?: string; nextRunAt?: string };
  stop: () => void;
} {
  if (input.intervalMinutes === undefined) {
    return {
      status: () => ({ enabled: false, running: false }),
      stop: () => {},
    };
  }
  const intervalMs = Math.max(1, Math.round(input.intervalMinutes * 60_000));
  const delayMs = intervalMs + deterministicJitterMs(input.profileId, intervalMs);
  let running = false;
  let lastRunAt: string | undefined;
  let nextRunAt = new Date(Date.now() + delayMs).toISOString();
  const tick = () => {
    nextRunAt = new Date(Date.now() + delayMs).toISOString();
    if (running) {
      console.error(JSON.stringify({
        service: "gmos-autopilot",
        profileId: input.profileId,
        skipped: "previous_run_still_running",
      }));
      return;
    }
    running = true;
    void runAutopilot({
      memory: input.memory,
      store: input.store,
      profileId: input.profileId,
      phases: maintenancePhasesOption(),
      embedBackfill: embedBackfillOption(),
      ...(value("--ingest-dir") !== undefined
        ? { ingest: { dir: path.resolve(process.cwd(), value("--ingest-dir")!) } }
        : {}),
      historyRetention: autopilotHistoryRetentionOption(),
    }).then((report) => {
      lastRunAt = report.finishedAt;
      console.error(JSON.stringify({
        service: "gmos-autopilot",
        profileId: report.profileId,
        startedAt: report.startedAt,
        durationMs: report.durationMs,
        counts: report.counts,
      }));
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        service: "gmos-autopilot",
        profileId: input.profileId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }).finally(() => {
      running = false;
    });
  };
  const timer = setInterval(tick, delayMs);
  return {
    status: () => ({
      enabled: true,
      running,
      ...(lastRunAt ? { lastRunAt } : {}),
      nextRunAt,
    }),
    stop: () => clearInterval(timer),
  };
}

async function runKeysCommand(action: string | undefined): Promise<void> {
  const store = createSqliteMemoryStore({ path: value("--db", "./gmos.db")! });
  try {
    if (action === "create") {
      const label = strictOptionValue("--label");
      if (!label) throw new Error("gmos keys create requires --label");
      const result = store.createServiceApiKey({
        label,
        scope: serviceKeyScopeOption(),
        profiles: serviceKeyProfilesOption(),
        ...(value("--default-disposition") !== undefined
          ? { defaultDisposition: value("--default-disposition") }
          : {}),
        historyAccess: !has("--no-history-access"),
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    if (action === "list") {
      console.log(JSON.stringify({ ok: true, keys: store.listServiceApiKeys() }, null, 2));
      return;
    }
    if (action === "revoke") {
      const keyId = strictOptionValue("--key-id");
      if (!keyId) throw new Error("gmos keys revoke requires --key-id");
      const key = store.revokeServiceApiKey(keyId);
      if (!key) {
        console.error(`Key not found: ${keyId}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: true, key }, null, 2));
      return;
    }
    throw new Error("gmos keys action must be create, list, or revoke");
  } finally {
    store.close();
  }
}

function safeSnapshotName(raw: string): string {
  const normalized = raw.trim().replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error("snapshot name must contain at least one filename-safe character");
  return normalized.slice(0, 80);
}

function snapshotTimestampForFile(timestamp: string): string {
  return timestamp.replace(/[:.]/gu, "-");
}

async function runSnapshotCommand(action: string | undefined): Promise<void> {
  const store = createSqliteMemoryStore({ path: value("--db", "./gmos.db")! });
  const profileId = value("--profile", "default")!;
  try {
    if (action === "create") {
      const createdAt = new Date().toISOString();
      const name = safeSnapshotName(value("--name", createdAt) ?? createdAt);
      const snapshotsDir = path.resolve(process.cwd(), value("--snapshots-dir", "snapshots") ?? "snapshots");
      mkdirSync(snapshotsDir, { recursive: true });
      const bundle = store.exportProfileBundle({
        profileId,
        mode: "full",
        includeArchived: true,
        includeSensitive: true,
        includePerson: true,
        includeEvidence: true,
        includeWorldBeliefs: true,
        includeFailures: true,
        includeTaskTrajectories: true,
      });
      const serialized = serializeSqliteProfileBundle({
        bundle,
        passphrase: passphraseFromEnvOption(),
      });
      const body = `${JSON.stringify(serialized, null, 2)}\n`;
      const fileName = `${snapshotTimestampForFile(createdAt)}-${name}.gmos-profile-bundle.json`;
      const outputPath = path.join(snapshotsDir, fileName);
      writeFileSync(outputPath, body);
      const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
      const evidence = await store.recordEvidence({
        profileId,
        eventKey: ["snapshot", profileId, createdAt, name].join(":"),
        sourceType: "snapshot",
        content: "Profile snapshot point",
        sensitivity: "normal",
        eligibleForLongTermMemory: false,
        createdAt,
        payload: {
          schema: "gmos.profile_snapshot_point.v1",
          name,
          fileName,
          sha256,
          bytes: Buffer.byteLength(body, "utf8"),
          createdAt,
          bundleSchema: serialized.schema,
          mode: "full",
        },
      });
      console.log(JSON.stringify({
        ok: true,
        snapshot: {
          id: evidence.id,
          name,
          createdAt,
          outputFile: publicOutputPath(outputPath),
          sha256,
        },
      }, null, 2));
      return;
    }
    if (action === "list") {
      if (!store.listEvidence) throw new Error("gmOS store does not support snapshot listing");
      const snapshots = await store.listEvidence({
        profileId,
        sourceType: "snapshot",
        eligibleForLongTermMemory: false,
        includeSensitive: true,
        limit: positiveIntegerOption("--limit", 50),
      });
      console.log(JSON.stringify({
        ok: true,
        snapshots: snapshots.map((snapshot) => ({
          id: snapshot.id,
          createdAt: snapshot.createdAt,
          ...snapshot.payload,
        })),
      }, null, 2));
      return;
    }
    throw new Error("gmos snapshot action must be create or list");
  } finally {
    store.close();
  }
}

async function runAuditCommand(action: string | undefined): Promise<void> {
  if (action !== "list") throw new Error("gmos audit action must be list");
  const store = createSqliteMemoryStore({ path: value("--db", "./gmos.db")! });
  try {
    console.log(
      JSON.stringify(
        {
          ok: true,
          audit: store.listServiceAuditRows({
            keyId: value("--key-id"),
            since: auditSinceOption(),
            limit: positiveIntegerOption("--limit", 100),
          }),
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
}

function embedBackfillOption(): boolean | { batchSize: number } {
  const raw = value("--embed-backfill-batch");
  if (raw === undefined) return true;
  return { batchSize: positiveIntegerOption("--embed-backfill-batch", 32) };
}

function autopilotHistoryRetentionOption(): number {
  return nonNegativeIntegerOption("--history-retention", 100);
}

async function runAutopilotHistoryCommand(): Promise<void> {
  const store = createSqliteMemoryStore({ path: value("--db", "./gmos.db")! });
  try {
    const profileId = value("--profile");
    const history = store.listAutopilotRuns({
      ...(profileId ? { profileId } : {}),
      limit: positiveIntegerOption("--limit", 20),
    });
    console.log(JSON.stringify({ ok: true, history }, null, 2));
  } finally {
    store.close();
  }
}

async function runServeCommand(input: {
  memory: Awaited<ReturnType<typeof createRuntime>>["memory"];
  store: Awaited<ReturnType<typeof createRuntime>>["store"];
  profileId: string;
}): Promise<void> {
  const hostname = serveHostnameOption();
  assertServeHostAllowed(hostname);
  const authToken = strictOptionValue("--auth-token", process.env.GMOS_HTTP_AUTH_TOKEN);
  const scopedKeys = has("--keys");
  const autopilot = startAutopilotScheduler({
    memory: input.memory,
    store: input.store,
    profileId: input.profileId,
    intervalMinutes: autopilotIntervalMinutesOption(),
  });
  const server = await serveMemoryHttp({
    memory: input.memory,
    store: input.store,
    profileId: input.profileId,
    host: hostPreset(),
    port: nonNegativeIntegerOption("--port", 4787),
    hostname,
    authToken,
    scopedKeys,
    corsOrigins: values("--cors-origin"),
    rateLimitRequestsPerMinute: positiveIntegerOption("--rate-limit", 600),
    console: has("--console"),
    ...(autopilotIntervalMinutesOption() !== undefined ? { autopilotStatus: autopilot.status } : {}),
    ...(value("--audit-retention-days") !== undefined
      ? { auditRetentionDays: nonNegativeIntegerOption("--audit-retention-days", 0) }
      : {}),
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        url: server.address.url,
        authRequired: scopedKeys || authToken !== undefined,
        authMode: scopedKeys ? "scoped_keys" : "legacy_token",
        console: has("--console"),
        autopilot: autopilot.status(),
        encrypted: input.store.encryptionStatus().encrypted,
      },
      null,
      2,
    ),
  );
  try {
    await waitForServerShutdown();
  } finally {
    autopilot.stop();
    await server.close();
  }
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

function requireYes(action: string): void {
  if (!has("--yes")) throw new Error(`${action} refuses to run without --yes`);
}

async function runEvolutionApply(): Promise<void> {
  requireYes("gmos evolution apply");
  const dbPath = value("--db", "./gmos.db")!;
  const profileId = value("--profile", "default")!;
  const proposalId = value("--proposal");
  const approvedBy = value("--approved-by");
  if (!proposalId || !approvedBy) usage();
  const store = createSqliteMemoryStore({ path: dbPath });
  try {
    await store.initialize();
    const controlPlane = createEvolutionControlPlane({ store, profileId });
    const result = await controlPlane.applyEvolutionProposal({
      profileId,
      proposalId,
      approvedBy,
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } finally {
    await store.close();
  }
}

async function runEvolutionRevert(): Promise<void> {
  requireYes("gmos evolution revert");
  const dbPath = value("--db", "./gmos.db")!;
  const applicationEventId = value("--application");
  if (!applicationEventId) usage();
  const profileId = value("--profile");
  const store = createSqliteMemoryStore({ path: dbPath });
  try {
    await store.initialize();
    const controlPlane = createEvolutionControlPlane({ store });
    const result = await controlPlane.revertEvolutionApplication({
      ...(profileId ? { profileId } : {}),
      applicationEventId,
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } finally {
    await store.close();
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
  if (command === "--version" || command === "-v") {
    console.log(readGmosPackageInfo().version);
    return;
  }
  if (!command || has("--help") || has("-h")) usage();

  if (command === "version") {
    const report = createCliVersionReport();
    printReport(report, renderCliVersionMarkdown(report));
    return;
  }

  if (command === "http" && subcommand === "openapi") {
    console.log(JSON.stringify(createMemoryHttpOpenApiDocument(), null, 2));
    return;
  }

  if (command === "keys") {
    await runKeysCommand(subcommand);
    return;
  }

  if (command === "snapshot") {
    await runSnapshotCommand(subcommand);
    return;
  }

  if (command === "audit") {
    await runAuditCommand(subcommand);
    return;
  }

  if (command === "autopilot" && subcommand === "history") {
    await runAutopilotHistoryCommand();
    return;
  }

  if (command === "gate" || (command === "gym" && subcommand === "gate")) {
    const report = await runMemoryReleaseGate({
      generatedSeeds: positiveIntegerOption("--generated-seeds", 3),
      scaleSizes: parsePositiveIntegerList(
        value("--scale-sizes", "100,1000") ?? "100,1000",
        "--scale-sizes",
      ),
      scaleThresholdP95Ms: nonNegativeNumberOption("--threshold-p95-ms", 250),
      scaleIngestP95Ms: nonNegativeNumberOption("--ingest-threshold-p95-ms", 25),
      scaleIngestLastToFirstFactor: positiveNumberOption("--ingest-last-to-first-factor", 3),
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
      ingestP95Ms: nonNegativeNumberOption("--ingest-threshold-p95-ms", 25),
      ingestLastToFirstFactor: positiveNumberOption("--ingest-last-to-first-factor", 3),
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
    const ingestMode = externalIngestModeOption();
    const intelligence = externalIntelligenceOption();
    const maintainPhases = externalMaintainPhasesOption();
    const parsedDataset =
      datasetFormat === "gmos"
        ? {
            datasetFormat: "gmos.external_long_memory_qa.jsonl" as const,
            cases: parseExternalMemoryBenchmarkJsonl(inputText),
          }
        : parseExternalMemoryBenchmarkDataset(inputText, { adapter: datasetFormat, ingestMode });
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
    const protocol = externalProtocolOption();
    const answererConfig = externalAnswererConfigOption(intelligence);
    if (answererConfig && protocol !== "official_protocol") {
      throw new Error("gmos gym external --answerer-* flags require --protocol official-protocol");
    }
    const judgeConfig = externalJudgeConfigOption(intelligence);
    if (judgeConfig && protocol !== "official_protocol") {
      throw new Error("gmos gym external --judge-* flags require --protocol official-protocol");
    }
    const answerer = answererConfig
      ? createOpenAICompatibleExternalBenchmarkAnswerer(answererConfig)
      : undefined;
    const judge = externalOfficialJudgeOption(protocol, intelligence, answererConfig, judgeConfig);
    const resultsJsonl = strictOptionValue("--results-jsonl");
    const maxCases = positiveIntegerOptionValue("--max-cases");
    const caseOffset = nonNegativeIntegerOptionValue("--case-offset");
    const caseIds = commaSeparatedStringOption("--case-ids");
    const abortController = new AbortController();
    let interrupted = false;
    const handleInterrupt = (signal: NodeJS.Signals): void => {
      interrupted = true;
      if (!abortController.signal.aborted) {
        console.error(`[gmos external] ${signal} received; finishing in-flight case work and writing partial artifacts`);
        abortController.abort();
      }
    };
    process.once("SIGINT", handleInterrupt);
    process.once("SIGTERM", handleInterrupt);
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
      temporalMode: temporalModeOption(),
      ...(has("--temporal-metadata") ? { includeTemporalMetadata: true } : {}),
      ...(has("--include-sensitive") ? { includeSensitive: true } : {}),
      concurrency: positiveIntegerOption("--concurrency", 4),
      extractionWindow: positiveIntegerOption("--extraction-window", 12),
      reuseProfiles: !has("--no-reuse-profiles"),
      failureSampleLimit: nonNegativeIntegerOption("--failure-sample-limit", 20),
      diagnosticsLevel: diagnosticsLevelOption(),
      protocol,
      ...(maxCases !== undefined ? { maxCases } : {}),
      ...(caseOffset !== undefined ? { caseOffset } : {}),
      ...(caseIds !== undefined ? { caseIds } : {}),
      abortSignal: abortController.signal,
      ...(judge ? { judge } : {}),
      ...(answerer ? { answerer } : {}),
      ingestMode,
      ...(intelligence ? { intelligence } : {}),
      ...(maintainPhases ? { maintainPhases } : {}),
      ...(has("--progress") || resultsJsonl
        ? {
            onCaseGroupSetup: (progress) => {
              if (has("--progress")) {
                console.error(
                  `[gmos external] setup group=${progress.groupKey} events=${progress.eventCount} memories=${progress.extractedMemoryCount} windows=${progress.extractionWindowCount} extractionCalls=${progress.extractionCallCount} extractionRetries=${progress.extractionRetryCount} extractionEmpty=${progress.extractionEmptyCount} okChars=${progress.extractionOkWithCandidatesCharCount} emptyChars=${progress.extractionEmptyCharCount} parseFailureChars=${progress.extractionParseFailureCharCount} transportFailureChars=${progress.extractionTransportFailureCharCount} extractionParseFailures=${progress.extractionParseFailureCount} extractionTransportFailures=${progress.extractionTransportFailureCount} extractionFailures=${progress.extractionFailureCount} ingestMs=${progress.ingestDurationMs}`,
                );
              }
            },
            onCaseGroupIngestProgress: (progress) => {
              if (!has("--progress")) return;
              console.error(
                `[gmos external] ingest group=${progress.groupKey} windows=${progress.windowsDone}/${progress.windowsTotal} extractionCalls=${progress.extractionCallCount} extractionRetries=${progress.extractionRetryCount} extractionEmpty=${progress.extractionEmptyCount} okChars=${progress.extractionOkWithCandidatesCharCount} emptyChars=${progress.extractionEmptyCharCount} parseFailureChars=${progress.extractionParseFailureCharCount} transportFailureChars=${progress.extractionTransportFailureCharCount} extractionParseFailures=${progress.extractionParseFailureCount} extractionTransportFailures=${progress.extractionTransportFailureCount} extractionFailures=${progress.extractionFailureCount} memories=${progress.extractedMemoryCount} elapsedMs=${progress.elapsedMs} etaMs=${progress.etaMs ?? "unknown"}`,
              );
            },
            onCaseResult: (progress) => {
              if (resultsJsonl) appendJsonLine(resultsJsonl, progress.result);
              if (!has("--progress")) return;
              const status = progress.pass ? "pass" : "fail";
              console.error(
                `[gmos external] ${progress.completedCount}/${progress.totalCount} ${status} case=${progress.caseId} durationMs=${progress.durationMs} passed=${progress.passedCount} failed=${progress.failedCount}`,
              );
            },
          }
        : {}),
      ...(requireConvergence ? { requireConvergence: true } : {}),
    }).finally(() => {
      process.removeListener("SIGINT", handleInterrupt);
      process.removeListener("SIGTERM", handleInterrupt);
    });
    const reproductionBundle = strictOptionValue("--reproduction-bundle");
    if (reproductionBundle) {
      writeExternalMemoryBenchmarkReproductionBundle({
        outputDir: reproductionBundle,
        report,
        command: ["gmos", ...process.argv.slice(2)],
        envVarNames: [
          ...values("--intelligence-api-key-env"),
          ...values("--answerer-api-key-env"),
        ],
      });
    }
    printReport(report, renderExternalMemoryBenchmarkMarkdown(report));
    if (interrupted || report.runManifest.execution.interrupted) {
      process.exitCode = 130;
    } else if (!report.pass) {
      process.exitCode = 1;
    }
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

  if (command === "mcp" && subcommand === "call" && value("--tool") === "memory.runtime_info") {
    const input = parseJsonInput(value("--input"));
    const unsupported =
      input && typeof input === "object" && !Array.isArray(input)
        ? Object.keys(input as Record<string, unknown>)
        : ["input"];
    const structuredContent =
      unsupported.length === 0
        ? { ok: true, runtimeInfo: getGmosRuntimeInfo() }
        : {
            ok: false,
            error: `memory.runtime_info contains unsupported fields: ${unsupported.join(", ")}`,
          };
    const result = {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
      ...(structuredContent.ok ? {} : { isError: true }),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!structuredContent.ok) process.exitCode = 1;
    return;
  }

  if (command === "evolution" && subcommand === "report") {
    await runEvolutionReport();
    return;
  }
  if (command === "evolution" && subcommand === "apply") {
    await runEvolutionApply();
    return;
  }
  if (command === "evolution" && subcommand === "revert") {
    await runEvolutionRevert();
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
      const encrypted = store.encryptionStatus().encrypted;
      console.log(JSON.stringify({ ok: true, dbPath, encrypted }, null, 2));
      return;
    }

    if (command === "doctor") {
      await store.initialize();
      const encryption = store.encryptionStatus();
      const report: CliDoctorReport = {
        ok: true,
        dbPath: REDACTED_PLAINTEXT_SQLITE_PATH,
        encrypted: encryption.encrypted,
        runtimeInfo: getGmosRuntimeInfo(),
        schema: {
          dialect: "sqlite",
          version: store.schemaVersion ? await store.schemaVersion() : null,
        },
        rowCounts: await store.rowCounts(),
        readAudit: doctorReadAudit(store.readAuditSnapshot ? await store.readAuditSnapshot() : null),
        searchIndex: store.searchIndexStatus ? await store.searchIndexStatus() : null,
        hostCompatibility: hostReport(requestedHost),
      };
      printReport(report, renderDoctorMarkdown(report));
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
              searchIndex: await store.repairSearchIndex({
                dryRun: has("--dry-run"),
                vectorBatchSize: positiveIntegerOption("--vector-batch-size", 32),
              }),
            },
            null,
            2,
          ),
        );
        return;
      }
      usage();
    }

    if (command === "maintain") {
      const phases = maintenancePhasesOption();
      const report = await memory.maintain({
        profileId,
        dryRun: has("--dry-run"),
        ...(phases !== undefined ? { phases } : {}),
        ...(value("--now") !== undefined ? { now: value("--now") } : {}),
      });
      printReport(report, renderMaintenanceMarkdown(report));
      return;
    }

    if (command === "ingest") {
      const inputFile = strictOptionValue("--input-file");
      if (!inputFile) throw new Error("gmos ingest requires --input-file");
      const report = await ingestTranscript({
        memory,
        profileId,
        inputFile: path.resolve(process.cwd(), inputFile),
        format: transcriptIngestFormatOption(),
        dryRun: has("--dry-run"),
      });
      printCustomReport(report, renderIngestMarkdown(report));
      return;
    }

    if (command === "autopilot" && subcommand === "run") {
      const phases = maintenancePhasesOption();
      const report = await runAutopilot({
        memory,
        store,
        profileId,
        dryRun: has("--dry-run"),
        ...(phases !== undefined ? { phases } : {}),
        embedBackfill: embedBackfillOption(),
        ...(value("--ingest-dir") !== undefined
          ? { ingest: { dir: path.resolve(process.cwd(), value("--ingest-dir")!) } }
          : {}),
        ...(value("--now") !== undefined ? { now: value("--now") } : {}),
        historyRetention: autopilotHistoryRetentionOption(),
      });
      printCustomReport(report, renderAutopilotMarkdown(report));
      return;
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

    if (command === "search" || command === "history") {
      const query = value("--query");
      if (!query) usage();
      const memories = await memory.search({
        profileId,
        query,
        purpose: command === "history" ? "history" : searchPurposeOption(),
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
      const bundle = store.exportProfileBundle({
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
      writeJsonOutput(serializeSqliteProfileBundle({
        bundle,
        passphrase: passphraseFromEnvOption(),
      }));
      return;
    }

    if (command === "import") {
      const inputFile = strictOptionValue("--input-file");
      if (!inputFile) throw new Error("gmos import requires --input-file");
      const source = profileImportSourceOption();
      if (source === "mem0") {
        const report = await loadMem0ExportIntoStore({
          store,
          profileId,
          inputFile: path.resolve(process.cwd(), inputFile),
          allowPerson: has("--include-person"),
        });
        console.log(JSON.stringify({ ok: true, ...report }, null, 2));
        return;
      }
      if (source === "conversation") {
        const report = await ingestTranscript({
          memory,
          profileId,
          inputFile: path.resolve(process.cwd(), inputFile),
          format: transcriptImportFormatOption(),
          dryRun: has("--dry-run"),
        });
        printCustomReport(report, renderIngestMarkdown(report));
        return;
      }
      const raw = readJsonFileOption("--input-file");
      if (
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        (raw as { schema?: unknown }).schema === "gmos.memory_snapshot_export.v1"
      ) {
        const parsed = parseMemorySnapshotExport(raw);
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
      const report = store.importProfileBundle({
        backup: parseSqliteProfileBundle(raw, { passphrase: passphraseFromEnvOption() }),
        profileId: value("--profile"),
        onConflict: profileBackupConflictOption(),
      });
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
      return;
    }

    if (command === "backup") {
      const backup = store.exportProfileBundle({
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
      writeJsonOutput(serializeSqliteProfileBundle({
        bundle: backup,
        passphrase: passphraseFromEnvOption(),
      }));
      return;
    }

    if (command === "restore") {
      const parsed = readProfileBundleFileOption("--input-file");
      const report = store.importProfileBundle({
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
      const sourceTrust = sourceTrustOption();
      const event = {
        type: "conversation.message",
        profileId,
        role: "user",
        content: text,
        privacyMode: has("--incognito") ? "incognito" : "normal",
        createdAt: new Date().toISOString(),
        ...(sourceTrust ? { sourceTrust } : {}),
      } as const;
      if (has("--report")) {
        console.log(JSON.stringify(await memory.observeWithReport(event), null, 2));
        return;
      }
      await memory.observe(event);
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
                reconstructionIntent: reconstructionIntentOption(),
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
        reconstructionIntent: reconstructionIntentOption(),
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
        reconstructionIntent: reconstructionIntentOption(),
      });
      console.log(JSON.stringify(explanation, null, 2));
      return;
    }

    if (command === "forget") {
      const query = value("--query");
      if (!query) usage();
      const targetTerms = values("--target-term");
      console.log(
        JSON.stringify(
          await memory.forget({
            profileId,
            query,
            ...(targetTerms.length > 0 ? { targetTerms } : {}),
          }),
          null,
          2,
        ),
      );
      return;
    }

    if (command === "rollback") {
      if (!has("--yes")) throw new Error("gmos rollback requires --yes");
      const memoryId = value("--memory");
      const toEvidenceEventId = value("--to");
      const approvedBy = value("--approved-by");
      if (!memoryId || !toEvidenceEventId || !approvedBy) usage();
      console.log(JSON.stringify(await memory.memoryRollback({
        profileId,
        memoryId,
        toEvidenceEventId,
        approvedBy,
      }), null, 2));
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

    if (command === "serve" || (command === "http" && subcommand === "serve")) {
      await runServeCommand({ memory, store, profileId });
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
