import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

import { createMemoryOS, type MemoryStore } from "../src/index.js";
import {
  renderHostCompatibilityGymMarkdown,
  renderMemoryGymMarkdown,
  renderMemoryReleaseGateMarkdown,
  renderMemoryScaleMarkdown,
  runHostCompatibilityGym,
  runMemoryGym,
  runMemoryReleaseGate,
  runMemoryScaleBenchmark,
} from "../src/gym/index.js";
import {
  createSqliteMemoryStore,
  parseSqliteProfileBackup,
  type SqliteMemoryStore,
  type SqliteProfileBackupDocument,
} from "../src/store/sqlite/index.js";
import {
  classifyHostCompatibility,
  createPresetHostAdapter,
  exportMemorySnapshots,
  loadHostMemorySnapshotsIntoStore,
  normalizeHostMemoryKind,
  normalizeHostMemorySensitivity,
  parseHostActualCompatibilityReports,
  parseMemorySnapshotExport,
  requireHostActualCompatibilityReports,
  syncHostMemorySnapshotsIntoStore,
} from "../src/host/index.js";
import {
  createMemoryMcpServer,
  createMemoryMcpStdioServer,
  listMemoryMcpTools,
  PUBLIC_MEMORY_HTTP_ROUTES,
  PUBLIC_MEMORY_MCP_TOOL_NAMES,
} from "../src/mcp/index.js";
import {
  createEvolutionControlPlane,
  renderEvolutionFailureReviewMarkdown,
} from "../src/evolution/index.js";
import {
  createMemoryStatusReport,
  renderMemoryStatusMarkdown,
} from "../src/diagnostics/index.js";
import { createMemoryHttpServer } from "../src/http/index.js";
import {
  classifyPayloadSensitivity,
  classifySensitivity,
  payloadContainsRestrictedValue,
  redactForReport,
  sanitizeEvidenceForPublicOutput,
  sanitizePublicPayload,
} from "../src/kernel/safety.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-sdk-test-"));
const dbPath = path.join(tmp, "test.db");
const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  name: string;
  version: string;
};
function gitOutput(args: string[]): string {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const expectedGit = {
  branch: gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]),
  sha: gitOutput(["rev-parse", "HEAD"]),
  dirty: gitOutput(["status", "--porcelain"]).length > 0,
};
function cloneProfileBackup(
  backup: SqliteProfileBackupDocument,
): SqliteProfileBackupDocument {
  return JSON.parse(JSON.stringify(backup)) as SqliteProfileBackupDocument;
}
function refreshProfileBackupCounts(backup: SqliteProfileBackupDocument): void {
  backup.counts.memories = backup.memories.length;
  backup.counts.evidenceEvents = backup.evidenceEvents.length;
  backup.counts.worldBeliefs = backup.worldBeliefs.length;
  backup.counts.failureEvents = backup.failureEvents.length;
  backup.counts.taskTrajectories = backup.taskTrajectories.length;
}

async function httpJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as Record<string, unknown>,
    text,
  };
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
  text: string;
}> {
  return httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rawHttpRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(response));
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("raw HTTP request timed out"));
    });
  });
}

const store: SqliteMemoryStore = createSqliteMemoryStore({ path: dbPath });
const memory = createMemoryOS({ profileId: "test", store });
await store.initialize();
assert.equal(await store.schemaVersion(), 3);

const legacyDbPath = path.join(tmp, "legacy-no-ledger.db");
const legacyHandle = new Database(legacyDbPath);
legacyHandle.exec(`
  CREATE TABLE legacy_marker(id TEXT PRIMARY KEY);
  INSERT INTO legacy_marker(id) VALUES ('preserved');
  CREATE TABLE gmos_memories (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    content TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'active',
    confidence REAL NOT NULL DEFAULT 0.5,
    source_event_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO gmos_memories (
    id, profile_id, kind, scope, content, sensitivity, status, confidence,
    source_event_id, metadata_json, created_at, updated_at
  ) VALUES (
    'legacy_memory_1', 'legacy_profile', 'preference', 'global',
    'legacy preference row', 'normal', 'active', 0.8,
    NULL, '{}', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z'
  );
`);
const legacyStore = createSqliteMemoryStore({ path: legacyDbPath, handle: legacyHandle });
await legacyStore.initialize();
assert.equal(await legacyStore.schemaVersion(), 3);
assert.equal(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_schema_migrations WHERE version = 1")
      .get() as { count: number }
  ).count,
  1,
);
assert.equal(
  (
    legacyHandle.prepare("SELECT id FROM legacy_marker").get() as { id: string }
  ).id,
  "preserved",
);
assert.equal(
  (
    legacyHandle
      .prepare("SELECT content FROM gmos_memories WHERE id = 'legacy_memory_1'")
      .get() as { content: string }
  ).content,
  "legacy preference row",
);
assert.equal(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_schema_migrations WHERE version = 2")
      .get() as { count: number }
  ).count,
  1,
);
assert.equal(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_memories_fts WHERE id = 'legacy_memory_1'")
      .get() as { count: number }
  ).count,
  1,
);
assert.ok(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_associations WHERE target_id = 'legacy_memory_1'")
      .get() as { count: number }
  ).count > 0,
);
const legacyStoreReopen = createSqliteMemoryStore({ path: legacyDbPath, handle: legacyHandle });
await legacyStoreReopen.initialize();
assert.equal(await legacyStoreReopen.schemaVersion(), 3);
assert.equal(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_memories_fts WHERE id = 'legacy_memory_1'")
      .get() as { count: number }
  ).count,
  1,
);
legacyHandle.close();

const legacyV2DbPath = path.join(tmp, "legacy-v2-association-backfill.db");
const legacyV2Handle = new Database(legacyV2DbPath);
legacyV2Handle.exec(`
  CREATE TABLE gmos_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
  INSERT INTO gmos_schema_migrations(version, name, applied_at)
    VALUES (1, 'baseline', '2026-06-25T00:00:00.000Z');
  INSERT INTO gmos_schema_migrations(version, name, applied_at)
    VALUES (2, 'memory_fts_search', '2026-06-25T00:00:00.000Z');
  CREATE TABLE gmos_memories (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    content TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'active',
    confidence REAL NOT NULL DEFAULT 0.5,
    source_event_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO gmos_memories (
    id, profile_id, kind, scope, content, sensitivity, status, confidence,
    source_event_id, metadata_json, created_at, updated_at
  ) VALUES (
    'legacy_v2_memory_1', 'legacy_v2', 'procedure', 'global',
    'Orchid project next step is to write the migration probe.', 'normal', 'active', 0.8,
    NULL, '{}', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z'
  );
`);
const legacyV2Store = createSqliteMemoryStore({ path: legacyV2DbPath, handle: legacyV2Handle });
await legacyV2Store.initialize();
assert.equal(await legacyV2Store.schemaVersion(), 3);
assert.ok(
  (
    legacyV2Handle
      .prepare("SELECT COUNT(*) AS count FROM gmos_associations WHERE target_id = 'legacy_v2_memory_1'")
      .get() as { count: number }
  ).count > 0,
);
const legacyV2Memory = createMemoryOS({ profileId: "legacy_v2", store: legacyV2Store });
const legacyV2Reconstructed = await legacyV2Memory.reconstructContext({
  profileId: "legacy_v2",
  query: "Orchid next step",
});
assert.match(legacyV2Reconstructed.contextBlock, /migration probe/);
await legacyV2Memory.close();
legacyV2Handle.close();

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "我喜欢直接、简洁的中文回答。",
  createdAt: "2026-06-25T00:00:00.000Z",
});

const prepared = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "你应该怎么回答我？" }],
  includeEvidence: true,
});
assert.match(prepared.contextBlock, /简洁的中文回答/);
assert.equal(prepared.evidence.length, 1);
const sourceMemoryId = prepared.actionPolicies[0]?.sourceMemoryId;
assert.equal(typeof sourceMemoryId, "string");
const explanation = await memory.explain(sourceMemoryId!, "test");
assert.equal(explanation?.kind, "memory");
assert.match(explanation?.text ?? "", /简洁的中文回答/);
assert.equal(explanation?.evidence.length, 1);

const extractorStore = createSqliteMemoryStore({ path: path.join(tmp, "custom-extractor.db") });
const extractorMemory = createMemoryOS({
  profileId: "extractor",
  store: extractorStore,
  extractor: {
    name: "fixture-structured-extractor",
    extract(input) {
      assert.equal(input.profileId, "extractor");
      assert.equal(input.evidence.sourceType, "conversation.message");
      assert.ok(input.ruleCandidates.length >= 1);
      return [
        {
          kind: "preference",
          content: "Custom extractor says the user prefers risk-first plans.",
          confidence: 0.91,
          predicate: "user.preference",
          actionPolicyKind: "prefer",
          metadata: { extractorFixture: "preference" },
        },
        {
          kind: "project",
          content: "Custom extractor says the Helio project is blocked on a migration probe.",
          confidence: 0.88,
          predicate: "project.state",
          subject: "project:helio",
          metadata: { extractorFixture: "project" },
        },
      ];
    },
  },
});
await extractorMemory.observe({
  type: "conversation.message",
  profileId: "extractor",
  role: "user",
  content: "我喜欢先讲风险，而且 Helio 项目卡在 migration probe。",
});
const extractedPreference = await extractorMemory.search({
  profileId: "extractor",
  query: "risk-first plans",
  limit: 5,
});
const extractedProject = await extractorMemory.search({
  profileId: "extractor",
  query: "Helio migration probe",
  limit: 5,
});
assert.equal(extractedPreference.some((entry) => entry.content.includes("risk-first plans")), true);
assert.equal(extractedProject.some((entry) => entry.content.includes("Helio project")), true);
assert.equal(
  extractedProject.some(
    (entry) =>
      entry.metadata.extractionSource === "custom" &&
      entry.metadata.extractorName === "fixture-structured-extractor",
  ),
  true,
);

const suppressRulesStore = createSqliteMemoryStore({ path: path.join(tmp, "suppress-rules.db") });
const suppressRulesMemory = createMemoryOS({
  profileId: "suppress",
  store: suppressRulesStore,
  extractor: () => [],
});
await suppressRulesMemory.observe({
  type: "conversation.message",
  profileId: "suppress",
  role: "user",
  content: "我喜欢这个本来会被规则抽取的偏好。",
});
assert.equal(
  (
    await suppressRulesMemory.search({
      profileId: "suppress",
      query: "规则抽取",
      purpose: "manage",
    })
  ).length,
  0,
);

const fallbackExtractorStore = createSqliteMemoryStore({
  path: path.join(tmp, "fallback-extractor.db"),
});
const fallbackExtractorMemory = createMemoryOS({
  profileId: "fallback_extractor",
  store: fallbackExtractorStore,
  extractor: {
    name: "throwing-extractor",
    extract() {
      throw new Error("fixture extractor unavailable");
    },
  },
});
await fallbackExtractorMemory.observe({
  type: "conversation.message",
  profileId: "fallback_extractor",
  role: "user",
  content: "我喜欢 fallback rule extraction.",
});
const fallbackMatches = await fallbackExtractorMemory.search({
  profileId: "fallback_extractor",
  query: "fallback rule extraction",
});
assert.equal(fallbackMatches.length, 1);
assert.equal(fallbackMatches[0]?.metadata.extractionSource, "rules");
assert.equal(fallbackMatches[0]?.metadata.extractorFallback, true);

const unsafeExtractorStore = createSqliteMemoryStore({
  path: path.join(tmp, "unsafe-extractor.db"),
});
const unsafeExtractorMemory = createMemoryOS({
  profileId: "unsafe_extractor",
  store: unsafeExtractorStore,
  extractor: () => [
    {
      kind: "preference",
      content: "Custom extractor leaked token sk-customextractorsecret1234567890.",
      confidence: 0.99,
      predicate: "user.preference",
    },
    {
      kind: "fact",
      content: "PERSON:Alice: likes private side-channel memory.",
      confidence: 0.99,
      predicate: "user.fact",
    },
    {
      kind: "person",
      content: "A custom extractor should not auto-write person-kind memory.",
      confidence: 0.99,
      predicate: "person.fact",
    },
    {
      kind: "invalid-kind" as never,
      content: "Invalid custom extractor kind should not enter memory storage.",
      confidence: 0.99,
      predicate: "invalid.kind",
    },
  ],
});
await unsafeExtractorMemory.observe({
  type: "conversation.message",
  profileId: "unsafe_extractor",
  role: "user",
  content: "A harmless message should not persist unsafe custom candidates.",
});
assert.equal(
  (
    await unsafeExtractorMemory.search({
      profileId: "unsafe_extractor",
      query: "customextractorsecret side-channel person-kind invalid-kind",
      purpose: "manage",
      includeSensitive: true,
      includePerson: true,
    })
  ).length,
  0,
);
await unsafeExtractorMemory.close();
await fallbackExtractorMemory.close();
await suppressRulesMemory.close();
await extractorMemory.close();

