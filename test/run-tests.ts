import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

import {
  createMemoryOS,
  createOpenAICompatibleExtractor,
  type MemoryStore,
} from "../src/index.js";
import {
  renderHostCompatibilityGymMarkdown,
  renderExternalMemoryBenchmarkMarkdown,
  renderMemoryGymMarkdown,
  renderMemoryReleaseGateMarkdown,
  renderMemoryScaleMarkdown,
  buildStateBenchLearnings,
  hashExternalMemoryBenchmarkInput,
  parseExternalMemoryBenchmarkDataset,
  parseExternalMemoryBenchmarkJsonl,
  parseLocomoBenchmarkDataset,
  parseLongMemEvalBenchmarkDataset,
  runExternalMemoryBenchmark,
  runHostCompatibilityGym,
  runMemoryGym,
  runMemoryReleaseGate,
  runMemoryScaleBenchmark,
  prepareStateBenchAgentLearningRun,
  summarizeStateBenchResults,
  stateBenchAgentPythonTemplate,
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
import { observedAtMetadata } from "../src/kernel/temporal-format.js";

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
assert.equal(await store.schemaVersion(), 6);

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
assert.equal(await legacyStore.schemaVersion(), 6);
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
assert.equal(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_memory_vectors WHERE id = 'legacy_memory_1'")
      .get() as { count: number }
  ).count,
  1,
);
assert.ok(
  (
    legacyHandle
      .prepare("SELECT COUNT(*) AS count FROM gmos_memory_vector_terms WHERE id = 'legacy_memory_1'")
      .get() as { count: number }
  ).count > 0,
);
const legacyStoreReopen = createSqliteMemoryStore({ path: legacyDbPath, handle: legacyHandle });
await legacyStoreReopen.initialize();
assert.equal(await legacyStoreReopen.schemaVersion(), 6);
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
assert.equal(await legacyV2Store.schemaVersion(), 6);
assert.ok(
  (
    legacyV2Handle
      .prepare("SELECT COUNT(*) AS count FROM gmos_associations WHERE target_id = 'legacy_v2_memory_1'")
      .get() as { count: number }
  ).count > 0,
);
assert.equal(
  (
    legacyV2Handle
      .prepare("SELECT COUNT(*) AS count FROM gmos_memory_vectors WHERE id = 'legacy_v2_memory_1'")
      .get() as { count: number }
  ).count,
  1,
);
assert.ok(
  (
    legacyV2Handle
      .prepare("SELECT COUNT(*) AS count FROM gmos_memory_vector_terms WHERE id = 'legacy_v2_memory_1'")
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
          metadata: {
            extractorFixture: "preference",
            apiKey: "sk-custommetadatasecret1234567890",
          },
        },
        {
          kind: "project",
          content: "Custom extractor says the Helio project is blocked on a migration probe.",
          confidence: 0.88,
          predicate: "project.state",
          subject: "Helio project",
          cardinality: "single",
          metadata: { extractorFixture: "project" },
        },
      ];
    },
  },
});
const customExtractionReport = await extractorMemory.observeWithReport({
  type: "conversation.message",
  profileId: "extractor",
  role: "user",
  content: "我喜欢先讲风险，而且 Helio 项目卡在 migration probe。",
});
assert.equal(customExtractionReport.extraction?.extractionSource, "custom");
assert.equal(customExtractionReport.extraction?.acceptedCandidateCount, 2);
assert.equal(customExtractionReport.extraction?.rejectedCandidateCount, 0);
assert.equal(customExtractionReport.memoryIds.length, 2);
assert.equal(customExtractionReport.worldBeliefIds.length, 2);
assert.equal(
  customExtractionReport.extraction?.decisions.every(
    (decision) => decision.decision === "accepted",
  ),
  true,
);
assert.equal(JSON.stringify(customExtractionReport).includes("sk-custommetadatasecret"), false);
const extractedPreference = await extractorMemory.search({
  profileId: "extractor",
  query: "risk-first plans",
  limit: 5,
});
assert.equal(JSON.stringify(extractedPreference).includes("sk-custommetadatasecret"), false);
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
await extractorMemory.observe({
  type: "conversation.message",
  profileId: "extractor",
  role: "user",
  content: "Helio 项目已经改为 blocked on rollout review.",
});
await extractorStore.addWorldBelief({
  profileId: "extractor",
  subject: "project:HELIO",
  predicate: "project.state",
  object: "Custom extractor says the Helio project is blocked on rollout review.",
  confidence: 0.93,
  cardinality: "single",
});
await extractorStore.addWorldBelief({
  profileId: "extractor",
  subject: "project:helio",
  predicate: "project.state",
  object: "Custom extractor says the Helio project is blocked on rollout review.",
  confidence: 0.94,
  cardinality: "single",
});
await extractorStore.addWorldBelief({
  profileId: "extractor",
  subject: "project:legacy",
  predicate: "project.state",
  object: "Legacy project state alpha from historical multi belief.",
  confidence: 0.81,
});
await extractorStore.addWorldBelief({
  profileId: "extractor",
  subject: "project:legacy",
  predicate: "project.state",
  object: "Legacy project state beta from historical multi belief.",
  confidence: 0.82,
});
await extractorStore.addWorldBelief({
  profileId: "extractor",
  subject: "project:legacy",
  predicate: "project.state",
  object: "Legacy project state beta from historical multi belief.",
  confidence: 0.91,
  cardinality: "single",
});
await extractorStore.addWorldBelief({
  profileId: "extractor",
  subject: "project:alias-safety",
  subjectAliases: ["sk-aliassecret1234567890"],
  predicate: "project.state",
  object: "Alias safety project has a public current state.",
  confidence: 0.91,
  cardinality: "single",
});
await extractorStore.addWorldBelief({
  profileId: "extractor",
  subject: "project:metadata-safety",
  predicate: "project.state",
  object: "Metadata safety project has a public current state.",
  confidence: 0.91,
  cardinality: "single",
  metadata: { note: "ssn 123-45-6789 should not leak through backup metadata" },
});
const extractorInspectDb = new Database(path.join(tmp, "custom-extractor.db"), { readonly: true });
try {
  const activeProjectBeliefCount = (
    extractorInspectDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM gmos_world_beliefs
         WHERE profile_id = 'extractor'
           AND subject = 'project:helio'
           AND predicate = 'project.state'
           AND status = 'active'`,
      )
      .get() as { count: number }
  ).count;
  assert.equal(activeProjectBeliefCount, 1);
  const activeProjectBelief = extractorInspectDb
    .prepare(
      `SELECT subject, metadata_json AS metadataJson
       FROM gmos_world_beliefs
       WHERE profile_id = 'extractor'
         AND subject = 'project:helio'
         AND predicate = 'project.state'
         AND status = 'active'
       LIMIT 1`,
    )
    .get() as { subject: string; metadataJson: string } | undefined;
  assert.equal(activeProjectBelief?.subject, "project:helio");
  const activeProjectMetadata = JSON.parse(activeProjectBelief?.metadataJson ?? "{}") as {
    entityResolution?: { aliases?: string[]; canonicalSubject?: string };
  };
  assert.equal(activeProjectMetadata.entityResolution?.canonicalSubject, "project:helio");
  assert.equal(
    activeProjectMetadata.entityResolution?.aliases?.some(
      (alias) => alias.toLowerCase() === "helio project",
    ),
    true,
  );
  const supersededProjectBeliefCount = (
    extractorInspectDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM gmos_world_beliefs
         WHERE profile_id = 'extractor'
           AND subject = 'project:helio'
           AND predicate = 'project.state'
           AND status = 'superseded'`,
      )
      .get() as { count: number }
  ).count;
  assert.equal(supersededProjectBeliefCount, 1);
  const staleWorldBeliefAssociationCount = (
    extractorInspectDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM gmos_associations
         WHERE profile_id = 'extractor'
           AND target_type = 'world_belief'
           AND target_summary LIKE '%migration probe%'`,
      )
      .get() as { count: number }
  ).count;
  assert.equal(staleWorldBeliefAssociationCount, 0);
  const activeLegacyProjectBeliefCount = (
    extractorInspectDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM gmos_world_beliefs
         WHERE profile_id = 'extractor'
           AND subject = 'project:legacy'
           AND predicate = 'project.state'
           AND status = 'active'`,
      )
      .get() as { count: number }
  ).count;
  assert.equal(activeLegacyProjectBeliefCount, 1);
  const supersededLegacyProjectBeliefCount = (
    extractorInspectDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM gmos_world_beliefs
         WHERE profile_id = 'extractor'
           AND subject = 'project:legacy'
           AND predicate = 'project.state'
           AND status = 'superseded'`,
      )
      .get() as { count: number }
  ).count;
  assert.equal(supersededLegacyProjectBeliefCount, 1);
  const staleLegacyWorldBeliefAssociationCount = (
    extractorInspectDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM gmos_associations
         WHERE profile_id = 'extractor'
           AND target_type = 'world_belief'
           AND target_summary LIKE '%Legacy project state alpha%'`,
      )
      .get() as { count: number }
  ).count;
  assert.equal(staleLegacyWorldBeliefAssociationCount, 0);
  const aliasSafetyRows = extractorInspectDb
    .prepare(
      `SELECT metadata_json AS metadataJson
       FROM gmos_world_beliefs
       WHERE profile_id = 'extractor'
         AND subject = 'project:alias-safety'`,
    )
    .all() as Array<{ metadataJson: string }>;
  assert.equal(JSON.stringify(aliasSafetyRows).includes("sk-aliassecret"), false);
  const unsafeAliasAssociationCount = (
    extractorInspectDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM gmos_associations
         WHERE profile_id = 'extractor'
           AND cue LIKE '%sk-aliassecret%'`,
      )
      .get() as { count: number }
  ).count;
  assert.equal(unsafeAliasAssociationCount, 0);
} finally {
  extractorInspectDb.close();
}
const extractorSafeBackup = extractorStore.exportProfileBackup({ profileId: "extractor" });
const extractorSafeBackupJson = JSON.stringify(extractorSafeBackup);
assert.equal(extractorSafeBackupJson.includes("sk-aliassecret"), false);
assert.equal(extractorSafeBackupJson.includes("123-45-6789"), false);
await extractorStore.rebuildAssociations({ profileId: "extractor" });
const currentProjectState = await extractorMemory.reconstructContext({
  profileId: "extractor",
  query: "Helio current state",
});
assert.match(currentProjectState.contextBlock, /rollout review/);
assert.doesNotMatch(currentProjectState.contextBlock, /migration probe/);
const contextStaleCurrentStateSearch = await extractorMemory.search({
  profileId: "extractor",
  query: "Helio migration probe",
  purpose: "context",
  limit: 10,
});
assert.equal(
  contextStaleCurrentStateSearch.some((entry) => entry.content.includes("migration probe")),
  false,
);
const manageStaleCurrentStateSearch = await extractorMemory.search({
  profileId: "extractor",
  query: "Helio migration probe",
  purpose: "manage",
  limit: 10,
});
assert.equal(
  manageStaleCurrentStateSearch.some((entry) => entry.content.includes("migration probe")),
  true,
);
const legacyProjectState = await extractorMemory.reconstructContext({
  profileId: "extractor",
  query: "Legacy project current state",
});
assert.match(legacyProjectState.contextBlock, /beta from historical multi belief/);
assert.doesNotMatch(legacyProjectState.contextBlock, /alpha from historical multi belief/);

const fallbackOnlyMemory = createMemoryOS({
  profileId: "fallback-only",
  store: {
    initialize() {},
    close() {},
    recordEvidence() {
      throw new Error("fallback-only store does not record evidence");
    },
    addMemory() {
      throw new Error("fallback-only store does not add memories");
    },
    addWorldBelief() {
      throw new Error("fallback-only store does not add beliefs");
    },
    searchMemories() {
      return [
        {
          id: "memory_fallback_false_positive",
          profileId: "fallback-only",
          kind: "fact",
          scope: "global",
          content: "Orbits correlated planning notes belong to a marketing campaign.",
          sensitivity: "normal",
          status: "active",
          confidence: 0.95,
          metadata: {},
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
        },
      ];
    },
    getMemoryById(_profileId: string, id: string) {
      return id === "memory_fallback_false_positive"
        ? {
            id: "memory_fallback_false_positive",
            profileId: "fallback-only",
            kind: "fact",
            scope: "global",
            content: "Orbits correlated planning notes belong to a marketing campaign.",
            sensitivity: "normal",
            status: "active",
            confidence: 0.95,
            metadata: {},
            createdAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
          }
        : null;
    },
    listEvidenceForMemory() {
      return [];
    },
    forget() {
      return { archivedMemoryIds: [] };
    },
    rowCounts() {
      return {
        gmos_evidence_events: 0,
        gmos_memories: 1,
        gmos_world_beliefs: 0,
        gmos_failure_events: 0,
        gmos_task_trajectories: 0,
        gmos_associations: 0,
        gmos_memory_vectors: 0,
        gmos_memory_vector_terms: 0,
      };
    },
  } satisfies MemoryStore,
});
const fallbackOnlyReconstruction = await fallbackOnlyMemory.reconstructContext({
  profileId: "fallback-only",
  query: "Completely unrelated Neptune orbital password?",
  maxMemories: 1,
});
assert.equal(fallbackOnlyReconstruction.contextBlock.includes("marketing campaign"), false);
assert.equal(fallbackOnlyReconstruction.stats.uncertainty?.level, "high");
assert.ok((fallbackOnlyReconstruction.stats.evidenceCoverage?.coverageRate ?? 1) < 0.5);
assert.equal(fallbackOnlyReconstruction.stats.evidenceConvergence?.reached, false);
await fallbackOnlyMemory.close();

const sharedSourceStore = createSqliteMemoryStore({ path: path.join(tmp, "shared-source.db") });
const sharedSourceMemory = createMemoryOS({
  profileId: "shared-source",
  store: sharedSourceStore,
  extractor: () => [],
});
const sharedActiveSource = await sharedSourceMemory.add({
  profileId: "shared-source",
  kind: "project",
  content: "SharedOwner",
  confidence: 0.9,
  metadata: { predicate: "project.state" },
});
await sharedSourceStore.addWorldBelief({
  profileId: "shared-source",
  subject: "project:active",
  predicate: "project.state",
  object: "SharedOwner",
  confidence: 0.9,
  sourceMemoryId: sharedActiveSource.id,
  cardinality: "single",
});
await sharedSourceStore.addWorldBelief({
  profileId: "shared-source",
  subject: "project:stale",
  predicate: "project.state",
  object: "SharedOwner",
  confidence: 0.8,
  cardinality: "single",
});
await sharedSourceStore.addWorldBelief({
  profileId: "shared-source",
  subject: "project:stale",
  predicate: "project.state",
  object: "NewOwner",
  confidence: 0.9,
  cardinality: "single",
});
await sharedSourceStore.rebuildAssociations({ profileId: "shared-source" });
const sharedSourceContextSearch = await sharedSourceMemory.search({
  profileId: "shared-source",
  query: "SharedOwner",
  purpose: "context",
  limit: 5,
});
assert.equal(
  sharedSourceContextSearch.some((entry) => entry.id === sharedActiveSource.id),
  true,
);
const sharedSourceReconstruction = await sharedSourceMemory.reconstructContext({
  profileId: "shared-source",
  query: "SharedOwner current state",
});
assert.match(sharedSourceReconstruction.contextBlock, /SharedOwner/);

const temporalStore = createSqliteMemoryStore({ path: path.join(tmp, "temporal-validity.db") });
const temporalMemory = createMemoryOS({
  profileId: "temporal",
  store: temporalStore,
  extractor: () => [],
});
const expiredTemporalMemory = await temporalMemory.add({
  profileId: "temporal",
  kind: "project",
  content: "Temporal window says Atlas owner is ExpiredOwner.",
  confidence: 0.9,
  metadata: { validTo: "2000-01-01T00:00:00.000Z" },
});
const futureTemporalMemory = await temporalMemory.add({
  profileId: "temporal",
  kind: "project",
  content: "Temporal window says Atlas owner is FutureOwner.",
  confidence: 0.9,
  metadata: { validFrom: "2999-01-01T00:00:00.000Z" },
});
const activeTemporalMemory = await temporalMemory.add({
  profileId: "temporal",
  kind: "project",
  content: "Temporal window says Atlas owner is ActiveOwner.",
  confidence: 0.9,
  createdAt: "2026-06-03T06:45:00.000Z",
  metadata: {
    validFrom: "2000-01-01T00:00:00.000Z",
    validTo: "2999-01-01T00:00:00.000Z",
  },
});
const contextTemporalSearch = await temporalMemory.search({
  profileId: "temporal",
  query: "Temporal window Atlas owner",
  purpose: "context",
  limit: 10,
});
assert.equal(contextTemporalSearch.some((entry) => entry.id === activeTemporalMemory.id), true);
assert.equal(contextTemporalSearch.some((entry) => entry.id === expiredTemporalMemory.id), false);
assert.equal(contextTemporalSearch.some((entry) => entry.id === futureTemporalMemory.id), false);
const manageTemporalSearch = await temporalMemory.search({
  profileId: "temporal",
  query: "Temporal window Atlas owner",
  purpose: "manage",
  limit: 10,
});
assert.equal(manageTemporalSearch.some((entry) => entry.id === expiredTemporalMemory.id), true);
assert.equal(manageTemporalSearch.some((entry) => entry.id === futureTemporalMemory.id), true);
const temporalReconstruction = await temporalMemory.reconstructContext({
  profileId: "temporal",
  query: "When was the Temporal window Atlas owner observed?",
  includeTemporalMetadata: true,
  maxSteps: 4,
  maxBranch: 8,
  maxMemories: 8,
});
assert.match(temporalReconstruction.contextBlock, /ActiveOwner/);
assert.match(temporalReconstruction.contextBlock, /observed=2026-06-03/);
assert.match(temporalReconstruction.contextBlock, /time=06:45 UTC/);
assert.equal(temporalReconstruction.paths.some((path) => path.createdAt === "2026-06-03T06:45:00.000Z"), true);
assert.doesNotMatch(temporalReconstruction.contextBlock, /ExpiredOwner/);
assert.doesNotMatch(temporalReconstruction.contextBlock, /FutureOwner/);
const nonTemporalReconstruction = await temporalMemory.reconstructContext({
  profileId: "temporal",
  query: "When was the Temporal window Atlas owner observed?",
  maxSteps: 4,
  maxBranch: 8,
  maxMemories: 8,
});
assert.match(nonTemporalReconstruction.contextBlock, /ActiveOwner/);
assert.doesNotMatch(nonTemporalReconstruction.contextBlock, /observed=2026-06-03/);
assert.equal(nonTemporalReconstruction.paths.some((path) => path.createdAt !== undefined), false);

let llmExtractorRequest: {
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
} = {};
const llmExtractorStore = createSqliteMemoryStore({
  path: path.join(tmp, "llm-extractor.db"),
});
const llmExtractorMemory = createMemoryOS({
  profileId: "llm_extractor",
  store: llmExtractorStore,
  extractor: createOpenAICompatibleExtractor({
    name: "fixture-openai-compatible-extractor",
    model: "fixture-memory-model",
    baseUrl: "https://memory-model.invalid/v1",
    apiKey: "test-key",
    headers: { "x-provider-fixture": "enabled" },
    timeoutMs: 5000,
    fetch: async (url, init) => {
      llmExtractorRequest = {
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        kind: "preference",
                        content: "LLM extractor says the user prefers risk-first summaries.",
                        confidence: 0.92,
                        predicate: "user.preference",
                        actionPolicyKind: "prefer",
                      },
                      {
                        kind: "project",
                        subject: "Project Mira",
                        content: "Mira project current blocker is rollout audit.",
                        confidence: 0.89,
                        predicate: "project.state",
                        cardinality: "single",
                      },
                      {
                        kind: "person",
                        content: "PERSON: Alice: Alice likes chamomile.",
                        confidence: 0.99,
                      },
                      {
                        kind: "fact",
                        content: "api key sk-llmextractorsecret1234567890",
                        confidence: 0.99,
                      },
                      {
                        kind: "unknown",
                        content: "invalid kind should be ignored",
                        confidence: 0.99,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
      };
    },
  }),
});
const llmExtractionReport = await llmExtractorMemory.observeWithReport({
  type: "conversation.message",
  profileId: "llm_extractor",
  role: "user",
  content: "我喜欢风险优先摘要；Mira 项目当前卡在 rollout audit。",
  metadata: { internalTrace: "sk-metadatashouldnotleave1234567890" },
});
assert.equal(llmExtractionReport.extraction?.extractorName, "fixture-openai-compatible-extractor");
assert.equal(llmExtractionReport.extraction?.acceptedCandidateCount, 2);
assert.equal(llmExtractionReport.extraction?.rejectedCandidateCount, 1);
assert.equal(llmExtractionReport.memoryIds.length, 2);
assert.equal(llmExtractionReport.worldBeliefIds.length, 2);
assert.deepEqual(
  llmExtractionReport.extraction?.decisions
    .filter((decision) => decision.decision === "rejected")
    .map((decision) => decision.reason),
  ["secret_like"],
);
assert.equal(JSON.stringify(llmExtractionReport).includes("sk-llmextractorsecret"), false);
assert.equal(llmExtractorRequest.url, "https://memory-model.invalid/v1/chat/completions");
assert.equal(llmExtractorRequest.headers?.authorization, "Bearer test-key");
assert.equal(llmExtractorRequest.headers?.["x-provider-fixture"], "enabled");
assert.equal(llmExtractorRequest.body?.model, "fixture-memory-model");
assert.deepEqual(llmExtractorRequest.body?.response_format, { type: "json_object" });
assert.equal(JSON.stringify(llmExtractorRequest.body).includes("sk-metadatashouldnotleave"), false);
const llmPreference = await llmExtractorMemory.search({
  profileId: "llm_extractor",
  query: "risk-first summaries",
  limit: 5,
});
assert.equal(llmPreference.some((entry) => entry.content.includes("risk-first summaries")), true);
assert.equal(
  llmPreference.some(
    (entry) =>
      entry.metadata.extractionSource === "custom" &&
      entry.metadata.extractorName === "fixture-openai-compatible-extractor" &&
      entry.metadata.llmExtractorModel === "fixture-memory-model",
  ),
  true,
);
const llmProject = await llmExtractorMemory.reconstructContext({
  profileId: "llm_extractor",
  query: "Mira project current blocker",
  maxSteps: 4,
  maxBranch: 6,
});
assert.match(llmProject.contextBlock, /rollout audit/);
assert.doesNotMatch(llmProject.contextBlock, /sk-llmextractorsecret/);
assert.doesNotMatch(llmProject.contextBlock, /Alice likes chamomile/);
await llmExtractorMemory.close();

const suppressRulesStore = createSqliteMemoryStore({ path: path.join(tmp, "suppress-rules.db") });
const suppressRulesMemory = createMemoryOS({
  profileId: "suppress",
  store: suppressRulesStore,
  extractor: () => [],
});
const suppressRulesReport = await suppressRulesMemory.observeWithReport({
  type: "conversation.message",
  profileId: "suppress",
  role: "user",
  content: "我喜欢这个本来会被规则抽取的偏好。",
});
assert.equal(suppressRulesReport.extraction?.extractionSource, "custom");
assert.equal(suppressRulesReport.extraction?.acceptedCandidateCount, 0);
assert.equal(suppressRulesReport.memoryIds.length, 0);
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
const fallbackExtractionReport = await fallbackExtractorMemory.observeWithReport({
  type: "conversation.message",
  profileId: "fallback_extractor",
  role: "user",
  content: "我喜欢 fallback rule extraction.",
});
assert.equal(fallbackExtractionReport.extraction?.extractionSource, "rules");
assert.equal(fallbackExtractionReport.extraction?.fallbackUsed, true);
assert.equal(fallbackExtractionReport.extraction?.extractorFailed, true);
assert.equal(fallbackExtractionReport.extraction?.acceptedCandidateCount, 1);
assert.equal(fallbackExtractionReport.memoryIds.length, 1);
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
      subject: "sk-customsubjectsecret1234567890",
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
const unsafeExtractionReport = await unsafeExtractorMemory.observeWithReport({
  type: "conversation.message",
  profileId: "unsafe_extractor",
  role: "user",
  content: "A harmless message should not persist unsafe custom candidates.",
});
assert.equal(unsafeExtractionReport.extraction?.acceptedCandidateCount, 0);
assert.deepEqual(
  unsafeExtractionReport.extraction?.decisions
    .filter((decision) => decision.decision === "rejected")
    .map((decision) => decision.reason)
    .sort(),
  ["invalid_kind", "person_kind", "person_routed", "secret_like"],
);
assert.equal(JSON.stringify(unsafeExtractionReport).includes("sk-customextractorsecret"), false);
assert.equal(JSON.stringify(unsafeExtractionReport).includes("sk-customsubjectsecret"), false);
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

const rulesReportStore = createSqliteMemoryStore({ path: path.join(tmp, "rules-report.db") });
const rulesReportMemory = createMemoryOS({
  profileId: "rules_report",
  store: rulesReportStore,
});
const rulesReport = await rulesReportMemory.observeWithReport({
  type: "conversation.message",
  profileId: "rules_report",
  role: "user",
  content: "I prefer concise release summaries.",
});
assert.equal(rulesReport.extraction?.extractionSource, "rules");
assert.equal(rulesReport.extraction?.fallbackUsed, false);
assert.equal(rulesReport.extraction?.extractorFailed, false);
assert.equal(rulesReport.extraction?.acceptedCandidateCount, 1);
const durableObservationReport = await rulesReportMemory.observeWithReport({
  type: "conversation.message",
  profileId: "rules_report",
  role: "user",
  content: "Caroline: I went to the LGBTQ support group yesterday.",
});
assert.equal(durableObservationReport.extraction?.acceptedCandidateCount, 1);
const durableObservationDecision = durableObservationReport.extraction?.decisions.find(
  (decision) => decision.decision === "accepted",
);
assert.equal(durableObservationDecision?.candidate.confidence, 0.52);
assert.equal(durableObservationDecision?.candidate.metadata?.rule, "durable_observation_fact");
assert.equal(durableObservationReport.memoryIds.length, 1);
assert.equal(durableObservationReport.worldBeliefIds.length, 0);
const defaultDurableObservationMatches = await rulesReportMemory.search({
  profileId: "rules_report",
  query: "Caroline support group",
});
assert.equal(defaultDurableObservationMatches.some((entry) => entry.content.includes("support group")), false);
const durableObservationMatches = await rulesReportMemory.search({
  profileId: "rules_report",
  query: "Caroline support group",
  purpose: "manage",
  includeSensitive: true,
});
assert.equal(durableObservationMatches.some((entry) => entry.content.includes("support group")), true);
assert.equal(
  durableObservationMatches.find((entry) => entry.content.includes("support group"))?.sensitivity,
  "sensitive",
);
const durableQuestionReport = await rulesReportMemory.observeWithReport({
  type: "conversation.message",
  profileId: "rules_report",
  role: "user",
  content: "Alex: Did you go to therapy yesterday?",
});
assert.equal(durableQuestionReport.extraction?.acceptedCandidateCount, 0);
assert.equal(durableQuestionReport.memoryIds.length, 0);
const durableThirdPersonReport = await rulesReportMemory.observeWithReport({
  type: "conversation.message",
  profileId: "rules_report",
  role: "user",
  content: "Alex: Blair painted a sunrise in 2022 after the charity race.",
});
assert.equal(durableThirdPersonReport.extraction?.acceptedCandidateCount, 0);
assert.equal(durableThirdPersonReport.memoryIds.length, 0);
const durableChineseQuestionReport = await rulesReportMemory.observeWithReport({
  type: "conversation.message",
  profileId: "rules_report",
  role: "user",
  content: "小林: 我昨天去心理咨询了吗",
});
assert.equal(durableChineseQuestionReport.extraction?.acceptedCandidateCount, 0);
assert.equal(durableChineseQuestionReport.memoryIds.length, 0);
await rulesReportMemory.close();

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
const fuzzyVectorMemory = await memory.add({
  profileId: "fts-history",
  kind: "project",
  content: "Aurora launch checklist requires cascade snapshot validation.",
  confidence: 0.9,
});
const fuzzyHybridMatches = await memory.search({
  profileId: "fts-history",
  query: "Auroa cheklist valdiation",
  limit: 5,
});
assert.equal(fuzzyHybridMatches.some((entry) => entry.id === fuzzyVectorMemory.id), true);
const fuzzyManageMatches = await memory.search({
  profileId: "fts-history",
  query: "Auroa cheklist valdiation",
  purpose: "manage",
  limit: 5,
});
assert.equal(fuzzyManageMatches.some((entry) => entry.id === fuzzyVectorMemory.id), false);
const vectorOnlyFalsePositiveMemory = await memory.add({
  profileId: "fts-history",
  kind: "fact",
  content: "Orbits correlated planning notes belong to a marketing campaign.",
  confidence: 0.9,
});
const vectorOnlyFalsePositiveMatches = await memory.search({
  profileId: "fts-history",
  query: "Completely unrelated Neptune orbital password?",
  limit: 5,
});
assert.equal(
  vectorOnlyFalsePositiveMatches.some((entry) => entry.id === vectorOnlyFalsePositiveMemory.id),
  false,
);
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
assert.equal(repairStatus.vectorIndex?.status, "ok");
assert.equal(repairStatus.vectorIndex?.indexedMemoryCount, 1);
assert.equal(repairStatus.vectorIndex?.dimensions, 384);
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
const missingVectorRepairDb = new Database(repairDbPath);
try {
  missingVectorRepairDb
    .prepare("DELETE FROM gmos_memory_vectors WHERE id = ?")
    .run(repairFixture.id);
} finally {
  missingVectorRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.vectorIndex?.status, "stale");
assert.equal(repairStatus.vectorIndex?.missingEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.vectorIndex?.status, "ok");
const staleVectorRepairDb = new Database(repairDbPath);
try {
  staleVectorRepairDb
    .prepare("UPDATE gmos_memory_vectors SET content_hash = ?, vector_json = ? WHERE id = ?")
    .run("stale-content-hash", "[]", repairFixture.id);
} finally {
  staleVectorRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.vectorIndex?.status, "stale");
assert.equal(repairStatus.vectorIndex?.staleEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.vectorIndex?.status, "ok");
const malformedVectorRepairDb = new Database(repairDbPath);
try {
  malformedVectorRepairDb
    .prepare("UPDATE gmos_memory_vectors SET vector_json = ? WHERE id = ?")
    .run("[]", repairFixture.id);
} finally {
  malformedVectorRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.vectorIndex?.status, "stale");
assert.equal(repairStatus.vectorIndex?.staleEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.vectorIndex?.status, "ok");
const missingVectorTermsRepairDb = new Database(repairDbPath);
try {
  missingVectorTermsRepairDb
    .prepare("DELETE FROM gmos_memory_vector_terms WHERE id = ?")
    .run(repairFixture.id);
} finally {
  missingVectorTermsRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.vectorIndex?.status, "stale");
assert.equal(repairStatus.vectorIndex?.missingEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.vectorIndex?.status, "ok");
const orphanVectorRepairDb = new Database(repairDbPath);
try {
  orphanVectorRepairDb
    .prepare(
      `INSERT INTO gmos_memory_vectors(
        id, profile_id, status, dimensions, vector_json, content_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "memory_vector_orphan",
      "repair",
      "active",
      384,
      "[0]",
      "orphan-content-hash",
      "2026-01-01T00:00:00.000Z",
    );
} finally {
  orphanVectorRepairDb.close();
}
repairStatus = await repairStore.searchIndexStatus();
assert.equal(repairStatus.status, "stale");
assert.equal(repairStatus.vectorIndex?.status, "stale");
assert.equal(repairStatus.vectorIndex?.orphanEntryCount, 1);
assert.equal((await repairStore.repairSearchIndex()).after.vectorIndex?.status, "ok");
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
const restoreSearchIndexStatus = await restoreStore.searchIndexStatus();
assert.equal(restoreSearchIndexStatus.status, "ok");
assert.equal(restoreSearchIndexStatus.vectorIndex?.status, "ok");
assert.ok((await restoreStore.rowCounts()).gmos_memory_vector_terms > 0);
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
assert.equal(statusReport.storage.schemaVersion, 6);
assert.equal(statusReport.storage.searchIndex?.status, "ok");
assert.equal(statusReport.storage.searchIndex?.missingEntryCount, 0);
assert.equal(statusReport.storage.rowCounts.gmos_failure_events >= testProfileFailures.length, true);
assert.equal(statusReport.storage.readAudit.status, "ok");
assert.equal(statusReport.storage.readAudit.schema, "gmos.read_audit_snapshot.v1");
assert.equal(statusReport.storage.readAudit.tableCount >= 10, true);
assert.equal(statusReport.storage.readAudit.auditedTables.includes("gmos_memories_fts"), true);
assert.equal(statusReport.storage.readAudit.hashesAvailable, true);
assert.equal(statusReport.storage.readAudit.missingTables.length, 0);
assert.equal(statusReport.failureSummary.status, "ok");
assert.equal(statusReport.failureSummary.inspectedFailureCount, 3);
assert.equal(statusReport.failureSummary.byKind.wrong_recall, 1);
assert.equal(statusReport.failureSummary.byKind.privacy_leak, 1);
assert.equal(statusReport.failureSummary.byKind.task_failure, 1);
assert.equal(statusReport.hostCompatibility?.level, "L4");
assert.equal(statusReport.trustContract.readPathSideEffectsChecked, true);
assert.equal(JSON.stringify(statusReport).includes("身份证"), false);
assert.equal(JSON.stringify(statusReport).includes("110101199001011234"), false);
assert.equal(JSON.stringify(statusReport).includes("stateHash"), false);
const renderedStatus = renderMemoryStatusMarkdown(statusReport);
assert.match(renderedStatus, /gmOS Status Report/);
assert.match(renderedStatus, /Search index: ok/);
assert.match(renderedStatus, /Read audit: ok/);
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
for (const sensitivePersonalFixture of [
  "I went to the LGBTQ support group yesterday.",
  "I discussed mental health therapy last week.",
  "我昨天去了心理支持小组。",
] as const) {
  assert.equal(classifySensitivity(sensitivePersonalFixture), "sensitive");
  assert.equal(redactForReport(sensitivePersonalFixture), "[redacted_sensitive]");
}
assert.equal(observedAtMetadata("2026-06-03T06:45:00.000Z"), "observed=2026-06-03; time=06:45 UTC");
assert.equal(observedAtMetadata("not a timestamp"), "");
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
    "POST /explain-path",
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
    6,
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
  const httpEvidencePath = await postJson(`${httpAddress.url}/explain-path`, {
    profileId: "http",
    text: "HTTP adapter 应该怎么回答？",
    includePlannerTrace: true,
  });
  assert.equal(httpEvidencePath.status, 200);
  assert.match(httpEvidencePath.text, /gmos\.evidence_path_explanation\.v1/);
  assert.equal(httpEvidencePath.text.includes("contextBlock"), false);
  assert.match(httpEvidencePath.text, /plannerTrace/);
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
  const explainPathSensitiveOverride = await postJson(`${httpAddress.url}/explain-path`, {
    profileId: "http",
    text: "SSN 是什么？",
    includeSensitive: true,
  });
  assert.equal(explainPathSensitiveOverride.status, 400);
  assert.equal(explainPathSensitiveOverride.text.includes("123-45-6789"), false);
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
assert.match(reconstructed.contextBlock, /Evidence coverage:/);
assert.match(reconstructed.contextBlock, /Evidence convergence:/);
assert.match(reconstructed.contextBlock, /Reconstruction uncertainty:/);
assert.ok((reconstructed.stats.evidenceCoverage?.coveredCueCount ?? 0) > 0);
assert.equal(reconstructed.stats.evidenceConvergence?.reached, true);
assert.equal(reconstructed.stats.evidenceConvergence?.stopWhenEvidenceEnough, true);
assert.ok(
  (reconstructed.stats.evidenceConvergence?.score ?? 0) >=
    (reconstructed.stats.evidenceConvergence?.threshold ?? 1),
);
assert.ok(reconstructed.paths.some((path) => (path.informationGain ?? 0) > 0));
assert.notEqual(reconstructed.stats.uncertainty?.level, "high");
const evidencePathRowsBefore = await reconstructionStore.rowCounts();
const reconstructionReadAudit = reconstructionStore.readAuditSnapshot();
assert.equal(reconstructionReadAudit.schema, "gmos.read_audit_snapshot.v1");
assert.equal(reconstructionReadAudit.tables.gmos_memories?.rowCount >= 3, true);
assert.match(reconstructionReadAudit.tables.gmos_memories?.stateHash ?? "", /^[a-f0-9]{64}$/u);
assert.match(reconstructionReadAudit.tables.gmos_memories_fts?.stateHash ?? "", /^[a-f0-9]{64}$/u);
const evidencePathExplanation = await reconstructionMemory.explainEvidencePath({
  profileId: "recon",
  query: "我之前说的那个计划，先做什么？",
  includePlannerTrace: true,
  maxSteps: 4,
  maxBranch: 6,
  maxMemories: 6,
});
assert.equal(evidencePathExplanation.schema, "gmos.evidence_path_explanation.v1");
assert.equal(evidencePathExplanation.summary.convergenceReached, true);
assert.equal(evidencePathExplanation.summary.pathCount >= 2, true);
assert.equal(evidencePathExplanation.summary.evidenceCount >= 2, true);
assert.match(JSON.stringify(evidencePathExplanation.paths), /Helio 项目推进时先写复现报告/);
assert.equal(evidencePathExplanation.plannerTrace?.steps.length ? true : false, true);
assert.equal(JSON.stringify(evidencePathExplanation).includes("contextBlock"), false);
assert.equal(JSON.stringify(evidencePathRowsBefore), JSON.stringify(await reconstructionStore.rowCounts()));
const evidencePathWithoutEvidence = await reconstructionMemory.explainEvidencePath({
  profileId: "recon",
  query: "我之前说的那个计划，先做什么？",
  includeEvidence: false,
  maxSteps: 4,
  maxBranch: 6,
  maxMemories: 6,
});
assert.equal(evidencePathWithoutEvidence.evidence.length, 0);

