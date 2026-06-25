#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMemoryOS } from "../runtime/create-memory-os.js";
import {
  renderMemoryGymMarkdown,
  renderMemoryScaleMarkdown,
  runMemoryGym,
  runMemoryScaleBenchmark,
} from "../gym/index.js";
import {
  createPresetHostAdapter,
  type HostPreset,
} from "../host/index.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";

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
  gmos gym run --db :memory: --format markdown --report-file ./memory-gym.md
  gmos gym scale --sizes 100,1000
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

function hostReport(preset: HostPreset | undefined) {
  if (!preset) return undefined;
  return createPresetHostAdapter(preset).compatibility;
}

async function createRuntime() {
  const dbPath = value("--db", "./gmos.db")!;
  const profileId = value("--profile", "default")!;
  const store = createSqliteMemoryStore({ path: dbPath });
  const memory = createMemoryOS({ profileId, store });
  return { memory, store, profileId, dbPath };
}

async function main(): Promise<void> {
  const [command, subcommand] = process.argv.slice(2);
  if (!command || has("--help") || has("-h")) usage();

  if (command === "gym" && subcommand === "run") {
    const report = await runMemoryGym({ dbPath: value("--db", ":memory:") });
    printReport(report, renderMemoryGymMarkdown(report));
    return;
  }

  if (command === "gym" && subcommand === "scale") {
    const sizes = parsePositiveIntegerList(value("--sizes", "100,1000") ?? "100,1000", "--sizes");
    const report = await runMemoryScaleBenchmark({ sizes });
    printReport(report, renderMemoryScaleMarkdown(report));
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

    usage();
  } finally {
    await memory.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