const lowLevelMemory = await memory.add({
  profileId: "test",
  kind: "preference",
  content: "Low-level compatibility prefers concise SDK docs.",
  confidence: 0.8,
  metadata: {
    source: "test",
    token: "sk-lowlevel-metadata-secret123456",
  },
});
assert.equal(lowLevelMemory.kind, "preference");
assert.equal(lowLevelMemory.sensitivity, "normal");
const lowLevelMatches = await memory.search({
  profileId: "test",
  query: "compatibility concise SDK docs",
});
assert.ok(lowLevelMatches.some((entry) => entry.id === lowLevelMemory.id));
const deepHistoryMemory = await memory.add({
  profileId: "fts-history",
  kind: "project",
  content: "Deep history target mentions quasar-lighthouse migration recall.",
  confidence: 0.9,
  createdAt: "2026-01-01T00:00:00.000Z",
});
for (let index = 0; index < 650; index += 1) {
  await memory.add({
    profileId: "fts-history",
    kind: "fact",
    content: `Recent unrelated noise memory ${index} about ordinary topic ${index % 17}.`,
    createdAt: `2026-02-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  });
}
const deepHistoryMatches = await memory.search({
  profileId: "fts-history",
  query: "quasar-lighthouse migration recall",
  limit: 5,
});
assert.equal(deepHistoryMatches.some((entry) => entry.id === deepHistoryMemory.id), true);
await memory.update({
  profileId: "fts-history",
  id: deepHistoryMemory.id,
  content: "Deep history target now mentions nebula-harbor migration recall.",
});
const staleDeepHistoryMatches = await memory.search({
  profileId: "fts-history",
  query: "quasar-lighthouse",
  limit: 5,
});
assert.equal(staleDeepHistoryMatches.some((entry) => entry.id === deepHistoryMemory.id), false);
const updatedDeepHistoryMatches = await memory.search({
  profileId: "fts-history",
  query: "nebula-harbor migration recall",
  limit: 5,
});
assert.equal(updatedDeepHistoryMatches.some((entry) => entry.id === deepHistoryMemory.id), true);
await memory.archive({
  profileId: "fts-history",
  id: deepHistoryMemory.id,
  reason: "fts archive sync test",
});
const archivedDeepHistoryMatches = await memory.search({
  profileId: "fts-history",
  query: "nebula-harbor",
  limit: 5,
});
assert.equal(archivedDeepHistoryMatches.some((entry) => entry.id === deepHistoryMemory.id), false);
await memory.restoreArchived({
  profileId: "fts-history",
  id: deepHistoryMemory.id,
  reason: "fts restore sync test",
});
const restoredDeepHistoryMatches = await memory.search({
  profileId: "fts-history",
  query: "nebula-harbor",
  limit: 5,
});
assert.equal(restoredDeepHistoryMatches.some((entry) => entry.id === deepHistoryMemory.id), true);
const repairDbPath = path.join(tmp, "repair-search-index.db");
const repairStore = createSqliteMemoryStore({ path: repairDbPath });
const repairMemory = createMemoryOS({ profileId: "repair", store: repairStore });
const repairFixture = await repairMemory.add({
  profileId: "repair",
  kind: "preference",
  content: "Repair index fixture prefers resilient recall.",
});
let repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "ok");
assert.equal(repairStatus.totalMemoryCount, 1);
assert.equal(repairStatus.indexedMemoryCount, 1);
const corruptRepairDb = new Database(repairDbPath);
try {
  corruptRepairDb
    .prepare("DELETE FROM gmos_memories_fts WHERE id = ?")
    .run(repairFixture.id);
} finally {
  corruptRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.missingEntryCount, 1);
const repairResult = await repairStore.repairSearchIndex();
assert.equal(repairResult.repaired, true);
assert.equal(repairResult.before.status, "stale");
assert.equal(repairResult.after.status, "ok");
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "ok");
const repairedMatches = await repairMemory.search({
  profileId: "repair",
  query: "resilient recall",
});
assert.equal(repairedMatches.some((entry) => entry.id === repairFixture.id), true);
const duplicateRepairDb = new Database(repairDbPath);
try {
  duplicateRepairDb
    .prepare(
      `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repairFixture.id,
      "repair",
      "preference",
      "global",
      "active",
      "Repair index fixture prefers resilient recall.",
    );
} finally {
  duplicateRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.duplicateEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.status, "ok");
const staleRepairDb = new Database(repairDbPath);
try {
  staleRepairDb.prepare("DELETE FROM gmos_memories_fts WHERE id = ?").run(repairFixture.id);
  staleRepairDb
    .prepare(
      `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repairFixture.id,
      "repair",
      "preference",
      "global",
      "active",
      "stale derived search index content",
    );
} finally {
  staleRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.staleEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.status, "ok");
const nullStaleRepairDb = new Database(repairDbPath);
try {
  nullStaleRepairDb.prepare("DELETE FROM gmos_memories_fts WHERE id = ?").run(repairFixture.id);
  nullStaleRepairDb
    .prepare(
      `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repairFixture.id,
      null,
      "preference",
      "global",
      "active",
      "Repair index fixture prefers resilient recall.",
    );
} finally {
  nullStaleRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.staleEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.status, "ok");
const orphanRepairDb = new Database(repairDbPath);
try {
  orphanRepairDb
    .prepare(
      `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("memory_orphan", "repair", "fact", "global", "active", "orphan fts row");
} finally {
  orphanRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.orphanEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.status, "ok");
await repairMemory.close();
const lowLevelExplanation = await memory.explain(lowLevelMemory.id, "test");
assert.equal(lowLevelExplanation?.evidence[0]?.sourceType, "sdk.low_level_add");
assert.equal(JSON.stringify(lowLevelExplanation).includes("sk-lowlevel-metadata-secret"), false);
const updatedLowLevelMemory = await memory.update({
  profileId: "test",
  id: lowLevelMemory.id,
  content: "Low-level compatibility now prefers risk-first SDK docs.",
  metadata: {
    source: "test-update",
    token: "sk-lowlevel-update-metadata-secret123456",
  },
});
assert.equal(updatedLowLevelMemory?.id, lowLevelMemory.id);
assert.match(updatedLowLevelMemory?.content ?? "", /risk-first SDK docs/);
const updatedLowLevelExplanation = await memory.explain(lowLevelMemory.id, "test");
assert.equal(updatedLowLevelExplanation?.evidence[0]?.sourceType, "sdk.low_level_update");
assert.equal(
  JSON.stringify(updatedLowLevelExplanation).includes("sk-lowlevel-update-metadata-secret"),
  false,
);
const lowLevelBeforeSecretUpdate = await store.rowCounts();
await assert.rejects(
  () =>
    memory.update({
      profileId: "test",
      id: lowLevelMemory.id,
      content: "api key: sk-lowlevelupdatesecret1234567890",
    }),
  /secret-like/,
);
assert.deepEqual(await store.rowCounts(), lowLevelBeforeSecretUpdate);
await assert.rejects(
  () =>
    memory.update({
      profileId: "test",
      id: lowLevelMemory.id,
      content: "PERSON: Alice: Alice prefers tea.",
    }),
  /person memory/,
);
const unsupportedUpdateDbPath = path.join(tmp, "unsupported-update-store.db");
const unsupportedUpdateBase = createSqliteMemoryStore({ path: unsupportedUpdateDbPath });
await unsupportedUpdateBase.initialize();
const unsupportedExisting = await unsupportedUpdateBase.addMemory({
  profileId: "unsupported_update",
  kind: "fact",
  content: "Unsupported update fixture should not gain evidence.",
});
const {
  updateMemory: _droppedUpdateMemory,
  restoreArchivedMemory: _droppedRestoreArchivedMemory,
  listMemories: _droppedListMemories,
  ...unsupportedUpdateStore
} =
  unsupportedUpdateBase as SqliteMemoryStore & {
    updateMemory?: unknown;
    restoreArchivedMemory?: unknown;
    listMemories?: unknown;
  };
const unsupportedUpdateMemory = createMemoryOS({
  profileId: "unsupported_update",
  store: unsupportedUpdateStore as MemoryStore,
});
const unsupportedBeforeCounts = await unsupportedUpdateBase.rowCounts();
await assert.rejects(
  () =>
    unsupportedUpdateMemory.update({
      profileId: "unsupported_update",
      id: unsupportedExisting.id,
      content: "This should not write evidence first.",
    }),
  /does not support low-level update/,
);
assert.deepEqual(await unsupportedUpdateBase.rowCounts(), unsupportedBeforeCounts);
await unsupportedUpdateBase.archiveMemoryById({
  profileId: "unsupported_update",
  id: unsupportedExisting.id,
  reason: "unsupported restore fixture",
});
const unsupportedBeforeRestoreCounts = await unsupportedUpdateBase.rowCounts();
await assert.rejects(
  () =>
    unsupportedUpdateMemory.restoreArchived({
      profileId: "unsupported_update",
      id: unsupportedExisting.id,
      reason: "This should not mutate without store support.",
    }),
  /does not support low-level restore archived memory/,
);
assert.deepEqual(await unsupportedUpdateBase.rowCounts(), unsupportedBeforeRestoreCounts);
const unsupportedActiveListingFixture = await unsupportedUpdateBase.addMemory({
  profileId: "unsupported_update",
  kind: "fact",
  content: "Unsupported fallback active listing fixture.",
});
const unsupportedListDefault = await unsupportedUpdateMemory.list({
  profileId: "unsupported_update",
  query: "active listing fixture",
});
assert.equal(
  unsupportedListDefault.some((entry) => entry.id === unsupportedActiveListingFixture.id),
  true,
);
await assert.rejects(
  () =>
    unsupportedUpdateMemory.list({
      profileId: "unsupported_update",
      status: "archived",
    }),
  /does not support archived memory listing/,
);
await assert.rejects(
  () =>
    unsupportedUpdateMemory.list({
      profileId: "unsupported_update",
      scope: "missing",
    }),
  /does not support filtered memory listing/,
);
await unsupportedUpdateMemory.close();
const archiveResult = await memory.archive({
  profileId: "test",
  id: lowLevelMemory.id,
  reason: "low-level archive test",
});
assert.deepEqual(archiveResult.archivedMemoryIds, [lowLevelMemory.id]);
const archivedLowLevelMatches = await memory.search({
  profileId: "test",
  query: "risk-first SDK docs",
  purpose: "manage",
});
assert.equal(archivedLowLevelMatches.some((entry) => entry.id === lowLevelMemory.id), false);
assert.equal(await memory.explain(lowLevelMemory.id, "test"), null);
const archiveInspectionDb = new Database(dbPath, { readonly: true });
try {
  const archivedRow = archiveInspectionDb
    .prepare("SELECT metadata_json FROM gmos_memories WHERE id = ?")
    .get(lowLevelMemory.id) as { metadata_json: string };
  assert.equal(JSON.parse(archivedRow.metadata_json).archive.reason, "low-level archive test");
} finally {
  archiveInspectionDb.close();
}
const restoreResult = await memory.restoreArchived({
  profileId: "test",
  id: lowLevelMemory.id,
  reason: "legacy compatibility delete rollback",
  restoredAt: "2026-06-25T00:00:01.000Z",
});
assert.deepEqual(restoreResult.restoredMemoryIds, [lowLevelMemory.id]);
const restoredLowLevelMatches = await memory.search({
  profileId: "test",
  query: "risk-first SDK docs",
  purpose: "manage",
});
assert.equal(restoredLowLevelMatches.some((entry) => entry.id === lowLevelMemory.id), true);
assert.notEqual(await memory.explain(lowLevelMemory.id, "test"), null);
const restoreInspectionDb = new Database(dbPath, { readonly: true });
try {
  const restoredRow = restoreInspectionDb
    .prepare("SELECT metadata_json, status FROM gmos_memories WHERE id = ?")
    .get(lowLevelMemory.id) as { metadata_json: string; status: string };
  const restoredMetadata = JSON.parse(restoredRow.metadata_json);
  assert.equal(restoredRow.status, "active");
  assert.equal(restoredMetadata.archive, undefined);
  assert.equal(restoredMetadata.restore.reason, "legacy compatibility delete rollback");
} finally {
  restoreInspectionDb.close();
}
const rearchiveResult = await memory.archive({
  profileId: "test",
  id: lowLevelMemory.id,
  reason: "low-level archive after restore test",
});
assert.deepEqual(rearchiveResult.archivedMemoryIds, [lowLevelMemory.id]);
const defaultManagedList = await memory.list({
  profileId: "test",
  query: "risk-first SDK docs",
});
assert.equal(defaultManagedList.some((entry) => entry.id === lowLevelMemory.id), false);
const archivedManagedList = await memory.list({
  profileId: "test",
  query: "risk-first SDK docs",
  status: "archived",
});
assert.equal(archivedManagedList.length, 1);
assert.equal(archivedManagedList[0]?.id, lowLevelMemory.id);
assert.equal(archivedManagedList[0]?.status, "archived");
assert.equal(await memory.get({ profileId: "test", id: lowLevelMemory.id }), null);
const archivedManagedGet = await memory.get({
  profileId: "test",
  id: lowLevelMemory.id,
  includeArchived: true,
});
assert.equal(archivedManagedGet?.id, lowLevelMemory.id);
assert.equal(archivedManagedGet?.status, "archived");
const clearMemoryA = await memory.add({
  profileId: "test",
  kind: "fact",
  content: "Clear fixture A belongs to conversation conv_clear_sdk.",
  scope: "clear-fixture",
  metadata: { conversationId: "conv_clear_sdk" },
});
const clearMemoryB = await memory.add({
  profileId: "test",
  kind: "fact",
  content: "Clear fixture B belongs to conversation conv_clear_sdk.",
  scope: "clear-fixture",
  metadata: { conversationId: "conv_clear_sdk" },
});
const clearByMetadata = await memory.clear({
  profileId: "test",
  metadataEquals: { key: "conversationId", value: "conv_clear_sdk" },
  reason: "low-level clear metadata test",
});
assert.deepEqual(
  new Set(clearByMetadata.archivedMemoryIds),
  new Set([clearMemoryA.id, clearMemoryB.id]),
);
const clearInspectionDb = new Database(dbPath, { readonly: true });
try {
  const clearRows = clearInspectionDb
    .prepare(
      "SELECT metadata_json FROM gmos_memories WHERE id IN (?, ?) ORDER BY id",
    )
    .all(clearMemoryA.id, clearMemoryB.id) as Array<{ metadata_json: string }>;
  assert.equal(clearRows.length, 2);
  assert.ok(
    clearRows.every(
      (row) => JSON.parse(row.metadata_json).archive.reason === "low-level clear metadata test",
    ),
  );
} finally {
  clearInspectionDb.close();
}
await assert.rejects(
  () =>
    memory.clear({
      profileId: "test",
    }),
  /requires all, scope, or metadataEquals/,
);
const lowLevelBeforeSecret = await store.rowCounts();
await assert.rejects(
  () =>
    memory.add({
      profileId: "test",
      kind: "fact",
      content: "api key: sk-lowlevelsecret1234567890",
    }),
  /secret-like/,
);
assert.deepEqual(await store.rowCounts(), lowLevelBeforeSecret);
const lowLevelSensitive = await memory.add({
  profileId: "test",
  kind: "fact",
  content: "My SSN is 123-45-6789.",
});
const lowLevelSensitiveDefault = await memory.search({
  profileId: "test",
  query: "123-45-6789",
});
assert.equal(lowLevelSensitiveDefault.some((entry) => entry.id === lowLevelSensitive.id), false);
const lowLevelSensitiveIncluded = await memory.search({
  profileId: "test",
  query: "123-45-6789",
  includeSensitive: true,
});
assert.ok(lowLevelSensitiveIncluded.some((entry) => entry.id === lowLevelSensitive.id));
const lowLevelSensitiveManagedDefault = await memory.list({
  profileId: "test",
  query: "123-45-6789",
});
assert.equal(
  lowLevelSensitiveManagedDefault.some((entry) => entry.id === lowLevelSensitive.id),
  false,
);
const lowLevelSensitiveManagedIncluded = await memory.list({
  profileId: "test",
  query: "123-45-6789",
  includeSensitive: true,
});
assert.ok(
  lowLevelSensitiveManagedIncluded.some((entry) => entry.id === lowLevelSensitive.id),
);
assert.equal(await memory.get({ profileId: "test", id: lowLevelSensitive.id }), null);
assert.equal(
  (await memory.get({
    profileId: "test",
    id: lowLevelSensitive.id,
    includeSensitive: true,
  }))?.id,
  lowLevelSensitive.id,
);
await assert.rejects(
  () =>
    memory.add({
      profileId: "test",
      kind: "person",
      content: "Alice prefers tea.",
    }),
  /person memory/,
);
const lowLevelPerson = await memory.add({
  profileId: "test",
  kind: "fact",
  content: "PERSON: Alice: Alice prefers tea.",
  allowPerson: true,
});
assert.equal(lowLevelPerson.kind, "person");
const lowLevelPersonDefault = await memory.search({
  profileId: "test",
  query: "Alice tea",
});
assert.equal(lowLevelPersonDefault.some((entry) => entry.id === lowLevelPerson.id), false);
const lowLevelPersonIncluded = await memory.search({
  profileId: "test",
  query: "Alice tea",
  includePerson: true,
});
assert.ok(lowLevelPersonIncluded.some((entry) => entry.id === lowLevelPerson.id));
const lowLevelPersonManagedDefault = await memory.list({
  profileId: "test",
  query: "Alice tea",
});
assert.equal(
  lowLevelPersonManagedDefault.some((entry) => entry.id === lowLevelPerson.id),
  false,
);
const lowLevelPersonManagedIncluded = await memory.list({
  profileId: "test",
  query: "Alice tea",
  includePerson: true,
});
assert.ok(lowLevelPersonManagedIncluded.some((entry) => entry.id === lowLevelPerson.id));
assert.equal(await memory.get({ profileId: "test", id: lowLevelPerson.id }), null);
assert.equal(
  (await memory.get({
    profileId: "test",
    id: lowLevelPerson.id,
    includePerson: true,
  }))?.id,
  lowLevelPerson.id,
);
const portableMemory = await memory.add({
  profileId: "test",
  kind: "preference",
  content: "Portable snapshot migration fixture prefers explicit exports.",
});
const defaultSnapshotExport = await exportMemorySnapshots({
  memory,
  profileId: "test",
  query: "portable snapshot migration",
});
assert.equal(defaultSnapshotExport.schema, "gmos.memory_snapshot_export.v1");
assert.equal(defaultSnapshotExport.filters.status, "active");
assert.equal(defaultSnapshotExport.filters.includeSensitive, false);
assert.equal(defaultSnapshotExport.filters.includePerson, false);
assert.deepEqual(
  defaultSnapshotExport.memories.map((entry) => entry.id),
  [portableMemory.id],
);
assert.equal(
  JSON.stringify(defaultSnapshotExport).includes("123-45-6789"),
  false,
);
assert.equal(JSON.stringify(defaultSnapshotExport).includes("Alice prefers tea"), false);
const sensitiveSnapshotExport = await exportMemorySnapshots({
  memory,
  profileId: "test",
  query: "123-45-6789",
  includeSensitive: true,
});
assert.deepEqual(
  sensitiveSnapshotExport.memories.map((entry) => entry.id),
  [lowLevelSensitive.id],
);
const personSnapshotExport = await exportMemorySnapshots({
  memory,
  profileId: "test",
  query: "Alice tea",
  includePerson: true,
});
assert.deepEqual(
  personSnapshotExport.memories.map((entry) => entry.id),
  [lowLevelPerson.id],
);
const archivedSnapshotExport = await exportMemorySnapshots({
  memory,
  profileId: "test",
  query: "risk-first SDK docs",
  status: "archived",
});
assert.equal(
  archivedSnapshotExport.memories.some((entry) => entry.id === lowLevelMemory.id),
  true,
);
const parsedSnapshotExport = parseMemorySnapshotExport(
  JSON.parse(JSON.stringify(defaultSnapshotExport)),
);
assert.equal(parsedSnapshotExport.memoryCount, defaultSnapshotExport.memoryCount);
assert.throws(
  () => parseMemorySnapshotExport({ schema: "gmos.unknown", memories: [] }),
  /Unsupported gmOS memory snapshot export schema/,
);
const snapshotExportMissingTimestamp = JSON.parse(
  JSON.stringify(defaultSnapshotExport),
) as Record<string, unknown>;
delete snapshotExportMissingTimestamp.exportedAt;
assert.throws(
  () => parseMemorySnapshotExport(snapshotExportMissingTimestamp),
  /requires exportedAt/,
);
const backupProfileId = "backup_profile";
const backupMemory = await memory.add({
  profileId: backupProfileId,
  kind: "preference",
  content: "Backup profile prefers portable restores.",
  metadata: { backupFixture: "primary" },
});
const backupArchivedMemory = await memory.add({
  profileId: backupProfileId,
  kind: "project",
  content: "Backup archived row should only appear in full backups.",
});
await memory.archive({
  profileId: backupProfileId,
  id: backupArchivedMemory.id,
  reason: "backup fixture archive",
});
const backupSensitiveMemory = await memory.add({
  profileId: backupProfileId,
  kind: "fact",
  content: "Backup sensitive fixture uses SSN 123-45-6789.",
  sensitivity: "sensitive",
});
const backupPersonMemory = await memory.add({
  profileId: backupProfileId,
  kind: "person",
  content: "PERSON: Bob: Backup person fixture prefers tea.",
  allowPerson: true,
});
const backupBelief = await store.addWorldBelief({
  profileId: backupProfileId,
  subject: "user",
  predicate: "prefers",
  object: "portable restores",
  sourceMemoryId: backupMemory.id,
});
await store.addWorldBelief({
  profileId: backupProfileId,
  subject: "user",
  predicate: "stores",
  object: "sensitive fixture",
  sourceMemoryId: backupSensitiveMemory.id,
});
await store.addWorldBelief({
  profileId: backupProfileId,
  subject: "user",
  predicate: "mentioned",
  object: "SSN 123-45-6789 in a source-less belief",
});
const sensitiveEvidenceForNormalMemory = await store.recordEvidence({
  profileId: backupProfileId,
  eventKey: "backup_sensitive_evidence_for_normal_memory",
  sourceType: "test",
  content: "Sensitive evidence says SSN 123-45-6789.",
  sensitivity: "sensitive",
  eligibleForLongTermMemory: true,
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "Normal memory linked to evidence that is not safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
  sourceEventId: sensitiveEvidenceForNormalMemory.id,
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "Normal memory with sensitive metadata should not be safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
  metadata: { ssn: "123-45-6789" },
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "Normal memory with sessionid metadata should not be safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
  metadata: { sessionid: "abcdefghijkl" },
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "Normal memory with dotted session metadata should not be safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
  metadata: { "session.id": "abcdefghijkl" },
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "Normal memory with space credential metadata should not be safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
  metadata: { "credential id": "abcdefghijkl" },
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "Normal memory with camel credential metadata should not be safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
  metadata: { sessionToken: "abcdefghijkl", clientSecret: "abcdefghijkl" },
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "Normal memory with plural credential metadata should not be safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
  metadata: { credentials: "abcdefghijkl", cookies: "abcdefghijkl" },
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  content: "{\"sessionid\":\"abcdefghijkl\"}",
  sensitivity: "normal",
  confidence: 0.8,
});
await store.addMemory({
  profileId: backupProfileId,
  kind: "fact",
  scope: "SSN 123-45-6789",
  content: "Normal memory with sensitive scope should not be safe to export.",
  sensitivity: "normal",
  confidence: 0.8,
});
const normalEvidenceWithSensitivePayload = await store.recordEvidence({
  profileId: backupProfileId,
  eventKey: "backup_normal_evidence_sensitive_payload",
  sourceType: "test",
  content: "Normal evidence with sensitive payload should not be safe to export.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: { authorization: "Bearer backup-sensitive-token" },
});
await store.recordEvidence({
  profileId: backupProfileId,
  eventKey: "backup sensitive event key 123-45-6789",
  sourceType: "test",
  sourceUri: "conversation://safe",
  content: "Normal evidence with sensitive event key should not be safe to export.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
});
await store.recordEvidence({
  profileId: backupProfileId,
  eventKey: "backup_normal_event_sensitive_source_uri",
  sourceType: "test",
  sourceUri: "conversation://SSN 123-45-6789",
  content: "Normal evidence with sensitive source URI should not be safe to export.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
});
await memory.recordFeedback({
  profileId: backupProfileId,
  content: "Backup profile wrong recall fixture.",
  failureKind: "wrong_recall",
});
await store.recordFailure({
  profileId: backupProfileId,
  content: "Backup sensitive failure mentions SSN 123-45-6789.",
  failureKind: "privacy_leak",
});
await store.recordFailure({
  profileId: backupProfileId,
  content: "Backup normal failure with sensitive metadata should not be safe to export.",
  failureKind: "privacy_leak",
  metadata: { authorization: "Bearer backup-sensitive-failure-token" },
});
await memory.commitOutcome({
  profileId: backupProfileId,
  taskId: "backup-task-1",
  objective: "Backup profile task trajectory fixture.",
  status: "completed",
  summary: "Backup task restored successfully.",
});
await memory.commitOutcome({
  profileId: backupProfileId,
  taskId: "backup-task-sensitive",
  objective: "Backup sensitive task mentions SSN 123-45-6789.",
  status: "failed",
  summary: "Sensitive task should not export when includeSensitive=false.",
});
await memory.commitOutcome({
  profileId: backupProfileId,
  taskId: "task 123-45-6789",
  objective: "Backup task with sensitive task id should not export when includeSensitive=false.",
  status: "completed",
  summary: "Task id carries the sensitive value.",
});
const safeProfileBackup = store.exportProfileBackup({ profileId: backupProfileId });
assert.equal(safeProfileBackup.schema, "gmos.profile_backup.v1");
assert.equal(safeProfileBackup.mode, "safe");
assert.equal(safeProfileBackup.options.includeSensitive, false);
assert.equal(safeProfileBackup.options.includePerson, false);
assert.equal(safeProfileBackup.options.includeArchived, false);
assert.equal(safeProfileBackup.memories.some((entry) => entry.id === backupMemory.id), true);
assert.equal(
  safeProfileBackup.memories.some((entry) => entry.id === backupArchivedMemory.id),
  false,
);
assert.equal(
  safeProfileBackup.memories.some((entry) => entry.id === backupSensitiveMemory.id),
  false,
);
assert.equal(
  safeProfileBackup.memories.some((entry) => entry.id === backupPersonMemory.id),
  false,
);
assert.equal(JSON.stringify(safeProfileBackup).includes("123-45-6789"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("Bearer backup-sensitive-token"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("sessionid"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("session.id"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("credential id"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("sessionToken"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("clientSecret"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("credentials"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("cookies"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("abcdefghijkl"), false);
assert.equal(JSON.stringify(safeProfileBackup).includes("Backup person fixture"), false);
assert.equal(
  safeProfileBackup.memories
    .filter((entry) => entry.content.includes("Normal memory linked to evidence"))
    .every((entry) => entry.sourceEventId === null),
  true,
);
assert.equal(safeProfileBackup.failureEvents.length, 0);
assert.equal(safeProfileBackup.taskTrajectories.length, 0);
assert.equal(parseSqliteProfileBackup(safeProfileBackup).memories.length, safeProfileBackup.memories.length);
const forgedSafeOrphanEvidenceBackup = cloneProfileBackup(safeProfileBackup);
forgedSafeOrphanEvidenceBackup.evidenceEvents.push({
  id: "evidence_forged_safe_orphan",
  eventKey: "evidence_forged_safe_orphan",
  profileId: backupProfileId,
  sourceType: "test",
  sourceUri: null,
  content: "Safe-looking orphan evidence should not be accepted in safe backups.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: {},
  createdAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedSafeOrphanEvidenceBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedSafeOrphanEvidenceBackup),
  /evidenceEvents\[\d+\]\.id/,
);
const fullProfileBackup = store.exportProfileBackup({ profileId: backupProfileId, mode: "full" });
assert.equal(fullProfileBackup.mode, "full");
assert.equal(fullProfileBackup.options.includeSensitive, true);
assert.equal(fullProfileBackup.options.includePerson, true);
assert.equal(fullProfileBackup.options.includeArchived, true);
for (const expectedId of [
  backupMemory.id,
  backupArchivedMemory.id,
  backupSensitiveMemory.id,
  backupPersonMemory.id,
]) {
  assert.equal(fullProfileBackup.memories.some((entry) => entry.id === expectedId), true);
}
assert.equal(fullProfileBackup.worldBeliefs.some((entry) => entry.id === backupBelief.id), true);
assert.equal(fullProfileBackup.failureEvents.length, 4);
assert.equal(fullProfileBackup.taskTrajectories.length, 3);
assert.equal(
  fullProfileBackup.evidenceEvents.some(
    (entry) => entry.id === normalEvidenceWithSensitivePayload.id,
  ),
  true,
);
assert.equal(
  fullProfileBackup.memories.find((entry) =>
    entry.content.includes("Normal memory with camel credential metadata"),
  )?.sensitivity,
  "secret_like",
);
assert.equal(
  fullProfileBackup.memories.find((entry) => entry.content.includes("\"sessionid\""))?.sensitivity,
  "secret_like",
);
assert.equal(
  fullProfileBackup.evidenceEvents.find((entry) => entry.id === normalEvidenceWithSensitivePayload.id)
    ?.sensitivity,
  "secret_like",
);
const parsedProfileBackup = parseSqliteProfileBackup(JSON.parse(JSON.stringify(fullProfileBackup)));
assert.equal(parsedProfileBackup.counts.memories, fullProfileBackup.counts.memories);
const forgedFullDowngradedMemoryBackup = cloneProfileBackup(fullProfileBackup);
forgedFullDowngradedMemoryBackup.memories.push({
  id: "memory_forged_full_downgraded_secret",
  profileId: backupProfileId,
  kind: "fact",
  scope: "global",
  content: "password=\"correct horse battery staple\"",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: {},
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedFullDowngradedMemoryBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedFullDowngradedMemoryBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedFullAliasDowngradedMemoryBackup = cloneProfileBackup(fullProfileBackup);
forgedFullAliasDowngradedMemoryBackup.memories.push({
  id: "memory_forged_full_alias_downgraded_secret",
  profileId: backupProfileId,
  kind: "fact",
  scope: "global",
  content: "clientSecret=abcdefghijkl",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: {},
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedFullAliasDowngradedMemoryBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedFullAliasDowngradedMemoryBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedFullDowngradedEvidenceBackup = cloneProfileBackup(fullProfileBackup);
forgedFullDowngradedEvidenceBackup.evidenceEvents.push({
  id: "evidence_forged_full_downgraded_secret",
  eventKey: "evidence_forged_full_downgraded_secret",
  profileId: backupProfileId,
  sourceType: "test",
  sourceUri: "conversation://fixture?sessionToken=abcdefghijkl",
  content: "Normal-looking evidence with secret metadata.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: { credentials: "abcdefghijkl" },
  createdAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedFullDowngradedEvidenceBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedFullDowngradedEvidenceBackup),
  /evidenceEvents\[\d+\]\.sensitivity/,
);
const forgedFullAliasDowngradedEvidenceBackup = cloneProfileBackup(fullProfileBackup);
forgedFullAliasDowngradedEvidenceBackup.evidenceEvents.push({
  id: "evidence_forged_full_alias_downgraded_secret",
  eventKey: "evidence_forged_full_alias_downgraded_secret",
  profileId: backupProfileId,
  sourceType: "test",
  sourceUri: "conversation://fixture?idToken=abcdefghijkl",
  content: "Normal-looking evidence with alias token in sourceUri.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: {},
  createdAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedFullAliasDowngradedEvidenceBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedFullAliasDowngradedEvidenceBackup),
  /evidenceEvents\[\d+\]\.sensitivity/,
);
assert.throws(
  () => parseSqliteProfileBackup({ schema: "gmos.unknown", memories: [] }),
  /gmos.profile_backup.v1/,
);
const noEvidenceFullBackup = store.exportProfileBackup({
  profileId: backupProfileId,
  mode: "full",
  includeEvidence: false,
});
assert.equal(noEvidenceFullBackup.evidenceEvents.length, 0);
assert.equal(parseSqliteProfileBackup(noEvidenceFullBackup).evidenceEvents.length, 0);
const forgedNoEvidenceSourceBackup = cloneProfileBackup(noEvidenceFullBackup);
forgedNoEvidenceSourceBackup.memories[0].sourceEventId = "forged_evidence_reference";
assert.throws(
  () => parseSqliteProfileBackup(forgedNoEvidenceSourceBackup),
  /memories\[0\]\.sourceEventId/,
);
const safeBeliefBackup = store.exportProfileBackup({
  profileId: backupProfileId,
  mode: "safe",
  includeWorldBeliefs: true,
});
assert.equal(safeBeliefBackup.worldBeliefs.some((entry) => entry.id === backupBelief.id), true);
assert.equal(
  safeBeliefBackup.worldBeliefs.some((entry) => entry.object === "sensitive fixture"),
  false,
);
assert.equal(parseSqliteProfileBackup(safeBeliefBackup).worldBeliefs.length, 1);
const filteredFullBackup = store.exportProfileBackup({
  profileId: backupProfileId,
  mode: "full",
  includeSensitive: false,
  includeArchived: false,
  includePerson: false,
  includeWorldBeliefs: true,
});
assert.equal(
  filteredFullBackup.memories.some((entry) => entry.id === backupSensitiveMemory.id),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) => entry.id === backupArchivedMemory.id),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) => entry.id === backupPersonMemory.id),
  false,
);
assert.equal(
  filteredFullBackup.evidenceEvents.every((entry) => entry.sensitivity === "normal"),
  true,
);
assert.equal(
  filteredFullBackup.evidenceEvents.some(
    (entry) => entry.id === normalEvidenceWithSensitivePayload.id,
  ),
  false,
);
assert.equal(JSON.stringify(filteredFullBackup).includes("Bearer backup-sensitive-token"), false);
assert.equal(
  filteredFullBackup.memories.some((entry) =>
    entry.content.includes("Normal memory with sensitive metadata"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) =>
    entry.content.includes("Normal memory with sessionid metadata"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) =>
    entry.content.includes("Normal memory with dotted session metadata"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) =>
    entry.content.includes("Normal memory with space credential metadata"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) =>
    entry.content.includes("Normal memory with camel credential metadata"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) =>
    entry.content.includes("Normal memory with plural credential metadata"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) => entry.content.includes("\"sessionid\"")),
  false,
);
assert.equal(
  filteredFullBackup.memories.some((entry) =>
    entry.content.includes("Normal memory with sensitive scope"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.evidenceEvents.some((entry) =>
    entry.content.includes("sensitive event key"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.evidenceEvents.some((entry) =>
    entry.content.includes("sensitive source URI"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.memories
    .filter((entry) => entry.content.includes("Normal memory linked to evidence"))
    .every((entry) => entry.sourceEventId === null),
  true,
);
assert.equal(
  filteredFullBackup.worldBeliefs.some((entry) => entry.object === "sensitive fixture"),
  false,
);
assert.equal(
  filteredFullBackup.worldBeliefs.some((entry) => entry.object.includes("123-45-6789")),
  false,
);
assert.equal(
  filteredFullBackup.failureEvents.some((entry) => entry.content.includes("123-45-6789")),
  false,
);
assert.equal(
  JSON.stringify(filteredFullBackup.failureEvents).includes("Bearer backup-sensitive-failure-token"),
  false,
);
assert.equal(
  filteredFullBackup.taskTrajectories.some((entry) =>
    `${entry.objective}\n${entry.summary ?? ""}`.includes("123-45-6789"),
  ),
  false,
);
assert.equal(
  filteredFullBackup.taskTrajectories.some((entry) => entry.taskId?.includes("123-45-6789")),
  false,
);
parseSqliteProfileBackup(filteredFullBackup);
assert.throws(
  () => store.exportProfileBackup({ profileId: "profile SSN 123-45-6789" }),
  /profileId requires includeSensitive=true/,
);
const sensitiveProfileFullBackup = store.exportProfileBackup({
  profileId: "profile SSN 123-45-6789",
  mode: "full",
});
assert.equal(sensitiveProfileFullBackup.profileId, "profile SSN 123-45-6789");
const malformedCountBackup = cloneProfileBackup(fullProfileBackup);
malformedCountBackup.counts.memories += 1;
assert.throws(
  () => parseSqliteProfileBackup(malformedCountBackup),
  /counts\.memories/,
);
const contradictoryEvidenceBackup = cloneProfileBackup(fullProfileBackup);
contradictoryEvidenceBackup.options.includeEvidence = false;
assert.throws(
  () => parseSqliteProfileBackup(contradictoryEvidenceBackup),
  /options\.includeEvidence/,
);
const contradictoryWorldBeliefBackup = cloneProfileBackup(fullProfileBackup);
contradictoryWorldBeliefBackup.options.includeWorldBeliefs = false;
assert.throws(
  () => parseSqliteProfileBackup(contradictoryWorldBeliefBackup),
  /options\.includeWorldBeliefs/,
);
const contradictoryFailureBackup = cloneProfileBackup(fullProfileBackup);
contradictoryFailureBackup.options.includeFailures = false;
assert.throws(
  () => parseSqliteProfileBackup(contradictoryFailureBackup),
  /options\.includeFailures/,
);
const contradictoryTrajectoryBackup = cloneProfileBackup(fullProfileBackup);
contradictoryTrajectoryBackup.options.includeTaskTrajectories = false;
assert.throws(
  () => parseSqliteProfileBackup(contradictoryTrajectoryBackup),
  /options\.includeTaskTrajectories/,
);
const contradictorySensitiveBackup = cloneProfileBackup(fullProfileBackup);
contradictorySensitiveBackup.options.includeSensitive = false;
assert.throws(
  () => parseSqliteProfileBackup(contradictorySensitiveBackup),
  /includeSensitive|sensitivity|metadata/,
);
const forgedSensitiveProfileBackup = cloneProfileBackup(filteredFullBackup);
forgedSensitiveProfileBackup.profileId = "profile SSN 123-45-6789";
for (const memoryRecord of forgedSensitiveProfileBackup.memories) {
  memoryRecord.profileId = forgedSensitiveProfileBackup.profileId;
}
for (const eventRecord of forgedSensitiveProfileBackup.evidenceEvents) {
  eventRecord.profileId = forgedSensitiveProfileBackup.profileId;
}
for (const beliefRecord of forgedSensitiveProfileBackup.worldBeliefs) {
  beliefRecord.profileId = forgedSensitiveProfileBackup.profileId;
}
for (const failureRecord of forgedSensitiveProfileBackup.failureEvents) {
  failureRecord.profileId = forgedSensitiveProfileBackup.profileId;
}
for (const trajectoryRecord of forgedSensitiveProfileBackup.taskTrajectories) {
  trajectoryRecord.profileId = forgedSensitiveProfileBackup.profileId;
}
assert.throws(
  () => parseSqliteProfileBackup(forgedSensitiveProfileBackup),
  /profileId|sensitivity/,
);
const forgedNormalSensitiveMemoryBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSensitiveMemoryBackup.memories.push({
  id: "memory_forged_sensitive_content",
  profileId: backupProfileId,
  kind: "fact",
  scope: "global",
  content: "Forged normal memory contains SSN 123-45-6789.",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: {},
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSensitiveMemoryBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSensitiveMemoryBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedNormalSensitiveMemoryMetadataBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSensitiveMemoryMetadataBackup.memories.push({
  id: "memory_forged_sensitive_metadata",
  profileId: backupProfileId,
  kind: "fact",
  scope: "global",
  content: "Forged normal memory contains sensitive metadata only.",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: { ssn: "123-45-6789" },
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSensitiveMemoryMetadataBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSensitiveMemoryMetadataBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedNormalSessionIdMemoryMetadataBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSessionIdMemoryMetadataBackup.memories.push({
  id: "memory_forged_sessionid_metadata",
  profileId: backupProfileId,
  kind: "fact",
  scope: "global",
  content: "Forged normal memory contains sessionid metadata only.",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: { sessionid: "abcdefghijkl" },
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSessionIdMemoryMetadataBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSessionIdMemoryMetadataBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedNormalDottedSessionMemoryMetadataBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalDottedSessionMemoryMetadataBackup.memories.push({
  id: "memory_forged_dotted_session_metadata",
  profileId: backupProfileId,
  kind: "fact",
  scope: "global",
  content: "Forged normal memory contains dotted session metadata only.",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: { "session.id": "abcdefghijkl" },
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalDottedSessionMemoryMetadataBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalDottedSessionMemoryMetadataBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedNormalJsonCredentialMemoryBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalJsonCredentialMemoryBackup.memories.push({
  id: "memory_forged_json_credential",
  profileId: backupProfileId,
  kind: "fact",
  scope: "global",
  content: "{\"sessionid\":\"abcdefghijkl\"}",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: {},
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalJsonCredentialMemoryBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalJsonCredentialMemoryBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedNormalSensitiveMemoryScopeBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSensitiveMemoryScopeBackup.memories.push({
  id: "memory_forged_sensitive_scope",
  profileId: backupProfileId,
  kind: "fact",
  scope: "SSN 123-45-6789",
  content: "Forged normal memory contains sensitive scope only.",
  sensitivity: "normal",
  status: "active",
  confidence: 0.8,
  sourceEventId: null,
  metadata: {},
  createdAt: "2026-06-25T00:00:00.000Z",
  updatedAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSensitiveMemoryScopeBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSensitiveMemoryScopeBackup),
  /memories\[\d+\]\.sensitivity/,
);
const forgedNormalSensitiveEvidenceBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSensitiveEvidenceBackup.evidenceEvents.push({
  id: "evidence_forged_sensitive_content",
  eventKey: "evidence_forged_sensitive_content",
  profileId: backupProfileId,
  sourceType: "test",
  sourceUri: null,
  content: "Forged normal evidence contains SSN 123-45-6789.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: {},
  createdAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSensitiveEvidenceBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSensitiveEvidenceBackup),
  /evidenceEvents\[\d+\]\.sensitivity/,
);
const forgedNormalSensitiveEvidencePayloadBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSensitiveEvidencePayloadBackup.evidenceEvents.push({
  id: "evidence_forged_sensitive_payload",
  eventKey: "evidence_forged_sensitive_payload",
  profileId: backupProfileId,
  sourceType: "test",
  sourceUri: null,
  content: "Forged normal evidence contains sensitive payload only.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: { authorization: "Bearer forged-sensitive-token" },
  createdAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSensitiveEvidencePayloadBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSensitiveEvidencePayloadBackup),
  /evidenceEvents\[\d+\]\.sensitivity/,
);
const forgedNormalSensitiveEvidenceEventKeyBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSensitiveEvidenceEventKeyBackup.evidenceEvents.push({
  id: "evidence_forged_sensitive_event_key",
  eventKey: "event key 123-45-6789",
  profileId: backupProfileId,
  sourceType: "test",
  sourceUri: null,
  content: "Forged normal evidence contains sensitive event key only.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: {},
  createdAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSensitiveEvidenceEventKeyBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSensitiveEvidenceEventKeyBackup),
  /evidenceEvents\[\d+\]\.sensitivity/,
);
const forgedNormalSensitiveEvidenceSourceUriBackup = cloneProfileBackup(filteredFullBackup);
forgedNormalSensitiveEvidenceSourceUriBackup.evidenceEvents.push({
  id: "evidence_forged_sensitive_source_uri",
  eventKey: "evidence_forged_sensitive_source_uri",
  profileId: backupProfileId,
  sourceType: "test",
  sourceUri: "conversation://SSN 123-45-6789",
  content: "Forged normal evidence contains sensitive source URI only.",
  sensitivity: "normal",
  eligibleForLongTermMemory: true,
  payload: {},
  createdAt: "2026-06-25T00:00:00.000Z",
});
refreshProfileBackupCounts(forgedNormalSensitiveEvidenceSourceUriBackup);
assert.throws(
  () => parseSqliteProfileBackup(forgedNormalSensitiveEvidenceSourceUriBackup),
  /evidenceEvents\[\d+\]\.sensitivity/,
);
const contradictoryWorldBeliefSensitiveContentBackup = cloneProfileBackup(filteredFullBackup);
contradictoryWorldBeliefSensitiveContentBackup.worldBeliefs = [
  {
    id: "belief_sensitive_content_fixture",
    profileId: backupProfileId,
    subject: "user",
    predicate: "mentioned",
    object: "SSN 123-45-6789",
    confidence: 0.8,
    status: "active",
    sourceMemoryId: null,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
  },
];
contradictoryWorldBeliefSensitiveContentBackup.failureEvents = [];
contradictoryWorldBeliefSensitiveContentBackup.taskTrajectories = [];
refreshProfileBackupCounts(contradictoryWorldBeliefSensitiveContentBackup);
assert.throws(
  () => parseSqliteProfileBackup(contradictoryWorldBeliefSensitiveContentBackup),
  /worldBeliefs\[0\]/,
);
const contradictoryFailureSensitiveContentBackup = cloneProfileBackup(
  contradictoryWorldBeliefSensitiveContentBackup,
);
contradictoryFailureSensitiveContentBackup.worldBeliefs = [];
contradictoryFailureSensitiveContentBackup.failureEvents = [
  {
    id: "failure_sensitive_content_fixture",
    profileId: backupProfileId,
    failureKind: "privacy_leak",
    content: "SSN 123-45-6789",
    metadata: {},
    createdAt: "2026-06-25T00:00:00.000Z",
  },
];
refreshProfileBackupCounts(contradictoryFailureSensitiveContentBackup);
assert.throws(
  () => parseSqliteProfileBackup(contradictoryFailureSensitiveContentBackup),
  /failureEvents\[0\]\.content/,
);
const contradictoryFailureSensitiveMetadataBackup = cloneProfileBackup(
  contradictoryWorldBeliefSensitiveContentBackup,
);
contradictoryFailureSensitiveMetadataBackup.worldBeliefs = [];
contradictoryFailureSensitiveMetadataBackup.failureEvents = [
  {
    id: "failure_sensitive_metadata_fixture",
    profileId: backupProfileId,
    failureKind: "privacy_leak",
    content: "Normal failure content with sensitive metadata only.",
    metadata: { authorization: "Bearer forged-sensitive-failure-token" },
    createdAt: "2026-06-25T00:00:00.000Z",
  },
];
refreshProfileBackupCounts(contradictoryFailureSensitiveMetadataBackup);
assert.throws(
  () => parseSqliteProfileBackup(contradictoryFailureSensitiveMetadataBackup),
  /failureEvents\[0\]\.content/,
);
const contradictoryFailureSensitiveIdBackup = cloneProfileBackup(
  contradictoryWorldBeliefSensitiveContentBackup,
);
contradictoryFailureSensitiveIdBackup.worldBeliefs = [];
contradictoryFailureSensitiveIdBackup.failureEvents = [
  {
    id: "failure 123-45-6789",
    profileId: backupProfileId,
    failureKind: "privacy_leak",
    content: "Normal failure content with sensitive id only.",
    metadata: {},
    createdAt: "2026-06-25T00:00:00.000Z",
  },
];
refreshProfileBackupCounts(contradictoryFailureSensitiveIdBackup);
assert.throws(
  () => parseSqliteProfileBackup(contradictoryFailureSensitiveIdBackup),
  /failureEvents\[0\]\.content/,
);
const contradictoryTaskSensitiveContentBackup = cloneProfileBackup(
  contradictoryWorldBeliefSensitiveContentBackup,
);
contradictoryTaskSensitiveContentBackup.worldBeliefs = [];
contradictoryTaskSensitiveContentBackup.taskTrajectories = [
  {
    id: "trajectory_sensitive_content_fixture",
    profileId: backupProfileId,
    taskId: "sensitive-task",
    objective: "SSN 123-45-6789",
    status: "failed",
    summary: "sensitive",
    createdAt: "2026-06-25T00:00:00.000Z",
  },
];
refreshProfileBackupCounts(contradictoryTaskSensitiveContentBackup);
assert.throws(
  () => parseSqliteProfileBackup(contradictoryTaskSensitiveContentBackup),
  /taskTrajectories\[0\]/,
);
const contradictoryTaskSensitiveIdBackup = cloneProfileBackup(
  contradictoryWorldBeliefSensitiveContentBackup,
);
contradictoryTaskSensitiveIdBackup.worldBeliefs = [];
contradictoryTaskSensitiveIdBackup.taskTrajectories = [
  {
    id: "trajectory_sensitive_task_id_fixture",
    profileId: backupProfileId,
    taskId: "task 123-45-6789",
    objective: "Normal objective with sensitive task id.",
    status: "completed",
    summary: "normal summary",
    createdAt: "2026-06-25T00:00:00.000Z",
  },
];
refreshProfileBackupCounts(contradictoryTaskSensitiveIdBackup);
assert.throws(
  () => parseSqliteProfileBackup(contradictoryTaskSensitiveIdBackup),
  /taskTrajectories\[0\]/,
);
const contradictoryPersonBackup = cloneProfileBackup(fullProfileBackup);
contradictoryPersonBackup.options.includePerson = false;
assert.throws(
  () => parseSqliteProfileBackup(contradictoryPersonBackup),
  /includePerson/,
);
const contradictoryArchivedBackup = cloneProfileBackup(fullProfileBackup);
contradictoryArchivedBackup.options.includeArchived = false;
assert.throws(
  () => parseSqliteProfileBackup(contradictoryArchivedBackup),
  /includeArchived/,
);
const malformedKindBackup = cloneProfileBackup(fullProfileBackup);
malformedKindBackup.memories[0].kind = "note";
assert.throws(
  () => parseSqliteProfileBackup(malformedKindBackup),
  /memories\[0\]\.kind/,
);
const malformedProfileBackup = cloneProfileBackup(fullProfileBackup);
malformedProfileBackup.memories[0].profileId = "other_profile";
assert.throws(
  () => parseSqliteProfileBackup(malformedProfileBackup),
  /memories\[0\]\.profileId/,
);
const malformedSourceEventBackup = cloneProfileBackup(fullProfileBackup);
malformedSourceEventBackup.memories[0].sourceEventId = "missing_evidence_event";
assert.throws(
  () => parseSqliteProfileBackup(malformedSourceEventBackup),
  /memories\[0\]\.sourceEventId/,
);
const malformedBeliefSourceBackup = cloneProfileBackup(fullProfileBackup);
malformedBeliefSourceBackup.worldBeliefs[0].sourceMemoryId = "missing_memory";
assert.throws(
  () => parseSqliteProfileBackup(malformedBeliefSourceBackup),
  /worldBeliefs\[0\]\.sourceMemoryId/,
);
const duplicateMemoryIdBackup = cloneProfileBackup(fullProfileBackup);
duplicateMemoryIdBackup.memories[1].id = duplicateMemoryIdBackup.memories[0].id;
assert.throws(
  () => parseSqliteProfileBackup(duplicateMemoryIdBackup),
  /memories\.id/,
);
const malformedFailureBackup = cloneProfileBackup(fullProfileBackup);
malformedFailureBackup.failureEvents[0].failureKind = "bad_failure";
assert.throws(
  () => parseSqliteProfileBackup(malformedFailureBackup),
  /failureEvents\[0\]\.failureKind/,
);
const malformedTrajectoryBackup = cloneProfileBackup(fullProfileBackup);
malformedTrajectoryBackup.taskTrajectories[0].status = "pending";
assert.throws(
  () => parseSqliteProfileBackup(malformedTrajectoryBackup),
  /taskTrajectories\[0\]\.status/,
);
const malformedPayloadBackup = cloneProfileBackup(fullProfileBackup);
malformedPayloadBackup.evidenceEvents[0].payload = [];
assert.throws(
  () => parseSqliteProfileBackup(malformedPayloadBackup),
  /evidenceEvents\[0\]\.payload/,
);
const sameDbOverrideRestore = store.restoreProfileBackup({
  backup: parsedProfileBackup,
  profileId: "backup_profile_same_db",
});
assert.equal(sameDbOverrideRestore.inserted.memories, fullProfileBackup.counts.memories);
const sourceProfileAfterSameDbRestore = await memory.search({
  profileId: backupProfileId,
  query: "portable restores",
});
assert.equal(sourceProfileAfterSameDbRestore.some((entry) => entry.id === backupMemory.id), true);
const sameDbTargetMatches = await memory.search({
  profileId: "backup_profile_same_db",
  query: "portable restores",
});
assert.equal(sameDbTargetMatches.some((entry) => entry.content.includes("portable restores")), true);
assert.equal(sameDbTargetMatches.some((entry) => entry.id === backupMemory.id), false);
const sameDbRepeatedRestore = store.restoreProfileBackup({
  backup: parsedProfileBackup,
  profileId: "backup_profile_same_db",
});
assert.equal(sameDbRepeatedRestore.inserted.memories, 0);
assert.equal(sameDbRepeatedRestore.skipped.memories, fullProfileBackup.counts.memories);
const sameDbReplaceRestore = store.restoreProfileBackup({
  backup: parsedProfileBackup,
  profileId: "backup_profile_same_db",
  onConflict: "replace",
});
assert.equal(sameDbReplaceRestore.inserted.memories, fullProfileBackup.counts.memories);
const sourceProfileAfterSameDbReplace = await memory.search({
  profileId: backupProfileId,
  query: "portable restores",
});
assert.equal(sourceProfileAfterSameDbReplace.some((entry) => entry.id === backupMemory.id), true);
const restoreStore = createSqliteMemoryStore({
  path: path.join(tmp, "profile-restore.db"),
});
await restoreStore.initialize();
const restoreReport = restoreStore.restoreProfileBackup({
  backup: parsedProfileBackup,
  profileId: "backup_profile_restored",
});
assert.equal(restoreReport.sourceProfileId, backupProfileId);
assert.equal(restoreReport.targetProfileId, "backup_profile_restored");
assert.equal(restoreReport.inserted.memories, fullProfileBackup.counts.memories);
assert.equal(restoreReport.inserted.evidenceEvents, fullProfileBackup.counts.evidenceEvents);
assert.equal(restoreReport.inserted.worldBeliefs, fullProfileBackup.counts.worldBeliefs);
assert.equal(restoreReport.inserted.failureEvents, fullProfileBackup.counts.failureEvents);
assert.equal(restoreReport.inserted.taskTrajectories, fullProfileBackup.counts.taskTrajectories);
const restoredMemory = createMemoryOS({
  profileId: "backup_profile_restored",
  store: restoreStore,
});
const restoredBackupMatches = await restoredMemory.search({
  profileId: "backup_profile_restored",
  query: "portable restores",
});
assert.equal(restoredBackupMatches.some((entry) => entry.content.includes("portable restores")), true);
assert.equal(restoredBackupMatches.some((entry) => entry.id === backupMemory.id), false);
const restoredReconstruction = await restoredMemory.reconstructContext({
  profileId: "backup_profile_restored",
  query: "portable restores",
  maxSteps: 3,
});
assert.match(restoredReconstruction.contextBlock, /portable restores/);
assert.ok((await restoreStore.rowCounts()).gmos_associations > 0);
const restoredSensitiveDefault = await restoredMemory.search({
  profileId: "backup_profile_restored",
  query: "123-45-6789",
});
assert.equal(
  restoredSensitiveDefault.some((entry) => entry.id === backupSensitiveMemory.id),
  false,
);
const restoredSensitiveIncluded = await restoredMemory.search({
  profileId: "backup_profile_restored",
  query: "123-45-6789",
  includeSensitive: true,
});
assert.equal(
  restoredSensitiveIncluded.some((entry) => entry.content.includes("123-45-6789")),
  true,
);
const restoredFullBackup = restoreStore.exportProfileBackup({
  profileId: "backup_profile_restored",
  mode: "full",
});
assert.equal(restoredFullBackup.counts.memories, fullProfileBackup.counts.memories);
assert.equal(restoredFullBackup.counts.evidenceEvents, fullProfileBackup.counts.evidenceEvents);
assert.equal(restoredFullBackup.counts.worldBeliefs, fullProfileBackup.counts.worldBeliefs);
assert.equal(restoredFullBackup.counts.failureEvents, fullProfileBackup.counts.failureEvents);
assert.equal(restoredFullBackup.counts.taskTrajectories, fullProfileBackup.counts.taskTrajectories);
const repeatedRestore = restoreStore.restoreProfileBackup({
  backup: parsedProfileBackup,
  profileId: "backup_profile_restored",
});
assert.equal(repeatedRestore.inserted.memories, 0);
assert.equal(repeatedRestore.skipped.memories, fullProfileBackup.counts.memories);
assert.throws(
  () =>
    restoreStore.restoreProfileBackup({
      backup: parsedProfileBackup,
      profileId: "backup_profile_restored",
      onConflict: "fail",
    }),
  /restore conflict/,
);
await restoredMemory.close();
assert.throws(
  () =>
    parseMemorySnapshotExport({
      ...JSON.parse(JSON.stringify(defaultSnapshotExport)),
      memoryCount: defaultSnapshotExport.memoryCount + 1,
    }),
  /memoryCount does not match memories/,
);
const importedSnapshotStore = createSqliteMemoryStore({
  path: path.join(tmp, "snapshot-import.db"),
});
await loadHostMemorySnapshotsIntoStore({
  store: importedSnapshotStore,
  profileId: "snapshot_import",
  memories: parsedSnapshotExport.memories,
  sourceType: "gmos.snapshot_export",
  sourceUriPrefix: parsedSnapshotExport.sourceUriPrefix,
});
const importedSnapshotMemory = createMemoryOS({
  profileId: "snapshot_import",
  store: importedSnapshotStore,
});
const importedSnapshotMatches = await importedSnapshotMemory.search({
  profileId: "snapshot_import",
  query: "explicit exports",
});
assert.equal(importedSnapshotMatches.length, 1);
assert.match(importedSnapshotMatches[0]?.content ?? "", /explicit exports/);
await importedSnapshotMemory.close();

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "PERSON: Alice: Alice 喜欢披萨。",
  createdAt: "2026-06-25T00:01:00.000Z",
});
const personLeak = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "Alice 喜欢什么？" }],
});
assert.equal(personLeak.contextBlock.includes("披萨"), false);

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "token: sk-test1234567890abcdef 不要泄漏",
  createdAt: "2026-06-25T00:02:00.000Z",
});
const secret = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "token 是什么？" }],
  includeSensitive: true,
  includeEvidence: true,
});
assert.equal(secret.contextBlock.includes("sk-test"), false);

await memory.observe({
  type: "conversation.message",
  profileId: "test",
  role: "user",
  content: "我的 SSN 是 123-45-6789，不要再提醒我。",
  createdAt: "2026-06-25T00:02:30.000Z",
});
const sensitivePolicy = await memory.prepareTurn({
  profileId: "test",
  messages: [{ role: "user", content: "SSN 提醒策略是什么？" }],
});
assert.equal(sensitivePolicy.contextBlock.includes("123-45-6789"), false);
assert.equal(
  sensitivePolicy.directives.some((directive) => directive.includes("123-45-6789")),
  false,
);

await memory.commitOutcome({
  profileId: "test",
  objective: "verify sdk",
  status: "failed",
  summary: "fixture failure",
});
await memory.recordFeedback({
  profileId: "test",
  content: "wrong recall used stale preference",
  failureKind: "wrong_recall",
});
await memory.recordFeedback({
  profileId: "test",
  content: "privacy leak exposed 身份证 110101199001011234",
  failureKind: "privacy_leak",
});
await memory.recordFeedback({
  profileId: "other_profile",
  content: "other profile wrong recall must not leak",
  failureKind: "wrong_recall",
});
const testProfileFailures = store.listFailures({ profileId: "test" });
assert.equal(testProfileFailures.length, 3);

const compat = classifyHostCompatibility({
  hostId: "ghast",
  capabilities: createPresetHostAdapter("ghast").capabilities,
});
assert.equal(compat.level, "L4");
assert.equal(compat.hardGateCoverage.forgetCompliance, true);
assert.equal(compat.hardGateCoverage.doNotPushPriority, true);
assert.deepEqual(compat.gaps, []);
const mockL3 = createPresetHostAdapter("mock_l3").compatibility;
assert.equal(mockL3.level, "L3");
assert.ok(mockL3.gaps.includes("tool observation"));
const mcp = createPresetHostAdapter("mcp").compatibility;
assert.equal(mcp.level, "L2");
assert.equal(mcp.hardGateCoverage.doNotPushPriority, false);
const searchOnly = createPresetHostAdapter("search_only").compatibility;
assert.equal(searchOnly.level, "L1");
assert.ok(searchOnly.gaps.includes("forget/delete"));
const reportOnlyControl = createEvolutionControlPlane();
assert.equal(reportOnlyControl.mode, "report_only");
assert.equal(reportOnlyControl.autoApply, false);
assert.equal(reportOnlyControl.autoRollout, false);
await assert.rejects(
  () => reportOnlyControl.reviewFailures(),
  /requires a store with listFailures/,
);
const evolutionBeforeCounts = await store.rowCounts();
const evolution = createEvolutionControlPlane({ store, profileId: "test" });
const evolutionReport = await evolution.reviewFailures({ limit: 10 });
assert.equal(evolutionReport.mode, "report_only");
assert.equal(evolutionReport.autoApply, false);
assert.equal(evolutionReport.autoRollout, false);
assert.equal(evolutionReport.decision, "report_only_review");
assert.equal(evolutionReport.inspectedFailureCount, 3);
assert.equal(evolutionReport.clusters.length, 3);
assert.ok(evolutionReport.clusters.some((cluster) => cluster.failureKind === "task_failure"));
assert.ok(evolutionReport.clusters.some((cluster) => cluster.failureKind === "wrong_recall"));
assert.ok(evolutionReport.clusters.some((cluster) => cluster.failureKind === "privacy_leak"));
assert.ok(evolutionReport.patchProposals.every((proposal) => proposal.autoApply === false));
assert.ok(evolutionReport.patchProposals.every((proposal) => proposal.autoRollout === false));
const evolutionReportJson = JSON.stringify(evolutionReport);
assert.equal(evolutionReportJson.includes("身份证"), false);
assert.equal(evolutionReportJson.includes("110101199001011234"), false);
assert.equal(evolutionReportJson.includes("other profile wrong recall"), false);
assert.ok(
  evolutionReport.clusters.some((cluster) =>
    cluster.sampleContents.includes("[redacted_sensitive_failure]"),
  ),
);
assert.deepEqual(await store.rowCounts(), evolutionBeforeCounts);
const wrongRecallOnly = await evolution.reviewFailures({ failureKind: "wrong_recall" });
assert.equal(wrongRecallOnly.inspectedFailureCount, 1);
assert.match(renderEvolutionFailureReviewMarkdown(evolutionReport), /gmOS Evolution Failure Review/);
const statusReport = await createMemoryStatusReport({
  store,
  profileId: "test",
  host: "ghast",
  now: () => "2026-06-25T00:02:45.000Z",
});
assert.equal(statusReport.framework, "ghast-memory-os");
assert.equal(statusReport.package.name, packageJson.name);
assert.equal(statusReport.package.version, packageJson.version);
assert.equal(statusReport.storage.status, "ok");
assert.equal(statusReport.storage.schemaVersion, 3);
assert.equal(statusReport.storage.searchIndex?.status, "ok");
assert.equal(statusReport.storage.searchIndex?.missingEntryCount, 0);
assert.equal(statusReport.storage.rowCounts.gmos_failure_events >= testProfileFailures.length, true);
assert.equal(statusReport.failureSummary.status, "ok");
assert.equal(statusReport.failureSummary.inspectedFailureCount, 3);
assert.equal(statusReport.failureSummary.byKind.wrong_recall, 1);
assert.equal(statusReport.failureSummary.byKind.privacy_leak, 1);
assert.equal(statusReport.failureSummary.byKind.task_failure, 1);
assert.equal(statusReport.hostCompatibility?.level, "L4");
assert.equal(JSON.stringify(statusReport).includes("身份证"), false);
assert.equal(JSON.stringify(statusReport).includes("110101199001011234"), false);
const renderedStatus = renderMemoryStatusMarkdown(statusReport);
assert.match(renderedStatus, /gmOS Status Report/);
assert.match(renderedStatus, /Search index: ok/);
assert.match(renderedStatus, /gmos_failure_events/);
assert.equal(renderedStatus.includes("身份证"), false);
const badStatus = await createMemoryStatusReport({
  store: {
    rowCounts: () => {
      const error = new Error("raw secret sk-diagnosticssecret1234567890 and memory text");
      error.name = "sk-diagnosticsname1234567890 memory name";
      throw error;
    },
  },
  profileId: "test",
});
const badStatusJson = JSON.stringify(badStatus);
assert.equal(badStatus.storage.status, "unavailable");
assert.equal(badStatus.storage.error?.code, "diagnostics_store_unavailable");
assert.equal(badStatus.storage.error?.name, "DiagnosticsStoreUnavailable");
assert.equal(badStatusJson.includes("sk-diagnosticssecret"), false);
assert.equal(badStatusJson.includes("sk-diagnosticsname"), false);
assert.equal(badStatusJson.includes("memory text"), false);
assert.equal(renderMemoryStatusMarkdown(badStatus).includes("sk-diagnosticssecret"), false);
assert.equal(renderMemoryStatusMarkdown(badStatus).includes("sk-diagnosticsname"), false);
assert.equal(normalizeHostMemoryKind({ content: "PERSON: Alice: likes pizza" }), "person");
assert.equal(
  normalizeHostMemoryKind({ content: "PERSON: Alice: likes pizza", kind: "fact" }),
  "person",
);
assert.equal(
  normalizeHostMemorySensitivity({ content: "api key: sk-hostimportsecret1234567890" }),
  "secret_like",
);
assert.equal(
  normalizeHostMemorySensitivity({
    content: "api key: sk-mislabeledsecret1234567890",
    sensitivity: "normal",
  }),
  "secret_like",
);
for (const [credentialFixture, leakedFragment] of [
  ["https://example.test/callback?access_token=abcdefghijkl", "abcdefghijkl"],
  ["https://example.test/callback?refresh_token=abcdefghijkl", "abcdefghijkl"],
  ["https://example.test/callback?session_id=abcdefghijkl", "abcdefghijkl"],
  ["https://example.test/callback?sessionid=abcdefghijkl", "abcdefghijkl"],
  ["https://example.test/callback?auth_token=abcdefghijkl", "abcdefghijkl"],
  ["https://example.test/callback?credential_id=abcdefghijkl", "abcdefghijkl"],
  ["https://example.test/callback?credential.id=abcdefghijkl", "abcdefghijkl"],
  ["https://example.test/callback?credential id=abcdefghijkl", "abcdefghijkl"],
  ["Cookie=abcdefghijkl", "abcdefghijkl"],
  ["authorization=abcdefghijkl", "abcdefghijkl"],
  ["{\"sessionid\":\"abcdefghijkl\"}", "abcdefghijkl"],
  ["{\"session.id\":\"abcdefghijkl\"}", "abcdefghijkl"],
  ["access_token=abc%2Fdefgh", "abc%2Fdefgh"],
  ["password=p@ssw0rd!", "p@ssw0rd!"],
  ["secret=abc:defgh", "abc:defgh"],
  ["api_key=abc&defgh", "abc&defgh"],
  ["clientSecret=abcdefghijkl", "abcdefghijkl"],
  ["idToken=abcdefghijkl", "abcdefghijkl"],
  ["sessionToken=abcdefghijkl", "abcdefghijkl"],
  ["credentials=abcdefghijkl", "abcdefghijkl"],
  ["cookies=abcdefghijkl", "abcdefghijkl"],
  ["conversation://callback?clientSecret=abcdefghijkl", "abcdefghijkl"],
  ["conversation://callback?idToken=abcdefghijkl", "abcdefghijkl"],
  ["password=\"correct horse battery staple\"", "correct horse battery staple"],
  ["password=\"correct horse's battery staple\"", "correct horse's battery staple"],
  ['password="correct \\"horse\\" battery staple"', "horse"],
  [
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "eyJhbGciOiJIUzI1NiJ9",
  ],
] as const) {
  assert.equal(classifySensitivity(credentialFixture), "secret_like");
  assert.equal(redactForReport(credentialFixture).includes(leakedFragment), false);
}
const sanitizedCredentialEvidence = sanitizeEvidenceForPublicOutput({
  id: "evidence_redaction_fixture",
  eventKey: "evidence_redaction_fixture?access_token=abcdefghijkl",
  profileId: "profile SSN 123-45-6789",
  sourceType: "test",
  sourceUri: "conversation://fixture?credential.id=abcdefghijkl",
  content: "{\"sessionid\":\"abcdefghijkl\"}",
  sensitivity: "secret_like",
  eligibleForLongTermMemory: false,
  payload: { "credential.id": "abcdefghijkl", note: "safe" },
  createdAt: "2026-06-25T00:00:00.000Z",
});
assert.equal(sanitizedCredentialEvidence.eventKey.includes("abcdefghijkl"), false);
assert.equal(sanitizedCredentialEvidence.profileId.includes("123-45-6789"), false);
assert.equal(sanitizedCredentialEvidence.sourceUri?.includes("abcdefghijkl"), false);
assert.equal(sanitizedCredentialEvidence.content, "{\"sessionid\":\"[redacted_secret]\"}");
assert.equal(sanitizedCredentialEvidence.content.includes("abcdefghijkl"), false);
assert.equal(JSON.stringify(sanitizedCredentialEvidence.payload).includes("abcdefghijkl"), false);
assert.equal(JSON.stringify(sanitizedCredentialEvidence.payload).includes("credential.id"), false);
for (const restrictedPayload of [
  { sessionToken: "abcdefghijkl" },
  { clientSecret: "abcdefghijkl" },
  { credentials: "abcdefghijkl" },
  { cookies: "abcdefghijkl" },
  { idToken: "abcdefghijkl" },
]) {
  assert.equal(classifyPayloadSensitivity(restrictedPayload), "secret_like");
  assert.equal(payloadContainsRestrictedValue(restrictedPayload), true);
  assert.equal(JSON.stringify(sanitizePublicPayload(restrictedPayload)).includes("abcdefghijkl"), false);
}
const hostImportReport = await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_import",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:03:00.000Z",
  memories: [
    {
      id: "host_pref",
      content: "我喜欢先讲风险的方案。",
      kind: "preference",
      confidence: 0.9,
      metadata: { origin: "fixture", secret: "sk-metadata-shouldnotleak123456" },
    },
    {
      id: "host_boundary",
      content: "以后不要再提醒我 Beta 项目延期。",
      kind: "boundary",
    },
    {
      id: "host_secret",
      content: "api key: sk-hostimportsecret1234567890",
      kind: "fact",
    },
    {
      id: "host_mislabeled_secret",
      content: "api key: sk-mislabeledsecret1234567890",
      kind: "fact",
      sensitivity: "normal",
    },
    {
      id: "host_person",
      content: "PERSON: Alice: Alice 喜欢披萨。",
      kind: "fact",
    },
  ],
});
assert.equal(hostImportReport.inputCount, 5);
assert.equal(hostImportReport.loadedCount, 2);
assert.equal(hostImportReport.reusedCount, 0);
assert.equal(hostImportReport.skippedCount, 3);
assert.equal(
  hostImportReport.skipped.filter((entry) => entry.reason === "secret_like").length,
  2,
);
assert.ok(hostImportReport.skipped.some((entry) => entry.reason === "person_memory"));
assert.equal(JSON.stringify(hostImportReport).includes("sk-hostimportsecret"), false);
assert.equal(JSON.stringify(hostImportReport).includes("sk-mislabeledsecret"), false);
const afterFirstHostImportCounts = await store.rowCounts();
const repeatedHostImportReport = await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_import",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:03:00.000Z",
  memories: [
    {
      id: "host_pref",
      content: "我喜欢先讲风险的方案。",
      kind: "preference",
      confidence: 0.9,
      metadata: { secret: "sk-metadata-shouldnotleak123456" },
    },
  ],
});
assert.equal(repeatedHostImportReport.loadedCount, 1);
assert.equal(repeatedHostImportReport.reusedCount, 1);
assert.deepEqual(await store.rowCounts(), afterFirstHostImportCounts);
const crossProfileReport = await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_import_other",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  memories: [
    {
      id: "host_pref",
      content: "I prefer isolated profile evidence.",
      kind: "preference",
    },
  ],
});
assert.equal(crossProfileReport.loadedCount, 1);
assert.equal(crossProfileReport.reusedCount, 0);
const hostPrepared = await memory.prepareTurn({
  profileId: "host_import",
  messages: [{ role: "user", content: "先讲风险 Beta" }],
  includeEvidence: true,
});
assert.match(hostPrepared.contextBlock, /先讲风险/);
assert.equal(hostPrepared.contextBlock.includes("sk-hostimportsecret"), false);
assert.equal(hostPrepared.contextBlock.includes("sk-mislabeledsecret"), false);
assert.equal(hostPrepared.contextBlock.includes("披萨"), false);
assert.ok(hostPrepared.evidence.some((entry) => entry.sourceType === "ghast.memory"));
assert.equal(JSON.stringify(hostPrepared.evidence).includes("sk-metadata-shouldnotleak"), false);
const crossProfilePrepared = await memory.prepareTurn({
  profileId: "host_import_other",
  messages: [{ role: "user", content: "isolated profile evidence" }],
  includeEvidence: true,
});
assert.match(crossProfilePrepared.contextBlock, /isolated profile evidence/);
assert.ok(crossProfilePrepared.evidence.every((entry) => entry.profileId === "host_import_other"));

const firstHostSync = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:04:00.000Z",
  memories: [
    {
      id: "sync_pref",
      content: "我喜欢先讲风险。",
      kind: "preference",
      updatedAt: "2026-06-25T00:04:00.000Z",
    },
    {
      id: "sync_boundary",
      content: "以后不要提醒我 Moonbase 项目延期。",
      kind: "boundary",
      updatedAt: "2026-06-25T00:04:00.000Z",
    },
  ],
});
assert.equal(firstHostSync.loadedCount, 2);
assert.equal(firstHostSync.reusedCount, 0);
assert.equal(firstHostSync.archivedCount, 0);
const firstHostSyncCounts = await store.rowCounts();
const changedHostSync = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:05:00.000Z",
  memories: [
    {
      id: "sync_pref",
      content: "我现在喜欢先讲结论。",
      kind: "preference",
      updatedAt: "2026-06-25T00:05:00.000Z",
    },
    {
      id: "sync_secret",
      content: "api key: sk-syncsecret1234567890",
      kind: "fact",
      updatedAt: "2026-06-25T00:05:00.000Z",
    },
  ],
});
assert.equal(changedHostSync.loadedCount, 1);
assert.equal(changedHostSync.reusedCount, 0);
assert.equal(changedHostSync.skippedCount, 1);
assert.equal(changedHostSync.archivedCount, 2);
assert.equal(changedHostSync.archivedMemoryIds.length, 2);
const afterChangedHostSync = await memory.prepareTurn({
  profileId: "host_sync",
  messages: [{ role: "user", content: "风险 结论 Moonbase" }],
  includeEvidence: true,
});
assert.match(afterChangedHostSync.contextBlock, /先讲结论/);
assert.equal(afterChangedHostSync.contextBlock.includes("先讲风险"), false);
assert.equal(afterChangedHostSync.contextBlock.includes("Moonbase"), false);
assert.equal(afterChangedHostSync.contextBlock.includes("sk-syncsecret"), false);
const repeatedHostSync = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:05:00.000Z",
  memories: [
    {
      id: "sync_pref",
      content: "我现在喜欢先讲结论。",
      kind: "preference",
      updatedAt: "2026-06-25T00:05:00.000Z",
    },
  ],
});
assert.equal(repeatedHostSync.loadedCount, 1);
assert.equal(repeatedHostSync.reusedCount, 1);
assert.equal(repeatedHostSync.archivedCount, 0);
assert.equal((await store.rowCounts()).gmos_memories, firstHostSyncCounts.gmos_memories + 1);
const hashFallbackSyncA = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_hash",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:06:00.000Z",
  memories: [
    {
      id: "sync_without_updated_at",
      content: "old host snapshot content",
      kind: "preference",
    },
  ],
});
assert.equal(hashFallbackSyncA.loadedCount, 1);
assert.equal(hashFallbackSyncA.archivedCount, 0);
const hashFallbackSyncB = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_hash",
  sourceType: "ghast.memory",
  sourceUriPrefix: "ghast://memory",
  nowIso: "2026-06-25T00:07:00.000Z",
  memories: [
    {
      id: "sync_without_updated_at",
      content: "new host snapshot content",
      kind: "preference",
    },
  ],
});
assert.equal(hashFallbackSyncB.loadedCount, 1);
assert.equal(hashFallbackSyncB.reusedCount, 0);
assert.equal(hashFallbackSyncB.archivedCount, 1);
const hashFallbackPrepared = await memory.prepareTurn({
  profileId: "host_sync_hash",
  messages: [{ role: "user", content: "host snapshot content" }],
});
assert.match(hashFallbackPrepared.contextBlock, /new host snapshot content/);
assert.equal(hashFallbackPrepared.contextBlock.includes("old host snapshot content"), false);
const wildcardSourceA = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_source_type",
  sourceType: "fooXbar",
  sourceUriPrefix: "host://fooXbar",
  nowIso: "2026-06-25T00:08:00.000Z",
  memories: [
    {
      id: "source_type_guard",
      content: "wildcard source should remain active",
      kind: "preference",
    },
  ],
});
assert.equal(wildcardSourceA.loadedCount, 1);
const wildcardSourceB = await syncHostMemorySnapshotsIntoStore({
  store,
  profileId: "host_sync_source_type",
  sourceType: "foo_bar",
  sourceUriPrefix: "host://foo_bar",
  nowIso: "2026-06-25T00:09:00.000Z",
  memories: [],
});
assert.equal(wildcardSourceB.archivedCount, 0);
const wildcardPrepared = await memory.prepareTurn({
  profileId: "host_sync_source_type",
  messages: [{ role: "user", content: "wildcard source active" }],
});
assert.match(wildcardPrepared.contextBlock, /wildcard source should remain active/);

const mcpServer = createMemoryMcpServer(memory);
assert.equal(mcpServer.status, "ready");
assert.deepEqual(
  mcpServer.listTools().map((tool) => tool.name),
  listMemoryMcpTools().map((tool) => tool.name),
);
assert.deepEqual(
  mcpServer.listTools().map((tool) => tool.name),
  [...PUBLIC_MEMORY_MCP_TOOL_NAMES],
);
assert.equal(PUBLIC_MEMORY_MCP_TOOL_NAMES.includes("memory.backup" as never), false);
assert.ok(mcpServer.listTools().every((tool) => tool.inputSchema.type === "object"));
const mcpInvalidBefore = await store.rowCounts();
const invalidMcpObserve = await mcpServer.callTool("memory.observe", { content: 42 });
assert.equal(invalidMcpObserve.isError, true);
assert.deepEqual(await store.rowCounts(), mcpInvalidBefore);
const mcpAdd = await mcpServer.callTool("memory.add", {
  profileId: "mcp",
  kind: "preference",
  content: "我喜欢 MCP add 工具记录稳定偏好。",
});
assert.equal(mcpAdd.isError, undefined);
assert.equal((mcpAdd.structuredContent as { ok?: boolean }).ok, true);
assert.match(JSON.stringify(mcpAdd.structuredContent), /MCP add/);
assert.equal(JSON.stringify(mcpAdd.structuredContent).includes("metadata"), false);
const mcpSearch = await mcpServer.callTool("memory.search", {
  profileId: "mcp",
  query: "MCP add 稳定偏好",
});
assert.equal(mcpSearch.isError, undefined);
assert.match(JSON.stringify(mcpSearch.structuredContent), /MCP add 工具/);
assert.equal(JSON.stringify(mcpSearch.structuredContent).includes("metadata"), false);
const mcpSearchSensitiveOverride = await mcpServer.callTool("memory.search", {
  profileId: "mcp",
  query: "MCP add",
  includeSensitive: true,
});
assert.equal(mcpSearchSensitiveOverride.isError, true);
const mcpSearchPersonOverride = await mcpServer.callTool("memory.search", {
  profileId: "mcp",
  query: "MCP add",
  includePerson: true,
});
assert.equal(mcpSearchPersonOverride.isError, true);
const mcpBeforeUnsafeAdd = await store.rowCounts();
const mcpAddWithPersonOverride = await mcpServer.callTool("memory.add", {
  profileId: "mcp",
  kind: "fact",
  content: "Trying to pass hidden person override.",
  allowPerson: true,
});
assert.equal(mcpAddWithPersonOverride.isError, true);
const mcpAddWithSensitivityOverride = await mcpServer.callTool("memory.add", {
  profileId: "mcp",
  kind: "fact",
  content: "Trying to pass hidden sensitivity override.",
  sensitivity: "sensitive",
});
assert.equal(mcpAddWithSensitivityOverride.isError, true);
const mcpAddWithBadConfidence = await mcpServer.callTool("memory.add", {
  profileId: "mcp",
  kind: "fact",
  content: "Trying to pass confidence beyond public range.",
  confidence: 2,
});
assert.equal(mcpAddWithBadConfidence.isError, true);
const mcpSecretAdd = await mcpServer.callTool("memory.add", {
  profileId: "mcp",
  kind: "fact",
  content: "api key: sk-mcpaddsecret1234567890",
});
assert.equal(mcpSecretAdd.isError, true);
assert.deepEqual(await store.rowCounts(), mcpBeforeUnsafeAdd);
const mcpPersonAdd = await mcpServer.callTool("memory.add", {
  profileId: "mcp",
  kind: "fact",
  content: "PERSON: Alice: Alice likes tea.",
});
assert.equal(mcpPersonAdd.isError, true);
assert.deepEqual(await store.rowCounts(), mcpBeforeUnsafeAdd);
const mcpObserve = await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  conversationId: "conv_mcp",
  messageId: "msg_mcp_1",
  role: "user",
  content: "我的代码方案沟通偏好是先讲风险。",
  createdAt: "2026-06-25T00:03:00.000Z",
});
assert.equal((mcpObserve.structuredContent as { ok?: boolean }).ok, true);
const mcpPrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "代码方案沟通偏好",
  includeEvidence: true,
});
const mcpPreparedPayload = mcpPrepared.structuredContent as {
  ok?: boolean;
  prepared?: {
    contextBlock: string;
    evidence: unknown[];
    memories: Array<{ id: string; content: string }>;
  };
};
assert.equal(mcpPreparedPayload.ok, true);
assert.match(mcpPreparedPayload.prepared?.contextBlock ?? "", /先讲风险/);
assert.ok((mcpPreparedPayload.prepared?.evidence.length ?? 0) >= 1);
const mcpMemoryId = mcpPreparedPayload.prepared?.memories.find((entry) =>
  entry.content.includes("先讲风险"),
)?.id;
assert.equal(typeof mcpMemoryId, "string");
const mcpExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: mcpMemoryId,
});
assert.match(JSON.stringify(mcpExplanation.structuredContent), /先讲风险/);
const mcpNestedOverride = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  messages: [
    {
      role: "user",
      content: "嵌套参数也不能携带隐藏 override",
      includeSensitive: true,
    },
  ],
});
assert.equal(mcpNestedOverride.isError, true);
const mcpTextAndNestedOverride = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "即使 text 存在也不能忽略坏 messages",
  messages: [
    {
      role: "user",
      content: "嵌套参数也不能被静默忽略",
      includeSensitive: true,
    },
  ],
});
assert.equal(mcpTextAndNestedOverride.isError, true);
const metadataSecret = "sk-metadata1234567890abcdef";
const metadataAuthSecret = "Bearer ghast-auth-secret-value";
await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  role: "user",
  content: "我的 metadata 偏好是先写测试。",
  metadata: {
    token: metadataSecret,
    auth: metadataAuthSecret,
    nested: {
      apiKey: metadataSecret,
      debug: metadataAuthSecret,
      note: "safe metadata note",
    },
  },
});
const mcpMetadataPrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "metadata 偏好",
  includeEvidence: true,
});
assert.equal(mcpMetadataPrepared.isError, undefined);
assert.equal(JSON.stringify(mcpMetadataPrepared.structuredContent).includes(metadataSecret), false);
assert.equal(
  JSON.stringify(mcpMetadataPrepared.structuredContent).includes(metadataAuthSecret),
  false,
);
const mcpMetadataPreparedPayload = mcpMetadataPrepared.structuredContent as {
  prepared?: { memories: Array<{ id: string; content: string }> };
};
const metadataMemoryId = mcpMetadataPreparedPayload.prepared?.memories.find((entry) =>
  entry.content.includes("metadata 偏好"),
)?.id;
assert.equal(typeof metadataMemoryId, "string");
const mcpMetadataExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: metadataMemoryId,
});
assert.equal(mcpMetadataExplanation.isError, undefined);
assert.equal(JSON.stringify(mcpMetadataExplanation.structuredContent).includes(metadataSecret), false);
assert.equal(
  JSON.stringify(mcpMetadataExplanation.structuredContent).includes(metadataAuthSecret),
  false,
);
await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  role: "user",
  content: "secret key: sk-mcp-secret-1234567890 不要泄漏",
});
const mcpSecretPrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "secret key 是什么？",
  includeEvidence: true,
});
assert.equal(JSON.stringify(mcpSecretPrepared.structuredContent).includes("sk-mcp-secret"), false);
await mcpServer.callTool("memory.observe", {
  profileId: "mcp",
  role: "user",
  content: "我的 SSN 是 123-45-6789，不要再提醒。",
});
const mcpSensitivePrepared = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "SSN 提醒",
  includeEvidence: true,
});
assert.equal(JSON.stringify(mcpSensitivePrepared.structuredContent).includes("123-45-6789"), false);
const mcpSensitiveOverride = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "SSN 提醒",
  includeSensitive: true,
});
assert.equal(mcpSensitiveOverride.isError, true);
assert.equal(JSON.stringify(mcpSensitiveOverride.structuredContent).includes("123-45-6789"), false);
const sensitiveMcpMemories = await store.searchMemories({
  profileId: "mcp",
  query: "123-45-6789",
  purpose: "manage",
  includeSensitive: true,
});
const sensitiveMcpMemoryId = sensitiveMcpMemories[0]?.id;
assert.equal(typeof sensitiveMcpMemoryId, "string");
const mcpSensitiveExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: sensitiveMcpMemoryId,
});
assert.equal(mcpSensitiveExplanation.isError, true);
assert.equal(
  JSON.stringify(mcpSensitiveExplanation.structuredContent).includes("123-45-6789"),
  false,
);
const metadataSensitiveMemory = await store.addMemory({
  profileId: "mcp",
  kind: "fact",
  content: "metadata-only sensitive payload",
  sensitivity: "sensitive",
  confidence: 0.9,
});
const mcpMetadataSensitiveExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: metadataSensitiveMemory.id,
});
assert.equal(mcpMetadataSensitiveExplanation.isError, true);
assert.equal(
  JSON.stringify(mcpMetadataSensitiveExplanation.structuredContent).includes(
    "metadata-only sensitive payload",
  ),
  false,
);
const metadataPersonMemory = await store.addMemory({
  profileId: "mcp",
  kind: "person",
  content: "Alice prefers tea",
  sensitivity: "normal",
  confidence: 0.9,
});
const mcpPersonExplanation = await mcpServer.callTool("memory.explain_belief", {
  profileId: "mcp",
  id: metadataPersonMemory.id,
});
assert.equal(mcpPersonExplanation.isError, true);
assert.equal(JSON.stringify(mcpPersonExplanation.structuredContent).includes("Alice prefers tea"), false);
const mcpForget = await mcpServer.callTool("memory.forget", {
  profileId: "mcp",
  query: "先讲风险",
  reason: "test cleanup",
});
assert.match(JSON.stringify(mcpForget.structuredContent), /archivedMemoryIds/);
const mcpAfterForget = await mcpServer.callTool("memory.prepare_context", {
  profileId: "mcp",
  text: "代码方案沟通偏好",
});
assert.equal(JSON.stringify(mcpAfterForget.structuredContent).includes("先讲风险"), false);
await mcpServer.callTool("memory.record_feedback", {
  profileId: "mcp",
  content: "刚才错误召回了已删除偏好",
  failureKind: "wrong_recall",
});
await mcpServer.callTool("memory.commit_outcome", {
  profileId: "mcp",
  objective: "verify mcp server",
  status: "failed",
  summary: "mcp fixture failure",
});
const mcpCounts = await store.rowCounts();
assert.ok(mcpCounts.gmos_failure_events >= 3);

const httpServer = createMemoryHttpServer({
  memory,
  store,
  profileId: "http",
  host: "ghast",
});
const httpAddress = await httpServer.listen();
try {
  const health = await httpJson(`${httpAddress.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.framework, "ghast-memory-os");
  const tools = await httpJson(`${httpAddress.url}/tools`);
  assert.equal(tools.status, 200);
  assert.match(tools.text, /memory.prepare_context/);
  assert.deepEqual(
    (tools.body.tools as Array<{ name: string }>).map((tool) => tool.name),
    [...PUBLIC_MEMORY_MCP_TOOL_NAMES],
  );
  assert.deepEqual(PUBLIC_MEMORY_HTTP_ROUTES, [
    "GET /health",
    "GET /tools",
    "GET /status",
    "POST /add",
    "POST /search",
    "POST /observe",
    "POST /prepare",
    "POST /reconstruct",
    "POST /commit-outcome",
    "POST /feedback",
    "POST /forget",
    "POST /explain",
    "POST /mcp/call",
  ]);
  assert.equal(PUBLIC_MEMORY_HTTP_ROUTES.includes("POST /backup" as never), false);
  assert.equal(PUBLIC_MEMORY_HTTP_ROUTES.includes("POST /restore" as never), false);
  const status = await httpJson(`${httpAddress.url}/status?profileId=http`);
  assert.equal(status.status, 200);
  assert.equal(
    ((status.body.report as { storage?: { schemaVersion?: number } }).storage ?? {}).schemaVersion,
    3,
  );
  assert.equal(status.text.includes("mcp fixture failure"), false);
  const observe = await postJson(`${httpAddress.url}/observe`, {
    profileId: "http",
    role: "user",
    content: "我喜欢 HTTP adapter 先讲风险再给方案。",
  });
  assert.equal(observe.status, 200);
  assert.equal(observe.body.ok, true);
  const httpAdd = await postJson(`${httpAddress.url}/add`, {
    profileId: "http",
    kind: "preference",
    content: "HTTP add route prefers compact memory contracts.",
  });
  assert.equal(httpAdd.status, 200);
  assert.match(httpAdd.text, /compact memory contracts/);
  assert.equal(httpAdd.text.includes("metadata"), false);
  const httpSearch = await postJson(`${httpAddress.url}/search`, {
    profileId: "http",
    query: "compact memory contracts",
  });
  assert.equal(httpSearch.status, 200);
  assert.match(httpSearch.text, /compact memory contracts/);
  assert.equal(httpSearch.text.includes("metadata"), false);
  const httpSearchSensitiveOverride = await postJson(`${httpAddress.url}/search`, {
    profileId: "http",
    query: "compact memory contracts",
    includeSensitive: true,
  });
  assert.equal(httpSearchSensitiveOverride.status, 400);
  const httpUnsafeAdd = await postJson(`${httpAddress.url}/add`, {
    profileId: "http",
    kind: "fact",
    content: "api key: sk-httpaddsecret1234567890",
  });
  assert.equal(httpUnsafeAdd.status, 400);
  assert.equal(httpUnsafeAdd.text.includes("sk-httpaddsecret"), false);
  const httpPersonAdd = await postJson(`${httpAddress.url}/add`, {
    profileId: "http",
    kind: "fact",
    content: "PERSON: Bob: Bob likes black tea.",
  });
  assert.equal(httpPersonAdd.status, 400);
  assert.equal(httpPersonAdd.text.includes("black tea"), false);
  const httpBackupRoute = await postJson(`${httpAddress.url}/backup`, {
    profileId: "http",
  });
  assert.equal(httpBackupRoute.status, 404);
  const httpRestoreRoute = await postJson(`${httpAddress.url}/restore`, {
    profileId: "http",
  });
  assert.equal(httpRestoreRoute.status, 404);
  const preparedHttp = await postJson(`${httpAddress.url}/prepare`, {
    profileId: "http",
    text: "HTTP adapter 应该怎么回答？",
    includeEvidence: true,
  });
  assert.equal(preparedHttp.status, 200);
  assert.match(preparedHttp.text, /先讲风险/);
  const preparedPayload = preparedHttp.body as {
    prepared?: { memories?: Array<{ id?: string }>; contextBlock?: string };
  };
  const httpMemoryId = preparedPayload.prepared?.memories?.[0]?.id;
  assert.equal(typeof httpMemoryId, "string");
  const explanation = await postJson(`${httpAddress.url}/explain`, {
    profileId: "http",
    id: httpMemoryId,
  });
  assert.equal(explanation.status, 200);
  assert.match(explanation.text, /先讲风险/);
  await postJson(`${httpAddress.url}/observe`, {
    profileId: "http",
    role: "user",
    content: "我的 SSN 是 123-45-6789，不要暴露。",
  });
  const sensitiveOverride = await postJson(`${httpAddress.url}/prepare`, {
    profileId: "http",
    text: "SSN 是什么？",
    includeSensitive: true,
  });
  assert.equal(sensitiveOverride.status, 400);
  assert.equal(sensitiveOverride.text.includes("123-45-6789"), false);
  const reconstructSensitiveOverride = await postJson(`${httpAddress.url}/reconstruct`, {
    profileId: "http",
    text: "SSN 是什么？",
    includeSensitive: true,
  });
  assert.equal(reconstructSensitiveOverride.status, 400);
  assert.equal(reconstructSensitiveOverride.text.includes("123-45-6789"), false);
  const mcpCall = await postJson(`${httpAddress.url}/mcp/call`, {
    tool: "memory.prepare_context",
    args: {
      profileId: "http",
      text: "风险 方案",
    },
  });
  assert.equal(mcpCall.status, 200);
  assert.match(mcpCall.text, /先讲风险/);
  const forget = await postJson(`${httpAddress.url}/forget`, {
    profileId: "http",
    query: "HTTP adapter",
    reason: "test cleanup",
  });
  assert.equal(forget.status, 200);
  assert.match(forget.text, /archivedMemoryIds/);
  const afterForget = await postJson(`${httpAddress.url}/prepare`, {
    profileId: "http",
    text: "HTTP adapter 应该怎么回答？",
  });
  assert.equal(afterForget.status, 200);
  assert.equal(afterForget.text.includes("先讲风险"), false);
  const invalidJson = await fetch(`${httpAddress.url}/observe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad-json",
  });
  assert.equal(invalidJson.status, 400);
  assert.match(await invalidJson.text(), /invalid_json/);
  const missingRoute = await httpJson(`${httpAddress.url}/missing`);
  assert.equal(missingRoute.status, 404);
  const malformedResponse = await rawHttpRequest(
    httpAddress.port,
    "GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
  );
  assert.match(malformedResponse, /400 Bad Request/);
  assert.match(malformedResponse, /invalid_url/);
  const stillHealthy = await httpJson(`${httpAddress.url}/health`);
  assert.equal(stillHealthy.status, 200);
} finally {
  await httpServer.close();
}

const tinyHttpServer = createMemoryHttpServer({
  memory,
  maxBodyBytes: 16,
});
const tinyHttpAddress = await tinyHttpServer.listen();
try {
  const tooLarge = await postJson(`${tinyHttpAddress.url}/observe`, {
    content: "this body is intentionally larger than the tiny test limit",
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((tooLarge.body.error as { code?: string }).code, "request_body_too_large");
} finally {
  await tinyHttpServer.close();
}

assert.throws(
  () => createMemoryHttpServer({ memory, authToken: " " }),
  /authToken must not be empty/,
);

const authedHttpServer = createMemoryHttpServer({
  memory,
  profileId: "http_auth",
  authToken: "local-test-token",
});
const authedHttpAddress = await authedHttpServer.listen();
try {
  const health = await httpJson(`${authedHttpAddress.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.authRequired, true);
  const toolsWithoutToken = await httpJson(`${authedHttpAddress.url}/tools`);
  assert.equal(toolsWithoutToken.status, 401);
  assert.equal((toolsWithoutToken.body.error as { code?: string }).code, "unauthorized");
  assert.equal(toolsWithoutToken.text.includes("local-test-token"), false);
  const wrongToken = await postJson(
    `${authedHttpAddress.url}/observe`,
    {
      profileId: "http_auth",
      role: "user",
      content: "HTTP auth should reject the wrong token.",
    },
    { authorization: "Bearer wrong-token" },
  );
  assert.equal(wrongToken.status, 401);
  const authorizedObserve = await postJson(
    `${authedHttpAddress.url}/observe`,
    {
      profileId: "http_auth",
      role: "user",
      content: "我喜欢 HTTP auth bearer-protected local calls.",
    },
    { authorization: "Bearer local-test-token" },
  );
  assert.equal(authorizedObserve.status, 200);
  const authorizedPrepare = await postJson(
    `${authedHttpAddress.url}/prepare`,
    {
      profileId: "http_auth",
      text: "bearer-protected local calls",
    },
    { authorization: "Bearer local-test-token" },
  );
  assert.equal(authorizedPrepare.status, 200);
  assert.match(authorizedPrepare.text, /bearer-protected local calls/);
} finally {
  await authedHttpServer.close();
}

const cliHttp = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "http",
    "serve",
    "--db",
    path.join(tmp, "cli-http.db"),
    "--profile",
    "cli_http",
    "--port",
    "0",
    "--host",
    "ghast",
    "--auth-token",
    "cli-local-token",
  ],
  { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
);
let cliHttpStdout = "";
let cliHttpStderr = "";
cliHttp.stdout.setEncoding("utf8");
cliHttp.stderr.setEncoding("utf8");
cliHttp.stdout.on("data", (chunk: string) => {
  cliHttpStdout += chunk;
});
cliHttp.stderr.on("data", (chunk: string) => {
  cliHttpStderr += chunk;
});
const cliHttpUrl = await Promise.race([
  new Promise<string>((resolve) => {
    cliHttp.stdout.on("data", () => {
      const match = cliHttpStdout.match(/"url": "(http:\/\/127\.0\.0\.1:\d+)"/u);
      if (match?.[1]) resolve(match[1]);
    });
  }),
  new Promise<never>((_, reject) => {
    cliHttp.once("exit", (code, signal) => {
      reject(new Error(`gmos http serve exited early: code=${code} signal=${signal} stderr=${cliHttpStderr}`));
    });
  }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`gmos http serve did not print url: ${cliHttpStderr}`)), 5000),
  ),
]);
try {
  const cliHealth = await httpJson(`${cliHttpUrl}/health`);
  assert.equal(cliHealth.status, 200);
  assert.equal(cliHealth.body.framework, "ghast-memory-os");
  assert.equal(cliHealth.body.authRequired, true);
  const cliUnauthedObserve = await postJson(`${cliHttpUrl}/observe`, {
    profileId: "cli_http",
    role: "user",
    content: "unauthorized CLI HTTP writes should fail.",
  });
  assert.equal(cliUnauthedObserve.status, 401);
  const cliObserve = await postJson(`${cliHttpUrl}/observe`, {
    profileId: "cli_http",
    role: "user",
    content: "我喜欢 CLI HTTP adapter 先讲测试结果。",
  }, { authorization: "Bearer cli-local-token" });
  assert.equal(cliObserve.status, 200);
  const cliPrepare = await postJson(`${cliHttpUrl}/prepare`, {
    profileId: "cli_http",
    text: "CLI HTTP adapter 应该先讲什么？",
  }, { authorization: "Bearer cli-local-token" });
  assert.equal(cliPrepare.status, 200);
  assert.match(cliPrepare.text, /先讲测试结果/);
} finally {
  cliHttp.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => cliHttp.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

const cliMissingAuthToken = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "http",
    "serve",
    "--db",
    path.join(tmp, "cli-http-missing-auth.db"),
    "--profile",
    "cli_http_missing_auth",
    "--port",
    "0",
    "--auth-token",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliMissingAuthToken.status, 0);