async function assertReadAuditRejectsSameRowMutation(
  operation: "prepareTurn" | "reconstructContext" | "explainEvidencePath",
): Promise<void> {
  const auditStore = createSqliteMemoryStore({
    path: path.join(tmp, `read-audit-${operation}.db`),
  });
  const auditMemory = createMemoryOS({
    profileId: `audit_${operation}`,
    store: auditStore,
  });
  const profileId = `audit_${operation}`;
  const memory = await auditMemory.add({
    profileId,
    kind: "preference",
    content: "Read audit fixture prefers stable invariant checks.",
  });
  const beforeCounts = auditStore.rowCounts();
  let mutated = false;
  function mutateSameRows(): void {
    if (mutated) return;
    mutated = true;
    const updated = auditStore.updateMemory?.({
      profileId,
      id: memory.id,
      metadata: {
        ...memory.metadata,
        readAuditMutation: operation,
      },
      updatedAt: "2030-01-01T00:00:00.000Z",
    });
    assert.ok(updated);
  }

  if (operation === "prepareTurn") {
    const originalSearchMemories = auditStore.searchMemories.bind(auditStore);
    auditStore.searchMemories = ((input) => {
      const result = originalSearchMemories(input);
      mutateSameRows();
      return result;
    }) as typeof auditStore.searchMemories;
    await assert.rejects(
      () =>
        auditMemory.prepareTurn({
          profileId,
          messages: [{ role: "user", content: "stable invariant checks" }],
        }),
      /prepareTurn produced write side effects/,
    );
  } else {
    const originalSearchAssociations = auditStore.searchAssociations.bind(auditStore);
    auditStore.searchAssociations = ((input) => {
      const result = originalSearchAssociations(input);
      mutateSameRows();
      return result;
    }) as typeof auditStore.searchAssociations;
    await assert.rejects(
      () =>
        operation === "reconstructContext"
          ? auditMemory.reconstructContext({
              profileId,
              query: "stable invariant checks",
            })
          : auditMemory.explainEvidencePath({
              profileId,
              query: "stable invariant checks",
            }),
      new RegExp(`${operation} produced write side effects`),
    );
  }
  assert.equal(JSON.stringify(beforeCounts), JSON.stringify(auditStore.rowCounts()));
  await auditMemory.close();
}

