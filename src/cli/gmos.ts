#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMemoryOS } from "../runtime/create-memory-os.js";
import {
  createEvolutionControlPlane,
  renderEvolutionFailureReviewMarkdown,
  type FailureReviewStore,
} from "../evolution/index.js";
import {
  renderHostCompatibilityGymMarkdown,
  renderMemoryGymMarkdown,
  renderMemoryScaleMarkdown,
  runHostCompatibilityGym,
  runMemoryGym,
  runMemoryScaleBenchmark,
} from "../gym/index.js";
import {
  createPresetHostAdapter,
  type HostPreset,
} from "../host/index.js";
import {
  createMemoryMcpServer,
  listMemoryMcpTools,
  serveMemoryMcpStdio,
} from "../mcp/index.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";
import type { FailureKind } from "../kernel/types.js";

function value(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  console.log(`gmOS CLI

Usage:
  gmos init --db ./gmos.db
  gmos doctor --db ./gmos.db --host ghast
  gmos observe --db ./gmos.db --profile local --text "我喜欢简洁回答"
  gmos prepare --db ./gmos.db --profile local --text "你知道我什么偏好吗？"
  gmos forget --db ./gmos.db --profile local --query "Moonbase"
  gmos explain --db ./gmos.db --profile local --id memory_xxx
  gmos mcp tools
  gmos mcp call --db ./gmos.db --tool memory.prepare_context --input '{"text":"你知道我什么偏好吗？"}'
  gmos mcp serve --db ./gmos.db --profile local
  gmos evolution report --db ./gmos.db --profile local --format markdown
  gmos gym run --db :memory: --generated-seeds 3 --format markdown --report-file ./memory-gym.md
  gmos gym scale --sizes 100,1000 --threshold-p95-ms 250
  gmos gym host --hosts ghast,mcp,mock_l3,search_only --format markdown
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
            hostCompatibility: hostReport(requestedHost),
          },
          null,
          2,
        ),
      );
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

    usage();
  } finally {
    await memory.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