assert.match(cliMissingAuthToken.stderr, /--auth-token requires a value/);

const cliEnvHttp = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "http",
    "serve",
    "--db",
    path.join(tmp, "cli-http-env.db"),
    "--profile",
    "cli_http_env",
    "--port",
    "0",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, GMOS_HTTP_AUTH_TOKEN: "cli-env-token" },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let cliEnvHttpStdout = "";
let cliEnvHttpStderr = "";
cliEnvHttp.stdout.setEncoding("utf8");
cliEnvHttp.stderr.setEncoding("utf8");
cliEnvHttp.stdout.on("data", (chunk: string) => {
  cliEnvHttpStdout += chunk;
});
cliEnvHttp.stderr.on("data", (chunk: string) => {
  cliEnvHttpStderr += chunk;
});
const cliEnvHttpUrl = await Promise.race([
  new Promise<string>((resolve) => {
    cliEnvHttp.stdout.on("data", () => {
      const match = cliEnvHttpStdout.match(/"url": "(http:\/\/127\.0\.0\.1:\d+)"/u);
      if (match?.[1]) resolve(match[1]);
    });
  }),
  new Promise<never>((_, reject) => {
    cliEnvHttp.once("exit", (code, signal) => {
      reject(new Error(`gmos env http serve exited early: code=${code} signal=${signal} stderr=${cliEnvHttpStderr}`));
    });
  }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`gmos env http serve did not print url: ${cliEnvHttpStderr}`)), 5000),
  ),
]);
try {
  const cliEnvHealth = await httpJson(`${cliEnvHttpUrl}/health`);
  assert.equal(cliEnvHealth.status, 200);
  assert.equal(cliEnvHealth.body.authRequired, true);
  const cliEnvUnauthedTools = await httpJson(`${cliEnvHttpUrl}/tools`);
  assert.equal(cliEnvUnauthedTools.status, 401);
  const cliEnvTools = await httpJson(`${cliEnvHttpUrl}/tools`, {
    headers: { authorization: "Bearer cli-env-token" },
  });
  assert.equal(cliEnvTools.status, 200);
  assert.match(cliEnvTools.text, /memory.prepare_context/);
} finally {
  cliEnvHttp.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => cliEnvHttp.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

const cliLowLevelDb = path.join(tmp, "cli-low-level.db");
const cliAdd = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "add",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--kind",
    "preference",
    "--text",
    "CLI low-level add prefers concise answers.",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliAdd.status, 0, cliAdd.stderr);
