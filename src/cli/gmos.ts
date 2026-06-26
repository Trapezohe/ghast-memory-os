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
  renderMemoryGymMarkdown,
  renderMemoryReleaseGateMarkdown,
  renderMemoryScaleMarkdown,
  runHostCompatibilityGym,
  runMemoryGym,
  runMemoryReleaseGate,
  runMemoryScaleBenchmark,
} from "../gym/index.js";
import {
  createPresetHostAdapter,
  exportMemorySnapshots,
  type HostActualCompatibilityReport,
  type HostPreset,
  loadHostMemorySnapshotsIntoStore,
  parseMemorySnapshotExport,
} from "../host/index.js";
import { serveMemoryHttp } from "../http/index.js";
import {
  createMemoryMcpServer,
  listMemoryMcpTools,
  serveMemoryMcpStdio,
} from "../mcp/index.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
import type {
  FailureKind,
  LowLevelListMemoriesInput,
  LowLevelSearchInput,
  MemoryKind,
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
  gmos observe --db ./gmos.db --profile local --text "我喜欢简洁回答"
  gmos prepare --db ./gmos.db --profile local --text "你知道我什么偏好吗？"
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
  gmos gym gate --generated-seeds 3 --scale-sizes 100,1000 --format json
  gmos gym host --hosts ghast,mcp,mock_l3,search_only --actual-report ./host-status.json --format markdown
`);
  process.exit(1);
}

function writeReportIfRequested(content: string): void {
  const reportFile = value("--report-file");
  if (!reportFile) return;
  const resolved = path.resolve(process.cwd(), reportFile);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
}

function printReport(json: unknown, markdown: string): void {
  const format = value("--format", "json");
  const output = format === "markdown" ? markdown : JSON.stringify(json, null, 2);
  writeReportIfRequested(output);
  console.log(output);
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

function hostActualReportFromUnknown(value: unknown): HostActualCompatibilityReport[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => hostActualReportFromUnknown(entry));
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.gmosSdkAdapter) {
    return hostActualReportFromUnknown(record.gmosSdkAdapter);
  }
  const hostId = typeof record.hostId === "string" ? record.hostId : null;
  const level = typeof record.level === "string" ? record.level : null;
  if (!hostId || !level) return [];
  if (level !== "L0" && level !== "L1" && level !== "L2" && level !== "L3" && level !== "L4") {
    return [];
  }
  const targetLevel =
    record.targetLevel === "L0" ||
    record.targetLevel === "L1" ||
    record.targetLevel === "L2" ||
    record.targetLevel === "L3" ||
    record.targetLevel === "L4"
      ? record.targetLevel
      : undefined;
  return [
    {
      hostId,
      level,
      targetLevel,
      canClaimTargetLevel:
        typeof record.canClaimTargetLevel === "boolean"
          ? record.canClaimTargetLevel
          : undefined,
      blockingGaps: Array.isArray(record.blockingGaps)
        ? record.blockingGaps.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      contextOwnership:
        typeof record.contextOwnership === "string" ? record.contextOwnership : undefined,
      candidateRetrievalOwnership:
        typeof record.candidateRetrievalOwnership === "string"
          ? record.candidateRetrievalOwnership
          : undefined,
      storageOwnership:
        typeof record.storageOwnership === "string" ? record.storageOwnership : undefined,
      mutationOwnership:
        typeof record.mutationOwnership === "string" ? record.mutationOwnership : undefined,
    },
  ];
}

function actualHostReportsFromOption(): HostActualCompatibilityReport[] | undefined {
  const reportFile = value("--actual-report");
  if (!reportFile) return undefined;
  const resolved = path.resolve(process.cwd(), reportFile);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  const reports = hostActualReportFromUnknown(parsed);
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
  if (raw !== "context" && raw !== "delete" && raw !== "manage") {
    throw new Error("--purpose must be one of: context, delete, manage");
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

function writeJsonOutput(payload: unknown): void {
  const output = JSON.stringify(payload, null, 2);
  const outputFile = value("--output-file");
  if (outputFile) {
    const resolved = path.resolve(process.cwd(), outputFile);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, output);
    console.log(JSON.stringify({ ok: true, outputFile: resolved }, null, 2));
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
      if (!has("--search-index")) usage();
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
      });
      console.log(JSON.stringify(prepared, null, 2));
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