await assertReadAuditRejectsSameRowMutation("prepareTurn");
await assertReadAuditRejectsSameRowMutation("reconstructContext");
await assertReadAuditRejectsSameRowMutation("explainEvidencePath");

async function assertReadAuditRejectsFtsSameRowMutation(
  operation: "prepareTurn" | "reconstructContext" | "explainEvidencePath",
): Promise<void> {
  const auditDbPath = path.join(tmp, `read-audit-fts-${operation}.db`);
  const auditHandle = new Database(auditDbPath);
  const auditStore = createSqliteMemoryStore({
    path: auditDbPath,
    handle: auditHandle,
  });
  const auditMemory = createMemoryOS({
    profileId: `audit_fts_${operation}`,
    store: auditStore,
  });
  const profileId = `audit_fts_${operation}`;
  const memory = await auditMemory.add({
    profileId,
    kind: "preference",
    content: "Read audit fixture prefers FTS invariant checks.",
  });
  const beforeCounts = auditStore.rowCounts();
  let mutated = false;
  function mutateFtsSameRows(): void {
    if (mutated) return;
    mutated = true;
    assert.equal(
      auditHandle.prepare("DELETE FROM gmos_memories_fts WHERE id = ?").run(memory.id).changes,
      1,
    );
    auditHandle
      .prepare(
        `INSERT INTO gmos_memories_fts(id, profile_id, kind, scope, status, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.profileId,
        memory.kind,
        memory.scope,
        memory.status,
        "FTS drift keeps the same row count but changes searchable content.",
      );
  }

  try {
    if (operation === "prepareTurn") {
      const originalSearchMemories = auditStore.searchMemories.bind(auditStore);
      auditStore.searchMemories = ((input) => {
        const result = originalSearchMemories(input);
        mutateFtsSameRows();
        return result;
      }) as typeof auditStore.searchMemories;
      await assert.rejects(
        () =>
          auditMemory.prepareTurn({
            profileId,
            messages: [{ role: "user", content: "FTS invariant checks" }],
          }),
        /prepareTurn produced write side effects/,
      );
    } else {
      const originalSearchAssociations = auditStore.searchAssociations.bind(auditStore);
      auditStore.searchAssociations = ((input) => {
        const result = originalSearchAssociations(input);
        mutateFtsSameRows();
        return result;
      }) as typeof auditStore.searchAssociations;
      await assert.rejects(
        () =>
          operation === "reconstructContext"
            ? auditMemory.reconstructContext({
                profileId,
                query: "FTS invariant checks",
              })
            : auditMemory.explainEvidencePath({
                profileId,
                query: "FTS invariant checks",
              }),
        new RegExp(`${operation} produced write side effects`),
      );
    }
    assert.equal(JSON.stringify(beforeCounts), JSON.stringify(auditStore.rowCounts()));
  } finally {
    await auditMemory.close();
    auditHandle.close();
  }
}

await assertReadAuditRejectsFtsSameRowMutation("prepareTurn");
await assertReadAuditRejectsFtsSameRowMutation("reconstructContext");
await assertReadAuditRejectsFtsSameRowMutation("explainEvidencePath");

const multiIntentReconstructed = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "我之前说的那个计划，先做什么，哪些不要主动做？",
  maxSteps: 5,
  maxBranch: 6,
  maxMemories: 6,
});
assert.match(multiIntentReconstructed.contextBlock, /Helio 项目推进时先写复现报告/);
assert.match(multiIntentReconstructed.contextBlock, /不要主动催促用户/);
assert.equal(multiIntentReconstructed.stats.evidenceConvergence?.reached, true);
assert.ok(
  (multiIntentReconstructed.stats.evidenceConvergence?.requiredIntentGroupCount ?? 0) >= 2,
);
assert.equal(
  multiIntentReconstructed.stats.evidenceConvergence?.coveredIntentGroupCount,
  multiIntentReconstructed.stats.evidenceConvergence?.requiredIntentGroupCount,
);
assert.deepEqual(
  multiIntentReconstructed.stats.evidenceConvergence?.missingRequiredIntentGroups,
  [],
);
const exhaustiveReconstructed = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "我之前说的那个计划，先做什么？",
  maxSteps: 5,
  maxBranch: 6,
  maxMemories: 6,
  stopWhenEvidenceEnough: false,
});
assert.equal(
  exhaustiveReconstructed.stats.evidenceConvergence?.stopWhenEvidenceEnough,
  false,
);
assert.match(exhaustiveReconstructed.contextBlock, /Evidence convergence:/);
await reconstructionMemory.add({
  profileId: "recon",
  kind: "project",
  content: "代号 Vega 的发布计划叫做 Lantern Run。",
  confidence: 0.9,
});
await reconstructionMemory.add({
  profileId: "recon",
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
  await reconstructionMemory.add({
    profileId: "recon",
    kind: "fact",
    content,
    confidence: 0.99,
  });
}
const intentReranked = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Vega 这个发布计划下一步先做什么？",
  maxSteps: 4,
  maxBranch: 2,
  maxMemories: 3,
});
assert.match(intentReranked.contextBlock, /rollback matrix/);
const intentProcedurePath = intentReranked.paths.find(
  (path) => path.targetKind === "procedure" && path.targetSummary.includes("rollback matrix"),
);
assert.ok(intentProcedurePath);
assert.match(intentProcedurePath.routeReason ?? "", /intent/);
assert.match(intentProcedurePath.routeReason ?? "", /gain:/);
assert.ok((intentProcedurePath.informationGain ?? 0) > 0);
await reconstructionMemory.add({
  profileId: "recon",
  kind: "procedure",
  content: "Apollo rollout checklist says run temporal smoke before deploy.",
  confidence: 0.35,
});
await reconstructionMemory.add({
  profileId: "recon",
  kind: "fact",
  content: "Apollo cafeteria note says the table is blue.",
  confidence: 0.99,
});
const hybridReconstruction = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "What does the Apollo rollout checklist say before deploy?",
  maxSteps: 4,
  maxBranch: 1,
  maxMemories: 3,
});
assert.match(hybridReconstruction.contextBlock, /temporal smoke/);
const hybridPath = hybridReconstruction.paths.find((path) =>
  path.targetSummary.includes("temporal smoke"),
);
assert.ok(hybridPath);
assert.match(hybridPath.routeReason ?? "", /hybrid_(direct_memory_rrf|memory)/);
assert.ok((hybridPath.informationGain ?? 0) > 0);
await reconstructionMemory.add({
  profileId: "recon",
  kind: "fact",
  content: "Orbits correlated planning notes belong to a marketing campaign.",
  confidence: 0.95,
});
const vectorOnlyGuardReconstruction = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Completely unrelated Neptune orbital password?",
  maxSteps: 1,
  maxBranch: 1,
  maxMemories: 1,
});
assert.equal(
  vectorOnlyGuardReconstruction.contextBlock.includes("marketing campaign"),
  false,
);
assert.equal(vectorOnlyGuardReconstruction.stats.uncertainty?.level, "high");
assert.equal(vectorOnlyGuardReconstruction.stats.evidenceConvergence?.reached, false);
const unrelatedReconstruction = await reconstructionMemory.reconstructContext({
  profileId: "recon",
  query: "Completely unrelated Neptune orbital password?",
  maxSteps: 2,
  maxBranch: 2,
  maxMemories: 2,
});
assert.equal(unrelatedReconstruction.stats.uncertainty?.level, "high");
assert.ok((unrelatedReconstruction.stats.evidenceCoverage?.coverageRate ?? 1) < 0.5);
assert.equal(unrelatedReconstruction.stats.evidenceConvergence?.reached, false);
const reconstructedRowsBefore = await reconstructionStore.rowCounts();
const preparedWithShadow = await reconstructionMemory.prepareTurn({
  profileId: "recon",
  messages: [{ role: "user", content: "我之前说的那个计划，先做什么？" }],
  reconstruction: {
    mode: "shadow",
    maxSteps: 4,
    maxBranch: 6,
    maxMemories: 6,
    includeTemporalMetadata: true,
  },
});
assert.match(preparedWithShadow.reconstruction?.contextBlock ?? "", /Helio 项目推进时先写复现报告/);
assert.match(preparedWithShadow.reconstruction?.contextBlock ?? "", /observed=/);
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
    includeTemporalMetadata: true,
    maxSteps: 4,
    stopWhenEvidenceEnough: false,
    evidenceConvergenceThreshold: 0.8,
  },
);
assert.equal(mcpReconstruct.isError, undefined);
assert.match(JSON.stringify(mcpReconstruct.structuredContent), /Helio 项目推进时先写复现报告/);
assert.match(JSON.stringify(mcpReconstruct.structuredContent), /stopWhenEvidenceEnough/);
assert.match(JSON.stringify(mcpReconstruct.structuredContent), /false/);
assert.match(JSON.stringify(mcpReconstruct.structuredContent), /observed=/);
const mcpDefaultReconstruct = await createMemoryMcpServer(reconstructionMemory).callTool(
  "memory.reconstruct_context",
  {
    profileId: "recon",
    text: "我之前说的那个计划，先做什么？",
    maxSteps: 4,
  },
);
assert.equal(mcpDefaultReconstruct.isError, undefined);
assert.equal(JSON.stringify(mcpDefaultReconstruct.structuredContent).includes("observed="), false);
const mcpDefaultReconstructed = (
  mcpDefaultReconstruct.structuredContent as { reconstructed?: { paths?: unknown[] } }
).reconstructed;
assert.equal(JSON.stringify(mcpDefaultReconstructed?.paths ?? []).includes("createdAt"), false);
const mcpExplainEvidencePath = await createMemoryMcpServer(reconstructionMemory).callTool(
  "memory.explain_evidence_path",
  {
    profileId: "recon",
    text: "我之前说的那个计划，先做什么？",
    includePlannerTrace: true,
    maxSteps: 4,
  },
);
assert.equal(mcpExplainEvidencePath.isError, undefined);
assert.match(JSON.stringify(mcpExplainEvidencePath.structuredContent), /gmos\.evidence_path_explanation\.v1/);
assert.equal(JSON.stringify(mcpExplainEvidencePath.structuredContent).includes("contextBlock"), false);
assert.match(JSON.stringify(mcpExplainEvidencePath.structuredContent), /plannerTrace/);
const mcpExplainSensitive = await createMemoryMcpServer(reconstructionMemory).callTool(
  "memory.explain_evidence_path",
  {
    profileId: "recon",
    text: "Helio",
    includeSensitive: true,
  },
);
assert.equal(mcpExplainSensitive.isError, true);
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
const cliExplainPath = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "explain-path",
    "--db",
    reconstructionDb,
    "--profile",
    "recon",
    "--text",
    "我之前说的那个计划，先做什么？",
    "--include-trace",
    "--max-steps",
    "4",
    "--max-branch",
    "6",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliExplainPath.status, 0, cliExplainPath.stderr);
const cliExplainPathJson = JSON.parse(cliExplainPath.stdout) as {
  schema?: string;
  summary?: { convergenceReached?: boolean; evidenceCount?: number };
  plannerTrace?: unknown;
};
assert.equal(cliExplainPathJson.schema, "gmos.evidence_path_explanation.v1");
assert.equal(cliExplainPathJson.summary?.convergenceReached, true);
assert.ok((cliExplainPathJson.summary?.evidenceCount ?? 0) >= 2);
assert.equal(JSON.stringify(cliExplainPathJson).includes("contextBlock"), false);
assert.ok(cliExplainPathJson.plannerTrace);
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
assert.equal(cliStatusPayload.storage?.schemaVersion, 6);
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
assert.equal(gym.runManifest.sqliteSchemaVersion, 6);
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
assert.match(renderedGym, /SQLite schema: 6/);
const externalBenchmarkJsonl = [
  JSON.stringify({
    id: "project-next-step",
    events: [
      { type: "memory", kind: "project", content: "代号 Vega 的发布计划叫做 Lantern Run。" },
      {
        type: "memory",
        kind: "procedure",
        content: "Lantern Run 下一步先更新 rollback matrix，再做发布实现。",
      },
      { type: "memory", kind: "fact", content: "Lantern Run 的会议室记录在七楼。" },
    ],
    question: "Vega 这个发布计划下一步先做什么？",
    expectedAll: ["rollback matrix"],
    forbiddenAny: ["sk-external-secret"],
  }),
  JSON.stringify({
    id: "task-trajectory",
    events: [
      {
        type: "task",
        taskId: "atlas-retro",
        objective: "Atlas 复盘",
        status: "completed",
        summary: "先核证据链，再写风险清单。",
      },
    ],
    question: "Atlas 复盘以前沉淀的做法是什么？",
    expectedAny: ["证据链", "风险清单"],
  }),
].join("\n");
const externalBenchmarkFile = path.join(tmp, "external-long-memory-qa.jsonl");
writeFileSync(externalBenchmarkFile, externalBenchmarkJsonl);
const externalCases = parseExternalMemoryBenchmarkJsonl(externalBenchmarkJsonl);
assert.equal(externalCases.length, 2);
const parsedGmosExternalDataset = parseExternalMemoryBenchmarkDataset(externalBenchmarkJsonl, {
  adapter: "gmos",
});
assert.equal(parsedGmosExternalDataset.adapter, "gmos");
assert.equal(parsedGmosExternalDataset.datasetFormat, "gmos.external_long_memory_qa.jsonl");
assert.equal(parsedGmosExternalDataset.cases.length, 2);
const externalBenchmark = await runExternalMemoryBenchmark({ cases: externalCases });
assert.equal(externalBenchmark.pass, true);
assert.equal(externalBenchmark.score, 1);
assert.equal(externalBenchmark.runManifest.framework, "gmos-external-long-memory-qa");
assert.equal(externalBenchmark.runManifest.dataset.caseCount, 2);
assert.equal(externalBenchmark.runManifest.dataset.hash, null);
assert.equal(externalBenchmark.runManifest.execution.caseGroupCount, 2);
assert.equal(externalBenchmark.runManifest.execution.reusedProfileCaseCount, 0);
assert.equal(externalBenchmark.runManifest.options.concurrency >= 1, true);
assert.equal(externalBenchmark.runManifest.options.reuseProfiles, true);
assert.equal(externalBenchmark.runManifest.options.requireConvergence, false);
assert.equal(externalBenchmark.runManifest.options.failureSampleLimit, 20);
assert.deepEqual(externalBenchmark.summary.failureReasons, []);
assert.equal(externalBenchmark.summary.warnings.length > 0, true);
assert.equal(externalBenchmark.summary.failureSamples.length, 0);
assert.equal(externalBenchmark.cases[0]?.failureReasons.length, 0);
assert.equal(typeof externalBenchmark.cases[0]?.diagnostics.evidenceConvergenceScore, "number");
const externalHash = hashExternalMemoryBenchmarkInput(externalBenchmarkJsonl);
assert.match(externalHash, /^sha256:[a-f0-9]{64}$/);
const externalBenchmarkWithManifest = await runExternalMemoryBenchmark({
  cases: externalCases,
  datasetHash: externalHash,
  datasetId: "unit-fixture",
  requireConvergence: false,
});
assert.equal(externalBenchmarkWithManifest.runManifest.dataset.hash, externalHash);
assert.equal(externalBenchmarkWithManifest.runManifest.dataset.id, "unit-fixture");
const sparseExternalConvergence = await runExternalMemoryBenchmark({
  requireConvergence: true,
  cases: [
    {
      id: "sparse-project-next-step",
      events: [
        { type: "memory", kind: "project", content: "代号 Vega 的发布计划叫做 Lantern Run。" },
        {
          type: "memory",
          kind: "procedure",
          content: "Lantern Run 下一步先更新 rollback matrix，再做发布实现。",
        },
      ],
      question: "Vega 这个发布计划下一步先做什么？",
      expectedAll: ["rollback matrix"],
      forbiddenAny: ["会议室"],
    },
  ],
});
assert.equal(sparseExternalConvergence.pass, true);
assert.equal(sparseExternalConvergence.cases[0]?.diagnostics.evidenceConvergenceReached, true);
const externalFailureSummaryBenchmark = await runExternalMemoryBenchmark({
  failureSampleLimit: 1,
  cases: [
    {
      id: "missing-one",
      events: [{ type: "memory", kind: "fact", content: "Visible answer is Alpha." }],
      question: "What is visible?",
      expectedAll: ["Missing Alpha"],
    },
    {
      id: "missing-two",
      events: [{ type: "memory", kind: "fact", content: "Visible answer is Beta." }],
      question: "What is visible?",
      expectedAny: ["Missing Beta"],
    },
  ],
});
assert.equal(externalFailureSummaryBenchmark.pass, false);
assert.equal(externalFailureSummaryBenchmark.runManifest.options.failureSampleLimit, 1);
assert.deepEqual(externalFailureSummaryBenchmark.summary.failureReasons, [
  { name: "expected_all_missing", count: 1 },
  { name: "expected_any_missing", count: 1 },
]);
assert.equal(externalFailureSummaryBenchmark.summary.failureSamples.length, 1);
assert.equal(externalFailureSummaryBenchmark.summary.failureSamples[0]?.id, "missing-one");
assert.equal(
  externalFailureSummaryBenchmark.summary.failureSamples[0]?.expectedAllMissing[0],
  "Missing Alpha",
);
const longMemEvalFixture = JSON.stringify([
  {
    question_id: "lme-vega-next-step",
    question_type: "multi-session",
    question: "Vega 这个发布计划下一步先做什么？",
    answer: "rollback matrix",
    question_date: "2026-06-24",
    haystack_session_ids: ["session-1", "session-2"],
    haystack_dates: ["2026-06-20", "2026-06-21"],
    haystack_sessions: [
      [
        {
          role: "user",
          content: "代号 Vega 的项目计划叫做 Lantern Run。",
        },
      ],
      [
        {
          role: "user",
          content: "Lantern Run 的流程步骤是先更新 rollback matrix，再做发布实现。",
          has_answer: true,
        },
      ],
    ],
    answer_session_ids: ["session-2"],
  },
]);
const longMemEvalCases = parseLongMemEvalBenchmarkDataset(longMemEvalFixture);
assert.equal(longMemEvalCases.length, 1);
assert.equal(longMemEvalCases[0]?.id, "lme-vega-next-step");
assert.equal(longMemEvalCases[0]?.events.length, 2);
assert.equal(JSON.stringify(longMemEvalCases[0]?.events).includes("has_answer"), false);
assert.equal(JSON.stringify(longMemEvalCases[0]?.events).includes("answer_session_ids"), false);
const longMemEvalJsonlCases = parseLongMemEvalBenchmarkDataset(
  longMemEvalFixture.slice(1, -1),
);
assert.equal(longMemEvalJsonlCases.length, 1);
const longMemEvalAbstentionFixture = JSON.stringify([
  {
    question_id: "lme-unknown_abs",
    question: "What was never mentioned?",
    answer: "unknown",
    haystack_sessions: [[{ role: "user", content: "This project history has no answer." }]],
  },
  {
    question_id: "lme-answerable",
    question: "What workflow is answerable?",
    answer: "answerable matrix",
    haystack_sessions: [[{ role: "user", content: "The project workflow uses answerable matrix." }]],
  },
]);
const parsedLongMemEvalWithAbstention = parseExternalMemoryBenchmarkDataset(
  longMemEvalAbstentionFixture,
  { adapter: "longmemeval" },
);
assert.equal(parsedLongMemEvalWithAbstention.cases.length, 1);
assert.deepEqual(parsedLongMemEvalWithAbstention.warnings, [
  "skipped_longmemeval_abstention:lme-unknown_abs",
]);
const parsedLongMemEvalDataset = parseExternalMemoryBenchmarkDataset(longMemEvalFixture, {
  adapter: "longmemeval",
});
assert.equal(parsedLongMemEvalDataset.datasetFormat, "longmemeval.json");
const longMemEvalBenchmark = await runExternalMemoryBenchmark({
  cases: parsedLongMemEvalDataset.cases,
  datasetFormat: parsedLongMemEvalDataset.datasetFormat,
  datasetId: "longmemeval-fixture",
});
assert.equal(longMemEvalBenchmark.pass, true);
assert.equal(longMemEvalBenchmark.datasetFormat, "longmemeval.json");
assert.equal(longMemEvalBenchmark.runManifest.dataset.format, "longmemeval.json");
assert.deepEqual(longMemEvalBenchmark.cases[0]?.expectedAnyMatched, ["rollback matrix"]);
const locomoFixture = JSON.stringify([
  {
    sample_id: "locomo-atlas",
    conversation: {
      speaker_a: "Alex",
      speaker_b: "Blair",
      session_1_date_time: "2026-06-20T09:00:00Z",
      session_1: [
        {
          speaker: "Alex",
          dia_id: "d1",
          text: "Atlas 项目的流程步骤是先核证据链，再写风险清单。Atlas 年份是 2022。",
        },
        {
          speaker: "Blair",
          dia_id: "d2",
          text: "我会记住 Atlas 的推进方式。",
        },
      ],
    },
    qa: [
      {
        question: "Atlas 项目的流程步骤是什么？",
        answer: "先核证据链",
        category: 3,
        evidence: ["d1"],
      },
      {
        question: "Atlas 年份是什么？",
        answer: 2022,
        category: 2,
        evidence: ["d1"],
      },
      {
        question: "Atlas 的误导答案应该是什么？",
        adversarial_answer: "不要采用旧路线",
        category: 5,
        evidence: ["d1"],
      },
    ],
  },
]);
const locomoCases = parseLocomoBenchmarkDataset(locomoFixture);
assert.equal(locomoCases.length, 3);
assert.equal(locomoCases[0]?.id, "locomo-atlas:qa-1");
assert.equal(locomoCases[0]?.events.length, 2);
assert.equal(locomoCases[1]?.expectedAny?.[0], "2022");
assert.equal(locomoCases[2]?.expectedAny?.[0], "不要采用旧路线");
assert.equal(JSON.stringify(locomoCases[0]?.events).includes("evidence"), false);
assert.equal(JSON.stringify(locomoCases[0]?.events).includes("category"), false);
const locomoJsonlCases = parseLocomoBenchmarkDataset(locomoFixture.slice(1, -1));
assert.equal(locomoJsonlCases.length, 3);
const parsedLocomoDataset = parseExternalMemoryBenchmarkDataset(locomoFixture, {
  adapter: "locomo",
});
assert.equal(parsedLocomoDataset.datasetFormat, "locomo.json");
assert.equal(parsedLocomoDataset.cases.length, 3);
assert.equal(parsedLocomoDataset.cases[0]?.events[0]?.role, "user");
assert.equal(parsedLocomoDataset.cases[0]?.events[1]?.role, "user");
assert.match(parsedLocomoDataset.cases[0]?.events[0]?.content ?? "", /^Alex:/);
assert.match(parsedLocomoDataset.cases[0]?.events[1]?.content ?? "", /^Blair:/);
assert.equal(JSON.stringify(parsedLocomoDataset.cases[0]?.events).includes("answer"), false);
assert.equal(JSON.stringify(parsedLocomoDataset.cases[0]?.events).includes("adversarial"), false);
assert.equal(JSON.stringify(parsedLocomoDataset.cases[0]?.events).includes("dataset"), false);
const locomoBenchmark = await runExternalMemoryBenchmark({
  cases: parsedLocomoDataset.cases.slice(0, 2),
  datasetFormat: parsedLocomoDataset.datasetFormat,
  datasetId: "locomo-fixture",
  concurrency: 1,
});
assert.equal(locomoBenchmark.pass, true);
assert.equal(locomoBenchmark.datasetFormat, "locomo.json");
assert.equal(locomoBenchmark.runManifest.dataset.format, "locomo.json");
assert.equal(locomoBenchmark.runManifest.execution.caseGroupCount, 1);
assert.equal(locomoBenchmark.runManifest.execution.reusedProfileCaseCount, 1);
assert.equal(locomoBenchmark.runManifest.options.concurrency, 1);
assert.equal(locomoBenchmark.runManifest.options.reuseProfiles, true);
assert.deepEqual(locomoBenchmark.cases[0]?.expectedAnyMatched, ["先核证据链"]);
assert.deepEqual(locomoBenchmark.cases[1]?.expectedAnyMatched, ["2022"]);
const locomoHumanSpeakerFixture = JSON.stringify([
  {
    sample_id: "locomo-human-speakers",
    conversation: {
      speaker_a: "Alex",
      speaker_b: "Blair",
      session_1_date_time: "2026-06-20T09:00:00Z",
      session_1: [
        {
          speaker: "Alex",
          text: "What did you paint recently?",
        },
        {
          speaker: "Blair",
          text: "I painted a sunrise in 2022 after the charity race.",
        },
      ],
    },
    qa: [
      {
        question: "When did Blair paint a sunrise?",
        answer: "2022",
      },
    ],
  },
]);
const locomoHumanSpeakerCases = parseLocomoBenchmarkDataset(locomoHumanSpeakerFixture);
assert.equal(locomoHumanSpeakerCases[0]?.events[1]?.role, "user");
assert.match(locomoHumanSpeakerCases[0]?.events[1]?.content ?? "", /^Blair:/);
const locomoHumanSpeakerBenchmark = await runExternalMemoryBenchmark({
  cases: locomoHumanSpeakerCases,
  datasetFormat: "locomo.json",
});
assert.equal(locomoHumanSpeakerBenchmark.pass, true);
assert.deepEqual(locomoHumanSpeakerBenchmark.cases[0]?.expectedAnyMatched, ["2022"]);
const locomoNoReuseBenchmark = await runExternalMemoryBenchmark({
  cases: parsedLocomoDataset.cases.slice(0, 2),
  datasetFormat: parsedLocomoDataset.datasetFormat,
  datasetId: "locomo-fixture",
  reuseProfiles: false,
});
assert.equal(locomoNoReuseBenchmark.pass, true);
assert.equal(locomoNoReuseBenchmark.runManifest.execution.caseGroupCount, 2);
assert.equal(locomoNoReuseBenchmark.runManifest.execution.reusedProfileCaseCount, 0);
const locomoProgressEvents: string[] = [];
const locomoProgressBenchmark = await runExternalMemoryBenchmark({
  cases: parsedLocomoDataset.cases.slice(0, 2),
  onCaseResult: (progress) => {
    locomoProgressEvents.push(`${progress.completedCount}/${progress.totalCount}:${progress.caseId}`);
  },
});
assert.equal(locomoProgressBenchmark.pass, true);
assert.deepEqual(locomoProgressEvents, [
  "1/2:locomo-atlas:qa-1",
  "2/2:locomo-atlas:qa-2",
]);
const sameProfileDifferentEventsBenchmark = await runExternalMemoryBenchmark({
  cases: [
    {
      id: "shared-profile-alpha",
      profileId: "shared-profile",
      events: [{ type: "memory", kind: "fact", content: "Shared profile answer is Alpha route." }],
      question: "What is the shared profile answer?",
      expectedAny: ["Alpha route"],
      forbiddenAny: ["Beta route"],
    },
    {
      id: "shared-profile-beta",
      profileId: "shared-profile",
      events: [{ type: "memory", kind: "fact", content: "Shared profile answer is Beta route." }],
      question: "What is the shared profile answer?",
      expectedAny: ["Beta route"],
      forbiddenAny: ["Alpha route"],
    },
  ],
});
assert.equal(sameProfileDifferentEventsBenchmark.pass, true);
assert.equal(sameProfileDifferentEventsBenchmark.runManifest.execution.caseGroupCount, 2);
assert.equal(sameProfileDifferentEventsBenchmark.runManifest.execution.reusedProfileCaseCount, 0);
const concurrentOrderBenchmark = await runExternalMemoryBenchmark({
  concurrency: 2,
  cases: [
    {
      id: "order-slower-first",
      events: Array.from({ length: 25 }, (_, index) => ({
        type: "memory" as const,
        kind: "fact" as const,
        content: `Order benchmark filler ${index}.`,
      })).concat([
        { type: "memory" as const, kind: "fact" as const, content: "Order benchmark answer is first." },
      ]),
      question: "What is the order benchmark answer?",
      expectedAny: ["first"],
    },
    {
      id: "order-fast-second",
      events: [{ type: "memory", kind: "fact", content: "Order benchmark answer is second." }],
      question: "What is the order benchmark answer?",
      expectedAny: ["second"],
    },
  ],
});
assert.equal(concurrentOrderBenchmark.pass, true);
assert.deepEqual(concurrentOrderBenchmark.cases.map((entry) => entry.id), [
  "order-slower-first",
  "order-fast-second",
]);
const stateBenchTrainDir = path.join(tmp, "statebench-train", "travel");
mkdirSync(stateBenchTrainDir, { recursive: true });
writeFileSync(
  path.join(stateBenchTrainDir, "001-booking.json"),
  JSON.stringify({
    conversation: [
      { role: "system", content: "synthetic state bench system prompt" },
      {
        role: "user",
        content: "sk-statebenchusersecret1234567890 Please book a refundable flight using points.",
      },
      {
        role: "assistant",
        content: "I will check the user's account and available flights.",
        tool_calls: [
          {
            name: "get_user_details",
            arguments: { user_id: "user_001" },
            result: { loyalty_points: 50000, secret: "sk-statebenchresultsecret1234567890" },
          },
          {
            name: "search_flights",
            arguments: { origin: "JFK", destination: "SFO" },
            result: { flights: [{ flight_id: "DL100" }] },
          },
          {
            name: "book_flight",
            arguments: { confirm: false },
            result: { preview: true },
          },
          {
            name: "book_flight",
            arguments: { confirm: true },
            result: { booking_id: "booking_001" },
          },
        ],
      },
    ],
  }),
);
writeFileSync(
  path.join(stateBenchTrainDir, "002-no-tools.json"),
  JSON.stringify({
    conversation: [
      { role: "user", content: "No tools here." },
      { role: "assistant", content: "No reusable procedure." },
    ],
  }),
);
writeFileSync(path.join(stateBenchTrainDir, "003-invalid.json"), JSON.stringify([]));
const stateBenchArtifact = buildStateBenchLearnings({
  domain: "travel",
  inputDir: stateBenchTrainDir,
  maxItems: 10,
  allowNonTrainInput: true,
});
const stateBenchArtifactAgain = buildStateBenchLearnings({
  domain: "travel",
  inputDir: stateBenchTrainDir,
  maxItems: 10,
  allowNonTrainInput: true,
});
assert.deepEqual(stateBenchArtifactAgain, stateBenchArtifact);
assert.equal(stateBenchArtifact.schema, "gmos.state_bench_learnings.v1");
assert.equal(stateBenchArtifact.framework, "state-bench-agent-learning-track");
assert.deepEqual(stateBenchArtifact.source, {
  protocol: "state-bench-agent-learning-track",
  input: "datasets/train_task_trajectories",
  domain: "travel",
});
assert.equal(stateBenchArtifact.itemCount, 1);
assert.equal(stateBenchArtifact.learnings[0]?.domain, "travel");
assert.equal(stateBenchArtifact.learnings[0]?.queryHint, "001 booking");
assert.match(stateBenchArtifact.learnings[0]?.content ?? "", /get_user_details -> search_flights -> book_flight\(preview\) -> book_flight\(confirmed\)/);
assert.equal(JSON.stringify(stateBenchArtifact).includes("sk-statebenchresultsecret"), false);
assert.equal(JSON.stringify(stateBenchArtifact).includes("sk-statebenchusersecret"), false);
assert.equal(JSON.stringify(stateBenchArtifact).includes("Please book a refundable flight"), false);
assert.equal(JSON.stringify(stateBenchArtifact).includes(stateBenchTrainDir), false);
assert.throws(
  () =>
    buildStateBenchLearnings({
      domain: "travel",
      inputDir: stateBenchTrainDir,
    }),
  /datasets\/train_task_trajectories/,
);
assert.throws(
  () =>
    buildStateBenchLearnings({
      domain: "travel",
      inputDir: path.join(tmp, "datasets", "train_task_trajectories", "travel"),
    }),
  /train trajectory directory does not exist/,
);
assert.equal(
  stateBenchArtifact.warnings.some((warning) => warning.includes("skipped_no_tool_calls")),
  true,
);
assert.equal(
  stateBenchArtifact.warnings.some((warning) => warning === "skipped_invalid_json:003-invalid.json:invalid_trajectory"),
  true,
);
const stateBenchAgentTemplate = stateBenchAgentPythonTemplate();
assert.match(stateBenchAgentTemplate, /class GmosMemoryAgent\(StateBenchAgent\)/);
assert.match(stateBenchAgentTemplate, /def retrieve_learnings/);
const stateBenchCheckoutDir = path.join(tmp, "STATE-Bench");
const stateBenchOfficialTrainDir = path.join(
  stateBenchCheckoutDir,
  "datasets",
  "train_task_trajectories",
  "travel",
);
mkdirSync(stateBenchOfficialTrainDir, { recursive: true });
writeFileSync(
  path.join(stateBenchOfficialTrainDir, "001-booking.json"),
  readFileSync(path.join(stateBenchTrainDir, "001-booking.json"), "utf8"),
);
writeFileSync(
  path.join(stateBenchOfficialTrainDir, "002-no-tools.json"),
  readFileSync(path.join(stateBenchTrainDir, "002-no-tools.json"), "utf8"),
);
const preparedStateBench = prepareStateBenchAgentLearningRun({
  domain: "travel",
  checkoutDir: stateBenchCheckoutDir,
  agentModelName: "gpt-test-statebench",
  agentModelReasoningLevel: "medium",
  numWorkers: 2,
  manifestFile: "outputs/gmos-learnings/travel.prepare.json",
});
assert.equal(preparedStateBench.schema, "gmos.state_bench_prepare_run.v1");
assert.equal(preparedStateBench.officialSettings.agentClass, "GmosMemoryAgent");
assert.equal(preparedStateBench.officialSettings.retrieveLearningsTopK, 3);
assert.equal(preparedStateBench.officialSettings.numRuns, 5);
assert.equal(preparedStateBench.officialSettings.numWorkers, 2);
assert.equal(preparedStateBench.officialSettings.agentModelReasoningLevel, "medium");
assert.equal(preparedStateBench.artifacts.learningsFile, "outputs/gmos-learnings/travel.json");
assert.equal(preparedStateBench.artifacts.agentFile, "agents/gmos_memory_agent.py");
assert.equal(preparedStateBench.artifacts.outputDir, "outputs/travel");
assert.equal(preparedStateBench.artifacts.manifestFile, "outputs/gmos-learnings/travel.prepare.json");
assert.deepEqual(preparedStateBench.source, {
  protocol: "state-bench-agent-learning-track",
  input: "datasets/train_task_trajectories",
  domain: "travel",
});
assert.equal(preparedStateBench.learnings.itemCount, 1);
assert.equal(preparedStateBench.environment.GMOS_STATE_BENCH_LEARNINGS_PATH, "outputs/gmos-learnings/travel.json");
assert.deepEqual(
  preparedStateBench.commands.runBatch.slice(0, 7),
  [
    "uv",
    "run",
    "python",
    "-m",
    "state_bench.scripts.run_batch",
    "--domain",
    "travel",
  ],
);
assert.equal(preparedStateBench.commands.runBatch.includes("--retrieve-learnings-top-k"), true);
assert.equal(
  preparedStateBench.commands.runBatch[
    preparedStateBench.commands.runBatch.indexOf("--retrieve-learnings-top-k") + 1
  ],
  "3",
);
assert.equal(preparedStateBench.commands.runBatch.includes("--agent-model-reasoning-level"), true);
assert.equal(preparedStateBench.commands.computeMetrics.includes("state_bench.scripts.compute_metrics"), true);
assert.equal(existsSync(path.join(stateBenchCheckoutDir, preparedStateBench.artifacts.learningsFile)), true);
assert.equal(existsSync(path.join(stateBenchCheckoutDir, preparedStateBench.artifacts.agentFile)), true);
assert.equal(existsSync(path.join(stateBenchCheckoutDir, preparedStateBench.artifacts.manifestFile!)), true);
const preparedStateBenchManifest = JSON.parse(
  readFileSync(path.join(stateBenchCheckoutDir, preparedStateBench.artifacts.manifestFile!), "utf8"),
);
assert.deepEqual(preparedStateBenchManifest, preparedStateBench);
assert.equal(JSON.stringify(preparedStateBench).includes(stateBenchCheckoutDir), false);
assert.equal(JSON.stringify(preparedStateBench).includes("sk-statebenchusersecret"), false);
assert.equal(JSON.stringify(preparedStateBench).includes("Please book a refundable flight"), false);
const preparedStateBenchAgain = prepareStateBenchAgentLearningRun({
  domain: "travel",
  checkoutDir: stateBenchCheckoutDir,
  agentModelName: "gpt-test-statebench",
  manifestFile: "outputs/gmos-learnings/travel.prepare.json",
});
assert.equal(preparedStateBenchAgain.schema, "gmos.state_bench_prepare_run.v1");
writeFileSync(path.join(stateBenchCheckoutDir, preparedStateBench.artifacts.agentFile), "# custom local edits\n");
assert.throws(
  () =>
    prepareStateBenchAgentLearningRun({
      domain: "travel",
      checkoutDir: stateBenchCheckoutDir,
      agentModelName: "gpt-test-statebench",
    }),
  /agent file exists/,
);
const forcedPreparedStateBench = prepareStateBenchAgentLearningRun({
  domain: "travel",
  checkoutDir: stateBenchCheckoutDir,
  agentModelName: "gpt-test-statebench",
  force: true,
});
assert.equal(forcedPreparedStateBench.schema, "gmos.state_bench_prepare_run.v1");
assert.throws(
  () =>
    prepareStateBenchAgentLearningRun({
      domain: "travel",
      checkoutDir: stateBenchCheckoutDir,
      agentModelName: "gpt-test-statebench",
      learningsFile: "../leak.json",
    }),
  /inside the STATE-Bench checkout/,
);
assert.throws(
  () =>
    prepareStateBenchAgentLearningRun({
      domain: "travel",
      checkoutDir: stateBenchCheckoutDir,
      agentModelName: "gpt-test-statebench",
      learningsFile: "outputs/gmos-learnings/same.json",
      manifestFile: "outputs/gmos-learnings/same.json",
    }),
  /must not reuse/,
);
const stateBenchResultsDir = path.join(stateBenchCheckoutDir, "outputs", "travel");
mkdirSync(path.join(stateBenchResultsDir, "run1"), { recursive: true });
mkdirSync(path.join(stateBenchResultsDir, "run2"), { recursive: true });
mkdirSync(path.join(stateBenchResultsDir, "per_task_metrics"), { recursive: true });
writeFileSync(path.join(stateBenchResultsDir, "run1", "task-a.json"), "{}");
writeFileSync(path.join(stateBenchResultsDir, "run2", "task-a.json"), "{}");
writeFileSync(path.join(stateBenchResultsDir, "per_task_metrics", "task-a.json"), "{}");
writeFileSync(
  path.join(stateBenchResultsDir, "metrics.json"),
  JSON.stringify(
    {
      benchmark_version: "state-bench-test",
      timestamp: "2026-06-26T00:00:00Z",
      evaluation_protocol_id: "state-bench-protocol-test",
      num_runs: 2,
	      agent_model: {
	        model_name: "gpt-test-statebench",
	        reasoning_level: "medium",
	        api_key: "sk-statebenchmetricssecret1234567890",
	        nested: { token: "sk-statebenchnestedsecret1234567890" },
	      },
      metrics: {
        "task_completion_pass@1": 0.75,
        "task_completion_pass@1_std_dev": 0.1,
        "task_completion_pass^2": 0.5,
        mean_ux_score: 4.2,
        mean_cost_usd: 0.0123,
        ignored_string: "not copied",
      },
    },
    null,
    2,
  ),
);
const stateBenchSummary = summarizeStateBenchResults({
  domain: "travel",
  checkoutDir: stateBenchCheckoutDir,
  prepareManifestFile: "outputs/gmos-learnings/travel.prepare.json",
});
assert.equal(stateBenchSummary.schema, "gmos.state_bench_results_summary.v1");
assert.equal(stateBenchSummary.source.metricsFile, "outputs/travel/metrics.json");
assert.equal(stateBenchSummary.source.resultsDir, "outputs/travel");
assert.equal(stateBenchSummary.source.prepareManifestFile, "outputs/gmos-learnings/travel.prepare.json");
assert.equal(stateBenchSummary.officialMetrics.benchmarkVersion, "state-bench-test");
assert.equal(stateBenchSummary.officialMetrics.evaluationProtocolId, "state-bench-protocol-test");
assert.equal(stateBenchSummary.officialMetrics.numRuns, 2);
assert.equal(
  (stateBenchSummary.officialMetrics.agentModel as { model_name?: string }).model_name,
  "gpt-test-statebench",
);
assert.equal(JSON.stringify(stateBenchSummary).includes("sk-statebenchmetricssecret"), false);
assert.equal(JSON.stringify(stateBenchSummary).includes("sk-statebenchnestedsecret"), false);
assert.equal(stateBenchSummary.officialMetrics.metrics["task_completion_pass@1"], 0.75);
assert.equal(stateBenchSummary.officialMetrics.metrics.ignored_string, undefined);
assert.equal(stateBenchSummary.preparedRun?.retrieveLearningsTopK, 3);
assert.equal(stateBenchSummary.preparedRun?.agentModelName, "gpt-test-statebench");
assert.equal(stateBenchSummary.coverage.runDirectoryCount, 2);
assert.equal(stateBenchSummary.coverage.trajectoryFileCount, 2);
assert.equal(stateBenchSummary.coverage.perTaskMetricsCount, 1);
assert.deepEqual(stateBenchSummary.coverage.perRunTrajectoryFileCounts, [
  { run: "run1", count: 1 },
  { run: "run2", count: 1 },
]);
assert.equal(stateBenchSummary.validation.status, "warning");
assert.equal(
  stateBenchSummary.validation.warnings.includes("prepare_manifest_num_runs_mismatch"),
  true,
);
assert.equal(JSON.stringify(stateBenchSummary).includes(stateBenchCheckoutDir), false);
assert.equal(JSON.stringify(stateBenchSummary).includes("sk-statebenchusersecret"), false);
const maliciousPrepareManifestPath = path.join(
  stateBenchCheckoutDir,
  "outputs",
  "gmos-learnings",
  "travel-malicious.prepare.json",
);
const outsideStateBenchArtifactPath = path.join(tmp, "outside-statebench-artifact.json");
writeFileSync(
  maliciousPrepareManifestPath,
  JSON.stringify({
    ...preparedStateBench,
    artifacts: {
      ...preparedStateBench.artifacts,
      learningsFile: outsideStateBenchArtifactPath,
      agentFile: "../outside-agent.py",
    },
    officialSettings: {
      ...preparedStateBench.officialSettings,
      numRuns: 2,
    },
  }),
);
const maliciousPrepareSummary = summarizeStateBenchResults({
  domain: "travel",
  checkoutDir: stateBenchCheckoutDir,
  prepareManifestFile: "outputs/gmos-learnings/travel-malicious.prepare.json",
});
assert.equal(maliciousPrepareSummary.validation.status, "warning");
assert.equal(
  maliciousPrepareSummary.validation.warnings.includes("prepare_manifest_learnings_file_unsafe"),
  true,
);
assert.equal(
  maliciousPrepareSummary.validation.warnings.includes("prepare_manifest_agent_file_unsafe"),
  true,
);
assert.equal(maliciousPrepareSummary.preparedRun?.learningsFile, undefined);
assert.equal(maliciousPrepareSummary.preparedRun?.agentFile, undefined);
assert.equal(JSON.stringify(maliciousPrepareSummary).includes(outsideStateBenchArtifactPath), false);
const symlinkOutsideResultsDir = path.join(tmp, "statebench-outside-results");
mkdirSync(symlinkOutsideResultsDir, { recursive: true });
writeFileSync(
  path.join(symlinkOutsideResultsDir, "metrics.json"),
  JSON.stringify({
    num_runs: 1,
    metrics: {
      "task_completion_pass@1": 1,
    },
  }),
);
try {
  symlinkSync(symlinkOutsideResultsDir, path.join(stateBenchCheckoutDir, "outputs", "symlinked-results"), "dir");
  assert.throws(
    () =>
      summarizeStateBenchResults({
        domain: "travel",
        checkoutDir: stateBenchCheckoutDir,
        resultsDir: "outputs/symlinked-results",
        metricsFile: "outputs/symlinked-results/metrics.json",
      }),
    /inside the STATE-Bench checkout/,
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") {
    throw error;
  }
}
try {
  symlinkSync(
    path.join(symlinkOutsideResultsDir, "metrics.json"),
    path.join(stateBenchResultsDir, "linked-metrics.json"),
    "file",
  );
  assert.throws(
    () =>
      summarizeStateBenchResults({
        domain: "travel",
        checkoutDir: stateBenchCheckoutDir,
        metricsFile: "outputs/travel/linked-metrics.json",
      }),
    /inside the STATE-Bench checkout/,
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") {
    throw error;
  }
}
assert.throws(
  () =>
    summarizeStateBenchResults({
      domain: "travel",
      checkoutDir: stateBenchCheckoutDir,
      metricsFile: "../metrics.json",
    }),
  /inside the STATE-Bench checkout/,
);
assert.throws(
  () =>
    summarizeStateBenchResults({
      domain: "travel",
      checkoutDir: stateBenchCheckoutDir,
      metricsFile: "outputs/travel/missing.json",
    }),
  /metrics file does not exist/,
);
const stateBenchTrainFilePath = path.join(
  stateBenchCheckoutDir,
  "datasets",
  "train_task_trajectories",
  "customer_support",
);
mkdirSync(path.dirname(stateBenchTrainFilePath), { recursive: true });
writeFileSync(stateBenchTrainFilePath, "not a directory");
assert.throws(
  () =>
    buildStateBenchLearnings({
      domain: "customer_support",
      inputDir: stateBenchTrainFilePath,
    }),
  /train trajectory directory does not exist/,
);
const externalMarkdown = renderExternalMemoryBenchmarkMarkdown(externalBenchmarkWithManifest);
assert.match(externalMarkdown, /External Long-Memory QA/);
assert.match(externalMarkdown, /Run Manifest/);
assert.match(externalMarkdown, /format=gmos\.external_long_memory_qa\.jsonl/);
assert.match(externalMarkdown, /## Summary/);
assert.match(externalMarkdown, /## Failure Samples/);
assert.match(externalMarkdown, /Failure reasons/);
assert.match(externalMarkdown, /Missing intent groups/);
assert.throws(
  () =>
    parseExternalMemoryBenchmarkDataset(externalBenchmarkJsonl, {
      adapter: "beam",
    }),
  /adapter must be gmos, longmemeval, or locomo/,
);
const externalConvergenceFailure = await runExternalMemoryBenchmark({
  cases: [
    {
      id: "missing-boundary-convergence",
      requireConvergence: true,
      events: [
        { type: "memory", kind: "project", content: "代号 Vega 的发布计划叫做 Lantern Run。" },
        {
          type: "memory",
          kind: "procedure",
          content: "Lantern Run 下一步先更新 rollback matrix，再做发布实现。",
        },
      ],
      question: "Vega 这个发布计划下一步先做什么，哪些不要主动做？",
      expectedAll: ["rollback matrix"],
    },
  ],
});
assert.equal(externalConvergenceFailure.pass, false);
assert.deepEqual(externalConvergenceFailure.cases[0]?.failureReasons, [
  "convergence_not_reached",
]);
assert.equal(
  externalConvergenceFailure.cases[0]?.diagnostics.missingRequiredIntentGroups.includes(
    "boundary",
  ),
  true,
);
assert.match(
  renderExternalMemoryBenchmarkMarkdown(externalConvergenceFailure),
  /convergence_not_reached/,
);
assert.match(
  renderExternalMemoryBenchmarkMarkdown(externalConvergenceFailure),
  /boundary/,
);
await assert.rejects(
  () =>
    runExternalMemoryBenchmark({
      cases: [
        {
          id: "empty-assertions",
          events: [{ type: "memory", kind: "fact", content: "用户喜欢先讲风险。" }],
          question: "用户喜欢什么？",
        },
      ],
    }),
  /requires at least one expected or forbidden assertion/,
);
assert.throws(
  () => parseExternalMemoryBenchmarkJsonl("{not-json"),
  /invalid JSON/,
);
assert.throws(
  () =>
    parseExternalMemoryBenchmarkJsonl(
      JSON.stringify({
        id: "invalid-mode",
        mode: "agent",
        events: [{ content: "用户喜欢先讲风险。" }],
        question: "用户喜欢什么？",
        expectedAll: ["风险"],
      }),
    ),
  /mode must be prepare or reconstruct/,
);
const escapedExternalMarkdown = renderExternalMemoryBenchmarkMarkdown({
  ...externalBenchmark,
  cases: [
    {
      ...externalBenchmark.cases[0]!,
      id: "case|pipe",
      pass: false,
      forbiddenMatches: ["line|break\nvalue"],
    },
  ],
});
assert.match(escapedExternalMarkdown, /case\\\|pipe/);
assert.match(escapedExternalMarkdown, /line\\\|break value/);
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
assert.equal(scale.results[0]?.reconstructContext.samples, 3);
assert.equal(scale.results[0]?.contextNoHitSearch.samples, 3);
assert.ok((scale.results[0]?.reconstructedPathCount.p95 ?? 0) > 0);
assert.match(renderMemoryScaleMarkdown(scale), /gmOS Memory Scale Benchmark/);
assert.match(renderMemoryScaleMarkdown(scale), /reconstructContext/);
assert.match(renderMemoryScaleMarkdown(scale), /contextNoHitSearch/);
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
assert.deepEqual(releaseGate.components.scale.failedOperations, []);
assert.equal(releaseGate.components.diagnostics.pass, true);
assert.equal(releaseGate.components.diagnostics.encrypted, false);
assert.equal(releaseGate.components.diagnostics.readAuditStatus, "ok");
assert.equal(releaseGate.components.diagnostics.readAuditTableCount >= 10, true);
assert.equal(releaseGate.components.diagnostics.readPathSideEffectsChecked, true);
assert.equal(releaseGate.reports.diagnostics.trustContract.encrypted, false);
assert.equal(releaseGate.reports.diagnostics.trustContract.readPathSideEffectsChecked, true);
assert.equal(releaseGate.inputs.actualHostReports, 0);
const releaseGateMarkdown = renderMemoryReleaseGateMarkdown(releaseGate);
assert.match(releaseGateMarkdown, /gmOS Release Gate Report/);
assert.match(releaseGateMarkdown, /readAudit=ok/);
const failedReleaseGate = await runMemoryReleaseGate({
  generatedSeeds: 1,
  scaleSizes: [10],
  scaleThresholdP95Ms: 0,
  hosts: ["ghast"],
});
assert.equal(failedReleaseGate.pass, false);
assert.equal(failedReleaseGate.releaseConfidence, "action_required");
assert.deepEqual(failedReleaseGate.components.scale.failedSizes, [10]);
assert.ok(
  failedReleaseGate.components.scale.failedOperations.some(
    (failure) => failure.operation === "reconstructContext",
  ),
);
const failedReleaseGateMarkdown = renderMemoryReleaseGateMarkdown(failedReleaseGate);
assert.match(failedReleaseGateMarkdown, /scale:10:reconstructContext/);
assert.doesNotMatch(failedReleaseGateMarkdown, /^- scale:10$/m);
const legacyReleaseGateMarkdown = renderMemoryReleaseGateMarkdown({
  ...failedReleaseGate,
  components: {
    ...failedReleaseGate.components,
    scale: {
      ...failedReleaseGate.components.scale,
      failedOperations: undefined,
    },
  },
});
assert.match(legacyReleaseGateMarkdown, /^- scale:10$/m);
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
    readAudit?: {
      status?: string;
      schema?: string;
      tableCount?: number;
      rowCountTotal?: number;
      missingTables?: string[];
      hashesAvailable?: boolean;
      stateHash?: string;
    };
    hostCompatibility?: { level?: string; gaps?: string[] };
    searchIndex?: { status?: string; missingEntryCount?: number; vectorIndex?: { status?: string } };
  };
  assert.equal(doctorJson.encrypted, false);
  assert.equal(doctorJson.schema?.dialect, "sqlite");
  assert.equal(doctorJson.schema?.version, 6);
  assert.equal(doctorJson.readAudit?.status, "ok");
  assert.equal(doctorJson.readAudit?.schema, "gmos.read_audit_snapshot.v1");
  assert.equal((doctorJson.readAudit?.tableCount ?? 0) >= 10, true);
  assert.equal(doctorJson.readAudit?.hashesAvailable, true);
  assert.equal(doctorJson.readAudit?.stateHash, undefined);
  assert.equal(doctorJson.hostCompatibility?.level, expectedLevel);
  assert.equal(doctorJson.searchIndex?.status, "ok");
  assert.equal(doctorJson.searchIndex?.missingEntryCount, 0);
  assert.equal(doctorJson.searchIndex?.vectorIndex?.status, "ok");
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
const cliExternalJsonFile = path.join(tmp, "cli-external-report.json");
const cliExternalMarkdownFile = path.join(tmp, "cli-external-report.md");
const cliExternal = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    externalBenchmarkFile,
    "--format",
    "json",
    "--json-file",
    cliExternalJsonFile,
    "--markdown-file",
    cliExternalMarkdownFile,
    "--failure-sample-limit",
    "3",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliExternal.status, 0, cliExternal.stderr);
const cliExternalJson = JSON.parse(cliExternal.stdout) as {
  schema?: string;
  pass?: boolean;
  runManifest?: {
    dataset?: { format?: string; hash?: string | null; id?: string | null };
    options?: { requireConvergence?: boolean; failureSampleLimit?: number };
  };
  summary?: { failureSampleLimit?: number };
};
assert.equal(cliExternalJson.schema, "gmos.external_long_memory_qa.v1");
assert.equal(cliExternalJson.pass, true);
assert.equal(cliExternalJson.runManifest?.dataset?.format, "gmos.external_long_memory_qa.jsonl");
assert.match(cliExternalJson.runManifest?.dataset?.hash ?? "", /^sha256:[a-f0-9]{64}$/);
assert.equal(cliExternalJson.runManifest?.dataset?.id, path.basename(externalBenchmarkFile));
assert.equal(cliExternalJson.runManifest?.options?.requireConvergence, false);
assert.equal(cliExternalJson.runManifest?.options?.failureSampleLimit, 3);
assert.equal(cliExternalJson.summary?.failureSampleLimit, 3);
assert.equal(existsSync(cliExternalJsonFile), true);
assert.equal(existsSync(cliExternalMarkdownFile), true);
assert.equal(JSON.parse(readFileSync(cliExternalJsonFile, "utf8")).schema, "gmos.external_long_memory_qa.v1");
assert.match(readFileSync(cliExternalMarkdownFile, "utf8"), /gmOS External Long-Memory QA Benchmark/);
assert.match(readFileSync(cliExternalMarkdownFile, "utf8"), /Failure sample limit: 3/);
const cliExternalMissingJsonFileValue = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    externalBenchmarkFile,
    "--json-file",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliExternalMissingJsonFileValue.status, 0);
assert.match(cliExternalMissingJsonFileValue.stderr, /--json-file requires a value/);
const longMemEvalFixtureFile = path.join(tmp, "longmemeval-fixture.json");
writeFileSync(longMemEvalFixtureFile, longMemEvalFixture);
const cliLongMemEvalExternal = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    longMemEvalFixtureFile,
    "--dataset-format",
    "longmemeval",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliLongMemEvalExternal.status, 0, cliLongMemEvalExternal.stderr);
const cliLongMemEvalJson = JSON.parse(cliLongMemEvalExternal.stdout) as {
  pass?: boolean;
  datasetFormat?: string;
  runManifest?: { dataset?: { format?: string; id?: string | null } };
};
assert.equal(cliLongMemEvalJson.pass, true);
assert.equal(cliLongMemEvalJson.datasetFormat, "longmemeval.json");
assert.equal(cliLongMemEvalJson.runManifest?.dataset?.format, "longmemeval.json");
assert.equal(cliLongMemEvalJson.runManifest?.dataset?.id, path.basename(longMemEvalFixtureFile));
const locomoFixtureFile = path.join(tmp, "locomo-fixture.json");
writeFileSync(
  locomoFixtureFile,
  JSON.stringify([
    {
      sample_id: "locomo-cli-atlas",
      conversation: {
        speaker_a: "Alex",
        speaker_b: "Blair",
        session_1: [
          {
            speaker: "Alex",
            text: "Atlas CLI 项目的流程步骤是先核证据链，再写风险清单。",
          },
        ],
      },
      qa: [{ question: "Atlas CLI 项目的流程步骤是什么？", answer: "先核证据链" }],
    },
  ]),
);
const cliLocomoExternal = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    locomoFixtureFile,
    "--dataset-format",
    "locomo",
    "--concurrency",
    "2",
    "--progress",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliLocomoExternal.status, 0, cliLocomoExternal.stderr);
const cliLocomoJson = JSON.parse(cliLocomoExternal.stdout) as {
  pass?: boolean;
  datasetFormat?: string;
  runManifest?: {
    dataset?: { format?: string; id?: string | null };
    execution?: { caseGroupCount?: number; reusedProfileCaseCount?: number };
    options?: { concurrency?: number; reuseProfiles?: boolean };
  };
};
assert.equal(cliLocomoJson.pass, true);
assert.equal(cliLocomoJson.datasetFormat, "locomo.json");
assert.equal(cliLocomoJson.runManifest?.dataset?.format, "locomo.json");
assert.equal(cliLocomoJson.runManifest?.dataset?.id, path.basename(locomoFixtureFile));
assert.equal(cliLocomoJson.runManifest?.execution?.caseGroupCount, 1);
assert.equal(cliLocomoJson.runManifest?.execution?.reusedProfileCaseCount, 0);
assert.equal(cliLocomoJson.runManifest?.options?.concurrency, 2);
assert.equal(cliLocomoJson.runManifest?.options?.reuseProfiles, true);
assert.match(cliLocomoExternal.stderr, /\[gmos external\] 1\/1 pass case=locomo-cli-atlas:qa-1/);
const stateBenchArtifactFile = path.join(tmp, "statebench-learnings.json");
const cliStateBenchBuild = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "build-learnings",
    "--domain",
    "travel",
    "--input-dir",
    stateBenchTrainDir,
    "--allow-non-train-input",
    "--output-file",
    stateBenchArtifactFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliStateBenchBuild.status, 0, cliStateBenchBuild.stderr);
assert.equal(cliStateBenchBuild.stdout.includes(tmp), false);
assert.equal(path.isAbsolute((JSON.parse(cliStateBenchBuild.stdout) as { outputFile?: string }).outputFile ?? ""), false);
assert.equal(existsSync(stateBenchArtifactFile), true);
const cliStateBenchArtifact = JSON.parse(readFileSync(stateBenchArtifactFile, "utf8")) as {
  schema?: string;
  itemCount?: number;
  learnings?: Array<{ content?: string }>;
};
assert.equal(cliStateBenchArtifact.schema, "gmos.state_bench_learnings.v1");
assert.equal(cliStateBenchArtifact.itemCount, 1);
assert.match(cliStateBenchArtifact.learnings?.[0]?.content ?? "", /book_flight\(confirmed\)/);
assert.equal(JSON.stringify(cliStateBenchArtifact).includes("Please book a refundable flight"), false);
const cliStateBenchNonTrainFail = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "build-learnings",
    "--domain",
    "travel",
    "--input-dir",
    stateBenchTrainDir,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliStateBenchNonTrainFail.status, 0);
assert.match(cliStateBenchNonTrainFail.stderr, /datasets\/train_task_trajectories/);
const stateBenchAgentFile = path.join(tmp, "gmos_memory_agent.py");
const cliStateBenchAgent = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "write-agent",
    "--output-file",
    stateBenchAgentFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliStateBenchAgent.status, 0, cliStateBenchAgent.stderr);
assert.equal(cliStateBenchAgent.stdout.includes(tmp), false);
assert.equal(path.isAbsolute((JSON.parse(cliStateBenchAgent.stdout) as { outputFile?: string }).outputFile ?? ""), false);
const stateBenchAgentPython = readFileSync(stateBenchAgentFile, "utf8");
assert.match(stateBenchAgentPython, /class GmosMemoryAgent\(StateBenchAgent\)/);
assert.match(stateBenchAgentPython, /f"\{base_url\}\/search"/);
assert.match(stateBenchAgentPython, /payload\.get\("memories"\)/);
const cliStateBenchAgentOverwrite = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "write-agent",
    "--output-file",
    stateBenchAgentFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliStateBenchAgentOverwrite.status, 0);
assert.match(cliStateBenchAgentOverwrite.stderr, /refuses to overwrite/);
const cliStateBenchCheckoutDir = path.join(tmp, "STATE-Bench-cli");
const cliStateBenchTrainDir = path.join(
  cliStateBenchCheckoutDir,
  "datasets",
  "train_task_trajectories",
  "travel",
);
mkdirSync(cliStateBenchTrainDir, { recursive: true });
writeFileSync(
  path.join(cliStateBenchTrainDir, "001-booking.json"),
  readFileSync(path.join(stateBenchTrainDir, "001-booking.json"), "utf8"),
);
const cliStateBenchPrepare = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "prepare",
    "--checkout-dir",
    cliStateBenchCheckoutDir,
    "--domain",
    "travel",
    "--agent-model-name",
    "gpt-test-statebench",
    "--num-workers",
    "2",
    "--manifest-file",
    "outputs/gmos-learnings/travel.prepare.json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliStateBenchPrepare.status, 0, cliStateBenchPrepare.stderr);
const cliStateBenchPrepareJson = JSON.parse(cliStateBenchPrepare.stdout) as {
  schema?: string;
  artifacts?: { learningsFile?: string; agentFile?: string; manifestFile?: string };
  officialSettings?: { retrieveLearningsTopK?: number; numWorkers?: number };
  commands?: { runBatch?: string[]; computeMetrics?: string[] };
};
assert.equal(cliStateBenchPrepareJson.schema, "gmos.state_bench_prepare_run.v1");
assert.equal(cliStateBenchPrepareJson.artifacts?.learningsFile, "outputs/gmos-learnings/travel.json");
assert.equal(cliStateBenchPrepareJson.artifacts?.agentFile, "agents/gmos_memory_agent.py");
assert.equal(cliStateBenchPrepareJson.artifacts?.manifestFile, "outputs/gmos-learnings/travel.prepare.json");
assert.equal(cliStateBenchPrepareJson.officialSettings?.retrieveLearningsTopK, 3);
assert.equal(cliStateBenchPrepareJson.officialSettings?.numWorkers, 2);
assert.equal(cliStateBenchPrepareJson.commands?.runBatch?.includes("--retrieve-learnings-top-k"), true);
assert.equal(cliStateBenchPrepareJson.commands?.computeMetrics?.includes("state_bench.scripts.compute_metrics"), true);
assert.equal(JSON.stringify(cliStateBenchPrepareJson).includes(cliStateBenchCheckoutDir), false);
assert.equal(existsSync(path.join(cliStateBenchCheckoutDir, "outputs/gmos-learnings/travel.json")), true);
assert.equal(existsSync(path.join(cliStateBenchCheckoutDir, "agents/gmos_memory_agent.py")), true);
assert.equal(existsSync(path.join(cliStateBenchCheckoutDir, "outputs/gmos-learnings/travel.prepare.json")), true);
const cliStateBenchResultsDir = path.join(cliStateBenchCheckoutDir, "outputs", "travel");
mkdirSync(path.join(cliStateBenchResultsDir, "run1"), { recursive: true });
writeFileSync(path.join(cliStateBenchResultsDir, "run1", "task-a.json"), "{}");
writeFileSync(
  path.join(cliStateBenchResultsDir, "metrics.json"),
  JSON.stringify({
    benchmark_version: "state-bench-cli",
    evaluation_protocol_id: "protocol-cli",
    num_runs: 1,
    agent_model: { model_name: "gpt-test-statebench" },
    metrics: {
      "task_completion_pass@1": 1,
      "task_completion_pass^1": 1,
      mean_ux_score: 4.5,
      mean_cost_usd: 0.01,
    },
  }),
);
const cliStateBenchSummarize = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "summarize",
    "--checkout-dir",
    cliStateBenchCheckoutDir,
    "--domain",
    "travel",
    "--metrics-file",
    "outputs/travel/metrics.json",
    "--prepare-manifest",
    "outputs/gmos-learnings/travel.prepare.json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliStateBenchSummarize.status, 0, cliStateBenchSummarize.stderr);
const cliStateBenchSummaryJson = JSON.parse(cliStateBenchSummarize.stdout) as {
  schema?: string;
  source?: { metricsFile?: string; resultsDir?: string; prepareManifestFile?: string };
  officialMetrics?: { benchmarkVersion?: string; numRuns?: number; metrics?: Record<string, number> };
  coverage?: { runDirectoryCount?: number; trajectoryFileCount?: number };
  validation?: { status?: string; warnings?: string[] };
};
assert.equal(cliStateBenchSummaryJson.schema, "gmos.state_bench_results_summary.v1");
assert.equal(cliStateBenchSummaryJson.source?.metricsFile, "outputs/travel/metrics.json");
assert.equal(cliStateBenchSummaryJson.source?.prepareManifestFile, "outputs/gmos-learnings/travel.prepare.json");
assert.equal(cliStateBenchSummaryJson.officialMetrics?.benchmarkVersion, "state-bench-cli");
assert.equal(cliStateBenchSummaryJson.officialMetrics?.numRuns, 1);
assert.equal(cliStateBenchSummaryJson.officialMetrics?.metrics?.["task_completion_pass@1"], 1);
assert.equal(cliStateBenchSummaryJson.coverage?.runDirectoryCount, 1);
assert.equal(cliStateBenchSummaryJson.coverage?.trajectoryFileCount, 1);
assert.equal(cliStateBenchSummaryJson.validation?.status, "warning");
assert.equal(JSON.stringify(cliStateBenchSummaryJson).includes(cliStateBenchCheckoutDir), false);
const cliStateBenchSummaryOutputFile = path.join(
  cliStateBenchCheckoutDir,
  "outputs",
  "gmos-learnings",
  "travel.summary.json",
);
const cliStateBenchSummarizeToFile = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "summarize",
    "--checkout-dir",
    cliStateBenchCheckoutDir,
    "--domain",
    "travel",
    "--metrics-file",
    "outputs/travel/metrics.json",
    "--prepare-manifest",
    "outputs/gmos-learnings/travel.prepare.json",
    "--output-file",
    cliStateBenchSummaryOutputFile,
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliStateBenchSummarizeToFile.status, 0, cliStateBenchSummarizeToFile.stderr);
assert.equal(cliStateBenchSummarizeToFile.stdout.includes(cliStateBenchCheckoutDir), false);
const cliStateBenchSummarizeToFileAck = JSON.parse(cliStateBenchSummarizeToFile.stdout) as {
  ok?: boolean;
  outputFile?: string;
};
assert.equal(cliStateBenchSummarizeToFileAck.ok, true);
assert.equal(path.isAbsolute(cliStateBenchSummarizeToFileAck.outputFile ?? ""), false);
const cliStateBenchSummaryFileJson = JSON.parse(readFileSync(cliStateBenchSummaryOutputFile, "utf8")) as {
  schema?: string;
};
assert.equal(cliStateBenchSummaryFileJson.schema, "gmos.state_bench_results_summary.v1");
const cliStateBenchPrepareMissingModel = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "statebench",
    "prepare",
    "--checkout-dir",
    cliStateBenchCheckoutDir,
    "--domain",
    "travel",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliStateBenchPrepareMissingModel.status, 0);
assert.match(cliStateBenchPrepareMissingModel.stderr, /--agent-model-name/);
const cliExternalInvalidDatasetFormat = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    externalBenchmarkFile,
    "--dataset-format",
    "beam",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliExternalInvalidDatasetFormat.status, 0);
assert.match(
  cliExternalInvalidDatasetFormat.stderr,
  /--dataset-format must be gmos, longmemeval, or locomo/,
);
const convergedExternalBenchmarkFile = path.join(
  tmp,
  "external-long-memory-qa-converged.jsonl",
);
writeFileSync(
  convergedExternalBenchmarkFile,
  JSON.stringify({
    id: "converged-release-policy",
    requireConvergence: false,
    events: [
      {
        type: "memory",
        kind: "project",
        content: "Atlas temporal validity says ActiveTemporalOwner is current.",
        confidence: 0.9,
      },
      {
        type: "memory",
        kind: "preference",
        content: "The user prefers risk-first release notes for Atlas.",
        confidence: 0.9,
      },
      {
        type: "memory",
        kind: "boundary",
        content:
          "For Atlas, do not auto-push release announcements without explicit confirmation.",
        confidence: 0.9,
      },
    ],
    question:
      "For Atlas, which preference applies to release notes, who is the current owner, and which boundary says do not auto-push release announcements?",
    expectedAll: [
      "risk-first release notes",
      "ActiveTemporalOwner",
      "do not auto-push release announcements",
    ],
    forbiddenAny: ["ExpiredTemporalOwner"],
  }),
);
const cliExternalConverged = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    convergedExternalBenchmarkFile,
    "--require-convergence",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.equal(cliExternalConverged.status, 0, cliExternalConverged.stderr);
const cliExternalConvergedJson = JSON.parse(cliExternalConverged.stdout) as {
  pass?: boolean;
  runManifest?: { options?: { requireConvergence?: boolean } };
  cases?: Array<{ requireConvergence?: boolean; failureReasons?: string[] }>;
};
assert.equal(cliExternalConvergedJson.pass, true);
assert.equal(cliExternalConvergedJson.runManifest?.options?.requireConvergence, true);
assert.equal(cliExternalConvergedJson.cases?.[0]?.requireConvergence, true);
assert.deepEqual(cliExternalConvergedJson.cases?.[0]?.failureReasons, []);
const cliExternalConvergencePrepare = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    convergedExternalBenchmarkFile,
    "--mode",
    "prepare",
    "--require-convergence",
    "--format",
    "json",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliExternalConvergencePrepare.status, 0);
assert.match(
  cliExternalConvergencePrepare.stderr,
  /--require-convergence requires reconstruct mode/,
);
const failedExternalBenchmarkFile = path.join(tmp, "external-long-memory-qa-fail.jsonl");
writeFileSync(
  failedExternalBenchmarkFile,
  JSON.stringify({
    id: "missing-answer",
    events: [{ content: "用户喜欢先讲风险。" }],
    question: "用户喜欢什么？",
    expectedAll: ["不存在的答案"],
  }),
);
const cliExternalFail = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli/gmos.ts",
    "gym",
    "external",
    "--input-file",
    failedExternalBenchmarkFile,
    "--format",
    "markdown",
  ],
  { cwd: process.cwd(), encoding: "utf8" },
);
assert.notEqual(cliExternalFail.status, 0);
assert.match(cliExternalFail.stdout, /Status: FAIL/);
assert.match(cliExternalFail.stdout, /expected_all_missing/);
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