const cliAddMemory = JSON.parse(cliAdd.stdout) as { id?: string; sourceEventId?: string };
assert.equal(typeof cliAddMemory.id, "string");
assert.equal(typeof cliAddMemory.sourceEventId, "string");
const cliSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "search",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "concise answers",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliSearch.status, 0, cliSearch.stderr);
assert.match(cliSearch.stdout, /CLI low-level add prefers concise answers/);
const cliList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "concise answers",
    "--kind",
    "preference",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliList.status, 0, cliList.stderr);
const cliListPayload = JSON.parse(cliList.stdout) as { memories?: Array<{ id?: string }> };
assert.equal(
  cliListPayload.memories?.some((entry) => entry.id === cliAddMemory.id),
  true,
);
const cliGet = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "get",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliAddMemory.id!,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliGet.status, 0, cliGet.stderr);
assert.match(cliGet.stdout, /CLI low-level add prefers concise answers/);
const cliSensitiveAdd = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "add",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--kind",
    "fact",
    "--text",
    "CLI 管理视图可以保存护照办理偏好。",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliSensitiveAdd.status, 0, cliSensitiveAdd.stderr);
const cliSensitiveMemory = JSON.parse(cliSensitiveAdd.stdout) as { id?: string };
const cliSensitiveDefaultList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "护照",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliSensitiveDefaultList.status, 0, cliSensitiveDefaultList.stderr);
assert.equal(cliSensitiveDefaultList.stdout.includes("护照办理偏好"), false);
const cliSensitiveIncludedList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "护照",
    "--include-sensitive",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliSensitiveIncludedList.status, 0, cliSensitiveIncludedList.stderr);
