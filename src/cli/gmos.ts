#!/usr/bin/env node
import { createMemoryOS } from "../runtime/create-memory-os.js";
import { runMemoryGym } from "../gym/index.js";
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
  gmos doctor --db ./gmos.db
  gmos observe --db ./gmos.db --profile local --text "我喜欢简洁回答"
  gmos prepare --db ./gmos.db --profile local --text "你知道我什么偏好吗？"
  gmos forget --db ./gmos.db --profile local --query "Moonbase"
  gmos gym run --db :memory:
`);
  process.exit(1);
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
    console.log(JSON.stringify(report, null, 2));
    return;
  }

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

    usage();
  } finally {
    await memory.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