assert.match(cliSensitiveIncludedList.stdout, /护照办理偏好/);
const cliSensitiveDefaultGet = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "get",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliSensitiveMemory.id!,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliSensitiveDefaultGet.status, 0);
assert.match(cliSensitiveDefaultGet.stderr, /Memory not found/);
const cliSensitiveIncludedGet = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "get",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliSensitiveMemory.id!,
    "--include-sensitive",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliSensitiveIncludedGet.status, 0, cliSensitiveIncludedGet.stderr);
assert.match(cliSensitiveIncludedGet.stdout, /护照办理偏好/);
const cliPersonAdd = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "add",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--kind",
    "person",
    "--text",
    "PERSON:李雷: 喜欢先看风险摘要。",
    "--allow-person",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliPersonAdd.status, 0, cliPersonAdd.stderr);
const cliPersonMemory = JSON.parse(cliPersonAdd.stdout) as { id?: string };
const cliPersonDefaultList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "李雷",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliPersonDefaultList.status, 0, cliPersonDefaultList.stderr);
assert.equal(cliPersonDefaultList.stdout.includes("李雷"), false);
const cliPersonIncludedList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "李雷",
    "--include-person",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliPersonIncludedList.status, 0, cliPersonIncludedList.stderr);
assert.match(cliPersonIncludedList.stdout, /李雷/);
const cliPersonDefaultGet = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "get",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliPersonMemory.id!,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliPersonDefaultGet.status, 0);
assert.match(cliPersonDefaultGet.stderr, /Memory not found/);
const cliPersonIncludedGet = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "get",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliPersonMemory.id!,
    "--include-person",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliPersonIncludedGet.status, 0, cliPersonIncludedGet.stderr);
assert.match(cliPersonIncludedGet.stdout, /李雷/);
const cliExportFile = path.join(tmp, "cli-snapshot-export.json");
const cliExport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "export",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "concise answers",
    "--output-file",
    cliExportFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliExport.status, 0, cliExport.stderr);
assert.equal(existsSync(cliExportFile), true);
const cliExportPayload = JSON.parse(readFileSync(cliExportFile, "utf8")) as {
  schema?: string;
  memoryCount?: number;
  memories?: Array<{ id?: string; content?: string }>;
};
assert.equal(cliExportPayload.schema, "gmos.memory_snapshot_export.v1");
assert.equal(cliExportPayload.memoryCount, 1);
assert.equal(cliExportPayload.memories?.[0]?.id, cliAddMemory.id);
assert.match(cliExportPayload.memories?.[0]?.content ?? "", /concise answers/);
assert.equal(JSON.stringify(cliExportPayload).includes("护照办理偏好"), false);
assert.equal(JSON.stringify(cliExportPayload).includes("李雷"), false);
const cliSensitiveExport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "export",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "护照",
    "--include-sensitive",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliSensitiveExport.status, 0, cliSensitiveExport.stderr);
assert.match(cliSensitiveExport.stdout, /护照办理偏好/);
const cliPersonExport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "export",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "李雷",
    "--include-person",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliPersonExport.status, 0, cliPersonExport.stderr);
assert.match(cliPersonExport.stdout, /李雷/);
const cliImportDb = path.join(tmp, "cli-snapshot-import.db");
const cliImport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "import",
    "--db",
    cliImportDb,
    "--profile",
    "cli_import",
    "--input-file",
    cliExportFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliImport.status, 0, cliImport.stderr);
assert.equal(JSON.parse(cliImport.stdout).loadedCount, 1);
const cliImportSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "search",
    "--db",
    cliImportDb,
    "--profile",
    "cli_import",
    "--query",
    "concise answers",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliImportSearch.status, 0, cliImportSearch.stderr);
assert.match(cliImportSearch.stdout, /concise answers/);
const cliMixedImportFile = path.join(tmp, "cli-mixed-snapshot-export.json");
writeFileSync(
  cliMixedImportFile,
  JSON.stringify(
    {
      schema: "gmos.memory_snapshot_export.v1",
      exportedAt: "2026-06-25T00:00:00.000Z",
      profileId: "cli_low",
      sourceUriPrefix: "gmos://memory",
      filters: {
        status: "active",
        includeSensitive: true,
        includePerson: true,
        limit: 3,
      },
      memoryCount: 3,
      memories: [
        {
          id: "cli_mixed_normal",
          content: "CLI mixed import keeps normal portable memory.",
          kind: "fact",
          sensitivity: "normal",
          sourceUri: "gmos://memory/cli_mixed_normal",
        },
        {
          id: "cli_mixed_person",
          content: "PERSON: Dana: Dana prefers tea.",
          kind: "person",
          sensitivity: "normal",
          sourceUri: "gmos://memory/cli_mixed_person",
        },
        {
          id: "cli_mixed_secret",
          content: "api key: sk-cliimportsecret1234567890",
          kind: "fact",
          sensitivity: "secret_like",
          sourceUri: "gmos://memory/cli_mixed_secret",
        },
      ],
    },
    null,
    2,
  ),
);
const cliMixedDefaultImportDb = path.join(tmp, "cli-mixed-default-import.db");
const cliMixedDefaultImport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "import",
    "--db",
    cliMixedDefaultImportDb,
    "--profile",
    "cli_mixed_default",
    "--input-file",
    cliMixedImportFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMixedDefaultImport.status, 0, cliMixedDefaultImport.stderr);
const cliMixedDefaultImportPayload = JSON.parse(cliMixedDefaultImport.stdout) as {
  loadedCount?: number;
  skipped?: Array<{ reason?: string }>;
};
assert.equal(cliMixedDefaultImportPayload.loadedCount, 1);
assert.deepEqual(
  cliMixedDefaultImportPayload.skipped?.map((entry) => entry.reason).sort(),
  ["person_memory", "secret_like"],
);
const cliMixedDefaultPersonSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "search",
    "--db",
    cliMixedDefaultImportDb,
    "--profile",
    "cli_mixed_default",
    "--query",
    "Dana tea",
    "--include-person",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMixedDefaultPersonSearch.status, 0, cliMixedDefaultPersonSearch.stderr);
assert.equal(cliMixedDefaultPersonSearch.stdout.includes("Dana prefers tea"), false);
const cliMixedDefaultSecretSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "search",
    "--db",
    cliMixedDefaultImportDb,
    "--profile",
    "cli_mixed_default",
    "--query",
    "sk-cliimportsecret",
    "--include-sensitive",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMixedDefaultSecretSearch.status, 0, cliMixedDefaultSecretSearch.stderr);
assert.equal(cliMixedDefaultSecretSearch.stdout.includes("sk-cliimportsecret"), false);
const cliMixedPersonImportDb = path.join(tmp, "cli-mixed-person-import.db");
const cliMixedPersonImport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "import",
    "--db",
    cliMixedPersonImportDb,
    "--profile",
    "cli_mixed_person",
    "--input-file",
    cliMixedImportFile,
    "--include-person",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMixedPersonImport.status, 0, cliMixedPersonImport.stderr);
const cliMixedPersonImportPayload = JSON.parse(cliMixedPersonImport.stdout) as {
  loadedCount?: number;
  skipped?: Array<{ reason?: string }>;
};
assert.equal(cliMixedPersonImportPayload.loadedCount, 2);
assert.deepEqual(
  cliMixedPersonImportPayload.skipped?.map((entry) => entry.reason),
  ["secret_like"],
);
const cliMixedPersonSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "search",
    "--db",
    cliMixedPersonImportDb,
    "--profile",
    "cli_mixed_person",
    "--query",
    "Dana tea",
    "--include-person",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMixedPersonSearch.status, 0, cliMixedPersonSearch.stderr);
assert.match(cliMixedPersonSearch.stdout, /Dana prefers tea/);
const cliMixedPersonSecretSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "search",
    "--db",
    cliMixedPersonImportDb,
    "--profile",
    "cli_mixed_person",
    "--query",
    "sk-cliimportsecret",
    "--include-sensitive",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMixedPersonSecretSearch.status, 0, cliMixedPersonSecretSearch.stderr);
assert.equal(cliMixedPersonSecretSearch.stdout.includes("sk-cliimportsecret"), false);
const cliUpdate = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "update",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliAddMemory.id!,
    "--text",
    "CLI low-level update prefers risk-first answers.",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliUpdate.status, 0, cliUpdate.stderr);
assert.match(cliUpdate.stdout, /risk-first answers/);
const cliDelete = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "delete",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliAddMemory.id!,
    "--reason",
    "cli delete test",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliDelete.status, 0, cliDelete.stderr);
assert.match(cliDelete.stdout, /archivedMemoryIds/);
const cliArchivedDefaultGet = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "get",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliAddMemory.id!,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliArchivedDefaultGet.status, 0);
assert.match(cliArchivedDefaultGet.stderr, /Memory not found/);
const cliArchivedIncludedGet = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "get",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--id",
    cliAddMemory.id!,
    "--include-archived",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliArchivedIncludedGet.status, 0, cliArchivedIncludedGet.stderr);
assert.match(cliArchivedIncludedGet.stdout, /risk-first answers/);
const cliArchivedList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--status",
    "archived",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliArchivedList.status, 0, cliArchivedList.stderr);
assert.match(cliArchivedList.stdout, /risk-first answers/);
const cliArchivedExportWithoutFlag = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "export",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "risk-first answers",
    "--status",
    "archived",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliArchivedExportWithoutFlag.status, 0);
assert.match(cliArchivedExportWithoutFlag.stderr, /requires --include-archived/);
const cliArchivedExport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "export",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--query",
    "risk-first answers",
    "--include-archived",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliArchivedExport.status, 0, cliArchivedExport.stderr);
assert.match(cliArchivedExport.stdout, /risk-first answers/);
const cliProfileBackupFile = path.join(tmp, "cli-profile-backup.json");
const cliProfileBackup = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "backup",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--mode",
    "full",
    "--output-file",
    cliProfileBackupFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliProfileBackup.status, 0, cliProfileBackup.stderr);
assert.equal(existsSync(cliProfileBackupFile), true);
const cliProfileBackupPayload = JSON.parse(readFileSync(cliProfileBackupFile, "utf8")) as {
  schema?: string;
  mode?: string;
  counts?: { memories?: number; evidenceEvents?: number };
  memories?: Array<{ id?: string; status?: string; content?: string }>;
};
assert.equal(cliProfileBackupPayload.schema, "gmos.profile_backup.v1");
assert.equal(cliProfileBackupPayload.mode, "full");
assert.equal((cliProfileBackupPayload.counts?.memories ?? 0) > 0, true);
assert.equal((cliProfileBackupPayload.counts?.evidenceEvents ?? 0) > 0, true);
assert.equal(
  cliProfileBackupPayload.memories?.some(
    (entry) => entry.id === cliAddMemory.id && entry.status === "archived",
  ),
  true,
);
const cliProfileRestoreDb = path.join(tmp, "cli-profile-restore.db");
const cliProfileRestore = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "restore",
    "--db",
    cliProfileRestoreDb,
    "--profile",
    "cli_restored",
    "--input-file",
    cliProfileBackupFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliProfileRestore.status, 0, cliProfileRestore.stderr);
const cliProfileRestorePayload = JSON.parse(cliProfileRestore.stdout) as {
  inserted?: { memories?: number };
  targetProfileId?: string;
};
assert.equal(cliProfileRestorePayload.targetProfileId, "cli_restored");
assert.equal(cliProfileRestorePayload.inserted?.memories, cliProfileBackupPayload.counts?.memories);
const cliProfileRestoreArchivedList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliProfileRestoreDb,
    "--profile",
    "cli_restored",
    "--status",
    "archived",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliProfileRestoreArchivedList.status, 0, cliProfileRestoreArchivedList.stderr);
assert.match(cliProfileRestoreArchivedList.stdout, /risk-first answers/);
const cliProfileRestoreRepeat = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "restore",
    "--db",
    cliProfileRestoreDb,
    "--profile",
    "cli_restored",
    "--input-file",
    cliProfileBackupFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliProfileRestoreRepeat.status, 0, cliProfileRestoreRepeat.stderr);
assert.equal(JSON.parse(cliProfileRestoreRepeat.stdout).inserted.memories, 0);
const cliProfileRestoreOriginalDb = path.join(tmp, "cli-profile-restore-original.db");
const cliProfileRestoreOriginal = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "restore",
    "--db",
    cliProfileRestoreOriginalDb,
    "--input-file",
    cliProfileBackupFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliProfileRestoreOriginal.status, 0, cliProfileRestoreOriginal.stderr);
assert.equal(JSON.parse(cliProfileRestoreOriginal.stdout).targetProfileId, "cli_low");
const cliProfileRestoreOriginalArchivedList = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "list",
    "--db",
    cliProfileRestoreOriginalDb,
    "--profile",
    "cli_low",
    "--status",
    "archived",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(
  cliProfileRestoreOriginalArchivedList.status,
  0,
  cliProfileRestoreOriginalArchivedList.stderr,
);
assert.match(cliProfileRestoreOriginalArchivedList.stdout, /risk-first answers/);
const cliClearAdd = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "add",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--kind",
    "fact",
    "--text",
    "CLI low-level clear scope fixture.",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliClearAdd.status, 0, cliClearAdd.stderr);
const cliClearMemory = JSON.parse(cliClearAdd.stdout) as { id?: string };
const cliClear = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "clear",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--scope",
    "global",
    "--reason",
    "cli clear test",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliClear.status, 0, cliClear.stderr);
assert.match(cliClear.stdout, /archivedMemoryIds/);
const cliMutationInspectDb = new Database(cliLowLevelDb, { readonly: true });
try {
  const cliDeleted = cliMutationInspectDb
    .prepare("SELECT metadata_json FROM gmos_memories WHERE id = ?")
    .get(cliAddMemory.id) as { metadata_json: string };
  assert.equal(JSON.parse(cliDeleted.metadata_json).archive.reason, "cli delete test");
  const cliCleared = cliMutationInspectDb
    .prepare("SELECT metadata_json FROM gmos_memories WHERE id = ?")
    .get(cliClearMemory.id) as { metadata_json: string };
  assert.equal(JSON.parse(cliCleared.metadata_json).archive.reason, "cli clear test");
} finally {
  cliMutationInspectDb.close();
}
const cliSecretAdd = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "add",
    "--db",
    cliLowLevelDb,
    "--profile",
    "cli_low",
    "--kind",
    "fact",
    "--text",
    "api key: sk-clilowlevelsecret1234567890",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliSecretAdd.status, 0);
assert.match(cliSecretAdd.stderr, /secret-like/);
const cliRepairSearchDb = path.join(tmp, "cli-repair-search-index.db");
const cliRepairAdd = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "add",
    "--db",
    cliRepairSearchDb,
    "--profile",
    "cli_repair",
    "--kind",
    "preference",
    "--text",
    "CLI repair search index fixture prefers resilient recall.",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliRepairAdd.status, 0, cliRepairAdd.stderr);
const cliRepairMemory = JSON.parse(cliRepairAdd.stdout) as { id?: string };
assert.ok(cliRepairMemory.id);
const corruptCliRepairDb = new Database(cliRepairSearchDb);
try {
  corruptCliRepairDb.prepare("DELETE FROM gmos_memories_fts WHERE id = ?").run(cliRepairMemory.id);
} finally {
  corruptCliRepairDb.close();
}
const cliRepairDoctorBefore = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "doctor",
    "--db",
    cliRepairSearchDb,
    "--host",
    "ghast",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliRepairDoctorBefore.status, 0, cliRepairDoctorBefore.stderr);
const cliRepairDoctorBeforeJson = JSON.parse(cliRepairDoctorBefore.stdout) as {
  searchIndex?: { status?: string; missingEntryCount?: number };
};
assert.equal(cliRepairDoctorBeforeJson.searchIndex?.status, "stale");
assert.equal(cliRepairDoctorBeforeJson.searchIndex?.missingEntryCount, 1);
const cliRepair = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "repair",
    "--db",
    cliRepairSearchDb,
    "--search-index",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliRepair.status, 0, cliRepair.stderr);
const cliRepairJson = JSON.parse(cliRepair.stdout) as {
  ok?: boolean;
  searchIndex?: {
    repaired?: boolean;
    before?: { status?: string; missingEntryCount?: number };
    after?: { status?: string; missingEntryCount?: number };
  };
};
assert.equal(cliRepairJson.ok, true);
assert.equal(cliRepairJson.searchIndex?.repaired, true);
assert.equal(cliRepairJson.searchIndex?.before?.status, "stale");
assert.equal(cliRepairJson.searchIndex?.before?.missingEntryCount, 1);
assert.equal(cliRepairJson.searchIndex?.after?.status, "ok");
assert.equal(cliRepairJson.searchIndex?.after?.missingEntryCount, 0);
const cliRepairSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "search",
    "--db",
    cliRepairSearchDb,
    "--profile",
    "cli_repair",
    "--query",
    "resilient recall",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliRepairSearch.status, 0, cliRepairSearch.stderr);
assert.match(cliRepairSearch.stdout, /resilient recall/);
const reconstructionDb = path.join(tmp, "reconstruction.db");
const reconstructionStore = createSqliteMemoryStore({ path: reconstructionDb });
const reconstructionMemory = createMemoryOS({
  profileId: "recon",
  store: reconstructionStore,
});
await reconstructionMemory.add({
  profileId: "recon",
  kind: "project",
  content: "代号 Helio 的项目是用户之前说的那个计划。",
});
await reconstructionMemory.add({
  profileId: "recon",
  kind: "procedure",
  content: "Helio 项目推进时先写复现报告，再做实现。",
});
await reconstructionMemory.add({
  profileId: "recon",
  kind: "boundary",
  content: "Helio 项目不要主动催促用户。",
});
await reconstructionMemory.commitOutcome({
  profileId: "recon",
  taskId: "helio-report",
  objective: "Helio 项目复现报告",
  status: "completed",
  summary: "先核证据链，再写实现计划。",
});
const reconstructed = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "我之前说的那个计划，先做什么？",
  includeEvidence: true,
  maxSteps: 4,
  maxBranch: 6,
  maxMemories: 6,
});
assert.match(reconstructed.contextBlock, /Helio 项目推进时先写复现报告/);
assert.ok(reconstructed.paths.length >= 2);
assert.ok(reconstructed.paths.some((path) => path.cue.toLowerCase() === "helio"));
assert.ok(reconstructed.evidence.length >= 2);
const reconstructedRowsBefore = await reconstructionStore.rowCounts();
const preparedWithShadow = await reconstructionMemory.prepareTurn({
  profileId: "recon",
  messages: [{ role: "user", content: "我之前说的那个计划，先做什么？" }],
  reconstruction: { mode: "shadow", maxSteps: 4, maxBranch: 6, maxMemories: 6 },
});
assert.match(preparedWithShadow.reconstruction?.contextBlock ?? "", /Helio 项目推进时先写复现报告/);
assert.equal(
  JSON.stringify(reconstructedRowsBefore),
  JSON.stringify(await reconstructionStore.rowCounts()),
);
const mcpReconstruct = await createMemoryMcpServer(reconstructionMemory).callTool(
  "memory.reconstruct_context",
  {
    profileId: "recon",
    text: "我之前说的那个计划，先做什么？",
    includeEvidence: true,
    maxSteps: 4,
  },
);
assert.equal(mcpReconstruct.isError, undefined);
assert.match(JSON.stringify(mcpReconstruct.structuredContent), /Helio 项目推进时先写复现报告/);
const mcpReconstructSensitive = await createMemoryMcpServer(reconstructionMemory).callTool(
  "memory.reconstruct_context",
  {
    profileId: "recon",
    text: "Helio",
    includeSensitive: true,
  },
);
assert.equal(mcpReconstructSensitive.isError, true);
const associationInspectDb = new Database(reconstructionDb, { readonly: true });
try {
  const associationCount = (
    associationInspectDb
      .prepare("SELECT COUNT(*) AS count FROM gmos_associations WHERE profile_id = 'recon'")
      .get() as { count: number }
  ).count;
  assert.ok(associationCount > 0);
} finally {
  associationInspectDb.close();
}
const cliReconstruct = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "reconstruct",
    "--db",
    reconstructionDb,
    "--profile",
    "recon",
    "--text",
    "我之前说的那个计划，先做什么？",
    "--max-steps",
    "4",
    "--max-branch",
    "6",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliReconstruct.status, 0, cliReconstruct.stderr);
assert.match(cliReconstruct.stdout, /Helio 项目推进时先写复现报告/);
const corruptAssociationsDb = new Database(reconstructionDb);
try {
  corruptAssociationsDb.prepare("DELETE FROM gmos_associations WHERE profile_id = 'recon'").run();
  corruptAssociationsDb.prepare("DELETE FROM gmos_associations_fts WHERE profile_id = 'recon'").run();
} finally {
  corruptAssociationsDb.close();
}
const cliRepairAssociations = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "repair",
    "--db",
    reconstructionDb,
    "--profile",
    "recon",
    "--associations",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliRepairAssociations.status, 0, cliRepairAssociations.stderr);
assert.ok(
  (JSON.parse(cliRepairAssociations.stdout) as {
    associations?: { rebuiltAssociationCount?: number };
  }).associations?.rebuiltAssociationCount ?? 0,
);
await reconstructionMemory.commitOutcome({
  profileId: "recon",
  taskId: "helio-secret-outcome",
  objective: "Helio secret outcome",
  status: "completed",
  summary: "Do not expose API key sk-reconstructiontrajectorysecret1234567890.",
});
const secretTrajectoryReconstruction = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Helio secret outcome API key",
  includeSensitive: true,
  maxSteps: 4,
});
assert.equal(
  secretTrajectoryReconstruction.contextBlock.includes("sk-reconstructiontrajectorysecret"),
  false,
);
await reconstructionMemory.observe({
  type: "conversation.message",
  profileId: "recon",
  role: "user",
  content: "Orchid project v1 owner is AlphaTeam.",
});
const orchidMatch = (await reconstructionMemory.search({
  profileId: "recon",
  query: "Orchid AlphaTeam",
  limit: 1,
}))[0];
assert.ok(orchidMatch);
await reconstructionMemory.update({
  profileId: "recon",
  id: orchidMatch.id,
  content: "Orchid project v2 owner is BetaTeam.",
  kind: "project",
});
await reconstructionStore.rebuildAssociations({ profileId: "recon" });
const orchidAfterUpdate = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Orchid owner",
  maxSteps: 4,
  maxBranch: 6,
});
assert.match(orchidAfterUpdate.contextBlock, /BetaTeam/);
assert.equal(orchidAfterUpdate.contextBlock.includes("AlphaTeam"), false);
await reconstructionMemory.observe({
  type: "conversation.message",
  profileId: "recon",
  role: "user",
  content: "Moonbase 项目发布管理由 SongSuOwnerAlpha 负责。",
});
const moonbaseBeforeForget = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Moonbase 发布管理",
  maxSteps: 4,
  maxBranch: 6,
});
assert.match(moonbaseBeforeForget.contextBlock, /SongSuOwnerAlpha/);
const moonbaseForgotten = await reconstructionMemory.forget({
  profileId: "recon",
  query: "SongSuOwnerAlpha",
});
assert.ok(moonbaseForgotten.archivedMemoryIds.length > 0);
await reconstructionStore.rebuildAssociations({ profileId: "recon" });
const moonbaseAfterRepair = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Moonbase 发布管理",
  maxSteps: 4,
  maxBranch: 6,
});
assert.equal(moonbaseAfterRepair.contextBlock.includes("SongSuOwnerAlpha"), false);
const personSourceMemory = await reconstructionMemory.add({
  profileId: "recon",
  kind: "person",
  content: "PERSON: Alice: Alice prefers chamomile tea.",
  allowPerson: true,
});
await reconstructionStore.addWorldBelief({
  profileId: "recon",
  subject: "Alice",
  predicate: "prefers",
  object: "ChamomileLeakTea",
  sourceMemoryId: personSourceMemory.id,
});
const sensitiveSourceMemory = await reconstructionMemory.add({
  profileId: "recon",
  kind: "fact",
  content: "Sensitive billing note says invoice code ZebraBlue.",
  sensitivity: "sensitive",
});
await reconstructionStore.addWorldBelief({
  profileId: "recon",
  subject: "billing",
  predicate: "code",
  object: "ZebraBlueLeakCode",
  sourceMemoryId: sensitiveSourceMemory.id,
});
await reconstructionStore.addWorldBelief({
  profileId: "recon",
  subject: "billing",
  predicate: "api_key",
  object: "api key sk-worldbeliefsecret1234567890",
  sourceMemoryId: sensitiveSourceMemory.id,
});
await reconstructionStore.rebuildAssociations({ profileId: "recon" });
const unsafeBeliefReconstruction = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Alice billing privacy",
  maxSteps: 4,
  maxBranch: 8,
});
assert.equal(unsafeBeliefReconstruction.contextBlock.includes("ChamomileLeakTea"), false);
assert.equal(unsafeBeliefReconstruction.contextBlock.includes("ZebraBlueLeakCode"), false);
const unsafeBeliefMcp = await createMemoryMcpServer(reconstructionMemory).callTool(
  "memory.reconstruct_context",
  {
    profileId: "recon",
    text: "Alice billing privacy",
    maxSteps: 4,
    maxBranch: 8,
  },
);
assert.equal(unsafeBeliefMcp.isError, undefined);
assert.equal(JSON.stringify(unsafeBeliefMcp.structuredContent).includes("ChamomileLeakTea"), false);
assert.equal(JSON.stringify(unsafeBeliefMcp.structuredContent).includes("ZebraBlueLeakCode"), false);
const secretBeliefReconstruction = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "billing api_key",
  includeSensitive: true,
  maxSteps: 4,
  maxBranch: 8,
});
assert.equal(secretBeliefReconstruction.contextBlock.includes("sk-worldbeliefsecret"), false);
const staleHostSource = await reconstructionMemory.add({
  profileId: "recon",
  kind: "project",
  content: "Host import stale project owner is StaleHostOwner.",
  metadata: {
    hostSnapshotImport: true,
    hostImportSourceType: "host.stale",
    hostImportKey: "stale-key",
  },
});
await reconstructionStore.addWorldBelief({
  profileId: "recon",
  subject: "host-import",
  predicate: "owner",
  object: "StaleHostOwner",
  sourceMemoryId: staleHostSource.id,
});
const archivedHostImports = reconstructionStore.archiveStaleHostImports?.({
  profileId: "recon",
  sourceType: "host.stale",
  activeImportKeys: [],
});
assert.ok((archivedHostImports?.length ?? 0) > 0);
await reconstructionStore.rebuildAssociations({ profileId: "recon" });
const staleHostAfterRepair = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "host import stale project",
  maxSteps: 4,
});
assert.equal(staleHostAfterRepair.contextBlock.includes("StaleHostOwner"), false);
await reconstructionMemory.add({
  profileId: "recon",
  kind: "fact",
  content: "Helio backup token is sk-reconstructionsecret1234567890",
}).then(
  () => assert.fail("secret-like reconstruction fixture should be rejected"),
  (error: unknown) => assert.match(String(error), /secret-like/),
);
await reconstructionMemory.close();
const cliStatus = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "status",
    "--db",
    dbPath,
    "--profile",
    "test",
    "--host",
    "ghast",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliStatus.status, 0, cliStatus.stderr);
const cliStatusPayload = JSON.parse(cliStatus.stdout) as {
  storage?: {
    schemaVersion?: number;
    rowCounts?: Record<string, number>;
    searchIndex?: { status?: string; missingEntryCount?: number };
  };
  failureSummary?: { inspectedFailureCount?: number };
  hostCompatibility?: { level?: string };
};
assert.equal(cliStatusPayload.storage?.schemaVersion, 3);
assert.ok((cliStatusPayload.storage?.rowCounts?.gmos_memories ?? 0) > 0);
assert.ok((cliStatusPayload.storage?.rowCounts?.gmos_associations ?? 0) > 0);
assert.equal(cliStatusPayload.storage?.searchIndex?.status, "ok");
assert.equal(cliStatusPayload.storage?.searchIndex?.missingEntryCount, 0);
assert.equal(cliStatusPayload.failureSummary?.inspectedFailureCount, 3);
assert.equal(cliStatusPayload.hostCompatibility?.level, "L4");
assert.equal(cliStatus.stdout.includes("身份证"), false);
const missingStatusDb = path.join(tmp, "missing-status.db");
assert.equal(existsSync(missingStatusDb), false);
const cliMissingStatus = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "status",
    "--db",
    missingStatusDb,
    "--profile",
    "missing",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMissingStatus.status, 0, cliMissingStatus.stderr);
const cliMissingStatusPayload = JSON.parse(cliMissingStatus.stdout) as {
  storage?: { status?: string; error?: { code?: string } };
};
assert.equal(cliMissingStatusPayload.storage?.status, "unavailable");
assert.equal(
  cliMissingStatusPayload.storage?.error?.code,
  "diagnostics_store_unavailable",
);
assert.equal(existsSync(missingStatusDb), false);

await memory.close();
const gym = await runMemoryGym();
assert.equal(gym.pass, true, gym.details.join("\n"));
assert.equal(gym.framework, "complete memory system benchmark framework");
assert.equal(gym.deterministicArchitectureResult.status, "pass");
assert.equal(gym.agentMemoryUseResult.status, "not_run");
assert.equal(gym.generalizationResult.status, "pass");
assert.equal(gym.generalizationResult.generatedSeedCount, 3);
assert.equal(gym.roadmapResult.status, "clear");
assert.equal(gym.runManifest.dbPathMode, "memory");
assert.equal(gym.runManifest.package.name, packageJson.name);
assert.equal(gym.runManifest.package.version, packageJson.version);
assert.equal(gym.runManifest.sqliteSchemaVersion, 3);
assert.equal(gym.runManifest.git.branch, expectedGit.branch);
assert.equal(gym.runManifest.git.sha, expectedGit.sha);
assert.equal(gym.runManifest.git.dirty, expectedGit.dirty);
assert.equal(gym.hardGates.mcp_public_sensitive_rejection, true);
assert.equal(gym.hardGates.host_adapter_contract, true);
assert.ok(gym.coverageMatrix.some((row) => row.layer === "Layer 2: MCP / Host Boundary"));
assert.ok(gym.memoryStackCoverage.some((row) => row.layer === "Safety / Privacy"));
const renderedGym = renderMemoryGymMarkdown(gym);
assert.match(renderedGym, /gmOS Memory Gym Report/);
assert.match(renderedGym, /Coverage Matrix/);
assert.match(renderedGym, /Run Manifest/);
assert.match(renderedGym, /Package: @ghast\/memory@/);
assert.match(renderedGym, /SQLite schema: 3/);
const generatedGym = await runMemoryGym({ generatedSeeds: 2 });
assert.equal(generatedGym.pass, true, generatedGym.details.join("\n"));
assert.equal(generatedGym.generalizationResult.generatedSeedCount, 2);
assert.equal(generatedGym.runManifest.generatedSeeds.length, 2);
await assert.rejects(
  () => runMemoryGym({ generatedSeeds: 0 }),
  /generatedSeeds must be a positive integer/,
);
await assert.rejects(
  () => runMemoryGym({ generatedSeeds: [] }),
  /generatedSeeds must be a positive integer/,
);
const scale = await runMemoryScaleBenchmark({ sizes: [10, 50], iterations: 3 });
assert.equal(scale.pass, true);
assert.match(renderMemoryScaleMarkdown(scale), /gmOS Memory Scale Benchmark/);
await assert.rejects(
  () => runMemoryScaleBenchmark({ sizes: [], iterations: 3 }),
  /positive integer size/,
);
await assert.rejects(
  () => runMemoryScaleBenchmark({ sizes: [10], iterations: 0 }),
  /positive integer/,
);
const releaseGate = await runMemoryReleaseGate({
  generatedSeeds: 1,
  scaleSizes: [10],
  scaleThresholdP95Ms: 250,
  hosts: ["ghast", "mcp"],
});
assert.equal(releaseGate.schema, "gmos.memory_release_gate.v1");
assert.equal(releaseGate.pass, true);
assert.equal(releaseGate.releaseConfidence, "release_candidate");
assert.equal(releaseGate.components.memoryGym.pass, true);
assert.equal(releaseGate.components.memoryGym.failedHardGates.length, 0);
assert.equal(releaseGate.components.hostCompatibility.pass, true);
assert.equal(releaseGate.components.hostCompatibility.hostCount, 2);
assert.equal(releaseGate.components.scale.pass, true);
assert.deepEqual(releaseGate.components.scale.failedSizes, []);
assert.equal(releaseGate.components.diagnostics.pass, true);
assert.equal(releaseGate.components.diagnostics.encrypted, false);
assert.equal(releaseGate.reports.diagnostics.trustContract.encrypted, false);
assert.equal(releaseGate.inputs.actualHostReports, 0);
assert.match(renderMemoryReleaseGateMarkdown(releaseGate), /gmOS Release Gate Report/);
const failedReleaseGate = await runMemoryReleaseGate({
  generatedSeeds: 1,
  scaleSizes: [10],
  scaleThresholdP95Ms: 0,
  hosts: ["ghast"],
});
assert.equal(failedReleaseGate.pass, false);
assert.equal(failedReleaseGate.releaseConfidence, "action_required");
assert.deepEqual(failedReleaseGate.components.scale.failedSizes, [10]);
for (const [host, expectedLevel] of [
  ["ghast", "L4"],
  ["mock_l3", "L3"],
  ["mcp", "L2"],
  ["search_only", "L1"],
] as const) {
  const doctor = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/gmos.ts",
      "doctor",
      "--db",
      path.join(tmp, `doctor-${host}.db`),
      "--host",
      host,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorJson = JSON.parse(doctor.stdout) as {
    encrypted: boolean;
    schema?: { dialect?: string; version?: number };
    hostCompatibility?: { level?: string; gaps?: string[] };
    searchIndex?: { status?: string; missingEntryCount?: number };
  };
  assert.equal(doctorJson.encrypted, false);
  assert.equal(doctorJson.schema?.dialect, "sqlite");
  assert.equal(doctorJson.schema?.version, 3);
  assert.equal(doctorJson.hostCompatibility?.level, expectedLevel);
  assert.equal(doctorJson.searchIndex?.status, "ok");
  assert.equal(doctorJson.searchIndex?.missingEntryCount, 0);
  if (host === "ghast") assert.deepEqual(doctorJson.hostCompatibility?.gaps, []);
}
const missingEvolutionDb = path.join(tmp, "evolution-missing.db");
assert.equal(existsSync(missingEvolutionDb), false);
const cliEvolutionReport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "evolution",
    "report",
    "--db",
    missingEvolutionDb,
    "--profile",
    "empty",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliEvolutionReport.status, 0, cliEvolutionReport.stderr);
assert.equal(existsSync(missingEvolutionDb), false);
const cliEvolutionJson = JSON.parse(cliEvolutionReport.stdout) as {
  mode?: string;
  autoApply?: boolean;
  autoRollout?: boolean;
  decision?: string;
  inspectedFailureCount?: number;
};
assert.equal(cliEvolutionJson.mode, "report_only");
assert.equal(cliEvolutionJson.autoApply, false);
assert.equal(cliEvolutionJson.autoRollout, false);
assert.equal(cliEvolutionJson.decision, "no_failures");
assert.equal(cliEvolutionJson.inspectedFailureCount, 0);
const emptyExistingEvolutionDb = path.join(tmp, "evolution-existing-empty.db");
const emptyExistingHandle = new Database(emptyExistingEvolutionDb);
emptyExistingHandle.close();
const readonlyEmptyEvolutionStore = createSqliteMemoryStore({
  path: emptyExistingEvolutionDb,
  readonly: true,
  fileMustExist: true,
});
assert.equal(await readonlyEmptyEvolutionStore.schemaVersion(), 0);
await readonlyEmptyEvolutionStore.close();
const existingEmptyEvolutionReport = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "evolution",
    "report",
    "--db",
    emptyExistingEvolutionDb,
    "--profile",
    "empty",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(existingEmptyEvolutionReport.status, 0, existingEmptyEvolutionReport.stderr);
const emptySchemaHandle = new Database(emptyExistingEvolutionDb, { readonly: true });
try {
  const tables = emptySchemaHandle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  assert.deepEqual(tables, []);
} finally {
  emptySchemaHandle.close();
}
const cliGymInvalidSeeds = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "run",
    "--db",
    ":memory:",
    "--generated-seeds",
    "0",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliGymInvalidSeeds.status, 0);
assert.match(cliGymInvalidSeeds.stderr, /--generated-seeds must be a positive integer/);
const cliScaleFail = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "scale",
    "--sizes",
    "1",
    "--threshold-p95-ms",
    "0",
    "--format",
    "markdown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliScaleFail.status, 0);
assert.match(cliScaleFail.stdout, /Status: FAIL/);
const cliGate = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gate",
    "--generated-seeds",
    "1",
    "--scale-sizes",
    "10",
    "--hosts",
    "ghast,mcp",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliGate.status, 0, cliGate.stderr);
const cliGateJson = JSON.parse(cliGate.stdout) as {
  schema?: string;
  pass?: boolean;
  inputs?: { dbPathMode?: string };
  components?: { diagnostics?: { encrypted?: boolean } };
};
assert.equal(cliGateJson.schema, "gmos.memory_release_gate.v1");
assert.equal(cliGateJson.pass, true);
assert.equal(cliGateJson.inputs?.dbPathMode, "memory");
assert.equal(cliGateJson.components?.diagnostics?.encrypted, false);
const ignoredGateDb = path.join(tmp, "gate-must-ignore-db.db");
assert.equal(existsSync(ignoredGateDb), false);
const cliGateIgnoresDb = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gate",
    "--db",
    ignoredGateDb,
    "--generated-seeds",
    "1",
    "--scale-sizes",
    "10",
    "--hosts",
    "ghast",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliGateIgnoresDb.status, 0, cliGateIgnoresDb.stderr);
assert.equal(JSON.parse(cliGateIgnoresDb.stdout).inputs.dbPathMode, "memory");
assert.equal(existsSync(ignoredGateDb), false);
const cliGymGate = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "gate",
    "--generated-seeds",
    "1",
    "--scale-sizes",
    "10",
    "--hosts",
    "ghast",
    "--format",
    "markdown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliGymGate.status, 0, cliGymGate.stderr);
assert.match(cliGymGate.stdout, /gmOS Release Gate Report/);
const hostGym = await runHostCompatibilityGym();
assert.equal(hostGym.pass, true, hostGym.failures.join("\n"));
assert.equal(hostGym.hostCount, 4);
assert.equal(hostGym.hosts.find((host) => host.hostId === "ghast")?.level, "L4");
assert.equal(
  hostGym.hosts.find((host) => host.hostId === "ghast")?.verificationMode,
  "preset_contract",
);
assert.equal(hostGym.hosts.find((host) => host.hostId === "ghast")?.memoryToAction, "pass");
assert.equal(hostGym.hosts.find((host) => host.hostId === "mcp")?.level, "L2");
assert.equal(
  hostGym.hosts.find((host) => host.hostId === "mcp")?.memoryToAction,
  "not_run",
);
assert.equal(
  hostGym.hosts.find((host) => host.hostId === "search_only")?.agentMemoryUse,
  "not_run",
);
assert.match(renderHostCompatibilityGymMarkdown(hostGym), /gmOS Host Compatibility Gym/);
const actualGhastL3Report = {
  hostId: "ghast_desktop",
  level: "L3",
  targetLevel: "L4",
  canClaimTargetLevel: false,
  blockingGaps: [
    "primary memory storage is still legacy memoryService",
    "non-SDK-owned consolidation and cleanup primary storage still execute through legacy memoryService",
  ],
};
const parsedHostStatusReports = parseHostActualCompatibilityReports({
  gmosSdkAdapter: actualGhastL3Report,
});
assert.equal(parsedHostStatusReports.length, 1);
assert.equal(parsedHostStatusReports[0]?.hostId, "ghast_desktop");
assert.equal(parsedHostStatusReports[0]?.level, "L3");
assert.equal(parsedHostStatusReports[0]?.targetLevel, "L4");
assert.equal(parsedHostStatusReports[0]?.canClaimTargetLevel, false);
assert.deepEqual(parsedHostStatusReports[0]?.blockingGaps, actualGhastL3Report.blockingGaps);
const parsedHostStatusArray = parseHostActualCompatibilityReports([
  actualGhastL3Report,
  { hostId: "bad_level", level: "L9" },
]);
assert.equal(parsedHostStatusArray.length, 1);
assert.equal(parsedHostStatusArray[0]?.hostId, "ghast_desktop");
assert.equal(
  requireHostActualCompatibilityReports({
    gmosSdkAdapter: actualGhastL3Report,
  })[0]?.level,
  "L3",
);
assert.throws(
  () =>
    requireHostActualCompatibilityReports({
      gmosSdkAdapter: { hostId: "bad_level", level: "L9" },
    }),
  /host actual report payload/,
);
const actualHostGym = await runHostCompatibilityGym({
  hosts: ["ghast"],
  actualReports: [actualGhastL3Report],
});
assert.equal(actualHostGym.pass, false);
assert.deepEqual(actualHostGym.unmatchedActualReportHostIds, []);
assert.equal(actualHostGym.hosts[0]?.verificationMode, "actual_host_report");
assert.equal(actualHostGym.hosts[0]?.level, "L3");
assert.equal(actualHostGym.hosts[0]?.presetLevel, "L4");
assert.match(actualHostGym.failures.join("\n"), /actual_host_report_level/);
const actualClaimFalseWithoutTarget = await runHostCompatibilityGym({
  hosts: ["ghast"],
  actualReports: [
    {
      hostId: "ghast_desktop",
      level: "L4",
      canClaimTargetLevel: false,
      blockingGaps: ["actual report explicitly refuses target claim"],
    },
  ],
});
assert.equal(actualClaimFalseWithoutTarget.pass, false);
assert.match(
  actualClaimFalseWithoutTarget.failures.join("\n"),
  /actual report explicitly refuses target claim/,
);
const unmatchedActualHostGym = await runHostCompatibilityGym({
  hosts: ["ghast"],
  actualReports: [
    {
      hostId: "unknown_host",
      level: "L3",
      targetLevel: "L4",
      canClaimTargetLevel: false,
    },
  ],
});
assert.equal(unmatchedActualHostGym.pass, false);
assert.deepEqual(unmatchedActualHostGym.unmatchedActualReportHostIds, ["unknown_host"]);
assert.match(unmatchedActualHostGym.failures.join("\n"), /actual_report_unmatched:unknown_host/);
const unconsumedActualHostGym = await runHostCompatibilityGym({
  hosts: ["ghast"],
  actualReports: [
    {
      hostId: "mcp",
      level: "L2",
      targetLevel: "L2",
      canClaimTargetLevel: true,
    },
  ],
});
assert.equal(unconsumedActualHostGym.pass, false);
assert.deepEqual(unconsumedActualHostGym.unmatchedActualReportHostIds, ["mcp"]);
assert.match(unconsumedActualHostGym.failures.join("\n"), /actual_report_unmatched:mcp/);
const cliHostGym = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "host",
    "--hosts",
    "ghast,mcp",
    "--format",
    "markdown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliHostGym.status, 0, cliHostGym.stderr);
assert.match(cliHostGym.stdout, /gmOS Host Compatibility Gym/);
assert.match(cliHostGym.stdout, /ghast/);
assert.match(cliHostGym.stdout, /mcp/);
const actualReportFile = path.join(tmp, "actual-ghast-report.json");
writeFileSync(
  actualReportFile,
  JSON.stringify({ gmosSdkAdapter: actualGhastL3Report }),
);
const cliHostGymActual = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "host",
    "--hosts",
    "ghast",
    "--actual-report",
    actualReportFile,
    "--format",
    "markdown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliHostGymActual.status, 0);
assert.match(cliHostGymActual.stdout, /actual_host_report/);
assert.match(cliHostGymActual.stdout, /primary memory storage is still legacy memoryService/);
const cliHostGymInvalid = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "host",
    "--hosts",
    "unknown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliHostGymInvalid.status, 0);
assert.match(cliHostGymInvalid.stderr, /--hosts must contain only/);
const cliMcpTools = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli/gmos.ts", "mcp", "tools"],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpTools.status, 0, cliMcpTools.stderr);
assert.ok(
  (JSON.parse(cliMcpTools.stdout) as { tools: Array<{ name: string }> }).tools.some(
    (tool) => tool.name === "memory.prepare_context",
  ),
);
const mcpCliDb = path.join(tmp, "mcp-cli.db");
const cliMcpObserve = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.observe",
    "--input",
    JSON.stringify({ content: "我偏好提交前先跑完整测试。", role: "user" }),
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpObserve.status, 0, cliMcpObserve.stderr);
const cliMcpPrepare = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.prepare_context",
    "--input",
    JSON.stringify({ text: "提交前应该注意什么？" }),
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpPrepare.status, 0, cliMcpPrepare.stderr);
assert.match(cliMcpPrepare.stdout, /完整测试/);
const cliMcpAdd = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.add",
    "--input",
    JSON.stringify({
      kind: "preference",
      content: "CLI MCP add remembers release gate coverage.",
    }),
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpAdd.status, 0, cliMcpAdd.stderr);
const cliMcpSearch = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.search",
    "--input",
    JSON.stringify({ query: "release gate coverage" }),
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliMcpSearch.status, 0, cliMcpSearch.stderr);
assert.match(cliMcpSearch.stdout, /release gate coverage/);
const cliMcpInvalid = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.observe",
    "--input",
    "{bad-json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliMcpInvalid.status, 0);
assert.match(cliMcpInvalid.stderr, /--input must be valid JSON/);
const cliMcpUnknownTool = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "call",
    "--db",
    mcpCliDb,
    "--profile",
    "cli_mcp",
    "--tool",
    "memory.unknown",
    "--input",
    "{}",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliMcpUnknownTool.status, 0);
assert.match(cliMcpUnknownTool.stdout, /Unknown gmOS MCP tool/);

const directStdioServer = createMemoryMcpStdioServer(memory);
assert.equal(directStdioServer.isConnected(), false);
const stdioMcpDb = path.join(tmp, "stdio-mcp.db");
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "serve",
    "--db",
    stdioMcpDb,
    "--profile",
    "stdio_mcp",
  ],
  cwd: process.cwd(),
  stderr: "pipe",
});
const stdioClient = new Client({
  name: "gmos-sdk-test-client",
  version: "0.0.0",
});
try {
  await stdioClient.connect(stdioTransport);
  assert.equal(stdioClient.getServerVersion()?.name, "gmos-memory");
  assert.equal(stdioClient.getServerVersion()?.version, packageJson.version);
  const stdioTools = await stdioClient.listTools();
  assert.deepEqual(
    stdioTools.tools.map((tool) => tool.name),
    [...PUBLIC_MEMORY_MCP_TOOL_NAMES],
  );
  const stdioAdd = await stdioClient.callTool({
    name: "memory.add",
    arguments: {
      profileId: "stdio_mcp",
      kind: "preference",
      content: "MCP stdio add remembers tool coverage.",
    },
  });
  assert.equal(stdioAdd.isError, undefined);
  const stdioSearch = await stdioClient.callTool({
    name: "memory.search",
    arguments: {
      profileId: "stdio_mcp",
      query: "tool coverage",
    },
  });
  assert.equal(stdioSearch.isError, undefined);
  assert.match(JSON.stringify(stdioSearch.structuredContent), /tool coverage/);
  await stdioClient.callTool({
    name: "memory.observe",
    arguments: {
      content: "我在 MCP stdio 模式下也偏好先讲风险。",
      role: "user",
      profileId: "stdio_mcp",
    },
  });
  const stdioPrepared = await stdioClient.callTool({
    name: "memory.prepare_context",
    arguments: {
      profileId: "stdio_mcp",
      text: "stdio 模式下应该怎么回答？",
      includeEvidence: true,
    },
  });
  assert.equal(stdioPrepared.isError, undefined);
  assert.match(JSON.stringify(stdioPrepared.structuredContent), /先讲风险/);
  const stdioNestedSensitive = await stdioClient.callTool({
    name: "memory.prepare_context",
    arguments: {
      profileId: "stdio_mcp",
      messages: [
        {
          role: "user",
          content: "嵌套参数不应携带隐藏 override",
          includeSensitive: true,
        },
      ],
    },
  });
  assert.equal(stdioNestedSensitive.isError, true);
  assert.equal(JSON.stringify(stdioNestedSensitive).includes("123-45-6789"), false);
  const stdioSensitive = await stdioClient.callTool({
    name: "memory.prepare_context",
    arguments: {
      profileId: "stdio_mcp",
      text: "stdio 敏感 override",
      includeSensitive: true,
    },
  });
  assert.equal(stdioSensitive.isError, true);
} finally {
  await stdioClient.close();
}

const termMcp = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "serve",
    "--db",
    path.join(tmp, "term-mcp.db"),
    "--profile",
    "term_mcp",
  ],
  { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
);
await new Promise((resolve) => setTimeout(resolve, 500));
termMcp.kill("SIGTERM");
const termExit = await Promise.race([
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    termMcp.once("exit", (code, signal) => resolve({ code, signal }));
  }),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
]);
if (!termExit) {
  termMcp.kill("SIGKILL");
  assert.fail("gmos mcp serve did not exit after SIGTERM");
}
assert.ok(termExit.code === 0 || termExit.signal === "SIGTERM");

const stdinEndMcp = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "mcp",
    "serve",
    "--db",
    path.join(tmp, "stdin-end-mcp.db"),
    "--profile",
    "stdin_end_mcp",
  ],
  { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
);
await new Promise((resolve) => setTimeout(resolve, 500));
stdinEndMcp.stdin.end();
const stdinEndExit = await Promise.race([
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    stdinEndMcp.once("exit", (code, signal) => resolve({ code, signal }));
  }),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
]);
if (!stdinEndExit) {
  stdinEndMcp.kill("SIGKILL");
  assert.fail("gmos mcp serve did not exit after stdin end");
}
assert.equal(stdinEndExit.code, 0);

const invalidHostDb = path.join(tmp, "doctor-invalid.db");
const invalidHost = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "doctor",
    "--db",
    invalidHostDb,
    "--host",
    "unknown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(invalidHost.status, 0);
assert.match(invalidHost.stderr, /--host must be one of/);
assert.equal(existsSync(invalidHostDb), false);
rmSync(tmp, { recursive: true, force: true });
console.log("[gmos-sdk] tests passed");
